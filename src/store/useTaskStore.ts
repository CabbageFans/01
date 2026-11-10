/**
 * src/store/useTaskStore.ts
 * 任务调度状态（Zustand） — V3 多账号并行 + 队列调度
 *
 * 改进：
 * - per-account 执行状态，不再全局单任务
 * - 账号忙时自动排队，空闲自动接下一个
 * - 不同账号的任务可以并行执行
 */

import { create } from 'zustand';
import type {
  Task,
  TaskStatus,
  GenerationMode,
  TaskUpdateInput,
  TaskErrorInfo,
  TaskRunSnapshot,
  TaskStage,
  TaskExecutionIntent,
  QualityRejectionTag,
} from '../types';
import { getAssignedAccountBlockReason } from '../utils/queueAccountDecision';
import { evaluateDependencies, isDependencyErrorCode } from '../utils/dependencyEval';
import { useAccountStore } from './useAccountStore';
import { automationEngine } from '../automation/AutomationEngine';
import { useProjectStore } from './useProjectStore';
import { findInteractiveAccountId } from '../utils/interactiveAccount';
import { hasPlatformAcceptance, renewObservationLease, shouldResumeAcceptedObservation } from '../utils/acceptedObservation';
import { canContinueUnsubmittedVerification, canRecoverTaskAfterVerification, hasVerificationRecoveryConflict, matchesVerificationRecoveryRun, verificationRecoveryInputMatches, type TaskVerificationRecoveryDetail, type UnsubmittedVerificationRecovery } from '../utils/verificationRecovery';
import { resolveTaskConversationTarget } from '../utils/taskConversationLocator';
import { runTaskDispatchGuards } from '../automation/taskDispatchGuards';
import { executionScopesConflict, getTaskAccountIdForScope, getTaskExecutionScope, isImageExecutionTask, IMAGE_EXECUTION_CONCURRENCY, tasksExecutionConflict } from '../utils/taskExecutionScope';
import { mergeTaskSnapshots } from '../utils/taskSnapshots';

let resumeAllInFlight: Promise<boolean> | null = null;
const verificationRecoveryInFlight = new Map<string, Promise<boolean>>();
const pendingCompletionWrites = new Map<string, { runId?: string; submittedAt?: string }>();
const startingAutomationTasks = new Set<string>();
const deletedTaskIds = new Set<string>();
/** 业务接力只读核对通用启动占位，不重复启动或撤销另一轮原任务。 */
export function isTaskAutomationStarting(taskId: string): boolean { return startingAutomationTasks.has(taskId); }

// 账号启动复检可能仍处于 unknown；队列遇到这种软阻断时不能永久停在那里。
// 只对已满足依赖的 queued 任务做有界退避复检，ready 后由现有调度继续。
const availabilityRetryAttempts = new Map<string, number>();
const availabilityRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

// 依赖阻断任务保持在 queued，因此仍会被队列扫描到。这里只保证在“没有其他调度触发”
// 的情况下也有一个有界的幂等重新评估机会，且同一时刻只排一个定时器。
/** 依赖前置可能在外部（其它窗口、CLI 或时间流逝）恢复，这里做固定周期复检。 */
export const dependencyRecheckDelayMs = 3_000;
let dependencyRecheckTimer: ReturnType<typeof setTimeout> | null = null;
let dependencyRecheckScheduled = false;

function scheduleDependencyRecheck(): void {
  if (dependencyRecheckScheduled) return;
  dependencyRecheckScheduled = true;
  dependencyRecheckTimer = setTimeout(() => {
    dependencyRecheckScheduled = false;
    dependencyRecheckTimer = null;
    void useTaskStore.getState().processQueue();
  }, dependencyRecheckDelayMs);
  const timer = dependencyRecheckTimer as unknown as { unref?: () => void };
  if (typeof timer.unref === 'function') timer.unref();
}


// ==================== 类型 ====================

/** 自动化执行状态 */
export type AutomationState = 'idle' | 'injecting' | 'submitting' | 'generating' | 'completed' | 'failed';
type PauseStatus = 'paused' | 'cancelled' | 'waiting_verification' | 'waiting_generation_confirmation' | 'manual_submission_observing';
const pauseStages: Record<PauseStatus, TaskStage> = {
  paused: 'paused', cancelled: 'cancelled', waiting_verification: 'waiting_verification',
  waiting_generation_confirmation: 'waiting_generation_confirmation', manual_submission_observing: 'manual_submission_observing',
};

interface TaskState {
  /** 所有任务列表 */
  tasks: Task[];
  loading: boolean;
  error: string | null;
  schedulerPaused: boolean;

  // ---- V3: 多账号并行执行 ----
  /** 执行槽正在运行的任务 ID；普通任务按账号，基础图片按账号/项目/素材。 */
  executingTasks: Record<string, string>;
  /** 每个账号是否正在忙碌 */
  accountBusy: Record<string, boolean>;
  /** 每个账号的自动化阶段（用于 UI 显示） */
  accountAutomationState: Record<string, AutomationState>;
  /** 每个账号的自动化消息 */
  accountAutoMessage: Record<string, string>;

  // 向后兼容（活跃账号的 automation 状态）
  activeTaskId: string | null;
  automationState: AutomationState;

  // ---- Actions ----
  loadTasks: (recoverInterrupted?: boolean) => Promise<void>;
  /** 正式列表和异步回执统一按 revision 合并。baseline 在发起 list 前取得。 */
  reconcileTasks: (tasks: Task[], baseline?: Task[]) => void;
  addTasks: (text: string, mode?: GenerationMode, videoConfig?: Task['videoConfig'], attachments?: string[], audioAttachment?: string) => Promise<Task[] | null>;
  importCsv: (filePath?: string) => Promise<{ tasks: Task[]; imported: number; skipped: number; errors: string[] } | null>;
  assignTask: (taskId: string, accountId: string) => Promise<boolean>;
  /** 将指定任务显式置为 armed；用于 CSV 明确执行和批量启动。 */
  armTasks: (taskIds: string[]) => Promise<{ armed: number; failed: number; error?: string }>;
  updateTaskStatus: (taskId: string, status: TaskStatus, result?: string, outputs?: string[]) => Promise<boolean>;
  updateTask: (taskId: string, updates: TaskUpdateInput) => Promise<boolean>;
  setQualityVerdict: (taskId: string, status: 'accepted' | 'rejected', rejectionTags?: QualityRejectionTag[]) => Promise<boolean>;
  deleteTask: (taskId: string) => Promise<boolean>;
  retryTask: (taskId: string) => Promise<boolean>;
  batchPause: () => Promise<boolean>;
  resumeAll: () => Promise<boolean>;
  /** 验证解除只恢复同账号原等待任务；已记录提交的运行仅接续只读观察。 */
  resumeAfterAccountVerification: (accountId: string, checkedAt: string) => Promise<boolean>;
  getCompletedOutputs: () => Promise<Array<{ taskId: string; prompt: string; outputs: string[]; accountId: string | null; mode: GenerationMode }>>;
  clearError: () => void;

  // V3 自动化方法
  startAutomation: (taskId: string, beforeDispatch?: (task: Task) => Promise<void>, verificationRecovery?: UnsubmittedVerificationRecovery) => Promise<boolean>;
  setAccountAutomationState: (accountId: string, state: AutomationState, message?: string, stage?: TaskStage, taskId?: string) => void;
  updateTaskRuntime: (taskId: string, patch: {
    expectedRunId?: string;
    expectedRevision?: number;
    status?: TaskStatus;
    runtime?: Partial<TaskRunSnapshot>;
    errorInfo?: TaskErrorInfo | null;
    executionIntent?: TaskExecutionIntent;
    blockedByTaskIds?: string[];
    result?: string;
  }) => Promise<boolean>;
  completeAutomation: (taskId: string, accountId: string, resultUrl: string, outputs?: string[], expectedRunId?: string) => Promise<void>;
  /** 持久化依赖阻断：写盘成功并回读一致后才更新界面，失败保持原状态 */
  markDependencyBlock: (
    taskId: string,
    block: { code: string; message: string; blockedByTaskIds: string[] },
  ) => Promise<boolean>;
  /** 依赖恢复后通过 Core/Repository 清除历史阻断；写失败返回 false 且保持原状态 */
  clearDependencyBlock: (taskId: string) => Promise<boolean>;
  pauseAutomation: (
    taskId: string,
    accountId: string,
    message?: string,
    options?: {
      expectedRunId?: string;
      endObservation?: boolean;
      status: PauseStatus;
      code?: string;
      generationConfirmation?: NonNullable<TaskRunSnapshot['generationConfirmation']>;
    },
  ) => Promise<void>;
  failAutomation: (taskId: string, accountId: string, errorMsg: string, errorInfo?: TaskErrorInfo, expectedRunId?: string) => Promise<void>;

  /** 处理队列：检查待执行任务，分配到空闲账号 */
  processQueue: () => Promise<void>;
  /** 获取指定账号的下一个排队任务 */
  getNextTaskForAccount: (accountId: string) => Task | null;
}

type TaskRuntimeWriteResult = Awaited<ReturnType<typeof window.electronAPI.tasks.updateRuntime>>;

