import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conversationSyncPageSnapshotScript, type ConversationSyncPageSnapshot } from '../../src/utils/conversationSync';

function read(): ConversationSyncPageSnapshot {
  return window.eval(conversationSyncPageSnapshotScript()) as ConversationSyncPageSnapshot;
}

describe('安全会话同步的真实序列化只读探针', (): void => {
  beforeEach((): void => {
    // 每例模拟独立文档；真实页面不会重复安装同一文档的只读活动观察器。
    delete (document as Document & { __doubaoStudioSyncInteraction?: unknown }).__doubaoStudioSyncInteraction;
    document.body.innerHTML = '<div class="guidance-input-surface"><input type="file" hidden><textarea></textarea></div>';
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 20, y: 20, left: 20, top: 20, right: 120, bottom: 60, width: 100, height: 40, toJSON: (): object => ({}) });
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  });
  afterEach((): void => { vi.useRealTimers(); });

  it('同一 document 的身份稳定；读取不会聚焦、清空或发送正文', (): void => {
    const editor = document.querySelector('textarea')!; editor.value = '未发送正文';
    const focus = vi.spyOn(editor, 'focus'); const dispatch = vi.spyOn(editor, 'dispatchEvent');
    const first = read(); const second = read();
    expect(first.documentId).toBeTruthy(); expect(second.documentId).toBe(first.documentId);
    expect(first).toMatchObject({ editorPresent: true, editorText: '未发送正文', attachmentCount: 0, pendingUploads: false, userInteracting: false });
    expect(editor.value).toBe('未发送正文'); expect(focus).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });

  it('当前输入区中的可见附件、未出现预览的已选文件和上传状态都保留', (): void => {
    const root = document.querySelector('.guidance-input-surface')!;
    root.insertAdjacentHTML('beforeend', '<div data-testid="mdbox_image"><img></div><div data-status="uploading"></div>');
    expect(read()).toMatchObject({ attachmentCount: 1, pendingUploads: true });
    root.querySelector('[data-testid="mdbox_image"]')!.remove(); root.querySelector('[data-status="uploading"]')!.remove();
    Object.defineProperty(root.querySelector('input'), 'files', { configurable: true, value: [new File(['x'], 'unsent.png')] });
    expect(read()).toMatchObject({ attachmentCount: 1, pendingUploads: false });
  });

  it('隐藏/历史附件不冒充当前附件；输入区边界未知时不报告安全空态', (): void => {
    document.body.insertAdjacentHTML('beforeend', '<div data-testid="receive_message"><div data-testid="mdbox_image"></div></div>');
    document.querySelector('.guidance-input-surface')!.insertAdjacentHTML('beforeend', '<div data-testid="mdbox_image" style="display:none"></div>');
    expect(read().attachmentCount).toBe(0);
    document.body.innerHTML = '<div><textarea></textarea></div>';
    expect(read()).toMatchObject({ editorPresent: true, attachmentCount: null, pendingUploads: null });
  });

  it('用户正聚焦输入区、真实停止控件与可见验证码分别识别；回复中的验证文字不触发', (): void => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    document.querySelector('textarea')!.focus();
    document.body.insertAdjacentHTML('beforeend', '<div data-testid="receive_message">请完成验证</div><button aria-label="停止生成"></button>');
    expect(read()).toMatchObject({ userInteracting: true, generating: true, humanVerification: false });
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog">请完成验证</div>');
    expect(read().humanVerification).toBe(true);
  });

  it('正在播放的可见媒体、可见预览和选择弹层都不被自动刷新打断', (): void => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    document.body.append(video);
    expect(read().userInteracting).toBe(true);
    video.style.display = 'none'; expect(read().userInteracting).toBe(false);
    document.body.insertAdjacentHTML('beforeend', '<div class="image-preview-root"></div>');
    expect(read().userInteracting).toBe(true);
    document.querySelector('.image-preview-root')!.remove();
    document.body.insertAdjacentHTML('beforeend', '<div role="listbox"></div>');
    expect(read().userInteracting).toBe(true);
  });

  it('最近 15 秒可信 pointer/key/scroll 活动跳过刷新；合成事件不算用户操作', (): void => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    const listeners = vi.spyOn(document, 'addEventListener');
    expect(read()).toMatchObject({ userInteracting: false, recentInteraction: false });
    expect(listeners.mock.calls.map((call): string => call[0])).toEqual(expect.arrayContaining(['pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart']));
    const callback = listeners.mock.calls.find((call): boolean => call[0] === 'keydown')?.[1] as EventListener;
    callback({ isTrusted: false } as Event); expect(read()).toMatchObject({ userInteracting: false, recentInteraction: false });
    const sampling = document as Document & { __doubaoStudioCreationHistorySampling?: boolean };
    sampling.__doubaoStudioCreationHistorySampling = true;
    const scroll = listeners.mock.calls.find((call): boolean => call[0] === 'scroll')?.[1] as EventListener;
    scroll({ type: 'scroll', isTrusted: true } as Event); expect(read().recentInteraction).toBe(false);
    callback({ isTrusted: true } as Event); expect(read()).toMatchObject({ userInteracting: false, recentInteraction: true });
    delete sampling.__doubaoStudioCreationHistorySampling;
    vi.advanceTimersByTime(14_999); expect(read().recentInteraction).toBe(true);
    vi.advanceTimersByTime(1); expect(read().recentInteraction).toBe(false);
    expect(listeners.mock.calls.filter((call): boolean => call[0] === 'keydown')).toHaveLength(1);
  });
});
