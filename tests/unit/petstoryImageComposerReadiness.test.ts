/** 图片入口异步重建的离线回归；只读探针，不上传、不点击、不发出真实豆包请求。 */
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForPetStoryImageComposer } from '../../src/utils/doubaoBridge';
import type { WebviewHandle } from '../../src/utils/doubaoBridge';
import type { PetStoryComposerSnapshot } from '../../src/utils/petstoryControls';

const absent: PetStoryComposerSnapshot = { present: false, generic: false, first: false, last: false, nativeLabel: false, firstLabel: false,
  model: '', duration: 0, aspectRatio: '', durations: [], count: 0, pending: false };
const ready: PetStoryComposerSnapshot = { ...absent, present: true, generic: true };
const nativeSlot: PetStoryComposerSnapshot = { ...absent, present: true, first: true, last: true };

function viewFor(samples: PetStoryComposerSnapshot[]): WebviewHandle & { executeJavaScript: ReturnType<typeof vi.fn>; loadURL: ReturnType<typeof vi.fn>; sendInputEvent: ReturnType<typeof vi.fn> } {
  let index = 0;
  return { executeJavaScript: vi.fn(async (): Promise<PetStoryComposerSnapshot> => structuredClone(samples[Math.min(index++, samples.length - 1)])),
    loadURL: vi.fn(), getURL: (): string => 'https://www.doubao.com/chat/TEST-image-ready', sendInputEvent: vi.fn() };
}

beforeEach((): void => { vi.useFakeTimers(); vi.setSystemTime('2026-10-30T05:00:00.000Z'); });
afterEach((): void => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('图片入口真实就绪回读', (): void => {
  it('跨过暂时缺失和错误首尾槽位，并要求连续两次真正的通用图片输入区', async (): Promise<void> => {
    const view = viewFor([absent, nativeSlot, ready, absent, ready, ready]);
    const completed = vi.fn();
    const result = waitForPetStoryImageComposer(view, new AbortController().signal, 5000).then((snapshot: PetStoryComposerSnapshot): PetStoryComposerSnapshot => { completed(); return snapshot; });
    await vi.advanceTimersByTimeAsync(500);
    expect(view.executeJavaScript).toHaveBeenCalledTimes(3); expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(view.executeJavaScript).toHaveBeenCalledTimes(5); expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toEqual(ready); expect(completed).toHaveBeenCalledTimes(1);
    expect(view.loadURL).not.toHaveBeenCalled(); expect(view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('已取消时不读取网页，也不执行导航、上传或发送动作', async (): Promise<void> => {
    const view = viewFor([ready]); const control = new AbortController(); control.abort();
    await expect(waitForPetStoryImageComposer(view, control.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(view.executeJavaScript).not.toHaveBeenCalled(); expect(view.loadURL).not.toHaveBeenCalled(); expect(view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('等待中取消后，即使探针随后返回第二个就绪样本，也不报告完成', async (): Promise<void> => {
    const view = viewFor([ready]); const control = new AbortController(); const completed = vi.fn();
    let release: ((snapshot: PetStoryComposerSnapshot) => void) | undefined;
    view.executeJavaScript.mockImplementationOnce(async (): Promise<PetStoryComposerSnapshot> => ready)
      .mockImplementationOnce((): Promise<PetStoryComposerSnapshot> => new Promise((resolve): void => { release = resolve; }));
    const result = waitForPetStoryImageComposer(view, control.signal, 5000).then((snapshot: PetStoryComposerSnapshot): PetStoryComposerSnapshot => { completed(); return snapshot; });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(250);
    expect(view.executeJavaScript).toHaveBeenCalledTimes(2);
    control.abort(); release?.(ready);
    await vi.advanceTimersByTimeAsync(250); await rejected;
    expect(completed).not.toHaveBeenCalled(); expect(view.executeJavaScript).toHaveBeenCalledTimes(2);
    expect(view.loadURL).not.toHaveBeenCalled(); expect(view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('到期仍没有真实输入区时拒绝，不把等待结束当作生成或控件就绪', async (): Promise<void> => {
    const view = viewFor([absent]); const completed = vi.fn();
    const result = waitForPetStoryImageComposer(view, new AbortController().signal, 750).then((snapshot: PetStoryComposerSnapshot): PetStoryComposerSnapshot => { completed(); return snapshot; });
    const rejected = expect(result).rejects.toThrow('图片输入区尚未就绪');
    await vi.advanceTimersByTimeAsync(750); await rejected;
    expect(view.executeJavaScript).toHaveBeenCalledTimes(3); expect(completed).not.toHaveBeenCalled();
    expect(view.loadURL).not.toHaveBeenCalled(); expect(view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('执行序列化的真实探针只读当前控件，不点击模式、参数或引用菜单', async (): Promise<void> => {
    const click = vi.fn();
    interface ProbeNode {
      parentElement: ProbeNode | null; textContent: string; accept?: string;
      getBoundingClientRect: () => { width: number; height: number };
      getAttribute: (name: string) => string | null;
      closest: (selector: string) => ProbeNode | null;
      contains: (node: ProbeNode) => boolean;
      querySelectorAll: (selector: string) => ProbeNode[];
      querySelector: (selector: string) => ProbeNode | null;
      click: () => void;
    }
    const makeNode = (text = ''): ProbeNode => ({ parentElement: null, textContent: text, getBoundingClientRect: (): { width: number; height: number } => ({ width: 600, height: 120 }),
      getAttribute: (): string | null => null, closest: (): ProbeNode | null => null,
      contains: (): boolean => true, querySelectorAll: (): ProbeNode[] => [], querySelector: (): ProbeNode | null => null, click });
    const root = makeNode(); const editor = makeNode(); const input = makeNode(); input.accept = 'image/*'; input.parentElement = root;
    const mode = makeNode('参考图'); const parameters = makeNode('9:16 · 5s'); const model = makeNode('模型 Seedream 4.0'); const reference = makeNode('图片1');
    editor.closest = (): ProbeNode => root;
    root.querySelectorAll = (selector: string): ProbeNode[] => selector === 'input[type="file"]' ? [input] : selector.includes('button') ? [mode, parameters] : [];
    const document = { body: makeNode(), querySelectorAll: (selector: string): ProbeNode[] => {
      if (selector.startsWith('textarea')) return [editor];
      if (selector === '[data-creation-params-panel-id]') return [parameters];
      if (selector === '[data-input-engine-actionbar-control-key="video-model"]') return [model];
      if (selector === '[role="option"],[role="menuitem"],[data-reference-option]') return [reference];
      return [];
    } };
    const view = viewFor([]);
    view.executeJavaScript.mockImplementation(async (code: string): Promise<PetStoryComposerSnapshot> => runInNewContext(code, {
      document, window: { getComputedStyle: (): { display: string; visibility: string } => ({ display: 'block', visibility: 'visible' }) },
    }) as PetStoryComposerSnapshot);
    const result = waitForPetStoryImageComposer(view, new AbortController().signal, 1000);
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject({ present: true, generic: true, first: false, last: false, model: 'Seedream 4.0', aspectRatio: '9:16' });
    expect(view.executeJavaScript).toHaveBeenCalledTimes(2);
    for (const [code] of view.executeJavaScript.mock.calls) expect(code).toMatch(/\)\(\{\}\)$/);
    expect(click).not.toHaveBeenCalled(); expect(view.loadURL).not.toHaveBeenCalled(); expect(view.sendInputEvent).not.toHaveBeenCalled();
  });
});
