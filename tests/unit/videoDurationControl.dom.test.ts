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
  container?.remove(); root = undefined; container = undefined; keyEvents.length = 0; vi.restoreAllMocks();
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
    expect(await setVideoDurationFromPage(10, Date.now() + 500)).toEqual({});
    mountSlider({ count: 2 }); expect(await setVideoDurationFromPage(10, Date.now() + 500)).toEqual({}); expect(keyEvents).toEqual([]);
  });

  it('禁用的真实滑条保留定位供最终回读，但不派发按键', async (): Promise<void> => {
    mountSlider({ disabled: true }); expect(await setVideoDurationFromPage(10, Date.now() + 500)).toEqual({ position: '150,75' }); expect(keyEvents).toEqual([]);
  });

  it('控件不响应时到截止即停，不补发 Home 或增加步数', async (): Promise<void> => {
    mountSlider({ ignoreKeys: true }); expect(await setVideoDurationFromPage(10, Date.now() + 80)).toEqual({ position: '150,75' }); expect(keyEvents).toEqual(['Home']);
  });

  it('截止或参数无效时不触碰滑条', async (): Promise<void> => {
    mountSlider(); expect(await setVideoDurationFromPage(10, Date.now() - 1)).toEqual({}); expect(await setVideoDurationFromPage(16, Date.now() + 500)).toEqual({}); expect(keyEvents).toEqual([]);
  });
});
