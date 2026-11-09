/** 序列化真实入口脚本的离线 DOM 行为测试，不访问平台、不发送生成。 */
import { runInNewContext } from 'node:vm';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickAITab } from '../../src/utils/doubaoBridge';

const pages: Window[] = [];

function fixture(initial: 'plain' | 'image-skill' | 'video', imageInMore: boolean = false, hiddenMeasurement: boolean = false, options: {
  imageEntryDelayMs?: number;
  moreDelayMs?: number;
  imageMissing?: boolean;
  selectedImageDelayMs?: number;
  ignoreImageSelection?: boolean;
} = {}): {
  view: { executeJavaScript: (code: string) => Promise<unknown>; getURL: () => string; loadURL: ReturnType<typeof vi.fn> };
  actions: string[];
} {
  const page = new Window(); pages.push(page);
  const document = page.document;
  page.HTMLElement.prototype.getBoundingClientRect = function (): InstanceType<typeof page.DOMRect> {
    return new page.DOMRect(167, this.tagName === 'TEXTAREA' ? 550 : 672, 600, this.tagName === 'TEXTAREA' ? 100 : 32);
  };
  const actions: string[] = [];
  let state = initial;
  let moreOpened = false;
  let surface = document.createElement('div');
  let engine = document.createElement('div');
  let bar = document.createElement('div');
  const image = document.createElement('button'); image.dataset.testid = 'skill_bar_button_image'; image.textContent = '图像生成';
  const video = document.createElement('button'); video.dataset.testid = 'skill_bar_button_video'; video.textContent = '视频生成';
  const more = document.createElement('button'); more.dataset.testid = 'skill_bar_button_more'; more.textContent = '更多';
  image.style.display = options.imageMissing || options.imageEntryDelayMs || imageInMore ? 'none' : '';
  more.style.display = options.moreDelayMs ? 'none' : '';
  const plainSurface = (): void => {
    const previous = surface;
    surface = document.createElement('div'); surface.className = 'guidance-input-surface';
    engine = document.createElement('div'); engine.id = 'input-engine-container'; engine.append(document.createElement('textarea'));
    bar = document.createElement('div'); bar.dataset.testid = 'guidance-skill-bar'; bar.append(image, video, more); surface.append(engine, bar);
    if (previous.isConnected) previous.replaceWith(surface); else document.body.append(surface);
  };
  const mountSkill = (mode: 'image' | 'video'): void => {
    state = mode === 'image' ? 'image-skill' : 'video'; bar.remove();
    surface.querySelector('[data-testid="skill_input_exit_button"]')?.remove();
    const selected = document.createElement('div'); selected.dataset.testid = 'skill_input_exit_button'; selected.textContent = mode === 'image' ? '图像生成' : '视频生成'; surface.append(selected);
    selected.addEventListener('click', (): void => { actions.push(selected.textContent || ''); state = 'plain'; plainSurface(); });
  };
  plainSurface();
  if (initial !== 'plain') mountSkill(initial === 'video' ? 'video' : 'image');
  image.addEventListener('click', (): void => { actions.push('图像生成'); if (!options.ignoreImageSelection) mountSkill('image'); });
  video.addEventListener('click', (): void => { actions.push('视频生成'); mountSkill('video'); });
  more.addEventListener('click', (): void => {
    actions.push('更多'); moreOpened = true;
    if (!options.imageMissing && !options.imageEntryDelayMs) image.style.display = '';
  });
  if (options.imageEntryDelayMs) setTimeout((): void => { if (!options.imageMissing && (!imageInMore || moreOpened)) image.style.display = ''; }, options.imageEntryDelayMs);
  if (options.moreDelayMs) setTimeout((): void => { more.style.display = ''; }, options.moreDelayMs);
  if (options.selectedImageDelayMs !== undefined) setTimeout((): void => { if (state === 'plain') mountSkill('image'); }, options.selectedImageDelayMs);
  const aside = document.createElement('aside');
  for (const label of ['图像生成', '视频生成']) { const button = document.createElement('button'); button.textContent = label; button.addEventListener('click', (): void => { actions.push(`错误侧栏:${label}`); }); aside.append(button); }
  document.body.prepend(aside);
  if (hiddenMeasurement) {
    const hidden = document.createElement('div'); hidden.className = 'guidance-input-surface'; hidden.style.display = 'none'; hidden.append(document.createElement('textarea'));
    const skill = document.createElement('div'); skill.dataset.testid = 'skill_input_exit_button'; skill.textContent = '视频生成'; hidden.append(skill);
    for (const marker of ['video-model', 'video-generation-params-panel']) {
      const control = document.createElement('button'); control.dataset.inputEngineActionbarControlKey = marker; hidden.append(control);
    }
    document.body.prepend(hidden);
  }
  return { actions, view: {
    executeJavaScript: async (code: string): Promise<unknown> => runInNewContext(code, { document, window: page, HTMLElement: page.HTMLElement,
      PointerEvent: page.PointerEvent, MouseEvent: page.MouseEvent, setTimeout, Date }),
    getURL: (): string => 'https://www.doubao.com/chat/', loadURL: vi.fn(),
  } };
}

