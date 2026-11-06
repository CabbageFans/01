/** 通用启动边界使用真实 TaskService；不挂载浏览器，不发送平台请求。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Task, TaskUpdateRuntimeParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { automationEngine } from '../../src/automation/AutomationEngine';
import { registerTaskDispatchGuard } from '../../src/automation/taskDispatchGuards';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useTaskStore } from '../../src/store/useTaskStore';

const initial = { tasks: useTaskStore.getState(), accounts: useAccountStore.getState() };
let tasks: Task[];
let core: TaskService;
let unregister: (() => void) | undefined;
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve): void => { release = resolve; });
  return { promise, resolve: release };
}
function account(id: string): Account {
  const now = new Date().toISOString();
  return { id, name: 'TEST 隔离账号', platform: 'doubao', avatar: '', partition: 'TEST-only', status: 'idle', pinned: false, createdAt: now, updatedAt: now,
    health: { loginState: 'ok', verificationRequired: false, consecutiveFailures: 0, successCount: 0, failureCount: 0,
      availability: { state: 'ready', reason: 'ready', message: 'TEST', checkedAt: now, source: 'manual' } } };
}
function add(accountId: string): string {
  const created = core.create({ prompts: ['TEST 正式任务输入'], mode: 'chat', projectId: 'TEST-dispatch-project', executionIntent: 'hold' });
  if (!created.success) throw new Error(created.error);
  const id = created.data[0].id;
  const assigned = core.assign({ taskId: id, accountId }); if (!assigned.success) throw new Error(assigned.error);
  useTaskStore.setState({ tasks: structuredClone(tasks) }); return id;
}
beforeEach((): void => {
  tasks = []; let sequence = 0;
  core = new TaskService({ store: { read: (): Task[] => structuredClone(tasks), replace: (items: Task[]): boolean => { tasks = structuredClone(items); return true; } },
    defaultProjectId: (): string => 'TEST-dispatch-project', id: (): string => `TEST-dispatch-${++sequence}` });
  vi.stubGlobal('window', { electronAPI: { tasks: {
    updateRuntime: async (id: string, patch: Omit<TaskUpdateRuntimeParams, 'taskId'>): Promise<unknown> => {
      const result = core.updateRuntime({ taskId: id, ...patch }); return result.success ? { success: true, task: result.data } : result;
    }, acquireLock: vi.fn(async (): Promise<{ success: true }> => ({ success: true })),
    releaseLock: vi.fn(async (): Promise<{ success: true }> => ({ success: true })),
    renewLock: vi.fn(async (): Promise<{ success: true }> => ({ success: true })),
  }, logs: { append: vi.fn() } } });
  useAccountStore.setState({ ...initial.accounts, accounts: [account('TEST-account-a'), account('TEST-account-b')] });
  useTaskStore.setState({ ...initial.tasks, tasks: [], schedulerPaused: false, accountBusy: {}, executingTasks: {}, accountAutomationState: {}, activeTaskId: null, processQueue: vi.fn() });
});
afterEach(async (): Promise<void> => {
  unregister?.(); unregister = undefined;
  for (const task of tasks) await automationEngine.release(task.id);
  useTaskStore.setState(initial.tasks); useAccountStore.setState(initial.accounts); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('所有通用启动入口的运行绑定门禁', (): void => {
  it('不传可选callback也必须经过guard，失败后同task保持hold并释放执行锁', async (): Promise<void> => {
    const id = add('TEST-account-a');
    const guard = vi.fn(async (task: Task): Promise<void> => {
      expect(task.runtime?.runId).toBeTruthy(); expect(useTaskStore.getState().executingTasks).toEqual({});
      throw new Error('TEST 绑定写入失败');
    });
    unregister = registerTaskDispatchGuard('TEST-business', guard);
    expect(await useTaskStore.getState().startAutomation(id)).toBe(false);
    expect(guard).toHaveBeenCalledOnce(); expect(tasks[0]).toMatchObject({ status: 'paused', executionIntent: 'hold',
      errorInfo: { code: 'dispatch_not_ready', recoverable: true, message: 'TEST 绑定写入失败' } });
    expect(tasks[0].runtime?.submittedAt).toBeUndefined(); expect(automationEngine.isReserved(id)).toBe(false);
    expect(useTaskStore.getState().executingTasks).toEqual({});
  });

  it('同毫秒并发启动同task只能调用一次guard，第二入口不能越过仍在等待的绑定', async (): Promise<void> => {
    const id = add('TEST-account-a'); const pending = deferred();
    vi.spyOn(Date, 'now').mockReturnValue(1_793_900_000_000);
    const guard = vi.fn(async (): Promise<void> => pending.promise);
    unregister = registerTaskDispatchGuard('TEST-business', guard);
    const first = useTaskStore.getState().startAutomation(id);
    await vi.waitFor((): void => { expect(guard).toHaveBeenCalledOnce(); });
    expect(await useTaskStore.getState().startAutomation(id)).toBe(false);
    expect(useTaskStore.getState().executingTasks).toEqual({});
    pending.resolve(); expect(await first).toBe(true);
    expect(guard).toHaveBeenCalledOnce(); expect(useTaskStore.getState().executingTasks['TEST-account-a']).toBe(id);
  });
  it('正式guard通过后beforeDispatch失败仍保存派发前原因，始终未发布页面执行状态', async (): Promise<void> => {
    const id = add('TEST-account-a'); const bound = vi.fn(async (): Promise<void> => undefined);
    unregister = registerTaskDispatchGuard('TEST-business', bound);
    expect(await useTaskStore.getState().startAutomation(id, async (): Promise<void> => { throw new Error('TEST正式绑定后回读尚未完成'); })).toBe(false);
    expect(bound).toHaveBeenCalledOnce();
    expect(tasks[0]).toMatchObject({ status: 'paused', executionIntent: 'hold', errorInfo: { code: 'dispatch_not_ready', recoverable: true } });
    expect(tasks[0].runtime?.submittedAt).toBeUndefined(); expect(useTaskStore.getState().executingTasks).toEqual({});
    expect(automationEngine.isReserved(id)).toBe(false);
  });

  it('绑定等待期间暂停原运行，迟到guard不能把权威paused覆盖为executing', async (): Promise<void> => {
    const id = add('TEST-account-a'); const pending = deferred();
    const guard = vi.fn(async (): Promise<void> => pending.promise);
    unregister = registerTaskDispatchGuard('TEST-business', guard);
    const starting = useTaskStore.getState().startAutomation(id);
    await vi.waitFor((): void => { expect(guard).toHaveBeenCalledOnce(); });
    await useTaskStore.getState().updateTaskRuntime(id, { status: 'paused', executionIntent: 'hold', runtime: { stage: 'paused', message: 'TEST 用户明确暂停' } });
    pending.resolve(); expect(await starting).toBe(false);
    expect(tasks[0]).toMatchObject({ status: 'paused', runtime: { message: 'TEST 用户明确暂停' } });
    expect(useTaskStore.getState().executingTasks).toEqual({}); expect(automationEngine.isReserved(id)).toBe(false);
  });

  it('普通启动仍在等待执行锁时暂停，迟到取锁成功不能写回executing', async (): Promise<void> => {
    const id = add('TEST-account-a'); const pending = deferred();
    const acquire = vi.spyOn(window.electronAPI.tasks, 'acquireLock').mockImplementationOnce(async (): Promise<{ success: true }> => { await pending.promise; return { success: true }; });
    const starting = useTaskStore.getState().startAutomation(id);
    await vi.waitFor((): void => { expect(acquire).toHaveBeenCalledOnce(); });
    await useTaskStore.getState().updateTaskRuntime(id, { status: 'paused', executionIntent: 'hold' });
    pending.resolve(); expect(await starting).toBe(false);
    expect(tasks[0].status).toBe('paused'); expect(tasks[0].runtime).toBeUndefined();
    expect(useTaskStore.getState().executingTasks).toEqual({}); expect(automationEngine.isReserved(id)).toBe(false);
  });

  it('一个账号绑定失败不会锁住另一账号的独立任务', async (): Promise<void> => {
    const first = add('TEST-account-a'); const second = add('TEST-account-b');
    unregister = registerTaskDispatchGuard('TEST-business', async (task: Task): Promise<void> => { if (task.id === first) throw new Error('TEST 原账号绑定失败'); });
    expect(await useTaskStore.getState().startAutomation(first)).toBe(false);
    expect(await useTaskStore.getState().startAutomation(second)).toBe(true);
    expect(useTaskStore.getState().executingTasks).toEqual({ 'TEST-account-b': second });
    expect(automationEngine.isReserved(first)).toBe(false);
  });
});
