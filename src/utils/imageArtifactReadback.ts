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
  | 'reply_ambiguous' | 'image_pending' | 'generation_not_started' | 'generation_in_progress' | 'ready';

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
  /** 仅携带图卡结构计数与字段类型，排查可见图卡尚未形成原图证据的原因。 */
  imageEvidence: { messageIndex: number; diagnostics: NonNullable<ChatPageSnapshot['messages'][number]['imageArtifactDiagnostics']> }[];
  messageChain: { index: number; role: 'user' | 'assistant'; textLength: number; imageGenerationCommand: boolean; imageGenerationAffirmation?: boolean; imageGenerationOffer?: boolean; attachmentOnly: boolean; hasAttachments: boolean; replyTargetIndices: number[] }[];
}

export interface ImageArtifactObservationOptions {
  ensureCurrent: () => void;
  onProgress?: (progress: ImageArtifactObservationProgress) => void | Promise<void>;
  /** 恢复时完整历史连续复读仍歧义则快速结束；首次生成默认保留原有等待。 */
  stopOnStableAmbiguity?: boolean;
}

/** 指向用户下一步操作的完整建议，不把任意“生图面板”提及视作失败。 */
function isImageOperationAdvice(text: string): boolean {
  const value = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return /^(?:这是(?:一个)?图生图修改任务[，,。 ]*)?你(?:现在)?可以(?:直接)?在生图面板(?:中)?选择[^。！？]{0,140}(?:参考图编辑|图生图)[^。！？]{0,140}生成(?:即可)?(?:[。！! ]|$)/u.test(value);
}

/** 仅识别原轮次助手明确给出的平台失败，不扫描用户提示词或整页文字。 */
export function imageGenerationBlocker(text: string): string | undefined {
  const value = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (/^(?:抱歉[，,。 ]*)?(?:本次|这次|当前)?(?:图片生成失败|生成图片失败|图片生成异常|图片生成出错|生成失败)(?:[，,。！!：: ]|$)/.test(value)) return '平台提示图片生成失败';
  if (/^(?:抱歉[，,。 ]*)?(?:当前|今日|本次)?(?:图片生成|生图|免费生图|免费图片生成)(?:次数|额度)(?:已用完|不足|已耗尽)/.test(value)) return '平台提示图片生成额度不足';
  if (/^(?:抱歉[，,。 ]*)?(?:该|本次|这次)?(?:图片|图片生成请求|生图请求|请求)(?:未通过|不符合|违反)(?:内容)?(?:审核|安全|平台|社区)/.test(value)) return '平台提示图片请求未通过内容审核';
  if (isImageOperationAdvice(value)) return '平台仅提供生图操作建议，未执行图片生成';
  return undefined;
}

function originalImageRequestIndices(snapshot: ChatPageSnapshot, context: ImageArtifactReadbackContext): number[] {
  const matches = snapshot.messages.flatMap((message: ImageArtifactMessage, index: number): number[] => {
    if (message.role !== 'user' || message.attachmentOnly || context.userMessageId && message.messageId !== context.userMessageId) return [];
    return inspectCreationReadback({ ...snapshot, messages: [message] }, context.prompt, 'image', 0).promptPublished ? [index] : [];
  });
  // union 的 turn 标记可能共享、变化或卸载；服务器消息ID与全文一致时不以它否定原身份。
  // 没有服务器ID时仍先要求全文唯一，不能用 turn 从同文重复请求中挑选一条。
  if (matches.length !== 1 || context.userMessageId || !context.userTurnId) return matches;
  return snapshot.messages[matches[0]].turnId === context.userTurnId ? matches : [];
}

