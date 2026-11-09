/** 离线执行真实派发到受理分支；本地点击回执不能替代平台原消息证明。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@doubao-studio/contracts';
import type { CurrentCreationConversationReadback } from '../../src/utils/creationConversationIdentity';
import type { SubmissionDispatchSafety } from '../../src/utils/doubaoBridge';
import { inspectCreationReadback } from '../../src/utils/chatReadback';
import { HumanVerificationRequiredError } from '../../src/utils/humanVerification';
import { mediaSubmissionReceiptFor } from '../../src/utils/mediaSubmissionReceipt';
import { waitForConfirmedSubmission } from '../../src/utils/realSendStateMachine';
import { SubmittedCreationReadbackContextError, SubmittedCreationReadbackTimeoutError } from '../../src/utils/submittedCreationReadback';

class SubmissionSafetyPauseError extends Error {}

/** 选取真实 AST 的派发与受理阶段，不在测试内复制其状态流转。 */
function actualDispatchReadback(bindings: Record<string, unknown>): () => Promise<unknown> {
  const file = ts.createSourceFile('BrowserPanel.tsx', fs.readFileSync(path.resolve('src/components/BrowserPanel.tsx'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let dispatch: ts.IfStatement | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'submitPromptOnce') {
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        if (ts.isIfStatement(parent) && parent.expression.getText(file) === '!authorizationTriggeredSubmission') { dispatch = parent; break; }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!dispatch || !ts.isBlock(dispatch.parent)) throw new Error('OFFLINE actual dispatch block missing');
  const statements = dispatch.parent.statements;
  const start = statements.indexOf(dispatch);
  const end = statements.findIndex((node: ts.Statement): boolean => ts.isIfStatement(node) && node.expression.getText(file) === '!submissionConfirmed');
  if (start < 0 || end <= start) throw new Error('OFFLINE actual confirmation stage missing');
  const expression = `(async () => { let submitted = authorizationTriggeredSubmission; ${statements.slice(start, end + 1).map((node: ts.Statement): string => node.getText(file)).join('\n')}; return confirmedEvidence; })`;
  const script = ts.transpileModule(expression, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(script, { ...bindings, Date, AbortController, DOMException, setTimeout, clearTimeout }) as () => Promise<unknown>;
}

function fixture(): Task {
  const at = '2026-11-09T12:00:00.000Z';
  const prompt = 'OFFLINE 完整视频请求，保持原画面与动作。';
  const videoConfig: Task['videoConfig'] = { model: 'seedance-2.0-fast', duration: '5s', aspectRatio: '16:9' };
  return { id: 'OFFLINE-task', assignedAccountId: 'OFFLINE-account', mode: 'video', prompt, videoConfig, status: 'executing',
    createdAt: at, updatedAt: at, outputs: [], result: null,
    runtime: { runId: 'OFFLINE-run', attempt: 1, stage: 'submitting', message: 'OFFLINE', submittedAt: at,
      startedAt: at, stageStartedAt: at, lastHeartbeatAt: at, input: { prompt, mode: 'video', attachments: [], videoConfig } } };
}

function providerPage(task: Task, separateUpload: boolean = false): CurrentCreationConversationReadback {
  const conversationId = 'OFFLINE-server-conversation';
  const text = `生成视频：${task.prompt}，16:9，5s`;
  return { source: 'published_message', conversationId, conversationUrl: `https://www.doubao.com/chat/${conversationId}`,
    messageIds: [...(separateUpload ? ['OFFLINE-server-upload'] : []), 'OFFLINE-server-user', 'OFFLINE-server-assistant'], snapshot: { conversationId, historyComplete: true,
      editorPresent: true, editorText: '', generating: true, messages: [
        // 实页单张首图可能单独占一条空用户消息，没有 attachmentOnly 或共享 turnId。
        ...(separateUpload ? [{ role: 'user' as const, text: '', rawText: '', messageId: 'OFFLINE-server-upload' }] : []),
        { role: 'user', text, rawText: text, messageId: 'OFFLINE-server-user' },
        { role: 'assistant', text: 'OFFLINE 正在处理', messageId: 'OFFLINE-server-assistant' },
      ] } };
}

function scopeFor(task: Task, dispatch: () => Promise<boolean>, publishAfter: number, separateUpload: boolean = false): {
  scope: Record<string, unknown>; read: ReturnType<typeof vi.fn>; submit: ReturnType<typeof vi.fn>; controller: AbortController;
} {
  const original = structuredClone(task); const controller = new AbortController(); let samples = 0;
  const submit = vi.fn(async (_view: unknown, safety: SubmissionDispatchSafety): Promise<boolean> => {
    expect(safety.dispatchKey).toContain(original.runtime!.runId); expect(safety.isCurrent()).toBe(true);
    return dispatch();
  });
  const read = vi.fn(async (): Promise<ReturnType<typeof inspectCreationReadback>> => {
    samples++;
    if (samples <= publishAfter) return inspectCreationReadback({ editorPresent: true, editorText: task.prompt, generating: false, messages: [] }, task.prompt, 'video', 0, task.videoConfig);
    const page = providerPage(task, separateUpload);
    const receipt = mediaSubmissionReceiptFor(original, task, original.assignedAccountId!, page, new Date().toISOString());
    if (!receipt || !task.runtime) throw new Error('OFFLINE original provider receipt rejected');
    task.runtime.mediaSubmissionReceipt = receipt; task.runtime.conversationUrl = receipt.conversationUrl;
    return inspectCreationReadback(page.snapshot, original.prompt, 'video', 0, original.videoConfig, false, {
      taskId: original.id, runId: original.runtime?.runId || '', currentRunId: task.runtime.runId,
      accountId: original.assignedAccountId || '', currentAccountId: task.assignedAccountId || '',
      conversationUrl: page.conversationUrl || '', currentConversationUrl: page.conversationUrl || '',
    });
  });
  const scope: Record<string, unknown> = { controller, authorizationTriggeredSubmission: false, submitPromptOnce: submit,
    backgroundInput: undefined, webview: {}, prompt: original.prompt, strictPrompt: true, mode: original.mode, videoConfig: original.videoConfig,
    accountId: original.assignedAccountId, taskId: original.id, expectedRunId: original.runtime?.runId, submissionMarkedAt: original.runtime?.submittedAt,
    useTaskStore: { getState: (): object => ({ tasks: [task] }) }, automationEngine: { ownsAccountController: (): boolean => true,
      confirmSubmissionOwnership: async (): Promise<boolean> => true }, ownsTaskWebview: (): boolean => true,
    checkHumanVerification: vi.fn(async (): Promise<void> => undefined), pauseForHumanVerification: vi.fn(async (): Promise<void> => undefined),
    HumanVerificationRequiredError, SubmissionSafetyPauseError, waitForConfirmedSubmission, readSubmissionEvidence: read,
    pause: async (milliseconds: number): Promise<void> => { vi.setSystemTime(Date.now() + milliseconds); }, latestChatReadback: undefined,
    updateTaskRuntime: vi.fn(async (): Promise<boolean> => true),
    waitForSubmittedCreationReadback: vi.fn(async (): Promise<never> => { throw new SubmittedCreationReadbackTimeoutError('prompt_not_published'); }),
    SubmittedCreationReadbackTimeoutError, SubmittedCreationReadbackContextError,
  };
  return { scope, submit, read, controller };
}

describe('单次发送 ACK 与平台受理的边界（真实分支，离线）', (): void => {
  afterEach((): void => { vi.useRealTimers(); });

  it.each(['true', 'false', 'lost'] as const)('本地 ACK=%s 后，晚挂载的原 provider 消息仍能保存会话，且仅发送一次', async (ack): Promise<void> => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
    const task = fixture(); const before = structuredClone(task.runtime);
    const test = scopeFor(task, async (): Promise<boolean> => {
      if (ack === 'lost') throw new Error('OFFLINE click applied but result channel lost');
      return ack === 'true';
    }, 2);
    const evidence = await actualDispatchReadback(test.scope)();
    expect(evidence).toMatchObject({ promptPublished: true, inputCleared: true });
    expect(test.read).toHaveBeenCalledTimes(3); expect(test.submit).toHaveBeenCalledOnce();
    expect(task.runtime?.mediaSubmissionReceipt).toMatchObject({ runId: before?.runId, submittedAt: before?.submittedAt,
      source: 'published_message', userMessageId: 'OFFLINE-server-user' });
    expect(task.runtime?.runId).toBe(before?.runId); expect(task.runtime?.submittedAt).toBe(before?.submittedAt);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('本地无 ACK 且平台始终没有原发布消息时保持不确定，不创建收据或第二次发送', async (): Promise<void> => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
    const task = fixture(); const before = structuredClone(task.runtime);
    const test = scopeFor(task, async (): Promise<boolean> => false, Number.POSITIVE_INFINITY);
    await expect(actualDispatchReadback(test.scope)()).rejects.toBeInstanceOf(SubmissionSafetyPauseError);
    expect(test.read).toHaveBeenCalled(); expect(test.submit).toHaveBeenCalledOnce();
    expect(task.runtime?.mediaSubmissionReceipt).toBeUndefined(); expect(task.runtime?.conversationUrl).toBeUndefined();
    expect(task.runtime?.submittedAt).toBe(before?.submittedAt); expect(task.runtime?.runId).toBe(before?.runId);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('单首帧实际独立空用户消息不替代原正文身份，首次发送按唯一完整原文保存收据', async (): Promise<void> => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
    const task = fixture();
    const test = scopeFor(task, async (): Promise<boolean> => true, 0, true);
    expect(await actualDispatchReadback(test.scope)()).toMatchObject({ promptPublished: true, inputCleared: true });
    expect(task.runtime?.mediaSubmissionReceipt?.userMessageId).toBe('OFFLINE-server-user');
    expect(test.read).toHaveBeenCalledOnce(); expect(test.submit).toHaveBeenCalledOnce();
  });

  it('原控制器暂停后不继续读平台消息，不以迟到 ACK 恢复执行', async (): Promise<void> => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
    const task = fixture();
    const test: ReturnType<typeof scopeFor> = scopeFor(task, async (): Promise<boolean> => { test.controller.abort(); return false; }, 0);
    await expect(actualDispatchReadback(test.scope)()).rejects.toMatchObject({ name: 'AbortError' });
    expect(test.read).not.toHaveBeenCalled(); expect(test.submit).toHaveBeenCalledOnce();
    expect(task.runtime?.mediaSubmissionReceipt).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  });

  it('可见人机验证保留验证原因，不进入平台只读确认或再次发送', async (): Promise<void> => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));
    const task = fixture(); const test = scopeFor(task, async (): Promise<boolean> => { throw new HumanVerificationRequiredError(); }, 0);
    const verification = Object.assign(new Error('OFFLINE user verification required'), { code: 'human_verification' });
    test.scope.checkHumanVerification = vi.fn(async (): Promise<void> => { throw verification; });
    await expect(actualDispatchReadback(test.scope)()).rejects.toBe(verification);
    expect(test.read).not.toHaveBeenCalled(); expect(test.submit).toHaveBeenCalledOnce();
    expect(task.runtime?.mediaSubmissionReceipt).toBeUndefined();
  });
});
