import { describe, expect, it } from 'vitest';
import { parseConversationScanData } from '../../src/utils/videoArtifactResolver';

describe('视频卡片归属', (): void => {
  it('多个视频分别绑定自己的vid，不把第一棵子树的身份贴给所有URL', (): void => {
    const result = parseConversationScanData({ messages: [
      { video: { vid: 'first-vid', play_info: { main_url: 'https://vod.example.com/first.mp4' } } },
      { video: { vid: 'second-vid', original_media_info: { main_url: 'https://vod.example.com/second.mp4' } } },
    ] });
    expect(result.candidates.map((item): object => ({ url: item.url, vid: item.vid }))).toEqual([
      { url: 'https://vod.example.com/first.mp4', vid: 'first-vid' }, { url: 'https://vod.example.com/second.mp4', vid: 'second-vid' },
    ]);
    expect(result.vid).toBeUndefined();
  });
});