async function settled(work: Promise<boolean>): Promise<boolean> {
  let result: { value: boolean } | { error: unknown } | undefined;
  void work.then((value: boolean): void => { result = { value }; }, (error: unknown): void => { result = { error }; });
  for (let sample = 0; sample < 100 && !result; sample++) await vi.advanceTimersByTimeAsync(250);
  if (!result) throw new Error('TEST 模式入口超出正式有界期限');
  if ('error' in result) throw result.error;
  return result.value;
}

beforeEach((): void => { vi.useFakeTimers(); });
afterEach(async (): Promise<void> => { for (const page of pages.splice(0)) await page.happyDOM.abort(); vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('P4 narrow composer mode entry', (): void => {
  it('ignores the hidden measuring skill and parameter controls, then clicks the real visible video entry', async (): Promise<void> => {
    const test = fixture('plain', false, true);
    expect(await settled(clickAITab(test.view, 'video'))).toBe(true); expect(test.actions).toEqual(['视频生成']);
  });
  it('keeps an already selected video skill without toggling it off', async (): Promise<void> => {
    const test = fixture('video'); expect(await settled(clickAITab(test.view, 'video'))).toBe(true); expect(test.actions).toEqual([]);
  });
  it('exits the video skill before selecting image generation', async (): Promise<void> => {
    const test = fixture('video'); expect(await settled(clickAITab(test.view, 'image'))).toBe(true); expect(test.actions).toEqual(['视频生成', '图像生成']);
  });
  it('selects the current composer entry at x=167 and excludes the identically named sidebar', async (): Promise<void> => {
    const test = fixture('plain'); expect(await settled(clickAITab(test.view, 'image'))).toBe(true); expect(test.actions).toEqual(['图像生成']); expect(test.view.loadURL).not.toHaveBeenCalled();
  });
  it('opens the visible More control once to reveal the image skill entry', async (): Promise<void> => {
    const test = fixture('plain', true); expect(await settled(clickAITab(test.view, 'image'))).toBe(true); expect(test.actions).toEqual(['更多', '图像生成']);
  });
  it('waits for an image entry that mounts after the editor without repeated clicks', async (): Promise<void> => {
    const test = fixture('plain', false, false, { imageEntryDelayMs: 4000, moreDelayMs: 20_000 });
    expect(await settled(clickAITab(test.view, 'image'))).toBe(true); expect(test.actions).toEqual(['图像生成']);
  });
  it('waits for a delayed More control and expands it only once', async (): Promise<void> => {
    const test = fixture('plain', true, false, { moreDelayMs: 3000 });
    expect(await settled(clickAITab(test.view, 'image'))).toBe(true); expect(test.actions).toEqual(['更多', '图像生成']);
  });
  it('keeps a selected image skill restored during asynchronous composer rebuilding', async (): Promise<void> => {
    const test = fixture('plain', false, false, { imageEntryDelayMs: 20_000, moreDelayMs: 20_000, selectedImageDelayMs: 3000 });
    expect(await settled(clickAITab(test.view, 'image'))).toBe(true); expect(test.actions).toEqual([]);
  });
  it('stops after a bounded wait when the image entry never mounts and never retries More clicks', async (): Promise<void> => {
    const test = fixture('plain', true, false, { imageMissing: true });
    expect(await settled(clickAITab(test.view, 'image'))).toBe(false); expect(test.actions).toEqual(['更多']); expect(test.view.loadURL).not.toHaveBeenCalled();
  });
  it('点击图像入口但技能未真实选中时拒绝，不把单次点击视作成功', async (): Promise<void> => {
    const test = fixture('plain', false, false, { ignoreImageSelection: true });
    expect(await settled(clickAITab(test.view, 'image'))).toBe(false); expect(test.actions).toEqual(['图像生成']); expect(test.view.loadURL).not.toHaveBeenCalled();
  });
  it('exits the selected image skill, locates the remounted composer and selects video', async (): Promise<void> => {
    const test = fixture('image-skill'); expect(await settled(clickAITab(test.view, 'video'))).toBe(true); expect(test.actions).toEqual(['图像生成', '视频生成']);
  });
});
