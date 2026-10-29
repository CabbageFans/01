/** 回复哈希与正文保真纯测试；输入为离线页面快照，无平台请求。 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPetStoryConversationReplies } from '../../src/utils/petstoryConversationReplies';
import { conversationReplyKey } from '../../main/utils/petstoryAdjustment';
import type { ChatPageSnapshot } from '../../src/utils/chatReadback';

function snapshot(messages: ChatPageSnapshot['messages'], generating: boolean = false): ChatPageSnapshot { return { messages, generating, editorPresent: true, editorText: 'TEST 用户未发送草稿' }; }
function message(role: 'user' | 'assistant', rawText: string, suffix: string = ''): ChatPageSnapshot['messages'][number] { return { role, rawText, text: rawText.replace(/\s+/g, ' '), turnId: `TEST-turn-${suffix}`, messageId: `TEST-message-${suffix}` }; }
beforeEach((): void => { vi.stubGlobal('crypto', webcrypto); });
afterEach((): void => { vi.unstubAllGlobals(); });

describe('明确回复标识与原文', (): void => {
  it('完整段落、围栏、原始标点和前一用户正文原样保留，前后端hash一致', async (): Promise<void> => {
    const text = '  方案正文\n\n```json\n{"optimized":"保持原台词：ＡＢＣ！"}\n```\n  ';
    const input = snapshot([message('user', '  TEST 指定本镜\n保留原台词。', 'user'), message('assistant', text, 'answer')]);
    const result = await readPetStoryConversationReplies(input);
    expect(result).toHaveLength(1); expect(result[0].text).toBe(text); expect(result[0].precedingUserText).toBe(input.messages[0].rawText);
    expect(result[0].key).toBe(conversationReplyKey(result[0])); expect(input.editorText).toBe('TEST 用户未发送草稿');
  });
  it('同样的助手正文在不同用户轮次中有不同标识，按页面顺序展示而不默认采用', async (): Promise<void> => {
    const result = await readPetStoryConversationReplies(snapshot([message('user', 'TEST 先讨论首帧', '1'), message('assistant', 'TEST 完整回复', '2'), message('user', 'TEST 再讨论尾帧', '3'), message('assistant', 'TEST 完整回复', '4')]));
    expect(result).toHaveLength(2); expect(result[0].key).not.toBe(result[1].key); expect(result.map((reply): string => reply.precedingUserText)).toEqual(['TEST 先讨论首帧', 'TEST 再讨论尾帧']);
  });
  it('正在生成时不输出中间回复；无前置用户消息的助手正文不被猜测关联', async (): Promise<void> => {
    await expect(readPetStoryConversationReplies(snapshot([message('user', 'TEST 用户'), message('assistant', 'TEST 半条回复')], true))).rejects.toThrow('正在回复');
    expect(await readPetStoryConversationReplies(snapshot([message('assistant', 'TEST 无归属回复')]))).toEqual([]);
  });
  it('空用户消息切断归属，不把后面的助手内容绑定到较早的用户文本', async (): Promise<void> => {
    const result = await readPetStoryConversationReplies(snapshot([message('user', 'TEST 旧用户文本', '1'), message('assistant', 'TEST 旧回复', '2'), { role: 'user', text: '', rawText: '', attachmentOnly: true, turnId: 'TEST-unreadable-user' }, message('assistant', 'TEST 上下文不明确的新回复', '3')]));
    expect(result.map((reply): string => reply.text)).toEqual(['TEST 旧回复']);
  });
  it('重复不可辨认的消息或超过100条时拒绝给出看似可选的回复', async (): Promise<void> => {
    const user = message('user', 'TEST 当前用户', 'user'); const answer = message('assistant', 'TEST 相同正文', 'answer');
    await expect(readPetStoryConversationReplies(snapshot([user, answer, answer]))).rejects.toThrow('无法唯一识别');
    await expect(readPetStoryConversationReplies(snapshot([user, ...Array.from({ length: 101 }, (_, index): ChatPageSnapshot['messages'][number] => message('assistant', `TEST 回复 ${index}`, String(index)))]))).rejects.toThrow('无法唯一识别');
  });
  it('无稳定正文时不使用经过空白归一的text冒充完整原文；有renderedSource时按原文读取', async (): Promise<void> => {
    const result = await readPetStoryConversationReplies(snapshot([message('user', 'TEST 用户', 'u'), { role: 'assistant', text: 'TEST 压缩文本' }, { role: 'assistant', text: 'TEST 压缩文本', renderedSource: '# TEST 标题\n\n完整正文', messageId: 'TEST-formatted' }]));
    expect(result).toHaveLength(1); expect(result[0].text).toBe('# TEST 标题\n\n完整正文');
  });
});