/** 仅由有限执行词组成的完整短句；不接受重做、修改、数量、参数或追加创作要求。 */
const IMAGE_GENERATION_COMMAND = /^(?:请)?(?:帮我|给我|直接|开始|现在|马上|立即)?(?:(?:生成|绘制)(?:图片|图像|图)?|生图|画图|出图)(?:一下|吧)?$/u;
const IMAGE_GENERATION_AFFIRMATION = /^(?:要|要的|是|是的|好|好的|可以|可以的|确认|确定|需要|行)[。!]?$/u;
const IMAGE_GENERATION_OFFER_ACTION = '(?:调用(?:生图|图片生成)(?:工具)?)?(?:(?:生成|绘制)(?:这张|这幅|这组|这些|对应的?|相关的?)?(?:图片|图像|效果图|参考图|图)|生图|画图|出图)';
const IMAGE_GENERATION_OFFER_SUBJECT = '(?:我|让我)?(?:现在|直接|开始|立即)?(?:为你|帮你|给你)?(?:现在|直接|开始|立即)?';
const IMAGE_GENERATION_OFFER_QUESTION = new RegExp('^(?:你)?(?:现在)?(?:要不要|需不需要|是否(?:要|需要|可以)?)' + IMAGE_GENERATION_OFFER_SUBJECT + IMAGE_GENERATION_OFFER_ACTION + '(?:吗)?$', 'u');
const IMAGE_GENERATION_OFFER_PERMISSION = new RegExp('^(?:你)?(?:现在)?(?:是)?(?:要|需要|想(?:要)?|可以|能否)' + IMAGE_GENERATION_OFFER_SUBJECT + IMAGE_GENERATION_OFFER_ACTION + '(?:吗|么)$', 'u');

