import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PetStoryProject, PetStoryPlan, PetStoryAsset, PetStoryPromptProfile, PetStoryPromptKind, PetStoryChatJob, PetStoryPromptBatch, PetStoryImageTarget } from '@doubao-studio/contracts';
import { assetCharacterIds, defaultPromptProfile } from './petstoryPromptQuality';
import { extractDouyinLink, record, validatePetStoryPlan, validatePromptTask } from './petstoryValidation';
import { invalidateMaterialDependents, materialAsset, syncMaterials, storyHash, requireMaterialInventory } from './petstoryMaterials';
import { mediaDigest, validatePetStoryMedia } from './petstoryMedia';
import { archiveCompletedPetStoryProduction } from './petstoryProductionLifecycle';
import { validateCastBindings } from './petstoryCast';
import { validatePetStoryAdjustments } from './petstoryAdjustmentValidation';
import { imageTargetBasis, imageTargetMatches, selectedShotImageId, reconcileAdoptedImages } from './petstoryImageReview';

/** 内部收取来源与候选一起原子保存，不出现“图片已存但回复来源未存”的中间状态。 */
interface PetStoryImageImportSource {
  taskId: string; runId?: string; downloadJobId: string;
  sourceReply: { adjustmentId: string; replyKey: string; urlHash: string };
}

export async function projectPath(directory: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some((p: string): boolean => p === '..' || p === '.' || !p)) {
    throw new Error('项目文件路径越界');
  }
  const root = await fs.realpath(directory);
  const target = path.join(root, relative);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('项目文件禁止符号链接');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}
function validateMobileStory(value: unknown): void {
  if (value === undefined) return;
  const story = record(value);
  if (typeof story.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(story.id)
    || typeof story.text !== 'string' || !story.text.trim() || story.text.length > 50_000
    || typeof story.importedAt !== 'string' || !Number.isFinite(Date.parse(story.importedAt))) throw new Error('手机豆包故事原文无效，原文件已保留');
}
export function validateProject(value: unknown, readHistorical: boolean = false): PetStoryProject {
  const p = record(value);
  if (p.schemaVersion !== 1 || typeof p.id !== 'string' || typeof p.studioProjectId !== 'string' || typeof p.accountId !== 'string' || !Number.isInteger(p.revision)) throw new Error('项目版本或身份无效，原文件已保留');
  const source = record(p.source);
  if (!['douyin', 'script'].includes(String(source.kind))) throw new Error('本项目仅接受抖音链接；原清单已保留，不支持本地原视频');
  if (source.url !== '') extractDouyinLink(String(source.url));
  if (!['pending', 'blocked', 'review_required'].includes(String(source.status))) throw new Error('来源状态无效');
  validateMobileStory(p.mobileStory);
  if (p.promptProfile !== undefined) validatePromptProfile(p.promptProfile);
  if (p.promptModel !== undefined && !['generic', 'seedance-2.5', 'seedance-2.0', 'seedance-2.0-fast', 'seedance-2.0-mini'].includes(String(p.promptModel))) throw new Error('文字目标模型无效');
  if (p.promptBatch !== undefined) validatePromptBatch(p.promptBatch);
  if (!Array.isArray(p.assets) || !Array.isArray(p.jobs)) throw new Error('项目资产或任务清单无效');
  const result = structuredClone(value) as PetStoryProject;
  if (p.plan) result.plan = validatePetStoryPlan(p.plan, false, readHistorical);
  const ids = validateAssets(result);
  for (const char of result.plan?.characters || []) {
    if (char.referenceAssetId && !result.assets.some((a: PetStoryAsset): boolean => a.id === char.referenceAssetId && assetCharacterIds(a).includes(char.id))) throw new Error(`${char.name}参考图错绑`);
  }
  validateChatJobs(result, readHistorical);
  validatePetStoryAdjustments(result);
  for (const shot of result.plan?.shots || []) {
    if (shot.sceneReferenceAssetIds?.some((id: string): boolean => !result.assets.some((a): boolean => a.id === id && a.kind === 'scene' && (a.shotId === shot.id || !!a.materialId)))) throw new Error('场景参考图错绑');
  }
  validateMaterials(result);
  validateAdoptedImages(result);
  validateProduction(result, ids);
  return result;
}

function validateAdoptedImages(result: PetStoryProject): void {
  for (const [shotId, selected] of Object.entries(result.adoptedImages || {})) {
    // 旧方案的镜头可能已经删除；历史指针不成为新方案的正式图片，也不能阻断读盘。
    if (!result.plan?.shots.some((shot): boolean => shot.id === shotId)) continue;
    for (const [field, kind] of [['firstFrameId', 'firstFrame'], ['plannedEndImageId', 'plannedEndImage']] as const) {
      if (selected[field] && !result.assets.some((asset): boolean => asset.id === selected[field] && asset.shotId === shotId && asset.kind === kind && asset.imageReview?.state === 'adopted')) throw new Error('正式镜头图片缺少明确采用记录');
    }
  }
}

