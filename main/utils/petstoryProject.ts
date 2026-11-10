import { buildPetStoryDiagnostics } from './petstoryDiagnostics';
import fs from 'node:fs/promises';
import { migrateLocalMediaSources } from './localMediaSource';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PetStoryProject, PetStoryPlan, PetStoryAsset, PetStoryPromptProfile, PetStoryPromptKind, PetStoryPromptEditBasis, PetStoryChatJob, PetStoryPromptBatch, PetStoryImageTarget, PetStoryProduction, PetStoryProductionStep } from '@doubao-studio/contracts';
import { assetCharacterIds, defaultPromptProfile, PROMPT_RULES_VERSION } from './petstoryPromptQuality';
import { collectPetStoryDialogueSourceIssues, extractDouyinLink, PetStoryContentValidationError, record, runtimePromptIssues, validatePetStoryPlan, validatePromptTask } from './petstoryValidation';
import { invalidateMaterialDependents, materialAsset, syncMaterials, storyHash, requireMaterialInventory } from './petstoryMaterials';
import { mediaDigest, validatePetStoryMedia } from './petstoryMedia';
import { archiveCompletedPetStoryProduction } from './petstoryProductionLifecycle';
import { imageOperationBlocksTargets } from './petstoryImageLifecycle';
import { validateCastBindings } from './petstoryCast';
import { validatePetStoryAdjustments } from './petstoryAdjustmentValidation';
import { imageTargetBasis, imageTargetMatches, selectedShotImageId, reconcileAdoptedImages } from './petstoryImageReview';
import { inspectPromptCandidate, inspectPromptEligibility, promptWritingTarget } from './petstoryEligibility';
import { boundaryStillCurrent, frameStillCurrent, hasSupersedingJob, runtimeContextStillCurrent, settlePromptBatchTarget } from './petstoryChat';
import { validateReferenceContinuationHistory } from './petstoryReferenceContinuation';
import { ensurePetStoryAutoModeTargets } from './petstoryModes';

/** 仅补当前可编辑方案的目标，不迁移原任务、候选或制作历史，也不触发任务。 */
function prepareEditableAutoModeTargets(project: PetStoryProject): void {
  const lockedProduction = project.production && (project.production.state !== 'complete' || project.production.steps.some((step): boolean => step.status !== 'complete'));
  if (!project.plan || lockedProduction || Object.values(project.imageProductions || {}).some((production): boolean => production.state !== 'complete' && !production.imageOperationId)
    || project.jobs.some((job): boolean => !job.endedWaitingAt && ['bound', 'captured'].includes(job.status))) return;
  // 历史曾采用的尾图仍应有可见用途，即使旧清单已经漏掉它的文字对象。
  for (const shot of project.plan.shots) {
    const tailId = project.adoptedImages?.[shot.id]?.plannedEndImageId;
    if (shot.requestedMode === 'auto' && !shot.prompts.lastFrame && project.assets.some((asset): boolean => asset.id === tailId && asset.shotId === shot.id && asset.kind === 'plannedEndImage')) {
      shot.prompts.lastFrame = { original: '', optimized: '', final: '', edited: false, rulesVersion: shot.prompts.firstFrame.rulesVersion };
    }
  }
  ensurePetStoryAutoModeTargets(project.plan);
}

/** 手动改剧情后，原样带回的旧判断不再冒充针对新剧情的分析结果。 */
function refreshEditedAutoModePlan(shot: PetStoryPlan['shots'][number], previous: PetStoryPlan['shots'][number] | undefined): void {
  if (shot.requestedMode !== 'auto' || !previous?.autoModePlan || !isDeepStrictEqual(shot.autoModePlan, previous.autoModePlan)) return;
  const basis = (value: PetStoryPlan['shots'][number]): object => ({ action: value.action, startState: value.startState, endState: value.endState,
    narrativePurpose: value.narrativePurpose, blocking: value.blocking, propStates: value.propStates, durationSeconds: value.durationSeconds, timingPlan: value.timingPlan });
  if (!isDeepStrictEqual(basis(shot), basis(previous))) shot.autoModePlan = undefined;
}

/** 格式纠正继承原请求职责；审查结果不能被当作可采用的正文。 */
function isPromptEditCreation(project: PetStoryProject, job: PetStoryChatJob, shotId: string, kind: PetStoryPromptKind): boolean {
  if (job.materialId || job.shotId !== shotId || job.promptKind !== kind || !['optimize', 'revise', 'repair'].includes(job.kind)) return false;
  let source = job; const seen = new Set<string>();
  while (source.kind === 'repair' && source.parentJobId && !seen.has(source.id)) {
    seen.add(source.id); const parent = project.jobs.find((item): boolean => item.id === source.parentJobId);
    if (!parent) break; source = parent;
  }
  return source.kind !== 'review' && job.originKind !== 'review';
}