/** 阶段上报只更新已有运行的阶段字段，提交与平台证据由各自正式入口负责。 */
function automationStageRuntimePatch(runtime: TaskRunSnapshot, state: AutomationState, stage?: TaskStage): Partial<TaskRunSnapshot> {
  return {
    stage: runtime.stage,
    message: runtime.message,
    stageStartedAt: runtime.stageStartedAt,
    lastHeartbeatAt: runtime.lastHeartbeatAt,
    ...(state === 'submitting' && stage === 'submitting' && runtime.submittedAt ? { submittedAt: runtime.submittedAt } : {}),
    ...(state === 'generating' && runtime.acceptanceObservation?.outcome === 'observing' ? { acceptanceObservation: runtime.acceptanceObservation } : {}),
  };
}

const runtimePersistState = new Map<string, { runId: string; stage?: TaskStage; savedAt: number }>();
const runtimeStageWrites = new Map<string, symbol>();
let queueProcessing = false;

function verificationRecoveryDispatchBlocked(state: TaskState, accountId: string): boolean {
  return state.schedulerPaused || Object.entries(state.accountBusy).some(([scope, busy]: [string, boolean]): boolean => busy && getTaskAccountIdForScope(scope) === accountId)
    || Object.keys(state.executingTasks).some((scope: string): boolean => getTaskAccountIdForScope(scope) === accountId)
    || Boolean(findInteractiveAccountId(state.accountAutomationState));
}

function executionSlotBusy(state: TaskState, task: Task): boolean {
  const scope = getTaskExecutionScope(task);
  return Object.entries(state.accountBusy).some(([otherScope, busy]: [string, boolean]): boolean => busy && executionScopesConflict(scope, otherScope))
    || Object.keys(state.executingTasks).some((otherScope: string): boolean => executionScopesConflict(scope, otherScope))
    || isImageExecutionTask(task) && imageExecutionCapacityReached(state, task);
}

/** 图片准备、生成和观察全局单行；已释放执行权的历史等待不占运行容量。 */
function imageExecutionCapacityReached(state: TaskState, task: Task): boolean {
  const occupiedScopes = new Set<string>();
  const imageScope = (scope: string): boolean => {
    const running = state.tasks.find((item: Task): boolean => item.id === state.executingTasks[scope]);
    return running ? isImageExecutionTask(running) : scope.startsWith('image:');
  };
  for (const [scope, taskId] of Object.entries(state.executingTasks)) {
    if (taskId !== task.id && imageScope(scope)) occupiedScopes.add(scope);
  }
  for (const [scope, busy] of Object.entries(state.accountBusy)) {
    if (busy && state.executingTasks[scope] !== task.id && imageScope(scope)) occupiedScopes.add(scope);
  }
  for (const other of state.tasks) {
    if (other.id === task.id || !isImageExecutionTask(other)) continue;
    if (['executing', 'generating', 'manual_submission_observing'].includes(other.status) || automationEngine.isReserved(other.id)) occupiedScopes.add(getTaskExecutionScope(other));
  }
  return occupiedScopes.size >= IMAGE_EXECUTION_CONCURRENCY;
}

/** 原受理证据继续防止重发；已完成或明确停止的图片不能因此永久占用账号。 */
function hasPendingAccountObservation(task: Task): boolean {
  if (task.status === 'done' || task.status === 'cancelled') return false;
  if (isImageExecutionTask(task) && task.status === 'paused' && task.executionIntent === 'hold' && task.errorInfo?.code === 'cancelled') return false;
  return task.runtime?.acceptanceObservation?.outcome === 'observing';
}

function conflictingExecutionTask(state: TaskState, task: Task): Task | undefined {
  return state.tasks.find((other: Task): boolean => other.id !== task.id && tasksExecutionConflict(other, task)
    && (['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'].includes(other.status)
      || hasPendingAccountObservation(other)));
}

/** 单图片模式下，忙碌拒绝必须发生在armed写盘前，不能暗中变成稍后启动的排队授权。 */
function imageStartBlockReason(state: TaskState, task: Task): string | null {
  if ([...startingAutomationTasks].some((id: string): boolean => id !== task.id) || findInteractiveAccountId(state.accountAutomationState)) {
    return '已有任务正在配置或提交，请等待完成后再开始图片任务';
  }
  if (executionSlotBusy(state, task) || conflictingExecutionTask(state, task)) return '已有图片或原账号任务正在处理，请等待完成或暂停后再开始';
  return null;
}

function executionScopeForTask(state: TaskState, taskId: string, accountId: string): string {
  const task = state.tasks.find((item: Task): boolean => item.id === taskId);
  return Object.entries(state.executingTasks).find((entry: [string, string]): boolean => entry[1] === taskId)?.[0]
    || (task ? getTaskExecutionScope(task) : accountId);
}

function accountHasExecutingScope(state: TaskState, accountId: string): boolean {
  return Object.keys(state.executingTasks).some((scope: string): boolean => getTaskAccountIdForScope(scope) === accountId);
}

/** 本地执行权可立即撤回；原任务是否暂停仍须等待权威写入，不能修改tasks来假装落盘。 */
function releaseStoppedExecutionScopes(state: TaskState, originals: readonly Task[]): Partial<TaskState> {
  const ids = new Set(originals.filter((original: Task): boolean => state.tasks.some((task: Task): boolean => task.id === original.id
    && task.runtime?.runId === original.runtime?.runId)).map((task: Task): string => task.id));
  const scopes = new Set(originals.filter((task: Task): boolean => ids.has(task.id)).map((task: Task): string => getTaskExecutionScope(task)));
  for (const [scope, taskId] of Object.entries(state.executingTasks)) if (ids.has(taskId)) scopes.add(scope);
  const keep = (entry: [string, unknown]): boolean => !scopes.has(entry[0]);
  const activeStopped = !!state.activeTaskId && ids.has(state.activeTaskId);
  return { executingTasks: Object.fromEntries(Object.entries(state.executingTasks).filter(keep)), accountBusy: Object.fromEntries(Object.entries(state.accountBusy).filter(keep)),
    accountAutomationState: Object.fromEntries(Object.entries(state.accountAutomationState).filter(keep)), accountAutoMessage: Object.fromEntries(Object.entries(state.accountAutoMessage).filter(keep)),
    ...(activeStopped ? { activeTaskId: null, automationState: 'idle' as const } : {}) };
}

/** 完成回执只能释放自己的槽；迟到回执不得覆盖后来运行的占位。 */
function completedExecutionScope(state: TaskState, scope: string, taskId: string): Pick<TaskState, 'executingTasks' | 'accountBusy' | 'accountAutomationState' | 'accountAutoMessage'> {
  const executingTasks = { ...state.executingTasks };
  const accountBusy = { ...state.accountBusy };
  const accountAutomationState = { ...state.accountAutomationState };
  const accountAutoMessage = { ...state.accountAutoMessage };
  if (!executingTasks[scope] || executingTasks[scope] === taskId) {
    delete executingTasks[scope];
    delete accountBusy[scope];
    accountAutomationState[scope] = 'completed';
    accountAutoMessage[scope] = '生成完成！';
  }
  return { executingTasks, accountBusy, accountAutomationState, accountAutoMessage };
}

/** 异步取锁与业务回读后，必须仍是同一份未发送任务；不能覆盖期间的暂停或输入变更。 */
function sameDispatchTask(current: Task | undefined, expected: Task, status: TaskStatus): current is Task {
  return !!current && current.status === status && current.executionIntent === 'armed' && !current.runtime?.submittedAt && !current.runtime?.chatResponse
    && current.assignedAccountId === expected.assignedAccountId && current.projectId === expected.projectId
    && current.prompt === expected.prompt && current.mode === expected.mode && current.audioAttachment === expected.audioAttachment
    && JSON.stringify(current.attachments || []) === JSON.stringify(expected.attachments || [])
    && JSON.stringify(current.videoConfig) === JSON.stringify(expected.videoConfig)
    && JSON.stringify(current.petstory) === JSON.stringify(expected.petstory)
    && JSON.stringify(current.petstoryChat) === JSON.stringify(expected.petstoryChat)
    && current.runtime?.runId === expected.runtime?.runId && JSON.stringify(current.runtime?.input) === JSON.stringify(expected.runtime?.input);
}

/** 完成写入回执不明时先回读，不能让异常恢复把实际已保存的 done 降为暂停。 */
async function completionWriteBlocksDowngrade(taskId: string, status: TaskStatus | undefined): Promise<boolean> {
  const pending = pendingCompletionWrites.get(taskId);
  if (!pending || status === undefined || status === 'done') return false;
  try {
    const task = (await window.electronAPI.tasks.list()).find((item: Task): boolean => item.id === taskId);
    if (task) useTaskStore.getState().reconcileTasks([task]);
    if (!task || task.runtime?.runId !== pending.runId || task.runtime?.submittedAt !== pending.submittedAt || task.status === 'done') pendingCompletionWrites.delete(taskId);
    else { pendingCompletionWrites.delete(taskId); return false; }
  } catch { /* 权威回读仍不可用，保留精确门闩；不假造 done，也不覆盖可能已经完成的任务。 */ }
  return true;
}

