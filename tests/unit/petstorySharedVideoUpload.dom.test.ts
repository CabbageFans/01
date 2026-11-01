/** 现场统一 multiple 上传入口的序列化 DOM 集成回归；只有 TEST 文件，不连接平台、不发送。 */
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryCompiledPrompt, PetStoryExecutionGuard, PetStoryPageBinding } from '@doubao-studio/contracts';
import {
  bindPetStoryReferences,
  checkPetStoryPageGuard,
  readPetStoryComposer,
  uploadPetStoryImages,
  verifyPetStoryReferenceBindings,
  verifyPetStoryUploads,
  waitForPetStoryVideoComposer,
} from '../../src/utils/doubaoBridge';
import type { PetStoryUploadReceipt, WebviewHandle } from '../../src/utils/doubaoBridge';

const files = ['first', 'last'].map((role: string): { name: string; base64: string; mime: string } => ({
  name: `TEST-${role}.png`, base64: Buffer.from(`TEST-${role}-bytes`).toString('base64'), mime: 'image/png',
}));
const hashes = files.map((file): string => createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex'));

function compiledPrompt(final = '首帧从已采用起始画面出发，尾帧作为目标结尾；固定机位完成动作。'): PetStoryCompiledPrompt {
  return {
    text: `第 1 张图作为首帧画面。\n第 2 张图作为尾帧目标。\n${final}`,
    final, kind: 'video', rulesVersion: 'TEST-current-shared-upload', requestedMode: 'first_last_frame', resolvedMode: 'first_last_frame',
    references: [
      { assetId: 'TEST-first-asset', order: 1, slot: 'first', characterIds: [], purpose: 'firstFrame' },
      { assetId: 'TEST-last-asset', order: 2, slot: 'last', characterIds: [], purpose: 'plannedEndImage' },
    ],
    segments: [{ referenceOrder: 1 }, { text: '作为首帧画面。\n' }, { referenceOrder: 2 }, { text: `作为尾帧目标。\n${final}` }],
  };
}

function guard(compiled = compiledPrompt()): PetStoryExecutionGuard {
  const entry = { state: 'supported' as const, reason: 'TEST 真实控件执行时读取' };
  return {
    mode: 'first_last_frame', durationSeconds: 5, attachmentAssetIds: ['TEST-first-asset', 'TEST-last-asset'],
    references: compiled.references, compiledPrompt: compiled, fileSha256s: hashes,
    capability: { accountId: 'TEST-account', checkedAt: '2026-11-01T00:00:00.000Z', image: entry,
      modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [5],
      videoConfig: { model: 'seedance-2.0-fast', aspectRatio: '9:16', duration: '5s' } },
  };
}

function sized<T extends HTMLElement>(element: T): T {
  element.getBoundingClientRect = (): DOMRect => ({ x: 10, y: 10, top: 10, left: 10, right: 610, bottom: 210, width: 600, height: 200, toJSON: (): object => ({}) });
  return element;
}

interface SharedComposerFixture {
  view: WebviewHandle & { executeJavaScript: ReturnType<typeof vi.fn>; sendInputEvent: ReturnType<typeof vi.fn>; loadURL: ReturnType<typeof vi.fn> };
  root: HTMLDivElement;
  input: HTMLInputElement;
  editor: HTMLTextAreaElement;
  changed: string[][];
  changeReadbacks: { count: number; decodedCount: number; pending: boolean }[];
  controlClick: ReturnType<typeof vi.fn>;
  addCard: (fileName: string) => HTMLElement;
}

function fixture(): SharedComposerFixture {
  const root = sized(document.createElement('div')); root.className = 'guidance-input-surface'; document.body.append(root);
  const editor = sized(document.createElement('textarea')); root.append(editor);
  Object.defineProperty(editor, 'offsetParent', { configurable: true, get: (): HTMLElement => root });
  const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
  input.accept = '.jpg,.png,.jpeg,.webp,.apng,.mp4,.mov'; input.style.display = 'none'; root.append(input);
  const controlClick = vi.fn();
  const parameters = sized(document.createElement('button')); parameters.setAttribute('data-input-engine-actionbar-render-entry-key', 'video-generation-params-panel'); parameters.textContent = '9:16 · 5s'; parameters.addEventListener('click', controlClick); root.append(parameters);
  const model = sized(document.createElement('button')); model.setAttribute('data-input-engine-actionbar-control-key', 'video-model'); model.textContent = '模型 Seedance 2.0 Fast'; model.addEventListener('click', controlClick); root.append(model);
  // 仅补齐测试浏览器缺失的编辑命令；编辑器、选区和后续全文回读均使用真实 DOM。
  Object.defineProperty(document, 'execCommand', { configurable: true, value: (command: string, _showUi?: boolean, value?: string): boolean => {
    if (document.activeElement !== editor || !['insertText', 'delete'].includes(command)) return false;
    const start = editor.selectionStart; const end = editor.selectionEnd; const replacement = command === 'delete' ? '' : value || '';
    editor.value = editor.value.slice(0, start) + replacement + editor.value.slice(end);
    editor.setSelectionRange(start + replacement.length, start + replacement.length);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: command === 'delete' ? 'deleteContentBackward' : 'insertText', data: replacement }));
    return true;
  } });
  const addCard = (fileName: string): HTMLElement => {
    const card = sized(document.createElement('div')); card.setAttribute('data-testid', 'attachment-image-card'); card.setAttribute('data-kind', 'image');
    const thumb = sized(document.createElement('img')); thumb.src = `blob:TEST-thumb-${fileName}`;
    Object.defineProperties(thumb, { complete: { get: (): boolean => true }, naturalWidth: { get: (): number => 64 }, naturalHeight: { get: (): number => 64 } });
    const full = sized(document.createElement('img')); full.src = `blob:TEST-full-${fileName}`; full.loading = 'lazy';
    let decoded = false;
    Object.defineProperties(full, { complete: { get: (): boolean => decoded }, naturalWidth: { get: (): number => decoded ? 1024 : 0 }, naturalHeight: { get: (): number => decoded ? 1024 : 0 } });
    const progress = sized(document.createElement('div')); progress.setAttribute('role', 'progressbar');
    const remove = sized(document.createElement('button')); remove.setAttribute('data-testid', 'attachment-delete-btn'); remove.textContent = '删除';
    card.append(thumb, full, progress, remove); root.append(card);
    // 平台先渲染附件卡和进度，随后解码实际图片；不把快照直接改成就绪。
    setTimeout((): void => { decoded = true; progress.remove(); full.dispatchEvent(new Event('load')); }, 120);
    return card;
  };
  const changed: string[][] = [];
  const changeReadbacks: SharedComposerFixture['changeReadbacks'] = [];
  input.addEventListener('change', (): void => {
    const cards = Array.from(root.querySelectorAll('[data-testid="attachment-image-card"]'));
    changeReadbacks.push({ count: cards.length, decodedCount: cards.filter((card: Element): boolean => {
      const full = card.querySelectorAll('img')[1]; return !!full?.complete && full.naturalWidth > 32;
    }).length, pending: !!root.querySelector('[role="progressbar"]') });
    const selected = Array.from(input.files || []); changed.push(selected.map((file: File): string => file.name));
    setTimeout((): void => { for (const file of selected) addCard(file.name); }, 60);
  });
  const view = { executeJavaScript: vi.fn(async (code: string): Promise<unknown> => window.eval(code)),
    getURL: (): string => 'https://www.doubao.com/chat/TEST-shared-video', loadURL: vi.fn(), sendInputEvent: vi.fn() };
  return { view, root, input, editor, changed, changeReadbacks, controlClick, addCard };
}

