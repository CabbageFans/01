import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@doubao-studio/contracts';
import { submitPromptOnce } from '../../src/utils/doubaoBridge';
import type { SendButtonTarget, SubmissionDispatchSafety, WebviewHandle } from '../../src/utils/doubaoBridge';
import { handleControlCommand } from '../../src/control/handleControlCommand';

/** 正式本机控制命令与正式页内准备/派发组合，不再截取React分支执行。 */
afterEach((): void => { vi.useRealTimers(); });
describe('发送准备期间的明确取消归属', (): void => {
  it.each(['pause', 'cancel'] as const)('%s 撤回原控制器后不激活最终控件，结果为确定未派发', async (action): Promise<void> => {
    const controller = new AbortController(); let finish: (value: SendButtonTarget) => void = (): void => undefined;
    const page = vi.fn((code: string): Promise<SendButtonTarget> => { expect(code).not.toContain('"dispatchKey":'); return new Promise((resolve): void => { finish = resolve; }); });
    const view: WebviewHandle = { executeJavaScript: page, getURL: (): string => '', loadURL: vi.fn() };
    const now = '2026-11-10T00:00:00.000Z';
    const task: Task = { id: 'task', projectId: 'project', assignedAccountId: 'account', mode: 'video', status: 'executing', prompt: 'input', outputs: [], result: null, createdAt: now, updatedAt: now };
    const safety: SubmissionDispatchSafety = { signal: controller.signal, deadlineAt: Date.now() + 10_000, dispatchKey: 'run', expectedPrompt: 'input',
      isCurrent: (): boolean => !controller.signal.aborted, verifyLease: async (): Promise<boolean> => !controller.signal.aborted };
    const pending = submitPromptOnce(view, safety);
    expect(page).toHaveBeenCalledOnce();
    const result = await handleControlCommand({ commandId: 'command', requestId: 'request', action, projectId: 'project', batchId: '_unbatched', taskId: 'task' }, {
      readTasks: async (): Promise<Task[]> => [task], start: async (): Promise<boolean> => false, retry: async (): Promise<boolean> => false,
      getLastError: (): null => null, updateStatus: async (): Promise<boolean> => false, abortActive: (): void => controller.abort(),
    });
    expect(result).toMatchObject({ ok: true, code: action === 'pause' ? 'PAUSE_ACCEPTED' : 'CANCEL_ACCEPTED' });
    finish({ ok: false }); expect(await pending).toMatchObject({ kind: 'not_dispatched' });
    expect(page).toHaveBeenCalledOnce(); expect(page.mock.calls[0][0]).not.toContain('"dispatchKey":'); expect(task.outputs).toEqual([]);
  });
  it('输入控件缺失只报告未派发，不留下平台发送事实', async (): Promise<void> => {
    vi.useFakeTimers(); const page = vi.fn(async (): Promise<SendButtonTarget> => ({ ok: false }));
    const view: WebviewHandle = { executeJavaScript: page, getURL: (): string => '', loadURL: vi.fn() };
    const pending = submitPromptOnce(view, { signal: new AbortController().signal, deadlineAt: Date.now() + 10_000, dispatchKey: 'run', expectedPrompt: 'input',
      isCurrent: (): boolean => true, verifyLease: async (): Promise<boolean> => true });
    await vi.advanceTimersByTimeAsync(500); expect(await pending).toMatchObject({ kind: 'not_dispatched', reason: 'controls_unavailable' });
  });
});
