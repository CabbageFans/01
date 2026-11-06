import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Task, TaskUpdateRuntimeParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';
import { getTaskExecutionScope as mainScope, isImageExecutionTask as mainImageTask, tasksExecutionConflict as mainConflict } from '../../main/utils/taskExecutionScope';
import { automationEngine } from '../../src/automation/AutomationEngine';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { findInteractiveAccountId, isAccountExecutionBusy } from '../../src/utils/interactiveAccount';
import { getTaskExecutionScope, isImageExecutionTask, isMaterialImageTask, tasksExecutionConflict } from '../../src/utils/taskExecutionScope';

const NOW = '2026-11-05T00:00:00.000Z';
const ACCOUNT = 'TEST-material-account';
const OTHER_ACCOUNT = 'TEST-other-account';
const initial = { tasks: useTaskStore.getState(), accounts: useAccountStore.getState() };
let tasks: Task[];
let core: TaskService;

function materialTask(id: string, materialId: string, mode: 'image' | 'chat' = 'image'): Task {
  const binding = { projectId: 'TEST-image-project', imageOperationId: `TEST-op-${id}`, materialId };
  return { id, prompt: 'TEST 独立素材输入', assignedAccountId: ACCOUNT, projectId: 'TEST-studio', mode, status: 'queued', executionIntent: 'hold',
    ...(mode === 'image' ? { petstory: { ...binding, stepId: `TEST-step-${id}` } } : { petstoryChat: { ...binding, jobId: `TEST-job-${id}` } }),
    result: null, outputs: [], artifacts: [], createdAt: NOW, updatedAt: NOW };
}

function seed(items: Task[]): void { tasks = structuredClone(items); useTaskStore.setState({ tasks: structuredClone(items) }); }

function stoppedPageTask(id: string, materialId: string): Task {
  const task = materialTask(id, materialId, 'chat');
  return { ...task, status: 'waiting_verification', executionIntent: 'armed',
    errorInfo: { code: 'page_unrecognized', message: '未识别到可用输入区域，请打开对话页后重新检测', recoverable: true, detectedAt: NOW },
    runtime: { runId: `TEST-stopped-run-${id}`, attempt: 1, stage: 'waiting_verification', message: 'TEST 页面识别已停止',
      startedAt: NOW, stageStartedAt: NOW, lastHeartbeatAt: NOW, input: { prompt: task.prompt, mode: task.mode, attachments: [] } } };
}

beforeEach((): void => {
  vi.useFakeTimers();
  tasks = [];
  core = new TaskService({ store: { read: (): Task[] => structuredClone(tasks), replace: (items: Task[]): boolean => { tasks = structuredClone(items); return true; } },
    defaultProjectId: (): string => 'TEST-studio' });
  const account: Account = { id: ACCOUNT, name: 'TEST', platform: 'doubao', avatar: '', partition: 'TEST-only', status: 'idle', pinned: false, createdAt: NOW, updatedAt: NOW,
    health: { loginState: 'ok', verificationRequired: false, consecutiveFailures: 0, successCount: 0, failureCount: 0,
      availability: { state: 'ready', reason: 'ready', message: 'TEST', checkedAt: NOW, source: 'manual' } } };
  vi.stubGlobal('window', { electronAPI: { tasks: {
    list: async (): Promise<Task[]> => core.getTasks().success ? structuredClone(tasks) : [],
    updateRuntime: async (id: string, patch: Omit<TaskUpdateRuntimeParams, 'taskId'>): Promise<unknown> => {
      const result = core.updateRuntime({ taskId: id, ...patch }); return result.success ? { success: true, task: result.data } : result;
    },
    updateStatus: async (id: string, status: Task['status'], result?: string, outputs?: string[]): Promise<unknown> => core.updateStatus({ taskId: id, status, result, outputs }),
    acquireLock: async (id: string, ownerId: string): Promise<unknown> => core.acquireLock({ taskId: id, ownerId }),
    renewLock: async (id: string, ownerId: string): Promise<unknown> => core.renewLock({ taskId: id, ownerId }),
    releaseLock: async (id: string, ownerId: string): Promise<unknown> => core.releaseLock({ taskId: id, ownerId }),
  }, accounts: { setStatus: vi.fn() }, logs: { append: vi.fn() } } });
  useAccountStore.setState({ ...initial.accounts, accounts: [account, { ...account, id: OTHER_ACCOUNT, partition: 'TEST-other-only' }] });
  useTaskStore.setState({ ...initial.tasks, tasks: [], schedulerPaused: false, executingTasks: {}, accountBusy: {}, accountAutomationState: {}, accountAutoMessage: {}, activeTaskId: null, processQueue: vi.fn() });
});

