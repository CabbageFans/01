/** 离线执行 BrowserPanel 的真实图片提交后延续分支；不打开页面或发送平台请求。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@doubao-studio/contracts';
import { diagnoseCreationReadback, inspectCreationReadback, type ChatPageSnapshot, type CreationReadbackResult } from '../../src/utils/chatReadback';
import { verifiedSubmissionConversationUrl, waitForConfirmedSubmission, type SubmissionReadback } from '../../src/utils/realSendStateMachine';
import { isSameDoubaoConversation, normalizeDoubaoConversationUrl } from '../../src/utils/taskConversationLocator';
import { SubmittedCreationReadbackContextError, SubmittedCreationReadbackTimeoutError, waitForSubmittedCreationReadback } from '../../src/utils/submittedCreationReadback';
import { mediaSubmissionReceiptFor } from '../../src/utils/mediaSubmissionReceipt';
import type { CurrentCreationConversationReadback } from '../../src/utils/creationConversationIdentity';

class OfflineSubmissionSafetyPauseError extends Error {}

function actualImageConfirmation(bindings: Record<string, unknown>): () => Promise<SubmissionReadback | undefined> {
  const file = ts.createSourceFile('BrowserPanel.tsx', fs.readFileSync(path.resolve('src/automation/TaskExecutionCoordinator.ts'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const initializers: Record<string, string> = {};
  let continuation = '';
  let preservation = '';
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ['trackSubmittedImageUrl', 'readSubmissionEvidence', 'confirmedEvidence'].includes(node.name.getText(file))) {
      initializers[node.name.getText(file)] = node.initializer!.getText(file);
    }
    if (ts.isBinaryExpression(node) && node.left.getText(file) === 'preserveSubmittedConversation' && ts.isArrowFunction(node.right)) preservation = node.right.getText(file);
    if (ts.isIfStatement(node) && node.expression.getText(file).startsWith("!confirmedEvidence && mode === 'image'")) continuation = node.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!continuation || !preservation || Object.keys(initializers).length !== 3) throw new Error('TEST actual image continuation branch missing');
  const source = `(async () => {
    let taskConversationUrl;
    let latestChatReadback;
    const actualPreservation = ${preservation};
    const preserveSubmittedConversation = async (...args) => { preserve(...args); return actualPreservation(...args); };
    let submittedImageUrl = null;
    const trackSubmittedImageUrl = ${initializers.trackSubmittedImageUrl};
    const readSubmissionEvidence = ${initializers.readSubmissionEvidence};
    let confirmedEvidence = ${initializers.confirmedEvidence};
    ${continuation}
    return confirmedEvidence;
  })`;
  const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(script, { ...bindings, Date, AbortController, DOMException, setTimeout, clearTimeout }) as () => Promise<SubmissionReadback | undefined>;
}

const originalUrl = 'https://www.doubao.com/chat/TEST-original-image';
const originalTime = '2026-11-03T08:00:00.000Z';
const originalPrompt = 'TEST 原场景图片完整请求，保留画面内容与构图。';

function emptyPage(): ChatPageSnapshot {
  return { messages: [], editorPresent: true, editorText: '', generating: false };
}

function publishedPage(patch: Partial<ChatPageSnapshot> = {}): ChatPageSnapshot {
  return { messages: [{ role: 'user', text: `生成图片：${originalPrompt}`, messageId: 'TEST-original-user' },
    { role: 'assistant', text: 'TEST图片生成中' }], editorPresent: true, editorText: '', generating: true, ...patch };
}

function providerPage(patch: Partial<ChatPageSnapshot> = {}): CurrentCreationConversationReadback {
  const conversationId = 'TEST-original-image';
  return { source: 'published_message', conversationId, conversationUrl: originalUrl, messageIds: ['TEST-original-user', 'TEST-original-assistant'],
    snapshot: { ...publishedPage(), historyComplete: true, conversationId, messages: [
      { role: 'user', text: `生成图片：${originalPrompt}`, rawText: `生成图片：${originalPrompt}`, messageId: 'TEST-original-user' },
      { role: 'assistant', text: 'TEST图片生成中', messageId: 'TEST-original-assistant', replyId: 'TEST-original-user' },
    ], ...patch } };
}

interface Harness {
  run: () => Promise<SubmissionReadback | undefined>;
  current: () => Task;
  replace: (task: Task) => void;
  controller: AbortController;
  view: { getURL: () => string; loadURL: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn>; sendInputEvent: ReturnType<typeof vi.fn> };
  setUrl: (url: string) => void;
  setOwnership: (owns: boolean) => void;
  replaceRegisteredView: () => void;
  chatRead: ReturnType<typeof vi.fn>;
  creationRead: ReturnType<typeof vi.fn>;
  providerRead: ReturnType<typeof vi.fn>;
  preserve: ReturnType<typeof vi.fn>;
  writes: ReturnType<typeof vi.fn>;
  sendCapabilities: ReturnType<typeof vi.fn>[];
  startedAt: number;
}

function fixture(strictImage: boolean = true): Harness {
  let current: Task = { id: 'TEST-submitted-image', assignedAccountId: 'TEST-account', mode: 'image', status: 'executing',
    executionIntent: 'armed', prompt: originalPrompt, promptReadback: 'exact', outputs: [], result: null, createdAt: originalTime, updatedAt: originalTime,
    petstory: { projectId: 'TEST-project', stepId: 'TEST-step' },
    runtime: { runId: 'TEST-original-run', attempt: 1, stage: 'submitting', message: 'TEST已单次发送', startedAt: originalTime,
      stageStartedAt: originalTime, lastHeartbeatAt: originalTime, submittedAt: originalTime,
      input: { prompt: originalPrompt, mode: 'image', attachments: [], petstory: { projectId: 'TEST-project', stepId: 'TEST-step' } } } };
  let url = originalUrl;
  let owns = true;
  const controller = new AbortController();
  const forbiddenWrite = (): never => { throw new Error('TEST read-only continuation invoked platform writing'); };
  const view = { getURL: (): string => url, loadURL: vi.fn(forbiddenWrite), reload: vi.fn(forbiddenWrite), sendInputEvent: vi.fn(forbiddenWrite) };
  const registry = new Map<string, unknown>([['TEST-account', view]]);
  const writes = vi.fn(async (_taskId: string, patch: { runtime?: Partial<NonNullable<Task['runtime']>> }): Promise<boolean> => {
    current = { ...current, runtime: { ...current.runtime!, ...patch.runtime } }; return true;
  });
  const preserve = vi.fn();
  const chatRead = vi.fn(async (): Promise<ChatPageSnapshot> => emptyPage());
  const creationRead = vi.fn(async (): Promise<ChatPageSnapshot> => publishedPage());
  const providerRead = vi.fn(async (): Promise<CurrentCreationConversationReadback> => ({ snapshot: await chatRead() }));
  const sendCapabilities = [vi.fn(forbiddenWrite), vi.fn(forbiddenWrite), vi.fn(forbiddenWrite), vi.fn(forbiddenWrite)];
  const bindings: Record<string, unknown> = {
    taskId: current.id, accountId: current.assignedAccountId, mode: 'image', prompt: originalPrompt, expectedRunId: current.runtime?.runId,
    submissionMarkedAt: current.runtime?.submittedAt, initialMsgCount: 0, videoConfig: undefined, strictPrompt: strictImage, petstoryGuard: strictImage,
    webview: view, controller, registryRef: { current: registry }, submittedImagePagesRef: { current: new Map() }, useTaskStore: { getState: (): object => ({ tasks: [current], updateTaskRuntime: writes }) },
    automationEngine: { ownsAccountController: (): boolean => owns, ownsController: (): boolean => owns },
    ownsTaskWebview: (taskId: string, page: unknown): boolean => taskId === current.id && registry.get(current.assignedAccountId || '') === page,
    pause: async (milliseconds: number): Promise<void> => { vi.setSystemTime(Date.now() + milliseconds); },
    checkHumanVerification: vi.fn(async (): Promise<void> => undefined),
    getChatPageSnapshot: chatRead, getCreationReadbackSnapshot: creationRead, getCurrentCreationConversation: providerRead, inspectCreationReadback, diagnoseCreationReadback,
    normalizeDoubaoConversationUrl, isSameDoubaoConversation, preserve, verifiedSubmissionConversationUrl, mediaSubmissionReceiptFor, updateTaskRuntime: writes,
    waitForConfirmedSubmission, waitForSubmittedCreationReadback, SubmittedCreationReadbackTimeoutError, SubmittedCreationReadbackContextError,
    SubmissionSafetyPauseError: OfflineSubmissionSafetyPauseError,
    window: { electronAPI: { logs: { append: vi.fn(async (): Promise<void> => undefined) } } },
    submitPromptOnce: sendCapabilities[0], injectPrompt: sendCapabilities[1], startNewConversation: sendCapabilities[2], uploadImages: sendCapabilities[3],
  };
  return { run: actualImageConfirmation(bindings), current: (): Task => current, replace: (task: Task): void => { current = task; },
    controller, view, setUrl: (next: string): void => { url = next; }, setOwnership: (next: boolean): void => { owns = next; },
    replaceRegisteredView: (): void => { registry.set('TEST-account', {}); }, chatRead, creationRead, providerRead, preserve, writes, sendCapabilities, startedAt: Date.now() };
}

function expectReadOnly(test: Harness): void {
  for (const capability of test.sendCapabilities) expect(capability).not.toHaveBeenCalled();
  expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.reload).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  expect(test.current().runtime?.submittedAt).toBe(originalTime);
}

beforeEach((): void => { vi.useFakeTimers(); vi.setSystemTime(originalTime); });
afterEach((): void => { vi.useRealTimers(); });

describe('BrowserPanel 原图片提交首轮未确认后的只读延续', (): void => {
  it.each(['https://www.doubao.com/chat/', 'https://www.doubao.com/chat/local_TEST'] as const)('发送后地址栏%s未更新，provider原消息可在首轮先保存耐久定位而无需等待路由', async (route): Promise<void> => {
    const test = fixture(); test.setUrl(route); test.providerRead.mockResolvedValue(providerPage());
    const result = await test.run();
    expect(result?.promptPublished).toBe(true); expect(result?.inputCleared).toBe(true);
    expect(Date.now() - test.startedAt).toBe(500); expect(test.providerRead).toHaveBeenCalledOnce();
    expect(test.current().runtime?.mediaSubmissionReceipt).toEqual({ schemaVersion: 1, source: 'published_message',
      accountId: 'TEST-account', runId: 'TEST-original-run', submittedAt: originalTime, conversationUrl: originalUrl,
      userMessageId: 'TEST-original-user', observedAt: new Date().toISOString() });
    expect(test.current().runtime?.conversationUrl).toBe(originalUrl); expect(test.view.getURL()).toBe(route);
    expect(test.writes).toHaveBeenCalledTimes(1); expect(test.creationRead).not.toHaveBeenCalled();
    expectReadOnly(test); expect(vi.getTimerCount()).toBe(0);
  });

  it('provider原消息在延续期出现时保存真实消息ID和会话，原临时路由保持不变', async (): Promise<void> => {
    const test = fixture(); test.setUrl('https://www.doubao.com/chat/local_TEST');
    test.providerRead.mockImplementation(async (): Promise<CurrentCreationConversationReadback> => test.providerRead.mock.calls.length <= 30
      ? { snapshot: emptyPage() } : providerPage());
    const result = await test.run();
    expect(result?.promptPublished).toBe(true); expect(Date.now() - test.startedAt).toBe(15_000);
    expect(test.current().runtime?.mediaSubmissionReceipt).toMatchObject({ conversationUrl: originalUrl, userMessageId: 'TEST-original-user' });
    expect(test.current().runtime?.conversationUrl).toBe(originalUrl); expect(test.view.getURL()).toBe('https://www.doubao.com/chat/local_TEST');
    expect(test.creationRead).not.toHaveBeenCalled(); expectReadOnly(test); expect(vi.getTimerCount()).toBe(0);
  });

  it('普通图片任务同样以provider保存原消息耐久定位，不依赖短剧strict标志', async (): Promise<void> => {
    const test = fixture(false); test.setUrl('https://www.doubao.com/chat/local_TEST'); test.providerRead.mockResolvedValue(providerPage());
    const result = await test.run();
    expect(result?.promptPublished).toBe(true); expect(test.current().runtime?.mediaSubmissionReceipt).toMatchObject({
      conversationUrl: originalUrl, userMessageId: 'TEST-original-user', runId: 'TEST-original-run',
    });
    expect(test.writes).toHaveBeenCalledTimes(1); expectReadOnly(test);
  });

  it('provider只证明已发布全文时可保存恢复定位，但输入未清空仍不能确认提交或重发', async (): Promise<void> => {
    const test = fixture(); test.setUrl('https://www.doubao.com/chat/local_TEST');
    test.providerRead.mockResolvedValue(providerPage({ editorText: originalPrompt }));
    await expect(test.run()).rejects.toThrow('原输入区尚未清空');
    expect(test.current().runtime?.mediaSubmissionReceipt).toMatchObject({ conversationUrl: originalUrl, userMessageId: 'TEST-original-user' });
    expect(test.writes).toHaveBeenCalledTimes(1); expect(Date.now() - test.startedAt).toBe(75_000);
    expectReadOnly(test); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['run', 'account', 'input', 'ownership', 'webview'] as const)('首轮provider读取返回前%s变化时，拒绝迟到全文且不把未存证据当作受理', async (change): Promise<void> => {
    const test = fixture(); test.setUrl('https://www.doubao.com/chat/local_TEST');
    test.providerRead.mockImplementation(async (): Promise<CurrentCreationConversationReadback> => {
      if (change === 'run') test.replace({ ...test.current(), runtime: { ...test.current().runtime!, runId: 'TEST-next-run' } });
      if (change === 'account') test.replace({ ...test.current(), assignedAccountId: 'TEST-other-account' });
      if (change === 'input') test.replace({ ...test.current(), runtime: { ...test.current().runtime!, input: { ...test.current().runtime!.input, prompt: originalPrompt + 'TEST changed' } } });
      if (change === 'ownership') test.setOwnership(false);
      if (change === 'webview') test.replaceRegisteredView();
      return providerPage();
    });
    await expect(test.run()).rejects.toBeInstanceOf(OfflineSubmissionSafetyPauseError);
    expect(test.writes).not.toHaveBeenCalled(); expect(test.current().runtime?.mediaSubmissionReceipt).toBeUndefined();
    expect(test.current().runtime?.conversationUrl).toBeUndefined(); expectReadOnly(test); expect(vi.getTimerCount()).toBe(0);
  });

  it('首轮15秒DOM为空后，用原具体会话历史补齐全文并自动确认同一运行', async (): Promise<void> => {
    const test = fixture();
    test.creationRead.mockResolvedValueOnce(emptyPage()).mockResolvedValueOnce(publishedPage());
    const result = await test.run();
    expect(result?.promptPublished).toBe(true); expect(result?.inputCleared).toBe(true);
    expect(test.chatRead).toHaveBeenCalled(); expect(test.creationRead).toHaveBeenCalledTimes(2);
    expect(Date.now() - test.startedAt).toBe(15_500);
    expect(test.current().runtime?.runId).toBe('TEST-original-run');
    expect(test.current().runtime?.conversationUrl).toBe(originalUrl);
    expect(test.writes).toHaveBeenCalledExactlyOnceWith(test.current().id, { runtime: { conversationUrl: originalUrl } });
    expect(test.creationRead).toHaveBeenCalledWith(test.view, expect.objectContaining({ conversationUrl: originalUrl, signal: test.controller.signal, ensureCurrent: expect.any(Function) }));
    expectReadOnly(test); expect(vi.getTimerCount()).toBe(0);
  });

  it('根页在延续期才得到具体会话时继续等原全文，不要求用户再次点击', async (): Promise<void> => {
    const test = fixture(); test.setUrl('https://www.doubao.com/chat/local_TEST');
    test.chatRead.mockImplementation(async (): Promise<ChatPageSnapshot> => {
      if (test.chatRead.mock.calls.length > 30) test.setUrl(originalUrl);
      return emptyPage();
    });
    const result = await test.run();
    expect(result?.promptPublished).toBe(true); expect(test.chatRead.mock.calls.length).toBeGreaterThanOrEqual(31);
    expect(test.creationRead).toHaveBeenCalledOnce(); expect(test.writes).toHaveBeenCalledExactlyOnceWith(test.current().id, { runtime: { conversationUrl: originalUrl } });
    expectReadOnly(test);
  });

  it('原全文已发布但输入尚未清空时不确认，延续超时仍保留原提交意图', async (): Promise<void> => {
    const test = fixture();
    test.creationRead.mockImplementation(async (): Promise<ChatPageSnapshot> => publishedPage({ editorText: originalPrompt }));
    await expect(test.run()).rejects.toThrow('原输入区尚未清空');
    expect(test.current().runtime?.conversationUrl).toBeUndefined(); expect(test.writes).not.toHaveBeenCalled();
    expect(Date.now() - test.startedAt).toBe(75_000); expectReadOnly(test); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['run', 'cancel', 'account', 'input', 'ownership', 'webview', 'url'] as const)('历史补齐返回前%s变化时不保存迟到定位或重发', async (change): Promise<void> => {
    const test = fixture();
    test.creationRead.mockImplementation(async (): Promise<ChatPageSnapshot> => {
      if (change === 'run') test.replace({ ...test.current(), runtime: { ...test.current().runtime!, runId: 'TEST-next-run' } });
      if (change === 'cancel') { test.replace({ ...test.current(), status: 'cancelled' }); test.controller.abort(); }
      if (change === 'account') test.replace({ ...test.current(), assignedAccountId: 'TEST-other-account' });
      if (change === 'input') test.replace({ ...test.current(), runtime: { ...test.current().runtime!, input: { ...test.current().runtime!.input, prompt: originalPrompt + 'TEST changed' } } });
      if (change === 'ownership') test.setOwnership(false);
      if (change === 'webview') test.replaceRegisteredView();
      if (change === 'url') test.setUrl('https://www.doubao.com/chat/TEST-other-image');
      return publishedPage();
    });
    const pending = test.run();
    if (change === 'cancel') await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    else await expect(pending).rejects.toBeInstanceOf(OfflineSubmissionSafetyPauseError);
    expect(test.creationRead).toHaveBeenCalledOnce(); expect(test.writes).not.toHaveBeenCalled();
    expect(test.preserve.mock.calls.some((call: unknown[]): boolean => (call[0] as CreationReadbackResult | undefined)?.promptPublished === true)).toBe(false);
    expect(test.current().runtime?.conversationUrl).toBeUndefined(); expectReadOnly(test); expect(vi.getTimerCount()).toBe(0);
  });

  it('延续仍读不到唯一原请求时抛安全暂停，保留输入、运行和单次提交记录', async (): Promise<void> => {
    const test = fixture(); const originalInput = structuredClone(test.current().runtime!.input);
    test.creationRead.mockImplementation(async (): Promise<ChatPageSnapshot> => emptyPage());
    const error = await test.run().catch((caught: unknown): unknown => caught);
    expect(error).toBeInstanceOf(OfflineSubmissionSafetyPauseError);
    expect((error as Error).message).toContain('原请求全文尚未匹配');
    expect((error as Error).message).not.toContain('prompt_unmatched');
    expect(test.current().runtime?.runId).toBe('TEST-original-run'); expect(test.current().runtime?.input).toEqual(originalInput);
    expect(test.current().runtime?.conversationUrl).toBeUndefined(); expect(test.writes).not.toHaveBeenCalled();
    expect(Date.now() - test.startedAt).toBe(75_000); expectReadOnly(test); expect(vi.getTimerCount()).toBe(0);
  });
});
