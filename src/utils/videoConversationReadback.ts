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