/** 复用采用前资格，并核对用户打开时选中的实际候选及首尾帧快照。 */
function promptEditCandidate(project: PetStoryProject, shotId: string, kind: PetStoryPromptKind, jobId: string): PetStoryChatJob {
  const prompt = project.plan?.shots.find((shot): boolean => shot.id === shotId)?.prompts[kind];
  const job = project.jobs.find((item): boolean => item.id === jobId);
  if (!job || !prompt || !isPromptEditCreation(project, job, shotId, kind) || !job.requestId || job.status !== 'applied'
    || job.resultStatus !== 'candidate' || job.endedWaitingAt || job.sourceStoryId !== project.mobileStory?.id || !job.parsedResult?.optimized?.trim()
    || (prompt.candidateJobId ? prompt.candidateJobId !== job.id : prompt.optimized !== job.parsedResult.optimized)) throw new Error('选定候选已变化，请重新打开当前提示词后修改');
  if (hasSupersedingJob(project, job)) throw new Error('本项已有更新请求，请重新打开当前提示词后修改');
  if (!frameStillCurrent(project, job)) throw new Error('本镜首尾帧正文已变化，请重新打开当前提示词后修改');
  if (!boundaryStillCurrent(project, job)) throw new Error('前镜边界已变化，请重新打开当前提示词后修改');
  const issues = runtimePromptIssues(project, job, job.parsedResult.optimized);
  if (issues.length) throw new Error(`选定候选尚需修订：${issues.join('；')}`);
  if (job.promptTask?.designHash) {
    const qualification = inspectPromptCandidate(project, job);
    if (!qualification.writingReady) throw new Error(`选定候选尚需修订：${qualification.reasons.join('；')}`);
  } else if (!runtimeContextStillCurrent(project, job)) throw new Error('当前事实已变化，请重新打开当前提示词后修改');
  return job;
}

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
  validateImageOperations(result);
  validateAdoptedImages(result);
  validateSelectedVideos(result);
  validateTaskIntents(result);
  validateProduction(result, ids);
  return result;
}

/** 视频设置不被无关基础素材暂停锁住；同镜图片的原快照必须先正式结束。 */
function assertEditableShotVideoSettings(project: PetStoryProject, plan: PetStoryPlan): void {
  for (const shot of plan.shots) {
    const previous = project.plan?.shots.find((item): boolean => item.id === shot.id);
    if (!previous || previous.requestedMode === shot.requestedMode && previous.durationSeconds === shot.durationSeconds) continue;
    const sameShotImage = Object.values(project.imageProductions || {}).some((run): boolean => run.target?.shotId === shot.id && run.state !== 'complete' && run.state !== 'ended' && run.steps.some((step): boolean => step.status !== 'complete'));
    if (sameShotImage) throw new Error('本镜还有未结束的图片等待，请先在原图片节点结束本次图片等待后修改视频设置；原图片和任务保留');
  }
}

