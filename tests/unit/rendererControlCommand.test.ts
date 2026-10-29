import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../src/types';
import { classifyControlRejection, handleControlCommand, type RendererControlDependencies } from '../../src/control/handleControlCommand';
import { TaskService } from '../../main/core/TaskService';
import { useTaskStore } from '../../src/store/useTaskStore';
import { requiresSubmissionReconciliation } from '../../src/utils/realSendStateMachine';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1', projectId: 'project-1', batchId: 'batch-1', prompt: 'secret',
    assignedAccountId: 'account-1', status: 'queued', mode: 'video', result: null, outputs: [],
    createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z', ...overrides,
  };
}

function command(action: 'start' | 'pause' | 'cancel' | 'retry' = 'start') {
  return { commandId: 'command-1', requestId: 'request-1', action, projectId: 'project-1', batchId: 'batch-1', taskId: 'task-1' };
}

function deps(tasks: Task[]): RendererControlDependencies {
  return {
    readTasks: vi.fn(async () => tasks),
    start: vi.fn(async () => true), retry: vi.fn(async () => true),
    getLastError: () => null,
    updateStatus: vi.fn(async () => true), abortActive: vi.fn(),
  };
}

describe('handleControlCommand', () => {
  it('每次命令先重新读取权威台账，再按三重 ID 校验', async () => {
    const d = deps([task({ batchId: 'other-batch' })]);
    await expect(handleControlCommand(command(), d)).resolves.toMatchObject({ ok: false, code: 'BATCH_TASK_MISMATCH' });
    expect(d.readTasks).toHaveBeenCalledOnce();
    expect(d.start).not.toHaveBeenCalled();
  });

  it('项目漂移时拒绝执行', async () => {
    const d = deps([task({ projectId: 'other-project' })]);
    await expect(handleControlCommand(command(), d)).resolves.toMatchObject({ ok: false, code: 'PROJECT_TASK_MISMATCH' });
    expect(d.start).not.toHaveBeenCalled();
  });

  it('start 与 retry 复用现有调度动作', async () => {
    const d = deps([task()]);
    await expect(handleControlCommand(command('start'), d)).resolves.toMatchObject({ ok: true, code: 'START_ACCEPTED' });
    await expect(handleControlCommand(command('retry'), d)).resolves.toMatchObject({ ok: true, code: 'RETRY_ACCEPTED' });
    expect(d.start).toHaveBeenCalledWith('task-1');
    expect(d.retry).toHaveBeenCalledWith('task-1');
  });

  it.each(['pause', 'cancel'] as const)('%s 排队任务通过状态边界完成，不触发网页控制', async (action) => {
    const d = deps([task()]);
    await expect(handleControlCommand(command(action), d)).resolves.toMatchObject({ ok: true, accepted: true });
    expect(d.updateStatus).toHaveBeenCalledWith('task-1', action === 'cancel' ? 'cancelled' : 'paused', expect.any(String));
    expect(d.abortActive).not.toHaveBeenCalled();
  });

  it.each(['pause', 'cancel'] as const)('%s 运行任务使用可中止的现有自动化链', async (action) => {
    const d = deps([task({ status: 'executing' })]);
    await expect(handleControlCommand(command(action), d)).resolves.toMatchObject({ ok: true, accepted: true });
    expect(d.abortActive).toHaveBeenCalledWith('task-1', action === 'cancel' ? 'cancelled' : 'paused');
    expect(d.updateStatus).not.toHaveBeenCalled();
  });

  it('明确cancel暂停的提交不明任务仅结束等待，保留全部原请求证据且不能start/retry重发', async (): Promise<void> => {
    const now = '2026-10-29T10:00:00.000Z';
    const original = task({ status: 'paused', mode: 'chat', executionIntent: 'armed', attachments: ['TEST-reference.png'],
      errorInfo: { code: 'submission_uncertain', message: 'TEST 原提交待核对', detectedAt: now, recoverable: false },
      runtime: { runId: 'TEST-original-run', attempt: 1, stage: 'paused', message: 'TEST 原运行', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
        conversationUrl: 'https://www.doubao.com/chat/TEST-original-conversation', input: { prompt: 'TEST original request', mode: 'chat', attachments: ['TEST-reference.png'] } },
      runHistory: [{ runId: 'TEST-original-run', attempt: 1, startedAt: now }] });
    let stored = [structuredClone(original)];
    const core = new TaskService({ store: { read: (): Task[] => structuredClone(stored), replace: (items: Task[]): boolean => { stored = structuredClone(items); return true; } }, defaultProjectId: (): string => 'project-1', now: (): string => now });
    const d = deps(stored); d.readTasks = async (): Promise<Task[]> => structuredClone(stored);
    d.updateStatus = vi.fn(async (taskId: string, status: Task['status'], text: string): Promise<boolean> => core.updateStatus({ taskId, status, result: text }).success);
    await expect(handleControlCommand(command('cancel'), d)).resolves.toMatchObject({ ok: true, code: 'CANCELLED', accepted: true });
    expect(d.start).not.toHaveBeenCalled(); expect(d.retry).not.toHaveBeenCalled(); expect(d.abortActive).not.toHaveBeenCalled();
    expect(stored).toHaveLength(1); expect(stored[0]).toEqual({ ...original, status: 'cancelled', result: '任务已由本机控制面取消', updatedAt: now });
    expect(requiresSubmissionReconciliation(stored[0])).toBe(true); expect(core.retry(original.id)).toMatchObject({ success: false, error: expect.stringContaining('禁止重新发送') });
    const saved = useTaskStore.getState();
    try {
      useTaskStore.setState({ tasks: structuredClone(stored), schedulerPaused: false, accountAutomationState: {} });
      expect(await useTaskStore.getState().startAutomation(original.id)).toBe(false);
      expect(useTaskStore.getState().error).toContain('只有排队中的任务可以启动');
      expect(stored[0].runtime).toEqual(original.runtime); expect(stored[0].errorInfo).toEqual(original.errorInfo);
    } finally { useTaskStore.setState(saved); }
  });

  it.each(['start', 'retry', 'pause', 'cancel'] as const)('保护自由对话的源任务拒绝%s，零状态写入和网页动作', async (action): Promise<void> => {
    const now = '2026-10-29T10:00:00.000Z'; const guarded = task({ status: 'paused', runtime: { runId: 'TEST-run', attempt: 1, stage: 'paused', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { prompt: 'TEST', mode: 'chat', attachments: [] }, chatAdjustmentGuard: { projectId: 'TEST-project', adjustmentId: 'TEST-adjustment', active: true } } });
    const d = deps([guarded]); await expect(handleControlCommand(command(action), d)).resolves.toMatchObject({ ok: false, code: 'TASK_LOCKED', accepted: false });
    expect(d.start).not.toHaveBeenCalled(); expect(d.retry).not.toHaveBeenCalled(); expect(d.updateStatus).not.toHaveBeenCalled(); expect(d.abortActive).not.toHaveBeenCalled();
  });

  it('终态任务拒绝暂停且零写入', async () => {
    const d = deps([task({ status: 'done' })]);
    await expect(handleControlCommand(command('pause'), d)).resolves.toMatchObject({ ok: false, code: 'TASK_NOT_ACTIVE' });
    expect(d.updateStatus).not.toHaveBeenCalled();
    expect(d.abortActive).not.toHaveBeenCalled();
  });

  it('排队任务状态写入失败时 fail-closed', async () => {
    const d = deps([task()]);
    d.updateStatus = vi.fn(async () => false);
    await expect(handleControlCommand(command('pause'), d)).resolves.toMatchObject({ ok: false, code: 'TASK_WRITE_FAILED' });
  });

  it.each([
    ['任务调度已暂停', 'SCHEDULER_PAUSED'],
    ['任务尚未指派账号', 'ACCOUNT_REQUIRED'],
    ['任务依赖尚未就绪', 'DEPENDENCY_NOT_READY'],
    ['账号额度不足', 'QUOTA_UNAVAILABLE'],
    ['账号需要重新登录', 'ACCOUNT_ACTION_REQUIRED'],
    ['该账号仍绑定其他任务', 'ACCOUNT_BUSY'],
    ['任务锁定失败', 'TASK_LOCKED'],
  ])('将内部拒绝文案映射为稳定错误码：%s', (message, code) => {
    expect(classifyControlRejection(message)).toBe(code);
  });

  it('start 拒绝时返回稳定原因且不回显内部文案', async () => {
    const d = deps([task()]);
    d.start = vi.fn(async () => false);
    d.getLastError = () => '账号额度不足：内部详情';
    return expect(handleControlCommand(command('start'), d)).resolves.toEqual({
      commandId: 'command-1', ok: false, code: 'QUOTA_UNAVAILABLE', accepted: false,
    });
  });
});