function completionReadbackMatches(task: Task | undefined, original: Task, accountId: string, outputs: string[]): task is Task {
  if (!task || task.id !== original.id || task.assignedAccountId !== accountId || task.status !== 'done'
    || task.runtime?.runId !== original.runtime?.runId || task.runtime?.submittedAt !== original.runtime?.submittedAt) return false;
  const expected = [...new Set(outputs)].sort(); const actual = [...new Set(task.outputs)].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  if (original.mode === 'chat') return !!task.runtime?.chatResponse?.text.trim() && task.runtime.chatResponse.text === original.runtime?.chatResponse?.text;
  const kind = original.mode === 'video' ? 'video' : original.mode === 'image' ? 'image' : 'file';
  return expected.length > 0 && expected.every((url: string): boolean => !!task.artifacts?.some((artifact): boolean => artifact.url === url
    && artifact.runId === original.runtime?.runId && artifact.kind === kind && !['invalid', 'expired'].includes(artifact.validation?.state || '')));
}

/** 判断任务是否处于依赖阻断态；只用于展示与重试门禁，不改变任务状态 */
export function isDependencyBlockedTask(task: Task | null | undefined): boolean {
  return isDependencyErrorCode(task?.errorInfo?.code);
}

/** 依赖阻断任务的统一用户可见文案 */
export function describeDependencyBlock(task: Task | null | undefined): string {
  const count = task?.blockedByTaskIds?.length || 0;
  const detail = count > 0 ? `（涉及 ${count} 个前置任务）` : '';
  switch (task?.errorInfo?.code) {
    case 'dependency_missing':
      return `依赖阻断：前置任务不存在，请检查工作流或 CSV${detail}`;
    case 'dependency_cycle':
      return `依赖阻断：存在自依赖或循环依赖${detail}`;
    default:
      return `依赖阻断：前置任务未成功，依赖恢复并重新评估后才会继续${detail}`;
  }
}

/** 依赖状态快照，用于序列化写入并检测并发漂移 */
interface DependencyStateSnapshot {
  status: TaskStatus;
  errorInfoCode: string | null | undefined;
  blockedByTaskIds: string[];
}

function dependencySnapshot(task: Task): DependencyStateSnapshot {
  return {
    status: task.status,
    errorInfoCode: task.errorInfo?.code,
    blockedByTaskIds: task.blockedByTaskIds || [],
  };
}

function dependenciesMatch(task: Task, expected: DependencyStateSnapshot): boolean {
  const actual = dependencySnapshot(task);
  if (actual.status !== expected.status) return false;
  if (actual.errorInfoCode !== expected.errorInfoCode) return false;
  if (actual.blockedByTaskIds.length !== expected.blockedByTaskIds.length) return false;
  return actual.blockedByTaskIds.every((id, index) => id === expected.blockedByTaskIds[index]);
}

async function readPersistedTask(taskId: string): Promise<Task | undefined> {
  return (await window.electronAPI.tasks.list()).find((task: Task): boolean => task.id === taskId);
}

/** 缺失/丢失ACK只允许回读原命令的落盘事实；Renderer不构造产物或授予版本。 */
function statusCommandReadbackMatches(written: Task | undefined, original: Task, status: TaskStatus, result?: string, outputs?: string[]): written is Task {
  if (!written || written.id !== original.id || written.assignedAccountId !== original.assignedAccountId
    || written.runtime?.runId !== original.runtime?.runId || written.status !== status
    || (written.revision || 0) < (original.revision || 0) || result !== undefined && written.result !== result) return false;
  if (outputs === undefined) return true;
  const expected = [...new Set(outputs.filter(Boolean))].sort(); const actual = [...new Set(written.outputs)].sort();
  return JSON.stringify(expected) === JSON.stringify(actual) && expected.every((url: string): boolean => !!written.artifacts?.some((artifact): boolean =>
    artifact.url === url && artifact.runId === original.runtime?.runId));
}

// evaluateDependencies 已抽取到 src/utils/dependencyEval.ts

