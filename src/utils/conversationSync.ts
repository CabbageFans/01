import { hasHumanVerificationEvidence, readHumanVerificationEvidence } from './humanVerification';
import { isSameDoubaoConversation, normalizeDoubaoConversationUrl } from './taskConversationLocator';

export interface ConversationSyncPageSnapshot {
  documentId: string;
  url: string;
  ready: boolean;
  editorPresent: boolean;
  editorText: string;
  /** 无法确定当前输入区边界时为 null，不能据此刷新。 */
  attachmentCount: number | null;
  pendingUploads: boolean | null;
  generating: boolean;
  humanVerification: boolean;
  userInteracting: boolean;
  /** 最近操作仅阻止被动同步；用户离开 Chat 后的显式检查不受 15 秒记忆阻断。 */
  recentInteraction?: boolean;
}

export interface ConversationSyncNavigator {
  getURL(): string;
  loadURL(url: string): void | Promise<unknown>;
  reload(): void | Promise<unknown>;
}

export type ConversationSyncFailure = 'INVALID_TARGET' | 'CANCELLED' | 'CONTEXT_CHANGED' | 'DIFFERENT_CONVERSATION'
  | 'PAGE_UNREADABLE' | 'PAGE_NOT_READY' | 'DRAFT_PRESENT' | 'ATTACHMENTS_PRESENT' | 'GENERATING'
  | 'HUMAN_VERIFICATION' | 'USER_INTERACTING' | 'NAVIGATION_FAILED' | 'NAVIGATION_TIMEOUT';
type SyncAction = 'reload' | 'navigate';
export type ConversationSyncResult =
  | { ok: true; action: SyncAction; snapshot: ConversationSyncPageSnapshot }
  | { ok: false; reason: ConversationSyncFailure; action?: SyncAction };

