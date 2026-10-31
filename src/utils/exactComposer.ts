/** 自包含的精确正文写入探针；原生编辑器事件保留段落，不触发 Enter 或发送。 */
export function insertExactComposerText(value: string): boolean {
  try {
    const editors = Array.from(document.querySelectorAll<HTMLElement>('textarea,[contenteditable="true"],[contenteditable=""]')).filter((editor: HTMLElement): boolean => {
      const style = window.getComputedStyle(editor);
      const rect = editor.getBoundingClientRect();
      return editor.offsetParent !== null && !('disabled' in editor && editor.disabled) && editor.getAttribute('aria-disabled') !== 'true'
        && !editor.closest('[aria-hidden="true"]') && style.display !== 'none' && style.visibility !== 'hidden'
        && rect.width >= 50 && rect.height >= 20 && rect.right > 0 && rect.bottom > 0
        && rect.left < window.innerWidth && rect.top < window.innerHeight;
    });
    if (editors.length !== 1) return false;
    const editor = editors[0];
    // 聚焦不得滚动长输入区，使随后全文回读沿用同一可见编辑器。
    editor.focus({ preventScroll: true });
    if (editor.tagName === 'TEXTAREA') (editor as HTMLTextAreaElement).select();
    else {
      const selection = window.getSelection();
      if (!selection) return false;
      const range = document.createRange(); range.selectNodeContents(editor);
      selection.removeAllRanges(); selection.addRange(range);
    }
    return document.execCommand('insertText', false, value);
  } catch { return false; }
}

/** 富文本段落的逻辑换行；innerText 会额外加入 P 元素的布局空行。 */
export function readExactComposerText(editor: HTMLElement): string {
  if (editor.tagName === 'TEXTAREA') return (editor as HTMLTextAreaElement).value;
  const blocks = Array.from(editor.children || []);
  // 只处理明确的逐段 P 结构；空段仍保留，实际多段／丢段不会被折叠。
  if (blocks.length && blocks.every((node: Element): boolean => node.tagName === 'P' && (!node.querySelector('br') || !(node.textContent || '')))) {
    return blocks.map((node: Element): string => node.textContent || '').join('\n');
  }
  return editor.innerText || editor.textContent || '';
}

/** 原生追加到当前编辑器光标末端；@ 菜单由平台创建引用节点，不注入伪造 HTML。 */
export function appendExactComposerText(value: string, reset = false): boolean {
  const editors = Array.from(document.querySelectorAll<HTMLElement>('textarea,[contenteditable="true"],[contenteditable=""]')).filter((el): boolean => {
    const rect = el.getBoundingClientRect(); const style = window.getComputedStyle(el);
    return el.offsetParent !== null && !('disabled' in el && el.disabled) && el.getAttribute('aria-disabled') !== 'true'
      && style.display !== 'none' && style.visibility !== 'hidden' && !el.closest('[aria-hidden="true"]')
      && rect.width >= 50 && rect.height >= 20 && rect.right > 0 && rect.bottom > 0
      && rect.left < window.innerWidth && rect.top < window.innerHeight;
  });
  if (editors.length !== 1) return false;
  const editor = editors[0]; editor.focus({ preventScroll: true });
  if (editor.tagName === 'TEXTAREA') { const input = editor as HTMLTextAreaElement; input.setSelectionRange(reset ? 0 : input.value.length, input.value.length); }
  else {
    const range = document.createRange(); range.selectNodeContents(editor); if (!reset) range.collapse(false);
    const selection = window.getSelection(); if (!selection) return false; selection.removeAllRanges(); selection.addRange(range);
  }
  return document.execCommand(reset && !value ? 'delete' : 'insertText', false, value);
}
