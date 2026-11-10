import fs from 'node:fs';
import promises from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { DownloadJob, GenerationMode } from '@doubao-studio/contracts';
import { DownloadRepository } from './DownloadRepository';
import { classifyDownloadException, validateDownloadResponse } from './downloadValidation';
import type { DownloadFailureType } from './downloadValidation';
import { mediaDigest } from './petstoryMedia';

/** 下载调用方与台账使用同一真实原因，原始网络/文件异常仍保留在cause中。 */
export class DownloadFailure extends Error {
  constructor(readonly failureType: DownloadFailureType, message: string, cause: unknown) {
    super(message, { cause }); this.name = 'DownloadFailure';
  }
}

export interface DownloadRequest {
  taskId: string;
  projectId?: string;
  batchId?: string;
  runId?: string;
  artifactId?: string;
  inputVersion?: number;
  accountId: string | null;
  mode: GenerationMode;
  url: string;
  saveDir: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  redirect?: 'error';
  timeoutMs?: number;
}
function downloadExtension(pathname: string, mode: GenerationMode, contentType: string): string {
  const extension = path.extname(pathname).toLowerCase();
  if (['.mp4', '.webm', '.png', '.jpg', '.jpeg', '.webp', '.mp3', '.wav'].includes(extension)) return extension;
  if (mode === 'video') return '.mp4';
  if (contentType.includes('webp')) return '.webp';
  return contentType.includes('jpeg') ? '.jpg' : '.png';
}
/** 同一 run/artifact 的下载共享一次本地操作，重试只更新原 job。 */
export class DownloadService {
  private readonly active = new Map<string, { promise: Promise<DownloadJob>; controller: AbortController }>();
  constructor(private readonly repository: DownloadRepository) {}
  private identity(request: DownloadRequest): string {
    return JSON.stringify([request.taskId, request.runId || '', request.artifactId || request.url, request.accountId, path.resolve(request.saveDir)]);
  }
  cancelTask(taskId: string, runId?: string): void {
    for (const [key, operation] of this.active) {
      const identity = JSON.parse(key) as [string, string];
      if (identity[0] === taskId && (!runId || identity[1] === runId)) operation.controller.abort(new Error('下载已暂停，可重试原产物'));
    }
  }
  download(request: DownloadRequest): Promise<DownloadJob> {
    const identity = this.identity(request);
    const current = this.active.get(identity);
    if (current) return current.promise;
    const controller = new AbortController();
    const promise = this.execute(request, controller).finally((): void => { this.active.delete(identity); });
    this.active.set(identity, { promise, controller });
    return promise;
  }
  private async completedFile(previous: DownloadJob | undefined): Promise<DownloadJob | undefined> {
    if (!previous?.filePath) return undefined;
    let info;
    try { info = await promises.lstat(previous.filePath); }
    catch { return undefined; } // 缓存被清理时沿原 job 下载。
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || previous.bytes !== undefined && info.size !== previous.bytes) return undefined;
    const digest = await mediaDigest(previous.filePath);
    if (previous.sha256 && previous.sha256 !== digest.sha256) return undefined;
    if (previous.status === 'done' && previous.sha256) return previous;
    // rename 已完成、完成台账未保存：重新验收同一文件，不再次下载或生成。
    return this.repository.patch(previous.id, { status: 'done', bytes: info.size, sha256: digest.sha256, error: undefined, updatedAt: new Date().toISOString() });
  }
  private async execute(request: DownloadRequest, controller: AbortController): Promise<DownloadJob> {
    const parsed = new URL(request.url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('产物地址无效');
    const previous = this.repository.list().find((job: DownloadJob): boolean => job.taskId === request.taskId && job.runId === request.runId
      && job.accountId === request.accountId && path.resolve(job.saveDir) === path.resolve(request.saveDir)
      && (request.artifactId ? job.artifactId === request.artifactId : job.url === request.url));
    const recovered = await this.completedFile(previous);
    if (recovered) return recovered;
    const now = new Date().toISOString();
    let job = this.repository.put({ ...previous, id: previous?.id || randomUUID(), taskId: request.taskId, projectId: request.projectId, batchId: request.batchId, runId: request.runId,
      artifactId: request.artifactId, inputVersion: request.inputVersion, accountId: request.accountId, mode: request.mode, url: request.url,
      saveDir: request.saveDir, status: 'downloading', attempts: (previous?.attempts || 0) + 1, createdAt: previous?.createdAt || now,
      updatedAt: now, error: undefined, filePath: undefined, bytes: undefined });
    let temporaryPath: string | undefined;
    const timeout = setTimeout((): void => controller.abort(new Error('下载超时')), request.timeoutMs ?? 60_000);
    try {
      controller.signal.throwIfAborted();
      await promises.mkdir(request.saveDir, { recursive: true });
      const response = await request.fetch(request.url, { redirect: request.redirect, signal: controller.signal,
        headers: { Referer: 'https://www.doubao.com/', 'User-Agent': 'Mozilla/5.0 Chrome/120 Safari/537.36' } });
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(validateDownloadResponse(response.status, contentType, 0, request.mode).message || '下载响应没有内容');
      }
      const extension = downloadExtension(parsed.pathname, request.mode, contentType);
      // jobId 唯一拥有最终文件和 .part，wx 阻止覆盖其他下载的文件。
      const filePath = path.join(request.saveDir, `${request.taskId.slice(0, 8)}_${job.id}${extension}`);
      // 先持久化最终路径意图。即便下载完成后写盘失败，重启也能找回唯一文件。
      this.repository.patch(job.id, { filePath });
      // 同一 job 重试也要独占 attempt 文件，崩溃遗留 part 不能造成永久 EEXIST。
      // jobId 后缀保留，进程启动恢复仍可按精确归属清理遗留文件。
      temporaryPath = `${filePath}.${randomUUID()}.${job.id}.part`;
      const hash = createHash('sha256');
      const digestStream = new Transform({ transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void { hash.update(chunk); callback(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), digestStream, fs.createWriteStream(temporaryPath, { flags: 'wx' }), { signal: controller.signal });
      controller.signal.throwIfAborted();
      const { size } = await promises.stat(temporaryPath);
      const validation = validateDownloadResponse(response.status, contentType, size, request.mode);
      if (!validation.valid) throw new Error(validation.message || '下载内容无效');
      const completedFile = await promises.open(temporaryPath, 'r');
      try { await completedFile.sync(); } finally { await completedFile.close(); }
      // 文件先落盘，台账完成保存失败时保留路径，重试可重新验收原文件。
      await promises.rename(temporaryPath, filePath); temporaryPath = undefined;
      job = this.repository.patch(job.id, { status: 'done', filePath, bytes: size, sha256: hash.digest('hex'), updatedAt: new Date().toISOString() });
      return job;
    } catch (error: unknown) {
      if (temporaryPath) await promises.rm(temporaryPath, { force: true }).catch((): void => {});
      const reason = controller.signal.aborted ? controller.signal.reason as unknown : error;
      const classified = classifyDownloadException(reason instanceof Error ? reason : { message: String(reason) });
      this.repository.patch(job.id, { status: 'failed', error: classified.message, updatedAt: new Date().toISOString() });
      if (error instanceof Error && error.message === 'DOWNLOAD_LEDGER_WRITE_FAILED') throw error;
      throw new DownloadFailure(classified.type, classified.message, error);
    } finally { clearTimeout(timeout); }
  }
}
