import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

export interface CanvasViewport { x: number; y: number; scale: number }
interface CanvasViewportSize { width: number; height: number }
interface CanvasViewportSnapshot { value: CanvasViewport; size?: CanvasViewportSize }
interface StoredViewport extends CanvasViewportSnapshot { projectId: string }
interface SavedViewport extends CanvasViewport { viewportWidth?: number; viewportHeight?: number }
export interface CanvasBounds { x: number; y: number; width: number; height: number }
const initialViewport: CanvasViewport = { x: 0, y: 0, scale: 1 };
const clampScale = (value: number): number => Math.max(0.45, Math.min(1.8, value));
const storageKey = (projectId: string): string => `petstory-canvas:${projectId}`;
const interactionSelector = 'article,button,input,textarea,select,details,video,[contenteditable="true"],.canvas-navigation';
const isInteractive = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest(interactionSelector);

function readViewport(projectId: string): CanvasViewportSnapshot | null {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(projectId)) || 'null') as SavedViewport | null;
    if (!saved || ![saved.x, saved.y, saved.scale].every(Number.isFinite)) return null;
    const size = saved.viewportWidth && saved.viewportHeight && [saved.viewportWidth, saved.viewportHeight].every((value): boolean => Number.isFinite(value) && value > 0)
      ? { width: saved.viewportWidth, height: saved.viewportHeight } : undefined;
    // 旧版把未操作过的固定初始值也写入存储；带新尺寸的用户视角始终保留。
    if (!size && saved.x === 28 && saved.y === 24 && saved.scale === 0.8) return null;
    return { value: { x: saved.x, y: saved.y, scale: clampScale(saved.scale) }, ...(size ? { size } : {}) };
  } catch { /* 损坏或不可用的视角存储不影响项目。 */ }
  return null;
}

/** 适应当前镜头的实际横向节点，保留可读比例；长项目不按总高度缩成缩略图。 */
export function frameCanvasBounds(bounds: CanvasBounds, width: number, height: number): CanvasViewport {
  const padding = 24;
  const scale = Math.max(0.72, Math.min(1, (width - padding * 2) / Math.max(bounds.width, 1)));
  const availableHeight = Math.max(1, height - 100);
  const top = 44 + Math.max(0, (availableHeight - bounds.height * scale) / 2);
  return { x: (width - bounds.width * scale) / 2 - bounds.x * scale, y: top - bounds.y * scale, scale };
}

