/** 执行真实序列化 guest 回读，只使用合成消息和媒体，不发平台消息。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectCreationReadback, readChatPage, type ChatReadbackContext } from '../../src/utils/chatReadback';
import { resolveVideoArtifact, type WebviewHandle } from '../../src/utils/doubaoBridge';
import { readVideoConversationPage, relatedVideoCards } from '../../src/utils/videoConversationReadback';

const prompt = 'TEST原视频：小熊把树枝递给伙伴。';
const url = 'https://www.doubao.com/chat/TEST-original';
const context: ChatReadbackContext = { taskId: 'TEST-task', runId: 'TEST-run', currentRunId: 'TEST-run', accountId: 'TEST-account', currentAccountId: 'TEST-account', conversationUrl: url, currentConversationUrl: url };
const config = { aspectRatio: '9:16', duration: '7s' };
type TestPropsElement = HTMLElement & { __reactProps$TEST?: object };

function message(role: 'user' | 'assistant', text: string, turnId = 'TEST-shared-union', messageId?: string): HTMLElement {
  const union = document.createElement('div'); union.setAttribute('data-testid', 'union_message'); union.setAttribute('data-target-id', turnId);
  const node = document.createElement('div'); node.setAttribute('data-testid', role === 'user' ? 'send_message' : 'receive_message');
  if (messageId) node.setAttribute('data-message-id', messageId);
  const content = document.createElement('div'); content.setAttribute('data-testid', 'message_text_content'); content.textContent = text; node.append(content); union.append(node); document.body.append(union); return node;
}
function card(parent: HTMLElement, vid: string, path: string, extra: object = {}): HTMLElement {
  const block = document.createElement('div') as TestPropsElement; block.className = 'block-video-TEST';
  block.__reactProps$TEST = { video: { vid, original_media_info: { main_url: `https://TEST.invalid/video/${path}.mp4` }, ...extra } };
  parent.append(block); return block;
}
function fixture(): { view: WebviewHandle & { executeJavaScript: ReturnType<typeof vi.fn>; loadURL: ReturnType<typeof vi.fn>; sendInputEvent: ReturnType<typeof vi.fn> }; originalReply: HTMLElement } {
  message('user', `生成视频：${prompt}，9:16，7s`);
  const originalReply = message('assistant', '视频生成参数确认：Seedance 2.0 Fast，时长7秒，比例9:16，请确认后生成。');
  const view = { executeJavaScript: vi.fn(async (code: string): Promise<unknown> => window.eval(code)), getURL: (): string => url, loadURL: vi.fn(), sendInputEvent: vi.fn() };
  return { view, originalReply };
}
function resolve(view: WebviewHandle): ReturnType<typeof resolveVideoArtifact> {
  return resolveVideoArtifact(view, { conversationUrl: url, runId: 'TEST-run', sourcePrompt: prompt, readbackContext: context, videoConfig: config, generationConfirmationRecorded: true, timeoutMs: 1000 });
}

afterEach((): void => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('原视频消息范围内的真实 DOM/React 卡回读', (): void => {
  it('从原消息关联卡读取视频，手机改时长和后续聊天不否定原完整请求', async (): Promise<void> => {
    const test = fixture(); message('user', '正在生成视频吗'); const generated = message('assistant', 'TEST原视频已生成'); card(generated, 'TEST-original-vid', 'original');
    message('user', '开始生成了吗'); message('assistant', 'TEST其它聊天回复');
    expect(await resolve(test.view)).toMatchObject({ status: 'resolved', url: 'https://TEST.invalid/video/original.mp4', vid: 'TEST-original-vid', source: 'conversation_scan' });
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled(); expect(test.view.executeJavaScript).toHaveBeenCalledOnce();
  });

  it('所有 union ID 相同也只允许关联区间，不从其它轮挑选整页最新视频', async (): Promise<void> => {
    const test = fixture(); card(test.originalReply, 'TEST-original-vid', 'original');
    message('user', 'TEST生成另一个无关视频'); const unrelated = message('assistant', 'TEST其它视频'); card(unrelated, 'TEST-foreign-vid', 'foreign');
    const page = readVideoConversationPage(document, readChatPage);
    const readback = inspectCreationReadback(page.snapshot, prompt, 'video', 0, config, false, context);
    expect(relatedVideoCards(page, readback).map((item): unknown => item.video.vid)).toEqual(['TEST-original-vid']);
    expect(await resolveVideoArtifact(test.view, { conversationUrl: url, sourcePrompt: prompt, readbackContext: context, videoConfig: config, timeoutMs: 1000 })).toMatchObject({ status: 'resolved', url: 'https://TEST.invalid/video/original.mp4' });
  });

  it('原视频已经形成真实卡后，后来明确“重发一次”的第二卡不能替换首个产物', async (): Promise<void> => {
    const test = fixture(); card(test.originalReply, 'TEST-original-vid', 'original');
    message('user', '重发一次'); const later = message('assistant', '现在开始生成视频，你的视频生成好了。'); card(later, 'TEST-second-vid', 'second');
    expect(await resolve(test.view)).toMatchObject({ status: 'resolved', vid: 'TEST-original-vid', url: 'https://TEST.invalid/video/original.mp4' });
  });

  it('完整历史记录原视频卡时，即使传入更宽续接索引也不能以唯一挂载的晚卡顶替卸载的原卡', (): void => {
    const test = fixture(); card(test.originalReply, 'TEST-original-vid', 'original');
    message('user', '重发一次'); const later = message('assistant', 'TEST第二视频已完成'); card(later, 'TEST-second-vid', 'second');
    const page = readVideoConversationPage(document, readChatPage);
    const readback = inspectCreationReadback(page.snapshot, prompt, 'video', 0, config, true, context);
    page.snapshot.historyComplete = true;
    page.cards = page.cards.filter((item): boolean => item.video.vid === 'TEST-second-vid');
    expect(page.snapshot.messages[1].videoReady).toBe(true);
    expect(relatedVideoCards(page, { ...readback, generationContinuationMessageIndices: [3] })).toEqual([]);
  });

  it('一个有界关联区间内出现不同视频时保留歧义，不按最新挑选', async (): Promise<void> => {
    const test = fixture(); card(test.originalReply, 'TEST-first-vid', 'first'); card(test.originalReply, 'TEST-second-vid', 'second');
    expect(await resolve(test.view)).toMatchObject({ status: 'needs_manual_selection' });
    expect(test.view.executeJavaScript).toHaveBeenCalledOnce();
  });

  it('虚拟卸载导致原请求未挂载时不能把共享 union 的最新生成卡冒充原视频', async (): Promise<void> => {
    const test = fixture(); document.body.replaceChildren(); message('user', '开始'); const generated = message('assistant', 'TEST新视频已生成'); card(generated, 'TEST-foreign-vid', 'foreign');
    expect(await resolve(test.view)).toMatchObject({ status: 'unavailable' });
    expect(test.view.executeJavaScript).toHaveBeenCalledOnce();
  });

  it('不读取消息外的全局 React 数据、缓存和其它助手的祖先组件', async (): Promise<void> => {
    const test = fixture(); card(test.originalReply, 'TEST-original-vid', 'original');
    const body = document.body as TestPropsElement; body.__reactProps$TEST = { video: { vid: 'TEST-foreign-vid', download_url: 'https://TEST.invalid/video/foreign.mp4' } };
    const script = document.createElement('script'); script.textContent = JSON.stringify({ video: { vid: 'TEST-foreign-vid', download_url: 'https://TEST.invalid/video/foreign.mp4' } }); document.body.append(script);
    expect(await resolve(test.view)).toMatchObject({ status: 'resolved', vid: 'TEST-original-vid' });
    const code = test.view.executeJavaScript.mock.calls[0][0] as string;
    expect(code).not.toMatch(/__doubaoVideoCache|__NEXT_DATA__|localStorage|sessionStorage|fetch\(/);
    delete body.__reactProps$TEST;
  });

  it('已有原消息 ID 时，可通过卡公开 messageId 归属读取晚到的原卡', async (): Promise<void> => {
    const test = fixture(); document.querySelector('[data-testid="send_message"]')?.setAttribute('data-message-id', 'TEST-original-user'); test.originalReply.setAttribute('data-message-id', 'TEST-original-assistant');
    message('user', 'TEST后续聊天', 'TEST-later-turn'); const later = message('assistant', 'TEST原产物延迟挂载', 'TEST-later-turn');
    card(later, 'TEST-original-vid', 'original', { messageId: 'TEST-original-assistant' });
    expect(await resolveVideoArtifact(test.view, { conversationUrl: url, sourcePrompt: prompt, readbackContext: { ...context, userMessageId: 'TEST-original-user' }, videoConfig: config, timeoutMs: 1000 })).toMatchObject({ status: 'resolved', vid: 'TEST-original-vid' });
  });

  it('实际 video/source 地址也必须属于原助手消息', async (): Promise<void> => {
    const test = fixture(); const video = document.createElement('video'); const source = document.createElement('source'); source.src = 'https://TEST.invalid/video/original.mp4'; video.append(source); test.originalReply.append(video);
    message('user', 'TEST后续无关聊天'); const other = message('assistant', 'TEST其它视频'); const foreign = document.createElement('video'); foreign.src = 'https://TEST.invalid/video/foreign.mp4'; other.append(foreign);
    expect(await resolveVideoArtifact(test.view, { conversationUrl: url, sourcePrompt: prompt, readbackContext: context, videoConfig: config, timeoutMs: 1000 })).toMatchObject({ status: 'resolved', url: 'https://test.invalid/video/original.mp4' });
  });

  it('回读期间会话改变或上下文冲突时不返回其它会话的候选', async (): Promise<void> => {
    const test = fixture(); card(test.originalReply, 'TEST-original-vid', 'original');
    expect(await resolveVideoArtifact(test.view, { conversationUrl: url, sourcePrompt: prompt, readbackContext: { ...context, currentRunId: 'TEST-other-run' }, videoConfig: config, timeoutMs: 1000 })).toMatchObject({ status: 'needs_manual_selection' });
    test.view.getURL = (): string => 'https://www.doubao.com/chat/TEST-other';
    expect(await resolve(test.view)).toMatchObject({ status: 'needs_manual_selection' });
    expect(test.view.executeJavaScript).toHaveBeenCalledOnce();
  });

  it('原视频诊断只暴露父链与卡片结构，不能把原正文、URL或标识写入日志', async (): Promise<void> => {
    const test = fixture(); card(test.originalReply, 'TEST-original-vid', 'original'); const diagnostic = vi.fn();
    expect(await resolveVideoArtifact(test.view, { conversationUrl: url, sourcePrompt: prompt, readbackContext: context, videoConfig: config, timeoutMs: 1000, onDiagnostic: diagnostic })).toMatchObject({ status: 'resolved' });
    expect(diagnostic).toHaveBeenCalledTimes(2);
    expect(diagnostic.mock.calls[0][0]).toMatchObject({ stage: 'anchored_snapshot', messageCount: 2, assistantMessageCount: 1, promptPublished: true,
      cards: [{ messageIndex: 1, hasVid: true, urlCount: 1, domUrlCount: 0 }], messageChain: { promptPublished: true } });
    expect(diagnostic.mock.calls[1][0]).toMatchObject({ stage: 'anchored_related_cards', relatedCardCount: 1 });
    const logged = JSON.stringify(diagnostic.mock.calls);
    for (const secret of [prompt, url, 'TEST-original-vid', 'TEST-task', 'TEST-run', 'TEST-account', 'https://TEST.invalid/video/original.mp4']) expect(logged).not.toContain(secret);
  });

  it('诊断写入失败不阻断已可靠归属的真实视频地址收取', async (): Promise<void> => {
    const test = fixture(); card(test.originalReply, 'TEST-original-vid', 'original');
    expect(await resolveVideoArtifact(test.view, { conversationUrl: url, sourcePrompt: prompt, readbackContext: context, videoConfig: config, timeoutMs: 1000,
      onDiagnostic: (): never => { throw new Error('TEST diagnostic storage failed'); } })).toMatchObject({ status: 'resolved', vid: 'TEST-original-vid' });
  });
});
