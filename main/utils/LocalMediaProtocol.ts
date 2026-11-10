import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Protocol } from 'electron';

interface MediaGrant { file: string; bytes: number; ino: number; mtimeMs: number; expiresAt: number; mimeType: 'video/mp4' | 'video/webm' }
/** 仅主进程按项目资产发放临时读取能力。URL 不接受文件路径，不暴露目录。 */
export class LocalMediaStreams {
  private readonly grants = new Map<string, MediaGrant>();
  async issue(filename: string, expectedBytes: number, mimeType: 'video/mp4' | 'video/webm' = 'video/mp4'): Promise<string> {
    const file = await fs.realpath(filename); const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedBytes) throw new Error('本地视频文件已变化，请重新读取');
    const now = Date.now();
    for (const [token, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(token);
    const token = randomBytes(32).toString('hex');
    this.grants.set(token, { file, bytes: stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs, expiresAt: now + 8 * 60 * 60 * 1000, mimeType });
    return `doubao-media://asset/${token}`;
  }
  async respond(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const grant = url.protocol === 'doubao-media:' && url.hostname === 'asset' && !url.search && !url.hash ? this.grants.get(url.pathname.slice(1)) : undefined;
    if (!grant || grant.expiresAt <= Date.now()) return new Response('请重新读取本地视频', { status: 403 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    let start = 0; let end = grant.bytes - 1; let partial = false;
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return this.invalidRange(grant.bytes);
      if (!match[1]) start = Math.max(0, grant.bytes - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= grant.bytes) return this.invalidRange(grant.bytes);
      partial = true;
    }
    let handle;
    try {
      handle = await fs.open(grant.file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== grant.bytes || stat.ino !== grant.ino || stat.mtimeMs !== grant.mtimeMs) { await handle.close(); return new Response('文件已变化，请重新读取', { status: 409 }); }
      const headers: Record<string, string> = { 'Content-Type': grant.mimeType, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Cache-Control': 'private, no-store' };
      if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${grant.bytes}`;
      if (request.method === 'HEAD') { await handle.close(); return new Response(null, { status: partial ? 206 : 200, headers }); }
      const stream = handle.createReadStream({ start, end, autoClose: true });
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: partial ? 206 : 200, headers });
    } catch {
      await handle?.close().catch((): void => {});
      return new Response('本地文件读取失败，请重新读取', { status: 404 });
    }
  }
  private invalidRange(bytes: number): Response { return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes}` } }); }
}
export const localMediaStreams = new LocalMediaStreams();
/** 必须早于 app.ready，支持 Chromium 的 seek 和流式解码。 */
export function registerLocalMediaScheme(protocol: Protocol): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'doubao-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
}
export function installLocalMediaProtocol(protocol: Protocol): void {
  protocol.handle('doubao-media', (request: Request): Promise<Response> => localMediaStreams.respond(request));
}
