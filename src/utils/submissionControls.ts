declare const __doubaoAssertOperation: (() => void) | undefined;
export interface NativeSubmissionReceipt { mouseDown: boolean; activated: boolean; trusted: boolean; cancelled: boolean; documentId: number }
interface NativeReservation {
  element: HTMLElement; target: SendButtonTarget; receipt: NativeSubmissionReceipt;
  validate: () => boolean; onEvent: EventListener; dispose: () => void; cancel: () => void;
}
/** 当前 guest 内的发送控件；只返回定位与正文摘要，不带页面内容。 */
export interface SendButtonTarget {
  ok: boolean;
  position?: string;
  method?: string;
  geometry?: string;
  inputHash?: string;
  dispatched?: boolean;
  dispatchAttempted?: boolean;
  humanVerification?: boolean;
  documentId?: number;
  nativeReserved?: boolean;
  nativeReceipt?: NativeSubmissionReceipt;
}

export interface PageSubmissionOperation {
  expected?: SendButtonTarget;
  dispatchKey?: string;
  deadlineAt?: number;
  expectedPrompt?: string;
  strictParagraphs?: boolean;
  reserveNative?: boolean;
  validateNativeKey?: string;
  readReceiptKey?: string;
  cancelNativeKey?: string;
}

/** 序列化到当前账号 guest：定位、复核和单次控件激活共用一条路径，不读取系统焦点。 */
export function pageSubmissionProbe(operation: PageSubmissionOperation, readText: (editor: HTMLElement) => string, hasVerification?: () => boolean): SendButtonTarget {
  try {
    const page = globalThis as typeof globalThis & { __doubaoStudioSubmissionAttempts?: Set<string>; __doubaoNativeSubmissionReceipts?: Map<string, NativeReservation> };
    const receipts = page.__doubaoNativeSubmissionReceipts || new Map<string, NativeReservation>();
    const receiptResult = (record: NativeReservation): SendButtonTarget => ({ ...record.target, nativeReserved: !record.receipt.cancelled,
      nativeReceipt: { ...record.receipt }, dispatched: record.receipt.activated, dispatchAttempted: record.receipt.mouseDown || record.receipt.activated });
    if (operation.cancelNativeKey) {
      const record = receipts.get(operation.cancelNativeKey);
      if (record) { if (!record.receipt.activated) record.cancel(); return receiptResult(record); }
      return { ok: false };
    }
    if (operation.readReceiptKey) { const record = receipts.get(operation.readReceiptKey); return record ? receiptResult(record) : { ok: false }; }
    if (typeof __doubaoAssertOperation === 'function') __doubaoAssertOperation();
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
    const sameExpected = (target: SendButtonTarget): boolean => {
      const expected = operation.expected;
      return !!expected?.ok && target.method === expected.method && target.geometry === expected.geometry && target.position === expected.position
        && target.inputHash === expected.inputHash && target.documentId === expected.documentId;
    };
    const validateReserved = (button: HTMLElement, target: SendButtonTarget, key: string): SendButtonTarget => {
      const reserved = receipts.get(key);
      if (!reserved || reserved.element !== button || reserved.target.geometry !== target.geometry || reserved.target.inputHash !== target.inputHash
        || reserved.target.documentId !== target.documentId || !reserved.validate()) return { ok: false };
      return receiptResult(reserved);
    };
    const finish = (button: HTMLElement, method: string): SendButtonTarget => {
      const identity = [button.getAttribute('aria-label'), button.getAttribute('title'), button.getAttribute('data-action')].filter(Boolean).join(' ');
      if (/上传|附件|文件|upload|attach|purchase|subscribe|购买|充值|订阅/i.test(identity)) return { ok: false };
      if (!enabled(button) || typeof button.click !== 'function') return { ok: false };
      const bounds = button.getBoundingClientRect();
      const x = Math.round(bounds.left + bounds.width / 2); const y = Math.round(bounds.top + bounds.height / 2);
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return { ok: false };
      // 此命中检查只验证 guest 内是否有阻挡弹窗，与用户鼠标位置和其他应用无关。
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === button || button.contains(hit))) return { ok: false };
      const target: SendButtonTarget = { ok: true, method, position: `${x},${y}`, inputHash, documentId: typeof performance === 'undefined' ? undefined : performance.timeOrigin,
        geometry: [Math.round(bounds.left), Math.round(bounds.top), Math.round(bounds.width), Math.round(bounds.height), window.innerWidth, window.innerHeight].join(',') };
      if (operation.validateNativeKey) return validateReserved(button, target, operation.validateNativeKey);
      if (!operation.dispatchKey) return target;
      if (!sameExpected(target)) return { ok: false };
      if (!Number.isFinite(operation.deadlineAt) || Date.now() >= (operation.deadlineAt as number) || operation.expectedPrompt === undefined) return { ok: false };
      const normalize = (value: string): string => operation.strictParagraphs ? value.replace(/\r\n?/g, '\n')
        : value.replace(/\u00a0/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
      if (normalize(actualText) !== normalize(operation.expectedPrompt)) return { ok: false };
      const attempts = page.__doubaoStudioSubmissionAttempts || (page.__doubaoStudioSubmissionAttempts = new Set<string>());
      if (attempts.has(operation.dispatchKey)) return { ok: false, dispatchAttempted: true };
      if (Date.now() >= (operation.deadlineAt as number)) return { ok: false };
      if (hasVerification?.()) return { ok: false, humanVerification: true };
      // 先消费本次运行的单次权限，再激活真实控件；异常／回执不明也不能再次点击。
      attempts.add(operation.dispatchKey);
      if (operation.reserveNative) return reserveNative(button, target, normalize);
      try { button.click(); } catch { return { ...target, dispatched: false, dispatchAttempted: true }; }
      return { ...target, dispatched: true, dispatchAttempted: true };
    };
    const reserveNative = (button: HTMLElement, target: SendButtonTarget, normalize: (value: string) => string): SendButtonTarget => {
      if (!Number.isFinite(target.documentId)) return { ok: false };
      // 新的正式预留交接前才移除旧取消守卫；旧宿主异步续步仍受冻结操作上下文阻断。
      for (const previous of receipts.values()) if (previous.receipt.cancelled || !previous.validate()) previous.dispose();
      const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
      const receipt: NativeSubmissionReceipt = { mouseDown: false, activated: false, trusted: false, cancelled: false, documentId: target.documentId as number };
      const validate = (): boolean => {
        try {
          if (typeof __doubaoAssertOperation === 'function') __doubaoAssertOperation();
          if (receipt.cancelled || Date.now() >= (operation.deadlineAt as number) || performance.timeOrigin !== receipt.documentId || !enabled(button)
            || normalize(readText(editor)) !== normalize(operation.expectedPrompt as string) || hasVerification?.()) return false;
          const rect = button.getBoundingClientRect(); const centerX = Math.round(rect.left + rect.width / 2); const centerY = Math.round(rect.top + rect.height / 2);
          const currentGeometry = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height), window.innerWidth, window.innerHeight].join(',');
          const hit = document.elementFromPoint(centerX, centerY);
          return target.geometry === currentGeometry && !!hit && (hit === button || button.contains(hit));
        } catch { return false; }
      };
      const dispose = (): void => { if (timer) clearTimeout(timer); for (const name of events) document.removeEventListener(name, onEvent, true); };
      const cancel = (): void => { receipt.cancelled = true; if (timer) clearTimeout(timer); };
      const onEvent: EventListener = (event: Event): void => {
        const belongs = event.target === button || event.target instanceof Node && button.contains(event.target);
        if (receipt.cancelled) {
          // 保留取消墓碑，拒绝已排队的迟到原生序列；其它位置的用户交互不受影响。
          const point = target.position?.split(',').map(Number); const mouse = event as MouseEvent;
          if (belongs || point && mouse.clientX === point[0] && mouse.clientY === point[1]) { event.preventDefault(); event.stopImmediatePropagation(); }
          return;
        }
        if (!event.isTrusted || !belongs || !validate()) {
          event.preventDefault(); event.stopImmediatePropagation(); cancel(); return;
        }
        if (event.type === 'mousedown') receipt.mouseDown = true;
        if (event.type === 'click') {
          if (!receipt.mouseDown) { event.preventDefault(); event.stopImmediatePropagation(); cancel(); return; }
          else { receipt.activated = true; receipt.trusted = true; }
          dispose();
        }
      };
      const record: NativeReservation = { element: button, target, receipt, validate, onEvent, dispose, cancel };
      page.__doubaoNativeSubmissionReceipts = receipts;
      receipts.set(operation.dispatchKey as string, record);
      for (const name of events) document.addEventListener(name, onEvent, true);
      const timer = setTimeout(cancel, Math.max(0, (operation.deadlineAt as number) - Date.now()));
      return receiptResult(record);
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
        if (/麦克风|语音|voice|microphone|audio|更多|more|上传|附件|upload|attach|购买|充值|订阅|purchase|subscribe/.test(descriptor)) return [];
        const bounds = control.getBoundingClientRect();
        const nearRight = bounds.left >= editorBounds.right - 180 && bounds.left <= editorBounds.right + 120;
        const nearVertical = bounds.top <= editorBounds.bottom + 80 && bounds.bottom >= editorBounds.top - 40;
        const square = bounds.width >= 24 && bounds.width <= 64 && bounds.height >= 24 && bounds.height <= 64;
        if (control.closest?.('[data-testid="skill_input_exit_button"],[data-valid-btn="mode-select-action-btn"],[data-testid="skill_bar_button_more"]')) return [];
        const labels = [control.getAttribute('aria-label'), control.getAttribute('title'), control.innerText].filter((value): value is string => !!value)
          .map((value): string => value.trim().replace(/\s+/g, ' ').toLowerCase());
        const semantic = labels.some((value): boolean => ['发送', '发送消息', '提交', '生成', '立即生成', '开始生成', 'send', 'send message', 'submit', 'generate'].includes(value))
          || [control.getAttribute('data-testid'), control.getAttribute('data-action')].some((value): boolean => !!value && /^(?:chat[-_]send|send[-_]button|message[-_]send|submit[-_]button|generate[-_]button)$/.test(value));
        return nearRight && nearVertical && square && semantic ? [{ element: control, semantic }] : [];
      });
      if (matches.length === 1) return finish(matches[0].element, 'composer-semantic');
    }
  } catch { /* 页面控件／单次激活不确定时只返回失败，调用方保留提交意图。 */ }
  return { ok: false };
}
