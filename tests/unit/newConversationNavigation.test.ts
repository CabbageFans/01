/** 离线执行真实序列化探针，模拟 loadURL 尚未替换旧编辑器的跨文档竞争。 */
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startNewConversation, type WebviewHandle } from '../../src/utils/doubaoBridge';
import original from '../fixtures/storyboard-five-shots.json';

interface PageState { href: string; timeOrigin: number; readyState: string; messages: boolean; draft: string; loading: boolean; editorLeft: number }

function fixture(initialRoot = false, rootSlash = true): {
  view: WebviewHandle; state: PageState; focus: ReturnType<typeof vi.fn>; complete: () => void;
  setProbeMutation: (mutation: () => void) => void;
} {
  const rootUrl = 'https://www.doubao.com/chat' + (rootSlash ? '/' : '');
  const state: PageState = { href: initialRoot ? rootUrl : 'https://www.doubao.com/chat/OFFLINE-original', timeOrigin: 1, readyState: 'complete', messages: !initialRoot, draft: '', loading: false, editorLeft: 30 };
  let hostUrl = state.href; let active: Element | null = null; let frameMutation = (): void => {};
  const focus = vi.fn();
  class Element {
    readonly offsetParent = {};
    readonly disabled = false;
    readonly childNodes: never[] = [];
    parentElement: Element | null = null;
    constructor(readonly tagName: string, readonly testId = '') {}
    get value(): string { return state.draft; }
    get innerText(): string { return this === editor ? state.draft : this === content ? original.mobileStory : ''; }
    get textContent(): string { return this.innerText; }
    getAttribute(name: string): string | null { return name === 'data-testid' ? this.testId : null; }
    hasAttribute(): boolean { return false; }
    closest(): null { return null; }
    contains(node: unknown): boolean { return this === node || this === root && node === editor; }
    focus(): void { focus(); active = editor; }
    getBoundingClientRect(): { left: number; top: number; width: number; height: number } { return { left: state.editorLeft, top: 40, width: 400, height: 80 }; }
    querySelector(selector: string): Element | null { return this === message && selector === '[data-testid="message_text_content"]' ? content : null; }
    querySelectorAll(selector: string): Element[] { return this === root && selector.startsWith('textarea') ? [editor] : []; }
  }
  const root = new Element('DIV'); const editor = new Element('TEXTAREA'); editor.parentElement = root;
  const message = new Element('DIV', 'send_message'); const content = new Element('DIV');
  const document = {
    get readyState(): string { return state.readyState; },
    get activeElement(): Element | null { return active; },
    querySelector: (selector: string): Element | null => selector === '#input-engine-container' ? root : null,
    querySelectorAll: (selector: string): Element[] => {
      if (selector === '[data-testid="send_message"], [data-testid="receive_message"]') return state.messages ? [message] : [];
      if (selector.startsWith('textarea') || selector.startsWith('[contenteditable=')) return [editor];
      return [];
    },
  };
  const context = {
    document, location: { get href(): string { return state.href; } }, performance: { get timeOrigin(): number { return state.timeOrigin; } },
    window: { getComputedStyle: (): object => ({ display: 'block', visibility: 'visible' }) }, Date, URL, setTimeout,
    // 模拟后台 WebView 不触发绘制回调，空会话核对必须仍可完成。
    requestAnimationFrame: (): number => 1,
  };
  const view: WebviewHandle = {
    getURL: (): string => hostUrl,
    loadURL: vi.fn((next: string): void => { hostUrl = next; state.loading = true; }),
    isLoadingMainFrame: (): boolean => state.loading,
    executeJavaScript: vi.fn(async (code: string): Promise<unknown> => {
      const result: unknown = runInNewContext(code, context);
      if (code.includes('var newConversationDocument')) frameMutation();
      return result;
    }),
    sendInputEvent: vi.fn(),
  };
  return { view, state, focus, complete: (): void => { state.href = hostUrl; state.timeOrigin++; state.readyState = 'complete'; state.messages = false; state.draft = ''; state.loading = false; active = null; }, setProbeMutation: (mutation: () => void): void => { frameMutation = mutation; } };
}

async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }

