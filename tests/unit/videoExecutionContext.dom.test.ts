/** 正式运行上下文与真实 guest 探针组合，不复制取消实现。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginVideoPageOperation, wrapVideoPageScript } from '../../src/automation/videoExecutionContext';
import { DoubaoVideoAdapter } from '../../src/automation/DoubaoVideoAdapter';
import { setVideoDurationFromPage } from '../../src/utils/videoDurationControl';
import { geometry, settleVideoFixture, videoWorkflowFixture } from '../fixtures/videoWorkflowDom';

beforeEach((): void => { vi.useFakeTimers(); });
afterEach((): void => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, '__doubaoVideoOperation'); });
const identity = (runId: string, signal: AbortSignal): Parameters<typeof beginVideoPageOperation>[1] => ({ operationId: `TEST-operation-${runId}`, taskId: 'TEST-task', runId, signal, deadlineAt: Date.now() + 30_000 });

describe('guest 操作取消和下一运行隔离', (): void => {
  it('旧guest脚本排队尚未执行时，取消并开始下一run后拒绝旧脚本零click', async (): Promise<void> => {
    const page = videoWorkflowFixture('first_frame', true); const first = new AbortController(); const release = await beginVideoPageOperation(page.view, identity('old', first.signal));
    const oldScript = wrapVideoPageScript(page.view, `(() => { document.querySelector('#flow-end-msg-send').click(); return true; })()`, 5000);
    first.abort(); release(); const second = new AbortController(); const releaseNext = await beginVideoPageOperation(page.view, identity('new', second.signal));
    await expect(page.view.executeJavaScript(oldScript)).rejects.toMatchObject({ name: 'AbortError' }); expect(page.finalClicks).not.toHaveBeenCalled(); releaseNext();
  });
  it('旧配置的await回执晚到后不能把后续参数写入借给下一run', async (): Promise<void> => {
    const page = videoWorkflowFixture('reference'); const first = new AbortController(); const adapter = new DoubaoVideoAdapter(page.view); const release = await adapter.begin(identity('old-config', first.signal));
    let resolveRead!: () => void; const delayed = new Promise<void>((resolve): void => { resolveRead = resolve; }); let entered!: () => void; const reading = new Promise<void>((resolve): void => { entered = resolve; });
    let hold = true;
    page.view.executeJavaScript.mockImplementation(async (code: string): Promise<unknown> => { const result = await window.eval(code) as unknown; if (hold && code.includes('function videoParameterControlFromPage')) { hold = false; entered(); await delayed; } return result; });
    const work = adapter.configure({ model: 'seedance-2.0', aspectRatio: '9:16', duration: '5s' }).then((): string => 'configured', (): string => 'stopped'); await vi.advanceTimersByTimeAsync(1000); await reading;
    first.abort(); release(); const next = new AbortController(); const releaseNext = await adapter.begin(identity('new-config', next.signal)); resolveRead();
    expect(await settleVideoFixture(work)).toBe('stopped'); expect(page.parameterClicks).not.toHaveBeenCalled(); expect(page.finalClicks).not.toHaveBeenCalled(); releaseNext();
  });
  it('旧adapter实例在操作结束后不能调用下一run的配置权限', async (): Promise<void> => {
    const page = videoWorkflowFixture('reference'); const old = new DoubaoVideoAdapter(page.view); const first = new AbortController();
    const release = await old.begin(identity('old-adapter', first.signal)); first.abort(); release();
    const current = new DoubaoVideoAdapter(page.view); const next = new AbortController(); const releaseNext = await current.begin(identity('new-adapter', next.signal));
    const outcome = old.configure({ model: 'seedance-2.0', aspectRatio: '9:16', duration: '5s' }).then((): string => 'configured', (): string => 'stopped');
    expect(await settleVideoFixture(outcome)).toBe('stopped'); expect(page.parameterClicks).not.toHaveBeenCalled(); releaseNext();
  });
  it('真实异步时长滑条让出宏任务后，旧run取消时不得再派发下一步键盘写入', async (): Promise<void> => {
    const slider = geometry(document.createElement('div'), 100, 100, 400, 40); slider.setAttribute('role', 'slider'); slider.setAttribute('aria-valuemin', '0'); slider.setAttribute('aria-valuemax', '11'); slider.setAttribute('aria-valuenow', '6'); document.body.append(slider);
    const keys: string[] = []; slider.addEventListener('keydown', (event: KeyboardEvent): void => { keys.push(event.key); slider.setAttribute('aria-valuenow', event.key === 'Home' ? '0' : String(Number(slider.getAttribute('aria-valuenow')) + 1)); });
    const view = { executeJavaScript: async (code: string): Promise<unknown> => window.eval(code) as unknown, getURL: (): string => '', loadURL: vi.fn() };
    const first = new AbortController(); const release = await beginVideoPageOperation(view, identity('old-duration', first.signal));
    const work = view.executeJavaScript(wrapVideoPageScript(view, `(${setVideoDurationFromPage.toString()})(5,${Date.now() + 4500})`, 5000)).catch((error: unknown): unknown => error);
    expect(keys).toEqual(['Home']); first.abort(); release(); const next = new AbortController(); const releaseNext = await beginVideoPageOperation(view, identity('new-duration', next.signal));
    await settleVideoFixture(work); expect(keys).toEqual(['Home']); releaseNext();
  });
});
