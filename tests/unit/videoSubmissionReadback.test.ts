import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForConfirmedSubmission } from '../../src/utils/realSendStateMachine';
import type { SubmissionReadback } from '../../src/utils/realSendStateMachine';

const waiting: SubmissionReadback = { generationStarted: false, inputCleared: false, messageCount: 0, promptPublished: false };
const accepted: SubmissionReadback = { generationStarted: true, inputCleared: true, messageCount: 1, promptPublished: true };
const wait = (milliseconds: number): Promise<void> => new Promise((resolve): void => { setTimeout(resolve, milliseconds); });

afterEach((): void => { vi.useRealTimers(); });

describe('单次视频发送后的受理等待', (): void => {
  it('平台超过旧 2 秒窗口才发布用户消息时，继续只读并确认原次发送', async (): Promise<void> => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const read = vi.fn(async (): Promise<SubmissionReadback> => Date.now() - startedAt >= 3500 ? accepted : waiting);
    const check = vi.fn(async (): Promise<void> => undefined);
    const pending = waitForConfirmedSubmission({ read, wait, onUnconfirmed: check, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(3500);
    await expect(pending).resolves.toEqual(accepted);
    expect(read).toHaveBeenCalledTimes(7);
    expect(check).toHaveBeenCalledTimes(6);
  });

  it('原次发送始终没有受理证据时有界结束，保留不确定状态', async (): Promise<void> => {
    vi.useFakeTimers();
    const read = vi.fn(async (): Promise<SubmissionReadback> => waiting);
    const pending = waitForConfirmedSubmission({ read, wait, onUnconfirmed: async (): Promise<void> => undefined, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(30);
  });

  it('用户取消后不再回读或确认受理', async (): Promise<void> => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const read = vi.fn(async (): Promise<SubmissionReadback> => accepted);
    const pending = waitForConfirmedSubmission({ read, wait, onUnconfirmed: async (): Promise<void> => undefined, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(read).not.toHaveBeenCalled();
  });
});
