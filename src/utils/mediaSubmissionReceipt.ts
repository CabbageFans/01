import type { Task } from '../types';
import type { CurrentCreationConversationReadback } from './creationConversationIdentity';
import { inspectCreationReadback } from './chatReadback';
import { verifiedSubmissionConversationUrl } from './realSendStateMachine';
import { getDoubaoConversationId } from './taskConversationLocator';

/** 只有当前完整 provider、原请求全文及正式运行同时一致，才形成可跨重启恢复的媒体收据。 */
export function mediaSubmissionReceiptFor(
  original: Task, current: Task | undefined, accountId: string, page: CurrentCreationConversationReadback, observedAt: string,
): NonNullable<Task['runtime']>['mediaSubmissionReceipt'] {
  if (!original.runtime?.submittedAt || !['image', 'video'].includes(original.mode || '') || page.source !== 'published_message'
    || !page.conversationUrl || !page.conversationId || page.snapshot.historyComplete !== true
    || page.snapshot.conversationId !== page.conversationId || getDoubaoConversationId(page.conversationUrl) !== page.conversationId) return undefined;
  const evidence = inspectCreationReadback(page.snapshot, original.runtime.input.prompt, original.mode === 'image' ? 'image' : 'video', 0, original.videoConfig);
  if (!evidence.promptPublished || !evidence.userMessageId || !/^[A-Za-z0-9_:.=-]{1,256}$/.test(evidence.userMessageId)
    || /^local_/i.test(evidence.userMessageId) || !page.messageIds?.includes(evidence.userMessageId)) return undefined;
  const url = verifiedSubmissionConversationUrl(original, current, accountId, page.conversationUrl, page.conversationUrl, evidence);
  if (!url) return undefined;
  return { schemaVersion: 1, source: 'published_message', runId: original.runtime.runId, accountId,
    submittedAt: original.runtime.submittedAt, conversationUrl: url, userMessageId: evidence.userMessageId,
    ...(evidence.userTurnId ? { userTurnId: evidence.userTurnId } : {}), observedAt };
}
