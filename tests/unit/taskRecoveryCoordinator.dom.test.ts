import { afterEach, expect, it, vi } from 'vitest';
import { message } from 'antd';
import type { Task, TaskUpdateRuntimeParams, TaskUpdateStatusParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { TaskRepository } from '../../main/core/TaskRepository';
import { TaskEventStream } from '../../main/core/TaskEventStream';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';
import { createTaskRecoveryCoordinator, type TaskRecoveryHost } from '../../src/automation/TaskRecoveryCoordinator';
import { DoubaoVideoAdapter } from '../../src/automation/DoubaoVideoAdapter';
import { stopTaskAutomation } from '../../src/automation/taskStopCommand';
import { createAcceptedObservationBinding } from '../../src/utils/acceptedObservation';
import { automationEngine } from '../../src/automation/AutomationEngine';
import { useAccountStore } from '../../src/store/useAccountStore';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { MaterialImagePages } from '../../src/utils/materialImagePages';
import { settleVideoFixture, videoFixturePrompt, videoFixtureUrl, videoWorkflowFixture, workflowCard, workflowMessage } from '../fixtures/videoWorkflowDom';

function closedMessage(): ReturnType<typeof message.error> {
  const closed = Promise.resolve(true); return Object.assign((): void => {}, { then: closed.then.bind(closed) });
}

afterEach((): void => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
  useTaskStore.setState({ tasks: [], executingTasks: {}, accountAutomationState: {}, accountAutoMessage: {}, accountBusy: {}, activeTaskId: null });
  useAccountStore.setState({ accounts: [], selectedAccountId: null }); usePetStoryStore.setState({ project: null });
});

function recoveryHost(view: HTMLWebViewElement, checkedAt: string): TaskRecoveryHost {
  return { abortControllersRef: { current: new Map() }, pendingCancellationStatusRef: { current: new Map() }, submissionReconcileRef: { current: new Set() }, submissionReconcilePromisesRef: { current: new Map() },
    submissionReconcileUsageRef: { current: new Set() }, submittedImagePagesRef: { current: new Map() }, materialPagesRef: { current: new MaterialImagePages() }, visibleRef: { current: false },
    getTaskWebview: (): HTMLWebViewElement => view, ensureTaskWebview: (): HTMLWebViewElement => view, taskWebviewReady: (): boolean => true, ownsTaskWebview: (): boolean => true,
    assertNoHumanVerification: async (): Promise<void> => {}, performAvailabilityCheck: async (): Promise<import('@doubao-studio/contracts').AccountAvailability> => ({ state: 'ready', reason: 'ready', message: 'TEST', checkedAt, source: 'manual' }),
    synchronizeConversation: vi.fn(async (): Promise<import('../../src/utils/conversationSync').ConversationSyncResult> => ({ ok: false, reason: 'CONTEXT_CHANGED' })), conversationSyncMessage: (): string => 'TEST must remain on original page' };
}

