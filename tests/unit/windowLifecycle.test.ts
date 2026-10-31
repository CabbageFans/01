import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { retainMacWindowOnClose, revealRetainedWindow } from '../../main/utils/windowLifecycle';

describe('Mac retained window lifecycle', (): void => {
  it('hides on close while preserving renderer and Webview ownership', (): void => {
    const event = { preventDefault: vi.fn() };
    const window = { hide: vi.fn(), destroy: vi.fn(), restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
    retainMacWindowOnClose(event, window, 'darwin', false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();
    expect(window.destroy).not.toHaveBeenCalled();
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32', 'linux'])('allows explicit quit on %s', (platform: string): void => {
    const event = { preventDefault: vi.fn() };
    const window = { hide: vi.fn() };
    retainMacWindowOnClose(event, window, platform, true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(window.hide).not.toHaveBeenCalled();
  });

  it('preserves the normal Windows close behavior', (): void => {
    const event = { preventDefault: vi.fn() };
    retainMacWindowOnClose(event, { hide: vi.fn() }, 'win32', false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('restores the same minimized hidden window and focuses it', (): void => {
    const window = {
      isDestroyed: (): boolean => false,
      isMinimized: (): boolean => true,
      isVisible: (): boolean => false,
      restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
    };
    revealRetainedWindow(window);
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it('does not revive a destroyed window', (): void => {
    const window = {
      isDestroyed: (): boolean => true,
      isMinimized: (): boolean => false,
      isVisible: (): boolean => false,
      restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
    };
    revealRetainedWindow(window);
    revealRetainedWindow(null);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });
});

describe('自动化窗口权限边界', (): void => {
  it('不给渲染进程暴露恢复窗口或抢占系统焦点的输入接口', (): void => {
    // 发送链必须定向到原 guest；不保留可被后台任务调用的系统激活桥。
    const main = readFileSync(new URL('../../main/main.ts', import.meta.url), 'utf8');
    const preload = readFileSync(new URL('../../main/preload.ts', import.meta.url), 'utf8');
    const contracts = readFileSync(new URL('../../packages/contracts/src/dto/electron-api.ts', import.meta.url), 'utf8');
    expect(main).not.toContain('window:prepareNativeInput');
    expect(main).not.toMatch(/app\.focus\s*\(/);
    expect(preload).not.toContain('prepareNativeInput');
    expect(contracts).not.toContain('prepareNativeInput');
  });
});
