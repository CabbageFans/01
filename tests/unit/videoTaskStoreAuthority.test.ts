import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskBatchPauseResult, TaskUpdateRuntimeParams, TaskUpdateStatusParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { TaskRepository } from '../../main/core/TaskRepository';
import { TaskEventStream } from '../../main/core/TaskEventStream';
import { useTaskStore } from '../../src/store/useTaskStore';
import { createAcceptedObservationBinding } from '../../src/utils/acceptedObservation';

function task(revision: number, status: Task['status'] = 'executing'): Task {
  return { id: 'video-authority-store', revision, prompt: '测试镜头', mode: 'video', status, assignedAccountId: 'account', result: null, outputs: [],
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
    runtime: { runId: 'run', attempt: 1, stage: 'preparing_account', message: '', startedAt: '2026-11-10T00:00:00.000Z',
      stageStartedAt: '2026-11-10T00:00:00.000Z', lastHeartbeatAt: '2026-11-10T00:00:00.000Z', input: { mode: 'video', prompt: '测试镜头', attachments: [] } } };
}

function persistedFixture(initial: Task[] = [task(2)]): { service: TaskService; read: () => Task[]; failWrites: () => void } {
  let saved = structuredClone(initial); let writable = true;
  const repository = new TaskRepository({ read: (): Task[] => structuredClone(saved), write: (_filename: string, value: Task[]): boolean => { if (!writable) return false; saved = structuredClone(value); return true; },
    normalize: (raw: unknown): { data: Task[]; changed: false; warnings: string[] } => ({ data: raw as Task[], changed: false, warnings: [] }),
    defaultProjectId: (): string => 'project', events: new TaskEventStream() });
  return { service: new TaskService({ store: repository, defaultProjectId: (): string => 'project' }), read: (): Task[] => repository.read(), failWrites: (): void => { writable = false; } };
}

afterEach((): void => { vi.unstubAllGlobals(); useTaskStore.setState({ tasks: [], error: null, executingTasks: {}, accountBusy: {}, activeTaskId: null }); });

