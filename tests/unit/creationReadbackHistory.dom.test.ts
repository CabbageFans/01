/** 复现平台已观测的 dataList ID 列表、provider DTO、异步虚拟挂载与 base64 videoModel。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCreationReadbackSnapshot, resolveVideoArtifact, type WebviewHandle } from '../../src/utils/doubaoBridge';
import { inspectCreationReadback, readChatPage, type ChatReadbackContext } from '../../src/utils/chatReadback';
import manualStatusFixture from '../fixtures/video-manual-status-continuation.json';

const url = 'https://www.doubao.com/chat/TEST-history';
const prompt = 'TEST原视频：伙伴把树枝递给小熊，固定机位。';
const config = { aspectRatio: '9:16', duration: '5s' };
const context: ChatReadbackContext = { taskId: 'TEST-task', runId: 'TEST-run', currentRunId: 'TEST-run', accountId: 'TEST-account', currentAccountId: 'TEST-account', conversationUrl: url, currentConversationUrl: url };
interface Model { id: string; role: 'user' | 'assistant'; text: string; replyId?: string; attachment?: boolean; vid?: string }
interface FiberElement extends HTMLElement { __reactFiber$TEST?: object; __reactProps$TEST?: object }

function fixture(): { view: WebviewHandle & { executeJavaScript: ReturnType<typeof vi.fn> }; list: FiberElement; scroller: HTMLElement; writes: number[]; models: Model[]; mount: (top?: boolean | 'all') => void } {
  const models: Model[] = [
    { id: 'TEST-39', role: 'user', text: '', attachment: true },
    { id: 'TEST-08', role: 'user', text: `生成视频：${prompt}，9:16，5s，720p` },
    { id: 'TEST-42', role: 'assistant', replyId: 'TEST-08', text: '视频生成参数确认：Seedance 2.0 Fast，时长5秒，比例9:16，请确认后生成视频。' },
    { id: 'TEST-12', role: 'user', text: '正在生成视频吗' },
    { id: 'TEST-07', role: 'assistant', replyId: 'TEST-12', text: 'TEST保持原角色，视频时长5秒、比例9:16，现在开始生成。' },
    { id: 'TEST-19', role: 'user', text: '开始生成了吗' },
    { id: 'TEST-09', role: 'assistant', replyId: 'TEST-19', text: '还没有，刚才只是确认参数。你回复“开始”后我才会正式生成视频。请回复“开始”，我立即生成视频。' },
    { id: 'TEST-22', role: 'user', text: '开始' },
    { id: 'TEST-17', role: 'assistant', replyId: 'TEST-22', text: '我将为你生成一段5秒9:16的视频，保持原角色与固定机位。' },
    { id: 'TEST-26', role: 'assistant', replyId: 'TEST-22', text: '你的视频生成好了。', vid: 'TEST-original-vid' },
  ];
  const list = document.createElement('div') as FiberElement; list.setAttribute('data-testid', 'message-list');
  const scroller = document.createElement('div'); scroller.className = 'scroller'; scroller.style.overflowY = 'auto'; list.append(scroller); document.body.append(list);
  const listProps = { conversationId: 'TEST-history', get dataList(): object[] { return models.map((model: Model): object => ({ type: 'block', data: [{ messageId: model.id, isLocalMessage: false }], isBatch: false, id: `block_${model.id}`, conversationId: 'TEST-history' })); } };
  list.__reactFiber$TEST = { return: { return: { return: { memoizedProps: listProps } } } };
  const mount = (top: boolean | 'all' = false): void => {
    scroller.replaceChildren();
    for (const model of top === 'all' ? models : top ? models.slice(0, 4) : models.slice(-7)) {
      const union = document.createElement('div'); union.setAttribute('data-testid', 'union_message'); union.setAttribute('data-target-id', 'TEST-whole-conversation');
      const node = document.createElement('div') as FiberElement; node.setAttribute('data-testid', model.role === 'user' ? 'send_message' : 'receive_message'); node.setAttribute('data-message-role', model.role);
      const content = document.createElement('div'); content.setAttribute('data-testid', 'message_text_content'); content.textContent = model.text;
      if (model.attachment) { const image = document.createElement('img'); image.src = 'https://TEST.invalid/attachment.png'; node.append(image); }
      if (model.text || !model.attachment) node.append(content);
      const dto = { conversation_id: 'TEST-history', message_id: model.id, index: model.id.slice(-2), reply_id: model.replyId || '', sender: model.role === 'user' ? 'TEST-real-user-id' : 'TEST-robot-identifier', content_type: 9999, content: '', content_blocks: [
        ...(model.attachment ? [{ block_type: 10001, content_obj: {} }] : []), ...(model.text || !model.attachment ? [{ block_type: 10000, content_obj: { text: model.text } }] : [])] };
      node.__reactFiber$TEST = { return: { return: { memoizedProps: { value: { message: dto } } } } };
      if (model.vid) {
        const wrapper = document.createElement('div') as FiberElement;
        wrapper.__reactProps$TEST = { children: { props: { video: { vid: model.vid, messageId: model.id, creation_task_id: 'TEST-creation-task', videoModel: JSON.stringify({ status: 0, message: '', video_id: model.vid, video_duration: 5.057, video_list: { video1: { width: 720, height: 1280, main_url: btoa(`https://TEST.invalid/video/${model.vid}.mp4`) } } }) } } } };
        const block = document.createElement('div'); block.className = 'block-video-TEST'; wrapper.append(block); node.append(wrapper);
      }
      union.append(node); scroller.append(union);
    }
  };
  mount(); let top = 1642; const writes: number[] = [];
  Object.defineProperties(scroller, { scrollHeight: { get: (): number => 2214 }, clientHeight: { get: (): number => 572 }, scrollTop: { get: (): number => top, set: (value: number): void => { top = value; writes.push(value); setTimeout((): void => mount(value === 0), 10); } } });
  const view = { executeJavaScript: vi.fn(async (code: string): Promise<unknown> => window.eval(code)), getURL: (): string => url, loadURL: vi.fn(), sendInputEvent: vi.fn() };
  return { view, list, scroller, writes, models, mount };
}
function clearCache(): void { delete (document as Document & { __doubaoStudioCreationHistory?: unknown }).__doubaoStudioCreationHistory; }
afterEach((): void => { document.body.replaceChildren(); clearCache(); vi.restoreAllMocks(); });

describe('虚拟消息历史补挂载与手机多轮确认', (): void => {
  it.each([false, true])('16条真实序列只读回收原卡；后续短句附新图=%s时严格隔离', async (newImage: boolean): Promise<void> => {
    const test = fixture();
    test.models.splice(0, test.models.length, ...manualStatusFixture.messages.map((item): Model => ({ id: item.messageId, role: item.role as Model['role'], text: item.text,
      replyId: 'replyId' in item ? item.replyId : undefined, attachment: 'attachmentOnly' in item && item.attachmentOnly === true,
      ...('videoReady' in item && item.videoReady ? { vid: 'TEST-final-original-vid' } : {}) })));
    if (newImage) test.models[13].attachment = true;
    test.mount('all');
    const dom = readChatPage(document); expect(dom.messages.some((item): boolean => item.role === 'user' && !!item.hasAttachments)).toBe(true);
    const snapshot = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(snapshot.historyComplete).toBe(true); expect(snapshot.messages).toHaveLength(16);
    expect(snapshot.messages[13].hasAttachments).toBe(newImage || undefined);
    const result = await resolveVideoArtifact(test.view, { conversationUrl: url, sourcePrompt: manualStatusFixture.prompt, readbackContext: context,
      videoConfig: manualStatusFixture.config, generationConfirmationRecorded: true, timeoutMs: 3000 });
    if (newImage) { expect(result.status).toBe('unavailable'); expect(result.url).toBeUndefined(); }
    else expect(result).toMatchObject({ status: 'resolved', vid: 'TEST-final-original-vid', url: 'https://TEST.invalid/video/TEST-final-original-vid.mp4' });
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('同ID正文先缓存、附件节点后挂载时保留原文并升级新素材标记', async (): Promise<void> => {
    const test = fixture(); await getCreationReadbackSnapshot(test.view, { conversationUrl: url }); test.mount('all');
    const attachment = document.createElement('div') as FiberElement; attachment.setAttribute('data-testid', 'send_message'); attachment.setAttribute('data-message-role', 'user');
    const image = document.createElement('img'); image.src = 'https://TEST.invalid/new-attachment.png'; attachment.append(image);
    attachment.__reactFiber$TEST = { return: { memoizedProps: { value: { message: { conversation_id: 'TEST-history', message_id: test.models[3].id,
      reply_id: '', content_blocks: [{ block_type: 10001, content_obj: {} }] } } } } };
    test.scroller.append(attachment);
    const snapshot = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(snapshot.messages[3]).toMatchObject({ text: '正在生成视频吗', hasAttachments: true });
    expect(snapshot.messages[1].hasAttachments).toBeUndefined();
    expect(inspectCreationReadback(snapshot, prompt, 'video', 0, config, true, context).generationContinuationMessageIndices).toEqual([]);
  });
  it('原请求未挂载时按 dataList 顺序补齐真实 DTO，保留原输入并取回实际5秒视频', async (): Promise<void> => {
    const test = fixture(); expect(document.body.textContent).not.toContain(prompt);
    const snapshot = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(snapshot.historyComplete).toBe(true); expect(snapshot.messages).toHaveLength(10);
    expect(snapshot.messages.map((item): string | undefined => item.messageId)).toEqual(test.models.map((item): string => item.id));
    expect(inspectCreationReadback(snapshot, prompt, 'video', 0, config, true, context)).toMatchObject({ promptPublished: true, originalMessageIndex: 1, generationContinuationMessageIndices: [4, 6, 8, 9] });
    expect(test.scroller.scrollTop).toBe(1642); expect(test.writes).toEqual([0, 1642]);
    const result = await resolveVideoArtifact(test.view, { conversationUrl: url, sourcePrompt: prompt, readbackContext: context, videoConfig: config, generationConfirmationRecorded: true, timeoutMs: 3000 });
    expect(result).toMatchObject({ status: 'resolved', vid: 'TEST-original-vid', url: 'https://TEST.invalid/video/TEST-original-vid.mp4' });
    expect(test.writes).toEqual([0, 1642]);
  });

  it('后续新生成的第二视频不串到第一条原请求，数据更新也不再次滚完整历史', async (): Promise<void> => {
    const test = fixture(); await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    test.models.push({ id: 'TEST-03', role: 'user', text: 'TEST生成全新另一个视频' }, { id: 'TEST-02', role: 'assistant', replyId: 'TEST-03', text: '你的视频生成好了。', vid: 'TEST-foreign-vid' }); test.mount();
    const result = await resolveVideoArtifact(test.view, { conversationUrl: url, sourcePrompt: prompt, readbackContext: context, videoConfig: config, generationConfirmationRecorded: true, timeoutMs: 3000 });
    expect(result).toMatchObject({ status: 'resolved', vid: 'TEST-original-vid' }); expect(test.writes).toEqual([0, 1642]);
  });

  it('原卡虚拟卸载、只有第二卡挂载时仍以完整历史原视频事实结束生成链', async (): Promise<void> => {
    const test = fixture(); test.models[9].text = ''; test.mount();
    const originalSnapshot = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(originalSnapshot.messages[9]).toMatchObject({ messageId: 'TEST-26', videoReady: true, text: '' });
    test.models.push({ id: 'TEST-03', role: 'user', text: 'TEST另一个视频' }, { id: 'TEST-02', role: 'assistant', replyId: 'TEST-03', text: '我将为你生成一段视频。你的视频生成好了。', vid: 'TEST-foreign-vid' }); test.mount();
    for (const wrapper of document.querySelectorAll<FiberElement>('[data-testid="receive_message"] [class*="block-video"]')) {
      const props = (wrapper.parentElement as FiberElement).__reactProps$TEST as { children?: { props?: { video?: { vid?: string } } } } | undefined;
      if (props?.children?.props?.video?.vid === 'TEST-original-vid') wrapper.closest('[data-testid="union_message"]')?.remove();
    }
    const result = await resolveVideoArtifact(test.view, { conversationUrl: url, sourcePrompt: prompt, readbackContext: context, videoConfig: config, generationConfirmationRecorded: true, timeoutMs: 3000 });
    expect(result.status).toBe('unavailable'); expect(result.url).toBeUndefined(); expect(test.writes).toEqual([0, 1642]);
  });

  it('DTO 的 reply_id 不属于该人工回复时不把卡归入原生成链', async (): Promise<void> => {
    const test = fixture(); test.models[9].replyId = 'TEST-other-user'; test.mount();
    const result = await resolveVideoArtifact(test.view, { conversationUrl: url, sourcePrompt: prompt, readbackContext: context, videoConfig: config, generationConfirmationRecorded: true, timeoutMs: 3000 });
    expect(result.status).toBe('unavailable');
  });

  it('视频工具结果回复同轮开始助手时，以DTO父链关联卡；正文外的真实视频块仍可回收', async (): Promise<void> => {
    const test = fixture(); test.models[9].replyId = test.models[8].id; test.models[9].text = ''; test.mount();
    const snapshot = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(snapshot.messages[9]).toMatchObject({ role: 'assistant', text: '', messageId: 'TEST-26', replyId: 'TEST-17', videoReady: true });
    const readback = inspectCreationReadback(snapshot, prompt, 'video', 0, config, true, context);
    expect(readback.generationContinuationMessageIndices).toEqual([4, 6, 8, 9]);
    expect(await resolveVideoArtifact(test.view, { conversationUrl: url, sourcePrompt: prompt, readbackContext: context,
      videoConfig: config, generationConfirmationRecorded: true, timeoutMs: 3000 })).toMatchObject({ status: 'resolved', vid: 'TEST-original-vid', url: 'https://TEST.invalid/video/TEST-original-vid.mp4' });
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('只信当前会话 dataList，不读取会话不匹配的 provider 或任意祖先缓存', async (): Promise<void> => {
    const test = fixture(); test.list.__reactFiber$TEST = { return: { memoizedProps: { conversationId: 'TEST-other', dataList: [] } } };
    const snapshot = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(snapshot.historyComplete).not.toBe(true); expect(inspectCreationReadback(snapshot, prompt, 'video', 0, config, true, context).promptPublished).toBe(false); expect(test.writes).toEqual([]);
  });

  it('取消与原任务回调阻止采样；草稿保护也不会改变滚动位置', async (): Promise<void> => {
    const test = fixture(); const controller = new AbortController(); controller.abort();
    await expect(getCreationReadbackSnapshot(test.view, { conversationUrl: url, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(getCreationReadbackSnapshot(test.view, { conversationUrl: url, ensureCurrent: (): void => { throw new Error('TEST run changed'); } })).rejects.toThrow('TEST run changed');
    expect(test.view.executeJavaScript).not.toHaveBeenCalled(); expect(test.writes).toEqual([]);
    const editor = document.createElement('textarea'); editor.value = 'TEST未发送草稿'; Object.defineProperty(editor, 'offsetParent', { get: (): HTMLElement => document.body }); document.body.append(editor);
    expect((await getCreationReadbackSnapshot(test.view, { conversationUrl: url })).historyComplete).not.toBe(true); expect(test.writes).toEqual([]); expect(editor.value).toBe('TEST未发送草稿');
  });

  it('挂载等待中取消只标记本次内存令牌，下一屏不再取样并恢复原滚动位置', async (): Promise<void> => {
    const test = fixture(); const controller = new AbortController();
    const reading = getCreationReadbackSnapshot(test.view, { conversationUrl: url, signal: controller.signal });
    setTimeout((): void => controller.abort(), 30);
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    expect(test.writes).toEqual([0, 1642]); expect(test.scroller.scrollTop).toBe(1642);
    expect(test.view.executeJavaScript).toHaveBeenCalledTimes(2);
    expect(test.view.executeJavaScript.mock.calls[1][0]).toContain('__doubaoStudioCreationHistoryCancelled');
    expect(Object.keys((document as Document & { __doubaoStudioCreationHistoryCancelled?: object }).__doubaoStudioCreationHistoryCancelled || {})).toHaveLength(0);
  });
});