describe('新会话必须属于真正完成导航的新文档（离线）', (): void => {
  afterEach((): void => { vi.useRealTimers(); });

  it('导航 pending 时旧 editor 虽可见也不能返回就绪；仅新根文档空态稳定后继续', async (): Promise<void> => {
    vi.useFakeTimers(); const test = fixture(); const proceedToInput = vi.fn();
    const pending = startNewConversation(test.view, 2000, true).then((result): typeof result => { if (result.ok) proceedToInput(); return result; });
    await flush(); expect(test.view.loadURL).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(200);
    expect(proceedToInput).not.toHaveBeenCalled(); expect(test.focus).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
    expect((test.view.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls.some((call): boolean => String(call[0]).includes('var newConversationDocument'))).toBe(false);
    test.complete(); await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ ok: true }); expect(proceedToInput).toHaveBeenCalledOnce(); expect(test.focus).toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('导航超时保留旧会话和输入，不会聚焦、注入或提交', async (): Promise<void> => {
    vi.useFakeTimers(); const test = fixture(); test.state.draft = original.mobileStory;
    const proceedToInput = vi.fn(); const pending = startNewConversation(test.view, 300, true).then((result): typeof result => { if (result.ok) proceedToInput(); return result; });
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toEqual({ ok: false, reason: 'PAGE_NOT_READY' });
    expect(test.state.draft).toBe(original.mobileStory); expect(test.state.messages).toBe(true);
    expect(test.focus).not.toHaveBeenCalled(); expect(proceedToInput).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('只有 host URL 变为根页或旧文档自行改 URL 都不能代替新文档 generation', async (): Promise<void> => {
    vi.useFakeTimers(); const test = fixture(); const pending = startNewConversation(test.view, 300, true);
    await flush(); test.state.href = 'https://www.doubao.com/chat/'; test.state.messages = false; test.state.loading = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toEqual({ ok: false, reason: 'PAGE_NOT_READY' }); expect(test.focus).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each(['loading', 'wrong-url', 'frame-loading'] as const)('新 generation 的%s仍不能进入编辑器准备', async (reason): Promise<void> => {
    vi.useFakeTimers(); const test = fixture(); const pending = startNewConversation(test.view, 300, true);
    await flush(); test.complete();
    if (reason === 'loading') test.state.readyState = 'loading';
    if (reason === 'wrong-url') test.state.href = 'https://www.doubao.com/chat/OFFLINE-other';
    if (reason === 'frame-loading') test.state.loading = true;
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toEqual({ ok: false, reason: 'PAGE_NOT_READY' }); expect(test.focus).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each([true, false])('标准根页末尾斜杠=%s时可复用已确认空文档，零重复导航', async (slash): Promise<void> => {
    vi.useFakeTimers(); const test = fixture(true, slash); const pending = startNewConversation(test.view, 1000, true);
    await vi.advanceTimersByTimeAsync(500); expect(await pending).toEqual({ ok: true }); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each(['modern-message', 'draft'] as const)('新根文档出现%s时停止，正文不清空', async (reason): Promise<void> => {
    vi.useFakeTimers(); const test = fixture(); const pending = startNewConversation(test.view, 1000, true);
    await flush(); test.complete();
    if (reason === 'modern-message') test.state.messages = true;
    else test.state.draft = original.mobileStory;
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toEqual({ ok: false, reason: 'SESSION_NOT_EMPTY' }); expect(test.focus).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
    if (reason === 'draft') expect(test.state.draft).toBe(original.mobileStory);
  });

  it.each(['draft', 'modern-message', 'new-document', 'geometry'] as const)('连续DOM核对过程中出现%s时不能报告旧空态就绪', async (reason): Promise<void> => {
    vi.useFakeTimers(); const test = fixture(); const pending = startNewConversation(test.view, 1000, true);
    await flush(); test.complete(); test.setProbeMutation((): void => {
      if (reason === 'draft') test.state.draft = original.mobileStory;
      else if (reason === 'modern-message') test.state.messages = true;
      else if (reason === 'geometry') test.state.editorLeft = test.state.editorLeft === 30 ? 40 : 30;
      else test.state.timeOrigin++;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ ok: false, reason: reason === 'draft' || reason === 'modern-message' ? 'SESSION_NOT_EMPTY' : 'PAGE_NOT_READY' }); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('绘制回调不执行且一次只读probe超时后，仍须重新取得完整稳定证据才可继续', async (): Promise<void> => {
    vi.useFakeTimers(); const test = fixture(); const execute = test.view.executeJavaScript; let hangOnce = true; let samples = 0;
    test.view.executeJavaScript = async (code: string): Promise<unknown> => {
      if (code.includes('var newConversationDocument')) {
        samples++;
        if (hangOnce) { hangOnce = false; return new Promise((): void => {}); }
      }
      return execute(code);
    };
    const proceed = vi.fn(); const pending = startNewConversation(test.view, 5000, true).then((result): typeof result => { if (result.ok) proceed(); return result; });
    await flush(); test.complete(); await vi.advanceTimersByTimeAsync(3000);
    expect(proceed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toEqual({ ok: true }); expect(samples).toBeGreaterThanOrEqual(5); expect(test.view.loadURL).toHaveBeenCalledOnce(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('只读probe持续超时在原截止时间停止，不能把超时当作空态通过', async (): Promise<void> => {
    vi.useFakeTimers(); const test = fixture(); const execute = test.view.executeJavaScript;
    test.view.executeJavaScript = async (code: string): Promise<unknown> => code.includes('var newConversationDocument') ? new Promise((): void => {}) : execute(code);
    const pending = startNewConversation(test.view, 3500, true);
    await flush(); test.complete(); await vi.advanceTimersByTimeAsync(3500);
    expect(await pending).toEqual({ ok: false, reason: 'PAGE_NOT_READY' }); expect(test.focus).not.toHaveBeenCalled(); expect(test.view.loadURL).toHaveBeenCalledOnce(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each(['empty', 'draft'] as const)('probe上下文短暂拒绝后重读同次导航的新文档%s事实，绝不再次loadURL', async (next): Promise<void> => {
    vi.useFakeTimers(); const test = fixture(); const execute = test.view.executeJavaScript; let rejectOnce = true;
    test.view.executeJavaScript = async (code: string): Promise<unknown> => {
      if (rejectOnce && code.includes('var newConversationDocument')) {
        rejectOnce = false; test.state.timeOrigin++;
        if (next === 'draft') test.state.draft = original.mobileStory;
        throw new Error('OFFLINE execution context changed');
      }
      return execute(code);
    };
    const pending = startNewConversation(test.view, 1500, true);
    await flush(); test.complete(); await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual(next === 'empty' ? { ok: true } : { ok: false, reason: 'SESSION_NOT_EMPTY' }); expect(test.view.loadURL).toHaveBeenCalledOnce(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
    if (next === 'draft') expect(test.state.draft).toBe(original.mobileStory);
  });
});
