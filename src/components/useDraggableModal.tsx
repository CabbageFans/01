import React from 'react';

interface Position { x: number; y: number }
interface DragState { pointerId: number; start: Position; origin: Position; min: Position; max: Position }
interface DraggableModal {
  titleProps: React.HTMLAttributes<HTMLDivElement>;
  modalRender: (modal: React.ReactNode) => React.ReactElement;
  afterOpenChange: (shown: boolean) => void;
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** 只移动弹框内容层，保留 AntD 外层的入场动画和焦点管理。 */
export function useDraggableModal(open: boolean): DraggableModal {
  const [position, setPosition] = React.useState<Position>({ x: 0, y: 0 });
  const [shown, setShown] = React.useState(false);
  const content = React.useRef<HTMLDivElement>(null);
  const offset = React.useRef(position);
  const drag = React.useRef<DragState>();
  const update = React.useCallback((next: Position): void => {
    offset.current = next;
    setPosition(next);
  }, []);
  const bounds = React.useCallback((): { min: Position; max: Position } | undefined => {
    const rect = content.current?.getBoundingClientRect();
    if (!rect) return undefined;
    const { x, y } = offset.current;
    // 内容高于窗口时仍让标题和关闭按钮留在窗口内，正文沿原弹框滚动。
    return {
      min: { x: x + 8 - rect.left, y: y + 8 - rect.top },
      max: { x: x + Math.max(8, window.innerWidth - rect.width - 8) - rect.left, y: y + Math.max(8, window.innerHeight - rect.height - 8) - rect.top },
    };
  }, []);
  const move = React.useCallback((next: Position): void => {
    const limit = bounds();
    if (!limit) return;
    const bounded = { x: clamp(next.x, limit.min.x, limit.max.x), y: clamp(next.y, limit.min.y, limit.max.y) };
    if (bounded.x !== offset.current.x || bounded.y !== offset.current.y) update(bounded);
  }, [bounds, update]);
  React.useLayoutEffect((): void => {
    drag.current = undefined;
    if (open) update({ x: 0, y: 0 });
  }, [open, update]);
  React.useEffect(() => {
    const node = content.current;
    if (!open || !shown || !node) return;
    // 动画结束后再测量；候选方案变宽、内容变高或窗口缩小时重新约束位置。
    const fit = (): void => { drag.current = undefined; move(offset.current); };
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    window.addEventListener('resize', fit);
    fit();
    return (): void => { observer.disconnect(); window.removeEventListener('resize', fit); };
  }, [open, shown, move]);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || drag.current) return;
    const limit = bounds();
    if (!limit) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: offset.current, ...limit };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    update({ x: clamp(active.origin.x + event.clientX - active.start.x, active.min.x, active.max.x), y: clamp(active.origin.y + event.clientY - active.start.y, active.min.y, active.max.y) });
  };
  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 50 : 10;
    const delta: Record<string, Position> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
    if (event.key !== 'Home' && !delta[event.key]) return;
    event.preventDefault();
    move(event.key === 'Home' ? { x: 0, y: 0 } : { x: offset.current.x + delta[event.key].x, y: offset.current.y + delta[event.key].y });
  };
  return {
    titleProps: { tabIndex: 0, title: '按住标题拖动；方向键移动，Home 键复位', style: { cursor: 'move', userSelect: 'none', touchAction: 'none' }, onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd, onLostPointerCapture: onPointerEnd, onKeyDown },
    modalRender: (modal: React.ReactNode): React.ReactElement => <div ref={content} style={{ transform: `translate(${position.x}px, ${position.y}px)` }}>{modal}</div>,
    afterOpenChange: (visible: boolean): void => { setShown(visible); },
  };
}