export function usePetStoryCanvasViewport(projectId: string): {
  viewport: CanvasViewport; viewportRef: React.RefObject<HTMLDivElement>; contentRef: React.RefObject<HTMLDivElement>;
  zoom: (factor: number, x?: number, y?: number) => void; fit: () => void; focus: (id: string) => void; reset: () => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerEnd: (event: React.PointerEvent<HTMLDivElement>) => void;
} {
  const [stored, setStored] = useState<StoredViewport>((): StoredViewport => ({ projectId, ...(readViewport(projectId) || { value: initialViewport }) }));
  const viewportRef = useRef<HTMLDivElement>(null); const contentRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; origin: CanvasViewport } | null>(null);
  const interacted = useRef(!!readViewport(projectId));
  const focusedId = useRef('');
  const viewport = stored.projectId === projectId ? stored.value : initialViewport;
  const latestViewport = useRef(viewport); latestViewport.current = viewport;
  const update = useCallback((change: (value: CanvasViewport) => CanvasViewport): void => {
    const host = viewportRef.current;
    const size = host?.clientWidth && host.clientHeight ? { width: host.clientWidth, height: host.clientHeight } : undefined;
    setStored((old): StoredViewport => {
      const snapshot = old.projectId === projectId ? old : readViewport(projectId) || { value: initialViewport };
      return { projectId, value: change(snapshot.value), size: size || snapshot.size };
    });
  }, [projectId]);
  const boundsForRow = useCallback((id?: string): CanvasBounds | undefined => {
    const content = contentRef.current; if (!content) return undefined;
    const rows = Array.from(content.querySelectorAll<HTMLElement>('[data-shot-id]'));
    const row = rows.find((item): boolean => item.dataset.shotId === (id || focusedId.current)) || rows[0];
    if (!row) return undefined;
    const root = content.getBoundingClientRect(); const actual = row.getBoundingClientRect();
    const scale = latestViewport.current.scale;
    return { x: (actual.left - root.left) / scale, y: (actual.top - root.top) / scale, width: actual.width / scale, height: actual.height / scale };
  }, []);
  const frame = useCallback((id?: string): void => {
    const host = viewportRef.current; const bounds = boundsForRow(id);
    if (!host || !bounds || !host.clientWidth || !host.clientHeight) return;
    if (id) focusedId.current = id;
    update((): CanvasViewport => frameCanvasBounds(bounds, host.clientWidth, host.clientHeight));
  }, [boundsForRow, update]);
  useEffect((): void => {
    drag.current = null; focusedId.current = ''; interacted.current = !!readViewport(projectId);
    setStored((old): StoredViewport => old.projectId === projectId ? old : { projectId, ...(readViewport(projectId) || { value: initialViewport }) });
  }, [projectId]);
  useEffect(() => {
    const host = viewportRef.current; if (!host) return;
    const savedSize = readViewport(projectId)?.size;
    let previous = savedSize || { width: host.clientWidth, height: host.clientHeight };
    let hasSize = !!savedSize;
    const resize = (): void => {
      const width = host.clientWidth; const height = host.clientHeight;
      if (!width || !height) return;
      if (!interacted.current) frame();
      else if (previous.width && previous.height && (previous.width !== width || previous.height !== height)) {
        // 辅助浏览器或窗口改变尺寸时保留用户当前看的世界中心，不因结果保存重置视角。
        const deltaX = (width - previous.width) / 2; const deltaY = (height - previous.height) / 2;
        update((value): CanvasViewport => ({ ...value, x: value.x + deltaX, y: value.y + deltaY }));
      } else if (!hasSize && interacted.current) {
        // 旧存储没有窗口尺寸时原样恢复坐标，首次获得可用视口后补存尺寸。
        update((value): CanvasViewport => value);
      }
      previous = { width, height }; hasSize = true;
    };
    const observer = new ResizeObserver(resize); observer.observe(host);
    const animation = requestAnimationFrame(resize);
    return (): void => { observer.disconnect(); cancelAnimationFrame(animation); };
  }, [projectId, frame, update]);
  useEffect((): void => {
    if (stored.projectId !== projectId || !interacted.current) return;
    try { localStorage.setItem(storageKey(projectId), JSON.stringify({ ...stored.value, ...(stored.size ? { viewportWidth: stored.size.width, viewportHeight: stored.size.height } : {}) })); } catch { /* 视角保存失败不阻断内容保存。 */ }
  }, [projectId, stored]);
  const zoom = useCallback((factor: number, x?: number, y?: number): void => {
    const host = viewportRef.current; const px = x ?? (host?.clientWidth || 800) / 2; const py = y ?? (host?.clientHeight || 600) / 2;
    interacted.current = true;
    update((value): CanvasViewport => {
      const scale = clampScale(value.scale * factor);
      return { x: px - (px - value.x) * scale / value.scale, y: py - (py - value.y) * scale / value.scale, scale };
    });
  }, [update]);
  useEffect(() => {
    const host = viewportRef.current; if (!host) return;
    const wheel = (event: WheelEvent): void => {
      if (isInteractive(event.target)) { if (event.ctrlKey || event.metaKey) event.preventDefault(); return; }
      event.preventDefault(); interacted.current = true;
      if (event.ctrlKey || event.metaKey) {
        const rect = host.getBoundingClientRect();
        zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - rect.left, event.clientY - rect.top);
      } else update((value): CanvasViewport => ({ ...value, x: value.x - event.deltaX, y: value.y - event.deltaY }));
    };
    host.addEventListener('wheel', wheel, { passive: false });
    return (): void => host.removeEventListener('wheel', wheel);
  }, [update, zoom]);
  const fit = useCallback((): void => { interacted.current = true; frame(); }, [frame]);
  const focus = useCallback((id: string): void => { interacted.current = true; frame(id); }, [frame]);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || isInteractive(event.target)) return;
    event.preventDefault(); interacted.current = true;
    drag.current = { x: event.clientX, y: event.clientY, origin: viewport }; event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = drag.current; if (!current) return;
    update((): CanvasViewport => ({ ...current.origin, x: current.origin.x + event.clientX - current.x, y: current.origin.y + event.clientY - current.y }));
  };
  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return { viewport, viewportRef, contentRef, zoom, fit, focus, reset: fit, onPointerDown, onPointerMove, onPointerEnd };
}
