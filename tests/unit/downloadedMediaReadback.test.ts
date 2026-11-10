/** 有界容器字节夹具只验证读取权限/Range契约，不冒充视频解码或真实播放验收。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DownloadJob } from '@doubao-studio/contracts';
import { DownloadRepository } from '../../main/utils/DownloadRepository';
import { LocalMediaStreams } from '../../main/utils/LocalMediaProtocol';
import { readDownloadedMedia } from '../../main/utils/downloadedMedia';

let directory: string; let filename: string; let stored: DownloadJob[]; let writable: boolean;
let repository: DownloadRepository; let streams: LocalMediaStreams;
const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom00000000fixture-container')]);
beforeEach(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'download-local-readback-')); filename = path.join(directory, 'video.mp4'); await fs.writeFile(filename, bytes); writable = true;
  stored = [{ id: 'job', taskId: 'cleaned-task', runId: 'original-run', artifactId: 'artifact', accountId: 'account', mode: 'video', status: 'done',
    url: 'https://fixture.invalid/expired.mp4?signature=expired', attempts: 1, saveDir: directory, filePath: filename, bytes: bytes.length,
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z' }];
  repository = new DownloadRepository({ read: (): DownloadJob[] => structuredClone(stored), write: (jobs: DownloadJob[]): boolean => { if (!writable) return false; stored = structuredClone(jobs); return true; } });
  streams = new LocalMediaStreams();
});
afterEach(async (): Promise<void> => { await fs.rm(directory, { recursive: true, force: true }); });

describe('按下载job读取本地视频', (): void => {
  it('已清理Task且远端链接失效时，仅凭原下载记录授予受控Range读取能力', async (): Promise<void> => {
    const result = await readDownloadedMedia('job', repository, streams);
    expect(result).toMatchObject({ success: true, mimeType: 'video/mp4' }); expect(result.data).toMatch(/^doubao-media:\/\/asset\/[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(directory); expect(JSON.stringify(result)).not.toContain('expired.mp4');
    expect(repository.list()[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    const response = await streams.respond(new Request(result.data!, { headers: { Range: 'bytes=0-15' } }));
    expect(response.status).toBe(206); expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(0, 16));
  });

  it('历史下载首次校验记录写盘失败不返回可播放URL，重读可安全完成', async (): Promise<void> => {
    writable = false;
    expect(await readDownloadedMedia('job', repository, streams)).toMatchObject({ success: false, errorCode: 'DOWNLOAD_RECORD_SAVE_FAILED' });
    expect(repository.list()[0].sha256).toBeUndefined();
    writable = true; expect((await readDownloadedMedia('job', repository, streams)).success).toBe(true);
  });

  it('同大小但内容被换掉时拒绝原身份，原记录与原hash保留', async (): Promise<void> => {
    expect((await readDownloadedMedia('job', repository, streams)).success).toBe(true); const digest = repository.list()[0].sha256;
    const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; await fs.writeFile(filename, changed);
    expect(await readDownloadedMedia('job', repository, streams)).toMatchObject({ success: false, errorCode: 'LOCAL_MEDIA_CHANGED' });
    expect(repository.list()[0].sha256).toBe(digest);
  });

  it('拒绝尚未下载、未知job和伪装成视频的页面内容，零路径参数入口', async (): Promise<void> => {
    expect((await readDownloadedMedia('../../etc/passwd', repository, streams)).success).toBe(false);
    stored[0].status = 'failed'; expect((await readDownloadedMedia('job', repository, streams)).success).toBe(false);
    stored[0].status = 'done'; await fs.writeFile(filename, '<html>login required</html>'); stored[0].bytes = (await fs.stat(filename)).size;
    expect(await readDownloadedMedia('job', repository, streams)).toMatchObject({ success: false, errorCode: 'LOCAL_MEDIA_CONTAINER' });
  });

  it('外部文件和符号链接不能借下载job取得读取权', async (): Promise<void> => {
    const outside = path.join(directory, 'outside'); await fs.mkdir(outside);
    stored[0].saveDir = outside;
    expect(await readDownloadedMedia('job', repository, streams)).toMatchObject({ success: false, errorCode: 'LOCAL_MEDIA_BOUNDARY' });
    stored[0].saveDir = directory;
    const symlink = path.join(directory, 'link.mp4'); await fs.symlink(filename, symlink); stored[0].filePath = symlink;
    expect(await readDownloadedMedia('job', repository, streams)).toMatchObject({ success: false, errorCode: 'LOCAL_MEDIA_BOUNDARY' });
  });

  it('真实容器身份决定本地Content-Type，不再按远端URL关键词猜测', async (): Promise<void> => {
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]); await fs.writeFile(filename, webm); stored[0].bytes = webm.length;
    const result = await readDownloadedMedia('job', repository, streams); expect(result).toMatchObject({ success: true, mimeType: 'video/webm' });
    const response = await streams.respond(new Request(result.data!, { method: 'HEAD' })); expect(response.headers.get('content-type')).toBe('video/webm');
  });
});
