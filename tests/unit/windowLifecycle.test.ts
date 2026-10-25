import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareWindowForNativeInput, retainMacWindowOnClose, revealRetainedWindow } from '../../main/utils/windowLifecycle';

describe('Mac retained window lifecycle', (): void => {
  it('hides on close while preserving renderer and Webview ownership', (): void => {
    const event = { preventDefault: vi.fn() };
    const window = { hide: vi.fn(), destroy: vi.fn() };
    retainMacWindowOnClose(event, window, 'darwin', false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();
    expect(window.destroy).not.toHaveBeenCalled();
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

describe('OS focus before native input', (): void => {
  afterEach((): void => { vi.useRealTimers(); });

  function fixture(focused = false): { window: Parameters<typeof prepareWindowForNativeInput>[0]; events: EventEmitter; focus: () => void } {
    const events = new EventEmitter();
    return {
      events,
      focus: (): void => { focused = true; events.emit('focus'); },
      window: {
        isDestroyed: (): boolean => false, isMinimized: (): boolean => true,
        isVisible: (): boolean => false, isFocused: (): boolean => focused,
        restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
        once: (event: 'focus', listener: () => void): EventEmitter => events.once(event, listener),
        removeListener: (event: 'focus', listener: () => void): EventEmitter => events.removeListener(event, listener),
      },
    };
  }

  it('waits for actual OS focus before allowing native input', async (): Promise<void> => {
    vi.useFakeTimers();
    const f = fixture();
    const activate = vi.fn((): void => { setTimeout(f.focus, 10); });
    let resolved = false;
    const pending = prepareWindowForNativeInput(f.window, activate).then((value: boolean): boolean => { resolved = true; return value; });
    await vi.advanceTimersByTimeAsync(9);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(true);
    expect(activate).toHaveBeenCalledOnce();
    expect(f.events.listenerCount('focus')).toBe(0);
  });

  it('fails closed on timeout and removes the focus listener', async (): Promise<void> => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = prepareWindowForNativeInput(f.window, vi.fn(), 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBe(false);
    expect(f.events.listenerCount('focus')).toBe(0);
  });

  it('allows an already focused window and leaves no listener', async (): Promise<void> => {
    const f = fixture(true);
    expect(await prepareWindowForNativeInput(f.window, vi.fn())).toBe(true);
    expect(f.events.listenerCount('focus')).toBe(0);
  });

  it('does not activate a missing window', async (): Promise<void> => {
    const activate = vi.fn();
    expect(await prepareWindowForNativeInput(null, activate)).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });

  it('cleans up and fails closed when window activation throws', async (): Promise<void> => {
    const f = fixture();
    expect(await prepareWindowForNativeInput(f.window, (): void => { throw new Error('activation failed'); })).toBe(false);
    expect(f.events.listenerCount('focus')).toBe(0);
  });
});
