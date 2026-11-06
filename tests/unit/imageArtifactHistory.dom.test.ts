/** 真实序列化只读回读，使用合成 provider 消息与图片卡验证归属及虚拟卸载。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCreationReadbackSnapshot, getCurrentCreationConversation, readAcceptedImageOutputs, type WebviewHandle } from '../../src/utils/doubaoBridge';
import { readChatPage } from '../../src/utils/chatReadback';
import { inspectImageArtifactReadback } from '../../src/utils/imageArtifactReadback';

const prompt = 'TEST 原场景完整请求。';
const url = 'https://www.doubao.com/chat/TEST-image-history';
const originalImage = 'https://test.invalid/original.png';
interface MessageModel { id: string; role: 'user' | 'assistant'; text: string; replyId?: string; image?: string; pending?: boolean; failure?: string; thumbOnly?: boolean }
type FiberElement = HTMLElement & { __reactFiber$TEST?: object };

function picture(source: string, width: number = 800, height: number = 600, complete: boolean = true): HTMLImageElement {
  const image = document.createElement('img'); image.src = source;
  Object.defineProperties(image, { naturalWidth: { value: width, configurable: true }, naturalHeight: { value: height, configurable: true }, complete: { value: complete, configurable: true } });
  return image;
}

function fixture(): { models: MessageModel[]; mount: (ids?: string[]) => void; view: WebviewHandle; nodeFor: (id: string) => FiberElement; messageFor: (id: string) => Record<string, unknown> } {
  const models: MessageModel[] = [
    { id: 'TEST-old-user', role: 'user', text: 'TEST历史请求' },
    { id: 'TEST-old-reply', role: 'assistant', text: 'TEST历史回复', replyId: 'TEST-old-user', image: 'https://test.invalid/history.png' },
    { id: 'TEST-original-user', role: 'user', text: `生成图片：${prompt}` },
    { id: 'TEST-original-reply', role: 'assistant', text: '', replyId: 'TEST-original-user', image: originalImage },
    { id: 'TEST-next-user', role: 'user', text: 'TEST后续请求' },
    { id: 'TEST-next-reply', role: 'assistant', text: 'TEST后续回复', replyId: 'TEST-next-user', image: 'https://test.invalid/next.png' },
  ];
  const list = document.createElement('div') as FiberElement; list.dataset.testid = 'message-list'; document.body.append(list);
  const props = { conversationId: 'TEST-image-history', get dataList(): object[] { return models.map((model: MessageModel): object => ({ type: 'block', conversationId: 'TEST-image-history', data: [{ messageId: model.id }] })); } };
  list.__reactFiber$TEST = { memoizedProps: props };
  const nodes = new Map<string, FiberElement>(); const messages = new Map<string, Record<string, unknown>>();
  const mount = (ids?: string[]): void => {
    list.replaceChildren();
    for (const model of models.filter((value: MessageModel): boolean => !ids || ids.includes(value.id))) {
      const union = document.createElement('div'); union.dataset.testid = 'union_message'; union.dataset.targetId = 'TEST-shared-turn';
      const node = document.createElement('div') as FiberElement; node.dataset.testid = model.role === 'user' ? 'send_message' : 'receive_message';
      const text = document.createElement('div'); text.dataset.testid = 'message_text_content'; text.textContent = model.text; node.append(text);
      const thumb = `https://test.invalid/${model.id}-thumb.png`;
      const message: Record<string, unknown> = { conversation_id: 'TEST-image-history', message_id: model.id, reply_id: model.replyId,
        content_blocks: [{ block_type: 10000, content_obj: { text: model.text } }, ...(model.image ? [{ is_finish: true, content_obj: { creations: [{ image: {
          status: 2, image_thumb: { url: thumb, width: 2848, height: 1600 },
          ...(model.thumbOnly ? {} : { image_ori: { url: model.image, width: 2848, height: 1600 } }),
        } }] } }] : [])] };
      node.__reactFiber$TEST = { memoizedProps: { value: { message } } }; nodes.set(model.id, node); messages.set(model.id, message);
      // 用户参考图、助手旁的大头像都没有正式图片卡证据。
      node.append(picture(`https://test.invalid/${model.role === 'user' ? 'reference' : 'large-decoration'}.png`));
      if (model.image || model.failure) {
        const card = document.createElement('div'); card.dataset.testid = 'message_image_content';
        if (model.failure) card.textContent = model.failure;
        if (model.image) {
          card.append(picture(thumb, 384, 216));
          if (!model.thumbOnly) { const original = picture(model.image, model.pending ? 0 : 2848, model.pending ? 0 : 1600, !model.pending); original.style.display = 'none'; card.append(original); }
        }
        node.append(card);
      }
      union.append(node); list.append(union);
    }
  };
  mount();
  return { models, mount, nodeFor: (id: string): FiberElement => nodes.get(id)!, messageFor: (id: string): Record<string, unknown> => messages.get(id)!,
    view: { executeJavaScript: vi.fn(async (code: string): Promise<unknown> => window.eval(code)), getURL: (): string => url, loadURL: vi.fn(), sendInputEvent: vi.fn() } };
}

afterEach((): void => {
  document.body.replaceChildren();
  delete (document as Document & { __doubaoStudioCreationHistory?: unknown }).__doubaoStudioCreationHistory;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('原图片卡证据的DOM读取和消息ID历史缓存', (): void => {
  it('同卡显式2848原图优先于384缩略图，隐藏和未懒加载均不阻断平台原图', (): void => {
    const assistant = document.createElement('div') as FiberElement; assistant.dataset.testid = 'receive_message'; assistant.dataset.messageId = 'TEST-reply';
    assistant.append(picture('https://test.invalid/large-decoration.png'));
    const card = document.createElement('div'); card.dataset.testid = 'message_image_content';
    const video = document.createElement('video'); video.append(picture('https://test.invalid/video-poster.png'));
    const original = picture(originalImage, 0, 0, false); original.style.display = 'none';
    card.append(original, picture('https://test.invalid/thumb.png', 384, 216), picture('https://test.invalid/avatar.png'),
      picture('http://test.invalid/insecure.png'), picture('https://test.invalid/unloaded.png', 800, 600, false), video);
    assistant.__reactFiber$TEST = { memoizedProps: { value: { message: { message_id: 'TEST-reply', conversation_id: 'TEST-image-history', content_blocks: [
      { is_finish: true, content_obj: { creations: [{ image: { status: 2, image_thumb: { url: 'https://test.invalid/thumb.png', width: 2848, height: 1600 }, image_ori: { url: originalImage, width: 2848, height: 1600 } } }] } },
    ] } } } };
    assistant.append(card); document.body.append(assistant);
    const message = readChatPage(document).messages[0];
    expect(message.imageArtifactUrls).toEqual([originalImage]);
    expect(message.imageArtifactPending).toBe(false);
    expect(message.imageUrls).toContain('https://test.invalid/large-decoration.png');
    expect(message.imageArtifactUrls).not.toContain('https://test.invalid/large-decoration.png');
  });

  it('provider真实消息ID补齐归属，仅收原轮次严格图片卡', async (): Promise<void> => {
    const test = fixture(); const snapshot = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(snapshot.historyComplete).toBe(true);
    expect(snapshot.messages[2]).toMatchObject({ messageId: 'TEST-original-user', turnId: 'TEST-shared-turn' });
    expect(snapshot.messages[3]).toMatchObject({ imageUrls: [originalImage], imageArtifactUrls: [originalImage], imageArtifactPending: false });
    expect(inspectImageArtifactReadback(snapshot, { prompt, runId: 'TEST-run', userMessageId: 'TEST-original-user' }).outputs).toEqual([originalImage]);
  });

  it('真实序列化历史中原助手询问生图、用户回复“要”后，按明确消息父链一次取齐三张既有原图', async (): Promise<void> => {
    vi.useFakeTimers(); const test = fixture();
    test.models[3].image = undefined; test.models[3].text = '你现在是要我直接调用生图生成这张图吗？'; test.models[4].text = '要'; test.mount();
    for (const image of test.nodeFor('TEST-next-user').querySelectorAll('img')) image.remove();
    const originals = [1, 2, 3].map((index: number): string => `https://test.invalid/confirmed-${index}.png`);
    const thumbs = [1, 2, 3].map((index: number): string => `https://test.invalid/confirmed-thumb-${index}.png`);
    test.messageFor('TEST-next-reply').content_blocks = [{ is_finish: true, content_obj: { creations: originals.map((source: string, index: number): object => ({ image: {
      status: 2, image_thumb: { url: thumbs[index], width: 2848, height: 1600 }, image_ori: { url: source, width: 2848, height: 1600 },
    } })) } }];
    test.nodeFor('TEST-next-reply').querySelector('[data-testid="message_image_content"]')!.replaceChildren(...thumbs.map((source: string): HTMLImageElement => picture(source, 384, 216)));
    const snapshot = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(snapshot.historyComplete).toBe(true); expect(snapshot.messages[3].imageArtifactUrls).toBeUndefined();
    expect(snapshot.messages[4]).toMatchObject({ role: 'user', text: '要', messageId: 'TEST-next-user' }); expect(snapshot.messages[4].hasAttachments).not.toBe(true);
    expect(snapshot.messages[5]).toMatchObject({ replyId: 'TEST-next-user', imageArtifactPending: false, imageArtifactUrls: originals });
    const recovering = readAcceptedImageOutputs(test.view, url, undefined, 5000, { prompt, runId: 'TEST-run', userMessageId: 'TEST-original-user' }, { ensureCurrent: (): void => undefined });
    await vi.advanceTimersByTimeAsync(2000); expect(await recovering).toEqual(originals);
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each(['real-user-attachment', 'unknown-reply-chain'] as const)('真实序列化的肯定回复遇到%s仍不串接图片', async (variant): Promise<void> => {
    const test = fixture(); test.models[3].image = undefined; test.models[3].text = '需要我帮你生成图片吗？'; test.models[4].text = '要';
    if (variant === 'unknown-reply-chain') test.models[5].replyId = 'TEST-unknown-parent';
    test.mount();
    if (variant === 'unknown-reply-chain') for (const image of test.nodeFor('TEST-next-user').querySelectorAll('img')) image.remove();
    const snapshot = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    if (variant === 'real-user-attachment') expect(snapshot.messages[4].hasAttachments).toBe(true);
    expect(inspectImageArtifactReadback(snapshot, { prompt, runId: 'TEST-run', userMessageId: 'TEST-original-user' }).outputs).toEqual([]);
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('图卡诊断只保留已知结构及比较结果，不泄露provider正文、身份、凭据或媒体地址', async (): Promise<void> => {
    const test = fixture(); const model = test.messageFor('TEST-original-reply');
    model.cookie = 'TEST-private-cookie'; model.token = 'TEST-private-token'; model.unknown_payload = 'TEST-private-payload';
    const visible = readChatPage(document); const history = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    for (const snapshot of [visible, history]) {
      const diagnostic = snapshot.messages.find((message): boolean => message.imageArtifactUrls?.includes(originalImage) === true)?.imageArtifactDiagnostics;
      expect(diagnostic).toMatchObject({ cardCount: 1, renderedImageCount: 2, modelFound: true,
        blockCounts: { normalized: 2, v2: 0, legacy: 0 }, creationCount: 1, matchedCreationCount: 1, matchedCardCount: 1,
        creations: [{ imagePresent: true, status: 2, statusType: 'number', finished: true, finishedType: 'boolean', matchedCardCount: 1 }] });
      expect(diagnostic?.creations[0].variants.find((variant): boolean => variant.field === 'image_ori'))
        .toMatchObject({ present: true, urlValid: true, widthType: 'number', heightType: 'number', widthPositive: true, heightPositive: true, matchedCardCount: 1 });
      const serialized = JSON.stringify(diagnostic);
      for (const secret of [prompt, url, originalImage, 'https:', 'TEST-original', 'TEST-private-cookie', 'TEST-private-token', 'TEST-private-payload']) expect(serialized).not.toContain(secret);
    }
  });

  it('缺失卡片选择器时保留结构诊断，不把provider原图字段升级为产物', async (): Promise<void> => {
    const test = fixture(); test.nodeFor('TEST-original-reply').querySelector('[data-testid="message_image_content"]')!.remove();
    const snapshot = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(snapshot.messages[3]).toMatchObject({ imageArtifactDiagnostics: { cardCount: 0, modelFound: true, creationCount: 1, matchedCreationCount: 0, matchedCardCount: 0 } });
    expect(snapshot.messages[3].imageArtifactUrls).toBeUndefined();
    expect(inspectImageArtifactReadback(snapshot, { prompt, runId: 'TEST-run' }).outputs).toEqual([]);
  });

  it('完整身份快照不含图片证据时，后续真实图片快照仍一次取齐原轮次三候选', async (): Promise<void> => {
    const test = fixture(); const node = test.nodeFor('TEST-original-reply');
    const originals = [1, 2, 3].map((ordinal: number): string => `https://test.invalid/candidate-${ordinal}.png`);
    const thumbs = [1, 2, 3].map((ordinal: number): string => `https://test.invalid/candidate-thumb-${ordinal}.png`);
    test.messageFor('TEST-original-reply').content_blocks = [{ is_finish: true, content_obj: { creations: originals.map((source: string, index: number): object => ({ image: {
      status: 2, image_thumb: { url: thumbs[index], width: 2848, height: 1600 }, image_ori: { url: source, width: 2848, height: 1600 },
    } })) } }];
    const card = node.querySelector('[data-testid="message_image_content"]')!;
    card.replaceChildren(...thumbs.map((source: string): HTMLImageElement => picture(source, 384, 216)));
    const identity = await getCurrentCreationConversation(test.view);
    expect(identity.source).toBe('published_message');
    expect(identity.snapshot.messages[3].imageArtifactUrls).toBeUndefined();
    const snapshot = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(inspectImageArtifactReadback(snapshot, { prompt, runId: 'TEST-run', userMessageId: 'TEST-original-user' }))
      .toMatchObject({ reason: 'ready', outputs: originals });
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('后续空用户消息及其图片保持独立轮次，不能因共享union或指回旧助手而串入原图', async (): Promise<void> => {
    const test = fixture(); test.models[4].text = ''; test.models[5].replyId = 'TEST-original-reply'; test.mount();
    const snapshot = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(snapshot.messages[4]).toMatchObject({ role: 'user', text: '' });
    expect(inspectImageArtifactReadback(snapshot, { prompt, runId: 'TEST-run', userMessageId: 'TEST-original-user' }))
      .toMatchObject({ reason: 'ready', outputs: [originalImage] });
    test.models[3].image = undefined; test.mount();
    const missing = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(inspectImageArtifactReadback(missing, { prompt, runId: 'TEST-run', userMessageId: 'TEST-original-user' }))
      .toMatchObject({ reason: 'image_pending', outputs: [] });
  });

  it.each(['normalized', 'legacy'] as const)('content_blocks_v2的%s图片模型与常规模型读取同一原图，不误等生成完成', async (format): Promise<void> => {
    const test = fixture(); const model = test.messageFor('TEST-original-reply');
    const blocks = model.content_blocks as { content_obj: object; is_finish?: boolean }[];
    model.content_blocks_v2 = format === 'normalized' ? blocks : blocks.map((block): object => ({ is_finish: block.is_finish, content: { creation_block: block.content_obj } }));
    delete model.content_blocks;
    const visible = readChatPage(document);
    const history = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    for (const snapshot of [visible, history]) {
      expect(snapshot.messages.find((message): boolean => message.role === 'assistant' && !!message.imageUrls?.includes(originalImage)))
        .toMatchObject({ imageArtifactUrls: [originalImage], imageArtifactPending: false });
    }
  });

  it('已证明的原图片卡虚拟卸载后，按同消息ID缓存回收，挂载晚图不能顶替', async (): Promise<void> => {
    const test = fixture(); await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    test.mount(['TEST-next-user', 'TEST-next-reply']);
    const snapshot = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(snapshot.historyComplete).toBe(true);
    expect(inspectImageArtifactReadback(snapshot, { prompt, runId: 'TEST-run' }).outputs).toEqual([originalImage]);
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('旧版缓存的已卸载缩略图不能升级成原图证据，重新挂载后才恢复真实原图', async (): Promise<void> => {
    const test = fixture(); await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    const cache = (document as Document & { __doubaoStudioCreationHistory?: { imageEvidenceVersion?: number; messages: Record<string, { imageArtifactUrls?: string[] }> } }).__doubaoStudioCreationHistory!;
    delete cache.imageEvidenceVersion; cache.messages['TEST-original-reply'].imageArtifactUrls = ['https://test.invalid/legacy-thumb.png'];
    test.mount(['TEST-next-user', 'TEST-next-reply']);
    const incomplete = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(inspectImageArtifactReadback(incomplete, { prompt, runId: 'TEST-run' }).outputs).toEqual([]);
    test.mount();
    const restored = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(inspectImageArtifactReadback(restored, { prompt, runId: 'TEST-run' }).outputs).toEqual([originalImage]);
  });

  it('已声明原图未解码时仍可用，同ID原图字段更新后不再返回旧地址', async (): Promise<void> => {
    const test = fixture(); await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    const original = test.models.find((model: MessageModel): boolean => model.id === 'TEST-original-reply')!;
    original.pending = true; test.mount();
    const pending = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(inspectImageArtifactReadback(pending, { prompt, runId: 'TEST-run' })).toMatchObject({ reason: 'ready', outputs: [originalImage] });
    original.pending = false; original.image = 'https://test.invalid/updated.png'; test.mount();
    const ready = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(inspectImageArtifactReadback(ready, { prompt, runId: 'TEST-run' }).outputs).toEqual(['https://test.invalid/updated.png']);
  });

  it('只有thumb时不以错误的2848声明尺寸认原图，可见读取与历史读取保持一致', async (): Promise<void> => {
    const test = fixture(); test.models[3].thumbOnly = true; test.mount();
    const visible = readChatPage(document);
    const history = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    for (const snapshot of [visible, history]) {
      const original = snapshot.messages.find((message): boolean => message.imageArtifactPending === true);
      expect(original).toMatchObject({ imageArtifactUrls: [], imageArtifactPending: true });
      expect(inspectImageArtifactReadback(snapshot, { prompt, runId: 'TEST-run', allowUnidentifiedNewConversation: true }).outputs).toEqual([]);
    }
  });

  it('同消息声明三候选但只挂载两候选时保持pending，不提前遗失第三张', async (): Promise<void> => {
    const test = fixture(); const node = test.nodeFor('TEST-original-reply');
    const message = test.messageFor('TEST-original-reply');
    const records = [1, 2, 3].map((ordinal: number): object => ({ image: { status: 2,
      image_thumb: { url: `https://test.invalid/thumb-${ordinal}.png`, width: 2848, height: 1600 },
      image_ori: { url: `https://test.invalid/original-${ordinal}.png`, width: 2848, height: 1600 } } }));
    message.content_blocks = [{ is_finish: true, content_obj: { creations: records } }];
    const card = node.querySelector('[data-testid="message_image_content"]')!; card.replaceChildren(picture('https://test.invalid/thumb-1.png', 384, 216), picture('https://test.invalid/thumb-2.png', 384, 216));
    const visible = readChatPage(document); const history = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    for (const snapshot of [visible, history]) {
      const result = snapshot.messages.find((item): boolean => item.imageArtifactPending === true);
      expect(result).toMatchObject({ imageArtifactPending: true, imageArtifactUrls: ['https://test.invalid/original-1.png', 'https://test.invalid/original-2.png'] });
    }
    card.append(picture('https://test.invalid/thumb-3.png', 384, 216));
    const ready = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(inspectImageArtifactReadback(ready, { prompt, runId: 'TEST-run' }).outputs).toHaveLength(3);
  });

  it('provider其它助手的原图字段不能借当前卡渲染源串入原回复', async (): Promise<void> => {
    const test = fixture(); const message = test.messageFor('TEST-original-reply');
    message.content_blocks = [{ is_finish: true, content_obj: { creations: [{ image: { status: 2,
      image_thumb: { url: 'https://test.invalid/foreign-thumb.png', width: 2848, height: 1600 },
      image_ori: { url: 'https://test.invalid/next.png', width: 2848, height: 1600 } } }] } }];
    const history = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(inspectImageArtifactReadback(history, { prompt, runId: 'TEST-run' })).toMatchObject({ reason: 'image_pending', outputs: [] });
    expect(history.messages[5].imageArtifactUrls).toEqual(['https://test.invalid/next.png']);
  });

  it('原消息从真实列表移除后，历史缓存不能自作主张补回旧产物', async (): Promise<void> => {
    const test = fixture(); await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    test.models.splice(2, 2); test.mount();
    const snapshot = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(inspectImageArtifactReadback(snapshot, { prompt, runId: 'TEST-run' })).toMatchObject({ reason: 'request_missing', outputs: [] });
  });

  it('原助手图片卡的明确失败保留具体原因，未加载图片不能伪装产物', async (): Promise<void> => {
    const test = fixture(); const original = test.models[3]; original.image = undefined; original.failure = '图片生成失败，请稍后重试。'; test.mount();
    const snapshot = await getCreationReadbackSnapshot(test.view, { conversationUrl: url });
    expect(snapshot.messages[3]).toMatchObject({ imageArtifactFailure: '图片生成失败', imageArtifactUrls: [] });
    expect(inspectImageArtifactReadback(snapshot, { prompt, runId: 'TEST-run' }).blocker).toBe('平台提示图片生成失败');
  });

  it('地址栏仍为根页时仅沿一致的真实provider会话收原图，最终仍回查该provider', async (): Promise<void> => {
    vi.useFakeTimers(); const test = fixture();
    test.view.getURL = (): string => 'https://www.doubao.com/chat/';
    const result = readAcceptedImageOutputs(test.view, url, undefined, 5000, { prompt, runId: 'TEST-run' }, { ensureCurrent: (): void => undefined });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual([originalImage]);
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });
});
