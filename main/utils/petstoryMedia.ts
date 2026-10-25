import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { PetStoryMediaValidation } from '@doubao-studio/contracts';

/** 无 shell、固定参数；本模块只校验媒体及提取真实末帧，不做 P5 合成。 */
export function mediaCommand(binary: 'ffmpeg' | 'ffprobe', args: string[]): Promise<string> {
  const executable = process.platform === 'darwin' ? `/opt/homebrew/bin/${binary}` : binary;
  return new Promise((resolve, reject): void => {
    execFile(executable, args, { timeout: 90_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout): void => {
      if (error) reject(new Error(`${binary}媒体处理失败，请检查工具和真实文件；已停止且不重新生成`));
      else resolve(stdout);
    });
  });
}
export async function mediaDigest(filename: string): Promise<{ sha256: string; bytes: number }> {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 512 * 1024 * 1024) throw new Error('媒体文件缺失、为空、过大或为符号链接');
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
  if (!stream || !stream.width || !stream.height) throw new Error('媒体没有真实可解码画面尺寸');
  const duration = Number(stream.duration || data.format?.duration);
  if (kind === 'video' && (!data.format?.format_name?.split(',').some((format): boolean => ['mov', 'mp4'].includes(format))
    || ['png', 'mjpeg', 'webp', 'gif'].includes(stream.codec_name) || !Number.isFinite(duration) || duration < 5 || duration > 10)) throw new Error('真实视频必须为 MP4、实际时长 5～10 秒；素材保留并阻断下游，不重新生成');
  if (kind === 'image' && !['png', 'mjpeg', 'webp'].includes(stream.codec_name)) throw new Error('产物不是可用的 PNG/JPEG/WebP 图片');
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
