import { create } from 'zustand';
import type { Task, PetStoryPlan, PetStoryProject, PetStoryPromptKind, PetStoryResult, PetStoryChatJob, PetStoryCapability, PetStoryMaterialEditIntent, PetStoryProductionCounts, PetStoryModeResolution, PetStoryPromptProfile, PetStoryRuntimeTarget, PetStoryPromptBatch } from '@doubao-studio/contracts';
import { useTaskStore } from './useTaskStore';
import { useAccountStore } from './useAccountStore';
import { useProjectStore } from './useProjectStore';
import { repairPrompt } from '../utils/petstoryPrompts';
import { resolveTaskConversationTarget } from '../utils/taskConversationLocator';
import { canStartBoundChat } from '../utils/petstoryCandidate';
import { petStoryReadOnlyProductionTask } from '../utils/petstoryRecovery';
import { canSelectAccount, findInteractiveAccountId } from '../utils/interactiveAccount';

interface PetStoryState {
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
  /** 项目中恢复的能力只供文字方言；媒体须在当前会话重新核对。 */
  capabilityCheckedInSession: boolean;
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
  inspectCapability: (freeConfirmed: boolean, kind?: 'image' | 'video') => Promise<void>;
  setPlainReferences: (value: boolean) => void;
  setFallback: (shotId: string, mode?: 'first_frame' | 'reference') => void;
  previewProduction: () => Promise<void>;
  startProduction: () => Promise<void>;
  pauseProduction: () => Promise<void>;
  resumeProduction: () => Promise<void>;