function normalizedImageMessageText(message: ImageArtifactMessage): string {
  return (message.rawText ?? message.text).normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function isImageGenerationCommand(message: ImageArtifactMessage): boolean {
  return message.role === 'user' && IMAGE_GENERATION_COMMAND.test(normalizedImageMessageText(message));
}

function isImageGenerationAffirmation(message: ImageArtifactMessage): boolean {
  return message.role === 'user' && IMAGE_GENERATION_AFFIRMATION.test(normalizedImageMessageText(message));
}

/** 只识别原助手末尾明确询问是否生成图片，不把泛泛确认、引用句或修改建议当成生图询问。 */
function isImageGenerationOffer(message: ImageArtifactMessage): boolean {
  if (message.role !== 'assistant') return false;
  const sentences = (message.rawText ?? message.text).normalize('NFKC').split(/[\n。!;?]/u)
    .map((sentence: string): string => sentence.replace(/^[*_\s]+|[*_\s]+$/gu, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const question = sentences.at(-1) || '';
  return IMAGE_GENERATION_OFFER_QUESTION.test(question) || IMAGE_GENERATION_OFFER_PERMISSION.test(question);
}

function confirmsOriginalImageGeneration(message: ImageArtifactMessage, originalReplies: ImageArtifactMessage[]): boolean {
  if (!isImageGenerationAffirmation(message)) return false;
  const lastReply = [...originalReplies].reverse().find((reply: ImageArtifactMessage): boolean => !!normalizedImageMessageText(reply));
  return !!lastReply && isImageGenerationOffer(lastReply);
}

function hasImageGenerationEvidence(message: ImageArtifactMessage): boolean {
  return message.imageArtifactUrls !== undefined || message.imageArtifactPending !== undefined || message.imageArtifactFailure !== undefined
    || !!message.imageUrls?.length || !!message.imageArtifactDiagnostics?.cardCount || !!message.imageArtifactDiagnostics?.creationCount
    || !isImageOperationAdvice(message.rawText ?? message.text) && !!imageGenerationBlocker(message.rawText ?? message.text);
}

interface ImageGenerationContinuation {
  replies: ImageArtifactMessage[];
  nextUserIndex: number;
  ambiguity?: 'request_ambiguous' | 'reply_ambiguous';
}

/** 只读接回已存在的首个执行原要求的短指令；不授权发送或跨其它用户要求寻找图片。 */
function readImageGenerationContinuation(snapshot: ChatPageSnapshot, originalUserId: string | undefined,
  originalReplies: ImageArtifactMessage[], firstFollowup: number): ImageGenerationContinuation | undefined {
  const messages = snapshot.messages;
  const uniqueServerId = (id: string | undefined): id is string => !!id && /^[A-Za-z0-9_:.=-]{1,256}$/.test(id)
    && !/^local_/i.test(id) && messages.filter((message: ImageArtifactMessage): boolean => message.messageId === id).length === 1;
  if (snapshot.historyComplete !== true || firstFollowup < 0 || !uniqueServerId(originalUserId)
    || originalReplies.some(hasImageGenerationEvidence) || !originalReplies.every((message: ImageArtifactMessage): boolean => uniqueServerId(message.messageId))) return;
  const command = messages[firstFollowup];
  if ((!isImageGenerationCommand(command) && !confirmsOriginalImageGeneration(command, originalReplies))
    || command.attachmentOnly || command.hasAttachments || command.imageUrls?.length || command.imageArtifactUrls?.length) return;
  const nextUserIndex = messages.findIndex((message: ImageArtifactMessage, index: number): boolean => index > firstFollowup && message.role === 'user');
  if (!uniqueServerId(command.messageId)) return { replies: [], nextUserIndex, ambiguity: 'request_ambiguous' };
  const end = nextUserIndex < 0 ? messages.length : nextUserIndex;
  const anchors = new Set([command.messageId]); const replies: ImageArtifactMessage[] = [];
  for (let index = firstFollowup + 1; index < end; index++) {
    const message = messages[index];
    // 续接不能仅凭相邻位置归属，必须有明确父链；未知父链的卡片不进入候选。
    if (message.role !== 'assistant' || !message.replyId || !anchors.has(message.replyId)) continue;
    if (!uniqueServerId(message.messageId)) return { replies: [], nextUserIndex, ambiguity: 'reply_ambiguous' };
    replies.push(message); anchors.add(message.messageId);
  }
  return replies.length ? { replies, nextUserIndex } : undefined;
}

function inspectImageArtifactReplies(replies: ImageArtifactMessage[], originalMessageId: string | undefined, generating: boolean): ImageArtifactReadbackResult {
  const outputs = [...new Set(replies.flatMap((message: ImageArtifactMessage): string[] => (message.imageArtifactUrls || [])
    .filter((url: string): boolean => /^https:\/\//i.test(url))))].sort();
  for (const reply of replies) {
    const blocker = imageGenerationBlocker(reply.imageArtifactFailure || '') || imageGenerationBlocker(reply.rawText ?? reply.text);
    if (blocker && isImageOperationAdvice(reply.imageArtifactFailure || reply.rawText || reply.text)) {
      if (!generating && !outputs.length && !replies.some((message: ImageArtifactMessage): boolean => message.imageArtifactPending === true)) {
        return { reason: 'generation_not_started', outputs, originalMessageId, blocker };
      }
      continue;
    }
    if (blocker) return { reason: 'image_pending', outputs: [], originalMessageId, blocker };
  }
  if (replies.some((message: ImageArtifactMessage): boolean => message.imageArtifactPending === true) || !outputs.length) return { reason: 'image_pending', outputs, originalMessageId };
  if (generating) return { reason: 'generation_in_progress', outputs, originalMessageId };
  return { reason: 'ready', outputs, originalMessageId };
}

/** 原全文和原消息身份决定回复区间；后续轮次及其它父链的图片不能进入本次结果。 */
export function inspectImageArtifactReadback(snapshot: ChatPageSnapshot, context: ImageArtifactReadbackContext): ImageArtifactReadbackResult {
  const messages = snapshot.messages as ImageArtifactMessage[];
  const matches = originalImageRequestIndices(snapshot, context);
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
  const continuation = readImageGenerationContinuation(snapshot, originalMessageId, replies, next);
  if (continuation?.ambiguity) return { reason: continuation.ambiguity, outputs: [], originalMessageId };
  // 后续自由聊天的停止按钮不能把早已形成的原图片再次标成生成中。
  return inspectImageArtifactReplies(continuation?.replies || replies, originalMessageId, (continuation?.nextUserIndex ?? next) < 0 && snapshot.generating);
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
  let previous = ''; let stable = 0; let originalMessageId = options.context.userMessageId; let previousAmbiguity = ''; let previousAdvice = '';
  try {
    while (true) {
      assertCurrent();
      const snapshot = await Promise.race([options.read(), stopped]);
      assertCurrent();
      const result = inspectImageArtifactReadback(snapshot, options.context);
      if (originalMessageId && result.originalMessageId && result.originalMessageId !== originalMessageId) throw new ImageArtifactObservationError('context_changed', '原图片用户消息身份已变化，未绑定其它产物');
      if (result.originalMessageId) originalMessageId = result.originalMessageId;
      if (result.reason === 'generation_not_started' && result.blocker) {
        // 完整原回复连续两次稳定、且无生成卡才结束；流式文字或生图尚在进行时不抢先判定。
        const advice = JSON.stringify([result.originalMessageId, snapshot.messages.map((message: ImageArtifactMessage): unknown[] => [message.messageId, message.rawText ?? message.text])]);
        if (advice === previousAdvice) throw new ImageArtifactObservationError('generation_not_started', `${result.blocker}；已保留原任务，未重新发送`);
        previousAdvice = advice;
      } else {
        previousAdvice = '';
        if (result.blocker) throw new ImageArtifactObservationError('platform_blocked', `${result.blocker}；已保留原任务，未重新发送`);
      }
      reason = result.reason;
      // 恢复中完整历史的稳定结构性歧义不能靠15分钟轮询解决；缺消息或待生成仍继续观察。
      if (options.stopOnStableAmbiguity && snapshot.historyComplete === true
        && (reason === 'request_ambiguous' || reason === 'reply_ambiguous')) {
        const ambiguity = JSON.stringify([reason, snapshot.messages.map((message: ImageArtifactMessage): unknown[] =>
          [message.role, message.messageId, message.replyId, message.turnId, message.attachmentOnly])]);
        if (ambiguity === previousAmbiguity) throw new ImageArtifactObservationError(reason,
          '原会话已完整读取，但原图片请求或回复无法唯一匹配；请核对原会话，保留原任务，未重复发送');
        previousAmbiguity = ambiguity;
      } else previousAmbiguity = '';
      const key = JSON.stringify(result.outputs);
      stable = result.reason === 'ready' && key === previous ? stable + 1 : 0;
      if (stable >= 3) { assertCurrent(); return result.outputs; }
      previous = result.reason === 'ready' ? key : '';
      if (options.onProgress) {
        const imageEvidence = snapshot.messages.flatMap((message: ChatPageSnapshot['messages'][number], messageIndex: number): ImageArtifactObservationProgress['imageEvidence'] =>
          message.imageArtifactDiagnostics ? [{ messageIndex, diagnostics: message.imageArtifactDiagnostics }] : []);
        const messageChain = snapshot.messages.map((message: ChatPageSnapshot['messages'][number], index: number): ImageArtifactObservationProgress['messageChain'][number] => ({
          index, role: message.role, textLength: message.text.length, imageGenerationCommand: isImageGenerationCommand(message),
          imageGenerationAffirmation: isImageGenerationAffirmation(message), imageGenerationOffer: isImageGenerationOffer(message), attachmentOnly: !!message.attachmentOnly, hasAttachments: !!message.hasAttachments,
          replyTargetIndices: message.replyId ? snapshot.messages.flatMap((target: ChatPageSnapshot['messages'][number], targetIndex: number): number[] => target.messageId === message.replyId ? [targetIndex] : []) : [],
        }));
        await Promise.race([Promise.resolve(options.onProgress({ elapsedMs: Math.max(0, now() - startedAt), reason, outputCount: result.outputs.length, imageEvidence, messageChain })), stopped]);
        assertCurrent();
      }
      await Promise.race([options.wait(Math.min(500, Math.max(0, deadline - now()))), stopped]);
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (abortWait) options.signal?.removeEventListener('abort', abortWait);
  }
}
