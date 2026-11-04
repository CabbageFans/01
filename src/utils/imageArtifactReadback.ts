import { inspectCreationReadback, type ChatPageSnapshot } from './chatReadback';

export interface ImageArtifactReadbackContext {
  prompt: string;
  runId: string;
  userMessageId?: string;
  userTurnId?: string;
  /** 仅发送前确证空白基线的执行器可启用；恢复缺失历史时不得自行推定新会话。 */
  allowUnidentifiedNewConversation?: boolean;
}

/** 严格图片卡证据与普通回复预览中的图片地址分开，不能互相兜底。 */
export type ImageArtifactMessage = ChatPageSnapshot['messages'][number] & {
  imageArtifactUrls?: string[];
  imageArtifactPending?: boolean;
  imageArtifactFailure?: string;
};

export type ImageArtifactReadbackReason = 'request_missing' | 'request_ambiguous' | 'reply_missing'
  | 'reply_ambiguous' | 'image_pending' | 'generation_in_progress' | 'ready';

export interface ImageArtifactReadbackResult {
  reason: ImageArtifactReadbackReason;
  outputs: string[];
  originalMessageId?: string;
  blocker?: string;
}

export interface ImageArtifactObservationProgress {
  elapsedMs: number;
  reason: ImageArtifactReadbackReason;
  outputCount: number;
}

export interface ImageArtifactObservationOptions {
  ensureCurrent: () => void;
  onProgress?: (progress: ImageArtifactObservationProgress) => void | Promise<void>;
}

/** 仅识别原轮次助手明确给出的平台失败，不扫描用户提示词或整页文字。 */
export function imageGenerationBlocker(text: string): string | undefined {
  const value = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (/^(?:抱歉[，,。 ]*)?(?:本次|这次|当前)?(?:图片生成失败|生成图片失败|图片生成异常|图片生成出错|生成失败)(?:[，,。！!：: ]|$)/.test(value)) return '平台提示图片生成失败';
  if (/^(?:抱歉[，,。 ]*)?(?:当前|今日|本次)?(?:图片生成|生图|免费生图|免费图片生成)(?:次数|额度)(?:已用完|不足|已耗尽)/.test(value)) return '平台提示图片生成额度不足';
  if (/^(?:抱歉[，,。 ]*)?(?:该|本次|这次)?(?:图片|图片生成请求|生图请求|请求)(?:未通过|不符合|违反)(?:内容)?(?:审核|安全|平台|社区)/.test(value)) return '平台提示图片请求未通过内容审核';
  return undefined;
}

