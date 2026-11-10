import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Task } from '@doubao-studio/contracts';
import { MaterialImagePages } from '../../src/utils/materialImagePages';

const now = '2026-11-05T00:00:00.000Z';
const account: Account = { id: 'TEST-account', name: 'TEST', avatar: '', pinned: false, partition: 'TEST-partition', status: 'idle', platform: 'doubao', createdAt: now, updatedAt: now };
function task(id: string, materialId: string, runId: string = `${id}-run`): Task {
  const binding = { projectId: 'TEST-project', stepId: `${id}-step`, imageOperationId: `${id}-operation`, materialId };
  return { id, projectId: 'TEST-studio', assignedAccountId: account.id, mode: 'image', status: 'generating', prompt: 'TEST', outputs: [], result: null,
    createdAt: now, updatedAt: now, petstory: binding, runtime: { runId, attempt: 1, stage: 'generating', startedAt: now, stageStartedAt: now,
      lastHeartbeatAt: now, message: 'TEST', input: { mode: 'image', prompt: 'TEST', attachments: [], petstory: binding } } };
}
function frameTask(id: string, mode: 'chat' | 'image' = 'image'): Task {
  const image = task(id, ''); const binding = { projectId: 'TEST-project', imageOperationId: `${id}-operation` };
  const petstory = { ...binding, stepId: `${id}-step` };
  return { ...image, mode, petstory: mode === 'image' ? petstory : undefined,
    petstoryChat: mode === 'chat' ? { ...binding, jobId: `${id}-job` } : undefined,
    runtime: { ...image.runtime!, input: { mode, prompt: image.prompt, attachments: [], ...(mode === 'image' ? { petstory } : {}) } } };
}
function host(): HTMLDivElement { const container = document.createElement('div'); document.body.append(container); return container; }
beforeEach((): void => { vi.useFakeTimers(); });
afterEach((): void => { vi.clearAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); });

