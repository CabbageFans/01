import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeVideoArtifact } from '../../src/utils/videoArtifactObservation';
import type { VideoArtifactObservationOptions } from '../../src/utils/videoArtifactObservation';
import type { VideoArtifactResolution } from '../../src/utils/videoArtifactResolver';

const pending: VideoArtifactResolution = { status: 'unavailable', reason: 'TEST 尚无 vid 或卡片', attempts: [] };
const resolved: VideoArtifactResolution = { status: 'resolved', url: 'https://TEST.invalid/video/original.mp4', vid: 'TEST-original-vid', source: 'play_info', attempts: [] };

function options(): VideoArtifactObservationOptions & {
  resolve: ReturnType<typeof vi.fn>; ensureCurrent: ReturnType<typeof vi.fn>; onProgress: ReturnType<typeof vi.fn>;
} {
  return { signal: new AbortController().signal, timeoutMs: 15 * 60_000,
    resolve: vi.fn(async (): Promise<VideoArtifactResolution> => pending), ensureCurrent: vi.fn(),
    onProgress: vi.fn(async (): Promise<void> => undefined) };
}

beforeEach((): void => { vi.useFakeTimers(); });
afterEach((): void => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('已提交视频的持续只读观察', (): void => {
  it('多次快速无产物读取不会提前暂停，延迟产生的视频仍由同一轮观察取得', async (): Promise<void> => {
    const test = options(); test.resolve.mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce(resolved);
    const work = observeVideoArtifact(test); await vi.advanceTimersByTimeAsync(9000);
    await expect(work).resolves.toEqual(resolved);
    expect(test.resolve).toHaveBeenCalledTimes(4); expect(test.onProgress).toHaveBeenCalledTimes(3);
    expect(test.onProgress.mock.calls.map((call: unknown[]): number => (call[0] as { pollCount: number }).pollCount)).toEqual([1, 2, 3]);
    expect(test.resolve.mock.calls.every((call: unknown[]): boolean => Number(call[0]) <= 8000)).toBe(true);
  });

  it('45秒观察预算内持续退避并发送心跳，到总期限才返回未就绪', async (): Promise<void> => {
    const test = options(); test.timeoutMs = 45_000;
    const work = observeVideoArtifact(test); await vi.advanceTimersByTimeAsync(44_999);
    let finished = false; void work.then((): void => { finished = true; }); await Promise.resolve();
    expect(finished).toBe(false); expect(test.onProgress.mock.calls.length).toBeGreaterThan(3);
    await vi.advanceTimersByTimeAsync(1);
    await expect(work).resolves.toMatchObject({ status: 'unavailable', reason: '原会话视频产物在本轮观察期限内尚未就绪' });
  });

  it('单次解析挂起也仅消耗8秒，并取消旧读取后继续原会话', async (): Promise<void> => {
    const test = options(); let firstSignal: AbortSignal | undefined;
    test.resolve.mockImplementationOnce((_timeoutMs: number, signal: AbortSignal): Promise<VideoArtifactResolution> => { firstSignal = signal; return new Promise((): void => undefined); });
    test.resolve.mockResolvedValueOnce(resolved);
    const work = observeVideoArtifact(test); await vi.advanceTimersByTimeAsync(10_000);
    await expect(work).resolves.toEqual(resolved); expect(firstSignal?.aborted).toBe(true); expect(test.resolve).toHaveBeenCalledTimes(2);
  });

  it('短暂读取异常继续观察，不把接口异常当平台未生成', async (): Promise<void> => {
    const test = options(); test.resolve.mockRejectedValueOnce(new Error('TEST temporary read failure')).mockResolvedValueOnce(resolved);
    const work = observeVideoArtifact(test); await vi.advanceTimersByTimeAsync(2000);
    await expect(work).resolves.toEqual(resolved); expect(test.onProgress).toHaveBeenCalledOnce();
  });

  it('用户取消退避等待时立即停止，不发起下一次读取', async (): Promise<void> => {
    const test = options(); const controller = new AbortController(); test.signal = controller.signal;
    const work = observeVideoArtifact(test); const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(500); controller.abort(); await rejected; await vi.advanceTimersByTimeAsync(20_000);
    expect(test.resolve).toHaveBeenCalledOnce();
  });

  it('读取尚未返回时取消，不等8秒超时也不采用迟到地址', async (): Promise<void> => {
    const test = options(); const controller = new AbortController(); test.signal = controller.signal;
    let release: ((value: VideoArtifactResolution) => void) | undefined;
    test.resolve.mockImplementationOnce((): Promise<VideoArtifactResolution> => new Promise((resolve): void => { release = resolve; }));
    const work = observeVideoArtifact(test); const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(100); controller.abort(); await rejected; release?.(resolved); await vi.advanceTimersByTimeAsync(100);
    expect(test.onProgress).not.toHaveBeenCalled(); expect(test.resolve).toHaveBeenCalledOnce();
  });

  it.each(['run', 'account', 'conversation', 'submittedAt'])('%s在读取中变化时不采用迟到产物或写观察心跳', async (change: string): Promise<void> => {
    const test = options(); let current = true;
    test.ensureCurrent.mockImplementation((): void => { if (!current) throw new Error(`TEST ${change} changed`); });
    test.resolve.mockImplementationOnce(async (): Promise<VideoArtifactResolution> => { current = false; return resolved; });
    await expect(observeVideoArtifact(test)).rejects.toThrow(`TEST ${change} changed`);
    expect(test.onProgress).not.toHaveBeenCalled(); expect(test.resolve).toHaveBeenCalledOnce();
  });

  it.each(['expired', 'unauthorized', 'needs_manual_selection'] as const)('明确%s后结束观察，不反复读取', async (status): Promise<void> => {
    const test = options(); test.resolve.mockResolvedValueOnce({ status, reason: 'TEST explicit terminal state', attempts: [] });
    await expect(observeVideoArtifact(test)).resolves.toMatchObject({ status });
    expect(test.resolve).toHaveBeenCalledOnce(); expect(test.onProgress).not.toHaveBeenCalled();
  });

  it('真实平台失败或限制由回读检查结束观察，保留原提交', async (): Promise<void> => {
    const test = options(); test.onProgress.mockRejectedValueOnce(new Error('豆包已停止生成：次数已用完'));
    await expect(observeVideoArtifact(test)).rejects.toThrow('次数已用完'); expect(test.resolve).toHaveBeenCalledOnce();
  });
});
