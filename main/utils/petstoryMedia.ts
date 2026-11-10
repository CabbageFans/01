import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { PetStoryMediaValidation } from '@doubao-studio/contracts';

export type MediaFailureCode = 'MEDIA_TOOL_MISSING' | 'MEDIA_TOOL_TIMEOUT' | 'MEDIA_TOOL_PERMISSION' | 'MEDIA_TOOL_FAILED' | 'MEDIA_CONTENT_INVALID';
export class MediaProcessingError extends Error {
  constructor(readonly code: MediaFailureCode, message: string, readonly details: { cause?: unknown; exitCode?: string | number; stderr?: string } = {}) {
    super(message, { cause: details.cause }); this.name = 'MediaProcessingError';
  }
  get stderr(): string | undefined { return this.details.stderr; }
  get exitCode(): string | number | undefined { return this.details.exitCode; }
}
/** 仅确证解码／容器损坏才拒绝内容；工具和本机故障均可沿原文件重试校验。 */
export function isConfirmedMediaRejection(error: unknown): boolean {
  return error instanceof MediaProcessingError && error.code === 'MEDIA_CONTENT_INVALID';
}
export function resolveMediaExecutable(binary: 'ffmpeg' | 'ffprobe'): string {
  const configured = process.env[binary === 'ffmpeg' ? 'DOUBAO_FFMPEG_PATH' : 'DOUBAO_FFPROBE_PATH'];
  if (configured) return configured;
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const file = process.platform === 'win32' ? `${binary}.exe` : binary;
  const candidates = [resources && path.join(resources, 'media-tools', file), resources && path.join(resources, 'bin', file),
    resources && path.join(resources, 'app.asar.unpacked', 'bin', file),
    ...(process.platform === 'darwin' ? [`/opt/homebrew/bin/${file}`, `/usr/local/bin/${file}`, `/usr/bin/${file}`] : [])];
  return candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate)) || file;
}
/** 无 shell、固定参数；保留 cause、退出码和有界 stderr 供诊断包串联。 */
export function mediaCommand(binary: 'ffmpeg' | 'ffprobe', args: string[]): Promise<string> {
  return new Promise((resolve, reject): void => {
    execFile(resolveMediaExecutable(binary), args, { timeout: 90_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr): void => {
      if (!error) { resolve(stdout); return; }
      const output = String(stderr || '').slice(-4096);
      const code: MediaFailureCode = error.code === 'ENOENT' ? 'MEDIA_TOOL_MISSING'
        : error.killed || error.signal ? 'MEDIA_TOOL_TIMEOUT'
        : ['EACCES', 'EPERM'].includes(String(error.code)) ? 'MEDIA_TOOL_PERMISSION'
        : /invalid data found|moov atom not found|error while decoding|invalid nal|corrupt decoded frame|partial file|invalid packet|error submitting packet/i.test(output) ? 'MEDIA_CONTENT_INVALID' : 'MEDIA_TOOL_FAILED';
      const reason = code === 'MEDIA_TOOL_MISSING' ? `${binary} 未安装或路径不可用，恢复工具后重新校验原文件`
        : code === 'MEDIA_TOOL_TIMEOUT' ? `${binary} 校验超时，可重新校验原文件`
        : code === 'MEDIA_TOOL_PERMISSION' ? `${binary} 无执行权限，修复权限后重新校验原文件`
        : code === 'MEDIA_CONTENT_INVALID' ? '真实媒体容器或解码数据损坏，原文件保留'
        : `${binary} 处理失败，可修复工具后重新校验原文件`;
      reject(new MediaProcessingError(code, reason, { cause: error, exitCode: error.code, stderr: output }));
    });
  });
}
export async function mediaDigest(filename: string): Promise<{ sha256: string; bytes: number }> {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('媒体文件缺失、为空或为符号链接');
  const hash = createHash('sha256');
  const file = await fs.open(filename, 'r');
  try { for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk); }
  finally { await file.close(); }
  return { sha256: hash.digest('hex'), bytes: stat.size };
}
export async function validatePetStoryMedia(filename: string, kind: 'image' | 'video'): Promise<PetStoryMediaValidation> {
  const digest = await mediaDigest(filename);
  const data = JSON.parse(await mediaCommand('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename])) as {
    streams?: { codec_type: string; codec_name: string; width?: number; height?: number; duration?: string }[];
    format?: { format_name?: string; duration?: string };
  };
  const stream = data.streams?.find((s): boolean => s.codec_type === 'video');
  if (!stream || !stream.width || !stream.height) throw new MediaProcessingError('MEDIA_CONTENT_INVALID', '媒体没有真实可解码画面尺寸');
  const duration = Number(stream.duration || data.format?.duration);
  if (kind === 'video' && (!data.format?.format_name?.split(',').some((format): boolean => ['mov', 'mp4'].includes(format))
    || ['png', 'mjpeg', 'webp', 'gif'].includes(stream.codec_name) || !Number.isFinite(duration) || duration < 5 || duration > 10)) throw new MediaProcessingError('MEDIA_CONTENT_INVALID', '真实视频必须为 MP4、实际时长 5～10 秒；素材保留并阻断下游，不重新生成');
  if (kind === 'image' && !['png', 'mjpeg', 'webp'].includes(stream.codec_name)) throw new MediaProcessingError('MEDIA_CONTENT_INVALID', '产物不是可用的 PNG/JPEG/WebP 图片');
  // ffprobe 元数据不等于可解码；完整解码全部视频画面，损坏不能用缩略图补过。
  await mediaCommand('ffmpeg', ['-v', 'error', '-xerror', '-err_detect', 'explode', '-i', filename, '-map', '0:v:0', ...(kind === 'image' ? ['-frames:v', '1'] : []), '-f', 'null', '-']);
  return { ...digest, width: stream.width, height: stream.height, durationSeconds: kind === 'video' ? duration : undefined, decoded: true, checkedAt: new Date().toISOString() };
}
export async function extractActualEndFrame(source: string, destination: string): Promise<{ validation: PetStoryMediaValidation; atSeconds: number }> {
  const video = await validatePetStoryMedia(source, 'video');
  // 对有效视频的全部解码画面做确定性黑帧检查，取时间区间内最后一张非黑帧。
  const metadata = await mediaCommand('ffmpeg', ['-v', 'error', '-xerror', '-i', source, '-map', '0:v:0', '-vf', 'blackframe=amount=0:threshold=32,metadata=mode=print:file=-', '-an', '-f', 'null', '-']);
  const frames = [...metadata.matchAll(/frame:(\d+)\s+pts:[^\n]*?pts_time:([\d.e+-]+)[^\n]*\n\s*lavfi\.blackframe\.pblack=([\d.]+)/g)];
  const last = frames.reverse().find((m): boolean => Number(m[2]) >= 0 && Number(m[2]) < (video.durationSeconds || 0) && Number(m[3]) < 98);
  if (!last) throw new Error('上一选中视频无有效区间内的可解码非黑画面，不能用计划尾帧替代');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await mediaCommand('ffmpeg', ['-v', 'error', '-xerror', '-i', source, '-vf', `select=eq(n\\,${Number(last[1])})`, '-frames:v', '1', '-fps_mode', 'vfr', '-n', destination]);
    return { validation: await validatePetStoryMedia(destination, 'image'), atSeconds: Number(last[2]) };
  } catch (error: unknown) { await fs.rm(destination, { force: true }); throw error; }
}
