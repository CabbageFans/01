import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

interface Viewport { x: number; y: number; scale: number }
interface StoredViewport { projectId: string; value: Viewport }
const initialViewport: Viewport = { x: 28, y: 24, scale: 0.8 };
const clampScale = (value: number): number => Math.max(0.18, Math.min(1.8, value));
const storageKey = (projectId: string): string => `petstory-canvas:${projectId}`;
const interactionSelector = 'article,button,input,textarea,select,details,video,[contenteditable="true"],.canvas-navigation';
const isInteractive = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest(interactionSelector);

function readViewport(projectId: string): Viewport {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(projectId)) || 'null') as Viewport | null;
    if (saved && [saved.x, saved.y, saved.scale].every(Number.isFinite)) return { ...saved, scale: clampScale(saved.scale) };
  } catch { /* 损坏或不可用的视角存储不影响项目。 */ }
  return { ...initialViewport };
}

export function usePetStoryCanvasViewport(projectId: string): {
  viewport: Viewport; viewportRef: React.RefObject<HTMLDivElement>; contentRef: React.RefObject<HTMLDivElement>;
  zoom: (factor: number, x?: number, y?: number) => void; fit: () => void; focus: (id: string) => void; reset: () => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerEnd: (event: React.PointerEvent<HTMLDivElement>) => void;
} {
  const [stored, setStored] = useState<StoredViewport>((): StoredViewport => ({ projectId, value: readViewport(projectId) }));
  const viewportRef = useRef<HTMLDivElement>(null); const contentRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; origin: Viewport } | null>(null);
  const viewport = stored.projectId === projectId ? stored.value : initialViewport;
  const update = useCallback((change: (value: Viewport) => Viewport): void => {
    setStored((old): StoredViewport => ({ projectId, value: change(old.projectId === projectId ? old.value : readViewport(projectId)) }));
  }, [projectId]);
  useEffect((): void => {
    drag.current = null;
    setStored((old): StoredViewport => old.projectId === projectId ? old : { projectId, value: readViewport(projectId) });
  }, [projectId]);
  useEffect((): void => {
    // 项目切换的首轮 render 仍可能带旧视角，不能写入新项目的 storage key。
    if (stored.projectId !== projectId) return;
    try { localStorage.setItem(storageKey(projectId), JSON.stringify(stored.value)); } catch { /* 视角保存失败不阻断内容保存。 */ }
  }, [projectId, stored]);
  const zoom = useCallback((factor: number, x?: number, y?: number): void => {
    const host = viewportRef.current; const px = x ?? (host?.clientWidth || 800) / 2; const py = y ?? (host?.clientHeight || 600) / 2;
    update((value): Viewport => {
      const scale = clampScale(value.scale * factor);
      return { x: px - (px - value.x) * scale / value.scale, y: py - (py - value.y) * scale / value.scale, scale };
    });
  }, [update]);
  useEffect(() => {
    const host = viewportRef.current; if (!host) return;
    const wheel = (event: WheelEvent): void => {
      if (isInteractive(event.target)) {
        // 编辑区内的普通滚动保留；缩放手势不交给 Chromium 整页缩放。
        if (event.ctrlKey || event.metaKey) event.preventDefault();
        return;
      }
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = host.getBoundingClientRect();
        zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - rect.left, event.clientY - rect.top);
      } else update((value): Viewport => ({ ...value, x: value.x - event.deltaX, y: value.y - event.deltaY }));
    };
    // React 的 wheel 委托可能为 passive，原生非 passive listener 才能可靠隔离页面缩放。
    host.addEventListener('wheel', wheel, { passive: false });
    return (): void => host.removeEventListener('wheel', wheel);
  }, [update, zoom]);
  const fit = useCallback((): void => {
    const host = viewportRef.current; const content = contentRef.current; if (!host || !content) return;
    const scale = Math.max(0.18, Math.min(1, (host.clientWidth - 56) / content.scrollWidth, (host.clientHeight - 56) / content.scrollHeight));
    update((): Viewport => ({ x: 28, y: 28, scale }));
  }, [update]);
  const focus = useCallback((id: string): void => {
    const row = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-shot-id]') || []).find((item): boolean => item.dataset.shotId === id);
    if (!row) return;
    const scale = Math.min(1, Math.max(0.8, (viewportRef.current?.clientWidth || 1000) / 1500));
    update((): Viewport => ({ x: 28 - 380 * scale, y: 60 - row.offsetTop * scale, scale }));
  }, [update]);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || isInteractive(event.target)) return;
    event.preventDefault(); // 空白拖动不启动浏览器文字选择，编辑区仍按原生交互处理。
    drag.current = { x: event.clientX, y: event.clientY, origin: viewport }; event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = drag.current; if (!current) return;
    update((): Viewport => ({ ...current.origin, x: current.origin.x + event.clientX - current.x, y: current.origin.y + event.clientY - current.y }));
  };
  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return { viewport, viewportRef, contentRef, zoom, fit, focus, reset: (): void => update((): Viewport => ({ x: 28, y: 24, scale: 1 })), onPointerDown, onPointerMove, onPointerEnd };
}