describe('任务状态落盘与快照合并', (): void => {
  it('批量暂停真实Service与Repository同时关闭受理/人工观察，保留原输入与平台确认事实并合并权威版本', async (): Promise<void> => {
    const observing = task(2, 'manual_submission_observing'); observing.runtime!.submittedAt = observing.createdAt;
    observing.runtime!.stage = 'manual_submission_observing'; observing.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-batch-original';
    observing.runtime!.acceptanceObservation = createAcceptedObservationBinding({ accountId: 'account', runId: 'run', conversationUrl: observing.runtime!.conversationUrl,
      acceptedAt: observing.createdAt, ownerId: 'TEST-observer', mode: 'video', evidence: { generationStarted: true, inputCleared: true, messageCount: 1, promptPublished: true } });
    observing.runtime!.manualObservation = { startedAt: observing.createdAt, expiresAt: '2026-11-10T01:00:00.000Z', source: 'stored_conversation', outcome: 'observing' };
    const confirmation = task(4, 'waiting_generation_confirmation'); confirmation.id = 'TEST-batch-confirmation'; confirmation.runtime!.submittedAt = confirmation.createdAt;
    confirmation.runtime!.generationConfirmation = { detectedAt: confirmation.createdAt, marker: 'confirm_before_generation' };
    const { service, read } = persistedFixture([observing, confirmation]); const events = vi.fn();
    vi.stubGlobal('window', { dispatchEvent: events, electronAPI: { tasks: { batchPause: async (): Promise<TaskBatchPauseResult> => {
      const saved = service.batchPause(); return saved.success ? { success: true, tasks: saved.data } : saved;
    } } } });
    useTaskStore.setState({ tasks: read(), executingTasks: { account: observing.id }, accountBusy: { account: true }, schedulerPaused: false });
    expect(await useTaskStore.getState().batchPause()).toBe(true);
    expect(useTaskStore.getState().tasks).toEqual(read()); expect(read().map((item: Task): number | undefined => item.revision)).toEqual([3, 5]);
    expect(read()[0]).toMatchObject({ status: 'paused', runtime: { runId: 'run', input: observing.runtime!.input, submittedAt: observing.createdAt,
      acceptanceObservation: { outcome: 'manual_review' }, manualObservation: { outcome: 'manual_review' } } });
    expect(read()[1]).toMatchObject({ status: 'paused', runtime: { submittedAt: confirmation.createdAt, generationConfirmation: confirmation.runtime!.generationConfirmation } });
    expect(service.retry(observing.id).success).toBe(false); expect(service.retry(confirmation.id).success).toBe(false);
    expect(useTaskStore.getState().executingTasks).toEqual({}); expect(events).toHaveBeenCalledTimes(2);
  });

  it('批量暂停写盘失败时本地调度停止，但任务快照不伪造已暂停', async (): Promise<void> => {
    const { service, read, failWrites } = persistedFixture(); const original = read(); failWrites();
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { tasks: { batchPause: async (): Promise<TaskBatchPauseResult> => {
      const saved = service.batchPause(); return saved.success ? { success: true, tasks: saved.data } : saved;
    } } } });
    useTaskStore.setState({ tasks: original, executingTasks: { account: original[0].id }, accountBusy: { account: true }, schedulerPaused: false }); expect(await useTaskStore.getState().batchPause()).toBe(false);
    expect(useTaskStore.getState().schedulerPaused).toBe(true); expect(useTaskStore.getState().tasks).toEqual(original); expect(read()).toEqual(original);
    expect(useTaskStore.getState().error).toContain('写入失败');
    expect(useTaskStore.getState().executingTasks).toEqual({}); expect(useTaskStore.getState().accountBusy).toEqual({});
  });

  it('旧批量暂停快照晚到不覆盖后续run或清除新run执行权', async (): Promise<void> => {
    const { service, read } = persistedFixture(); let release: ((result: TaskBatchPauseResult) => void) | undefined; let saved: TaskBatchPauseResult | undefined;
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { tasks: { batchPause: (): Promise<TaskBatchPauseResult> => {
      const stopped = service.batchPause(); saved = stopped.success ? { success: true, tasks: stopped.data } : stopped;
      return new Promise((resolve): void => { release = resolve; });
    } } } });
    useTaskStore.setState({ tasks: read(), schedulerPaused: false }); const pausing = useTaskStore.getState().batchPause();
    expect(service.retry('video-authority-store').success).toBe(true);
    expect(service.updateRuntime({ taskId: 'video-authority-store', expectedRunId: 'run', status: 'executing', runtime: { runId: 'TEST-batch-next-run', attempt: 2, stage: 'preparing_account' } }).success).toBe(true);
    const current = read(); useTaskStore.getState().reconcileTasks(current); useTaskStore.setState({ executingTasks: { account: current[0].id }, accountBusy: { account: true } });
    release?.(saved!); expect(await pausing).toBe(false); expect(useTaskStore.getState().tasks).toEqual(current);
    expect(useTaskStore.getState().executingTasks).toEqual({ account: current[0].id });
  });

  it.each(['missing', 'lost'] as const)('完成命令%s ACK后只消费真实服务回读，不合成revision或产物', async (ack: 'missing' | 'lost'): Promise<void> => {
    const { service, read } = persistedFixture();
    vi.stubGlobal('window', { electronAPI: { tasks: {
      updateStatus: async (taskId: string, status: Task['status'], result?: string, outputs?: string[], identity?: Pick<TaskUpdateStatusParams, 'expectedRunId' | 'expectedRevision'>): Promise<{ success: boolean }> => {
        expect(service.updateStatus({ taskId, status, result, outputs, ...identity }).success).toBe(true);
        if (ack === 'lost') throw new Error('fixture ACK丢失'); return { success: true };
      }, list: async (): Promise<Task[]> => read(),
    } } });
    useTaskStore.setState({ tasks: read() });
    expect(await useTaskStore.getState().updateTaskStatus('video-authority-store', 'done', '完成', ['https://fixture.invalid/video.mp4'])).toBe(true);
    expect(useTaskStore.getState().tasks).toEqual(read());
    expect(useTaskStore.getState().tasks[0]).toMatchObject({ revision: 3, status: 'done', runtime: { stage: 'completed' }, artifacts: [{ source: 'network', runId: 'run' }] });
  });

  it('success无权威快照且回读未保存时返回失败，不捏造状态、时间或产物', async (): Promise<void> => {
    const { read } = persistedFixture(); const original = read();
    vi.stubGlobal('window', { electronAPI: { tasks: { updateStatus: async (): Promise<{ success: true }> => ({ success: true }), list: async (): Promise<Task[]> => read() } } });
    useTaskStore.setState({ tasks: original });
    expect(await useTaskStore.getState().updateTaskStatus(original[0].id, 'done', '完成', ['https://fixture.invalid/unsaved.mp4'])).toBe(false);
    expect(useTaskStore.getState().tasks).toEqual(original); expect(useTaskStore.getState().error).toBeTruthy();
  });

  it('原完成命令缺快照的ACK晚于新run返回时，不修改新运行且不报告原命令已确认', async (): Promise<void> => {
    const { service, read } = persistedFixture(); let acknowledge: (() => void) | undefined;
    vi.stubGlobal('window', { electronAPI: { tasks: {
      updateStatus: async (taskId: string, status: Task['status'], result?: string, outputs?: string[], identity?: Pick<TaskUpdateStatusParams, 'expectedRunId' | 'expectedRevision'>): Promise<{ success: true }> => {
        expect(service.updateStatus({ taskId, status, result, outputs, ...identity }).success).toBe(true);
        await new Promise<void>((resolve): void => { acknowledge = resolve; }); return { success: true };
      }, list: async (): Promise<Task[]> => read(),
    } } });
    useTaskStore.setState({ tasks: read() });
    const completing = useTaskStore.getState().updateTaskStatus('video-authority-store', 'done', '旧结果', ['https://fixture.invalid/old.mp4']);
    expect(service.retry('video-authority-store').success).toBe(true);
    expect(service.updateRuntime({ taskId: 'video-authority-store', expectedRunId: 'run', status: 'executing', runtime: { runId: 'next-run', attempt: 2, stage: 'preparing_account' } }).success).toBe(true);
    const current = read(); useTaskStore.getState().reconcileTasks(current);
    acknowledge?.(); expect(await completing).toBe(false);
    expect(useTaskStore.getState().tasks).toEqual(current); expect(read()).toEqual(current);
  });

  it('迟到 list 不能覆盖期间已保存的新版本', async (): Promise<void> => {
    let finish: ((value: Task[]) => void) | undefined;
    vi.stubGlobal('window', { electronAPI: { tasks: { list: (): Promise<Task[]> => new Promise((resolve): void => { finish = resolve; }) } } });
    useTaskStore.setState({ tasks: [task(1)] });
    const loading = useTaskStore.getState().loadTasks();
    useTaskStore.setState({ tasks: [task(2, 'paused')] });
    finish?.([task(1)]); await loading;
    expect(useTaskStore.getState().tasks[0]).toMatchObject({ revision: 2, status: 'paused' });
  });

  it('暂停写盘失败释放本地执行权但不伪造已暂停事实', async (): Promise<void> => {
    vi.stubGlobal('window', { electronAPI: { tasks: { updateRuntime: vi.fn(async (): Promise<{ success: false; error: string }> => ({ success: false, error: 'fixture 磁盘失败' })) },
      logs: { append: vi.fn(async (): Promise<void> => undefined) }, accounts: { setStatus: vi.fn(async (): Promise<void> => undefined) } } });
    useTaskStore.setState({ tasks: [task(2)], executingTasks: { account: 'video-authority-store' }, accountBusy: { account: true }, activeTaskId: 'video-authority-store' });
    await useTaskStore.getState().pauseAutomation('video-authority-store', 'account');
    expect(useTaskStore.getState().tasks[0].status).toBe('executing');
    expect(useTaskStore.getState().executingTasks).toEqual({});
    expect(useTaskStore.getState().error).toContain('磁盘失败');
  });

  it('正式结束原观察原子保存cancelled并结束租约，原提交与输入保留', async (): Promise<void> => {
    const original = task(2, 'generating'); const acceptedAt = original.createdAt;
    original.runtime!.stage = 'generating'; original.runtime!.submittedAt = acceptedAt;
    original.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-original-video';
    original.runtime!.acceptanceObservation = createAcceptedObservationBinding({ accountId: 'account', runId: 'run',
      conversationUrl: original.runtime!.conversationUrl, acceptedAt, ownerId: 'observer', mode: 'video',
      evidence: { generationStarted: true, inputCleared: true, messageCount: 1, promptPublished: true } });
    let saved = [structuredClone(original)];
    const service = new TaskService({ store: { read: (): Task[] => structuredClone(saved), replace: (next: Task[]): boolean => { saved = structuredClone(next); return true; } }, defaultProjectId: (): string => 'project' });
    vi.stubGlobal('window', { electronAPI: { tasks: { updateRuntime: async (taskId: string, params: Omit<TaskUpdateRuntimeParams, 'taskId'>): Promise<{ success: boolean; task?: Task; error?: string }> => {
      const result = service.updateRuntime({ ...params, taskId });
      return result.success ? { success: true, task: result.data } : { success: false, task: result.task, error: result.error };
    } }, logs: { append: vi.fn(async (): Promise<void> => undefined) }, accounts: { setStatus: vi.fn(async (): Promise<void> => undefined) } } });
    useTaskStore.setState({ tasks: [original], executingTasks: { account: original.id }, accountBusy: { account: true }, activeTaskId: original.id });
    await useTaskStore.getState().pauseAutomation(original.id, 'account', '已结束本地等待', { status: 'cancelled', code: 'local_wait_ended', expectedRunId: 'run', endObservation: true });
    expect(saved[0]).toMatchObject({ status: 'cancelled', runtime: { runId: 'run', stage: 'cancelled', submittedAt: acceptedAt, input: original.runtime!.input,
      acceptanceObservation: { outcome: 'manual_review', accountId: 'account', runId: 'run', conversationUrl: original.runtime!.conversationUrl } } });
    expect(saved[0].runtime!.acceptanceObservation!.lease.expiresAt).toBe(saved[0].runtime!.acceptanceObservation!.lease.lastHeartbeatAt);
    expect(useTaskStore.getState().tasks[0].status).toBe('cancelled'); expect(useTaskStore.getState().executingTasks).toEqual({});
  });

  it('删除期间晚到的旧列表不能让已清理任务复活', async (): Promise<void> => {
    const deleted = { ...task(2, 'done'), id: 'deleted-video-authority-store' };
    let finish: ((value: Task[]) => void) | undefined;
    vi.stubGlobal('window', { electronAPI: { tasks: {
      list: (): Promise<Task[]> => new Promise((resolve): void => { finish = resolve; }),
      delete: vi.fn(async (): Promise<{ success: true }> => ({ success: true })),
    } } });
    useTaskStore.setState({ tasks: [deleted] });
    const loading = useTaskStore.getState().loadTasks();
    expect(await useTaskStore.getState().deleteTask(deleted.id)).toBe(true);
    finish?.([deleted]); await loading;
    expect(useTaskStore.getState().tasks).toEqual([]);
  });

  it('同运行命令回执逆序返回时仍保留较新的权威版本', async (): Promise<void> => {
    let finishFirst: ((value: { success: true; task: Task }) => void) | undefined;
    let finishSecond: ((value: { success: true; task: Task }) => void) | undefined;
    const update = vi.fn().mockImplementationOnce((): Promise<{ success: true; task: Task }> => new Promise((resolve): void => { finishFirst = resolve; }))
      .mockImplementationOnce((): Promise<{ success: true; task: Task }> => new Promise((resolve): void => { finishSecond = resolve; }));
    vi.stubGlobal('window', { electronAPI: { tasks: { updateRuntime: update } } });
    useTaskStore.setState({ tasks: [task(1)] });
    const first = useTaskStore.getState().updateTaskRuntime('video-authority-store', { runtime: { message: '旧阶段' } });
    const second = useTaskStore.getState().updateTaskRuntime('video-authority-store', { runtime: { message: '新阶段' } });
    await Promise.resolve();
    const latest = task(3); latest.runtime!.message = '新阶段';
    finishSecond?.({ success: true, task: latest }); expect(await second).toBe(true);
    const old = task(2); old.runtime!.message = '旧阶段';
    finishFirst?.({ success: true, task: old }); await first;
    expect(useTaskStore.getState().tasks[0]).toMatchObject({ revision: 3, runtime: { message: '新阶段' } });
  });
});