it.each(['resolved', 'unauthorized', 'expired', 'needs_manual_selection', 'user_pause', 'user_cancel'] as const)('正式恢复协调器沿原run处理%s，重挂载共享观察且零再次激活', async (terminal): Promise<void> => {
  vi.useFakeTimers(); const page = videoWorkflowFixture('reference', true); page.editor.value = '';
  workflowMessage('user', videoFixturePrompt, 'TEST-original-user'); const assistant = workflowMessage('assistant', '视频生成好了', 'TEST-original-assistant');
  workflowCard(assistant, 'TEST-original-vid', terminal === 'resolved' || terminal === 'user_pause' || terminal === 'user_cancel' || terminal === 'needs_manual_selection' ? 'https://fixture.test/video/original.mp4' : '');
  if (terminal === 'needs_manual_selection') workflowCard(assistant, 'TEST-other-vid', 'https://fixture.test/video/other.mp4');
  const submittedAt = new Date().toISOString();
  let stored: Task[] = [{ id: 'TEST-recovery-task', revision: 3, prompt: videoFixturePrompt, promptReadback: 'exact', mode: 'video', status: 'paused', assignedAccountId: 'TEST-account',
    videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' }, result: null, outputs: [], createdAt: submittedAt, updatedAt: submittedAt,
    runtime: { runId: 'TEST-original-run', attempt: 1, stage: 'paused', message: 'TEST 原受理观察', startedAt: submittedAt, stageStartedAt: submittedAt,
      lastHeartbeatAt: submittedAt, submittedAt, conversationUrl: videoFixtureUrl, submission: { schemaVersion: 1, operationId: 'TEST-original-operation', runId: 'TEST-original-run', state: 'dispatch_unknown', updatedAt: submittedAt },
      input: { mode: 'video', prompt: videoFixturePrompt, attachments: [], videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' } } } }];
  stored[0].runtime!.acceptanceObservation = createAcceptedObservationBinding({ accountId: 'TEST-account', runId: 'TEST-original-run', conversationUrl: videoFixtureUrl, acceptedAt: submittedAt, ownerId: 'TEST-original-observer', mode: 'video', evidence: { generationStarted: true, inputCleared: true, messageCount: 1, promptPublished: true } });
  const repository = new TaskRepository({ read: (): Task[] => structuredClone(stored), write: (_file: string, tasks: Task[]): boolean => { stored = structuredClone(tasks); return true; },
    normalize: normalizeTasks, events: new TaskEventStream(), defaultProjectId: (): string => 'TEST-project' });
  const core = new TaskService({ store: repository, defaultProjectId: (): string => 'TEST-project' });
  const read = (): Task[] => { const result = core.getTasks(); if (!result.success) throw new Error(result.error); return result.data; };
  const nativeWindow = window;
  vi.stubGlobal('window', Object.assign(nativeWindow, { electronAPI: { tasks: {
    list: async (): Promise<Task[]> => read(),
    updateRuntime: async (taskId: string, patch: Omit<TaskUpdateRuntimeParams, 'taskId'>): Promise<{ success: boolean; task?: Task; error?: string }> => {
      const result = core.updateRuntime({ ...patch, taskId }); return result.success ? { success: true, task: result.data } : result;
    },
    updateStatus: async (taskId: string, status: Task['status'], resultText?: string, outputs?: string[], identity?: Pick<TaskUpdateStatusParams, 'expectedRunId' | 'expectedRevision'>): Promise<{ success: boolean; task?: Task; error?: string }> => {
      const result = core.updateStatus({ taskId, status, result: resultText, outputs, ...identity }); return result.success ? { success: true, task: result.data } : result;
    },
  }, logs: { append: vi.fn(async (): Promise<void> => {}) }, accounts: { setStatus: vi.fn(async (): Promise<void> => {}) } } }));
  vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response(JSON.stringify({ code: terminal === 'expired' ? 404 : 401 }), { status: terminal === 'expired' ? 404 : 401 })));
  useTaskStore.setState({ tasks: read(), accountAutomationState: {}, accountAutoMessage: {}, executingTasks: {}, accountBusy: {} });
  const accountState = useAccountStore.getState(); const recordUsage = vi.fn(async (): Promise<void> => {});
  vi.spyOn(useAccountStore, 'getState').mockReturnValue({ ...accountState, accounts: [{ id: 'TEST-account', name: 'TEST', avatar: '', platform: 'doubao', partition: 'TEST-partition', status: 'idle', pinned: false, createdAt: submittedAt, updatedAt: submittedAt }],
    recordAccountOutcome: vi.fn(async (): Promise<void> => {}), recordSeedanceUsage: recordUsage, selectAccount: vi.fn() });
  vi.spyOn(automationEngine, 'hasController').mockReturnValue(false);
  vi.spyOn(message, 'error').mockImplementation(closedMessage); vi.spyOn(message, 'warning').mockImplementation(closedMessage); vi.spyOn(message, 'success').mockImplementation(closedMessage);
  const view = page.view as unknown as HTMLWebViewElement;
  const host = recoveryHost(view, submittedAt);
  const actualObserve = DoubaoVideoAdapter.prototype.observe; let enter: (() => void) | undefined; let release: (() => void) | undefined;
  const entered = new Promise<void>((resolve): void => { enter = resolve; }); const blocked = new Promise<void>((resolve): void => { release = resolve; });
  const observe = vi.spyOn(DoubaoVideoAdapter.prototype, 'observe').mockImplementation(async function(this: DoubaoVideoAdapter, options): Promise<import('../../src/utils/videoArtifactResolver').VideoArtifactResolution> {
    enter?.(); await blocked; return actualObserve.call(this, options);
  });
  const firstSettled = vi.fn(); const secondSettled = vi.fn();
  const event = (onSettled: () => void): Event => new CustomEvent('reconcile-task-submission', { detail: { taskId: 'TEST-recovery-task', accountId: 'TEST-account', runId: 'TEST-original-run', submittedAt, onSettled } });
  const first = createTaskRecoveryCoordinator(host).handleSubmissionReconcileSafely(event(firstSettled));
  await settleVideoFixture(entered, 15_000);
  const sharedPromise = host.submissionReconcilePromisesRef.current.get('TEST-recovery-task'); const sharedController = host.abortControllersRef.current.get('TEST-recovery-task');
  const second = createTaskRecoveryCoordinator(host).handleSubmissionReconcileSafely(event(secondSettled));
  expect(host.submissionReconcilePromisesRef.current.get('TEST-recovery-task')).toBe(sharedPromise); expect(host.abortControllersRef.current.get('TEST-recovery-task')).toBe(sharedController);
  const stopped = terminal === 'user_pause' || terminal === 'user_cancel';
  const emitted = vi.spyOn(window, 'dispatchEvent');
  if (stopped) expect(await stopTaskAutomation({ ...host, pendingRestartTasksRef: { current: new Map() } }, { taskId: 'TEST-recovery-task', expectedRunId: 'TEST-original-run', targetStatus: terminal === 'user_cancel' ? 'cancelled' : 'paused' })).toBe(true);
  release?.(); await settleVideoFixture(Promise.all([first, second]), 15_000);
  expect(observe).toHaveBeenCalledOnce(); expect(firstSettled).toHaveBeenCalledOnce(); expect(secondSettled).toHaveBeenCalledOnce();
  expect(host.submissionReconcilePromisesRef.current.size).toBe(0); expect(host.abortControllersRef.current.size).toBe(0);
  expect(host.synchronizeConversation).not.toHaveBeenCalled(); expect(page.finalClicks).not.toHaveBeenCalled(); expect(page.parameterClicks).not.toHaveBeenCalled(); expect(page.uploadedNames).toEqual([]);
  const final = read()[0]; expect(final.runtime).toMatchObject({ runId: 'TEST-original-run', attempt: 1, submittedAt, input: { prompt: videoFixturePrompt }, submission: { operationId: 'TEST-original-operation' } });
  if (terminal === 'resolved') { expect(final).toMatchObject({ status: 'done', outputs: ['https://fixture.test/video/original.mp4'], artifacts: [{ runId: 'TEST-original-run' }] }); expect(recordUsage).toHaveBeenCalledOnce(); }
  else if (stopped) {
    expect(final).toMatchObject({ status: terminal === 'user_cancel' ? 'cancelled' : 'paused', outputs: [], runtime: { acceptanceObservation: { outcome: 'manual_review' } } });
    expect(recordUsage).not.toHaveBeenCalled(); expect(emitted).not.toHaveBeenCalled();
    const reads = page.view.executeJavaScript.mock.calls.length; const before = read(); await vi.advanceTimersByTimeAsync(30_000);
    expect(page.view.executeJavaScript).toHaveBeenCalledTimes(reads); expect(read()).toEqual(before);
  } else { expect(final).toMatchObject({ status: 'paused', outputs: [], errorInfo: { code: `video_${terminal}` }, runtime: { executionDiagnostics: { videoObservation: { status: terminal } } } }); expect(recordUsage).not.toHaveBeenCalled(); }
});

it('主进程拒绝人工观察写入时，既有observing状态也不能冒充本次保存成功或发布新观察事件', async (): Promise<void> => {
  const submittedAt = new Date().toISOString();
  const original: Task = { id: 'TEST-manual-task', revision: 7, prompt: videoFixturePrompt, assignedAccountId: 'TEST-account', mode: 'video', status: 'manual_submission_observing', result: null,
    outputs: [], createdAt: submittedAt, updatedAt: submittedAt, runtime: { runId: 'TEST-preserved-run', attempt: 1, stage: 'manual_submission_observing', message: 'TEST',
      startedAt: submittedAt, submittedAt, stageStartedAt: submittedAt, lastHeartbeatAt: submittedAt, conversationUrl: videoFixtureUrl, input: { mode: 'video', prompt: videoFixturePrompt, attachments: [] } } };
  let stored = [structuredClone(original)]; const write = vi.fn((_file: string, value: Task[]): boolean => { stored = structuredClone(value); return true; });
  const repository = new TaskRepository({ read: (): Task[] => structuredClone(stored), write,
    normalize: (raw: unknown): { data: Task[]; changed: false; warnings: string[] } => ({ data: raw as Task[], changed: false, warnings: [] }), events: new TaskEventStream(), defaultProjectId: (): string => 'TEST-project' });
  const core = new TaskService({ store: repository, defaultProjectId: (): string => 'TEST-project' });
  const nativeWindow = window;
  vi.stubGlobal('window', Object.assign(nativeWindow, { electronAPI: { tasks: { updateRuntime: async (taskId: string, patch: Omit<TaskUpdateRuntimeParams, 'taskId'>): Promise<{ success: boolean; task?: Task; error?: string }> => {
    const result = core.updateRuntime({ ...patch, taskId }); return result.success ? { success: true, task: result.data } : result;
  } } } }));
  useTaskStore.setState({ tasks: [structuredClone(original)], error: null });
  useAccountStore.setState({ accounts: [{ id: 'TEST-account', name: 'TEST', avatar: '', platform: 'doubao', partition: 'TEST-partition', status: 'idle', pinned: false, createdAt: submittedAt, updatedAt: submittedAt }] });
  const dispatch = vi.spyOn(window, 'dispatchEvent'); const error = vi.spyOn(message, 'error').mockImplementation(closedMessage);
  const view = { getURL: (): string => videoFixtureUrl } as HTMLWebViewElement;
  await createTaskRecoveryCoordinator(recoveryHost(view, submittedAt)).handleManualSubmission(new CustomEvent('mark-manual-submission', { detail: { taskId: original.id, useCurrentPage: true } }));
  expect(error).toHaveBeenCalledWith(useTaskStore.getState().error); expect(useTaskStore.getState().error).toContain('原运行已有提交事实');
  expect(write).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(repository.read()).toEqual([original]); expect(useTaskStore.getState().tasks).toEqual([original]);
});
