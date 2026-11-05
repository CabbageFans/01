import { pendingPetStoryDrafts } from '../utils/petstoryDraftPresence';
import { create } from 'zustand';
import type { Account, Task, TaskResubmitUncertainParams, PetStoryPlan, PetStoryProject, PetStoryPromptKind, PetStoryPromptEditBasis, PetStoryResult, PetStoryChatJob, PetStoryCapability, PetStoryMaterialEditIntent, PetStoryProductionCounts, PetStoryModeResolution, PetStoryPromptProfile, PetStoryRuntimeTarget, PetStoryPromptBatch, PetStoryConversationReply, PetStoryAdjustmentPreview, PetStoryImageTarget, PetStoryImageOperation, PetStoryImageOperationResult, PetStoryAsset, PetStoryProductionStep, PetStoryShot } from '@doubao-studio/contracts';
import { useTaskStore } from './useTaskStore';
import { useAccountStore } from './useAccountStore';
import { useProjectStore } from './useProjectStore';
import { repairPrompt } from '../utils/petstoryPrompts';
import { resolveTaskConversationTarget } from '../utils/taskConversationLocator';
import { canStartBoundChat } from '../utils/petstoryCandidate';
import { canSelectAccount, findInteractiveAccountId } from '../utils/interactiveAccount';
import { IMAGE_CONVERSATION_RECOVERY_MESSAGE, imageConversationTask, imageOperationForChatJob } from '../utils/petstoryImageFlow';
import { journeyShotAsset } from '../utils/petstoryJourney';
import { isBackgroundProductionVideoTask } from '../utils/petstoryBackground';
import { automationEngine } from '../automation/AutomationEngine';
import { isPetStoryPromptPreparationMessage } from '../components/petStoryCanvasShared';
import { matchesVerificationRecoveryRun, type TaskVerificationRecoveryDetail } from '../utils/verificationRecovery';
import { needsPetStoryReferenceAdaptation } from '../utils/petstoryVisualBasis';
import { selectPlanReview } from '../utils/petstoryPlanReview';
import { hasPlatformAcceptance } from '../utils/acceptedObservation';
import { registerTaskDispatchGuard } from '../automation/taskDispatchGuards';

interface PetStoryState {
  activeImageOperationId: string | null;
  generateMaterialImage: (materialId: string) => Promise<void>;
  modifyImage: (target: PetStoryImageTarget, baseAssetId: string, feedback: string) => Promise<void>;
  recoverImageOperation: (operationId: string) => Promise<void>;
  advanceImageOperation: () => Promise<void>;
  openImageConversation: (target: PetStoryImageTarget, assetId?: string) => Promise<void>;
  applyChatReply: (replyKey: string) => Promise<PetStoryAdjustmentPreview | null>;
  previewChatReply: (replyKey: string) => Promise<PetStoryAdjustmentPreview | null>;
  openChatAdjustment: (target: PetStoryRuntimeTarget) => Promise<void>;
  captureChatReplies: (adjustmentId: string, conversationUrl: string, replies: PetStoryConversationReply[]) => Promise<void>;
  adoptChatReply: (replyKey: string) => Promise<void>;
  importChatImages: (replyKey: string) => Promise<void>;
  endChatAdjustment: () => Promise<void>;
  chatReadbackError: string;
  uploadShotImage: (shotId: string, kind: 'firstFrame' | 'lastFrame') => Promise<void>;
  adoptShotImage: (shotId: string, kind: 'firstFrame' | 'lastFrame', assetId: string) => Promise<void>;
  continuePromptStage: () => Promise<void>;
  generateCanvasPrompts: () => Promise<void>;
  inspectPromptStageTargets: (scope?: 'shots') => Promise<PetStoryResult>;
  resumeCanvasPrompt: (jobId: string) => Promise<void>;
  adoptPromptBatchCandidates: () => Promise<void>;
  revisePlan: (feedback: { text: string; baseJobId?: string; requestId: string }) => Promise<string | undefined>;
  revisePrompt: (request: { shotId: string; promptKind: PetStoryPromptKind; feedback: string; baseJobId?: string }) => Promise<void>;
  savePromptModel: (model?: PetStoryProject['promptModel']) => Promise<void>;
  endChatWaiting: (jobId: string) => Promise<void>;
  recoverChat: (jobId: string) => Promise<void>;
  saveOriginalStory: (text: string) => Promise<void>;
  linkExistingMedia: (shotId: string, kind: PetStoryPromptKind, taskId: string, artifactId?: string) => Promise<void>;
  promptBatch: { total: number; completed: number; status: 'idle' | 'running' | 'complete' | 'paused' };
  promptRepairJobIds: string[];
  regenerateAllPrompts: () => Promise<void>;
  regenerateAllMaterialPrompts: () => Promise<void>;
  extractAssets: () => Promise<void>;
  adoptPlanCandidate: (jobId: string) => Promise<void>;
  adoptAssetsCandidate: (jobId: string) => Promise<void>;
  adoptPromptCandidate: (jobId: string) => Promise<void>;
  reviewContent: (target?: PetStoryRuntimeTarget) => Promise<void>;
  reviseContent: (reviewJobId: string, target: PetStoryRuntimeTarget) => Promise<void>;
  stopPromptBatch: (reason?: 'verification') => Promise<void>;
  regenerateMaterialPrompt: (materialId: string, editIntent?: PetStoryMaterialEditIntent) => Promise<void>;
  saveShotPrompt: (shotId: string, kind: PetStoryPromptKind, final: string, basis?: PetStoryPromptEditBasis) => Promise<void>;
  generateShotMedia: (shotId: string, kind: PetStoryPromptKind) => Promise<void>;
  resumeUnsubmittedVideo: (shotId: string, taskId: string, runId: string) => Promise<void>;
  resumeVideoAsReferences: (shotId: string, taskId: string, runId: string) => Promise<void>;
  exportStatus: string;
  exportPrompts: () => Promise<void>;
  project: PetStoryProject | null;
  projectName: string;
  capability: PetStoryCapability | null;
  productionCounts: PetStoryProductionCounts | null;
  productionResolutions: Record<string, PetStoryModeResolution>;
  fallbacks: Record<string, 'first_frame' | 'reference'>;
  confirmStory: () => Promise<void>;
  saveMaterialPrompt: (materialId: string, final: string) => Promise<void>;
  addMaterialImage: (materialId: string) => Promise<void>;
  selectMaterialImage: (materialId: string, assetId: string) => Promise<void>;
  approveMaterials: (selections: { materialId: string; assetId: string }[]) => Promise<void>;
  generateMaterials: (materialIds: string[]) => Promise<void>;
  selectProductionImage: (stepId: string, artifactId: string) => Promise<void>;
  setFallback: (shotId: string, mode?: 'first_frame' | 'reference') => void;
  previewProduction: () => Promise<void>;
  startProduction: () => Promise<void>;
  pauseProduction: () => Promise<void>;
  resumeProduction: () => Promise<void>;
  resubmitProduction: (request: TaskResubmitUncertainParams) => Promise<void>;

  busy: boolean;
  error: string;
  autoRepair: boolean;
  setAutoRepair: (value: boolean) => void;
  createProject: (selection?: { accountId: string; studioProjectId: string }) => Promise<void>;
  openProject: (path?: string) => Promise<void>;
  saveSource: (text: string) => Promise<void>;
  saveMobileStory: (text: string) => Promise<void>;
  addSceneReference: (shotId: string) => Promise<void>;
  addReference: (characterId: string) => Promise<void>;
  bindSharedReference: (characterId: string, assetId: string) => Promise<void>;
  savePromptProfile: (profile: PetStoryPromptProfile) => Promise<void>;
  savePlan: (plan: PetStoryPlan) => Promise<void>;
  analyze: () => Promise<void>;
  optimize: (shotId: string, kind: PetStoryPromptKind) => Promise<void>;
  correctOnce: (jobId: string) => Promise<void>;
  startBoundChat: (jobId: string) => Promise<void>;
  retryUnsubmitted: (jobId: string) => Promise<void>;
  collect: (jobId: string, allowRepair?: boolean) => Promise<void>;
  draftFinal: (shotId: string) => Promise<void>;
}
function isChatAdjusting(p: PetStoryProject | null): boolean { return p?.chatAdjustment?.status === 'active'; }
/** 自由交流只向用户明确选定的修订任务移交输入权，其余任务继续等待。 */
function isAdjustmentRepair(p: PetStoryProject, job: PetStoryChatJob | undefined): boolean {
  return !!job && job.kind === 'repair' && p.chatAdjustment?.status === 'active' && p.chatAdjustment.repairJobId === job.id;
}
function latestRepair(p: PetStoryProject, source: PetStoryChatJob): PetStoryChatJob {
  let current = source; const seen = new Set<string>();
  while (!seen.has(current.id)) {
    seen.add(current.id);
    const child = p.jobs.find((job): boolean => job.kind === 'repair' && job.parentJobId === current.id);
    if (!child) break;
    current = child;
  }
  return current;
}
function pendingChatJob(job: PetStoryChatJob | undefined): job is PetStoryChatJob & { status: 'bound' | 'captured' } {
  return !!job && !job.endedWaitingAt && ['bound', 'captured'].includes(job.status);
}
/** 文字采用与图片收取都重新核对选定回复；过程不发送、导航或修改网页输入框。 */
async function verifyAdjustmentReply(adjustmentId: string, replyKey: string): Promise<void> {
  await new Promise<void>((resolve, reject): void => {
    const timeout = setTimeout((): void => reject(new Error('关联会话未能及时核对，请保持豆包页面打开')), 6000);
    window.dispatchEvent(new CustomEvent('petstory-verify-adjustment-reply', { detail: { adjustmentId, replyKey,
      resolve: (): void => { clearTimeout(timeout); resolve(); }, reject: (error: Error): void => { clearTimeout(timeout); reject(error); } } }));
  });
}
const liveJobs = new Set<string>();
/** 重开只恢复已发送原结果的收取权，不恢复平台发送或格式修订的授权。 */
const restoredPlanReadbacks = new Map<string, { projectId: string; runId: string; authorization: number }>();
type PlanReadbackTask = Task & { runtime: NonNullable<Task['runtime']> };
function samePlanReadbackInput(job: PetStoryChatJob, task: PlanReadbackTask): boolean {
  const input = task.runtime.input;
  return !!job.requestText && task.prompt === job.requestText && input.mode === 'chat' && input.prompt === task.prompt
    && JSON.stringify(input.attachments || []) === JSON.stringify(task.attachments || []) && input.audioAttachment === task.audioAttachment
    && JSON.stringify(input.videoConfig) === JSON.stringify(task.videoConfig) && JSON.stringify(input.petstory) === JSON.stringify(task.petstory);
}
function originalPlanReadbackTask(project: PetStoryProject, job: PetStoryChatJob, task: Task | undefined): task is PlanReadbackTask {
  if (!task || !task.runtime?.runId || !task.runtime.submittedAt || !job.runId || task.runtime.runId !== job.runId || !job.requestId
    || task.mode !== 'chat' || task.projectId !== project.studioProjectId || task.assignedAccountId !== project.accountId) return false;
  return samePlanReadbackInput(job, task as PlanReadbackTask);
}
function restoredPlanReadback(project: PetStoryProject, tasks: Task[]): { job: PetStoryChatJob; task: PlanReadbackTask } | undefined {
  if (!project.mobileStory || isChatAdjusting(project)) return;
  const selection = selectPlanReview(project); const root = selection.family[0]; const job = selection.job;
  if (!root?.planFeedback || !job || !['bound', 'captured'].includes(job.status) || job.resultStatus === 'stale'
    || selection.family.some((item): boolean => !!item.endedWaitingAt || item.sourceStoryId !== project.mobileStory?.id || item.sourceUrl !== project.source.url)) return;
  const task = tasks.find((item): boolean => item.id === job.taskId);
  if (!originalPlanReadbackTask(project, job, task)) return;
  const runtime = task.runtime;
  const saved = task.status === 'done' && (!!runtime.chatResponse?.text || job.status === 'captured' && !!job.rawText);
  const observing = ['generating', 'manual_submission_observing'].includes(task.status) && hasPlatformAcceptance(task)
    && runtime.acceptanceObservation?.accountId === project.accountId && runtime.acceptanceObservation.expectedArtifact.runId === runtime.runId;
  // 暂停／排队仍要求用户明确继续；重开不把未决发送、已停止等待或任意历史回复重新激活。
  return saved || observing ? { job, task } : undefined;
}
function currentRestoredPlanReadback(project: PetStoryProject | null, tasks: Task[]): ReturnType<typeof restoredPlanReadback> {
  const restored = project ? restoredPlanReadback(project, tasks) : undefined;
  for (const [jobId, readback] of restoredPlanReadbacks) {
    if (jobId !== restored?.job.id || readback.projectId !== project?.id || readback.runId !== restored.task.runtime.runId
      || readback.authorization !== promptWorkAuthorization) restoredPlanReadbacks.delete(jobId);
  }
  return restored;
}
type PromptBatchTarget = { shotId: string; kind: PetStoryPromptKind; materialId?: never } | { materialId: string; shotId?: never; kind?: never };
function promptTargetKey(target: PromptBatchTarget): string {
  return target.materialId ? `material:${target.materialId}` : `shot:${target.shotId}:${target.kind}`;
}
function promptTargetExists(project: PetStoryProject, target: PromptBatchTarget): boolean {
  if (target.materialId) return !!project.materials?.some((material): boolean => material.id === target.materialId);
  if (!target.kind) return false;
  return !!project.plan?.shots.find((shot): boolean => shot.id === target.shotId)?.prompts[target.kind];
}
function promptJobKey(job: PetStoryChatJob): string | undefined {
  if (!['optimize', 'materialPrompt', 'revise', 'repair'].includes(job.kind)) return;
  if (job.materialId) return promptTargetKey({ materialId: job.materialId });
  if (job.shotId && job.promptKind) return promptTargetKey({ shotId: job.shotId, kind: job.promptKind });
}
function resolvesEndedPrompt(project: PetStoryProject, ended: PetStoryChatJob, candidate: PetStoryChatJob): boolean {
  if (candidate.endedWaitingAt || candidate.status !== 'applied' || candidate.resultStatus === 'stale' || promptJobKey(candidate) !== promptJobKey(ended)) return false;
  // 自动纠正属于其原请求；旧请求晚到后纠正，不能冒充结束等待后的新明确操作。
  let round: PetStoryChatJob | undefined = candidate; const seen = new Set<string>();
  while (round?.kind === 'repair' && !seen.has(round.id)) {
    seen.add(round.id); const parentId: string | undefined = round.parentJobId;
    round = project.jobs.find((job): boolean => job.id === parentId);
  }
  if (!round || !['optimize', 'materialPrompt', 'revise'].includes(round.kind)) return false;
  return Date.parse(round.createdAt || '') > Date.parse(ended.endedWaitingAt || '');
}
function unresolvedEndedPromptKeys(project: PetStoryProject): Set<string> {
  const ended = project.jobs.filter((job): boolean => !!job.endedWaitingAt && !!promptJobKey(job));
  const unresolved = ended.filter((job): boolean => !project.jobs.some((candidate): boolean => resolvesEndedPrompt(project, job, candidate)));
  return new Set(unresolved.map(promptJobKey).filter((key): key is string => !!key));
}
/** 展示和执行共享同一范围；结束等待的目标仍须用户明确重新生成。 */
export function petStoryPromptActionTargets(project: PetStoryProject, targets: PromptBatchTarget[]): PromptBatchTarget[] {
  const saved = project.promptBatch;
  if (saved && saved.status !== 'complete' && saved.targets.length) return saved.targets;
  const excluded = unresolvedEndedPromptKeys(project);
  return targets.filter((target): boolean => !excluded.has(promptTargetKey(target)));
}
function currentPromptSource(project: PetStoryProject, target: PromptBatchTarget): PetStoryChatJob | undefined {
  const prompt = target.materialId ? project.materials?.find((item): boolean => item.id === target.materialId)?.prompt
    : target.kind ? project.plan?.shots.find((shot): boolean => shot.id === target.shotId)?.prompts[target.kind] : undefined;
  const id = prompt?.edited ? prompt.basisJobId : prompt?.sourceJobId;
  return project.jobs.find((job): boolean => job.id === id);
}
function hasAdoptedReplacement(project: PetStoryProject, failed: PetStoryChatJob, target: PromptBatchTarget): boolean {
  const source = currentPromptSource(project, target);
  if (!source || project.jobs.indexOf(source) <= project.jobs.findIndex((job): boolean => job.id === failed.id)) return false;
  return source.status === 'applied' && source.resultStatus === 'adopted' && !source.endedWaitingAt && promptJobKey(source) === promptTargetKey(target);
}
function hasPendingTargetCandidate(project: PetStoryProject, target: PromptBatchTarget, jobIds: string[]): boolean {
  return jobIds.some((id): boolean => {
    const job = project.jobs.find((item): boolean => item.id === id);
    return !job || promptJobKey(job) === promptTargetKey(target);
  });
}
function failedPromptLabels(project: PetStoryProject, jobs: PetStoryChatJob[]): string[] {
  const grouped = new Map<string, { order: number; kinds: Set<PetStoryPromptKind> }>();
  const other: string[] = [];
  for (const job of jobs) {
    const shot = project.plan?.shots.find((item): boolean => item.id === job.shotId);
    if (!shot || !job.promptKind) { other.push(project.materials?.find((item): boolean => item.id === job.materialId)?.name || '该项提示词'); continue; }
    const group = grouped.get(shot.id) || { order: shot.order, kinds: new Set<PetStoryPromptKind>() };
    group.kinds.add(job.promptKind); grouped.set(shot.id, group);
  }
  const labels: Record<PetStoryPromptKind, string> = { firstFrame: '首帧', lastFrame: '尾帧', video: '视频' };
  return [...grouped.values()].sort((a, b): number => a.order - b.order).map((item): string => `镜头${item.order}${(['firstFrame', 'lastFrame', 'video'] as const).filter((kind): boolean => item.kinds.has(kind)).map((kind): string => labels[kind]).join('／')}`).concat([...new Set(other)]);
}
function savedPromptBatchRun(project: PetStoryProject, saved: PetStoryPromptBatch): { job: PetStoryChatJob | undefined; targets: PromptBatchTarget[] } {
  const original = project.jobs.find((item): boolean => item.id === saved.jobId);
  let job = original ? latestRepair(project, original) : undefined;
  const targets = [...saved.targets];
  if (saved.scope !== 'shots') return { job, targets };
  // 后续镜头已有原请求时先恢复它，不被旧失败队首挡住后另建请求。
  const pending = project.jobs.find((item): boolean => pendingChatJob(item) && targets.some((target): boolean => promptTargetKey(target) === promptJobKey(item)));
  if (!pending) return { job, targets };
  job = latestRepair(project, pending);
  const key = promptJobKey(job);
  const index = targets.findIndex((target): boolean => promptTargetKey(target) === key);
  if (index > 0) { const [target] = targets.splice(index, 1); targets.unshift(target); }
  return { job, targets };
}
function canAutomaticallyRepair(job: PetStoryChatJob, authorized: boolean, imageOperation: boolean, autoRepair: boolean): boolean {
  return !job.endedWaitingAt && authorized && (imageOperation || !!job.planFeedback || isPromptWritingJob(job) || autoRepair);
}
function isPromptWritingJob(job: PetStoryChatJob): boolean {
  return job.originKind !== 'review' && !!promptJobKey(job);
}
function hasRepairablePromptReply(job: PetStoryChatJob): boolean {
  return job.status === 'invalid' && !!job.requestId && !!job.rawText && !job.endedWaitingAt && job.resultStatus !== 'stale'
    && !!job.validationDetails?.length && job.validationDetails.every((issue): boolean => issue.repairable);
}
let promptBatchQueue: { projectId: string; id: string; scope?: 'shots'; targets: PromptBatchTarget[]; candidateJobIds: string[]; failedTargets: NonNullable<PetStoryPromptBatch['failedTargets']>; jobId?: string; stopRequested?: boolean } | null = null;
let promptWorkAuthorization = 0;
let verificationPausedBatch: { projectId: string; jobId: string; taskId: string; runId: string; authorization: number } | undefined;
function isVerificationBatchContinuation(projectId: string, job: PetStoryChatJob): boolean {
  return verificationPausedBatch?.projectId === projectId && verificationPausedBatch.jobId === job.id
    && verificationPausedBatch.authorization === promptWorkAuthorization && verificationPausedBatch.runId === job.runId;
}
let activeProductionId: string | null = null;
let productionTickRunning = false;
const observingProductionTasks = new Set<string>();
type ProductionConfirmationRecheck = { projectId: string; taskId: string; runId: string; submittedAt: string };
let pendingProductionConfirmationRecheck: ProductionConfirmationRecheck | undefined;
type ProductionObservationAttempt = ProductionConfirmationRecheck & { authorization: number };
const productionObservationAttempts = new Map<string, ProductionObservationAttempt>();
let productionObservationAuthorization = 0;
type ImageOperationContext = { projectId: string; operationId: string };
type ImageObservationAttempt = { context: ImageOperationContext; taskId: string; accountId: string; runId: string; submittedAt: string };
let activeImageOperation: ImageOperationContext | null = null;
let imageOperationTickRunning = false;
const dispatchedImageTasks = new Set<string>();
const imageObservationAttempts = new Map<string, ImageObservationAttempt>();
const attemptedImageRuns = new Set<string>();
function authorizedImageChat(project: PetStoryProject, jobId: string): boolean {
  const operation = imageOperationForChatJob(project, jobId);
  return !!operation && activeImageOperation?.projectId === project.id && activeImageOperation.operationId === operation.id;
}
function collectedFailureMessage(result: PetStoryResult, imageOperation: boolean): string {
  if (result.error) return result.error;
  return imageOperation ? '图片准备未完成，请继续本次任务。' : '内容尚未通过，请查看当前任务。';
}
function imageOperationContinues(result: PetStoryImageOperationResult, operation: PetStoryImageOperation | undefined): boolean {
  return (result.success || !!result.needsRepair) && operation?.stage !== 'complete' && operation?.stage !== 'failed';
}
/** 只有本会话的生成或显式恢复可推进；重开卡片仅显示保存的真实状态。 */
export async function tickPetStoryImageOperation(): Promise<void> {
  const state = usePetStoryStore.getState();
  if (!activeImageOperation || activeImageOperation.projectId !== state.project?.id || state.busy || isChatAdjusting(state.project) || imageOperationTickRunning) return;
  imageOperationTickRunning = true;
  try { await state.advanceImageOperation(); }
  finally { imageOperationTickRunning = false; }
}
function canTickProduction(state: PetStoryState, id: string | null): id is string {
  return !!id && state.project?.id === id && !state.busy && !isChatAdjusting(state.project) && !productionTickRunning;
}
/** 制作接力独立于前台保存运行，迟到回读不得覆盖暂停后的新版本或另一个项目。 */
function acceptProductionSnapshot(id: string, project: PetStoryProject | undefined): boolean {
  const current = usePetStoryStore.getState().project;
  if (!project || project.id !== id || current?.id !== id || project.revision < current.revision) return false;
  usePetStoryStore.setState({ project });
  return true;
}
function productionStillRunning(id: string): boolean {
  const current = usePetStoryStore.getState().project;
  return activeProductionId === id && current?.id === id && current.production?.state === 'running';
}
/** 明确受理或仍在观察的任务只能继续读取；新发送必须单独取得本次用户授权。 */
export function petStoryResubmissionTask(project: PetStoryProject, tasks: Task[], activeTaskIds: string[] = []): Task | undefined {
  if (project.production?.state !== 'paused') return undefined;
  const step = project.production.steps.find((item): boolean => item.status !== 'complete');
  const task = tasks.find((item): boolean => item.id === step?.taskId);
  const runtime = task?.runtime;
  if (!task || !runtime?.runId || !runtime.submittedAt || !['paused', 'fail', 'cancelled', 'waiting_verification', 'waiting_generation_confirmation'].includes(task.status)
    || activeTaskIds.includes(task.id) || step?.runId && step.runId !== runtime.runId
    || runtime.stage === 'completed' || runtime.chatAdjustmentGuard?.active || task.outputs.length || runtime.chatResponse || task.artifacts?.length
    || ['observing', 'completed'].includes(runtime.acceptanceObservation?.outcome || '')
    || ['observing', 'completed'].includes(runtime.manualObservation?.outcome || '')
    || task.lock && Date.parse(task.lock.expiresAt) > Date.now()) return undefined;
  return task;
}
/** 参数准备明确停止且没有发送证据时，才能从画布沿用原任务继续；未知受理走原有核对入口。 */
export function petStoryUnsubmittedVideoTask(project: PetStoryProject, shotId: string, tasks: Task[], activeTaskIds: string[] = []): Task | undefined {
  const task = unsubmittedVideoCandidate(project, shotId, tasks, activeTaskIds);
  if (task?.lock && (!Number.isFinite(Date.parse(task.lock.expiresAt)) || Date.parse(task.lock.expiresAt) > Date.now())) return undefined;
  return task;
}
function unsubmittedVideoCandidate(project: PetStoryProject, shotId: string, tasks: Task[], activeTaskIds: string[]): Task | undefined {
  if (project.production?.state !== 'paused') return undefined;
  const step = project.production.steps.find((item): boolean => item.status !== 'complete');
  if (step?.kind !== 'video' || step.shotId !== shotId || !step.runId) return undefined;
  const task = tasks.find((item): boolean => item.id === step.taskId);
  const runtime = task?.runtime;
  if (!task || !runtime || task.mode !== 'video' || runtime.input.mode !== 'video' || task.assignedAccountId !== project.accountId || task.projectId !== project.studioProjectId
    || task.petstory?.projectId !== project.id || task.petstory.stepId !== step.id || runtime.runId !== step.runId || !['fail', 'paused', 'cancelled'].includes(task.status)
    // 模式槽位核验同样发生在上传与提交之前；仍逐项排除所有发送和受理证据。
    || !(/^video_[a-z_]+_not_ready$/.test(task.errorInfo?.code || '') || task.errorInfo?.code === 'petstory_controls_unconfirmed') || activeTaskIds.includes(task.id)
    || runtime.submittedAt || runtime.acceptanceObservation || runtime.chatResponse || runtime.chatReadback || runtime.chatReadbackReview || runtime.manualObservation
    || runtime.stage === 'completed' || runtime.chatAdjustmentGuard?.active || task.outputs.length || task.artifacts?.length) return undefined;
  return task;
}

