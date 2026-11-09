/** 执行 BrowserPanel 的真实准备、意图和发送分支；取消期间不产生提交副作用。 */
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@doubao-studio/contracts';
import { handleControlCommand, type RendererControlDependencies } from '../../src/control/handleControlCommand';
import { classifyTaskError } from '../../src/utils/errorClassification';
import type { SendButtonTarget } from '../../src/utils/submissionControls';
import type { SubmissionDispatchSafety } from '../../src/utils/doubaoBridge';

function actualPreparationAndDispatch(bindings: Record<string, unknown>): () => Promise<void> {
  const source = ts.createSourceFile('BrowserPanel.tsx', fs.readFileSync(new URL('../../src/components/BrowserPanel.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const conditions: Record<string, string> = {
    preparePageSubmission: '!authorizationTriggeredSubmission',
    markSubmissionIntent: '!submissionMarkedAt',
    submitPromptOnce: '!authorizationTriggeredSubmission',
  };
  const branches = new Map<string, ts.IfStatement>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source);
      if (conditions[name]) {
        for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
          if (ts.isIfStatement(parent) && parent.expression.getText(source) === conditions[name]) {
            branches.set(name, parent); break;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const availabilityError = source.statements.find((node: ts.Statement): boolean => ts.isClassDeclaration(node) && node.name?.text === 'AccountAvailabilityPauseError');
  if (!availabilityError || Object.keys(conditions).some((name: string): boolean => !branches.has(name))) throw new Error('OFFLINE 正式提交准备分支缺失');
  const body = Object.keys(conditions).map((name: string): string => branches.get(name)!.getText(source)).join('\n');
  const script = ts.transpileModule(`${availabilityError.getText(source)}\n(async () => { let submissionMarkedAt; ${body}\n })`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(script, { ...bindings, AbortController, DOMException, Date, setTimeout, clearTimeout }) as () => Promise<void>;
}

function fixture(): {
  task: Task;
  controller: AbortController;
  prepare: ReturnType<typeof vi.fn>;
  markIntent: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  run: () => Promise<void>;
} {
  const now = '2026-11-09T00:00:00.000Z';
  const task: Task = { id: 'OFFLINE-preparation', projectId: 'OFFLINE-project', assignedAccountId: 'OFFLINE-account', mode: 'video', status: 'executing', prompt: 'OFFLINE 测试输入', outputs: [], result: null,
    createdAt: now, updatedAt: now, runtime: { runId: 'OFFLINE-run', attempt: 1, stage: 'injecting_prompt', message: 'OFFLINE', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { mode: 'video', prompt: 'OFFLINE 测试输入', attachments: [] } } };
  const controller = new AbortController();
  const prepare = vi.fn(async (): Promise<SendButtonTarget> => ({ ok: true }));
  const markIntent = vi.fn(async (stage: 'submitting' | 'waiting_verification'): Promise<string> => {
    if (!task.runtime) throw new Error('OFFLINE 缺少原运行');
    task.runtime.stage = stage; task.runtime.submittedAt = now; return now;
  });
  const submit = vi.fn(async (_view: unknown, guard: SubmissionDispatchSafety): Promise<boolean> => {
    expect(guard.isCurrent()).toBe(true); return true;
  });
  const scope = { controller, preparePageSubmission: prepare, markSubmissionIntent: markIntent, submitPromptOnce: submit,
    authorizationTriggeredSubmission: false, backgroundInput: undefined, webview: {}, accountId: task.assignedAccountId, taskId: task.id, expectedRunId: task.runtime?.runId,
    prompt: task.prompt, strictPrompt: true, mode: task.mode, useTaskStore: { getState: (): object => ({ tasks: [task] }) },
    automationEngine: { ownsAccountController: (): boolean => !controller.signal.aborted, confirmSubmissionOwnership: async (): Promise<boolean> => !controller.signal.aborted },
    pauseForHumanVerification: vi.fn(), checkHumanVerification: vi.fn(), updateTaskRuntime: vi.fn(),
    HumanVerificationRequiredError: class extends Error {}, SubmissionSafetyPauseError: class extends Error {} };
  return { task, controller, prepare, markIntent, submit, run: actualPreparationAndDispatch(scope) };
}

describe('发送准备期间的明确取消归属', (): void => {
  it.each(['pause', 'cancel'] as const)('%s 中止原控制器后，失败准备保留取消分类且零意图、零发送', async (action): Promise<void> => {
    const test = fixture(); let finish: (result: SendButtonTarget) => void = (): void => {};
    test.prepare.mockImplementation((): Promise<SendButtonTarget> => new Promise((resolve): void => { finish = resolve; }));
    const pending = test.run().catch((error: unknown): unknown => error);
    expect(test.prepare).toHaveBeenCalledOnce();
    const abortActive = vi.fn<RendererControlDependencies['abortActive']>((): void => test.controller.abort());
    expect(await handleControlCommand({ commandId: 'OFFLINE-command', requestId: 'OFFLINE-request', action, projectId: 'OFFLINE-project', batchId: '_unbatched', taskId: test.task.id }, {
      readTasks: async (): Promise<Task[]> => [test.task], start: async (): Promise<boolean> => false, retry: async (): Promise<boolean> => false,
      getLastError: (): null => null, updateStatus: async (): Promise<boolean> => false, abortActive,
    })).toMatchObject({ ok: true, code: action === 'pause' ? 'PAUSE_ACCEPTED' : 'CANCEL_ACCEPTED' });
    expect(abortActive).toHaveBeenCalledWith(test.task.id, action === 'pause' ? 'paused' : 'cancelled');
    finish({ ok: false });
    const error = await pending;
    expect(error).toBeInstanceOf(DOMException); expect(error).toMatchObject({ name: 'AbortError' });
    expect(classifyTaskError((error as DOMException).message).code).toBe('cancelled');
    expect(test.markIntent).not.toHaveBeenCalled(); expect(test.submit).not.toHaveBeenCalled(); expect(test.task.runtime?.submittedAt).toBeUndefined();
  });

  it('原控制器仍有效时，真实准备失败继续报告页面原因且不提交', async (): Promise<void> => {
    const test = fixture(); test.prepare.mockResolvedValue({ ok: false });
    await expect(test.run()).rejects.toMatchObject({ name: 'AccountAvailabilityPauseError', code: 'page_unrecognized' });
    expect(test.markIntent).not.toHaveBeenCalled(); expect(test.submit).not.toHaveBeenCalled(); expect(test.task.runtime?.submittedAt).toBeUndefined();
  });

  it('准备成功仍沿原分支记录意图并仅发送一次', async (): Promise<void> => {
    const test = fixture(); await expect(test.run()).resolves.toBeUndefined();
    expect(test.markIntent).toHaveBeenCalledOnce(); expect(test.submit).toHaveBeenCalledOnce(); expect(test.task.runtime?.submittedAt).toBeDefined();
  });
});
