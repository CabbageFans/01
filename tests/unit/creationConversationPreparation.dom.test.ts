/** 离线执行真实页面脚本，验证创作准备只读复用与新文档的连续空态证据。 */
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickAITab, startNewConversation, type NewConversationResult, type WebviewHandle } from '../../src/utils/doubaoBridge';

type CreationMode = 'image' | 'video';
type ContentState = 'draft' | 'user-message' | 'assistant-message' | 'stop-button' | 'monitor-generating';
type AttachmentState = 'unloaded-image' | 'hidden-attachment' | 'audio' | 'video' | 'selected-file' | 'pending-upload' | 'progress';
interface PageState { href: string; timeOrigin: number; readyState: string; loading: boolean; editorLeft: number }
interface CreationFixture {
  state: PageState;
  view: WebviewHandle;
  readonly editor: HTMLTextAreaElement;
  readonly surface: HTMLElement;
  focus: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  entry: ReturnType<typeof vi.fn>;
  completeNavigation: () => void;
  setProbeMutation: (mutation: () => void) => void;
}

const rootUrl = 'https://www.doubao.com/chat/';

function fixture(mode: CreationMode = 'video', history: boolean = false): CreationFixture {
  const state: PageState = { href: history ? rootUrl + 'OFFLINE-original' : rootUrl, timeOrigin: 1, readyState: 'complete', loading: false, editorLeft: 30 };
  let hostUrl = state.href;
  let editor: HTMLTextAreaElement;
  let surface: HTMLElement;
  let probeMutation = (): void => {};
  const focus = vi.fn(); const exit = vi.fn(); const entry = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(focus);
  vi.spyOn(document, 'readyState', 'get').mockImplementation((): DocumentReadyState => state.readyState as DocumentReadyState);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement): DOMRect {
    const isEditor = this.tagName === 'TEXTAREA' || this.hasAttribute('contenteditable');
    return { x: state.editorLeft, y: isEditor ? 550 : 672, left: state.editorLeft, top: isEditor ? 550 : 672,
      right: state.editorLeft + 600, bottom: isEditor ? 650 : 704, width: 600, height: isEditor ? 100 : 32, toJSON: (): object => ({}) };
  });
  const selected = (): void => {
    const skill = document.createElement('button'); skill.dataset.testid = 'skill_input_exit_button';
    skill.textContent = mode === 'image' ? '图像生成' : '视频生成'; skill.addEventListener('click', exit); surface.append(skill);
  };
  const install = (alreadySelected: boolean): void => {
    document.body.replaceChildren();
    surface = document.createElement('div'); surface.className = 'guidance-input-surface';
    const engine = document.createElement('div'); engine.id = 'input-engine-container';
    editor = document.createElement('textarea'); engine.append(editor); surface.append(engine); document.body.append(surface);
    if (alreadySelected) selected();
    else {
      const bar = document.createElement('div'); bar.dataset.testid = 'guidance-skill-bar';
      const button = document.createElement('button'); button.dataset.testid = 'skill_bar_button_' + mode;
      button.textContent = mode === 'image' ? '图像生成' : '视频生成';
      button.addEventListener('click', (): void => { entry(); bar.remove(); selected(); }); bar.append(button); surface.append(bar);
    }
  };
  install(true);
  if (history) addMessage('send_message');
  const context = {
    document, window, HTMLElement, HTMLTextAreaElement, HTMLInputElement, Element, Node, PointerEvent, MouseEvent, Event,
    location: { get href(): string { return state.href; } },
    performance: { get timeOrigin(): number { return state.timeOrigin; } }, Date, URL, setTimeout, clearTimeout,
  };
  const view: WebviewHandle = {
    getURL: (): string => hostUrl,
    loadURL: vi.fn((next: string): void => { hostUrl = next; state.loading = true; }),
    isLoadingMainFrame: (): boolean => state.loading,
    executeJavaScript: vi.fn(async (code: string): Promise<unknown> => {
      const result: unknown = runInNewContext(code, context);
      if (code.includes('var newConversationDocument')) probeMutation();
      return result;
    }),
    sendInputEvent: vi.fn(),
  };
  return { state, view, get editor(): HTMLTextAreaElement { return editor; }, get surface(): HTMLElement { return surface; }, focus, exit, entry,
    completeNavigation: (): void => { state.href = hostUrl; state.timeOrigin++; state.readyState = 'complete'; state.loading = false; install(false); },
    setProbeMutation: (mutation: () => void): void => { probeMutation = mutation; } };
}

