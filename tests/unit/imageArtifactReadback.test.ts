import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatPageSnapshot } from '../../src/utils/chatReadback';
import { ImageArtifactObservationError, imageGenerationBlocker, inspectImageArtifactReadback, waitForImageArtifactReadback,
  type ImageArtifactReadbackContext, type ImageArtifactObservationProgress } from '../../src/utils/imageArtifactReadback';

const prompt = 'TEST 原图片完整请求，固定原角色和场景。';
const context: ImageArtifactReadbackContext = { prompt, runId: 'TEST-run' };
const originalUrl = 'https://TEST.invalid/original.png';
function page(patch: Partial<ChatPageSnapshot> = {}): ChatPageSnapshot {
  return { messages: [{ role: 'user', text: `生成图片：${prompt}`, messageId: 'TEST-user' },
    { role: 'assistant', text: 'TEST图片', messageId: 'TEST-reply', replyId: 'TEST-user', imageArtifactUrls: [originalUrl], imageArtifactPending: false }],
  editorPresent: true, editorText: '', generating: false, ...patch };
}
afterEach((): void => { vi.useRealTimers(); });

describe('原图片请求关联的严格产物证据', (): void => {
  it('排除前后轮次、用户参考图和普通回复图片，仅收原请求助手卡', (): void => {
    const original = page();
    const snapshot = page({ messages: [{ role: 'user', text: 'TEST历史请求', messageId: 'TEST-old-user' },
      { role: 'assistant', text: 'TEST历史图', messageId: 'TEST-old-reply', replyId: 'TEST-old-user', imageArtifactUrls: ['https://TEST.invalid/history.png'] },
      { role: 'user', text: '', attachmentOnly: true, imageUrls: ['https://TEST.invalid/reference.png'] }, ...original.messages,
      { role: 'assistant', text: 'TEST其它父链', messageId: 'TEST-foreign-reply', replyId: 'TEST-old-user', imageArtifactUrls: ['https://TEST.invalid/foreign.png'] },
      { role: 'user', text: 'TEST后续请求', messageId: 'TEST-later-user' },
      { role: 'assistant', text: 'TEST后续图', messageId: 'TEST-later-reply', replyId: 'TEST-later-user', imageArtifactUrls: ['https://TEST.invalid/later.png'] }], generating: true });
    snapshot.messages[4].imageUrls = ['https://TEST.invalid/large-avatar.png'];
    expect(inspectImageArtifactReadback(snapshot, context)).toMatchObject({ reason: 'ready', outputs: [originalUrl], originalMessageId: 'TEST-user' });
  });

  it('原助手工具子链内可以保留多张真实候选，不跨未知父链', (): void => {
    const snapshot = page(); snapshot.messages.push({ role: 'assistant', text: '', messageId: 'TEST-tool', replyId: 'TEST-reply', imageArtifactUrls: ['https://TEST.invalid/second.png'] });
    expect(inspectImageArtifactReadback(snapshot, context).outputs).toEqual([originalUrl, 'https://TEST.invalid/second.png']);
  });

  it('后发纯图片消息立即截断原轮次，无父链ID的晚图也不能顶替原结果', (): void => {
    const snapshot = page(); delete snapshot.messages[1].imageArtifactUrls;
    snapshot.messages.push({ role: 'user', text: '', attachmentOnly: true, messageId: 'TEST-later-upload', imageUrls: ['https://TEST.invalid/reference.png'] },
      { role: 'assistant', text: 'TEST晚图片', messageId: 'TEST-later-reply', imageArtifactUrls: ['https://TEST.invalid/later.png'] });
    expect(inspectImageArtifactReadback(snapshot, context)).toMatchObject({ reason: 'image_pending', outputs: [] });
    snapshot.messages[1].imageArtifactUrls = [originalUrl];
    expect(inspectImageArtifactReadback(snapshot, context)).toMatchObject({ reason: 'ready', outputs: [originalUrl] });
  });

  it('普通imageUrls、只有助手图片或被卸载的原请求都不能成为本次产物', (): void => {
    const generic = page(); delete generic.messages[1].imageArtifactUrls; generic.messages[1].imageUrls = [originalUrl];
    expect(inspectImageArtifactReadback(generic, context)).toMatchObject({ reason: 'image_pending', outputs: [] });
    expect(inspectImageArtifactReadback(page({ messages: [page().messages[1]] }), context)).toMatchObject({ reason: 'request_missing', outputs: [] });
    expect(inspectImageArtifactReadback(page({ messages: [] }), context)).toMatchObject({ reason: 'request_missing', outputs: [] });
  });

  it('相同全文出现两次时保持歧义，已记录的真实消息ID只能选择对应原轮次', (): void => {
    const snapshot = page(); snapshot.messages.push({ ...snapshot.messages[0], messageId: 'TEST-second-user' },
      { ...snapshot.messages[1], messageId: 'TEST-second-reply', replyId: 'TEST-second-user', imageArtifactUrls: ['https://TEST.invalid/second.png'] });
    expect(inspectImageArtifactReadback(snapshot, context)).toMatchObject({ reason: 'request_ambiguous', outputs: [] });
    expect(inspectImageArtifactReadback(snapshot, { ...context, userMessageId: 'TEST-user' }).outputs).toEqual([originalUrl]);
    expect(inspectImageArtifactReadback(snapshot, { ...context, userMessageId: 'TEST-missing' }).outputs).toEqual([]);
  });

  it('记录的turn身份不符、原用户ID或助手ID重复时不绑定', (): void => {
    expect(inspectImageArtifactReadback(page(), { ...context, userTurnId: 'TEST-expected-turn' }).outputs).toEqual([]);
    const repeatedUser = page(); repeatedUser.messages.push({ role: 'user', text: 'TEST另一个请求', messageId: 'TEST-user' });
    expect(inspectImageArtifactReadback(repeatedUser, context).reason).toBe('request_ambiguous');
    const repeatedReply = page(); repeatedReply.messages.push({ ...repeatedReply.messages[1] });
    expect(inspectImageArtifactReadback(repeatedReply, context).reason).toBe('reply_ambiguous');
  });

  it('无消息ID只在原执行器已证空白基线且唯一user/assistant的快照中允许', (): void => {
    const snapshot = page(); for (const message of snapshot.messages) { delete message.messageId; delete message.replyId; }
    expect(inspectImageArtifactReadback(snapshot, context).outputs).toEqual([]);
    const authorized = { ...context, allowUnidentifiedNewConversation: true };
    expect(inspectImageArtifactReadback(snapshot, authorized).outputs).toEqual([originalUrl]);
    snapshot.messages.push({ role: 'assistant', text: 'TEST另一回复', imageArtifactUrls: ['https://TEST.invalid/extra.png'] });
    expect(inspectImageArtifactReadback(snapshot, authorized).outputs).toEqual([]);
  });

  it('原轮次生成仍在进行或另有图片卡尚未加载时保持等待', (): void => {
    expect(inspectImageArtifactReadback(page({ generating: true }), context).reason).toBe('generation_in_progress');
    const pending = page(); pending.messages[1].imageArtifactPending = true;
    expect(inspectImageArtifactReadback(pending, context)).toMatchObject({ reason: 'image_pending', outputs: [originalUrl] });
  });

  it('只报告原轮次明确平台失败，不读用户请求、历史失败和后续失败', (): void => {
    const failed = page(); failed.messages[1].imageArtifactFailure = '图片生成失败';
    expect(inspectImageArtifactReadback(failed, context).blocker).toBe('平台提示图片生成失败');
    const snapshot = page(); snapshot.messages.unshift({ role: 'assistant', text: '图片生成失败，请重试。', messageId: 'TEST-history-error' });
    snapshot.messages.push({ role: 'user', text: 'TEST新请求', messageId: 'TEST-next' }, { role: 'assistant', text: '图片生成失败，请重试。', messageId: 'TEST-next-error', replyId: 'TEST-next' });
    expect(inspectImageArtifactReadback(snapshot, context)).toMatchObject({ reason: 'ready', outputs: [originalUrl] });
    expect(imageGenerationBlocker('TEST故事里出现“图片生成失败”的提示。')).toBeUndefined();
    expect(imageGenerationBlocker('图片生成额度不足，请稍后再试。')).toBe('平台提示图片生成额度不足');
    expect(imageGenerationBlocker('请求未通过内容审核。')).toBe('平台提示图片请求未通过内容审核');
  });
});

