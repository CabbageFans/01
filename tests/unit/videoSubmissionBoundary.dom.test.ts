import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageSubmissionProbe } from '../../src/utils/submissionControls';
import { submitPromptOnce } from '../../src/utils/doubaoBridge';
import type { SubmissionDispatchSafety, WebviewHandle } from '../../src/utils/doubaoBridge';

function composer(label: string): { button: HTMLButtonElement; clicks: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = '<div data-testid="guidance-input-surface"><textarea></textarea><button style="background:rgb(80,40,200)"></button></div>';
  const editor = document.querySelector('textarea') as HTMLTextAreaElement; editor.value = 'fixture input';
  const button = document.querySelector('button') as HTMLButtonElement; button.setAttribute('aria-label', label);
  for (const element of [editor, button]) {
    Object.defineProperty(element, 'offsetParent', { value: document.body });
    element.getBoundingClientRect = (): DOMRect => ({ x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 50, width: element === button ? 40 : 100, height: 40, toJSON: (): object => ({}) });
  }
  document.elementFromPoint = (): Element => button;
  const clicks = vi.fn(); button.addEventListener('click', clicks); return { button, clicks };
}
function safety(): SubmissionDispatchSafety {
  return { signal: new AbortController().signal, deadlineAt: Date.now() + 10_000, dispatchKey: 'fixture-run', expectedPrompt: 'fixture input',
    isCurrent: (): boolean => true, verifyLease: async (): Promise<boolean> => false };
}

afterEach((): void => { vi.useRealTimers(); document.body.innerHTML = ''; });
describe('正式提交边界', (): void => {
  it('唯一紫色附件按钮没有发送语义时拒绝定位且零点击', (): void => {
    const fixture = composer('上传附件');
    const target = pageSubmissionProbe({}, (editor: HTMLElement): string => (editor as HTMLTextAreaElement).value);
    expect(target.ok).toBe(false); expect(fixture.clicks).not.toHaveBeenCalled();
  });
  it.each(['视频生成', '图像生成', '重新生成图片'])('模式或其他生成入口%s不能冒充最终发送', (label: string): void => {
    const fixture = composer(label);
    expect(pageSubmissionProbe({}, (editor: HTMLElement): string => (editor as HTMLTextAreaElement).value).ok).toBe(false);
    expect(fixture.clicks).not.toHaveBeenCalled();
  });
  it('租约撤回属于确定未派发，不能被 boolean 混成受理未知', async (): Promise<void> => {
    vi.useFakeTimers();
    const target = { ok: true, method: 'exact-id', geometry: 'fixture', position: 'fixture', inputHash: 'fixture' };
    const execute = vi.fn(async (): Promise<unknown> => target);
    const webview: WebviewHandle = { executeJavaScript: execute, loadURL: (): void => undefined, getURL: (): string => 'https://www.doubao.com/chat/' };
    const pending = submitPromptOnce(webview, safety());
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ kind: 'not_dispatched' });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
