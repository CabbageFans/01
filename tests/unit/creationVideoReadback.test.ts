import { describe, expect, it } from 'vitest';
import { diagnoseCreationReadback, diagnoseVideoMessageChain, inspectCreationReadback, type ChatPageSnapshot, type ChatReadbackContext } from '../../src/utils/chatReadback';
import manualStatusFixture from '../fixtures/video-manual-status-continuation.json';

const prompt = 'TEST原视频：小熊把树枝递给伙伴，镜头保持不动。';
const config = { aspectRatio: '9:16', duration: '7s' };
const context: ChatReadbackContext = { taskId: 'TEST-task', runId: 'TEST-run', currentRunId: 'TEST-run', accountId: 'TEST-account', currentAccountId: 'TEST-account', conversationUrl: 'https://www.doubao.com/chat/TEST-original', currentConversationUrl: 'https://www.doubao.com/chat/TEST-original' };
const original: ChatPageSnapshot['messages'][number] = { role: 'user', text: `生成视频：${prompt}，9:16，7s`, turnId: 'TEST-shared-union' };
const parameter: ChatPageSnapshot['messages'][number] = { role: 'assistant', text: '视频生成参数确认：Seedance 2.0 Fast，时长7秒，比例9:16，请确认后生成。', turnId: 'TEST-shared-union' };
function page(messages: ChatPageSnapshot['messages'], patch: Partial<ChatPageSnapshot> = {}): ChatPageSnapshot {
  return { messages, editorPresent: true, editorText: '', generating: false, ...patch };
}
function inspect(snapshot: ChatPageSnapshot, patch: Partial<ChatReadbackContext> = {}): ReturnType<typeof inspectCreationReadback> {
  return inspectCreationReadback(snapshot, prompt, 'video', 0, config, true, { ...context, ...patch });
}

