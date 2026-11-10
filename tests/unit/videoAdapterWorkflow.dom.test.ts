/** 真实适配器、提交协调器、Core/Repository与原消息观察的组合；所有页面和素材均为离线夹具。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryResolvedMode, Task } from '@doubao-studio/contracts';
import { DoubaoVideoAdapter } from '../../src/automation/DoubaoVideoAdapter';
import { dispatchSubmissionAttempt } from '../../src/automation/SubmissionCoordinator';
import { getSubmissionEvidence, inspectMaterialAuthorization } from '../../src/utils/doubaoBridge';
import { TaskService } from '../../main/core/TaskService';
import { TaskRepository } from '../../main/core/TaskRepository';
import { TaskEventStream } from '../../main/core/TaskEventStream';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';
import { geometry, settleVideoFixture, videoFixturePrompt, videoFixtureUrl, videoWorkflowFixture, workflowCard, workflowMessage } from '../fixtures/videoWorkflowDom';

const config = { model: 'seedance-2.0' as const, aspectRatio: '9:16' as const, duration: '5s' as const };
function authority(): { core: TaskService; task: () => Task; persist: (state: 'intent_saved' | 'dispatch_unknown' | 'not_dispatched' | 'accepted') => Promise<void> } {
  let stored: Task[] = [];
  const repository = new TaskRepository({ read: (): Task[] => structuredClone(stored), write: (_file: string, tasks: Task[]): boolean => { stored = structuredClone(tasks); return true; }, normalize: normalizeTasks, defaultProjectId: (): string => 'TEST-project', events: new TaskEventStream() });
  const core = new TaskService({ store: repository, defaultProjectId: (): string => 'TEST-project', id: (): string => 'TEST-task' });
  const created = core.create({ prompts: [videoFixturePrompt], mode: 'video', videoConfig: config, executionIntent: 'hold' }); expect(created.success).toBe(true);
  expect(core.assign({ taskId: 'TEST-task', accountId: 'TEST-account' }).success).toBe(true);
  const now = new Date().toISOString();
  expect(core.updateRuntime({ taskId: 'TEST-task', status: 'executing', runtime: { runId: 'TEST-run', attempt: 1, stage: 'configuring', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { prompt: videoFixturePrompt, mode: 'video', attachments: [], videoConfig: config } } }).success).toBe(true);
  const task = (): Task => { const result = core.getTasks(); if (!result.success) throw new Error(result.error); return result.data[0]; };
  return { core, task, persist: async (state): Promise<void> => {
    const current = task(); const timestamp = new Date().toISOString();
    const result = core.updateRuntime({ taskId: current.id, expectedRunId: 'TEST-run', runtime: { ...(state === 'dispatch_unknown' ? { submittedAt: timestamp } : {}), submission: { schemaVersion: 1, runId: 'TEST-run', operationId: 'TEST-operation', state, updatedAt: timestamp } } });
    if (!result.success) throw new Error(result.error);
  } };
}
function observe(adapter: DoubaoVideoAdapter, signal: AbortSignal): ReturnType<DoubaoVideoAdapter['observe']> {
  return adapter.observe({ signal, timeoutMs: 10_000, ensureCurrent: (): void => {}, onProgress: async (): Promise<void> => {},
    context: { conversationUrl: videoFixtureUrl, runId: 'TEST-run', sourcePrompt: videoFixturePrompt, videoConfig: config,
      readbackContext: { taskId: 'TEST-task', runId: 'TEST-run', currentRunId: 'TEST-run', accountId: 'TEST-account', currentAccountId: 'TEST-account', conversationUrl: videoFixtureUrl, currentConversationUrl: videoFixtureUrl } } });
}
function acceptedPage(test: ReturnType<typeof videoWorkflowFixture>, delay = 0): void {
  test.editor.value = ''; workflowMessage('user', videoFixturePrompt, 'TEST-user'); const assistant = workflowMessage('assistant', '正在生成视频', 'TEST-assistant');
  setTimeout((): void => { workflowCard(assistant, 'TEST-original-vid', 'https://fixture.test/video/original.mp4'); }, delay);
}
beforeEach((): void => { vi.useFakeTimers(); });
afterEach((): void => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, '__doubaoStudioSubmissionAttempts'); Reflect.deleteProperty(window, '__doubaoVideoOperation'); });

describe('正式视频三模式的DOM组合闭环', (): void => {
  it.each(['first_frame', 'first_last_frame', 'reference'] as PetStoryResolvedMode[])('%s共用正式composer配置和自检，真实槽位上传、单次提交、原消息观察归于同一run', async (mode): Promise<void> => {
    const test = videoWorkflowFixture(mode); const service = authority(); const controller = new AbortController(); const adapter = new DoubaoVideoAdapter(test.view);
    const release = await adapter.begin({ operationId: 'TEST-prepare', taskId: 'TEST-task', runId: 'TEST-run', signal: controller.signal, deadlineAt: Date.now() + 60_000 });
    await settleVideoFixture(adapter.configure(config));
    const readOnly = await settleVideoFixture(adapter.readComposer()); expect(readOnly.composer).toMatchObject({ present: true, selectedSkill: 'video', model: 'Seedance 2.0', duration: 5, aspectRatio: '9:16' }); expect(test.finalClicks).not.toHaveBeenCalled();
    const receipts = await settleVideoFixture(adapter.uploadReferences(test.files, mode, controller.signal, test.hashes));
    expect(receipts.map((receipt): string => receipt.slot)).toEqual(mode === 'first_frame' ? ['first_frame'] : mode === 'first_last_frame' ? ['first_frame', 'last_frame'] : ['reference', 'reference']);
    expect(receipts.map((receipt): string | undefined => receipt.fileSha256)).toEqual(test.hashes); expect(test.uploadedNames).toEqual(test.files.map((file): string => file.name));
    const final = await settleVideoFixture(adapter.readComposer()); expect(final.submit.ok).toBe(true); expect(final.composer.count).toBe(test.files.length);
    await service.persist('intent_saved'); test.send.addEventListener('click', (): void => acceptedPage(test));
    const dispatched = await settleVideoFixture(dispatchSubmissionAttempt({ persist: service.persist, dispatch: (safety): ReturnType<DoubaoVideoAdapter['dispatch']> => adapter.dispatch(safety),
      safety: { signal: controller.signal, deadlineAt: Date.now() + 10_000, dispatchKey: 'TEST-task:TEST-run', expectedPrompt: videoFixturePrompt, strictParagraphs: true, isCurrent: (): boolean => service.task().runtime?.runId === 'TEST-run', verifyLease: async (): Promise<boolean> => true } }));
    expect(dispatched.kind).toBe('dispatch_attempted'); expect(test.finalClicks).toHaveBeenCalledOnce();
    expect(await getSubmissionEvidence(test.view, videoFixturePrompt, 0, 0)).toMatchObject({ inputCleared: true, generationStarted: true, promptPublished: true });
    const original = await adapter.readOriginalMessage(); expect(original.snapshot.messages).toHaveLength(2);
    await service.persist('accepted'); release(); const result = await settleVideoFixture(observe(adapter, controller.signal)); expect(result).toMatchObject({ status: 'resolved', vid: 'TEST-original-vid', url: 'https://fixture.test/video/original.mp4' });
    expect(service.core.updateStatus({ taskId: 'TEST-task', expectedRunId: 'TEST-run', status: 'done', outputs: [result.url!] }).success).toBe(true);
    expect(service.task().artifacts?.[0].runId).toBe('TEST-run'); expect(test.finalClicks).toHaveBeenCalledOnce(); expect(service.task().runtime?.submission?.state).toBe('accepted'); release();
  });
  it('参数浮层看似正确但正式输入区技能已变化时，配置最终回读失败，自检返回相同现场且零发送', async (): Promise<void> => {
    const test = videoWorkflowFixture('first_frame', true); test.root.querySelector('[data-testid="skill_input_exit_button"]')!.textContent = '图像生成';
    const adapter = new DoubaoVideoAdapter(test.view);
    const diagnostic = await settleVideoFixture(adapter.configure(config).catch((error: unknown): unknown => error));
    expect(diagnostic).toMatchObject({ name: 'VideoControlReadinessError', diagnostic: { failureStage: 'final_readback', failureReason: 'value_not_applied' } });
    expect((await settleVideoFixture(adapter.readComposer())).composer.selectedSkill).toBe('image'); expect(test.finalClicks).not.toHaveBeenCalled();
  });
  it('激活ACK丢失但原消息已发布时，正式observer继续原卡且不增加点击', async (): Promise<void> => {
    const test = videoWorkflowFixture('first_frame', true); const controller = new AbortController(); const adapter = new DoubaoVideoAdapter(test.view); const service = authority();
    const release = await adapter.begin({ operationId: 'TEST-ack', taskId: 'TEST-task', runId: 'TEST-run', signal: controller.signal, deadlineAt: Date.now() + 30_000 });
    await service.persist('intent_saved'); test.setAckLost(); test.send.addEventListener('click', (): void => acceptedPage(test, 1000));
    const result = await settleVideoFixture(dispatchSubmissionAttempt({ persist: service.persist, dispatch: (safety): ReturnType<DoubaoVideoAdapter['dispatch']> => adapter.dispatch(safety), safety: { signal: controller.signal, deadlineAt: Date.now() + 10_000, dispatchKey: 'TEST-ack-once', expectedPrompt: videoFixturePrompt, isCurrent: (): boolean => true, verifyLease: async (): Promise<boolean> => true } }));
    expect(result.kind).toBe('dispatch_unknown'); expect(service.task().runtime?.submission?.state).toBe('dispatch_unknown');
    const observed = await settleVideoFixture(observe(adapter, controller.signal)); expect(observed).toMatchObject({ status: 'resolved', vid: 'TEST-original-vid' }); expect(test.finalClicks).toHaveBeenCalledOnce(); release();
  });
  it('仅预留控件的ACK丢失且宿主尚未按下时，明确未派发并由真实Core清除submittedAt', async (): Promise<void> => {
    const test = videoWorkflowFixture('first_frame', true); const service = authority(); const controller = new AbortController(); const adapter = new DoubaoVideoAdapter(test.view);
    const release = await adapter.begin({ operationId: 'TEST-reserve-only', taskId: 'TEST-task', runId: 'TEST-run', signal: controller.signal, deadlineAt: Date.now() + 30_000 });
    const execute = test.view.executeJavaScript.getMockImplementation();
    test.view.executeJavaScript.mockImplementation(async (code: string): Promise<unknown> => { const result: unknown = await execute?.(code); if (code.includes('"reserveNative":true')) throw new Error('TEST reserve-only ACK lost'); return result; });
    await service.persist('intent_saved');
    const result = await settleVideoFixture(dispatchSubmissionAttempt({ persist: service.persist, dispatch: (safety): ReturnType<DoubaoVideoAdapter['dispatch']> => adapter.dispatch(safety),
      safety: { signal: controller.signal, deadlineAt: Date.now() + 10_000, dispatchKey: 'TEST-reserve-only-key', expectedPrompt: videoFixturePrompt, strictParagraphs: true,
        isCurrent: (): boolean => service.task().runtime?.runId === 'TEST-run', verifyLease: async (): Promise<boolean> => true } }));
    expect(result.kind).toBe('not_dispatched'); expect(service.task().runtime?.submission?.state).toBe('not_dispatched'); expect(service.task().runtime?.submittedAt).toBeUndefined();
    expect(test.view.sendInputEvent).not.toHaveBeenCalled(); expect(test.finalClicks).not.toHaveBeenCalled(); release();
  });
  it('只有紫色附件按钮时，正式提交返回明确未派发且不消费生成点击', async (): Promise<void> => {
    const test = videoWorkflowFixture('reference', true); test.send.id = ''; test.send.setAttribute('aria-label', '上传附件'); test.send.style.backgroundColor = 'rgb(100, 30, 230)';
    const adapter = new DoubaoVideoAdapter(test.view); const service = authority(); await service.persist('intent_saved'); const controller = new AbortController();
    const result = await settleVideoFixture(dispatchSubmissionAttempt({ persist: service.persist, dispatch: (safety): ReturnType<DoubaoVideoAdapter['dispatch']> => adapter.dispatch(safety), safety: { signal: controller.signal, deadlineAt: Date.now() + 10_000, dispatchKey: 'TEST-no-send', expectedPrompt: videoFixturePrompt, isCurrent: (): boolean => true, verifyLease: async (): Promise<boolean> => true } }));
    expect(result.kind).toBe('not_dispatched'); expect(service.task().runtime?.submission?.state).toBe('not_dispatched'); expect(service.task().runtime?.submittedAt).toBeUndefined(); expect(test.finalClicks).not.toHaveBeenCalled();
  });
  it('素材授权期间保持同一waiting_verification运行，人工确认后只观察原消息和原卡', async (): Promise<void> => {
    const test = videoWorkflowFixture('first_frame', true); const adapter = new DoubaoVideoAdapter(test.view); const service = authority(); const controller = new AbortController();
    const dialog = geometry(document.createElement('div'), 200, 200, 450, 250); dialog.setAttribute('role', 'dialog');
    const body = geometry(document.createElement('p'), 220, 220, 400, 100); body.textContent = '安全确认：您上传、使用的素材均已获得充分授权。';
    const confirm = geometry(document.createElement('button'), 230, 350, 80, 40); confirm.textContent = '确认'; const refuse = geometry(document.createElement('button'), 400, 350, 80, 40); refuse.textContent = '拒绝'; dialog.append(body, confirm, refuse); document.body.append(dialog);
    expect(await inspectMaterialAuthorization(test.view)).toBe('present'); await service.persist('intent_saved');
    expect(service.core.updateRuntime({ taskId: 'TEST-task', expectedRunId: 'TEST-run', status: 'waiting_verification', runtime: { stage: 'waiting_verification' } }).success).toBe(true);
    await service.persist('dispatch_unknown'); expect(service.task().status).toBe('waiting_verification');
    confirm.addEventListener('click', (): void => { dialog.remove(); acceptedPage(test); }); confirm.click();
    expect(await inspectMaterialAuthorization(test.view)).toBe('absent');
    const evidence = await getSubmissionEvidence(test.view, videoFixturePrompt, 0, 0); expect(evidence).toMatchObject({ promptPublished: true, inputCleared: true, generationStarted: true });
    const observed = await settleVideoFixture(observe(adapter, controller.signal)); expect(observed).toMatchObject({ status: 'resolved', vid: 'TEST-original-vid' });
    expect(service.task().runtime?.runId).toBe('TEST-run'); expect(test.finalClicks).not.toHaveBeenCalled(); await service.persist('accepted');
  });
});
