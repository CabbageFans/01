import React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setVideoDurationFromPage } from '../../src/utils/videoDurationControl';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const keyEvents: string[] = [];

/** 普通受控 state 刻意使用 value + 1，确保同步连发确实会复用旧 render。 */
function mountSlider(options: { count?: number; disabled?: boolean; ignoreKeys?: boolean; remount?: boolean } = {}): HTMLElement {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  const Slider: React.FC = (): React.ReactElement => {
    const [value, setValue] = React.useState(7);
    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
      keyEvents.push(event.key);
      if (options.ignoreKeys) return;
      if (event.key === 'Home') setValue(0);
      if (event.key === 'ArrowRight') setValue(Math.min(11, value + 1));
    };
    return React.createElement('div', { key: options.remount ? value : undefined, role: 'slider', 'aria-label': '视频时长', 'aria-valuemin': '0', 'aria-valuemax': '11', 'aria-valuenow': String(value), 'aria-disabled': options.disabled ? 'true' : undefined, onKeyDown });
  };
  flushSync((): void => { root!.render(React.createElement(React.Fragment, null, ...Array.from({ length: options.count ?? 1 }, (_, index): React.ReactElement => React.createElement(Slider, { key: index })))); });
  for (const element of container.querySelectorAll<HTMLElement>('[role="slider"]')) geometry(element);
  return container.querySelector<HTMLElement>('[role="slider"]')!;
}

function geometry(element: HTMLElement): void {
  Object.defineProperty(element, 'offsetParent', { configurable: true, get: (): HTMLElement => document.body });
  element.getBoundingClientRect = (): DOMRect => ({ x: 50, y: 60, left: 50, top: 60, right: 250, bottom: 90, width: 200, height: 30, toJSON: (): object => ({}) });
}

afterEach((): void => {
  if (root) flushSync((): void => root!.unmount());
  container?.remove(); document.body.replaceChildren(); root = undefined; container = undefined; keyEvents.length = 0; vi.restoreAllMocks();
});

describe('视频时长逐键等待真实 React 回读', (): void => {
  it('同步连发会复用旧值，复现本次修复的批处理故障', async (): Promise<void> => {
    const slider = mountSlider();
    const press = (key: string): void => { slider.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true })); };
    press('Home'); for (let index = 0; index < 6; index++) press('ArrowRight');
    await new Promise<void>((resolve): void => { setTimeout(resolve, 25); });
    expect(slider.getAttribute('aria-valuenow')).toBe('8');
  });

  it.each([4, 5, 10, 15])('%s 秒按每次实际状态步进，不使用焦点或原生输入', async (seconds): Promise<void> => {
    const slider = mountSlider(); const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const raf = vi.spyOn(window, 'requestAnimationFrame'); const native = vi.fn();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { sendInputEvent: native } });
    expect(await setVideoDurationFromPage(seconds, Date.now() + 1500)).toEqual({ position: '150,75' });
    expect(slider.getAttribute('aria-valuenow')).toBe(String(seconds - 4));
    expect(keyEvents).toEqual(['Home', ...Array.from({ length: seconds - 4 }, (): string => 'ArrowRight')]);
    expect(focus).not.toHaveBeenCalled(); expect(raf).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
  });

  it('同一语义滑条因 React 重新挂载后仍重新定位回读', async (): Promise<void> => {
    mountSlider({ remount: true });
    const observer = new MutationObserver((): void => { for (const element of container!.querySelectorAll<HTMLElement>('[role="slider"]')) geometry(element); });
    observer.observe(container!, { childList: true, subtree: true });
    try {
      expect(await setVideoDurationFromPage(10, Date.now() + 1500)).toEqual({ position: '150,75' });
      expect(container!.querySelector('[role="slider"]')!.getAttribute('aria-valuenow')).toBe('6');
    } finally { observer.disconnect(); }
  });

  it('没有滑条或出现多个可见滑条时不派发按键', async (): Promise<void> => {
    expect(await setVideoDurationFromPage(10, Date.now() + 500)).toMatchObject({ verified: false, failureReason: 'menu_not_open' });
    mountSlider({ count: 2 }); expect(await setVideoDurationFromPage(10, Date.now() + 500)).toMatchObject({ verified: false, failureReason: 'ambiguous' }); expect(keyEvents).toEqual([]);
  });

  it('禁用的真实滑条保留定位供最终回读，但不派发按键', async (): Promise<void> => {
    mountSlider({ disabled: true }); expect(await setVideoDurationFromPage(10, Date.now() + 500)).toEqual({ position: '150,75', verified: false, failureReason: 'disabled' }); expect(keyEvents).toEqual([]);
  });

  it('控件不响应时到截止即停，不补发 Home 或增加步数', async (): Promise<void> => {
    mountSlider({ ignoreKeys: true }); expect(await setVideoDurationFromPage(10, Date.now() + 80)).toEqual({ position: '150,75', verified: false, failureReason: 'value_not_applied' }); expect(keyEvents).toEqual(['Home']);
  });

  it('截止或参数无效时不触碰滑条', async (): Promise<void> => {
    mountSlider(); expect(await setVideoDurationFromPage(10, Date.now() - 1)).toEqual({}); expect(await setVideoDurationFromPage(16, Date.now() + 500)).toEqual({}); expect(keyEvents).toEqual([]);
  });
});

