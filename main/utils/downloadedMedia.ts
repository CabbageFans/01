import fs from 'node:fs/promises';
import path from 'node:path';
import type { DownloadJob, TaskReadDownloadedMediaResult } from '@doubao-studio/contracts';
import type { DownloadRepository } from './DownloadRepository';
import type { LocalMediaStreams } from './LocalMediaProtocol';
import { mediaDigest } from './petstoryMedia';

function failure(errorCode: string, error: string): TaskReadDownloadedMediaResult { return { success: false, errorCode, error }; }
function sameFileJob(current: DownloadJob | undefined, original: DownloadJob): boolean {
  return !!current && current.status === 'done' && current.filePath === original.filePath && current.taskId === original.taskId
    && current.runId === original.runId && current.artifactId === original.artifactId && current.bytes === original.bytes;
}

/** jobId是唯一输入；检查台账中的真实文件，不借用Task或过期的远端URL。这里只授予读取能力，解码由播放器回读。 */
export async function readDownloadedMedia(jobId: string, repository: DownloadRepository, streams: LocalMediaStreams): Promise<TaskReadDownloadedMediaResult> {
  try {
    const job = repository.list().find((candidate: DownloadJob): boolean => candidate.id === jobId);
    if (!job || job.status !== 'done' || job.mode !== 'video' || !job.filePath) return failure('DOWNLOAD_NOT_READY', '这个下载尚无可读取的本地视频，请先完成或重试原下载');
    const root = await fs.realpath(job.saveDir); const originalStat = await fs.lstat(job.filePath); const filename = await fs.realpath(job.filePath);
    const relative = path.relative(root, filename);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || !originalStat.isFile() || originalStat.isSymbolicLink()) return failure('LOCAL_MEDIA_BOUNDARY', '本地视频路径或文件类型已变化，请核对原下载');
    if (originalStat.size <= 0 || job.bytes !== undefined && originalStat.size !== job.bytes) return failure('LOCAL_MEDIA_CHANGED', '本地视频大小已变化，请重新读取或重试原下载');
    const handle = await fs.open(filename, 'r'); let mimeType: 'video/mp4' | 'video/webm' | undefined;
    try {
      const header = Buffer.alloc(16); const { bytesRead } = await handle.read(header, 0, 16, 0);
      if (bytesRead >= 12 && header.toString('ascii', 4, 8) === 'ftyp') mimeType = 'video/mp4';
      else if (bytesRead >= 4 && header.readUInt32BE(0) === 0x1a45dfa3) mimeType = 'video/webm';
    } finally { await handle.close(); }
    if (!mimeType) return failure('LOCAL_MEDIA_CONTAINER', '本地下载不是可识别的视频容器，请重试下载或重新校验原文件');
    const digest = await mediaDigest(filename); const checked = await fs.lstat(filename);
    if (checked.ino !== originalStat.ino || checked.mtimeMs !== originalStat.mtimeMs || digest.bytes !== originalStat.size
      || job.sha256 && digest.sha256 !== job.sha256) return failure('LOCAL_MEDIA_CHANGED', '本地视频内容已变化，原下载记录保留，请重新读取或校验');
    if (!sameFileJob(repository.list().find((candidate: DownloadJob): boolean => candidate.id === jobId), job)) return failure('DOWNLOAD_CHANGED', '原下载状态已变化，请重新读取当前记录');
    // 历史下载首次读取时只补本地文件事实，绝不创建任务或平台请求。
    if (!job.sha256) repository.patch(job.id, { sha256: digest.sha256, bytes: digest.bytes });
    return { success: true, data: await streams.issue(filename, digest.bytes, mimeType), mimeType };
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return failure('LOCAL_MEDIA_MISSING', '本地视频文件已不存在，请重试原下载');
    if (error instanceof Error && error.message === 'DOWNLOAD_LEDGER_WRITE_FAILED') return failure('DOWNLOAD_RECORD_SAVE_FAILED', '本地文件校验记录未保存，请检查磁盘后重新读取');
    return failure('LOCAL_MEDIA_READ_FAILED', '本地视频读取失败，请检查文件权限后重新读取');
  }
}
