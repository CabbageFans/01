import { createFailedResolution } from './videoArtifactResolver';
import type { VideoArtifactResolution } from './videoArtifactResolver';

export interface VideoArtifactObservationProgress {
  pollCount: number;
  elapsedMs: number;
  resolution: VideoArtifactResolution;
}

export interface VideoArtifactObservationOptions {
  signal: AbortSignal;
  timeoutMs: number;
  resolve: (timeoutMs: number, signal: AbortSignal) => Promise<VideoArtifactResolution>;
  ensureCurrent: () => void;
  onProgress: (progress: VideoArtifactObservationProgress) => Promise<void>;
}

function assertObserving(options: VideoArtifactObservationOptions): void {
  if (options.signal.aborted) throw new DOMException('只读视频观察已停止', 'AbortError');
  options.ensureCurrent();
}

function observationDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject): void => {
    const aborted = (): void => { clearTimeout(timer); reject(new DOMException('只读视频观察已停止', 'AbortError')); };
    const timer = setTimeout((): void => { signal.removeEventListener('abort', aborted); resolve(); }, milliseconds);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** 每轮只读解析独立限时；迟到的读取结果不能越过总观察期限或取消动作。 */
async function resolveObservationSample(options: VideoArtifactObservationOptions, timeoutMs: number): Promise<VideoArtifactResolution> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = (): void => controller.abort();
  options.signal.addEventListener('abort', aborted, { once: true });
  if (options.signal.aborted) controller.abort();
  const cancelled = new Promise<never>((_resolve, reject): void => {
    controller.signal.addEventListener('abort', (): void => reject(new DOMException('本轮视频读取已停止', 'AbortError')), { once: true });
  });
  try {
    return await Promise.race([
      options.resolve(timeoutMs, controller.signal),
      cancelled,
      new Promise<VideoArtifactResolution>((resolve): void => {
        timer = setTimeout((): void => {
          resolve(createFailedResolution('retryable_error', '本轮读取尚未完成，继续观察原会话', []));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } catch (error: unknown) {
    if (options.signal.aborted) throw error;
    return createFailedResolution('retryable_error', '本轮原视频读取暂不可用，继续观察原会话', []);
  } finally {
    if (timer) clearTimeout(timer);
    options.signal.removeEventListener('abort', aborted);
    controller.abort();
  }
}

/** 原次提交的持续只读观察；没有上传、注入、刷新或发送能力。 */
export async function observeVideoArtifact(options: VideoArtifactObservationOptions): Promise<VideoArtifactResolution> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, options.timeoutMs);
  let last = createFailedResolution('unavailable', '原会话视频产物尚未就绪', []);
  let pollCount = 0;
  let previousAdvice = '';
  while (Date.now() < deadline) {
    assertObserving(options);
    last = await resolveObservationSample(options, Math.min(8000, deadline - Date.now()));
    assertObserving(options);
    if (last.status === 'resolved' || last.status === 'expired' || last.status === 'unauthorized' || last.status === 'needs_manual_selection') return last;
    if (last.status === 'generation_not_started' && last.evidenceKey) {
      if (last.evidenceKey === previousAdvice) return last;
      previousAdvice = last.evidenceKey;
    } else previousAdvice = '';
    pollCount += 1;
    await options.onProgress({ pollCount, elapsedMs: Date.now() - startedAt, resolution: last });
    assertObserving(options);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await observationDelay(Math.min(remaining, 1000 + pollCount * 1000, 10_000), options.signal);
  }
  assertObserving(options);
  return { ...last, reason: '原会话视频产物在本轮观察期限内尚未就绪' };
}
