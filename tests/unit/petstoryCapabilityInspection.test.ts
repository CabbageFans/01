/** 离线页面替身核对：检查图片不会访问视频；不是豆包实机验收。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inspectPetStoryCapability } from '../../src/utils/doubaoBridge';
import type { PetStoryComposerSnapshot } from '../../src/utils/petstoryControls';

beforeEach((): void => { vi.useFakeTimers(); });
afterEach((): void => { vi.useRealTimers(); });

it.each([false, true])('独立图片检查可在没有视频控件时完成，人工免费确认=%s', async (confirmed: boolean): Promise<void> => {
  const snapshot: PetStoryComposerSnapshot = { present: true, generic: true, first: false, last: false, nativeLabel: false, firstLabel: false, free: 'unknown', model: '', duration: 0, aspectRatio: '', durations: [], count: 0, pending: false };
  let calls = 0;
  const view = { getURL: (): string => 'https://www.doubao.com/chat/', loadURL: vi.fn(), executeJavaScript: vi.fn(async (): Promise<unknown> => {
    calls++;
    if (calls === 1 || calls === 3) return snapshot;
    if (calls === 2) return { ok: true, method: 'TEST可见图片入口' };
    throw new Error('TEST视频入口不存在，不得访问');
  }) };
  const result = inspectPetStoryCapability(view, 'TEST-account', confirmed, 'image');
  await vi.advanceTimersByTimeAsync(600);
  const capability = await result;
  expect(capability).toMatchObject({ accountId: 'TEST-account', image: { state: 'supported', free: confirmed ? 'free' : 'unknown' }, durations: [], freeEvidence: confirmed ? 'user_confirmed' : 'unknown' });
  expect(Object.values(capability.modes).every((entry): boolean => entry.state === 'unknown' && entry.free === 'unknown')).toBe(true);
  expect(capability.videoConfig).toBeUndefined(); expect(view.executeJavaScript).toHaveBeenCalledTimes(3); expect(view.loadURL).not.toHaveBeenCalled();
});
