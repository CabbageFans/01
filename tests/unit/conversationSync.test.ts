import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncTaskConversation, type ConversationSyncOptions, type ConversationSyncPageSnapshot } from '../../src/utils/conversationSync';

const originalUrl = 'https://www.doubao.com/chat/OFFLINE-original';
const otherUrl = 'https://www.doubao.com/chat/OFFLINE-other';

function fixture(): {
  page: ConversationSyncPageSnapshot;
  options: ConversationSyncOptions;
  reload: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  setHostUrl: (url: string) => void;
  setCurrent: (current: boolean) => void;
} {
  let hostUrl = originalUrl;
  let current = true;
  const page: ConversationSyncPageSnapshot = {
    documentId: 'document-before', url: originalUrl, ready: true, editorPresent: true, editorText: '',
    attachmentCount: 0, pendingUploads: false, generating: false, humanVerification: false, userInteracting: false,
  };
  const reload = vi.fn();
  const loadURL = vi.fn((url: string): void => { hostUrl = url; });
  return {
    page, reload, loadURL,
    options: {
      navigator: { getURL: (): string => hostUrl, reload, loadURL }, targetUrl: originalUrl,
      readPageSnapshot: vi.fn(async (): Promise<ConversationSyncPageSnapshot> => ({ ...page })),
      isCurrent: (): boolean => current, timeoutMs: 1_000, intervalMs: 100,
    },
    setHostUrl: (url: string): void => { hostUrl = url; },
    setCurrent: (value: boolean): void => { current = value; },
  };
}

async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }

