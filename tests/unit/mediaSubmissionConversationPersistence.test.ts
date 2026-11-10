/** 执行 BrowserPanel 实际媒体回读闭包并经过真实 TaskService；离线证明发送后定位不依赖地址栏。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { Task, TaskUpdateRuntimeParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';
import { inspectChatReadback, inspectCreationReadback, type ChatPageSnapshot } from '../../src/utils/chatReadback';
import type { CurrentCreationConversationReadback } from '../../src/utils/creationConversationIdentity';
import { mediaSubmissionReceiptFor } from '../../src/utils/mediaSubmissionReceipt';
import { verifiedSubmissionConversationUrl, type SubmissionReadback } from '../../src/utils/realSendStateMachine';
import { canLocateSubmittedMediaConversation, isSameDoubaoConversation, normalizeDoubaoConversationUrl, resolveTaskConversationTarget, supportsDoubaoConversationLocator } from '../../src/utils/taskConversationLocator';

const NOW = '2026-11-09T14:00:00.000Z';
const OBSERVED = '2026-11-09T14:00:02.000Z';
const ACCOUNT = 'TEST-media-account';
const URL = 'https://www.doubao.com/chat/TEST-provider-conversation';

function actualClosure<T>(name: string, bindings: Record<string, unknown>): T {
  const source = ts.createSourceFile('execution.tsx', ['src/components/BrowserPanel.tsx', 'src/automation/TaskRecoveryCoordinator.ts', 'src/automation/TaskExecutionCoordinator.ts', 'src/automation/taskExecutionSupport.ts'].map((file): string => fs.readFileSync(path.resolve(file), 'utf8').replace(/^export /gm, '')).join('\n'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let expression: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) expression = node.initializer?.getText(source);
    if (ts.isFunctionDeclaration(node) && node.name?.getText(source) === name) expression = node.getText(source);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(source) === name && ts.isArrowFunction(node.right)) expression = node.right.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression) throw new Error(`TEST actual ${name} not found`);
  const script = ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(script, { ...bindings, Date, Error, DOMException }) as T;
}

function fixture(mode: 'image' | 'video' = 'video', route: string = 'https://www.doubao.com/chat/'): {
  read: () => Task; replace: (value: Task) => void; service: TaskService; writes: ReturnType<typeof vi.fn>; bindings: Record<string, unknown>;
  provider: ReturnType<typeof vi.fn<() => Promise<CurrentCreationConversationReadback>>>;
  view: { getURL: ReturnType<typeof vi.fn>; loadURL: ReturnType<typeof vi.fn>; sendInputEvent: ReturnType<typeof vi.fn> };
  preserve: () => Promise<void>; evidence: () => Promise<SubmissionReadback>; page: CurrentCreationConversationReadback;
  setOwned: (value: boolean) => void;
} {
  const prompt = 'TEST 完整原媒体请求，固定同一画面并保持镜头动作。';
  const videoConfig: Task['videoConfig'] = mode === 'video' ? { model: 'seedance-2.0-fast', aspectRatio: '16:9', duration: '5s' } : undefined;
  const initial: Task = { id: 'TEST-media-task', projectId: 'TEST-studio', assignedAccountId: ACCOUNT, mode, prompt, videoConfig,
    status: 'executing', executionIntent: 'armed', outputs: [], result: null, createdAt: NOW, updatedAt: NOW,
    runtime: { runId: 'TEST-media-run', attempt: 1, stage: 'submitting', message: 'TEST 原提交', startedAt: NOW,
      stageStartedAt: NOW, lastHeartbeatAt: NOW, submittedAt: NOW, input: { prompt, mode, attachments: [], videoConfig } } };
  let persisted = JSON.stringify([initial]);
  const read = (): Task => normalizeTasks(JSON.parse(persisted), 'TEST-studio', OBSERVED).data[0];
  const service = new TaskService({ store: { read: (): Task[] => [read()], replace: (tasks: Task[]): boolean => { persisted = JSON.stringify(tasks); return true; } },
    defaultProjectId: (): string => 'TEST-studio', now: (): string => OBSERVED });
  const writes = vi.fn(async (taskId: string, patch: Omit<TaskUpdateRuntimeParams, 'taskId'>): Promise<boolean> => service.updateRuntime({ taskId, expectedRunId: initial.runtime?.runId, ...patch }).success);
  const providerText = mode === 'video' ? `生成视频：${prompt}，16:9，5s` : `生成图片：${prompt}`;
  const page: CurrentCreationConversationReadback = { source: 'published_message', conversationId: 'TEST-provider-conversation', conversationUrl: URL,
    messageIds: ['TEST-original-user', 'TEST-original-assistant'], snapshot: { conversationId: 'TEST-provider-conversation', historyComplete: true,
      editorPresent: true, editorText: '', generating: true, messages: [
        { role: 'user', text: providerText, rawText: providerText, messageId: 'TEST-original-user' },
        { role: 'assistant', text: 'TEST 正在处理', messageId: 'TEST-original-assistant', replyId: 'TEST-original-user' },
      ] } };
  const provider = vi.fn(async (): Promise<CurrentCreationConversationReadback> => structuredClone(page));
  const view = { getURL: vi.fn((): string => route), loadURL: vi.fn(), sendInputEvent: vi.fn() };
  const controller = new AbortController(); let owned = true;
  const bindings: Record<string, unknown> = {
    mode, accountId: ACCOUNT, taskId: initial.id, expectedRunId: initial.runtime!.runId, submissionMarkedAt: NOW,
    prompt, initialMsgCount: 0, videoConfig, strictPrompt: true, petstoryGuard: {}, controller, webview: view,
    taskConversationUrl: undefined, latestChatReadback: undefined,
    automationEngine: { ownsController: (): boolean => owned, ownsAccountController: (): boolean => owned },
    SubmissionSafetyPauseError: Error,
    ownsTaskWebview: (): boolean => owned,
    useTaskStore: { getState: (): object => ({ tasks: [read()] }) },
    updateTaskRuntime: writes, normalizeDoubaoConversationUrl, isSameDoubaoConversation, resolveTaskConversationTarget, mediaSubmissionReceiptFor, verifiedSubmissionConversationUrl,
    inspectChatReadback, inspectCreationReadback,
    getCurrentCreationConversation: provider,
    getChatPageSnapshot: vi.fn(async (): Promise<ChatPageSnapshot> => ({ messages: [], editorPresent: true, editorText: '', generating: true })),
    getCreationReadbackSnapshot: vi.fn(async (): Promise<ChatPageSnapshot> => structuredClone(page.snapshot)),
    submittedImagePagesRef: { current: new Map<string, object>() },
    trackSubmittedImageUrl: vi.fn(),
    chatReadbackReceipt: vi.fn(),
  };
  bindings.taskChatReadbackContext = actualClosure('taskChatReadbackContext', bindings);
  const preserve = actualClosure<() => Promise<void>>('preserveSubmittedConversation', bindings);
  bindings.preserveSubmittedConversation = preserve;
  const evidence = actualClosure<() => Promise<SubmissionReadback>>('readSubmissionEvidence', bindings);
  return { read, replace: (value: Task): void => { persisted = JSON.stringify([value]); }, service, writes, bindings, provider, view, preserve, evidence, page, setOwned: (value: boolean): void => { owned = value; } };
}

describe('媒体发送后真实回读与耐久会话归属接线', (): void => {
  it.each(['image', 'video'] as const)('%s地址栏仍为根页时，当前完整服务器消息被保存且可打开', async (mode): Promise<void> => {
    const test = fixture(mode); const input = structuredClone(test.read().runtime!.input);
    expect((await test.evidence()).promptPublished).toBe(true);
    expect(test.read().runtime?.mediaSubmissionReceipt).toMatchObject({ runId: 'TEST-media-run', accountId: ACCOUNT, conversationUrl: URL, userMessageId: 'TEST-original-user' });
    expect(resolveTaskConversationTarget(test.read())).toMatchObject({ ok: true, url: URL });
    expect(test.read().runtime?.input).toEqual(input); expect(test.read().runtime?.submittedAt).toBe(NOW);
    expect(test.provider).toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('视频临时发送路由不能成为定位，但当前provider的正式原消息身份可以持久化', async (): Promise<void> => {
    const test = fixture('video', 'https://www.doubao.com/chat/local_TEST-pending');
    await test.evidence(); expect(resolveTaskConversationTarget(test.read())).toMatchObject({ ok: true, url: URL });
    expect(test.read().runtime?.mediaSubmissionReceipt?.conversationUrl).toBe(URL);
  });

  it('视频正文已发布但输入框尚未清空时，先保存导航身份而不伪造受理观察', async (): Promise<void> => {
    const test = fixture(); test.page.snapshot.editorText = test.read().prompt;
    const evidence = await test.evidence();
    expect(evidence.promptPublished).toBe(true); expect(evidence.inputCleared).toBe(false);
    expect(resolveTaskConversationTarget(test.read())).toMatchObject({ ok: true, url: URL });
    expect(test.read().runtime?.acceptanceObservation).toBeUndefined(); expect(test.read().status).toBe('executing');
  });

  it('视频原消息收据保存后，后续同文请求不能替换既有服务器消息身份', async (): Promise<void> => {
    const test = fixture(); await test.evidence();
    test.page.snapshot.messages.push({ ...test.page.snapshot.messages[0], messageId: 'TEST-later-same-text' });
    test.page.messageIds!.push('TEST-later-same-text');
    const original = test.read();
    expect(mediaSubmissionReceiptFor(original, test.read(), ACCOUNT, test.page, OBSERVED)).toMatchObject({ userMessageId: 'TEST-original-user' });
    expect((await test.evidence()).promptPublished).toBe(true);
    original.runtime!.mediaSubmissionReceipt!.userMessageId = 'TEST-missing-original';
    expect(mediaSubmissionReceiptFor(original, original, ACCOUNT, test.page, OBSERVED)).toBeUndefined();
  });

  it.each(['no-provider', 'other-prompt', 'ambiguous-users', 'local-message'] as const)('%s不形成具体原会话或耐久收据', async (condition): Promise<void> => {
    const test = fixture();
    if (condition === 'no-provider') { delete test.page.source; delete test.page.conversationId; delete test.page.conversationUrl; test.page.snapshot.messages = []; }
    if (condition === 'other-prompt') test.page.snapshot.messages[0].text = test.page.snapshot.messages[0].rawText = 'TEST 无关媒体请求';
    if (condition === 'ambiguous-users') { test.page.snapshot.messages.push({ ...test.page.snapshot.messages[0], messageId: 'TEST-second-user' }); test.page.messageIds!.push('TEST-second-user'); }
    if (condition === 'local-message') { test.page.snapshot.messages[0].messageId = 'local_TEST-pending'; test.page.messageIds![0] = 'local_TEST-pending'; }
    await test.evidence();
    expect(test.read().runtime?.mediaSubmissionReceipt).toBeUndefined(); expect(resolveTaskConversationTarget(test.read())).toMatchObject({ ok: false });
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each(['run', 'account', 'ownership', 'input'] as const)('provider异步返回前%s变化，旧结果零写入', async (change): Promise<void> => {
    const test = fixture();
    test.provider.mockImplementationOnce(async (): Promise<CurrentCreationConversationReadback> => {
      if (change === 'ownership') test.setOwned(false);
      else {
        const task = test.read(); const runtime = task.runtime!;
        if (change === 'run') test.replace({ ...task, runtime: { ...runtime, runId: 'TEST-new-run', attempt: 2 } });
        if (change === 'account') test.replace({ ...task, assignedAccountId: 'TEST-other-account' });
        if (change === 'input') test.replace({ ...task, runtime: { ...runtime, input: { ...runtime.input, prompt: 'TEST changed input' } } });
      }
      return structuredClone(test.page);
    });
    await expect(test.evidence()).rejects.toThrow();
    expect(test.writes).not.toHaveBeenCalled(); expect(test.read().runtime?.mediaSubmissionReceipt).toBeUndefined();
  });
});

describe('进入豆包对话先保存原媒体身份再显示', (): void => {
  function navigation(test: ReturnType<typeof fixture>, isCurrentSource?: () => boolean): { open: () => Promise<void>; reveal: ReturnType<typeof vi.fn>; synchronize: ReturnType<typeof vi.fn>; warnings: ReturnType<typeof vi.fn> } {
    const reveal = vi.fn(); const synchronize = vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true })); const warnings = vi.fn();
    const bindings: Record<string, unknown> = { ...test.bindings,
      canLocateSubmittedMediaConversation, supportsDoubaoConversationLocator, resolveTaskConversationTarget,
      sameTaskConversationRun: actualClosure('sameTaskConversationRun', {}),
      useTaskStore: { getState: (): object => ({ tasks: [test.read()], accountAutomationState: {}, updateTaskRuntime: test.writes }) },
      useAccountStore: { getState: (): object => ({ accounts: [{ id: ACCOUNT, platform: 'doubao' }], selectAccount: vi.fn() }) },
      canSelectAccount: (): boolean => true, findInteractiveAccountId: (): undefined => undefined, hasAccountChatAdjustment: (): boolean => false,
      ensureTaskWebview: vi.fn(), waitForConversationNavigator: vi.fn(async (): Promise<typeof test.view> => test.view),
      getTaskWebview: (): typeof test.view => test.view, taskWebviewReady: (): boolean => true,
      materialPagesRef: { current: { uses: (): boolean => false } }, setViewedTaskPageId: vi.fn(), revealBrowser: reveal,
      submissionReconcileRef: { current: new Set<string>() }, tasksExecutionConflict: (): boolean => true,
      synchronizeConversation: synchronize, conversationSyncMessage: (): string => 'TEST 同步拒绝',
      message: { warning: warnings, info: vi.fn(), success: vi.fn() },
    };
    bindings.locateSubmittedMediaConversation = actualClosure('locateSubmittedMediaConversation', bindings);
    const handle = actualClosure<(event: Event) => Promise<void>>('handleOpenConversation', bindings);
    return { open: (): Promise<void> => handle({ detail: { task: test.read(), locateSubmittedMedia: true, isCurrentSource } } as unknown as Event), reveal, synchronize, warnings };
  }

  it.each(['image', 'video'] as const)('%s已提交缺URL时，正式provider证据落盘后原位显示，零刷新导航发送', async (mode): Promise<void> => {
    const test = fixture(mode); test.service.updateRuntime({ taskId: test.read().id, status: 'paused', runtime: { stage: 'paused' } });
    const nav = navigation(test); await nav.open();
    expect(test.read().runtime?.mediaSubmissionReceipt).toMatchObject({ conversationUrl: URL, userMessageId: 'TEST-original-user' });
    expect(nav.reveal).toHaveBeenCalledOnce(); expect(nav.synchronize).not.toHaveBeenCalled();
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled(); expect(nav.warnings).not.toHaveBeenCalled();
  });

  it('真实视频消息形状含前置零字服务器用户消息时，仍按正式上下文唯一全文保存并打开', async (): Promise<void> => {
    const test = fixture(); test.page.snapshot.messages.unshift({ role: 'user', text: '', messageId: 'TEST-original-upload' });
    test.page.messageIds!.unshift('TEST-original-upload');
    const evidence = await test.evidence(); expect(evidence.promptPublished).toBe(true);
    expect(test.read().runtime?.mediaSubmissionReceipt?.userMessageId).toBe('TEST-original-user');
    const nav = navigation(test); await nav.open();
    expect(nav.reveal).toHaveBeenCalledOnce(); expect(nav.synchronize).not.toHaveBeenCalled();
  });

  it('已有原收据且当前正在生成时，仅显示已核实provider，不同步刷新', async (): Promise<void> => {
    const test = fixture(); await test.evidence(); test.service.updateRuntime({ taskId: test.read().id, status: 'generating', runtime: { stage: 'generating' } });
    const nav = navigation(test); await nav.open();
    expect(nav.reveal).toHaveBeenCalledOnce(); expect(nav.synchronize).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled();
  });

  it('原收据与当前具体路由已一致时，原消息虚拟卸载不触发再次全文读取或刷新', async (): Promise<void> => {
    const test = fixture('video', URL); await test.evidence(); const priorReads = test.provider.mock.calls.length;
    test.provider.mockRejectedValue(new Error('TEST 原消息已虚拟卸载'));
    const nav = navigation(test); await nav.open();
    expect(nav.reveal).toHaveBeenCalledOnce(); expect(nav.synchronize).not.toHaveBeenCalled(); expect(test.provider).toHaveBeenCalledTimes(priorReads);
    expect(nav.warnings).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled();
  });

  it.each(['no-message', 'wrong-message', 'new-run'] as const)('%s不会打开账号根页冒充原chat或保存错误定位', async (condition): Promise<void> => {
    const test = fixture(); test.service.updateRuntime({ taskId: test.read().id, status: 'paused', runtime: { stage: 'paused' } });
    if (condition === 'no-message') { delete test.page.source; test.page.snapshot.messages = []; }
    if (condition === 'wrong-message') test.page.snapshot.messages[0].text = test.page.snapshot.messages[0].rawText = 'TEST 其他用户请求';
    if (condition === 'new-run') test.provider.mockImplementationOnce(async (): Promise<CurrentCreationConversationReadback> => {
      const task = test.read(); test.replace({ ...task, runtime: { ...task.runtime!, runId: 'TEST-replaced-run', attempt: 2 } });
      return structuredClone(test.page);
    });
    const nav = navigation(test); await nav.open();
    expect(nav.reveal).not.toHaveBeenCalled(); expect(nav.synchronize).not.toHaveBeenCalled(); expect(test.writes).not.toHaveBeenCalled();
    expect(nav.warnings).toHaveBeenCalledOnce(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('provider等待期间画布来源步骤改变，即使原任务没变也不保存定位或显示旧来源', async (): Promise<void> => {
    const test = fixture(); let sourceCurrent = true;
    test.provider.mockImplementationOnce(async (): Promise<CurrentCreationConversationReadback> => {
      sourceCurrent = false; return structuredClone(test.page);
    });
    const nav = navigation(test, (): boolean => sourceCurrent); await nav.open();
    expect(test.writes).not.toHaveBeenCalled(); expect(nav.reveal).not.toHaveBeenCalled(); expect(nav.synchronize).not.toHaveBeenCalled();
    expect(nav.warnings).toHaveBeenCalledOnce();
  });
});
