/** 离线执行实际 BrowserPanel 执行入口；不挂载网页，不调用平台。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@doubao-studio/contracts';
import original from '../fixtures/storyboard-five-shots.json';

function executeEntry(bindings: Record<string, unknown>): (...args: unknown[]) => Promise<void> {
  const file = ts.createSourceFile('BrowserPanel.tsx', fs.readFileSync(path.resolve('src/components/BrowserPanel.tsx'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let expression = '';
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'executeAutomation') expression = node.initializer!.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file); if (!expression) throw new Error('OFFLINE: actual BrowserPanel execution entry not found');
  const script = ts.transpileModule('(' + expression + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(script, bindings) as (...args: unknown[]) => Promise<void>;
}

function task(): Task {
  return { id: 'OFFLINE-task', mode: 'chat', prompt: original.mobileStory, assignedAccountId: 'OFFLINE-account', status: 'executing', result: null, outputs: [], createdAt: '2026-10-26', updatedAt: '2026-10-26',
    runtime: { runId: 'OFFLINE-original-run', attempt: 1, startedAt: '2026-10-26', stageStartedAt: '2026-10-26', lastHeartbeatAt: '2026-10-26', stage: 'submitting', message: 'OFFLINE-original', submittedAt: '2026-10-26', input: { prompt: original.mobileStory, mode: 'chat', attachments: [] } } };
}

describe('F03 组件重挂载／热更新防重复执行（离线）', (): void => {
  it('已有提交记录时仅暂停并派发原任务只读核对，零网页调用且不创建控制器', async (): Promise<void> => {
    const current = task(); const runningRef = { current: new Set([current.assignedAccountId]) };
    const pauseAutomation = vi.fn(async (): Promise<void> => { current.status = 'paused'; });
    const release = vi.fn(async (): Promise<void> => {}); const createController = vi.fn(); const dispatchEvent = vi.fn();
    const entry = executeEntry({ useTaskStore: { getState: (): object => ({ tasks: [current], pauseAutomation }) }, runningRef,
      automationEngine: { hasController: (): boolean => false, release, createController }, window: { dispatchEvent }, CustomEvent: class { constructor(public readonly type: string, public readonly options: object) {} } });
    const webview = { executeJavaScript: vi.fn(), loadURL: vi.fn(), sendInputEvent: vi.fn() };
    const submittedAt = current.runtime!.submittedAt;
    await entry(current.assignedAccountId, current.id, current.prompt, current.mode, webview);
    expect(pauseAutomation).toHaveBeenCalledWith(current.id, current.assignedAccountId, expect.any(String), { status: 'paused', code: 'submission_uncertain' });
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'reconcile-task-submission', options: { detail: { taskId: current.id } } }));
    expect(current.runtime!.submittedAt).toBe(submittedAt); expect(createController).not.toHaveBeenCalled();
    expect(webview.executeJavaScript).not.toHaveBeenCalled(); expect(webview.loadURL).not.toHaveBeenCalled(); expect(webview.sendInputEvent).not.toHaveBeenCalled();
  });

  it('原控制器仍持有运行时重挂载不暂停、不释放、不接管账号', async (): Promise<void> => {
    const current = task(); const pauseAutomation = vi.fn(); const release = vi.fn(); const dispatchEvent = vi.fn();
    const entry = executeEntry({ useTaskStore: { getState: (): object => ({ tasks: [current], pauseAutomation }) }, runningRef: { current: new Set([current.assignedAccountId]) },
      automationEngine: { hasController: (): boolean => true, release }, window: { dispatchEvent } });
    await entry(current.assignedAccountId, current.id, current.prompt, current.mode, {});
    expect(pauseAutomation).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled(); expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
