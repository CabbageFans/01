import { describe, expect, it } from 'vitest';
import { inspectCreationReadback, inspectSubmittedImageReadback, type ChatPageSnapshot, type ChatReadbackContext } from '../../src/utils/chatReadback';

const prompt = 'TEST 原场景完整图片请求，固定角色与道路。';
const context: ChatReadbackContext = { taskId: 'TEST-task', runId: 'TEST-run', currentRunId: 'TEST-run', accountId: 'TEST-account', currentAccountId: 'TEST-account',
  conversationUrl: 'https://www.doubao.com/chat/TEST-original', currentConversationUrl: 'https://www.doubao.com/chat/TEST-original' };
const original: ChatPageSnapshot['messages'][number] = { role: 'user', text: `生成图片：${prompt}`, messageId: 'TEST-original-user', turnId: 'TEST-shared-union' };
const reply: ChatPageSnapshot['messages'][number] = { role: 'assistant', text: 'TEST 原图片已完成', messageId: 'TEST-original-reply', replyId: original.messageId };
function page(messages: ChatPageSnapshot['messages'], patch: Partial<ChatPageSnapshot> = {}): ChatPageSnapshot {
  return { messages, editorPresent: true, editorText: '', generating: false, historyComplete: true, ...patch };
}

describe('已提交图片的只读请求定位', (): void => {
  it('历史聊天和后发空消息不阻断唯一原全文，默认发送回执仍保持严格', (): void => {
    const snapshot = page([{ role: 'user', text: 'TEST 历史请求', messageId: 'TEST-old-user' }, { role: 'assistant', text: 'TEST 历史回复' }, original, reply,
      { role: 'user', text: '', messageId: 'TEST-empty-user', turnId: 'TEST-shared-union' }, { role: 'assistant', text: 'TEST 后发回复' }]);
    expect(inspectCreationReadback(snapshot, prompt, 'image', 0)).toMatchObject({ promptPublished: false, reason: 'user_ambiguous' });
    expect(inspectSubmittedImageReadback(snapshot, prompt, context)).toMatchObject({ promptPublished: true, userMessageId: original.messageId,
      originalMessageIndex: 2, originalAssistantMessageIndices: [3], followupUserMessageIndices: [4], generationContinuationMessageIndices: [], replyText: reply.text,
      candidates: [{ messageIndex: 3 }] });
  });

  it('同文重复保持歧义，仅已有服务器消息ID可选原请求，错误ID不得退回全文', (): void => {
    const snapshot = page([original, reply, { ...original, messageId: 'TEST-other-user' }, { ...reply, messageId: 'TEST-other-reply', replyId: 'TEST-other-user' }]);
    expect(inspectSubmittedImageReadback(snapshot, prompt, context)).toMatchObject({ promptPublished: false, reason: 'user_ambiguous' });
    expect(inspectSubmittedImageReadback(snapshot, prompt, { ...context, userMessageId: original.messageId })).toMatchObject({ promptPublished: true, originalMessageIndex: 0, originalAssistantMessageIndices: [1] });
    expect(inspectSubmittedImageReadback(snapshot, prompt, { ...context, userMessageId: 'TEST-missing' })).toMatchObject({ promptPublished: false, reason: 'user_ambiguous' });
  });

  it('已存消息ID不能豁免全文校验或ID唯一性，整会话共享turn也不能认领其它请求', (): void => {
    const recorded = { ...context, userMessageId: original.messageId, userTurnId: original.turnId };
    expect(inspectSubmittedImageReadback(page([{ ...original, text: original.text + 'TEST 追加要求' }, reply]), prompt, recorded).promptPublished).toBe(false);
    expect(inspectSubmittedImageReadback(page([original, reply, { role: 'user', text: 'TEST 其它请求', messageId: original.messageId }]), prompt, recorded).promptPublished).toBe(false);
    expect(inspectSubmittedImageReadback(page([{ ...original, text: 'TEST 其它请求' }, reply]), prompt, { ...context, userTurnId: original.turnId }).promptPublished).toBe(false);
  });

  it.each([{}, { attachmentOnly: true }])('后发空用户消息均截止原轮次，不续接之后的图片回复：%j', (patch: { attachmentOnly?: boolean }): void => {
    const snapshot = page([original, reply, { role: 'user', text: '', messageId: 'TEST-upload', turnId: original.turnId, ...patch },
      { role: 'assistant', text: 'TEST 后发图片', messageId: 'TEST-later-reply', replyId: reply.messageId }]);
    expect(inspectSubmittedImageReadback(snapshot, prompt, context)).toMatchObject({ promptPublished: true, originalAssistantMessageIndices: [1], followupUserMessageIndices: [2], generationContinuationMessageIndices: [] });
  });

  it('原附件不算重复请求，同轮工具沿明确父链保留，未知父链助手排除', (): void => {
    const snapshot = page([{ role: 'user', text: '', attachmentOnly: true, turnId: original.turnId }, original, reply,
      { role: 'assistant', text: 'TEST 无关助手', messageId: 'TEST-foreign-reply', replyId: 'TEST-unknown' },
      { role: 'assistant', text: 'TEST 原工具图片', messageId: 'TEST-tool-reply', replyId: reply.messageId }]);
    expect(inspectSubmittedImageReadback(snapshot, prompt, context)).toMatchObject({ promptPublished: true, originalMessageIndex: 1, originalAssistantMessageIndices: [2, 4],
      candidates: [{ messageIndex: 2 }, { messageIndex: 4 }] });
  });

  it.each([{ currentRunId: 'TEST-other-run' }, { currentAccountId: 'TEST-other-account' }, { currentConversationUrl: 'https://www.doubao.com/chat/TEST-other' }])('正式上下文变化立即拒绝原消息：%j', (patch: Partial<ChatReadbackContext>): void => {
    expect(inspectSubmittedImageReadback(page([original, reply]), prompt, { ...context, ...patch })).toMatchObject({ promptPublished: false, reason: 'context_changed' });
  });

  it('未发送草稿不证明已发布，用户后续草稿不否定原请求', (): void => {
    expect(inspectSubmittedImageReadback(page([], { editorText: prompt }), prompt, context).promptPublished).toBe(false);
    expect(inspectSubmittedImageReadback(page([original, reply], { editorText: 'TEST 后续草稿' }), prompt, context)).toMatchObject({ promptPublished: true, inputCleared: false });
  });
});
