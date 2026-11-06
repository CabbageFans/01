import type { ChatPageSnapshot } from './chatReadback';

export interface CreationHistoryReadOptions { conversationId: string; timeoutMs: number; requestId?: string }

/**
 * 只读取当前会话明确的消息列表和已挂载 Message provider DTO。
 * dataList 只有消息 ID；缺项时短暂挂载较早消息，完成后恢复位置，不调用 React 方法或平台接口。
 */
export async function readCreationHistorySnapshot(doc: Document, readMessages: (document: Document) => ChatPageSnapshot, options: CreationHistoryReadOptions): Promise<ChatPageSnapshot> {
  type Message = ChatPageSnapshot['messages'][number];
  type RecordValue = Record<string, unknown>;
  type Cache = { conversationId: string; messages: Record<string, Message>; imageEvidenceVersion: 1 };
  const current = doc as Document & { __doubaoStudioCreationHistory?: Cache; __doubaoStudioCreationHistorySampling?: boolean; __doubaoStudioCreationHistoryCancelled?: Record<string, boolean> };
  const cancelled = (): boolean => !!options.requestId && current.__doubaoStudioCreationHistoryCancelled?.[options.requestId] === true;
  const clearCancellation = (): void => { if (options.requestId && current.__doubaoStudioCreationHistoryCancelled) delete current.__doubaoStudioCreationHistoryCancelled[options.requestId]; };
  const list = doc.querySelector('[data-testid="message-list"]');
  const fallback = (): ChatPageSnapshot => readMessages(doc);
  if (!list || !options.conversationId) return fallback();
  const object = (value: unknown): RecordValue | undefined => value && typeof value === 'object' ? value as RecordValue : undefined;
  const fiberFor = (node: Element): RecordValue | undefined => {
    const key = Object.getOwnPropertyNames(node).find((name: string): boolean => name.startsWith('__reactFiber$'));
    return key ? object((node as unknown as RecordValue)[key]) : undefined;
  };
  const listIds = (): string[] | undefined => {
    let fiber = fiberFor(list);
    for (let depth = 0; fiber && depth < 16; depth++, fiber = object(fiber.return)) {
      const props = object(fiber.memoizedProps);
      if (props?.conversationId !== options.conversationId || !Array.isArray(props.dataList)) continue;
      const ids: string[] = [];
      for (const entry of props.dataList) {
        const block = object(entry);
        if (!block || block.type !== 'block' || block.conversationId !== options.conversationId || !Array.isArray(block.data)) return undefined;
        for (const value of block.data) {
          const item = object(value);
          if (typeof item?.messageId !== 'string' || !item.messageId) return undefined;
          ids.push(item.messageId);
        }
      }
      return ids.length > 0 && ids.length <= 1000 && new Set(ids).size === ids.length ? ids : undefined;
    }
    return undefined;
  };
  const initialIds = listIds();
  if (!initialIds) return fallback();
  // 旧缓存曾以解码尺寸接纳缩略图，不能升级成“平台显式原图”证据；须重新读取真实 provider。
  if (current.__doubaoStudioCreationHistory?.conversationId !== options.conversationId || current.__doubaoStudioCreationHistory.imageEvidenceVersion !== 1) {
    current.__doubaoStudioCreationHistory = { conversationId: options.conversationId, messages: {}, imageEvidenceVersion: 1 };
  }
  const cache = current.__doubaoStudioCreationHistory;
  if (!cache) return fallback();
  const modelFor = (node: Element, ids: Set<string>): RecordValue | undefined => {
    let fiber = fiberFor(node);
    for (let depth = 0; fiber && depth < 8; depth++, fiber = object(fiber.return)) {
      const props = object(fiber.memoizedProps); const value = object(props?.value);
      const message = object(value?.message) || object(props?.message);
      if (message?.conversation_id === options.conversationId && typeof message.message_id === 'string' && ids.has(message.message_id)) return message;
    }
    return undefined;
  };
  const modelText = (model: RecordValue): string | undefined => {
    const blocks = Array.isArray(model.content_blocks) ? model.content_blocks : Array.isArray(model.content_blocks_v2) ? model.content_blocks_v2 : [];
    const texts = blocks.flatMap((value: unknown): string[] => {
      const block = object(value); const content = object(block?.content_obj);
      return block?.block_type === 10000 && !block.is_deleted && typeof content?.text === 'string' ? [content.text] : [];
    });
    if (texts.length) return texts.join('\n');
    const original = Array.isArray(model.content_block) ? model.content_block : [];
    const raw = original.flatMap((value: unknown): string[] => {
      const block = object(value); const content = object(block?.content); const text = object(content?.text_block);
      return !block?.is_deleted && typeof text?.text === 'string' ? [text.text] : [];
    });
    return raw.length ? raw.join('\n') : undefined;
  };
  // 自包含：此函数随消息读取器一起序列化，不依赖宿主模块或整页全局媒体缓存。
  const readOriginalImageCards = (node: Element, suppliedModel?: Record<string, unknown>): Pick<Message, 'imageArtifactUrls' | 'imageArtifactPending' | 'imageArtifactFailure' | 'imageArtifactDiagnostics'> => {
    if (node.getAttribute('data-testid') !== 'receive_message') return {};
    const cards = Array.from(node.querySelectorAll('[data-testid="message_image_content"]'));
    type Value = Record<string, unknown>;
    const object = (value: unknown): Value | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined;
    const modelForMessage = (): Value | undefined => {
      const keys = Object.getOwnPropertyNames(node).filter((key: string): boolean => key.startsWith('__reactFiber$'));
      if (keys.length !== 1) return undefined;
      let fiber = object((node as unknown as Value)[keys[0]]); let found: Value | undefined;
      for (let depth = 0; fiber && depth < 8; depth++, fiber = object(fiber.return)) {
        const props = object(fiber.memoizedProps); const value = object(props?.value);
        const model = object(value?.message) || object(props?.message);
        if (!model) continue;
        if (typeof model.message_id !== 'string' || typeof model.conversation_id !== 'string') return undefined;
        if (found && (found.message_id !== model.message_id || found.conversation_id !== model.conversation_id)) return undefined;
        found = model;
      }
      const declared = node.getAttribute('data-message-id') || node.getAttribute('data-msg-id');
      return found && (!declared || declared === found.message_id) ? found : undefined;
    };
    const model = suppliedModel || modelForMessage();
    const creationsIn = (blocks: unknown, normalized: boolean): Value[] => Array.isArray(blocks) ? blocks.flatMap((value: unknown): Value[] => {
      const block = object(value); if (!block || block.is_deleted) return [];
      const content = normalized ? object(block.content_obj) : object(object(block.content)?.creation_block);
      return Array.isArray(content?.creations) ? content.creations.flatMap((creation: unknown): Value[] => {
        const item = object(creation); return item ? [{ image: item.image, finished: block.is_finish }] : [];
      }) : [];
    }) : [];
    const normalized = creationsIn(model?.content_blocks, true);
    // v2 同时存在归一化 content_obj 与旧 creation_block；只读当前消息明确的字段。
    const normalizedV2 = creationsIn(model?.content_blocks_v2, true);
    const modern = normalized.length ? normalized : normalizedV2.length ? normalizedV2 : creationsIn(model?.content_blocks_v2, false);
    const creations = modern.length ? modern : creationsIn(model?.content_block, false);
    const remoteUrl = (value: unknown): value is string => {
      if (typeof value !== 'string' || !/^https:\/\//i.test(value)) return false;
      try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
    };
    const matchedVariantCards = (sources: string[]): number => cards.filter((card: Element): boolean => Array.from(card.querySelectorAll('img')).some((element: HTMLImageElement): boolean => !element.closest('video')
      && (sources.includes(element.currentSrc || element.src) || sources.includes(element.src)))).length;
    // 诊断只读取已知字段的存在、类型及比较结果；不输出任意 provider 值或媒体地址。
    const blockCount = (blocks: unknown): number => Array.isArray(blocks) ? blocks.length : 0;
    const diagnostics: NonNullable<ChatPageSnapshot['messages'][number]['imageArtifactDiagnostics']> = {
      cardCount: cards.length, renderedImageCount: cards.reduce((count: number, card: Element): number => count + card.querySelectorAll('img').length, 0), modelFound: !!model,
      blockCounts: { normalized: blockCount(model?.content_blocks), v2: blockCount(model?.content_blocks_v2), legacy: blockCount(model?.content_block) },
      creationCount: creations.length, matchedCreationCount: 0, matchedCardCount: 0,
      creations: creations.slice(0, 32).map((creation: Value): NonNullable<ChatPageSnapshot['messages'][number]['imageArtifactDiagnostics']>['creations'][number] => {
        const image = object(creation.image);
        return { imagePresent: !!image, statusType: typeof image?.status, ...(typeof image?.status === 'number' && Number.isFinite(image.status) ? { status: image.status } : {}),
          finishedType: typeof creation.finished, ...(typeof creation.finished === 'boolean' ? { finished: creation.finished } : {}), matchedCardCount: 0,
          variants: ['image_thumb', 'image_ori', 'image_preview', 'image_ori_raw', 'image_preview_resize'].map((field: string): NonNullable<ChatPageSnapshot['messages'][number]['imageArtifactDiagnostics']>['creations'][number]['variants'][number] => {
            const variant = image ? object(image[field]) : undefined; const variantUrl = variant?.url; const valid = remoteUrl(variantUrl);
            return { field, present: !!variant, urlValid: valid, widthType: typeof variant?.width, heightType: typeof variant?.height,
              widthPositive: typeof variant?.width === 'number' && Number.isFinite(variant.width) && variant.width > 0,
              heightPositive: typeof variant?.height === 'number' && Number.isFinite(variant.height) && variant.height > 0,
              matchedCardCount: valid ? matchedVariantCards([variantUrl]) : 0 };
          }) };
      }),
    };
    // 无卡时只记录真实 provider 的结构；普通 Chat 保持原快照契约。
    if (!cards.length) return model ? { imageArtifactDiagnostics: diagnostics } : {};
    const failureFor = (card: Element): string | undefined => (card.textContent || '').normalize('NFKC').trim()
      .match(/^(?:图片生成失败|生成图片失败|图片生成异常|图片生成出错|生成失败|图片生成次数已用完|图片生成额度不足|请求未通过内容审核)/)?.[0];
    let imageArtifactFailure: string | undefined; let imageArtifactPending = false;
    const matchedCards = new Set<Element>(); const urls: string[] = [];
    for (const [creationIndex, creation] of creations.entries()) {
      const image = object(creation.image); if (!image) continue;
      const variants = ['image_thumb', 'image_ori', 'image_preview', 'image_ori_raw', 'image_preview_resize'].flatMap((key: string): string[] => {
        const variant = object(image[key]); return remoteUrl(variant?.url) ? [variant.url] : [];
      });
      // 原图字段必须与本消息图片卡的某个真实渲染源精确关联；不按最大尺寸猜地址。
      const owned = cards.filter((card: Element): boolean => Array.from(card.querySelectorAll('img')).some((element: HTMLImageElement): boolean => !element.closest('video')
        && (variants.includes(element.currentSrc || element.src) || variants.includes(element.src))));
      if (owned.length) diagnostics.matchedCreationCount++;
      if (diagnostics.creations[creationIndex]) diagnostics.creations[creationIndex].matchedCardCount = owned.length;
      if (!owned.length) { imageArtifactPending = true; continue; }
      for (const card of owned) matchedCards.add(card);
      const original = ['image_ori', 'image_ori_raw'].map((key: string): Value | undefined => object(image[key])).find((variant: Value | undefined): variant is Value => !!variant && remoteUrl(variant.url)
        && typeof variant.width === 'number' && Number.isFinite(variant.width) && variant.width > 0
        && typeof variant.height === 'number' && Number.isFinite(variant.height) && variant.height > 0);
      if (!original || image.status !== 2 || creation.finished === false) { imageArtifactPending = true; continue; }
      // 已由平台显式给出的原图不依赖懒渲染、display:none 或缩略图解码完成。
      urls.push(original.url as string);
    }
    for (const card of cards) {
      const failure = failureFor(card); if (failure) imageArtifactFailure = failure;
      if (card.getAttribute('data-finished') === 'false' || !matchedCards.has(card) && !failure) imageArtifactPending = true;
    }
    diagnostics.matchedCardCount = matchedCards.size;
    return { imageArtifactDiagnostics: diagnostics, imageArtifactUrls: [...new Set(urls)], imageArtifactPending, ...(imageArtifactFailure ? { imageArtifactFailure } : {}) };
  };
  const imageEvidence = (node: Element, model: RecordValue): Pick<Message, 'imageUrls' | 'imageArtifactUrls' | 'imageArtifactPending' | 'imageArtifactFailure' | 'imageArtifactDiagnostics'> => {
    const evidence = readOriginalImageCards(node, model);
    return { ...evidence, ...(evidence.imageArtifactUrls?.length ? { imageUrls: evidence.imageArtifactUrls } : {}) };
  };
  const capture = (): string[] | undefined => {
    const ids = listIds(); if (!ids) return undefined;
    const allowed = new Set(ids);
    for (const node of list.querySelectorAll('[data-testid="send_message"], [data-testid="receive_message"]')) {
      const model = modelFor(node, allowed); if (!model || typeof model.message_id !== 'string') continue;
      const declared = node.getAttribute('data-message-role');
      const role = node.getAttribute('data-testid') === 'send_message' ? 'user' : 'assistant';
      if (declared && declared !== role) continue;
      const turnId = node.closest('[data-testid="union_message"]')?.getAttribute('data-target-id') || undefined;
      const rawText = modelText(model) ?? node.querySelector('[data-testid="message_text_content"]')?.textContent ?? '';
      const attachmentOnly = role === 'user' && !rawText.trim() && !!node.querySelector('img');
      const hasAttachments = role === 'user' && (!!node.querySelector('img') || cache.messages[model.message_id]?.hasAttachments === true);
      const images = imageEvidence(node, model);
      if (attachmentOnly && cache.messages[model.message_id]?.text) {
        if (hasAttachments) cache.messages[model.message_id].hasAttachments = true;
        continue;
      }
      cache.messages[model.message_id] = { role, text: rawText.normalize('NFKC').replace(/\s+/g, ' ').trim(), rawText,
        messageId: model.message_id, ...(typeof model.reply_id === 'string' && model.reply_id ? { replyId: model.reply_id } : {}),
        turnId,
        ...(role === 'assistant' && (node.querySelector('[class*="block-video"],video') || cache.messages[model.message_id]?.videoReady) ? { videoReady: true } : {}),
        ...images,
        ...(hasAttachments ? { hasAttachments: true } : {}),
        ...(attachmentOnly ? { attachmentOnly: true } : {}) };
    }
    return ids;
  };
  const complete = (ids: string[] | undefined): boolean => !!ids && ids.every((id: string): boolean => !!cache.messages[id]);
  const snapshot = (ids: string[] | undefined): ChatPageSnapshot => ids && complete(ids)
    ? { ...fallback(), messages: ids.map((id: string): Message => cache.messages[id]), historyComplete: true, conversationId: options.conversationId }
    : fallback();
  let ids = capture();
  if (complete(ids)) return snapshot(ids);
  // 阅读已挂载模型不影响用户；补挂载历史前则保护正在编辑的草稿和焦点。
  const editing = (): boolean => {
    const editor = doc.activeElement as HTMLElement | null;
    return !!fallback().editorText.trim() || doc.hasFocus() && !!editor?.matches('textarea,[contenteditable="true"],[contenteditable=""]');
  };
  if (editing()) return snapshot(ids);
  const scroller = list.querySelector<HTMLElement>('.scroller');
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight || options.timeoutMs < 150) return snapshot(ids);
  const scrollTop = scroller.scrollTop; const scrollLeft = scroller.scrollLeft;
  const deadline = Date.now() + Math.min(3500, Math.max(1, options.timeoutMs));
  let interrupted = false;
  const onInteraction = (event: Event): void => { if (event.isTrusted) interrupted = true; };
  const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  for (const event of events) doc.addEventListener(event, onInteraction, { capture: true, passive: true });
  const sameList = (): boolean => list.isConnected && doc.querySelector('[data-testid="message-list"]') === list && !!listIds();
  const canSample = (): boolean => Date.now() < deadline && !interrupted && !cancelled() && sameList();
  current.__doubaoStudioCreationHistorySampling = true;
  try {
    // 前端列表反向虚拟挂载；先读顶部，随后最多五个屏段，严格限制单次读取预算。
    for (let sample = 0; sample < 6 && canSample(); sample++) {
      scroller.scrollTop = sample === 0 ? 0 : Math.min(scroller.scrollHeight - scroller.clientHeight, sample * Math.max(1, scroller.clientHeight - 40));
      await new Promise<void>((resolve): void => { setTimeout(resolve, Math.min(180, Math.max(1, deadline - Date.now()))); });
      if (!canSample()) break;
      ids = capture(); if (complete(ids)) break;
    }
  } finally {
    for (const event of events) doc.removeEventListener(event, onInteraction, true);
    if (!interrupted && sameList()) { scroller.scrollTop = scrollTop; scroller.scrollLeft = scrollLeft; }
    current.__doubaoStudioCreationHistorySampling = false;
    clearCancellation();
  }
  if (!interrupted && sameList() && Date.now() + 100 < deadline) await new Promise<void>((resolve): void => { setTimeout(resolve, 100); });
  return sameList() ? snapshot(ids) : fallback();
}
