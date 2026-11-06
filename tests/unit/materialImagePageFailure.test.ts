/** 首载失败只交回对应的未发送运行，不挂载真实豆包页面。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@doubao-studio/contracts';
import type { MaterialImagePageFailure } from '../../src/utils/materialImagePages';
import { getTaskExecutionScope } from '../../src/utils/taskExecutionScope';

function handler(bindings: Record<string, unknown>): (task: Task, failure: MaterialImagePageFailure) => Promise<void> {
  const file = ts.createSourceFile('BrowserPanel.tsx', fs.readFileSync(path.resolve('src/components/BrowserPanel.tsx'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let expression = '';
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'pauseFailedMaterialPage') expression = node.initializer!.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file); if (!expression) throw new Error('TEST actual page failure handler missing');
  const script = ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(script, { getTaskExecutionScope, useCallback: (callback: unknown): unknown => callback, ...bindings }) as (task: Task, failure: MaterialImagePageFailure) => Promise<void>;
}

function fixture(): { task: Task; failure: MaterialImagePageFailure; pause: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn>;
  hasController: ReturnType<typeof vi.fn>; run: ReturnType<typeof handler>; running: Set<string>; replaceRun: () => void } {
  const now = '2026-11-05T00:00:00.000Z';
  let task: Task = { id: 'TEST-page-failure', assignedAccountId: 'TEST-account', mode: 'image', status: 'executing', prompt: 'TEST', result: null, outputs: [], createdAt: now, updatedAt: now,
    petstory: { projectId: 'TEST-project', stepId: 'TEST-step', imageOperationId: 'TEST-operation', materialId: 'character:a' },
    runtime: { runId: 'TEST-original-run', attempt: 1, stage: 'preparing_account', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { mode: 'image', prompt: 'TEST', attachments: [] } } };
  const failure: MaterialImagePageFailure = { taskId: task.id, accountId: 'TEST-account', runId: 'TEST-original-run', code: 'page_loading', message: 'TEST 首载失败' };
  const running = new Set(['image:TEST-account:TEST-project:prop%3Ab']);
  const pause = vi.fn(async (): Promise<void> => { task = { ...task, status: 'paused' }; });
  const release = vi.fn(async (): Promise<void> => {}); const hasController = vi.fn((): boolean => false);
  const run = handler({ useTaskStore: { getState: (): object => ({ tasks: [task], pauseAutomation: pause, processQueue: vi.fn() }) },
    automationEngine: { release, hasController }, runningRef: { current: running }, message: { error: vi.fn() }, setTimeout: vi.fn() });
  return { task, failure, pause, release, hasController, run, running, replaceRun: (): void => { task = { ...task, runtime: { ...task.runtime!, runId: 'TEST-later-run' } }; } };
}

describe('派发前首载失败释放精确运行', (): void => {
  it('只暂停未创建controller的原task并释放自己的预约，另一素材占位保留', async (): Promise<void> => {
    const test = fixture(); await test.run(test.task, test.failure);
    expect(test.pause).toHaveBeenCalledExactlyOnceWith(test.task.id, test.task.assignedAccountId, test.failure.message, { status: 'paused', code: 'page_loading' });
    expect(test.release).toHaveBeenCalledExactlyOnceWith(test.task.id);
    expect(test.running).toEqual(new Set(['image:TEST-account:TEST-project:prop%3Ab']));
    expect(test.task.runtime?.submittedAt).toBeUndefined();
  });

  it('旧run加载错误不得暂停或释放后来同task的预约', async (): Promise<void> => {
    const test = fixture(); test.replaceRun(); await test.run(test.task, test.failure);
    expect(test.pause).not.toHaveBeenCalled(); expect(test.release).not.toHaveBeenCalled();
  });

  it('已有controller的执行走原运行错误路径，不由首载分支接管或释放', async (): Promise<void> => {
    const test = fixture(); test.hasController.mockReturnValue(true); await test.run(test.task, test.failure);
    expect(test.pause).not.toHaveBeenCalled(); expect(test.release).not.toHaveBeenCalled();
  });
});