function validateChatJobs(result: PetStoryProject, readHistorical: boolean = false): void {
  for (const job of result.jobs) {
    if (!job.id || !job.taskId || !/^[a-f0-9]{64}$/.test(job.inputHash) || !['analysis', 'repair', 'optimize', 'materialPrompt', 'assets', 'review', 'revise'].includes(job.kind)) throw new Error('项目任务绑定无效');
    if (job.parsedResult?.plan) job.parsedResult.plan = validatePetStoryPlan(job.parsedResult.plan, false, readHistorical);
    if (job.requestId && (!job.expectedIds?.length || !job.rulesVersion || !job.ruleFiles?.length)) throw new Error('运行时规则或目标记录不完整');
    if (job.selectedIssueIds !== undefined && (!Array.isArray(job.selectedIssueIds) || !job.selectedIssueIds.length || job.selectedIssueIds.some((id: unknown): boolean => typeof id !== 'string' || !id.trim()) || new Set(job.selectedIssueIds).size !== job.selectedIssueIds.length)) throw new Error('保存的局部修订问题选择无效');
    if (job.reviewFocus !== undefined && (typeof job.reviewFocus !== 'string' || !job.reviewFocus.trim() || job.reviewFocus.length > 2000 || !['review', 'repair'].includes(job.kind))) throw new Error('保存的内容审查核对疑点无效');
    if (job.endedWaitingAt !== undefined && !Number.isFinite(Date.parse(job.endedWaitingAt))) throw new Error('结束等待记录无效');
    validateChatRequestFacts(job);
  }
}
function validateChatRequestFacts(job: PetStoryChatJob): void {
  validateChatRepairFacts(job);
  if (job.analysisCastBindings !== undefined) {
    if (!['analysis', 'repair'].includes(job.kind)) throw new Error('演员绑定快照仅用于分析任务');
    validateCastBindings(job.analysisCastBindings);
  }
  if (job.reviewInputFinals !== undefined && (!['review', 'repair'].includes(job.kind) || !job.reviewInputFinals || typeof job.reviewInputFinals !== 'object' || Object.prototype.toString.call(job.reviewInputFinals) !== '[object Object]'
    || Object.entries(job.reviewInputFinals).some(([key, value]): boolean => !/^(?:(?:character|prop|scene):[a-zA-Z0-9_-]{1,80}|[a-zA-Z0-9_-]{1,80}:(?:firstFrame|lastFrame|video))$/.test(key) || typeof value !== 'string'))) throw new Error('保存的审查逐项正文快照无效');
  if (job.requestText !== undefined && (typeof job.requestText !== 'string' || !job.requestText.trim())) throw new Error('保存的 Chat 原请求无效');
  if (job.validationIssues !== undefined && (!Array.isArray(job.validationIssues) || job.validationIssues.some((issue: unknown): boolean => typeof issue !== 'string' || !issue.trim()))) throw new Error('保存的 Chat 具体缺项无效');
  if (job.formatCorrections !== undefined && (!['analysis', 'repair'].includes(job.kind) || !Array.isArray(job.formatCorrections) || job.formatCorrections.some((item: unknown): boolean => typeof item !== 'string' || !item.trim()))) throw new Error('保存的分镜结构整理记录无效');
  if (job.frameContextHash !== undefined && !/^[a-f0-9]{64}$/.test(job.frameContextHash)) throw new Error('保存的共同帧正文快照无效');
  if (job.previousBoundaryHash !== undefined && !/^[a-f0-9]{64}$/.test(job.previousBoundaryHash)) throw new Error('保存的前镜采用边界快照无效');
  if (job.promptTask) job.promptTask = validatePromptTask(job.promptTask);
}
function validateChatRepairFacts(job: PetStoryChatJob): void {
  if (job.originKind !== undefined && (!['analysis', 'optimize', 'materialPrompt', 'assets', 'review', 'revise'].includes(job.originKind) || job.kind !== 'repair')) throw new Error('修订原创作职责无效');
  if (job.repairMode !== undefined && (!['automatic', 'explicit'].includes(job.repairMode) || job.kind !== 'repair')) throw new Error('修订轮次记录无效');
  if (job.validationDetails !== undefined && (!Array.isArray(job.validationDetails) || job.validationDetails.some((issue): boolean => !issue || typeof issue.code !== 'string' || typeof issue.path !== 'string' || typeof issue.actualType !== 'string' || typeof issue.expected !== 'string' || typeof issue.repairable !== 'boolean' || typeof issue.message !== 'string'))) throw new Error('保存的具体内容校验问题无效');
}

function validateMaterials(result: PetStoryProject): void {
  if (result.materials) {
    const keys = new Set<string>();
    for (const m of result.materials) {
      if (keys.has(m.id) || m.id !== `${m.kind}:${m.entityId}` || !['character', 'prop', 'scene'].includes(m.kind) || !/^[a-zA-Z0-9_-]{1,80}$/.test(m.entityId)
        || !/^[a-f0-9]{64}$/.test(m.designHash) || typeof m.prompt?.final !== 'string') throw new Error('基础素材条目无效');
      keys.add(m.id);
      if (m.prompt.promptTask) m.prompt.promptTask = validatePromptTask(m.prompt.promptTask);
      if (m.selectedAssetId) materialAsset(result, m.id, false);
      if (m.approved && (m.approved.assetId !== m.selectedAssetId || !/^[a-f0-9]{64}$/.test(m.approved.sha256))) throw new Error('具体图片确认绑定无效');
    }
  }
}

