import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PetStoryProject, PetStoryPlan, PetStoryAsset } from '@doubao-studio/contracts';
import { extractDouyinLink, record, validatePetStoryPlan } from './petstoryValidation';

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
function validateMobileStory(value: unknown, sourceUrl: unknown): void {
  if (value === undefined) return;
  const story = record(value);
  if (!sourceUrl || typeof story.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(story.id)
    || typeof story.text !== 'string' || !story.text.trim() || story.text.length > 50_000
    || typeof story.importedAt !== 'string' || !Number.isFinite(Date.parse(story.importedAt))) throw new Error('手机豆包故事原文无效，原文件已保留');
}
export function validateProject(value: unknown): PetStoryProject {
  const p = record(value);
  if (p.schemaVersion !== 1 || typeof p.id !== 'string' || typeof p.studioProjectId !== 'string' || typeof p.accountId !== 'string' || !Number.isInteger(p.revision)) throw new Error('项目版本或身份无效，原文件已保留');
  const source = record(p.source);
  if (source.kind !== 'douyin') throw new Error('本项目仅接受抖音链接；原清单已保留，不支持本地原视频');
  if (source.url !== '') extractDouyinLink(String(source.url));
  if (!['pending', 'blocked', 'review_required'].includes(String(source.status))) throw new Error('来源状态无效');
  validateMobileStory(p.mobileStory, source.url);
  if (!Array.isArray(p.assets) || !Array.isArray(p.jobs)) throw new Error('项目资产或任务清单无效');
  const result = structuredClone(value) as PetStoryProject;
  if (p.plan) result.plan = validatePetStoryPlan(p.plan);
  const ids = validateAssets(result);
  for (const char of result.plan?.characters || []) {
    if (char.referenceAssetId && !result.assets.some((a: PetStoryAsset): boolean => a.id === char.referenceAssetId && a.characterId === char.id)) throw new Error(`${char.name}参考图错绑`);
  }
  for (const job of result.jobs) {
    if (!job.id || !job.taskId || !/^[a-f0-9]{64}$/.test(job.inputHash) || !['analysis', 'repair', 'optimize'].includes(job.kind)) throw new Error('项目任务绑定无效');
  }
  for (const shot of result.plan?.shots || []) {
    if (shot.sceneReferenceAssetIds?.some((id: string): boolean => !result.assets.some((a): boolean => a.id === id && a.kind === 'scene' && a.shotId === shot.id))) throw new Error('场景参考图错绑');
  }
  validateProduction(result, ids);
  return result;
}

