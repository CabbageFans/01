import type { Account, Task } from '../types';

const DOUBAO_ORIGIN = 'https://www.doubao.com';
const CONVERSATION_URL = /^https:\/\/www\.doubao\.com\/chat\/([A-Za-z0-9_-]{1,128})\/?(?:[?#].*)?$/i;

export type TaskConversationTarget =
  | { ok: true; url: string; conversationId: string; source: 'runtime' | 'receipt' | 'artifact' }
  | {
      ok: false;
      reason: 'CONVERSATION_URL_MISSING' | 'CONVERSATION_URL_AMBIGUOUS' | 'CONVERSATION_BINDING_CONFLICT';
    };

export interface ConversationNavigator {
  getURL(): string;
  loadURL(url: string): void;
  reload(): void;
}

export interface ConversationNavigationResult {
  ok: boolean;
  reason?: 'INVALID_TARGET' | 'NAVIGATION_TIMEOUT';
  url?: string;
}

/** 只接受豆包的具体会话地址；根页、端口、凭据、错误协议与错误域名全部拒绝。 */
export function normalizeDoubaoConversationUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const match = raw.trim().match(CONVERSATION_URL);
  // local_ 是平台发送中的临时路由，刷新／重开会回到首页，不能持久化为原会话。
  if (!match || /^local_/i.test(match[1])) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.origin !== DOUBAO_ORIGIN || parsed.username || parsed.password || parsed.port) return null;
    return `${DOUBAO_ORIGIN}/chat/${match[1]}`;
  } catch {
    return null;
  }
}

export function getDoubaoConversationId(raw: string | undefined): string | null {
  const normalized = normalizeDoubaoConversationUrl(raw);
  return normalized?.slice(`${DOUBAO_ORIGIN}/chat/`.length) || null;
}

export function isSameDoubaoConversation(left: string | undefined, right: string | undefined): boolean {
  const leftId = getDoubaoConversationId(left);
  return !!leftId && leftId === getDoubaoConversationId(right);
}

/** Dola 尚未完成端到端验收，不能把豆包会话定位器用于其它平台分区。 */
export function supportsDoubaoConversationLocator(platform: Account['platform'] | undefined): boolean {
  return (platform || 'doubao') === 'doubao';
}

type ConversationTask = Pick<Task, 'runtime' | 'artifacts'> & Partial<Pick<Task, 'assignedAccountId' | 'mode'>>;
type MediaReceipt = NonNullable<NonNullable<Task['runtime']>['mediaSubmissionReceipt']>;
function serverMediaMessageId(value: string | undefined): boolean {
  return typeof value === 'string' && /^[a-zA-Z0-9_:.=-]{1,256}$/.test(value) && !/^local_/i.test(value);
}
function receiptRunMatches(receipt: MediaReceipt, runtime: NonNullable<Task['runtime']>): boolean {
  return receipt.schemaVersion === 1 && receipt.source === 'published_message' && !!runtime.runId && receipt.runId === runtime.runId
    && !!runtime.submittedAt && receipt.submittedAt === runtime.submittedAt && Number.isFinite(Date.parse(receipt.submittedAt))
    && Number.isFinite(Date.parse(receipt.observedAt)) && Date.parse(receipt.observedAt) >= Date.parse(receipt.submittedAt);
}
function receiptIdentityMatches(receipt: MediaReceipt, task: ConversationTask): boolean {
  return !!receipt.accountId && (task.assignedAccountId === undefined || task.assignedAccountId === receipt.accountId)
    && (task.mode === undefined || ['image', 'video'].includes(task.mode))
    && (task.runtime?.input?.mode === undefined || ['image', 'video'].includes(task.runtime.input.mode))
    && (serverMediaMessageId(receipt.userMessageId) || serverMediaMessageId(receipt.userTurnId))
    && (receipt.userMessageId === undefined || serverMediaMessageId(receipt.userMessageId))
    && (receipt.userTurnId === undefined || serverMediaMessageId(receipt.userTurnId));
}
function receiptConversationTarget(task: ConversationTask | null | undefined, runtimeUrl: string | null): { ok: true; url: string | null } | { ok: false } {
  const runtime = task?.runtime; const receipt = runtime?.mediaSubmissionReceipt;
  if (!receipt) return { ok: true, url: null };
  const url = normalizeDoubaoConversationUrl(receipt.conversationUrl);
  if (!task || !url || !runtime || !receiptRunMatches(receipt, runtime) || !receiptIdentityMatches(receipt, task)
    || runtimeUrl && !isSameDoubaoConversation(runtimeUrl, url)) return { ok: false };
  return { ok: true, url };
}

/**
 * runtime 优先；缺定位时可消费原运行持久化媒体收据，任何已记录身份冲突均拒绝。
 * 存在 acceptance binding 时，权威 URL 与 run 必须完全同步。
 * 旧任务只能回退到当前 run 的唯一 artifact，绝不跨 run 猜测。
 */