interface PopupFixture { trigger: HTMLButtonElement; menu: HTMLDivElement; control: HTMLElement; events: string[] }
function mountPopup(options: { native?: boolean; min?: number; max?: number; ignore?: boolean; changeIdentity?: boolean } = {}): PopupFixture {
  const min = options.min ?? 4; const max = options.max ?? 15;
  const composer = document.createElement('div'); composer.id = 'input-engine-container'; geometry(composer);
  const trigger = document.createElement('button'); trigger.setAttribute('data-creation-params-panel-id', 'TEST'); trigger.setAttribute('aria-controls', 'TEST-duration-popup'); trigger.textContent = '9:16 · 10s'; geometry(trigger); composer.append(trigger); document.body.append(composer);
  const menu = document.createElement('div'); menu.id = 'TEST-duration-popup'; menu.setAttribute('role', 'menu'); geometry(menu); document.body.append(menu);
  const control = document.createElement(options.native ? 'input' : 'div'); const events: string[] = [];
  control.id = 'TEST-duration'; geometry(control);
  if (control instanceof HTMLInputElement) {
    control.type = 'range'; control.min = String(min); control.max = String(max); control.step = '1'; control.value = String(min === 0 ? 6 : 10);
    control.addEventListener('input', (): void => { events.push('input'); if (options.changeIdentity) control.id = 'TEST-replaced'; });
  } else {
    control.setAttribute('role', 'slider'); control.setAttribute('aria-label', '视频时长'); control.setAttribute('aria-valuemin', String(min)); control.setAttribute('aria-valuemax', String(max)); control.setAttribute('aria-valuenow', String(min === 0 ? 6 : 10));
    control.addEventListener('keydown', (event: Event): void => {
      const key = (event as KeyboardEvent).key; events.push(key); if (options.ignore) return;
      const previous = Number(control.getAttribute('aria-valuenow'));
      setTimeout((): void => { if (options.changeIdentity) control.id = 'TEST-replaced'; control.setAttribute('aria-valuenow', String(key === 'Home' ? min : Math.min(max, previous + 1))); }, 0);
    });
  }
  menu.append(control); return { trigger, menu, control, events };
}

describe('当前参数浮层中的原生与语义时长滑条', (): void => {
  it.each([
    { native: true, min: 0, max: 11 }, { native: true, min: 4, max: 15 },
    { native: false, min: 0, max: 11 }, { native: false, min: 4, max: 15 },
  ])('正确设置 $native 原生、$min..$max 声明的5秒，并跨宏任务回读', async (options): Promise<void> => {
    const page = mountPopup(options); const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    expect(await setVideoDurationFromPage(5, Date.now() + 1000)).toEqual({ position: '150,75', verified: true });
    const value = page.control instanceof HTMLInputElement ? page.control.value : page.control.getAttribute('aria-valuenow');
    expect(value).toBe(options.min === 0 ? '1' : '5'); expect(page.events).toEqual(options.native ? ['input'] : ['Home', 'ArrowRight']); expect(focus).not.toHaveBeenCalled();
  });

  it('已展开的新参数菜单优先，页面其他0..11滑条不冒充当前视频时长', async (): Promise<void> => {
    const page = mountPopup({ native: true }); const unrelated = document.createElement('div');
    unrelated.setAttribute('role', 'slider'); unrelated.setAttribute('aria-valuemin', '0'); unrelated.setAttribute('aria-valuemax', '11'); unrelated.setAttribute('aria-valuenow', '6'); geometry(unrelated); document.body.append(unrelated);
    const keys = vi.fn(); unrelated.addEventListener('keydown', keys);
    expect(await setVideoDurationFromPage(5, Date.now() + 1000)).toMatchObject({ verified: true }); expect((page.control as HTMLInputElement).value).toBe('5'); expect(keys).not.toHaveBeenCalled();
  });

  it('隐藏重复滑条排除；可见重复返回ambiguous且不输入', async (): Promise<void> => {
    const page = mountPopup({ native: true }); const duplicate = page.control.cloneNode(true) as HTMLInputElement; geometry(duplicate); duplicate.style.display = 'none'; page.menu.append(duplicate);
    expect(await setVideoDurationFromPage(5, Date.now() + 1000)).toMatchObject({ verified: true }); page.events.length = 0;
    duplicate.style.display = 'block'; expect(await setVideoDurationFromPage(10, Date.now() + 500)).toMatchObject({ verified: false, failureReason: 'ambiguous' }); expect(page.events).toEqual([]);
  });

  it('菜单关闭、空data-disabled和不受支持的范围在输入前分别停止', async (): Promise<void> => {
    const page = mountPopup({ native: true }); page.menu.style.display = 'none';
    expect(await setVideoDurationFromPage(5, Date.now() + 500)).toMatchObject({ verified: false, failureReason: 'menu_not_open' }); page.menu.style.display = 'block'; page.menu.setAttribute('data-disabled', '');
    expect(await setVideoDurationFromPage(5, Date.now() + 500)).toMatchObject({ verified: false, failureReason: 'disabled' }); page.menu.removeAttribute('data-disabled'); (page.control as HTMLInputElement).min = '1';
    expect(await setVideoDurationFromPage(5, Date.now() + 500)).toMatchObject({ verified: false, failureReason: 'not_found' }); expect(page.events).toEqual([]);
  });

  it('受控语义滑条不响应时有界停止并给出value_not_applied', async (): Promise<void> => {
    const page = mountPopup({ ignore: true }); expect(await setVideoDurationFromPage(5, Date.now() + 80)).toMatchObject({ verified: false, failureReason: 'value_not_applied' }); expect(page.events).toEqual(['Home']);
  });

  it.each([false, true])('输入后语义身份改变时不会继续调节其他控件（原生=%s）', async (native: boolean): Promise<void> => {
    const page = mountPopup({ native, changeIdentity: true }); expect(await setVideoDurationFromPage(5, Date.now() + 500)).toMatchObject({ verified: false, failureReason: 'changed' }); expect(page.events).toEqual(native ? ['input'] : ['Home']);
  });
});
