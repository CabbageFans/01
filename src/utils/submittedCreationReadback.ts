import type { CreationReadbackResult } from './chatReadback';
import { normalizeDoubaoConversationUrl } from './taskConversationLocator';

export type SubmittedCreationReadbackPendingReason =
  | 'conversation_url_missing'
  | 'prompt_not_published'
  | 'input_not_cleared'
  | NonNullable<CreationReadbackResult['reason']>;

export interface SubmittedCreationReadbackSample {
  url: string;
  evidence: CreationReadbackResult;
}

export interface SubmittedCreationReadbackProgress {
  elapsedMs: number;
  reason: SubmittedCreationReadbackPendingReason;
}

export interface SubmittedCreationReadbackOptions {
  read: () => Promise<SubmittedCreationReadbackSample>;
  ensureCurrent: () => void;
  wait: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  onProgress?: (progress: SubmittedCreationReadbackProgress) => void | Promise<void>;
  /** 首次发送仍须证明编辑器清空；恢复只读不以用户后续草稿阻断原结果。 */
  requireInputCleared?: boolean;
}

const pendingReasonText: Record<SubmittedCreationReadbackPendingReason, string> = {
  conversation_url_missing: '尚未取得具体原会话',
  prompt_not_published: '原请求全文尚未读到',
  input_not_cleared: '原输入区尚未清空',
  context_changed: '原账号或运行身份已变化',
  user_ambiguous: '存在多个请求，无法唯一匹配原请求',
  reply_ambiguous: '存在多个回复，尚未确认原回复归属',
  reply_identity_mismatch: '回复与原请求身份不一致',
  prompt_unmatched: '原请求全文尚未匹配',
};

export class SubmittedCreationReadbackTimeoutError extends Error {
  constructor(readonly reason: SubmittedCreationReadbackPendingReason) {
    super(`原创作提交只读核对已超时：${pendingReasonText[reason]}；保留原任务，未重新发送`);
    this.name = 'SubmittedCreationReadbackTimeoutError';
  }
}

export class SubmittedCreationReadbackContextError extends Error {
  constructor(readonly reason: 'conversation_changed' | 'context_changed') {
    super(`${reason === 'conversation_changed' ? '页面已切换到其他会话' : '原账号或运行身份已变化'}；停止核对，未重新发送`);
    this.name = 'SubmittedCreationReadbackContextError';
  }
}

/** 仅等待原次发送的完整消息证据；不提供注入、上传、导航或发送能力。 */
export async function waitForSubmittedCreationReadback(
  options: SubmittedCreationReadbackOptions,
): Promise<SubmittedCreationReadbackSample> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('原创作只读核对等待时长无效');
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let reason: SubmittedCreationReadbackPendingReason = 'conversation_url_missing';
  let pinnedUrl: string | undefined;
  const assertCurrent = (): void => {
    if (options.signal?.aborted) throw new DOMException('原创作只读核对已取消', 'AbortError');
    options.ensureCurrent();
    if (now() >= deadline) throw new SubmittedCreationReadbackTimeoutError(reason);
  };
  assertCurrent();

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let abortWait: (() => void) | undefined;
  // 即使注入的 DOM 读取尚未返回，也要按宿主截止时间／用户取消结束等待。
  const stopped = new Promise<never>((_resolve: (value: never | PromiseLike<never>) => void, reject: (error?: unknown) => void): void => {
    deadlineTimer = setTimeout((): void => reject(new SubmittedCreationReadbackTimeoutError(reason)), Math.max(0, deadline - now()));
    abortWait = (): void => reject(new DOMException('原创作只读核对已取消', 'AbortError'));
    options.signal?.addEventListener('abort', abortWait, { once: true });
  });
  try {
    while (true) {
      assertCurrent();
      const sample = await Promise.race([options.read(), stopped]);
      assertCurrent();
      const url = normalizeDoubaoConversationUrl(sample.url);
      if (url && pinnedUrl && url !== pinnedUrl) throw new SubmittedCreationReadbackContextError('conversation_changed');
      if (url) pinnedUrl = url;
      if (sample.evidence.reason === 'context_changed') throw new SubmittedCreationReadbackContextError('context_changed');
      if (url && sample.evidence.promptPublished && (!options.requireInputCleared || sample.evidence.inputCleared)) {
        return { url, evidence: sample.evidence };
      }
      reason = !url ? 'conversation_url_missing'
        : !sample.evidence.promptPublished ? sample.evidence.reason ?? 'prompt_not_published'
          : 'input_not_cleared';
      if (options.onProgress) {
        await Promise.race([Promise.resolve(options.onProgress({ elapsedMs: Math.max(0, now() - startedAt), reason })), stopped]);
        assertCurrent();
      }
      const remaining = deadline - now();
      if (remaining <= 0) throw new SubmittedCreationReadbackTimeoutError(reason);
      await Promise.race([options.wait(Math.min(500, remaining)), stopped]);
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    if (abortWait) options.signal?.removeEventListener('abort', abortWait);
  }
}
