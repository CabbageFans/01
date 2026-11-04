import { describe, expect, it } from 'vitest';
import type { Task } from '@doubao-studio/contracts';
import type { CurrentCreationConversationReadback } from '../../src/utils/creationConversationIdentity';
import { mediaSubmissionReceiptFor } from '../../src/utils/mediaSubmissionReceipt';

const submittedAt = '2026-11-04T10:00:00.000Z';
const observedAt = '2026-11-04T10:00:02.000Z';
const accountId = 'TEST-account';
const conversationId = 'TEST-server-conversation';
const conversationUrl = `https://www.doubao.com/chat/${conversationId}`;
const prompt = 'TEST 完整原请求：同一人物，保持原画面结构。';
function task(mode: 'image' | 'video' = 'image'): Task {
  const videoConfig: Task['videoConfig'] = mode === 'video' ? { model: 'seedance-2.0-fast', duration: '5s', aspectRatio: '9:16' } : undefined;
  return { id: 'TEST-task', assignedAccountId: accountId, projectId: 'TEST-studio', prompt, mode, status: 'executing', executionIntent: 'armed', videoConfig,
    outputs: [], result: null, createdAt: submittedAt, updatedAt: submittedAt, runtime: { runId: 'TEST-run', attempt: 1, stage: 'submitting', message: 'TEST',
      startedAt: submittedAt, stageStartedAt: submittedAt, lastHeartbeatAt: submittedAt, submittedAt, input: { prompt, mode, attachments: [], videoConfig } } };
}
function page(mode: 'image' | 'video' = 'image'): CurrentCreationConversationReadback {
  const text = mode === 'image' ? `生成图片：${prompt}` : `生成视频：${prompt}，9:16，5s`;
  return { source: 'published_message', conversationId, conversationUrl, messageIds: ['TEST-server-user', 'TEST-server-assistant'],
    snapshot: { historyComplete: true, conversationId, editorPresent: false, editorText: '', generating: true,
      messages: [{ role: 'user', text, rawText: text, messageId: 'TEST-server-user' }, { role: 'assistant', text: 'TEST 正在处理', messageId: 'TEST-server-assistant' }] } };
}

describe('原运行媒体提交收据的发布消息证明', (): void => {
  it.each(['image', 'video'] as const)('完整当前provider、唯一全文及服务器ID生成可跨重启保存的%s收据', (mode): void => {
    const original = task(mode); const current = structuredClone(original);
    expect(mediaSubmissionReceiptFor(original, current, accountId, page(mode), observedAt)).toEqual({ schemaVersion: 1, source: 'published_message',
      runId: original.runtime!.runId, accountId, submittedAt, conversationUrl, userMessageId: 'TEST-server-user', observedAt });
    expect(current.runtime?.conversationUrl).toBeUndefined(); expect(current.runtime?.mediaSubmissionReceipt).toBeUndefined();
  });

  it.each(['dom-only', 'virtual-incomplete', 'missing-provider-source', 'no-server-id', 'foreign-server-id', 'local-id'] as const)('%s不能被相同可见文字升级为耐久媒体收据', (condition): void => {
    const original = task(); const sample = page();
    if (condition === 'dom-only') { delete sample.source; delete sample.snapshot.historyComplete; delete sample.messageIds; }
    if (condition === 'virtual-incomplete') sample.snapshot.historyComplete = false;
    if (condition === 'missing-provider-source') delete sample.source;
    if (condition === 'no-server-id') delete sample.snapshot.messages[0].messageId;
    if (condition === 'foreign-server-id') sample.messageIds = ['TEST-unrelated-server-user'];
    if (condition === 'local-id') { sample.snapshot.messages[0].messageId = 'local_TEST-pending-user'; sample.messageIds![0] = 'local_TEST-pending-user'; }
    expect(mediaSubmissionReceiptFor(original, structuredClone(original), accountId, sample, observedAt)).toBeUndefined();
  });

  it('完整provider内多个同文用户请求仍拒绝唯一原请求归属', (): void => {
    const original = task(); const sample = page();
    sample.snapshot.messages.push({ ...sample.snapshot.messages[0], messageId: 'TEST-second-server-user' }); sample.messageIds!.push('TEST-second-server-user');
    expect(mediaSubmissionReceiptFor(original, structuredClone(original), accountId, sample, observedAt)).toBeUndefined();
  });

  it.each(['root', 'foreign-origin', 'temporary-route', 'different-conversation', 'snapshot-conversation'] as const)('%s不是当前已发布请求的具体服务器会话', (condition): void => {
    const original = task(); const sample = page();
    if (condition === 'root') sample.conversationUrl = 'https://www.doubao.com/chat/';
    if (condition === 'foreign-origin') sample.conversationUrl = `https://example.test/chat/${conversationId}`;
    if (condition === 'temporary-route') sample.conversationUrl = 'https://www.doubao.com/chat/local_TEST-sending';
    if (condition === 'different-conversation') sample.conversationUrl = 'https://www.doubao.com/chat/TEST-other';
    if (condition === 'snapshot-conversation') sample.snapshot.conversationId = 'TEST-other';
    expect(mediaSubmissionReceiptFor(original, structuredClone(original), accountId, sample, observedAt)).toBeUndefined();
  });

  it.each(['account', 'run', 'submission', 'prompt', 'input', 'attachments', 'cancelled', 'done'] as const)('正式任务%s变化后不能用旧provider证据保存收据', (condition): void => {
    const original = task(); const current = structuredClone(original);
    if (condition === 'account') current.assignedAccountId = 'TEST-other-account';
    if (condition === 'run') current.runtime!.runId = 'TEST-other-run';
    if (condition === 'submission') current.runtime!.submittedAt = observedAt;
    if (condition === 'prompt') current.prompt += 'TEST 追加要求';
    if (condition === 'input') current.runtime!.input.prompt += 'TEST 其他输入';
    if (condition === 'attachments') current.attachments = ['TEST-another-asset.png'];
    if (condition === 'cancelled' || condition === 'done') current.status = condition;
    expect(mediaSubmissionReceiptFor(original, current, accountId, page(), observedAt)).toBeUndefined();
  });
});