// ==================== Store ====================

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: [],
  loading: false,
  error: null,
  schedulerPaused: false,
  executingTasks: {},
  accountBusy: {},
  accountAutomationState: {},
  accountAutoMessage: {},
  activeTaskId: null,
  automationState: 'idle',

  // ---- 基础操作 ----

  reconcileTasks: (tasks: Task[], baseline?: Task[]): void => {
    set({ tasks: mergeTaskSnapshots(get().tasks, tasks, baseline, deletedTaskIds) });
  },

  loadTasks: async (recoverInterrupted = false) => {
    const baseline = get().tasks;
    set({ loading: true, error: null });
    try {
      let tasks = await window.electronAPI.tasks.list();
      if (recoverInterrupted) {
        const resumableObservations = tasks.filter(shouldResumeAcceptedObservation);
        for (const task of resumableObservations) {
          const now = new Date().toISOString();
          await window.electronAPI.tasks.updateRuntime(task.id, {
            expectedRunId: task.runtime?.runId,
            status: 'manual_submission_observing',
            result: '应用界面重新载入，正在从原会话恢复只读产物观察',
            runtime: { stage: 'manual_submission_observing', message: '正在恢复只读产物观察', stageStartedAt: now, lastHeartbeatAt: now },
          });
          if (task.lock?.ownerId) await window.electronAPI.tasks.releaseLock(task.id, task.lock.ownerId);
        }
        const activeTasks = tasks.filter((task) =>
          ['executing', 'generating', 'waiting_verification'].includes(task.status) && !shouldResumeAcceptedObservation(task),
        );
        for (const task of activeTasks) {
          const now = new Date().toISOString();
          await window.electronAPI.tasks.updateRuntime(task.id, {
            expectedRunId: task.runtime?.runId,
            status: 'paused',
            result: '应用界面重新载入，任务已安全暂停',
            errorInfo: { code: 'cancelled', message: '应用界面重新载入，任务已安全暂停', recoverable: true, detectedAt: now },
            runtime: task.runtime ? { stage: 'paused', message: '应用界面重新载入，任务已安全暂停', stageStartedAt: now, lastHeartbeatAt: now } : undefined,
          });
          if (task.lock?.ownerId) {
            await window.electronAPI.tasks.releaseLock(task.id, task.lock.ownerId);
          }
        }
        if (activeTasks.length > 0 || resumableObservations.length > 0) tasks = await window.electronAPI.tasks.list();
      }
      // 新素材创建任务后的回读不能清掉其它图片仍持有的运行槽。
      set({ tasks: mergeTaskSnapshots(get().tasks, tasks, baseline, deletedTaskIds), loading: false, ...(recoverInterrupted ? { executingTasks: {}, accountBusy: {}, accountAutomationState: {}, accountAutoMessage: {} } : {}) });
    } catch (err: any) {
      set({ error: err.message, loading: false });
    }
  },

  addTasks: async (text: string, mode?: GenerationMode, videoConfig?: Task['videoConfig'], attachments?: string[], audioAttachment?: string) => {
    set({ error: null });
    const prompts = text
      .split('%%%%%%%%%%')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (prompts.length === 0) {
      set({ error: '请输入至少一条提示词' });
      return null;
    }

    try {
      const result = await window.electronAPI.tasks.add(prompts, mode, videoConfig, attachments, audioAttachment, useProjectStore.getState().activeProjectId);
      if (result.success && result.tasks) {
        get().reconcileTasks(result.tasks);
        return result.tasks;
      } else {
        set({ error: result.error || '添加失败' });
        return null;
      }
    } catch (err: any) {
      set({ error: err.message });
      return null;
    }
  },

  assignTask: async (taskId: string, accountId: string) => {
    set({ error: null });
    try {
      const result = await window.electronAPI.tasks.assign(taskId, accountId);
      const assignedTask = result.task;
      if (result.success && assignedTask) {
        get().reconcileTasks([assignedTask]);
        // 指派只改变账号绑定，不得触发队列、页面导航、提示词注入或平台请求。
        return true;
      }
      set({ error: result.error || '指派失败' });
      return false;
    } catch (err: any) {
      set({ error: err.message });
      return false;
    }
  },

  /** 显式执行授权：只持久化 executionIntent=armed，随后交给统一队列门禁。 */
  armTasks: async (taskIds: string[]) => {
    const ids = [...new Set(taskIds.filter(Boolean))];
    if (ids.length === 0) return { armed: 0, failed: 0 };
    const updated = new Map<string, Task>();
    const failures: string[] = [];
    for (const taskId of ids) {
      const result = await window.electronAPI.tasks.updateRuntime(taskId, { executionIntent: 'armed' });
      if (result.success && result.task) updated.set(taskId, result.task);
      else failures.push(result.error || taskId);
    }
    if (updated.size > 0) {
      get().reconcileTasks([...updated.values()]);
      setTimeout(() => get().processQueue(), 0);
    }
    if (failures.length > 0) {
      set({ error: `部分任务启动授权失败：${failures.slice(0, 2).join('；')}` });
    }
    const failedReason = failures.length > 0 ? failures.slice(0, 2).join('；') : undefined;
    return failedReason
      ? { armed: updated.size, failed: failures.length, error: failedReason }
      : { armed: updated.size, failed: failures.length };
  },

  updateTaskStatus: async (taskId: string, status: TaskStatus, result?: string, outputs?: string[]) => {
    const before = get().tasks.find((task: Task): boolean => task.id === taskId);
    if (!before) { set({ error: '任务不存在' }); return false; }
    let persisted: { success: boolean; task?: Task; error?: string } | undefined;
    try {
      persisted = await window.electronAPI.tasks.updateStatus(taskId, status, result, outputs, { expectedRunId: before.runtime?.runId, expectedRevision: before.revision });
    } catch { /* IPC回执丢失不代表未写盘；仅回读，不再次执行命令。 */ }
    if (persisted && !persisted.success) { set({ error: persisted.error || '任务状态写入失败' }); return false; }
    let written = persisted?.task;
    try { written ??= await readPersistedTask(taskId); }
    catch { set({ error: '任务状态写入尚未确认，无法读取原运行记录；请重试读取' }); return false; }
    const current = get().tasks.find((task: Task): boolean => task.id === taskId);
    if (!statusCommandReadbackMatches(written, before, status, result, outputs) || !current
      || current.runtime?.runId !== before.runtime?.runId || (current.revision || 0) > (written.revision || 0)) {
      set({ error: '任务状态未能按原运行和版本确认，未改写当前记录；请刷新核对' }); return false;
    }
    get().reconcileTasks([written]);
    return true;
  },

  importCsv: async (filePath?: string) => {
    const result = await window.electronAPI.tasks.importCsv(useProjectStore.getState().activeProjectId, filePath);
    if (!result.success || !result.tasks) {
      if (result.error) set({ error: result.error });
      return null;
    }
    get().reconcileTasks(result.tasks);
    // CSV 导入只创建 hold 任务；只有 UI 明确勾选导入后执行时才调用 armTasks。
    return { tasks: result.tasks, imported: result.imported || result.tasks.length, skipped: result.skipped || 0, errors: result.errors || [] };
  },

  updateTask: async (taskId: string, updates: TaskUpdateInput) => {
    set({ error: null });
    try {
      const result = await window.electronAPI.tasks.update(taskId, updates);
      if (!result.success || !result.task) {
        set({ error: result.error || '编辑任务失败' });
        return false;
      }
      get().reconcileTasks([result.task]);
      return true;
    } catch (err: any) {
      set({ error: err.message });
      return false;
    }
  },

  setQualityVerdict: async (taskId: string, status: 'accepted' | 'rejected', rejectionTags?: QualityRejectionTag[]) => {
    set({ error: null });
    try {
      const result = await window.electronAPI.tasks.setQualityVerdict(taskId, status, rejectionTags);
      const updatedTask = result.task;
      if (result.success && updatedTask) {
        get().reconcileTasks([updatedTask]);
        return true;
      }
      set({ error: result.error || '人工质量裁决写入失败' });
      return false;
    } catch (err: any) {
      set({ error: err.message });
      return false;
    }
  },

  deleteTask: async (taskId: string) => {
    set({ error: null });
    try {
      const result = await window.electronAPI.tasks.delete(taskId);
      if (result.success) {
        deletedTaskIds.add(taskId);
        const tasks = get().tasks.filter((t) => t.id !== taskId);
        set({ tasks });
        return true;
      } else {
        set({ error: result.error || '删除失败' });
        return false;
      }
    } catch (err: any) {
      set({ error: err.message });
      return false;
    }
  },

  retryTask: async (taskId: string) => {
    set({ error: null });
    try {
      const result = await window.electronAPI.tasks.retry(taskId);
      if (result.success && result.task) {
        get().reconcileTasks([result.task]);

        // 重试后统一由调度器决定是否启动，避免绕过依赖检查、账号健康检查和防重复处理
        setTimeout(() => get().processQueue(), 0);

        return true;
      } else {
        set({ error: result.error || '重试失败' });
        return false;
      }
    } catch (err: any) {
      set({ error: err.message });
      return false;
    }
  },

  batchPause: async () => {
    const before = get().tasks;
    const active = before.filter((task: Task): boolean => ['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'].includes(task.status));
    // 立即停本地调度与执行权；是否已经暂停只以主进程快照为准。
    set((state): Partial<TaskState> => ({ schedulerPaused: true, ...releaseStoppedExecutionScopes(state, active) }));
    for (const task of active) {
      automationEngine.abort(task.id);
      window.dispatchEvent(new CustomEvent('cancel-task-automation', { detail: { taskId: task.id, expectedRunId: task.runtime?.runId, targetStatus: 'paused' } }));
    }
    try {
      const result = await window.electronAPI.tasks.batchPause();
      if (!result.success) { set({ error: result.error || '批量暂停未保存；本地执行已停止，请重试保存' }); return false; }
      const snapshots = result.tasks || await window.electronAPI.tasks.list();
      get().reconcileTasks(snapshots);
      const unsettled = active.some((original: Task): boolean => {
        const task = get().tasks.find((item: Task): boolean => item.id === original.id);
        return !!task && (task.runtime?.runId !== original.runtime?.runId || !['paused', 'done', 'cancelled', 'fail'].includes(task.status)
          || task.status === 'paused' && (task.runtime?.acceptanceObservation?.outcome === 'observing' || task.runtime?.manualObservation?.outcome === 'observing'));
      });
      if (unsettled) { set({ error: '部分原运行尚未确认暂停，已保留权威记录；请刷新核对或重试保存' }); return false; }
      return true;
    } catch { set({ error: '批量暂停尚未确认；本地执行已停止，请重试保存暂停记录' }); return false; }
  },

  resumeAll: (): Promise<boolean> => {
    if (resumeAllInFlight) return resumeAllInFlight;
    resumeAllInFlight = (async (): Promise<boolean> => {
      try {
        const tasks = await window.electronAPI.tasks.list();
        const resumed = new Map<string, Task>();
        const failures: string[] = [];
        for (const task of tasks.filter((item: Task): boolean => item.status === 'paused')) {
          const accepted = hasPlatformAcceptance(task);
          // “继续”不授予重发许可。结果不确定的已提交任务必须留在原会话人工核对。
          if (task.runtime?.submittedAt && !accepted) {
            failures.push(`任务 ${task.id.slice(0, 8)} 已提交，请核对原会话；未重新发送`);
            continue;
          }
          if (task.lock?.ownerId) {
            const released = await window.electronAPI.tasks.releaseLock(task.id, task.lock.ownerId);
            if (!released.success) {
              failures.push(`任务 ${task.id.slice(0, 8)} 执行锁未释放`);
              continue;
            }
          }
          const result = await window.electronAPI.tasks.updateRuntime(task.id, {
            expectedRunId: task.runtime?.runId,
            status: accepted ? 'manual_submission_observing' : 'queued',
            executionIntent: task.executionIntent === 'armed' ? 'armed' : 'hold',
            runtime: task.runtime ? {
              stage: accepted ? 'manual_submission_observing' : 'queued',
              message: accepted ? '继续核对原会话，不重复发送' : '等待原执行意图的队列评估',
            } : undefined,
          });
          if (result.success && result.task) resumed.set(task.id, result.task);
          else failures.push(result.error || `任务 ${task.id.slice(0, 8)} 恢复失败`);
        }
        set({
          schedulerPaused: false,
          tasks: mergeTaskSnapshots(get().tasks, [...resumed.values()], undefined, deletedTaskIds),
          error: failures.length > 0 ? `部分任务未恢复：${failures.slice(0, 2).join('；')}` : null,
        });
        setTimeout((): void => { void get().processQueue(); }, 0);
        return failures.length === 0;
      } catch {
        set({ error: '无法回读原任务，队列继续保持暂停' });
        return false;
      }
    })().finally((): void => { resumeAllInFlight = null; });
    return resumeAllInFlight;
  },

  resumeAfterAccountVerification: (accountId: string, checkedAt: string): Promise<boolean> => {
    const pending = verificationRecoveryInFlight.get(accountId);
    if (pending) return pending;
    const operation = (async (): Promise<boolean> => {
      try {
        const state = get();
        if (verificationRecoveryDispatchBlocked(state, accountId)) return false;
        const waiting = state.tasks.filter((task: Task): boolean => task.assignedAccountId === accountId && task.status === 'waiting_verification');
        if (waiting.length !== 1) return false;
        const task = waiting[0];
        const expectedRunId = task.runtime?.runId;
        const expectedSubmittedAt = task.runtime?.submittedAt;
        if (!expectedRunId) return false;
        const expected = { taskId: task.id, accountId, runId: expectedRunId, submittedAt: expectedSubmittedAt };
        const readyAccount = (): boolean => canRecoverTaskAfterVerification(task,
          useAccountStore.getState().accounts.find((account): boolean => account.id === accountId), checkedAt);
        // 回读真实任务后再次核对本地状态，不能用页面探测前的旧 task/run 恢复后来任务。
        const storedTasks = await window.electronAPI.tasks.list();
        const stored = storedTasks.find((item: Task): boolean => item.id === task.id);
        const latest = get().tasks.find((item: Task): boolean => item.id === task.id);
        const account = useAccountStore.getState().accounts.find((item): boolean => item.id === accountId);
        const originalWaiting = (item: Task | undefined): item is Task => matchesVerificationRecoveryRun(item, expected)
          && canRecoverTaskAfterVerification(item, account, checkedAt) && verificationRecoveryInputMatches(item);
        if (!originalWaiting(stored) || !originalWaiting(latest) || verificationRecoveryDispatchBlocked(get(), accountId)
          || automationEngine.isReserved(task.id)) return false;
        if (hasVerificationRecoveryConflict(get().tasks, accountId, task.id) || hasVerificationRecoveryConflict(storedTasks, accountId, task.id)) return false;
        const submitted = Boolean(stored.runtime?.submittedAt || stored.runtime?.acceptanceObservation);
        const status = submitted ? 'manual_submission_observing' : 'executing';
        const now = new Date().toISOString();
        const recoveryMessage = '人工验证已解除，正在继续只读检查原结果，不会重新发送';
        const saved = submitted ? await get().updateTaskRuntime(task.id, {
          status: 'manual_submission_observing', errorInfo: null, result: recoveryMessage,
          runtime: { stage: 'manual_submission_observing', message: recoveryMessage, stageStartedAt: now, lastHeartbeatAt: now },
        }) : await get().startAutomation(task.id, undefined, { runId: expectedRunId, checkedAt });
        const recovered = get().tasks.find((item: Task): boolean => item.id === task.id);
        if (!saved || !readyAccount() || !matchesVerificationRecoveryRun(recovered, expected) || recovered.status !== status
          || !verificationRecoveryInputMatches(recovered)) return false;
        const detail: TaskVerificationRecoveryDetail = { taskId: task.id, accountId, runId: recovered.runtime.runId,
          submittedAt: recovered.runtime.submittedAt, verificationCheckedAt: checkedAt };
        window.dispatchEvent(new CustomEvent('task-verification-recovery-started', { detail }));
        if (submitted) {
          const target = resolveTaskConversationTarget(recovered);
          window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: {
            ...detail, useCurrentPage: !target.ok && target.reason === 'CONVERSATION_URL_MISSING',
          } }));
        }
        return true;
      } catch (error: unknown) {
        set({ error: error instanceof Error ? error.message : '人工验证恢复状态暂未确认，原任务未重新发送' });
        return false;
      }
    })();
    verificationRecoveryInFlight.set(accountId, operation);
    void operation.finally((): void => { if (verificationRecoveryInFlight.get(accountId) === operation) verificationRecoveryInFlight.delete(accountId); });
    return operation;
  },

  getCompletedOutputs: async () => {
    return window.electronAPI.tasks.getCompletedOutputs();
  },

  clearError: () => set({ error: null }),

  // ---- V3 自动化方法 ----

  startAutomation: async (taskId: string, beforeDispatch?: (task: Task) => Promise<void>, verificationRecovery?: UnsubmittedVerificationRecovery) => {
    // 在首次异步写入前占位，不能让队列或另一个按钮越过本次业务绑定。
    if (startingAutomationTasks.has(taskId)) {
      set({ error: '该任务正在启动，请等待原启动完成' });
      return false;
    }
    startingAutomationTasks.add(taskId);
    try {
    if (get().schedulerPaused) {
      set({ error: '任务调度已暂停' });
      return false;
    }
    let task = get().tasks.find((t) => t.id === taskId);
    if (!task || !task.assignedAccountId) {
      console.warn('[TaskStore] startAutomation: 任务未指派账号', taskId);
      set({ error: task ? '任务尚未指派账号' : '任务不存在' });
      return false;
    }
    const expectedStatus = verificationRecovery ? 'waiting_verification' : 'queued';
    if (task.status !== expectedStatus) {
      set({ error: '只有排队中的任务可以启动' });
      return false;
    }
    if (!isImageExecutionTask(task) && findInteractiveAccountId(get().accountAutomationState)) {
      set({ error: '另一账号正在配置或提交，请等待其进入生成阶段' });
      return false;
    }
    if (verificationRecovery && !canContinueUnsubmittedVerification(task,
      useAccountStore.getState().accounts.find((account): boolean => account.id === task?.assignedAccountId), verificationRecovery)) return false;
    if (task.runtime?.submittedAt || task.runtime?.chatResponse) {
      set({ error: '原任务已有提交或回复证据，请只读检查原结果；不会重新发送' });
      return false;
    }
    if (isImageExecutionTask(task)) {
      const blocked = imageStartBlockReason(get(), task);
      if (blocked) { set({ error: blocked }); return false; }
    }

    // 显式启动必须先持久化 armed，写失败则绝不进入账号与页面动作。
    if (task.executionIntent !== 'armed') {
      const armResult = await window.electronAPI.tasks.updateRuntime(taskId, { executionIntent: 'armed' });
      if (!armResult.success || !armResult.task) {
        set({ error: armResult.error || '执行意图写入失败' });
        return false;
      }
      const armedTask = armResult.task;
      task = armedTask;
      get().reconcileTasks([armedTask]);
    }

    if (!task.assignedAccountId) {
      set({ error: '任务尚未指派账号' });
      return false;
    }

    const dependency = evaluateDependencies(task, get().tasks);
    if (dependency.state !== 'ready') {
      set({ error: dependency.message || '任务依赖尚未就绪' });
      setTimeout(() => get().processQueue(), 0);
      return false;
    }

    // 依赖恢复后必须通过 Core/Repository 清空历史阻断；清理写入成功并回读一致才允许启动。
    if (task.blockedByTaskIds?.length) {
      const cleared = await get().clearDependencyBlock(taskId);
      if (!cleared) {
        // 清理失败或并发漂移：保持原状态与原错误，绝不启动，也不并发发起启动写入。
        set({ error: useTaskStore.getState().error || '依赖阻断清理失败，任务保持原状态' });
        return false;
      }
    }
    const refreshed = get().tasks.find((item) => item.id === taskId);
    if (!refreshed || refreshed.status !== expectedStatus) {
      set({ error: '任务状态在依赖清理后发生变化，已停止启动' });
      return false;
    }
    task = refreshed;

    if (!task.assignedAccountId) {
      set({ error: '任务尚未指派账号' });
      return false;
    }

    const accountId = task.assignedAccountId;
    const assignedAccount = useAccountStore.getState().accounts.find((account) => account.id === accountId);
    const accountBlockReason = getAssignedAccountBlockReason(assignedAccount);
    if (accountBlockReason) {
      console.warn('[TaskStore] 账号不可调度:', accountBlockReason, accountId);
      set({ error: accountBlockReason });
      setTimeout(() => get().processQueue(), 0);
      return false;
    }

    // 检查账号是否忙碌
    const reservedTask = conflictingExecutionTask(get(), refreshed);
    if (reservedTask) {
      set({ error: '该账号仍绑定生成确认或人工提交观察会话；请先完成只读回读或人工取消' });
      return false;
    }
    if (executionSlotBusy(get(), task)) {
      console.log('[TaskStore] 账号', accountId, '忙碌，任务排队');
      set({ error: '该账号正在执行其他任务' });
      return false;
    }

    const runId = verificationRecovery?.runId || `${taskId}-${Date.now()}`;
    const reservation = await automationEngine.reserve(taskId, accountId, runId, task);
    if (!reservation.ok) {
      set({ error: reservation.error || '任务锁定失败' });
      return false;
    }
    const reservedState = get();
    const reservedSnapshot = reservedState.tasks.find((item): boolean => item.id === taskId);
    if (reservedState.schedulerPaused || !sameDispatchTask(reservedSnapshot, task, expectedStatus)
      || executionSlotBusy(reservedState, task) || findInteractiveAccountId(reservedState.accountAutomationState)) {
      await automationEngine.release(taskId);
      set({ error: '取得执行锁期间任务或调度状态已变化，原任务保留且未发送' });
      return false;
    }
    task = reservedSnapshot;
    // 验证等待期间的原未发送运行只续用原租约标识；异步取锁后再查一次，不能接管已提交或后来运行。
    const currentVerificationTask = get().tasks.find((item): boolean => item.id === taskId);
    if (verificationRecovery && (!currentVerificationTask || !canContinueUnsubmittedVerification(currentVerificationTask,
      useAccountStore.getState().accounts.find((account): boolean => account.id === accountId), verificationRecovery))) {
      await automationEngine.release(taskId);
      return false;
    }
    if (verificationRecovery && currentVerificationTask) task = currentVerificationTask;

    const now = new Date().toISOString();
    const startedTask: Task = {
      ...task,
      status: 'executing',
      result: null,
      errorInfo: undefined,
      blockedByTaskIds: undefined,
      runtime: verificationRecovery && task.runtime ? {
        ...task.runtime,
        stage: 'preparing_account', message: '人工验证已解除，继续原未发送运行', stageStartedAt: now, lastHeartbeatAt: now,
      } : {
        runId,
        attempt: (task.runtime?.attempt || 0) + 1,
        stage: 'preparing_account',
        message: '准备执行',
        startedAt: now,
        stageStartedAt: now,
        lastHeartbeatAt: now,
        input: {
          videoInputSnapshot: task.videoInputSnapshot ? structuredClone(task.videoInputSnapshot) : undefined,
          prompt: task.prompt,
          mode: task.mode,
          videoConfig: task.videoConfig,
          attachments: [...(task.attachments || [])],
          audioAttachment: task.audioAttachment,
          petstory: task.petstory,
          promptReadback: task.promptReadback,
        },
      },
      updatedAt: now,
    };

    // 启动写入必须持久化成功并回读一致；失败时释放预留、保持排队状态且不更新界面。
    const startWritten = await get().updateTaskRuntime(taskId, {
      status: 'executing',
      runtime: verificationRecovery ? {
        stage: 'preparing_account', message: '人工验证已解除，继续原未发送运行', stageStartedAt: now, lastHeartbeatAt: now,
      } : startedTask.runtime,
      errorInfo: null,
      blockedByTaskIds: [],
      result: '',
    });
    if (!startWritten) {
      await automationEngine.release(taskId);
      return false;
    }
    let runningTask = get().tasks.find((item) => item.id === taskId) || startedTask;

    // 启动入口统一执行正式绑定，任务中心、队列和本机控制都不能绕过。
    {
      try {
        await runTaskDispatchGuards(runningTask);
        if (beforeDispatch) await beforeDispatch(runningTask);
        const state = get();
        const latest = state.tasks.find((item): boolean => item.id === taskId);
        const interactive = findInteractiveAccountId(state.accountAutomationState);
        if (state.schedulerPaused || !sameDispatchTask(latest, runningTask, 'executing') || latest.runtime?.runId !== runId
          || executionSlotBusy(state, runningTask) || interactive) {
          throw new Error('运行绑定期间任务或调度状态已变化，未向页面发送');
        }
        runningTask = latest;
      }
      catch (error: unknown) {
        const message = error instanceof Error ? error.message : '业务运行绑定失败';
        const latest = get().tasks.find((item): boolean => item.id === taskId);
        // 不覆盖绑定等待期间已经暂停、完成或换成另一运行的权威状态。
        if (latest?.runtime?.runId === runId && latest.status === 'executing' && !latest.runtime.submittedAt) {
          // 正式绑定门禁尚未发布执行状态，页面从未取得本次运行；保存可恢复的派发前原因。
          await get().updateTaskRuntime(taskId, { status: 'paused', executionIntent: 'hold',
            errorInfo: { code: 'dispatch_not_ready', message, recoverable: true, detectedAt: new Date().toISOString() },
            runtime: { stage: 'paused', message } });
        }
        await automationEngine.release(taskId);
        set({ error: message });
        return false;
      }
    }

    console.log('[TaskStore] 启动任务', taskId, '在账号', accountId);
    void window.electronAPI.logs.append({ level: 'info', scope: 'automation', message: '任务开始执行', taskId, runId, accountId,
      projectId: runningTask.petstory?.projectId || runningTask.projectId, stepId: runningTask.petstory?.stepId, shotId: runningTask.runtime?.input.videoInputSnapshot?.shotId });

    const executionScope = getTaskExecutionScope(runningTask);
    set({
      tasks: mergeTaskSnapshots(get().tasks, [runningTask], undefined, deletedTaskIds),
      executingTasks: { ...get().executingTasks, [executionScope]: taskId },
      accountBusy: { ...get().accountBusy, [executionScope]: true },
      accountAutomationState: { ...get().accountAutomationState, [executionScope]: 'injecting' },
      accountAutoMessage: { ...get().accountAutoMessage, [executionScope]: '准备执行...' },
      // 向后兼容
      activeTaskId: taskId,
      automationState: 'injecting',
    });

    return true;
    } finally { startingAutomationTasks.delete(taskId); }
  },

  markDependencyBlock: async (taskId, block) => {
    const blockedByTaskIds = [...new Set(block.blockedByTaskIds.filter(Boolean))].sort();
    const now = new Date().toISOString();
    const current = get().tasks.find((task) => task.id === taskId);
    if (!current || current.status !== 'queued') {
      set({ error: '只有排队中的任务可以写入依赖阻断' });
      return false;
    }
    // 幂等：已经处于相同依赖阻断态时不再重复写盘。
    // 依赖阻断保持 queued（不写 fail），否则调度器与重试入口都会永久跳过它。
    if (current.errorInfo?.code === block.code
      && current.errorInfo?.message === block.message
      && dependenciesMatch(current, {
        status: 'queued',
        errorInfoCode: block.code,
        blockedByTaskIds,
      })) {
      return true;
    }
    return get().updateTaskRuntime(taskId, {
      status: 'queued',
      result: block.message,
      errorInfo: { code: block.code, message: block.message, recoverable: false, detectedAt: now },
      blockedByTaskIds,
    });
  },

  clearDependencyBlock: async (taskId) => {
    const current = get().tasks.find((task) => task.id === taskId);
    // 幂等：没有历史阻断时无需写入。
    if (!current?.blockedByTaskIds?.length) return true;
    // 阻断恢复必须在一次写入里原子转回可调度的 queued 并清除阻断证据。
    return get().updateTaskRuntime(taskId, {
      status: 'queued',
      result: '',
      errorInfo: null,
      blockedByTaskIds: [],
    });
  },

  setAccountAutomationState: (accountId: string, state: AutomationState, message?: string, stage?: TaskStage, explicitTaskId?: string) => {
    const scope = explicitTaskId ? executionScopeForTask(get(), explicitTaskId, accountId) : accountId;
    if (explicitTaskId && get().executingTasks[scope] && get().executingTasks[scope] !== explicitTaskId) return;
    const previousState = get().accountAutomationState[scope];
    const taskId = explicitTaskId || get().executingTasks[scope];
    const now = new Date().toISOString();
    const status: TaskStatus | undefined = stage === 'waiting_verification' || stage === 'waiting_generation_confirmation'
      ? stage
      : state === 'generating'
        ? 'generating'
        : state === 'injecting' || state === 'submitting'
          ? 'executing'
          : undefined;
    const tasks = taskId
      ? get().tasks.map((task) => task.id === taskId
        ? {
            ...task,
            status: status || task.status,
            runtime: task.runtime ? {
              ...task.runtime,
              stage: stage || task.runtime.stage,
              message: message ?? task.runtime.message,
              stageStartedAt: stage && stage !== task.runtime.stage ? now : task.runtime.stageStartedAt,
              lastHeartbeatAt: now,
              acceptanceObservation: state === 'generating' && task.runtime.acceptanceObservation?.outcome === 'observing'
                ? renewObservationLease(task.runtime.acceptanceObservation, now)
                : task.runtime.acceptanceObservation,
            } : task.runtime,
            updatedAt: now,
          }
        : task)
      : get().tasks;
    set({
      accountAutomationState: { ...get().accountAutomationState, [scope]: state },
      accountAutoMessage: message !== undefined
        ? { ...get().accountAutoMessage, [scope]: message }
        : get().accountAutoMessage,
    });
    if (taskId) {
      const task = tasks.find((item) => item.id === taskId);
      const previousPersist = runtimePersistState.get(taskId);
      const shouldPersist = !!task?.runtime && (
        previousPersist?.runId !== task.runtime.runId ||
        previousPersist?.stage !== task.runtime.stage ||
        Date.now() - (previousPersist?.savedAt || 0) >= 15_000 ||
        state === 'failed' ||
        state === 'completed'
      );
      if (task?.runtime && shouldPersist) {
        const runId = task.runtime.runId;
        const token = Symbol('stage-write');
        runtimeStageWrites.set(taskId, token);
        // 阶段投影只能写自己的字段；归一化快照含有专用保护与证据，不能整体回传。
        const runtime = automationStageRuntimePatch(task.runtime, state, stage);
        void window.electronAPI.tasks.updateRuntime(taskId, {
          expectedRunId: runId,
          status,
          runtime,
        }).then((result: TaskRuntimeWriteResult): void => {
          const current = get().tasks.find((item): boolean => item.id === taskId)?.runtime;
          if (current?.runId !== runId || runtimeStageWrites.get(taskId) !== token) return;
          if (!result.success || result.task?.runtime?.runId !== runId || result.task.runtime.stage !== runtime.stage) {
            set({ error: result.error || '任务阶段写入回读不一致，未确认保存' });
            void get().pauseAutomation(taskId, accountId, result.error || '任务阶段保存失败，本地执行已停止', { status: 'paused', code: 'runtime_save_failed' }).catch((error: unknown): void => {
              set({ error: error instanceof Error ? error.message : '停止状态未确认保存，请重试保存' });
            });
            return;
          }
          get().reconcileTasks([result.task]);
          // 失败不占用节流记录；仅确认原运行真实落盘后才抑制同阶段心跳。
          runtimePersistState.set(taskId, { runId, stage: runtime.stage, savedAt: Date.now() });
        }).catch((error: unknown): void => {
          const current = get().tasks.find((item): boolean => item.id === taskId)?.runtime;
          if (current?.runId === runId && runtimeStageWrites.get(taskId) === token) {
            const message = error instanceof Error ? error.message : '任务阶段保存失败';
            set({ error: message });
            void get().pauseAutomation(taskId, accountId, message, { status: 'paused', code: 'runtime_save_failed' }).catch((reason: unknown): void => {
              set({ error: reason instanceof Error ? reason.message : '停止状态未确认保存，请重试保存' });
            });
          }
        });
      }
    }
    if (state === 'generating' && previousState !== 'generating') {
      setTimeout(() => get().processQueue(), 0);
    }
  },

  updateTaskRuntime: async (taskId, patch) => {
    if (await completionWriteBlocksDowngrade(taskId, patch.status)) {
      set({ error: '原完成写入尚待核对或已经完成，未覆盖为其他状态；不会重新发送' });
      return false;
    }
    const previous = get().tasks.find((task) => task.id === taskId);
    if (!previous) {
      set({ error: '任务不存在' });
      return false;
    }
    let result: { success: boolean; task?: Task; error?: string };
    try {
      result = await window.electronAPI.tasks.updateRuntime(taskId, { ...patch, expectedRunId: patch.expectedRunId ?? previous.runtime?.runId });
    } catch (err: any) {
      set({ error: err?.message || '任务运行状态写入失败' });
      return false;
    }
    const written = result.task;
    // 写盘确实失败且主进程没有回读结果：界面保持写入前的原状态。
    if (!written) {
      set({ error: result.error || '任务运行状态写入失败' });
      return false;
    }
    // 并发冲突：写盘已发生，主进程如实返回权威回读状态。
    // 此时必须让界面与落盘事实一致，并显示冲突错误——不得宣称“已保持原状态”。
    if (!result.success) {
      set({
        tasks: mergeTaskSnapshots(get().tasks, [written], undefined, deletedTaskIds),
        error: result.error || '任务状态已被并发修改，已同步落盘状态',
      });
      return false;
    }
    if (patch.runtime?.chatResponse && written.runtime?.chatResponse?.text !== patch.runtime.chatResponse.text) {
      set({ error: 'Chat 正文未确认落盘，已停止且不重发' });
      return false;
    }
    // 只校验本次显式请求的字段（与 TaskService.readBackMatches 同一口径）：
    // 未请求的字段不参与比较，明确请求清空的字段才要求回读为空。
    if (patch.status !== undefined && written.status !== patch.status) {
      set({
        tasks: mergeTaskSnapshots(get().tasks, [written], undefined, deletedTaskIds),
        error: '任务状态与请求不一致，已同步落盘状态',
      });
      return false;
    }
    if (patch.errorInfo !== undefined) {
      const expectedCode = patch.errorInfo === null ? null : patch.errorInfo.code;
      if ((written.errorInfo?.code ?? null) !== expectedCode) {
        set({
          tasks: mergeTaskSnapshots(get().tasks, [written], undefined, deletedTaskIds),
          error: '任务错误信息与请求不一致，已同步落盘状态',
        });
        return false;
      }
    }
    if (patch.blockedByTaskIds !== undefined) {
      const expectedIds = [...new Set(patch.blockedByTaskIds.filter(Boolean))].sort();
      const actualIds = written.blockedByTaskIds || [];
      if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
        set({
          tasks: mergeTaskSnapshots(get().tasks, [written], undefined, deletedTaskIds),
          error: '任务依赖阻断记录与请求不一致，已同步落盘状态',
        });
        return false;
      }
    }
    get().reconcileTasks([written]);
    const merged = get().tasks.find((task: Task): boolean => task.id === taskId);
    if (!merged || merged.runtime?.runId !== written.runtime?.runId || patch.status !== undefined && merged.status !== patch.status) return false;
    return true;
  },

  completeAutomation: async (taskId: string, accountId: string, resultUrl: string, outputs?: string[], expectedRunId?: string) => {
    const finalOutputs = outputs && outputs.length > 0 ? outputs : resultUrl ? [resultUrl] : [];
    const current = get().tasks.find((task) => task.id === taskId);
    if (!current || current.assignedAccountId !== accountId) throw new Error('原任务或账号已变化，未绑定完成结果');
    if (expectedRunId !== undefined && expectedRunId !== current.runtime?.runId) throw new Error('原任务运行已变化，未绑定迟到结果');
    if (current?.mode === 'chat' && !current.runtime?.chatResponse?.text.trim()) throw new Error('Chat 最终正文尚未保存，不能标记完成');
    void window.electronAPI.logs.append({ level: 'info', scope: 'automation', message: current?.mode === 'chat' ? 'Chat 最终正文已保存' : `任务完成，发现 ${finalOutputs.length} 个产物`, taskId, runId: current.runtime?.runId, accountId });
    pendingCompletionWrites.set(taskId, { runId: current.runtime?.runId, submittedAt: current.runtime?.submittedAt });
    let authoritative: Task | undefined;
    try {
      const statusSaved = await window.electronAPI.tasks.updateStatus(taskId, 'done', resultUrl, finalOutputs, { expectedRunId: current.runtime?.runId });
      if (!statusSaved.success) throw new Error('任务完成状态保存失败，保留原结果且不得重发');
      authoritative = statusSaved.task || (await window.electronAPI.tasks.list()).find((task: Task): boolean => task.id === taskId);
      if (authoritative) get().reconcileTasks([authoritative]);
      if (!completionReadbackMatches(authoritative, current, accountId, finalOutputs)) throw new Error('任务完成结果与原运行的权威回读不一致，保留原结果且不得重发');
      pendingCompletionWrites.delete(taskId);
    } catch (error: unknown) {
      try {
        authoritative = (await window.electronAPI.tasks.list()).find((task: Task): boolean => task.id === taskId);
        if (authoritative) get().reconcileTasks([authoritative]);
        pendingCompletionWrites.delete(taskId);
      } catch { /* 写入可能已经成功；门闩阻止随后异常恢复覆盖未知的完成状态。 */ }
      // 完成命令的ACK可能丢失；原运行的完整落盘证据已经确认时，应正常释放本地执行槽。
      if (!completionReadbackMatches(authoritative, current, accountId, finalOutputs)) {
        const latest = get().tasks.find((task: Task): boolean => task.id === taskId);
        if (latest?.runtime?.runId === current.runtime?.runId) {
          const scope = executionScopeForTask(get(), taskId, accountId);
          const executingTasks = { ...get().executingTasks }; const accountBusy = { ...get().accountBusy };
          if (executingTasks[scope] === taskId) { delete executingTasks[scope]; delete accountBusy[scope]; }
          set({ executingTasks, accountBusy, error: '原完成回执尚未确认，本地执行已停止；请检查原结果，不会重新发送' });
        }
        throw error;
      }
    }
    if (get().tasks.find((task: Task): boolean => task.id === taskId)?.runtime?.runId !== current.runtime?.runId) return;
    const tasks = get().tasks;

    // 只释放本任务的素材槽；同账号其它图片的执行与观察继续保留。
    const scope = executionScopeForTask(get(), taskId, accountId);
    const completedScope = completedExecutionScope(get(), scope, taskId);

    // 向后兼容：如果完成的是活跃任务
    const isActive = get().activeTaskId === taskId;

    set({
      tasks,
      ...completedScope,
      activeTaskId: isActive ? null : get().activeTaskId,
      automationState: isActive ? 'completed' : get().automationState,
    });

    // 更新账号状态
    if (!accountHasExecutingScope(get(), accountId)) void window.electronAPI.accounts.setStatus(accountId, 'idle');

    // 延迟后清理完成状态 + 处理队列
    setTimeout(() => {
      const s = get();
      const cleanState = { ...s.accountAutomationState };
      const cleanMsg = { ...s.accountAutoMessage };
      if (!s.executingTasks[scope] && cleanState[scope] === 'completed') {
        cleanState[scope] = 'idle';
        cleanMsg[scope] = '';
      }
      set({
        accountAutomationState: cleanState,
        accountAutoMessage: cleanMsg,
      });
      // 处理队列：检查是否有排队任务可以启动
      get().processQueue();
      // 前序进入终态后，被其阻断的后继必须获得一次重新评估机会。
      scheduleDependencyRecheck();
    }, 2000);
  },

  pauseAutomation: async (
    taskId: string,
    accountId: string,
    pauseMessage = '用户已暂停',
    options?: {
      expectedRunId?: string;
      endObservation?: boolean;
      status: PauseStatus;
      code?: string;
      generationConfirmation?: NonNullable<TaskRunSnapshot['generationConfirmation']>;
    },
  ) => {
    const expectedRunId = get().tasks.find((task: Task): boolean => task.id === taskId)?.runtime?.runId;
    if (options?.expectedRunId !== undefined && options.expectedRunId !== expectedRunId) return;
    // 本地停止不等待 IPC；写盘失败时保留原事实并显示可重试原因。
    automationEngine.abort(taskId);
    if (await completionWriteBlocksDowngrade(taskId, options?.status || 'paused')) return;
    void window.electronAPI.logs.append({ level: 'warn', scope: 'automation', message: pauseMessage, taskId, runId: expectedRunId, accountId });
    const now = new Date().toISOString();
    const originalRuntime = get().tasks.find((task: Task): boolean => task.id === taskId)?.runtime;
    const targetStatus: PauseStatus = options?.status || 'paused';
    const targetStage = pauseStages[targetStatus];
    const errorInfo: TaskErrorInfo = {
      code: options?.code || 'cancelled',
      message: pauseMessage,
      recoverable: true,
      detectedAt: now,
    };
    const persisted = await get().updateTaskRuntime(taskId, {
      expectedRunId,
      status: targetStatus,
      result: pauseMessage,
      errorInfo,
      runtime: {
        stage: targetStage,
        message: pauseMessage,
        stageStartedAt: now,
        lastHeartbeatAt: now,
        ...(options?.generationConfirmation ? { generationConfirmation: options.generationConfirmation } : {}),
        ...(options?.endObservation && originalRuntime?.acceptanceObservation ? { acceptanceObservation: {
          ...originalRuntime.acceptanceObservation, outcome: 'manual_review',
          lease: { ...originalRuntime.acceptanceObservation.lease, expiresAt: now, lastHeartbeatAt: now },
        } } : {}),
        ...(options?.endObservation && originalRuntime?.manualObservation ? { manualObservation: { ...originalRuntime.manualObservation, outcome: 'manual_review', lastCheckedAt: now } } : {}),
      },
    });

    if (get().tasks.find((task: Task): boolean => task.id === taskId)?.runtime?.runId !== expectedRunId) return;

    const scope = executionScopeForTask(get(), taskId, accountId);
    const newExecuting = { ...get().executingTasks };
    const newBusy = { ...get().accountBusy };
    const ownsScope = !newExecuting[scope] || newExecuting[scope] === taskId;
    if (ownsScope) { delete newExecuting[scope]; delete newBusy[scope]; }
    set({
      ...(persisted ? {} : { error: `${get().error || '暂停状态未保存'}；本地执行已停止，请重试保存暂停状态` }),
      executingTasks: newExecuting,
      accountBusy: newBusy,
      accountAutomationState: ownsScope ? { ...get().accountAutomationState, [scope]: 'idle' } : get().accountAutomationState,
      accountAutoMessage: ownsScope ? { ...get().accountAutoMessage, [scope]: pauseMessage } : get().accountAutoMessage,
      activeTaskId: get().activeTaskId === taskId ? null : get().activeTaskId,
      automationState: get().activeTaskId === taskId ? 'idle' : get().automationState,
    });
    if (!accountHasExecutingScope(get(), accountId)) void window.electronAPI.accounts.setStatus(accountId, 'idle');
  },

  failAutomation: async (taskId: string, accountId: string, errorMsg: string, errorInfo?: TaskErrorInfo, originalRunId?: string) => {
    const expectedRunId = get().tasks.find((task: Task): boolean => task.id === taskId)?.runtime?.runId;
    if (originalRunId !== undefined && originalRunId !== expectedRunId) return;
    automationEngine.abort(taskId);
    if (await completionWriteBlocksDowngrade(taskId, 'fail')) return;
    void window.electronAPI.logs.append({ level: 'error', scope: errorInfo?.code || 'automation', message: errorMsg, taskId, runId: expectedRunId, accountId });
    const now = new Date().toISOString();
    const persisted = await get().updateTaskRuntime(taskId, {
      expectedRunId,
      status: 'fail',
      result: errorMsg,
      errorInfo: errorInfo || null,
      runtime: { stage: 'failed', message: errorMsg, stageStartedAt: now, lastHeartbeatAt: now },
    });

    if (get().tasks.find((task: Task): boolean => task.id === taskId)?.runtime?.runId !== expectedRunId) return;

    const scope = executionScopeForTask(get(), taskId, accountId);
    const newExecuting = { ...get().executingTasks };
    const newBusy = { ...get().accountBusy };
    const newAutoState = { ...get().accountAutomationState };
    const newAutoMsg = { ...get().accountAutoMessage };
    if (!newExecuting[scope] || newExecuting[scope] === taskId) {
      delete newExecuting[scope];
      delete newBusy[scope];
      newAutoState[scope] = 'failed';
      newAutoMsg[scope] = errorMsg;
    }

    const isActive = get().activeTaskId === taskId;

    set({
      ...(persisted ? {} : { error: `${get().error || '失败状态未保存'}；本地执行已停止，请重试保存状态` }),
      executingTasks: newExecuting,
      accountBusy: newBusy,
      accountAutomationState: newAutoState,
      accountAutoMessage: newAutoMsg,
      activeTaskId: isActive ? null : get().activeTaskId,
      automationState: isActive ? 'failed' : get().automationState,
    });

    if (!accountHasExecutingScope(get(), accountId)) void window.electronAPI.accounts.setStatus(accountId, 'idle');

    // 延迟后清理 + 处理队列
    setTimeout(() => {
      const s = get();
      const cleanState = { ...s.accountAutomationState };
      const cleanMsg = { ...s.accountAutoMessage };
      if (!s.executingTasks[scope] && cleanState[scope] === 'failed') {
        cleanState[scope] = 'idle';
        cleanMsg[scope] = '';
      }
      set({
        accountAutomationState: cleanState,
        accountAutoMessage: cleanMsg,
      });
      get().processQueue();
      // 前序进入终态后，被其阻断的后继必须获得一次重新评估机会。
      scheduleDependencyRecheck();
    }, 3000);
  },

  // ---- 队列调度 ----

  processQueue: async () => {
    if (queueProcessing) return;
    queueProcessing = true;
    try {
      const initialState = get();
      if (initialState.schedulerPaused) return;
      if (findInteractiveAccountId(initialState.accountAutomationState)) return;

      // A：只处理已指派、queued 且显式 armed 的任务；hold/历史缺失意图 fail-closed。
      const queuedIds = initialState.tasks
        .filter((t) => t.status === 'queued' && t.assignedAccountId && t.executionIntent === 'armed')
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .map((task) => task.id);

      for (const taskId of queuedIds) {
        const task = get().tasks.find((item) => item.id === taskId);
        if (!task || task.status !== 'queued' || !task.assignedAccountId || task.executionIntent !== 'armed') continue;

        const dependency = evaluateDependencies(task, get().tasks);

        if (dependency.state === 'ready') {
          if (task.blockedByTaskIds?.length) {
            // 恢复：用一次写入原子转回可调度的 queued 并清除阻断证据。
            // 清理与启动严格串行：清理写入成功并回读一致后才继续，失败保持原状态。
            const cleared = await get().clearDependencyBlock(taskId);
            if (!cleared) {
              scheduleDependencyRecheck();
              continue;
            }
          }
        } else if (dependency.state === 'waiting') {
          // 合法等待：不写失败也不写阻断。旧阻断已不成立时清除陈旧证据后继续本轮判断。
          if (task.blockedByTaskIds?.length) {
            if (!(await get().clearDependencyBlock(taskId))) {
              scheduleDependencyRecheck();
              continue;
            }
          } else {
            continue;
          }
        } else {
          // 缺失 / 循环 / 前置不可满足：幂等写入结构化阻断原因。
          // 任务始终保持 queued，依赖恢复后仍会被本调度器重新评估。
          const message = dependency.message || '依赖状态异常';
          const code = dependency.code || 'dependency_failed';
          const blockedByTaskIds = dependency.blockedByTaskIds || [];
          // 先成功写盘并回读，再让界面呈现阻断；写失败保持原状态。
          await get().markDependencyBlock(taskId, { code, message, blockedByTaskIds });
          scheduleDependencyRecheck();
          // 阻断任务绝不能在本轮继续走到启动分支。
          continue;
        }

        const latestTask = get().tasks.find((item) => item.id === taskId);
        if (!latestTask || latestTask.status !== 'queued' || !latestTask.assignedAccountId) continue;
        const accountId = latestTask.assignedAccountId;
        const accountHasObservation = get().tasks.some((item) =>
          item.id !== taskId && tasksExecutionConflict(item, latestTask) &&
          hasPendingAccountObservation(item),
        );
        if (accountHasObservation) continue;
        const account = useAccountStore.getState().accounts.find((item) => item.id === accountId);
        const availabilityState = account?.health?.availability?.state;
        if (availabilityState === 'unknown') {
          const attempts = availabilityRetryAttempts.get(accountId) || 0;
          if (attempts < 30) {
            availabilityRetryAttempts.set(accountId, attempts + 1);
            useAccountStore.getState().requestAvailabilityCheck(accountId);
            if (!availabilityRetryTimers.has(accountId)) {
              const delay = Math.min(30_000, 2_000 * 2 ** Math.min(attempts, 4));
              const timer = setTimeout(() => {
                availabilityRetryTimers.delete(accountId);
                void get().processQueue();
              }, delay);
              availabilityRetryTimers.set(accountId, timer);
            }
          }
          continue;
        }
        availabilityRetryAttempts.delete(accountId);

        if (getAssignedAccountBlockReason(account)) {
          continue;
        }
        if (!executionSlotBusy(get(), latestTask)) {
          console.log('[TaskStore] 队列调度：启动任务', taskId, '在账号', accountId);
          const started = await get().startAutomation(taskId);
          if (started) {
            // 接受排队不等于已经派发；等待正在准备的任务进入生成后再唤醒，避免空转。
            if (get().tasks.find((item: Task): boolean => item.id === taskId)?.status !== 'queued') setTimeout(() => { void get().processQueue(); }, 0);
            return;
          }
        }
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('[TaskStore] 队列调度异常：', err);
      set({ error: `任务调度异常：${error}` });
    } finally {
      queueProcessing = false;
    }
  },

  getNextTaskForAccount: (accountId: string) => {
    const tasks = get().tasks;
    return tasks.find(
        (t) => t.status === 'queued' && t.assignedAccountId === accountId && t.executionIntent === 'armed'
    ) || null;
  },
}));
