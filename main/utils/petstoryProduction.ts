import { compileVideoInputSnapshot } from './videoInputCompiler';
import { commitPetStoryTaskIntent, reconcilePetStoryTaskIntents } from './petstoryTaskTransaction';
import { currentReferenceContinuation, referenceContinuationHash, referenceContinuationStep } from './petstoryReferenceContinuation';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DownloadJob, PetStoryAsset, PetStoryCapability, PetStoryChatJob, PetStoryExecutionGuard, PetStoryPlan, PetStoryProductionCounts, PetStoryProductionResult, PetStoryProductionStep, PetStoryProject, Task, TaskLocalMediaUpdate, TaskAddParams, TaskDownloadOutputsParams, TaskDownloadOutputsResult, TaskResubmitUncertainParams, PetStoryCompiledPrompt, PetStoryPromptKind, PetStoryShot, PetStoryShotMedia, PetStoryVideoReferenceRequest, PetStoryVideoReferenceContinuation } from '@doubao-studio/contracts';
import { PetStoryProjects, projectPath } from './petstoryProject';
import { compilePrompt, compileMaterialPrompt, checkPromptReferences, assetCharacterIds, requiresNativeFirstLastSlots } from './petstoryPromptQuality';
import { bindReferenceText } from './petstoryReferenceText';
import { approvedMaterialHash, legacyApprovedMaterialHash, materialAsset, requireApprovedMaterials, requireMaterialInventory, requireMaterialPromptSource, requiredMaterialKeys } from './petstoryMaterials';
import type { PetStoryPageBinding, PetStoryRuntimeTarget, PetStoryGenerationBlocker, PetStoryGenerationEligibilityResult, PetStoryModeResolution } from '@doubao-studio/contracts';
import { boundaryStillCurrent, finalTaskInput, frameStillCurrent, hasSupersedingJob, runtimeContextStillCurrent } from './petstoryChat';
import { runtimePromptIssues, validatePetStoryPlan } from './petstoryValidation';
import { validPetStoryDuration } from './petstoryValidationIssues';
import { petStoryAutoModePlan, plannedPetStoryMode, resolvePetStoryMode } from './petstoryModes';
import { productionCapability } from './petstoryCapability';
import { extractActualEndFrame, mediaDigest, validatePetStoryMedia, isConfirmedMediaRejection, MediaProcessingError } from './petstoryMedia';
import { inspectPromptCandidate, promptContractFactsCurrent, requirePromptEligibility, promptWritingTarget } from './petstoryEligibility';
import { pendingChatConflicts } from './petstoryPending';
import { hasCurrentPromptReviewError } from './petstoryReview';
import { localMediaSource, migrateLocalMediaSources, assertLocalMediaSource } from './localMediaSource';
import { downloadBelongsToArtifact } from './downloadIdentity';
import { compileImageFeedback, imageTargetBasis, imageTargetMatches, isPetStoryImageAdopted, selectedShotImageId, shotImageUnavailableReason } from './petstoryImageReview';

/** 页面绑定属于本次上传文件与当前编译片段，不接受导出文本作为绑定证据。 */
function validatePageBinding(p: PetStoryProject, step: PetStoryProductionStep, b: PetStoryPageBinding, index: number, unifiedFrames: boolean): void {
  const ref = step.compiledPrompt?.references[index];
  // 附件未在正文显式引用时不凭空补 @；仍核对该文件预览、素材目标和零节点证据。
  const noTextReference = !!step.compiledPrompt?.segments
    && !step.compiledPrompt.segments.some((segment): boolean => 'referenceOrder' in segment && segment.referenceOrder === b.order)
    && b.occurrenceCount === 0 && b.nodeIds?.length === 0;
      const slot = unifiedFrames ? 'reference' : ref?.slot === 'first' ? 'first_frame' : ref?.slot === 'last' ? 'last_frame' : 'reference';
      if (!/^(?:@图片[0-9]+|第 [0-9]+ 张图)$/.test(b.label) || (b.nodeId !== undefined && !/^[a-zA-Z0-9_:.=-]{1,160}$/.test(b.nodeId)) || b.assetId !== step.attachmentAssetIds[index] || b.order !== index + 1 || b.slot !== slot || !/^[a-f0-9]{64}$/.test(b.previewHash)
        || !['plain', 'mention', 'slot'].includes(b.reference) || b.label.length > 40 || (b.reference === 'mention' && !b.nodeId && !noTextReference)) throw new Error('页面素材／槽位／引用节点映射不符');
  validateBindingEvidence(p, step, b, slot, unifiedFrames);

}

function validateBindingEvidence(p: PetStoryProject, step: PetStoryProductionStep, b: PetStoryPageBinding, slot: PetStoryPageBinding['slot'], unifiedFrames: boolean): void {
      const source = step.compiledPrompt;
      if (source?.segments || unifiedFrames) {
        const asset = p.assets.find((a): boolean => a.id === b.assetId);
        if (!asset?.validation || b.fileSha256 !== asset.validation.sha256 || !/^[a-f0-9]{64}$/.test(b.fileSha256)) throw new Error('本次真实上传文件摘要与确认素材不符');
        if ((slot === 'reference') === (b.reference === 'slot')) throw new Error('普通引用和首尾槽位不能互换');
        if (b.reference === 'mention' && (!b.targetId || !/^[a-zA-Z0-9_:.=-]{1,160}$/.test(b.targetId) || !b.nodeIds || b.nodeIds.some((id): boolean => !/^[a-zA-Z0-9_:.=-]{1,160}$/.test(id))
          || b.occurrenceCount !== source?.segments?.filter((s): boolean => 'referenceOrder' in s && s.referenceOrder === b.order).length || b.nodeIds.length !== b.occurrenceCount)) throw new Error('每次原生引用的节点／素材目标证据不全');
      }}

/** 帧用途与页面上传方式分别保存；统一上传只接受完整的单张首帧或有序首尾两图，不混入半组槽位。 */
function usesUnifiedFrameBindings(step: PetStoryProductionStep, bindings: PetStoryPageBinding[]): boolean {
  const source = step.compiledPrompt;
  if (step.kind !== 'video' || !source) return false;
  const firstFrame = source.resolvedMode === 'first_frame' && source.references.length === 1 && source.references[0].slot === 'first';
  const firstLastFrame = source.resolvedMode === 'first_last_frame' && source.references.length === 2
    && source.references[0].slot === 'first' && source.references[1].slot === 'last';
  const unified = (firstFrame || firstLastFrame) && bindings.length === source.references.length
    && bindings.every((binding): boolean => binding.slot === 'reference' && ['mention', 'plain'].includes(binding.reference));
  if (unified && requiresNativeFirstLastSlots(source.final)) throw new Error('最终正文明确要求原生首尾帧槽，当前统一上传方式无法满足；原文和模式已保留，未提交');
  return unified;
}

function validatePageBindings(p: PetStoryProject, step: PetStoryProductionStep, bindings: PetStoryPageBinding[]): void {
  if (!Array.isArray(bindings) || bindings.length !== step.attachmentAssetIds.length) throw new Error('页面引用清单与本次运行不符');
  if (new Set(bindings.map((binding): string => `${binding.slot}:${binding.previewHash}`)).size !== bindings.length
    || new Set(bindings.map((binding): string => `${binding.slot}:${binding.label}`)).size !== bindings.length) throw new Error('多个文件指向同一页面素材或编号，禁止错绑');
  const targets = bindings.flatMap((binding): string[] => binding.slot === 'reference' && binding.targetId ? [binding.targetId] : []);
  if (new Set(targets).size !== targets.length) throw new Error('不同文件不能引用同一平台素材目标');
  const unifiedFrames = usesUnifiedFrameBindings(step, bindings);
  bindings.forEach((binding, index): void => validatePageBinding(p, step, binding, index, unifiedFrames));
}

type GenerationAdd = (code: PetStoryGenerationBlocker['code'], message: string, location?: Partial<PetStoryRuntimeTarget>) => void;
type GenerationCheck = (code: PetStoryGenerationBlocker['code'], work: () => void | Promise<unknown>, location?: Partial<PetStoryRuntimeTarget>) => Promise<boolean>;

