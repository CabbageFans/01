/** 执行 BrowserPanel 实际可见性 effect 及正式同步函数，验证未解决媒体原现场不会被自动刷新。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@doubao-studio/contracts';
import { syncTaskConversation, type ConversationSyncPageSnapshot } from '../../src/utils/conversationSync';
import { isSameDoubaoConversation, normalizeDoubaoConversationUrl, resolveTaskConversationTarget, supportsDoubaoConversationLocator } from '../../src/utils/taskConversationLocator';

const NOW = '2026-11-09T14:00:00.000Z';
const ACCOUNT = 'TEST-passive-account';
const URL = 'https://www.doubao.com/chat/TEST-submitted-media';

function originalTask(): Task {
  return { id: 'TEST-passive-task', projectId: 'TEST-studio', assignedAccountId: ACCOUNT, prompt: 'TEST 原媒体请求', mode: 'video', status: 'paused',
    outputs: [], result: null, createdAt: NOW, updatedAt: NOW,
    runtime: { runId: 'TEST-passive-run', attempt: 1, stage: 'paused', message: 'TEST 原发送待核对', startedAt: NOW,
      stageStartedAt: NOW, lastHeartbeatAt: NOW, submittedAt: NOW, conversationUrl: URL, input: { mode: 'video', prompt: 'TEST 原媒体请求', attachments: [] },
      mediaSubmissionReceipt: { schemaVersion: 1, source: 'published_message', runId: 'TEST-passive-run', accountId: ACCOUNT,
        submittedAt: NOW, observedAt: NOW, conversationUrl: URL, userMessageId: 'TEST-original-server-user' } } };
}

function effect(bindings: Record<string, unknown>): () => (() => void) | undefined {
  const source = ts.createSourceFile('BrowserPanel.tsx', fs.readFileSync(path.resolve('src/components/BrowserPanel.tsx'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let callback = ''; const helpers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('passiveConversationSyncRef')) callback = node.arguments[0].getText(source);
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'hasUnresolvedMediaConversation') helpers.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source); if (!callback) throw new Error('TEST passive effect not found');
  const script = ts.transpileModule(`${helpers.join('\n')}\n(${callback})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(script, { ...bindings, Date, Error, AbortController, setInterval, clearInterval }) as () => (() => void) | undefined;
}

function fixture(task: Task = originalTask()): { start: () => void; stop: () => void; focus: () => void; setRoute: (url: string) => void;
  reload: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn>; readPage: ReturnType<typeof vi.fn>; task: Task } {
  let route = URL; let documentId = 'TEST-initial-document'; let cleanup: (() => void) | undefined; let focus: (() => void) | undefined;
  const reload = vi.fn((): void => { documentId = 'TEST-reloaded-document'; });
  const navigate = vi.fn((url: string): void => { route = url; documentId = 'TEST-navigated-document'; });
  const view = { getURL: (): string => route, reload, loadURL: navigate };
  const readPage = vi.fn(async (): Promise<import('../../src/utils/conversationSync').ConversationSyncPageSnapshot> => ({
    documentId, url: route, ready: true, editorPresent: true, editorText: '', attachmentCount: 0, pendingUploads: false,
    generating: false, humanVerification: false, userInteracting: false,
  }));
  const bindings: Record<string, unknown> = {
    visible: true, activeAccount: { id: ACCOUNT, platform: 'doubao' }, visibleRef: { current: true },
    useAccountStore: { getState: (): object => ({ selectedAccountId: ACCOUNT }) },
    useTaskStore: { getState: (): object => ({ tasks: [task], accountAutomationState: {} }) },
    hasAccountChatAdjustment: (): boolean => false, findInteractiveAccountId: (): undefined => undefined,
    supportsDoubaoConversationLocator, normalizeDoubaoConversationUrl, resolveTaskConversationTarget, isSameDoubaoConversation,
    loadingMapRef: { current: new Map([[ACCOUNT, false]]) }, registryRef: { current: new Map([[ACCOUNT, view]]) }, passiveConversationSyncRef: { current: new Map<string, number>() },
    synchronizeConversation: (_view: typeof view, target: string, isCurrent: () => boolean, trigger: 'visibility', signal: AbortSignal): ReturnType<typeof syncTaskConversation> => syncTaskConversation({
      navigator: view, targetUrl: target, isCurrent, trigger, signal, readPageSnapshot: readPage,
    }),
    window: { addEventListener: (name: string, handler: () => void): void => { if (name === 'focus') focus = handler; },
      removeEventListener: (): void => { focus = undefined; } },
  };
  return { start: (): void => { cleanup = effect(bindings)(); }, stop: (): void => { cleanup?.(); }, focus: (): void => { focus?.(); },
    setRoute: (url: string): void => { route = url; }, reload, navigate, readPage, task };
}

beforeEach((): void => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach((): void => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('未解决已提交媒体原Chat的被动同步边界', (): void => {
  it.each(['receipt', 'intent'] as const)('原%s定位匹配当前Chat时，显示、聚焦和30秒轮询均不自动刷新', async (evidence): Promise<void> => {
    const task = originalTask(); if (evidence === 'intent') task.runtime!.mediaSubmissionReceipt = undefined;
    const test = fixture(task); test.start(); await vi.advanceTimersByTimeAsync(500); test.focus(); await vi.advanceTimersByTimeAsync(30_000);
    expect(test.reload).not.toHaveBeenCalled(); expect(test.navigate).not.toHaveBeenCalled(); test.stop();
  });

  it.each(['done', 'cancelled', 'other-route', 'other-account', 'chat', 'unsubmitted', 'binding-conflict'] as const)('%s不阻止普通可见Chat自动同步', async (state): Promise<void> => {
    const task = originalTask();
    if (state === 'done' || state === 'cancelled') task.status = state;
    if (state === 'other-account') task.assignedAccountId = 'TEST-other-account';
    if (state === 'chat') { task.mode = 'chat'; task.runtime!.input.mode = 'chat'; task.runtime!.mediaSubmissionReceipt = undefined; }
    if (state === 'unsubmitted') { task.runtime!.submittedAt = undefined; task.runtime!.mediaSubmissionReceipt = undefined; }
    if (state === 'binding-conflict') task.runtime!.mediaSubmissionReceipt!.runId = 'TEST-foreign-run';
    const test = fixture(task); if (state === 'other-route') test.setRoute('https://www.doubao.com/chat/TEST-other-chat');
    test.start(); await vi.advanceTimersByTimeAsync(500);
    expect(test.reload).toHaveBeenCalledOnce(); expect(test.navigate).not.toHaveBeenCalled(); test.stop();
  });

  it('同步快照等待期间当前会话出现原媒体提交，导航前重新核验并停止刷新', async (): Promise<void> => {
    const task = originalTask(); task.runtime!.submittedAt = undefined; task.runtime!.mediaSubmissionReceipt = undefined;
    const test = fixture(task); const readPage = test.readPage.getMockImplementation()!;
    test.readPage.mockImplementationOnce(async (): Promise<ConversationSyncPageSnapshot> => {
      task.runtime!.submittedAt = NOW; return readPage();
    });
    test.start(); await vi.advanceTimersByTimeAsync(500);
    expect(test.reload).not.toHaveBeenCalled(); expect(test.navigate).not.toHaveBeenCalled(); test.stop();
  });
});