async function settled<T>(work: Promise<T>): Promise<T> {
  let outcome: { value: T } | { error: unknown } | undefined;
  void work.then((value: T): void => { outcome = { value }; }, (error: unknown): void => { outcome = { error }; });
  // 直接推进假时钟并让真实摘要 Promise 完成，避免每个上传样本等待真实 500ms。
  for (let sample = 0; sample < 200 && !outcome; sample++) await vi.advanceTimersByTimeAsync(100);
  if (!outcome) throw new Error('TEST operation did not settle');
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

async function upload(test: SharedComposerFixture): Promise<PetStoryUploadReceipt[]> {
  return settled(uploadPetStoryImages(test.view, files, 'first_last_frame', new AbortController().signal, hashes));
}

async function bind(test: SharedComposerFixture): Promise<{ compiled: PetStoryCompiledPrompt; bindings: PetStoryPageBinding[] }> {
  const receipts = await upload(test);
  return settled(bindPetStoryReferences(test.view, compiledPrompt(), receipts, new AbortController().signal));
}

beforeEach((): void => { vi.useFakeTimers(); vi.stubGlobal('crypto', webcrypto); });
afterEach((): void => { document.body.replaceChildren(); Reflect.deleteProperty(document, 'execCommand'); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('逻辑首尾帧直接使用现场统一上传入口', (): void => {
  it('连续回读 multiple 通用入口即放行原首尾帧请求，不查找或点击额外模式按钮', async (): Promise<void> => {
    const test = fixture(); const currentGuard = guard();
    const snapshot = await settled(waitForPetStoryVideoComposer(test.view, currentGuard, new AbortController().signal));
    expect(snapshot).toMatchObject({ present: true, generic: true, referenceMultiple: true, first: false, last: false, model: 'Seedance 2.0 Fast', duration: 5, aspectRatio: '9:16' });
    expect(currentGuard.mode).toBe('first_last_frame'); expect(currentGuard.compiledPrompt?.resolvedMode).toBe('first_last_frame');
    expect(test.controlClick).not.toHaveBeenCalled(); expect(test.changed).toEqual([]);
    expect(test.view.executeJavaScript.mock.calls.every((call: unknown[]): boolean => !String(call[0]).includes('"selectMode"'))).toBe(true);
  });

  it('首图和尾图按原顺序写入同一个 multiple input，并逐文件等待实际附件卡解码', async (): Promise<void> => {
    const test = fixture(); const receipts = await upload(test);
    expect(test.root.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(test.changed).toEqual([[files[0].name], [files[1].name]]);
    expect(test.changeReadbacks).toEqual([{ count: 0, decodedCount: 0, pending: false }, { count: 1, decodedCount: 1, pending: false }]);
    expect(receipts.map((receipt): object => ({ fileIndex: receipt.fileIndex, slot: receipt.slot, reference: receipt.reference, fileSha256: receipt.fileSha256 }))).toEqual([
      { fileIndex: 0, slot: 'reference', reference: 'plain', fileSha256: hashes[0] },
      { fileIndex: 1, slot: 'reference', reference: 'plain', fileSha256: hashes[1] },
    ]);
    const snapshot = await readPetStoryComposer(test.view, { slot: 'reference' });
    expect(snapshot).toMatchObject({ count: 2, pending: false, generic: true, referenceMultiple: true, first: false, last: false });
    expect(snapshot.previews?.map((preview): string => preview.key)).toEqual(receipts.map((receipt): string => receipt.key));
    expect(new Set(receipts.map((receipt): string => receipt.key)).size).toBe(2);
    expect(test.root.querySelectorAll('[data-testid="attachment-image-card"][data-kind="image"]')).toHaveLength(2);
    await expect(verifyPetStoryUploads(test.view, guard(), true)).resolves.toBeUndefined();
    expect(test.controlClick).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('真实 reference 绑定保留逻辑首尾用途和完整正文，不虚构独立首尾槽', async (): Promise<void> => {
    const test = fixture(); const original = compiledPrompt(); const bound = await bind(test);
    expect(bound.compiled).toMatchObject({ requestedMode: 'first_last_frame', resolvedMode: 'first_last_frame', final: original.final, references: original.references });
    expect(bound.compiled.text).toContain('第 1 张图作为首帧画面。'); expect(bound.compiled.text).toContain('第 2 张图作为尾帧目标。');
    expect(bound.compiled.text).toContain('尾帧作为目标结尾'); expect(test.editor.value).toBe(bound.compiled.text);
    expect(bound.bindings.map((binding): object => ({ assetId: binding.assetId, order: binding.order, slot: binding.slot, reference: binding.reference }))).toEqual([
      { assetId: 'TEST-first-asset', order: 1, slot: 'reference', reference: 'plain' },
      { assetId: 'TEST-last-asset', order: 2, slot: 'reference', reference: 'plain' },
    ]);
    await expect(verifyPetStoryReferenceBindings(test.view, bound.bindings)).resolves.toBeUndefined();
    expect(test.controlClick).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('富文本正文的首尾说明不会把含编辑器的上传祖先误识别为原生首尾槽', async (): Promise<void> => {
    const test = fixture(); const bound = await bind(test);
    const before = await readPetStoryComposer(test.view, { slot: 'reference' });
    test.editor.remove();
    const holder = sized(document.createElement('div'));
    const richEditor = sized(document.createElement('div')); richEditor.setAttribute('contenteditable', 'true');
    const paragraph = document.createElement('p'); paragraph.textContent = '首帧 第1张图 尾帧 第2张图'; richEditor.append(paragraph);
    holder.append(test.input, richEditor); test.root.prepend(holder);
    const snapshot = await readPetStoryComposer(test.view, { slot: 'reference' });
    expect(snapshot).toMatchObject({ present: true, generic: true, referenceMultiple: true, first: false, last: false, count: 2, pending: false });
    expect(snapshot.previews).toEqual(before.previews);
    expect((): void => checkPetStoryPageGuard(snapshot, guard(), true)).not.toThrow();
    await expect(verifyPetStoryUploads(test.view, guard(), true)).resolves.toBeUndefined();
    await expect(verifyPetStoryReferenceBindings(test.view, bound.bindings)).resolves.toBeUndefined();
    expect(test.changed).toEqual([[files[0].name], [files[1].name]]); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('统一入口没有 multiple 证据时不把单图上传器当作两图能力', async (): Promise<void> => {
    const test = fixture(); test.input.multiple = false;
    const snapshot = await readPetStoryComposer(test.view);
    expect((): void => checkPetStoryPageGuard(snapshot, guard(), true)).toThrow();
    expect(test.changed).toEqual([]);
  });

  it('将要上传的首尾文件顺序与已采用素材摘要不符时零上传', async (): Promise<void> => {
    const test = fixture();
    await expect(uploadPetStoryImages(test.view, [files[1], files[0]], 'first_last_frame', new AbortController().signal, hashes)).rejects.toThrow('摘要不符');
    expect(test.changed).toEqual([]); expect(test.root.querySelectorAll('[data-testid="attachment-image-card"]')).toHaveLength(0);
  });

  it('正文明确要求原生独立首尾帧槽时仍拒绝统一上传，普通尾帧目标说明继续允许', async (): Promise<void> => {
    const test = fixture(); const snapshot = await readPetStoryComposer(test.view);
    expect((): void => checkPetStoryPageGuard(snapshot, guard(), true)).not.toThrow();
    expect((): void => checkPetStoryPageGuard(snapshot, guard(compiledPrompt('必须使用原生独立首尾帧槽，禁止将两图作为普通参考上传。')), true)).toThrow();
    expect(test.changed).toEqual([]);
  });

  it.each(['missing', 'extra', 'replacement', 'card_order', 'binding_order', 'mixed_slots'] as const)('最终提交前拒绝 %s 素材或绑定变化', async (change): Promise<void> => {
    const test = fixture(); const bound = await bind(test);
    const cards = Array.from(test.root.querySelectorAll<HTMLElement>('[data-testid="attachment-image-card"]'));
    if (change === 'missing') cards[1].remove();
    if (change === 'extra') { test.addCard('TEST-foreign.png'); await vi.advanceTimersByTimeAsync(200); }
    if (change === 'replacement') (cards[1].querySelectorAll('img')[1] as HTMLImageElement).src = 'blob:TEST-foreign-file';
    if (change === 'card_order') test.root.insertBefore(cards[1], cards[0]);
    if (change === 'binding_order') bound.bindings.reverse();
    if (change === 'mixed_slots') { bound.bindings[1].slot = 'last_frame'; bound.bindings[1].reference = 'slot'; }
    if (change === 'missing' || change === 'extra') await expect(verifyPetStoryUploads(test.view, guard(), true)).rejects.toThrow();
    await expect(verifyPetStoryReferenceBindings(test.view, bound.bindings)).rejects.toThrow();
    expect(test.view.sendInputEvent).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled();
  });
});