function addMessage(testId: 'send_message' | 'receive_message'): HTMLElement {
  const message = document.createElement('div'); message.dataset.testid = testId;
  const content = document.createElement('div'); content.dataset.testid = 'message_text_content'; content.textContent = 'OFFLINE 保留的会话内容';
  message.append(content); document.body.prepend(message); return message;
}

async function flush(): Promise<void> { for (let index = 0; index < 20; index++) await Promise.resolve(); }

async function settled<T>(work: Promise<T>): Promise<T> {
  let result: { value: T } | { error: unknown } | undefined;
  void work.then((value: T): void => { result = { value }; }, (error: unknown): void => { result = { error }; });
  for (let sample = 0; sample < 100 && !result; sample++) await vi.advanceTimersByTimeAsync(100);
  if (!result) throw new Error('TEST 创作准备超过正式有界期限');
  if ('error' in result) throw result.error;
  return result.value;
}

function prepare(test: CreationFixture, mode: CreationMode = 'video'): Promise<NewConversationResult> {
  return startNewConversation(test.view, 1200, false, false, undefined, mode);
}

beforeEach((): void => {
  vi.useFakeTimers();
  const hiddenByLayout = (element: HTMLElement): boolean => window.getComputedStyle(element).display === 'none'
    || !!element.parentElement && hiddenByLayout(element.parentElement);
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: function (this: HTMLElement): Element | null {
    // visibility:hidden / aria-hidden 保留布局和 offsetParent，不能冒充 display:none。
    return hiddenByLayout(this) ? null : this.parentElement;
  } });
});
afterEach((): void => {
  document.body.replaceChildren(); delete (window as Window & { __genState?: unknown }).__genState;
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetParent');
  vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe('创作会话准备保留媒体输入区，不制造冷启动竞争', (): void => {
  it.each<CreationMode>(['image', 'video'])('官方空根页的 %s 技能零导航零聚焦复用，后续模式回读继续成功', async (mode: CreationMode): Promise<void> => {
    const test = fixture(mode); const initialSkill = test.surface.querySelector('[data-testid="skill_input_exit_button"]');
    expect(await settled(prepare(test, mode))).toEqual({ ok: true });
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled();
    expect(test.surface.querySelector('[data-testid="skill_input_exit_button"]')).toBe(initialSkill);
    expect(await settled(clickAITab(test.view, mode))).toBe(true);
    expect(test.entry).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('隐藏镜像编辑器不参与唯一性，也不会被聚焦或清空', async (): Promise<void> => {
    const test = fixture(); const hidden = document.createElement('div'); hidden.style.visibility = 'hidden';
    const mirror = document.createElement('textarea'); mirror.value = 'OFFLINE hidden mirror'; hidden.append(mirror); document.body.prepend(hidden);
    expect(await settled(startNewConversation(test.view, 1200, false, true, undefined, 'video'))).toEqual({ ok: true });
    expect(mirror.value).toBe('OFFLINE hidden mirror'); expect(test.focus).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled();
  });

  it('实际编辑器有草稿时，前置空镜像不能覆盖草稿证据', async (): Promise<void> => {
    const test = fixture(); test.editor.value = 'OFFLINE 实际可见草稿';
    const hidden = document.createElement('div'); hidden.style.visibility = 'hidden'; hidden.append(document.createElement('textarea')); document.body.prepend(hidden);
    expect(await settled(prepare(test))).toEqual({ ok: false, reason: 'SESSION_NOT_EMPTY' });
    expect(test.editor.value).toBe('OFFLINE 实际可见草稿'); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled();
  });

  it('后台任务保护当前输入的前置检查仍复用空根页，不退出已选视频技能', async (): Promise<void> => {
    const test = fixture();
    expect(await settled(startNewConversation(test.view, 1200, false, true, undefined, 'video'))).toEqual({ ok: true });
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled();
    expect(await settled(clickAITab(test.view, 'video'))).toBe(true);
  });

  it('media 参数与普通 Chat 的复用开关同时启用时仍保留媒体技能', async (): Promise<void> => {
    const test = fixture();
    expect(await settled(startNewConversation(test.view, 1200, true, false, undefined, 'video'))).toEqual({ ok: true });
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled();
    expect(await settled(clickAITab(test.view, 'video'))).toBe(true);
  });

  it('两个真实可见编辑器没有唯一归属，拒绝复用且不导航清场', async (): Promise<void> => {
    const test = fixture(); const other = document.createElement('div'); other.className = 'guidance-input-surface'; other.append(document.createElement('textarea')); document.body.append(other);
    expect(await settled(prepare(test))).toEqual({ ok: false, reason: 'PAGE_NOT_READY' });
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled();
  });

  it.each(['draft', 'user-message', 'assistant-message', 'stop-button', 'monitor-generating'] as const)('空根页存在 %s 时拒绝，不清除现场、不导航', async (kind: ContentState): Promise<void> => {
    const test = fixture();
    if (kind === 'draft') test.editor.value = 'OFFLINE 原始草稿';
    else if (kind === 'user-message') addMessage('send_message');
    else if (kind === 'assistant-message') addMessage('receive_message');
    else if (kind === 'stop-button') { const stop = document.createElement('button'); stop.setAttribute('aria-label', '停止生成'); test.surface.append(stop); }
    else (window as Window & { __genState?: { generating: boolean } }).__genState = { generating: true };
    const markup = document.body.innerHTML; const draft = test.editor.value;
    expect(await settled(prepare(test))).toEqual({ ok: false, reason: 'SESSION_NOT_EMPTY' });
    expect(document.body.innerHTML).toBe(markup); expect(test.editor.value).toBe(draft);
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each(['unloaded-image', 'hidden-attachment', 'audio', 'video', 'selected-file', 'pending-upload', 'progress'] as const)('输入区存在 %s 时不冒充空会话，保留附件与选择', async (kind: AttachmentState): Promise<void> => {
    const test = fixture(); let file: HTMLInputElement | undefined;
    if (kind === 'selected-file') {
      file = document.createElement('input'); file.type = 'file'; const transfer = new DataTransfer(); transfer.items.add(new File(['OFFLINE'], 'test.png', { type: 'image/png' })); file.files = transfer.files; test.surface.append(file);
    } else if (kind === 'audio' || kind === 'video') {
      test.surface.append(document.createElement(kind));
    } else {
      const item = document.createElement('div');
      if (kind === 'pending-upload') item.dataset.status = 'uploading';
      else if (kind === 'progress') item.setAttribute('role', 'progressbar');
      else { item.dataset.testid = 'attachment-image-card'; item.append(document.createElement('img')); if (kind === 'hidden-attachment') item.style.display = 'none'; }
      test.surface.append(item);
    }
    const markup = document.body.innerHTML;
    if (kind === 'unloaded-image') { const image = test.surface.querySelector('img'); expect(image?.naturalWidth).toBe(0); }
    expect(await settled(prepare(test))).toEqual({ ok: false, reason: 'SESSION_NOT_EMPTY' });
    expect(document.body.innerHTML).toBe(markup); if (file) expect(file.files?.length).toBe(1);
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('历史会话只导航一次，必须等新根文档空态稳定，再选择真实视频技能', async (): Promise<void> => {
    const test = fixture('video', true); let done = false;
    const pending = prepare(test).then((result: NewConversationResult): NewConversationResult => { done = true; return result; });
    await flush(); await vi.advanceTimersByTimeAsync(200);
    expect(test.view.loadURL).toHaveBeenCalledExactlyOnceWith(rootUrl); expect(done).toBe(false);
    expect(test.state.timeOrigin).toBe(1); expect(test.state.href).not.toBe(rootUrl); expect(document.querySelector('[data-testid="send_message"]')).not.toBeNull();
    expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled();
    test.completeNavigation();
    expect(await settled(pending)).toEqual({ ok: true });
    expect(test.focus).not.toHaveBeenCalled(); expect(test.view.loadURL).toHaveBeenCalledOnce();
    expect(await settled(clickAITab(test.view, 'video'))).toBe(true); expect(test.entry).toHaveBeenCalledOnce(); expect(test.exit).not.toHaveBeenCalled();
  });

  it('图片恢复的精确本任务草稿可带旧附件进入一次新文档导航，旧输入不被清空', async (): Promise<void> => {
    const test = fixture('image'); const owned = 'OFFLINE 本任务图片恢复草稿'; test.editor.value = owned;
    const oldEditor = test.editor; const attachment = document.createElement('div'); attachment.dataset.testid = 'attachment-image-card'; attachment.append(document.createElement('img')); test.surface.append(attachment);
    const input = document.createElement('input'); input.type = 'file'; const transfer = new DataTransfer(); transfer.items.add(new File(['OFFLINE'], 'previous.png', { type: 'image/png' })); input.files = transfer.files; test.surface.append(input);
    let done = false;
    const pending = startNewConversation(test.view, 1200, false, true, owned, 'image').then((result: NewConversationResult): NewConversationResult => { done = true; return result; });
    await flush(); await vi.advanceTimersByTimeAsync(200);
    expect(test.view.loadURL).toHaveBeenCalledExactlyOnceWith(rootUrl); expect(done).toBe(false); expect(test.state.timeOrigin).toBe(1);
    expect(oldEditor.value).toBe(owned); expect(attachment.isConnected).toBe(true); expect(input.files?.length).toBe(1);
    expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
    test.completeNavigation();
    expect(await settled(pending)).toEqual({ ok: true }); expect(test.state.timeOrigin).toBe(2); expect(test.editor.value).toBe('');
    expect(test.view.loadURL).toHaveBeenCalledOnce(); expect(oldEditor.value).toBe(owned); expect(input.files?.length).toBe(1);
    expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled(); expect(test.entry).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each(['OFFLINE 其他用户草稿', 'OFFLINE 本任务图片恢复草稿x'])('图片恢复草稿不精确匹配时拒绝导航：%s', async (draft: string): Promise<void> => {
    const test = fixture('image'); const owned = 'OFFLINE 本任务图片恢复草稿'; test.editor.value = draft;
    expect(await settled(startNewConversation(test.view, 1200, false, true, owned, 'image'))).toEqual({ ok: false, reason: 'SESSION_NOT_EMPTY' });
    expect(test.editor.value).toBe(draft); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each(['uploading', 'monitor', 'stop'] as const)('精确本任务图片草稿仍不能越过 %s 状态', async (kind: 'uploading' | 'monitor' | 'stop'): Promise<void> => {
    const test = fixture('image'); const owned = 'OFFLINE 本任务图片恢复草稿'; test.editor.value = owned;
    if (kind === 'monitor') (window as Window & { __genState?: { generating: boolean } }).__genState = { generating: true };
    else {
      const control = document.createElement(kind === 'stop' ? 'button' : 'div');
      if (kind === 'stop') control.setAttribute('aria-label', '停止生成'); else control.dataset.status = 'uploading'; test.surface.append(control);
    }
    const markup = document.body.innerHTML;
    expect(await settled(startNewConversation(test.view, 1200, false, true, owned, 'image'))).toEqual({ ok: false, reason: kind === 'stop' ? 'GENERATION_IN_PROGRESS' : 'SESSION_NOT_EMPTY' });
    expect(test.editor.value).toBe(owned); expect(document.body.innerHTML).toBe(markup);
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('本任务草稿授权仅用于导航前检查，新文档恢复同样草稿也不能当作空态通过', async (): Promise<void> => {
    const test = fixture('image'); const owned = 'OFFLINE 本任务图片恢复草稿'; test.editor.value = owned;
    const pending = startNewConversation(test.view, 1200, false, true, owned, 'image');
    await flush(); expect(test.view.loadURL).toHaveBeenCalledOnce(); test.completeNavigation(); test.editor.value = owned;
    expect(await settled(pending)).toEqual({ ok: false, reason: 'SESSION_NOT_EMPTY' });
    expect(test.editor.value).toBe(owned); expect(test.view.loadURL).toHaveBeenCalledOnce(); expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('旧版 data-role 用户气泡同样阻止空态复用，且不触发媒体退出', async (): Promise<void> => {
    const test = fixture(); const bubble = document.createElement('div'); bubble.dataset.role = 'user'; bubble.textContent = 'OFFLINE 旧版用户消息'; document.body.prepend(bubble);
    expect(await settled(prepare(test))).toEqual({ ok: false, reason: 'SESSION_NOT_EMPTY' });
    expect(bubble.textContent).toBe('OFFLINE 旧版用户消息'); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled();
  });

  it('首个空态样本后出现用户附件时中止，不能拿旧样本继续', async (): Promise<void> => {
    const test = fixture(); let samples = 0;
    test.setProbeMutation((): void => {
      samples++;
      if (samples === 1) { const attachment = document.createElement('div'); attachment.dataset.testid = 'attachment-file-card'; test.surface.append(attachment); }
    });
    expect(await settled(prepare(test))).toEqual({ ok: false, reason: 'SESSION_NOT_EMPTY' });
    expect(samples).toBeGreaterThan(1); expect(test.surface.querySelector('[data-testid="attachment-file-card"]')).not.toBeNull();
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled();
  });

  it.each(['document', 'geometry'] as const)('连续空态采样之间的 %s 一直变化时不能拼接为稳定证据', async (kind: 'document' | 'geometry'): Promise<void> => {
    const test = fixture(); let samples = 0;
    test.setProbeMutation((): void => { samples++; if (kind === 'document') test.state.timeOrigin++; else test.state.editorLeft += 2; });
    expect(await settled(prepare(test))).toEqual({ ok: false, reason: 'PAGE_NOT_READY' });
    expect(samples).toBeGreaterThan(2); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.focus).not.toHaveBeenCalled(); expect(test.exit).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });
});
