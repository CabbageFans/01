/** 只检验视口几何；真实 Electron 空间测量另行验收。 */
import { describe, expect, it } from 'vitest';
import { frameCanvasBounds } from '../../src/components/usePetStoryCanvasViewport';

describe('画布按真实镜头边界适应', (): void => {
  it.each([1280, 1440, 1920])('宽 %i 时镜头横向中心与可用视口中心一致', (width: number): void => {
    const bounds = { x: 380, y: 2476, width: 1364, height: 540 };
    const value = frameCanvasBounds(bounds, width, 740);
    expect(value.x + (bounds.x + bounds.width / 2) * value.scale).toBeCloseTo(width / 2);
    expect(value.y + bounds.y * value.scale).toBeGreaterThanOrEqual(44);
    expect(value.scale).toBeGreaterThanOrEqual(0.72);
  });
  it('镜头数量和垂直位置不降低可读比例，目标实际宽度影响适应结果', (): void => {
    const first = frameCanvasBounds({ x: 380, y: 40, width: 1364, height: 540 }, 1280, 700);
    const far = frameCanvasBounds({ x: 580, y: 28040, width: 1364, height: 3000 }, 1280, 700);
    const smaller = frameCanvasBounds({ x: 0, y: 0, width: 700, height: 540 }, 1280, 700);
    expect(far.scale).toBe(first.scale);
    expect(far.y + 28040 * far.scale).toBeCloseTo(44);
    expect(smaller.scale).toBe(1);
    expect(smaller.x).toBe(290);
    expect(first.x).not.toBe(28);
  });
});
