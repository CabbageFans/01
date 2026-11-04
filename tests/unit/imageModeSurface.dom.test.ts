/** 复现真实页面的 surface > engine + skill-bar 兄弟结构，执行实际序列化脚本。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickAITab, readPetStoryComposer, type CreationModeEntryDiagnostic, type WebviewHandle } from '../../src/utils/doubaoBridge';

interface SurfaceFixture {
  surface: HTMLElement;
  engine: HTMLElement;
  image: HTMLButtonElement;
  more: HTMLButtonElement;
  imageClicks: ReturnType<typeof vi.fn>;
  sidebarClicks: ReturnType<typeof vi.fn>;
  modeClicks: ReturnType<typeof vi.fn>;
  view: WebviewHandle;
}

function fixture(options: { selectedDelayMs?: number } = {}): SurfaceFixture {
  const sidebar = document.createElement('aside');
  const sidebarImage = document.createElement('button'); sidebarImage.textContent = '图像生成'; sidebar.append(sidebarImage); document.body.append(sidebar);
  const sidebarClicks = vi.fn(); sidebarImage.addEventListener('click', sidebarClicks);
  const surface = document.createElement('div'); surface.className = 'guidance-input-surface';
  const engine = document.createElement('div'); engine.id = 'input-engine-container';
  const editorWrapper = document.createElement('div');
  const editor = document.createElement('textarea');
  const upload = document.createElement('input'); upload.type = 'file'; upload.accept = 'image/*'; upload.style.display = 'none';
  editorWrapper.append(editor, upload); engine.append(editorWrapper);
  const bar = document.createElement('div'); bar.dataset.testid = 'guidance-skill-bar';
  const image = document.createElement('button'); image.dataset.testid = 'skill_bar_button_3'; image.textContent = '图像生成';
  const more = document.createElement('button'); more.dataset.testid = 'skill_bar_button_more'; more.textContent = '更多';
  bar.append(image, more); surface.append(engine, bar); document.body.append(surface);
  let selectionPending = true;
  const modeClicks = vi.fn((): void => { selectionPending = false; });
  const imageClicks = vi.fn((): void => {
    bar.remove();
    const parameters = document.createElement('button'); parameters.dataset.validBtn = 'mode-select-action-btn'; parameters.textContent = '模式'; parameters.addEventListener('click', modeClicks); engine.append(parameters);
    // 真实技能退出控件在 surface 的另一分支，不属于 engine 的任何祖先层。
    const mountSelected = (): void => {
      if (!selectionPending) return;
      const selectedBranch = document.createElement('div'); surface.append(selectedBranch);
      let parent = selectedBranch;
      for (let depth = 0; depth < 8; depth++) { const wrapper = document.createElement('div'); parent.append(wrapper); parent = wrapper; }
      const selected = document.createElement('div'); selected.dataset.testid = 'skill_input_exit_button'; selected.textContent = '图像生成'; parent.append(selected);
    };
    if (options.selectedDelayMs) setTimeout(mountSelected, options.selectedDelayMs);
    else mountSelected();
  });
  image.addEventListener('click', imageClicks);
  const view: WebviewHandle = { executeJavaScript: vi.fn(async (code: string): Promise<unknown> => window.eval(code)), getURL: (): string => 'https://www.doubao.com/chat/', loadURL: vi.fn(), sendInputEvent: vi.fn() };
  return { surface, engine, image, more, imageClicks, sidebarClicks, modeClicks, view };
}

beforeEach((): void => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement): DOMRect {
    const editor = this.tagName === 'TEXTAREA';
    const button = this.tagName === 'BUTTON' || this.dataset.testid === 'skill_input_exit_button';
    const left = this.closest('aside') ? 8 : 167;
    return { left, x: left, right: left + (button ? 120 : 600), top: editor ? 550 : 672, y: editor ? 550 : 672,
      bottom: editor ? 650 : 704, width: button ? 120 : 600, height: editor ? 100 : 32, toJSON: (): object => ({}) };
  });
});
afterEach((): void => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('真实兄弟分支图片技能输入区', (): void => {
  it('定位共同surface中的图像入口，点击后识别engine外的已选技能，两个探针保持一致', async (): Promise<void> => {
    const test = fixture(); const diagnostics: CreationModeEntryDiagnostic[] = [];
    expect(test.engine.children.length).toBe(1); expect(test.surface.children.length).toBe(2);
    expect(test.engine.contains(test.image)).toBe(false); expect(test.engine.contains(test.more)).toBe(false);
    expect(test.surface.contains(test.image)).toBe(true); expect(test.image.getAttribute('aria-controls')).toBeNull();
    expect(await readPetStoryComposer(test.view)).toMatchObject({ present: true, generic: true, selectedSkill: 'none' });
    const selected = clickAITab(test.view, 'image', (value: CreationModeEntryDiagnostic): void => { diagnostics.push(value); });
    await vi.advanceTimersByTimeAsync(500); expect(await selected).toBe(true);
    expect(test.engine.children.length).toBe(2);
    const exit = test.surface.querySelector('[data-testid="skill_input_exit_button"]');
    expect(exit).not.toBeNull(); expect(exit?.closest('#input-engine-container')).toBeNull();
    expect(await readPetStoryComposer(test.view)).toMatchObject({ present: true, generic: true, selectedSkill: 'image', count: 0 });
    expect(test.imageClicks).toHaveBeenCalledOnce(); expect(test.sidebarClicks).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([expect.objectContaining({ ready: true, method: 'button-near-textarea-image-verified' })]);
    expect(diagnostics[0].elapsedMs).toBeLessThanOrEqual(500);
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('已选图像技能位于engine外时保持原位，不再次点击入口或退出技能', async (): Promise<void> => {
    const test = fixture(); test.image.click();
    const first = test.imageClicks.mock.calls.length;
    const selected = clickAITab(test.view, 'image'); await vi.advanceTimersByTimeAsync(500);
    expect(await selected).toBe(true); expect(test.imageClicks).toHaveBeenCalledTimes(first);
    expect(await readPetStoryComposer(test.view)).toMatchObject({ selectedSkill: 'image' });
    expect(test.sidebarClicks).not.toHaveBeenCalled();
  });

  it('直接技能入口冷激活后等待异步重建，全程不点击新挂载的mode-trigger', async (): Promise<void> => {
    const test = fixture({ selectedDelayMs: 3000 }); const completed = vi.fn();
    const selected = clickAITab(test.view, 'image').then((ready: boolean): boolean => { completed(); return ready; });
    await vi.advanceTimersByTimeAsync(1750);
    expect(completed).not.toHaveBeenCalled(); expect(test.modeClicks).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1750);
    expect(await selected).toBe(true); expect(test.modeClicks).not.toHaveBeenCalled();
    expect(test.imageClicks).toHaveBeenCalledOnce();
    expect(await readPetStoryComposer(test.view)).toMatchObject({ selectedSkill: 'image' });
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('带模式触发器标记的入口直接选中图片时只读确认，不强求不存在的菜单', async (): Promise<void> => {
    const test = fixture({ selectedDelayMs: 3000 });
    test.image.dataset.validBtn = 'mode-select-action-btn';
    const selected = clickAITab(test.view, 'image');
    await vi.advanceTimersByTimeAsync(3750);
    expect(await selected).toBe(true);
    expect(test.imageClicks).toHaveBeenCalledOnce(); expect(test.modeClicks).not.toHaveBeenCalled();
    expect(await readPetStoryComposer(test.view)).toMatchObject({ selectedSkill: 'image' });
    expect(test.sidebarClicks).not.toHaveBeenCalled();
  });

  it('多个真实可见surface时两个探针都拒绝归属，不点击任一同名入口', async (): Promise<void> => {
    const first = fixture(); const second = fixture(); const diagnostics: CreationModeEntryDiagnostic[] = [];
    expect(await readPetStoryComposer(first.view)).toMatchObject({ present: false });
    const selected = clickAITab(first.view, 'image', (value: CreationModeEntryDiagnostic): void => { diagnostics.push(value); });
    await vi.advanceTimersByTimeAsync(10_000); expect(await selected).toBe(false);
    expect(first.imageClicks).not.toHaveBeenCalled(); expect(second.imageClicks).not.toHaveBeenCalled();
    expect(first.sidebarClicks).not.toHaveBeenCalled(); expect(second.sidebarClicks).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([expect.objectContaining({ ready: false, reason: '图像生成模式入口未在等待窗口内挂载' })]);
  });

  it('隐藏的旧surface不制造归属歧义，诊断回调异常不改变真实选中结果', async (): Promise<void> => {
    const test = fixture(); const hidden = fixture(); hidden.surface.style.display = 'none';
    const selected = clickAITab(test.view, 'image', (): never => { throw new Error('TEST diagnostic sink unavailable'); });
    await vi.advanceTimersByTimeAsync(500); expect(await selected).toBe(true);
    expect(test.imageClicks).toHaveBeenCalledOnce(); expect(hidden.imageClicks).not.toHaveBeenCalled();
    expect(await readPetStoryComposer(test.view)).toMatchObject({ present: true, selectedSkill: 'image' });
  });
});
