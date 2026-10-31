/** 真实 Core → renderer 回读 → 正式调度链；不打开平台、不产生网络提交。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Task, TaskUpdateRuntimeParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import type { TaskServiceResult } from '../../main/core/TaskService';
import { automationEngine } from '../../src/automation/AutomationEngine';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';

const initial = { tasks: useTaskStore.getState(), accounts: useAccountStore.getState() };
const now = '2026-10-31T02:00:00.000Z';
let persisted: Task[]; let core: TaskService; let account: Account;
const acquire = vi.fn();
function source(status: 'waiting_verification' | 'waiting_generation_confirmation'): Task {
  return { id: 'TEST-source', assignedAccountId: 'TEST-account', status, executionIntent: 'armed', mode: 'image', projectId: 'TEST-studio', prompt: 'TEST原运行请求', result: 'TEST受理不明', outputs: [], createdAt: now, updatedAt: now,
    runtime: { runId: 'TEST-original-run', attempt: 1, submittedAt: now, stage: status, message: 'TEST原运行记录保留', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { mode: 'image', prompt: 'TEST原运行请求', attachments: [] } } };
}
function resultForRenderer(result: TaskServiceResult<Task>): { success: boolean; task?: Task; error?: string } {
  return result.success ? { success: true, task: result.data } : { success: false, error: result.error };
}
async function resubmit(status: 'waiting_verification' | 'waiting_generation_confirmation' = 'waiting_verification'): Promise<{ original: Task; child: Task }> {
  const original = source(status); persisted = [structuredClone(original)];
  const result = core.resubmitUncertain({ taskId: original.id, runId: original.runtime!.runId, submittedAt: now, authorizationId: 'TEST-once', acceptDuplicateRisk: true });
  expect(result.success).toBe(true); if (!result.success) throw new Error('TEST Core授权失败');
  await useTaskStore.getState().loadTasks();
  return { original, child: result.data };
}
beforeEach((): void => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(now)); vi.clearAllMocks(); persisted = [];
  core = new TaskService({ store: { read: (): Task[] => structuredClone(persisted), replace: (tasks: Task[]): boolean => { persisted = structuredClone(tasks); return true; } },
    defaultProjectId: (): string => 'TEST-studio', id: (): string => 'TEST-child', now: (): string => now, nowMs: (): number => Date.now() });
  acquire.mockImplementation(async (taskId: string, ownerId: string): Promise<{ success: boolean; task?: Task; error?: string }> => resultForRenderer(core.acquireLock({ taskId, ownerId })));
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { tasks: {
    list: async (): Promise<Task[]> => structuredClone(persisted),
    updateRuntime: async (taskId: string, patch: Omit<TaskUpdateRuntimeParams, 'taskId'>): Promise<{ success: boolean; task?: Task; error?: string }> => resultForRenderer(core.updateRuntime({ taskId, ...patch })),
    acquireLock: acquire,
    renewLock: async (taskId: string, ownerId: string): Promise<{ success: boolean; task?: Task; error?: string }> => resultForRenderer(core.renewLock({ taskId, ownerId })),
    releaseLock: async (taskId: string, ownerId: string): Promise<TaskServiceResult> => core.releaseLock({ taskId, ownerId }),
  }, logs: { append: vi.fn(async (): Promise<void> => undefined) } } });
  account = { id: 'TEST-account', name: 'TEST账号', platform: 'doubao', avatar: '', partition: 'TEST', status: 'idle', pinned: false, createdAt: now, updatedAt: now,
    health: { loginState: 'ok', verificationRequired: false, failureCount: 0, successCount: 0, consecutiveFailures: 0, availability: { state: 'ready', reason: 'ready', message: 'TEST已处理', checkedAt: now, source: 'manual' } } };
  useAccountStore.setState({ ...initial.accounts, accounts: [account] });
  useTaskStore.setState({ ...initial.tasks, tasks: [], schedulerPaused: false, activeTaskId: null, executingTasks: {}, accountBusy: {}, accountAutomationState: {}, accountAutoMessage: {} });
});
afterEach(async (): Promise<void> => {
  useTaskStore.setState({ schedulerPaused: true });
  for (const task of persisted) await automationEngine.release(task.id);
  vi.clearAllTimers(); vi.useRealTimers(); useTaskStore.setState(initial.tasks); useAccountStore.setState(initial.accounts); vi.unstubAllGlobals();
});

describe('显式替代任务解除旧本地等待占位后仍走原账号安全调度', (): void => {
  it.each(['waiting_verification', 'waiting_generation_confirmation'] as const)('%s → Core原子收束paused → 回读 → 新hold任务可显式启动', async (status): Promise<void> => {
    const { original, child } = await resubmit(status); const savedSource = persisted.find((task): boolean => task.id === original.id)!;
    expect(savedSource.status).toBe('paused'); expect(savedSource.runtime).toEqual(original.runtime); expect(savedSource.result).toBe(original.result);
    expect(child.status).toBe('queued'); expect(child.executionIntent).toBe('hold'); expect(child.runtime).toBeUndefined();
    const beforeDispatch = vi.fn(async (task: Task): Promise<void> => { expect(task.runtime?.runId).toBeTruthy(); expect(task.runtime?.submittedAt).toBeUndefined(); });
    expect(await useTaskStore.getState().startAutomation(child.id, beforeDispatch)).toBe(true);
    expect(beforeDispatch).toHaveBeenCalledOnce(); expect(acquire).toHaveBeenCalledExactlyOnceWith(child.id, expect.any(String));
    expect(persisted.find((task): boolean => task.id === child.id)).toMatchObject({ status: 'executing', executionIntent: 'armed' });
    expect(persisted.find((task): boolean => task.id === original.id)?.runtime).toEqual(original.runtime);
  });
  it('新child保持hold时队列不启动，明确armed后按原队列安全启动', async (): Promise<void> => {
    const { child } = await resubmit(); await useTaskStore.getState().processQueue(); expect(acquire).not.toHaveBeenCalled();
    expect(await useTaskStore.getState().armTasks([child.id])).toEqual({ armed: 1, failed: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(persisted.find((task): boolean => task.id === child.id)?.status).toBe('executing'); expect(acquire).toHaveBeenCalledOnce();
  });
  it.each(['waiting_verification', 'waiting_generation_confirmation', 'executing', 'generating', 'manual_submission_observing'] as const)('无关%s仍占位，关联元数据不会豁免真实其他任务', async (status): Promise<void> => {
    const { child } = await resubmit(); persisted.push({ ...source('waiting_verification'), id: 'TEST-unrelated', status });
    await useTaskStore.getState().loadTasks();
    expect(await useTaskStore.getState().startAutomation(child.id)).toBe(false); expect(acquire).not.toHaveBeenCalled();
    expect(persisted.find((task): boolean => task.id === 'TEST-unrelated')?.status).toBe(status);
  });
  it('原source后续重新持有活锁时Core仍拒绝新child占用账号', async (): Promise<void> => {
    const { original, child } = await resubmit(); const stored = persisted.find((task): boolean => task.id === original.id)!;
    stored.lock = { ownerId: 'TEST-live-owner', acquiredAt: now, expiresAt: '2026-10-31T02:05:00.000Z' };
    await useTaskStore.getState().loadTasks(); expect(await useTaskStore.getState().startAutomation(child.id)).toBe(false);
    expect(useTaskStore.getState().error).toContain('已经被其他任务锁定'); expect(stored.lock.ownerId).toBe('TEST-live-owner');
  });
  it('原source仍持真实控制器时不替换控制器或启动新child', async (): Promise<void> => {
    const { original, child } = await resubmit(); expect(await automationEngine.reserve(original.id, account.id, 'TEST-active-owner')).toEqual({ ok: true });
    const controller = automationEngine.createController(original.id, account.id); acquire.mockClear();
    expect(await useTaskStore.getState().startAutomation(child.id)).toBe(false); expect(acquire).not.toHaveBeenCalled();
    expect(automationEngine.ownsController(original.id, controller)).toBe(true); expect(controller.signal.aborted).toBe(false);
  });
  it('原source结束本地占位后，账号仍需完成人机验证才允许新child执行', async (): Promise<void> => {
    const { child } = await resubmit(); account.health!.verificationRequired = true; useAccountStore.setState({ accounts: [account] });
    expect(await useTaskStore.getState().startAutomation(child.id)).toBe(false); expect(acquire).not.toHaveBeenCalled();
    expect(useTaskStore.getState().error).toContain('等待人工验证');
  });
});
