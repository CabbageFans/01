import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DownloadJob } from '@doubao-studio/contracts';
import { DownloadRepository } from '../../main/utils/DownloadRepository';
import { DownloadService } from '../../main/utils/DownloadService';

let directory: string; let jobs: DownloadJob[]; let denyDone: boolean; let service: DownloadService; let server: http.Server | undefined;
beforeEach(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'download-service-integration-')); jobs = []; denyDone = false;
  service = new DownloadService(new DownloadRepository({ read: (): DownloadJob[] => structuredClone(jobs), write: (next: DownloadJob[]): boolean => { if (denyDone && next.some((job): boolean => job.status === 'done')) return false; jobs = structuredClone(next); return true; } }));
});
afterEach(async (): Promise<void> => { server?.closeAllConnections(); await new Promise<void>((resolve): void => { if (server) server.close((): void => resolve()); else resolve(); }); server = undefined; await fs.rm(directory, { recursive: true, force: true }); });
function request(url = 'https://fixture.test/video'): Parameters<DownloadService['download']>[0] {
  return { taskId: 'task', runId: 'run-original', artifactId: 'artifact', accountId: 'account', mode: 'video', url, saveDir: directory,
    fetch: async (): Promise<Response> => new Response(new Uint8Array([0, 1, 2, 3]), { headers: { 'content-type': 'video/mp4' } }) };
}
async function listen(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler); await new Promise<void>((resolve): void => { server!.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address missing'); return `http://127.0.0.1:${address.port}/video`;
}
describe('下载短事务和故障恢复', (): void => {
  it('完成台账失败不报告成功，重建服务后复用已完成文件，无第二次下载', async (): Promise<void> => {
    denyDone = true; await expect(service.download(request())).rejects.toThrow('DOWNLOAD_LEDGER_WRITE_FAILED');
    expect(jobs).toHaveLength(1); expect(jobs[0].status).toBe('failed'); expect(jobs[0].filePath).toBeDefined();
    expect((await fs.readFile(jobs[0].filePath!)).length).toBe(4);
    denyDone = false; let networkCalls = 0;
    const recovered = new DownloadService(new DownloadRepository({ read: (): DownloadJob[] => structuredClone(jobs), write: (next): boolean => { jobs = structuredClone(next); return true; } }));
    const done = await recovered.download({ ...request('https://fixture.test/new-signed-url'), fetch: async (): Promise<Response> => { networkCalls++; throw new Error('unexpected network'); } });
    expect(done.id).toBe(jobs[0].id); expect(done.status).toBe('done'); expect(networkCalls).toBe(0); expect(jobs).toHaveLength(1);
  });
  it('进程重建后同一job遗留part不使重试永久EEXIST，每次attempt持有独占临时文件', async (): Promise<void> => {
    const finalPath = path.join(directory, 'task_crashed-job.mp4'); const oldPart = `${finalPath}.crashed-job.part`; const now = new Date().toISOString();
    jobs = [{ id: 'crashed-job', taskId: 'task', runId: 'run-original', artifactId: 'artifact', accountId: 'account', mode: 'video', url: request().url, status: 'downloading', attempts: 1, saveDir: directory, filePath: finalPath, createdAt: now, updatedAt: now }];
    await fs.writeFile(oldPart, 'TEST interrupted partial bytes');
    const done = await service.download(request());
    expect(done.id).toBe('crashed-job'); expect(done.attempts).toBe(2); expect(done.status).toBe('done'); expect(await fs.readFile(done.filePath!)).toEqual(Buffer.from([0, 1, 2, 3]));
    // 新worker只清理自己attempt的临时文件；旧文件由进程启动的下载恢复模块精确处理。
    expect(await fs.readFile(oldPart, 'utf8')).toBe('TEST interrupted partial bytes');
  });
  it('真实HTTP响应头已返回、body停滞时，全程预算会终止流并删除part', async (): Promise<void> => {
    const url = await listen((_req, response): void => { response.writeHead(200, { 'Content-Type': 'video/mp4' }); response.write(Buffer.from([0, 1])); });
    await expect(service.download({ ...request(url), fetch, timeoutMs: 80 })).rejects.toMatchObject({ name: 'DownloadFailure',
      failureType: 'network_error', message: '下载超时', cause: expect.any(Error) });
    expect(jobs[0].status).toBe('failed'); expect(jobs[0].error).toContain('超时'); expect(await fs.readdir(directory)).toEqual([]);
  });
  it('暂停只取消原run的本地响应流，立即返回并保留原job供重试', async (): Promise<void> => {
    let headers!: () => void; const headersArrived = new Promise<void>((resolve): void => { headers = resolve; });
    const url = await listen((_req, response): void => { response.writeHead(200, { 'Content-Type': 'video/mp4' }); response.write(Buffer.from([0, 1])); headers(); });
    const pending = service.download({ ...request(url), fetch }); const result = pending.catch((error: unknown): unknown => error);
    await headersArrived; service.cancelTask('task', 'different-run'); expect(jobs[0].status).toBe('downloading');
    service.cancelTask('task', 'run-original'); await result;
    expect(jobs[0].status).toBe('failed'); expect(jobs[0].attempts).toBe(1); expect(await fs.readdir(directory)).toEqual([]);
  });
  it('同一run和artifact并发请求共享操作，签名URL变化不改变媒体身份', async (): Promise<void> => {
    let calls = 0; const options = { ...request(), fetch: async (): Promise<Response> => { calls++; return new Response(new Uint8Array([0, 1]), { headers: { 'content-type': 'video/mp4' } }); } };
    const [first, second] = await Promise.all([service.download(options), service.download({ ...options, url: 'https://fixture.test/refreshed-signature' })]);
    expect(first.id).toBe(second.id); expect(calls).toBe(1); expect(jobs).toHaveLength(1);
  });
});
