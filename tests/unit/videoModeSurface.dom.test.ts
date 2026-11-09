/** 离线执行正式序列化脚本，复现视频技能切换的异步状态；不访问平台或发送生成请求。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickAITab } from '../../src/utils/doubaoBridge';
import type { CreationModeEntryDiagnostic, WebviewHandle } from '../../src/utils/doubaoBridge';

interface VideoSurfaceFixture {
  surface: HTMLElement;
  engine: HTMLElement;
  bar: HTMLElement;
  entry: HTMLButtonElement;
  entryClicks: ReturnType<typeof vi.fn>;
  modeClicks: ReturnType<typeof vi.fn>;
  view: WebviewHandle;
}

function addSelectedVideo(surface: HTMLElement): HTMLElement {
  const branch = document.createElement('div'); surface.append(branch);
  const selected = document.createElement('div'); selected.dataset.testid = 'skill_input_exit_button'; selected.textContent = '视频生成'; branch.append(selected);
  return selected;
}

function addVideoControls(engine: HTMLElement): void {
  const model = document.createElement('button'); model.dataset.inputEngineActionbarControlKey = 'video-model'; model.textContent = '模型 TEST';
  const parameters = document.createElement('button'); parameters.dataset.inputEngineActionbarRenderEntryKey = 'video-generation-params-panel'; parameters.textContent = '9:16 · 5s';
  engine.append(model, parameters);
}

function fixture(selectedDelayMs: number = 0): VideoSurfaceFixture {
  const surface = document.createElement('div'); surface.className = 'guidance-input-surface';
  const engine = document.createElement('div'); engine.id = 'input-engine-container'; engine.append(document.createElement('textarea'));
  const bar = document.createElement('div'); bar.dataset.testid = 'guidance-skill-bar';
  const entry = document.createElement('button'); entry.dataset.testid = 'skill_bar_button_video'; entry.textContent = '视频生成';
  bar.append(entry); surface.append(engine, bar); document.body.append(surface);
  let pending = true;
  const modeClicks = vi.fn((): void => { pending = false; });
  const entryClicks = vi.fn((): void => {
    bar.remove();
    // 直接技能入口启动后，模式触发器先于已选技能标记挂载；再次点击会中断原选择。
    const mode = document.createElement('button'); mode.dataset.validBtn = 'mode-select-action-btn'; mode.textContent = '模式';
    mode.addEventListener('click', modeClicks); engine.append(mode);
    if (selectedDelayMs) setTimeout((): void => { if (pending) addSelectedVideo(surface); }, selectedDelayMs);
    else addSelectedVideo(surface);
  });
  entry.addEventListener('click', entryClicks);
  const view: WebviewHandle = { executeJavaScript: vi.fn(async (code: string): Promise<unknown> => window.eval(code)),
    getURL: (): string => 'https://www.doubao.com/chat/', loadURL: vi.fn(), sendInputEvent: vi.fn() };
  return { surface, engine, bar, entry, entryClicks, modeClicks, view };
}

async function settled(work: Promise<boolean>): Promise<boolean> {
  let result: { value: boolean } | { error: unknown } | undefined;
  void work.then((value: boolean): void => { result = { value }; }, (error: unknown): void => { result = { error }; });
  for (let sample = 0; sample < 200 && !result; sample++) await vi.advanceTimersByTimeAsync(250);
  if (!result) throw new Error('TEST 视频模式切换超过正式有界期限');
  if ('error' in result) throw result.error;
  return result.value;
}

beforeEach((): void => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement): DOMRect {
    const editor = this.tagName === 'TEXTAREA';
    return { x: 167, y: editor ? 550 : 672, left: 167, top: editor ? 550 : 672, right: 767,
      bottom: editor ? 650 : 704, width: 600, height: editor ? 100 : 32, toJSON: (): object => ({}) };
  });
});
afterEach((): void => { document.body.replaceChildren(); vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('视频模式选择的单一状态与阶段边界', (): void => {
  it('直接技能冷激活三秒后选中，期间不点击新挂载的模式触发器', async (): Promise<void> => {
    const test = fixture(3000); const diagnostics: CreationModeEntryDiagnostic[] = [];
    expect(await settled(clickAITab(test.view, 'video', (diagnostic: CreationModeEntryDiagnostic): void => { diagnostics.push(diagnostic); }))).toBe(true);
    expect(test.entryClicks).toHaveBeenCalledOnce(); expect(test.modeClicks).not.toHaveBeenCalled();
    expect(test.surface.querySelector('[data-testid="skill_input_exit_button"]')?.textContent).toBe('视频生成');
    expect(diagnostics.at(-1)?.ready).toBe(true);
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('已选视频技能时模式阶段成功，模型参数尚未挂载交给后续参数阶段检查', async (): Promise<void> => {
    const test = fixture(); test.bar.remove();
    const selected = addSelectedVideo(test.surface); const exit = vi.fn(); selected.addEventListener('click', exit);
    expect(await settled(clickAITab(test.view, 'video'))).toBe(true);
    expect(exit).not.toHaveBeenCalled(); expect(test.entryClicks).not.toHaveBeenCalled(); expect(test.modeClicks).not.toHaveBeenCalled();
    expect(test.engine.querySelector('[data-input-engine-actionbar-control-key="video-model"]')).toBeNull();
  });

  it('普通输入区残留视频参数控件不冒充已选视频技能', async (): Promise<void> => {
    const test = fixture(); test.bar.remove(); addVideoControls(test.engine);
    expect(await settled(clickAITab(test.view, 'video'))).toBe(false);
    expect(test.surface.querySelector('[data-testid="skill_input_exit_button"]')).toBeNull();
    expect(test.entryClicks).not.toHaveBeenCalled(); expect(test.modeClicks).not.toHaveBeenCalled();
  });

  it('模式触发器通过明确关联的弹层选择视频，只打开一次并点击唯一选项', async (): Promise<void> => {
    const test = fixture(); test.bar.remove();
    const trigger = document.createElement('button'); trigger.dataset.validBtn = 'mode-select-action-btn'; trigger.textContent = '模式';
    trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-controls', 'TEST-video-mode-menu'); trigger.setAttribute('aria-expanded', 'false'); test.engine.append(trigger);
    const triggerClicks = vi.fn(); const optionClicks = vi.fn();
    trigger.addEventListener('click', (): void => {
      triggerClicks();
      const existing = document.getElementById('TEST-video-mode-menu');
      if (existing) { existing.remove(); trigger.setAttribute('aria-expanded', 'false'); return; }
      const menu = document.createElement('div'); menu.id = 'TEST-video-mode-menu'; menu.setAttribute('role', 'menu');
      const option = document.createElement('button'); option.setAttribute('role', 'menuitem'); option.textContent = '视频生成'; menu.append(option); document.body.append(menu);
      trigger.setAttribute('aria-expanded', 'true');
      option.addEventListener('click', (): void => { optionClicks(); menu.remove(); trigger.setAttribute('aria-expanded', 'false'); addSelectedVideo(test.surface); });
    });
    expect(await settled(clickAITab(test.view, 'video'))).toBe(true);
    expect(triggerClicks).toHaveBeenCalledOnce(); expect(optionClicks).toHaveBeenCalledOnce();
    expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('当前输入区出现两个同等有效的视频入口时拒绝，不按页面顺序猜选一个', async (): Promise<void> => {
    const test = fixture();
    const duplicate = document.createElement('button'); duplicate.dataset.testid = 'skill_bar_button_video_duplicate'; duplicate.textContent = '视频生成'; test.bar.append(duplicate);
    const duplicateClicks = vi.fn((): void => { addSelectedVideo(test.surface); }); duplicate.addEventListener('click', duplicateClicks);
    expect(await settled(clickAITab(test.view, 'video'))).toBe(false);
    expect(test.entryClicks).not.toHaveBeenCalled(); expect(duplicateClicks).not.toHaveBeenCalled();
  });

  it('同一输入区中既有的无关参数菜单不抢占正常视频技能入口', async (): Promise<void> => {
    const test = fixture();
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu');
    const option = document.createElement('button'); option.setAttribute('role', 'menuitem'); option.textContent = '5s'; menu.append(option); test.engine.append(menu);
    const parameterClicks = vi.fn(); option.addEventListener('click', parameterClicks);
    expect(await settled(clickAITab(test.view, 'video'))).toBe(true);
    expect(test.entryClicks).toHaveBeenCalledOnce(); expect(parameterClicks).not.toHaveBeenCalled(); expect(test.modeClicks).not.toHaveBeenCalled();
  });

  it('无关参数触发器的关联portal中同名选项不能代替真正的视频入口', async (): Promise<void> => {
    const test = fixture();
    const trigger = document.createElement('button'); trigger.dataset.inputEngineActionbarRenderEntryKey = 'video-generation-params-panel'; trigger.textContent = '参数';
    trigger.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-controls', 'TEST-unrelated-parameters'); test.engine.append(trigger);
    const menu = document.createElement('div'); menu.id = 'TEST-unrelated-parameters'; menu.setAttribute('role', 'menu');
    const option = document.createElement('button'); option.setAttribute('role', 'menuitem'); option.textContent = '视频生成'; menu.append(option); document.body.append(menu);
    const unrelatedClicks = vi.fn((): void => { addSelectedVideo(test.surface); }); option.addEventListener('click', unrelatedClicks);
    expect(await settled(clickAITab(test.view, 'video'))).toBe(true);
    expect(test.entryClicks).toHaveBeenCalledOnce(); expect(unrelatedClicks).not.toHaveBeenCalled(); expect(test.modeClicks).not.toHaveBeenCalled();
  });

  it('其他区域的同名文字和未关联菜单都不能成为本次模式入口', async (): Promise<void> => {
    const test = fixture(); test.bar.remove();
    const aside = document.createElement('aside'); const sideButton = document.createElement('button'); sideButton.textContent = '视频生成'; aside.append(sideButton); document.body.prepend(aside);
    const menu = document.createElement('div'); menu.setAttribute('role', 'menu'); const menuButton = document.createElement('button'); menuButton.setAttribute('role', 'menuitem'); menuButton.textContent = '视频生成'; menu.append(menuButton); document.body.append(menu);
    const sideClicks = vi.fn(); const menuClicks = vi.fn(); sideButton.addEventListener('click', sideClicks); menuButton.addEventListener('click', menuClicks);
    expect(await settled(clickAITab(test.view, 'video'))).toBe(false);
    expect(sideClicks).not.toHaveBeenCalled(); expect(menuClicks).not.toHaveBeenCalled();
  });
});