interface MediaImportContext { task: Task }
interface ProductionPort {
  updateLocalMedia: (taskId: string, runId: string, patch: TaskLocalMediaUpdate) => Task;
  reviseVideoInput?: (taskId: string, expectedRunId: string, snapshot: NonNullable<Task['videoInputSnapshot']>) => Task;
  bindPageInput?: (taskId: string, runId: string, prompt: string) => Task;
  list: () => Task[];
  create: (params: TaskAddParams, accountId: string) => Task;
  adopt: (taskId: string, binding: NonNullable<Task['petstory']>, compiledPrompt?: string) => Task;
  retryUnsubmitted: (taskId: string) => Task;
  resubmitUncertain?: (params: TaskResubmitUncertainParams) => Task;
  downloads: () => DownloadJob[];
  cancelDownloads?: (taskId: string, runId?: string) => void;
  download: (params: TaskDownloadOutputsParams) => Promise<TaskDownloadOutputsResult>;
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requireValue<T>(value: T | undefined, message = '原制作引用缺失'): T { if (value === undefined) throw new Error(message); return value; }
function safePreparationFailure(code: string): boolean {
  // 正式派发守卫在发布页面执行权前拒绝；恢复仍须核对零提交证据，并重新绑定本次运行。
  return ['cancelled', 'dispatch_not_ready', 'chat_assets_not_ready', 'page_unrecognized', 'page_loading', 'page_changed', 'authentication_unconfirmed', 'petstory_controls_unconfirmed',
    'quota_exhausted', 'membership_required', 'login_required', 'verification', 'verification_required', 'verification_detected'].includes(code)
    || /^video_(?:[a-z_]+)_not_ready$/.test(code);
}
/** 仅兼容旧版误分类的确定未发送错误；未知错误及提交结果不明不能凭文案猜测重试。 */
function legacyUnsubmittedPreparationFailure(task: Task, step: PetStoryProductionStep): boolean {
  const error = task.errorInfo;
  const recognized = error?.code === 'submission_uncertain' && error.message === '最终全文或段落回读不一致，未提交'
    || task.mode === 'image' && error?.code === 'unknown' && error.message === '图片模式入口未就绪，已在提交前停止';
  return recognized && !!step.runId && step.runId === task.runtime?.runId && task.runtime.input.mode === task.mode;
}
/** 任何提交、观察、回复或产物记录都优先于可恢复错误码，不能用准备阶段重试清掉它们。 */
function hasSubmissionEvidence(task: Task): boolean {
  const runtime = task.runtime;
  return !!(runtime?.submittedAt || runtime?.submission && ['dispatch_unknown', 'accepted'].includes(runtime.submission.state) || runtime?.acceptanceObservation || runtime?.mediaSubmissionReceipt || runtime?.chatResponse || runtime?.chatReadback
    || runtime?.chatReadbackReview || runtime?.manualObservation || task.outputs.length || task.artifacts?.length);
}
/** 任何活跃租约、人工会话或重发关联都阻止清理原运行。 */
function referenceRecoveryGuarded(task: Task, step: PetStoryProductionStep): boolean {
  return !!(task.runtime?.chatAdjustmentGuard?.active
    || task.lock && (!Number.isFinite(Date.parse(task.lock.expiresAt)) || Date.parse(task.lock.expiresAt) > Date.now())
    || task.resubmissionOf !== undefined || task.resubmittedAs !== undefined || step.resubmissionHistory !== undefined);
}
function referenceVideoRecoveryRuntime(step: PetStoryProductionStep, task: Task, request: PetStoryVideoReferenceRequest): NonNullable<Task['runtime']> {
  const runtime = task.runtime;
  if (step.kind !== 'video' || step.shotId !== request.shotId || task.id !== request.taskId || step.runId !== request.runId || runtime?.runId !== request.runId
    || step.inputHash !== request.inputHash || !['fail', 'paused', 'cancelled'].includes(task.status) || task.errorInfo?.code !== 'petstory_controls_unconfirmed'
    || hasSubmissionEvidence(task) || runtime.stage === 'completed' || referenceRecoveryGuarded(task, step)) throw new Error('原视频不满足明确未提交的恢复条件，未改模式或发送');
  return runtime;
}
function referenceVideoFrames(p: PetStoryProject, production: NonNullable<PetStoryProject['production']>, step: PetStoryProductionStep, request: PetStoryVideoReferenceRequest): { media: PetStoryShotMedia; shot: PetStoryShot } {
  const media = requireValue(production.shots[request.shotId]); const shot = requireValue(p.plan?.shots.find((item): boolean => item.id === request.shotId));
  if (media.resolvedMode !== 'first_last_frame' || shot.prompts.video.promptTask?.mode !== 'first_last_frame'
    || request.firstFrameId !== selectedShotImageId(p, shot.id, 'firstFrame') || request.lastFrameId !== selectedShotImageId(p, shot.id, 'lastFrame')
    || JSON.stringify(step.attachmentAssetIds) !== JSON.stringify([request.firstFrameId, request.lastFrameId]) || step.attachmentAssetIds.length !== 2) throw new Error('仅允许原生首尾任务当前已选的两张图片按原顺序改作参考图');
  return { media, shot };
}
/** 旧运行只按原算法精确核对，不能将新hash回写为旧任务的授权。 */
export function legacyProductionPlanHash(plan: PetStoryPlan): string {
  return hash({ ...plan, characters: plan.characters.map((character): object => ({ ...character, referenceAssetId: undefined })) });
}
/** 角色图绑定后只锁定剧情角色和实际图片；旧造型描述不再属于下游制作事实。 */
export function productionPlanHash(plan: PetStoryPlan): string {
  const imageBacked = new Set(plan.characters.filter((character): boolean => !!character.referenceAssetId).map((character): string => character.id));
  const characters = plan.characters.map((character): object => {
    if (!imageBacked.has(character.id)) return { ...character, referenceAssetId: undefined };
    const { description: _description, continuity: _continuity, ...facts } = character;
    return facts;
  });
  const shots = plan.shots.map((shot): object => {
    if (!shot.appearanceOverrides) return shot;
    const remaining = Object.fromEntries(Object.entries(shot.appearanceOverrides).filter(([id]): boolean => !imageBacked.has(id)));
    return { ...shot, appearanceOverrides: Object.keys(remaining).length ? remaining : undefined };
  });
  return hash({ ...plan, characters, shots });
}
function productionPlanMatches(p: PetStoryProject): boolean {
  if (!p.plan || !p.production) return false;
  return p.production.planHash === productionPlanHash(p.plan) || p.production.planHash === legacyProductionPlanHash(p.plan);
}
function productionMaterialsMatch(p: PetStoryProject, production: NonNullable<PetStoryProject['production']>): boolean {
  const scope = productionShotScope(production);
  if (production.materialHash === approvedMaterialHash(p, scope) || production.materialHash === legacyApprovedMaterialHash(p, scope)) return true;
  // 旧单节点运行曾保存全清单摘要，仍只在原摘要精确匹配时兼容。
  return !!production.target && (production.materialHash === approvedMaterialHash(p) || production.materialHash === legacyApprovedMaterialHash(p));
}
export function productionCounts(p: PetStoryProject, capability: PetStoryCapability, fallbacks: Record<string, 'first_frame' | 'reference'>): PetStoryProductionCounts {
  const plan = validatePetStoryPlan(p.plan);
  const required = new Set(plan.shots.flatMap((s): string[] => s.characterIds));
  const supporting = plan.characters.filter((c): boolean => c.role === 'supporting' && required.has(c.id));
  const modes = plan.shots.map((s): string => resolvePetStoryMode(s, capability, fallbacks[s.id]).resolvedMode);
  return { shots: plan.shots.length, supporting: supporting.length, newCharacters: supporting.filter((c): boolean => !c.referenceAssetId).length,
    firstFrames: plan.shots.filter((s): boolean => (!!p.materials || s.transition === 'cut') && !p.production?.shots[s.id]?.firstFrameId).length,
    lastFrames: modes.filter((m, i): boolean => m === 'first_last_frame' && !p.production?.shots[plan.shots[i].id]?.plannedEndImageId).length,
    videos: plan.shots.filter((s): boolean => !p.production?.shots[s.id]?.videoId).length };
}
export function checkProductionReferences(final: string, p: PetStoryProject, assetIds: string[]): void {
  checkPromptReferences(final, p, assetIds.map((id, index) => {
    const a = requireValue(p.assets.find((asset): boolean => asset.id === id), '引用素材缺失');
    return { assetId: id, materialId: a.materialId || p.materials?.find((m): boolean => m.selectedAssetId === a.id)?.id, order: index + 1, characterIds: assetCharacterIds(a),
      purpose: a.kind === 'character' ? 'identity' : a.kind === 'video' ? 'scene' : a.kind };
  }));
}
function productionStepTarget(step?: Pick<PetStoryProductionStep, 'materialId' | 'shotId' | 'kind'>): PetStoryRuntimeTarget | undefined {
  if (!step) return undefined;
  return { materialId: step.materialId, shotId: step.shotId, promptKind: ['firstFrame', 'lastFrame', 'video'].includes(step.kind) ? step.kind as PetStoryPromptKind : undefined };
}
function productionResumeTarget(production: NonNullable<PetStoryProject['production']>, pending?: PetStoryProductionStep): PetStoryRuntimeTarget | undefined { return production.target || productionStepTarget(pending); }
function productionShotScope(production: NonNullable<PetStoryProject['production']>): string[] | undefined { return production.target ? [production.target.shotId] : undefined; }
function needsContinuationFrame(shot: PetStoryShot, media: PetStoryShotMedia, shots: Record<string, PetStoryShotMedia>): boolean {
  return shot.transition === 'continue' && (!media.actualEndFrameId || media.startFromPreviousEnd?.assetId !== shots[shot.previousShotId || '']?.videoId)
    && !!shot.prompts.firstFrame.promptTask?.references.some((reference): boolean => reference.purpose === 'actualEndFrame');
}
function isFeedbackBase(p: PetStoryProject, asset: PetStoryAsset, operationId?: string): boolean {
  const operation = operationId ? p.imageOperations?.find((item): boolean => item.id === operationId && item.mode === 'modify') : undefined;
  return !!operation && p.production?.imageOperationId === operation.id && operation.baseAssetId === asset.id
    && operation.baseSha256 === asset.validation?.sha256 && imageTargetMatches(asset, operation.target);
}
/** 只读选择仍对应当前创作依据的回复；恢复文案不能引导采用或修复过期结果。 */
function currentShotPromptReply(p: PetStoryProject, shot: PetStoryShot, kind: PetStoryPromptKind): PetStoryChatJob | undefined {
  const job = [...p.jobs].reverse().find((item): boolean => item.shotId === shot.id && item.promptKind === kind
    && ['optimize', 'revise', 'repair'].includes(item.kind) && item.originKind !== 'review');
  if (!job || !p.mobileStory || job.endedWaitingAt || job.resultStatus === 'stale' || job.sourceStoryId !== p.mobileStory.id || hasSupersedingJob(p, job)) return undefined;
  if (job.inputFinal !== undefined && job.inputFinal !== shot.prompts[kind]?.final || !frameStillCurrent(p, job) || !boundaryStillCurrent(p, job)) return undefined;
  const current = job.promptTask?.designHash ? promptContractFactsCurrent(p, job) : job.contextHash === undefined || runtimeContextStillCurrent(p, job);
  return current ? job : undefined;
}
function pendingShotPromptMessage(p: PetStoryProject, job: PetStoryChatJob, label: string, tasks: Task[]): string {
  const task = tasks.find((item): boolean => item.id === job.taskId && item.mode === 'chat' && item.projectId === p.studioProjectId && item.assignedAccountId === p.accountId);
  if (!task) return `${label}的原文字任务状态待同步，请检查原任务；不会重复提交。`;
  if (task.errorInfo?.code === 'submission_uncertain') return `${label}的原文字任务是否受理尚未确认，请检查原结果；不会自动重发。`;
  if (task.status === 'waiting_verification') return `${label}后台准备已暂停：请先完成原账号登录或人机验证。`;
  if (['fail', 'paused', 'cancelled'].includes(task.status)) return `${label}后台准备已暂停：${task.errorInfo?.message || job.error || '原文字任务尚未完成'}。`;
  if (task.status === 'queued' && task.executionIntent === 'hold') return `${label}文字任务等待继续；开始本镜制作后将接续原任务。`;
  return `${label}正在后台准备并校验，校验通过后请确认使用。`;
}
function missingShotPromptMessage(p: PetStoryProject, shot: PetStoryShot, kind: PetStoryPromptKind, tasks: Task[]): string {
  const label = { firstFrame: '首帧生图提示词', lastFrame: '尾帧编辑提示词', video: '视频提示词 / 运镜' }[kind];
  const job = currentShotPromptReply(p, shot, kind);
  if (job?.status === 'invalid') {
    if (job.rawText && job.requestId && job.validationDetails?.length && job.validationDetails.every((issue): boolean => issue.repairable)) {
      return `${label}尚未通过校验；开始本镜制作后，软件会在后台按原要求持续修订并校验，通过后请确认使用。`;
    }
    const reason = job.validationDetails?.find((issue): boolean => !issue.repairable)?.message || job.error || '原回复缺少可核验的归属或完整校验记录';
    return `${label}后台准备已暂停：${reason}。请先查看豆包对话并核对原结果。`;
  }
  if (job?.status === 'applied' && job.resultStatus === 'candidate' && job.parsedResult?.optimized?.trim()
    && inspectPromptCandidate(p, job).writingReady && !runtimePromptIssues(p, job, job.parsedResult.optimized).length) {
    return `${label}已有待采用候选，请先在对应提示词节点“确认使用”，再生成媒体。`;
  }
  if (job && ['bound', 'captured'].includes(job.status)) return pendingShotPromptMessage(p, job, label, tasks);
  return `${label}尚未准备；开始本镜制作后将先在后台准备并校验，通过后请确认使用。`;
}
function checkPlannedReferences(p: PetStoryProject, capability: PetStoryCapability, fallbacks: Record<string, 'first_frame' | 'reference'>): void {
  for (const shot of requireValue(p.plan).shots) {
    const mode = resolvePetStoryMode(shot, capability, fallbacks[shot.id]).resolvedMode;
    if (shot.transition === 'cut' || p.materials) { requirePromptEligibility(p, shot.prompts.firstFrame, { shotId: shot.id, promptKind: 'firstFrame' }); compilePrompt(p, shot.id, 'firstFrame', undefined, true); }
    if (mode === 'first_last_frame') { requirePromptEligibility(p, requireValue(shot.prompts.lastFrame, '本镜尾帧正文待生成'), { shotId: shot.id, promptKind: 'lastFrame' }); compilePrompt(p, shot.id, 'lastFrame', undefined, true); }
    requirePromptEligibility(p, shot.prompts.video, { shotId: shot.id, promptKind: 'video', mode, model: capability.videoConfig?.model });
    compilePrompt(p, shot.id, 'video', mode, true);
  }
}
/** 线性业务接力。只准备原 TaskService 的单个 hold 任务，发送仍由正式执行协调器完成。 */
export class PetStoryProductionService {
  private readonly authorized = new Set<string>();
  private readonly advances = new Map<string, Promise<PetStoryProductionResult>>();
  private readonly validated = new Map<string, string>();
  private readonly imageServices = new Map<string, PetStoryProductionService>();
  suspend(id: string): void {
    this.authorized.delete(id);
    for (const task of this.tasks.list()) {
      if (task.petstory?.projectId !== id || this.imageOperationId && task.petstory.imageOperationId !== this.imageOperationId) continue;
      this.tasks.cancelDownloads?.(task.id, task.runtime?.runId);
      const local = task.runtime?.localMedia;
      if (task.runtime && local?.state === 'working') this.tasks.updateLocalMedia(task.id, task.runtime.runId, { ...local, state: 'paused', expectedRevision: task.revision });
    }
    for (const service of this.imageServices.values()) service.suspend(id);
  }
  constructor(private readonly projects: Pick<PetStoryProjects, 'read' | 'write' | 'directory' | 'referenceFile'>, private readonly tasks: ProductionPort, private readonly imageOperationId?: string) {}

  /** 图片流程只投影自己的 production；落盘时还原其他流程，仍由外层项目事务串行保护。 */
  async withImageOperation<T extends PetStoryProductionResult>(id: string, operationId: string, work: (service: PetStoryProductionService) => Promise<T>): Promise<T> {
    let service = this.imageServices.get(operationId);
    if (!service) {
      const scoped: Pick<PetStoryProjects, 'read' | 'write' | 'directory' | 'referenceFile'> = {
        directory: (projectId: string): string => this.projects.directory(projectId),
        referenceFile: (projectId: string, assetId: string): Promise<string> => this.projects.referenceFile(projectId, assetId),
        read: async (projectId: string): Promise<PetStoryProject> => {
          const p = await this.projects.read(projectId);
          return { ...p, production: p.imageProductions?.[operationId] || (p.production?.imageOperationId === operationId ? p.production : undefined) };
        },
        write: async (p: PetStoryProject): Promise<PetStoryProject> => {
          const original = await this.projects.read(p.id);
          const production = p.production;
          if (production && production.imageOperationId !== operationId) throw new Error('图片制作授权与独立执行目标不符');
          const saved = await this.projects.write({ ...p, production: original.production?.imageOperationId === operationId ? undefined : original.production,
            imageProductions: { ...p.imageProductions, ...(production ? { [operationId]: production } : {}) } });
          return { ...saved, production: saved.imageProductions?.[operationId] };
        },
      };
      service = new PetStoryProductionService(scoped, this.tasks, operationId);
      this.imageServices.set(operationId, service);
    }
    const result = await work(service);
    return result.project ? { ...result, project: await this.projects.read(id) } : result;
  }

  private async imageTaskResult(taskId: string, work: (service: PetStoryProductionService) => Promise<PetStoryProductionResult>): Promise<PetStoryProductionResult | undefined> {
    if (this.imageOperationId) return undefined;
    const task = this.tasks.list().find((item): boolean => item.id === taskId);
    if (!task?.petstory) return undefined;
    const p = await this.projects.read(task.petstory.projectId);
    const operationId = task.petstory.imageOperationId || Object.entries(p.imageProductions || {}).find(([, run]): boolean => run.steps.some((step): boolean => step.taskId === taskId))?.[0];
    return operationId ? this.withImageOperation(p.id, operationId, work) : undefined;
  }