/** 操作台账兼容历史对象；具体执行时再核对当前事实与原文件。 */
function validateImageOperations(project: PetStoryProject): void {
  if (project.imageOperations === undefined) return;
  if (!Array.isArray(project.imageOperations)) throw new Error('图片操作记录无效');
  const ids = new Set<string>(); const requests = new Set<string>();
  for (const operation of project.imageOperations) {
    if (!operation || typeof operation.id !== 'string' || !operation.id || ids.has(operation.id)
      || typeof operation.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(operation.requestId) || requests.has(operation.requestId)
      || !['generate', 'modify'].includes(operation.mode) || !['preparing', 'generating', 'saving', 'complete', 'failed'].includes(operation.stage)
      || !Number.isFinite(Date.parse(operation.createdAt)) || !/^[a-f0-9]{64}$/.test(operation.basisHash)
      || !validImageOperationTarget(operation.target)) throw new Error('图片操作授权或进度记录无效');
    if (operation.endedAt !== undefined && !Number.isFinite(Date.parse(operation.endedAt))) throw new Error('图片结束等待记录无效，原文件保留');
    if (operation.mode === 'modify' && (typeof operation.feedback !== 'string' || !operation.feedback.trim() || operation.feedback.length > 4000
      || !/^[a-f0-9]{64}$/.test(operation.baseSha256 || '') || !project.assets.some((asset): boolean => asset.id === operation.baseAssetId && imageTargetMatches(asset, operation.target)))) throw new Error('图片修改基图或反馈记录无效');
    if (operation.chatJobId && !project.jobs.some((job): boolean => job.id === operation.chatJobId && job.materialId === operation.target.materialId)) throw new Error('图片准备原任务记录无效');
    if (operation.outputAssetId && !project.assets.some((asset): boolean => asset.id === operation.outputAssetId && imageTargetMatches(asset, operation.target))) throw new Error('图片输出与目标素材不符');
    ids.add(operation.id); requests.add(operation.requestId);
  }
}
function validImageOperationTarget(target: PetStoryImageTarget): boolean {
  return !!target && !!target.materialId !== !!target.shotId && (!target.shotId || ['firstFrame', 'lastFrame'].includes(target.kind || ''));
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

function validateSelectedVideos(result: PetStoryProject): void {
  if (result.selectedVideos === undefined) return;
  if (!result.selectedVideos || typeof result.selectedVideos !== 'object' || Array.isArray(result.selectedVideos)) throw new Error('镜头视频选择记录无效');
  for (const [shotId, assetId] of Object.entries(result.selectedVideos)) {
    // 删除镜头后的选择仅保留为历史，不参与当前投影，也不阻断新的方案保存。
    if (!result.plan?.shots.some((shot): boolean => shot.id === shotId)) continue;
    if (typeof assetId !== 'string' || !result.assets.some((asset): boolean => asset.id === assetId && asset.kind === 'video' && asset.shotId === shotId)) throw new Error('镜头选中视频缺失或归属不符');
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
      if (m.prompt.supersededByAssetId !== undefined && (m.kind !== 'character' || typeof m.prompt.supersededByAssetId !== 'string'
        || !result.assets.some((asset): boolean => asset.id === m.prompt.supersededByAssetId && imageTargetMatches(asset, { materialId: m.id })))) throw new Error('基础图历史正文的图片替代关系无效');
      if (m.visualBasis && (m.kind !== 'character' || m.visualBasis.assetId !== m.selectedAssetId || m.visualBasis.sha256 !== result.assets.find((asset): boolean => asset.id === m.visualBasis?.assetId)?.validation?.sha256 || !Number.isFinite(Date.parse(m.visualBasis.adoptedAt)))) throw new Error('角色视觉依据绑定无效');
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
    validateImageReview(asset, result);
  }
  return ids;
}
function validateImageReview(asset: PetStoryAsset, project: PetStoryProject): void {
    if (asset.imageReview) {
      const review = asset.imageReview;
      if (!['candidate', 'adopted'].includes(review.state) || !/^[a-f0-9]{64}$/.test(review.basisHash) || !imageTargetMatches(asset, review.target)
        || review.state === 'adopted' && (!review.adoptedAt || !Number.isFinite(Date.parse(review.adoptedAt)) || review.sha256 !== asset.validation?.sha256)) throw new Error('图片候选或采用记录无效');
      if (review.sourceReply && (!/^[a-f0-9-]{36}$/i.test(review.sourceReply.adjustmentId) || !/^[a-f0-9]{64}$/.test(review.sourceReply.replyKey) || !/^[a-f0-9]{64}$/.test(review.sourceReply.urlHash))) throw new Error('图片回复来源记录无效');
      if (review.resolvedCandidateIds !== undefined && (review.state !== 'adopted' || !Array.isArray(review.resolvedCandidateIds)
        || new Set(review.resolvedCandidateIds).size !== review.resolvedCandidateIds.length
        || review.resolvedCandidateIds.some((id): boolean => typeof id !== 'string' || id === asset.id
          || !project.assets.some((other): boolean => other.id === id && other.kind === asset.kind && imageTargetMatches(other, review.target))))) throw new Error('图片选图决定的候选归属无效');
    }
}
function validateImageProductions(result: PetStoryProject, ids: Set<string>): void {
  if (result.imageProductions === undefined) return;
  if (!result.imageProductions || typeof result.imageProductions !== 'object' || Array.isArray(result.imageProductions)) throw new Error('独立图片制作清单无效');
  for (const [operationId, production] of Object.entries(result.imageProductions)) {
    const operation = result.imageOperations?.find((item): boolean => item.id === operationId);
    if (!operation || !production || production.imageOperationId !== operationId || production.steps?.some((step): boolean => step.kind === 'video')) throw new Error('独立图片制作与原操作绑定不符');
    if (operation.target.materialId ? production.phase !== 'materials' || production.materialIds?.length !== 1 || production.materialIds[0] !== operation.target.materialId
      || production.steps?.some((step): boolean => step.materialId !== operation.target.materialId)
      : production.target?.shotId !== operation.target.shotId || production.target?.kind !== operation.target.kind) throw new Error('独立图片制作目标与授权不符');
    validateProduction({ ...result, imageProductions: undefined, production, productionHistory: undefined }, ids);
  }
}
/** 新日志和执行快照在读入边界核对；历史无此字段时保持原样读取。 */
function validateTaskIntents(project: PetStoryProject): void {
  if (project.taskIntents === undefined) return;
  if (!Array.isArray(project.taskIntents)) throw new Error('项目任务意图日志无效，原数据保留');
  const ids = new Set<string>();
  for (const intent of project.taskIntents) {
    const binding = intent.kind === 'media' ? intent.input?.petstory : intent.input?.petstoryChat;
    if (!intent.operationId || ids.has(intent.operationId) || !['media', 'chat'].includes(intent.kind) || !intent.targetId
      || intent.accountId !== project.accountId || binding?.projectId !== project.id || intent.input.projectId !== project.studioProjectId
      || !Array.isArray(intent.input.prompts) || intent.input.prompts.length !== 1 || !intent.input.prompts[0]?.trim()
      || intent.input.executionIntent !== 'hold' || !Number.isFinite(Date.parse(intent.createdAt))
      || (intent.kind === 'media' ? intent.input.petstory?.stepId : intent.input.petstoryChat?.jobId) !== intent.targetId) throw new Error('项目任务意图身份或输入无效，原数据保留');
    if (intent.chatJob && (intent.kind !== 'chat' || intent.chatJob.id !== intent.targetId)) throw new Error('正文准备意图与原任务不符');
    ids.add(intent.operationId);
  }
}
function validateVideoInputSnapshot(project: PetStoryProject, step: PetStoryProductionStep): void {
  const snapshot = step.videoInputSnapshot; if (!snapshot) return;
  const { digest, ...input } = snapshot;
  if (step.kind !== 'video' || snapshot.schemaVersion !== 1 || !Number.isInteger(snapshot.inputVersion) || snapshot.inputVersion < 1
    || snapshot.projectId !== project.id || snapshot.accountId !== project.accountId || snapshot.shotId !== step.shotId || snapshot.stepId !== step.id
    || !['first_frame', 'first_last_frame', 'reference'].includes(snapshot.mode) || typeof snapshot.prompt !== 'string' || !snapshot.prompt.trim()
    || typeof snapshot.sourceText !== 'string' || typeof snapshot.dialogue !== 'string' || !Array.isArray(snapshot.references)
    || snapshot.references.length !== step.attachmentAssetIds.length || snapshot.references.some((reference, index): boolean => reference.assetId !== step.attachmentAssetIds[index] || reference.order !== index + 1 || !/^[a-f0-9]{64}$/.test(reference.sha256))
    || digest !== createHash('sha256').update(JSON.stringify(input)).digest('hex')) throw new Error('原视频输入快照校验失败，原数据与媒体保留');
}
function validateProduction(result: PetStoryProject, ids: Set<string>): void {
  validateImageProductions(result, ids);
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
    if (production.phase !== 'materials') validateShotMedia(result, production, !production.imageOperationId);
  }
  validateProductionReferences(result, ids);
}
function validateProductionReferences(result: PetStoryProject, ids: Set<string>): void {
  if (result.productionHistory !== undefined && !Array.isArray(result.productionHistory)) throw new Error('历史制作清单无效，原文件已保留');
  for (const production of [result.production, ...(result.productionHistory || [])]) {
    for (const step of production?.steps || []) { validateResubmissionHistory(step, ids); validateVideoInputSnapshot(result, step); }
    if (production && production !== result.production) validateShotMedia(result, production);
    if (production) validateReferenceContinuationHistory(result.id, production);
  }
}

