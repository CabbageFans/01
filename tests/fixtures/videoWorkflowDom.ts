import { webcrypto, createHash } from 'node:crypto';
import { setImmediate as nativeSetImmediate } from 'node:timers';
import { vi, type Mock } from 'vitest';
import type { PetStoryResolvedMode } from '@doubao-studio/contracts';
import type { WebviewHandle } from '../../src/utils/doubaoBridge';
import type { NativeSubmissionReceipt } from '../../src/utils/submissionControls';

/** jsdom不能构造isTrusted；只在明确的Electron输入边界替身中交付可信事件，原生证明由独立webview脚本负责。 */
export function deliverNativeFixtureEvent(button: HTMLButtonElement, event: Parameters<NonNullable<WebviewHandle['sendInputEvent']>>[0]): void {
  if (event.type !== 'mouseDown' && event.type !== 'mouseUp') return;
  if (event.x < 0 || event.y < 0) return;
  const page = window as typeof window & { __doubaoNativeSubmissionReceipts?: Map<string, { element: HTMLElement; receipt: NativeSubmissionReceipt; onEvent: EventListener }> };
  const record = [...(page.__doubaoNativeSubmissionReceipts?.values() || [])].find((value): boolean => value.element === button && !value.receipt.cancelled && !value.receipt.activated);
  if (!record) return;
  for (const type of event.type === 'mouseDown' ? ['pointerdown', 'mousedown'] : ['pointerup', 'mouseup', 'click']) {
    record.onEvent({ type, target: button, isTrusted: true, preventDefault: (): void => {}, stopImmediatePropagation: (): void => {} } as unknown as Event);
    if (record.receipt.cancelled) return;
  }
  if (record.receipt.activated) button.click();
}