function validateAssets(result: PetStoryProject): Set<string> {
  const ids = new Set<string>();
  for (const asset of result.assets) {
    if (typeof asset.id !== 'string' || ids.has(asset.id) || !['character', 'firstFrame', 'plannedEndImage', 'video', 'actualEndFrame', 'scene'].includes(asset.kind) || !(asset.kind === 'character' ? /^characters\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/i : /^shots\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp|mp4)$/i).test(asset.relativePath)) throw new Error('项目角色素材无效');
    ids.add(asset.id);
    if (asset.kind === 'video' && (!asset.taskId || !asset.runId || !asset.validation || !asset.downloadJobId || !asset.artifactId)) throw new Error('视频素材缺少真实产物归属');
    if (asset.validation && (asset.validation.decoded !== true || !/^[a-f0-9]{64}$/.test(asset.validation.sha256) || !(asset.validation.bytes > 0) || !(asset.validation.width > 0) || !(asset.validation.height > 0))) throw new Error('媒体校验记录无效');
    if (asset.kind === 'actualEndFrame' && (!asset.sourceVideo || !(asset.sourceVideo.atSeconds >= 0))) throw new Error('真实末帧缺少源视频信息');
  }
  return ids;
}
function validateProduction(result: PetStoryProject, ids: Set<string>): void {
  if (result.production) {
    const production = result.production;
    if (!result.plan || !['running', 'paused', 'complete'].includes(production.state) || !/^[a-f0-9]{64}$/.test(production.planHash)
      || !Array.isArray(production.steps) || !production.shots || production.capability?.accountId !== result.accountId) throw new Error('制作进度或账号绑定无效');
    const stepIds = new Set<string>();
    for (const step of production.steps) {
      if (!step.id || stepIds.has(step.id) || !['character', 'firstFrame', 'lastFrame', 'video'].includes(step.kind) || !['preparing', 'bound', 'complete'].includes(step.status)
        || !Array.isArray(step.attachmentAssetIds) || step.attachmentAssetIds.some((id: string): boolean => !ids.has(id)) || !/^[a-f0-9]{64}$/.test(step.inputHash)) throw new Error('制作步骤绑定无效');
      stepIds.add(step.id);
    }
    validateShotMedia(result);
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
    const project = validateProject(JSON.parse(await fs.readFile(filename, 'utf8')));
    if (project.id !== id) throw new Error('项目身份发生变化，已停止操作');
    return project;
  }
  async open(directory: string): Promise<PetStoryProject> {
    const real = await fs.realpath(directory);
    const filename = await projectPath(real, 'project.json');
    if ((await fs.stat(filename)).size > 8 * 1024 * 1024) throw new Error('项目文件超过 8 MiB');
    const project = validateProject(JSON.parse(await fs.readFile(filename, 'utf8')));
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
      source: { kind: 'douyin', url: '', status: 'pending' }, assets: [], jobs: [], updatedAt: new Date().toISOString() };
    await fs.writeFile(filename, JSON.stringify(project, null, 2), { flag: 'wx', mode: 0o600 });
    this.directories.set(project.id, real);
    return project;
  }
  async write(project: PetStoryProject): Promise<PetStoryProject> {
    const checked = validateProject(project);
    const current = await this.read(checked.id);
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
    if (!p.source.url) throw new Error('请先保存抖音链接');
    if (!text.trim() || text.length > 50_000) throw new Error('请粘贴手机豆包返回的故事情节原文（最多 50000 字符），无需 JSON');
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
    p.contentBasis = undefined;
    p.source = { ...p.source, status: 'pending', reason: '手机豆包故事原文已保存，待生成制作方案；请本人对照原视频核对内容' };
    return this.write(p);
  }
  async savePlan(id: string, revision: number, value: PetStoryPlan): Promise<PetStoryProject> {
    const p = await this.read(id);
    if (p.revision !== revision) throw new Error('项目版本已变化，请重新读取');
    if (!p.plan) throw new Error('请先取得本次 Chat 分析结果');
    if (p.production) throw new Error('P4 制作方案已确认，修改计划须等待后续局部重做入口；原素材和任务保留');
    const checked = validatePetStoryPlan(value);
    for (const shot of checked.shots) {
      const previous = p.plan.shots.find((s): boolean => s.id === shot.id);
      for (const kind of ['firstFrame', 'lastFrame', 'video'] as const) {
        const incoming = shot.prompts[kind];
        const old = previous?.prompts[kind];
        if (incoming && old) shot.prompts[kind] = { ...old, final: incoming.final, edited: old.edited || incoming.final !== old.final };
      }
    }
    p.plan = checked;
    return this.write(p);
  }
  async addReference(id: string, characterId: string, sourcePath: string): Promise<PetStoryProject> {
    const p = await this.read(id);
    if (p.production) throw new Error('制作中不能替换角色参考图，请保留原素材绑定');
    if (!['lulu', 'lumei', ...(p.plan?.characters.map((c): string => c.id) || [])].includes(characterId)) throw new Error('角色 ID 无效');
    if ((await fs.lstat(sourcePath)).isSymbolicLink()) throw new Error('参考图禁止符号链接');
    const ext = path.extname(sourcePath).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext) || (await fs.stat(sourcePath)).size > 20 * 1024 * 1024) throw new Error('参考图格式或大小不符合要求');
    const asset: PetStoryAsset = { id: randomUUID(), kind: 'character', characterId, relativePath: `characters/${randomUUID()}${ext}` };
    const directory = await projectPath(this.directory(id), 'characters');
    await fs.mkdir(directory, { recursive: true });
    const target = await projectPath(this.directory(id), asset.relativePath);
    await fs.copyFile(sourcePath, target, 1);
    p.assets = [...p.assets.filter((a: PetStoryAsset): boolean => a.characterId !== characterId), asset];
    const char = p.plan?.characters.find((c): boolean => c.id === characterId);
    if (char) char.referenceAssetId = asset.id;
    return this.write(p);
  }
  async addSceneReference(id: string, shotId: string, sourcePath: string): Promise<PetStoryProject> {
    const p = await this.read(id);
    const shot = p.plan?.shots.find((s): boolean => s.id === shotId);
    if (!shot || p.production) throw new Error('请在确认制作前选择当前镜头的场景参考图');
    const ext = path.extname(sourcePath).toLowerCase();
    const info = await fs.lstat(sourcePath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 20 * 1024 * 1024 || !['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('场景参考图格式或路径无效');
    const asset: PetStoryAsset = { id: randomUUID(), kind: 'scene', shotId, relativePath: `shots/${shotId}/${randomUUID()}${ext}` };
    const target = await projectPath(this.directory(id), asset.relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await projectPath(this.directory(id), asset.relativePath);
    await fs.copyFile(sourcePath, target, 1);
    p.assets.push(asset); shot.sceneReferenceAssetIds = [...(shot.sceneReferenceAssetIds || []), asset.id];
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