let videoRecoveryRefreshRunning = false;
/** 执行器结束后释放的是正式任务锁；补读该原任务，避免本地旧锁永久遮住继续入口。只读不授权。 */
async function refreshUnsubmittedVideoRecovery(): Promise<void> {
  const pet = usePetStoryStore.getState(); const state = useTaskStore.getState(); const project = pet.project;
  const step = project?.production?.steps.find((item): boolean => item.status !== 'complete');
  if (videoRecoveryRefreshRunning || pet.busy || !project || !step?.shotId) return;
  const task = unsubmittedVideoCandidate(project, step.shotId, state.tasks, [...Object.values(state.executingTasks), ...(state.activeTaskId ? [state.activeTaskId] : [])]);
  if (!task?.lock || automationEngine.isReserved(task.id) || Number.isFinite(Date.parse(task.lock.expiresAt)) && Date.parse(task.lock.expiresAt) <= Date.now()) return;
  videoRecoveryRefreshRunning = true;
  try {
    const fresh = (await window.electronAPI.tasks.list()).find((item): boolean => item.id === task.id);
    const current = useTaskStore.getState();
    // 回读期间若切项目、启动新运行或收到更新，不用旧响应覆盖当前任务。
    if (!fresh || usePetStoryStore.getState().project?.id !== project.id || current.tasks.find((item): boolean => item.id === task.id) !== task) return;
    if (JSON.stringify(fresh) !== JSON.stringify(task)) useTaskStore.setState({ tasks: current.tasks.map((item): Task => item.id === task.id ? fresh : item) });
  } catch {
    // 读取失败仍保留锁和原错误；下轮只读观察可再次核对，绝不凭本地猜测解锁。
  } finally { videoRecoveryRefreshRunning = false; }
}
function referenceFrameAdopted(asset: PetStoryAsset): boolean {
  return !!asset.validation?.decoded && asset.imageReview?.sha256 === asset.validation.sha256 && !!asset.imageReview?.adoptedAt;
}
function referenceStepUsesFrames(step: PetStoryProductionStep | undefined, task: Task, shot: PetStoryShot, first: PetStoryAsset, last: PetStoryAsset): boolean {
  if (step?.compiledPrompt?.references.length !== 2 || step.pageBindings
    || JSON.stringify(step.attachmentAssetIds) !== JSON.stringify([first.id, last.id]) || task.attachments?.length !== 2
    || step.compiledPrompt.final !== shot.prompts.video.final || task.resubmissionOf !== undefined || task.resubmittedAs !== undefined || step.resubmissionHistory !== undefined) return false;
  return true;
}
/** 按钮本身代表仅把当前两张首尾图用作普通参考图的明确授权，不承诺原生首尾约束。 */
export function petStoryReferenceVideoTask(project: PetStoryProject, shotId: string, tasks: Task[], activeTaskIds: string[] = []): Task | undefined {
  const task = petStoryUnsubmittedVideoTask(project, shotId, tasks, activeTaskIds);
  const step = project.production?.steps.find((item): boolean => item.status !== 'complete'); const shot = project.plan?.shots.find((item): boolean => item.id === shotId);
  const first = shot && journeyShotAsset(project, shot, 'firstFrame'); const last = shot && journeyShotAsset(project, shot, 'lastFrame');
  if (!task || task.errorInfo?.code !== 'petstory_controls_unconfirmed' || !shot || !first || !last || project.production?.shots[shotId]?.resolvedMode !== 'first_last_frame'
    || !referenceFrameAdopted(first) || !referenceFrameAdopted(last) || shot.prompts.video.promptTask?.mode !== 'first_last_frame'
    || !referenceStepUsesFrames(step, task, shot, first, last)) return undefined;
  return task;
}
/** 登录和验证必须在原账号解决，确认重复风险不能代替平台验证。 */
export function petStoryResubmissionAccountBlock(account: Account | undefined): string | undefined {
  if (!account) return '原执行账号不存在，请先在账号与浏览器中处理。';
  const availability = account.health?.availability;
  if (availability?.state === 'login_required' || account.health?.loginState === 'expired') return '请打开原账号豆包完成登录，再重新检测账号状态后确认重发。';
  if (account.health?.verificationRequired || availability?.state === 'action_required' && /human|verification|captcha|验证/.test(availability.reason)) return '请打开原账号豆包完成人机验证，再重新检测账号状态后确认重发。';
  return undefined;
}
async function pauseProductionFromTick(id: string, error: string): Promise<void> {
  activeProductionId = null;
  const paused = await window.electronAPI.petstory.pauseProduction(id);
  acceptProductionSnapshot(id, paused.project);
  if (usePetStoryStore.getState().project?.id === id) usePetStoryStore.setState({ error });
}
async function startProductionTask(id: string, taskId: string): Promise<void> {
  await refreshTasks();
  if (!productionStillRunning(id)) return;
  const started = await useTaskStore.getState().startAutomation(taskId, async (task: Task): Promise<void> => {
    if (!productionStillRunning(id) || !task.runtime) throw new Error('制作已暂停');
    const bound = await window.electronAPI.petstory.bindProductionRun(id, task.id, task.runtime.runId);
    if (!bound.success) throw new Error(bound.error || '制作运行绑定未保存');
    // 绑定写入期间也可能收到暂停；分派页面前再次核对，不能复活旧的运行授权。
    if (!productionStillRunning(id)) throw new Error('制作已暂停');
    if (bound.project && (!acceptProductionSnapshot(id, bound.project) || !productionStillRunning(id))) throw new Error('制作状态已变化，请核对后继续原任务');
  });
  if (!started && productionStillRunning(id)) await pauseProductionFromTick(id, useTaskStore.getState().error || '原任务未启动，请处理后继续');
}
function consumeProductionConfirmationRecheck(id: string, task: Task | undefined): boolean {
  const recheck = pendingProductionConfirmationRecheck;
  pendingProductionConfirmationRecheck = undefined;
  return recheck?.projectId === id && recheck.taskId === task?.id
    && recheck.runId === task?.runtime?.runId && recheck.submittedAt === task?.runtime?.submittedAt;
}
function matchesProductionObservation(attempt: ProductionObservationAttempt, id: string, task: Task | undefined): boolean {
  return attempt.projectId === id && attempt.taskId === task?.id
    && attempt.runId === task?.runtime?.runId && attempt.submittedAt === task?.runtime?.submittedAt;
}
function clearProductionObservation(attempt: ProductionObservationAttempt): void {
  if (productionObservationAttempts.get(attempt.taskId) !== attempt) return;
  productionObservationAttempts.delete(attempt.taskId);
  observingProductionTasks.delete(attempt.taskId);
}
function ownsProductionObservation(attempt: ProductionObservationAttempt): boolean {
  const pending = usePetStoryStore.getState().project?.production?.steps.find((step): boolean => step.status !== 'complete');
  return productionStillRunning(attempt.projectId) && pending?.taskId === attempt.taskId && pending.runId === attempt.runId;
}
/** 页面执行器完成清理后才交还本轮观察；旧回执不能取消新一轮显式检查。 */
async function settleProductionObservation(attempt: ProductionObservationAttempt): Promise<void> {
  if (productionObservationAttempts.get(attempt.taskId) !== attempt) return;
  try {
    await refreshTasks();
    const task = useTaskStore.getState().tasks.find((item): boolean => item.id === attempt.taskId);
    if (productionObservationAttempts.get(attempt.taskId) !== attempt || !ownsProductionObservation(attempt)
      || !matchesProductionObservation(attempt, attempt.projectId, task) || attempt.authorization !== productionObservationAuthorization) return;
    if (task?.status === 'done') return;
    const reason = task?.errorInfo?.message || task?.runtime?.message || '原视频结果尚未读到，请检查原会话后再次只读检查；未重新发送。';
    if (task && ['executing', 'generating', 'manual_submission_observing'].includes(task.status)) {
      const saved = await useTaskStore.getState().updateTaskRuntime(task.id, { status: 'paused',
        errorInfo: { code: 'submission_uncertain', message: reason, recoverable: true, detectedAt: new Date().toISOString() },
        runtime: { stage: 'paused', message: reason, lastHeartbeatAt: new Date().toISOString() } });
      if (!saved) throw new Error(useTaskStore.getState().error || '原视频检查暂停状态尚未保存，请稍后重试');
    }
    const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === attempt.taskId);
    if (attempt.authorization === productionObservationAuthorization && matchesProductionObservation(attempt, attempt.projectId, latest)
      && ownsProductionObservation(attempt)) await pauseProductionFromTick(attempt.projectId, reason);
  } catch (error: unknown) {
    if (ownsProductionObservation(attempt) && attempt.authorization === productionObservationAuthorization) {
      activeProductionId = null;
      usePetStoryStore.setState({ error: error instanceof Error ? error.message : '原视频检查状态尚未保存，请稍后重试' });
    }
  } finally { clearProductionObservation(attempt); }
}
async function observeProductionTask(id: string, taskId: string): Promise<void> {
  await refreshTasks();
  if (!productionStillRunning(id)) return;
  const originalTask = useTaskStore.getState().tasks.find((task): boolean => task.id === taskId);
  const observing = productionObservationAttempts.get(taskId);
  if (observing && matchesProductionObservation(observing, id, originalTask)) return;
  if (observing) clearProductionObservation(observing);
  // 账号验证恢复器或原执行器已接续此运行；刷新期间状态变化也只能等待，不能另开观察或因缺 URL 假暂停。
  if (originalTask && ['executing', 'generating', 'manual_submission_observing'].includes(originalTask.status)) return;
  // 平台参数确认是明确的待办，不自动反复开启观察；用户显式检查只授权原运行回读一次。
  const confirmationRecheck = consumeProductionConfirmationRecheck(id, originalTask);
  if (originalTask?.status === 'waiting_generation_confirmation' && !confirmationRecheck) {
    await pauseProductionFromTick(id, originalTask?.errorInfo?.message || '豆包正在等待视频生成参数确认，请打开原会话确认后检查原视频结果。');
    return;
  }
  const locator = resolveTaskConversationTarget(originalTask);
  const useCurrentPage = confirmationRecheck && !locator.ok && locator.reason === 'CONVERSATION_URL_MISSING';
  if (!locator.ok && !useCurrentPage) {
    // 缺少原会话定位不能开启观察状态，否则页面执行器退出后会留下永久活跃的假观察。
    await pauseProductionFromTick(id, '原任务未保存可核对的具体会话。请打开原账号，在历史对话中找到原请求后检查原结果；受理仍不明时可确认重发一次。');
    return;
  }
  if (observingProductionTasks.has(taskId)) {
    await pauseProductionFromTick(id, originalTask?.errorInfo?.message || '原会话本轮只读观察未完成，请处理后显式继续；未重新生成');
    return;
  }
  if (!originalTask?.runtime?.runId || !originalTask.runtime.submittedAt) return;
  const attempt: ProductionObservationAttempt = { projectId: id, taskId, runId: originalTask.runtime.runId,
    submittedAt: originalTask.runtime.submittedAt, authorization: productionObservationAuthorization };
  productionObservationAttempts.set(taskId, attempt);
  observingProductionTasks.add(taskId);
  const resumed = await useTaskStore.getState().updateTaskRuntime(taskId, { status: 'manual_submission_observing', runtime: { stage: 'manual_submission_observing', message: '继续只读观察原制作会话，不重复发送' } });
  if (!resumed || !productionStillRunning(id)) { await settleProductionObservation(attempt); return; }
  window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId, ...(useCurrentPage ? { useCurrentPage: true } : {}),
    onSettled: (): Promise<void> => settleProductionObservation(attempt) } }));
}
/** 打开清单不启用接力；只在本会话一次确认或显式继续后推进。 */
export async function tickPetStoryProduction(): Promise<void> {
  const id = activeProductionId;
  const state = usePetStoryStore.getState();
  if (pendingProductionConfirmationRecheck && (pendingProductionConfirmationRecheck.projectId !== id || state.project?.id !== id)) pendingProductionConfirmationRecheck = undefined;
  if (!canTickProduction(state, id)) return;
  productionTickRunning = true;
  try {
    const result = await window.electronAPI.petstory.advanceProduction(id);
    const applied = acceptProductionSnapshot(id, result.project);
    if (activeProductionId !== id || usePetStoryStore.getState().project?.id !== id) return;
    if (result.project && !applied) {
      if (!productionStillRunning(id)) activeProductionId = null;
      return;
    }
    if (!result.success || result.project?.production?.state !== 'running') {
      activeProductionId = null;
      if (!result.success) usePetStoryStore.setState({ error: result.error || '制作已暂停' });
      return;
    }
    if (result.taskId && result.action === 'start') await startProductionTask(id, result.taskId);
    else if (result.taskId && result.action === 'observe') await observeProductionTask(id, result.taskId);
  } catch (error: unknown) {
    if (activeProductionId === id) activeProductionId = null;
    if (usePetStoryStore.getState().project?.id === id) usePetStoryStore.setState({ error: error instanceof Error ? error.message : '制作接力中断，请打开原项目核对后继续' });
  } finally { productionTickRunning = false; }
}
async function refreshTasks(): Promise<void> {
  const tasks = await window.electronAPI.tasks.list();
  useTaskStore.setState({ tasks });
}
async function waitForProjectVideoControllers(tasks: Task[]): Promise<void> {
  const deadline = Date.now() + 6000;
  while (tasks.some((task): boolean => automationEngine.hasController(task.id))) {
    if (Date.now() >= deadline) throw new Error('原视频控制器尚未停止，已保留原项目，请稍后再切换');
    await new Promise<void>((resolve): void => { setTimeout(resolve, 100); });
  }
}
export const usePetStoryStore = create<PetStoryState>((set, get) => {
  const accept = (result: PetStoryResult): void => {
    if (result.project && (get().project?.id !== result.project.id || result.project.revision >= (get().project?.revision || 0))) {
      const batch = result.project.promptBatch;
      set({ project: result.project, projectName: result.displayName ?? (get().project?.id === result.project.id ? get().projectName : ''),
        ...(isPetStoryPromptPreparationMessage(get().error) ? { error: '' } : {}),
        ...(!promptBatchQueue && batch ? { promptBatch: { total: batch.total, completed: batch.completed, status: batch.status === 'complete' ? 'complete' : 'paused' as const } } : {}) });
    }
    if (!result.success) set({ error: result.error || '操作未完成' });
  };
  let currentWork: Promise<void> | null = null;
  const run = async (work: () => Promise<void>, background: boolean = false): Promise<void> => {
    if (get().busy || background && currentWork) return;
    const previous = currentWork;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve): void => { release = resolve; });
    currentWork = pending;
    // 进度检查不反复禁用整页，也不清除用户刚遇到的错误。
    // 用户操作先锁住前台，再等待本次后台推进完成，用最新项目版本执行。
    if (!background) set({ busy: true });
    try {
      if (previous) await previous;
      if (!background) set({ error: '' });
      await work();
    }
    catch (error: unknown) {
      let message = error instanceof Error ? error.message : '操作失败';
      try { await pauseBatch(); }
      catch (saveError: unknown) { message += `；批次暂停记录未保存：${saveError instanceof Error ? saveError.message : '保存失败'}`; }
      set({ error: message });
    }
    finally {
      if (promptBatchQueue?.stopRequested) {
        try { await pauseBatch(); }
        catch (error: unknown) { set({ error: `批次已停止后续发送，但暂停记录未保存：${error instanceof Error ? error.message : '保存失败'}` }); }
      }
      if (currentWork === pending) currentWork = null;
      release?.();
      if (!background) set({ busy: false });
    }
  };
  /** 换项目先收回原视频宿主；提交证据与平台后台生成保留，回原项目后只读接续。 */
  const pauseVideosBeforeProjectChange = async (): Promise<void> => {
    const project = get().project;
    if (!project) return;
    await refreshTasks();
    const videos = useTaskStore.getState().tasks.filter((task): boolean => ['executing', 'generating', 'manual_submission_observing'].includes(task.status)
      && isBackgroundProductionVideoTask(project, task.id, task));
    if (!videos.length) return;
    for (const task of videos) window.dispatchEvent(new CustomEvent('cancel-task-automation', { detail: { taskId: task.id, targetStatus: 'paused' } }));
    if (project.production && project.production.state !== 'complete') {
      const paused = await window.electronAPI.petstory.pauseProduction(project.id);
      accept(paused);
      if (!paused.success) throw new Error(paused.error || '原视频制作尚未确认暂停，未切换项目');
    }
    // 已受理控制器可能先保存 manual_submission_observing；等其退出后再停止自动观察，避免旧effect重新唤醒。
    await waitForProjectVideoControllers(videos);
    for (const task of videos) {
      const current = useTaskStore.getState().tasks.find((item): boolean => item.id === task.id);
      if (!current || current.runtime?.runId !== task.runtime?.runId) throw new Error('原视频运行已变化，已保留原项目，未切换');
      if (!['executing', 'generating', 'manual_submission_observing'].includes(current.status)) continue;
      await useTaskStore.getState().pauseAutomation(task.id, project.accountId, '已暂停原视频观察以切换项目；平台后台生成与原提交记录保留，返回原项目后检查原结果',
        { status: 'paused', generationConfirmation: current.runtime?.generationConfirmation });
    }
    await refreshTasks();
    const stopped = videos.every((task): boolean => {
      const current = useTaskStore.getState().tasks.find((item): boolean => item.id === task.id);
      return !!current && current.runtime?.runId === task.runtime?.runId && !['executing', 'generating', 'manual_submission_observing'].includes(current.status)
        && !automationEngine.hasController(task.id);
    });
    if (!stopped) throw new Error('原视频暂停状态尚未回读确认，已保留原项目，未切换');
  };
  const startBound = async (jobId: string): Promise<void> => {
    const authorization = promptWorkAuthorization;
    const project = get().project;
    const job = project?.jobs.find((j): boolean => j.id === jobId);
    if (project?.chatAdjustment?.status === 'active' && !isAdjustmentRepair(project, job)) throw new Error('请先采用豆包回复或结束当前调整');
    if (!project || !job || job.endedWaitingAt || job.status !== 'bound') throw new Error('请选择原步骤');
    if (!project.mobileStory || job.sourceStoryId !== project.mobileStory.id) throw new Error('旧版链接直读任务已停用，请保存手机豆包故事后生成制作方案');
    if (!useProjectStore.getState().projects.some((p): boolean => p.id === project.studioProjectId && !p.archived)) throw new Error('原Studio项目不存在');
    restoredPlanReadbacks.delete(job.id);
    liveJobs.add(job.id);
    const started = await useTaskStore.getState().startAutomation(job.taskId, async (task: Task): Promise<void> => {
      if (authorization !== promptWorkAuthorization) throw new Error('本轮文字准备已停止，原任务保留且未发送');
      if (!job || !task.runtime?.runId) throw new Error('本步骤运行未初始化');
      await bindPetStoryTaskRun(task);
      if (authorization !== promptWorkAuthorization) throw new Error('本轮文字准备已停止，原任务保留且未发送');
      if (get().project?.id !== project.id || get().project?.jobs.find((item): boolean => item.id === job.id)?.runId !== task.runtime.runId) throw new Error('本步骤运行绑定未保存或项目已变化');
    });
    if (!started) throw new Error(useTaskStore.getState().error || '原任务保持已绑定；请处理原因后启动原任务，不要重复分析');
  };
  const continueBoundChat = async (jobId: string): Promise<void> => {
    const authorization = promptWorkAuthorization;
    const p = get().project; const job = p?.jobs.find((item): boolean => item.id === jobId);
    if (!p || !job) throw new Error('请先打开原项目并选择原文字任务');
    await refreshTasks();
    if (authorization !== promptWorkAuthorization) return;
    const taskState = useTaskStore.getState(); const task = taskState.tasks.find((item): boolean => item.id === job.taskId);
    if (!canStartBoundChat(p, job, task, taskState.tasks, taskState.activeTaskId === job.taskId || !!taskState.accountBusy[p.accountId])) throw new Error('原任务未明确停止在未发送状态，或运行归属／账号占用不符；请只读核对，不重新发送');
    if (task?.status !== 'queued') {
      const result = await window.electronAPI.petstory.retryUnsubmitted(p.id, job.id); accept(result);
      if (!result.success) return;
      await refreshTasks();
    }
    if (authorization === promptWorkAuthorization) await startBound(job.id);
  };
  const startPrepared = async (result: PetStoryResult, canContinue: () => boolean = (): boolean => true): Promise<string | undefined> => {
    accept(result);
    if (!result.success || !result.taskId || !result.project) return;
    const job = result.project.jobs.find((item): boolean => item.taskId === result.taskId);
    if (!job) throw new Error('已创建原任务但项目绑定未回读，不继续发送');
    const batch = promptBatchQueue;
    if (batch?.projectId === result.project.id && (!job.promptBatchId || job.promptBatchId === batch.id)) {
      // 启动前保存原任务关联；启动失败和重开都只能恢复这一任务。
      batch.jobId = job.id;
      await persistBatch(batch.stopRequested ? 'paused' : 'running', job.id);
    }
    await refreshTasks();
    if (!canContinue()) return job.id;
    if (batch && (batch.stopRequested || promptBatchQueue !== batch)) return job.id;
    const task = useTaskStore.getState().tasks.find((item): boolean => item.id === job.taskId);
    // 幂等准备可能接回已提交修订。仅连接原运行，绝不重新启动或替换 run。
    if (job.status !== 'bound' || task?.runtime?.submittedAt || task?.runtime?.chatResponse || task && ['executing', 'generating', 'manual_submission_observing'].includes(task.status)) {
      if (!job.endedWaitingAt && job.status === 'bound') liveJobs.add(job.id);
      return job.id;
    }
    await startBound(job.id); return job.id;
  };
  const prepare = async (prompt: string, kind: PetStoryChatJob['kind'], parentJobId?: string, shotId?: string, promptKind?: PetStoryPromptKind, materialId?: string): Promise<string | undefined> => {
    const authorization = promptWorkAuthorization;
    const project = get().project;
    if (!project) throw new Error('请先打开或创建项目');
    if (project.chatAdjustment?.status === 'active') throw new Error('请先采用豆包回复或结束当前调整');
    if (!useProjectStore.getState().projects.some((p): boolean => p.id === project.studioProjectId && !p.archived)) throw new Error('原 Studio 项目缺失或已归档');
    const account = useAccountStore.getState().accounts.find((a): boolean => a.id === project.accountId);
    if (!account || account.platform === 'dola') throw new Error('项目原豆包账号缺失，不能自动更换账号');
    const result = await window.electronAPI.petstory.prepareChat(project.id, prompt, kind, parentJobId, shotId, promptKind, materialId);
    if (get().project?.id !== project.id) return;
    return startPrepared(result, (): boolean => authorization === promptWorkAuthorization && get().project?.id === project.id);
  };
  const prepareRuntime = async (kind: PetStoryChatJob['kind'], target?: PetStoryRuntimeTarget): Promise<string | undefined> => {
    const project = get().project;
    const authorization = promptWorkAuthorization;
    if (!project) throw new Error('请先打开或创建项目');
    if (project.chatAdjustment?.status === 'active' && !(kind === 'repair' && target?.parentJobId && project.chatAdjustment.repairJobId)) throw new Error('请先采用豆包回复或结束当前调整');
    if (!useProjectStore.getState().projects.some((p): boolean => p.id === project.studioProjectId && !p.archived)) throw new Error('原 Studio 项目缺失或已归档');
    const account = useAccountStore.getState().accounts.find((a): boolean => a.id === project.accountId);
    if (!account || account.platform === 'dola') throw new Error('项目原豆包账号缺失，不能自动更换账号');
    // 规则、当前事实和实际附件由主进程同一快照组装；页面不自行撰写运行时正文。
    const capability = target?.capability || get().capability || project.promptCapability;
    const requestTarget = capability ? { ...target, capability } : target;
    const result = await window.electronAPI.petstory.prepareRuntime(project.id, project.revision, kind, requestTarget);
    if (get().project?.id !== project.id) return;
    return startPrepared(result, (): boolean => authorization === promptWorkAuthorization && get().project?.id === project.id);
  };
  const persistBatch = async (status: PetStoryPromptBatch['status'], jobId?: string): Promise<void> => {
    const batch = promptBatchQueue; const p = get().project;
    if (!batch || !p || batch.projectId !== p.id) return;
    const progress = get().promptBatch;
    const result = await window.electronAPI.petstory.savePromptBatch(p.id, p.revision, { id: batch.id, scope: batch.scope, candidateJobIds: batch.candidateJobIds, failedTargets: batch.failedTargets, targets: batch.targets, total: progress.total, completed: progress.completed, status, jobId });
    accept(result);
    if (!result.success) throw new Error(result.error || '批次未保存，不继续发送');
  };
  const pauseBatch = async (): Promise<void> => {
    const batch = promptBatchQueue; if (!batch) return;
    batch.stopRequested = true;
    if (batch.jobId) liveJobs.delete(batch.jobId);
    try { await persistBatch('paused', batch.jobId); }
    finally {
      if (promptBatchQueue === batch) promptBatchQueue = null;
      set({ promptBatch: { ...get().promptBatch, status: 'paused' } });
    }
  };
  const recoverBatchJob = async (job: PetStoryChatJob): Promise<void> => {
    const authorization = promptWorkAuthorization;
    await refreshTasks();
    if (authorization !== promptWorkAuthorization) return;
    const task = useTaskStore.getState().tasks.find((item): boolean => item.id === job.taskId);
    const project = get().project;
    if (!task || !project || task.mode !== 'chat' || task.projectId !== project.studioProjectId || task.assignedAccountId !== project.accountId || job.sourceStoryId !== project.mobileStory?.id) throw new Error('原文字任务、项目或账号归属不符，未重新创建');
    liveJobs.add(job.id);
    if (job.status === 'captured' || task.runtime?.chatResponse?.text) { await collectResult(job.id, true); return; }
    if (!task.runtime?.submittedAt) { await continueBoundChat(job.id); return; }
    if (task.runtime.runId !== job.runId || task.runtime.input.mode !== 'chat' || task.runtime.input.prompt !== task.prompt || JSON.stringify(task.runtime.input.attachments || []) !== JSON.stringify(task.attachments || [])) throw new Error('原文字运行或提交输入不一致，未重新发送');
    if (['fail', 'paused', 'cancelled', 'waiting_verification'].includes(task.status)) {
      const locator = resolveTaskConversationTarget(task);
      if (!locator.ok && locator.reason !== 'CONVERSATION_URL_MISSING') throw new Error('原会话归属不明，请查看豆包对话');
      const observed = await useTaskStore.getState().updateTaskRuntime(task.id, { status: 'manual_submission_observing', runtime: { stage: 'manual_submission_observing', message: '只读取得原提示词结果，不重复发送' } });
      if (!observed) throw new Error('原任务恢复未保存，请稍后继续');
      window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: task.id, useCurrentPage: !locator.ok } }));
    }
  };
  const failedDependency = (project: PetStoryProject, batch: NonNullable<typeof promptBatchQueue>, target: PromptBatchTarget): boolean => {
    if (!target.shotId) return false;
    const shot = project.plan?.shots.find((item): boolean => item.id === target.shotId);
    const previousId = shot?.previousShotId || project.plan?.shots.filter((item): boolean => item.order < (shot?.order || 0)).sort((a, b): number => b.order - a.order)[0]?.id;
    return batch.failedTargets.some(({ target: failed }): boolean => {
      if (failed.shotId === target.shotId) return failed.kind === 'firstFrame' && target.kind !== 'firstFrame' || failed.kind === 'lastFrame' && target.kind === 'video';
      return shot?.transition === 'continue' && previousId === failed.shotId && ['lastFrame', 'video'].includes(failed.kind || '');
    });
  };
  const nextPrompt = async (): Promise<void> => {
    const batch = promptBatchQueue; const p = get().project;
    if (!batch || !p || batch.projectId !== p.id) return;
    while (batch.targets[0] && failedDependency(p, batch, batch.targets[0])) {
      const target = batch.targets.shift(); if (!target) break;
      batch.failedTargets.push({ target, message: '等待前序提示词完成后继续' });
    }
    const target = batch.targets[0];
    if (!target) {
      // 独立项继续生成；失败项保留在原批次，同一入口可显式恢复。
      if (batch.failedTargets.length) batch.targets = batch.failedTargets.map((item): PromptBatchTarget => {
        if (item.target.materialId) return { materialId: item.target.materialId };
        if (item.target.shotId && item.target.kind) return { shotId: item.target.shotId, kind: item.target.kind };
        throw new Error('保存的失败目标不完整，保留原批次');
      });
      const status = batch.failedTargets.length ? 'paused' : 'complete';
      await persistBatch(status); promptBatchQueue = null; set({ promptBatch: { ...get().promptBatch, status } }); return;
    }
    batch.jobId = undefined;
    await persistBatch('running');
    if (batch.stopRequested || promptBatchQueue !== batch) { await pauseBatch(); return; }
    const latest = get().project || p;
    const original = [...latest.jobs].reverse().find((job): boolean => pendingChatJob(job) && promptJobKey(job) === promptTargetKey(target));
    if (original) {
      const job = latestRepair(latest, original); batch.jobId = job.id;
      await persistBatch('running', job.id); await recoverBatchJob(job); return;
    }
    const shared = { promptBatchId: batch.id, textContextJobIds: [...batch.candidateJobIds], ...(batch.scope === 'shots' ? { background: 'canvas' as const } : {}) };
    const jobId = target.materialId ? await prepareRuntime('materialPrompt', { materialId: target.materialId, ...shared }) : await prepareRuntime('optimize', { shotId: target.shotId, promptKind: target.kind, ...shared });
    if (!jobId) throw new Error(get().error || '本项文字任务未启动，批次已暂停');
    batch.jobId = jobId;
    if (batch.stopRequested) await pauseBatch();
  };
  const beginBatch = async (targets: PromptBatchTarget[], scope?: 'shots'): Promise<void> => {
    const p = get().project;
    if (!p) throw new Error('请先打开项目');
    if (promptBatchQueue) return;
    const targetKeys = new Set(targets.map(promptTargetKey));
    const prior = scope === 'shots' ? p.promptBatch : undefined;
    const candidates = (prior?.candidateJobIds || []).filter((id): boolean => { const job = p.jobs.find((item): boolean => item.id === id); return !!job && job.status === 'applied' && job.resultStatus === 'candidate' && !targetKeys.has(promptJobKey(job) || ''); });
    promptBatchQueue = { projectId: p.id, id: candidates.length && prior?.id ? prior.id : crypto.randomUUID(), scope, targets: [...targets], candidateJobIds: candidates, failedTargets: [] };
    set({ promptBatch: { total: targets.length + candidates.length, completed: candidates.length, status: 'running' } });
    await nextPrompt();
  };
  const stageTargets = async (scope?: 'shots'): Promise<void> => {
    const p = get().project; if (!p) return;
    const result = await (scope ? window.electronAPI.petstory.promptStageTargets(p.id, p.revision, scope) : window.electronAPI.petstory.promptStageTargets(p.id, p.revision)); accept(result);
    if (!result.success || !result.promptTargets) throw new Error(result.error || '当前文字阶段未完成资格核对，不创建请求');
    const excluded = unresolvedEndedPromptKeys(result.project || p);
    const targets = petStoryPromptActionTargets({ ...(result.project || p), promptBatch: undefined }, result.promptTargets);
    await beginBatch(targets, scope);
    const notices: string[] = [];
    if (excluded.size) notices.push('已结束等待的原目标保留为待处理，本次只补齐其他目标；这些目标需要新的明确单项或批量重新生成操作，不会自动重发。');
    if (result.pendingCandidateJobIds?.length) notices.push('已有本次模型与模式的新候选待采用；手改 final 保留，下游仍引用当前已采用正文。');
    if (notices.length) set({ error: notices.join('\n') });
  };
  const consumeReplacedInvalid = async (failed: PetStoryChatJob, saved: PetStoryPromptBatch): Promise<boolean> => {
    const p = get().project; const batch = promptBatchQueue; const first = batch?.targets[0];
    if (!p || !batch || !first || promptJobKey(failed) !== promptTargetKey(first)) throw new Error('保存的批次目标与原失败任务不符，保留记录并停止');
    const result = await (saved.scope ? window.electronAPI.petstory.promptStageTargets(p.id, p.revision, saved.scope) : window.electronAPI.petstory.promptStageTargets(p.id, p.revision)); accept(result);
    if (!result.success || !result.promptTargets) throw new Error(result.error || '当前正文资格未核对，不继续原失败批次');
    const current = result.project || p;
    if (result.promptTargets.some((target): boolean => promptTargetKey(target) === promptTargetKey(first))) return false;
    if (hasPendingTargetCandidate(current, first, result.pendingCandidateJobIds || [])) return false;
    if (!hasAdoptedReplacement(current, failed, first)) return false;
    // 只消费已由后来明确操作采用且当前合格的目标；原 invalid 与原回复继续保留。
    batch.targets.shift(); set({ promptBatch: { ...get().promptBatch, completed: saved.completed + 1 } });
    return true;
  };
  const restartExpiredPromptBatch = async (): Promise<void> => {
    const scope = promptBatchQueue?.scope;
    await pauseBatch();
    const notice = '旧设计的文字批次已过期，已按当前设计重新核对缺失目标；原任务与回复记录保留，不发送已删除目标。';
    try { await stageTargets(scope); }
    catch (error: unknown) { throw new Error(`${notice}\n${error instanceof Error ? error.message : '当前缺失目标未核对，保持暂停'}`); }
    set({ error: [notice, get().error].filter(Boolean).join('\n') });
  };
  const resumeSavedRepair = async (job: PetStoryChatJob): Promise<void> => {
    await refreshTasks();
    const task = useTaskStore.getState().tasks.find((item): boolean => item.id === job.taskId);
    await persistBatch('running', job.id);
    liveJobs.add(job.id);
    if (task?.runtime?.chatResponse) { await collectResult(job.id, true); return; }
    if (task?.runtime?.submittedAt) {
      if (['fail', 'paused', 'cancelled', 'waiting_verification'].includes(task.status)) window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: task.id } }));
      return;
    }
    await continueBoundChat(job.id);
  };
  const resumeAppliedPrompt = async (job: PetStoryChatJob, saved: PetStoryPromptBatch): Promise<void> => {
    const p = get().project; if (!p || !promptBatchQueue) return;
    const first = promptBatchQueue.targets[0];
    if (!first || promptJobKey(job) !== promptTargetKey(first)) throw new Error('保存的批次目标与原任务不符，保留记录并停止');
    if (job.resultStatus === 'stale') { await pauseBatch(); await stageTargets(saved.scope); return; }
    const qualification = await window.electronAPI.petstory.promptStageTargets(p.id, p.revision, saved.scope); accept(qualification);
    if (!qualification.success || !qualification.promptTargets) throw new Error('原结果的当前资格尚未核对');
    if (qualification.promptTargets.some((target): boolean => promptTargetKey(target) === promptTargetKey(first))) { await pauseBatch(); await stageTargets(saved.scope); return; }
    if (job.resultStatus === 'candidate' && !promptBatchQueue.candidateJobIds.includes(job.id)) promptBatchQueue.candidateJobIds.push(job.id);
    promptBatchQueue.targets.shift(); set({ promptBatch: { ...get().promptBatch, completed: saved.completed + 1 } });
    await nextPrompt();
  };
  const qualifySavedPromptBatch = async (saved: PetStoryPromptBatch): Promise<{ project: PetStoryProject; batch: PetStoryPromptBatch } | undefined> => {
    const p = get().project; if (!p) return;
    if (saved.scope !== 'shots') return { project: p, batch: saved };
    // 已保存的合法节点反馈先结算原失败目标，恢复不能重复生成该正文。
    const qualified = await window.electronAPI.petstory.promptStageTargets(p.id, p.revision, 'shots'); accept(qualified);
    if (!qualified.success) throw new Error(qualified.error || '原批次结果尚未核对');
    const project = qualified.project || p;
    return { project, batch: { ...(project.promptBatch || saved), scope: 'shots' } };
  };
  const resumeInvalidPrompt = async (job: PetStoryChatJob, saved: PetStoryPromptBatch): Promise<boolean> => {
    const p = get().project; if (!p || !promptBatchQueue) return true;
    const newest = [...p.jobs].reverse().find((item): boolean => isPromptWritingJob(item) && promptJobKey(item) === promptJobKey(job));
    const existing = latestRepair(p, newest || job);
    if (existing.id !== job.id && pendingChatJob(existing)) { await recoverBatchJob(existing); return true; }
    if (await consumeReplacedInvalid(job, saved)) return false;
    if (isPromptWritingJob(existing) && hasRepairablePromptReply(existing)) {
      // 恢复校验链，从最新原回复继续修订，不另建一条相同的 optimize 请求。
      promptBatchQueue.jobId = existing.id; liveJobs.add(existing.id);
      await persistBatch('running', existing.id); await collectResult(existing.id, true); return true;
    }
    await pauseBatch(); set({ error: '原候选没有明确可修复问题，请核对原任务与当前依据；继续不会自动重发。' }); return true;
  };
  const resumePromptBatch = async (saved: PetStoryPromptBatch): Promise<void> => {
    const qualified = await qualifySavedPromptBatch(saved); if (!qualified) return;
    const p = qualified.project; saved = qualified.batch;
    if (!saved.targets.length) return;
    const { job, targets: savedTargets } = savedPromptBatchRun(p, saved);
    promptBatchQueue = { projectId: p.id, id: saved.id || crypto.randomUUID(), scope: saved.scope, targets: savedTargets, candidateJobIds: [...(saved.candidateJobIds || [])], failedTargets: [], jobId: job?.id || saved.jobId };
    set({ promptBatch: { total: saved.total, completed: saved.completed, status: 'running' } });
    if (pendingChatJob(job)) {
      if (!promptTargetExists(p, { shotId: job.shotId || '', kind: job.promptKind || 'video', ...(job.materialId ? { materialId: job.materialId } : {}) } as PromptBatchTarget)) { await pauseBatch(); set({ error: '原任务目标已删除，请只读重新收取或明确结束等待；未发送或创建新任务' }); return; }
      if (job.kind === 'repair') {
        await resumeSavedRepair(job); return;
      }
      if (saved.scope === 'shots' || isVerificationBatchContinuation(p.id, job)) { await persistBatch('running', job.id); await recoverBatchJob(job); return; }
      await pauseBatch(); set({ error: '原批次已有未决任务，请只读重新收取或明确结束等待；不会重发。' }); return;
    }
    if (saved.targets.some((target): boolean => !promptTargetExists(p, target))) {
      // 新方案可改实体ID；删除目标不是已完成，只有显式继续时重新核对当前阶段。
      if (!job || !job.endedWaitingAt && !['applied', 'invalid'].includes(job.status)) {
        await pauseBatch(); set({ error: '旧设计批次包含已删除目标，但原任务归属或状态尚未明确；请核对原任务，继续不会重发。' }); return;
      }
      await restartExpiredPromptBatch(); return;
    }
    if (job?.endedWaitingAt) { await pauseBatch(); await stageTargets(saved.scope); return; }
    if (job?.status === 'invalid' && await resumeInvalidPrompt(job, saved)) return;
    const excluded = unresolvedEndedPromptKeys(get().project || p);
    if (promptBatchQueue.targets.some((target): boolean => excluded.has(promptTargetKey(target)))) { await pauseBatch(); await stageTargets(saved.scope); return; }
    if (job?.status === 'applied') { await resumeAppliedPrompt(job, saved); return; }
    await nextPrompt();
  };
  /** 已有失败子回复先只读重校验，回读期间的停止不能被递归修订重新授权。 */
  const recheckExistingRepair = async (projectId: string, jobId: string, authorized: boolean, imageOperation: boolean): Promise<string | undefined> => {
    const authorization = promptWorkAuthorization;
    const checked = await window.electronAPI.petstory.collectChat(projectId, jobId);
    if (get().project?.id !== projectId) return;
    const stillAuthorized = authorized && authorization === promptWorkAuthorization;
    accept(checked.needsRepair && stillAuthorized ? { ...checked, success: true } : checked);
    if (!stillAuthorized) return;
    liveJobs.add(jobId);
    try { return await repairResult(checked, jobId, authorized, imageOperation); }
    finally { liveJobs.delete(jobId); }
  };
  const repairResult = async (result: PetStoryResult, sourceId: string, authorized: boolean, imageOperation = false): Promise<string | undefined> => {
    const authorization = promptWorkAuthorization;
    const p = result.project || get().project; const job = p?.jobs.find((item): boolean => item.id === sourceId);
    if (!p || !job || !canAutomaticallyRepair(job, authorized, imageOperation, get().autoRepair)) return;
    if (promptBatchQueue?.stopRequested) return;
    if (!imageOperation && isPromptWritingJob(job) && !promptBatchQueue && !liveJobs.has(job.id)) return;
    if (p.promptBatch?.status === 'paused' && p.promptBatch.jobId === sourceId && !promptBatchQueue && !liveJobs.has(job.id)) return;
    if (isChatAdjusting(p) && !isAdjustmentRepair(p, job)) return;
    const child = latestRepair(p, job);
    if (child.id !== job.id || result.repairJobId) {
      const existing = latestRepair(p, p.jobs.find((item): boolean => item.id === result.repairJobId) || child);
      if (existing.endedWaitingAt) return;
      if (existing.status === 'invalid') return recheckExistingRepair(p.id, existing.id, authorized, imageOperation);
      return startPrepared({ success: true, project: p, taskId: existing.taskId }, (): boolean => authorization === promptWorkAuthorization && get().project?.id === p.id);
    }
    if (!result.needsRepair) return;
    set({ promptRepairJobIds: [...get().promptRepairJobIds, job.id] });
    try {
      if (job.requestId) return await prepareRuntime('repair', { parentJobId: job.id, repairMode: 'automatic' });
      return await prepare(repairPrompt(p, job), 'repair', job.id);
    } finally { set({ promptRepairJobIds: get().promptRepairJobIds.filter((id): boolean => id !== job.id) }); }
  };
  const collectResult = async (jobId: string, allowRepair: boolean): Promise<void> => {
    const p = get().project; if (!p) return;
    const authorization = promptWorkAuthorization;
    if (allowRepair) restoredPlanReadbacks.delete(jobId);
    const result = await window.electronAPI.petstory.collectChat(p.id, jobId);
    if (get().project?.id !== p.id) return;
    // 修订是当前创作的一步：原错误先保存在详情，安排失败时才成为当前阻断。
    // 收取期间的停止动作立即撤回发送权，迟到回复仍保存，但不能重新授权下一轮。
    const repairAuthorized = allowRepair && authorization === promptWorkAuthorization;
    accept(result.needsRepair && repairAuthorized ? { ...result, success: true } : result);
    const authorizedImage = authorizedImageChat(result.project || p, jobId);
    const repairJobId = await repairResult(result, jobId, repairAuthorized, authorizedImage);
    if (!pendingChatJob(get().project?.jobs.find((item): boolean => item.id === jobId))) {
      liveJobs.delete(jobId);
      restoredPlanReadbacks.delete(jobId);
    }
    if (repairJobId) set({ error: '' });
    // 接回已有修订时保留最新子回复／准备失败的原因，旧父回复不能覆盖当前暂停。
    else if (!result.success && (!result.needsRepair || !repairAuthorized || !get().error)) set({ error: collectedFailureMessage(result, authorizedImage) });
    await advanceCollectedPromptBatch(result, jobId, repairJobId);
  };
  const advanceCollectedPromptBatch = async (result: PetStoryResult, jobId: string, repairJobId?: string): Promise<void> => {
    if (promptBatchQueue?.stopRequested) { await pauseBatch(); return; }
    if (!promptBatchQueue || promptBatchQueue.jobId !== jobId && promptBatchQueue.jobId !== repairJobId) return;
    if (repairJobId) {
      promptBatchQueue.jobId = repairJobId;
      const repaired = get().project?.jobs.find((item): boolean => item.id === repairJobId);
      // 新校验器可能直接接纳原回复，返回相同 jobId；以重校验后的快照结算，不能沿用旧失败结果。
      if (repaired?.resultStatus === 'stale') await failBatchTarget(repaired, repaired.staleReason || '本项结果依据已变化');
      else if (repaired?.status === 'applied') await finishBatchTarget(repaired);
      else if (repaired?.status === 'invalid') await failBatchTarget(repaired, repaired.error || '本项修订未完成');
      return;
    }
    const job = result.project?.jobs.find((item): boolean => item.id === jobId);
    if (!result.success || !job || job.resultStatus === 'stale') { await failBatchTarget(job, result.error || job?.staleReason || '本项结果尚未取得'); return; }
    await finishBatchTarget(job);
  };
  const finishBatchTarget = async (job: PetStoryChatJob): Promise<void> => {
    const batch = promptBatchQueue; const target = batch?.targets[0];
    const source = job.kind === 'repair' && !promptJobKey(job) ? get().project?.jobs.find((item): boolean => item.id === job.parentJobId) : job;
    if (!batch || !target || !source || promptJobKey(source) !== promptTargetKey(target)) throw new Error('批次结果与当前目标不符，未推进进度');
    if (job.status !== 'applied' || job.resultStatus === 'stale') throw new Error('本项尚未保存有效候选');
    if (job.resultStatus === 'candidate' && !batch.candidateJobIds.includes(job.id)) batch.candidateJobIds.push(job.id);
    batch.targets.shift(); batch.jobId = undefined;
    set({ promptBatch: { ...get().promptBatch, completed: get().promptBatch.completed + 1 } });
    await nextPrompt();
  };
  const failBatchTarget = async (job: PetStoryChatJob | undefined, message: string): Promise<void> => {
    const batch = promptBatchQueue; const target = batch?.targets[0]; if (!batch || !target) return;
    // 受理不明只能观察原运行；其余独立项保留已保存候选后继续。
    if (!job || pendingChatJob(job) || batch.scope !== 'shots') { await pauseBatch(); return; }
    batch.failedTargets.push({ target, jobId: job.id, message }); batch.targets.shift(); batch.jobId = undefined;
    await nextPrompt();
  };
  const adoptCandidate = async (jobId: string, kind: 'plan' | 'assets' | 'prompt'): Promise<void> => {
    const p = get().project; if (!p) return;
    const api = window.electronAPI.petstory;
    const result = await (kind === 'plan' ? api.adoptPlanCandidate(p.id, p.revision, jobId) : kind === 'assets' ? api.adoptAssetsCandidate(p.id, p.revision, jobId) : api.adoptPromptCandidate(p.id, p.revision, jobId));
    accept(result.needsRepair ? { ...result, success: true } : result);
    if (result.needsRepair) {
      liveJobs.add(result.repairSourceJobId || jobId);
      await repairResult(result, result.repairSourceJobId || jobId, true); return;
    }
    if (!result.success) return;
  };
  const validateImageObservationTask = (project: PetStoryProject, operationId: string, task: Task): void => {
    const operation = project.imageOperations?.find((item): boolean => item.id === operationId);
    const step = project.production?.steps.find((item): boolean => item.taskId === task.id);
    if (!task.runtime?.submittedAt) throw new Error('原图片缺少提交记录，未读取当前页面');
    if (operation?.taskId !== task.id || task.mode !== 'image' || task.runtime.input.mode !== 'image' || task.runtime.input.prompt !== task.prompt
      || JSON.stringify(task.runtime.input.attachments || []) !== JSON.stringify(task.attachments || [])
      || task.projectId !== project.studioProjectId || task.assignedAccountId !== project.accountId
      || project.production?.imageOperationId !== operationId || !step?.runId || step.runId !== task.runtime.runId
      || task.petstory?.projectId !== project.id || task.petstory.stepId !== step.id) throw new Error('图片原任务与项目、账号或运行不一致，未读取当前页面');
  };
  const imageObservationTask = (context: ImageOperationContext, taskId: string): Task | undefined => {
    const project = get().project;
    if (activeImageOperation !== context || project?.id !== context.projectId) return;
    const task = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
    if (!task?.runtime?.submittedAt) return;
    validateImageObservationTask(project, context.operationId, task);
    return task;
  };
  const ownsImageObservation = (attempt: ImageObservationAttempt, task: Task | undefined): boolean =>
    activeImageOperation === attempt.context && get().project?.id === attempt.context.projectId
      && imageObservationAttempts.get(attempt.taskId) === attempt && task?.assignedAccountId === attempt.accountId
      && task.runtime?.runId === attempt.runId && task.runtime.submittedAt === attempt.submittedAt;
  /** 只在真实观察器清理后交还制作；失败结束本轮授权，不由定时器反复开启原检查。 */
  const settleImageObservation = async (attempt: ImageObservationAttempt): Promise<void> => {
    let collect = false;
    try {
      await refreshTasks();
      const task = useTaskStore.getState().tasks.find((item): boolean => item.id === attempt.taskId);
      if (!ownsImageObservation(attempt, task) || !imageObservationTask(attempt.context, attempt.taskId)) return;
      if (task?.status === 'done') { collect = true; return; }
      const reason = task?.errorInfo?.message || '本次图片原结果尚未核对完成，请处理原会话后继续；未重新发送。';
      if (task && ['executing', 'generating', 'manual_submission_observing'].includes(task.status)) {
        const saved = await useTaskStore.getState().updateTaskRuntime(task.id, { status: 'paused',
          errorInfo: { code: 'submission_uncertain', message: reason, recoverable: true, detectedAt: new Date().toISOString() },
          runtime: { stage: 'paused', message: reason, lastHeartbeatAt: new Date().toISOString() } });
        if (!saved) throw new Error(useTaskStore.getState().error || '原图片检查暂停状态尚未保存，请稍后继续');
      }
      const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === attempt.taskId);
      if (!ownsImageObservation(attempt, latest)) return;
      activeImageOperation = null; set({ activeImageOperationId: null, error: reason });
      const paused = await window.electronAPI.petstory.pauseProduction(attempt.context.projectId);
      if (get().project?.id === attempt.context.projectId) accept(paused);
    } catch (error: unknown) {
      const task = useTaskStore.getState().tasks.find((item): boolean => item.id === attempt.taskId);
      if (ownsImageObservation(attempt, task)) {
        activeImageOperation = null; set({ activeImageOperationId: null, error: error instanceof Error ? error.message : '原图片检查状态尚未保存，请稍后继续' });
      }
    } finally {
      if (imageObservationAttempts.get(attempt.taskId) === attempt) imageObservationAttempts.delete(attempt.taskId);
      if (collect && activeImageOperation === attempt.context) await tickPetStoryImageOperation();
    }
  };
  /** 自动接力与显式继续共用同一原运行的只读观察，缺 URL 时也只核对当前原账号页面。 */
  const observeImageTask = async (context: ImageOperationContext, taskId: string, explicit: boolean = false): Promise<void> => {
    await refreshTasks();
    const task = imageObservationTask(context, taskId);
    if (!task?.runtime?.submittedAt || !task.assignedAccountId || task.status === 'done' || ['executing', 'generating'].includes(task.status)) return;
    const existing = imageObservationAttempts.get(taskId);
    if (existing?.context === context && existing.runId === task.runtime.runId && existing.submittedAt === task.runtime.submittedAt) return;
    const locator = resolveTaskConversationTarget(task);
    if (!locator.ok && locator.reason !== 'CONVERSATION_URL_MISSING') throw new Error('图片原会话存在多个候选或绑定冲突，请先核对原任务');
    const key = JSON.stringify([context.projectId, context.operationId, taskId, task.runtime.runId, task.runtime.submittedAt]);
    if (attemptedImageRuns.has(key)) return;
    const attempt: ImageObservationAttempt = { context, taskId, accountId: task.assignedAccountId, runId: task.runtime.runId, submittedAt: task.runtime.submittedAt };
    imageObservationAttempts.set(taskId, attempt); attemptedImageRuns.add(key);
    let observed = false;
    try {
      observed = await useTaskStore.getState().updateTaskRuntime(taskId, { status: 'manual_submission_observing', runtime: { stage: 'manual_submission_observing', message: '只读核对本次图片原结果，不重复发送' } });
    } catch (error: unknown) {
      if (imageObservationAttempts.get(taskId) === attempt) imageObservationAttempts.delete(taskId);
      throw error;
    }
    if (!observed) { await settleImageObservation(attempt); return; }
    if (!ownsImageObservation(attempt, useTaskStore.getState().tasks.find((item): boolean => item.id === taskId))) {
      if (imageObservationAttempts.get(taskId) === attempt) imageObservationAttempts.delete(taskId);
      return;
    }
    window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId, accountId: attempt.accountId, runId: attempt.runId,
      submittedAt: attempt.submittedAt, useCurrentPage: !locator.ok, automatic: !explicit, onSettled: (): Promise<void> => settleImageObservation(attempt) } }));
  };
  const driveImageChat = async (project: PetStoryProject, jobId: string, context: NonNullable<typeof activeImageOperation>): Promise<void> => {
      const original = project.jobs.find((job): boolean => job.id === jobId);
      const job = original ? latestRepair(project, original) : undefined;
      if (!job || job.endedWaitingAt || !pendingChatJob(job)) return;
      if (dispatchedImageTasks.has(job.taskId)) { liveJobs.add(job.id); return; }
      dispatchedImageTasks.add(job.taskId);
      await refreshTasks();
      if (activeImageOperation !== context || get().project?.id !== context.projectId) return;
      const task = useTaskStore.getState().tasks.find((item): boolean => item.id === job.taskId);
      if (job.status === 'captured' || task?.runtime?.chatResponse?.text) { await collectResult(job.id, true); return; }
      if (task?.runtime?.submittedAt && ['paused', 'fail', 'cancelled', 'waiting_verification'].includes(task.status)) {
        if (task.runtime.runId !== job.runId) throw new Error('图片准备的原运行不一致，未重新发送');
        const locator = resolveTaskConversationTarget(task);
        if (!locator.ok && locator.reason !== 'CONVERSATION_URL_MISSING') throw new Error('原会话存在多个候选或绑定冲突，请先查看豆包对话');
        liveJobs.add(job.id);
        const resumed = await useTaskStore.getState().updateTaskRuntime(task.id, { status: 'manual_submission_observing', runtime: { stage: 'manual_submission_observing', message: '继续读取本次图片准备结果，不重复发送' } });
        if (resumed) window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: task.id, useCurrentPage: !locator.ok } }));
        return;
      }
      await startPrepared({ success: true, project, taskId: job.taskId }); return;
  };
  const driveImageOperation = async (result: PetStoryImageOperationResult, context: NonNullable<typeof activeImageOperation>): Promise<void> => {
    if (activeImageOperation !== context || get().project?.id !== context.projectId) return;
    accept(result.needsRepair ? { ...result, success: true } : result);
    const project = get().project;
    const operation = project?.imageOperations?.find((item): boolean => item.id === context.operationId);
    if (!project || !imageOperationContinues(result, operation)) {
      activeImageOperation = null; set({ activeImageOperationId: null }); return;
    }
    if (result.needsRepair && result.chatJobId) {
      await repairResult(result, result.repairSourceJobId || result.chatJobId, true, true); return;
    }
    if (result.chatJobId) { await driveImageChat(project, result.chatJobId, context); return; }
    if (!result.taskId) return;
    if (result.action === 'start') {
      if (dispatchedImageTasks.has(result.taskId)) return;
      dispatchedImageTasks.add(result.taskId);
      await refreshTasks();
      if (activeImageOperation !== context || get().project?.id !== context.projectId) return;
      const started = await useTaskStore.getState().startAutomation(result.taskId, async (task: Task): Promise<void> => {
        if (activeImageOperation !== context || get().project?.id !== context.projectId || !task.runtime) throw new Error('本次图片任务已停止');
        const bound = await window.electronAPI.petstory.bindProductionRun(context.projectId, task.id, task.runtime.runId);
        if (get().project?.id === context.projectId) accept(bound);
        if (!bound.success) throw new Error(bound.error || '图片任务运行绑定未保存');
      });
      if (!started) {
        const message = useTaskStore.getState().error || '图片任务未启动，请处理后继续';
        const paused = await window.electronAPI.petstory.pauseProduction(context.projectId);
        if (get().project?.id === context.projectId) {
          accept(paused);
          // 保存失败状态并保留同一任务，重试不会再次创建图片请求。
          accept(await window.electronAPI.petstory.advanceImageOperation(context.projectId, context.operationId));
          set({ error: message });
        }
        activeImageOperation = null; set({ activeImageOperationId: null });
      }
    } else if (result.action === 'observe') await observeImageTask(context, result.taskId);
  };
  /** 显式继续可核对仍停在当前页的原图片请求；绝不把缺少会话地址当作重发授权。 */
  const recoverSubmittedImage = async (context: NonNullable<typeof activeImageOperation>): Promise<void> => {
    await refreshTasks();
    const project = get().project;
    if (!project || project.id !== context.projectId || activeImageOperation !== context) return;
    const operation = project.imageOperations?.find((item): boolean => item.id === context.operationId);
    const task = useTaskStore.getState().tasks.find((item): boolean => item.id === operation?.taskId);
    if (!task?.runtime?.submittedAt || !['paused', 'fail', 'cancelled', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'].includes(task.status)) return;
    await observeImageTask(context, task.id, true);
  };
  /** 缺少持久化定位的旧图片先检查已有账号页；根页不进入虚假的观察或等待状态。 */
  const inspectImageRecoveryPage = async (task: Task): Promise<void> => {
    const runtime = task.runtime;
    if (task.mode !== 'image' || !runtime?.submittedAt || task.status === 'done') return;
    const { runId, submittedAt } = runtime;
    const locator = resolveTaskConversationTarget(task);
    if (locator.ok || locator.reason !== 'CONVERSATION_URL_MISSING') return;
    if (!task.assignedAccountId) throw new Error('原执行账号不存在，请先处理原账号');
    await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
      let settled = false;
      const timeout = setTimeout((): void => {
        if (!settled) { settled = true; reject(new Error(IMAGE_CONVERSATION_RECOVERY_MESSAGE)); }
      }, 10_000);
      const onResult = (result: { ready: boolean; message?: string }): void => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        if (result.ready) resolve(); else reject(new Error(result.message || IMAGE_CONVERSATION_RECOVERY_MESSAGE));
      };
      window.dispatchEvent(new CustomEvent('inspect-image-task-recovery-page', { detail: { taskId: task.id, accountId: task.assignedAccountId,
        runId, submittedAt, onResult } }));
    });
    const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === task.id);
    if (latest?.assignedAccountId !== task.assignedAccountId || latest.runtime?.runId !== runId || latest.runtime.submittedAt !== submittedAt) throw new Error('原图片运行已变化，请重新检查当前任务');
  };
  const beginImageOperation = async (target: PetStoryImageTarget, baseAssetId?: string, feedback?: string): Promise<void> => {
    const project = get().project;
    if (!project) throw new Error('请先打开原项目');
    if (baseAssetId && !feedback?.trim()) return;
    const result = await window.electronAPI.petstory.beginImageOperation(project.id, project.revision,
      { target, requestId: crypto.randomUUID(), ...(baseAssetId ? { baseAssetId, feedback } : {}) }, get().capability || undefined);
    accept(result);
    if (!result.success || !result.operationId) return;
    activeProductionId = null;
    dispatchedImageTasks.clear(); attemptedImageRuns.clear();
    const context = { projectId: project.id, operationId: result.operationId };
    activeImageOperation = context;
    set({ productionCounts: null, activeImageOperationId: context.operationId });
    try { await driveImageOperation(result, context); }
    catch (error: unknown) { if (activeImageOperation === context) { activeImageOperation = null; set({ activeImageOperationId: null }); } throw error; }
  };
  /** 视频点击沿原文字链准备合格候选；尚未确认正文时不创建媒体任务。 */
  const prepareShotPrompt = async (shotId: string, kind: PetStoryPromptKind): Promise<boolean> => {
    const project = get().project; const shot = project?.plan?.shots.find((item): boolean => item.id === shotId);
    if (!project) throw new Error('请先打开原项目');
    if (project.production && project.production.state !== 'complete') return true;
    if (!shot) throw new Error('镜头不存在，请重新选择当前镜头');
    if (!needsPetStoryReferenceAdaptation(project, shotId, kind)) return true;
    if (pendingPetStoryDrafts(project.id).length) throw new Error('请先保存或放弃尚未保存的修改，再开始本镜制作');
    const original = [...project.jobs].reverse().find((job): boolean => job.shotId === shotId && job.promptKind === kind && isPromptWritingJob(job));
    const job = original ? latestRepair(project, original) : undefined;
    if (job?.endedWaitingAt || unresolvedEndedPromptKeys(project).has(promptTargetKey({ shotId, kind }))) throw new Error('本镜原文字任务已结束等待，请先核对原结果；未重复发送');
    if (pendingChatJob(job)) { await recoverBatchJob(job); return false; }
    if (job?.status === 'invalid' && job.resultStatus !== 'stale') {
      if (!hasRepairablePromptReply(job)) throw new Error(job.error || '本镜提示词的原回复尚需核对归属或当前依据，未重复发送');
      liveJobs.add(job.id); await collectResult(job.id, true); return false;
    }
    if (job?.status === 'applied' && job.resultStatus === 'candidate' && job.parsedResult?.optimized?.trim()) return false;
    await prepareRuntime('optimize', { shotId, promptKind: kind, background: 'canvas' });
    return false;
  };
  return {
    activeImageOperationId: null,
    generateMaterialImage: async (materialId: string): Promise<void> => {
      await run((): Promise<void> => beginImageOperation({ materialId }));
      await tickPetStoryImageOperation();
    },
    modifyImage: async (target: PetStoryImageTarget, baseAssetId: string, feedback: string): Promise<void> => {
      if (!feedback.trim()) return;
      await run((): Promise<void> => beginImageOperation(target, baseAssetId, feedback));
      await tickPetStoryImageOperation();
    },
    recoverImageOperation: async (operationId: string): Promise<void> => {
      await run(async (): Promise<void> => {
        const project = get().project;
        if (!project) throw new Error('请先打开原项目');
        if ([...imageObservationAttempts.values()].some((attempt): boolean => attempt.context.projectId === project.id && attempt.context.operationId === operationId)) return;
        await refreshTasks();
        const operation = project.imageOperations?.find((item): boolean => item.id === operationId);
        const originalTask = useTaskStore.getState().tasks.find((item): boolean => item.id === operation?.taskId);
        if (originalTask?.mode === 'image' && originalTask.runtime?.submittedAt) {
          try { validateImageObservationTask(project, operationId, originalTask); await inspectImageRecoveryPage(originalTask); }
          catch (error: unknown) {
            if (activeImageOperation?.projectId === project.id && activeImageOperation.operationId === operationId) {
              activeImageOperation = null; set({ activeImageOperationId: null });
            }
            throw error;
          }
        }
        if (get().project?.id !== project.id) throw new Error('当前项目已变化，请重新打开原图片任务');
        const result = await window.electronAPI.petstory.resumeImageOperation(project.id, operationId, get().capability || undefined);
        accept(result);
        if (!result.success) return;
        activeProductionId = null; dispatchedImageTasks.clear(); attemptedImageRuns.clear();
        const context = { projectId: project.id, operationId };
        activeImageOperation = context;
        set({ activeImageOperationId: operationId });
        try { await recoverSubmittedImage(context); await driveImageOperation(result, context); }
        catch (error: unknown) { if (activeImageOperation === context) { activeImageOperation = null; set({ activeImageOperationId: null }); } throw error; }
      });
      await tickPetStoryImageOperation();
    },
    advanceImageOperation: async (): Promise<void> => run(async (): Promise<void> => {
      const context = activeImageOperation;
      if (!context || get().project?.id !== context.projectId) return;
      try { await driveImageOperation(await window.electronAPI.petstory.advanceImageOperation(context.projectId, context.operationId), context); }
      catch (error: unknown) { if (activeImageOperation === context) { activeImageOperation = null; set({ activeImageOperationId: null }); } throw error; }
    }, true),
    openImageConversation: async (target: PetStoryImageTarget, assetId?: string): Promise<void> => {
      const project = get().project;
      if (!project) return;
      const task = imageConversationTask(project, target, useTaskStore.getState().tasks, assetId);
      if (!task) return;
      const locator = resolveTaskConversationTarget(task);
      if (!locator.ok && locator.reason !== 'CONVERSATION_URL_MISSING') return;
      if (!canSelectAccount(project.accountId, findInteractiveAccountId(useTaskStore.getState().accountAutomationState))) { set({ error: '其他账号正在提交，请稍后查看这次豆包对话' }); return; }
      const occupied = useTaskStore.getState().tasks.some((item): boolean => item.id !== task.id && item.assignedAccountId === project.accountId
        && ['executing', 'generating', 'manual_submission_observing', 'waiting_verification', 'waiting_generation_confirmation'].includes(item.status));
      if (occupied || project.chatAdjustment?.status === 'active') { set({ error: '这个账号正在处理另一段对话，请稍后查看图片来源' }); return; }
      if (locator.ok) {
        window.dispatchEvent(new CustomEvent('reveal-workspace-browser'));
        window.dispatchEvent(new CustomEvent('open-task-conversation', { detail: { task } }));
      } else window.dispatchEvent(new CustomEvent('open-image-task-account', { detail: { taskId: task.id, accountId: project.accountId,
        runId: task.runtime?.runId, submittedAt: task.runtime?.submittedAt } }));
    },
    chatReadbackError: '',
    applyChatReply: async (replyKey: string): Promise<PetStoryAdjustmentPreview | null> => {
      let preview: PetStoryAdjustmentPreview | null = null;
      await run(async (): Promise<void> => {
        const p = get().project; const a = p?.chatAdjustment;
        if (!p || a?.status !== 'active') throw new Error('请重新打开当前对象的豆包调整');
        if (pendingPetStoryDrafts(p.id).length) throw new Error('请先保存或放弃尚未保存的修改，再应用豆包回复');
        await verifyAdjustmentReply(a.id, replyKey);
        const latest = get().project;
        if (!latest || latest.chatAdjustment?.id !== a.id) throw new Error('当前调整已变化，请重新选择回复');
        const checked = await window.electronAPI.petstory.previewAdjustmentReply(latest.id, latest.revision, a.id, replyKey);
        if (checked.success) { preview = checked.preview || null; return; }
        if (!checked.needsRepair) { accept(checked); return; }
        const result = await window.electronAPI.petstory.adoptAdjustmentReply(latest.id, latest.revision, a.id, replyKey);
        await startPrepared(result);
      });
      return preview;
    },
    previewChatReply: async (replyKey: string): Promise<PetStoryAdjustmentPreview | null> => {
      const p = get().project; const a = p?.chatAdjustment;
      if (!p || a?.status !== 'active') return null;
      const result = await window.electronAPI.petstory.previewAdjustmentReply(p.id, p.revision, a.id, replyKey);
      if (!result.success) { set({ error: result.error || '回复尚不能采用，请在豆包中整理' }); return null; }
      set({ error: '' }); return result.preview || null;
    },
    openChatAdjustment: async (target: PetStoryRuntimeTarget): Promise<void> => run(async (): Promise<void> => {
      await pauseBatch();
      activeProductionId = null;
      let p = get().project; if (!p) throw new Error('请先打开项目');
      if (p.production?.state === 'running') { const paused = await window.electronAPI.petstory.pauseProduction(p.id); accept(paused); if (!paused.success) throw new Error(paused.error || '当前制作未暂停'); const refreshed = get().project; if (!refreshed) throw new Error('项目已关闭'); p = refreshed; }
      if (useTaskStore.getState().accountBusy[p.accountId] || !canSelectAccount(p.accountId, findInteractiveAccountId(useTaskStore.getState().accountAutomationState))) throw new Error('这个账号仍在执行任务，请等待原任务结束再调整');
      const result = await window.electronAPI.petstory.beginAdjustment(p.id, p.revision, target); accept(result);
      if (!result.success) return;
      set({ chatReadbackError: '' });
      useAccountStore.getState().selectAccount(p.accountId);
      window.dispatchEvent(new CustomEvent('reveal-workspace-browser'));
      window.dispatchEvent(new CustomEvent('petstory-open-adjustment'));
      // 调整已由主进程建立，先打开原会话；任务列表刷新不能阻塞用户继续交流。
      const adjustmentId = result.adjustment?.id || result.project?.chatAdjustment?.id;
      void refreshTasks().catch((): void => {
        const current = get(); const adjustment = current.project?.chatAdjustment;
        if (current.project?.id === p.id && adjustmentId && adjustment?.id === adjustmentId && adjustment.status === 'active' && !current.chatReadbackError) {
          set({ chatReadbackError: '任务状态暂未刷新，可继续在关联会话中调整' });
        }
      });
    }),
    captureChatReplies: async (adjustmentId: string, conversationUrl: string, replies: PetStoryConversationReply[]): Promise<void> => {
      const p = get().project; if (!p || get().busy || p.chatAdjustment?.id !== adjustmentId || p.chatAdjustment.status !== 'active') return;
      try {
        const result = await window.electronAPI.petstory.captureAdjustmentReplies(p.id, adjustmentId, conversationUrl, replies);
        if (get().project?.id !== p.id || get().project?.chatAdjustment?.id !== adjustmentId) return;
        accept(result); set({ chatReadbackError: result.success ? '' : result.error || '回复未读取完整' });
      } catch (error: unknown) { set({ chatReadbackError: error instanceof Error ? error.message : '回复未读取完整' }); }
    },
    adoptChatReply: async (replyKey: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; const a = p?.chatAdjustment;
      if (!p || a?.status !== 'active') throw new Error('请重新打开当前对象的豆包调整');
      if (pendingPetStoryDrafts(p.id).length) throw new Error('请先保存或放弃尚未保存的修改，再采用豆包回复');
      // 应用前只读回查具体回复；不会发送、导航或改变输入框。
      await verifyAdjustmentReply(a.id, replyKey);
      const latest = get().project;
      if (!latest || latest.chatAdjustment?.id !== a.id) throw new Error('当前调整已变化，未采用回复');
      accept(await window.electronAPI.petstory.adoptAdjustmentReply(latest.id, latest.revision, a.id, replyKey)); await refreshTasks();
    }),
    importChatImages: async (replyKey: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; const a = p?.chatAdjustment;
      if (!p || a?.status !== 'active') throw new Error('请重新打开当前图片对象的豆包调整');
      if (pendingPetStoryDrafts(p.id).length) throw new Error('请先保存或放弃尚未保存的修改，再收取图片');
      await verifyAdjustmentReply(a.id, replyKey);
      const latest = get().project;
      if (!latest || latest.chatAdjustment?.id !== a.id) throw new Error('当前调整已变化，未收取图片');
      const result = await window.electronAPI.petstory.importAdjustmentImages(latest.id, latest.revision, a.id, replyKey);
      accept(result);
      // 服务在部分下载失败时也返回已保存候选；重试只补原图下载。
      set({ productionCounts: null });
    }),
    endChatAdjustment: async (): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; const a = p?.chatAdjustment;
      const repair = p?.jobs.find((job): boolean => job.id === a?.repairJobId);
      if (pendingChatJob(repair)) window.dispatchEvent(new CustomEvent('cancel-task-automation', { detail: { taskId: repair.taskId, targetStatus: 'paused' } }));
      if (p && a?.status === 'active') { const result = await window.electronAPI.petstory.endAdjustment(p.id, p.revision, a.id); accept(result); if (result.success) { if (a.repairJobId) liveJobs.delete(a.repairJobId); set({ chatReadbackError: '' }); await refreshTasks(); } }
    }),
    uploadShotImage: async (shotId: string, kind: 'firstFrame' | 'lastFrame'): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; if (p) accept(await window.electronAPI.petstory.addShotImage(p.id, p.revision, shotId, kind)); set({ productionCounts: null });
    }),
    adoptShotImage: async (shotId: string, kind: 'firstFrame' | 'lastFrame', assetId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; if (p) accept(await window.electronAPI.petstory.adoptImage(p.id, p.revision, { shotId, kind }, assetId)); set({ productionCounts: null });
    }),
    savePromptModel: async (model?: PetStoryProject['promptModel']): Promise<void> => run(async (): Promise<void> => {
      await pauseBatch();
      const p = get().project; if (p) accept(await window.electronAPI.petstory.savePromptModel(p.id, p.revision, model));
    }),
    endChatWaiting: async (jobId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; if (!p) return;
      const job = p.jobs.find((item): boolean => item.id === jobId);
      if (pendingChatJob(job)) window.dispatchEvent(new CustomEvent('cancel-task-automation', { detail: { taskId: job.taskId, targetStatus: 'paused' } }));
      const result = await window.electronAPI.petstory.endChatWaiting(p.id, p.revision, jobId); accept(result);
      if (result.success) { liveJobs.delete(jobId); restoredPlanReadbacks.delete(jobId); promptBatchQueue = null; set({ promptBatch: { ...get().promptBatch, status: 'paused' } }); }
    }),
    recoverChat: async (jobId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; const job = p?.jobs.find((item): boolean => item.id === jobId);
      if (!p || !job) throw new Error('请选择原任务');
      await refreshTasks();
      const task = useTaskStore.getState().tasks.find((item): boolean => item.id === job.taskId);
      if (!task?.runtime?.submittedAt || task.runtime.runId !== job.runId) throw new Error('没有已提交原运行，不能以恢复入口重新发送');
      restoredPlanReadbacks.delete(job.id);
      liveJobs.add(job.id);
      if (task.runtime.chatResponse?.text) { await collectResult(job.id, true); return; }
      if (!['fail', 'paused', 'cancelled', 'waiting_verification'].includes(task.status)) throw new Error('原任务仍在运行或占用中，请等待原观察完成');
      const locator = resolveTaskConversationTarget(task);
      if (!locator.ok && locator.reason !== 'CONVERSATION_URL_MISSING') throw new Error('原会话定位存在多个候选或绑定冲突；请先核对原任务记录，未读取当前页面');
      window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: task.id, useCurrentPage: !locator.ok } }));
    }),
    resumeCanvasPrompt: async (jobId: string): Promise<void> => run(async (): Promise<void> => {
      const project = get().project; if (!project) return;
      const marked = await window.electronAPI.petstory.markCanvasChat(project.id, project.revision, jobId); accept(marked);
      if (!marked.success || !marked.project) return;
      const source = marked.project.jobs.find((item): boolean => item.id === jobId); if (!source) return;
      let job = latestRepair(marked.project, source);
      if (job.id !== source.id && job.background !== 'canvas') {
        // 已有修订也必须完成画布归属保存与回读，失败时不继续启动原任务。
        const childMarked = await window.electronAPI.petstory.markCanvasChat(project.id, marked.project.revision, job.id); accept(childMarked);
        if (!childMarked.success || !childMarked.project) return;
        const child = childMarked.project.jobs.find((item): boolean => item.id === job.id); if (!child) return;
        job = child;
      }
      if (pendingChatJob(job)) { await recoverBatchJob(job); return; }
      if (job.status === 'invalid') { await prepareRuntime('repair', { parentJobId: job.id, repairMode: 'explicit' }); return; }
      if (job.status === 'applied') return;
      throw new Error('本次结果尚未取得，请查看豆包对话');
    }),
    inspectPromptStageTargets: async (scope?: 'shots'): Promise<PetStoryResult> => {
      const project = get().project; if (!project) return { success: false, error: '请先打开项目' };
      const result = await (scope ? window.electronAPI.petstory.promptStageTargets(project.id, project.revision, scope) : window.electronAPI.petstory.promptStageTargets(project.id, project.revision));
      const current = get().project;
      if (current?.id !== project.id || !result.success || !result.project || result.project.id !== current.id || result.project.revision < current.revision) return result;
      // 同版本资格查询不替换plan引用，避免页面effect因新对象重复查询。
      if (result.project.revision > current.revision) accept(result);
      else if (!promptBatchQueue && result.project.promptBatch) {
        const batch = result.project.promptBatch;
        set({ promptBatch: { total: batch.total, completed: batch.completed, status: batch.status === 'complete' ? 'complete' : 'paused' } });
      }
      return result;
    },
    generateCanvasPrompts: async (): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; if (!p?.plan) throw new Error('请先采用镜头设计');
      if (promptBatchQueue) return;
      const saved = p.promptBatch;
      if (saved && saved.status !== 'complete' && saved.targets.length && saved.targets.every((target): boolean => !!target.shotId)) { await resumePromptBatch({ ...saved, scope: 'shots' }); return; }
      await stageTargets('shots');
    }),
    adoptPromptBatchCandidates: async (): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; const batch = p?.promptBatch;
      if (!p || !batch || get().promptBatch.status === 'running') return;
      const failures: PetStoryChatJob[] = []; let confirmed = 0;
      const recordFailure = (job: PetStoryChatJob, detail: string): void => {
        failures.push(job);
        void window.electronAPI.logs?.append({ level: 'warn', scope: 'petstory_prompt_adoption', message: detail, taskId: job.taskId, accountId: p.accountId }).catch((): void => undefined);
      };
      const ordered = [...(batch.candidateJobIds || [])].sort((left, right): number => {
        const a = p.jobs.find((item): boolean => item.id === left); const b = p.jobs.find((item): boolean => item.id === right);
        const rank = (job: PetStoryChatJob | undefined): number => (p.plan?.shots.find((shot): boolean => shot.id === job?.shotId)?.order || 0) * 3 + ['firstFrame', 'lastFrame', 'video'].indexOf(job?.promptKind || 'firstFrame');
        return rank(a) - rank(b);
      });
      for (const id of ordered) {
        const current = get().project; const job = current?.jobs.find((item): boolean => item.id === id);
        if (!current || job?.status !== 'applied' || job.resultStatus !== 'candidate' || !job.parsedResult?.optimized) continue;
        try {
          const result = await window.electronAPI.petstory.adoptPromptCandidate(current.id, current.revision, id);
          if (result.project) accept({ ...result, success: true });
          if (!result.success) recordFailure(job, result.error || '本项候选需修改后再确认');
          else confirmed += 1;
        } catch (error: unknown) { recordFailure(job, error instanceof Error ? error.message : '本项候选未确认'); }
      }
      set({ error: failures.length ? `已确认${confirmed}项；${failedPromptLabels(get().project || p, failures).join('、')}需修改后确认。` : '' });
    }),
    revisePlan: async (feedback: { text: string; baseJobId?: string; requestId: string }): Promise<string | undefined> => {
      const projectId = get().project?.id;
      const createdJobId = (): string | undefined => get().project?.id === projectId
        ? get().project?.jobs.find((job): boolean => job.kind === 'analysis' && job.planFeedback?.requestId === feedback.requestId)?.id : undefined;
      if (get().busy) {
        set({ error: '当前操作仍在处理，请等待完成后继续调整方案' });
        return createdJobId();
      }
      let jobId: string | undefined;
      await run(async (): Promise<void> => {
        const project = get().project;
        if (!project) throw new Error('请先打开或创建项目');
        if (!feedback.text.trim()) throw new Error('请说明希望调整哪里');
        if (!feedback.requestId.trim()) throw new Error('本次方案修改的授权标识缺失，请重新打开修改');
        if (pendingPetStoryDrafts(project.id).length) throw new Error('请先保存或放弃尚未保存的修改，再调整方案');
        await pauseBatch();
        // 用户提交即授权本轮后台分析；候选采用和制作依据仍由用户另行确认。
        jobId = await prepareRuntime('analysis', { planFeedback: feedback, background: 'canvas' });
      });
      // 保存任务后，账号占用或调度失败仍返回同一原步骤，避免重试另造请求。
      return jobId || createdJobId();
    },
    revisePrompt: async (request: { shotId: string; promptKind: PetStoryPromptKind; feedback: string; baseJobId?: string }): Promise<void> => run(async (): Promise<void> => {
      const project = get().project;
      if (!project || !request.feedback.trim()) throw new Error('请说明希望调整哪里');
      if (promptBatchQueue) throw new Error('本次生成仍在继续，请完成后提交修改');
      const base = project.jobs.find((job): boolean => job.id === request.baseJobId);
      await prepareRuntime('optimize', { shotId: request.shotId, promptKind: request.promptKind, background: 'canvas',
        ...(base?.promptBatchId === project.promptBatch?.id ? { promptBatchId: base?.promptBatchId, textContextJobIds: base?.textContextJobIds } : {}),
        promptFeedback: { text: request.feedback, ...(request.baseJobId ? { baseJobId: request.baseJobId } : {}) } });
    }),
    continuePromptStage: async (): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; if (!p?.plan) throw new Error('请先采用镜头设计');
      if (promptBatchQueue) throw new Error('当前批次仍在运行');
      const saved = p.promptBatch;
      if (saved && saved.status !== 'complete' && saved.targets.length) { await resumePromptBatch(saved); return; }
      await stageTargets();
    }),
    saveOriginalStory: async (text: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; if (p) accept(await window.electronAPI.petstory.saveOriginalStory(p.id, p.revision, text));
    }),
    linkExistingMedia: async (shotId: string, kind: PetStoryPromptKind, taskId: string, artifactId?: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; if (p) accept(await window.electronAPI.petstory.linkExistingMedia(p.id, p.revision, shotId, kind, taskId, artifactId));
    }),
    promptBatch: { total: 0, completed: 0, status: 'idle' },
    regenerateAllPrompts: async (): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (!p?.plan) throw new Error('请先打开已有制作方案');
      if (promptBatchQueue) throw new Error('当前文字批次尚未结束，请先收取原任务');
      const targets = p.plan.shots.flatMap((s): { shotId: string; kind: PetStoryPromptKind }[] => (['firstFrame', 'lastFrame', 'video'] as const).filter((kind): boolean => !!s.prompts[kind]).map((kind) => ({ shotId: s.id, kind })));
      await beginBatch(targets);
    }),
    regenerateAllMaterialPrompts: async (): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (!p?.materials?.length) throw new Error('请先补齐并采用当前资产清单');
      if (promptBatchQueue) throw new Error('当前文字批次尚未结束，请先收取原任务');
      const targets = p.materials.map((material): PromptBatchTarget => ({ materialId: material.id }));
      await beginBatch(targets);
    }),
    extractAssets: async (): Promise<void> => run(async (): Promise<void> => { await prepareRuntime('assets'); }),
    adoptPlanCandidate: async (jobId: string): Promise<void> => run((): Promise<void> => adoptCandidate(jobId, 'plan')),
    adoptAssetsCandidate: async (jobId: string): Promise<void> => run((): Promise<void> => adoptCandidate(jobId, 'assets')),
    adoptPromptCandidate: async (jobId: string): Promise<void> => run((): Promise<void> => adoptCandidate(jobId, 'prompt')),
    reviewContent: async (target?: PetStoryRuntimeTarget): Promise<void> => run(async (): Promise<void> => { await prepareRuntime('review', target); }),
    reviseContent: async (reviewJobId: string, target: PetStoryRuntimeTarget): Promise<void> => run(async (): Promise<void> => { await prepareRuntime('revise', { ...target, parentJobId: reviewJobId }); }),
    stopPromptBatch: async (reason?: 'verification'): Promise<void> => {
      if (reason !== 'verification') { promptWorkAuthorization++; verificationPausedBatch = undefined; restoredPlanReadbacks.clear(); }
      if (promptBatchQueue) promptBatchQueue.stopRequested = true;
      // 单镜正文与方案反馈的独立修订也受停止约束，迟到回复不能重新取得下一轮发送权。
      if (reason !== 'verification') for (const item of get().project?.jobs || []) if (isPromptWritingJob(item) || item.planFeedback) liveJobs.delete(item.id);
      const job = get().project?.jobs.find((item): boolean => item.id === promptBatchQueue?.jobId);
      const task = useTaskStore.getState().tasks.find((item): boolean => item.id === job?.taskId);
      if (reason !== 'verification' && job?.kind === 'repair' && !task?.runtime?.submittedAt) window.dispatchEvent(new CustomEvent('cancel-task-automation', { detail: { taskId: job.taskId, targetStatus: 'paused' } }));
      set({ promptBatch: { ...get().promptBatch, status: 'paused' } });
      // 忙碌期间先阻止下一次发送，当前操作退出时保存暂停；不丢弃已创建的原任务。
      if (!get().busy) await run(pauseBatch);
    },
    regenerateMaterialPrompt: async (materialId: string, editIntent?: PetStoryMaterialEditIntent): Promise<void> => run(async (): Promise<void> => {
      await prepareRuntime('materialPrompt', { materialId, ...(editIntent ? { editIntent } : {}) });
    }),
    saveShotPrompt: async (shotId: string, kind: PetStoryPromptKind, final: string, basis?: PetStoryPromptEditBasis): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; if (p) accept(await window.electronAPI.petstory.saveShotPrompt(p.id, p.revision, shotId, kind, final, basis));
    }),
    generateShotMedia: async (shotId: string, kind: PetStoryPromptKind): Promise<void> => {
      if (kind === 'firstFrame' || kind === 'lastFrame') {
        // 与基础图及图片修改共用真实进度、后台宿主和原任务恢复，不另建执行器。
        await run(async (): Promise<void> => {
          if (!await prepareShotPrompt(shotId, kind)) return;
          await beginImageOperation({ shotId, kind });
        });
        await tickPetStoryImageOperation();
        return;
      }
      await run(async (): Promise<void> => {
        const p = get().project; const capability = get().capability;
        if (!p) throw new Error('请先打开原项目');
        if (!await prepareShotPrompt(shotId, kind)) return;
        const result = await window.electronAPI.petstory.generateShotMedia(p.id, p.revision, shotId, kind, capability || undefined, get().fallbacks);
        accept(result); if (result.success) { activeProductionId = p.id; observingProductionTasks.clear(); set({ productionCounts: null }); }
      });
      await tickPetStoryProduction();
    },
    resumeUnsubmittedVideo: async (shotId: string, taskId: string, runId: string): Promise<void> => {
      let authorized = false;
      await run(async (): Promise<void> => {
        const p = get().project;
        if (!p) throw new Error('请先打开原项目');
        if (pendingPetStoryDrafts(p.id).length) throw new Error('请先保存或放弃尚未保存的修改，再继续原视频任务。');
        await refreshTasks();
        const taskState = useTaskStore.getState(); const current = get().project;
        const task = current?.id === p.id ? petStoryUnsubmittedVideoTask(current, shotId, taskState.tasks, [...Object.values(taskState.executingTasks), ...(taskState.activeTaskId ? [taskState.activeTaskId] : [])]) : undefined;
        if (!task || task.id !== taskId || task.runtime?.runId !== runId) throw new Error('原任务状态已变化，请重新查看当前任务；未重新发送。');
        if (pendingPetStoryDrafts(p.id).length) throw new Error('请先保存或放弃尚未保存的修改，再继续原视频任务。');
        const result = await window.electronAPI.petstory.resumeProduction(p.id, get().capability || undefined);
        accept(result);
        await refreshTasks();
        if (result.success && get().project?.id === p.id) { activeProductionId = p.id; observingProductionTasks.clear(); authorized = true; }
      });
      if (authorized) await tickPetStoryProduction();
    },
    resumeVideoAsReferences: async (shotId: string, taskId: string, runId: string): Promise<void> => {
      let authorized = false;
      await run(async (): Promise<void> => {
        const p = get().project;
        if (!p || pendingPetStoryDrafts(p.id).length) throw new Error('请先保存或放弃草稿，再继续原视频任务');
        await refreshTasks();
        const current = get().project; const taskState = useTaskStore.getState();
        const task = current?.id === p.id ? petStoryReferenceVideoTask(current, shotId, taskState.tasks, [...Object.values(taskState.executingTasks), ...(taskState.activeTaskId ? [taskState.activeTaskId] : [])]) : undefined;
        const step = current?.production?.steps.find((item): boolean => item.status !== 'complete');
        if (!current || !task || !step || task.id !== taskId || task.runtime?.runId !== runId || pendingPetStoryDrafts(p.id).length) throw new Error('原任务或当前首尾选图已变化，未改模式或发送');
        const result = await window.electronAPI.petstory.resumeReferenceVideo(p.id, current.revision, { shotId, taskId, runId, inputHash: step.inputHash,
          firstFrameId: step.attachmentAssetIds[0], lastFrameId: step.attachmentAssetIds[1], authorizationId: crypto.randomUUID(), useExistingFrames: true });
        accept(result); await refreshTasks();
        if (result.success && get().project?.id === p.id) { activeProductionId = p.id; observingProductionTasks.clear(); authorized = true; }
      });
      if (authorized) await tickPetStoryProduction();
    },
    exportStatus: '',
    exportPrompts: async (): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; if (!p) return;
      set({ exportStatus: '' });
      const result = await window.electronAPI.petstory.exportPrompts(p.id, p.revision);
      if (!result.success) throw new Error(result.error || '导出失败');
      set({ exportStatus: `已导出 ${result.exportName || ''}：模型正文、引用计划与实际记录分别保存，目录已打开。` });
    }),
    project: null, projectName: '', capability: null, productionCounts: null, productionResolutions: {}, fallbacks: {},
    confirmStory: async (): Promise<void> => run(async (): Promise<void> => { const p = get().project; if (p) accept(await window.electronAPI.petstory.confirmStory(p.id, p.revision)); }),
    saveMaterialPrompt: async (materialId: string, final: string): Promise<void> => run(async (): Promise<void> => { const p = get().project; if (p) accept(await window.electronAPI.petstory.saveMaterialPrompt(p.id, p.revision, materialId, final)); }),
    addMaterialImage: async (materialId: string): Promise<void> => run(async (): Promise<void> => { const p = get().project; if (p) accept(await window.electronAPI.petstory.addMaterialImage(p.id, p.revision, materialId)); set({ productionCounts: null }); }),
    selectMaterialImage: async (materialId: string, assetId: string): Promise<void> => run(async (): Promise<void> => { const p = get().project; if (p) accept(await window.electronAPI.petstory.selectMaterialImage(p.id, p.revision, materialId, assetId)); set({ productionCounts: null }); }),
    approveMaterials: async (selections: { materialId: string; assetId: string }[]): Promise<void> => run(async (): Promise<void> => { const p = get().project; if (p) accept(await window.electronAPI.petstory.approveMaterials(p.id, p.revision, selections)); set({ productionCounts: null }); }),
    generateMaterials: async (materialIds: string[]): Promise<void> => {
      await run(async (): Promise<void> => {
        const p = get().project; const capability = get().capability;
        if (!p) throw new Error('请先打开原项目');
        const result = await window.electronAPI.petstory.generateMaterials(p.id, p.revision, materialIds, capability || undefined);
        accept(result); if (result.success) { activeProductionId = p.id; observingProductionTasks.clear(); set({ productionCounts: null }); }
      });
      await tickPetStoryProduction();
    },
    selectProductionImage: async (stepId: string, artifactId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (p) accept(await window.electronAPI.petstory.selectProductionImage(p.id, stepId, artifactId));
    }),
    setFallback: (shotId: string, mode?: 'first_frame' | 'reference'): void => {
      const fallbacks = { ...get().fallbacks };
      if (mode) fallbacks[shotId] = mode; else delete fallbacks[shotId];
      set({ fallbacks, productionCounts: null, productionResolutions: {} });
    },
    previewProduction: async (): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; const capability = get().capability;
      if (!p) throw new Error('请先打开原项目');
      const result = await window.electronAPI.petstory.previewProduction(p.id, capability || undefined, get().fallbacks);
      accept(result);
      set({ productionCounts: result.counts || null, productionResolutions: result.resolutions || {} });
    }),
    startProduction: async (): Promise<void> => {
      await run(async (): Promise<void> => {
        const p = get().project; const capability = get().capability;
        if (!p || !get().productionCounts) throw new Error('请先查看并确认制作数量');
        const result = await window.electronAPI.petstory.approveProduction(p.id, p.revision, capability || undefined, get().fallbacks);
        accept(result);
        if (result.success) { activeProductionId = p.id; observingProductionTasks.clear(); }
      });
      await tickPetStoryProduction();
    },
    pauseProduction: async (): Promise<void> => {
      const p = get().project;
      if (!p) return;
      productionObservationAuthorization++; activeProductionId = null;
      const taskId = p.production?.steps.find((s): boolean => s.status !== 'complete')?.taskId;
      if (taskId) window.dispatchEvent(new CustomEvent('cancel-task-automation', { detail: { taskId } }));
      await run(async (): Promise<void> => accept(await window.electronAPI.petstory.pauseProduction(p.id)));
    },
    resumeProduction: async (): Promise<void> => {
      await run(async (): Promise<void> => {
        const p = get().project;
        if (!p) throw new Error('请先打开原项目');
        // 显式检查一开始就收回旧接力；旧observer的迟到结束不能覆盖本次恢复。
        productionObservationAuthorization++; activeProductionId = null;
        const result = await window.electronAPI.petstory.resumeProduction(p.id, get().capability || undefined);
        accept(result);
        if (result.success) { activeProductionId = p.id; observingProductionTasks.clear(); pendingProductionConfirmationRecheck = undefined; }
        await refreshTasks();
        const taskId = result.project?.production?.steps.find((step): boolean => step.status !== 'complete')?.taskId;
        const task = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
        // 旧tick可能仍在途；授权保留到实际观察时消费，并绑定原项目、运行和提交意图。
        if (result.success && task && ['waiting_generation_confirmation', 'waiting_verification', 'paused', 'fail', 'cancelled'].includes(task.status) && task.runtime?.runId && task.runtime.submittedAt) pendingProductionConfirmationRecheck = { projectId: p.id, taskId: task.id, runId: task.runtime.runId, submittedAt: task.runtime.submittedAt };
      });
      await tickPetStoryProduction();
    },
    resubmitProduction: async (request: TaskResubmitUncertainParams): Promise<void> => {
      let authorized = false; let imageAuthorized = false;
      await run(async (): Promise<void> => {
        const p = get().project; const taskState = useTaskStore.getState();
        if (!p) throw new Error('请先打开原项目');
        const task = petStoryResubmissionTask(p, taskState.tasks, [...Object.values(taskState.executingTasks), ...(taskState.activeTaskId ? [taskState.activeTaskId] : [])]);
        if (!task || task.id !== request.taskId || task.runtime?.runId !== request.runId || task.runtime.submittedAt !== request.submittedAt || request.acceptDuplicateRisk !== true) throw new Error('原任务状态已变化，请重新检查制作结果后确认');
        const block = petStoryResubmissionAccountBlock(useAccountStore.getState().accounts.find((account): boolean => account.id === task.assignedAccountId));
        if (block) throw new Error(block);
        const result = await window.electronAPI.petstory.resubmitProduction(p.id, p.revision, request, get().capability || undefined);
        if (get().project?.id !== p.id) return;
        accept(result);
        if (result.success) {
          await refreshTasks();
          const operationId = result.project?.production?.imageOperationId;
          if (operationId) {
            // 重发只创建既有授权关联任务；沿图片接力收取候选，不能遗漏原操作的收尾状态。
            const resumed = await window.electronAPI.petstory.resumeImageOperation(p.id, operationId, get().capability || undefined);
            if (get().project?.id !== p.id) return;
            accept(resumed);
            if (!resumed.success) return;
            activeProductionId = null; dispatchedImageTasks.clear(); attemptedImageRuns.clear();
            activeImageOperation = { projectId: p.id, operationId };
            set({ activeImageOperationId: operationId }); imageAuthorized = true;
          } else { activeProductionId = p.id; observingProductionTasks.clear(); authorized = true; }
        }
      });
      if (imageAuthorized) await tickPetStoryImageOperation();
      else if (authorized) await tickPetStoryProduction();
    },
    busy: false, error: '', autoRepair: true, promptRepairJobIds: [],
    setAutoRepair: (value: boolean): void => set({ autoRepair: value }),
    createProject: async (selection?: { accountId: string; studioProjectId: string }): Promise<void> => run(async (): Promise<void> => {
      promptWorkAuthorization++;
      if (isChatAdjusting(get().project)) throw new Error('请先采用当前豆包回复或结束调整，再切换短剧项目');
      await pauseBatch();
      await pauseVideosBeforeProjectChange();
      activeProductionId = null; activeImageOperation = null; set({ activeImageOperationId: null }); promptBatchQueue = null;
      set({ capability: null, productionCounts: null, fallbacks: {}, promptRepairJobIds: [] });
      const accountId = selection ? selection.accountId : useAccountStore.getState().selectedAccountId;
      if (!accountId) throw new Error('请先选择已登录的豆包账号');
      const result = await window.electronAPI.petstory.create(selection ? selection.studioProjectId : useProjectStore.getState().activeProjectId, accountId);
      accept(result);
      if (result.success) { liveJobs.clear(); restoredPlanReadbacks.clear(); set({ promptBatch: { total: 0, completed: 0, status: 'idle' } }); }
    }),
    openProject: async (path?: string): Promise<void> => run(async (): Promise<void> => {
      promptWorkAuthorization++;
      if (isChatAdjusting(get().project)) throw new Error('请先采用当前豆包回复或结束调整，再切换短剧项目');
      await pauseBatch();
      await pauseVideosBeforeProjectChange();
      activeProductionId = null; activeImageOperation = null; set({ activeImageOperationId: null }); promptBatchQueue = null;
      liveJobs.clear();
      restoredPlanReadbacks.clear();
      set({ capability: null, productionCounts: null, fallbacks: {}, promptRepairJobIds: [] });
      const result = path === undefined ? await window.electronAPI.petstory.open() : await window.electronAPI.petstory.open(path);
      accept(result);
      await refreshTasks();
      if (result.project) {
        const current = get().project;
        const project = current?.id === result.project.id && current.revision >= result.project.revision ? current : result.project;
        set({ capability: project.promptCapability || null, promptBatch: project.promptBatch ? { total: project.promptBatch.total, completed: project.promptBatch.completed, status: project.promptBatch.status === 'complete' ? 'complete' : 'paused' } : { total: 0, completed: 0, status: 'idle' } });
        const studio = useProjectStore.getState();
        if (studio.projects.some((p): boolean => p.id === project.studioProjectId && !p.archived)) studio.selectProject(project.studioProjectId);
        else set({ error: '原 Studio 项目缺失或已归档，保留当前文件，不能开始新的对话' });
        if (useAccountStore.getState().accounts.some((a): boolean => a.id === project.accountId)
          && canSelectAccount(project.accountId, findInteractiveAccountId(useTaskStore.getState().accountAutomationState))) useAccountStore.getState().selectAccount(project.accountId);
        const readback = restoredPlanReadback(project, useTaskStore.getState().tasks);
        if (readback) {
          restoredPlanReadbacks.set(readback.job.id, { projectId: project.id, runId: readback.task.runtime.runId, authorization: promptWorkAuthorization });
          if (readback.task.status === 'done') await collectResult(readback.job.id, false);
        }
        if (project.promptBatch?.status === 'running' && studio.projects.some((item): boolean => item.id === project.studioProjectId && !item.archived)) await resumePromptBatch(project.promptBatch);
      }
    }),
    saveSource: async (text: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (p) accept(await window.electronAPI.petstory.saveSource(p.id, p.revision, text));
    }),
    saveMobileStory: async (text: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (p) accept(await window.electronAPI.petstory.saveMobileStory(p.id, p.revision, text));
    }),
    addSceneReference: async (shotId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (p) accept(await window.electronAPI.petstory.addSceneReference(p.id, shotId));
      set({ productionCounts: null, productionResolutions: {} });
    }),
    addReference: async (characterId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (p) accept(await window.electronAPI.petstory.addReference(p.id, characterId));
      set({ productionCounts: null, productionResolutions: {} });
    }),
    bindSharedReference: async (characterId: string, assetId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (p) accept(await window.electronAPI.petstory.bindSharedReference(p.id, p.revision, characterId, assetId));
      set({ productionCounts: null, productionResolutions: {} });
    }),
    savePromptProfile: async (profile: PetStoryPromptProfile): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (p) accept(await window.electronAPI.petstory.savePromptProfile(p.id, p.revision, profile));
      set({ productionCounts: null, productionResolutions: {} });
    }),
    savePlan: async (plan: PetStoryPlan): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      set({ productionCounts: null, productionResolutions: {} });
      if (p) accept(await window.electronAPI.petstory.savePlan(p.id, p.revision, plan));
    }),
    analyze: async (): Promise<void> => run(async (): Promise<void> => {
      await prepareRuntime('analysis');
    }),
    optimize: async (shotId: string, kind: PetStoryPromptKind): Promise<void> => run(async (): Promise<void> => {
      await prepareRuntime('optimize', { shotId, promptKind: kind });
    }),
    correctOnce: async (jobId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      const job = p?.jobs.find((j): boolean => j.id === jobId);
      if (p && job) {
        if (job.requestId) await prepareRuntime('repair', { parentJobId: job.id, repairMode: 'explicit' });
        else await prepare(repairPrompt(p, job), 'repair', job.id);
      }
    }),
    startBoundChat: async (jobId: string): Promise<void> => run((): Promise<void> => continueBoundChat(jobId)),
    retryUnsubmitted: async (jobId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (!p) throw new Error('请先打开原项目');
      const result = await window.electronAPI.petstory.retryUnsubmitted(p.id, jobId);
      accept(result);
      await refreshTasks();
      if (result.success) await startBound(jobId);
    }),
    collect: async (jobId: string, allowRepair = true): Promise<void> => run((): Promise<void> => collectResult(jobId, allowRepair)),
    draftFinal: async (shotId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (!p) return;
      accept(await window.electronAPI.petstory.draftFinal(p.id, shotId, 'firstFrame'));
      await refreshTasks();
    }),
  };
});

