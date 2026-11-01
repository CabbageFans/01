/** 视口存储与 ResizeObserver 的离线真实 Hook 回归；不计作 Electron 尺寸验收。 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePetStoryCanvasViewport } from '../../src/components/usePetStoryCanvasViewport';
import type { CanvasViewport } from '../../src/components/usePetStoryCanvasViewport';

const projectId = 'TEST-viewport-persistence';
const key = `petstory-canvas:${projectId}`;
let size: { width: number; height: number };
let resize: () => void;
const Harness: React.FC<{ revision?: number }> = ({ revision }): React.ReactElement => {
  const view = usePetStoryCanvasViewport(projectId);
  return <div data-revision={revision}><div className="TEST-viewport" ref={view.viewportRef}><div ref={view.contentRef}><div data-shot-id="TEST-shot" /></div></div><output>{JSON.stringify(view.viewport)}</output><button type="button" onClick={(): void => view.focus('TEST-shot')}>定位</button></div>;
};
function viewport(): CanvasViewport { return JSON.parse(screen.getByRole('status').textContent || '{}') as CanvasViewport; }
function saved(): CanvasViewport & { viewportWidth: number; viewportHeight: number } { return JSON.parse(localStorage.getItem(key) || '{}') as CanvasViewport & { viewportWidth: number; viewportHeight: number }; }
beforeEach((): void => {
  localStorage.removeItem(key); size = { width: 1174, height: 760 }; resize = (): void => undefined;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement): number { return this.className === 'TEST-viewport' ? size.width : 0; });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement): number { return this.className === 'TEST-viewport' ? size.height : 0; });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = (): void => callback([], this as unknown as ResizeObserver); }
    observe(): void { /* 测试由 resize 显式驱动。 */ }
    disconnect(): void { /* 无外部 observer。 */ }
  });
});
afterEach((): void => { localStorage.removeItem(key); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('保存视角附带视口尺寸', (): void => {
  it('跨窗口重开及后续resize保留世界中心，普通结果回填不重置', (): void => {
    const original = { x: -260, y: -145, scale: 0.752199 };
    localStorage.setItem(key, JSON.stringify({ ...original, viewportWidth: 1026, viewportHeight: 660 }));
    const first = render(<Harness revision={1} />); act((): void => resize());
    expect(viewport()).toEqual({ ...original, x: original.x + 74, y: original.y + 50 });
    expect(saved()).toMatchObject({ viewportWidth: 1174, viewportHeight: 760 });
    const centered = viewport(); first.rerender(<Harness revision={2} />); expect(viewport()).toEqual(centered);
    first.unmount(); size = { width: 1026, height: 660 };
    render(<Harness revision={3} />); act((): void => resize());
    expect(viewport()).toEqual(original);
    act((): void => { size = { width: 900, height: 600 }; resize(); });
    const smaller = viewport();
    expect((size.width / 2 - smaller.x) / smaller.scale).toBeCloseTo((1026 / 2 - original.x) / original.scale);
    expect((size.height / 2 - smaller.y) / smaller.scale).toBeCloseTo((660 / 2 - original.y) / original.scale);
    expect(saved()).toMatchObject({ viewportWidth: 900, viewportHeight: 600 });
  });

  it('legacy纯坐标原样恢复并补存尺寸，后续定位继续保存当前视口尺寸', (): void => {
    const original = { x: -310, y: 55, scale: 0.85 };
    localStorage.setItem(key, JSON.stringify(original)); render(<Harness />); act((): void => resize());
    expect(viewport()).toEqual(original); expect(saved()).toMatchObject({ ...original, viewportWidth: 1174, viewportHeight: 760 });
    fireEvent.click(screen.getByRole('button', { name: '定位' }));
    expect(saved()).toMatchObject({ viewportWidth: 1174, viewportHeight: 760 });
  });
});