export const videoFixturePrompt = 'TEST 原镜头：角色打开门，保持原对白与起止顺序。';
export const videoFixtureUrl = 'https://www.doubao.com/chat/TEST-video-workflow';
export function geometry<T extends HTMLElement>(element: T, left = 100, top = 100, width = 600, height = 60): T {
  element.getBoundingClientRect = (): DOMRect => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: (): object => ({}) });
  Object.defineProperty(element, 'offsetParent', { configurable: true, get: (): HTMLElement => element.parentElement || document.body });
  return element;
}
export function workflowMessage(role: 'user' | 'assistant', text: string, messageId: string): HTMLElement {
  const union = document.createElement('div'); union.setAttribute('data-testid', 'union_message'); union.setAttribute('data-target-id', 'TEST-turn');
  const node = document.createElement('div'); node.setAttribute('data-testid', role === 'user' ? 'send_message' : 'receive_message'); node.setAttribute('data-message-id', messageId);
  const content = document.createElement('div'); content.setAttribute('data-testid', 'message_text_content'); content.textContent = text; node.append(content); union.append(node); document.body.append(union); return node;
}
export function workflowCard(parent: HTMLElement, vid: string, url: string): void {
  const card = document.createElement('div') as HTMLElement & { __reactProps$TEST?: object }; card.className = 'block-video-TEST';
  card.__reactProps$TEST = { video: { vid, original_media_info: { main_url: url } } }; parent.append(card);
}
export function videoWorkflowFixture(mode: PetStoryResolvedMode, configured = false): {
  view: WebviewHandle & { executeJavaScript: ReturnType<typeof vi.fn>; sendInputEvent: Mock<NonNullable<WebviewHandle['sendInputEvent']>> }; root: HTMLElement; editor: HTMLTextAreaElement; send: HTMLButtonElement; parameterClicks: ReturnType<typeof vi.fn>; finalClicks: ReturnType<typeof vi.fn>; uploadedNames: string[];
  files: { name: string; base64: string; mime: string }[]; hashes: string[]; setAckLost: () => void;
} {
  vi.stubGlobal('crypto', webcrypto);
  const root = geometry(document.createElement('div'), 70, 100, 700, 380); root.className = 'guidance-input-surface'; root.id = 'input-engine-container'; document.body.append(root);
  const skill = geometry(document.createElement('button'), 100, 110, 100, 35); skill.setAttribute('data-testid', 'skill_input_exit_button'); skill.textContent = '视频生成'; root.append(skill);
  const editor = geometry(document.createElement('textarea'), 100, 160, 550, 110); editor.value = videoFixturePrompt; root.append(editor);
  const model = geometry(document.createElement('button'), 100, 430, 180, 35); model.setAttribute('data-input-engine-actionbar-control-key', 'video-model'); model.textContent = '模型 Seedance 2.0'; root.append(model);
  const trigger = geometry(document.createElement('button'), 300, 430, 180, 35); trigger.setAttribute('data-creation-params-panel-id', 'TEST-params'); trigger.setAttribute('aria-controls', 'TEST-popup'); root.append(trigger);
  const popup = geometry(document.createElement('div'), 300, 480, 300, 200); popup.id = 'TEST-popup'; popup.setAttribute('role', 'menu'); popup.style.display = 'none'; popup.style.position = 'fixed'; document.body.append(popup);
  let ratio = configured ? '9:16' : '自动';
  const slider = geometry(document.createElement('input'), 330, 590, 240, 30); slider.type = 'range'; slider.min = '4'; slider.max = '15'; slider.step = '1'; slider.value = configured ? '5' : '10';
  const render = (): void => { trigger.textContent = `${ratio} · ${slider.value}s`; }; render(); slider.addEventListener('input', render);
  const auto = geometry(document.createElement('button'), 330, 490, 240, 35); auto.textContent = '自动';
  const vertical = geometry(document.createElement('button'), 330, 535, 240, 35); vertical.textContent = '9:16'; vertical.addEventListener('pointerdown', (): void => { ratio = '9:16'; render(); }); popup.append(auto, vertical, slider);
  const parameterClicks = vi.fn(); trigger.addEventListener('pointerdown', (): void => { parameterClicks(); popup.style.display = popup.style.display === 'none' ? 'block' : 'none'; });
  const uploadedNames: string[] = [];
  const labels = mode === 'reference' ? [''] : mode === 'first_frame' ? ['首帧'] : ['首帧', '尾帧'];
  for (const [index, label] of labels.entries()) {
    const slot = geometry(document.createElement('div'), 100 + index * 200, 315, 180, 100); if (label) slot.setAttribute('aria-label', label);
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = mode === 'reference'; input.style.display = 'none'; slot.append(input); root.append(slot);
    input.addEventListener('change', (): void => { for (const file of Array.from(input.files || [])) {
      uploadedNames.push(file.name); const card = geometry(document.createElement('div'), 110 + index * 200, 320, 100, 80); card.setAttribute('data-testid', 'attachment-image-card'); card.setAttribute('data-kind', 'image');
      const image = geometry(document.createElement('img'), 110 + index * 200, 320, 100, 80); image.src = `blob:TEST-${file.name}`;
      Object.defineProperties(image, { complete: { get: (): boolean => true }, naturalWidth: { get: (): number => 256 }, naturalHeight: { get: (): number => 256 } }); card.append(image); slot.append(card);
    } });
  }
  const send = geometry(document.createElement('button'), 620, 280, 40, 40); send.id = 'flow-end-msg-send'; send.setAttribute('aria-label', '发送'); const finalClicks = vi.fn(); send.addEventListener('click', finalClicks); root.append(send);
  vi.spyOn(document, 'elementFromPoint').mockImplementation((x: number, y: number): Element | null => Array.from(document.querySelectorAll<HTMLElement>('*')).filter((element): boolean => {
    const rect = element.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0 || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) if (getComputedStyle(node).display === 'none') return false; return true;
  }).at(-1) || null);
  let ackLost = false;
  const view = { executeJavaScript: vi.fn(async (code: string): Promise<unknown> => {
    const value = await window.eval(code) as unknown;
    if (ackLost && value && typeof value === 'object' && 'dispatched' in value && value.dispatched === true) { ackLost = false; throw new Error('TEST final activation ACK lost'); }
    return value;
  }), getURL: (): string => videoFixtureUrl, loadURL: vi.fn(), sendInputEvent: vi.fn<NonNullable<WebviewHandle['sendInputEvent']>>((event): void => deliverNativeFixtureEvent(send, event)), isConnected: true };
  const count = mode === 'first_frame' ? 1 : 2;
  const files = Array.from({ length: count }, (_, index): { name: string; base64: string; mime: string } => ({ name: `TEST-reference-${index + 1}.png`, mime: 'image/png', base64: Buffer.from(`TEST fixture image ${index + 1}`).toString('base64') }));
  const hashes = files.map((file): string => createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex'));
  return { view, root, editor, send, parameterClicks, finalClicks, uploadedNames, files, hashes, setAckLost: (): void => { ackLost = true; } };
}
export async function settleVideoFixture<T>(work: Promise<T>, budget = 12_000): Promise<T> {
  let outcome: { value: T } | { error: unknown } | undefined;
  void work.then((value): void => { outcome = { value }; }, (error: unknown): void => { outcome = { error }; });
  for (let waited = 0; waited < budget && !outcome; waited += 100) { await new Promise<void>((resolve): void => { nativeSetImmediate(resolve); }); await vi.advanceTimersByTimeAsync(100); }
  if (!outcome) throw new Error('TEST fixture stage did not settle within budget');
  if ('error' in outcome) throw outcome.error; return outcome.value;
}