export interface ConversationSyncOptions {
  navigator: ConversationSyncNavigator;
  targetUrl: string;
  readPageSnapshot(): Promise<ConversationSyncPageSnapshot | null>;
  /** 调用方核对原任务/run/账号租约；每次等待后及导航前都重新核对。 */
  isCurrent(): boolean;
  /** 显示/聚焦仅同步已经打开的原会话，不能趁机切换会话。 */
  trigger?: 'explicit' | 'visibility';
  signal?: AbortSignal;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

function protectedPageReason(page: ConversationSyncPageSnapshot, trigger: ConversationSyncOptions['trigger']): ConversationSyncFailure | undefined {
  if (page.humanVerification) return 'HUMAN_VERIFICATION';
  if (page.editorText.trim()) return 'DRAFT_PRESENT';
  if (page.attachmentCount === null || page.pendingUploads === null) return 'PAGE_UNREADABLE';
  if (page.attachmentCount > 0 || page.pendingUploads) return 'ATTACHMENTS_PRESENT';
  if (page.generating) return 'GENERATING';
  if (page.userInteracting || trigger === 'visibility' && page.recentInteraction) return 'USER_INTERACTING';
  if (!page.ready || !page.editorPresent) return 'PAGE_NOT_READY';
  return undefined;
}

function isSnapshot(value: ConversationSyncPageSnapshot | null): value is ConversationSyncPageSnapshot {
  return !!value && typeof value.documentId === 'string' && !!value.documentId.trim() && typeof value.url === 'string'
    && typeof value.editorText === 'string'
    && ['ready', 'editorPresent', 'generating', 'humanVerification', 'userInteracting']
      .every((key: string): boolean => typeof value[key as keyof ConversationSyncPageSnapshot] === 'boolean')
    && (value.recentInteraction === undefined || typeof value.recentInteraction === 'boolean')
    && (value.attachmentCount === null || Number.isInteger(value.attachmentCount) && value.attachmentCount >= 0)
    && (value.pendingUploads === null || typeof value.pendingUploads === 'boolean');
}

type SyncBaseline = { ok: true; snapshot: ConversationSyncPageSnapshot } | { ok: false; reason: ConversationSyncFailure };

async function readSyncBaseline(
  options: ConversationSyncOptions, target: string,
  read: () => Promise<ConversationSyncPageSnapshot | null>,
  stopped: () => ConversationSyncFailure | undefined,
): Promise<SyncBaseline> {
  const inspect = async (): Promise<SyncBaseline> => {
    const page = await read();
    const reason = stopped();
    if (reason) return { ok: false, reason };
    if (!isSnapshot(page)) return { ok: false, reason: 'PAGE_UNREADABLE' };
    const protection = protectedPageReason(page, options.trigger);
    return protection ? { ok: false, reason: protection } : { ok: true, snapshot: page };
  };
  const baseline = await inspect();
  if (!baseline.ok) return baseline;
  // 再读一次输入区，防止首个异步快照返回前用户已输入或切换了文档。
  const before = await inspect();
  if (!before.ok) return before;
  if (before.snapshot.documentId !== baseline.snapshot.documentId || before.snapshot.url !== baseline.snapshot.url
    || options.navigator.getURL() !== before.snapshot.url) return { ok: false, reason: 'CONTEXT_CHANGED' };
  if (options.trigger === 'visibility' && !isSameDoubaoConversation(before.snapshot.url, target)) return { ok: false, reason: 'DIFFERENT_CONVERSATION' };
  return before;
}

/**
 * 只刷新/导航一次，不输入、不上传、不发送。旧文档仍就绪、同 URL 提前回读都不算完成。
 * visibility 调用可随时安全跳过；调用方不应将跳过变成强制刷新或周期重试。
 */
export async function syncTaskConversation(options: ConversationSyncOptions): Promise<ConversationSyncResult> {
  const target = normalizeDoubaoConversationUrl(options.targetUrl);
  if (!target) return { ok: false, reason: 'INVALID_TARGET' };
  const now = options.now ?? Date.now;
  const timeout = Math.max(1, options.timeoutMs ?? 20_000);
  const interval = Math.max(1, options.intervalMs ?? 250);
  const deadline = now() + timeout;
  const wait = options.wait ?? ((ms: number): Promise<void> => new Promise((resolve): void => { setTimeout(resolve, ms); }));
  let action: SyncAction | undefined;
  const stopped = (): ConversationSyncFailure | undefined => {
    if (options.signal?.aborted) return 'CANCELLED';
    try { if (!options.isCurrent()) return 'CONTEXT_CHANGED'; }
    catch { return 'CONTEXT_CHANGED'; }
    return undefined;
  };
  const fail = (reason: ConversationSyncFailure): ConversationSyncResult => action ? { ok: false, reason, action } : { ok: false, reason };
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    const reason = stopped();
    if (reason) throw reason;
    const remaining = deadline - now();
    if (remaining <= 0) throw 'NAVIGATION_TIMEOUT';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      const value = await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject): void => {
          timer = setTimeout((): void => reject('NAVIGATION_TIMEOUT'), remaining);
          abort = (): void => reject('CANCELLED');
          options.signal?.addEventListener('abort', abort, { once: true });
          if (options.signal?.aborted) abort();
        }),
      ]);
      const after = stopped();
      if (after) throw after;
      if (now() >= deadline) throw 'NAVIGATION_TIMEOUT';
      return value;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) options.signal?.removeEventListener('abort', abort);
    }
  };
  const read = (): Promise<ConversationSyncPageSnapshot | null> => bounded(options.readPageSnapshot);
  try {
    const initialStop = stopped();
    if (initialStop) return fail(initialStop);
    if (options.trigger === 'visibility' && !isSameDoubaoConversation(options.navigator.getURL(), target)) return fail('DIFFERENT_CONVERSATION');
    const baseline = await readSyncBaseline(options, target, read, stopped);
    if (!baseline.ok) return fail(baseline.reason);
    const before = baseline.snapshot;
    const nextAction = isSameDoubaoConversation(before.url, target) ? 'reload' : 'navigate';
    await bounded(async (): Promise<void> => {
      action = nextAction;
      if (nextAction === 'reload') await options.navigator.reload();
      else await options.navigator.loadURL(target);
    });
    while (now() < deadline) {
      await bounded((): Promise<void> => wait(Math.min(interval, Math.max(1, deadline - now()))));
      let page: ConversationSyncPageSnapshot | null;
      try { page = await read(); }
      catch (error: unknown) {
        // 导航销毁旧执行上下文是正常过渡，只读重取，不再导航。
        if (error === 'CANCELLED' || error === 'CONTEXT_CHANGED' || error === 'NAVIGATION_TIMEOUT') throw error;
        continue;
      }
      const pageStop = stopped();
      if (pageStop) return fail(pageStop);
      if (!isSnapshot(page)) continue;
      if (page.humanVerification) return fail('HUMAN_VERIFICATION');
      if (page.documentId === before.documentId || !page.ready || !page.editorPresent
        || !isSameDoubaoConversation(page.url, target) || !isSameDoubaoConversation(options.navigator.getURL(), target)) continue;
      // 新文档可能已经呈现正在生成的原任务；同步完成后只允许调用方继续只读观察。
      return { ok: true, action: nextAction, snapshot: page };
    }
    return fail('NAVIGATION_TIMEOUT');
  } catch (error: unknown) {
    const reason = stopped();
    if (reason) return fail(reason);
    if (error === 'CANCELLED' || error === 'CONTEXT_CHANGED' || error === 'NAVIGATION_TIMEOUT') return fail(error);
    return fail(action ? 'NAVIGATION_FAILED' : 'PAGE_UNREADABLE');
  }
}