describe('已受理原视频的只读消息定位', (): void => {
  it('失败诊断只含消息元数据和比较结果，不泄露正文、角色、消息ID或会话地址', (): void => {
    const privatePrompt = 'PRIVATE_PROMPT_AND_CHARACTER_TEST';
    const diagnostic = JSON.stringify(diagnoseCreationReadback(page([{ role: 'user', text: `生成视频：${privatePrompt}，9:16，7s，720p`, messageId: 'PRIVATE_MESSAGE_ID_TEST' }]), privatePrompt, 'video', config, context));
    for (const secret of [privatePrompt, 'PRIVATE_MESSAGE_ID_TEST', context.conversationUrl]) expect(diagnostic).not.toContain(secret);
    expect(JSON.parse(diagnostic)).toMatchObject({ users: 1, messages: 1, promptPublished: true, contextCurrent: true,
      inputs: [{ role: 'user', attachmentOnly: false, hasMessageId: true, fullPromptMatches: true }] });
    const chain = JSON.stringify(diagnoseVideoMessageChain(page([{ role: 'user', text: `生成视频：${privatePrompt}，9:16，7s，720p`, messageId: 'PRIVATE_MESSAGE_ID_TEST' },
      { role: 'assistant', text: privatePrompt, messageId: 'PRIVATE_ASSISTANT_ID', replyId: 'PRIVATE_MESSAGE_ID_TEST' }]), privatePrompt, config, true, context));
    for (const secret of [privatePrompt, 'PRIVATE_MESSAGE_ID_TEST', 'PRIVATE_ASSISTANT_ID', context.conversationUrl]) expect(chain).not.toContain(secret);
    expect(JSON.parse(chain)).toMatchObject({ originalMessageIndex: 0, originalAssistantMessageIndices: [1], messages: [{ index: 0, replyTargetIndices: [] }, { index: 1, replyTargetIndices: [0] }] });
  });
  it.each(['正在生成视频吗', '开始生成了吗', '开始', '好的，按上面来'])('用户追加“%s”不否定已发布的完整原请求', (text: string): void => {
    const snapshot = page([original, parameter, { role: 'user', text, turnId: 'TEST-shared-union' }, { role: 'assistant', text: 'TEST后续回复', turnId: 'TEST-shared-union' }]);
    const result = inspect(snapshot);
    expect(result).toMatchObject({ promptPublished: true, originalMessageIndex: 0, originalAssistantMessageIndices: [1], followupUserMessageIndices: [2], generationContinuationMessageIndices: [3], replyText: parameter.text, confirmationPublished: false });
    expect(inspectCreationReadback(snapshot, prompt, 'video', 0, config, true).promptPublished).toBe(false);
  });

  it('完整16条现场序列：确认后催进度、时间询问和手动原样重发不丢失最终原视频工具结果', (): void => {
    const messages = structuredClone(manualStatusFixture.messages) as ChatPageSnapshot['messages'];
    const result = inspectCreationReadback(page(messages), manualStatusFixture.prompt, 'video', 0, manualStatusFixture.config, true, context);
    expect(result).toMatchObject({ promptPublished: true, originalMessageIndex: 1, originalAssistantMessageIndices: [2],
      followupUserMessageIndices: [3, 5, 7, 9, 11, 13], generationContinuationMessageIndices: [4, 6, 8, 10, 12, 14, 15] });
  });

  it('合法状态询问中的未知搜索子链不归入候选，也不阻断后续明确原样重试', (): void => {
    const messages = structuredClone(manualStatusFixture.messages) as ChatPageSnapshot['messages']; messages[6].replyId = 'TEST-unrelated-search-parent';
    const result = inspectCreationReadback(page(messages), manualStatusFixture.prompt, 'video', 0, manualStatusFixture.config, true, context);
    expect(result.generationContinuationMessageIndices).toEqual([4, 8, 10, 12, 14, 15]);
  });

  it.each(['视频改红色还在排队吗', '做一个新视频正在生成吗', '时长是5秒', '确认，改成5秒', '改成16:9再生成', '重发一次，换一张图', '换成Seedance 2.0 Fast重试一次', '720p还在排队吗', '用刚上传的图重发一次', '讲一下排队算法', '重新生成一个新视频', '我12点16确认，现在已经12点40了，还没给我视频，这正常吗，改成10秒'])('完整用户句包含新内容或配置时截止原续接：%s', (text: string): void => {
    const messages = structuredClone(manualStatusFixture.messages) as ChatPageSnapshot['messages']; messages[5].text = text;
    const result = inspectCreationReadback(page(messages), manualStatusFixture.prompt, 'video', 0, manualStatusFixture.config, true, context);
    expect(result.promptPublished).toBe(true); expect(result.generationContinuationMessageIndices).toEqual([4]);
  });

  it('新上传附件和首个已有视频都截止后续重发产物，不能吸收另一条视频', (): void => {
    const uploaded = structuredClone(manualStatusFixture.messages) as ChatPageSnapshot['messages'];
    uploaded.splice(5, 0, { role: 'user', text: '', attachmentOnly: true, messageId: 'TEST-new-upload' });
    expect(inspectCreationReadback(page(uploaded), manualStatusFixture.prompt, 'video', 0, manualStatusFixture.config, true, context).generationContinuationMessageIndices).toEqual([]);
    const captionedUpload = structuredClone(manualStatusFixture.messages) as ChatPageSnapshot['messages']; captionedUpload[5].hasAttachments = true;
    expect(inspectCreationReadback(page(captionedUpload), manualStatusFixture.prompt, 'video', 0, manualStatusFixture.config, true, context).generationContinuationMessageIndices).toEqual([4]);
    const completed = structuredClone(manualStatusFixture.messages) as ChatPageSnapshot['messages']; completed[4].videoReady = true;
    expect(inspectCreationReadback(page(completed), manualStatusFixture.prompt, 'video', 0, manualStatusFixture.config, true, context).generationContinuationMessageIndices).toEqual([4]);
  });

  it('多个任意后续聊天不会替代原助手正文，也不把最新助手误作直接产物', (): void => {
    const snapshot = page([original, parameter, { role: 'user', text: '时长是5秒' }, { role: 'assistant', text: 'TEST第一次后续回复' }, { role: 'user', text: '开始生成了吗' }, { role: 'assistant', text: 'TEST最新回复' }]);
    expect(inspect(snapshot)).toMatchObject({ promptPublished: true, replyText: parameter.text, originalAssistantMessageIndices: [1], followupUserMessageIndices: [2, 4] });
  });

  it('持久化原消息 ID 可在同文多轮中唯一定位，错误 ID 不回退到同文消息', (): void => {
    const snapshot = page([{ ...original, messageId: 'TEST-first' }, parameter, { ...original, messageId: 'TEST-second' }, { role: 'assistant', text: 'TEST其它视频' }]);
    expect(inspect(snapshot, { userMessageId: 'TEST-first' })).toMatchObject({ promptPublished: true, originalMessageIndex: 0 });
    expect(inspect(snapshot)).toMatchObject({ promptPublished: false, reason: 'user_ambiguous' });
    expect(inspect(snapshot, { userMessageId: 'TEST-missing' })).toMatchObject({ promptPublished: false, reason: 'user_ambiguous' });
  });

  it.each([false, true])('视频工具产物沿同轮助手父链归属，人工确认轮=%s', (confirmed: boolean): void => {
    const user = { ...original, messageId: 'TEST-original-user' };
    const start: ChatPageSnapshot['messages'][number] = { role: 'assistant', messageId: 'TEST-start', replyId: confirmed ? 'TEST-confirm-user' : user.messageId, text: '我将为你生成一段视频。' };
    const tool: ChatPageSnapshot['messages'][number] = { role: 'assistant', messageId: 'TEST-tool-result', replyId: start.messageId, text: '你的视频生成好了。', videoReady: true };
    const prefix: ChatPageSnapshot['messages'] = confirmed ? [user, { ...parameter, messageId: 'TEST-confirm-request', replyId: user.messageId }, { role: 'user', messageId: 'TEST-confirm-user', text: '确认' }] : [user];
    const result = inspect(page([...prefix, start, tool]));
    expect(result.promptPublished).toBe(true);
    if (confirmed) expect(result.generationContinuationMessageIndices).toEqual([3, 4]);
    else expect(result.originalAssistantMessageIndices).toEqual([1, 2]);
  });

  it.each(['other-user', 'future-assistant', 'unknown', 'duplicate-assistant', 'cross-turn'] as const)('工具父链遇%s时不把其它视频纳入原运行', (variant: 'other-user' | 'future-assistant' | 'unknown' | 'duplicate-assistant' | 'cross-turn'): void => {
    const user = { ...original, messageId: 'TEST-original-user' };
    const messages: ChatPageSnapshot['messages'] = [user, { role: 'assistant', text: '我将为你生成一段视频。', messageId: 'TEST-start', replyId: user.messageId }];
    if (variant === 'duplicate-assistant') messages.push({ role: 'assistant', text: 'TEST重复ID', messageId: 'TEST-start', replyId: user.messageId });
    if (variant === 'cross-turn') messages.push({ role: 'user', text: 'TEST另一个视频', messageId: 'TEST-other-user' });
    messages.push({ role: 'assistant', text: '你的视频生成好了。', messageId: 'TEST-tool-result',
      replyId: variant === 'other-user' ? 'TEST-other-user' : variant === 'future-assistant' ? 'TEST-future' : variant === 'unknown' ? 'TEST-missing' : 'TEST-start', videoReady: true });
    if (variant === 'future-assistant') messages.push({ role: 'assistant', text: 'TEST未来助手', messageId: 'TEST-future', replyId: user.messageId });
    const result = inspect(page(messages));
    expect(result.originalAssistantMessageIndices).not.toContain(messages.findIndex((message: ChatPageSnapshot['messages'][number]): boolean => message.messageId === 'TEST-tool-result'));
    expect(result.generationContinuationMessageIndices).toEqual([]);
  });

  it('整会话共用的 union turnId 不能把虚拟卸载后的其它用户文字当原请求', (): void => {
    const snapshot = page([{ role: 'user', text: '开始', turnId: 'TEST-shared-union' }, { role: 'assistant', text: 'TEST新视频已生成', turnId: 'TEST-shared-union' }]);
    expect(inspect(snapshot, { userTurnId: 'TEST-shared-union' })).toMatchObject({ promptPublished: false, reason: 'prompt_unmatched' });
    expect(inspect(page([original, parameter, ...snapshot.messages]), { userTurnId: 'TEST-shared-union' })).toMatchObject({ promptPublished: true, originalMessageIndex: 0 });
  });

  it.each([{ currentRunId: 'TEST-other-run' }, { currentAccountId: 'TEST-other-account' }, { currentConversationUrl: 'https://www.doubao.com/chat/TEST-other' }])('正式任务身份改变时阻断 $currentRunId$currentAccountId$currentConversationUrl', (patch: Partial<ChatReadbackContext>): void => {
    expect(inspect(page([original, parameter]), patch)).toMatchObject({ promptPublished: false, reason: 'context_changed' });
  });

  it('保留用户尚未发送的输入，不把原消息已发布误作当前编辑器已清空', (): void => {
    expect(inspect(page([original, parameter, { role: 'user', text: '开始' }], { editorText: 'TEST未发送草稿' }))).toMatchObject({ promptPublished: true, inputCleared: false });
  });

  it('没有原助手参数确认事实时不扩大到任意后续助手', (): void => {
    const snapshot = page([original, { role: 'assistant', text: 'TEST原视频已完成' }, { role: 'user', text: '生成另一个视频' }, { role: 'assistant', text: 'TEST另一个视频' }]);
    expect(inspect(snapshot)).toMatchObject({ promptPublished: true, originalAssistantMessageIndices: [1], generationContinuationMessageIndices: [] });
    expect(inspectCreationReadback(page([original, parameter, { role: 'user', text: '开始' }, { role: 'assistant', text: 'TEST' }]), prompt, 'video', 0, config, false, context).generationContinuationMessageIndices).toEqual([]);
  });

  it.each([{ text: '你的视频生成好了。' }, { text: '', videoReady: true }])('原直接回复已有成片终态时不续接任何后续新视频 $text', (terminal: { text: string; videoReady?: boolean }): void => {
    const snapshot = page([original, parameter, { role: 'assistant', ...terminal }, { role: 'user', text: 'TEST生成另一个视频' }, { role: 'assistant', text: '我将为你生成一段视频。', videoReady: true }]);
    expect(inspect(snapshot)).toMatchObject({ promptPublished: true, originalAssistantMessageIndices: [1, 2], generationContinuationMessageIndices: [] });
  });

  it('用户说成片文案不算助手终态；只以原续接助手的实际视频块结束链', (): void => {
    const snapshot = page([original, parameter, { role: 'user', text: '为什么视频生成好了但我看不到' }, { role: 'assistant', text: '现在开始生成。' }, { role: 'user', text: '还在排队吗' }, { role: 'assistant', text: '', videoReady: true }, { role: 'user', text: 'TEST另一个视频' }, { role: 'assistant', text: '你的视频生成好了。', videoReady: true }]);
    expect(inspect(snapshot).generationContinuationMessageIndices).toEqual([3, 5]);
  });

  it('图片流程与未提交正文保持严格回执条件', (): void => {
    expect(inspectCreationReadback(page([{ role: 'user', text: `生成图片：${prompt}` }, parameter, { role: 'user', text: '开始' }]), prompt, 'image', 0, undefined, true, context).promptPublished).toBe(false);
    expect(inspect(page([], { editorText: prompt })).promptPublished).toBe(false);
  });
});
