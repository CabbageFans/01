import type { ChatPageSnapshot } from './chatReadback';

export interface CreationHistoryReadOptions { conversationId: string; timeoutMs: number; requestId?: string }

/**
 * 只读取当前会话明确的消息列表和已挂载 Message provider DTO。
 * dataList 只有消息 ID；缺项时短暂挂载较早消息，完成后恢复位置，不调用 React 方法或平台接口。
 */
export async function readCreationHistorySnapshot(doc: Document, readMessages: (document: Document) => ChatPageSnapshot, options: CreationHistoryReadOptions): Promise<ChatPageSnapshot> {
  type Message = ChatPageSnapshot['messages'][number];
  type RecordValue = Record<string, unknown>;
  type Cache = { conversationId: string; messages: Record<string, Message> };
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
  if (current.__doubaoStudioCreationHistory?.conversationId !== options.conversationId) current.__doubaoStudioCreationHistory = { conversationId: options.conversationId, messages: {} };
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
  const capture = (): string[] | undefined => {
    const ids = listIds(); if (!ids) return undefined;
    const allowed = new Set(ids);
    for (const node of list.querySelectorAll('[data-testid="send_message"], [data-testid="receive_message"]')) {
      const model = modelFor(node, allowed); if (!model || typeof model.message_id !== 'string') continue;
      const declared = node.getAttribute('data-message-role');
      const role = node.getAttribute('data-testid') === 'send_message' ? 'user' : 'assistant';
      if (declared && declared !== role) continue;
      const rawText = modelText(model) ?? node.querySelector('[data-testid="message_text_content"]')?.textContent ?? '';
      const attachmentOnly = role === 'user' && !rawText.trim() && !!node.querySelector('img');
      const hasAttachments = role === 'user' && (!!node.querySelector('img') || cache.messages[model.message_id]?.hasAttachments === true);
      if (attachmentOnly && cache.messages[model.message_id]?.text) {
        if (hasAttachments) cache.messages[model.message_id].hasAttachments = true;
        continue;
      }
      cache.messages[model.message_id] = { role, text: rawText.normalize('NFKC').replace(/\s+/g, ' ').trim(), rawText,
        messageId: model.message_id, ...(typeof model.reply_id === 'string' && model.reply_id ? { replyId: model.reply_id } : {}),
        ...(role === 'assistant' && (node.querySelector('[class*="block-video"],video') || cache.messages[model.message_id]?.videoReady) ? { videoReady: true } : {}),
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