afterEach(async (): Promise<void> => {
  for (const task of tasks) await automationEngine.release(task.id);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  useTaskStore.setState(initial.tasks); useAccountStore.setState(initial.accounts);
});

describe('图片全局单个执行位置与独立任务归属', (): void => {
  it('主进程与渲染进程只允许完整图片操作绑定，且同素材跨operation始终互斥', (): void => {
    const first = materialTask('scope-a', 'character:a'); const second = materialTask('scope-b', 'character:b', 'chat');
    const same = materialTask('scope-c', 'character:a', 'chat');
    const incomplete = { ...second, petstoryChat: { projectId: 'TEST-image-project', jobId: 'TEST-job', imageOperationId: 'TEST-op' } };
    for (const task of [first, second, same, incomplete, { ...first, mode: 'video' as const }]) expect(mainScope(task)).toBe(getTaskExecutionScope(task));
    expect(isMaterialImageTask(incomplete)).toBe(false); expect(getTaskExecutionScope(incomplete)).toBe(ACCOUNT);
    expect(tasksExecutionConflict(first, second)).toBe(false); expect(mainConflict(first, second)).toBe(false);
    expect(tasksExecutionConflict(first, same)).toBe(true); expect(mainConflict(first, same)).toBe(true);
    expect(tasksExecutionConflict(first, incomplete)).toBe(true);
    expect(findInteractiveAccountId({ [getTaskExecutionScope(first)]: 'injecting' })).toBe(ACCOUNT);
    expect(isAccountExecutionBusy({ [getTaskExecutionScope(first)]: true }, ACCOUNT)).toBe(true);
    for (const item of [first, second, { ...first, petstory: undefined }, { ...first, mode: 'video' as const }, { ...second, petstoryChat: undefined }]) {
      expect(mainImageTask(item)).toBe(isImageExecutionTask(item));
    }
    expect(isImageExecutionTask({ ...first, petstory: undefined })).toBe(true);
    expect(isImageExecutionTask(second)).toBe(true);
    expect(isImageExecutionTask({ ...second, petstoryChat: undefined })).toBe(false);
  });

  it('真实主进程图片锁全项目全账号单行，准备Chat和普通生图均计入，普通Chat不改规则', (): void => {
    const first = materialTask('lock-a', 'character:a');
    const second = { ...materialTask('lock-b', 'character:b', 'chat'), assignedAccountId: OTHER_ACCOUNT, projectId: 'TEST-other-project' };
    const third = { ...materialTask('lock-c', 'character:c'), assignedAccountId: OTHER_ACCOUNT, petstory: undefined };
    const ordinary = { ...materialTask('ordinary', 'unused', 'chat'), assignedAccountId: OTHER_ACCOUNT, petstoryChat: undefined };
    seed([first, second, third, ordinary]);
    expect(core.acquireLock({ taskId: first.id, ownerId: 'TEST-owner-a' }).success).toBe(true);
    expect(core.acquireLock({ taskId: second.id, ownerId: 'TEST-owner-b' }).success).toBe(false);
    expect(core.acquireLock({ taskId: third.id, ownerId: 'TEST-owner-c' }).success).toBe(false);
    expect(core.acquireLock({ taskId: ordinary.id, ownerId: 'TEST-owner-ordinary' }).success).toBe(true);
    expect(core.releaseLock({ taskId: ordinary.id, ownerId: 'TEST-owner-ordinary' }).success).toBe(true);
    expect(core.releaseLock({ taskId: first.id, ownerId: 'TEST-owner-a' }).success).toBe(true);
    expect(core.acquireLock({ taskId: second.id, ownerId: 'TEST-owner-b' }).success).toBe(true);
    expect(core.acquireLock({ taskId: first.id, ownerId: 'TEST-owner-a' }).success).toBe(false);
  });

  it('跨账号的图片预约在首个异步取锁期间已互斥，普通Chat仍可按原账号规则运行', async (): Promise<void> => {
    const first = materialTask('reservation-first', 'character:a');
    const second = { ...materialTask('reservation-second', 'prop:b', 'chat'), assignedAccountId: OTHER_ACCOUNT };
    const ordinary = { ...materialTask('reservation-chat', 'unused', 'chat'), assignedAccountId: OTHER_ACCOUNT, petstoryChat: undefined };
    seed([first, second, ordinary]);
    const acquire = vi.spyOn(window.electronAPI.tasks, 'acquireLock');
    const pending = automationEngine.reserve(first.id, ACCOUNT, 'TEST-image-owner-a', first);
    expect((await automationEngine.reserve(second.id, OTHER_ACCOUNT, 'TEST-image-owner-b', second)).ok).toBe(false);
    expect((await pending).ok).toBe(true); expect(acquire).toHaveBeenCalledOnce();
    expect((await automationEngine.reserve(ordinary.id, OTHER_ACCOUNT, 'TEST-chat-owner', ordinary)).ok).toBe(true);
    await automationEngine.release(ordinary.id); await automationEngine.release(first.id);
    expect((await automationEngine.reserve(second.id, OTHER_ACCOUNT, 'TEST-image-owner-b', second)).ok).toBe(true);
    acquire.mockRestore();
  });

  it.each(['chat', 'video'] as const)('全局图片占用不改变另一账号普通%s的原规则，普通生图仍等待', async (mode: 'chat' | 'video'): Promise<void> => {
    const first = materialTask(`global-first-${mode}`, 'character:a');
    const waiting = { ...materialTask(`global-waiting-${mode}`, 'unused'), assignedAccountId: OTHER_ACCOUNT, petstory: undefined };
    const ordinary: Task = { ...materialTask(`global-ordinary-${mode}`, 'unused'), assignedAccountId: OTHER_ACCOUNT, mode, petstory: undefined };
    seed([first, waiting, ordinary]);
    expect(await useTaskStore.getState().startAutomation(first.id)).toBe(true);
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'generating', 'TEST 图片生成中', 'generating', first.id);
    expect(await useTaskStore.getState().startAutomation(waiting.id)).toBe(false);
    expect(useTaskStore.getState().tasks.find((task: Task): boolean => task.id === waiting.id)?.executionIntent).toBe('hold');
    expect(useTaskStore.getState().tasks.find((task: Task): boolean => task.id === waiting.id)?.runtime).toBeUndefined();
    expect(await useTaskStore.getState().startAutomation(ordinary.id)).toBe(true);
    expect(Object.values(useTaskStore.getState().executingTasks)).toEqual([first.id, ordinary.id]);
    expect(useTaskStore.getState().tasks.filter((task: Task): boolean => ['executing', 'generating'].includes(task.status) && isImageExecutionTask(task))).toHaveLength(1);
  });

  it('独立准备chat的归属重载后保留，半截绑定不能降成可并行任务', (): void => {
    const task = materialTask('persist-chat', 'prop:a', 'chat');
    const normalized = normalizeTasks([task], 'TEST-studio', NOW).data[0];
    expect(normalized.petstoryChat).toEqual(task.petstoryChat); expect(getTaskExecutionScope(normalized)).toBe(getTaskExecutionScope(task));
    expect(core.create({ prompts: ['TEST'], mode: 'chat', petstoryChat: { projectId: 'TEST-image-project', jobId: 'TEST-job', imageOperationId: 'TEST-op' } }).success).toBe(false);
  });

  it('两项页面识别等待已释放后不占全局位置，另外两项素材仍按一次一个顺序派发', async (): Promise<void> => {
    const stopped = [stoppedPageTask('stopped-page-b', 'character:b'), stoppedPageTask('stopped-page-c', 'character:c')];
    const first = { ...materialTask('waiting-image-a', 'character:a'), executionIntent: 'armed' as const };
    const second = { ...materialTask('waiting-prop-a', 'prop:a', 'chat'), executionIntent: 'armed' as const };
    seed([...stopped, first, second]);
    expect(stopped.every((task: Task): boolean => !automationEngine.isReserved(task.id) && !task.lock && !task.runtime?.submittedAt)).toBe(true);
    await initial.tasks.processQueue();
    expect(useTaskStore.getState().executingTasks[getTaskExecutionScope(first)]).toBe(first.id);
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'generating', 'TEST 第一素材生成中', 'generating', first.id);
    await initial.tasks.processQueue();
    expect(Object.values(useTaskStore.getState().executingTasks)).toEqual([first.id]);
    expect(useTaskStore.getState().tasks.find((task: Task): boolean => task.id === second.id)?.status).toBe('queued');
    expect(useTaskStore.getState().tasks.filter((task: Task): boolean => stopped.some((old: Task): boolean => old.id === task.id)))
      .toEqual(stopped);
    await useTaskStore.getState().pauseAutomation(first.id, ACCOUNT, 'TEST 停止第一素材'); await automationEngine.release(first.id);
    await initial.tasks.processQueue();
    expect(Object.values(useTaskStore.getState().executingTasks)).toEqual([second.id]);
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'generating', 'TEST 第二素材生成中', 'generating', second.id);
    const third = materialTask('waiting-third', 'scene:a'); seed([...tasks, third]);
    expect(await useTaskStore.getState().startAutomation(third.id)).toBe(false);
    await initial.tasks.processQueue();
    expect(useTaskStore.getState().tasks.find((task: Task): boolean => task.id === third.id)?.status).toBe('queued');
    expect(Object.values(useTaskStore.getState().executingTasks)).toHaveLength(1);
  });

  it('已停止的页面识别等待仍保护同一素材原任务，不允许另一个任务覆盖', async (): Promise<void> => {
    const stopped = stoppedPageTask('same-material-stopped', 'character:a'); const duplicate = materialTask('same-material-new', 'character:a');
    seed([stopped, duplicate]);
    expect(await useTaskStore.getState().startAutomation(duplicate.id)).toBe(false);
    expect(automationEngine.isReserved(duplicate.id)).toBe(false);
    expect(useTaskStore.getState().tasks[0]).toEqual(stopped);
  });

  it.each(['login', 'verification'] as const)('移除空等待槽占用仍遵循账号真实%s阻断', async (blocked: 'login' | 'verification'): Promise<void> => {
    const waiting = { ...materialTask(`account-blocked-${blocked}`, 'prop:a'), executionIntent: 'armed' as const };
    seed([stoppedPageTask(`old-page-${blocked}`, 'character:b'), waiting]);
    const account = useAccountStore.getState().accounts[0];
    useAccountStore.setState({ accounts: [{ ...account, health: { loginState: blocked === 'login' ? 'expired' : 'ok', verificationRequired: blocked === 'verification',
      consecutiveFailures: 0, successCount: 0, failureCount: 0, availability: {
        state: blocked === 'login' ? 'login_required' : 'action_required', reason: blocked === 'login' ? 'login_required' : 'human_verification',
        message: 'TEST 真实账号待办', checkedAt: NOW, source: 'manual',
      } } }] });
    await initial.tasks.processQueue();
    expect(useTaskStore.getState().tasks.find((task: Task): boolean => task.id === waiting.id)?.status).toBe('queued');
    expect(useTaskStore.getState().executingTasks).toEqual({}); expect(automationEngine.isReserved(waiting.id)).toBe(false);
  });

  it('另一账号项目的图片准备忙时保持hold，原图片释放后仅明确再次开始才执行callback', async (): Promise<void> => {
    const first = materialTask('queue-a', 'character:a'); const second = materialTask('queue-b', 'prop:b', 'chat'); const third = materialTask('queue-c', 'scene:c');
    second.assignedAccountId = OTHER_ACCOUNT; second.projectId = 'TEST-other-studio';
    if (second.petstoryChat) second.petstoryChat.projectId = 'TEST-other-project';
    seed([first, second, third]);
    const callback = vi.fn(async (): Promise<void> => {});
    expect(await useTaskStore.getState().startAutomation(first.id)).toBe(true);
    const arm = vi.spyOn(window.electronAPI.tasks, 'updateRuntime'); const acquire = vi.spyOn(window.electronAPI.tasks, 'acquireLock');
    expect(await useTaskStore.getState().startAutomation(second.id, callback)).toBe(false);
    expect(arm).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled(); arm.mockRestore(); acquire.mockRestore();
    expect(callback).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks.find((task: Task): boolean => task.id === second.id)).toMatchObject({ status: 'queued', executionIntent: 'hold' });
    expect(tasks.find((task: Task): boolean => task.id === second.id)?.executionIntent).toBe('hold');
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'generating', 'TEST', 'generating', first.id);
    await initial.tasks.processQueue();
    expect(callback).not.toHaveBeenCalled();
    expect(Object.values(useTaskStore.getState().executingTasks)).toEqual([first.id]);
    expect(await useTaskStore.getState().startAutomation(third.id)).toBe(false);
    expect(useTaskStore.getState().tasks.find((task: Task): boolean => task.id === third.id)?.status).toBe('queued');
    await initial.tasks.processQueue(); expect(Object.values(useTaskStore.getState().executingTasks)).toHaveLength(1);
    expect((await automationEngine.reserve(third.id, ACCOUNT, 'TEST-third-run', third)).ok).toBe(false);
    await useTaskStore.getState().pauseAutomation(first.id, ACCOUNT, 'TEST 释放一项'); await automationEngine.release(first.id);
    await initial.tasks.processQueue();
    expect(callback).not.toHaveBeenCalled(); expect(useTaskStore.getState().executingTasks).toEqual({});
    expect(await useTaskStore.getState().startAutomation(second.id)).toBe(true);
    expect(callback).not.toHaveBeenCalled();
    expect(Object.values(useTaskStore.getState().executingTasks)).toEqual([second.id]);
    useTaskStore.getState().setAccountAutomationState(OTHER_ACCOUNT, 'generating', 'TEST', 'generating', second.id);
    await useTaskStore.getState().pauseAutomation(second.id, OTHER_ACCOUNT, 'TEST 停止第二素材'); await automationEngine.release(second.id);
    await initial.tasks.processQueue();
    expect(useTaskStore.getState().executingTasks).toEqual({});
    expect(await useTaskStore.getState().startAutomation(third.id)).toBe(true);
    expect(Object.values(useTaskStore.getState().executingTasks)).toEqual([third.id]);
  });

  it('任务回读保留原位置，租约失效暂停原任务后下一图才取得自己的控制器', async (): Promise<void> => {
    const first = materialTask('refresh-a', 'character:a'); const second = materialTask('refresh-b', 'prop:b'); seed([first, second]);
    await useTaskStore.getState().startAutomation(first.id);
    const firstController = automationEngine.createController(first.id, ACCOUNT);
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'generating', 'TEST-a', 'generating', first.id);
    await useTaskStore.getState().loadTasks(false);
    expect(useTaskStore.getState().executingTasks[getTaskExecutionScope(first)]).toBe(first.id);
    await useTaskStore.getState().startAutomation(second.id);
    expect((): AbortController => automationEngine.createController(second.id, ACCOUNT)).toThrow('执行锁');
    const ownerId = tasks.find((task: Task): boolean => task.id === first.id)!.lock!.ownerId;
    expect(core.releaseLock({ taskId: first.id, ownerId }).success).toBe(true);
    const error = vi.spyOn(console, 'error').mockImplementation((): void => {});
    expect(await automationEngine.confirmSubmissionOwnership(first.id, ACCOUNT, firstController)).toBe(false);
    error.mockRestore();
    expect(firstController.signal.aborted).toBe(true);
    await useTaskStore.getState().pauseAutomation(first.id, ACCOUNT, 'TEST 原租约失效');
    await initial.tasks.processQueue();
    expect(await useTaskStore.getState().startAutomation(second.id)).toBe(true);
    const secondController = automationEngine.createController(second.id, ACCOUNT);
    expect(await automationEngine.confirmSubmissionOwnership(second.id, ACCOUNT, secondController)).toBe(true);
    expect(secondController.signal.aborted).toBe(false);
  });

  it.each(['pause', 'fail'] as const)('忙时拒绝图片后%s再显式恢复同一任务，仅执行本次新callback', async (action: 'pause' | 'fail'): Promise<void> => {
    const first = materialTask(`callback-busy-${action}`, 'character:a'); const waiting = materialTask(`callback-waiting-${action}`, 'prop:b');
    seed([first, waiting]);
    const oldCallback = vi.fn(async (): Promise<void> => { throw new Error('TEST 原图片授权已撤销'); });
    const newCallback = vi.fn(async (task: Task): Promise<void> => {
      expect(task.id).toBe(waiting.id);
      expect(task.runtime?.runId).toBeTruthy();
      expect(task.runtime?.submittedAt).toBeUndefined();
    });
    expect(await useTaskStore.getState().startAutomation(first.id)).toBe(true);
    expect(await useTaskStore.getState().startAutomation(waiting.id, oldCallback)).toBe(false);
    expect(oldCallback).not.toHaveBeenCalled();
    if (action === 'pause') await useTaskStore.getState().pauseAutomation(waiting.id, ACCOUNT, 'TEST 撤销旧图片授权');
    else await useTaskStore.getState().failAutomation(waiting.id, ACCOUNT, 'TEST 原授权已停止');
    expect(core.retry(waiting.id, 'hold').success).toBe(true);
    await useTaskStore.getState().loadTasks(false);
    expect(await useTaskStore.getState().startAutomation(waiting.id, newCallback)).toBe(false);
    expect(newCallback).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks.find((task: Task): boolean => task.id === waiting.id)).toMatchObject({ status: 'queued', executionIntent: 'hold' });
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'generating', 'TEST 释放前台准备租约', 'generating', first.id);
    await useTaskStore.getState().pauseAutomation(first.id, ACCOUNT, 'TEST 释放全局图片位置'); await automationEngine.release(first.id);
    await initial.tasks.processQueue();
    expect(newCallback).not.toHaveBeenCalled();
    expect(await useTaskStore.getState().startAutomation(waiting.id, newCallback)).toBe(true);
    expect(newCallback).toHaveBeenCalledOnce(); expect(oldCallback).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(2);
    expect(useTaskStore.getState().tasks.find((task: Task): boolean => task.id === waiting.id)).toMatchObject({ status: 'executing', runtime: { attempt: 1 } });
    expect(useTaskStore.getState().executingTasks[getTaskExecutionScope(waiting)]).toBe(waiting.id);
  });

  it.each(['pause', 'fail'] as const)('原图片%s只清自身位置并保留下一张排队，释放后下一张方可执行', async (action: 'pause' | 'fail'): Promise<void> => {
    const first = materialTask(`stop-a-${action}`, 'character:a'); const second = materialTask(`stop-b-${action}`, 'prop:b');
    seed([first, second]);
    await useTaskStore.getState().startAutomation(first.id);
    const firstController = automationEngine.createController(first.id, ACCOUNT);
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'generating', 'TEST-a', 'generating', first.id);
    await useTaskStore.getState().startAutomation(second.id);
    expect(automationEngine.isReserved(second.id)).toBe(false);
    if (action === 'pause') await useTaskStore.getState().pauseAutomation(first.id, ACCOUNT, 'TEST 单图暂停');
    else await useTaskStore.getState().failAutomation(first.id, ACCOUNT, 'TEST 单图失败');
    await automationEngine.release(first.id, firstController);
    expect(useTaskStore.getState().tasks.find((task: Task): boolean => task.id === second.id)?.status).toBe('queued');
    await initial.tasks.processQueue();
    expect(useTaskStore.getState().executingTasks).toEqual({});
    expect(await useTaskStore.getState().startAutomation(second.id)).toBe(true);
    const secondController = automationEngine.createController(second.id, ACCOUNT);
    const scope = getTaskExecutionScope(second);
    expect(useTaskStore.getState().executingTasks).toEqual({ [scope]: second.id });
    expect(useTaskStore.getState().accountBusy[scope]).toBe(true);
    expect(useTaskStore.getState().accountAutomationState[scope]).toBe('injecting');
    expect(automationEngine.ownsAccountController(second.id, ACCOUNT, secondController)).toBe(true);
  });
});