function invalidResubmissionHistory(): never { throw new Error('重发历史记录不完整或绑定无效，原文件已保留，请核对原任务'); }
function validResubmissionHistoryId(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value === value.trim() && value.length <= 200;
}
function validateResubmissionHistory(step: PetStoryProductionStep, assetIds: Set<string>): void {
  if (step.resubmissionHistory === undefined) return;
  if (!Array.isArray(step.resubmissionHistory)) invalidResubmissionHistory();
  const attempts = new Set<string>(); const authorizations = new Set<string>();
  for (const history of step.resubmissionHistory) {
    if (!history || typeof history !== 'object' || !validResubmissionHistoryId(history.taskId) || !validResubmissionHistoryId(history.runId)
      || !validResubmissionHistoryId(history.authorizationId) || history.taskId === step.taskId
      || typeof history.submittedAt !== 'string' || !Number.isFinite(Date.parse(history.submittedAt))
      || typeof history.authorizedAt !== 'string' || !Number.isFinite(Date.parse(history.authorizedAt))
      || !/^[a-f0-9]{64}$/.test(history.inputHash) || !Array.isArray(history.attachmentAssetIds)
      || history.attachmentAssetIds.some((id: string): boolean => typeof id !== 'string' || !assetIds.has(id))) invalidResubmissionHistory();
    const key = `${history.taskId}:${history.runId}:${history.submittedAt}`;
    if (attempts.has(key) || authorizations.has(history.authorizationId)) invalidResubmissionHistory();
    attempts.add(key); authorizations.add(history.authorizationId);
    validateResubmissionCompiled(history, step.kind);
    validateResubmissionPageBindings(history);
  }
}
function validateResubmissionCompiled(history: NonNullable<PetStoryProductionStep['resubmissionHistory']>[number], kind: PetStoryProductionStep['kind']): void {
  const compiled = history.compiledPrompt;
  if (compiled === undefined) return;
  if (!compiled || typeof compiled !== 'object' || compiled.kind !== kind || typeof compiled.text !== 'string' || !compiled.text.trim()
    || typeof compiled.final !== 'string' || !compiled.final.trim() || typeof compiled.rulesVersion !== 'string' || !Array.isArray(compiled.references)
    || createHash('sha256').update(JSON.stringify(compiled.text)).digest('hex') !== history.inputHash
    || compiled.references.length !== history.attachmentAssetIds.length
    || compiled.references.some((reference, index): boolean => !reference || reference.assetId !== history.attachmentAssetIds[index] || reference.order !== index + 1)) invalidResubmissionHistory();
}
function validateResubmissionPageBindings(history: NonNullable<PetStoryProductionStep['resubmissionHistory']>[number]): void {
  if (history.pageBindings === undefined) return;
  if (!Array.isArray(history.pageBindings) || history.pageBindings.length !== history.attachmentAssetIds.length) invalidResubmissionHistory();
  if (history.pageBindings.some((binding, index): boolean => !binding || binding.assetId !== history.attachmentAssetIds[index] || binding.order !== index + 1
    || !['reference', 'first_frame', 'last_frame'].includes(binding.slot) || !['plain', 'mention', 'slot'].includes(binding.reference)
    || typeof binding.label !== 'string' || !binding.label.trim() || binding.label.length > 40 || !/^[a-f0-9]{64}$/.test(binding.previewHash)
    || binding.fileSha256 !== undefined && !/^[a-f0-9]{64}$/.test(binding.fileSha256))) invalidResubmissionHistory();
}
function validateShotMedia(result: PetStoryProject, production: PetStoryProduction, matchesCurrentPlan: boolean = false): void {
  if (!production.shots || typeof production.shots !== 'object' || Array.isArray(production.shots)) throw new Error('镜头实际模式无效');
  // 独立图片和归档制作保存原模式事实；当前草稿的新版本不得改写或使其失效。
  if (matchesCurrentPlan && result.plan?.shots.some((shot): boolean => production.shots[shot.id]?.requestedMode !== shot.requestedMode)) throw new Error('镜头实际模式无效');
  for (const [shotId, media] of Object.entries(production.shots)) {
    if (!shotId || !media || !['auto', 'first_frame', 'first_last_frame', 'reference'].includes(media.requestedMode)
      || !['first_frame', 'first_last_frame', 'reference'].includes(media.resolvedMode)) throw new Error('镜头实际模式无效');
    for (const [key, kind] of [['firstFrameId', 'firstFrame'], ['plannedEndImageId', 'plannedEndImage'], ['videoId', 'video'], ['actualEndFrameId', 'actualEndFrame']] as const) {
      const id = media[key];
      if (id && !result.assets.some((asset): boolean => asset.id === id && asset.shotId === shotId && (asset.kind === kind || (key === 'firstFrameId' && asset.kind === 'actualEndFrame')))) throw new Error('镜头选中素材错绑');
    }
  }
}

