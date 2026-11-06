/** 离线验证解除回归：真实页面就绪由替身提供，不触发平台输入、导航或发送。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskUpdateRuntimeParams } from '@doubao-studio/contracts';
import type { Account, Task } from '../../src/types';
import { automationEngine } from '../../src/automation/AutomationEngine';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useTaskStore } from '../../src/store/useTaskStore';

const checkedAt = '2026-11-01T00:00:04.000Z';
const blockedAt = '2026-11-01T00:00:00.000Z';
const accountId = 'OFFLINE-verification-account';
const taskId = 'OFFLINE-verification-task';
let stored: Task[];
const dispatch = vi.fn();
const patch = vi.fn();
const list = vi.fn();

function readyAccount(): Account {
  return { id: accountId, name: 'OFFLINE', platform: 'doubao', avatar: '', partition: `persist:${accountId}`, status: 'idle', pinned: false,
    createdAt: blockedAt, updatedAt: checkedAt,
    health: { loginState: 'ok', verificationRequired: false, consecutiveFailures: 0, successCount: 0, failureCount: 0,
      availability: { state: 'ready', reason: 'ready', message: 'OFFLINE', checkedAt, source: 'navigation' } } };
}

function waitingTask(submitted: boolean = true): Task {
  return { id: taskId, prompt: 'OFFLINE完整原始输入', mode: 'chat', assignedAccountId: accountId, status: 'waiting_verification', executionIntent: 'armed',
    result: 'OFFLINE等待用户验证', outputs: [], createdAt: blockedAt, updatedAt: blockedAt,
    errorInfo: { code: 'human_verification', message: 'OFFLINE', recoverable: true, detectedAt: blockedAt },
    runtime: { runId: 'OFFLINE-original-run', attempt: 3, stage: 'waiting_verification', message: 'OFFLINE', startedAt: blockedAt,
      stageStartedAt: blockedAt, lastHeartbeatAt: blockedAt, submittedAt: submitted ? blockedAt : undefined,
      input: { prompt: 'OFFLINE完整原始输入', mode: 'chat', attachments: [] } } };
}

function setTasks(tasks: Task[]): void {
  stored = structuredClone(tasks);
  useTaskStore.setState({ tasks: structuredClone(tasks) });
}

function events(): CustomEvent[] {
  return dispatch.mock.calls.map((call: unknown[]): CustomEvent => call[0] as CustomEvent);
}

beforeEach((): void => {
  vi.useFakeTimers(); vi.setSystemTime('2026-11-01T00:00:05.000Z');
  dispatch.mockReset();
  list.mockReset().mockImplementation(async (): Promise<Task[]> => structuredClone(stored));
  patch.mockReset().mockImplementation(async (id: string, updates: Omit<TaskUpdateRuntimeParams, 'taskId'>): Promise<object> => {
    const current = stored.find((task: Task): boolean => task.id === id);
    if (!current) return { success: false };
    const task: Task = { ...current, status: updates.status || current.status, result: updates.result ?? current.result,
      executionIntent: updates.executionIntent || current.executionIntent,
      errorInfo: updates.errorInfo === null ? undefined : updates.errorInfo || current.errorInfo,
      runtime: updates.runtime ? { ...current.runtime, ...updates.runtime } as NonNullable<Task['runtime']> : current.runtime };
    stored = stored.map((item: Task): Task => item.id === id ? task : item);
    return { success: true, task: structuredClone(task) };
  });
  vi.stubGlobal('window', { dispatchEvent: dispatch, electronAPI: { tasks: { list, updateRuntime: patch }, logs: { append: vi.fn(async (): Promise<void> => undefined) } } });
  vi.spyOn(automationEngine, 'isReserved').mockReturnValue(false);
  vi.spyOn(automationEngine, 'reserve').mockResolvedValue({ ok: true });
  vi.spyOn(automationEngine, 'release').mockResolvedValue(undefined);
  useAccountStore.setState({ accounts: [readyAccount()], selectedAccountId: accountId });
  useTaskStore.setState({ schedulerPaused: false, executingTasks: {}, accountBusy: {}, accountAutomationState: {}, accountAutoMessage: {}, activeTaskId: null, automationState: 'idle', error: null });
  setTasks([waitingTask()]);
});

afterEach((): void => {
  useTaskStore.setState({ tasks: [], schedulerPaused: false, executingTasks: {}, accountBusy: {}, accountAutomationState: {}, accountAutoMessage: {}, activeTaskId: null, automationState: 'idle', error: null });
  useAccountStore.setState({ accounts: [], selectedAccountId: null });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('验证解除后的原已提交运行仅恢复只读观察', (): void => {
  it.each([false, true])('会话地址已保存=%s：保存manual观察，精确保留原run和提交后派恢复与只读事件', async (hasConversation: boolean): Promise<void> => {
    const task = waitingTask();
    if (hasConversation && task.runtime) task.runtime.conversationUrl = 'https://www.doubao.com/chat/OFFLINE-original';
    setTasks([task]);
    expect(await useTaskStore.getState().resumeAfterAccountVerification(accountId, checkedAt)).toBe(true);
    const current = useTaskStore.getState().tasks[0];
    expect(current).toMatchObject({ status: 'manual_submission_observing', executionIntent: 'armed', runtime: {
      runId: 'OFFLINE-original-run', attempt: 3, submittedAt: blockedAt, input: task.runtime?.input,
    } });
    expect(current.runtime?.acceptanceObservation).toBeUndefined();
    expect(automationEngine.reserve).not.toHaveBeenCalled();
    expect(events().map((event: CustomEvent): string => event.type)).toEqual(['task-verification-recovery-started', 'reconcile-task-submission']);
    expect(events()[0].detail).toEqual({ taskId, accountId, runId: 'OFFLINE-original-run', submittedAt: blockedAt, verificationCheckedAt: checkedAt });
    expect(events()[1].detail).toEqual({ ...events()[0].detail, useCurrentPage: !hasConversation });
    expect(await useTaskStore.getState().resumeAfterAccountVerification(accountId, checkedAt)).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('同账号的重叠ready回读只执行一次恢复写入和一次只读派发', async (): Promise<void> => {
    const first = useTaskStore.getState().resumeAfterAccountVerification(accountId, checkedAt);
    const second = useTaskStore.getState().resumeAfterAccountVerification(accountId, checkedAt);
    expect(first).toBe(second); expect(await first).toBe(true);
    expect(patch).toHaveBeenCalledOnce(); expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('状态持久化失败保持原等待，不派只读事件也不重发', async (): Promise<void> => {
    patch.mockResolvedValue({ success: false, error: 'OFFLINE-disk' });
    expect(await useTaskStore.getState().resumeAfterAccountVerification(accountId, checkedAt)).toBe(false);
    expect(useTaskStore.getState().tasks[0].status).toBe('waiting_verification'); expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('原未提交运行通过正式执行门禁续用原run', (): void => {
  it('同task/run/attempt/input续执行，不创建新任务或丢掉原PetStory运行绑定', async (): Promise<void> => {
    const task = waitingTask(false); task.promptReadback = 'exact';
    if (task.runtime) task.runtime.input.promptReadback = 'exact';
    setTasks([task]);
    const originalTask = useTaskStore.getState().tasks[0];
    expect(await useTaskStore.getState().resumeAfterAccountVerification(accountId, checkedAt)).toBe(true);
    const current = useTaskStore.getState().tasks[0];
    expect(current).toMatchObject({ id: taskId, status: 'executing', runtime: {
      runId: 'OFFLINE-original-run', attempt: 3, stage: 'preparing_account', input: task.runtime?.input,
    } });
    expect(current.runtime?.submittedAt).toBeUndefined();
    expect(automationEngine.reserve).toHaveBeenCalledOnce();
    expect(automationEngine.reserve).toHaveBeenCalledWith(taskId, accountId, 'OFFLINE-original-run', task);
    expect(vi.mocked(automationEngine.reserve).mock.calls[0][3]).toBe(originalTask);
    expect(useTaskStore.getState().executingTasks[accountId]).toBe(taskId);
    expect(useTaskStore.getState().accountBusy[accountId]).toBe(true);
    expect(events().map((event: CustomEvent): string => event.type)).toEqual(['task-verification-recovery-started']);
    expect(events()[0].detail.runId).toBe('OFFLINE-original-run');
  });

  it('原先hold的未提交任务不会因为ready而获得armed', async (): Promise<void> => {
    const task = waitingTask(false); task.executionIntent = 'hold'; setTasks([task]);
    expect(await useTaskStore.getState().resumeAfterAccountVerification(accountId, checkedAt)).toBe(false);
    expect(patch).not.toHaveBeenCalled(); expect(automationEngine.reserve).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });

  it('正式依赖尚未成功时不续执行', async (): Promise<void> => {
    const task = waitingTask(false); task.dependsOnTaskIds = ['OFFLINE-missing-dependency']; setTasks([task]);
    expect(await useTaskStore.getState().resumeAfterAccountVerification(accountId, checkedAt)).toBe(false);
    expect(automationEngine.reserve).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });

  it('正式执行锁无法取得时保持验证等待', async (): Promise<void> => {
    setTasks([waitingTask(false)]); vi.mocked(automationEngine.reserve).mockResolvedValue({ ok: false, error: 'OFFLINE-lease' });
    expect(await useTaskStore.getState().resumeAfterAccountVerification(accountId, checkedAt)).toBe(false);
    expect(patch).not.toHaveBeenCalled(); expect(useTaskStore.getState().tasks[0].status).toBe('waiting_verification');
  });

  it('等取锁时后来出现提交意图，不允许原未提交恢复再次进入发送流程', async (): Promise<void> => {
    setTasks([waitingTask(false)]);
    vi.mocked(automationEngine.reserve).mockImplementation(async (): Promise<{ ok: boolean }> => {
      const task = waitingTask(true); setTasks([task]); return { ok: true };
    });
    expect(await useTaskStore.getState().resumeAfterAccountVerification(accountId, checkedAt)).toBe(false);
    expect(automationEngine.release).toHaveBeenCalledWith(taskId); expect(patch).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('验证解除恢复只作用于精确原账号和原运行', (): void => {
  it.each(['paused', 'cancelled', 'done', 'fail', 'queued'] as const)('用户已改为%s的任务不自动唤醒', async (status): Promise<void> => {
    const task = waitingTask(); task.status = status; setTasks([task]);
    expect(await useTaskStore.getState().resumeAfterAccountVerification(accountId, checkedAt)).toBe(false);
    expect(patch).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(['wrong-account', 'old-check', 'still-verifying', 'unknown', 'explicit-scheduler-pause', 'other-task', 'adjustment', 'changed-input', 'other-reason', 'new-run'] as const)('遇到%s保持原状态，不接管其他账号、草稿或运行', async (condition): Promise<void> => {
    const task = waitingTask(); const account = readyAccount();
    let requestedCheckedAt = checkedAt;
    if (condition === 'wrong-account') task.assignedAccountId = 'OFFLINE-other-account';
    if (condition === 'old-check') requestedCheckedAt = blockedAt;
    if (condition === 'still-verifying' && account.health) account.health.verificationRequired = true;
    if (condition === 'unknown' && account.health?.availability) account.health.availability.state = 'unknown';
    if (condition === 'explicit-scheduler-pause') useTaskStore.setState({ schedulerPaused: true });
    if (condition === 'changed-input') task.prompt = 'OFFLINE后来改过的输入';
    if (condition === 'other-reason' && task.errorInfo) task.errorInfo.code = 'page_unrecognized';
    if (condition === 'adjustment' && task.runtime) task.runtime.chatAdjustmentGuard = { projectId: 'OFFLINE', adjustmentId: 'OFFLINE', active: true };
    setTasks([task]); useAccountStore.setState({ accounts: [account] });
    if (condition === 'other-task') setTasks([task, { ...waitingTask(), id: 'OFFLINE-other-task', status: 'executing' }]);
    if (condition === 'new-run') {
      const persisted = structuredClone(task); if (persisted.runtime) persisted.runtime.runId = 'OFFLINE-newer-run';
      list.mockResolvedValue([persisted]);
    }
    expect(await useTaskStore.getState().resumeAfterAccountVerification(accountId, requestedCheckedAt)).toBe(false);
    expect(patch).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(automationEngine.reserve).not.toHaveBeenCalled();
  });

  it('ready检测先于本次验证阻断时不能唤醒任务', async (): Promise<void> => {
    const task = waitingTask(); if (task.errorInfo) task.errorInfo.detectedAt = '2026-11-01T00:00:04.500Z'; setTasks([task]);
    expect(await useTaskStore.getState().resumeAfterAccountVerification(accountId, checkedAt)).toBe(false);
    expect(patch).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });
});
