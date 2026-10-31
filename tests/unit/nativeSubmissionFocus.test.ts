/** 离线执行真实序列化提交探针；不打开网页、不产生平台请求。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import { findSendButtonTarget, preparePageSubmission, submitPromptOnce, verifyPromptReadyForSubmission } from '../../src/utils/doubaoBridge';
import type { SubmissionDispatchSafety, WebviewHandle } from '../../src/utils/doubaoBridge';
import { HumanVerificationRequiredError } from '../../src/utils/humanVerification';

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, right: left + width, bottom: top + height, width, height });
const offlinePrompt = 'OFFLINE：只验证原输入与发送控件。';
class ProbeNode {
  parentElement: ProbeNode | null = null;
  children: ProbeNode[] = [];
  offsetParent: object | null = {};
  disabled = false;
  isConnected = true;
  innerText = '';
  id = '';
  attributes: Record<string, string> = {};
  moving = false;
  failClick = false;
  message = false;
  readonly focus = vi.fn();
  readonly dispatchEvent = vi.fn();
  constructor(public tagName: string, public bounds: Rect, readonly events: string[]) {}
  get textContent(): string { return this.innerText; }
  getBoundingClientRect(): Rect { if (this.moving) this.bounds = rect(this.bounds.left + 3, this.bounds.top, this.bounds.width, this.bounds.height); return this.bounds; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  hasAttribute(name: string): boolean { return Object.hasOwn(this.attributes, name); }
  contains(node: unknown): boolean { return node === this || this.children.some((child): boolean => child.contains(node)); }
  closest(): ProbeNode | null { return this.message ? this : null; }
  querySelectorAll(): ProbeNode[] { return this.children.flatMap((child): ProbeNode[] => [child, ...child.querySelectorAll()]); }
  querySelector(): null { return null; }
  click(): void { this.events.push('click'); if (this.failClick) throw new Error('OFFLINE click delivery uncertain'); }
}
interface ProbeOptions { exact?: boolean; icon?: boolean; occluded?: boolean; outside?: boolean; focused?: boolean; moving?: boolean; hostOutside?: boolean; hostButtonOccluded?: boolean; parked?: boolean; inert?: boolean; duplicateEditor?: boolean; verification?: boolean; hiddenVerification?: boolean; messageVerification?: boolean }
interface ProbeFixture {
  webview: WebviewHandle; native: ReturnType<typeof vi.fn>; prepareNativeInput: ReturnType<typeof vi.fn>;
  hostHit: ReturnType<typeof vi.fn>; hasFocus: ReturnType<typeof vi.fn>; events: string[]; editor: ProbeNode; button: ProbeNode;
  setOccluded: (value: boolean) => void; setHostBounds: (value: Rect) => void; setFocused: (value: boolean) => void;
  setVerification: (value: boolean) => void;
}
function fixture(options: ProbeOptions = {}): ProbeFixture {
  const events: string[] = []; let occluded = !!options.occluded; let focused = options.focused !== false;
  let hostBounds = rect(options.hostOutside ? 2000 : 100, 80, 800, 600);
  const body = new ProbeNode('BODY', rect(0, 0, 800, 600), events);
  const root = new ProbeNode('DIV', rect(30, 60, 400, 250), events); root.parentElement = body; body.children = [root];
  const editor = new ProbeNode('DIV', rect(50, 90, 300, 110), events); editor.parentElement = root; editor.innerText = offlinePrompt;
  const button = new ProbeNode('BUTTON', rect(310, options.outside ? 700 : 210, 40, 40), events); button.parentElement = root;
  button.id = options.exact === false ? '' : 'flow-end-msg-send'; button.moving = !!options.moving;
  const icon = new ProbeNode('SPAN', rect(320, 220, 20, 20), events); icon.parentElement = button; icon.attributes['data-testid'] = 'OFFLINE-send-icon';
  button.children = [icon]; root.children = [editor, button];
  const secondEditor = new ProbeNode('DIV', rect(50, 350, 300, 110), events); secondEditor.innerText = offlinePrompt; secondEditor.parentElement = root;
  const editors = options.duplicateEditor ? [editor, secondEditor] : [editor];
  const overlay = new ProbeNode('DIV', rect(0, 0, 800, 600), events); const hasFocus = vi.fn((): boolean => focused);
  let verificationVisible = !!options.verification;
  const verification = new ProbeNode('DIV', rect(40, 40, 400, 250), events); verification.parentElement = body; verification.innerText = '人机验证';
  if (options.hiddenVerification) verification.attributes['aria-hidden'] = 'true';
  verification.message = !!options.messageVerification;
  const doc = {
    body, documentElement: body, activeElement: overlay, hasFocus,
    querySelectorAll: (selector: string): ProbeNode[] => selector === '#flow-end-msg-send' ? options.exact === false ? [] : [button]
      : selector.includes('textarea') || selector.includes('contenteditable') ? editors : selector.startsWith('[role="dialog"]') && verificationVisible ? [verification] : [],
    elementFromPoint: (): ProbeNode => occluded ? overlay : options.icon ? icon : button,
  };
  const pageWindow = { innerWidth: 800, innerHeight: 600, getComputedStyle: (): object => ({ visibility: 'visible', display: 'block', pointerEvents: 'auto', opacity: '1', backgroundColor: 'rgb(20, 30, 180)' }) };
  // 同一个 guest 上下文保留页内 dispatchKey 集合，避免每次请求重建全局状态。
  const context = createContext({ document: doc, window: pageWindow, Date, Set });
  const native = vi.fn(async (): Promise<void> => undefined);
  const webview: WebviewHandle = { focus: vi.fn(), isConnected: true, getBoundingClientRect: vi.fn((): Rect => hostBounds),
    closest: vi.fn((): Element | null => options.parked ? { hasAttribute: (name: string): boolean => name === 'inert' && !!options.inert } as unknown as Element : null),
    executeJavaScript: vi.fn(async (code: string): Promise<unknown> => runInContext(code, context)), sendInputEvent: native, loadURL: vi.fn(), getURL: (): string => '' };
  const prepareNativeInput = vi.fn(async (): Promise<boolean> => false);
  const hostHit = vi.fn((): ProbeNode | WebviewHandle => options.hostButtonOccluded ? overlay : webview);
  vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 800, electronAPI: { system: { prepareNativeInput } } });
  vi.stubGlobal('document', { elementFromPoint: hostHit });
  return { webview, native, prepareNativeInput, hostHit, hasFocus, events, editor, button,
    setOccluded: (value: boolean): void => { occluded = value; }, setHostBounds: (value: Rect): void => { hostBounds = value; }, setFocused: (value: boolean): void => { focused = value; },
    setVerification: (value: boolean): void => { verificationVisible = value; } };
}
function safety(expectedPrompt: string = offlinePrompt): { guard: SubmissionDispatchSafety; controller: AbortController; isCurrent: ReturnType<typeof vi.fn>; verifyLease: ReturnType<typeof vi.fn> } {
  const controller = new AbortController(); const isCurrent = vi.fn((): boolean => true); const verifyLease = vi.fn(async (): Promise<boolean> => true);
  return { controller, isCurrent, verifyLease, guard: { signal: controller.signal, deadlineAt: Date.now() + 10_000, isCurrent, verifyLease,
    dispatchKey: 'OFFLINE-task:OFFLINE-run:OFFLINE-intent', expectedPrompt, strictParagraphs: true } };
}
async function settled<T>(pending: Promise<T>): Promise<T> { await vi.advanceTimersByTimeAsync(500); return pending; }
function expectNoHostInput(test: ProbeFixture): void {
  expect(test.native).not.toHaveBeenCalled(); expect(test.prepareNativeInput).not.toHaveBeenCalled(); expect(test.hostHit).not.toHaveBeenCalled();
  expect(test.webview.focus).not.toHaveBeenCalled(); expect(test.editor.focus).not.toHaveBeenCalled(); expect(test.button.dispatchEvent).not.toHaveBeenCalled(); expect(test.hasFocus).not.toHaveBeenCalled();
}

describe('单次页内提交与系统鼠标、窗口焦点无关', (): void => {
  beforeEach((): void => { vi.useFakeTimers(); });
  afterEach((): void => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('真实可见验证在prepare中有独立原因，且发送器不激活控件', async (): Promise<void> => {
    const test = fixture({ verification: true });
    expect(await preparePageSubmission(test.webview)).toMatchObject({ ok: false, humanVerification: true });
    await expect(submitPromptOnce(test.webview, safety().guard)).rejects.toBeInstanceOf(HumanVerificationRequiredError);
    expect(test.events).toEqual([]); expectNoHostInput(test);
  });
  it('租约回读期间才出现验证，guest最后同步检查仍阻止click并保留验证原因', async (): Promise<void> => {
    const test = fixture(); const attempt = safety();
    attempt.verifyLease.mockImplementation(async (): Promise<boolean> => { test.setVerification(true); return true; });
    const pending = submitPromptOnce(test.webview, attempt.guard).catch((error: unknown): unknown => error);
    expect(await settled(pending)).toBeInstanceOf(HumanVerificationRequiredError); expect(test.events).toEqual([]); expectNoHostInput(test);
  });
  it.each([{ hiddenVerification: true }, { messageVerification: true }])('隐藏或消息正文验证文字不阻断单次发送%j', async (options): Promise<void> => {
    const test = fixture({ verification: true, ...options }); expect(await settled(submitPromptOnce(test.webview, safety().guard))).toBe(true);
    expect(test.events).toEqual(['click']); expectNoHostInput(test);
  });
  it.each([{ focused: false }, { hostOutside: true }, { hostButtonOccluded: true }, { hostOutside: true, parked: true, inert: true }])('用户切换工具或宿主不可命中仍只提交一次 %j', async (options): Promise<void> => {
    const test = fixture(options); expect(await settled(submitPromptOnce(test.webview, safety().guard))).toBe(true);
    expect(test.events).toEqual(['click']); expectNoHostInput(test);
  });
  it('只读准备连续两次稳定页面快照，不改变焦点或正文', async (): Promise<void> => {
    const test = fixture({ icon: true, focused: false });
    expect(await settled(preparePageSubmission(test.webview))).toMatchObject({ ok: true, method: 'exact-id', geometry: '310,210,40,40,800,600' });
    expect(test.events).toEqual([]); expect(test.editor.innerText).toBe(offlinePrompt); expectNoHostInput(test);
  });
  it.each([{ outside: true }, { occluded: true }, { moving: true }, { duplicateEditor: true }])('页面内按钮或编辑器失稳时在点击前停止 %j', async (options): Promise<void> => {
    const test = fixture(options); expect((await settled(preparePageSubmission(test.webview))).ok).toBe(false);
    expect(await settled(submitPromptOnce(test.webview, safety().guard))).toBe(false); expect(test.events).toEqual([]); expectNoHostInput(test);
  });
  it('精确多段正文和部分可见输入区无需焦点即可准备，丢段后禁止发送', async (): Promise<void> => {
    const test = fixture(); const prompt = 'OFFLINE 第一段。\n\n第二段“台词”。'; test.editor.innerText = prompt; test.editor.bounds = rect(50, -20, 300, 110);
    expect(await verifyPromptReadyForSubmission(test.webview, prompt, true)).toBe(true); expect((await settled(preparePageSubmission(test.webview))).ok).toBe(true);
    test.editor.innerText = prompt.replace(/\n+/g, ' '); expect(await settled(submitPromptOnce(test.webview, safety(prompt).guard))).toBe(false);
    expect(test.events).toEqual([]); expectNoHostInput(test);
  });
  it('输入摘要不向宿主返回正文', async (): Promise<void> => {
    const test = fixture(); const target = await settled(preparePageSubmission(test.webview));
    expect(target.ok).toBe(true); expect(target.inputHash).toBeTypeOf('string'); expect(JSON.stringify(target)).not.toContain(offlinePrompt); expectNoHostInput(test);
  });
  it('支持真实序列化的主色按钮定位与子图标回读', async (): Promise<void> => {
    const test = fixture({ exact: false, icon: true }); expect(await findSendButtonTarget(test.webview)).toMatchObject({ ok: true, method: 'composer-accent' });
    expect(await settled(submitPromptOnce(test.webview, safety().guard))).toBe(true); expect(test.events).toEqual(['click']); expectNoHostInput(test);
  });
  it('后台操作授权与窗口位置、parked 样式无关，仍核对当前任务及租约', async (): Promise<void> => {
    const test = fixture({ hostOutside: true, focused: false }); const attempt = safety();
    expect(await settled(submitPromptOnce(test.webview, attempt.guard, { taskId: 'OFFLINE-image-operation', isCurrent: (): boolean => true }))).toBe(true);
    expect(attempt.verifyLease).toHaveBeenCalledOnce(); expect(test.events).toEqual(['click']); expectNoHostInput(test);
  });
  it('后台授权在租约回读时撤销则不提交', async (): Promise<void> => {
    const test = fixture(); const attempt = safety(); let current = true;
    attempt.verifyLease.mockImplementation(async (): Promise<boolean> => { current = false; return true; });
    expect(await settled(submitPromptOnce(test.webview, attempt.guard, { taskId: 'OFFLINE-image-operation', isCurrent: (): boolean => current }))).toBe(false);
    expect(test.events).toEqual([]); expectNoHostInput(test);
  });
  it.each(['host-move', 'focus-lost'] as const)('等待租约期间 %s 不影响原页面单次提交', async (change): Promise<void> => {
    const test = fixture(); const attempt = safety(); let releaseLease: (value: boolean) => void = (): void => {};
    attempt.verifyLease.mockImplementation((): Promise<boolean> => new Promise((resolve): void => { releaseLease = resolve; }));
    const pending = submitPromptOnce(test.webview, attempt.guard); await vi.advanceTimersByTimeAsync(500); expect(attempt.verifyLease).toHaveBeenCalledOnce();
    if (change === 'host-move') test.setHostBounds(rect(2300, 80, 800, 600)); if (change === 'focus-lost') test.setFocused(false);
    releaseLease(true); expect(await settled(pending)).toBe(true); expect(test.events).toEqual(['click']); expectNoHostInput(test);
  });
  it.each(['button-move', 'guest-occluded', 'disabled', 'prompt-change'] as const)('租约回读后 %s 会在最终页内点击前停止', async (change): Promise<void> => {
    const test = fixture(); const attempt = safety(); let releaseLease: (value: boolean) => void = (): void => {};
    attempt.verifyLease.mockImplementation((): Promise<boolean> => new Promise((resolve): void => { releaseLease = resolve; }));
    const pending = submitPromptOnce(test.webview, attempt.guard); await vi.advanceTimersByTimeAsync(500); expect(attempt.verifyLease).toHaveBeenCalledOnce();
    if (change === 'button-move') test.button.bounds = rect(315, 210, 40, 40); if (change === 'guest-occluded') test.setOccluded(true);
    if (change === 'disabled') test.button.disabled = true; if (change === 'prompt-change') test.editor.innerText += 'OFFLINE 已改变';
    releaseLease(true); expect(await settled(pending)).toBe(false); expect(test.events).toEqual([]); expectNoHostInput(test);
  });
  it('同一已持久化提交标识重复调用也只点击一次', async (): Promise<void> => {
    const test = fixture(); const attempt = safety(); expect(await settled(submitPromptOnce(test.webview, attempt.guard))).toBe(true);
    expect(await settled(submitPromptOnce(test.webview, attempt.guard))).toBe(false); expect(test.events).toEqual(['click']); expectNoHostInput(test);
  });
  it('控件激活抛异常后不回退，并消费该提交标识以防补点', async (): Promise<void> => {
    const test = fixture(); test.button.failClick = true; const attempt = safety(); expect(await settled(submitPromptOnce(test.webview, attempt.guard))).toBe(false);
    test.button.failClick = false; expect(await settled(submitPromptOnce(test.webview, attempt.guard))).toBe(false); expect(test.events).toEqual(['click']); expectNoHostInput(test);
  });
  it.each(['abort', 'expired', 'old-run'] as const)('初始 %s 时不执行页面探针或提交', async (reason): Promise<void> => {
    const test = fixture(); const attempt = safety(); if (reason === 'abort') attempt.controller.abort();
    if (reason === 'expired') attempt.guard.deadlineAt = Date.now() - 1; if (reason === 'old-run') attempt.isCurrent.mockReturnValue(false);
    expect(await settled(submitPromptOnce(test.webview, attempt.guard))).toBe(false); expect(test.webview.executeJavaScript).not.toHaveBeenCalled();
    expect(attempt.verifyLease).not.toHaveBeenCalled(); expect(test.events).toEqual([]); expectNoHostInput(test);
  });
  it.each(['abort', 'expired', 'old-run'] as const)('异步页面准备期间 %s 后不继续发送', async (reason): Promise<void> => {
    const test = fixture(); const attempt = safety(); const execute = test.webview.executeJavaScript; let releaseProbe: (() => void) | undefined;
    test.webview.executeJavaScript = (code: string): Promise<unknown> => new Promise((resolve): void => { releaseProbe = (): void => { void execute(code).then(resolve); }; });
    const pending = submitPromptOnce(test.webview, attempt.guard);
    if (reason === 'abort') attempt.controller.abort(); if (reason === 'expired') attempt.guard.deadlineAt = Date.now() - 1; if (reason === 'old-run') attempt.isCurrent.mockReturnValue(false);
    releaseProbe!(); expect(await settled(pending)).toBe(false); expect(attempt.verifyLease).not.toHaveBeenCalled(); expect(test.events).toEqual([]); expectNoHostInput(test);
  });
  it.each(['abort', 'expired', 'old-run', 'lost-lease'] as const)('最终租约完成后重核 %s 并阻止任何点击', async (reason): Promise<void> => {
    const test = fixture(); const attempt = safety(); let finishLease: (value: boolean) => void = (): void => {};
    attempt.verifyLease.mockImplementation((): Promise<boolean> => new Promise((resolve): void => { finishLease = resolve; }));
    const pending = submitPromptOnce(test.webview, attempt.guard); await vi.advanceTimersByTimeAsync(500); expect(attempt.verifyLease).toHaveBeenCalledOnce();
    if (reason === 'abort') attempt.controller.abort(); if (reason === 'expired') attempt.guard.deadlineAt = Date.now() - 1; if (reason === 'old-run') attempt.isCurrent.mockReturnValue(false);
    finishLease(reason !== 'lost-lease'); expect(await settled(pending)).toBe(false); expect(test.events).toEqual([]); expectNoHostInput(test);
  });
  it('最终派发脚本迟到执行时由 guest 自身截止检查阻止点击', async (): Promise<void> => {
    const test = fixture(); const attempt = safety(); const execute = test.webview.executeJavaScript; let runDispatch: (() => void) | undefined;
    attempt.guard.deadlineAt = Date.now() + 2_000;
    test.webview.executeJavaScript = (code: string): Promise<unknown> => code.includes('"dispatchKey":')
      ? new Promise((resolve): void => { runDispatch = (): void => { void execute(code).then(resolve); }; }) : execute(code);
    const pending = submitPromptOnce(test.webview, attempt.guard); await vi.advanceTimersByTimeAsync(500);
    expect(attempt.verifyLease).toHaveBeenCalledOnce(); expect(runDispatch).toBeTypeOf('function');
    // 仍早于 executeJavaScript 的 5 秒超时，直接验证 guest 内过期判定。
    await vi.advanceTimersByTimeAsync(2_001); runDispatch!();
    expect(await settled(pending)).toBe(false); expect(test.events).toEqual([]); expectNoHostInput(test);
  });
  it('宿主执行超时后排队脚本失去激活权限，即使原运行截止尚未到达', async (): Promise<void> => {
    const test = fixture(); const attempt = safety(); const execute = test.webview.executeJavaScript; let runDispatch: (() => void) | undefined;
    test.webview.executeJavaScript = (code: string): Promise<unknown> => code.includes('"dispatchKey":')
      ? new Promise((resolve): void => { runDispatch = (): void => { void execute(code).then(resolve); }; }) : execute(code);
    const pending = submitPromptOnce(test.webview, attempt.guard); await vi.advanceTimersByTimeAsync(100);
    expect(runDispatch).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toBe(false); expect(attempt.guard.deadlineAt).toBeGreaterThan(Date.now());
    runDispatch!(); await Promise.resolve();
    expect(test.events).toEqual([]); expectNoHostInput(test);
  });
});
