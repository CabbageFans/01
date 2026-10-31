export interface PopupControlTarget {
  allowed: boolean;
  position?: string;
  geometry?: string;
  fingerprint?: string;
}

export interface PopupControlClick {
  expected: PopupControlTarget;
  expectedUrl: string;
  deadlineAt: number;
  dispatchKey: string;
}

/** guest 内重读白名单与唯一控件后单次激活；超时队列、窗口失焦均不借用系统输入。 */
export function clickWhitelistedPopupControl(operation: PopupControlClick, read: () => PopupControlTarget): boolean {
  try {
    const sameTarget = (current: PopupControlTarget, expected: PopupControlTarget): boolean => current.allowed && expected.allowed
      && !!current.position && !!current.geometry && !!current.fingerprint && current.position === expected.position
      && current.geometry === expected.geometry && current.fingerprint === expected.fingerprint;
    const enabled = (control: HTMLElement | null): control is HTMLElement => !!control && control !== document.body && control !== document.documentElement
      && typeof control.click === 'function' && !(control as HTMLButtonElement).disabled
      && control.getAttribute('aria-disabled') !== 'true' && control.getAttribute('data-disabled') !== 'true';
    const currentUrl = typeof location === 'undefined' ? '' : location.href;
    if (!operation.expectedUrl || currentUrl !== operation.expectedUrl || !Number.isFinite(operation.deadlineAt)
      || Date.now() >= operation.deadlineAt || !operation.dispatchKey) return false;
    const current = read(); const expected = operation.expected;
    if (!sameTarget(current, expected)) return false;
    const [x, y] = (current.position || '').split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    let control: HTMLElement | null = hit as HTMLElement | null;
    while (control && control !== document.body && control !== document.documentElement) {
      const bounds = control.getBoundingClientRect();
      const geometry = [Math.round(bounds.left), Math.round(bounds.top), Math.round(bounds.width), Math.round(bounds.height)].join(',');
      if (geometry === current.geometry && control.matches('button,[role="button"],a,[aria-label],[title]')) break;
      control = control.parentElement;
    }
    if (!enabled(control) || !hit || !(hit === control || control.contains(hit))) return false;
    const page = globalThis as typeof globalThis & { __doubaoStudioPopupAttempts?: Set<string> };
    const attempts = page.__doubaoStudioPopupAttempts || (page.__doubaoStudioPopupAttempts = new Set<string>());
    if (attempts.has(operation.dispatchKey) || Date.now() >= operation.deadlineAt || location.href !== operation.expectedUrl) return false;
    // 确认可能直接提交：点击前消费权限，异常或回执不明也不得补点。
    attempts.add(operation.dispatchKey);
    control.click();
    return true;
  } catch { return false; }
}
