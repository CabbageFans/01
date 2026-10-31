/** 离线执行 BrowserPanel 的真实发送分支，不打开网页、不发送平台请求。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@doubao-studio/contracts';
import type { SubmissionDispatchSafety } from '../../src/utils/doubaoBridge';
import { HumanVerificationRequiredError } from '../../src/utils/humanVerification';
import original from '../fixtures/storyboard-five-shots.json';

function actualDispatchBlock(bindings: Record<string, unknown>): () => Promise<boolean> {
  const file = ts.createSourceFile('BrowserPanel.tsx', fs.readFileSync(path.resolve('src/components/BrowserPanel.tsx'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let statement: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'submitPromptOnce') {
      let ancestor: ts.Node | undefined = node.parent;
      while (ancestor) {
        if (ts.isIfStatement(ancestor) && ancestor.expression.getText(file) === '!authorizationTriggeredSubmission') { statement = ancestor; break; }
        ancestor = ancestor.parent;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!statement) throw new Error('OFFLINE: actual single submission dispatch branch missing');
  const expression = `(async () => { let submitted = false; ${(statement as ts.Node).getText(file)}; return submitted; })`;
  const script = ts.transpileModule(expression, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(script, { ...bindings, Date, AbortController, setTimeout, clearTimeout }) as () => Promise<boolean>;
}

function fixture(): Task {
  return { id: 'OFFLINE-dispatch', mode: 'chat', prompt: original.mobileStory, assignedAccountId: 'OFFLINE-account', status: 'executing', result: null, outputs: [], createdAt: '2026-10-26', updatedAt: '2026-10-26',
    runtime: { runId: 'OFFLINE-run', attempt: 1, startedAt: '2026-10-26', stageStartedAt: '2026-10-26', lastHeartbeatAt: '2026-10-26', stage: 'submitting', message: 'OFFLINE-only', submittedAt: '2026-10-26', input: { prompt: original.mobileStory, mode: 'chat', attachments: [] } } };
}

function bindings(current: Task, submit: ReturnType<typeof vi.fn>, controller = new AbortController()): Record<string, unknown> {
  return { current, submitPromptOnce: submit, controller, authorizationTriggeredSubmission: false, backgroundInput: undefined, webview: {}, prompt: current.prompt, strictPrompt: true,
    accountId: current.assignedAccountId, taskId: current.id, mode: current.mode, expectedRunId: current.runtime?.runId, submissionMarkedAt: current.runtime?.submittedAt,
    useTaskStore: { getState: (): object => ({ tasks: [current] }) }, automationEngine: { ownsAccountController: (): boolean => true, confirmSubmissionOwnership: vi.fn(async (): Promise<boolean> => true) },
    HumanVerificationRequiredError, pauseForHumanVerification: vi.fn(async (): Promise<void> => undefined),
    checkHumanVerification: vi.fn(async (): Promise<void> => undefined), SubmissionSafetyPauseError: class extends Error {} };
}

describe('单次发送分支的超时与控制权（离线）', (): void => {
  afterEach((): void => { vi.useRealTimers(); });

  it.each(['chat', 'image', 'video'] as const)('%s 仅向原页面控件提交一次，并携带持久化意图和全文快照', async (mode): Promise<void> => {
    const current = fixture(); current.mode = mode;
    if (current.runtime) current.runtime.input.mode = mode;
    const submit = vi.fn(async (_webview: unknown, guard: SubmissionDispatchSafety): Promise<boolean> => {
      expect(guard.dispatchKey).toBeTruthy(); expect(guard.expectedPrompt).toBe(current.prompt); expect(guard.strictParagraphs).toBe(true);
      expect(guard.isCurrent()).toBe(true); expect(await guard.verifyLease()).toBe(true); return true;
    });
    expect(await actualDispatchBlock(bindings(current, submit))()).toBe(true); expect(submit).toHaveBeenCalledOnce();
  });

  it.each(['chat', 'image', 'video'] as const)('%s 的首次提交异常后不会切换方式或再次发送', async (mode): Promise<void> => {
    const current = fixture(); current.mode = mode;
    if (current.runtime) current.runtime.input.mode = mode;
    const submittedAt = current.runtime?.submittedAt;
    const submit = vi.fn(async (_webview: unknown, guard: SubmissionDispatchSafety): Promise<boolean> => { expect(guard.dispatchKey).toBeTruthy(); throw new Error('OFFLINE page dispatch uncertain'); });
    await expect(actualDispatchBlock(bindings(current, submit))()).rejects.toThrow('系统未自动重发');
    expect(submit).toHaveBeenCalledOnce(); expect(current.runtime?.submittedAt).toBe(submittedAt);
  });

  it('宿主超时会终止尚未派发的发送分支，迟到返回不重试且保留提交意图', async (): Promise<void> => {
    vi.useFakeTimers(); const current = fixture(); const submittedAt = current.runtime?.submittedAt;
    let guard: SubmissionDispatchSafety | undefined; let finish: (value: boolean) => void = (): void => {};
    const submit = vi.fn((_webview: unknown, safety: SubmissionDispatchSafety): Promise<boolean> => {
      guard = safety; return new Promise((resolve): void => { finish = resolve; });
    });
    const pending = actualDispatchBlock(bindings(current, submit))().catch((error: unknown): unknown => error);
    expect(guard?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeInstanceOf(Error); expect(guard?.signal.aborted).toBe(true);
    expect(guard?.deadlineAt).toBeLessThanOrEqual(Date.now());
    finish(false); await Promise.resolve();
    expect(submit).toHaveBeenCalledOnce(); expect(current.runtime?.submittedAt).toBe(submittedAt); expect(current.status).toBe('executing');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['chat', 'image', 'video'] as const)('%s 派发异常遇到可见验证码时保留验证原因和原提交意图', async (mode): Promise<void> => {
    const current = fixture(); current.mode = mode;
    if (current.runtime) current.runtime.input.mode = mode;
    const submittedAt = current.runtime?.submittedAt;
    const submit = vi.fn(async (): Promise<boolean> => { throw new Error('OFFLINE uncertain dispatch'); });
    const scope = bindings(current, submit);
    const verification = Object.assign(new Error('OFFLINE human verification'), { code: 'human_verification' });
    scope.checkHumanVerification = vi.fn(async (): Promise<void> => { throw verification; });
    await expect(actualDispatchBlock(scope)()).rejects.toBe(verification);
    expect(submit).toHaveBeenCalledOnce(); expect(current.runtime?.submittedAt).toBe(submittedAt);
  });

  it('最终发送门禁核对原运行、原输入、提交意图、状态、账号与控制器租约', async (): Promise<void> => {
    const current = fixture(); const scope = bindings(current, vi.fn());
    const engine = scope.automationEngine as { ownsAccountController: () => boolean; confirmSubmissionOwnership: ReturnType<typeof vi.fn> };
    const submit = vi.fn(async (_webview: unknown, guard: SubmissionDispatchSafety): Promise<boolean> => {
      expect(guard.isCurrent()).toBe(true); expect(await guard.verifyLease()).toBe(true);
      const originalRuntime = current.runtime;
      if (!originalRuntime) throw new Error('OFFLINE missing runtime');
      const originalInput = originalRuntime.input;
      current.runtime = { ...originalRuntime, runId: 'OFFLINE-later-run' }; expect(guard.isCurrent()).toBe(false); current.runtime = originalRuntime;
      current.runtime.submittedAt = 'OFFLINE-changed'; expect(guard.isCurrent()).toBe(false); current.runtime.submittedAt = '2026-10-26';
      current.runtime.input = { ...originalInput, prompt: original.mobileStory + '\n' }; expect(guard.isCurrent()).toBe(false); current.runtime.input = originalInput;
      current.runtime.input = { ...originalInput, mode: 'image' }; expect(guard.isCurrent()).toBe(false); current.runtime.input = originalInput;
      current.runtime.stage = 'generating'; expect(guard.isCurrent()).toBe(false); current.runtime.stage = 'submitting';
      expect(guard.isCurrent()).toBe(true);
      current.status = 'paused'; expect(guard.isCurrent()).toBe(false); current.status = 'executing';
      current.assignedAccountId = 'OFFLINE-other-account'; expect(guard.isCurrent()).toBe(false); current.assignedAccountId = 'OFFLINE-account';
      engine.ownsAccountController = (): boolean => false; expect(guard.isCurrent()).toBe(false);
      return false;
    });
    scope.submitPromptOnce = submit;
    expect(await actualDispatchBlock(scope)()).toBe(false); expect(submit).toHaveBeenCalledOnce();
    expect(engine.confirmSubmissionOwnership).toHaveBeenCalledWith(current.id, 'OFFLINE-account', scope.controller);
  });

  it('原任务中止会传递给等待中的单次发送，正常返回后也清理截止计时器', async (): Promise<void> => {
    vi.useFakeTimers(); const current = fixture(); const controller = new AbortController(); let guard: SubmissionDispatchSafety | undefined;
    const submit = vi.fn(async (_webview: unknown, value: SubmissionDispatchSafety): Promise<boolean> => {
      guard = value; controller.abort(); expect(value.signal.aborted).toBe(true); return false;
    });
    expect(await actualDispatchBlock(bindings(current, submit, controller))()).toBe(false);
    expect(guard?.signal.aborted).toBe(true); expect(submit).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});
