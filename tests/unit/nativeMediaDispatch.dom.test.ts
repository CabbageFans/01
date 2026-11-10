/** 正式媒体派发与显式原生边界替身组合；可信事件本身由独立Electron webview验收。 */
import { afterEach, expect, it, vi } from 'vitest';
import { submitPromptOnce, type SubmissionDispatchSafety, type WebviewHandle } from '../../src/utils/doubaoBridge';
import { DoubaoVideoAdapter } from '../../src/automation/DoubaoVideoAdapter';
import { runAdapterSelfCheck } from '../../src/automation/doubaoAdapter';
import { videoWorkflowFixture, videoFixturePrompt, settleVideoFixture } from '../fixtures/videoWorkflowDom';

function safety(controller: AbortController, key: string): SubmissionDispatchSafety {
  return { activation: 'native_media', signal: controller.signal, deadlineAt: Date.now() + 10_000, dispatchKey: key,
    expectedPrompt: videoFixturePrompt, strictParagraphs: true, isCurrent: (): boolean => !controller.signal.aborted, verifyLease: async (): Promise<boolean> => true };
}
afterEach((): void => { document.body.replaceChildren(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const key of ['__doubaoStudioSubmissionAttempts', '__doubaoNativeSubmissionReceipts', '__doubaoVideoOperation']) Reflect.deleteProperty(window, key);
});
it('媒体无原生能力时明确未派发，共享composer自检报告能力缺失且零DOM点击', async (): Promise<void> => {
  vi.useFakeTimers(); const page = videoWorkflowFixture('first_frame', true); const view: WebviewHandle = { ...page.view, sendInputEvent: undefined };
  expect(await submitPromptOnce(view, safety(new AbortController(), 'TEST-missing-native'))).toEqual({ kind: 'not_dispatched', reason: 'native_input_unavailable' });
  expect((await settleVideoFixture(new DoubaoVideoAdapter(view).readComposer())).nativeInputAvailable).toBe(false);
  const report = await settleVideoFixture(runAdapterSelfCheck(view)); expect(report.items.find((item): boolean => item.key === 'native_input')).toMatchObject({ ok: false });
  expect(page.finalClicks).not.toHaveBeenCalled(); expect(page.view.sendInputEvent).not.toHaveBeenCalled();
});
it('正式视频适配器强制原生单次派发，重复原key不产生第二次按下', async (): Promise<void> => {
  vi.useFakeTimers(); const page = videoWorkflowFixture('first_frame', true); const adapter = new DoubaoVideoAdapter(page.view); const guard = safety(new AbortController(), 'TEST-once');
  guard.activation = 'dom_compat';
  expect(await settleVideoFixture(adapter.dispatch(guard))).toMatchObject({ kind: 'dispatch_attempted' });
  expect(await settleVideoFixture(adapter.dispatch(guard))).toMatchObject({ kind: 'dispatch_unknown' });
  expect(page.finalClicks).toHaveBeenCalledOnce(); expect(page.view.sendInputEvent.mock.calls.map((call): string => call[0].type)).toEqual(['mouseDown', 'mouseUp']);
});
it('最终可信点击回执丢失保留未知状态，原key再次调用零补点', async (): Promise<void> => {
  vi.useFakeTimers(); const page = videoWorkflowFixture('first_frame', true); page.setAckLost(); const guard = safety(new AbortController(), 'TEST-ack-lost');
  expect(await settleVideoFixture(submitPromptOnce(page.view, guard))).toMatchObject({ kind: 'dispatch_unknown' });
  expect(await settleVideoFixture(submitPromptOnce(page.view, guard))).toMatchObject({ kind: 'dispatch_unknown' });
  expect(page.view.sendInputEvent).toHaveBeenCalledTimes(2); expect(page.finalClicks).toHaveBeenCalledOnce();
});
it('原生mouseDown的ACK等待中取消，只在原页面外松键且零最终点击', async (): Promise<void> => {
  vi.useFakeTimers(); const page = videoWorkflowFixture('first_frame', true); const controller = new AbortController();
  const send = page.view.sendInputEvent.getMockImplementation(); let pressed!: () => void; const down = new Promise<void>((resolve): void => { pressed = resolve; });
  page.view.sendInputEvent.mockImplementation((event): void | Promise<void> => { send?.(event); if (event.type === 'mouseDown') { pressed(); return new Promise<void>((): void => {}); } });
  const work = submitPromptOnce(page.view, safety(controller, 'TEST-abort-down')); await settleVideoFixture(down); controller.abort();
  expect(await settleVideoFixture(work)).toMatchObject({ kind: 'dispatch_unknown' });
  expect(page.view.sendInputEvent.mock.calls.map((call): unknown => call[0])).toEqual([
    expect.objectContaining({ type: 'mouseDown' }), { type: 'mouseUp', x: -1, y: -1, button: 'left', clickCount: 1 },
  ]); expect(page.finalClicks).not.toHaveBeenCalled();
});
it('旧reserve ACK跨run迟到时不借用新运行原生权限，新运行仍可独立单次派发', async (): Promise<void> => {
  vi.useFakeTimers(); const page = videoWorkflowFixture('first_frame', true); const first = new AbortController(); const previous = new DoubaoVideoAdapter(page.view);
  const release = await previous.begin({ operationId: 'TEST-old', taskId: 'TEST-task', runId: 'TEST-old-run', signal: first.signal, deadlineAt: Date.now() + 20_000 });
  const execute = page.view.executeJavaScript.getMockImplementation(); let finish!: () => void; let reserved!: () => void;
  const ready = new Promise<void>((resolve): void => { reserved = resolve; }); const delayed = new Promise<void>((resolve): void => { finish = resolve; }); let held = false;
  page.view.executeJavaScript.mockImplementation(async (code: string): Promise<unknown> => { const result: unknown = await execute?.(code); if (!held && code.includes('"reserveNative":true')) { held = true; reserved(); await delayed; } return result; });
  const work = previous.dispatch(safety(first, 'TEST-old-key')); await settleVideoFixture(ready);
  first.abort(); release(); const next = new DoubaoVideoAdapter(page.view); const second = new AbortController();
  const releaseNext = await next.begin({ operationId: 'TEST-new', taskId: 'TEST-task', runId: 'TEST-new-run', signal: second.signal, deadlineAt: Date.now() + 20_000 });
  finish(); expect(await settleVideoFixture(work)).toMatchObject({ kind: 'not_dispatched' }); expect(page.view.sendInputEvent).not.toHaveBeenCalled();
  expect(await settleVideoFixture(next.dispatch(safety(second, 'TEST-new-key')))).toMatchObject({ kind: 'dispatch_attempted' });
  expect(page.finalClicks).toHaveBeenCalledOnce(); expect(page.view.sendInputEvent).toHaveBeenCalledTimes(2); releaseNext();
});