  busy: boolean;
  error: string;
  freeChatConfirmed: boolean;
  autoRepair: boolean;
  setFreeChatConfirmed: (value: boolean) => void;
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
let promptBatchQueue: { projectId: string; targets: PromptBatchTarget[]; jobId?: string; stopRequested?: boolean } | null = null;
let activeProductionId: string | null = null;
let productionTickRunning = false;
const observingProductionTasks = new Set<string>();
/** 打开清单不启用接力；只在本会话一次确认或显式继续后推进。 */
export async function tickPetStoryProduction(): Promise<void> {
  const id = activeProductionId;
  const state = usePetStoryStore.getState();
  if (!id || state.project?.id !== id || state.busy || productionTickRunning) return;
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
    if (result.project) set({ project: result.project, projectName: result.displayName ?? (get().project?.id === result.project.id ? get().projectName : '') });
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
    if (!project || !job || job.endedWaitingAt || job.status !== 'bound') throw new Error('请选择原步骤');
    if (!project.mobileStory || job.sourceStoryId !== project.mobileStory.id) throw new Error('旧版链接直读任务已停用，请保存手机豆包故事后生成制作方案');
    if (!get().freeChatConfirmed) throw new Error('请本人确认当前普通Chat免费可用');
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
    if (!p || !job || !get().freeChatConfirmed) throw new Error('请先打开原项目并本人确认普通 Chat 免费可用');
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
    await startBound(job.id); return job.id;
  };
  const prepare = async (prompt: string, kind: PetStoryChatJob['kind'], parentJobId?: string, shotId?: string, promptKind?: PetStoryPromptKind, materialId?: string): Promise<string | undefined> => {
    const project = get().project;
    if (!project) throw new Error('请先打开或创建项目');
    if (!get().freeChatConfirmed) throw new Error('请先由本人确认当前普通Chat免费可用，未知时暂停');
    if (!useProjectStore.getState().projects.some((p): boolean => p.id === project.studioProjectId && !p.archived)) throw new Error('原 Studio 项目缺失或已归档');
    const account = useAccountStore.getState().accounts.find((a): boolean => a.id === project.accountId);
    if (!account || account.platform === 'dola') throw new Error('项目原豆包账号缺失，不能自动更换账号');
    const result = await window.electronAPI.petstory.prepareChat(project.id, prompt, kind, parentJobId, shotId, promptKind, materialId);
    return startPrepared(result);
  };
  const prepareRuntime = async (kind: PetStoryChatJob['kind'], target?: PetStoryRuntimeTarget): Promise<string | undefined> => {
    const project = get().project;
    if (!project) throw new Error('请先打开或创建项目');
    if (!get().freeChatConfirmed) throw new Error('请先确认当前普通 Chat 免费可用');
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
    try { await persistBatch('paused', batch.jobId); }
    finally {
      if (promptBatchQueue === batch) promptBatchQueue = null;
      set({ promptBatch: { ...get().promptBatch, status: 'paused' } });
    }
  };
  const nextPrompt = async (): Promise<void> => {
    const batch = promptBatchQueue; const p = get().project;
    if (!batch || !p || batch.projectId !== p.id) return;
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
  const resumePromptBatch = async (saved: PetStoryPromptBatch): Promise<void> => {
    const p = get().project; if (!p) return;
    const job = p.jobs.find((item): boolean => item.id === saved.jobId);
    promptBatchQueue = { projectId: p.id, targets: [...saved.targets], jobId: saved.jobId };
    set({ promptBatch: { total: saved.total, completed: saved.completed, status: 'running' } });
    if (job && !job.endedWaitingAt && ['bound', 'captured'].includes(job.status)) {
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
  return {
    savePromptModel: async (model?: PetStoryProject['promptModel']): Promise<void> => run(async (): Promise<void> => {
      await pauseBatch();
      const p = get().project; if (p) accept(await window.electronAPI.petstory.savePromptModel(p.id, p.revision, model));
    }),
    endChatWaiting: async (jobId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; if (!p) return;
      const result = await window.electronAPI.petstory.endChatWaiting(p.id, p.revision, jobId); accept(result);
      if (result.success) { liveJobs.delete(jobId); promptBatchQueue = null; set({ promptBatch: { ...get().promptBatch, status: 'paused' } }); }
    }),
    recoverChat: async (jobId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; const job = p?.jobs.find((item): boolean => item.id === jobId);
      if (!p || !job) throw new Error('请选择原任务');
      await refreshTasks();
      const task = useTaskStore.getState().tasks.find((item): boolean => item.id === job.taskId);
      if (!task?.runtime?.submittedAt || task.runtime.runId !== job.runId) throw new Error('没有已提交原运行，不能以恢复入口重新发送');
      if (task.runtime.chatResponse?.text) { accept(await window.electronAPI.petstory.collectChat(p.id, job.id)); return; }
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
    adoptPlanCandidate: async (jobId: string): Promise<void> => run(async (): Promise<void> => { const p = get().project; if (p) accept(await window.electronAPI.petstory.adoptPlanCandidate(p.id, p.revision, jobId)); }),
    adoptAssetsCandidate: async (jobId: string): Promise<void> => run(async (): Promise<void> => { const p = get().project; if (p) accept(await window.electronAPI.petstory.adoptAssetsCandidate(p.id, p.revision, jobId)); }),
    adoptPromptCandidate: async (jobId: string): Promise<void> => run(async (): Promise<void> => { const p = get().project; if (p) accept(await window.electronAPI.petstory.adoptPromptCandidate(p.id, p.revision, jobId)); }),
    reviewContent: async (target?: PetStoryRuntimeTarget): Promise<void> => run(async (): Promise<void> => { await prepareRuntime('review', target); }),
    reviseContent: async (reviewJobId: string, target: PetStoryRuntimeTarget): Promise<void> => run(async (): Promise<void> => { await prepareRuntime('revise', { ...target, parentJobId: reviewJobId }); }),
    stopPromptBatch: async (): Promise<void> => {
      if (promptBatchQueue) promptBatchQueue.stopRequested = true;
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
        if (!p || !capability || !get().capabilityCheckedInSession) throw new Error('请先在当前会话核对原账号的免费创作入口；已保存选择仅供文字创作');
        const result = await window.electronAPI.petstory.generateShotMedia(p.id, p.revision, shotId, kind, capability, get().fallbacks);
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
    project: null, projectName: '', capability: null, capabilityCheckedInSession: false, productionCounts: null, productionResolutions: {}, fallbacks: {},
    confirmStory: async (): Promise<void> => run(async (): Promise<void> => { const p = get().project; if (p) accept(await window.electronAPI.petstory.confirmStory(p.id, p.revision)); }),
    saveMaterialPrompt: async (materialId: string, final: string): Promise<void> => run(async (): Promise<void> => { const p = get().project; if (p) accept(await window.electronAPI.petstory.saveMaterialPrompt(p.id, p.revision, materialId, final)); }),
    addMaterialImage: async (materialId: string): Promise<void> => run(async (): Promise<void> => { const p = get().project; if (p) accept(await window.electronAPI.petstory.addMaterialImage(p.id, p.revision, materialId)); set({ productionCounts: null }); }),
    selectMaterialImage: async (materialId: string, assetId: string): Promise<void> => run(async (): Promise<void> => { const p = get().project; if (p) accept(await window.electronAPI.petstory.selectMaterialImage(p.id, p.revision, materialId, assetId)); set({ productionCounts: null }); }),
    approveMaterials: async (selections: { materialId: string; assetId: string }[]): Promise<void> => run(async (): Promise<void> => { const p = get().project; if (p) accept(await window.electronAPI.petstory.approveMaterials(p.id, p.revision, selections)); set({ productionCounts: null }); }),
    generateMaterials: async (materialIds: string[]): Promise<void> => {
      await run(async (): Promise<void> => {
        const p = get().project; const capability = get().capability;
        if (!p || !capability || !get().capabilityCheckedInSession) throw new Error('请先在当前会话核对原账号的免费图片入口；已保存选择仅供文字创作');
        const result = await window.electronAPI.petstory.generateMaterials(p.id, p.revision, materialIds, capability);
        accept(result); if (result.success) { activeProductionId = p.id; observingProductionTasks.clear(); set({ productionCounts: null }); }
      });
      await tickPetStoryProduction();
    },
    selectProductionImage: async (stepId: string, artifactId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (p) accept(await window.electronAPI.petstory.selectProductionImage(p.id, stepId, artifactId));
    }),
    inspectCapability: async (freeConfirmed: boolean, kind?: 'image' | 'video'): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (!p) throw new Error('请先打开原项目');
      const capability = await new Promise<PetStoryCapability>((resolve, reject): void => {
        const timeout = setTimeout((): void => reject(new Error('当前可见入口检查超时，仍记待确认，未上传或提交')), 60_000);
        window.dispatchEvent(new CustomEvent('petstory-inspect-capability', { detail: { accountId: p.accountId, freeConfirmed, kind,
          resolve: (value: PetStoryCapability): void => { clearTimeout(timeout); resolve(value); },
          reject: (error: Error): void => { clearTimeout(timeout); reject(error); } } }));
      });
      if (capability.accountId !== p.accountId) throw new Error('入口检查结果不属于项目原账号');
      set({ capability, capabilityCheckedInSession: true, productionCounts: null, productionResolutions: {} });
    }),
    setPlainReferences: (value: boolean): void => { const capability = get().capability; if (capability) set({ capability: { ...capability, allowPlainReferences: value }, productionCounts: null }); },
    setFallback: (shotId: string, mode?: 'first_frame' | 'reference'): void => {
      const fallbacks = { ...get().fallbacks };
      if (mode) fallbacks[shotId] = mode; else delete fallbacks[shotId];
      set({ fallbacks, productionCounts: null, productionResolutions: {} });
    },
    previewProduction: async (): Promise<void> => run(async (): Promise<void> => {
      const p = get().project; const capability = get().capability;
      if (!p || !capability || !get().capabilityCheckedInSession) throw new Error('请先在当前会话核对原账号的免费创作入口');
      const result = await window.electronAPI.petstory.previewProduction(p.id, capability, get().fallbacks);
      accept(result);
      set({ productionCounts: result.counts || null, productionResolutions: result.resolutions || {} });
    }),
    startProduction: async (): Promise<void> => {
      await run(async (): Promise<void> => {
        const p = get().project; const capability = get().capability;
        if (!p || !capability || !get().capabilityCheckedInSession || !get().productionCounts) throw new Error('请先在当前会话核对入口，再查看并确认制作数量');
        const result = await window.electronAPI.petstory.approveProduction(p.id, p.revision, capability, get().fallbacks);
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
        const readOnly = p && petStoryReadOnlyProductionTask(p, useTaskStore.getState().tasks);
        // 已发送／已完成原步骤可回读。未检查当前入口时抹去旧免费授权，后续新步骤仍由后端零提交阻断。
        const capability = get().capabilityCheckedInSession ? get().capability : readOnly && p?.production ? { ...p.production.capability, freeEvidence: 'unknown' as const } : null;
        if (!p || !capability) throw new Error('重新打开后请本人核对当前入口，再显式继续原制作');
        const result = await window.electronAPI.petstory.resumeProduction(p.id, capability);
        accept(result);
        if (result.success) { activeProductionId = p.id; observingProductionTasks.clear(); }
        await refreshTasks();
      });
      await tickPetStoryProduction();
    },
    busy: false, error: '', freeChatConfirmed: false, autoRepair: true,
    setFreeChatConfirmed: (value: boolean): void => set({ freeChatConfirmed: value }),
    setAutoRepair: (value: boolean): void => set({ autoRepair: value }),
    createProject: async (selection?: { accountId: string; studioProjectId: string }): Promise<void> => run(async (): Promise<void> => {
      await pauseBatch();
      activeProductionId = null; promptBatchQueue = null;
      set({ capability: null, capabilityCheckedInSession: false, productionCounts: null, fallbacks: {} });
      const accountId = selection ? selection.accountId : useAccountStore.getState().selectedAccountId;
      if (!accountId) throw new Error('请先选择已登录的豆包账号');
      const result = await window.electronAPI.petstory.create(selection ? selection.studioProjectId : useProjectStore.getState().activeProjectId, accountId);
      accept(result);
      if (result.success) { liveJobs.clear(); set({ freeChatConfirmed: false, promptBatch: { total: 0, completed: 0, status: 'idle' } }); }
    }),
    openProject: async (path?: string): Promise<void> => run(async (): Promise<void> => {
      await pauseBatch();
      activeProductionId = null; promptBatchQueue = null;
      liveJobs.clear();
      set({ freeChatConfirmed: false, capability: null, capabilityCheckedInSession: false, productionCounts: null, fallbacks: {} });
      const result = path === undefined ? await window.electronAPI.petstory.open() : await window.electronAPI.petstory.open(path);
      accept(result);
      if (result.project) {
        const project = result.project;
        set({ capability: project.promptCapability || null, capabilityCheckedInSession: false, promptBatch: project.promptBatch ? { total: project.promptBatch.total, completed: project.promptBatch.completed, status: project.promptBatch.status === 'complete' ? 'complete' : 'paused' } : { total: 0, completed: 0, status: 'idle' } });
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
        if (job.requestId) await prepareRuntime('repair', { parentJobId: job.id });
        else await prepare(repairPrompt(p, job), 'repair', job.id);
      }
    }),
    startBoundChat: async (jobId: string): Promise<void> => run((): Promise<void> => continueBoundChat(jobId)),
    retryUnsubmitted: async (jobId: string): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (!p || !get().freeChatConfirmed) throw new Error('请先打开原项目并本人确认普通 Chat 免费可用');
      const result = await window.electronAPI.petstory.retryUnsubmitted(p.id, jobId);
      accept(result);
      await refreshTasks();
      if (result.success) await startBound(jobId);
    }),
    collect: async (jobId: string, allowRepair = false): Promise<void> => run(async (): Promise<void> => {
      const p = get().project;
      if (!p) return;
      const result = await window.electronAPI.petstory.collectChat(p.id, jobId);
      accept(result);
      let repairJobId: string | undefined;
      if (!result.project?.jobs.find((item): boolean => item.id === jobId)?.endedWaitingAt && allowRepair && get().autoRepair && get().freeChatConfirmed && liveJobs.has(jobId) && result.needsRepair && result.project) {
        const job = result.project.jobs.find((j): boolean => j.id === jobId);
        if (job?.requestId) repairJobId = await prepareRuntime('repair', { parentJobId: job.id });
        else if (job) repairJobId = await prepare(repairPrompt(result.project, job), 'repair', job.id);
      }
      liveJobs.delete(jobId);
      if (promptBatchQueue?.jobId === jobId) {
        // 一次修订仍属于同一条文字目标，只有完整修订收取成功后才计数并继续。
        if (repairJobId) { promptBatchQueue.jobId = repairJobId; return; }
        if (!result.success) { await persistBatch('paused', jobId); promptBatchQueue = null; set({ promptBatch: { ...get().promptBatch, status: 'paused' } }); }
        else { promptBatchQueue.targets.shift(); set({ promptBatch: { ...get().promptBatch, completed: get().promptBatch.completed + 1 } }); await nextPrompt(); }
      }
    }),
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
  const interval = setInterval((): void => { void tickPetStoryProduction(); }, 1000);
  const unsubscribe = useTaskStore.subscribe((state): void => {
    void tickPetStoryProduction();
    const p = usePetStoryStore.getState();
    if (p.busy || !p.project) return;
    const batchJob = p.project.jobs.find((j): boolean => j.id === promptBatchQueue?.jobId);
    if (batchJob && state.tasks.some((t): boolean => t.id === batchJob.taskId && ['fail', 'paused', 'cancelled', 'waiting_verification'].includes(t.status))) {
      void p.stopPromptBatch();
    }
    const job = p.project.jobs.find((j): boolean => !j.endedWaitingAt && liveJobs.has(j.id) && !attempted.has(j.id) && j.status === 'bound' && state.tasks.some((t): boolean => t.id === j.taskId && t.status === 'done' && !!t.runtime?.chatResponse));
    if (!job) return;
    attempted.add(job.id);
    void p.collect(job.id, true);
  });
  return (): void => { clearInterval(interval); unsubscribe(); };
}
