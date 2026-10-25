/** 离线附件回读测试；没有真实上传、页面或模型请求。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadReferenceImages } from '../../src/utils/doubaoBridge';
import type { UploadReadinessSnapshot } from '../../src/utils/uploadReadiness';

beforeEach((): void => { vi.useFakeTimers(); });
afterEach((): void => { vi.useRealTimers(); });
const material = [{ name: 'TEST-role.png', base64: 'VEVTVA==', mime: 'image/png' }];
const base: UploadReadinessSnapshot = { inputFileCount: 0, visibleAttachmentCount: 0, matchingFileNameCount: 0, pending: false };
function testView(samples: UploadReadinessSnapshot[]): { executeJavaScript: ReturnType<typeof vi.fn>; getURL: () => string; loadURL: ReturnType<typeof vi.fn> } {
  let count = 0;
  return { executeJavaScript: vi.fn(async (code: string): Promise<unknown> => {
    if (code.includes(')("inject",')) return { injected: true };
    return structuredClone(samples[Math.min(count++, samples.length - 1)]);
  }), getURL: (): string => 'https://www.doubao.com/chat/', loadURL: vi.fn() };
}

describe('ordinary Chat attachments through existing uploader', (): void => {
  it('allows a request without optional role attachments without touching the page', async (): Promise<void> => {
    const view = testView([base]);
    expect(await uploadReferenceImages(view, [], { chat: true })).toBe(true);
    expect(view.executeJavaScript).not.toHaveBeenCalled();
  });
  it('does not treat input.files assignment as a successful Chat upload', async (): Promise<void> => {
    const view = testView([base]);
    const result = uploadReferenceImages(view, material, { chat: true, timeoutMs: 30_000 });
    const assertion = expect(result).rejects.toThrow('chat_assets_not_ready');
    await vi.advanceTimersByTimeAsync(33_000);
    await assertion;
    expect(view.loadURL).not.toHaveBeenCalled();
  });
  it('waits through pending and incomplete states until attachment count is visibly stable', async (): Promise<void> => {
    const ready = { ...base, visibleAttachmentCount: 1, matchingFileNameCount: 1 };
    const view = testView([base, { ...ready, pending: true }, base, ready, ready, ready]);
    const onProgress = vi.fn();
    const result = uploadReferenceImages(view, material, { chat: true, stableSamples: 3, onProgress });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe(true);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ stableSamples: 3, observedCount: 1, pending: false }));
    const injections = view.executeJavaScript.mock.calls.filter((call: unknown[]): boolean => String(call[0]).includes(')("inject",'));
    expect(injections).toHaveLength(1);
  });
});
