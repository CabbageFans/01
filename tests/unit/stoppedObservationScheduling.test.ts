/** 历史受理证据只保护原请求；停止图片后不应继续占用账号调度。所有存储与平台调用均为离线替身。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Task, TaskUpdateRuntimeParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { automationEngine } from '../../src/automation/AutomationEngine';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useTaskStore } from '../../src/store/useTaskStore';

const NOW = '2026-11-06T07:00:00.000Z';
const SUBMITTED_AT = '2026-11-06T03:31:00.000Z';
const ACCOUNT = 'TEST-observation-account';
const initial = { tasks: useTaskStore.getState(), accounts: useAccountStore.getState() };
let tasks: Task[];
let core: TaskService;

function stoppedImage(status: Task['status'] = 'paused'): Task {
  const binding = { projectId: 'TEST-short-drama', stepId: 'TEST-image-step', imageOperationId: 'TEST-image-operation', materialId: 'prop:TEST-branch' };
  const runId = 'TEST-original-image-run';
  return {
    id: 'TEST-original-image', projectId: 'TEST-studio', assignedAccountId: ACCOUNT, mode: 'image', status, executionIntent: 'hold',
    prompt: 'TEST 原始图片请求', petstory: binding, result: 'TEST 用户已停止', outputs: [], artifacts: [], createdAt: SUBMITTED_AT, updatedAt: SUBMITTED_AT,
    errorInfo: { code: 'cancelled', message: 'TEST 用户已停止', recoverable: true, detectedAt: SUBMITTED_AT },
    runtime: {
      runId, attempt: 1, stage: 'paused', message: 'TEST 用户已停止', startedAt: SUBMITTED_AT, stageStartedAt: SUBMITTED_AT,
      lastHeartbeatAt: SUBMITTED_AT, submittedAt: SUBMITTED_AT, conversationUrl: 'https://www.doubao.com/chat/TEST-original-image',
      input: { mode: 'image', prompt: 'TEST 原始图片请求', attachments: [], petstory: binding },
      acceptanceObservation: {
        schemaVersion: 1, accountId: ACCOUNT, runId, conversationUrl: 'https://www.doubao.com/chat/TEST-original-image', acceptedAt: SUBMITTED_AT,
        evidence: { kind: 'generation_started', messageCount: 2 }, cursor: { messageCount: 2, pollCount: 0 }, expectedArtifact: { kind: 'image', runId },
        lease: { ownerId: 'TEST-original-owner', acquiredAt: SUBMITTED_AT, expiresAt: '2026-11-06T03:32:00.000Z', lastHeartbeatAt: SUBMITTED_AT },
        outcome: 'observing',
      },
    },
  };
}

function queuedChat(intent: Task['executionIntent'] = 'hold'): Task {
  return {
    id: 'TEST-keyframe-preparation', projectId: 'TEST-studio', assignedAccountId: ACCOUNT, mode: 'chat', status: 'queued', executionIntent: intent,
    prompt: 'TEST 关键帧提示词准备', petstoryChat: { projectId: 'TEST-short-drama', jobId: 'TEST-keyframe-job' }, result: null, outputs: [], createdAt: NOW, updatedAt: NOW,
  };
}

function seed(items: Task[]): void {
  tasks = structuredClone(items);
  useTaskStore.setState({ tasks: structuredClone(tasks) });
}

beforeEach((): void => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
  tasks = [];
  core = new TaskService({ store: { read: (): Task[] => structuredClone(tasks), replace: (items: Task[]): boolean => { tasks = structuredClone(items); return true; } },
    defaultProjectId: (): string => 'TEST-studio' });
  const account: Account = {
    id: ACCOUNT, name: 'TEST 隔离账号', platform: 'doubao', partition: 'TEST-only', avatar: '', status: 'idle', pinned: false, createdAt: NOW, updatedAt: NOW,
    health: { loginState: 'ok', verificationRequired: false, consecutiveFailures: 0, successCount: 0, failureCount: 0,
      availability: { state: 'ready', reason: 'ready', message: 'TEST', checkedAt: NOW, source: 'manual' } },
  };
  vi.stubGlobal('window', { electronAPI: {
    tasks: {
      updateRuntime: async (id: string, patch: Omit<TaskUpdateRuntimeParams, 'taskId'>): Promise<unknown> => {
        const result = core.updateRuntime({ taskId: id, ...patch });
        return result.success ? { success: true, task: result.data } : result;
      },
      acquireLock: vi.fn(async (id: string, ownerId: string): Promise<unknown> => core.acquireLock({ taskId: id, ownerId })),
      renewLock: async (id: string, ownerId: string): Promise<unknown> => core.renewLock({ taskId: id, ownerId }),
      releaseLock: async (id: string, ownerId: string): Promise<unknown> => core.releaseLock({ taskId: id, ownerId }),
    }, accounts: { setStatus: vi.fn() }, logs: { append: vi.fn() },
  } });
  useAccountStore.setState({ ...initial.accounts, accounts: [account] });
  useTaskStore.setState({ ...initial.tasks, tasks: [], schedulerPaused: false, accountBusy: {}, executingTasks: {}, accountAutomationState: {}, accountAutoMessage: {}, activeTaskId: null, processQueue: vi.fn() });
});

afterEach(async (): Promise<void> => {
  for (const task of tasks) await automationEngine.release(task.id);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
  useTaskStore.setState(initial.tasks); useAccountStore.setState(initial.accounts);
});

describe('已停止图片的历史观察证据与账号占用', (): void => {
  it('paused/hold 已停止图片不阻塞同账号显式开始关键帧准备，原任务与提交保护完整保留', async (): Promise<void> => {
    const original = stoppedImage(); const next = queuedChat(); seed([original, next]);
    expect(original.lock).toBeUndefined();
    expect(Date.parse(original.runtime!.acceptanceObservation!.lease.expiresAt)).toBeLessThan(Date.now());
    expect(await useTaskStore.getState().startAutomation(next.id)).toBe(true);
    expect(useTaskStore.getState().executingTasks[ACCOUNT]).toBe(next.id);
    expect(tasks.find((task: Task): boolean => task.id === original.id)).toEqual(original);
    expect(useTaskStore.getState().tasks.find((task: Task): boolean => task.id === original.id)).toEqual(original);
    expect(core.retry(original.id).success).toBe(false);
    expect(tasks.find((task: Task): boolean => task.id === original.id)).toEqual(original);
  });

  it('已授权的 queued 任务可由正式队列接续，停止图片不会让队列静默卡住', async (): Promise<void> => {
    const original = stoppedImage(); const next = queuedChat('armed'); seed([original, next]);
    await initial.tasks.processQueue();
    expect(useTaskStore.getState().executingTasks[ACCOUNT]).toBe(next.id);
    expect(tasks.find((task: Task): boolean => task.id === next.id)?.status).toBe('executing');
    expect(tasks.find((task: Task): boolean => task.id === original.id)).toEqual(original);
  });

  it('停止后的释放不替 hold 新任务授权或自动开始', async (): Promise<void> => {
    const original = stoppedImage(); const next = queuedChat(); seed([original, next]);
    await initial.tasks.processQueue();
    expect(tasks).toEqual([original, next]);
    expect(useTaskStore.getState().executingTasks).toEqual({});
    expect(window.electronAPI.tasks.acquireLock).not.toHaveBeenCalled();
  });

  it('明确停止记录仍带有效执行锁时由 Core 拒绝接管，历史观察释放不能绕过真实租约', async (): Promise<void> => {
    const original = stoppedImage(); const next = queuedChat();
    original.lock = { ownerId: 'TEST-still-active-owner', acquiredAt: NOW, expiresAt: '2026-11-06T07:01:00.000Z' };
    seed([original, next]);
    expect(await useTaskStore.getState().startAutomation(next.id)).toBe(false);
    expect(useTaskStore.getState().executingTasks).toEqual({});
    expect(tasks.find((task: Task): boolean => task.id === original.id)).toEqual(original);
    expect(automationEngine.isReserved(next.id)).toBe(false);
  });

  it.each(['ordinary-paused', 'image-paused-uncertain', 'image-failed-uncertain'] as const)(
    '仅有 %s 历史状态而无明确图片停止事实时，仍保护待核对原会话', async (condition: 'ordinary-paused' | 'image-paused-uncertain' | 'image-failed-uncertain'): Promise<void> => {
      const original = stoppedImage(condition === 'image-failed-uncertain' ? 'fail' : 'paused'); const next = queuedChat('armed');
      original.errorInfo = { code: 'submission_uncertain', message: 'TEST 原受理结果待核对', recoverable: true, detectedAt: NOW };
      if (condition === 'ordinary-paused') { original.mode = 'chat'; original.petstory = undefined; original.runtime!.input!.mode = 'chat'; }
      seed([original, next]);
      expect(await useTaskStore.getState().startAutomation(next.id)).toBe(false);
      await initial.tasks.processQueue();
      expect(useTaskStore.getState().executingTasks).toEqual({});
      expect(window.electronAPI.tasks.acquireLock).not.toHaveBeenCalled();
      expect(tasks.find((task: Task): boolean => task.id === original.id)).toEqual(original);
    },
  );

  it.each(['executing', 'generating', 'manual_submission_observing', 'waiting_generation_confirmation', 'waiting_verification'] as const)(
    '真实 %s 任务仍占用账号，过期观察租约不能解除活动状态保护', async (status: Task['status']): Promise<void> => {
      const original = stoppedImage(status); const next = queuedChat('armed'); seed([original, next]);
      expect(await useTaskStore.getState().startAutomation(next.id)).toBe(false);
      await initial.tasks.processQueue();
      expect(useTaskStore.getState().executingTasks).toEqual({});
      expect(window.electronAPI.tasks.acquireLock).not.toHaveBeenCalled();
      expect(tasks.find((task: Task): boolean => task.id === original.id)).toEqual(original);
    },
  );

  it('已完成历史即使残留 observing 也不占用账号，原观察证据保持不变', async (): Promise<void> => {
    const original = stoppedImage('done'); const next = queuedChat('armed'); seed([original, next]);
    await initial.tasks.processQueue();
    expect(useTaskStore.getState().executingTasks[ACCOUNT]).toBe(next.id);
    expect(tasks.find((task: Task): boolean => task.id === original.id)).toEqual(original);
  });
});
