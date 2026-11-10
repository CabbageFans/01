import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/types';
import { inspectCreationReadback, type ChatPageSnapshot, type ChatReadbackContext } from '../../src/utils/chatReadback';
import { verifiedSubmissionConversationUrl } from '../../src/utils/realSendStateMachine';

const now = '2026-11-01T04:00:00.000Z';
const url = 'https://www.doubao.com/chat/TEST-original';
function task(): Task {
  const prompt = 'TEST 原视频完整提示词，原素材图片1和图片2，保持原镜头动作与原台词。';
  const videoConfig: NonNullable<Task['videoConfig']> = { model: 'seedance-2.0', aspectRatio: '9:16', duration: '5s' };
  return { id: 'TEST-task', assignedAccountId: 'TEST-account', mode: 'video', status: 'waiting_verification', executionIntent: 'armed',
    prompt, promptReadback: 'exact', attachments: ['TEST-first.png', 'TEST-last.png'], videoConfig,
    outputs: [], result: null, createdAt: now, updatedAt: now,
    runtime: { runId: 'TEST-run', attempt: 1, stage: 'waiting_verification', message: 'TEST人工验证', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
      input: { prompt, mode: 'video', attachments: ['TEST-first.png', 'TEST-last.png'], videoConfig } } };
}
function snapshot(original: Task, patch: Partial<ChatPageSnapshot> = {}): ChatPageSnapshot {
  return { messages: [{ role: 'user', text: `生成视频：${original.prompt}，9:16，5s`, messageId: 'TEST-original-user' },
    { role: 'assistant', text: 'TEST视频生成中' }], editorPresent: true, editorText: '', generating: true, ...patch };
}
function context(original: Task): ChatReadbackContext {
  return { taskId: original.id, runId: 'TEST-run', currentRunId: 'TEST-run', accountId: 'TEST-account', currentAccountId: 'TEST-account', conversationUrl: url, currentConversationUrl: url };
}

describe('验证码前后保存原已提交会话定位', (): void => {
  it('缺会话的原视频须完整原消息、原参数与原运行输入同时匹配，才恢复具体定位', (): void => {
    const original = task(); const current = structuredClone(original); current.status = 'manual_submission_observing';
    const evidence = inspectCreationReadback(snapshot(original), original.prompt, 'video', 0, original.videoConfig, false, context(original));
    expect(evidence.promptPublished).toBe(true);
    expect(verifiedSubmissionConversationUrl(original, current, 'TEST-account', `${url}?from=send`, url, evidence)).toBe(url);
    expect(current.runtime?.conversationUrl).toBeUndefined(); expect(current.runtime?.submittedAt).toBe(now);
  });

  it.each(['run', 'submittedAt', 'account', 'prompt', 'mode', 'attachments', 'audio', 'parameters', 'cancelled', 'done'] as const)('原%s改变时拒绝把当前URL绑定给原任务', (change: 'run' | 'submittedAt' | 'account' | 'prompt' | 'mode' | 'attachments' | 'audio' | 'parameters' | 'cancelled' | 'done'): void => {
    const original = task(); const current = structuredClone(original);
    if (change === 'run') current.runtime!.runId = 'TEST-new-run';
    if (change === 'submittedAt') current.runtime!.submittedAt = '2026-11-01T04:01:00.000Z';
    if (change === 'account') current.assignedAccountId = 'TEST-other-account';
    if (change === 'prompt') current.prompt += 'TEST改稿';
    if (change === 'mode') current.mode = 'image';
    if (change === 'attachments') current.attachments = ['TEST-replaced.png'];
    if (change === 'audio') current.audioAttachment = 'TEST-audio.wav';
    if (change === 'parameters') current.videoConfig!.duration = '6s';
    if (change === 'cancelled' || change === 'done') current.status = change;
    expect(verifiedSubmissionConversationUrl(original, current, 'TEST-account', url, url, { promptPublished: true })).toBeUndefined();
  });

  it.each(['https://www.doubao.com/chat/', 'https://www.doubao.com/chat/local_TEST', 'https://other.example/chat/TEST'])('根页、临时页或跨域地址不能持久化：%s', (candidate: string): void => {
    const original = task(); expect(verifiedSubmissionConversationUrl(original, original, 'TEST-account', candidate, candidate, { promptPublished: true })).toBeUndefined();
  });

  it('页面只有草稿、生成文字、错误比例/时长或多个同文原消息时不认领', (): void => {
    const original = task();
    const pages = [snapshot(original, { messages: [], editorText: original.prompt }), snapshot(original, { messages: [{ role: 'assistant', text: 'TEST 视频生成中' }] }),
      snapshot(original, { messages: [{ role: 'user', text: `生成视频：${original.prompt}，16:9，5s` }] }),
      snapshot(original, { messages: [{ role: 'user', text: `生成视频：${original.prompt}，9:16，6s` }] }),
      snapshot(original, { messages: [snapshot(original).messages[0], snapshot(original).messages[0]] })];
    for (const page of pages) {
      const evidence = inspectCreationReadback(page, original.prompt, 'video', 0, original.videoConfig, false, context(original));
      expect(verifiedSubmissionConversationUrl(original, original, 'TEST-account', url, url, evidence)).toBeUndefined();
    }
  });

  it('读取中导航或既有定位冲突时不覆盖已保存的原会话', (): void => {
    const original = task();
    expect(verifiedSubmissionConversationUrl(original, original, 'TEST-account', url, `${url}-other`, { promptPublished: true })).toBeUndefined();
    original.runtime!.conversationUrl = `${url}-other`;
    expect(verifiedSubmissionConversationUrl(original, original, 'TEST-account', url, url, { promptPublished: true })).toBeUndefined();
  });

  it('发送受理和验证码检查前保存已匹配定位；验证后恢复始终只读且核对fresh原运行', (): void => {
    const source = readFileSync(resolve(__dirname, '../../src/components/BrowserPanel.tsx'), 'utf8') + '\n' + readFileSync(resolve(__dirname, '../../src/automation/TaskRecoveryCoordinator.ts'), 'utf8') + '\n' + readFileSync(resolve(__dirname, '../../src/automation/TaskExecutionCoordinator.ts'), 'utf8');
    const preserveAt = source.indexOf('await preserveSubmittedConversation?.().catch');
    expect(preserveAt).toBeGreaterThan(0);
    expect(source.indexOf('await assertNoHumanVerification(accountId, webview);', preserveAt)).toBeGreaterThan(preserveAt);
    expect(source).toContain('await preserveSubmittedConversation?.(evidence, observedUrl, page)');
    const recoveryStart = source.indexOf('const originalContextIsCurrent');
    const recovery = source.slice(recoveryStart, source.indexOf('const syncStartedAt', recoveryStart));
    expect(recovery).toContain('getCreationReadbackSnapshot'); expect(recovery).toContain('verifiedSubmissionConversationUrl');
    expect(recovery).not.toMatch(/submitPrompt|injectPrompt|startNewConversation|\.click\(/);
    expect(source).toContain('resumeAfterAccountVerification(accountId, availability.checkedAt)');
    expect(source).toContain('ready.checkedAt !== detail.verificationCheckedAt');
  });
});
