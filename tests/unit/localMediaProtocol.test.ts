import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { LocalMediaStreams } from '../../main/utils/LocalMediaProtocol';
let directory: string; let filename: string; let streams: LocalMediaStreams; let url: string;
beforeEach(async (): Promise<void> => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-stream-')); filename = path.join(directory, 'video.mp4'); await fs.writeFile(filename, '0123456789'); streams = new LocalMediaStreams(); url = await streams.issue(filename, 10); });
afterEach(async (): Promise<void> => { await fs.rm(directory, { recursive: true, force: true }); });
it('只发放不含实际路径的临时URL，完整读取与Range使用同一实际文件', async (): Promise<void> => {
  expect(url).not.toContain(directory); expect(url).toMatch(/^doubao-media:\/\/asset\/[a-f0-9]{64}$/);
  const partial = await streams.respond(new Request(url, { headers: { range: 'bytes=2-5' } }));
  expect(partial.status).toBe(206); expect(partial.headers.get('content-range')).toBe('bytes 2-5/10'); expect(await partial.text()).toBe('2345');
  expect(await (await streams.respond(new Request(url))).text()).toBe('0123456789');
});
it('拒绝未知能力、越界Range和替换文件', async (): Promise<void> => {
  expect((await streams.respond(new Request('doubao-media://asset/unknown'))).status).toBe(403);
  expect((await streams.respond(new Request(url, { headers: { range: 'bytes=90-' } }))).status).toBe(416);
  await fs.writeFile(filename, 'altered-file');
  expect((await streams.respond(new Request(url))).status).toBe(409);
});
it('支持suffix Range与HEAD，不把整文件装入IPC', async (): Promise<void> => {
  const suffix = await streams.respond(new Request(url, { headers: { range: 'bytes=-3' } })); expect(await suffix.text()).toBe('789');
  const head = await streams.respond(new Request(url, { method: 'HEAD' })); expect(head.headers.get('content-length')).toBe('10'); expect(await head.text()).toBe('');
});
