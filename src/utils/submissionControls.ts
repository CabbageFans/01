/** 当前 guest 内的发送控件；只返回定位与正文摘要，不带页面内容。 */
export interface SendButtonTarget {
  ok: boolean;
  position?: string;
  method?: string;
  geometry?: string;
  inputHash?: string;
  dispatched?: boolean;
  humanVerification?: boolean;
}

export interface PageSubmissionOperation {
  expected?: SendButtonTarget;
  dispatchKey?: string;
  deadlineAt?: number;
  expectedPrompt?: string;
  strictParagraphs?: boolean;
}

/** 序列化到当前账号 guest：定位、复核和单次控件激活共用一条路径，不读取系统焦点。 */
export function pageSubmissionProbe(operation: PageSubmissionOperation, readText: (editor: HTMLElement) => string, hasVerification?: () => boolean): SendButtonTarget {
  try {
    if (hasVerification?.()) return { ok: false, humanVerification: true };
    const visible = (element: HTMLElement | null): element is HTMLElement => {
      if (!element || element.offsetParent === null || element.isConnected === false) return false;
      for (let current: HTMLElement | null = element; current; current = current.parentElement) {
        const style = window.getComputedStyle(current);
        if (style.visibility === 'hidden' || style.display === 'none' || current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') return false;
      }
      const style = window.getComputedStyle(element); const bounds = element.getBoundingClientRect();
      return style.pointerEvents !== 'none' && Number.parseFloat(style.opacity || '1') >= 0.5 && bounds.width > 0 && bounds.height > 0;
    };
    const enabled = (element: HTMLElement | null): element is HTMLElement => visible(element) && !(element as HTMLButtonElement).disabled
      && element.getAttribute('aria-disabled') !== 'true' && element.getAttribute('data-disabled') !== 'true';
    const editors = Array.from(document.querySelectorAll<HTMLElement>('textarea, [contenteditable="true"], [contenteditable=""]')).filter((element): boolean => {
      if (!enabled(element)) return false;
      const bounds = element.getBoundingClientRect();
      return bounds.width >= 50 && bounds.height >= 20 && bounds.right > 0 && bounds.bottom > 0 && bounds.left < window.innerWidth && bounds.top < window.innerHeight;
    });
    if (editors.length !== 1) return { ok: false };
    const editor = editors[0]; const editorBounds = editor.getBoundingClientRect();
    const actualText = readText(editor);
    const fingerprint = (value: string): string => {
      let a = 2166136261; let b = 5381;
      for (let index = 0; index < value.length; index++) { a = Math.imul(a ^ value.charCodeAt(index), 16777619); b = Math.imul(b, 33) ^ value.charCodeAt(index); }
      return `${a >>> 0}-${b >>> 0}`;
    };
    const inputHash = fingerprint(`${typeof location === 'undefined' ? '' : location.href}\u0000${actualText}`);
    const finish = (button: HTMLElement, method: string): SendButtonTarget => {
      if (!enabled(button) || typeof button.click !== 'function') return { ok: false };
      const bounds = button.getBoundingClientRect();
      const x = Math.round(bounds.left + bounds.width / 2); const y = Math.round(bounds.top + bounds.height / 2);
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return { ok: false };
      // 此命中检查只验证 guest 内是否有阻挡弹窗，与用户鼠标位置和其他应用无关。
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === button || button.contains(hit))) return { ok: false };
      const target: SendButtonTarget = { ok: true, method, position: `${x},${y}`, inputHash,
        geometry: [Math.round(bounds.left), Math.round(bounds.top), Math.round(bounds.width), Math.round(bounds.height), window.innerWidth, window.innerHeight].join(',') };
      if (!operation.dispatchKey) return target;
      const expected = operation.expected;
      if (!expected?.ok || target.method !== expected.method || target.geometry !== expected.geometry || target.position !== expected.position || target.inputHash !== expected.inputHash) return { ok: false };
      if (!Number.isFinite(operation.deadlineAt) || Date.now() >= (operation.deadlineAt as number) || operation.expectedPrompt === undefined) return { ok: false };
      const normalize = (value: string): string => operation.strictParagraphs ? value.replace(/\r\n?/g, '\n')
        : value.replace(/\u00a0/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
      if (normalize(actualText) !== normalize(operation.expectedPrompt)) return { ok: false };
      const page = globalThis as typeof globalThis & { __doubaoStudioSubmissionAttempts?: Set<string> };
      const attempts = page.__doubaoStudioSubmissionAttempts || (page.__doubaoStudioSubmissionAttempts = new Set<string>());
      if (attempts.has(operation.dispatchKey) || Date.now() >= (operation.deadlineAt as number)) return { ok: false };
      if (hasVerification?.()) return { ok: false, humanVerification: true };
      // 先消费本次运行的单次权限，再激活真实控件；异常／回执不明也不能再次点击。
      attempts.add(operation.dispatchKey);
      button.click();
      return { ...target, dispatched: true };
    };
    const exactButtons = Array.from(document.querySelectorAll<HTMLElement>('#flow-end-msg-send'));
    if (exactButtons.length > 1) return { ok: false };
    const exact = exactButtons[0];
    for (let root = editor.parentElement, depth = 0; root && depth < 12; root = root.parentElement, depth++) {
      if (root === document.body || root === document.documentElement) break;
      if (enabled(exact) && root.contains(exact)) return finish(exact, 'exact-id');
      const matches = Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"], [data-testid], [aria-label], [title]')).flatMap((control): { element: HTMLElement; semantic: boolean }[] => {
        if (!enabled(control) || control.getAttribute('aria-haspopup')) return [];
        const descriptor = [control.id, control.getAttribute('aria-label'), control.getAttribute('title'), control.getAttribute('data-testid'), control.getAttribute('data-action'), control.innerText].filter(Boolean).join(' ').toLowerCase();
        if (/麦克风|语音|voice|microphone|audio|更多|more/.test(descriptor)) return [];
        const bounds = control.getBoundingClientRect();
        const nearRight = bounds.left >= editorBounds.right - 180 && bounds.left <= editorBounds.right + 120;
        const nearVertical = bounds.top <= editorBounds.bottom + 80 && bounds.bottom >= editorBounds.top - 40;
        const square = bounds.width >= 24 && bounds.width <= 64 && bounds.height >= 24 && bounds.height <= 64;
        const semantic = /发送|提交|生成|send|submit|generate/.test(descriptor);
        const rgb = (window.getComputedStyle(control).backgroundColor || '').match(/\d+/g);
        const accent = !!(rgb && rgb.length >= 3 && Number(rgb[2]) > Number(rgb[0]) && Number(rgb[2]) > Number(rgb[1]) && Number(rgb[2]) > 120);
        return nearRight && nearVertical && square && (semantic || accent) ? [{ element: control, semantic }] : [];
      });
      if (matches.length === 1) return finish(matches[0].element, matches[0].semantic ? 'composer-semantic' : 'composer-accent');
    }
  } catch { /* 页面控件／单次激活不确定时只返回失败，调用方保留提交意图。 */ }
  return { ok: false };
}