function validateAssets(result: PetStoryProject): Set<string> {
  const ids = new Set<string>();
  for (const asset of result.assets) {
    const legacyPath = asset.kind === 'character' ? /^characters\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/i : /^shots\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|mp4)$/i;
    if (typeof asset.id !== 'string' || ids.has(asset.id) || !['character', 'prop', 'firstFrame', 'plannedEndImage', 'video', 'actualEndFrame', 'scene'].includes(asset.kind)
      || !(legacyPath.test(asset.relativePath) || (!!asset.materialId && /^materials\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/i.test(asset.relativePath)))) throw new Error('项目素材路径或类型无效');
    if (asset.kind === 'character' && (!assetCharacterIds(asset).length || assetCharacterIds(asset).some((id: string): boolean => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)))) throw new Error('身份参考角色映射无效');
    ids.add(asset.id);
    if (asset.kind === 'video' && (!asset.taskId || !asset.runId || !asset.validation || !asset.downloadJobId || !asset.artifactId)) throw new Error('视频素材缺少真实产物归属');
    if (asset.validation && (asset.validation.decoded !== true || !/^[a-f0-9]{64}$/.test(asset.validation.sha256) || !(asset.validation.bytes > 0) || !(asset.validation.width > 0) || !(asset.validation.height > 0))) throw new Error('媒体校验记录无效');
    if (asset.kind === 'actualEndFrame' && (!asset.sourceVideo || !(asset.sourceVideo.atSeconds >= 0))) throw new Error('真实末帧缺少源视频信息');
    validateImageReview(asset);
  }
  return ids;
}
function validateImageReview(asset: PetStoryAsset): void {
    if (asset.imageReview) {
      const review = asset.imageReview;
      if (!['candidate', 'adopted'].includes(review.state) || !/^[a-f0-9]{64}$/.test(review.basisHash) || !imageTargetMatches(asset, review.target)
        || review.state === 'adopted' && (!review.adoptedAt || !Number.isFinite(Date.parse(review.adoptedAt)) || review.sha256 !== asset.validation?.sha256)) throw new Error('图片候选或采用记录无效');
      if (review.sourceReply && (!/^[a-f0-9-]{36}$/i.test(review.sourceReply.adjustmentId) || !/^[a-f0-9]{64}$/.test(review.sourceReply.replyKey) || !/^[a-f0-9]{64}$/.test(review.sourceReply.urlHash))) throw new Error('图片回复来源记录无效');
    }
}
function validateProduction(result: PetStoryProject, ids: Set<string>): void {
  if (result.production) {
    const production = result.production;
    if (!result.plan || !['running', 'paused', 'complete'].includes(production.state) || !/^[a-f0-9]{64}$/.test(production.planHash)
      || !Array.isArray(production.steps) || !production.shots || production.capability?.accountId !== result.accountId) throw new Error('制作进度或账号绑定无效');
    if (production.target && (!result.plan.shots.some((s): boolean => s.id === production.target?.shotId) || !['firstFrame', 'lastFrame', 'video'].includes(production.target.kind))) throw new Error('单节点制作目标无效');
    const stepIds = new Set<string>();
    for (const step of production.steps) {
      if (!step.id || stepIds.has(step.id) || !['character', 'prop', 'scene', 'firstFrame', 'lastFrame', 'video'].includes(step.kind) || !['preparing', 'bound', 'complete'].includes(step.status)
        || !Array.isArray(step.attachmentAssetIds) || step.attachmentAssetIds.some((id: string): boolean => !ids.has(id)) || !/^[a-f0-9]{64}$/.test(step.inputHash)) throw new Error('制作步骤绑定无效');
      stepIds.add(step.id);
    }
    if (production.phase !== 'materials') validateShotMedia(result);
  }
}
function validateShotMedia(result: PetStoryProject): void {
  const production = result.production;
  if (!production || !result.plan) return;
    for (const shot of result.plan.shots) {
      const media = production.shots[shot.id];
      if (!media || media.requestedMode !== shot.requestedMode || !['first_frame', 'first_last_frame', 'reference'].includes(media.resolvedMode)) throw new Error('镜头实际模式无效');
      for (const [key, kind] of [['firstFrameId', 'firstFrame'], ['plannedEndImageId', 'plannedEndImage'], ['videoId', 'video'], ['actualEndFrameId', 'actualEndFrame']] as const) {
        const id = media[key];
        if (id && !result.assets.some((a): boolean => a.id === id && a.shotId === shot.id && (a.kind === kind || (key === 'firstFrameId' && a.kind === 'actualEndFrame')))) throw new Error('镜头选中素材错绑');
      }
    }
}

