import type { ChatPageSnapshot } from './chatReadback';

export interface CurrentCreationConversationReadback {
  snapshot: ChatPageSnapshot;
  conversationId?: string;
  conversationUrl?: string;
  source?: 'published_message';
  /** 仅含本次列表及实际 provider DTO 双方一致的服务器消息 ID。 */
  messageIds?: string[];
  reason?: 'message_list_missing' | 'message_list_ambiguous' | 'conversation_identity_missing' | 'conversation_identity_conflict' | 'message_models_incomplete';
}

/**
 * 当前活动消息列表的只读身份探针，可直接序列化到 Webview；不依赖地址栏或外部闭包。
 * 只沿列表/消息节点的固定 Fiber props 路径读取，不遍历全局 store、不调用 React 方法。
 * 部分实际模型只证明当前会话 ID；全部服务器模型一致且存在用户消息时才给发布来源。
 */
export function readCurrentCreationConversation(doc: Document, readMessages: (document: Document) => ChatPageSnapshot): CurrentCreationConversationReadback {
  type Value = Record<string, unknown>;
  type Message = ChatPageSnapshot['messages'][number];
  const fallback = (): ChatPageSnapshot => readMessages(doc);
  const failed = (reason: CurrentCreationConversationReadback['reason']): CurrentCreationConversationReadback => ({ snapshot: fallback(), reason });
  const object = (value: unknown): Value | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined;
  const conversationId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) && !/^local_/i.test(value);
  const messageId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_:.=-]{1,256}$/.test(value) && !/^local_/i.test(value);
  const fiberFor = (node: Element): Value | undefined => {
    const keys = Object.getOwnPropertyNames(node).filter((key: string): boolean => key.startsWith('__reactFiber$'));
    return keys.length === 1 ? object((node as unknown as Value)[keys[0]]) : undefined;
  };
  type ListIdentity = { id: string; ids: string[]; localIds: Set<string> };
  const parseListProps = (props: Value): ListIdentity | undefined => {
    if (!conversationId(props.conversationId) || !Array.isArray(props.dataList)) return undefined;
    const candidateIds: string[] = [];
    const candidateLocalIds = new Set<string>();
    for (const entry of props.dataList) {
      const block = object(entry);
      if (!block || block.type !== 'block' || block.conversationId !== props.conversationId || !Array.isArray(block.data)) return undefined;
      for (const entryMessage of block.data) {
        const item = object(entryMessage);
        if (!item || typeof item.messageId !== 'string' || !item.messageId || item.messageId.length > 256) return undefined;
        if (item.isLocalMessage === true || /^local_/i.test(item.messageId)) candidateLocalIds.add(item.messageId);
        else if (!messageId(item.messageId)) return undefined;
        candidateIds.push(item.messageId);
      }
    }
    if (candidateIds.length > 1000 || new Set(candidateIds).size !== candidateIds.length) return undefined;
    return { id: props.conversationId, ids: candidateIds, localIds: candidateLocalIds };
  };
  const listIdentity = (list: Element): ListIdentity | undefined => {
    let identity: ListIdentity | undefined;
    let fiber = fiberFor(list);
    for (let depth = 0; fiber && depth < 16; depth++, fiber = object(fiber.return)) {
      const props = object(fiber.memoizedProps);
      if (!props || !Array.isArray(props.dataList)) continue;
      const candidate = parseListProps(props);
      if (!candidate) return undefined;
      if (identity && (identity.id !== candidate.id || JSON.stringify(identity.ids) !== JSON.stringify(candidate.ids)
        || JSON.stringify([...identity.localIds]) !== JSON.stringify([...candidate.localIds]))) return undefined;
      identity = candidate;
    }
    return identity;
  };
  const modelText = (model: Value): string => {
    const blocks = Array.isArray(model.content_blocks) ? model.content_blocks : Array.isArray(model.content_blocks_v2) ? model.content_blocks_v2 : [];
    const texts = blocks.flatMap((value: unknown): string[] => {
      const block = object(value); const content = object(block?.content_obj);
      return block?.block_type === 10000 && !block.is_deleted && typeof content?.text === 'string' ? [content.text] : [];
    });
    if (texts.length) return texts.join('\n');
    const original = Array.isArray(model.content_block) ? model.content_block : [];
    return original.flatMap((value: unknown): string[] => {
      const block = object(value); const content = object(block?.content); const text = object(content?.text_block);
      return !block?.is_deleted && typeof text?.text === 'string' ? [text.text] : [];
    }).join('\n');
  };
  const providerModel = (node: Element, identity: ListIdentity): { ok: boolean; model?: Value } => {
    const allowed = new Set(identity.ids);
    let model: Value | undefined;
    let current = fiberFor(node);
    for (let depth = 0; current && depth < 8; depth++, current = object(current.return)) {
      const props = object(current.memoizedProps); const value = object(props?.value);
      const candidate = object(value?.message) || object(props?.message);
      if (!candidate) continue;
      if (candidate.conversation_id !== identity.id || typeof candidate.message_id !== 'string' || !allowed.has(candidate.message_id)) return { ok: false };
      if (model && (model.message_id !== candidate.message_id || modelText(model) !== modelText(candidate))) return { ok: false };
      model = candidate;
    }
    return { ok: true, model };
  };
  const pageMessage = (node: Element, model: Value, previous: Message | undefined): Message | undefined => {
    const role: Message['role'] = node.getAttribute('data-testid') === 'send_message' ? 'user' : 'assistant';
    const declared = node.getAttribute('data-message-role');
    if (declared && declared !== role) return undefined;
    const rawText = modelText(model);
    const hasAttachments = role === 'user' && (!!node.querySelector('img') || (Array.isArray(model.content_blocks) && model.content_blocks.some((block: unknown): boolean => object(block)?.block_type === 10001)));
    if (previous && (previous.role !== role || !!previous.rawText && !!rawText && previous.rawText !== rawText)) return undefined;
    const text = rawText || previous?.rawText || '';
    const replyId = messageId(model.reply_id) ? model.reply_id : undefined;
    return { role, text: text.normalize('NFKC').replace(/\s+/g, ' ').trim(), rawText: text, messageId: model.message_id as string,
      ...(replyId ? { replyId } : {}), ...(hasAttachments || previous?.hasAttachments ? { hasAttachments: true } : {}),
      ...(role === 'user' && !text.trim() && hasAttachments ? { attachmentOnly: true } : {}),
      ...(role === 'assistant' && node.querySelector('[class*="block-video"],video') ? { videoReady: true } : {}) };
  };
  const captureMessages = (list: Element, identity: ListIdentity): Map<string, Message> | undefined => {
    const captured = new Map<string, Message>();
    for (const node of list.querySelectorAll('[data-testid="send_message"], [data-testid="receive_message"]')) {
      const found = providerModel(node, identity);
      if (!found.ok) return undefined;
      const model = found.model;
      if (!model || typeof model.message_id !== 'string' || identity.localIds.has(model.message_id)) continue;
      const message = pageMessage(node, model, captured.get(model.message_id));
      if (!message) return undefined;
      captured.set(model.message_id, message);
    }
    return captured;
  };
  const lists = Array.from(doc.querySelectorAll('[data-testid="message-list"]'));
  if (!lists.length) return failed('message_list_missing');
  if (lists.length !== 1) return failed('message_list_ambiguous');
  const list = lists[0]; const identity = listIdentity(list);
  if (!identity) return failed('conversation_identity_conflict');
  if (!identity.ids.length) return failed('conversation_identity_missing');
  const captured = captureMessages(list, identity);
  if (!captured) return failed('conversation_identity_conflict');
  // 尚未挂载的服务器用户消息可能造成同文歧义；不把部分可见模型升级为完整发布证明。
  const serverIds = identity.ids.filter((value: string): boolean => !identity.localIds.has(value));
  const knownIds = serverIds.filter((value: string): boolean => captured.has(value));
  if (!knownIds.length) return failed('message_models_incomplete');
  const complete = knownIds.length === serverIds.length && knownIds.some((value: string): boolean => captured.get(value)?.role === 'user');
  const snapshot: ChatPageSnapshot = { ...fallback(), messages: knownIds.flatMap((value: string): Message[] => {
    const message = captured.get(value); return message ? [message] : [];
  }), historyComplete: complete, conversationId: identity.id };
  return { snapshot, conversationId: identity.id, conversationUrl: 'https://www.doubao.com/chat/' + identity.id, messageIds: knownIds,
    ...(complete ? { source: 'published_message' as const } : { reason: 'message_models_incomplete' as const }) };
}