describe('原会话安全同步只读刷新', (): void => {
  afterEach((): void => { vi.useRealTimers(); });

  it('同 URL 的旧就绪 DOM 不能完成刷新；新文档就绪且身份匹配后才返回', async (): Promise<void> => {
    vi.useFakeTimers();
    const test = fixture(); let done = false;
    const pending = syncTaskConversation(test.options).then((result): typeof result => { done = true; return result; });
    await flush(); expect(test.reload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300); expect(done).toBe(false);
    test.page.documentId = 'document-after'; test.page.ready = false;
    await vi.advanceTimersByTimeAsync(100); expect(done).toBe(false);
    test.page.ready = true; test.page.url = otherUrl;
    await vi.advanceTimersByTimeAsync(100); expect(done).toBe(false);
    test.page.url = originalUrl;
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ ok: true, action: 'reload', snapshot: test.page });
    expect(test.reload).toHaveBeenCalledOnce(); expect(test.loadURL).not.toHaveBeenCalled();
  });

  it('显式检查可从空闲会话导航到原会话一次；上下文暂时销毁不会重复导航', async (): Promise<void> => {
    vi.useFakeTimers(); const test = fixture();
    test.page.url = otherUrl; test.setHostUrl(otherUrl);
    let reads = 0;
    test.options.readPageSnapshot = async (): Promise<ConversationSyncPageSnapshot> => {
      reads++;
      if (reads === 3) throw new Error('execution context destroyed');
      return { ...test.page };
    };
    const pending = syncTaskConversation(test.options); await flush();
    expect(test.loadURL).toHaveBeenCalledExactlyOnceWith(originalUrl);
    await vi.advanceTimersByTimeAsync(100);
    test.page.documentId = 'document-after'; test.page.url = originalUrl;
    // 原任务正在生成是刷新后的平台事实，成功后仅继续只读观察。
    test.page.generating = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ ok: true, action: 'navigate', snapshot: { generating: true } });
    expect(test.loadURL).toHaveBeenCalledOnce(); expect(test.reload).not.toHaveBeenCalled();
  });

  it.each([
    [{ editorPresent: false }, 'PAGE_NOT_READY'], [{ ready: false }, 'PAGE_NOT_READY'],
    [{ editorText: '用户尚未发送的正文' }, 'DRAFT_PRESENT'], [{ attachmentCount: 1 }, 'ATTACHMENTS_PRESENT'],
    [{ pendingUploads: true }, 'ATTACHMENTS_PRESENT'], [{ attachmentCount: null }, 'PAGE_UNREADABLE'],
    [{ pendingUploads: null }, 'PAGE_UNREADABLE'], [{ generating: true }, 'GENERATING'],
    [{ humanVerification: true }, 'HUMAN_VERIFICATION'], [{ userInteracting: true }, 'USER_INTERACTING'],
  ] as const)('输入区保护 %j 时不刷新或离开页面', async (patch, reason): Promise<void> => {
    const test = fixture(); Object.assign(test.page, patch);
    expect(await syncTaskConversation(test.options)).toEqual({ ok: false, reason });
    expect(test.reload).not.toHaveBeenCalled(); expect(test.loadURL).not.toHaveBeenCalled();
  });

  it('首次快照之后开始输入时，第二次核对保护新草稿', async (): Promise<void> => {
    const test = fixture(); let reads = 0;
    test.options.readPageSnapshot = async (): Promise<ConversationSyncPageSnapshot> => {
      const value = { ...test.page }; if (++reads === 1) test.page.editorText = '新输入'; return value;
    };
    expect(await syncTaskConversation(test.options)).toEqual({ ok: false, reason: 'DRAFT_PRESENT' });
    expect(test.page.editorText).toBe('新输入'); expect(test.reload).not.toHaveBeenCalled();
  });

  it('显示/聚焦的被动同步不会从别的会话跳转，也不会强制刷新交互中的页面', async (): Promise<void> => {
    const test = fixture(); test.options.trigger = 'visibility'; test.setHostUrl(otherUrl);
    expect(await syncTaskConversation(test.options)).toEqual({ ok: false, reason: 'DIFFERENT_CONVERSATION' });
    expect(test.options.readPageSnapshot).not.toHaveBeenCalled();
    test.setHostUrl(originalUrl); test.page.userInteracting = true;
    expect(await syncTaskConversation(test.options)).toEqual({ ok: false, reason: 'USER_INTERACTING' });
    expect(test.reload).not.toHaveBeenCalled(); expect(test.loadURL).not.toHaveBeenCalled();
  });

  it('最近操作只跳过被动同步；用户已离开输入区后显式检查立即刷新', async (): Promise<void> => {
    vi.useFakeTimers(); const passive = fixture(); passive.options.trigger = 'visibility'; passive.page.recentInteraction = true;
    expect(await syncTaskConversation(passive.options)).toEqual({ ok: false, reason: 'USER_INTERACTING' }); expect(passive.reload).not.toHaveBeenCalled();
    const explicit = fixture(); explicit.page.recentInteraction = true;
    const pending = syncTaskConversation(explicit.options); await flush(); expect(explicit.reload).toHaveBeenCalledOnce();
    explicit.page.documentId = 'new-document'; await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ ok: true, action: 'reload' });
  });

  it.each(['task', 'document', 'host-url'] as const)('导航前 %s 改变后不能拿旧快照导航', async (change): Promise<void> => {
    const test = fixture(); let reads = 0;
    test.options.readPageSnapshot = async (): Promise<ConversationSyncPageSnapshot> => {
      const value = { ...test.page };
      if (++reads === 1) {
        if (change === 'task') test.setCurrent(false);
        else if (change === 'document') test.page.documentId = 'another-document';
        else test.setHostUrl(otherUrl);
      }
      return value;
    };
    expect(await syncTaskConversation(test.options)).toEqual({ ok: false, reason: 'CONTEXT_CHANGED' });
    expect(test.reload).not.toHaveBeenCalled(); expect(test.loadURL).not.toHaveBeenCalled();
  });

  it('挂起的首个只读快照仍受截止时间约束；迟到结果不会触发刷新', async (): Promise<void> => {
    vi.useFakeTimers(); const test = fixture();
    let resolve: ((page: ConversationSyncPageSnapshot) => void) | undefined;
    test.options.readPageSnapshot = (): Promise<ConversationSyncPageSnapshot> => new Promise((done): void => { resolve = done; });
    const pending = syncTaskConversation(test.options);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({ ok: false, reason: 'NAVIGATION_TIMEOUT' });
    resolve?.(test.page); await flush(); expect(test.reload).not.toHaveBeenCalled();
  });

  it('取消挂起读操作立即结束，迟到读不再改变导航', async (): Promise<void> => {
    const test = fixture(); const controller = new AbortController(); test.options.signal = controller.signal;
    test.options.readPageSnapshot = (): Promise<never> => new Promise((): void => {});
    const pending = syncTaskConversation(test.options); controller.abort();
    expect(await pending).toEqual({ ok: false, reason: 'CANCELLED' }); expect(test.reload).not.toHaveBeenCalled();
  });

  it('刷新后任务租约改变或验证码出现立即停止，不重复刷新', async (): Promise<void> => {
    vi.useFakeTimers(); const test = fixture(); const pending = syncTaskConversation(test.options); await flush();
    test.setCurrent(false); await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ ok: false, reason: 'CONTEXT_CHANGED', action: 'reload' }); expect(test.reload).toHaveBeenCalledOnce();
    const verification = fixture(); const next = syncTaskConversation(verification.options); await flush();
    verification.page.documentId = 'new-document'; verification.page.humanVerification = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(await next).toEqual({ ok: false, reason: 'HUMAN_VERIFICATION', action: 'reload' }); expect(verification.reload).toHaveBeenCalledOnce();
  });

  it('刷新一直停留旧文档时超时保留原输入，不尝试再次导航', async (): Promise<void> => {
    vi.useFakeTimers(); const test = fixture(); const pending = syncTaskConversation(test.options);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({ ok: false, reason: 'NAVIGATION_TIMEOUT', action: 'reload' });
    expect(test.reload).toHaveBeenCalledOnce(); expect(test.loadURL).not.toHaveBeenCalled();
  });
});
