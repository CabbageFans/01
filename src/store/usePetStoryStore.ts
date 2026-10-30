import { pendingPetStoryDrafts } from '../utils/petstoryDraftPresence';
import { create } from 'zustand';
import type { Task, PetStoryPlan, PetStoryProject, PetStoryPromptKind, PetStoryResult, PetStoryChatJob, PetStoryCapability, PetStoryMaterialEditIntent, PetStoryProductionCounts, PetStoryModeResolution, PetStoryPromptProfile, PetStoryRuntimeTarget, PetStoryPromptBatch, PetStoryConversationReply, PetStoryAdjustmentPreview, PetStoryImageTarget, PetStoryImageOperation, PetStoryImageOperationResult } from '@doubao-studio/contracts';
import { useTaskStore } from './useTaskStore';
import { useAccountStore } from './useAccountStore';
import { useProjectStore } from './useProjectStore';
import { repairPrompt } from '../utils/petstoryPrompts';
import { resolveTaskConversationTarget } from '../utils/taskConversationLocator';
import { canStartBoundChat } from '../utils/petstoryCandidate';
import { canSelectAccount, findInteractiveAccountId } from '../utils/interactiveAccount';
import { imageConversationTask, imageOperationForChatJob } from '../utils/petstoryImageFlow';

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
  savePromptModel: (model?: PetStoryProject['promptModel']) => Promise<void>;
  endChatWaiting: (jobId: string) => Promise<void>;
  recoverChat: (jobId: string) => Promise<void>;
  saveOriginalStory: (text: string) => Promise<void>;
  linkExistingMedia: (shotId: string, kind: PetStoryPromptKind, taskId: string, artifactId?: string) => Promise<void>;
  promptBatch: { total: number; completed: number; status: 'idle' | 'running' | 'complete' | 'paused' };
  regenerateAllPrompts: () => Promise<void>;
  regenerateAllMaterialPrompts: () => Promise<void>;
  extractAssets: () => Promise<void>;
  adoptPlanCandidate: (jobId: string) => Promise<void>;
  adoptAssetsCandidate: (jobId: string) => Promise<void>;
  adoptPromptCandidate: (jobId: string) => Promise<void>;
  reviewContent: (target?: PetStoryRuntimeTarget) => Promise<void>;
  reviseContent: (reviewJobId: string, target: PetStoryRuntimeTarget) => Promise<void>;
  stopPromptBatch: () => Promise<void>;
  regenerateMaterialPrompt: (materialId: string, editIntent?: PetStoryMaterialEditIntent) => Promise<void>;
  saveShotPrompt: (shotId: string, kind: PetStoryPromptKind, final: string) => Promise<void>;
  generateShotMedia: (shotId: string, kind: PetStoryPromptKind) => Promise<void>;
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
  const round = candidate.kind === 'repair' ? project.jobs.find((job): boolean => job.id === candidate.parentJobId) : candidate;
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
let promptBatchQueue: { projectId: string; targets: PromptBatchTarget[]; jobId?: string; stopRequested?: boolean; waitingCandidate?: boolean } | null = null;
let activeProductionId: string | null = null;
let productionTickRunning = false;
const observingProductionTasks = new Set<string>();
let activeImageOperation: { projectId: string; operationId: string } | null = null;
let imageOperationTickRunning = false;
const dispatchedImageTasks = new Set<string>();
const observingImageTasks = new Set<string>();
function authorizedImageChat(project: PetStoryProject, jobId: string): boolean {
  const operation = imageOperationForChatJob(project, jobId);
  return !!operation && activeImageOperation?.projectId === project.id && activeImageOperation.operationId === operation.id;
}
function collectedFailureMessage(result: PetStoryResult, failedRepair: boolean, imageOperation: boolean): string {
  if (imageOperation) return '图片准备未完成，请继续本次任务。';
  if (failedRepair) return '豆包还未修好，你可以继续调整。具体原因已保留在生成记录中。';
  return result.error || '内容尚未通过，请查看当前任务。';
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
/** 打开清单不启用接力；只在本会话一次确认或显式继续后推进。 */
export async function tickPetStoryProduction(): Promise<void> {
  const id = activeProductionId;
  const state = usePetStoryStore.getState();
  if (!canTickProduction(state, id)) return;
  productionTickRunning = true;
  try {
    const result = await window.electronAPI.petstory.advanceProduction(id);
    if (result.project && usePetStoryStore.getState().project?.id === id) usePetStoryStore.setState({ project: result.project });
    if (activeProductionId !== id) return;
    if (!result.success || result.project?.production?.state !== 'running') {
      activeProductionId = null;
      if (!result.success) usePetStoryStore.setState({ error: result.error || '制作已暂停' });
      return;
    }
    if (result.taskId && result.action === 'start') {
      await refreshTasks();
      if (activeProductionId !== id) return;
      const started = await useTaskStore.getState().startAutomation(result.taskId, async (task: Task): Promise<void> => {
        if (activeProductionId !== id || !task.runtime) throw new Error('制作已暂停');
        const bound = await window.electronAPI.petstory.bindProductionRun(id, task.id, task.runtime.runId);
        if (!bound.success) throw new Error(bound.error || '制作运行绑定未保存');
        if (bound.project) usePetStoryStore.setState({ project: bound.project });
      });
      if (!started) {
        activeProductionId = null;
        const paused = await window.electronAPI.petstory.pauseProduction(id);
        usePetStoryStore.setState({ ...(paused.project ? { project: paused.project } : {}), error: useTaskStore.getState().error || '原任务未启动，请处理后继续' });
      }
    } else if (result.taskId && result.action === 'observe') {
      if (observingProductionTasks.has(result.taskId)) {
        activeProductionId = null;
        const paused = await window.electronAPI.petstory.pauseProduction(id);
        usePetStoryStore.setState({ ...(paused.project ? { project: paused.project } : {}), error: '原会话本轮只读观察未完成，请处理后显式继续；未重新生成' });
        return;
      }
      observingProductionTasks.add(result.taskId);
      const resumed = await useTaskStore.getState().updateTaskRuntime(result.taskId, { status: 'manual_submission_observing', runtime: { stage: 'manual_submission_observing', message: '继续只读观察原制作会话，不重复发送' } });
      if (!resumed || activeProductionId !== id) return;
      window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: result.taskId } }));
    }
  } catch (error: unknown) {
    activeProductionId = null;
    usePetStoryStore.setState({ error: error instanceof Error ? error.message : '制作接力中断，请打开原项目核对后继续' });
  } finally { productionTickRunning = false; }
}
async function refreshTasks(): Promise<void> {
  const tasks = await window.electronAPI.tasks.list();
  useTaskStore.setState({ tasks });
}
export const usePetStoryStore = create<PetStoryState>((set, get) => {
  const accept = (result: PetStoryResult): void => {
    if (result.project && (get().project?.id !== result.project.id || result.project.revision >= (get().project?.revision || 0))) set({ project: result.project, projectName: result.displayName ?? (get().project?.id === result.project.id ? get().projectName : '') });
    if (!result.success) set({ error: result.error || '操作未完成' });
  };
  const run = async (work: () => Promise<void>): Promise<void> => {
    if (get().busy) return;
    set({ busy: true, error: '' });
    try { await work(); }
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
      set({ busy: false });
    }
  };
  const startBound = async (jobId: string): Promise<void> => {
    const project = get().project;
    const job = project?.jobs.find((j): boolean => j.id === jobId);
    if (project?.chatAdjustment?.status === 'active' && !isAdjustmentRepair(project, job)) throw new Error('请先采用豆包回复或结束当前调整');
    if (!project || !job || job.endedWaitingAt || job.status !== 'bound') throw new Error('请选择原步骤');
    if (!project.mobileStory || job.sourceStoryId !== project.mobileStory.id) throw new Error('旧版链接直读任务已停用，请保存手机豆包故事后生成制作方案');
    if (!useProjectStore.getState().projects.some((p): boolean => p.id === project.studioProjectId && !p.archived)) throw new Error('原Studio项目不存在');
    liveJobs.add(job.id);
    const started = await useTaskStore.getState().startAutomation(job.taskId, async (task: Task): Promise<void> => {
      if (!job || !task.runtime?.runId) throw new Error('本步骤运行未初始化');
      const bound = await window.electronAPI.petstory.bindRun(project.id, job.id, task.runtime.runId);
      accept(bound);
      if (!bound.success) throw new Error(bound.error || '本步骤运行绑定未保存');
    });
    if (!started) throw new Error(useTaskStore.getState().error || '原任务保持已绑定；请处理原因后启动原任务，不要重复分析');
  };
  const continueBoundChat = async (jobId: string): Promise<void> => {
    const p = get().project; const job = p?.jobs.find((item): boolean => item.id === jobId);
    if (!p || !job) throw new Error('请先打开原项目并选择原文字任务');
    await refreshTasks();
    const taskState = useTaskStore.getState(); const task = taskState.tasks.find((item): boolean => item.id === job.taskId);
    if (!canStartBoundChat(p, job, task, taskState.tasks, taskState.activeTaskId === job.taskId || !!taskState.accountBusy[p.accountId])) throw new Error('原任务未明确停止在未发送状态，或运行归属／账号占用不符；请只读核对，不重新发送');
    if (task?.status !== 'queued') {
      const result = await window.electronAPI.petstory.retryUnsubmitted(p.id, job.id); accept(result);
      if (!result.success) return;
      await refreshTasks();
    }
    await startBound(job.id);
  };
  const startPrepared = async (result: PetStoryResult): Promise<string | undefined> => {
    accept(result);
    if (!result.success || !result.taskId || !result.project) return;
    const job = result.project.jobs.find((item): boolean => item.taskId === result.taskId);
    if (!job) throw new Error('已创建原任务但项目绑定未回读，不继续发送');
    const batch = promptBatchQueue;
    if (batch?.projectId === result.project.id) {
      // 启动前保存原任务关联；启动失败和重开都只能恢复这一任务。
      batch.jobId = job.id;
      await persistBatch(batch.stopRequested ? 'paused' : 'running', job.id);
    }
    await refreshTasks();
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
    const project = get().project;
    if (!project) throw new Error('请先打开或创建项目');
    if (project.chatAdjustment?.status === 'active') throw new Error('请先采用豆包回复或结束当前调整');
    if (!useProjectStore.getState().projects.some((p): boolean => p.id === project.studioProjectId && !p.archived)) throw new Error('原 Studio 项目缺失或已归档');
    const account = useAccountStore.getState().accounts.find((a): boolean => a.id === project.accountId);
    if (!account || account.platform === 'dola') throw new Error('项目原豆包账号缺失，不能自动更换账号');
    const result = await window.electronAPI.petstory.prepareChat(project.id, prompt, kind, parentJobId, shotId, promptKind, materialId);
    return startPrepared(result);
  };
  const prepareRuntime = async (kind: PetStoryChatJob['kind'], target?: PetStoryRuntimeTarget): Promise<string | undefined> => {
    const project = get().project;
    if (!project) throw new Error('请先打开或创建项目');
    if (project.chatAdjustment?.status === 'active' && !(kind === 'repair' && target?.parentJobId && project.chatAdjustment.repairJobId)) throw new Error('请先采用豆包回复或结束当前调整');
    if (!useProjectStore.getState().projects.some((p): boolean => p.id === project.studioProjectId && !p.archived)) throw new Error('原 Studio 项目缺失或已归档');
    const account = useAccountStore.getState().accounts.find((a): boolean => a.id === project.accountId);
    if (!account || account.platform === 'dola') throw new Error('项目原豆包账号缺失，不能自动更换账号');
    // 规则、当前事实和实际附件由主进程同一快照组装；页面不自行撰写运行时正文。
    const capability = target?.capability || get().capability || project.promptCapability;
    const requestTarget = capability ? { ...target, capability } : target;
    const result = await window.electronAPI.petstory.prepareRuntime(project.id, project.revision, kind, requestTarget);
    return startPrepared(result);
  };
  const persistBatch = async (status: PetStoryPromptBatch['status'], jobId?: string): Promise<void> => {
    const batch = promptBatchQueue; const p = get().project;
    if (!batch || !p || batch.projectId !== p.id) return;
    const progress = get().promptBatch;
    const result = await window.electronAPI.petstory.savePromptBatch(p.id, p.revision, { targets: batch.targets, total: progress.total, completed: progress.completed, status, jobId });
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
  const nextPrompt = async (): Promise<void> => {
    const batch = promptBatchQueue; const p = get().project;
    if (!batch || !p || batch.projectId !== p.id || batch.waitingCandidate) return;
    const target = batch.targets[0];
    if (!target) { await persistBatch('complete'); promptBatchQueue = null; set({ promptBatch: { ...get().promptBatch, status: 'complete' } }); return; }
    await persistBatch('running');
    if (batch.stopRequested || promptBatchQueue !== batch) { await pauseBatch(); return; }
    const jobId = target.materialId ? await prepareRuntime('materialPrompt', { materialId: target.materialId }) : await prepareRuntime('optimize', { shotId: target.shotId, promptKind: target.kind });
    if (!jobId) throw new Error(get().error || '本项文字任务未启动，批次已暂停');
    batch.jobId = jobId;
    if (batch.stopRequested) await pauseBatch();
  };
  const beginBatch = async (targets: PromptBatchTarget[]): Promise<void> => {
    const p = get().project;
    if (!p) throw new Error('请先打开项目');
    if (promptBatchQueue) throw new Error('当前文字批次尚未结束，请先收取原任务或停止后续请求');
    promptBatchQueue = { projectId: p.id, targets };
    set({ promptBatch: { total: targets.length, completed: 0, status: 'running' } });
    await nextPrompt();
  };
  const stageTargets = async (): Promise<void> => {
    const p = get().project; if (!p) return;
    const result = await window.electronAPI.petstory.promptStageTargets(p.id, p.revision); accept(result);
    if (!result.success || !result.promptTargets) throw new Error(result.error || '当前文字阶段未完成资格核对，不创建请求');
    const excluded = unresolvedEndedPromptKeys(result.project || p);
    const targets = petStoryPromptActionTargets({ ...(result.project || p), promptBatch: undefined }, result.promptTargets);
    await beginBatch(targets);
    const notices: string[] = [];
    if (excluded.size) notices.push('已结束等待的原目标保留为待处理，本次只补齐其他目标；这些目标需要新的明确单项或批量重新生成操作，不会自动重发。');
    if (result.pendingCandidateJobIds?.length) notices.push('已有本次模型与模式的新候选待采用；手改 final 保留，下游仍引用当前已采用正文。');
    if (notices.length) set({ error: notices.join('\n') });
  };
  const consumeReplacedInvalid = async (failed: PetStoryChatJob, saved: PetStoryPromptBatch): Promise<boolean> => {
    const p = get().project; const batch = promptBatchQueue; const first = batch?.targets[0];
    if (!p || !batch || !first || promptJobKey(failed) !== promptTargetKey(first)) throw new Error('保存的批次目标与原失败任务不符，保留记录并停止');
    const result = await window.electronAPI.petstory.promptStageTargets(p.id, p.revision); accept(result);
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
    await pauseBatch();
    const notice = '旧设计的文字批次已过期，已按当前设计重新核对缺失目标；原任务与回复记录保留，不发送已删除目标。';
    try { await stageTargets(); }
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
  const resumePromptBatch = async (saved: PetStoryPromptBatch): Promise<void> => {
    const p = get().project; if (!p) return;
    const original = p.jobs.find((item): boolean => item.id === saved.jobId);
    const job = original ? latestRepair(p, original) : undefined;
    promptBatchQueue = { projectId: p.id, targets: [...saved.targets], jobId: job?.id || saved.jobId };
    set({ promptBatch: { total: saved.total, completed: saved.completed, status: 'running' } });
    if (pendingChatJob(job)) {
      if (job.kind === 'repair') {
        await resumeSavedRepair(job); return;
      }
      await pauseBatch();
      set({ error: '原批次已有未决任务，请只读重新收取或明确结束等待；不会重发。' }); return;
    }
    if (saved.targets.some((target): boolean => !promptTargetExists(p, target))) {
      // 新方案可改实体ID；删除目标不是已完成，只有显式继续时重新核对当前阶段。
      if (!job || !job.endedWaitingAt && !['applied', 'invalid'].includes(job.status)) {
        await pauseBatch(); set({ error: '旧设计批次包含已删除目标，但原任务归属或状态尚未明确；请核对原任务，继续不会重发。' }); return;
      }
      await restartExpiredPromptBatch(); return;
    }
    if (job?.endedWaitingAt) { await pauseBatch(); await stageTargets(); return; }
    if (job?.status === 'invalid' && !await consumeReplacedInvalid(job, saved)) {
      await pauseBatch();
      set({ error: '原候选未通过，请核对原回复并明确修订或重新生成并采用；继续不会自动重发。' }); return;
    }
    // 保存的队列也可能含更早结束等待的目标；重开/再次继续同样依据全部任务历史排除。
    const excluded = unresolvedEndedPromptKeys(get().project || p);
    if (promptBatchQueue.targets.some((target): boolean => excluded.has(promptTargetKey(target)))) { await pauseBatch(); await stageTargets(); return; }
    if (job?.status === 'applied') {
      if (job.resultStatus === 'candidate') {
        promptBatchQueue.waitingCandidate = true;
        await persistBatch('paused', job.id);
        set({ promptBatch: { ...get().promptBatch, status: 'paused' } }); return;
      }
      const first = promptBatchQueue.targets[0];
      if (!first || (first.materialId ? first.materialId !== job.materialId : first.shotId !== job.shotId || first.kind !== job.promptKind)) throw new Error('保存的批次目标与原任务不符，保留记录并停止');
      const qualification = await window.electronAPI.petstory.promptStageTargets(p.id, p.revision); accept(qualification);
      if (!qualification.success || !qualification.promptTargets) throw new Error(qualification.error || '原结果的当前资格未核对，不继续批次');
      if (qualification.promptTargets.some((target): boolean => first.materialId ? target.materialId === first.materialId : target.shotId === first.shotId && target.kind === first.kind)) {
        // 用户本次继续已授权按当前事实适配；旧模型/旧模式的applied不能当作本次完成。
        await pauseBatch(); await stageTargets(); return;
      }
      promptBatchQueue.targets.shift(); set({ promptBatch: { ...get().promptBatch, completed: saved.completed + 1 } });
    }
    await nextPrompt();
  };
  const repairResult = async (result: PetStoryResult, sourceId: string, authorized: boolean, imageOperation = false): Promise<string | undefined> => {
    const p = result.project || get().project; const job = p?.jobs.find((item): boolean => item.id === sourceId);
    if (!p || !job || job.endedWaitingAt || !authorized || !imageOperation && !get().autoRepair) return;
    if (promptBatchQueue?.stopRequested || p.promptBatch?.status === 'paused' && p.promptBatch.jobId === sourceId && !promptBatchQueue) return;
    if (isChatAdjusting(p) && !isAdjustmentRepair(p, job)) return;
    const child = latestRepair(p, job);
    if (child.id !== job.id || result.repairJobId) {
      const existing = latestRepair(p, p.jobs.find((item): boolean => item.id === result.repairJobId) || child);
      if (existing.endedWaitingAt) return;
      return startPrepared({ success: true, project: p, taskId: existing.taskId });
    }
    if (!result.needsRepair) return;
    if (job.requestId) return prepareRuntime('repair', { parentJobId: job.id, repairMode: 'automatic' });
    return prepare(repairPrompt(p, job), 'repair', job.id);
  };
  const collectResult = async (jobId: string, allowRepair: boolean): Promise<void> => {
    const p = get().project; if (!p) return;
    const result = await window.electronAPI.petstory.collectChat(p.id, jobId);
    if (get().project?.id !== p.id) return;
    const collectedJob = result.project?.jobs.find((item): boolean => item.id === jobId);
    const failedRepair = collectedJob?.kind === 'repair' && collectedJob.status === 'invalid';
    // 修订是当前创作的一步：原错误先保存在详情，安排失败时才成为当前阻断。
    accept(result.needsRepair && allowRepair || failedRepair ? { ...result, success: true } : result);
    const authorizedImage = authorizedImageChat(result.project || p, jobId);
    const repairJobId = await repairResult(result, jobId, allowRepair, authorizedImage);
    liveJobs.delete(jobId);
    if (repairJobId) set({ error: '' });
    else if (!result.success) set({ error: collectedFailureMessage(result, failedRepair, authorizedImage) });
    if (!promptBatchQueue || promptBatchQueue.jobId !== jobId && promptBatchQueue.jobId !== repairJobId) return;
    if (repairJobId && repairJobId !== jobId) {
      promptBatchQueue.jobId = repairJobId;
      const repaired = get().project?.jobs.find((item): boolean => item.id === repairJobId);
      if (repaired?.status === 'applied') {
        if (repaired.resultStatus === 'candidate') {
          promptBatchQueue.waitingCandidate = true;
          await persistBatch('paused', repairJobId);
          set({ promptBatch: { ...get().promptBatch, status: 'paused' } });
        } else { promptBatchQueue.targets.shift(); set({ promptBatch: { ...get().promptBatch, completed: get().promptBatch.completed + 1 } }); await nextPrompt(); }
      } else if (repaired?.status === 'invalid') await pauseBatch();
      return;
    }
    if (!result.success) { await pauseBatch(); return; }
    const job = result.project?.jobs.find((item): boolean => item.id === jobId);
    if (job?.resultStatus === 'candidate') {
      promptBatchQueue.waitingCandidate = true;
      await persistBatch('paused', jobId);
      set({ promptBatch: { ...get().promptBatch, status: 'paused' } }); return;
    }
    promptBatchQueue.targets.shift();
    set({ promptBatch: { ...get().promptBatch, completed: get().promptBatch.completed + 1 } });
    await nextPrompt();
  };
  const adoptCandidate = async (jobId: string, kind: 'plan' | 'assets' | 'prompt'): Promise<void> => {
    const p = get().project; if (!p) return;
    const api = window.electronAPI.petstory;
    const result = await (kind === 'plan' ? api.adoptPlanCandidate(p.id, p.revision, jobId) : kind === 'assets' ? api.adoptAssetsCandidate(p.id, p.revision, jobId) : api.adoptPromptCandidate(p.id, p.revision, jobId));
    accept(result.needsRepair ? { ...result, success: true } : result);
    if (result.needsRepair) { await repairResult(result, result.repairSourceJobId || jobId, true); return; }
    if (!result.success) return;
    const batch = promptBatchQueue;
    if (batch?.jobId === jobId && batch.waitingCandidate && !batch.stopRequested) {
      batch.waitingCandidate = false; batch.targets.shift();
      set({ promptBatch: { ...get().promptBatch, completed: get().promptBatch.completed + 1, status: 'running' } });
      await nextPrompt();
    }
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
    } else if (result.action === 'observe' && !observingImageTasks.has(result.taskId)) {
      observingImageTasks.add(result.taskId);
      const resumed = await useTaskStore.getState().updateTaskRuntime(result.taskId, { status: 'manual_submission_observing', runtime: { stage: 'manual_submission_observing', message: '继续读取本次图片结果，不重复发送' } });
      if (resumed && activeImageOperation === context) window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: result.taskId } }));
    }
  };
  /** 显式继续可核对仍停在当前页的原图片请求；绝不把缺少会话地址当作重发授权。 */
  const recoverSubmittedImage = async (context: NonNullable<typeof activeImageOperation>): Promise<void> => {
    await refreshTasks();
    const project = get().project;
    if (!project || project.id !== context.projectId || activeImageOperation !== context) return;
    const operation = project.imageOperations?.find((item): boolean => item.id === context.operationId);
    const task = useTaskStore.getState().tasks.find((item): boolean => item.id === operation?.taskId);
    if (!task?.runtime?.submittedAt || !['paused', 'fail', 'cancelled', 'waiting_verification', 'waiting_generation_confirmation'].includes(task.status)) return;
    const production = project.production;
    const step = production?.steps.find((item): boolean => item.taskId === task.id);
    if (task.mode !== 'image' || task.projectId !== project.studioProjectId || task.assignedAccountId !== project.accountId
      || production?.imageOperationId !== context.operationId || !step?.runId || step.runId !== task.runtime.runId
      || task.petstory?.projectId !== project.id || task.petstory.stepId !== step.id) throw new Error('图片原任务与项目、账号或运行不一致，未读取当前页面');
    const locator = resolveTaskConversationTarget(task);
    if (!locator.ok && locator.reason !== 'CONVERSATION_URL_MISSING') throw new Error('图片原会话存在多个候选或绑定冲突，请先核对原任务');
    if (observingImageTasks.has(task.id)) return;
    const observed = await useTaskStore.getState().updateTaskRuntime(task.id, { status: 'manual_submission_observing', runtime: { stage: 'manual_submission_observing', message: '只读核对本次图片原结果，不重复发送' } });
    if (!observed) throw new Error(useTaskStore.getState().error || '原图片只读恢复未保存，请稍后继续');
    observingImageTasks.add(task.id);
    if (activeImageOperation === context) window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: task.id, useCurrentPage: !locator.ok } }));
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
    dispatchedImageTasks.clear(); observingImageTasks.clear();
    const context = { projectId: project.id, operationId: result.operationId };
    activeImageOperation = context;
    set({ productionCounts: null, activeImageOperationId: context.operationId });
    try { await driveImageOperation(result, context); }
    catch (error: unknown) { if (activeImageOperation === context) { activeImageOperation = null; set({ activeImageOperationId: null }); } throw error; }
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
        const result = await window.electronAPI.petstory.resumeImageOperation(project.id, operationId, get().capability || undefined);
        accept(result);
        if (!result.success) return;
        activeProductionId = null; dispatchedImageTasks.clear(); observingImageTasks.clear();
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
    }),
    openImageConversation: async (target: PetStoryImageTarget, assetId?: string): Promise<void> => {
      const project = get().project;
      if (!project) return;
      const task = imageConversationTask(project, target, useTaskStore.getState().tasks, assetId);
      if (!task || !resolveTaskConversationTarget(task).ok) return;
      if (!canSelectAccount(project.accountId, findInteractiveAccountId(useTaskStore.getState().accountAutomationState))) { set({ error: '其他账号正在提交，请稍后查看这次豆包对话' }); return; }
      const occupied = useTaskStore.getState().tasks.some((item): boolean => item.id !== task.id && item.assignedAccountId === project.accountId
        && ['executing', 'generating', 'manual_submission_observing', 'waiting_verification', 'waiting_generation_confirmation'].includes(item.status));
      if (occupied || project.chatAdjustment?.status === 'active') { set({ error: '这个账号正在处理另一段对话，请稍后查看图片来源' }); return; }
      window.dispatchEvent(new CustomEvent('reveal-workspace-browser'));
      window.dispatchEvent(new CustomEvent('open-task-conversation', { detail: { task } }));
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
      const result = await window.electronAPI.petstory.beginAdjustment(p.id, p.revision, target); accept(result); await refreshTasks();
      if (!result.success) return;
      set({ chatReadbackError: '' });
      useAccountStore.getState().selectAccount(p.accountId);
      window.dispatchEvent(new CustomEvent('reveal-workspace-browser'));
      window.dispatchEvent(new CustomEvent('petstory-open-adjustment'));
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
      if (result.success) { liveJobs.delete(jobId); promptBatchQueue = null; set({ promptBatch: { ...get().promptBatch, status: 'paused' } }); }
    }),
    recoverChat: async (jobId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; const job = p?.jobs.find((item): boolean => item.id === jobId);
      if (!p || !job) throw new Error('请选择原任务');
      await refreshTasks();
      const task = useTaskStore.getState().tasks.find((item): boolean => item.id === job.taskId);
      if (!task?.runtime?.submittedAt || task.runtime.runId !== job.runId) throw new Error('没有已提交原运行，不能以恢复入口重新发送');
      liveJobs.add(job.id);
      if (task.runtime.chatResponse?.text) { await collectResult(job.id, true); return; }
      if (!['fail', 'paused', 'cancelled', 'waiting_verification'].includes(task.status)) throw new Error('原任务仍在运行或占用中，请等待原观察完成');
      const locator = resolveTaskConversationTarget(task);
      if (!locator.ok && locator.reason !== 'CONVERSATION_URL_MISSING') throw new Error('原会话定位存在多个候选或绑定冲突；请先核对原任务记录，未读取当前页面');
      window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: task.id, useCurrentPage: !locator.ok } }));
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
    stopPromptBatch: async (): Promise<void> => {
      if (promptBatchQueue) promptBatchQueue.stopRequested = true;
      const job = get().project?.jobs.find((item): boolean => item.id === promptBatchQueue?.jobId);
      const task = useTaskStore.getState().tasks.find((item): boolean => item.id === job?.taskId);
      if (job?.kind === 'repair' && !task?.runtime?.submittedAt) window.dispatchEvent(new CustomEvent('cancel-task-automation', { detail: { taskId: job.taskId, targetStatus: 'paused' } }));
      set({ promptBatch: { ...get().promptBatch, status: 'paused' } });
      // 忙碌期间先阻止下一次发送，当前操作退出时保存暂停；不丢弃已创建的原任务。
      if (!get().busy) await run(pauseBatch);
    },
    regenerateMaterialPrompt: async (materialId: string, editIntent?: PetStoryMaterialEditIntent): Promise<void> => run(async (): Promise<void> => {
      await prepareRuntime('materialPrompt', { materialId, ...(editIntent ? { editIntent } : {}) });
    }),
    saveShotPrompt: async (shotId: string, kind: PetStoryPromptKind, final: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; if (p) accept(await window.electronAPI.petstory.saveShotPrompt(p.id, p.revision, shotId, kind, final));
    }),
    generateShotMedia: async (shotId: string, kind: PetStoryPromptKind): Promise<void> => {
      await run(async (): Promise<void> => {
        const p = get().project; const capability = get().capability;
        if (!p) throw new Error('请先打开原项目');
        const result = await window.electronAPI.petstory.generateShotMedia(p.id, p.revision, shotId, kind, capability || undefined, get().fallbacks);
        accept(result); if (result.success) { activeProductionId = p.id; observingProductionTasks.clear(); set({ productionCounts: null }); }
      });
      await tickPetStoryProduction();
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
      activeProductionId = null;
      const taskId = p.production?.steps.find((s): boolean => s.status !== 'complete')?.taskId;
      if (taskId) window.dispatchEvent(new CustomEvent('cancel-task-automation', { detail: { taskId } }));
      await run(async (): Promise<void> => accept(await window.electronAPI.petstory.pauseProduction(p.id)));
    },
    resumeProduction: async (): Promise<void> => {
      await run(async (): Promise<void> => {
        const p = get().project;
        if (!p) throw new Error('请先打开原项目');
        const result = await window.electronAPI.petstory.resumeProduction(p.id, get().capability || undefined);
        accept(result);
        if (result.success) { activeProductionId = p.id; observingProductionTasks.clear(); }
        await refreshTasks();
      });
      await tickPetStoryProduction();
    },
    busy: false, error: '', autoRepair: true,
    setAutoRepair: (value: boolean): void => set({ autoRepair: value }),
    createProject: async (selection?: { accountId: string; studioProjectId: string }): Promise<void> => run(async (): Promise<void> => {
      if (isChatAdjusting(get().project)) throw new Error('请先采用当前豆包回复或结束调整，再切换短剧项目');
      await pauseBatch();
      activeProductionId = null; activeImageOperation = null; set({ activeImageOperationId: null }); promptBatchQueue = null;
      set({ capability: null, productionCounts: null, fallbacks: {} });
      const accountId = selection ? selection.accountId : useAccountStore.getState().selectedAccountId;
      if (!accountId) throw new Error('请先选择已登录的豆包账号');
      const result = await window.electronAPI.petstory.create(selection ? selection.studioProjectId : useProjectStore.getState().activeProjectId, accountId);
      accept(result);
      if (result.success) { liveJobs.clear(); set({ promptBatch: { total: 0, completed: 0, status: 'idle' } }); }
    }),
    openProject: async (path?: string): Promise<void> => run(async (): Promise<void> => {
      if (isChatAdjusting(get().project)) throw new Error('请先采用当前豆包回复或结束调整，再切换短剧项目');
      await pauseBatch();
      activeProductionId = null; activeImageOperation = null; set({ activeImageOperationId: null }); promptBatchQueue = null;
      liveJobs.clear();
      set({ capability: null, productionCounts: null, fallbacks: {} });
      const result = path === undefined ? await window.electronAPI.petstory.open() : await window.electronAPI.petstory.open(path);
      accept(result);
      await refreshTasks();
      if (result.project) {
        const project = result.project;
        set({ capability: project.promptCapability || null, promptBatch: project.promptBatch ? { total: project.promptBatch.total, completed: project.promptBatch.completed, status: project.promptBatch.status === 'complete' ? 'complete' : 'paused' } : { total: 0, completed: 0, status: 'idle' } });
        const studio = useProjectStore.getState();
        if (studio.projects.some((p): boolean => p.id === project.studioProjectId && !p.archived)) studio.selectProject(project.studioProjectId);
        else set({ error: '原 Studio 项目缺失或已归档，保留当前文件，不能开始新的对话' });
        if (useAccountStore.getState().accounts.some((a): boolean => a.id === project.accountId)
          && canSelectAccount(project.accountId, findInteractiveAccountId(useTaskStore.getState().accountAutomationState))) useAccountStore.getState().selectAccount(project.accountId);
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
/** 仅收取本会话显式启动任务的结果；打开项目不会授权纠正或发送。 */
export function observePetStoryTasks(): () => void {
  const attempted = new Set<string>();
  const observe = (): void => {
    const state = useTaskStore.getState();
    void tickPetStoryProduction();
    const p = usePetStoryStore.getState();
    if (p.busy || !p.project) return;
    const project = p.project;
    const batchJob = project.jobs.find((j): boolean => j.id === promptBatchQueue?.jobId);
    if (batchJob && state.tasks.some((t): boolean => t.id === batchJob.taskId && ['fail', 'paused', 'cancelled', 'waiting_verification'].includes(t.status))) {
      void p.stopPromptBatch();
    }
    const job = project.jobs.find((j): boolean => (!isChatAdjusting(project) || isAdjustmentRepair(project, j)) && !j.endedWaitingAt && liveJobs.has(j.id) && !attempted.has(j.id) && j.status === 'bound' && state.tasks.some((t): boolean => t.id === j.taskId && t.status === 'done' && !!t.runtime?.chatResponse));
    if (!job) { void tickPetStoryImageOperation(); return; }
    attempted.add(job.id);
    void p.collect(job.id, true);
  };
  // busy期间到达的完成事件不会再发一次；轻量检查只收取本轮已明确启动的任务。
  const interval = setInterval(observe, 1000);
  const unsubscribe = useTaskStore.subscribe(observe);
  return (): void => { clearInterval(interval); unsubscribe(); };
}