  /** 只读复用正式生产校验；不写项目、不创建任务，也不提取连续镜头末帧。 */
  async inspectGeneration(id: string, revision: number, target: PetStoryRuntimeTarget, capability?: PetStoryCapability, fallbacks: Record<string, 'first_frame' | 'reference'> = {}): Promise<PetStoryGenerationEligibilityResult> {
    const p = await this.projects.read(id);
    if (p.revision !== revision) throw new Error('项目已变化，请刷新当前操作的前置条件');
    if (!target || !!target.materialId === !!target.shotId || target.shotId && !['firstFrame', 'lastFrame', 'video'].includes(target.promptKind || '')) throw new Error('请选择当前项目的具体素材或镜头节点');
    const blockers: PetStoryGenerationBlocker[] = [];
    const add = (code: PetStoryGenerationBlocker['code'], message: string, location: Partial<PetStoryRuntimeTarget> = target): void => {
      if (!blockers.some((item): boolean => item.code === code && item.message === message)) blockers.push({ code, message, materialId: location.materialId, shotId: location.shotId, promptKind: location.promptKind });
    };
    const check = async (code: PetStoryGenerationBlocker['code'], work: () => void | Promise<unknown>, location?: Partial<PetStoryRuntimeTarget>): Promise<boolean> => {
      try { await work(); return true; }
      catch (error: unknown) { add(code, error instanceof Error ? error.message : '当前条件无法确认', location); return false; }
    };
    const pending = pendingChatConflicts(p, target);
    for (const job of pending) blockers.push({ code: 'task', message: '本目标或其依赖仍在等待原豆包回复，请检查原回复或明确结束等待；不会重复发送。', jobId: job.id, materialId: job.materialId, shotId: job.shotId, promptKind: job.promptKind });
    if (p.production && p.production.state !== 'complete') add('task', '已有制作任务尚未结束，请先查看并处理当前任务。');
    capability = productionCapability(p, capability);
    await check('story', (): void => requireMaterialInventory(p));
    const resolution = target.materialId
      ? await this.inspectMaterialGeneration(p, target.materialId, check)
      : await this.inspectShotGeneration(p, target, capability, fallbacks, check, add);
    if ((await this.projects.read(id)).revision !== p.revision) throw new Error('检查期间项目已变化，请刷新当前操作的前置条件');
    return { success: true, eligibility: { ready: !blockers.length, blockers, resolvedMode: resolution?.resolvedMode, modeReason: resolution?.reason } };
  }
  private async inspectMaterialGeneration(p: PetStoryProject, materialId: string, check: GenerationCheck): Promise<undefined> {
    if (!p.materials?.some((item): boolean => item.id === materialId)) throw new Error('基础素材不属于当前项目');
    const validPrompt = await check('prompt', (): void => { requireMaterialPromptSource(p, materialId); });
    if (validPrompt) await check('materials', async (): Promise<void> => {
      const compiled = this.compileMaterial(p, materialId);
      await Promise.all(compiled.references.map((ref): Promise<string> => this.assetFile(p, ref.assetId, 'image')));
    });
    return undefined;
  }
  private async inspectShotGeneration(p: PetStoryProject, target: PetStoryRuntimeTarget, capability: PetStoryCapability | undefined, fallbacks: Record<string, 'first_frame' | 'reference'>, check: GenerationCheck, add: GenerationAdd): Promise<PetStoryModeResolution | undefined> {
    let resolution: PetStoryModeResolution | undefined;
    const shot = p.plan?.shots.find((item): boolean => item.id === target.shotId);
    if (!shot) throw new Error('镜头节点不属于当前方案');
    const kind = requireValue(target.promptKind, '请选择镜头节点');
    const prompt = shot.prompts[kind];
    const approved = await check('materials', (): Promise<void> => this.checkApprovedFiles(p, [shot.id]));
    if (!approved && p.plan) {
      for (const key of requiredMaterialKeys(p.plan, [shot.id])) await check('materials', (): void => { materialAsset(p, key); }, { materialId: key });
    }
    const media = this.shotMedia(p)[shot.id];
    if (kind !== 'firstFrame' && !media.firstFrameId) add('firstFrame', shotImageUnavailableReason(p, shot.id, 'firstFrame'), { shotId: shot.id, promptKind: 'firstFrame' });
    if (kind === 'video' && capability) {
      await check('capability', (): void => { resolution = resolvePetStoryMode(shot, capability, fallbacks[shot.id]); });
      if (resolution?.resolvedMode === 'first_last_frame' && !media.plannedEndImageId) add('lastFrame', shotImageUnavailableReason(p, shot.id, 'lastFrame'), { shotId: shot.id, promptKind: 'lastFrame' });
    }
    const mode = kind === 'video' ? resolution?.resolvedMode || promptWritingTarget(p, target).mode : undefined;
    const promptValid = await check('prompt', (): void => {
      if (!prompt?.final.trim()) throw new Error(missingShotPromptMessage(p, shot, kind, this.tasks.list()));
      requirePromptEligibility(p, prompt, { shotId: shot.id, promptKind: kind, mode, model: capability?.videoConfig?.model });
    });
    const needsActualEnd = kind === 'firstFrame' && needsContinuationFrame(shot, media, this.shotMedia(p));
    if (needsActualEnd) {
      // 实际提取只在用户授权生成后发生；查询仅验证正式提取将读取的前镜真实视频。
      const previous = this.shotMedia(p)[shot.previousShotId || ''];
      await check('firstFrame', async (): Promise<void> => { await this.assetFile(p, requireValue(previous?.videoId, '连续镜头需要前镜实际视频，请先完成前镜视频。'), 'video'); }, { shotId: shot.previousShotId, promptKind: 'video' });
    } else if (promptValid && approved && (kind !== 'video' || resolution)) await check('prompt', async (): Promise<void> => {
      const snapshot = this.generationSnapshot(p, capability, fallbacks);
      const compiled = compilePrompt(snapshot, shot.id, kind, mode);
      await Promise.all(compiled.references.map((ref): Promise<string> => this.assetFile(snapshot, ref.assetId, 'image')));
    });
    return resolution;
  }
  /** 仅供只读编译；使用本次入口与同一媒体投影，不沿用历史模型，也不写入授权。 */
  private generationSnapshot(p: PetStoryProject, capability: PetStoryCapability | undefined, fallbacks: Record<string, 'first_frame' | 'reference'>): PetStoryProject {
    const snapshot = structuredClone(p);
    const shots = this.shotMedia(p);
    if (capability) snapshot.production = { phase: 'shots', state: 'running', planHash: productionPlanHash(requireValue(p.plan)), approvedAt: p.updatedAt, capability, fallbacks, shots, steps: [], message: '只读生成条件检查' };
    else if (snapshot.production) snapshot.production.shots = shots;
    return snapshot;
  }
  /** 读取当前与历史所选媒体的规则与正式单节点创建保持一致。 */
  private shotMedia(p: PetStoryProject): Record<string, PetStoryShotMedia> {
    return Object.fromEntries((p.plan?.shots || []).map((shot): [string, PetStoryShotMedia] => {
      const prior = [p.production, ...(p.productionHistory || []).slice().reverse()].find((run): boolean => !!run?.shots[shot.id])?.shots[shot.id];
      const latest = (kind: PetStoryAsset['kind']): string | undefined => [...p.assets].reverse().find((asset): boolean => asset.shotId === shot.id && asset.kind === kind)?.id;
      // 图片制作历史只提供媒体归属，不代表用户为新视频选择了多参考模式。
      const activeVideo = p.production?.steps.some((step): boolean => step.shotId === shot.id && step.kind === 'video');
      const mode = activeVideo ? p.production?.shots[shot.id]?.resolvedMode || plannedPetStoryMode(shot) : plannedPetStoryMode(shot);
      const reason = activeVideo ? p.production?.shots[shot.id]?.reason : shot.requestedMode === 'auto' ? petStoryAutoModePlan(shot).reason : '按请求模式准备，执行时读取页面控件';
      return [shot.id, { requestedMode: shot.requestedMode, resolvedMode: mode, reason: reason || '沿用原视频任务的执行模式', firstFrameId: selectedShotImageId(p, shot.id, 'firstFrame'), plannedEndImageId: selectedShotImageId(p, shot.id, 'lastFrame'), videoId: p.selectedVideos?.[shot.id] || prior?.videoId || latest('video'), actualEndFrameId: prior?.actualEndFrameId, startFromPreviousEnd: prior?.startFromPreviousEnd }];
    }));
  }
  async preview(id: string, capability: PetStoryCapability | undefined = undefined, fallbacks: Record<string, 'first_frame' | 'reference'> = {}): Promise<PetStoryProductionResult> {
    const p = await this.projects.read(id);
    capability = productionCapability(p, capability);
    this.validateRequestContext(p, capability);
    checkPlannedReferences(p, capability, fallbacks);
    return { success: true, project: p, counts: productionCounts(p, capability, fallbacks), resolutions: Object.fromEntries(requireValue(p.plan).shots.map((shot): [string, ReturnType<typeof resolvePetStoryMode>] => [shot.id, resolvePetStoryMode(shot, capability, fallbacks[shot.id])])) };
  }
  private validateRequestContext(p: PetStoryProject, c: PetStoryCapability, target?: PetStoryRuntimeTarget): void {
    if (pendingChatConflicts(p, target).length) throw new Error('本目标或其依赖仍有未收取的普通 Chat 原任务；请只读收取或明确结束等待，不自动重发');
    if (c.accountId !== p.accountId) throw new Error('生成参数与项目原账号不符');
  }
  async approve(id: string, revision: number, capability: PetStoryCapability | undefined = undefined, fallbacks: Record<string, 'first_frame' | 'reference'> = {}): Promise<PetStoryProductionResult> {
    let p = await this.projects.read(id);
    capability = productionCapability(p, capability);
    if (p.revision !== revision) throw new Error('项目版本已变化，请重新确认制作计划');
    if (p.production?.phase === 'materials' && p.production.state === 'complete') { p.productionHistory = [...(p.productionHistory || []), p.production]; p.production = undefined; }
    if (p.production) throw new Error('制作计划已确认，请继续原制作，不重复创建');
    if (!p.plan || !p.mobileStory || p.source.status !== 'review_required') throw new Error('请先保存有效的 P2/P3 制作方案');
    this.validateRequestContext(p, capability);
    await this.checkApprovedFiles(p);
    const counts = productionCounts(p, capability, fallbacks);
    checkPlannedReferences(p, capability, fallbacks);
    for (const char of p.plan.characters.filter((c): boolean => c.role === 'main' && (p.plan?.shots || []).some((s): boolean => s.characterIds.includes(c.id)))) {
      if (!char.referenceAssetId) throw new Error(`${char.name}必须使用本人确认的参考图`);
      await this.assetFile(p, char.referenceAssetId, 'image');
    }
    const usedCharacters = new Set(p.plan.shots.flatMap((s): string[] => s.characterIds));
    for (const char of p.plan.characters.filter((c): boolean => usedCharacters.has(c.id) && !!c.referenceAssetId)) await this.assetFile(p, requireValue(char.referenceAssetId), 'image');
    for (const shot of p.plan.shots) for (const assetId of shot.sceneReferenceAssetIds || []) await this.assetFile(p, assetId, 'image');
    p.production = { phase: 'shots', materialHash: approvedMaterialHash(p), state: 'running', planHash: productionPlanHash(p.plan), approvedAt: new Date().toISOString(), capability, fallbacks,
      shots: Object.fromEntries(p.plan.shots.map((s): [string, ReturnType<typeof resolvePetStoryMode>] => [s.id, resolvePetStoryMode(s, capability, fallbacks[s.id])])), steps: [], message: '计划已确认，准备顺序制作' };
    p = await this.projects.write(p);
    this.authorized.add(id);
    return { success: true, project: p, counts };
  }
  /** 每次只授权点击的媒体节点；缺少前置素材直接停止，不暗中补生成。 */
  async generateShotMedia(id: string, revision: number, shotId: string, kind: PetStoryPromptKind, capability: PetStoryCapability | undefined = undefined, fallbacks: Record<string, 'first_frame' | 'reference'> = {}, imageOperationId?: string): Promise<PetStoryProductionResult> {
    let p = await this.projects.read(id);
    capability = productionCapability(p, capability);
    if (p.revision !== revision) throw new Error('项目版本已变化，请重新查看节点');
    if (!['firstFrame', 'lastFrame', 'video'].includes(kind)) throw new Error('媒体节点类型无效');
    if (imageOperationId && (kind === 'video' || !p.imageOperations?.some((operation): boolean => operation.id === imageOperationId
      && operation.mode === 'generate' && operation.target.shotId === shotId && operation.target.kind === kind))) throw new Error('图片节点与本次操作授权不一致');
    const shot = p.plan?.shots.find((s): boolean => s.id === shotId);
    if (!shot) throw new Error('镜头不存在或已不属于当前方案，请刷新后重新选择。');
    if (!shot.prompts[kind]?.final.trim()) throw new Error(missingShotPromptMessage(p, shot, kind, this.tasks.list()));
    if (p.production && p.production.state !== 'complete') throw new Error('请先处理原制作任务，不重复创建节点任务');
    this.validateRequestContext(p, capability, { shotId, promptKind: kind });
    await this.checkApprovedFiles(p, [shotId]);
    // 图片节点不要求先确认尚未使用的视频入口；这里的模式仅留作未授权占位。
    const shots = this.shotMedia(p);
    const media = shots[shotId];
    if (kind === 'firstFrame' && needsContinuationFrame(shot, media, shots)) {
      requirePromptEligibility(p, shot.prompts.firstFrame, { shotId, promptKind: kind });
      await this.prepareContinuationFrame(p, shot, shots);
    }
    if (kind !== 'firstFrame' && !media.firstFrameId) throw new Error(shotImageUnavailableReason(p, shot.id, 'firstFrame'));
    if (kind === 'video') {
      Object.assign(media, resolvePetStoryMode(shot, capability, fallbacks[shot.id]));
      if (media.resolvedMode === 'first_last_frame' && !media.plannedEndImageId) throw new Error(shotImageUnavailableReason(p, shot.id, 'lastFrame'));
    }
    if (p.production) p.productionHistory = [...(p.productionHistory || []), p.production];
    p.production = { phase: 'shots', target: { shotId, kind }, imageOperationId, materialHash: approvedMaterialHash(p, [shotId]), state: 'running', planHash: productionPlanHash(requireValue(p.plan)), approvedAt: new Date().toISOString(), capability, fallbacks, shots, steps: [], message: `仅授权 ${shot.order} 镜 ${kind}，完成后停止` };
    // 用原编译器核对本项前置与 final，在任何任务创建前失败即停止。
    const compiled = compilePrompt(p, shotId, kind, kind === 'video' ? media.resolvedMode : undefined);
    await Promise.all(compiled.references.map((r): Promise<string> => this.assetFile(p, r.assetId, 'image')));
    p = await this.projects.write(p); this.authorized.add(id);
    return { success: true, project: p };
  }
  /** 切换项目只收起后续镜头授权，当前运行仍由稳定宿主完成观察和入库。 */
  async detach(id: string): Promise<PetStoryProductionResult> {
    const project = await this.projects.read(id); const production = project.production;
    if (!production || production.state !== 'running') return { success: true, project };
    const pending = production.steps.find((step): boolean => step.status !== 'complete');
    const task = pending?.taskId ? this.tasks.list().find((item): boolean => item.id === pending.taskId) : undefined;
    if (pending && task && ['executing', 'generating', 'manual_submission_observing', 'done'].includes(task.status)) {
      production.stopAfterCurrent = true; production.message = '当前镜头继续生成和保存；完成后停止后续镜头，返回项目可继续';
    } else {
      this.authorized.delete(id); production.state = 'paused'; production.message = '已离开项目，后续制作暂未启动；原任务和输入保留';
    }
    return { success: true, project: await this.projects.write(project) };
  }
  /** 结束本地制作占位；已提交的远端请求仍属于原历史，不声称取消平台。 */
  async end(id: string): Promise<PetStoryProductionResult> {
    this.suspend(id);
    const project = await this.projects.read(id);
    const production = project.production;
    if (!production) return { success: true, project };
    production.state = 'ended'; production.endedAt = new Date().toISOString();
    production.message = '本次本地制作已结束；原任务、提交和成果保留，平台请求可能仍在完成';
    project.productionHistory = [...(project.productionHistory || []), production];
    project.production = undefined;
    return { success: true, project: await this.projects.write(project) };
  }
  async pause(id: string, message = '用户已暂停；点击继续后沿用原任务'): Promise<PetStoryProductionResult> {
    this.suspend(id);
    const p = await this.projects.read(id);
    if (!p.production) throw new Error('尚未确认制作方案');
    p.production.state = 'paused'; p.production.message = message;
    return { success: true, project: await this.projects.write(p), taskId: p.production.steps.find((s): boolean => s.status !== 'complete')?.taskId };
  }
  async resume(id: string, capability?: PetStoryCapability): Promise<PetStoryProductionResult> {
    let p = await this.projects.read(id);
    p = await reconcilePetStoryTaskIntents(this.projects, this.tasks, p);
    capability = productionCapability(p, capability);
    if (!p.production || !productionPlanMatches(p)) throw new Error('原制作计划不存在或已经改变');
    // 停止后允许上传和采用图片；先核对原授权依据，再触碰原运行或页面输入。
    this.checked(p);
    const pending = p.production.steps.find((s): boolean => s.status !== 'complete');
    const repaired = await this.recoverInterruptedPageBinding(p, pending);
    if (repaired) return this.resume(repaired.id, capability);
    if (pending) this.reconcilePageInput(p, pending);
    const pendingTask = pending?.taskId ? this.originalTask(p, pending) : undefined;
    const readOnly = pendingTask?.status === 'done' || !!pendingTask?.runtime?.submittedAt;
    if (!readOnly) {
      if (pending && pendingTask) this.validateCompiledStep(p, pending, pendingTask);
      this.validateRequestContext(p, capability, productionResumeTarget(p.production, pending));
      // 继续原批次保留已选模式；真实控件支持在该任务执行时回读，不从未知状态重新推测。
    } else if (capability?.accountId !== p.accountId) throw new Error('原账号不符，禁止切换账号');
    if (pending?.taskId) {
      const task = this.originalTask(p, pending);
      if (!task.runtime?.submittedAt && !['queued', 'executing', 'generating', 'done'].includes(task.status)) {
        if ((!safePreparationFailure(task.errorInfo?.code || '') && !legacyUnsubmittedPreparationFailure(task, pending))
          || hasSubmissionEvidence(task)) throw new Error('原任务未确认可安全恢复，仅保留原任务核对，不重发');
        const held = await this.retryStepPreparation(p, pending, task);
        return this.resume(held.id, capability);
      }
    }
    p.production.capability = capability; p.production.state = 'running'; p.production.stopAfterCurrent = undefined; p.production.message = '继续原任务与素材，未授权重复发送';
    const saved = await this.projects.write(p);
    this.authorized.add(id);
    return { success: true, project: saved };
  }
  private async retryStepPreparation(project: PetStoryProject, step: PetStoryProductionStep, task: Task): Promise<PetStoryProject> {
    const source = this.resetPageBindingForRetry(project, step); step.runId = undefined;
    const held = await this.projects.write(project); this.tasks.retryUnsubmitted(task.id); this.resetTaskPageInput(task, source);
    if (step.videoInputSnapshot && task.videoInputSnapshot?.digest !== step.videoInputSnapshot.digest) {
      if (!this.tasks.reviseVideoInput || !task.runtime) throw new Error('原视频输入版本更新入口不可用，请结束本次制作后生成新版本');
      this.tasks.reviseVideoInput(task.id, task.runtime.runId, step.videoInputSnapshot);
    }
    return held;
  }
  private async recoverInterruptedPageBinding(project: PetStoryProject, step: PetStoryProductionStep | undefined): Promise<PetStoryProject | undefined> {
    if (!step?.pageBindings || !step.taskId || !step.runId) return undefined;
    const task = this.tasks.list().find((item): boolean => item.id === step.taskId);
    if (!task || task.runtime?.runId !== step.runId || task.prompt === step.compiledPrompt?.text
      || !['paused', 'fail', 'cancelled'].includes(task.status) || hasSubmissionEvidence(task)) return undefined;
    if (task.petstory?.projectId !== project.id || task.petstory.stepId !== step.id || task.assignedAccountId !== project.accountId
      || task.runtime.input.prompt !== task.prompt) throw new Error('原页面绑定事务与原任务归属不符，请结束本次制作后按当前输入继续');
    validatePageBindings(project, step, step.pageBindings);
    // 重启后旧页面节点已经失效；保留绑定历史后重做原task准备，已提交请求不能走此分支。
    return this.retryStepPreparation(project, step, task);
  }
  private async resumeAuthorizedReferenceVideo(id: string, p: PetStoryProject, request: PetStoryVideoReferenceRequest, existing: PetStoryVideoReferenceContinuation): Promise<PetStoryProductionResult> {
    const production = requireValue(p.production);
    if (existing.authorizationId !== request.authorizationId || existing.taskId !== request.taskId || existing.originalRunId !== request.runId
      || existing.firstFrameId !== request.firstFrameId || existing.lastFrameId !== request.lastFrameId || hash(existing.sourceCompiledPrompt.text) !== request.inputHash) throw new Error('已有两参考图授权，请继续原任务，不重复授权');
    const step = requireValue(referenceContinuationStep(production, request.shotId, existing));
    const task = this.originalTask(p, step);
    // 原两图授权不再次授权后续明确重发；仅返回已有的关联任务。
    if (step.taskId !== existing.taskId) return { success: true, project: p, taskId: task.id, action: 'wait' };
    // 授权落盘后的失败允许接续同一个 hold；新运行、发送证据或执行状态只回读，绝不再次清理运行。
    if (task.runtime?.runId !== existing.originalRunId || hasSubmissionEvidence(task) || !['queued', 'fail', 'paused', 'cancelled'].includes(task.status)) return { success: true, project: p, taskId: existing.taskId, action: 'wait' };
    if (!currentReferenceContinuation(p, request.shotId) || referenceRecoveryGuarded(task, step)) throw new Error('原两参考图授权或任务状态已变化，未重新发送');
    await this.validateStepInputs(p, step, task);
    return this.resume(id, production.capability);
  }
  /** 用户明确把本次未发送的原生首尾图改作两张参考图；不改正文、不换模型、不新建图片或任务。 */
  async resumeReferenceVideo(id: string, revision: number, request: PetStoryVideoReferenceRequest): Promise<PetStoryProductionResult> {
    const p = await this.projects.read(id); const production = this.checked(p);
    if (!request || request.useExistingFrames !== true || !/^[a-zA-Z0-9_-]{8,100}$/.test(request.authorizationId || '')) throw new Error('请明确授权仅用已有首尾两图作为参考图继续');
    const existing = production.referenceContinuations?.[request.shotId];
    if (existing) return this.resumeAuthorizedReferenceVideo(id, p, request, existing);
    if (p.revision !== revision || production.state !== 'paused') throw new Error('原制作状态已变化，请重新查看当前任务');
    const step = requireValue(production.steps.find((item): boolean => item.status !== 'complete'), '原制作步骤已经结束');
    const task = this.originalTask(p, step); const runtime = referenceVideoRecoveryRuntime(step, task, request);
    const { media, shot } = referenceVideoFrames(p, production, step, request);
    const capability = productionCapability(p, production.capability);
    if (!task.videoConfig?.model || !capability.videoConfig || capability.videoConfig.model !== task.videoConfig.model || capability.videoConfig.aspectRatio !== task.videoConfig.aspectRatio) throw new Error('当前模型或比例与原任务不一致，不能借此授权更换参数');
    this.validateRequestContext(p, capability, { shotId: shot.id, promptKind: 'video' });
    await this.validateStepInputs(p, step, task);
    const source = requireValue(step.compiledPrompt, '原编译正文缺失');
    if (step.pageBindings || source.references.length !== 2 || source.text !== task.prompt || source.final !== shot.prompts.video.final) throw new Error('原输入已有网页绑定或正文已变化，不能按本次两图授权改配');
    production.referenceContinuations = { ...production.referenceContinuations, [shot.id]: { authorizationId: request.authorizationId, authorizedAt: new Date().toISOString(), shotId: shot.id,
      taskId: task.id, originalRunId: runtime.runId, firstFrameId: request.firstFrameId, lastFrameId: request.lastFrameId,
      firstSha256: requireValue(p.assets.find((asset): boolean => asset.id === request.firstFrameId)?.validation?.sha256), lastSha256: requireValue(p.assets.find((asset): boolean => asset.id === request.lastFrameId)?.validation?.sha256),
      model: task.videoConfig.model, finalHash: referenceContinuationHash(shot.prompts.video.final), promptTaskHash: referenceContinuationHash(shot.prompts.video.promptTask),
      sourceCompiledPrompt: structuredClone(source), sourceRuntime: structuredClone(runtime), sourceError: task.errorInfo ? structuredClone(task.errorInfo) : undefined } };
    production.fallbacks[shot.id] = 'reference'; media.resolvedMode = 'reference'; media.reason = '用户明确授权已有首帧与尾帧作为两张普通参考图；不保证原生首尾帧约束';
    const compiled = compilePrompt(p, shot.id, 'video', 'reference');
    if (compiled.text !== source.text || compiled.references.length !== 2 || JSON.stringify(compiled.references.map((reference): string => reference.assetId)) !== JSON.stringify(step.attachmentAssetIds)
      || compiled.references.some((reference): boolean => reference.slot !== undefined)) throw new Error('两参考图编译改变了原全文或图片清单，未发送');
    step.compiledPrompt = compiled; production.capability = capability;
    step.videoInputSnapshot = compileVideoInputSnapshot(p, step.id, shot.id, compiled, task.videoConfig);
    await this.projects.write(p);
    return this.resume(id, capability);
  }
  /** 不明提交只能由用户针对原运行另行授权；新 hold 任务绑定成功后才进入正式调度。 */
  async resubmit(id: string, revision: number, request: TaskResubmitUncertainParams, capability?: PetStoryCapability): Promise<PetStoryProductionResult> {
    const scoped = await this.imageTaskResult(request.taskId, (service: PetStoryProductionService): Promise<PetStoryProductionResult> => service.resubmit(id, revision, request, capability));
    if (scoped) return scoped;
    const p = await this.projects.read(id);
    const production = this.checked(p);
    if (!request || request.acceptDuplicateRisk !== true || !this.tasks.resubmitUncertain) throw new Error('请明确确认本次重发及可能重复生成的风险');
    // 项目写入已成功而回复丢失时只返回关联结果，绝不再次启动已运行的新任务。
    const linked = production.steps.find((step): boolean => !!step.taskId && this.tasks.list().some((task): boolean => task.id === step.taskId
      && task.resubmissionOf?.taskId === request.taskId && task.resubmissionOf.runId === request.runId && task.resubmissionOf.submittedAt === request.submittedAt));
    if (linked?.taskId) {
      const task = this.tasks.resubmitUncertain(request);
      return this.resumeLinkedResubmission(p, production, linked, task, capability);
    }
    if (p.revision !== revision) throw new Error('项目版本已变化，请刷新后确认本次重发');
    if (production.state !== 'paused') throw new Error('请先暂停原制作，再确认重发');
    const pending = requireValue(production.steps.find((step): boolean => step.status !== 'complete'), '原制作步骤已经结束');
    const original = this.originalTask(p, pending);
    if (original.id !== request.taskId || pending.runId !== request.runId || original.runtime?.submittedAt !== request.submittedAt) throw new Error('原提交已变化，请刷新后重新核对');
    capability = productionCapability(p, capability);
    this.validateRequestContext(p, capability, productionResumeTarget(production, pending));
    await this.validateStepInputs(p, pending, original);
    const history = { taskId: original.id, runId: request.runId, submittedAt: request.submittedAt, authorizationId: request.authorizationId,
      authorizedAt: '', inputHash: pending.inputHash, attachmentAssetIds: [...pending.attachmentAssetIds],
      compiledPrompt: pending.compiledPrompt ? structuredClone(pending.compiledPrompt) : undefined,
      pageBindings: pending.pageBindings ? structuredClone(pending.pageBindings) : undefined };
    const source = this.resetPageBindingForRetry(p, pending) || pending.compiledPrompt;
    const created = this.tasks.resubmitUncertain(request);
    // Core 已持久化原记录和唯一关联任务；后续写盘失败时该任务保持 hold，可幂等接续。
    if (created.status !== 'queued' || created.executionIntent !== 'hold' || created.runtime) throw new Error('关联重发任务已开始，请核对现有任务，不重复启动');
    const adopted = this.tasks.adopt(created.id, { projectId: p.id, stepId: pending.id,
      ...(production.imageOperationId ? { imageOperationId: production.imageOperationId, materialId: pending.materialId } : {}) }, source?.text);
    if (adopted.status !== 'queued' || adopted.executionIntent !== 'hold' || adopted.runtime || hash(adopted.prompt) !== pending.inputHash) throw new Error('重发输入绑定不符，新任务保持暂停');
    history.authorizedAt = this.tasks.list().find((task): boolean => task.id === original.id)?.resubmittedAs?.find((record): boolean => record.authorizationId === request.authorizationId)?.authorizedAt
      || requireValue(created.resubmissionOf).authorizedAt;
    pending.resubmissionHistory = [...(pending.resubmissionHistory || []), history];
    pending.taskId = adopted.id; pending.runId = undefined; pending.status = 'bound'; pending.error = undefined;
    production.capability = capability; production.state = 'running'; production.message = '已确认重发一次；保留原任务，新请求完成后继续制作';
    this.bindResubmittedImageOperation(p, pending, adopted);
    const saved = await this.projects.write(p);
    this.authorized.add(id);
    return { success: true, project: saved, taskId: adopted.id, action: 'start' };
  }
  /** 重复授权只接续原唯一关联任务；同步图片操作后沿原写盘和执行授权返回。 */
  private async resumeLinkedResubmission(p: PetStoryProject, production: NonNullable<PetStoryProject['production']>, linked: PetStoryProductionStep,
    task: Task, capability?: PetStoryCapability): Promise<PetStoryProductionResult> {
    if (task.id !== linked.taskId) throw new Error('重发关联已变化，请刷新原制作任务');
    if (task.status === 'queued' && task.executionIntent === 'hold' && !task.runtime && linked.status === 'bound' && !linked.runId) {
      capability = productionCapability(p, capability);
      this.originalTask(p, linked);
      this.validateRequestContext(p, capability, productionResumeTarget(production, linked));
      await this.validateStepInputs(p, linked, task);
      if (production.state === 'complete') throw new Error('原制作已结束，请核对关联任务');
      production.capability = capability; production.state = 'running'; production.message = '继续本次已确认的重发请求；保留原任务';
      this.bindResubmittedImageOperation(p, linked, task);
      const saved = await this.projects.write(p);
      this.authorized.add(p.id);
      return { success: true, project: saved, taskId: task.id, action: 'start' };
    }
    const imageChanged = this.bindResubmittedImageOperation(p, linked, task);
    return { success: true, project: imageChanged ? await this.projects.write(p) : p, taskId: task.id, action: 'wait' };
  }
  /** 图片重发仍属于原操作；旧任务保存在步骤历史，当前卡片始终跟随唯一关联的新任务。 */
  private bindResubmittedImageOperation(p: PetStoryProject, step: PetStoryProductionStep, task: Task): boolean {
    const operation = p.imageOperations?.find((item): boolean => item.id === p.production?.imageOperationId);
    if (!operation || task.mode !== 'image') return false;
    const complete = step.status === 'complete' && p.production?.state === 'complete' && !!step.assetId
      && p.assets.some((asset): boolean => asset.id === step.assetId && !!asset.validation?.decoded);
    const stage = complete ? 'complete' : task.status === 'done' ? 'saving' : 'generating';
    const outputAssetId = complete ? step.assetId : undefined;
    if (operation.taskId === task.id && operation.stage === stage && !operation.error && operation.outputAssetId === outputAssetId) return false;
    operation.taskId = task.id; operation.stage = stage; operation.error = undefined; operation.outputAssetId = outputAssetId;
    return true;
  }
  private resetPageBindingForRetry(p: PetStoryProject, pending: PetStoryProductionStep): PetStoryCompiledPrompt | undefined {
    if (!pending.pageBindings) return undefined;
    const operation = p.imageOperations?.find((item): boolean => item.id === p.production?.imageOperationId && item.mode === 'modify');
    const source = operation ? compileImageFeedback(p, operation) : pending.materialId ? this.compileMaterial(p, pending.materialId)
      : compilePrompt(p, requireValue(pending.shotId), pending.kind as 'firstFrame' | 'lastFrame' | 'video', pending.kind === 'video' ? this.checked(p).shots[requireValue(pending.shotId)].resolvedMode : undefined);
    if (pending.compiledPrompt) pending.pageBindingHistory = [...(pending.pageBindingHistory || []), { runId: pending.runId, compiledPrompt: pending.compiledPrompt, bindings: pending.pageBindings }];
    pending.pageBindings = undefined; pending.compiledPrompt = source; pending.inputHash = hash(source.text);
    return source;
  }
  private resetTaskPageInput(task: Task, source?: PetStoryCompiledPrompt): void {
    if (!source) return;
    if (!this.tasks.bindPageInput || !task.runtime) throw new Error('原任务引用重置入口不可用');
    this.tasks.bindPageInput(task.id, task.runtime.runId, source.text);
  }
  private checked(p: PetStoryProject): NonNullable<PetStoryProject['production']> {
    const operation = this.imageOperationId ? p.imageOperations?.find((item): boolean => item.id === this.imageOperationId) : undefined;
    const sameBasis = operation ? operation.basisHash === imageTargetBasis(p, operation.target) : productionPlanMatches(p);
    if (!p.production || this.imageOperationId && !operation || !sameBasis) throw new Error('制作计划与原确认不一致');
    if (p.production.phase === 'shots' && !productionMaterialsMatch(p, p.production)) throw new Error('基础素材确认绑定已变化，保留原成果，不能沿用旧制作授权');
    return p.production;
  }
  private async checkApprovedFiles(p: PetStoryProject, shotIds?: string[]): Promise<void> {
    requireApprovedMaterials(p, shotIds);
    const keys = requiredMaterialKeys(requireValue(p.plan), shotIds);
    for (const material of (p.materials || []).filter((item): boolean => keys.has(item.id))) {
      const asset = materialAsset(p, material.id);
      await this.assetFile(p, asset.id, 'image');
      if (asset.validation?.sha256 !== material.approved?.sha256) throw new Error('确认图片内容已变化，未授权镜头生成');
    }
  }
  /** 单节点与整批共用真实视频末帧提取；计划尾帧永不替代实际前镜结果。 */
  private async prepareContinuationFrame(p: PetStoryProject, shot: PetStoryShot, shots: Record<string, PetStoryShotMedia>): Promise<void> {
    const media = requireValue(shots[shot.id]);
    const previous = shots[requireValue(shot.previousShotId)];
    const video = p.assets.find((asset): boolean => asset.id === previous?.videoId && asset.kind === 'video' && asset.shotId === shot.previousShotId);
    if (!video || video.origin !== 'user_upload' && (!video.taskId || !video.runId)) throw new Error('本镜连续首帧依赖前镜实际视频／末帧；请先完成或选择前镜实际视频，再制作本镜，不能使用计划尾帧');
    if (video.needsReview) throw new Error('前镜素材已替换，请先复核前镜视频，再制作连续镜头');
    const source = await this.assetFile(p, video.id, 'video');
    const frameId = randomUUID();
    const relativePath = `shots/${shot.id}/${frameId}.png`;
    const extracted = await extractActualEndFrame(source, await projectPath(this.projects.directory(p.id), relativePath));
    const sourceVideo = { assetId: video.id, taskId: video.taskId, runId: video.runId, sha256: requireValue(video.validation).sha256, atSeconds: extracted.atSeconds };
    p.assets.push({ id: frameId, kind: 'actualEndFrame', shotId: shot.id, relativePath, validation: extracted.validation, sourceVideo });
    media.actualEndFrameId = frameId; media.startFromPreviousEnd = sourceVideo;
    if (!p.materials) media.firstFrameId = frameId;
  }
  async generateMaterials(id: string, revision: number, materialIds: string[], capability?: PetStoryCapability, imageOperationId?: string): Promise<PetStoryProductionResult> {
    const p = await this.projects.read(id);
    capability = productionCapability(p, capability);
    if (revision !== p.revision) throw new Error('项目版本变化，请重新查看素材');
    requireMaterialInventory(p);
    for (const materialId of materialIds) this.validateRequestContext(p, capability, { materialId });
    if (!Array.isArray(materialIds) || !materialIds.length || new Set(materialIds).size !== materialIds.length || materialIds.some((id): boolean => !p.materials?.some((m): boolean => m.id === id))) throw new Error('请选择本项目的基础素材');
    for (const materialId of materialIds) requireMaterialPromptSource(p, materialId);
    if (p.production) {
      if (p.production.state !== 'complete') throw new Error('请先继续原制作或处理未结束任务，不能重复生成');
      p.productionHistory = [...(p.productionHistory || []), p.production];
    }
    const ordered: string[] = [];
    const append = (id: string): void => {
      if (ordered.includes(id)) return;
      const parent = p.plan?.scenes?.find((s): boolean => `scene:${s.id}` === id)?.parentSceneId;
      if (parent && materialIds.includes(`scene:${parent}`)) append(`scene:${parent}`);
      ordered.push(id);
    };
    materialIds.forEach(append);
    p.production = { phase: 'materials', materialIds: ordered, imageOperationId, state: 'running', planHash: productionPlanHash(requireValue(p.plan)), approvedAt: new Date().toISOString(), capability, fallbacks: {}, shots: {}, steps: [], message: '基础图已单独授权，下载后仍需用户接受图片' };
    const saved = await this.projects.write(p); this.authorized.add(id);
    return { success: true, project: saved };
  }
  private compileMaterial(p: PetStoryProject, materialId: string): PetStoryCompiledPrompt {
    return compileMaterialPrompt(p, materialId);
  }
  /** 精确选图编辑复用生产、上传、单次发送和下载；基图无需先正式采用。 */
  async generateImageFeedback(id: string, revision: number, operationId: string, capability?: PetStoryCapability): Promise<PetStoryProductionResult> {
    const p = await this.projects.read(id);
    if (p.revision !== revision) throw new Error('项目版本变化，请刷新后修改图片');
    requireMaterialInventory(p);
    const operation = requireValue(p.imageOperations?.find((item): boolean => item.id === operationId && item.mode === 'modify'), '本次图片修改授权不存在');
    capability = productionCapability(p, capability);
    this.validateRequestContext(p, capability, operation.target.materialId ? { materialId: operation.target.materialId } : { shotId: operation.target.shotId, promptKind: operation.target.kind });
    if (p.production) {
      if (p.production.state !== 'complete') throw new Error('已有制作任务尚未结束，请先处理原任务');
      p.productionHistory = [...(p.productionHistory || []), p.production];
    }
    compileImageFeedback(p, operation);
    p.production = { phase: operation.target.materialId ? 'materials' : 'shots', imageOperationId: operation.id,
      materialIds: operation.target.materialId ? [operation.target.materialId] : undefined,
      target: operation.target.shotId ? { shotId: operation.target.shotId, kind: operation.target.kind } : undefined,
      materialHash: approvedMaterialHash(p, operation.target.shotId ? [operation.target.shotId] : undefined),
      state: 'running', planHash: productionPlanHash(requireValue(p.plan)), approvedAt: new Date().toISOString(), capability, fallbacks: {}, shots: this.shotMedia(p), steps: [], message: '正在按你的要求修改图片…' };
    const saved = await this.projects.write(p); this.authorized.add(id);
    return { success: true, project: saved };
  }
  async recordPageBindings(id: string, taskId: string, runId: string, bindings: PetStoryPageBinding[]): Promise<PetStoryProductionResult> {
    const scoped = await this.imageTaskResult(taskId, (service: PetStoryProductionService): Promise<PetStoryProductionResult> => service.recordPageBindings(id, taskId, runId, bindings));
    if (scoped) return scoped;
    const p = await this.projects.read(id); const production = this.checked(p);
    const step = production.steps.find((s): boolean => s.taskId === taskId && s.runId === runId && s.status === 'bound');
    if (!step || !Array.isArray(bindings) || bindings.length !== step.attachmentAssetIds.length) throw new Error('页面引用清单与本次运行不符');
    const task = this.tasks.list().find((item): boolean => item.id === taskId && item.petstory?.projectId === p.id && item.petstory.stepId === step.id);
    if (!task || task.runtime?.runId !== runId || task.assignedAccountId !== p.accountId) throw new Error('原网页绑定与任务运行不符');
    if (task.runtime.submittedAt) throw new Error('已提交的网页绑定快照不可改写');
    validatePageBindings(p, step, bindings);
    if (step.pageBindings) {
      if (JSON.stringify(step.pageBindings) !== JSON.stringify(bindings)) throw new Error('本次网页绑定已经固定，不能重复改写');
      this.reconcilePageInput(p, step);
      return { success: true, project: p, compiledPrompt: step.compiledPrompt };
    }
    const source = requireValue(step.compiledPrompt, '原编译输入缺失');
    const compiled = bindReferenceText(source, bindings);
    if (!this.tasks.bindPageInput) throw new Error('原任务实际引用保存入口不可用');
    // 项目中的已验证绑定就是可重入意图；任务写入失败后只补同run正文，不重新上传或派发。
    step.pageBindings = bindings; step.compiledPrompt = compiled; step.inputHash = hash(compiled.text);
    const saved = await this.projects.write(p);
    this.reconcilePageInput(saved, requireValue(saved.production?.steps.find((item): boolean => item.id === step.id)));

    return { success: true, project: saved, compiledPrompt: compiled };
  }
  private reconcilePageInput(project: PetStoryProject, step: PetStoryProductionStep): void {
    if (!step.pageBindings || !step.runId || !step.taskId || !step.compiledPrompt) return;
    const task = this.tasks.list().find((item): boolean => item.id === step.taskId);
    if (!task || task.petstory?.projectId !== project.id || task.petstory.stepId !== step.id || task.assignedAccountId !== project.accountId
      || task.runtime?.runId !== step.runId) throw new Error('原页面绑定运行已变化，未改写新运行');
    if (task.prompt === step.compiledPrompt.text && task.runtime.input.prompt === step.compiledPrompt.text) return;
    if (task.runtime.submittedAt || task.runtime.submission && !['not_dispatched', 'intent_saved'].includes(task.runtime.submission.state)) throw new Error('原页面绑定未完成且已有派发可能，请检查原请求');
    const bound = this.tasks.bindPageInput?.(task.id, step.runId, step.compiledPrompt.text);
    if (bound?.prompt !== step.compiledPrompt.text || bound.runtime?.input.prompt !== step.compiledPrompt.text) throw new Error('网页引用保存回读不一致，零提交；请继续原准备');
  }
  async assetFile(p: PetStoryProject, id: string, kind: 'image' | 'video', feedbackOperationId?: string): Promise<string> {
    const asset = p.assets.find((a): boolean => a.id === id);
    if (!asset || (kind === 'video' ? asset.kind !== 'video' : asset.kind === 'video')) throw new Error('素材未登记或类别不符');
    if (kind === 'image' && !isPetStoryImageAdopted(p, asset) && !isFeedbackBase(p, asset, feedbackOperationId)) throw new Error('这张图片尚未采用或当前文件确认无效，请先查看图片并明确采用');
    if (kind === 'video') {
      migrateLocalMediaSources(p);
      // 入库时的来源和文件摘要是本地播放／接力依据，不再读取可清理的队列任务。
      assertLocalMediaSource(p, asset);
    }
    const file = await projectPath(this.projects.directory(p.id), asset.relativePath);
    const digest = await mediaDigest(file);
    if (asset.validation && digest.sha256 !== asset.validation.sha256) throw new Error('已选素材文件发生变化，保留进度并停止接力');
    if (this.validated.get(`${file}:${kind}`) !== digest.sha256) {
      asset.validation = await validatePetStoryMedia(file, kind);
      this.validated.set(`${file}:${kind}`, digest.sha256);
    }
    const validation = requireValue(asset.validation);
    if (kind === 'video' && (!validation.durationSeconds || validation.durationSeconds < 5 || validation.durationSeconds > 10)) throw new Error('实际视频时长异常，阻断下游');
    return file;
  }
  private originalTask(p: PetStoryProject, step: PetStoryProductionStep): Task {
    const task = this.tasks.list().find((t): boolean => t.id === step.taskId);
    if (!task || task.projectId !== p.studioProjectId || task.assignedAccountId !== p.accountId || hash(task.prompt) !== step.inputHash
      || task.petstory?.projectId !== p.id || task.petstory.stepId !== step.id || task.mode !== (step.kind === 'video' ? 'video' : 'image')
      || task.petstory.imageOperationId && task.petstory.imageOperationId !== p.production?.imageOperationId) throw new Error('原任务／账号／项目／输入归属不符，停止且不重建');
    if (task.runtime && (task.runtime.input.mode !== task.mode || task.runtime.input.prompt !== task.prompt || JSON.stringify(task.runtime.input.attachments) !== JSON.stringify(task.attachments || []) || JSON.stringify(task.runtime.input.videoConfig) !== JSON.stringify(task.videoConfig))) throw new Error('原运行输入快照与任务不符，禁止混用产物');
    if (step.runId && task.runtime?.runId !== step.runId) throw new Error('原运行已变化，不混用不同运行素材');
    return task;
  }
  async guard(taskId: string, requireRun = true): Promise<PetStoryProductionResult> {
    const scoped = await this.imageTaskResult(taskId, (service: PetStoryProductionService): Promise<PetStoryProductionResult> => service.guard(taskId, requireRun));
    if (scoped) return scoped;
    const task = this.tasks.list().find((t): boolean => t.id === taskId);
    if (!task?.petstory) return { success: true };
    const p = await this.projects.read(task.petstory.projectId);
    const production = this.checked(p);
    const step = production.steps.find((s): boolean => s.id === task.petstory?.stepId && s.taskId === taskId && s.status === 'bound');
    if (!step || production.state !== 'running' || !this.authorized.has(p.id)) throw new Error('制作已暂停、重开尚未显式继续或原步骤无效，未授权提交');
    if (requireRun && (!step.runId || task.runtime?.runId !== step.runId)) throw new Error('原制作运行尚未绑定，禁止直接从 Studio 绕过制作授权');
    this.originalTask(p, step);
    this.validateRequestContext(p, production.capability, productionStepTarget(step));
    await this.validateStepInputs(p, step, task);
    const shot = p.plan?.shots.find((s): boolean => s.id === step.shotId);
    const guard: PetStoryExecutionGuard = { videoInputSnapshot: step.videoInputSnapshot, capability: production.capability, mode: shot ? production.shots[shot.id].resolvedMode : undefined,
      durationSeconds: shot?.durationSeconds, attachmentAssetIds: step.attachmentAssetIds, references: step.compiledPrompt?.references, compiledPrompt: step.compiledPrompt, fileSha256s: step.attachmentAssetIds.map((id): string => requireValue(p.assets.find((a): boolean => a.id === id)?.validation?.sha256)) };
    return { success: true, guard };
  }
  private async validateStepInputs(p: PetStoryProject, step: PetStoryProductionStep, task: Task): Promise<void> {
    const production = this.checked(p);
    const feedback = p.imageOperations?.find((item): boolean => item.id === production.imageOperationId && item.mode === 'modify');
    if (production.phase !== 'materials' && !feedback) await this.checkApprovedFiles(p, productionShotScope(production));
    else requireMaterialInventory(p);
    this.validateCompiledStep(p, step, task);
    const files = await Promise.all(step.attachmentAssetIds.map((id): Promise<string> => this.assetFile(p, id, 'image', feedback?.id)));
    if (JSON.stringify(files) !== JSON.stringify(task.attachments || [])) throw new Error('实际上传顺序与批准素材绑定不一致');
    if (task.runtime && (task.runtime.input.prompt !== task.prompt || JSON.stringify(task.runtime.input.attachments) !== JSON.stringify(files)
      || JSON.stringify(task.runtime.input.videoConfig) !== JSON.stringify(task.videoConfig))) throw new Error('本次持久化运行输入不符');
    if (step.shotId) {
      const source = production.shots[step.shotId]?.startFromPreviousEnd;
      const shotPlan = p.plan?.shots.find((s): boolean => s.id === step.shotId);
      if (source && (production.shots[shotPlan?.previousShotId || '']?.videoId !== source.assetId
        || !p.assets.some((a): boolean => a.id === source.assetId && a.validation?.sha256 === source.sha256 && a.taskId === source.taskId && a.runId === source.runId))) throw new Error('连续镜头的源视频选择已过时，停止接力');
      if (source) await this.assetFile(p, source.assetId, 'video');
    }
    const shot = p.plan?.shots.find((s): boolean => s.id === step.shotId);
    if (step.kind === 'video' && (!shot || !validPetStoryDuration(shot.durationSeconds) || task.videoConfig?.duration !== `${shot.durationSeconds}s`)) throw new Error('视频时长不符，零提交');
  }
  private validateCompiledStep(p: PetStoryProject, step: PetStoryProductionStep, task: Task): void {
    const production = this.checked(p);
    if (step.pageBindings) validatePageBindings(p, step, step.pageBindings);
    const feedback = p.imageOperations?.find((item): boolean => item.id === production.imageOperationId && item.mode === 'modify');
    if (feedback) {
      const source = compileImageFeedback(p, feedback);
      const compiled = step.pageBindings ? bindReferenceText(source, step.pageBindings) : source;
      if (JSON.stringify(compiled) !== JSON.stringify(step.compiledPrompt) || compiled.text !== task.prompt
        || JSON.stringify(step.attachmentAssetIds) !== JSON.stringify([feedback.baseAssetId])) throw new Error('图片修改基图、反馈或输入已变化，零提交');
      return;
    }
    if (step.materialId) {
      const source = this.compileMaterial(p, step.materialId);
      const compiled = step.pageBindings ? bindReferenceText(source, step.pageBindings) : source;
      if (JSON.stringify(compiled) !== JSON.stringify(step.compiledPrompt) || compiled.text !== task.prompt) throw new Error('基础图提示词或场景引用已变化');
    }
    if (step.compiledPrompt && step.shotId && ['firstFrame', 'lastFrame', 'video'].includes(step.kind)) {
      const source = compilePrompt(p, step.shotId, step.kind as 'firstFrame' | 'lastFrame' | 'video', step.kind === 'video' ? production.shots[step.shotId].resolvedMode : undefined);
      const compiled = step.pageBindings ? bindReferenceText(source, step.pageBindings) : source;
      if (compiled.text !== task.prompt || JSON.stringify(compiled) !== JSON.stringify(step.compiledPrompt)
        || JSON.stringify(compiled.references.map((r): string => r.assetId)) !== JSON.stringify(step.attachmentAssetIds)) throw new Error('最终编译文本／实际模式／素材快照已变化，零提交');
    }
  }
  async bindRun(id: string, taskId: string, runId: string): Promise<PetStoryProductionResult> {
    const scoped = await this.imageTaskResult(taskId, (service: PetStoryProductionService): Promise<PetStoryProductionResult> => service.bindRun(id, taskId, runId));
    if (scoped) return scoped;
    const p = await this.projects.read(id);
    const production = this.checked(p);
    const step = production.steps.find((s): boolean => s.taskId === taskId && s.status === 'bound');
    if (!step || production.state !== 'running') throw new Error('步骤未绑定或制作已暂停');
    const task = this.originalTask(p, step);
    if (task.runtime?.runId !== runId || (step.runId && step.runId !== runId)) throw new Error('本次运行绑定不符');
    await this.guard(taskId, false);
    step.runId = runId;
    return { success: true, project: await this.projects.write(p) };
  }
  async advance(id: string): Promise<PetStoryProductionResult> {
    const pending = this.advances.get(id);
    if (pending) return pending;
    const work = this.advanceOnce(id).then((result): PetStoryProductionResult => ({ ...result, taskSnapshots: this.tasks.list().filter((task): boolean => task.petstory?.projectId === id && task.mode === 'video') })); this.advances.set(id, work);
    try { return await work; } finally { if (this.advances.get(id) === work) this.advances.delete(id); }
  }
  private async advanceOnce(id: string): Promise<PetStoryProductionResult> {
    let p = await this.projects.read(id);
    await this.reconcileLocalMediaAssets(p);
    const production = this.checked(p);
    const localOnly = production.state === 'paused' && production.steps.some((step): boolean => step.status !== 'complete' && this.tasks.list().some((task): boolean => task.id === step.taskId && task.runtime?.runId === step.runId && task.status === 'done'));
    if (!localOnly && (production.state !== 'running' || !this.authorized.has(id))) return { success: true, project: p };
    try {
      const pending = production.steps.find((s): boolean => s.status !== 'complete');
      if (pending) return await this.advancePending(p, pending);
      const plan = requireValue(p.plan);
      for (const shot of plan.shots) {
        const media = production.shots[shot.id];
        if (media) { media.firstFrameId = selectedShotImageId(p, shot.id, 'firstFrame'); media.plannedEndImageId = selectedShotImageId(p, shot.id, 'lastFrame'); }
      }
      const feedback = p.imageOperations?.find((item): boolean => item.id === production.imageOperationId && item.mode === 'modify');
      if (feedback) return await this.advanceImageFeedback(p, feedback.id);
      if (production.phase === 'materials') return await this.advanceMaterials(p);
      await this.checkApprovedFiles(p, productionShotScope(production));
      if (production.target) return await this.advanceTarget(p, production.target);
      for (const shot of plan.shots) {
        const media = production.shots[shot.id];
        if (media.videoId) { await this.assetFile(p, media.videoId, 'video'); continue; }
        if (!media.firstFrameId && !media.actualEndFrameId && shot.transition === 'continue') {
          await this.prepareContinuationFrame(p, shot, production.shots);
          p = await this.projects.write(p);
          return { success: true, project: p, action: 'wait' };
        }
        const kind: 'firstFrame' | 'lastFrame' | 'video' = !media.firstFrameId ? 'firstFrame' : media.resolvedMode === 'first_last_frame' && !media.plannedEndImageId ? 'lastFrame' : 'video';
        const compiled = compilePrompt(p, shot.id, kind, kind === 'video' ? media.resolvedMode : undefined);
        const assetIds = compiled.references.map((r): string => r.assetId);
        const attachments = await Promise.all(assetIds.map((assetId): Promise<string> => this.assetFile(p, assetId, 'image')));
        if (kind === 'video' && media.resolvedMode === 'first_last_frame') {
          const first = requireValue(requireValue(p.assets.find((a): boolean => a.id === media.firstFrameId)).validation);
          const last = requireValue(requireValue(p.assets.find((a): boolean => a.id === media.plannedEndImageId)).validation);
          if (first.width * last.height !== last.width * first.height) throw new Error('首尾帧宽高比不同，停止视频制作');
        }
        const config = kind === 'video' ? { ...requireValue(production.capability.videoConfig), duration: `${shot.durationSeconds}s` as NonNullable<Task['videoConfig']>['duration'] } : undefined;
        const input = finalTaskInput(plan, shot.id, kind, attachments, p.studioProjectId, config);
        input.prompts = [compiled.text];
        return await this.prepareStep(p, { kind, shotId: shot.id }, input, assetIds, compiled);
      }
      production.state = 'complete'; production.message = '逐镜素材已下载并校验，请查看实际画面并确认质量';
      return { success: true, project: await this.projects.write(p) };
    } catch (error: unknown) {
      // 下载／验证失败只停止业务推进，保留原任务和所有产物；不进入生成重试。
      const current = await this.projects.read(id);
      const message = error instanceof Error ? error.message : '制作步骤失败';
      // 原下载/解码迟到不能暂停新制作或把用户已结束的历史重新激活。
      if (!current.production || current.production.approvedAt !== production.approvedAt || current.production.state !== 'running') return { success: false, error: message, project: current };
      this.authorized.delete(id); current.production.state = 'paused'; current.production.message = message;
      return { success: false, error: message, project: await this.projects.write(current) };
    }
  }
  private async advanceImageFeedback(p: PetStoryProject, operationId: string): Promise<PetStoryProductionResult> {
    const production = this.checked(p);
    const operation = requireValue(p.imageOperations?.find((item): boolean => item.id === operationId));
    if (production.steps.some((step): boolean => step.status === 'complete')) {
      production.state = 'complete'; production.message = '图片已生成，请查看'; this.authorized.delete(p.id);
      return { success: true, project: await this.projects.write(p) };
    }
    const compiled = compileImageFeedback(p, operation);
    const attachments = [await this.assetFile(p, requireValue(operation.baseAssetId), 'image', operation.id)];
    const material = p.materials?.find((item): boolean => item.id === operation.target.materialId);
    return this.prepareStep(p, { kind: material?.kind || requireValue(operation.target.kind), materialId: material?.id,
      characterId: material?.kind === 'character' ? material.entityId : undefined, shotId: operation.target.shotId },
    { prompts: [compiled.text], mode: 'image', projectId: p.studioProjectId, executionIntent: 'hold', attachments }, [requireValue(operation.baseAssetId)], compiled);
  }
  private async advanceMaterials(p: PetStoryProject): Promise<PetStoryProductionResult> {
    const production = this.checked(p);
    for (const materialId of production.materialIds || []) {
      if (production.steps.some((s): boolean => s.materialId === materialId && s.status === 'complete')) continue;
      const m = requireValue(p.materials?.find((m): boolean => m.id === materialId));
      const compiled = this.compileMaterial(p, materialId);
      const assetIds = compiled.references.map((r): string => r.assetId);
      const files = await Promise.all(assetIds.map((id): Promise<string> => this.assetFile(p, id, 'image')));
      return this.prepareStep(p, { kind: m.kind, materialId, characterId: m.kind === 'character' ? m.entityId : undefined }, { prompts: [compiled.text], mode: 'image', projectId: p.studioProjectId, executionIntent: 'hold', attachments: files }, assetIds, compiled);
    }
    production.state = 'complete'; production.message = '基础图已下载，请查看实际图片并接受；镜头尚未授权';
    return { success: true, project: await this.projects.write(p) };
  }
  private async advanceTarget(p: PetStoryProject, target: NonNullable<PetStoryProject['production']>['target']): Promise<PetStoryProductionResult> {
    const production = this.checked(p); const plan = requireValue(p.plan);
    const { shotId, kind } = requireValue(target);
    if (production.steps.some((s): boolean => s.shotId === shotId && s.kind === kind && s.status === 'complete')) {
      production.state = 'complete'; production.message = '本节点真实产物已下载并校验；未启动其他媒体节点'; this.authorized.delete(p.id);
      return { success: true, project: await this.projects.write(p) };
    }
    const shot = requireValue(plan.shots.find((s): boolean => s.id === shotId));
    const media = production.shots[shotId];
    const compiled = compilePrompt(p, shotId, kind, kind === 'video' ? media.resolvedMode : undefined);
    const assetIds = compiled.references.map((r): string => r.assetId);
    const attachments = await Promise.all(assetIds.map((assetId): Promise<string> => this.assetFile(p, assetId, 'image')));
    if (kind === 'video' && media.resolvedMode === 'first_last_frame') {
      const first = requireValue(p.assets.find((a): boolean => a.id === media.firstFrameId)?.validation);
      const last = requireValue(p.assets.find((a): boolean => a.id === media.plannedEndImageId)?.validation);
      if (first.width * last.height !== last.width * first.height) throw new Error('首尾帧宽高比不同，停止视频制作');
    }
    const config = kind === 'video' ? { ...requireValue(production.capability.videoConfig), duration: `${shot.durationSeconds}s` as NonNullable<Task['videoConfig']>['duration'] } : undefined;
    const input = finalTaskInput(plan, shotId, kind, attachments, p.studioProjectId, config);
    input.prompts = [compiled.text];
    return this.prepareStep(p, { kind, shotId }, input, assetIds, compiled);
  }
  private async advancePending(p: PetStoryProject, pending: PetStoryProductionStep): Promise<PetStoryProductionResult> {
        if (!pending.taskId) {
          const recovered = await this.recoverPreparingStep(p, pending); p = recovered.project; pending = recovered.step;
        }
        const task = this.originalTask(p, pending);
        if (task.status === 'done') {
          const priorSelection = pending.shotId ? p.selectedVideos?.[pending.shotId] : undefined;
          await this.collectMedia(p, pending, task);
          if (p.production?.target && pending.status === 'complete') {
            p.production.state = 'complete'; p.production.message = '本镜真实视频已下载入库，可在本地播放；原成果保留'; this.authorized.delete(p.id);
          }
          p = await this.commitCollectedMedia(p, pending, priorSelection);
          if (p.production?.steps.some((step): boolean => step.id === pending.id && step.status === 'complete') && p.production.stopAfterCurrent) {
            p.production.state = p.production.target ? 'complete' : 'paused';
            p.production.message = '当前镜头已保存；后续镜头等待返回项目后明确继续';
            this.authorized.delete(p.id); p = await this.projects.write(p);
          }
          return { success: true, project: p, action: 'wait' };
        }
        // 活跃原控制器可能先写 submittedAt、再写受理证据。这里只等待同一绑定运行，
        // 不发送、重试或创建观察器；停止后的不明提交仍必须走下方原会话核对。
        if (task.runtime?.acceptanceObservation?.outcome === 'manual_review'
          && ['executing', 'generating', 'manual_submission_observing'].includes(task.status)) throw new Error('提交受理状态不明，请先结束当前观察，再检查原结果或确认重发一次');
        if (['executing', 'generating', 'manual_submission_observing'].includes(task.status)) return { success: true, project: p, action: 'wait' };
        if (task.runtime?.submittedAt) {
          return { success: true, project: p, taskId: task.id, action: 'observe' };
        }
        if (task.status !== 'queued') throw new Error(task.errorInfo?.message || '原任务已停止，请处理后显式继续');
        if (pending.runId) throw new Error('原任务已有运行记录，禁止重新发送');
        await this.guard(task.id, false);
        return { success: true, project: p, taskId: task.id, action: 'start' };
  }
  private async recoverPreparingStep(p: PetStoryProject, pending: PetStoryProductionStep): Promise<{ project: PetStoryProject; step: PetStoryProductionStep }> {
    const matches = this.tasks.list().filter((task): boolean => task.petstory?.projectId === p.id && task.petstory.stepId === pending.id);
    if (matches.length > 1) throw new Error('原制作步骤存在多个历史任务，请先选择正确的原任务；未创建或发送');
    const intent = p.taskIntents?.find((item): boolean => item.kind === 'media' && item.targetId === pending.id);
    if (intent) {
      const recovered = await commitPetStoryTaskIntent(this.projects, this.tasks, p, intent, (project, task): void => {
        const step = requireValue(project.production?.steps.find((item): boolean => item.id === pending.id));
        step.taskId = task.id; step.status = 'bound';
      });
      p = recovered.project; pending = requireValue(p.production?.steps.find((item): boolean => item.id === pending.id));
    } else if (matches[0]) {
      const found = matches[0];
      if (found.projectId !== p.studioProjectId || found.assignedAccountId !== p.accountId || hash(found.prompt) !== pending.inputHash) throw new Error('历史制作步骤与原任务输入不一致，未授权');
      pending.taskId = found.id; pending.status = 'bound'; p = await this.projects.write(p);
    } else throw new Error('历史准备步骤缺少原任务及完整输入意图，请结束本次制作后按当前输入生成；未新增平台请求');
    return { project: p, step: pending };
  }
  /** 长下载/解码在项目短事务外执行，完成后仅回填原step；新制作与用户选择不能被迟到结果覆盖。 */
  private async commitCollectedMedia(source: PetStoryProject, step: PetStoryProductionStep, priorSelection: string | undefined): Promise<PetStoryProject> {
    const latest = await this.projects.read(source.id);
    if (latest.revision === source.revision) { const saved = await this.projects.write(source); await this.reconcileLocalMediaAssets(saved); return saved; }
    const original = [latest.production, ...(latest.productionHistory || []), ...Object.values(latest.imageProductions || {})]
      .find((production): boolean => !!production?.steps.some((item): boolean => item.id === step.id && item.taskId === step.taskId && item.runId === step.runId));
    const target = original?.steps.find((item): boolean => item.id === step.id && item.taskId === step.taskId && item.runId === step.runId);
    if (!target) throw new Error('原产物已下载，但制作运行已变化；原下载保留，请关联已有视频');
    const generated = source.assets.filter((asset): boolean => asset.taskId === step.taskId && asset.runId === step.runId);
    for (const asset of generated) if (!latest.assets.some((item): boolean => item.id === asset.id)) latest.assets.push(asset);
    target.assetId = step.assetId; target.status = step.status; target.error = step.error;
    target.rejectedArtifactIds = step.rejectedArtifactIds; target.failure = step.failure; target.mediaFailure = step.mediaFailure;
    if (original && original === latest.production && original.target && step.status === 'complete') { original.state = 'complete'; original.message = '本镜原运行产物已保存，可本地播放'; this.authorized.delete(latest.id); }
    if (original && original === latest.production && step.kind === 'video' && step.shotId && step.assetId
      && latest.selectedVideos?.[step.shotId] === priorSelection) {
      latest.selectedVideos = { ...latest.selectedVideos, [step.shotId]: step.assetId };
      original.shots[step.shotId].videoId = step.assetId;
    }
    const saved = await this.projects.write(latest); await this.reconcileLocalMediaAssets(saved); return saved;
  }
  private async prepareStep(p: PetStoryProject, target: Pick<PetStoryProductionStep, 'kind' | 'shotId' | 'characterId' | 'materialId'>, input: TaskAddParams, assetIds: string[], compiledPrompt?: PetStoryCompiledPrompt): Promise<PetStoryProductionResult> {
    const production = this.checked(p);
    this.validateRequestContext(p, production.capability, productionStepTarget(target));
    const final = input.prompts[0];
    if (!final || /@(?:Image|Video|Audio)\b/i.test(final)) throw new Error('最终提示词为空或含未验证引用语法');
    checkProductionReferences(final, p, assetIds);
    const videoPrompt = target.kind === 'video' ? p.plan?.shots.find((shot): boolean => shot.id === target.shotId)?.prompts.video : undefined;
    // 本次正文与实际输入已通过正式编译；清理旧泛标记，避免新成果继续被误报待复核。
    if (videoPrompt?.needsReview && compiledPrompt?.kind === 'video' && compiledPrompt.final === videoPrompt.final
      && !hasCurrentPromptReviewError(p, videoPrompt, { shotId: target.shotId, promptKind: 'video' })) {
      videoPrompt.needsReview = undefined;
      // checked已验证原快照；仅同步本次已核对的标记变化，不改历史文字合同或任务输入。
      production.planHash = productionPlanHash(requireValue(p.plan));
    }
    const step: PetStoryProductionStep = { ...target, id: randomUUID(), inputHash: hash(final), attachmentAssetIds: assetIds, compiledPrompt, status: 'preparing' };
    if (target.kind === 'video') {
      step.videoInputSnapshot = compileVideoInputSnapshot(p, step.id, requireValue(target.shotId), requireValue(compiledPrompt), requireValue(input.videoConfig));
      input = { ...input, videoInputSnapshot: step.videoInputSnapshot };
    }
    production.steps.push(step); production.message = `${target.characterId || target.shotId} · ${target.kind}`;
    const binding = { projectId: p.id, stepId: step.id, ...(production.imageOperationId ? { imageOperationId: production.imageOperationId, materialId: target.materialId } : {}) };
    const params: TaskAddParams = { ...input, petstory: binding, promptReadback: 'exact', executionIntent: 'hold' };
    const draft = target.kind === 'firstFrame' ? p.drafts?.find((d): boolean => d.shotId === target.shotId && d.kind === 'firstFrame' && (d.final === final || d.final === compiledPrompt?.final.trim())) : undefined;
    const old = draft ? this.tasks.list().find((t): boolean => t.id === draft.taskId) : undefined;
    const committed = await commitPetStoryTaskIntent(this.projects, this.tasks, p,
      { operationId: `media:${step.id}`, kind: 'media', targetId: step.id, input: params, accountId: p.accountId, createdAt: new Date().toISOString() },
      (project, task): void => {
        if (task.prompt !== final || task.executionIntent !== 'hold' || task.status !== 'queued') throw new Error('hold 任务写入回读不符，禁止授权');
        const savedStep = requireValue(project.production?.steps.find((item): boolean => item.id === step.id)); savedStep.taskId = task.id; savedStep.status = 'bound';
      }, old && old.projectId === p.studioProjectId && old.assignedAccountId === p.accountId && (old.prompt === final || old.prompt === compiledPrompt?.final.trim()) && JSON.stringify(old.attachments || []) === JSON.stringify(input.attachments || [])
        ? (): Task => this.tasks.adopt(old.id, binding, final) : undefined);
    p = committed.project; const task = committed.task;
    return { success: true, project: p, taskId: task.id, action: 'start' };
  }
  /** 仅在暂停且下游尚未使用该图时替换，旧文件保留；已经影响视频的重做属于 P5。 */
  async selectImage(id: string, stepId: string, artifactId: string): Promise<PetStoryProductionResult> {
    if (!this.imageOperationId) {
      const project = await this.projects.read(id);
      const operationId = Object.entries(project.imageProductions || {}).find(([, run]): boolean => run.steps.some((step): boolean => step.id === stepId))?.[0];
      if (operationId) return this.withImageOperation(id, operationId, (service: PetStoryProductionService): Promise<PetStoryProductionResult> => service.selectImage(id, stepId, artifactId));
    }
    const p = await this.projects.read(id);
    const production = this.checked(p);
    const step = production.steps.find((s): boolean => s.id === stepId && s.kind !== 'video');
    if (production.state !== 'paused' || !step?.taskId) throw new Error('请先暂停，再选择原图片任务的有效产物');
    if (step.assetId && production.steps.some((s): boolean => s.id !== step.id && s.attachmentAssetIds.includes(step.assetId || ''))) throw new Error('下游已经使用此图，保留原素材；有关视频局部重做属于 P5');
    const task = this.originalTask(p, step);
    const artifact = task.artifacts?.find((a): boolean => a.id === artifactId && a.runId === step.runId && a.kind === 'image' && task.outputs.includes(a.url));
    if (task.status !== 'done' || !artifact || ['expired', 'invalid'].includes(artifact.validation?.state || '')) throw new Error('请选择原运行的有效图片产物');
    if (p.assets.some((a): boolean => a.id === step.assetId && a.artifactId === artifactId)) return { success: true, project: p };
    // 原文件不删除；只有下载／校验及原子保存均成功，才更新选中指针。
    await this.collectMedia(p, step, { ...task, outputs: [artifact.url] });
    return { success: true, project: await this.projects.write(p) };
  }
  private async originalMediaDownload(p: PetStoryProject, step: PetStoryProductionStep, task: Task, artifact: NonNullable<Task['artifacts']>[number]): Promise<DownloadJob & { filePath: string }> {
      let job: DownloadJob | undefined = this.tasks.downloads().filter((j): boolean => downloadBelongsToArtifact(j, task, artifact, p.accountId)).reverse()[0];
      if (job?.filePath) {
        try { await fs.lstat(job.filePath); }
        catch (error: unknown) {
          // 本地下载缓存可能被移动／清理；只重下原 artifact，不把缺文件当成平台产物损坏。
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') job = undefined;
          else throw error;
        }
      }
      if (!job) {
        const result = await this.tasks.download({ outputs: [{ taskId: task.id, runId: step.runId, artifactIds: [artifact.id], inputVersion: step.videoInputSnapshot?.inputVersion, prompt: task.prompt, outputs: [artifact.url], accountId: p.accountId, mode: task.mode }] });
        if (!result.success || result.failed) throw new Error(result.error || '下载失败，继续时只重试原产物下载，不重新生成');
        job = this.tasks.downloads().find((j): boolean => !!result.jobIds?.includes(j.id) && downloadBelongsToArtifact(j, task, artifact, p.accountId));
      }
      if (!job?.filePath) throw new Error('下载作业与原任务产物归属不符，未登记素材');
      return { ...job, filePath: job.filePath };
  }
  private localMediaFact(task: Task, step: PetStoryProductionStep, artifactId: string, patch: Pick<TaskLocalMediaUpdate, 'phase' | 'state'> & Partial<TaskLocalMediaUpdate>, context?: MediaImportContext): Task {
    if (task.mode !== 'video') return task;
    const runtime = requireValue(task.runtime); const previous = runtime.localMedia;
    const { updatedAt: _at, phaseHistory: _history, ...stored } = previous || { updatedAt: '', phaseHistory: undefined };
    const saved = this.tasks.updateLocalMedia(task.id, runtime.runId, { ...stored, ...patch, expectedRevision: task.revision,
      operationId: `media:${runtime.runId}:${artifactId}`, artifactId,
      inputVersion: runtime.input.videoInputSnapshot?.inputVersion || step.videoInputSnapshot?.inputVersion,
      inputDigest: runtime.input.videoInputSnapshot?.digest || step.videoInputSnapshot?.digest, error: patch.error });
    if (context) context.task = saved; return saved;
  }
  /** 项目是已入库成果目录；仅依据原来源及真实文件补原Task ready，重启不触发平台。 */
  async reconcileLocalMediaAssets(project: PetStoryProject): Promise<void> {
    for (const asset of project.assets) {
      if (asset.kind !== 'video' || !asset.taskId || !asset.runId || !asset.artifactId || !asset.validation || !asset.downloadJobId) continue;
      const task = this.tasks.list().find((item): boolean => item.id === asset.taskId && item.runtime?.runId === asset.runId);
      if (!task?.runtime?.localMedia || task.runtime.localMedia.state === 'ready' || task.runtime.localMedia.assetId !== asset.id) continue;
      const step = [project.production, ...(project.productionHistory || [])].flatMap((run): PetStoryProductionStep[] => run?.steps || []).find((item): boolean => item.taskId === task.id && item.runId === asset.runId);
      if (!step || (await mediaDigest(await projectPath(this.projects.directory(project.id), asset.relativePath))).sha256 !== asset.validation.sha256) throw new Error('原入库视频文件与摘要不符，请重新读取或恢复原文件');
      this.localMediaFact(task, step, asset.artifactId, { phase: 'ready', state: 'ready', assetId: asset.id, downloadJobId: asset.downloadJobId, sha256: asset.validation.sha256, mediaInfo: asset.validation });
    }
  }
  private async decodedDownload(step: PetStoryProductionStep, task: Task, artifact: NonNullable<Task['artifacts']>[number], job: DownloadJob & { filePath: string }, kind: 'video' | 'image'): Promise<PetStoryAsset['validation']> {
      try { return await validatePetStoryMedia(job.filePath, kind); }
      catch (error: unknown) {
        step.mediaFailure = { code: error instanceof MediaProcessingError ? error.code : (error as NodeJS.ErrnoException)?.code || 'MEDIA_VALIDATION_FAILED',
          taskId: task.id, runId: requireValue(step.runId), artifactId: artifact.id, recordedAt: new Date().toISOString(),
          ...(error instanceof MediaProcessingError ? { exitCode: error.exitCode, stderr: error.stderr } : {}) };
        // 权限、文件竞态或磁盘错误可沿原下载重试，不能永久排除仍有效的平台产物。
        if (!isConfirmedMediaRejection(error)) throw error;
        step.failure = { stage: 'validation', code: 'MEDIA_CONTENT_INVALID', message: error instanceof Error ? error.message : '媒体内容校验失败' };
        step.rejectedArtifactIds = [...(step.rejectedArtifactIds || []), artifact.id];
        step.error = error instanceof Error ? error.message : '产物校验失败';
        return undefined; // 损坏产物不能采用，也不发起新生成。
      }
  }
  private async prepareLocalDownload(p: PetStoryProject, step: PetStoryProductionStep, task: Task, artifact: NonNullable<Task['artifacts']>[number], context: MediaImportContext): Promise<{ task: Task; job: DownloadJob & { filePath: string } }> {
    const previous = task.runtime?.localMedia;
    if (previous && previous.state !== 'ready') task = this.localMediaFact(task, step, artifact.id, { phase: previous.phase, state: 'working' }, context);
    else if (!previous) task = this.localMediaFact(task, step, artifact.id, { phase: 'downloading', state: 'working' }, context);
    const job = await this.originalMediaDownload(p, step, task, artifact);
    if (!task.runtime?.localMedia || task.runtime.localMedia.phase === 'downloading') task = this.localMediaFact(task, step, artifact.id, { phase: 'downloaded', state: 'working', downloadJobId: job.id }, context);
    return { task, job };
  }
  private async validateLocalDownload(step: PetStoryProductionStep, task: Task, artifact: NonNullable<Task['artifacts']>[number], job: DownloadJob & { filePath: string }, kind: 'video' | 'image', context: MediaImportContext): Promise<{ task: Task; validation: PetStoryAsset['validation'] }> {
    let validation = task.runtime?.localMedia?.mediaInfo;
    if (!validation) {
      task = this.localMediaFact(task, step, artifact.id, { phase: 'validating', state: 'working', downloadJobId: job.id }, context);
      validation = await this.decodedDownload(step, task, artifact, job, kind);
      if (!validation) {
        this.localMediaFact(task, step, artifact.id, { phase: 'validating', state: 'failed', error: { code: 'MEDIA_CONTENT_INVALID', message: step.error || '媒体内容校验失败' } }, context);
        return { task, validation: undefined };
      }
    }
    return { task, validation };
  }
  private async copyLocalAsset(p: PetStoryProject, step: PetStoryProductionStep, task: Task, artifact: NonNullable<Task['artifacts']>[number], job: DownloadJob & { filePath: string }, validation: NonNullable<PetStoryAsset['validation']>, kind: 'video' | 'image', context: MediaImportContext): Promise<PetStoryAsset> {
    const assetId = task.runtime?.localMedia?.assetId || randomUUID();
    if (task.runtime?.localMedia?.state !== 'ready') task = this.localMediaFact(task, step, artifact.id, { phase: 'library', state: 'working', assetId, mediaInfo: validation, sha256: validation.sha256, downloadJobId: job.id }, context);
    const ext = kind === 'video' ? '.mp4' : path.extname(job.filePath).toLowerCase();
    if (!['.mp4', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('下载图片扩展名异常，未绑定');
    const relativePath = step.materialId ? `materials/${assetId}${ext}` : step.kind === 'character' ? `characters/${assetId}${ext}` : `shots/${step.shotId}/${assetId}${ext}`;
    const destination = await projectPath(this.projects.directory(p.id), relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await projectPath(this.projects.directory(p.id), relativePath);
    try { await fs.copyFile(job.filePath, destination, 1); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if ((await mediaDigest(destination)).sha256 !== validation.sha256) throw new Error('下载复制后的素材校验不一致');
    // copy之后仍核对原版本；暂停/结束的迟到磁盘结果不取得新运行的写入权。
    if (task.mode === 'video' && task.runtime?.localMedia?.state !== 'ready') task = this.localMediaFact(task, step, artifact.id, { phase: 'library', state: 'working', assetId, mediaInfo: validation, sha256: validation.sha256, downloadJobId: job.id }, context);
    const asset: PetStoryAsset = { id: assetId, kind: step.kind === 'lastFrame' ? 'plannedEndImage' : step.kind, relativePath,
      materialId: step.materialId, generationPrompt: task.prompt, generationFinal: step.compiledPrompt?.final, shotId: step.shotId, characterId: step.characterId, taskId: task.id, runId: step.runId, artifactId: artifact.id, downloadJobId: job.id, validation };
    if (kind === 'video') asset.sourceSnapshot = localMediaSource(p, asset, step, task);
    if (kind === 'image') {
      const target = step.materialId ? { materialId: step.materialId } : step.kind === 'character' ? { materialId: `character:${requireValue(step.characterId)}` }
        : { shotId: requireValue(step.shotId), kind: step.kind as 'firstFrame' | 'lastFrame' };
      asset.imageReview = { state: 'candidate', target, basisHash: imageTargetBasis(p, target) };
    }
    step.failure = undefined;
    return asset;
  }
  private recordLocalFailure(step: PetStoryProductionStep, task: Task, artifactId: string, stage: 'download' | 'validation' | 'library', error: unknown): void {
    step.failure = { stage, code: error instanceof MediaProcessingError ? error.code : (error as NodeJS.ErrnoException)?.code || `${stage.toUpperCase()}_FAILED`, message: error instanceof Error ? error.message : '本地媒体处理失败' };
    const local = task.runtime?.localMedia;
    const latest = this.tasks.list().find((item): boolean => item.id === task.id && item.runtime?.runId === task.runtime?.runId);
    if (task.mode === 'video' && local?.state !== 'ready' && latest?.runtime?.localMedia?.state === 'working') {
      // 保存失败或运行被撤回不能再用晚到错误覆盖新版本；权威命令会拒绝旧revision。
      try { this.localMediaFact(task, step, artifactId, { phase: local?.phase || 'downloading', state: 'failed', error: { code: step.failure.code, message: step.failure.message } }); } catch { /* 主错误保留，未伪报成功 */ }
    }
  }
  private async importMediaArtifact(p: PetStoryProject, step: PetStoryProductionStep, task: Task, artifact: NonNullable<Task['artifacts']>[number]): Promise<PetStoryAsset | undefined> {
    const kind = step.kind === 'video' ? 'video' : 'image';
    const context: MediaImportContext = { task };
    let stage: 'download' | 'validation' | 'library' = 'download';
    try {
      const prepared = await this.prepareLocalDownload(p, step, task, artifact, context); task = prepared.task;
      stage = 'validation';
      const checked = await this.validateLocalDownload(step, task, artifact, prepared.job, kind, context); task = checked.task;
      if (!checked.validation) return undefined;
      step.mediaFailure = undefined; stage = 'library';
      return await this.copyLocalAsset(p, step, task, artifact, prepared.job, checked.validation, kind, context);
    } catch (error: unknown) { this.recordLocalFailure(step, context.task, artifact.id, stage, error); throw error; }
  }
  private async collectMedia(p: PetStoryProject, step: PetStoryProductionStep, task: Task): Promise<void> {
    if (!step.runId || task.runtime?.runId !== step.runId || !task.runtime.submittedAt) throw new Error('生成结果缺少原运行与单次提交记录');
    const kind = step.kind === 'video' ? 'video' : 'image';
    const artifacts = task.outputs.flatMap((url): NonNullable<Task['artifacts']> => (task.artifacts || []).filter((a): boolean => a.url === url && a.runId === step.runId && a.kind === kind && (!['invalid', 'expired'].includes(a.validation?.state || '') || this.tasks.downloads().some((job): boolean => downloadBelongsToArtifact(job, task, a, p.accountId))) && !step.rejectedArtifactIds?.includes(a.id)));
    if (!artifacts.length) throw new Error('没有属于原运行的可用真实产物，done 或缩略图不算媒体');
    // 同一运行的所有有效图片均保存为候选；下载和文件校验不代表用户采用。
    let firstAssetId: string | undefined;
    for (const artifact of artifacts) {
      const duplicate = p.assets.find((asset): boolean => asset.taskId === task.id && asset.runId === step.runId && asset.artifactId === artifact.id);
      if (duplicate) { firstAssetId ||= duplicate.id; continue; }
      let asset: PetStoryAsset | undefined;
      try { asset = await this.importMediaArtifact(p, step, task, artifact); }
      catch (error: unknown) {
        if (!firstAssetId) throw error;
        step.error = error instanceof Error ? error.message : '部分候选下载失败';
        // 同一任务后续候选失败时，先保住已取得候选，再暂停原步骤；恢复只重下缺项。
        await this.projects.write(p);
        throw error;
      }
      if (!asset) continue;
      p.assets.push(asset); firstAssetId ||= asset.id;
      if (kind === 'video') break;
    }
    if (firstAssetId) {
      step.assetId = firstAssetId; step.status = 'complete'; step.error = undefined;
      if (kind === 'video') {
        const shotId = requireValue(step.shotId);
        this.checked(p).shots[shotId].videoId = firstAssetId;
        p.selectedVideos = { ...p.selectedVideos, [shotId]: firstAssetId };
      }
      if (kind === 'image' && this.checked(p).phase !== 'materials') {
        const production = this.checked(p);
        production.state = production.target ? 'complete' : 'paused';
        production.message = '图片已下载，请预览并采用满意的一张';
        this.authorized.delete(p.id);
      }
      return;
    }
    await this.projects.write(p);
    throw new Error(step.error || '本次返回的产物均未通过文件校验；保留原任务，不重新生成');
  }
}
