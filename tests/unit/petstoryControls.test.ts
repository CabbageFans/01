/** 当前输入区的序列化 DOM 回归。只有 TEST 字节；不打开真实网页或提交生成。 */
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PetStoryCapability, PetStoryExecutionGuard } from '@doubao-studio/contracts';
import { checkPetStoryPageGuard, getResultUrl, readAcceptedImageOutputs, readPetStoryComposer, uploadPetStoryImages, verifyPetStoryUploads, verifyPetStoryReferenceBindings } from '../../src/utils/doubaoBridge';

class Node {
  parentElement: Node | null = null;
  children: Node[] = [];
  accept = 'image/*'; files: File[] = []; disabled = false; display = 'block'; text = ''; width = 200; height = 100;
  complete = true; naturalWidth = 64; naturalHeight = 96; pending = false; loading = 'lazy';
  declare src: string;
  received: string[] = [];
  clicks = 0;
  constructor(readonly tag: string, readonly attributes: Record<string, string> = {}) { if (tag === 'img') this.src = ''; }
  get tagName(): string { return this.tag.toUpperCase(); }
  add(node: Node): Node { this.children.push(node); node.parentElement = this; return node; }
  get textContent(): string { return [this.text, ...this.children.map((n): string => n.textContent)].join(' '); }
  getBoundingClientRect(): { width: number; height: number } { return { width: this.width, height: this.height }; }
  getAttribute(key: string): string | null { return this.attributes[key] ?? null; }
  contains(node: Node): boolean { return node === this || this.children.some((c): boolean => c.contains(node)); }
  closest(selector: string): Node | null {
    if ((selector.includes('mdbox_image') && this.attributes['data-testid'] === 'mdbox_image') || (selector.includes('guidance-input-surface') && this.attributes.class === 'guidance-input-surface') || (selector.includes('role="menu"') && this.attributes.role === 'menu')) return this;
    return this.parentElement?.closest(selector) || null;
  }
  querySelector(selector: string): Node | null { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector: string): Node[] {
    const nodes = this.children.flatMap((c): Node[] => [c, ...c.querySelectorAll('*')]);
    if (selector === '*') return nodes;
    if (selector.startsWith('textarea')) return nodes.filter((n): boolean => n.tag === 'textarea' || n.attributes.contenteditable === 'true');
    if (selector === 'input[type="file"]') return nodes.filter((n): boolean => n.tag === 'input');
    if (selector === 'img') return nodes.filter((n): boolean => n.tag === 'img');
    if (selector.includes('aria-busy')) return nodes.filter((n): boolean => n.pending);
    if (selector.includes('data-creation-params-panel-id')) return nodes.filter((n): boolean => 'data-creation-params-panel-id' in n.attributes);
    if (selector.includes('video-model')) return nodes.filter((n): boolean => n.attributes['data-input-engine-actionbar-control-key'] === 'video-model');
    if (selector.includes('role="dialog"')) return nodes.filter((n): boolean => n.attributes.role === 'dialog' || n.attributes.role === 'alert');
    if (selector.includes('data-type="mention"')) return nodes.filter((n): boolean => n.attributes['data-type'] === 'mention');
    if (selector.includes('data-reference-option')) return nodes.filter((n): boolean => n.attributes.role === 'option' || 'data-reference-option' in n.attributes);
    if (selector.includes('button')) return nodes.filter((n): boolean => ['button', 'span', 'label'].includes(n.tag));
    return [];
  }
  dispatchEvent(): boolean {
    for (const file of this.files) {
      this.received.push(file.name);
      const image = this.parentElement?.add(new Node('img'));
      if (image) { image.src = `blob:TEST-${file.name}`; image.width = 64; image.height = 96; }
    }
    return true;
  }
  click(): void { this.clicks++; }
}
function fixture(native: boolean): { view: { executeJavaScript: ReturnType<typeof vi.fn>; loadURL: ReturnType<typeof vi.fn>; getURL: () => string }; surface: Node; first: Node; last?: Node; portal: Node } {
  const body = new Node('body'); const surface = body.add(new Node('div', { class: 'guidance-input-surface' }));
  let nested = surface; for (let i = 0; i < 12; i++) nested = nested.add(new Node('div'));
  nested.add(new Node('textarea'));
  const firstRoot = surface.add(new Node('div', native ? { 'aria-label': '首帧' } : {}));
  const first = firstRoot.add(new Node('input')); first.display = 'none';
  const last = native ? surface.add(new Node('div', { 'aria-label': '尾帧' })).add(new Node('input')) : undefined;
  if (last) last.display = 'none';
  const menu = surface.add(new Node('div', { role: 'menu' })); menu.display = 'none';
  const portal = menu.add(new Node('input')); portal.display = 'none';
  const config = surface.add(new Node('button', { 'data-creation-params-panel-id': 'TEST' })); config.text = '9:16 · 5s';
  const model = surface.add(new Node('button', { 'data-input-engine-actionbar-control-key': 'video-model' })); model.text = '模型 Seedance 2.0';
  const document = { body, querySelectorAll: (selector: string): Node[] => body.querySelectorAll(selector), querySelector: (selector: string): Node | null => body.querySelector(selector) };
  class Transfer { files: File[] = []; items = { add: (file: File): void => { this.files.push(file); } }; }
  const executeJavaScript = vi.fn(async (code: string): Promise<unknown> => runInNewContext(code, { document, window: { getComputedStyle: (node: Node): object => ({ display: node.display, visibility: 'visible' }) }, DataTransfer: Transfer, Event, File, Uint8Array, atob }));
  return { surface, first, last, portal, view: { executeJavaScript, loadURL: vi.fn(), getURL: (): string => 'https://www.doubao.com/chat/TEST' } };
}
function guard(mode: PetStoryExecutionGuard['mode'] = 'reference', count = 1): PetStoryExecutionGuard {
  const supported = { state: 'supported' as const, reason: 'TEST' };
  const capability: PetStoryCapability = { accountId: 'TEST', checkedAt: new Date().toISOString(), image: supported, modes: { first_frame: supported, first_last_frame: supported, reference: supported }, durations: [5], videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' }, };
  return { capability, mode, durationSeconds: 5, attachmentAssetIds: Array.from({ length: count }, (_, i): string => `TEST-asset-${i}`) };
}
const materials = ['TEST-first.png', 'TEST-last.png'].map((name): { name: string; base64: string; mime: string } => ({ name, base64: 'VEVTVA==', mime: 'image/png' }));
describe('P4 current composer and actual slot readback', (): void => {
  it('selects the loaded full image from an assistant card, excluding its thumbnail and all user references', async (): Promise<void> => {
    const thumb = { src: 'https://TEST.invalid/image-thumb.jpg', complete: true, naturalWidth: 108, naturalHeight: 192 };
    const full = { src: 'https://TEST.invalid/image-full.jpg', complete: true, naturalWidth: 1152, naturalHeight: 2048 };
    const card = { querySelectorAll: (selector: string): object[] => selector === 'img' ? [thumb, full] : [] };
    const reply = { querySelectorAll: (): object[] => [card] };
    const document = { querySelectorAll: (selector: string): object[] => selector === '[data-testid="receive_message"]' ? [reply] : [] };
    const view = { executeJavaScript: async (code: string): Promise<string> => runInNewContext(code, { document }) as string, getURL: (): string => '', loadURL: (): void => {} };
    expect(JSON.parse(await getResultUrl(view, 1000, true))).toEqual([full.src]);
    full.complete = false;
    expect(JSON.parse(await getResultUrl(view, 1000, true))).toEqual([]);
  });
  it('accepts a zero-height upload wrapper inside a visible composer while excluding hidden portal inputs', async (): Promise<void> => {
    const test = fixture(false);
    if (test.first.parentElement) test.first.parentElement.height = 0;
    expect(await readPetStoryComposer(test.view)).toMatchObject({ present: true, generic: true });
    const result = await readPetStoryComposer(test.view, { slot: 'reference', file: materials[0] });
    expect(result.uploaded).toBe(true);
    expect(test.first.received).toEqual([materials[0].name]);
    expect(test.portal.received).toEqual([]);
  });
  it('two generic images never become native first/last slots', async (): Promise<void> => {
    const test = fixture(false);
    const snapshot = await readPetStoryComposer(test.view);
    expect(snapshot).toMatchObject({ generic: true, first: false, last: false, duration: 5, model: 'Seedance 2.0' });
    expect((): void => checkPetStoryPageGuard(snapshot, guard('first_last_frame', 2), true)).toThrow('槽位');
    expect(test.first.received).toEqual([]); expect(test.portal.received).toEqual([]);
  });
  it('uploads first and last separately to explicit slots and verifies both; hidden menu remains untouched', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const test = fixture(true); const control = new AbortController();
      const upload = uploadPetStoryImages(test.view, materials, 'first_last_frame', control.signal);
      await vi.waitFor((): void => expect(test.first.received).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(4000); await upload;
      expect(test.first.received).toEqual(['TEST-first.png']); expect(test.last?.received).toEqual(['TEST-last.png']); expect(test.portal.received).toEqual([]);
      await expect(verifyPetStoryUploads(test.view, guard('first_last_frame', 2), true)).resolves.toBeUndefined();
      test.last?.parentElement?.children.pop();
      await expect(verifyPetStoryUploads(test.view, guard('first_last_frame', 2), true)).rejects.toThrow('素材数量');
    } finally { vi.useRealTimers(); }
  });
  it('first-frame mode binds only its explicit single start slot and does not require an end slot', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const test = fixture(true);
      const end = test.last?.parentElement;
      test.surface.children = test.surface.children.filter((node): boolean => node !== end);
      const snapshot = await readPetStoryComposer(test.view);
      expect(snapshot).toMatchObject({ first: true, last: false, generic: false });
      checkPetStoryPageGuard(snapshot, guard('first_frame'), true);
      const upload = uploadPetStoryImages(test.view, [materials[0]], 'first_frame', new AbortController().signal);
      await vi.waitFor((): void => expect(test.first.received).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(2000); await upload;
      await verifyPetStoryUploads(test.view, guard('first_frame'), true);
      expect(test.first.received).toEqual([materials[0].name]); expect(test.last?.received).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
  it('reference images are uploaded one at a time in the approved character order', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const test = fixture(false);
      const upload = uploadPetStoryImages(test.view, materials, 'reference', new AbortController().signal);
      await vi.waitFor((): void => expect(test.first.received).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(4000); await upload;
      expect(test.first.received).toEqual(materials.map((m): string => m.name));
      expect((await readPetStoryComposer(test.view, { slot: 'reference' })).count).toBe(2);
      await verifyPetStoryUploads(test.view, guard('reference', 2), true);
    } finally { vi.useRealTimers(); }
  });
  it.each([false, true])('binds distinct uploaded files to their decoded images instead of a shared first placeholder (decoded=%s)', async (placeholderDecoded): Promise<void> => {
    vi.useFakeTimers();
    try {
      const test = fixture(false);
      vi.spyOn(test.first, 'dispatchEvent').mockImplementation((): boolean => {
        for (const file of test.first.files) {
          test.first.received.push(file.name);
          const card = test.surface.add(new Node('div', { 'data-testid': 'mdbox_image' }));
          const placeholder = card.add(new Node('img')); placeholder.src = 'data:image/png;base64,TEST-shared-placeholder';
          placeholder.complete = placeholderDecoded; placeholder.naturalWidth = placeholderDecoded ? 64 : 0;
          const image = card.add(new Node('img')); image.src = `blob:TEST-${file.name}`; image.naturalWidth = 512; image.naturalHeight = 768;
        }
        return true;
      });
      const upload = uploadPetStoryImages(test.view, materials, 'image', new AbortController().signal)
        .then((receipts): { receipts: typeof receipts; error?: undefined } => ({ receipts }), (error: unknown): { error: unknown; receipts?: undefined } => ({ error }));
      await vi.waitFor((): void => expect(test.first.received).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(5000);
      const outcome = await upload;
      expect(outcome.error).toBeUndefined();
      const receipts = outcome.receipts!;
      expect(test.first.received).toEqual(materials.map((file): string => file.name));
      expect(receipts.map((receipt): number => receipt.fileIndex)).toEqual([0, 1]);
      expect(new Set(receipts.map((receipt): string => receipt.key)).size).toBe(2);
      const snapshot = await readPetStoryComposer(test.view, { slot: 'reference' });
      expect(snapshot.count).toBe(2);
      expect(snapshot.previews?.map((preview): string => preview.key)).toEqual(receipts.map((receipt): string => receipt.key));
      const bindings = receipts.map((receipt, index): import('@doubao-studio/contracts').PetStoryPageBinding => ({ assetId: `TEST-asset-${index}`, order: index + 1, slot: receipt.slot, reference: 'plain', label: receipt.label,
        previewHash: createHash('sha256').update(receipt.key).digest('hex'), fileSha256: receipt.fileSha256 }));
      await verifyPetStoryReferenceBindings(test.view, bindings);
      const images = test.surface.querySelectorAll('img').filter((image): boolean => image.src.startsWith('blob:'));
      [images[0].src, images[1].src] = [images[1].src, images[0].src];
      await expect(verifyPetStoryReferenceBindings(test.view, bindings)).rejects.toThrow('素材或引用节点已变化');
      [images[0].src, images[1].src] = [images[1].src, images[0].src];
      test.surface.children = test.surface.children.filter((node): boolean => node !== images[0].parentElement);
      await expect(verifyPetStoryReferenceBindings(test.view, bindings)).rejects.toThrow('素材丢失');
    } finally { vi.useRealTimers(); }
  });
  it('rejects wrong file bytes before any upload and detects actual first/last preview swaps', async (): Promise<void> => {
    const test = fixture(true);
    await expect(uploadPetStoryImages(test.view, materials, 'first_last_frame', new AbortController().signal, ['0'.repeat(64), '0'.repeat(64)])).rejects.toThrow('摘要不符');
    expect(test.first.received).toEqual([]); expect(test.last?.received).toEqual([]);
    vi.useFakeTimers();
    try {
      const upload = uploadPetStoryImages(test.view, materials, 'first_last_frame', new AbortController().signal, materials.map((m): string => createHash('sha256').update(Buffer.from(m.base64, 'base64')).digest('hex')));
      await vi.waitFor((): void => expect(test.first.received).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(5000); const receipts = await upload;
      const bindings = receipts.map((r, i): import('@doubao-studio/contracts').PetStoryPageBinding => ({ assetId: `TEST-frame-${i}`, order: i + 1, slot: r.slot, reference: 'slot', label: r.label, fileSha256: r.fileSha256, previewHash: createHash('sha256').update(r.key).digest('hex') }));
      await verifyPetStoryReferenceBindings(test.view, bindings);
      const first = test.first.parentElement!.querySelector('img')!; const last = test.last!.parentElement!.querySelector('img')!;
      [first.src, last.src] = [last.src, first.src];
      await expect(verifyPetStoryReferenceBindings(test.view, bindings)).rejects.toThrow('素材丢失');
    } finally { vi.useRealTimers(); }
  });
  it.each(['duration', 'model'] as const)('blocks real %s mismatch before submission', async (failure): Promise<void> => {
    const test = fixture(false); const current = await readPetStoryComposer(test.view); const expected = guard();
    if (failure === 'duration') current.duration = 10;
    if (failure === 'model') current.model = 'TEST wrong';
    expect((): void => checkPetStoryPageGuard(current, expected, true)).toThrow('模型／时长／比例');
    expect(test.first.received).toEqual([]);
  });
  it.each(['unknown', 'paid', false, undefined])('legacy free=%s is ignored when actual parameters and slots match', async (free): Promise<void> => {
    const test = fixture(false); const current = { ...await readPetStoryComposer(test.view), free };
    expect((): void => checkPetStoryPageGuard(current, guard(), true)).not.toThrow();
    expect(test.first.received).toEqual([]);
  });
  it('counts two rendered img nodes in one actual upload card once', async (): Promise<void> => {
    const test = fixture(false);
    const card = test.surface.add(new Node('div', { 'data-testid': 'mdbox_image' }));
    const image = card.add(new Node('img')); image.src = 'blob:TEST-real'; image.width = 64; image.height = 96; image.naturalWidth = 512; image.naturalHeight = 768;
    const placeholder = card.add(new Node('img')); placeholder.src = 'blob:TEST-placeholder'; placeholder.width = 64; placeholder.height = 96;
    const snapshot = await readPetStoryComposer(test.view, { slot: 'reference' });
    expect(snapshot.count).toBe(1); expect(snapshot.previews?.[0].key).toBeTruthy();
    image.complete = false;
    placeholder.complete = false;
    expect((await readPetStoryComposer(test.view, { slot: 'reference' })).count).toBe(0);
  });
  it('does not treat a decoded inline placeholder as a completed upload while its actual image is still loading', async (): Promise<void> => {
    const test = fixture(false);
    const card = test.surface.add(new Node('div', { 'data-testid': 'mdbox_image' }));
    const placeholder = card.add(new Node('img')); placeholder.src = 'data:image/png;base64,TEST-placeholder';
    const image = card.add(new Node('img')); image.src = 'blob:TEST-pending'; image.complete = false;
    expect(await readPetStoryComposer(test.view, { slot: 'reference' })).toMatchObject({ count: 0, previews: [] });
    image.complete = true;
    expect((await readPetStoryComposer(test.view, { slot: 'reference' })).count).toBe(1);
  });
  it('does not guess between equally sized distinct images in one card', async (): Promise<void> => {
    const test = fixture(false);
    const card = test.surface.add(new Node('div', { 'data-testid': 'mdbox_image' }));
    card.add(new Node('img')).src = 'blob:TEST-A'; card.add(new Node('img')).src = 'blob:TEST-B';
    expect(await readPetStoryComposer(test.view, { slot: 'reference' })).toMatchObject({ count: 0, previews: [] });
  });
  it('keeps a unique platform asset ID as the identity when two decoded card images have the same resolution', async (): Promise<void> => {
    const test = fixture(false);
    const card = test.surface.add(new Node('div', { 'data-testid': 'mdbox_image', 'data-asset-id': 'TEST-actual-asset' }));
    card.add(new Node('img')).src = 'blob:TEST-thumbnail'; card.add(new Node('img')).src = 'blob:TEST-actual';
    const first = await readPetStoryComposer(test.view, { slot: 'reference' });
    expect(first.count).toBe(1); expect(first.previews?.[0].nodeId).toBe('TEST-actual-asset'); expect(first.previews?.[0].key).toBeTruthy();
    card.querySelectorAll('img')[1].src = 'https://TEST.invalid/completed-preview.png';
    const second = await readPetStoryComposer(test.view, { slot: 'reference' });
    expect(second.previews?.[0].key).toBe(first.previews?.[0].key);
  });
  it('keeps duplicate actual uploads blocked instead of inventing distinct identities from card positions', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const test = fixture(false);
      vi.spyOn(test.first, 'dispatchEvent').mockImplementation((): boolean => {
        test.first.received.push(test.first.files[0].name);
        const card = test.surface.add(new Node('div', { 'data-testid': 'mdbox_image' }));
        card.add(new Node('img')).src = 'data:image/png;base64,TEST-placeholder';
        card.add(new Node('img')).src = 'blob:TEST-same-actual-image';
        return true;
      });
      const upload = uploadPetStoryImages(test.view, materials, 'image', new AbortController().signal).catch((error: unknown): unknown => error);
      await vi.waitFor((): void => expect(test.first.received).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(5000);
      expect(await upload).toMatchObject({ message: expect.stringContaining('无法逐文件核对实际素材') });
      expect(test.first.received).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
  it.each([false, true])('uses actual sources consistently for preview identities and exact reference menu selection (menu decoded=%s)', async (menuDecoded): Promise<void> => {
    const test = fixture(false);
    const card = test.surface.add(new Node('div', { 'data-testid': 'mdbox_image' }));
    card.add(new Node('img')).src = 'data:image/png;base64,TEST-shared-placeholder';
    card.add(new Node('img')).src = 'blob:TEST-actual-A';
    const options = ['A', 'B'].map((id): Node => {
      const option = test.surface.parentElement!.add(new Node('div', { role: 'option' })); option.text = '图片1';
      option.add(new Node('img')).src = 'data:image/png;base64,TEST-shared-placeholder';
      const image = option.add(new Node('img')); image.src = `blob:TEST-actual-${id}`;
      image.complete = menuDecoded; image.naturalWidth = menuDecoded ? 64 : 0; image.naturalHeight = menuDecoded ? 96 : 0;
      return option;
    });
    const snapshot = await readPetStoryComposer(test.view);
    const key = snapshot.previews![0].key;
    expect(key).toBeTruthy(); expect(snapshot.referenceOptions?.[0].key).toBe(key);
    expect(snapshot.referenceOptions?.[1].key).not.toBe(key);
    const selected = await readPetStoryComposer(test.view, { selectReference: '@图片1', selectReferenceKey: key });
    expect(selected.selectedReference).toBe(true); expect(options.map((option): number => option.clicks)).toEqual([1, 0]);
  });
  it('serialized guest reads distinct node instance and target IDs and selects the matching real menu item', async (): Promise<void> => {
    const test = fixture(false); const textarea = test.surface.querySelector('textarea')!; const parent = textarea.parentElement!;
    parent.children = parent.children.filter((n): boolean => n !== textarea);
    const editor = parent.add(new Node('div', { contenteditable: 'true' }));
    const node = editor.add(new Node('span', { 'data-type': 'mention', 'data-mention-id': 'instance-9', 'data-asset-id': 'target-A' })); node.text = '@图片1';
    const preview = test.surface.add(new Node('div', { 'data-testid': 'mdbox_image', 'data-asset-id': 'target-A', 'data-reference-label': '@图片1' })); preview.add(new Node('img')).src = 'blob:TEST-upload';
    const menu = test.surface.parentElement!.add(new Node('div'));
    const correct = menu.add(new Node('div', { role: 'option', 'data-asset-id': 'target-A' })); correct.text = '图片1';
    const other = menu.add(new Node('div', { role: 'option', 'data-asset-id': 'target-B' })); other.text = '图片1';
    const snapshot = await readPetStoryComposer(test.view);
    expect(snapshot.referenceNodes).toEqual([{ label: '@图片1', nodeId: 'instance-9', targetId: 'target-A' }]);
    expect(snapshot.previews![0].nodeId).toBe('target-A');
    const selected = await readPetStoryComposer(test.view, { selectReference: '@图片1', selectReferenceKey: snapshot.referenceOptions!.find((o): boolean => o.nodeId === 'target-A')!.key });
    expect(selected.selectedReference).toBe(true); expect(correct.clicks).toBe(1); expect(other.clicks).toBe(0);
  });
  it('wakes only current composer previews and still requires actual decoding before counting', async (): Promise<void> => {
    const test = fixture(false);
    const current = test.surface.add(new Node('img')); current.src = 'blob:TEST-current';
    current.complete = false; current.naturalWidth = 0;
    const history = test.surface.parentElement?.add(new Node('img'));
    if (!history) throw new Error('TEST history missing');
    history.src = 'https://TEST.invalid/history.png';
    const pending = await readPetStoryComposer(test.view, { slot: 'reference', wakePreviews: true });
    expect(pending).toMatchObject({ count: 0, uploaded: false });
    expect(current.loading).toBe('eager'); expect(current.src).toBe('blob:TEST-current');
    expect(history.loading).toBe('lazy'); expect(test.first.received).toEqual([]);
    current.complete = true; current.naturalWidth = 64;
    expect((await readPetStoryComposer(test.view, { slot: 'reference' })).count).toBe(1);
  });
  it('recovers accepted image results only by observing the original session and existing extractors', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const view = { executeJavaScript: vi.fn(async (code: string): Promise<unknown> => code.includes('messages.push') ? { messages: [], editorPresent: true, editorText: '', generating: false } : JSON.stringify(['https://TEST.invalid/generated.png'])),
        getURL: (): string => 'https://www.doubao.com/chat/TEST-original', loadURL: vi.fn(), sendInputEvent: vi.fn() };
      const result = readAcceptedImageOutputs(view, view.getURL(), new AbortController().signal, 3000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await result).toEqual(['https://TEST.invalid/generated.png']);
      expect(view.loadURL).not.toHaveBeenCalled(); expect(view.sendInputEvent).not.toHaveBeenCalled();
      const aborted = new AbortController(); aborted.abort();
      await expect(readAcceptedImageOutputs(view, view.getURL(), aborted.signal, 3000)).rejects.toThrow('暂停');
      await expect(readAcceptedImageOutputs(view, 'https://www.doubao.com/chat/TEST-other', undefined, 3000)).rejects.toThrow('会话已变化');
    } finally { vi.useRealTimers(); }
  });
  it('input.files alone and an aborted upload cannot pass actual image readiness', async (): Promise<void> => {
    const test = fixture(true);
    test.first.files = [new File(['TEST'], 'TEST-unrendered.png')];
    expect((await readPetStoryComposer(test.view, { slot: 'first_frame' })).count).toBe(0);
    const aborted = new AbortController(); aborted.abort();
    await expect(uploadPetStoryImages(test.view, materials, 'first_last_frame', aborted.signal)).rejects.toThrow();
    expect(test.first.received).toEqual([]);
  });
});