/** 仅在当前文档内存记录可信用户活动；不派发事件、不更改页面和平台存储。 */
function readSyncUserInteraction(
  doc: Document, visible: (element: Element) => boolean, root: Element | null, editor: Element | null,
): { userInteracting: boolean; recentInteraction: boolean } {
  const current = doc as Document & { __doubaoStudioSyncInteraction?: { lastAt: number }; __doubaoStudioCreationHistorySampling?: boolean };
  if (!current.__doubaoStudioSyncInteraction) {
    const activity = { lastAt: doc.hasFocus() ? Date.now() : 0 };
    current.__doubaoStudioSyncInteraction = activity;
    const record = (event: Event): void => {
      // 原任务历史只读采样会程序滚动，不据此制造“用户刚操作”的 15 秒记忆。
      if (event.type === 'scroll' && current.__doubaoStudioCreationHistorySampling === true) return;
      if (event.isTrusted) activity.lastAt = Date.now();
    };
    for (const event of ['pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart']) {
      doc.addEventListener(event, record, { capture: true, passive: true });
    }
  }
  const recent = current.__doubaoStudioSyncInteraction.lastAt > 0 && Date.now() - current.__doubaoStudioSyncInteraction.lastAt < 15_000;
  const focused = !!editor && doc.hasFocus() && !!doc.activeElement && (root || editor).contains(doc.activeElement);
  const playing = Array.from(doc.querySelectorAll<HTMLMediaElement>('video,audio'))
    .some((media: HTMLMediaElement): boolean => visible(media) && !media.paused && !media.ended);
  const overlay = Array.from(doc.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open],[class*="image-preview"],[class*="ImagePreview"],[class*="preview-modal"],[class*="PhotoView"],[role="menu"],[role="listbox"]')).some(visible);
  return { userInteracting: focused || playing || overlay, recentInteraction: recent };
}

/** 自包含 DOM 只读探针；身份仅放在当前 Document 内存，不改页面 DOM/输入/平台存储。 */
function readConversationSyncPage(
  doc: Document, win: Window, verification: boolean,
  interacting: (doc: Document, visible: (element: Element) => boolean, root: Element | null, editor: Element | null) => { userInteracting: boolean; recentInteraction: boolean },
): ConversationSyncPageSnapshot {
  const current = doc as Document & { __doubaoStudioSyncDocumentId?: string };
  if (!current.__doubaoStudioSyncDocumentId) {
    current.__doubaoStudioSyncDocumentId = win.crypto?.randomUUID?.()
      || `${win.performance.timeOrigin}:${Date.now()}:${Math.random()}`;
  }
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = win.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || Number.parseFloat(style.opacity || '1') === 0 || parent.getAttribute('aria-hidden') === 'true' || parent.hasAttribute('inert')) return false;
    }
    return true;
  };
  const editors = Array.from(doc.querySelectorAll<HTMLElement>('textarea,[contenteditable="true"],[contenteditable=""]'))
    .filter((element: HTMLElement): boolean => visible(element) && !element.closest('[data-testid="send_message"],[data-testid="receive_message"]'));
  const editor = editors.length === 1 ? editors[0] : null;
  const surface = editor?.closest<HTMLElement>('.guidance-input-surface,#input-engine-container,[data-testid="chat-input"],[data-testid="chat_input"]');
  let root = surface || editor?.parentElement || null;
  while (root && root !== doc.body && !surface && !root.querySelector('input[type="file"]')) root = root.parentElement;
  let attachmentCount: number | null = null;
  let pendingUploads: boolean | null = null;
  if (root && root !== doc.body && visible(root)) {
    const cards = Array.from(root.querySelectorAll('[data-testid="mdbox_image"],[data-testid="image-upload-item"],[data-testid="reference-image"],[data-testid="attachment-image-card"],[data-testid="attachment-file-card"],[data-testid="attachment-video-card"],[data-testid="attachment-audio-card"]')).filter(visible);
    const files = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="file"]')).reduce((total: number, input: HTMLInputElement): number => total + (input.files?.length || 0), 0);
    attachmentCount = Math.max(cards.length, files);
    pendingUploads = Array.from(root.querySelectorAll('[aria-busy="true"],[class*="uploading"],[class*="progress"],[class*="loading"],[data-status="uploading"]')).some(visible);
  }
  return {
    documentId: current.__doubaoStudioSyncDocumentId, url: win.location.href, ready: doc.readyState === 'complete',
    editorPresent: !!editor, editorText: editor?.tagName === 'TEXTAREA' ? (editor as HTMLTextAreaElement).value : editor?.innerText || editor?.textContent || '',
    attachmentCount, pendingUploads,
    generating: Array.from(doc.querySelectorAll('button[aria-label*="停止"],button[aria-label*="stop"],[data-testid="chat_input_local_break_button"],[class*="stop-generat"]')).some(visible),
    humanVerification: verification, ...interacting(doc, visible, root, editor),
  };
}

export function conversationSyncPageSnapshotScript(): string {
  return `(${readConversationSyncPage.toString()})(document,window,(${hasHumanVerificationEvidence.toString()})((${readHumanVerificationEvidence.toString()})(document,window)),${readSyncUserInteraction.toString()})`;
}