describe('基础素材独立豆包任务页面', (): void => {
  it.each(['chat', 'image'] as const)('关键帧%s无materialId仍建立原账号独立页，不触碰正在展示的自由聊天', (mode: 'chat' | 'image'): void => {
    const pages = new MaterialImagePages(); const container = host(); const frame = frameTask(`TEST-frame-${mode}`, mode);
    const freeChat = document.createElement('webview'); freeChat.setAttribute('src', 'https://www.doubao.com/chat/TEST-free-chat');
    freeChat.textContent = 'TEST 用户未发送的自由聊天草稿'; container.appendChild(freeChat);
    expect(pages.uses(frame)).toBe(true);
    const page = pages.ensure(frame, account, container, (): void => undefined);
    expect(page).not.toBe(freeChat); expect(page.getAttribute('partition')).toBe('persist:doubao_TEST-partition');
    expect(page.getAttribute('src')).toBe('https://www.doubao.com/chat/');
    page.dispatchEvent(new Event('dom-ready'));
    expect(pages.get(frame)).toBe(page); expect(pages.ready(frame)).toBe(true);
    expect(freeChat.getAttribute('src')).toBe('https://www.doubao.com/chat/TEST-free-chat');
    expect(freeChat.textContent).toBe('TEST 用户未发送的自由聊天草稿');
    pages.dispose(); expect(freeChat.isConnected).toBe(true);
  });

  it('已拥有独立页的关键帧提交后缺locator仍保留同一现场，不退回自由聊天', (): void => {
    const pages = new MaterialImagePages(); const frame = frameTask('TEST-live-frame');
    const page = pages.ensure(frame, account, host(), (): void => undefined); page.dispatchEvent(new Event('dom-ready'));
    const submitted: Task = { ...frame, runtime: { ...frame.runtime!, submittedAt: now } };
    expect(pages.uses(submitted)).toBe(true); expect(pages.get(submitted)).toBe(page);
    expect(pages.ensure(submitted, account, host(), (): void => undefined)).toBe(page);
    pages.prune([{ ...submitted, status: 'fail' }], new Set([account.id]), null);
    expect(page.isConnected).toBe(true); expect(pages.get(submitted)).toBe(page); pages.dispose();
  });

  it.each(['chat', 'image'] as const)('旧关键帧%s已有提交且缺原会话定位时不创建空白页替换共享现场', (mode: 'chat' | 'image'): void => {
    const pages = new MaterialImagePages(); const container = host(); const frame = frameTask(`TEST-legacy-${mode}`, mode);
    frame.runtime!.submittedAt = now;
    expect(pages.uses(frame)).toBe(false);
    expect((): void => { pages.ensure(frame, account, container, (): void => undefined); }).toThrow();
    expect(pages.get(frame)).toBeUndefined(); expect(container.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0); pages.dispose();
  });

  it.each(['chat', 'image'] as const)('已定位旧关键帧%s只打开持久化原会话，恢复后维持原task和run', (mode: 'chat' | 'image'): void => {
    const pages = new MaterialImagePages(); const container = host(); const frame = frameTask(`TEST-restored-${mode}`, mode);
    frame.runtime!.submittedAt = now; frame.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-original-frame-conversation';
    expect(pages.uses(frame)).toBe(true);
    const page = pages.ensure(frame, account, container, (): void => undefined);
    expect(page.getAttribute('src')).toBe(frame.runtime!.conversationUrl);
    expect(page.getAttribute('partition')).toBe('persist:doubao_TEST-partition');
    page.dispatchEvent(new Event('dom-ready')); expect(pages.ready(frame)).toBe(true);
    expect(pages.ensure(frame, account, container, (): void => undefined)).toBe(page);
    expect(frame.runtime!.runId).toBe(`${frame.id}-run`); expect(frame.runtime!.submittedAt).toBe(now);
    expect(container.children).toHaveLength(1); expect(vi.getTimerCount()).toBe(0); pages.dispose();
  });

  it('不同素材保持两个独立页面，共用原账号partition，乱序就绪不串路由', (): void => {
    const pages = new MaterialImagePages(); const container = host(); const ready = vi.fn();
    const a = task('TEST-a', 'character:a'); const b = task('TEST-b', 'prop:b');
    const pageA = pages.ensure(a, account, container, ready); const pageB = pages.ensure(b, account, container, ready);
    expect(pageA).not.toBe(pageB); expect(container.children).toHaveLength(2);
    for (const page of [pageA, pageB]) expect(page.getAttribute('partition')).toBe('persist:doubao_TEST-partition');
    pageB.dispatchEvent(new Event('dom-ready'));
    expect(pages.ready(b)).toBe(true); expect(pages.ready(a)).toBe(false);
    expect(pages.get(a)).toBe(pageA); expect(pages.get(b)).toBe(pageB);
    expect(pages.ensure(a, account, container, ready)).toBe(pageA);
    pages.dispose();
  });

  it('组件重挂载复用同一任务页，迟到dom-ready唤醒当前展示而非已卸载回调', (): void => {
    const pages = new MaterialImagePages(); const original = frameTask('TEST-remount-video'); original.mode = 'video'; original.runtime!.input.mode = 'video';
    const previousCallback = vi.fn(); const nextCallback = vi.fn();
    const page = pages.ensure(original, account, host(), previousCallback);
    pages.park();
    expect(pages.ensure(original, account, host(), nextCallback)).toBe(page);
    page.dispatchEvent(new Event('dom-ready'));
    expect(previousCallback).not.toHaveBeenCalled(); expect(nextCallback).toHaveBeenCalledOnce();
    expect(pages.ready(original)).toBe(true); expect(pages.get(original)).toBe(page); expect(original.runtime!.runId).toBe('TEST-remount-video-run');
    pages.dispose();
  });

  it('原task的新run不继承旧页面，迟到dom事件不认领新运行', (): void => {
    const pages = new MaterialImagePages(); const container = host(); const ready = vi.fn();
    const original = task('TEST-a', 'character:a'); const old = pages.ensure(original, account, container, ready);
    const current = task('TEST-a', 'character:a', 'TEST-new-run');
    expect(pages.get(current)).toBeUndefined();
    const replacement = pages.ensure(current, account, container, ready);
    expect(old.isConnected).toBe(false); old.dispatchEvent(new Event('dom-ready'));
    expect(ready).not.toHaveBeenCalled(); expect(pages.owns(current.id, old)).toBe(false);
    expect(pages.get(current)).toBe(replacement); expect(pages.ready(current)).toBe(false);
    pages.dispose();
  });

  it('关闭或结束一张图不清理其他页面，后台观察页保持可渲染', (): void => {
    const pages = new MaterialImagePages(); const container = host(); const a = task('TEST-a', 'character:a'); const b = task('TEST-b', 'prop:b');
    const pageA = pages.ensure(a, account, container, (): void => undefined); const pageB = pages.ensure(b, account, container, (): void => undefined);
    pages.activate(a.id);
    expect(pageA.style.pointerEvents).toBe('auto'); expect(pageB.style.pointerEvents).toBe('none');
    expect(pageB.style.visibility).toBe('visible'); expect(pageB.style.opacity).toBe('1'); expect(pageB.style.transform).toBe('');
    pages.prune([{ ...a, status: 'done' }, b], new Set([account.id]), null);
    expect(pageA.isConnected).toBe(false); expect(pages.get(b)).toBe(pageB); expect(pageB.isConnected).toBe(true);
    pages.delete(a.id); expect(pages.get(b)).toBe(pageB);
    pages.removeAccount(account.id); expect(pageB.isConnected).toBe(false);
  });

  it('缺少正式操作绑定、跨账号或未验证Dola均不创建执行页面', (): void => {
    const pages = new MaterialImagePages(); const container = host(); const a = task('TEST-a', 'character:a');
    expect((): void => { pages.ensure({ ...a, petstory: undefined }, account, container, (): void => undefined); }).toThrow('绑定');
    expect((): void => { pages.ensure(a, { ...account, id: 'TEST-other' }, container, (): void => undefined); }).toThrow('原账号');
    expect((): void => { pages.ensure(a, { ...account, platform: 'dola' }, container, (): void => undefined); }).toThrow('原账号');
    expect(container.children).toHaveLength(0);
  });

  it('受理不明的失败页面保留唯一现场，已有原会话定位则可重新打开', async (): Promise<void> => {
    const pages = new MaterialImagePages(); const container = host(); const a = task('TEST-a', 'character:a');
    a.runtime!.submittedAt = now;
    const original = pages.ensure(a, account, container, (): void => undefined);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(pages.failure(a)).toBeUndefined(); original.dispatchEvent(new Event('dom-ready'));
    expect(pages.ready(a)).toBe(true);
    pages.prune([{ ...a, status: 'fail' }], new Set([account.id]), null);
    expect(pages.get(a)).toBe(original); expect(original.isConnected).toBe(true);
    a.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-original-conversation';
    pages.prune([{ ...a, status: 'fail' }], new Set([account.id]), null);
    expect(original.isConnected).toBe(false);
    const reopened = pages.ensure(a, account, container, (): void => undefined);
    expect(reopened.getAttribute('src')).toBe(a.runtime!.conversationUrl);
    pages.dispose();
  });

  it('只把真实主frame加载失败绑定原run，失败后的stop/ready不能复活且另一页正常', (): void => {
    const pages = new MaterialImagePages(); const container = host(); const changed = vi.fn();
    const a = task('TEST-failed-load', 'character:a'); const b = task('TEST-healthy-load', 'prop:b');
    const pageA = pages.ensure(a, account, container, changed); const pageB = pages.ensure(b, account, container, (): void => undefined);
    pageA.dispatchEvent(Object.assign(new Event('did-fail-load'), { isMainFrame: false, errorCode: -105 }));
    pageA.dispatchEvent(Object.assign(new Event('did-fail-load'), { isMainFrame: true, errorCode: -3 }));
    expect(pages.failure(a)).toBeUndefined(); expect(changed).not.toHaveBeenCalled();
    pageA.dispatchEvent(Object.assign(new Event('did-fail-load'), { isMainFrame: true, errorCode: -105 }));
    expect(pages.failure(a)).toMatchObject({ taskId: a.id, accountId: account.id, runId: a.runtime?.runId, code: 'page_loading' });
    expect(pages.failure(a)?.message).toContain('-105'); expect(pages.ready(a)).toBe(false);
    for (const event of ['did-stop-loading', 'did-finish-load', 'dom-ready']) pageA.dispatchEvent(new Event(event));
    expect(pages.ready(a)).toBe(false); expect(changed).toHaveBeenCalledOnce();
    expect(pages.ensure(a, account, container, changed)).toBe(pageA);
    pageB.dispatchEvent(new Event('dom-ready')); expect(pages.ready(b)).toBe(true); expect(pages.failure(b)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0); pages.dispose();
  });

  it('首文档事件前进程退出保留原运行错误，迟到ready不能改为可执行', (): void => {
    const pages = new MaterialImagePages(); const changed = vi.fn(); const a = task('TEST-crashed-page', 'character:a');
    const page = pages.ensure(a, account, host(), changed);
    page.dispatchEvent(new Event('render-process-gone'));
    expect(pages.failure(a)).toMatchObject({ taskId: a.id, runId: a.runtime?.runId, code: 'page_unrecognized' });
    page.dispatchEvent(new Event('dom-ready')); expect(pages.ready(a)).toBe(false);
    expect(changed).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0); pages.dispose();
  });

  it('未收到任何就绪事件时15秒精确截止，晚到事件不重建或重新派发该页', async (): Promise<void> => {
    const pages = new MaterialImagePages(); const changed = vi.fn(); const a = task('TEST-no-document', 'character:a'); const container = host();
    const page = pages.ensure(a, account, container, changed);
    await vi.advanceTimersByTimeAsync(14_999); expect(pages.failure(a)).toBeUndefined(); expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(pages.failure(a)).toMatchObject({ taskId: a.id, runId: a.runtime?.runId, code: 'page_loading' });
    expect(changed).toHaveBeenCalledOnce(); page.dispatchEvent(new Event('dom-ready'));
    expect(pages.ready(a)).toBe(false); expect(container.children).toHaveLength(1); expect(changed).toHaveBeenCalledOnce(); pages.dispose();
  });

  it('取消删除清掉自己的首载timer和监听，新run不继承旧页的失败', async (): Promise<void> => {
    const pages = new MaterialImagePages(); const changed = vi.fn(); const container = host();
    const a = task('TEST-cancel-page', 'character:a'); const b = task('TEST-retain-page', 'prop:b');
    const old = pages.ensure(a, account, container, changed); const other = pages.ensure(b, account, container, (): void => undefined);
    other.dispatchEvent(new Event('dom-ready'));
    pages.prune([{ ...a, status: 'cancelled' }, b], new Set([account.id]), null);
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(15_000);
    old.dispatchEvent(new Event('render-process-gone')); expect(changed).not.toHaveBeenCalled(); expect(pages.get(a)).toBeUndefined();
    expect(pages.get(b)).toBe(other); expect(pages.ready(b)).toBe(true);
    const resumed = task(a.id, 'character:a', 'TEST-resumed-run'); const replacement = pages.ensure(resumed, account, container, changed);
    old.dispatchEvent(Object.assign(new Event('did-fail-load'), { isMainFrame: true, errorCode: -105 }));
    expect(pages.failure(resumed)).toBeUndefined(); replacement.dispatchEvent(new Event('dom-ready'));
    expect(pages.ready(resumed)).toBe(true); expect(changed).toHaveBeenCalledOnce(); pages.dispose();
  });

  it('首文档就绪立即清截止计时，运行中的页面不被首载timer误暂停', async (): Promise<void> => {
    const pages = new MaterialImagePages(); const changed = vi.fn(); const a = task('TEST-loaded-page', 'character:a');
    const page = pages.ensure(a, account, host(), changed); page.dispatchEvent(new Event('dom-ready'));
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(30_000);
    expect(pages.failure(a)).toBeUndefined(); expect(pages.ready(a)).toBe(true); expect(changed).toHaveBeenCalledOnce(); pages.dispose();
  });
});
