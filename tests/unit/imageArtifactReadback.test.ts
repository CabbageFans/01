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
function imageCommandContinuation(): ChatPageSnapshot {
  return page({ historyComplete: true, messages: [
    { role: 'user', text: `生成图片：${prompt}`, messageId: 'TEST-user' },
    { role: 'assistant', text: 'TEST将按原请求生成三张图片的文字方案', messageId: 'TEST-proposal', replyId: 'TEST-user' },
    { role: 'user', text: '生成图片', messageId: 'TEST-generate-command' },
    { role: 'assistant', text: 'TEST三张图片已生成', messageId: 'TEST-generated-reply', replyId: 'TEST-generate-command',
      imageArtifactUrls: [originalUrl, 'https://TEST.invalid/second.png', 'https://TEST.invalid/third.png'], imageArtifactPending: false },
  ] });
}
function imageConfirmationContinuation(offer = '要不要为你生成这张图？', reply = '要'): ChatPageSnapshot {
  const snapshot = imageCommandContinuation(); snapshot.messages[1].text = offer; snapshot.messages[2].text = reply; return snapshot;
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

  it('完整历史中原回复只有文字方案，首个“生成图片”指令的明确回复可恢复三张原候选', (): void => {
    expect(inspectImageArtifactReadback(imageCommandContinuation(), context)).toMatchObject({ reason: 'ready',
      originalMessageId: 'TEST-user', outputs: [originalUrl, 'https://TEST.invalid/second.png', 'https://TEST.invalid/third.png'] });
  });

  it('原助手明确询问是否生成图片后，首个“要”的已存在图片回复可只读恢复', (): void => {
    expect(inspectImageArtifactReadback(imageConfirmationContinuation(), context)).toMatchObject({ reason: 'ready', originalMessageId: 'TEST-user',
      outputs: [originalUrl, 'https://TEST.invalid/second.png', 'https://TEST.invalid/third.png'] });
  });

  it('原助手明确问“你现在是要我直接调用生图生成这张图吗”后可关联用户的“要”', (): void => {
    const snapshot = imageConfirmationContinuation('你现在是要我直接调用生图生成这张图吗？');
    expect(inspectImageArtifactReadback(snapshot, context)).toMatchObject({ reason: 'ready', originalMessageId: 'TEST-user',
      outputs: [originalUrl, 'https://TEST.invalid/second.png', 'https://TEST.invalid/third.png'] });
  });

  it.each(['你现在是要我直接调用生图重新生成这张图吗？', '你现在是要我直接调用视频生成这张图吗？', '你现在是要我直接调用生图生成新角色吗？',
    '你现在是要我直接调用生图生成这张图，换成下雪吗？', '你现在是要我直接调用生图生成这张图吗？还是要换成猫？'] as const)('近似调用询问“%s”涉及重做、其他工具或新要求时不续接', (offer): void => {
    expect(inspectImageArtifactReadback(imageConfirmationContinuation(offer), context).outputs).toEqual([]);
  });

  it.each(['要', '要的', '是', '是的', '好', '好的', '可以', '可以的', '确认', '确定', '需要', '行', '好的！', '确认。'] as const)('完整短肯定“%s”只在原图片生成询问之后可只读续接', (reply): void => {
    expect(inspectImageArtifactReadback(imageConfirmationContinuation(undefined, reply), context).reason).toBe('ready');
    const unrelated = imageCommandContinuation(); unrelated.messages[2].text = reply;
    expect(inspectImageArtifactReadback(unrelated, context).outputs).toEqual([]);
  });

  it.each(['需要我帮你生成图片吗？', '是否要生成这张图片？', '要我现在直接生成图片吗？', '要不要我为你生成这张图？', '可以开始生成图片吗？',
    '是否开始生图？', '你要我直接出图吗？', '需要生成这张图吗？', '你想让我帮你绘制这张参考图吗？', 'TEST文字方案。\n**需要我直接生成对应图片吗？**',
    '需不需要我帮你画图？', '是否可以让我立即生成这幅图像？'] as const)('原助手末尾明确图片生成询问“%s”可关联首个肯定答复', (offer): void => {
    expect(inspectImageArtifactReadback(imageConfirmationContinuation(offer), context)).toMatchObject({ reason: 'ready', outputs: [originalUrl, 'https://TEST.invalid/second.png', 'https://TEST.invalid/third.png'] });
  });

  it.each(['TEST将按要求生成三张图', '这张图可以生成。', '需要我修改这张图吗？', '要不要重新生成这张图？', '要不要换成雪景后生成图片？',
    '需要我为你生成视频吗？', '需要我为你生成提示词吗？', '需要我为你生成一张16:9图片吗？', '需要我帮你吗？', '你要雪景还是雨景？',
    '用户问：“要不要为你生成这张图？”', '```要不要为你生成这张图？```'] as const)('普通说明、改图建议或其他询问“%s”不能把“要”当作原图片生成确认', (offer): void => {
    expect(inspectImageArtifactReadback(imageConfirmationContinuation(offer), context).outputs).toEqual([]);
  });

  it.each(['不要', '不需要', '要两张', '要，改成下雪', '好的，16:9', '可以，用新模型', '是另一张', '好的，换图', '确认修改', '好，但是换成猫'] as const)('否定、参数或新要求“%s”不属于图片生成短肯定', (reply): void => {
    expect(inspectImageArtifactReadback(imageConfirmationContinuation(undefined, reply), context).outputs).toEqual([]);
  });

  it.each(['incomplete-history', 'has-attachment', 'not-first-followup', 'duplicate-command-id', 'unknown-reply-parent', 'generic-image-only'] as const)('短肯定续接仍拒绝%s，不能降低图片归属与产物门槛', (variant): void => {
    const snapshot = imageConfirmationContinuation();
    if (variant === 'incomplete-history') snapshot.historyComplete = false;
    if (variant === 'has-attachment') snapshot.messages[2].hasAttachments = true;
    if (variant === 'not-first-followup') snapshot.messages.splice(2, 0, { role: 'user', text: 'TEST别的要求', messageId: 'TEST-other-request' });
    if (variant === 'duplicate-command-id') snapshot.messages.push({ role: 'user', text: 'TEST另一请求', messageId: snapshot.messages[2].messageId });
    if (variant === 'unknown-reply-parent') snapshot.messages[3].replyId = 'TEST-unknown-parent';
    if (variant === 'generic-image-only') { snapshot.messages[3].imageUrls = snapshot.messages[3].imageArtifactUrls; delete snapshot.messages[3].imageArtifactUrls; }
    expect(inspectImageArtifactReadback(snapshot, context).outputs).toEqual([]);
  });

  it('后续助手已改问其他事项或生图询问来自未知父链时，不能拿“要”串接图片', (): void => {
    const changedQuestion = imageConfirmationContinuation();
    changedQuestion.messages.splice(2, 0, { role: 'assistant', text: '需要我帮你整理成表格吗？', messageId: 'TEST-next-question', replyId: 'TEST-proposal' });
    expect(inspectImageArtifactReadback(changedQuestion, context).outputs).toEqual([]);
    const foreignQuestion = imageConfirmationContinuation(); foreignQuestion.messages[1].replyId = 'TEST-foreign-origin';
    expect(inspectImageArtifactReadback(foreignQuestion, context).outputs).toEqual([]);
  });

  it('原回复已有图片或待完成图卡时，即使后来询问生图并收到肯定也只保护原轮次', (): void => {
    const snapshot = imageConfirmationContinuation(); snapshot.messages[1].imageArtifactUrls = [originalUrl]; snapshot.messages[1].imageArtifactPending = false;
    expect(inspectImageArtifactReadback(snapshot, context)).toMatchObject({ reason: 'ready', outputs: [originalUrl] });
    snapshot.messages[1].imageArtifactUrls = []; snapshot.messages[1].imageArtifactPending = true;
    expect(inspectImageArtifactReadback(snapshot, context)).toMatchObject({ reason: 'image_pending', outputs: [] });
  });

  it.each(['开始生成', '帮我生成', '直接生成', '立即生成', '生成一下', '生成图像', '开始生图', '帮我画图', '直接出图', '生成吧', '出图吧',
    '请生成', '给我生成', '现在生成', '马上生成', '开始绘制', '立即绘制', '请直接生成图片', '帮我绘制一下', '给我出图吧', '请出图', '绘制图像', '生成图'] as const)('有限执行短句“%s”可只读接回原要求的图片，不新增创作要求', (text): void => {
      const snapshot = imageCommandContinuation(); snapshot.messages[2].text = text;
      expect(inspectImageArtifactReadback(snapshot, context)).toMatchObject({ reason: 'ready', originalMessageId: 'TEST-user',
        outputs: [originalUrl, 'https://TEST.invalid/second.png', 'https://TEST.invalid/third.png'] });
    });

  it.each(['重新生成', '帮我生成两张', '开始生成16:9', '直接生成，换成猫', '立即生成新场景', '生成吧，改成夜晚', '继续画第三张', '开 始生成', '用新模型生成',
    '请重新生成', '帮我修改图片', '现在生成3张', '请生成图片16:9', '给我生图2K', '立即绘制角色A', '请按新要求生成', '修改生图', '替换素材生成', '请生成图片并换成猫'] as const)('短句“%s”包含重做、参数或新要求时不能续接原结果', (text): void => {
      const snapshot = imageCommandContinuation(); snapshot.messages[2].text = text;
      expect(inspectImageArtifactReadback(snapshot, context).outputs).toEqual([]);
    });

  it('首个生成指令的已验证助手子链可恢复图片，但再下一用户轮次和未知父链不纳入', (): void => {
    const snapshot = imageCommandContinuation(); delete snapshot.messages[3].imageArtifactUrls; delete snapshot.messages[3].imageArtifactPending;
    snapshot.messages.push({ role: 'assistant', text: 'TEST生成工具产物', messageId: 'TEST-image-tool', replyId: 'TEST-generated-reply', imageArtifactUrls: [originalUrl] },
      { role: 'assistant', text: 'TEST未知父链', messageId: 'TEST-unknown-reply', replyId: 'TEST-unknown', imageArtifactUrls: ['https://TEST.invalid/foreign.png'] },
      { role: 'user', text: '生成图片', messageId: 'TEST-next-command' },
      { role: 'assistant', text: 'TEST第二次生成', messageId: 'TEST-next-reply', replyId: 'TEST-next-command', imageArtifactUrls: ['https://TEST.invalid/later.png'] });
    expect(inspectImageArtifactReadback(snapshot, context)).toMatchObject({ reason: 'ready', outputs: [originalUrl] });
  });

  it.each(['', '生成图片。', '生成一张图片', '生成图片，改成下雪', '重新生成图片'] as const)('空指令或完整短句不符（%s）不能把后续图片当成本次原结果', (text): void => {
    const snapshot = imageCommandContinuation(); snapshot.messages[2].text = text;
    expect(inspectImageArtifactReadback(snapshot, context).outputs).toEqual([]);
  });

  it.each(['attachmentOnly', 'hasAttachments', 'imageUrls'] as const)('生成指令含%s附件证据时不续接', (kind): void => {
    const snapshot = imageCommandContinuation();
    if (kind === 'imageUrls') snapshot.messages[2].imageUrls = ['https://TEST.invalid/reference.png'];
    else snapshot.messages[2][kind] = true;
    expect(inspectImageArtifactReadback(snapshot, context).outputs).toEqual([]);
  });

  it.each(['incomplete-history', 'not-first-followup', 'missing-command-id', 'local-command-id', 'missing-reply-parent', 'unknown-reply-parent'] as const)('%s不能取得生成指令回复的图片', (kind): void => {
    const snapshot = imageCommandContinuation();
    if (kind === 'incomplete-history') snapshot.historyComplete = false;
    if (kind === 'not-first-followup') snapshot.messages.splice(2, 0, { role: 'user', text: 'TEST另一创作要求', messageId: 'TEST-other-request' });
    if (kind === 'missing-command-id') delete snapshot.messages[2].messageId;
    if (kind === 'local-command-id') { snapshot.messages[2].messageId = 'local_TEST-command'; snapshot.messages[3].replyId = 'local_TEST-command'; }
    if (kind === 'missing-reply-parent') delete snapshot.messages[3].replyId;
    if (kind === 'unknown-reply-parent') snapshot.messages[3].replyId = 'TEST-unknown-parent';
    expect(inspectImageArtifactReadback(snapshot, context).outputs).toEqual([]);
  });

  it.each(['command', 'reply', 'original-user', 'proposal'] as const)('原或续接的%s服务器消息ID重复时不领取图片', (kind): void => {
    const snapshot = imageCommandContinuation();
    const index = kind === 'original-user' ? 0 : kind === 'proposal' ? 1 : kind === 'command' ? 2 : 3;
    snapshot.messages.push({ role: 'assistant', text: 'TEST重复消息身份', messageId: snapshot.messages[index].messageId });
    expect(inspectImageArtifactReadback(snapshot, context).outputs).toEqual([]);
  });

  it('原回复已有图或待完成图卡时保留原轮次，后来生成指令不能覆盖或绕过它', (): void => {
    const snapshot = imageCommandContinuation(); snapshot.messages[1].imageArtifactUrls = [originalUrl]; snapshot.messages[1].imageArtifactPending = false;
    expect(inspectImageArtifactReadback(snapshot, context)).toMatchObject({ reason: 'ready', outputs: [originalUrl] });
    snapshot.messages[1].imageArtifactUrls = []; snapshot.messages[1].imageArtifactPending = true;
    expect(inspectImageArtifactReadback(snapshot, context)).toMatchObject({ reason: 'image_pending', outputs: [] });
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

  it.each(['TEST-new-union', undefined] as const)('服务器消息ID与全文一致时，union turn变化或卸载（%s）不阻断原图', (turnId): void => {
    const snapshot = page(); snapshot.messages[0].turnId = turnId;
    snapshot.messages.push({ role: 'user', text: 'TEST后续无关请求', messageId: 'TEST-next-user', turnId: 'TEST-old-union' },
      { role: 'assistant', text: 'TEST后续图片', messageId: 'TEST-next-reply', replyId: 'TEST-next-user', imageArtifactUrls: ['https://TEST.invalid/later.png'] });
    expect(inspectImageArtifactReadback(snapshot, { ...context, userMessageId: 'TEST-user', userTurnId: 'TEST-old-union' }))
      .toMatchObject({ reason: 'ready', outputs: [originalUrl], originalMessageId: 'TEST-user' });
  });

  it('服务器消息ID错误或该消息全文已变时，匹配的union turn和其他同文请求不能替代原身份', (): void => {
    const snapshot = page(); snapshot.messages[0].turnId = 'TEST-shared-union';
    expect(inspectImageArtifactReadback(snapshot, { ...context, userMessageId: 'TEST-missing', userTurnId: 'TEST-shared-union' }))
      .toMatchObject({ reason: 'request_missing', outputs: [] });
    snapshot.messages[0].text = 'TEST原消息全文已变';
    snapshot.messages.push({ role: 'user', text: prompt, messageId: 'TEST-other-user', turnId: 'TEST-shared-union' },
      { role: 'assistant', text: 'TEST其他图片', messageId: 'TEST-other-reply', replyId: 'TEST-other-user', imageArtifactUrls: ['https://TEST.invalid/other.png'] });
    expect(inspectImageArtifactReadback(snapshot, { ...context, userMessageId: 'TEST-user', userTurnId: 'TEST-shared-union' }))
      .toMatchObject({ reason: 'request_missing', outputs: [] });
  });

  it('未保存服务器消息ID时，union turn不能从重复全文中挑出一条请求', (): void => {
    const snapshot = page(); snapshot.messages[0].turnId = 'TEST-first-union';
    snapshot.messages.push({ ...snapshot.messages[0], messageId: 'TEST-second-user', turnId: 'TEST-second-union' },
      { ...snapshot.messages[1], messageId: 'TEST-second-reply', replyId: 'TEST-second-user', imageArtifactUrls: ['https://TEST.invalid/second.png'] });
    expect(inspectImageArtifactReadback(snapshot, { ...context, userTurnId: 'TEST-first-union' }))
      .toMatchObject({ reason: 'request_ambiguous', outputs: [] });
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
  it('“要”之后已经生成的原图只需稳定采样，进度只输出肯定与询问布尔而不暴露正文', async (): Promise<void> => {
    let now = 0; const progress: ImageArtifactObservationProgress[] = [];
    const read = vi.fn(async (): Promise<ChatPageSnapshot> => imageConfirmationContinuation());
    const outputs = await waitForImageArtifactReadback({ context, ensureCurrent: (): void => undefined, read, now: (): number => now,
      wait: async (milliseconds: number): Promise<void> => { now += milliseconds; }, onProgress: (value: ImageArtifactObservationProgress): void => { progress.push(value); } });
    expect(outputs).toEqual([originalUrl, 'https://TEST.invalid/second.png', 'https://TEST.invalid/third.png']); expect(read).toHaveBeenCalledTimes(4); expect(now).toBe(1500);
    expect(progress[0].messageChain[1]).toMatchObject({ imageGenerationOffer: true }); expect(progress[0].messageChain[2]).toMatchObject({ imageGenerationAffirmation: true });
    expect(JSON.stringify(progress)).not.toContain(prompt); expect(JSON.stringify(progress)).not.toContain('要不要为你生成这张图'); expect(JSON.stringify(progress)).not.toContain(originalUrl);
  });
  it.each(['request_ambiguous', 'reply_ambiguous'] as const)('恢复完整历史的稳定%s仅500ms复读即结束，释放计时器且不含私密内容', async (reason): Promise<void> => {
    vi.useFakeTimers();
    const snapshot = page({ historyComplete: true });
    if (reason === 'request_ambiguous') snapshot.messages.push({ ...snapshot.messages[0], messageId: 'TEST-duplicate-user' });
    else snapshot.messages.push({ ...snapshot.messages[1] });
    const read = vi.fn(async (): Promise<ChatPageSnapshot> => snapshot);
    const pending = waitForImageArtifactReadback({ context, ensureCurrent: (): void => undefined, stopOnStableAmbiguity: true, read,
      wait: async (milliseconds: number): Promise<void> => new Promise((resolve: () => void): void => { setTimeout(resolve, milliseconds); }) });
    const rejected = expect(pending).rejects.toMatchObject({ reason, message: expect.not.stringContaining(prompt) });
    await vi.advanceTimersByTimeAsync(499); expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('首次生成默认继续等待完整历史暂时歧义，随后原图稳定可完成', async (): Promise<void> => {
    let now = 0; let polls = 0;
    const ambiguous = page({ historyComplete: true }); ambiguous.messages.push({ ...ambiguous.messages[0], messageId: 'TEST-duplicate-user' });
    const result = await waitForImageArtifactReadback({ context, ensureCurrent: (): void => undefined, now: (): number => now,
      wait: async (milliseconds: number): Promise<void> => { now += milliseconds; },
      read: async (): Promise<ChatPageSnapshot> => ++polls <= 3 ? ambiguous : page({ historyComplete: true }) });
    expect(result).toEqual([originalUrl]); expect(polls).toBe(7); expect(now).toBe(3000);
  });

  it('恢复不完整历史中的暂时歧义和变化中的完整结构继续观察，随后原图可恢复', async (): Promise<void> => {
    let now = 0; let polls = 0;
    const ambiguous = page({ historyComplete: true }); ambiguous.messages.push({ ...ambiguous.messages[0], messageId: 'TEST-duplicate-user' });
    const incomplete = { ...ambiguous, historyComplete: false };
    const changed = { ...ambiguous, messages: [...ambiguous.messages, { role: 'assistant' as const, text: 'TEST结构变化', messageId: 'TEST-extra-reply' }] };
    const snapshots = [incomplete, incomplete, ambiguous, changed, page()];
    const result = await waitForImageArtifactReadback({ context, ensureCurrent: (): void => undefined, stopOnStableAmbiguity: true, now: (): number => now,
      wait: async (milliseconds: number): Promise<void> => { now += milliseconds; },
      read: async (): Promise<ChatPageSnapshot> => { polls++; return snapshots.shift() || page(); } });
    expect(result).toEqual([originalUrl]); expect(polls).toBe(8);
  });

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
