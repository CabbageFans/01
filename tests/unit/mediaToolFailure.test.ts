import { describe, expect, it, vi } from 'vitest';
const command = vi.hoisted(() => ({ failure: { code: 'ENOENT', message: 'spawn ffprobe ENOENT' } as Error & { code?: string; killed?: boolean; signal?: string } }));
vi.mock('node:child_process', () => ({ execFile: (_file: string, _args: string[], _options: object, callback: (error: Error, out: string, stderr: string) => void): void => callback(command.failure, '', 'test stderr') }));
import { mediaCommand } from '../../main/utils/petstoryMedia';
describe('媒体工具故障归属', (): void => {
  it('保留工具缺失的分类和原始 cause，不当成内容损坏', async (): Promise<void> => {
    await expect(mediaCommand('ffprobe', ['-version'])).rejects.toMatchObject({ code: 'MEDIA_TOOL_MISSING', cause: command.failure, stderr: 'test stderr' });
  });
  it('工具超时保持为可重新校验的工具故障', async (): Promise<void> => {
    command.failure = Object.assign(new Error('killed after timeout'), { killed: true, signal: 'SIGTERM' });
    await expect(mediaCommand('ffmpeg', ['-version'])).rejects.toMatchObject({ code: 'MEDIA_TOOL_TIMEOUT', cause: command.failure });
  });
});
