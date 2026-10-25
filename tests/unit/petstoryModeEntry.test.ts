/** 序列化真实入口脚本的离线 DOM 行为测试，不访问平台、不发送生成。 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { clickAITab } from '../../src/utils/doubaoBridge';

function fixture(initial: 'plain' | 'image-skill' | 'video', imageInMore: boolean = false, hiddenMeasurement: boolean = false): {
  view: { executeJavaScript: (code: string) => Promise<unknown>; getURL: () => string; loadURL: ReturnType<typeof vi.fn> };
  actions: string[];
} {
  let state = initial as string;
  let menu = false;
  const actions: string[] = [];
  class Element {
    parentElement: Element | null = null;
    visibility = 'visible';
    constructor(readonly tagName: string, readonly innerText: string, readonly owned = true) {}
    get childNodes(): Array<{ nodeType: number; textContent: string }> { return [{ nodeType: 3, textContent: this.innerText }]; }
    get offsetParent(): object | null { return this.shown() ? {} : null; }
    shown(): boolean { return this !== image || !imageInMore || menu; }
    getBoundingClientRect(): { left: number; top: number; bottom: number; width: number; height: number } {
      return { left: this.owned ? 167 : 8, top: 672, bottom: 704, width: this.shown() ? 92 : 0, height: this.shown() ? 32 : 0 };
    }
    getAttribute(key: string): string | null { return key === 'role' ? 'button' : null; }
    closest(): null { return null; }
    contains(node: Element): boolean { return this === root && node.owned; }
    querySelectorAll(selector: string): Element[] {
      if (selector.includes('skill_input_exit_button')) return hiddenMeasurement || state === 'image-skill' || state === 'video' ? [skill] : [];
      if (selector.includes('aria-expanded')) return [];
      return [more, image, video].filter((n): boolean => n.shown());
    }
    dispatchEvent(event: { type: string }): boolean {
      if (event.type !== 'click') return true;
      actions.push(this.innerText);
      if (this === more) menu = true;
      if (this === skill) { state = 'plain'; root = new Element('DIV', 'TEST remounted composer'); }
      if (this === video) state = 'video';
      return true;
    }
  }
  const image = new Element('BUTTON', '图像生成');
  const video = new Element('BUTTON', '视频生成');
  const sidebarImage = new Element('BUTTON', '图像生成', false);
  const sidebarVideo = new Element('BUTTON', '视频生成', false);
  const more = new Element('BUTTON', '更多');
  const skill = new Element('DIV', initial === 'video' || hiddenMeasurement ? '视频生成' : '图像生成');
  if (hiddenMeasurement) skill.visibility = 'hidden';
  let root = new Element('DIV', 'TEST composer');
  const editor = { getBoundingClientRect: (): object => ({ top: 550, bottom: 650, width: 480, height: 100 }) };
  const model = { getBoundingClientRect: (): object => ({ width: 100, height: 32 }) };
  const document = {
    querySelector: (selector: string): unknown => {
      if (selector === 'textarea') return editor;
      if (selector.includes('input-engine-container') || selector === '.guidance-input-surface') return root;
      if (selector.includes('video-model') || selector.includes('data-creation-params-panel-id')) return state === 'video' ? model : null;
      return null;
    },
    querySelectorAll: (selector: string): object[] => {
      if (selector.includes('video-model') || selector.includes('data-creation-params-panel-id')) return state === 'video' || hiddenMeasurement ? [model] : [];
      return state === 'image-skill' || state === 'video' ? [sidebarImage, sidebarVideo, skill] : [sidebarImage, sidebarVideo, more, image, video].filter((n): boolean => n.shown());
    },
    getElementById: (): null => null,
  };
  class InputEvent { constructor(readonly type: string) {} }
  return { actions, view: { executeJavaScript: async (code: string): Promise<unknown> => runInNewContext(code, { document, window: { innerHeight: 732, getComputedStyle: (node: Element): object => ({ display: 'block', visibility: node === (model as unknown) && state !== 'video' ? 'hidden' : node.visibility || 'visible' }) }, setTimeout, Date, PointerEvent: InputEvent, MouseEvent: InputEvent }), getURL: (): string => 'https://www.doubao.com/chat/', loadURL: vi.fn() } };
}

describe('P4 narrow composer mode entry', (): void => {
  it('ignores the hidden measuring skill and parameter controls, then clicks the real visible video entry', async (): Promise<void> => {
    const test = fixture('plain', false, true);
    expect(await clickAITab(test.view, 'video')).toBe(true);
    expect(test.actions).toEqual(['视频生成']);
  });
  it('keeps an already selected video skill and its verified controls without toggling it off', async (): Promise<void> => {
    const test = fixture('video');
    expect(await clickAITab(test.view, 'video')).toBe(true);
    expect(test.actions).toEqual([]);
  });
  it('exits the video skill before selecting image generation', async (): Promise<void> => {
    const test = fixture('video');
    expect(await clickAITab(test.view, 'image')).toBe(true);
    expect(test.actions).toEqual(['视频生成', '图像生成']);
  });
  it('selects the current composer entry at x=167 and excludes the identically named sidebar', async (): Promise<void> => {
    const test = fixture('plain');
    expect(await clickAITab(test.view, 'image')).toBe(true);
    expect(test.actions).toEqual(['图像生成']);
    expect(test.view.loadURL).not.toHaveBeenCalled();
  });
  it('opens the visible More menu once to reveal the image entry', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const test = fixture('plain', true);
      const pending = clickAITab(test.view, 'image');
      await vi.advanceTimersByTimeAsync(2500);
      expect(await pending).toBe(true);
      expect(test.actions).toEqual(['更多', '图像生成']);
    } finally { vi.useRealTimers(); }
  });
  it('exits the selected image skill, locates the remounted composer and waits for video controls', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const test = fixture('image-skill');
      const pending = clickAITab(test.view, 'video');
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toBe(true);
      expect(test.actions).toEqual(['图像生成', '视频生成']);
    } finally { vi.useRealTimers(); }
  });
});