/** 每个打开目录一条串行队列；只有主进程选择的目录会登记。 */
export class PetStoryProjects {
  private directories = new Map<string, string>();
  private queues = new Map<string, Promise<unknown>>();
  private writeQueues = new Map<string, Promise<unknown>>();
  constructor(private readonly replaceFile: (from: string, to: string) => Promise<void> = fs.rename) {}

  async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) || Promise.resolve();
    const next = previous.catch((): void => {}).then(work);
    this.queues.set(id, next);
    try { return await next; } finally { if (this.queues.get(id) === next) this.queues.delete(id); }
  }
  /** 只读取当前进程已打开项目；目录本身不进入导出。 */
  async diagnostics(): Promise<object[]> {
    return Promise.all([...this.directories.keys()].map(async (id: string): Promise<object> => {
      try { return buildPetStoryDiagnostics(await this.read(id)); }
      catch { return { projectId: id, readError: '项目当前不可读取，原文件保留' }; }
    }));
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
    prepareEditableAutoModeTargets(project);
    migrateLocalMediaSources(project);
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
    prepareEditableAutoModeTargets(project);
    migrateLocalMediaSources(project);
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
    const previous = this.writeQueues.get(project.id) || Promise.resolve();
    const work = previous.catch((): void => {}).then((): Promise<PetStoryProject> => this.writeCurrent(project));
    this.writeQueues.set(project.id, work);
    try { return await work; } finally { if (this.writeQueues.get(project.id) === work) this.writeQueues.delete(project.id); }
  }
  private async writeCurrent(project: PetStoryProject): Promise<PetStoryProject> {
    const current = await this.read(project.id);
    // 盘上原有小数方案和历史候选逐值保留；本次新增／改变的方案必须重新严格校验。
    const checked = validateProject(project, true);
    if (checked.plan && !isDeepStrictEqual(project.plan, current.plan)) checked.plan = validatePetStoryPlan(project.plan);
    for (const job of checked.jobs) {
      const previous = current.jobs.find((item): boolean => item.id === job.id);
      if (job.parsedResult?.plan && !isDeepStrictEqual(job.parsedResult.plan, previous?.parsedResult?.plan)) job.parsedResult.plan = validatePetStoryPlan(job.parsedResult.plan);
    }
    if (current.revision !== checked.revision) throw new Error('项目已被修改，请重新打开后操作');
    prepareEditableAutoModeTargets(checked);
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
    // 旧批次的当前候选补上批次归属，仅迁移明确保存的当前任务，不采用正文。
    for (const jobId of batch.candidateJobIds || []) {
      const job = p.jobs.find((item): boolean => item.id === jobId);
      if (!job || job.status !== 'applied' || !['candidate', 'adopted'].includes(job.resultStatus || '')) throw new Error('批次候选尚未合法保存');
      if (!job.promptBatchId && p.promptBatch?.jobId === jobId) job.promptBatchId = batch.id;
      if (job.promptBatchId !== batch.id) throw new Error('候选不属于当前文字批次');
    }
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
    assertEditableShotVideoSettings(p, checked);
    ensurePetStoryAutoModeTargets(checked);
    const sourceIssues = collectPetStoryDialogueSourceIssues(checked, p.mobileStory?.text || '');
    if (sourceIssues.length) throw new PetStoryContentValidationError(sourceIssues);
    for (const shot of checked.shots) {
      const previous = p.plan.shots.find((s): boolean => s.id === shot.id);
      refreshEditedAutoModePlan(shot, previous);
      if (shot.requestedMode === 'auto' && previous?.prompts.lastFrame && !shot.prompts.lastFrame) shot.prompts.lastFrame = structuredClone(previous.prompts.lastFrame);
      const timingChanged = !!previous && (previous.durationSeconds !== shot.durationSeconds || !isDeepStrictEqual(previous.timingPlan, shot.timingPlan));
      for (const kind of ['firstFrame', 'lastFrame', 'video'] as const) {
        const incoming = shot.prompts[kind];
        const old = previous?.prompts[kind];
        if (incoming && old) shot.prompts[kind] = { ...old, final: incoming.final, edited: old.edited || incoming.final !== old.final, basisJobId: incoming.final === old.final ? old.basisJobId : old.sourceJobId || old.basisJobId, sourceJobId: incoming.final === old.final ? old.sourceJobId : undefined,
          timingStale: incoming.final !== old.final ? undefined : old.timingStale,
          ...(timingChanged && incoming.final === old.final ? { timingStale: true } : {}) };
      }
    }
    ensurePetStoryAutoModeTargets(checked);
    p.plan = checked;
    if (p.materials) p.materials = syncMaterials(p);
    reconcileAdoptedImages(p);
    return this.write(p);
  }
  /** 只合并本项 final；候选回复与其他镜头可在等待保存期间继续回填。 */
  async saveShotPrompt(id: string, revision: number, shotId: string, kind: PetStoryPromptKind, final: string, basis?: PetStoryPromptEditBasis): Promise<PetStoryProject> {
    const p = await this.read(id);
    if (!Number.isInteger(revision) || revision > p.revision) throw new Error('项目版本无效，请刷新后操作');
    if (!['firstFrame', 'lastFrame', 'video'].includes(kind) || !final.trim() || final.length > 100_000) throw new Error('提示词用途或正文无效');
    const target = p.plan?.shots.find((s): boolean => s.id === shotId)?.prompts[kind];
    if (!target) throw new Error('镜头或提示词不存在');
    if (basis !== undefined) {
      const checked = record(basis);
      if (typeof checked.expectedFinal !== 'string' || checked.baseJobId !== undefined && (typeof checked.baseJobId !== 'string' || !checked.baseJobId)) throw new Error('手动修改基准无效，请重新打开提示词');
      if (target.final !== checked.expectedFinal) throw new Error('当前使用正文已变化，修改内容已保留，请重新打开提示词后保存');
    }
    if (p.production && !archiveCompletedPetStoryProduction(p)) throw new Error('原制作尚未结束，请先处理原任务，保留已有输入与素材');
    const source = basis?.baseJobId ? promptEditCandidate(p, shotId, kind, basis.baseJobId) : undefined;
    if (source) {
      // “确定”一次性采用选定候选的来源合同并保存手改；不会先写入未修改的候选。
      source.replacedPrompt = structuredClone(target); source.resultStatus = 'adopted';
      target.basisJobId = source.id; target.optimized = source.parsedResult!.optimized!;
      target.rulesVersion = source.rulesVersion || PROMPT_RULES_VERSION; target.promptTask = source.promptTask ? structuredClone(source.promptTask) : undefined;
      target.editIntent = source.editIntent ? structuredClone(source.editIntent) : undefined; target.needsReview = undefined;
    } else target.basisJobId = target.sourceJobId || target.basisJobId;
    if (final !== target.final || source) target.timingStale = undefined;
    target.final = final; target.edited = true; target.sourceJobId = undefined; target.visualBasisStale = undefined;
    if (basis) {
      target.candidateJobId = undefined;
      // 旧回复留在历史中；明确确认的手改正文不能被此前未采用候选或坏回复遮挡。
      for (const job of p.jobs) if (job !== source && isPromptEditCreation(p, job, shotId, kind)
        && (job.resultStatus === 'candidate' || job.status === 'invalid' && job.resultStatus !== 'adopted')) {
        job.resultStatus = 'stale'; job.staleReason = '用户已明确保存本项手改正文，此前回复保留为历史。';
      }
      const selection = { shotId, promptKind: kind };
      if (inspectPromptEligibility(p, target, promptWritingTarget(p, selection), 'current').writingReady) settlePromptBatchTarget(p, selection, source?.id);
    }
    return this.write(p);
  }
  async bindSharedReference(id: string, revision: number, characterId: string, assetId: string): Promise<PetStoryProject> {
    const p = await this.read(id);
    if (p.revision !== revision || p.production) throw new Error('项目版本变化或制作已锁定');
    if (!p.plan?.characters.some((character): boolean => character.id === characterId)) throw new Error('角色不存在');
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
  private editableMaterials(p: PetStoryProject, revision: number, targets?: PetStoryImageTarget[]): void {
    if (p.revision !== revision) throw new Error('项目版本变化，请刷新后操作');
    archiveCompletedPetStoryProduction(p);
    // 旧版独立图片也由同一目标／步骤策略判断，不能退回整批制作的全项目输入锁。
    const imageProduction = p.production?.imageOperationId && p.imageOperations?.some((operation): boolean => operation.id === p.production?.imageOperationId);
    // 停止后允许图片上传／选用；剧本和正文仍受原制作约束，恢复时另校验原输入依据。
    const pausedImageEdit = targets !== undefined && p.production?.state === 'paused';
    if (!imageProduction && !pausedImageEdit && (p.production?.state === 'running' || p.production?.steps.some((s): boolean => s.status !== 'complete'))) throw new Error('原制作尚有未结束步骤，请先处理原任务，不能替换其输入');
    const affected = p.imageOperations?.some((operation): boolean => imageOperationBlocksTargets(p, operation, targets));
    if (affected) throw new Error('当前图片或其实际引用仍有未结束任务，请先处理原任务');
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
    const p = await this.read(id); this.editableMaterials(p, revision, [{ materialId }]); requireMaterialInventory(p);
    const m = p.materials?.find((m): boolean => m.id === materialId);
    if (!m) throw new Error('基础素材不存在');
    const asset = p.assets.find((item): boolean => item.id === assetId && imageTargetMatches(item, { materialId }));
    if (!asset || asset.kind !== m.kind) throw new Error('请选择本素材的具体图片');
    // 历史列表只负责定位预览；采用必须经 approveMaterials / adoptImage 明确确认。
    return p;
  }
  async addMaterialImage(id: string, revision: number, materialId: string, sourcePath: string, source?: PetStoryImageImportSource): Promise<PetStoryProject> {
    const p = await this.read(id); this.editableMaterials(p, revision, [{ materialId }]); requireMaterialInventory(p);
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
    const p = await this.read(id); this.editableMaterials(p, revision, [{ shotId, kind }]); requireMaterialInventory(p);
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
    if (asset.visualBasisStale && target.shotId) throw new Error('角色图已更新，旧帧仅保留历史；请生成、上传或修改当前形象图片后采用');
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
    // 一次选图结束当前目标已知备选的待选状态；保留文件及原采用事实，供历史预览和再次修改。
    // 包含旧采用图，使其同运行迟到下载的兄弟图片也能沿用已完成的选择。
    const resolvedCandidateIds = p.assets.filter((other): boolean => other.id !== asset.id && other.kind === asset.kind && imageTargetMatches(other, target)).map((other): string => other.id);
    asset.imageReview = { state: 'adopted', target, basisHash, adoptedAt, sha256: validation.sha256, resolvedCandidateIds,
      ...(asset.imageReview?.sourceReply ? { sourceReply: asset.imageReview.sourceReply } : {}) };
    asset.needsReview = undefined;
    this.applyImageSelection(p, target, asset, oldId, adoptedAt, validation.sha256);
  }
  private applyImageSelection(p: PetStoryProject, target: PetStoryImageTarget, asset: PetStoryAsset, oldId: string | undefined, adoptedAt: string, sha256: string): void {
    const material = target.materialId ? p.materials?.find((item): boolean => item.id === target.materialId) : undefined;
    if (material) {
      material.selectedAssetId = asset.id;
      const character = material.kind === 'character' ? p.plan?.characters.find((item): boolean => item.id === material.entityId) : undefined;
      material.approved = { assetId: asset.id, sha256, at: adoptedAt, ...(character ? { identity: { assetId: asset.id } } : {}) };
      if (character) {
        character.referenceAssetId = asset.id;
        material.visualBasis = { assetId: asset.id, sha256, adoptedAt };
        // 保留旧正文、原回复和来源，不给上传图补造任何文字身份或 Chat 来源。
        material.prompt = { ...material.prompt, supersededByAssetId: asset.id, needsReview: undefined };
        for (const job of p.jobs) if (job.materialId === material.id && job.resultStatus !== 'adopted') {
          job.resultStatus = 'stale'; job.staleReason = '角色图已采用，原基础图文字仅保留历史。';
        }
      }
      if (oldId !== asset.id) invalidateMaterialDependents(p, material.id);
    } else if (target.shotId) {
      p.adoptedImages ||= {};
      const selected = p.adoptedImages[target.shotId] ||= {};
      selected[target.kind === 'firstFrame' ? 'firstFrameId' : 'plannedEndImageId'] = asset.id;
      const media = p.production?.shots[target.shotId];
      if (media) media[target.kind === 'firstFrame' ? 'firstFrameId' : 'plannedEndImageId'] = asset.id;
      if (oldId && oldId !== asset.id) for (const item of p.assets) {
        if (item.shotId === target.shotId && item.id !== asset.id && item.kind === 'video') item.needsReview = true;
      }
    }
  }
  async adoptImage(id: string, revision: number, target: PetStoryImageTarget, assetId: string): Promise<PetStoryProject> {
    const p = await this.read(id); this.editableMaterials(p, revision, [target]); requireMaterialInventory(p);
    if (!target || !!target.materialId === !!target.shotId) throw new Error('请选择唯一图片目标');
    await this.adoptProjectImage(p, target, assetId);
    return this.write(p);
  }
  async approveMaterials(id: string, revision: number, selections: { materialId: string; assetId: string }[]): Promise<PetStoryProject> {
    const p = await this.read(id); this.editableMaterials(p, revision, selections?.map((item): PetStoryImageTarget => ({ materialId: item.materialId }))); requireMaterialInventory(p);
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

function batchTargetCount(batch: Record<string, unknown>): number {
  const targets = Array.isArray(batch.targets) ? batch.targets : [];
  const failed = Array.isArray(batch.failedTargets) ? batch.failedTargets.map((item: unknown): unknown => record(item).target) : [];
  return new Set([...targets, ...failed].map((item: unknown): string => { const target = record(item); return target.materialId ? `material:${String(target.materialId)}` : `shot:${String(target.shotId)}:${String(target.kind)}`; })).size;
}

/** 批次只保存文字目标和进度，不保存自动重启授权。 */
function validatePromptBatch(value: unknown): void {
  const batch = record(value);
  if (!['running', 'paused', 'complete'].includes(String(batch.status)) || !Array.isArray(batch.targets)
    || !Number.isInteger(batch.total) || !Number.isInteger(batch.completed) || Number(batch.completed) < 0 || Number(batch.total) < Number(batch.completed)
    || batchTargetCount(batch) + Number(batch.completed) !== batch.total) throw new Error('文字批次进度无效');
  for (const item of batch.targets) {
    const t = record(item);
    if (!(typeof t.materialId === 'string' && !t.shotId && !t.kind || typeof t.shotId === 'string' && !t.materialId && ['firstFrame', 'lastFrame', 'video'].includes(String(t.kind)))) throw new Error('文字批次目标无效');
  }
  if (batch.id !== undefined && (typeof batch.id !== 'string' || !batch.id.trim())) throw new Error('文字批次身份无效');
  if (batch.candidateJobIds !== undefined && (!Array.isArray(batch.candidateJobIds) || batch.candidateJobIds.some((id: unknown): boolean => typeof id !== 'string') || new Set(batch.candidateJobIds).size !== batch.candidateJobIds.length)) throw new Error('文字候选关联无效');
  if (batch.jobId !== undefined && typeof batch.jobId !== 'string') throw new Error('文字批次运行无效');
}
