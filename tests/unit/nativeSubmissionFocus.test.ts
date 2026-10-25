import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitPromptWithNativeClick } from '../../src/utils/doubaoBridge';

describe('single native submission requires OS focus', (): void => {
  afterEach((): void => { vi.unstubAllGlobals(); });

  it('does not send any mouse event if focus cannot be confirmed', async (): Promise<void> => {
    vi.stubGlobal('window', { electronAPI: { system: { prepareNativeInput: async (): Promise<boolean> => false } } });
    const sendInputEvent = vi.fn();
    const executeJavaScript = vi.fn();
    expect(await submitPromptWithNativeClick({ executeJavaScript, sendInputEvent, loadURL: vi.fn(), getURL: (): string => '' })).toBe(false);
    expect(sendInputEvent).not.toHaveBeenCalled();
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it('waits for focus and sends exactly one ordered mouse sequence', async (): Promise<void> => {
    const events: string[] = [];
    vi.stubGlobal('window', { electronAPI: { system: { prepareNativeInput: async (): Promise<boolean> => { events.push('OS-focus'); return true; } } } });
    const sendInputEvent = vi.fn(async (event: { type: string }): Promise<void> => { await Promise.resolve(); events.push(event.type); });
    const result = await submitPromptWithNativeClick({
      focus: (): void => { events.push('guest-focus'); },
      executeJavaScript: async (): Promise<unknown> => { events.push('target'); return { ok: true, position: '20,30' }; },
      sendInputEvent, loadURL: vi.fn(), getURL: (): string => '',
    });
    expect(result).toBe(true);
    expect(events).toEqual(['OS-focus', 'guest-focus', 'target', 'mouseMove', 'mouseDown', 'mouseUp']);
    expect(sendInputEvent).toHaveBeenCalledTimes(3);
  });

  it('never falls back or sends again after a partial mouse failure', async (): Promise<void> => {
    vi.stubGlobal('window', { electronAPI: { system: { prepareNativeInput: async (): Promise<boolean> => true } } });
    const sendInputEvent = vi.fn(async (event: { type: string }): Promise<void> => { if (event.type === 'mouseDown') throw new Error('native input failed'); });
    expect(await submitPromptWithNativeClick({
      executeJavaScript: async (): Promise<unknown> => ({ ok: true, position: '20,30' }),
      sendInputEvent, loadURL: vi.fn(), getURL: (): string => '',
    })).toBe(false);
    expect(sendInputEvent.mock.calls.map((call): string => call[0].type)).toEqual(['mouseMove', 'mouseDown']);
  });
});
