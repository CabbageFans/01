import type { Task } from '../types';
import type { CurrentCreationConversationReadback } from './creationConversationIdentity';
import { inspectCreationReadback, inspectSubmittedImageReadback } from './chatReadback';
import { verifiedSubmissionConversationUrl } from './realSendStateMachine';
import { getDoubaoConversationId } from './taskConversationLocator';

type MediaSubmissionReceipt = NonNullable<NonNullable<Task['runtime']>['mediaSubmissionReceipt']>;

/** 恢复只能沿既有原消息身份，不能用后来的同文请求替换耐久收据。 */
function previousReceiptMatches(previous: MediaSubmissionReceipt, original: Task, accountId: string, conversationUrl: string): boolean {
  const originalMessageId = original.runtime?.mediaSubmissionReceipt?.userMessageId;
  return previous.runId === original.runtime?.runId && previous.accountId === accountId
    && previous.submittedAt === original.runtime?.submittedAt && previous.conversationUrl === conversationUrl
    && (!originalMessageId || originalMessageId === previous.userMessageId);
}

function inspectImageReceiptPage(original: Task, current: Task | undefined, accountId: string, page: CurrentCreationConversationReadback,
  previous?: MediaSubmissionReceipt): ReturnType<typeof inspectSubmittedImageReadback> {
  return inspectSubmittedImageReadback(page.snapshot, original.runtime?.input.prompt || '', {
    taskId: original.id, runId: original.runtime?.runId || '', currentRunId: current?.runtime?.runId || '',
    accountId: original.assignedAccountId || '', currentAccountId: accountId,
    conversationUrl: previous?.conversationUrl || page.conversationUrl || '', currentConversationUrl: page.conversationUrl || '',
    ...(previous?.userMessageId ? { userMessageId: previous.userMessageId } : {}),
  });
}

/** 只有当前完整 provider、原请求全文及正式运行同时一致，才形成可跨重启恢复的媒体收据。 */
export function mediaSubmissionReceiptFor(
  original: Task, current: Task | undefined, accountId: string, page: CurrentCreationConversationReadback, observedAt: string,
): NonNullable<Task['runtime']>['mediaSubmissionReceipt'] {
  if (!original.runtime?.submittedAt || !['image', 'video'].includes(original.mode || '') || page.source !== 'published_message'
    || !page.conversationUrl || !page.conversationId || page.snapshot.historyComplete !== true
    || page.snapshot.conversationId !== page.conversationId || getDoubaoConversationId(page.conversationUrl) !== page.conversationId) return undefined;
  const previous = current?.runtime?.mediaSubmissionReceipt || original.runtime.mediaSubmissionReceipt;
  if (previous && !previousReceiptMatches(previous, original, accountId, page.conversationUrl)) return undefined;
  const evidence = original.mode === 'image' ? inspectImageReceiptPage(original, current, accountId, page, previous)
    : inspectCreationReadback(page.snapshot, original.runtime.input.prompt, 'video', 0, original.videoConfig);
  if (!evidence.promptPublished || !evidence.userMessageId || !/^[A-Za-z0-9_:.=-]{1,256}$/.test(evidence.userMessageId)
    || /^local_/i.test(evidence.userMessageId) || !page.messageIds?.includes(evidence.userMessageId)) return undefined;
  const url = verifiedSubmissionConversationUrl(original, current, accountId, page.conversationUrl, page.conversationUrl, evidence);
  if (!url) return undefined;
  return { schemaVersion: 1, source: 'published_message', runId: original.runtime.runId, accountId,
    submittedAt: original.runtime.submittedAt, conversationUrl: url, userMessageId: evidence.userMessageId,
    ...(evidence.userTurnId ? { userTurnId: evidence.userTurnId } : {}), observedAt };
}
