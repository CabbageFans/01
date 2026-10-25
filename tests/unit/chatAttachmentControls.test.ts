/** 离线 DOM 夹具采用实页控件结构；不连接网页、不上传真实素材或请求模型。 */
import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { chatAttachmentScript } from '../../src/utils/chatAttachments';
import { uploadReferenceImages } from '../../src/utils/doubaoBridge';

class TestNode {
  parentElement: TestNode | null = null;
  children: TestNode[] = [];
  accept = '';
  multiple = true;
  disabled = false;
  isConnected = true;
  files: File[] = [];
  width = 500;
  height = 100;
  display = 'block';
  alt = '';
  title = '';
  text = '';
  pending = false;
  failed = false;
  events: string[] = [];
  constructor(readonly tagName: string, readonly attributes: Record<string, string> = {}) {}
  add(node: TestNode): TestNode { this.children.push(node); node.parentElement = this; return node; }
  closest(selector: string): TestNode | null {
    if (selector === '.guidance-input-surface' && this.attributes.class === 'guidance-input-surface') return this;
    return this.parentElement?.closest(selector) || null;
  }
  get innerText(): string { return [this.text, ...this.children.map((node: TestNode): string => node.innerText)].join(' '); }
  getBoundingClientRect(): { width: number; height: number } { return { width: this.width, height: this.height }; }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  dispatchEvent(event: Event): boolean { this.events.push(event.type); return true; }
  querySelectorAll(selector: string): TestNode[] {
    const descendants = this.children.flatMap((node: TestNode): TestNode[] => [node, ...node.querySelectorAll('*')]);
    if (selector === '*') return descendants;
    if (selector.startsWith('textarea')) return descendants.filter((node: TestNode): boolean => node.tagName === 'TEXTAREA' || node.attributes.contenteditable === 'true');
    if (selector === 'input[type="file"]') return descendants.filter((node: TestNode): boolean => node.tagName === 'INPUT');
    if (selector === 'img') return descendants.filter((node: TestNode): boolean => node.tagName === 'IMG');
    if (selector === '[data-testid="mdbox_image"]') return descendants.filter((node: TestNode): boolean => node.attributes['data-testid'] === 'mdbox_image');
    if (selector.includes('aria-busy')) return descendants.filter((node: TestNode): boolean => node.pending);
    if (selector.includes('data-status="error"')) return descendants.filter((node: TestNode): boolean => node.failed);
    return [];
  }
}
const materials = ['TEST-lulu.png', 'TEST-lumei.png'].map((name: string): { name: string; base64: string; mime: string } => ({ name, base64: 'VEVTVA==', mime: 'image/png' }));
function fixture(): { surface: TestNode; input: TestNode; portal: TestNode; execute: (operation: 'inspect' | 'inject') => Promise<unknown>; view: { executeJavaScript: ReturnType<typeof vi.fn>; getURL: () => string; loadURL: ReturnType<typeof vi.fn> } } {
  const body = new TestNode('BODY');
  // 实页编辑器深于八层，上传 input 位于共同输入 surface 的兄弟节点。
  const surface = body.add(new TestNode('DIV', { class: 'guidance-input-surface' }));
  let wrapper = surface;
  for (let index = 0; index < 12; index++) wrapper = wrapper.add(new TestNode('DIV'));
  wrapper.add(new TestNode('DIV', { contenteditable: 'true' }));
  const input = surface.add(new TestNode('DIV')).add(new TestNode('INPUT'));
  input.accept = '.pdf,.docx,.png,.jpeg,.jpg,.webp,.mp3'; input.display = 'none';
  const portal = body.add(new TestNode('DIV')).add(new TestNode('INPUT'));
  portal.accept = '.pdf, .txt, .png, .jpeg, .jpg, .webp, .mp3'; portal.display = 'none';
  const icon = surface.add(new TestNode('IMG', { src: 'https://example.test/TEST-icon.svg' })); icon.width = 16; icon.height = 16;
  const document = { body, querySelectorAll: (selector: string): TestNode[] => body.querySelectorAll(selector) };
  class TestDataTransfer {
    files: File[] = [];
    items = { add: (file: File): void => { this.files.push(file); } };
  }
  const executeJavaScript = vi.fn(async (code: string): Promise<unknown> => runInNewContext(code, { document, window: { getComputedStyle: (node: TestNode): { display: string; visibility: string } => ({ display: node.display, visibility: 'visible' }) }, DataTransfer: TestDataTransfer, File, Event, atob, Uint8Array }));
  return { surface, input, portal, execute: (operation: 'inspect' | 'inject'): Promise<unknown> => executeJavaScript(chatAttachmentScript(operation, materials)),
    view: { executeJavaScript, getURL: (): string => 'https://www.doubao.com/chat/', loadURL: vi.fn() } };
}
function preview(surface: TestNode, name: string): TestNode {
  const card = surface.add(new TestNode('DIV', { 'data-testid': 'mdbox_image' })); card.text = name;
  const image = card.add(new TestNode('IMG', { src: `https://example.test/${name}` })); image.width = 64; image.height = 64;
  const placeholder = card.add(new TestNode('IMG', { src: 'data:image/png;base64,TEST' })); placeholder.width = 64; placeholder.height = 64;
  return card;
}
describe('ordinary Chat serialized attachment controls — offline only', (): void => {
  it('selects the composer upload despite a second hidden portal and deep editor nesting', async (): Promise<void> => {
    const { execute, input, portal } = fixture();
    expect(await execute('inject')).toMatchObject({ injected: true });
    expect(input.files.map((file: File): string => file.name)).toEqual(materials.map((file): string => file.name));
    expect(input.events).toEqual(['change']);
    expect(portal.files).toEqual([]);
    expect(portal.events).toEqual([]);
  });
  it.each(['ambiguous', 'disabled', 'missing', 'single', 'editor'] as const)('stops before injection for %s controls', async (failure): Promise<void> => {
    const { execute, input, surface } = fixture();
    if (failure === 'ambiguous') { const second = surface.add(new TestNode('INPUT')); second.accept = 'image/*'; }
    if (failure === 'disabled') input.disabled = true;
    if (failure === 'missing') input.accept = '.pdf';
    if (failure === 'single') input.multiple = false;
    if (failure === 'editor') surface.add(new TestNode('TEXTAREA'));
    expect(await execute('inject')).toMatchObject({ error: expect.any(String) });
    expect(input.events).toEqual([]);
  });
  it('counts real composer previews once, excluding input.files, toolbar icons and wrapping nodes', async (): Promise<void> => {
    const { execute, input, surface } = fixture();
    input.files = [new File(['TEST'], 'TEST-existing.png')];
    surface.add(new TestNode('DIV', { class: 'preview attachment thumb' }));
    expect(await execute('inspect')).toMatchObject({ inputFileCount: 0, visibleAttachmentCount: 0 });
    const card = preview(surface, materials[0].name); card.pending = true;
    expect(await execute('inspect')).toMatchObject({ visibleAttachmentCount: 1, matchingFileNameCount: 1, pending: true });
    card.pending = false; preview(surface, materials[1].name);
    expect(await execute('inspect')).toMatchObject({ visibleAttachmentCount: 2, matchingFileNameCount: 2, pending: false });
  });
  it('keeps observing the attachment surface when upload adds another input inside the editor subtree', async (): Promise<void> => {
    const { execute, surface } = fixture();
    // 实页在上传后把添加附件 input 插入 guidance-input-content，附件卡仍在 surface 的另一分支。
    const nested = surface.children[0].add(new TestNode('INPUT')); nested.accept = 'image/*';
    preview(surface, materials[0].name); preview(surface, materials[1].name);
    expect(await execute('inspect')).toMatchObject({ visibleAttachmentCount: 2, matchingFileNameCount: 2, pending: false });
    expect(await execute('inject')).toMatchObject({ error: 'input_ambiguous' });
  });
  it('excludes a hidden menu reparented into the same composer surface after SPA navigation', async (): Promise<void> => {
    const { execute, surface, input } = fixture();
    const menu = surface.children[0].add(new TestNode('DIV')); menu.display = 'none';
    const menuInput = menu.add(new TestNode('INPUT')); menuInput.accept = 'image/*';
    expect(await execute('inject')).toMatchObject({ injected: true });
    expect(input.events).toEqual(['change']);
    expect(menuInput.events).toEqual([]);
    preview(surface, materials[0].name); preview(surface, materials[1].name);
    expect(await execute('inspect')).toMatchObject({ visibleAttachmentCount: 2 });
  });
  it('reports a specific Chat control error instead of a synthetic 0ms video timeout', async (): Promise<void> => {
    const { input, view } = fixture(); input.disabled = true;
    await expect(uploadReferenceImages(view, materials, { chat: true })).rejects.toMatchObject({ code: 'chat_assets_not_ready', reason: 'input_missing' });
    expect(input.events).toEqual([]);
  });
  it('runs the real upload loop against serialized DOM, waits for all images, and injects only once', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const { surface, input, portal, view } = fixture();
      const onProgress = vi.fn();
      const result = uploadReferenceImages(view, materials, { chat: true, onProgress });
      await vi.advanceTimersByTimeAsync(750);
      const first = preview(surface, materials[0].name); first.pending = true;
      await vi.advanceTimersByTimeAsync(1500);
      expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ observedCount: 1, pending: true, stableSamples: 0 }));
      first.pending = false; preview(surface, materials[1].name);
      await vi.advanceTimersByTimeAsync(2250);
      expect(await result).toBe(true);
      expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ observedCount: 2, stableSamples: 3, pending: false }));
      expect(input.events).toEqual(['change']);
      expect(portal.events).toEqual([]);
      expect(view.loadURL).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('stops after one injection if the page reports an upload error', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const { surface, input, view } = fixture();
      const result = uploadReferenceImages(view, materials, { chat: true });
      const assertion = expect(result).rejects.toMatchObject({ code: 'chat_assets_not_ready', reason: 'upload_failed' });
      await vi.advanceTimersByTimeAsync(750);
      preview(surface, materials[0].name).failed = true;
      await vi.advanceTimersByTimeAsync(750);
      await assertion;
      expect(input.events).toEqual(['change']);
    } finally { vi.useRealTimers(); }
  });
});
