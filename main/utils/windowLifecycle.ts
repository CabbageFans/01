export interface RetainedWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  isVisible(): boolean;
  show(): void;
  focus(): void;
}

/** 仅供用户显式重开窗口；保留原 renderer/Webview 实例并恢复可见性。 */
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
