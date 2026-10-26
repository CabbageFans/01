/** 离线序列化探针回归，不点击真实页面。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { findSendButtonTarget, prepareNativeSubmission, submitPromptWithNativeClick } from '../../src/utils/doubaoBridge';
import type { WebviewHandle } from '../../src/utils/doubaoBridge';

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, right: left + width, bottom: top + height, width, height });
class ProbeNode {
  parentElement: ProbeNode | null = null;
  children: ProbeNode[] = [];
  offsetParent: object | null = {};
  disabled = false;
  innerText = '';
  id = '';
  attributes: Record<string, string> = {};
  moving = false;
  failEvent = '';
  focusAction: () => void = (): void => undefined;
  constructor(public tagName: string, public bounds: Rect, readonly events: string[]) {}
  getBoundingClientRect(): Rect { if (this.moving) this.bounds = rect(this.bounds.left + 3, this.bounds.top, this.bounds.width, this.bounds.height); return this.bounds; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  contains(node: unknown): boolean { return node === this || this.children.some((child): boolean => child.contains(node)); }
  querySelectorAll(): ProbeNode[] { return this.children.flatMap((child): ProbeNode[] => [child, ...child.querySelectorAll()]); }
  matches(): boolean { return this.tagName === 'BUTTON' || !!this.attributes['data-testid']; }
  focus(): void { this.focusAction(); }
  dispatchEvent(event: { type: string }): boolean { this.events.push(event.type); if (event.type === this.failEvent) throw new Error('TEST partial event'); return true; }
}
class ProbeEvent { constructor(readonly type: string, readonly options: unknown) {} }
interface ProbeOptions { exact?: boolean; icon?: boolean; occluded?: boolean; outside?: boolean; focused?: boolean; moving?: boolean; hostOutside?: boolean }
function fixture(options: ProbeOptions = {}): { webview: WebviewHandle; native: ReturnType<typeof vi.fn>; events: string[]; button: ProbeNode; setOccluded: (value: boolean) => void } {
  const events: string[] = []; let occluded = !!options.occluded;
  const body = new ProbeNode('BODY', rect(0, 0, 800, 600), events);
  const root = new ProbeNode('DIV', rect(30, 60, 400, 250), events); root.parentElement = body;
  const editor = new ProbeNode('DIV', rect(50, 90, 300, 110), events); editor.parentElement = root;
  const button = new ProbeNode('BUTTON', rect(310, options.outside ? 700 : 210, 40, 40), events); button.parentElement = root; button.id = options.exact === false ? '' : 'flow-end-msg-send'; button.moving = !!options.moving;
  const icon = new ProbeNode('SPAN', rect(320, 220, 20, 20), events); icon.parentElement = button; icon.attributes['data-testid'] = 'TEST-send-icon'; button.children = [icon]; root.children = [editor, button];
  const overlay = new ProbeNode('DIV', rect(0, 0, 800, 600), events);
  let active: ProbeNode = editor; editor.focusAction = (): void => { active = editor; };
  const doc = { body, documentElement: body, get activeElement(): ProbeNode { return active; }, hasFocus: (): boolean => options.focused !== false,
    querySelector: (): ProbeNode | null => options.exact === false ? null : button,
    querySelectorAll: (): ProbeNode[] => [editor], elementFromPoint: (): ProbeNode => occluded ? overlay : options.icon ? icon : button };
  const pageWindow = { innerWidth: 800, innerHeight: 600, getComputedStyle: (): object => ({ visibility: 'visible', display: 'block', pointerEvents: 'auto', opacity: '1', backgroundColor: 'rgb(20, 30, 180)' }) };
  const native = vi.fn(async (): Promise<void> => undefined);
  const webview: WebviewHandle = { focus: vi.fn(), isConnected: true, getBoundingClientRect: (): Rect => rect(options.hostOutside ? 2000 : 100, 80, 800, 600),
    executeJavaScript: vi.fn(async (code: string): Promise<unknown> => runInNewContext(code, { document: doc, window: pageWindow, requestAnimationFrame: (callback: (at: number) => void): number => { callback(0); return 1; }, PointerEvent: ProbeEvent, MouseEvent: ProbeEvent })),
    sendInputEvent: native, loadURL: vi.fn(), getURL: (): string => '' };
  vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 800, electronAPI: { system: { prepareNativeInput: async (): Promise<boolean> => true } } });
  vi.stubGlobal('document', { elementFromPoint: (): WebviewHandle => webview });
  return { webview, native, events, button, setOccluded: (value: boolean): void => { occluded = value; } };
}

describe('single verified submission requires focus and a stable visible composer', (): void => {
  afterEach((): void => { vi.unstubAllGlobals(); });
  it('does not probe or dispatch if OS focus cannot be confirmed', async (): Promise<void> => {
    const test = fixture(); vi.stubGlobal('window', { electronAPI: { system: { prepareNativeInput: async (): Promise<boolean> => false } } });
    expect(await submitPromptWithNativeClick(test.webview, 'guest')).toBe(false); expect(test.webview.executeJavaScript).not.toHaveBeenCalled(); expect(test.native).not.toHaveBeenCalled(); expect(test.events).toEqual([]);
  });
  it.each([{ focused: false }, { hostOutside: true }, { outside: true }, { occluded: true }, { moving: true }])('fails before dispatch for non-ready focus/host/viewport/hit/geometry %j', async (options): Promise<void> => {
    const test = fixture(options); expect((await prepareNativeSubmission(test.webview)).ok).toBe(false); expect(test.native).not.toHaveBeenCalled(); expect(test.events).toEqual([]);
  });
  it('prepares two stable frames without any submission event', async (): Promise<void> => {
    const test = fixture({ icon: true }); expect(await prepareNativeSubmission(test.webview)).toMatchObject({ ok: true, method: 'exact-id', focused: true, geometry: '310,210,40,40,800,600' });
    expect(test.native).not.toHaveBeenCalled(); expect(test.events).toEqual([]);
  });
  it('uses the actual serialized accent regex and accepts a verified child-icon hit', async (): Promise<void> => {
    const test = fixture({ exact: false, icon: true }); expect(await findSendButtonTarget(test.webview)).toMatchObject({ ok: true, method: 'composer-accent' });
    expect(await submitPromptWithNativeClick(test.webview, 'guest')).toBe(true); expect(test.events).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']); expect(test.native).not.toHaveBeenCalled();
  });
  it('dispatches exactly one guest sequence to the authoritative button even when its child has data-testid', async (): Promise<void> => {
    const test = fixture({ icon: true }); expect(await submitPromptWithNativeClick(test.webview, 'guest')).toBe(true);
    expect(test.events).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']); expect(test.native).not.toHaveBeenCalled();
  });
  it('sends one ordered native sequence for the separately selected media strategy', async (): Promise<void> => {
    const test = fixture(); expect(await submitPromptWithNativeClick(test.webview, 'native')).toBe(true);
    expect(test.native.mock.calls.map((call): string => (call[0] as { type: string }).type)).toEqual(['mouseMove', 'mouseDown', 'mouseUp']); expect(test.events).toEqual([]);
  });
  it('rechecks hit ownership immediately before guest dispatch and never falls back', async (): Promise<void> => {
    const test = fixture(); const execute = test.webview.executeJavaScript;
    test.webview.executeJavaScript = async (code: string): Promise<unknown> => { if (code.includes('var expectedGeometry')) test.setOccluded(true); return execute(code); };
    expect(await submitPromptWithNativeClick(test.webview, 'guest')).toBe(false); expect(test.events).toEqual([]); expect(test.native).not.toHaveBeenCalled();
  });
  it('never tries another transport or another click after partial guest dispatch', async (): Promise<void> => {
    const test = fixture(); test.button.failEvent = 'mousedown'; expect(await submitPromptWithNativeClick(test.webview, 'guest')).toBe(false);
    expect(test.events).toEqual(['pointerdown', 'mousedown']); expect(test.native).not.toHaveBeenCalled();
  });
  it('never continues or retries after a partial native sequence', async (): Promise<void> => {
    const test = fixture(); test.native.mockImplementation(async (event: unknown): Promise<void> => { if ((event as { type: string }).type === 'mouseDown') throw new Error('TEST native input failed'); });
    expect(await submitPromptWithNativeClick(test.webview)).toBe(false); expect(test.native.mock.calls.map((call): string => (call[0] as { type: string }).type)).toEqual(['mouseMove', 'mouseDown']); expect(test.events).toEqual([]);
  });
});
