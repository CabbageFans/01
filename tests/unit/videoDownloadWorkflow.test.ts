import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadJob } from '@doubao-studio/contracts';

const state = vi.hoisted(() => ({ files: {} as Record<string, unknown>, failWrite: false, fetch: vi.fn<typeof fetch>() }));
vi.mock('electron', () => ({ app: { getPath: (): string => os.tmpdir() }, ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, dialog: {}, session: { fromPartition: (): object => ({ fetch: state.fetch }), defaultSession: { fetch: state.fetch } } }));
vi.mock('../../main/utils/store', () => ({
  readJSON: (file: string, fallback: unknown): unknown => structuredClone(state.files[file] ?? fallback),
  writeJSON: (file: string, value: unknown): boolean => { if (state.failWrite && file === 'downloads.json') return false; state.files[file] = structuredClone(value); return true; },
}));
vi.mock('../../main/utils/persistenceNormalization', () => ({ normalizeTasks: (value: unknown): object => ({ data: structuredClone(value), changed: false, warnings: [] }), normalizeDownloadJobs: (value: unknown): object => ({ data: structuredClone(value), changed: false, warnings: [] }) }));
import { downloadTaskOutputs, listTaskDownloads } from '../../main/ipc/tasks';

let directory: string;
const input = (id: string): Parameters<typeof downloadTaskOutputs>[0] => ({ saveDir: directory, outputs: [{ taskId: id, prompt: '', outputs: [`https://example.test/${id}.mp4`], accountId: 'account-1', mode: 'video' }] });
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done): void => { resolve = done; });
  return { promise, resolve };
}
const response = (): Response => new Response(new Uint8Array([0, 1, 2, 3]), { headers: { 'content-type': 'video/mp4' } });

beforeEach((): void => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-download-workflow-')); state.files = { 'accounts.json': [{ id: 'account-1', partition: 'isolated' }], 'downloads.json': [] }; state.failWrite = false; state.fetch.mockReset(); });
afterEach((): void => { vi.useRealTimers(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('正式视频下载出口', (): void => {
  it('两个下载交错完成仍保留两条独立台账', async (): Promise<void> => {
    const first = deferred<Response>(); const second = deferred<Response>();
    state.fetch.mockImplementation((address: string | URL | Request): Promise<Response> => String(address).includes('/first.') ? first.promise : second.promise);
    const a = downloadTaskOutputs(input('first')); const b = downloadTaskOutputs(input('second'));
    second.resolve(response()); await b; first.resolve(response()); await a;
    const jobs = listTaskDownloads();
    expect(jobs.map((job: DownloadJob): string => job.taskId).sort()).toEqual(['first', 'second']);
    expect(jobs.every((job: DownloadJob): boolean => job.status === 'done')).toBe(true);
  });
  it('初始意图保存失败时零网络请求，不伪报成功', async (): Promise<void> => {
    state.failWrite = true; state.fetch.mockResolvedValue(response());
    const result = await downloadTaskOutputs(input('write-fail'));
    expect(result.success).toBe(false); expect(result.count).toBe(0); expect(state.fetch).not.toHaveBeenCalled();
  });
  it('HTTP 头到达但响应体停滞，仍在原预算内失败并清理自己的临时文件', async (): Promise<void> => {
    vi.useFakeTimers();
    state.fetch.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller): void { controller.enqueue(new Uint8Array([0, 1])); } }), { headers: { 'content-type': 'video/mp4' } }));
    let settled = false;
    const pending = downloadTaskOutputs(input('stalled')).then((result): typeof result => { settled = true; return result; });
    await vi.waitFor((): void => { expect(state.fetch).toHaveBeenCalledOnce(); });
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.waitFor((): void => { expect(settled).toBe(true); });
    expect(settled).toBe(true);
    const result = await pending; expect(result.success).toBe(false);
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});
