import type { ChatPageSnapshot, CreationReadbackResult } from './chatReadback';

export interface VideoConversationCard {
  messageIndex: number;
  video: Record<string, unknown>;
  urls: string[];
}
export interface VideoConversationPage {
  snapshot: ChatPageSnapshot;
  cards: VideoConversationCard[];
}

/** 原消息归属已由readback核对；这里只识别明确未执行的回复，并给稳定观察提供无正文摘要。 */
export function readVideoGenerationAdvice(page: VideoConversationPage, readback: CreationReadbackResult): { reason: string; evidenceKey: string } | undefined {
  if (!readback.promptPublished || page.snapshot.generating || relatedVideoCards(page, readback).length) return;
  const indices = new Set([...(readback.originalAssistantMessageIndices || []), ...(readback.generationContinuationMessageIndices || [])]);
  const replies = page.snapshot.messages.flatMap((message: ChatPageSnapshot['messages'][number], index: number): ChatPageSnapshot['messages'][number][] =>
    indices.has(index) && message.role === 'assistant' ? [message] : []);
  if (!replies.length || replies.some((message: ChatPageSnapshot['messages'][number]): boolean => message.videoReady === true)) return;
  const texts = replies.map((message: ChatPageSnapshot['messages'][number]): string => (message.rawText ?? message.text).normalize('NFKC').replace(/\s+/g, ' ').trim());
  if (texts.some((text: string): boolean => /正在(?:为你)?生成|视频生成中|已(?:经)?开始生成/u.test(text))) return;
  const copyPrompt = texts.some((text: string): boolean => /^(?:[\s#*_✅☑✔✓]+)?(?:视频生成提示词|视频提示词)\s*[（(]\s*(?:可直接复制使用|可复制使用|复制即用|可直接使用)\s*[）)]/u.test(text));
  const instructions = texts.some((text: string): boolean => /^(?:你(?:现在)?可以|请)(?:直接)?在(?:视频生成|生视频)(?:面板|入口)(?:中)?(?:选择|粘贴|复制|上传)[^。！？]{0,160}(?:点击)?生成(?:即可)?(?:[。！! ]|$)/u.test(text));
  if (!copyPrompt && !instructions) return;
  // 非安全摘要只比较同一原消息的文字是否连续不变；运行/消息身份仍由上游严格回读负责。
  const source = JSON.stringify([readback.originalMessageIndex, replies.map((message: ChatPageSnapshot['messages'][number]): string | undefined => message.messageId), texts]);
  let first = 2166136261; let second = 5381;
  for (let index = 0; index < source.length; index++) { first = Math.imul(first ^ source.charCodeAt(index), 16777619); second = Math.imul(second, 33) ^ source.charCodeAt(index); }
  return { reason: copyPrompt ? '平台仅返回可复制的视频提示词，未执行视频生成' : '平台仅提供视频生成操作建议，未执行视频生成', evidenceKey: `${first >>> 0}-${second >>> 0}` };
}

/** 消息顺序只用于本次快照；整会话共用的 union ID 不构成单轮身份。 */
export function relatedVideoCards(page: VideoConversationPage, readback: CreationReadbackResult): VideoConversationCard[] {
  if (!readback.promptPublished || readback.originalMessageIndex === undefined) return [];
  const indices = new Set([readback.originalMessageIndex, ...(readback.originalAssistantMessageIndices || []), ...(readback.generationContinuationMessageIndices || [])]);
  const candidates = page.cards.filter((card: VideoConversationCard): boolean => indices.has(card.messageIndex));
  // 首个关联产物结束本次生成链；原卡虚拟卸载时也保留完整历史的边界，不能让晚卡补位。
  // videoReady 仅用于缩小归属范围，收取成功仍必须有该条原卡的真实媒体地址。
  const mountedFirst = candidates.reduce((index: number, card: VideoConversationCard): number => Math.min(index, card.messageIndex), Infinity);
  const recordedFirst = page.snapshot.messages.findIndex((message: ChatPageSnapshot['messages'][number], index: number): boolean => indices.has(index) && message.role === 'assistant' && message.videoReady === true);
  const first = Math.min(mountedFirst, recordedFirst < 0 ? Infinity : recordedFirst);
  return candidates.filter((card: VideoConversationCard): boolean => card.messageIndex === first);
}

/** 同一次 guest 回读中关联助手正文与其公开视频卡；不扫描全局缓存或其他消息的祖先组件。 */
export function readVideoConversationPage(doc: Document, readMessages: (document: Document) => ChatPageSnapshot): VideoConversationPage {
  const snapshot = readMessages(doc);
  const cards: VideoConversationCard[] = [];
  const replies = Array.from(doc.querySelectorAll('[data-testid="receive_message"]'));
  const replyIndices = snapshot.messages.flatMap((message: ChatPageSnapshot['messages'][number], index: number): number[] => message.role === 'assistant' ? [index] : []);
  if (!snapshot.historyComplete && replies.length !== replyIndices.length) return { snapshot, cards };
  const publicVideo = (value: Record<string, unknown>): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const key of ['vid', 'creation_task_id', 'messageId', 'download_url', 'no_watermark_url']) if (typeof value[key] === 'string') result[key] = value[key];
    for (const key of ['original_media_info', 'play_info']) {
      const media = value[key]; if (!media || typeof media !== 'object') continue;
      result[key] = Object.fromEntries(Object.entries(media).filter(([name, item]: [string, unknown]): boolean => ['main_url', 'main', 'url', 'download_url'].includes(name) && typeof item === 'string'));
    }
    // 实际视频卡的 videoModel 是同 vid 的播放 JSON，main_url 为 base64；封面不作为媒体。
    if (typeof value.videoModel === 'string' && value.videoModel.length < 1_000_000) {
      try {
        const model = JSON.parse(value.videoModel) as Record<string, unknown>;
        if (model.video_id === value.vid && model.video_list && typeof model.video_list === 'object') {
          const urls = Object.values(model.video_list).flatMap((item: unknown): string[] => {
            if (!item || typeof item !== 'object') return [];
            const encoded = (item as Record<string, unknown>).main_url; if (typeof encoded !== 'string') return [];
            let url = encoded; try { if (!/^https?:\/\//i.test(url)) url = atob(url); } catch { return []; }
            return /^https?:\/\//i.test(url) ? [url] : [];
          });
          if (urls.length) result.play_info = { main_url: urls[0] };
        }
      } catch { /* 未完成／异常播放 JSON 留待下次只读，不猜测地址。 */ }
    }
    return result;
  };
  const videosInProps = (initial: unknown): Record<string, unknown>[] => {
    const visited = new WeakSet<object>(); let inspected = 0;
    const read = (value: unknown, depth: number): Record<string, unknown>[] => {
      if (!value || typeof value !== 'object' || depth > 10 || inspected++ > 800 || visited.has(value)) return [];
      visited.add(value);
      const object = value as Record<string, unknown>;
      if (typeof object.vid === 'string' && object.vid.trim()) return [publicVideo(object)];
      return Object.keys(object).flatMap((key: string): Record<string, unknown>[] => ['_owner', 'stateNode', 'return', 'alternate'].includes(key) ? [] : read(object[key], depth + 1));
    };
    return read(initial, 0);
  };
  for (let replyIndex = 0; replyIndex < replies.length; replyIndex++) {
    const reply = replies[replyIndex];
    const modelMessageId = (): string | undefined => {
      const object = reply as unknown as Record<string, unknown>;
      const key = Object.getOwnPropertyNames(reply).find((name: string): boolean => name.startsWith('__reactFiber$'));
      let fiber = key ? object[key] as Record<string, unknown> | undefined : undefined;
      for (let depth = 0; fiber && depth < 8; depth++, fiber = fiber.return as Record<string, unknown> | undefined) {
        const props = fiber.memoizedProps as Record<string, unknown> | undefined; const value = props?.value as Record<string, unknown> | undefined;
        const message = (value?.message || props?.message) as Record<string, unknown> | undefined;
        if (typeof message?.message_id === 'string' && message.conversation_id === snapshot.conversationId) return message.message_id;
      }
      return undefined;
    };
    const modelId = modelMessageId();
    const blocks = [...new Set(Array.from(reply.querySelectorAll('[class*="block-video"],video')).map((node: Element): Element => node.closest('[class*="block-video"]') || node))];
    for (const block of blocks) {
      let videos: Record<string, unknown>[] = [];
      let ancestor: Element | null = block;
      for (let depth = 0; ancestor && reply.contains(ancestor) && depth < 8 && !videos.length; depth++, ancestor = ancestor.parentElement) {
        const object = ancestor as unknown as Record<string, unknown>;
        videos = Object.getOwnPropertyNames(ancestor).filter((key: string): boolean => key.startsWith('__reactProps$')).flatMap((key: string): Record<string, unknown>[] => videosInProps(object[key]));
        const fiberKey = Object.getOwnPropertyNames(ancestor).find((key: string): boolean => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? object[fiberKey] as Record<string, unknown> | undefined : undefined;
        for (let level = 0; fiber && !videos.length && level < 12; level++, fiber = fiber.return as Record<string, unknown> | undefined) {
          const stateNode = fiber.stateNode;
          if (stateNode instanceof Element && !reply.contains(stateNode)) break;
          const pending = fiber.pendingProps as Record<string, unknown> | undefined; const memoized = fiber.memoizedProps as Record<string, unknown> | undefined;
          videos = videosInProps(pending?.video || memoized?.video);
        }
      }
      const players = block.tagName === 'VIDEO' ? [block as HTMLVideoElement] : Array.from(block.querySelectorAll<HTMLVideoElement>('video'));
      const urls = [...new Set(players.flatMap((player: HTMLVideoElement): string[] => [player.currentSrc, player.src, ...Array.from(player.querySelectorAll<HTMLSourceElement>('source')).map((source: HTMLSourceElement): string => source.src)]).filter((url: string): boolean => /^https?:\/\//i.test(url)))];
      for (const video of videos.length ? videos : [{}]) {
        const cardId = typeof video.messageId === 'string' ? video.messageId : undefined;
        if (modelId && cardId && modelId !== cardId) continue;
        const id = modelId || cardId;
        const matched = id ? snapshot.messages.flatMap((message: ChatPageSnapshot['messages'][number], index: number): number[] => message.role === 'assistant' && message.messageId === id ? [index] : []) : [];
        const messageIndex = matched.length === 1 ? matched[0] : snapshot.historyComplete ? undefined : replyIndices[replyIndex];
        if (messageIndex !== undefined) cards.push({ messageIndex, video, urls });
      }
    }
  }
  return { snapshot, cards };
}
