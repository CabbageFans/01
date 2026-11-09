/** 真实 TaskService 与 JSON/归一化往返；IPC 仅转发，不伪造持久化成功。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskUpdateRuntimeParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';
import { useTaskStore } from '../../src/store/useTaskStore';

const NOW = '2026-11-09T00:00:00.000Z';
const ACCOUNT = 'TEST-stage-account';
const initial = useTaskStore.getState();
type RuntimeWriteResult = Awaited<ReturnType<typeof window.electronAPI.tasks.updateRuntime>>;
let sequence = 0;
let core: TaskService;
let persisted: string;
let failWrites: boolean;
let id: string;

function read(): Task { return normalizeTasks(JSON.parse(persisted), 'TEST-studio', NOW).data[0]; }
function refresh(): void { useTaskStore.setState({ tasks: [structuredClone(read())] }); }
function writeRuntime(taskId: string, patch: Omit<TaskUpdateRuntimeParams, 'taskId'>): RuntimeWriteResult {
  const result = core.updateRuntime({ taskId, ...structuredClone(patch) });
  return result.success ? { success: true, task: structuredClone(result.data) } : result;
}
function seed(guarded: boolean = false): void {
  id = `TEST-stage-${++sequence}`;
  const mode = guarded ? 'chat' : 'video';
  const task: Task = { id, projectId: 'TEST-studio', assignedAccountId: ACCOUNT, prompt: 'TEST immutable input', mode, status: 'paused', executionIntent: 'armed',
    videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' }, attachments: ['TEST-first.png'], result: null, outputs: [], createdAt: NOW, updatedAt: NOW,
    runtime: { runId: `TEST-run-${id}`, attempt: 1, stage: 'preparing_account', message: 'TEST preparing', startedAt: NOW, stageStartedAt: NOW, lastHeartbeatAt: NOW,
      input: { prompt: 'TEST immutable input', mode, attachments: ['TEST-first.png'], videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' } } } };
  persisted = JSON.stringify([task]); failWrites = false;
  core = new TaskService({ store: { read: (): Task[] => [read()], replace: (items: Task[]): boolean => { if (failWrites) return false; persisted = JSON.stringify(items); return true; } },
    defaultProjectId: (): string => 'TEST-studio', now: (): string => new Date().toISOString() });
  if (guarded) core.setConversationGuard(id, 'TEST-creative-project', 'TEST-adjustment', true);
  expect(core.updateRuntime({ taskId: id, status: 'executing' }).success).toBe(true);
  useTaskStore.setState({ ...initial, tasks: [structuredClone(read())], executingTasks: { [ACCOUNT]: id }, accountAutomationState: {}, accountAutoMessage: {}, processQueue: vi.fn() });
  vi.stubGlobal('window', { electronAPI: { tasks: { updateRuntime: vi.fn(async (taskId: string, patch: Omit<TaskUpdateRuntimeParams, 'taskId'>): Promise<RuntimeWriteResult> => writeRuntime(taskId, patch)) } } });
}

beforeEach((): void => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach((): void => { vi.clearAllTimers(); vi.useRealTimers(); useTaskStore.setState(initial); vi.unstubAllGlobals(); });

describe('自动化阶段只持久化自身字段', (): void => {
  it.each([false, true])('归一化完整快照的保护字段仍被真实服务拒绝（guard=%s）', (guarded: boolean): void => {
    seed(guarded); const before = read(); const runtime = structuredClone(before.runtime!);
    expect(Object.prototype.hasOwnProperty.call(runtime, 'chatAdjustmentGuard')).toBe(true);
    runtime.stage = 'configuring';
    expect(core.updateRuntime({ taskId: id, runtime })).toMatchObject({ success: false, error: '对话保护只能由对应创作调整操作更新' });
    expect(read()).toEqual(before);
  });

  it.each([false, true])('阶段确实落盘且原输入和保护保持不变（guard=%s）', async (guarded: boolean): Promise<void> => {
    seed(guarded); const before = read();
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'injecting', 'TEST configuring', 'configuring', id);
    await vi.waitFor((): void => expect(read().runtime!.stage).toBe('configuring'));
    expect(read().runtime!.message).toBe('TEST configuring'); expect(read().runtime!.input).toEqual(before.runtime!.input);
    expect(read().runtime!.runId).toBe(before.runtime!.runId); expect(read().runtime!.chatAdjustmentGuard).toEqual(before.runtime!.chatAdjustmentGuard);
    const patch = vi.mocked(window.electronAPI.tasks.updateRuntime).mock.calls[0][1];
    expect(patch.expectedRunId).toBe(before.runtime!.runId);
    expect(Object.keys(patch.runtime!).sort()).toEqual(['lastHeartbeatAt', 'message', 'stage', 'stageStartedAt']);
  });

  it('写入失败明确报告且不占用节流，下次同阶段调用可正式保存；成功后才节流', async (): Promise<void> => {
    seed(); failWrites = true;
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'injecting', 'TEST rejected stage', 'configuring', id);
    await vi.waitFor((): void => expect(useTaskStore.getState().error).toContain('写入失败'));
    expect(read().runtime!.stage).toBe('preparing_account');
    failWrites = false;
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'injecting', 'TEST saved stage', 'configuring', id);
    await vi.waitFor((): void => expect(read().runtime!.message).toBe('TEST saved stage'));
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'injecting', 'TEST throttled heartbeat', 'configuring', id);
    await Promise.resolve(); expect(read().runtime!.message).toBe('TEST saved stage');
    expect(window.electronAPI.tasks.updateRuntime).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'injecting', 'TEST renewed heartbeat', 'configuring', id);
    await vi.waitFor((): void => expect(read().runtime!.message).toBe('TEST renewed heartbeat'));
  });

  it('新运行处于相同阶段时不沿用旧运行节流，且不通过阶段patch替换run或输入', async (): Promise<void> => {
    seed(); useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'injecting', 'TEST first run', 'configuring', id);
    await vi.waitFor((): void => expect(read().runtime!.stage).toBe('configuring'));
    const before = read().runtime!;
    expect(core.updateRuntime({ taskId: id, runtime: { runId: 'TEST-new-run', attempt: 2, stage: 'configuring', message: 'TEST new run', startedAt: NOW, stageStartedAt: NOW, lastHeartbeatAt: NOW, input: before.input } }).success).toBe(true);
    refresh(); useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'injecting', 'TEST same stage new run', 'configuring', id);
    await vi.waitFor((): void => expect(read().runtime!.message).toBe('TEST same stage new run'));
    expect(read().runtime!.runId).toBe('TEST-new-run'); expect(read().runtime!.input).toEqual(before.input);
    expect(window.electronAPI.tasks.updateRuntime).toHaveBeenCalledTimes(2);
  });

  it('旧运行的IPC直到新运行创建后才到达时，真实服务零写拒绝，不污染新运行或当前错误', async (): Promise<void> => {
    seed(); const old = read(); let release!: () => void;
    vi.mocked(window.electronAPI.tasks.updateRuntime).mockImplementationOnce((taskId: string, patch: Omit<TaskUpdateRuntimeParams, 'taskId'>): Promise<RuntimeWriteResult> => new Promise((resolve: (value: RuntimeWriteResult | PromiseLike<RuntimeWriteResult>) => void): void => {
      release = (): void => { resolve(writeRuntime(taskId, patch)); };
    }));
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'injecting', 'TEST late old stage', 'configuring', id);
    expect(core.updateRuntime({ taskId: id, runtime: { runId: 'TEST-replacement-run', attempt: 2, stage: 'preparing_account', message: 'TEST new runtime', startedAt: NOW, stageStartedAt: NOW, lastHeartbeatAt: NOW, input: old.runtime!.input } }).success).toBe(true);
    refresh(); const current = read(); release(); await Promise.resolve(); await Promise.resolve();
    expect(read()).toEqual(current); expect(useTaskStore.getState().error).toBeNull();
    expect(core.updateRuntime({ taskId: id, expectedRunId: old.runtime!.runId, runtime: { message: 'TEST must reject' } })).toMatchObject({ success: false, error: '原任务运行已变化，未更新运行状态' });
    expect(read()).toEqual(current);
  });

  it.each([false, true])('同运行较旧阶段的迟到回执不覆盖新阶段错误或节流（oldFailed=%s）', async (oldFailed: boolean): Promise<void> => {
    seed(); let release!: () => void;
    vi.mocked(window.electronAPI.tasks.updateRuntime).mockImplementationOnce((taskId: string, patch: Omit<TaskUpdateRuntimeParams, 'taskId'>): Promise<RuntimeWriteResult> => {
      failWrites = oldFailed; const result = writeRuntime(taskId, patch); failWrites = false;
      return new Promise((resolve: (value: RuntimeWriteResult | PromiseLike<RuntimeWriteResult>) => void): void => { release = (): void => resolve(result); });
    });
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'injecting', 'TEST old configuring', 'configuring', id);
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'injecting', 'TEST latest injecting', 'injecting_prompt', id);
    await vi.waitFor((): void => expect(read().runtime!.stage).toBe('injecting_prompt'));
    release(); await Promise.resolve(); await Promise.resolve();
    expect(useTaskStore.getState().error).toBeNull(); expect(read().runtime!.message).toBe('TEST latest injecting');
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'injecting', 'TEST throttled latest heartbeat', 'injecting_prompt', id);
    await Promise.resolve(); expect(window.electronAPI.tasks.updateRuntime).toHaveBeenCalledTimes(2);
    expect(read().runtime!.message).toBe('TEST latest injecting');
  });

  it('expectedRunId为空同样零写拒绝，匹配值不允许绕过专用保护', (): void => {
    seed(true); const before = read();
    expect(core.updateRuntime({ taskId: id, expectedRunId: '', runtime: { stage: 'configuring' } }).success).toBe(false);
    expect(core.updateRuntime({ taskId: id, expectedRunId: before.runtime!.runId, runtime: { chatAdjustmentGuard: undefined } }).success).toBe(false);
    expect(read()).toEqual(before);
  });

  it.each([false, true])('submitting仅携带正式已有的提交意图，不因阶段展示生成新意图（existing=%s）', async (existing: boolean): Promise<void> => {
    seed(); if (existing) expect(core.updateRuntime({ taskId: id, runtime: { submittedAt: NOW } }).success).toBe(true);
    refresh(); useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'submitting', 'TEST submitting', 'submitting', id);
    await vi.waitFor((): void => expect(read().runtime!.stage).toBe('submitting'));
    expect(read().runtime!.submittedAt).toBe(existing ? NOW : undefined);
    expect(useTaskStore.getState().tasks[0].runtime!.submittedAt).toBe(existing ? NOW : undefined);
    const patch = vi.mocked(window.electronAPI.tasks.updateRuntime).mock.calls[0][1];
    expect(Object.prototype.hasOwnProperty.call(patch.runtime, 'submittedAt')).toBe(existing);
  });

  it.each([false, true])('原媒体回执不会被陈旧快照覆盖，阶段写入成功或失败重入均保留原证据（failFirst=%s）', async (failFirst: boolean): Promise<void> => {
    seed(); const before = read(); const conversationUrl = 'https://www.doubao.com/chat/TEST-stage-original';
    expect(core.updateRuntime({ taskId: id, runtime: { submittedAt: NOW, conversationUrl } }).success).toBe(true);
    expect(core.updateRuntime({ taskId: id, runtime: { mediaSubmissionReceipt: { schemaVersion: 1, source: 'published_message', accountId: ACCOUNT,
      runId: before.runtime!.runId, submittedAt: NOW, observedAt: NOW, conversationUrl, userMessageId: 'TEST-original-message' } } }).success).toBe(true);
    const receipt = read().runtime!.mediaSubmissionReceipt;
    expect(receipt).toBeDefined(); failWrites = failFirst;
    // Renderer 仍为提交前快照；只能报告阶段，不能把其中的 undefined 收据或旧输入回传。
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'generating', 'TEST extracting', 'extracting_outputs', id);
    if (failFirst) {
      await vi.waitFor((): void => expect(useTaskStore.getState().error).toContain('写入失败'));
      expect(read().runtime!.stage).toBe('preparing_account'); failWrites = false;
      useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'generating', 'TEST extracting', 'extracting_outputs', id);
    }
    await vi.waitFor((): void => expect(read().runtime!.stage).toBe('extracting_outputs'));
    expect(read().runtime!.mediaSubmissionReceipt).toEqual(receipt); expect(read().runtime!.submittedAt).toBe(NOW);
    expect(read().runtime!.input).toEqual(before.runtime!.input);
    for (const [, patch] of vi.mocked(window.electronAPI.tasks.updateRuntime).mock.calls) {
      expect(Object.keys(patch.runtime!).sort()).toEqual(['lastHeartbeatAt', 'message', 'stage', 'stageStartedAt']);
    }
  });

  it('仅续租已有observing绑定，原受理依据不变且不发送专用保护或其他证据', async (): Promise<void> => {
    seed(); const before = read();
    expect(core.updateRuntime({ taskId: id, runtime: { submittedAt: NOW, conversationUrl: 'https://www.doubao.com/chat/TEST-stage-observation', acceptanceObservation: {
      schemaVersion: 1, accountId: ACCOUNT, runId: before.runtime!.runId, conversationUrl: 'https://www.doubao.com/chat/TEST-stage-observation', acceptedAt: NOW,
      evidence: { kind: 'generation_started', messageCount: 1 }, cursor: { messageCount: 1, pollCount: 2 }, expectedArtifact: { kind: 'video', runId: before.runtime!.runId },
      lease: { ownerId: 'TEST-observer', acquiredAt: NOW, expiresAt: NOW, lastHeartbeatAt: NOW }, outcome: 'observing',
    } } }).success).toBe(true);
    refresh(); const observation = read().runtime!.acceptanceObservation!; await vi.advanceTimersByTimeAsync(1_000);
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'generating', 'TEST observing', 'generating', id);
    await vi.waitFor((): void => expect(read().runtime!.stage).toBe('generating'));
    const saved = read().runtime!.acceptanceObservation!;
    expect(saved.evidence).toEqual(observation.evidence); expect(saved.expectedArtifact).toEqual(observation.expectedArtifact);
    expect(saved.cursor.pollCount).toBe(observation.cursor.pollCount + 1); expect(Date.parse(saved.lease.expiresAt)).toBeGreaterThan(Date.parse(observation.lease.expiresAt));
    expect(read().runtime!.input).toEqual(before.runtime!.input);
    expect(Object.keys(vi.mocked(window.electronAPI.tasks.updateRuntime).mock.calls[0][1].runtime!).sort()).toEqual(['acceptanceObservation', 'lastHeartbeatAt', 'message', 'stage', 'stageStartedAt']);
  });

  it('其他任务占用同一执行位置时原task显式阶段调用仍被拒绝', async (): Promise<void> => {
    seed(); const before = read(); useTaskStore.setState({ executingTasks: { [ACCOUNT]: 'TEST-other-controller-task' } });
    useTaskStore.getState().setAccountAutomationState(ACCOUNT, 'injecting', 'TEST stale controller', 'configuring', id);
    await Promise.resolve(); expect(read()).toEqual(before); expect(window.electronAPI.tasks.updateRuntime).not.toHaveBeenCalled();
  });
});