/** 每个打开目录一条串行队列；只有主进程选择的目录会登记。 */
export class PetStoryProjects {
  private directories = new Map<string, string>();
  private queues = new Map<string, Promise<unknown>>();
  constructor(private readonly replaceFile: (from: string, to: string) => Promise<void> = fs.rename) {}

  async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) || Promise.resolve();
    const next = previous.catch((): void => {}).then(work);
    this.queues.set(id, next);
    try { return await next; } finally { if (this.queues.get(id) === next) this.queues.delete(id); }
  }
  directory(id: string): string {
    const directory = this.directories.get(id);
    if (!directory) throw new Error('请先打开项目目录');
    return directory;
  }
  async read(id: string): Promise<PetStoryProject> {
    const filename = await projectPath(this.directory(id), 'project.json');
    const info = await fs.stat(filename);
    if (info.size > 8 * 1024 * 1024) throw new Error('项目文件超过 8 MiB');
    const project = validateProject(JSON.parse(await fs.readFile(filename, 'utf8')), true);
    if (project.id !== id) throw new Error('项目身份发生变化，已停止操作');
    return project;
  }
  async open(directory: string): Promise<PetStoryProject> {
    const real = await fs.realpath(directory);
    const filename = await projectPath(real, 'project.json');
    if ((await fs.stat(filename)).size > 8 * 1024 * 1024) throw new Error('项目文件超过 8 MiB');
    const project = validateProject(JSON.parse(await fs.readFile(filename, 'utf8')), true);
    const old = this.directories.get(project.id);
    if (old && old !== real) throw new Error('相同项目 ID 已在其他目录打开');
    for (const asset of project.assets) await projectPath(real, asset.relativePath);
    this.directories.set(project.id, real);
    return project;
  }
  async create(directory: string, studioProjectId: string, accountId: string): Promise<PetStoryProject> {
    const real = await fs.realpath(directory);
    const filename = await projectPath(real, 'project.json');
    const project: PetStoryProject = { schemaVersion: 1, id: randomUUID(), studioProjectId, accountId, revision: 0,
      source: { kind: 'douyin', url: '', status: 'pending' }, promptProfile: defaultPromptProfile(), assets: [], jobs: [], updatedAt: new Date().toISOString() };
    await fs.writeFile(filename, JSON.stringify(project, null, 2), { flag: 'wx', mode: 0o600 });
    this.directories.set(project.id, real);
    return project;
  }
  async write(project: PetStoryProject): Promise<PetStoryProject> {
    const current = await this.read(project.id);
    // 盘上原有小数方案和历史候选逐值保留；本次新增／改变的方案必须重新严格校验。
    const checked = validateProject(project, true);
    if (checked.plan && !isDeepStrictEqual(project.plan, current.plan)) checked.plan = validatePetStoryPlan(project.plan);
    for (const job of checked.jobs) {
      const previous = current.jobs.find((item): boolean => item.id === job.id);
      if (job.parsedResult?.plan && !isDeepStrictEqual(job.parsedResult.plan, previous?.parsedResult?.plan)) job.parsedResult.plan = validatePetStoryPlan(job.parsedResult.plan);
    }
    if (current.revision !== checked.revision) throw new Error('项目已被修改，请重新打开后操作');
    const next = { ...checked, revision: checked.revision + 1, updatedAt: new Date().toISOString() };
    const target = await projectPath(this.directory(checked.id), 'project.json');
    const temporary = await projectPath(this.directory(checked.id), `project-${randomUUID()}.tmp`);
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        const content = JSON.stringify(next, null, 2);
        if (Buffer.byteLength(content, 'utf8') > 8 * 1024 * 1024) throw new Error('项目正文超过 8 MiB，旧清单保留');
        await file.writeFile(content, 'utf8'); await file.sync();
      } finally { await file.close(); }
      await projectPath(this.directory(checked.id), 'project.json');
      await this.replaceFile(temporary, target);
      const written = await this.read(next.id);
      if (written.revision !== next.revision) throw new Error('项目写入后回读不一致');
      return written;
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async savePromptModel(id: string, revision: number, model?: PetStoryProject['promptModel']): Promise<PetStoryProject> {
    const p = await this.read(id);
    if (p.revision !== revision) throw new Error('项目已变化或原制作仍在使用中');
    archiveCompletedPetStoryProduction(p);
    if (p.production) throw new Error('项目已变化或原制作仍在使用中');
    p.promptModel = model;
    return this.write(p);
  }
  async savePromptBatch(id: string, revision: number, batch: PetStoryPromptBatch): Promise<PetStoryProject> {
    const p = await this.read(id);
    if (p.revision !== revision) throw new Error('项目版本已变化，请刷新文字批次');
    validatePromptBatch(batch);
    p.promptBatch = structuredClone(batch);
    return this.write(p);
  }
  async savePromptProfile(id: string, revision: number, profile: PetStoryPromptProfile): Promise<PetStoryProject> {
    const p = await this.read(id);
    if (p.revision !== revision) throw new Error('项目已变化或制作已锁定');
    archiveCompletedPetStoryProduction(p);
    if (p.production) throw new Error('项目已变化或制作已锁定');
    p.promptProfile = validatePromptProfile(profile);
    if (p.materials) p.materials = syncMaterials(p);
    return this.write(p);
  }
  async saveSource(id: string, revision: number, value: string): Promise<PetStoryProject> {
    const p = await this.read(id);
    if (p.revision !== revision) throw new Error('项目版本已变化');
    const url = extractDouyinLink(value);
    if (url === p.source.url) return p;
    if (p.plan || p.drafts?.length) throw new Error('已有制作方案或媒体草稿，更换来源请新建项目，保留现有最终提示词');
    if (p.jobs.some((j): boolean => j.status === 'bound' || j.status === 'captured')) throw new Error('原分析任务尚未核对，请先收取原结果，不得另发');
    p.plan = undefined;
    p.contentBasis = undefined;
    p.mobileStory = undefined;
    p.source = { kind: 'douyin', url, status: 'pending' };
    return this.write(p);
  }
  async saveMobileStory(id: string, revision: number, text: string): Promise<PetStoryProject> {
    const p = await this.read(id);
    if (p.revision !== revision) throw new Error('项目版本已变化');
    if (!text.trim() || text.length > 50_000) throw new Error('请粘贴剧本或手机豆包返回的故事情节原文（最多 50000 字符），无需 JSON');
    if (p.mobileStory?.text === text) return p;
    if (p.plan || p.drafts?.length) throw new Error('已有制作方案或媒体草稿，更换故事请新建项目，保留现有最终提示词');
    if (p.jobs.some((j): boolean => !!j.sourceStoryId && (j.status === 'bound' || j.status === 'captured'))) throw new Error('原故事处理任务尚未核对，请先收取原结果');
    // 旧版链接直读任务保留身份及原文，但导入后不再允许启动／重试它们。
    for (const job of p.jobs) {
      if (!job.sourceStoryId && (job.status === 'bound' || job.status === 'captured')) {
        job.status = 'invalid';
        job.error = '旧版网页链接直读已停用，仅保留原任务及只读核对';
      }
    }
    p.mobileStory = { id: randomUUID(), text, importedAt: new Date().toISOString() };
    if (!p.source.url) p.source.kind = 'script';
    p.contentBasis = undefined;
    p.source = { ...p.source, status: 'pending', reason: p.source.kind === 'script' ? '剧本原文已保存，待分析；请在生成基础素材前确认剧本与资产清单' : '手机豆包故事原文已保存，待生成制作方案；请本人对照原视频核对内容' };
    return this.write(p);
  }
  /** 显式改原文仅使故事确认失效；不重拆镜、不改写已有方案与媒体。 */
  async saveOriginalStory(id: string, revision: number, text: string): Promise<PetStoryProject> {
    const p = await this.read(id);
    if (!p.plan) return this.saveMobileStory(id, revision, text);
    if (p.revision !== revision) throw new Error('项目版本已变化，请刷新后保存原剧本');
    if (!text.trim() || text.length > 50_000) throw new Error('需要有效原剧本（最多 50000 字符）');
    if (p.mobileStory?.text === text) return p;
    if (p.jobs.some((j): boolean => !j.requestId && (j.status === 'bound' || j.status === 'captured'))) throw new Error('原 Chat 尚未收取完成，暂不能更换原文');
    if (p.production && (p.production.state !== 'complete' || p.production.steps.some((s): boolean => s.status !== 'complete'))) throw new Error('原制作任务尚未结束，暂不能更换原文');
    p.mobileStory = { id: randomUUID(), text, importedAt: new Date().toISOString() };
    p.storyApproval = undefined;
    p.source = { ...p.source, status: 'review_required', reason: '用户已编辑原剧本；已有镜头、手改、历史回复与媒体保留，请重新核对并确认当前故事和素材。未自动改编或拆镜。' };
    return this.write(p);
  }
  async savePlan(id: string, revision: number, value: PetStoryPlan): Promise<PetStoryProject> {
    const p = await this.read(id);
    if (p.revision !== revision) throw new Error('项目版本已变化，请重新读取');
    if (!p.plan) throw new Error('请先取得本次 Chat 分析结果');
    if (p.production && !archiveCompletedPetStoryProduction(p)) throw new Error('原制作尚未结束或镜头方案已锁定，保留已有素材和任务');
    const checked = validatePetStoryPlan(value);
    for (const shot of checked.shots) {
      const previous = p.plan.shots.find((s): boolean => s.id === shot.id);
      for (const kind of ['firstFrame', 'lastFrame', 'video'] as const) {
        const incoming = shot.prompts[kind];
        const old = previous?.prompts[kind];
        if (incoming && old) shot.prompts[kind] = { ...old, final: incoming.final, edited: old.edited || incoming.final !== old.final, basisJobId: incoming.final === old.final ? old.basisJobId : old.sourceJobId || old.basisJobId, sourceJobId: incoming.final === old.final ? old.sourceJobId : undefined };
      }
    }
    p.plan = checked;
    if (p.materials) p.materials = syncMaterials(p);
    reconcileAdoptedImages(p);
    return this.write(p);
  }
  /** 只合并本项 final；候选回复与其他镜头可在等待保存期间继续回填。 */
  async saveShotPrompt(id: string, revision: number, shotId: string, kind: PetStoryPromptKind, final: string): Promise<PetStoryProject> {
    const p = await this.read(id);
    if (!Number.isInteger(revision) || revision > p.revision) throw new Error('项目版本无效，请刷新后操作');
    if (!['firstFrame', 'lastFrame', 'video'].includes(kind) || !final.trim() || final.length > 100_000) throw new Error('提示词用途或正文无效');
    const target = p.plan?.shots.find((s): boolean => s.id === shotId)?.prompts[kind];
    if (!target) throw new Error('镜头或提示词不存在');
    if (p.production && !archiveCompletedPetStoryProduction(p)) throw new Error('原制作尚未结束，请先处理原任务，保留已有输入与素材');
    target.basisJobId = target.sourceJobId || target.basisJobId; target.final = final; target.edited = true; target.sourceJobId = undefined;
    return this.write(p);
  }
  async bindSharedReference(id: string, revision: number, characterId: string, assetId: string): Promise<PetStoryProject> {
    const p = await this.read(id);
    if (p.revision !== revision || p.production) throw new Error('项目版本变化或制作已锁定');
    if (!['lulu', 'lumei', ...(p.plan?.characters.map((c): string => c.id) || [])].includes(characterId)) throw new Error('角色不存在');
    const asset = p.assets.find((a): boolean => a.id === assetId && a.kind === 'character');
    if (!asset) throw new Error('请选已登记的身份参考图');
    // 为新目标保存独立候选记录；原图片的采用、身份映射与历史保持不变。
    return this.addMaterialImage(id, p.revision, `character:${characterId}`, await projectPath(this.directory(id), asset.relativePath));
  }
  async addReference(id: string, characterId: string, sourcePath: string): Promise<PetStoryProject> {
    const p = await this.read(id); requireMaterialInventory(p);
    const materialId = `character:${characterId}`;
    if (!p.materials?.some((item): boolean => item.id === materialId)) throw new Error('请先在方案中确认此人物，再上传对应图片');
    return this.addMaterialImage(id, p.revision, materialId, sourcePath);
  }
  async addSceneReference(id: string, shotId: string, sourcePath: string): Promise<PetStoryProject> {
    const p = await this.read(id); requireMaterialInventory(p);
    const shot = p.plan?.shots.find((item): boolean => item.id === shotId);
    const materialId = `scene:${shot?.sceneId || ''}`;
    if (!shot || !p.materials?.some((item): boolean => item.id === materialId)) throw new Error('请先确认当前镜头的场景素材，再上传对应图片');
    return this.addMaterialImage(id, p.revision, materialId, sourcePath);
  }
  private editableMaterials(p: PetStoryProject, revision: number): void {
    if (p.revision !== revision) throw new Error('项目版本变化，请刷新后操作');
    archiveCompletedPetStoryProduction(p);
    if (p.production?.state === 'running' || p.production?.steps.some((s): boolean => s.status !== 'complete')) throw new Error('原制作尚有未结束步骤，请先处理原任务，不能替换其输入');
  }
  async confirmStory(id: string, revision: number): Promise<PetStoryProject> {
    const p = await this.read(id); this.editableMaterials(p, revision);
    if (!p.plan || !p.mobileStory || !p.plan.props || !p.plan.scenes || p.plan.shots.some((s): boolean => !s.sceneId || !s.propIds)) throw new Error('请补齐剧本解析的人物、道具、场景及每镜引用，再确认剧本');
    p.materials = syncMaterials(p);
    p.storyApproval = { hash: storyHash(p), at: new Date().toISOString() };
    return this.write(p);
  }
  async saveMaterialPrompt(id: string, revision: number, materialId: string, final: string): Promise<PetStoryProject> {
    const p = await this.read(id); this.editableMaterials(p, revision); requireMaterialInventory(p);
    const m = p.materials?.find((m): boolean => m.id === materialId);
    if (!m || !final.trim() || final.length > 50000) throw new Error('基础图提示词为空或无效');
    m.prompt = { ...m.prompt, final, edited: true, basisJobId: m.prompt.sourceJobId || m.prompt.basisJobId, sourceJobId: undefined, needsReview: undefined };
    return this.write(p);
  }
  async selectMaterialImage(id: string, revision: number, materialId: string, assetId: string): Promise<PetStoryProject> {
    const p = await this.read(id); this.editableMaterials(p, revision); requireMaterialInventory(p);
    const m = p.materials?.find((m): boolean => m.id === materialId);
    if (!m) throw new Error('基础素材不存在');
    const asset = p.assets.find((item): boolean => item.id === assetId && imageTargetMatches(item, { materialId }));
    if (!asset || asset.kind !== m.kind) throw new Error('请选择本素材的具体图片');
    // 历史列表只负责定位预览；采用必须经 approveMaterials / adoptImage 明确确认。
    return p;
  }
  async addMaterialImage(id: string, revision: number, materialId: string, sourcePath: string, source?: PetStoryImageImportSource): Promise<PetStoryProject> {
    const p = await this.read(id); this.editableMaterials(p, revision); requireMaterialInventory(p);
    const m = p.materials?.find((m): boolean => m.id === materialId);
    if (!m) throw new Error('基础素材不存在');
    const info = await fs.lstat(sourcePath); const ext = path.extname(sourcePath).toLowerCase();
    if (!info.isFile() || info.isSymbolicLink() || info.size > 20 * 1024 * 1024 || !['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('基础图格式或大小无效');
    const validation = await validatePetStoryMedia(sourcePath, 'image');
    const asset: PetStoryAsset = { id: randomUUID(), materialId, kind: m.kind, relativePath: `materials/${randomUUID()}${ext}`, characterId: m.kind === 'character' ? m.entityId : undefined, validation,
      ...(source ? { taskId: source.taskId, runId: source.runId, downloadJobId: source.downloadJobId } : {}) };
    const file = await projectPath(this.directory(id), asset.relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true }); await projectPath(this.directory(id), asset.relativePath);
    await fs.copyFile(sourcePath, file, 1);
    if ((await mediaDigest(file)).sha256 !== validation.sha256) throw new Error('基础图片复制校验失败，原绑定保留');
    asset.imageReview = { state: 'candidate', target: { materialId }, basisHash: imageTargetBasis(p, { materialId }), ...(source ? { sourceReply: source.sourceReply } : {}) };
    p.assets.push(asset);
    return this.write(p);
  }
  async addShotImage(id: string, revision: number, shotId: string, kind: 'firstFrame' | 'lastFrame', sourcePath: string, source?: PetStoryImageImportSource): Promise<PetStoryProject> {
    const p = await this.read(id); this.editableMaterials(p, revision); requireMaterialInventory(p);
    const target: PetStoryImageTarget = { shotId, kind };
    const basisHash = imageTargetBasis(p, target);
    const info = await fs.lstat(sourcePath); const ext = path.extname(sourcePath).toLowerCase();
    if (!info.isFile() || info.isSymbolicLink() || info.size > 20 * 1024 * 1024 || !['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('图片格式或大小无效');
    const validation = await validatePetStoryMedia(sourcePath, 'image');
    const asset: PetStoryAsset = { id: randomUUID(), kind: kind === 'lastFrame' ? 'plannedEndImage' : 'firstFrame', shotId,
      relativePath: `shots/${shotId}/${randomUUID()}${ext}`, validation, imageReview: { state: 'candidate', target, basisHash, ...(source ? { sourceReply: source.sourceReply } : {}) },
      ...(source ? { taskId: source.taskId, runId: source.runId, downloadJobId: source.downloadJobId } : {}) };
    const file = await projectPath(this.directory(id), asset.relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true }); await projectPath(this.directory(id), asset.relativePath);
    await fs.copyFile(sourcePath, file, 1);
    if ((await mediaDigest(file)).sha256 !== validation.sha256) throw new Error('图片复制校验失败，原采用图保留');
    p.assets.push(asset);
    return this.write(p);
  }
  private async adoptProjectImage(p: PetStoryProject, target: PetStoryImageTarget, assetId: string): Promise<void> {
    const asset = p.assets.find((item): boolean => item.id === assetId);
    if (!asset || !imageTargetMatches(asset, target)) throw new Error('图片不属于当前目标');
    const material = target.materialId ? p.materials?.find((item): boolean => item.id === target.materialId) : undefined;
    if (target.materialId && (!material || material.kind !== asset.kind)) throw new Error('图片用途与素材不符');
    const basisHash = imageTargetBasis(p, target);
    if (asset.imageReview?.state === 'candidate' && asset.imageReview.basisHash !== basisHash) throw new Error('图片候选依据已变化，请重新核对当前目标后准备图片');
    const file = await projectPath(this.directory(p.id), asset.relativePath);
    const validation = await validatePetStoryMedia(file, 'image');
    if (asset.validation && asset.validation.sha256 !== validation.sha256) throw new Error('图片文件已变化，请重新上传后查看采用');
    asset.validation = validation;
    const oldId = material?.selectedAssetId || (target.shotId && target.kind ? selectedShotImageId(p, target.shotId, target.kind) : undefined);
    const adoptedAt = new Date().toISOString();
    asset.imageReview = { state: 'adopted', target, basisHash, adoptedAt, sha256: validation.sha256, ...(asset.imageReview?.sourceReply ? { sourceReply: asset.imageReview.sourceReply } : {}) };
    asset.needsReview = undefined;
    this.applyImageSelection(p, target, asset, oldId, adoptedAt, validation.sha256);
  }
  private applyImageSelection(p: PetStoryProject, target: PetStoryImageTarget, asset: PetStoryAsset, oldId: string | undefined, adoptedAt: string, sha256: string): void {
    const material = target.materialId ? p.materials?.find((item): boolean => item.id === target.materialId) : undefined;
    if (material) {
      material.selectedAssetId = asset.id;
      const character = material.kind === 'character' ? p.plan?.characters.find((item): boolean => item.id === material.entityId) : undefined;
      material.approved = { assetId: asset.id, sha256: sha256, at: adoptedAt, ...(character ? { identity: { assetId: asset.id, description: character.description } } : {}) };
      if (character) character.referenceAssetId = asset.id;
      if (oldId && oldId !== asset.id) invalidateMaterialDependents(p, material.id);
    } else if (target.shotId) {
      p.adoptedImages ||= {};
      const selected = p.adoptedImages[target.shotId] ||= {};
      selected[target.kind === 'firstFrame' ? 'firstFrameId' : 'plannedEndImageId'] = asset.id;
      const media = p.production?.shots[target.shotId];
      if (media) media[target.kind === 'firstFrame' ? 'firstFrameId' : 'plannedEndImageId'] = asset.id;
      if (oldId && oldId !== asset.id) for (const item of p.assets) {
        if (item.shotId === target.shotId && item.id !== asset.id && (item.kind === 'video' || target.kind === 'firstFrame' && item.kind === 'plannedEndImage')) item.needsReview = true;
      }
    }
  }
  async adoptImage(id: string, revision: number, target: PetStoryImageTarget, assetId: string): Promise<PetStoryProject> {
    const p = await this.read(id); this.editableMaterials(p, revision); requireMaterialInventory(p);
    if (!target || !!target.materialId === !!target.shotId) throw new Error('请选择唯一图片目标');
    await this.adoptProjectImage(p, target, assetId);
    return this.write(p);
  }
  async approveMaterials(id: string, revision: number, selections: { materialId: string; assetId: string }[]): Promise<PetStoryProject> {
    const p = await this.read(id); this.editableMaterials(p, revision); requireMaterialInventory(p);
    if (!Array.isArray(selections) || !selections.length || new Set(selections.map((s): string => s.materialId)).size !== selections.length) throw new Error('请选择已经查看的具体图片');
    for (const selection of selections) {
      const m = p.materials?.find((m): boolean => m.id === selection.materialId);
      if (!m) throw new Error('基础素材不存在');
      await this.adoptProjectImage(p, { materialId: m.id }, selection.assetId);
    }
    return this.write(p);
  }
  async referenceFile(id: string, assetId: string): Promise<string> {
    const p = await this.read(id);
    const asset = p.assets.find((a: PetStoryAsset): boolean => a.id === assetId && a.kind !== 'video');
    if (!asset) throw new Error('参考图未登记在当前项目');
    const filename = await projectPath(this.directory(id), asset.relativePath);
    if ((await fs.stat(filename)).size > 20 * 1024 * 1024) throw new Error('参考图文件过大');
    return filename;
  }
  async attachments(p: PetStoryProject): Promise<string[]> {
    return Promise.all(p.assets.filter((a): boolean => a.kind !== 'video').map(async (a: PetStoryAsset): Promise<string> => {
      const file = await projectPath(this.directory(p.id), a.relativePath);
      await fs.access(file);
      return file;
    }));
  }
}

export function validatePromptProfile(value: unknown): PetStoryPromptProfile {
  const p = record(value); const characters = record(p.characters);
  if (typeof p.style !== 'string' || p.style.length > 10000) throw new Error('共同风格无效');
  if (p.assetStyles !== undefined) {
    for (const [kind, style] of Object.entries(record(p.assetStyles))) {
      if (!['common', 'character', 'prop', 'scene'].includes(kind) || typeof style !== 'string' || style.length > 10000) throw new Error('分类视觉风格无效');
    }
  }
  for (const [id, value] of Object.entries(characters)) {
    const c = record(value);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || typeof c.identity !== 'string' || typeof c.appearance !== 'string'
      || c.identity.length > 10000 || c.appearance.length > 10000) throw new Error('角色预设无效');
  }
  validateCastBindings(characters);
  return structuredClone(value) as PetStoryPromptProfile;
}

/** 批次只保存文字目标和进度，不保存自动重启授权。 */
function validatePromptBatch(value: unknown): void {
  const batch = record(value);
  if (!['running', 'paused', 'complete'].includes(String(batch.status)) || !Array.isArray(batch.targets)
    || !Number.isInteger(batch.total) || !Number.isInteger(batch.completed) || Number(batch.completed) < 0 || Number(batch.total) < Number(batch.completed)
    || batch.targets.length + Number(batch.completed) !== batch.total) throw new Error('文字批次进度无效');
  for (const item of batch.targets) {
    const t = record(item);
    if (!(typeof t.materialId === 'string' && !t.shotId && !t.kind || typeof t.shotId === 'string' && !t.materialId && ['firstFrame', 'lastFrame', 'video'].includes(String(t.kind)))) throw new Error('文字批次目标无效');
  }
  if (batch.jobId !== undefined && typeof batch.jobId !== 'string') throw new Error('文字批次运行无效');
}
