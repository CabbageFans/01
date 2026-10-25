export interface RetainedWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  isVisible(): boolean;
  show(): void;
  focus(): void;
}

export interface NativeInputWindow extends RetainedWindow {
  isFocused(): boolean;
  once(event: 'focus', listener: () => void): unknown;
  removeListener(event: 'focus', listener: () => void): unknown;
}

/** 原生输入前确认 OS 窗口焦点；第一次鼠标点击不能被拿来仅激活窗口。 */
export function prepareWindowForNativeInput(
  window: NativeInputWindow | null,
  activate: () => void,
  timeoutMs: number = 1500,
): Promise<boolean> {
  if (!window || window.isDestroyed()) return Promise.resolve(false);
  return new Promise<boolean>((resolve: (focused: boolean) => void): void => {
    let settled = false;
    const finish = (focused: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeListener('focus', onFocus);
      resolve(focused);
    };
    const onFocus = (): void => finish(!window.isDestroyed() && window.isFocused());
    const timer = setTimeout((): void => finish(false), timeoutMs);
    window.once('focus', onFocus);
    try {
      activate();
      revealRetainedWindow(window);
      if (!window.isDestroyed() && window.isFocused()) finish(true);
    } catch {
      finish(false);
    }
  });
}

/** 保留原 renderer/Webview 实例，Dock 重开时只恢复可见性。 */
export function revealRetainedWindow(window: RetainedWindow | null): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

/** Mac 红色关闭按钮和 Cmd+W 隐藏窗口；只有显式退出才允许销毁执行链。 */
export function retainMacWindowOnClose(
  event: { preventDefault(): void },
  window: { hide(): void },
  platform: string,
  isQuitting: boolean,
): void {
  if (platform !== 'darwin' || isQuitting) return;
  event.preventDefault();
  window.hide();
}