const knownChatProjects = new Map<string, string>();
const verifiedChatDispatchTasks = new WeakMap<Task, { key: string; revision: number }>();
const rememberChatProjects = (project: PetStoryProject | null): void => {
  if (project) for (const job of project.jobs) knownChatProjects.set(job.taskId, project.id);
};
rememberChatProjects(usePetStoryStore.getState().project);
const stopRememberingChats = usePetStoryStore.subscribe((state, previous): void => { if (state.project !== previous.project) rememberChatProjects(state.project); });

/** 输入与归属先核对；发送前仍由主进程验证请求事实与正式运行绑定。 */
function chatDispatchRun(project: PetStoryProject, job: PetStoryChatJob, task: Task): string {
  if (job.status !== 'bound' || job.endedWaitingAt || task.mode !== 'chat' || task.assignedAccountId !== project.accountId
    || task.projectId !== project.studioProjectId || !project.mobileStory || job.sourceStoryId !== project.mobileStory.id
    || !task.runtime?.runId || task.runtime.submittedAt || task.runtime.input.mode !== 'chat' || task.runtime.input.prompt !== task.prompt
    || JSON.stringify(task.runtime.input.attachments || []) !== JSON.stringify(task.attachments || [])) throw new Error('原文字任务、项目、账号或运行输入不符，未授权页面操作');
  return task.runtime.runId;
}
function boundChatSnapshot(project: PetStoryProject, job: PetStoryChatJob, taskId: string, runId: string, result: PetStoryResult): PetStoryProject {
  const bound = result.project;
  const saved = bound?.jobs.find((item): boolean => item.id === job.id);
  if (!result.success || !bound || bound.id !== project.id || bound.accountId !== project.accountId || bound.studioProjectId !== project.studioProjectId
    || !saved || saved.taskId !== taskId || saved.status !== 'bound' || saved.endedWaitingAt || saved.runId !== runId
    || saved.inputHash !== job.inputHash || saved.requestId !== job.requestId || saved.kind !== job.kind
    || saved.sourceStoryId !== project.mobileStory?.id) throw new Error(result.error || '本步骤运行绑定未回读，未授权页面操作');
  return bound;
}
async function bindPetStoryTaskRun(task: Task): Promise<void> {
  const project = usePetStoryStore.getState().project;
  const job = project?.jobs.find((item): boolean => item.taskId === task.id);
  const marker = task.petstoryChat;
  if (marker !== undefined && (!project || !job || marker?.projectId !== project.id || marker?.jobId !== job.id)) throw new Error('请先打开该文字任务所属的原项目，并核对原步骤后继续；本次未发送');
  if (!project || !job) {
    if (knownChatProjects.has(task.id)) throw new Error('请先打开该文字任务所属的原项目，再继续原任务');
    return;
  }
  const authorization = promptWorkAuthorization;
  const runId = chatDispatchRun(project, job, task);
  const key = JSON.stringify([project.id, job.id, runId]);
  const verified = verifiedChatDispatchTasks.get(task);
  if (verified?.key === key && verified.revision === project.revision && job.runId === runId) return;
  const result = await window.electronAPI.petstory.bindRun(project.id, job.id, runId);
  const bound = boundChatSnapshot(project, job, task.id, runId, result);
  const current = usePetStoryStore.getState().project;
  if (authorization !== promptWorkAuthorization || current?.id !== project.id) throw new Error('本轮文字准备已停止或项目已变化，原任务保留且未发送');
  if (bound.revision >= current.revision) usePetStoryStore.setState({ project: bound });
  const latestProject = usePetStoryStore.getState().project;
  const latest = latestProject?.jobs.find((item): boolean => item.id === job.id);
  if (!latestProject || latest?.runId !== runId || latest.status !== 'bound' || latest.endedWaitingAt) throw new Error('本步骤运行绑定已变化，未授权页面操作');
  verifiedChatDispatchTasks.set(task, { key, revision: latestProject.revision });
  liveJobs.add(job.id);
}
const unregisterChatDispatch = registerTaskDispatchGuard('petstory-chat', bindPetStoryTaskRun);
if (import.meta.hot) import.meta.hot.dispose((): void => { unregisterChatDispatch(); stopRememberingChats(); });

