export interface EmptyCreationComposer {
  ok: boolean;
  reason: 'READY' | 'PAGE_NOT_READY' | 'SESSION_NOT_EMPTY';
  geometry?: number[];
  ownedDraft?: true;
}

/** 序列化到 guest；只读创作输入区，不聚焦、切换模式或清除用户现场。 */
export function readEmptyCreationComposer(ownedDraft?: string): EmptyCreationComposer {
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || parent.getAttribute('aria-hidden') === 'true') return false;
    }
    return !element.matches(':disabled,[aria-disabled="true"]');
  };
  const editors = Array.from(document.querySelectorAll<HTMLElement>('textarea,[contenteditable="true"],[contenteditable=""]')).filter(visible);
  if (editors.length !== 1) return { ok: false, reason: 'PAGE_NOT_READY' };
  const editor = editors[0];
  const root = editor.closest('[data-testid="guidance-input-surface"],.guidance-input-surface');
  if (!root || !visible(root)) return { ok: false, reason: 'PAGE_NOT_READY' };
  const draft = editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent || '';
  const files = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="file"]')).some((input: HTMLInputElement): boolean => !!input.files?.length);
  // 未解码或隐藏的附件也属于当前输入，不能通过只数已加载图片把它们当成空态。
  const attachments = root.querySelector('[data-testid="attachment-image-card"],[data-testid="attachment-file-card"],[data-testid="image-upload-item"],[data-testid="reference-image"],[data-testid="mdbox_image"],[data-testid="upload-file-item"],[data-kind="audio"],[data-kind="video"],audio,video');
  const pending = Array.from(root.querySelectorAll('[aria-busy="true"],[data-status="uploading"],[role="progressbar"]')).some(visible);
  const monitor = (window as Window & { __genState?: { generating?: boolean } }).__genState;
  if (pending || monitor?.generating) return { ok: false, reason: 'SESSION_NOT_EMPTY' };
  // 仅既有图片恢复传入的精确本任务草稿可进入单次新文档导航；它不属于空页复用。
  if (draft.trim()) return ownedDraft && draft === ownedDraft ? { ok: true, reason: 'READY', ownedDraft: true } : { ok: false, reason: 'SESSION_NOT_EMPTY' };
  if (files || attachments) return { ok: false, reason: 'SESSION_NOT_EMPTY' };
  const rect = editor.getBoundingClientRect();
  return { ok: true, reason: 'READY', geometry: [rect.left, rect.top, rect.width, rect.height, window.innerWidth, window.innerHeight].map(Math.round) };
}