/** 原全文和原消息身份决定回复区间；后续轮次及其它父链的图片不能进入本次结果。 */
export function inspectImageArtifactReadback(snapshot: ChatPageSnapshot, context: ImageArtifactReadbackContext): ImageArtifactReadbackResult {
  const messages = snapshot.messages as ImageArtifactMessage[];
  const matches = messages.flatMap((message: ImageArtifactMessage, index: number): number[] => {
    if (message.role !== 'user' || message.attachmentOnly || context.userMessageId && message.messageId !== context.userMessageId
      || context.userTurnId && message.turnId !== context.userTurnId) return [];
    return inspectCreationReadback({ ...snapshot, messages: [message] }, context.prompt, 'image', 0).promptPublished ? [index] : [];
  });
  if (matches.length !== 1) return { reason: matches.length > 1 ? 'request_ambiguous' : 'request_missing', outputs: [] };
  const start = matches[0];
  // 后发纯图片同样是新的用户轮次；共享 union ID 不能把它续接到原请求。
  const next = messages.findIndex((message: ImageArtifactMessage, index: number): boolean => index > start && message.role === 'user');
  const end = next < 0 ? messages.length : next;
  const originalMessageId = messages[start].messageId;
  const unique = (id: string | undefined): id is string => !!id && messages.filter((message: ImageArtifactMessage): boolean => message.messageId === id).length === 1;
  if (originalMessageId && !unique(originalMessageId)) return { reason: 'request_ambiguous', outputs: [] };
  const anchors = new Set<string>(); if (unique(originalMessageId)) anchors.add(originalMessageId);
  const replies: ImageArtifactMessage[] = [];
  for (let index = start + 1; index < end; index++) {
    const message = messages[index];
    if (message.role !== 'assistant' || message.replyId && !anchors.has(message.replyId)) continue;
    if (message.messageId && !unique(message.messageId)) return { reason: 'reply_ambiguous', outputs: [], originalMessageId };
    replies.push(message);
    if (unique(message.messageId)) anchors.add(message.messageId);
  }
  if (!replies.length) return { reason: 'reply_missing', outputs: [], originalMessageId };
  if (!originalMessageId || replies.some((message: ImageArtifactMessage): boolean => !message.messageId)) {
    const users = messages.filter((message: ImageArtifactMessage): boolean => message.role === 'user' && !message.attachmentOnly);
    const assistants = messages.filter((message: ImageArtifactMessage): boolean => message.role === 'assistant');
    if (!context.allowUnidentifiedNewConversation || users.length !== 1 || assistants.length !== 1 || replies.length !== 1) return { reason: 'reply_ambiguous', outputs: [], originalMessageId };
  }
  for (const reply of replies) {
    const blocker = imageGenerationBlocker(reply.imageArtifactFailure || '') || imageGenerationBlocker(reply.rawText ?? reply.text);
    if (blocker) return { reason: 'image_pending', outputs: [], originalMessageId, blocker };
  }
  const outputs = [...new Set(replies.flatMap((message: ImageArtifactMessage): string[] => (message.imageArtifactUrls || [])
    .filter((url: string): boolean => /^https:\/\//i.test(url))))].sort();
  if (replies.some((message: ImageArtifactMessage): boolean => message.imageArtifactPending === true) || !outputs.length) return { reason: 'image_pending', outputs, originalMessageId };
  // 后续自由聊天的停止按钮不能把早已形成的原图片再次标成生成中。
  if (next < 0 && snapshot.generating) return { reason: 'generation_in_progress', outputs, originalMessageId };
  return { reason: 'ready', outputs, originalMessageId };
}

export class ImageArtifactObservationError extends Error {
  constructor(readonly reason: ImageArtifactReadbackReason | 'context_changed' | 'platform_blocked', message: string) {
    super(message); this.name = 'ImageArtifactObservationError';
  }
}

export interface WaitForImageArtifactOptions extends ImageArtifactObservationOptions {
  context: ImageArtifactReadbackContext;
  read: () => Promise<ChatPageSnapshot>;
  wait: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}

/** 有界只读观察，所有异步边界及最终交付前均核对原运行；迟到页面读取不能恢复控制权。 */
export async function waitForImageArtifactReadback(options: WaitForImageArtifactOptions): Promise<string[]> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  if (!options.context.prompt.trim() || !options.context.runId || typeof options.ensureCurrent !== 'function') throw new ImageArtifactObservationError('context_changed', '缺少原图片请求或运行身份，未绑定产物');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('原图片观察等待时长无效');
  const startedAt = now(); const deadline = startedAt + timeoutMs;
  let reason: ImageArtifactReadbackReason = 'request_missing';
  const timeoutError = (): ImageArtifactObservationError => new ImageArtifactObservationError(reason,
    reason === 'request_missing' ? '原图片请求全文尚未读到，请保留原会话继续核对，未重复发送'
      : reason === 'request_ambiguous' || reason === 'reply_ambiguous' ? '原图片请求或回复无法唯一匹配，请核对原会话，未重复发送'
        : '原图片任务仍未取得稳定真实产物，请保留原会话继续核对，未重复发送');
  const assertCurrent = (): void => {
    if (options.signal?.aborted) throw new DOMException('用户已暂停图片观察', 'AbortError');
    options.ensureCurrent();
    if (now() >= deadline) throw timeoutError();
  };
  assertCurrent();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined; let abortWait: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve: (value: never | PromiseLike<never>) => void, reject: (error?: unknown) => void): void => {
    deadlineTimer = setTimeout((): void => reject(timeoutError()), Math.max(0, deadline - now()));
    abortWait = (): void => reject(new DOMException('用户已暂停图片观察', 'AbortError'));
    options.signal?.addEventListener('abort', abortWait, { once: true });
  });
  let previous = ''; let stable = 0; let originalMessageId = options.context.userMessageId;
  try {
    while (true) {
      assertCurrent();
      const snapshot = await Promise.race([options.read(), stopped]);
      assertCurrent();
      const result = inspectImageArtifactReadback(snapshot, options.context);
      if (originalMessageId && result.originalMessageId && result.originalMessageId !== originalMessageId) throw new ImageArtifactObservationError('context_changed', '原图片用户消息身份已变化，未绑定其它产物');
      if (result.originalMessageId) originalMessageId = result.originalMessageId;
      if (result.blocker) throw new ImageArtifactObservationError('platform_blocked', `${result.blocker}；已保留原任务，未重新发送`);
      reason = result.reason;
      const key = JSON.stringify(result.outputs);
      stable = result.reason === 'ready' && key === previous ? stable + 1 : 0;
      if (stable >= 3) { assertCurrent(); return result.outputs; }
      previous = result.reason === 'ready' ? key : '';
      if (options.onProgress) {
        await Promise.race([Promise.resolve(options.onProgress({ elapsedMs: Math.max(0, now() - startedAt), reason, outputCount: result.outputs.length })), stopped]);
        assertCurrent();
      }
      await Promise.race([options.wait(Math.min(500, Math.max(0, deadline - now()))), stopped]);
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (abortWait) options.signal?.removeEventListener('abort', abortWait);
  }
}
