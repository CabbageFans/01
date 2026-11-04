import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCurrentCreationConversation } from '../../src/utils/creationConversationIdentity';
import { inspectCreationReadback, readChatPage, type ChatPageSnapshot } from '../../src/utils/chatReadback';
import { mediaSubmissionReceiptFor } from '../../src/utils/mediaSubmissionReceipt';
import type { Task } from '@doubao-studio/contracts';

interface FiberElement extends HTMLElement { __reactFiber$TEST?: object }
type Model = { conversation_id: string; message_id: string; reply_id?: string; content_blocks?: unknown[]; content_blocks_v2?: unknown[]; content_block?: unknown[]; cookie?: string };
const conversationId = 'OFFLINE-server-conversation';
const prompt = 'OFFLINE完整原图片请求，保留逐字身份。';
function model(id: string, text: string): Model {
  return { conversation_id: conversationId, message_id: id, content_blocks: [{ block_type: 10000, content_obj: { text } }] };
}
function fixture(): { list: FiberElement; user: FiberElement; assistant: FiberElement; userModel: Model; assistantModel: Model;
  props: { conversationId: string; dataList: { type: string; conversationId: string; data: { messageId: string; isLocalMessage: boolean }[] }[]; onLoadMore: ReturnType<typeof vi.fn> } } {
  const userModel = model('OFFLINE-user-message', `生成图片：${prompt}`);
  const assistantModel = { ...model('OFFLINE-assistant-message', 'OFFLINE正在生成图片'), reply_id: userModel.message_id };
  const props = { conversationId, dataList: [{ type: 'block', conversationId, data: [
    { messageId: userModel.message_id, isLocalMessage: false }, { messageId: assistantModel.message_id, isLocalMessage: false },
  ] }], onLoadMore: vi.fn() };
  const list = document.createElement('div') as FiberElement; list.setAttribute('data-testid', 'message-list');
  list.__reactFiber$TEST = { return: { return: { memoizedProps: props } } };
  const messageNode = (role: 'user' | 'assistant', dto: Model): FiberElement => {
    const node = document.createElement('div') as FiberElement;
    node.setAttribute('data-testid', role === 'user' ? 'send_message' : 'receive_message'); node.setAttribute('data-message-role', role);
    const content = document.createElement('div'); content.setAttribute('data-testid', 'message_text_content'); content.textContent = 'OFFLINE界面折叠文字'; node.append(content);
    node.__reactFiber$TEST = { return: { return: { memoizedProps: { value: { message: dto } } } } };
    list.append(node); return node;
  };
  const user = messageNode('user', userModel); const assistant = messageNode('assistant', assistantModel); document.body.append(list);
  return { list, user, assistant, userModel, assistantModel, props };
}
afterEach((): void => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('当前创作列表的服务器会话身份（只读）', (): void => {
  it('地址栏尚无具体URL时，从唯一列表与provider取得真实全文和服务器消息ID', (): void => {
    const test = fixture(); const before = document.body.innerHTML;
    const result = readCurrentCreationConversation(document, readChatPage);
    expect(result).toMatchObject({ conversationId, conversationUrl: `https://www.doubao.com/chat/${conversationId}`, source: 'published_message',
      messageIds: ['OFFLINE-user-message', 'OFFLINE-assistant-message'], snapshot: { historyComplete: true, conversationId, messages: [
        { role: 'user', rawText: `生成图片：${prompt}`, messageId: 'OFFLINE-user-message' },
        { role: 'assistant', replyId: 'OFFLINE-user-message' },
      ] } });
    expect(inspectCreationReadback(result.snapshot, prompt, 'image', 0).promptPublished).toBe(true);
    expect(document.body.innerHTML).toBe(before); expect(test.props.onLoadMore).not.toHaveBeenCalled();
  });

  it('函数序列化后独立执行，不依赖渲染进程闭包或平台方法', (): void => {
    fixture();
    const result = window.eval(`(${readCurrentCreationConversation.toString()})(document, (${readChatPage.toString()}))`) as ReturnType<typeof readCurrentCreationConversation>;
    expect(result.source).toBe('published_message'); expect(result.conversationId).toBe(conversationId);
    expect(inspectCreationReadback(result.snapshot, prompt, 'image', 0).promptPublished).toBe(true);
  });

  it.each(['missing', 'multiple', 'nested'] as const)('%s活动列表不给原消息发布来源', (kind): void => {
    const test = fixture();
    if (kind === 'missing') test.list.remove();
    else {
      const other = document.createElement('div'); other.setAttribute('data-testid', 'message-list');
      (kind === 'nested' ? test.list : document.body).append(other);
    }
    const result = readCurrentCreationConversation(document, readChatPage);
    expect(result.source).toBeUndefined(); expect(result.conversationUrl).toBeUndefined();
    expect(result.reason).toBe(kind === 'missing' ? 'message_list_missing' : 'message_list_ambiguous');
  });

  it.each(['local_OFFLINE', '', 'OFFLINE/other', 'https://evil.invalid/chat/id'] as const)('临时或非法列表会话ID拒绝：%s', (id): void => {
    const test = fixture(); test.props.conversationId = id; test.props.dataList[0].conversationId = id;
    const result = readCurrentCreationConversation(document, readChatPage);
    expect(result.source).toBeUndefined(); expect(result.conversationId).toBeUndefined();
  });

  it.each(['block', 'provider-conversation', 'provider-message', 'duplicate-list-id', 'role', 'ancestor'] as const)('%s身份冲突时不得认领当前页', (kind): void => {
    const test = fixture();
    if (kind === 'block') test.props.dataList[0].conversationId = 'OFFLINE-other';
    if (kind === 'provider-conversation') test.userModel.conversation_id = 'OFFLINE-other';
    if (kind === 'provider-message') test.userModel.message_id = 'OFFLINE-absent';
    if (kind === 'duplicate-list-id') test.props.dataList[0].data.push({ messageId: 'OFFLINE-user-message', isLocalMessage: false });
    if (kind === 'role') test.user.setAttribute('data-message-role', 'assistant');
    if (kind === 'ancestor') test.list.__reactFiber$TEST = { memoizedProps: test.props, return: { memoizedProps: { ...test.props, conversationId: 'OFFLINE-other' } } };
    const result = readCurrentCreationConversation(document, readChatPage);
    expect(result.source).toBeUndefined(); expect(result.conversationUrl).toBeUndefined(); expect(result.reason).toBe('conversation_identity_conflict');
  });

  it('DOM显示完整文字但缺provider或尚有未挂载服务器消息时，不把部分页面升级为唯一全文证明', (): void => {
    const test = fixture(); test.user.querySelector('[data-testid="message_text_content"]')!.textContent = prompt;
    test.props.dataList[0].data.push({ messageId: 'OFFLINE-unmounted-possible-duplicate-user', isLocalMessage: false });
    const result = readCurrentCreationConversation(document, readChatPage);
    expect(result.source).toBeUndefined(); expect(result.reason).toBe('message_models_incomplete'); expect(result.snapshot.historyComplete).not.toBe(true);
    expect(result.conversationId).toBe(conversationId); expect(result.conversationUrl).toBe(`https://www.doubao.com/chat/${conversationId}`);
    expect(result.messageIds).toEqual(['OFFLINE-user-message', 'OFFLINE-assistant-message']);
    const submittedAt = '2026-11-03T14:58:14.019Z';
    const original: Task = { id: 'OFFLINE-task', mode: 'image', prompt, assignedAccountId: 'OFFLINE-account', status: 'executing', result: null, outputs: [],
      createdAt: submittedAt, updatedAt: submittedAt, runtime: { runId: 'OFFLINE-run', attempt: 1, stage: 'submitting', message: '', startedAt: submittedAt,
        stageStartedAt: submittedAt, lastHeartbeatAt: submittedAt, submittedAt, input: { mode: 'image', prompt, attachments: [] } } };
    expect(mediaSubmissionReceiptFor(original, original, 'OFFLINE-account', result, '2026-11-03T14:58:15.019Z')).toBeUndefined();
  });

  it('本地发送占位不成为服务器消息，已发布用户模型仍可与本地助手占位隔离', (): void => {
    const test = fixture(); test.props.dataList[0].data[1] = { messageId: 'local_OFFLINE-assistant', isLocalMessage: true };
    test.assistantModel.message_id = 'local_OFFLINE-assistant';
    const result = readCurrentCreationConversation(document, readChatPage);
    expect(result.source).toBe('published_message'); expect(result.messageIds).toEqual(['OFFLINE-user-message']);
    expect(result.snapshot.messages).toHaveLength(1); expect(result.snapshot.messages[0].messageId).toBe('OFFLINE-user-message');
  });

  it('只有助手模型而无服务器用户模型时不认领；DOM的union标记不冒充消息ID', (): void => {
    const test = fixture(); test.props.dataList[0].data.shift(); test.user.remove();
    test.assistant.setAttribute('data-target-id', 'OFFLINE-whole-conversation');
    const result = readCurrentCreationConversation(document, readChatPage);
    expect(result.source).toBeUndefined(); expect(result.reason).toBe('message_models_incomplete');
    expect(result.conversationUrl).toBe(`https://www.doubao.com/chat/${conversationId}`); expect(result.snapshot.historyComplete).toBe(false);
    expect(result.messageIds).toEqual(['OFFLINE-assistant-message']);
  });

  it('真实同文多用户消息保留给全文检查拒绝，探针不挑选最后一条', (): void => {
    const test = fixture(); const second = test.user.cloneNode(true) as FiberElement;
    second.__reactFiber$TEST = { memoizedProps: { message: model('OFFLINE-duplicate-user', `生成图片：${prompt}`) } };
    test.list.append(second); test.props.dataList[0].data.push({ messageId: 'OFFLINE-duplicate-user', isLocalMessage: false });
    const result = readCurrentCreationConversation(document, readChatPage);
    expect(result.source).toBe('published_message'); expect(result.snapshot.messages).toHaveLength(3);
    expect(inspectCreationReadback(result.snapshot, prompt, 'image', 0).promptPublished).toBe(false);
  });

  it.each(['v2', 'legacy'] as const)('保留实际%s正文，未知cookie和方法字段不进入结果', (format): void => {
    const test = fixture(); test.userModel.content_blocks = undefined; test.userModel.cookie = 'OFFLINE-private-cookie';
    if (format === 'v2') test.userModel.content_blocks_v2 = [{ block_type: 10000, content_obj: { text: prompt } }];
    else test.userModel.content_block = [{ content: { text_block: { text: prompt } } }];
    const result = readCurrentCreationConversation(document, readChatPage);
    expect(result.source).toBe('published_message'); expect(result.snapshot.messages[0].rawText).toBe(prompt);
    expect(JSON.stringify(result)).not.toContain('OFFLINE-private-cookie'); expect(test.props.onLoadMore).not.toHaveBeenCalled();
  });

  it('没有可信provider的DOM消息只能返回只读快照，不能因可见文字构造原会话', (): void => {
    const test = fixture(); test.user.__reactFiber$TEST = undefined; test.assistant.__reactFiber$TEST = undefined;
    const read = vi.fn((doc: Document): ChatPageSnapshot => { void doc; return { messages: [{ role: 'user', text: prompt }], editorPresent: true, editorText: '', generating: false }; });
    const result = readCurrentCreationConversation(document, read);
    expect(result.source).toBeUndefined(); expect(result.conversationUrl).toBeUndefined(); expect(result.snapshot.messages[0].text).toBe(prompt);
  });
});