function verifiedWorkflowTask(project: PetStoryProject, detail: TaskVerificationRecoveryDetail): Task | undefined {
  const task = useTaskStore.getState().tasks.find((item): boolean => item.id === detail.taskId);
  const account = useAccountStore.getState().accounts.find((item): boolean => item.id === detail.accountId);
  if (project.accountId !== detail.accountId || !matchesVerificationRecoveryRun(task, detail) || task.projectId !== project.studioProjectId
    || !['executing', 'generating', 'manual_submission_observing', 'done'].includes(task.status)
    || account?.health?.availability?.state !== 'ready' || account.health.availability.checkedAt !== detail.verificationCheckedAt || account.health.verificationRequired) return undefined;
  return task;
}
/** 账号就绪只恢复刚解除验证的精确原运行；不把普通就绪探测当成新制作授权。 */
async function resumeVerifiedWorkflow(detail: TaskVerificationRecoveryDetail, projectId: string, authorization: number, productionAuthorization: number): Promise<void> {
  const state = usePetStoryStore.getState(); const project = state.project;
  if (!project || project.id !== projectId || authorization !== promptWorkAuthorization || state.busy || isChatAdjusting(project)) return;
  const task = verifiedWorkflowTask(project, detail); if (!task) return;
  const step = project.production?.steps.find((item): boolean => item.status !== 'complete');
  if (step?.taskId === task.id && step.runId === detail.runId) {
    if (productionAuthorization !== productionObservationAuthorization) return;
    await state.resumeProduction();
    // 本轮观察由验证恢复器持有；失败后保持暂停，不能由接力轮询无限重复检查。
    if (usePetStoryStore.getState().project?.id === projectId) observingProductionTasks.add(task.id);
    return;
  }
  const job = project.jobs.find((item): boolean => item.taskId === task.id && item.runId === detail.runId && item.status === 'bound' && !item.endedWaitingAt);
  const operation = project.imageOperations?.find((item): boolean => item.taskId === task.id && item.stage !== 'complete')
    || (job ? imageOperationForChatJob(project, job.id) : undefined);
  if (operation) { await state.recoverImageOperation(operation.id); return; }
  const suspended = verificationPausedBatch;
  if (job && suspended?.projectId === projectId && suspended.jobId === job.id && suspended.taskId === task.id
    && suspended.runId === detail.runId && suspended.authorization === authorization) {
    try { await state.continuePromptStage(); }
    finally { if (verificationPausedBatch === suspended) verificationPausedBatch = undefined; }
    return;
  }
  if (job && liveJobs.has(job.id) && task.status === 'done') await state.collect(job.id, true);
}
/** 仅收取本会话显式启动任务的结果；打开项目不会授权纠正或发送。 */
export function observePetStoryTasks(): () => void {
  // 只重读已落盘的原回复。瞬时 IPC／文件读取失败最多补偿两次，不重发平台请求。
  const readbackAttempts = new Map<string, number>();
  const readbackKey = (projectId: string, job: PetStoryChatJob, task: Task | undefined): string => {
    return JSON.stringify([projectId, job.id, job.runId, task?.runtime?.runId, task?.runtime?.chatResponse?.capturedAt]);
  };
  const verificationRecoveries = new Map<string, { detail: TaskVerificationRecoveryDetail; projectId: string; authorization: number; productionAuthorization: number }>();
  const handledVerificationRecoveries = new Set<string>();
  const onVerificationRecovered = (event: Event): void => {
    const detail = (event as CustomEvent<TaskVerificationRecoveryDetail>).detail;
    const projectId = usePetStoryStore.getState().project?.id;
    if (!projectId || !detail?.taskId || !detail.runId || !detail.verificationCheckedAt) return;
    const key = JSON.stringify([projectId, detail.taskId, detail.runId, detail.verificationCheckedAt]);
    if (handledVerificationRecoveries.has(key)) return;
    handledVerificationRecoveries.add(key);
    verificationRecoveries.set(detail.taskId, { detail, projectId, authorization: promptWorkAuthorization, productionAuthorization: productionObservationAuthorization });
    observe();
  };
  const observe = (): void => {
    const state = useTaskStore.getState();
    void tickPetStoryProduction();
    void refreshUnsubmittedVideoRecovery();
    const p = usePetStoryStore.getState();
    const restored = currentRestoredPlanReadback(p.project, state.tasks);
    if (p.busy || !p.project) return;
    for (const [taskId, recovery] of verificationRecoveries) {
      verificationRecoveries.delete(taskId);
      void resumeVerifiedWorkflow(recovery.detail, recovery.projectId, recovery.authorization, recovery.productionAuthorization);
    }
    const project = p.project;
    const batchJob = project.jobs.find((j): boolean => j.id === promptBatchQueue?.jobId);
    const blockedTask = batchJob && state.tasks.find((t): boolean => t.id === batchJob.taskId && ['fail', 'paused', 'cancelled', 'waiting_verification'].includes(t.status));
    if (batchJob && blockedTask) {
      const verification = blockedTask.status === 'waiting_verification' && blockedTask.errorInfo?.code === 'human_verification' && blockedTask.runtime?.runId;
      if (verification) verificationPausedBatch = { projectId: project.id, jobId: batchJob.id, taskId: blockedTask.id, runId: verification, authorization: promptWorkAuthorization };
      void p.stopPromptBatch(verification ? 'verification' : undefined);
    }
    const readback = restored && restoredPlanReadbacks.get(restored.job.id);
    const readOnlyJob = restored && restored.task.status === 'done' && readback?.projectId === project.id
      && readback.runId === restored.task.runtime?.runId && readback.authorization === promptWorkAuthorization ? restored.job : undefined;
    const tasksById = new Map(state.tasks.map((task): [string, Task] => [task.id, task]));
    const job = project.jobs.find((item): boolean => {
      const task = tasksById.get(item.taskId);
      return (!isChatAdjusting(project) || isAdjustmentRepair(project, item)) && !item.endedWaitingAt
        && (readbackAttempts.get(readbackKey(project.id, item, task)) || 0) < 3
        && (item.id === readOnlyJob?.id || liveJobs.has(item.id) && pendingChatJob(item) && task?.status === 'done'
          && (!!task.runtime?.chatResponse?.text || item.status === 'captured' && !!item.rawText));
    });
    if (!job) { void tickPetStoryImageOperation(); return; }
    const key = readbackKey(project.id, job, tasksById.get(job.taskId));
    readbackAttempts.set(key, (readbackAttempts.get(key) || 0) + 1);
    // 重启只解析原回复；需要新的平台格式修订时，留给用户明确继续原步骤。
    void p.collect(job.id, job.id !== readOnlyJob?.id || liveJobs.has(job.id));
  };
  // busy期间到达的完成事件不会再发一次；轻量检查只收取本轮已明确启动的任务。
  const interval = setInterval(observe, 1000);
  const unsubscribe = useTaskStore.subscribe(observe);
  window.addEventListener('task-verification-recovery-started', onVerificationRecovered);
  return (): void => { clearInterval(interval); unsubscribe(); window.removeEventListener('task-verification-recovery-started', onVerificationRecovered); verificationRecoveries.clear(); };
}