export function resolveTaskConversationTarget(
  task: ConversationTask | null | undefined,
): TaskConversationTarget {
  const runtime = task?.runtime;
  const runtimeUrl = normalizeDoubaoConversationUrl(runtime?.conversationUrl);
  const receipt = runtime?.mediaSubmissionReceipt;
  const receiptTarget = receiptConversationTarget(task, runtimeUrl);
  if (!receiptTarget.ok) return { ok: false, reason: 'CONVERSATION_BINDING_CONFLICT' };
  const receiptUrl = receiptTarget.url;
  const locatedUrl = runtimeUrl || receiptUrl;
  const binding = runtime?.acceptanceObservation;
  if (binding) {
    const bindingUrl = normalizeDoubaoConversationUrl(binding.conversationUrl);
    if (!locatedUrl || !bindingUrl || binding.runId !== runtime?.runId || !isSameDoubaoConversation(locatedUrl, bindingUrl)
      || receipt && binding.accountId !== receipt.accountId) {
      return { ok: false, reason: 'CONVERSATION_BINDING_CONFLICT' };
    }
  }
  const currentRunId = runtime?.runId;
  const urls = currentRunId ? [...new Set((task?.artifacts || [])
    .filter((artifact) => artifact.runId === currentRunId)
    .map((artifact) => normalizeDoubaoConversationUrl(artifact.conversationUrl))
    .filter((url): url is string => !!url))] : [];
  if (receiptUrl && urls.some((url: string): boolean => !isSameDoubaoConversation(url, receiptUrl))) return { ok: false, reason: 'CONVERSATION_BINDING_CONFLICT' };
  if (runtimeUrl) {
    const conversationId = getDoubaoConversationId(runtimeUrl);
    if (conversationId) return { ok: true, url: runtimeUrl, conversationId, source: 'runtime' };
  }
  if (receiptUrl) {
    const conversationId = getDoubaoConversationId(receiptUrl);
    if (conversationId) return { ok: true, url: receiptUrl, conversationId, source: 'receipt' };
  }
  if (!currentRunId) return { ok: false, reason: 'CONVERSATION_URL_MISSING' };
  if (urls.length === 0) return { ok: false, reason: 'CONVERSATION_URL_MISSING' };
  if (urls.length > 1) return { ok: false, reason: 'CONVERSATION_URL_AMBIGUOUS' };
  const conversationId = getDoubaoConversationId(urls[0]);
  return conversationId
    ? { ok: true, url: urls[0], conversationId, source: 'artifact' }
    : { ok: false, reason: 'CONVERSATION_URL_MISSING' };
}

/** 根页及空值都属于缺少具体定位；冲突／多候选不能借当前页面兜底。 */
export function isTaskConversationMissing(task: ConversationTask | null | undefined): boolean {
  const target = resolveTaskConversationTarget(task);
  return !target.ok && target.reason === 'CONVERSATION_URL_MISSING';
}

/** 切换账号后有界等待该账号的常驻 WebView 完成注册和就绪。 */
export async function waitForConversationNavigator<T extends ConversationNavigator>(
  getNavigator: () => T | null | undefined,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
    isReady?: (navigator: T) => boolean;
  } = {},
): Promise<T | null> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 250;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  do {
    const navigator = getNavigator();
    if (navigator && (!options.isReady || options.isReady(navigator))) return navigator;
    if (now() >= deadline) break;
    await wait(Math.min(intervalMs, Math.max(0, deadline - now())));
  } while (now() <= deadline);
  return null;
}

/** 平台受理后有界等待根页被替换为具体会话地址。 */
export async function waitForConcreteConversationUrl(
  navigator: Pick<ConversationNavigator, 'getURL'>,
  options: { timeoutMs?: number; intervalMs?: number; now?: () => number; wait?: (ms: number) => Promise<void> } = {},
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 250;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  do {
    const normalized = normalizeDoubaoConversationUrl(navigator.getURL());
    if (normalized) return normalized;
    if (now() >= deadline) break;
    await wait(Math.min(intervalMs, Math.max(0, deadline - now())));
  } while (now() <= deadline);
  return null;
}

/** 只导航或刷新已验证的具体会话，并在动作后重新核对会话身份。 */
export async function openTaskConversation(
  navigator: ConversationNavigator,
  targetUrl: string,
  options: {
    refreshIfAlreadyOpen?: boolean;
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<ConversationNavigationResult> {
  const normalizedTarget = normalizeDoubaoConversationUrl(targetUrl);
  if (!normalizedTarget) return { ok: false, reason: 'INVALID_TARGET' };
  try {
    if (isSameDoubaoConversation(navigator.getURL(), normalizedTarget)) {
      if (!options.refreshIfAlreadyOpen) return { ok: true, url: normalizedTarget };
      navigator.reload();
    } else {
      navigator.loadURL(normalizedTarget);
    }
  } catch {
    return { ok: false, reason: 'NAVIGATION_TIMEOUT' };
  }

  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 250;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  await wait(Math.min(intervalMs, timeoutMs));
  while (now() <= deadline) {
    if (isSameDoubaoConversation(navigator.getURL(), normalizedTarget)) return { ok: true, url: normalizedTarget };
    if (now() >= deadline) break;
    await wait(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  return { ok: false, reason: 'NAVIGATION_TIMEOUT' };
}