describe('图片产物稳定观察的异步边界', (): void => {
  it('短暂缺失不吞掉原结果，候选集合变化后重新连续采样才完成', async (): Promise<void> => {
    let now = 0; let polls = 0;
    const progress: ImageArtifactObservationProgress[] = [];
    const result = await waitForImageArtifactReadback({ context, ensureCurrent: (): void => undefined, now: (): number => now,
      wait: async (milliseconds: number): Promise<void> => { now += milliseconds; },
      read: async (): Promise<ChatPageSnapshot> => {
        polls++; if (polls === 1 || polls === 3) return page({ messages: [] });
        const snapshot = page(); if (polls >= 5) snapshot.messages[1].imageArtifactUrls!.push('https://TEST.invalid/second.png'); return snapshot;
      }, onProgress: (value: ImageArtifactObservationProgress): void => { progress.push(value); }, timeoutMs: 10_000 });
    expect(result).toEqual([originalUrl, 'https://TEST.invalid/second.png']); expect(polls).toBe(8);
    expect(JSON.stringify(progress)).not.toContain(originalUrl); expect(JSON.stringify(progress)).not.toContain(prompt);
  });

  it.each(['abort', 'context'] as const)('最后一次产物读取期间%s也不能返回迟到产物', async (change): Promise<void> => {
    let now = 0; let polls = 0; let current = true; const controller = new AbortController();
    const pending = waitForImageArtifactReadback({ context, signal: controller.signal, now: (): number => now,
      ensureCurrent: (): void => { if (!current) throw new Error('TEST original context changed'); },
      wait: async (milliseconds: number): Promise<void> => { now += milliseconds; },
      read: async (): Promise<ChatPageSnapshot> => { if (++polls === 4) { if (change === 'abort') controller.abort(); else current = false; } return page(); } });
    if (change === 'abort') await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    else await expect(pending).rejects.toThrow('TEST original context changed');
    expect(polls).toBe(4);
  });

  it('首次识别的用户消息ID不能被后来唯一同文消息替换', async (): Promise<void> => {
    let polls = 0;
    await expect(waitForImageArtifactReadback({ context, ensureCurrent: (): void => undefined,
      wait: async (): Promise<void> => undefined,
      read: async (): Promise<ChatPageSnapshot> => { const snapshot = page(); if (++polls > 1) { snapshot.messages[0].messageId = 'TEST-other'; snapshot.messages[1].replyId = 'TEST-other'; } return snapshot; } }))
      .rejects.toThrow('用户消息身份已变化');
    expect(polls).toBe(2);
  });

  it('原卡明确失败立即结束，不等15分钟或重新发送', async (): Promise<void> => {
    const read = vi.fn(async (): Promise<ChatPageSnapshot> => { const snapshot = page(); snapshot.messages[1].text = '图片生成失败，请稍后重试。'; return snapshot; });
    const wait = vi.fn(async (): Promise<void> => undefined);
    await expect(waitForImageArtifactReadback({ context, ensureCurrent: (): void => undefined, read, wait })).rejects.toMatchObject({ reason: 'platform_blocked' });
    expect(read).toHaveBeenCalledOnce(); expect(wait).not.toHaveBeenCalled();
  });

  it('挂起读取受硬截止限制，取消同样立即终止并清理宿主定时器', async (): Promise<void> => {
    vi.useFakeTimers(); const controller = new AbortController();
    const read = vi.fn((): Promise<ChatPageSnapshot> => new Promise<ChatPageSnapshot>((): void => undefined));
    const first = waitForImageArtifactReadback({ context, ensureCurrent: (): void => undefined, read, wait: async (): Promise<void> => undefined, timeoutMs: 1000 });
    const firstRejected = expect(first).rejects.toBeInstanceOf(ImageArtifactObservationError); await vi.advanceTimersByTimeAsync(1000); await firstRejected;
    const second = waitForImageArtifactReadback({ context, signal: controller.signal, ensureCurrent: (): void => undefined, read, wait: async (): Promise<void> => undefined });
    const secondRejected = expect(second).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await secondRejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
