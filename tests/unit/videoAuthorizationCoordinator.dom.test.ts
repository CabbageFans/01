/** 素材授权状态由真实Core落盘，实际长协调器继续同一run；页面/桌面边界为离线夹具。 */
import { afterEach, expect, it, vi } from 'vitest';
import type { Task } from '@doubao-studio/contracts';
import { executeTaskAutomation, type TaskExecutionHost } from '../../src/automation/TaskExecutionCoordinator';
import { DoubaoVideoAdapter } from '../../src/automation/DoubaoVideoAdapter';
import { automationEngine } from '../../src/automation/AutomationEngine';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { MaterialImagePages } from '../../src/utils/materialImagePages';
import * as bridge from '../../src/utils/doubaoBridge';
import * as hydration from '../../src/utils/webviewHydration';
import { TaskService } from '../../main/core/TaskService';
import { TaskRepository } from '../../main/core/TaskRepository';
import { TaskEventStream } from '../../main/core/TaskEventStream';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';
import { notification } from 'antd';
import { geometry, settleVideoFixture, videoWorkflowFixture, videoFixturePrompt, workflowMessage, workflowCard } from '../fixtures/videoWorkflowDom';

afterEach((): void => { document.body.replaceChildren(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'execCommand'); Reflect.deleteProperty(window, '__doubaoVideoOperation'); });
it.each(['resolved', 'unauthorized', 'expired', 'needs_manual_selection', 'image_advice', 'video_advice', 'user_pause', 'user_cancel'] as const)('真实授权循环沿同一run处理%s，明确终态暂停且不补点或循环恢复', async (terminal): Promise<void> => {
  vi.useFakeTimers(); const page = videoWorkflowFixture('reference', true); page.editor.value = '';
  const mode = terminal === 'image_advice' ? 'image' : 'video';
  const skill = page.root.querySelector('[data-testid="skill_input_exit_button"]');
  if (mode === 'image' && skill) skill.textContent = '图像生成';
  let stored: Task[] = [];
  const repository = new TaskRepository({ read: (): Task[] => structuredClone(stored), write: (_file: string, tasks: Task[]): boolean => { stored = structuredClone(tasks); return true; }, normalize: normalizeTasks, events: new TaskEventStream(), defaultProjectId: (): string => 'TEST-project' });
  const core = new TaskService({ store: repository, defaultProjectId: (): string => 'TEST-project', id: (): string => 'TEST-task' });
  const config = { model: 'seedance-2.0' as const, duration: '5s' as const, aspectRatio: '9:16' as const };
  expect(core.create({ prompts: [videoFixturePrompt], mode, promptReadback: 'exact', ...(mode === 'video' ? { videoConfig: config } : {}), attachments: ['TEST-reference.png'], executionIntent: 'armed' }).success).toBe(true);
  expect(core.assign({ taskId: 'TEST-task', accountId: 'TEST-account' }).success).toBe(true);
  const now = new Date().toISOString();
  expect(core.updateRuntime({ taskId: 'TEST-task', status: 'executing', runtime: { runId: 'TEST-run', attempt: 1, stage: 'preparing_account', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
    input: { prompt: videoFixturePrompt, mode, promptReadback: 'exact', attachments: ['TEST-reference.png'], ...(mode === 'video' ? { videoConfig: config } : {}) } } }).success).toBe(true);
  const current = (): Task => { const result = core.getTasks(); if (!result.success) throw new Error(result.error); return result.data[0]; };
  const dialog = geometry(document.createElement('div'), 200, 200, 450, 250); dialog.setAttribute('role', 'dialog');
  const body = geometry(document.createElement('p'), 220, 220, 400, 100); body.textContent = '安全确认：您上传、使用的素材均已获得充分授权。';
  const confirm = geometry(document.createElement('button'), 230, 350, 80, 40); confirm.textContent = '确认'; const refuse = geometry(document.createElement('button'), 400, 350, 80, 40); refuse.textContent = '拒绝'; dialog.append(body, confirm, refuse);
  let confirmedFromStatus: Task['status'] | undefined; let submittedAtWhenConfirmed: string | undefined;
  const reconcile = vi.fn(); window.addEventListener('reconcile-task-submission', reconcile);
  const acceptRequest = (): void => {
    confirmedFromStatus = current().status; submittedAtWhenConfirmed = current().runtime?.submittedAt; dialog.remove(); page.editor.value = '';
    workflowMessage('user', videoFixturePrompt, 'TEST-user'); const assistant = workflowMessage('assistant', terminal === 'image_advice' ? '你现在可以直接在生图面板选择【参考图编辑 / 图生图】，上传参考图后生成即可。' : terminal === 'video_advice' ? '✅视频生成提示词（可直接复制使用）\nTEST原镜头内容\n参数核对：5秒，9:16' : '视频生成好了', 'TEST-assistant');
    if (terminal === 'image_advice' || terminal === 'video_advice') return;
    workflowCard(assistant, 'TEST-authorized-vid', terminal === 'resolved' || terminal === 'needs_manual_selection' ? 'https://fixture.test/video/authorized.mp4' : '');
    if (terminal === 'needs_manual_selection') workflowCard(assistant, 'TEST-second-vid', 'https://fixture.test/video/second.mp4');
  };
  confirm.addEventListener('click', acceptRequest);
  if (mode === 'image') page.send.addEventListener('click', acceptRequest);
  const originalTaskState = useTaskStore.getState(); const originalAccountState = useAccountStore.getState(); const originalPetState = usePetStoryStore.getState();
  const failures = vi.fn(); const stages: string[] = [];
  const pauses = vi.fn<typeof originalTaskState.pauseAutomation>(async (taskId, _accountId, text, options): Promise<void> => {
    const result = core.updateRuntime({ taskId, expectedRunId: options?.expectedRunId, status: options?.status || 'paused',
      errorInfo: { code: options?.code || 'manual_review_required', message: text || 'TEST', recoverable: true, detectedAt: new Date().toISOString() }, runtime: { stage: options?.status === 'cancelled' ? 'cancelled' : 'paused', ...(options?.endObservation && current().runtime?.acceptanceObservation ? { acceptanceObservation: { ...current().runtime!.acceptanceObservation!, outcome: 'manual_review', lease: { ...current().runtime!.acceptanceObservation!.lease, expiresAt: new Date().toISOString() } } } : {}) } });
    if (!result.success) throw new Error(result.error);
  });
  const updateTaskRuntime: typeof originalTaskState.updateTaskRuntime = async (taskId, patch): Promise<boolean> => {
    const result = core.updateRuntime({ ...patch, taskId });
    if (patch.status === 'waiting_verification' && result.success) setTimeout((): void => confirm.click(), 100);
    return result.success;
  };
  vi.spyOn(useTaskStore, 'getState').mockImplementation((): typeof originalTaskState => ({ ...originalTaskState, tasks: [current()], updateTaskRuntime,
    setAccountAutomationState: (_id, _state, _text, stage): void => { if (stage) stages.push(stage); if (mode === 'video' && stage === 'injecting_prompt' && !dialog.isConnected) document.body.append(dialog); },
    pauseAutomation: pauses, failAutomation: failures, processQueue: vi.fn(),
    completeAutomation: async (taskId, _accountId, resultUrl, outputs, expectedRunId): Promise<void> => { const saved = core.updateStatus({ taskId, expectedRunId, status: 'done', result: resultUrl, outputs }); if (!saved.success) throw new Error(saved.error); },
  }));
  vi.spyOn(useAccountStore, 'getState').mockReturnValue({ ...originalAccountState, accounts: [], selectAccount: vi.fn(), recordAccountOutcome: vi.fn(), recordSeedanceUsage: vi.fn() });
  vi.spyOn(usePetStoryStore, 'getState').mockReturnValue({ ...originalPetState, project: null });
  let controller: AbortController | undefined;
  vi.spyOn(automationEngine, 'hasController').mockReturnValue(false);
  vi.spyOn(automationEngine, 'createController').mockImplementation((): AbortController => { controller = new AbortController(); return controller; });
  vi.spyOn(automationEngine, 'ownsController').mockImplementation((_id, candidate): boolean => candidate === controller);
  vi.spyOn(automationEngine, 'ownsAccountController').mockImplementation((_id, account, candidate): boolean => account === 'TEST-account' && candidate === controller);
  vi.spyOn(automationEngine, 'confirmSubmissionOwnership').mockResolvedValue(true); vi.spyOn(automationEngine, 'release').mockResolvedValue();
  vi.spyOn(hydration, 'forceWebviewLayoutRepaint').mockResolvedValue();
  vi.spyOn(bridge, 'startNewConversation').mockResolvedValue({ ok: true }); vi.spyOn(bridge, 'switchMode').mockImplementation((): void => {});
  vi.spyOn(bridge, 'injectGenerationMonitor').mockResolvedValue(true);
  vi.spyOn(notification, 'warning').mockImplementation((): void => {}); vi.spyOn(notification, 'destroy').mockImplementation((): void => {});
  const injected: string[] = [];
  Object.defineProperty(document, 'execCommand', { configurable: true, value: (_command: string, _showUi: boolean, value: string): boolean => { injected.push(value); page.editor.value = value; page.editor.dispatchEvent(new Event('input', { bubbles: true })); return true; } });
  const fetchFixture = vi.fn(async (): Promise<Response> => new Response(JSON.stringify({ code: terminal === 'expired' ? 404 : 401 }), { status: terminal === 'expired' ? 404 : 401 }));
  vi.stubGlobal('fetch', fetchFixture);
  const nativeWindow = window;
  vi.stubGlobal('window', Object.assign(nativeWindow, { electronAPI: { settings: { get: async (): Promise<object> => ({ initializationConcurrency: 1, autoConfirmMaterialAuthorization: false }) }, logs: { append: vi.fn(async (): Promise<void> => {}) }, tasks: { readFileAsBase64: async (): Promise<object> => ({ success: true, data: `data:image/png;base64,${page.files[0].base64}` }) } } }));
  const context: TaskExecutionHost = { runningRef: { current: new Set(['TEST-account']) }, abortControllersRef: { current: new Map() }, pendingRestartTasksRef: { current: new Map() }, pendingCancellationStatusRef: { current: new Map() }, submittedImagePagesRef: { current: new Map() }, materialPagesRef: { current: new MaterialImagePages() }, setInteractiveTaskPageId: vi.fn(), ownsTaskWebview: (): boolean => true,
    assertNoHumanVerification: async (): Promise<void> => {}, pauseForHumanVerification: vi.fn(), performAvailabilityCheck: async (): Promise<import('@doubao-studio/contracts').AccountAvailability> => ({ state: 'ready', reason: 'ready', message: 'TEST', checkedAt: now, source: 'pre_task' }), conversationSynchronizations: new WeakMap() };
  let readsAtStop: number | undefined;
  if (terminal === 'user_pause' || terminal === 'user_cancel') {
    const observe = DoubaoVideoAdapter.prototype.observe;
    vi.spyOn(DoubaoVideoAdapter.prototype, 'observe').mockImplementation(function(this: DoubaoVideoAdapter, options): ReturnType<typeof observe> {
      expect(current().runtime?.acceptanceObservation?.outcome).toBe('observing');
      context.pendingCancellationStatusRef.current.set('TEST-task', terminal === 'user_cancel' ? 'cancelled' : 'paused');
      controller?.abort(); readsAtStop = page.view.executeJavaScript.mock.calls.length;
      return observe.call(this, options);
    });
  }
  await settleVideoFixture(executeTaskAutomation(context, 'TEST-account', 'TEST-task', videoFixturePrompt, mode, page.view as unknown as HTMLWebViewElement), 20_000);
  expect(confirmedFromStatus).toBe(mode === 'image' ? 'executing' : 'waiting_verification'); expect(failures).not.toHaveBeenCalled();
  if (terminal === 'resolved') {
    expect(pauses).not.toHaveBeenCalled(); expect(current()).toMatchObject({ status: 'done', outputs: ['https://fixture.test/video/authorized.mp4'] });
  } else {
    expect(pauses).toHaveBeenCalledOnce(); expect(current()).toMatchObject({ status: terminal === 'user_cancel' ? 'cancelled' : 'paused', runtime: { acceptanceObservation: { outcome: 'manual_review' } } });
    const calls = fetchFixture.mock.calls.length; const pageReads = page.view.executeJavaScript.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000); expect(fetchFixture).toHaveBeenCalledTimes(calls); expect(page.view.executeJavaScript).toHaveBeenCalledTimes(pageReads);
    if (readsAtStop !== undefined) expect(page.view.executeJavaScript).toHaveBeenCalledTimes(readsAtStop);
    if (terminal === 'user_pause' || terminal === 'user_cancel') expect(pauses.mock.calls[0][3]).toMatchObject({ status: terminal === 'user_cancel' ? 'cancelled' : 'paused', endObservation: true });
    if (terminal === 'video_advice') expect(current().errorInfo?.code).toBe('video_generation_not_started');
  }
  expect(current()).toMatchObject({ runtime: { runId: 'TEST-run', submittedAt: submittedAtWhenConfirmed, submission: { state: 'accepted' } } });
  if (mode === 'video') { expect(stages).toContain('waiting_verification'); expect(page.finalClicks).not.toHaveBeenCalled(); }
  else { expect(current().errorInfo?.code).toBe('image_generation_not_started'); expect(page.finalClicks).toHaveBeenCalledOnce(); }
  expect(stages).toContain('generating'); expect(injected).toContain(videoFixturePrompt); expect(reconcile).not.toHaveBeenCalled();
  window.removeEventListener('reconcile-task-submission', reconcile);
});
