/** 离线执行 BrowserPanel 真实只读恢复及收束函数；不发送、导航或伪造平台受理。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { PetStoryPlan, PetStoryProject, Task } from '@doubao-studio/contracts';
import { isBackgroundPetStoryTask } from '../../src/utils/petstoryBackground';
import { requiresSubmissionReconciliation, verifiedSubmissionConversationUrl } from '../../src/utils/realSendStateMachine';
import { diagnoseCreationReadback, inspectCreationReadback, inspectSubmittedImageReadback, type ChatPageSnapshot } from '../../src/utils/chatReadback';
import { waitForSubmittedCreationReadback, type SubmittedCreationReadbackOptions, type SubmittedCreationReadbackSample } from '../../src/utils/submittedCreationReadback';
import { canSelectAccount, findInteractiveAccountId } from '../../src/utils/interactiveAccount';
import { syncTaskConversation, type ConversationSyncPageSnapshot, type ConversationSyncResult } from '../../src/utils/conversationSync';
import { isSameDoubaoConversation, normalizeDoubaoConversationUrl, resolveTaskConversationTarget, supportsDoubaoConversationLocator } from '../../src/utils/taskConversationLocator';
import { mediaSubmissionReceiptFor } from '../../src/utils/mediaSubmissionReceipt';
import type { CurrentCreationConversationReadback } from '../../src/utils/creationConversationIdentity';
import { inspectImageArtifactReadback, type ImageArtifactReadbackContext, type ImageArtifactObservationOptions } from '../../src/utils/imageArtifactReadback';
import { getTaskExecutionScope, tasksExecutionConflict } from '../../src/utils/taskExecutionScope';
import { MaterialImagePages } from '../../src/utils/materialImagePages';
import original from '../fixtures/storyboard-five-shots.json';

type RuntimePatch = { status?: Task['status']; runtime?: Partial<NonNullable<Task['runtime']>>; errorInfo?: Task['errorInfo'] };
type ReconcileHandler = (event: Event) => Promise<void>;
class OfflineAccountPause extends Error { constructor(message: string, readonly code: string) { super(message); } }
function actualFunction<T>(name: string, bindings: Record<string, unknown>): T {
  const file = ts.createSourceFile('execution.tsx', ['src/components/BrowserPanel.tsx', 'src/automation/TaskRecoveryCoordinator.ts', 'src/automation/TaskExecutionCoordinator.ts', 'src/automation/taskExecutionSupport.ts'].map((file): string => fs.readFileSync(path.resolve(file), 'utf8').replace(/^export /gm, '')).join('\n'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let expression = '';
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) expression = node.initializer!.getText(file);
    if (ts.isFunctionDeclaration(node) && node.name?.getText(file) === name) expression = node.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file); if (!expression) throw new Error(`TEST: actual ${name} not found`);
  const script = ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(script, { ...bindings, Error, Date, AbortController, DOMException, CustomEvent, setTimeout, clearTimeout }) as T;
}

function fixture(): {
  current: () => Task; replace: (task: Task) => void; bindings: Record<string, unknown>; event: Event;
  writes: ReturnType<typeof vi.fn>; errors: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn>; view: { getURL: ReturnType<typeof vi.fn>; loadURL: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn>; sendInputEvent: ReturnType<typeof vi.fn> };
  promises: { current: Map<string, Promise<void>> };
  guard: { current: Set<string> }; controllers: { current: Map<string, AbortController> }; handler: (override?: ReconcileHandler) => ReconcileHandler;
} {
  const now = '2026-10-30T08:30:00.000Z';
  let current: Task = { id: 'TEST-stopped-image', projectId: 'TEST-studio', assignedAccountId: 'TEST-account', mode: 'image', status: 'manual_submission_observing',
    prompt: original.plan.shots[0].prompts.firstFrame.final, result: null, outputs: [], createdAt: now, updatedAt: now,
    petstory: { projectId: 'TEST-project', stepId: 'TEST-step' }, runtime: { runId: 'TEST-original-run', attempt: 1, stage: 'manual_submission_observing', message: 'TEST 原提交只读核对',
      startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, input: { mode: 'image', prompt: original.plan.shots[0].prompts.firstFrame.final, attachments: [], petstory: { projectId: 'TEST-project', stepId: 'TEST-step' } } } };
  const project: PetStoryProject = { id: 'TEST-project', schemaVersion: 1, revision: 1, studioProjectId: 'TEST-studio', accountId: 'TEST-account', updatedAt: now,
    source: { kind: 'script', url: '', status: 'review_required' }, plan: structuredClone(original.plan) as PetStoryPlan, jobs: [], assets: [], imageOperations: [{
      id: 'TEST-operation', requestId: 'TEST-request', target: { materialId: 'TEST-material' }, taskId: current.id, mode: 'modify', stage: 'generating', createdAt: now, basisHash: 'TEST' }] };
  const writes = vi.fn(async (_id: string, patch: RuntimePatch): Promise<boolean> => {
    current = { ...current, ...patch, runtime: { ...current.runtime!, ...patch.runtime } }; return true;
  });
  const errors = vi.fn(); const guard = { current: new Set<string>() }; const controllers = { current: new Map<string, AbortController>() };
  const complete = vi.fn(async (_id: string, _accountId: string, _result: string, outputs: string[]): Promise<void> => {
    current = { ...current, status: 'done', outputs };
  });
  const promises = { current: new Map<string, Promise<void>>() };
  const view = { getURL: vi.fn((): string => 'https://www.doubao.com/chat/TEST-current'), loadURL: vi.fn(), reload: vi.fn(), sendInputEvent: vi.fn() };
  const selectAccount = vi.fn();
  type TaskProjection = { accountAutomationState: Record<string, string>; accountAutoMessage: Record<string, string> };
  const projection: TaskProjection = { accountAutomationState: {}, accountAutoMessage: {} };
  const bindings: Record<string, unknown> = {
    useTaskStore: { getState: (): object => ({ tasks: [current], ...projection, updateTaskRuntime: writes, completeAutomation: complete, setAccountAutomationState: vi.fn(),
      pauseAutomation: async (id: string, _accountId: string, text: string, options: { status: Task['status']; code: string }): Promise<boolean> => writes(id, {
        status: options.status, errorInfo: { code: options.code, message: text, recoverable: true, detectedAt: now }, runtime: { stage: 'waiting_verification', message: text },
      }),
    }), setState: (update: Partial<TaskProjection> | ((state: TaskProjection) => Partial<TaskProjection>)): void => {
      Object.assign(projection, typeof update === 'function' ? update(projection) : update);
    } }, usePetStoryStore: { getState: (): object => ({ project }) },
    useAccountStore: { getState: (): object => ({ accounts: [{ id: 'TEST-account', platform: 'doubao' }], selectAccount, recordAccountOutcome: vi.fn(async (): Promise<void> => undefined) }) },
    isBackgroundPetStoryTask, visibleRef: { current: false }, requiresSubmissionReconciliation, hasAccountChatAdjustment: (): boolean => false,
    resolveTaskConversationTarget, supportsDoubaoConversationLocator, normalizeDoubaoConversationUrl, isSameDoubaoConversation,
    inspectCreationReadback, inspectSubmittedImageReadback, diagnoseCreationReadback, verifiedSubmissionConversationUrl, mediaSubmissionReceiptFor,
    waitForSubmittedCreationReadback: vi.fn((options: SubmittedCreationReadbackOptions): Promise<SubmittedCreationReadbackSample> => {
      let elapsed = 0;
      return waitForSubmittedCreationReadback({ ...options, timeoutMs: 2000, now: (): number => elapsed,
        wait: async (ms: number): Promise<void> => { elapsed += ms; } });
    }),
    window: { dispatchEvent: vi.fn((): boolean => true), electronAPI: { logs: { append: vi.fn(async (): Promise<void> => undefined) } } },
    observeWithHumanVerification: async <T>(observe: (signal: AbortSignal) => Promise<T>, check: () => Promise<void>, signal?: AbortSignal): Promise<T> => {
      await check(); return observe(signal || new AbortController().signal);
    },
    waitForWebviewReady: vi.fn(async (): Promise<void> => undefined),
    readAcceptedImageOutputs: vi.fn(async (_view: unknown, _url: string, signal: AbortSignal, _timeout: number | undefined,
      context: ImageArtifactReadbackContext, options: ImageArtifactObservationOptions): Promise<string[]> => {
      if (!context || !options?.ensureCurrent || signal.aborted || context.runId !== current.runtime?.runId || context.prompt !== current.runtime.input.prompt) throw new Error('TEST missing original image context');
      options.ensureCurrent();
      const userMessageId = context.userMessageId || 'TEST-original-user';
      const readback = inspectImageArtifactReadback({ messages: [
        { role: 'user', text: context.prompt, messageId: userMessageId, ...(context.userTurnId ? { turnId: context.userTurnId } : {}) },
        { role: 'assistant', text: 'TEST 图片已生成', messageId: 'TEST-original-assistant', replyId: userMessageId,
          imageArtifactUrls: ['https://media.example/TEST-image.png'] } as ChatPageSnapshot['messages'][number],
      ], editorPresent: true, editorText: '', generating: false }, context);
      if (readback.reason !== 'ready') throw new Error('TEST strict original image card not ready');
      return readback.outputs;
    }),
    message: { error: errors, warning: vi.fn(), info: vi.fn(), success: vi.fn() },
    submissionReconcileRef: guard, submissionReconcilePromisesRef: promises, abortControllersRef: controllers, pendingCancellationStatusRef: { current: new Map<string, 'paused' | 'cancelled'>() }, submittedImagePagesRef: { current: new Map<string, object>() },
    automationEngine: { hasController: (): boolean => false }, canSelectAccount, findInteractiveAccountId,
    sleepWithAbort: actualFunction<(ms: number, signal: AbortSignal) => Promise<void>>('sleepWithAbort', { window: { setTimeout, clearTimeout } }),
    registryRef: { current: new Map([['TEST-account', view]]) }, loadingMapRef: { current: new Map([['TEST-account', false]]) },
    tasksExecutionConflict, getTaskExecutionScope,
    materialPagesRef: { current: new MaterialImagePages() }, poolRef: { current: null }, setViewedTaskPageId: vi.fn(),
    useCallback: <T>(callback: T): T => callback,
    waitForConversationNavigator: vi.fn(async (): Promise<typeof view> => view),
    getChatPageSnapshot: vi.fn(async (): Promise<object> => ({ messages: [], editorPresent: true, editorText: current.prompt, generating: false })),
    getCreationReadbackSnapshot: vi.fn(async (): Promise<ChatPageSnapshot> => ({ messages: [], editorPresent: true, editorText: '', generating: true })),
    getCurrentCreationConversation: vi.fn(async (): Promise<CurrentCreationConversationReadback> => ({
      snapshot: await (bindings.getChatPageSnapshot as () => Promise<ChatPageSnapshot>)(),
    })),
    openTaskConversation: vi.fn(),
    synchronizeConversation: vi.fn(async (_view: typeof view, targetUrl: string, isCurrent: () => boolean, trigger: 'explicit' | 'visibility', signal: AbortSignal): Promise<ConversationSyncResult> => syncTaskConversation({
      navigator: view, targetUrl, isCurrent, trigger, signal,
      readPageSnapshot: async (): Promise<ConversationSyncPageSnapshot> => ({ documentId: 'TEST-document', url: view.getURL(), ready: true,
        editorPresent: true, editorText: current.prompt, attachmentCount: 0, pendingUploads: false, generating: false, humanVerification: false, userInteracting: false }),
    })),
    conversationSyncMessage: (result: ConversationSyncResult): string => result.ok ? 'TEST 已同步' : `TEST 原会话未同步：${result.reason}`,
    assertNoHumanVerification: vi.fn(async (): Promise<void> => undefined), AccountAvailabilityPauseError: OfflineAccountPause,
  };
  // 运行真实路由/归属闭包；当前任务、账号和注册实例改变时仍须拒绝迟到结果。
  bindings.getTaskWebview = actualFunction('getTaskWebview', bindings);
  bindings.ownsTaskWebview = actualFunction('ownsTaskWebview', bindings);
  bindings.taskWebviewReady = actualFunction('taskWebviewReady', bindings);
  bindings.ensureTaskWebview = actualFunction('ensureTaskWebview', bindings);
  const handler = (override?: ReconcileHandler): ReconcileHandler => {
    const handleSubmissionReconcile = override || actualFunction<ReconcileHandler>('handleSubmissionReconcile', bindings);
    const runSubmissionReconcileSafely = actualFunction<ReconcileHandler>('runSubmissionReconcileSafely', { ...bindings, handleSubmissionReconcile });
    return actualFunction<ReconcileHandler>('handleSubmissionReconcileSafely', { ...bindings, runSubmissionReconcileSafely });
  };
  return { current: (): Task => current, replace: (task: Task): void => { current = task; }, bindings, writes, errors, complete, view, guard, controllers, promises, handler,
    event: { type: 'reconcile-task-submission', detail: { taskId: current.id, useCurrentPage: true } } as unknown as Event };
}

describe('图片只读恢复预检退出后的真实状态收束', (): void => {
  const publishedImage = (prompt: string): ChatPageSnapshot => ({
    messages: [{ role: 'user', text: prompt, rawText: prompt }], editorPresent: false, editorText: '', generating: true,
  });
  const providerImage = (prompt: string, conversationId: string = 'TEST-provider-original'): CurrentCreationConversationReadback => ({
    source: 'published_message', conversationId, conversationUrl: `https://www.doubao.com/chat/${conversationId}`,
    messageIds: ['TEST-original-user', 'TEST-original-assistant'], snapshot: { historyComplete: true, conversationId,
      messages: [{ role: 'user', text: `生成图片：${prompt}`, rawText: `生成图片：${prompt}`, messageId: 'TEST-original-user' },
        { role: 'assistant', text: 'TEST图片生成中', messageId: 'TEST-original-assistant', replyId: 'TEST-original-user' }],
      editorPresent: true, editorText: '', generating: true },
  });

  function recoveryPageHandlers(test: ReturnType<typeof fixture>): { inspect: ReconcileHandler; open: (event: Event) => void } {
    const originalImageAccount = actualFunction<(detail: object) => Task>('originalImageAccount', test.bindings);
    const revealImageAccount = actualFunction<(detail: object) => void>('revealImageAccount', { ...test.bindings, originalImageAccount });
    const bindings = { ...test.bindings, originalImageAccount, revealImageAccount };
    return { inspect: actualFunction<ReconcileHandler>('handleImageRecoveryPage', bindings), open: actualFunction<(event: Event) => void>('handleOpenImageAccount', bindings) };
  }
  function pageEvent(test: ReturnType<typeof fixture>, onResult?: (result: { ready: boolean; message?: string }) => void): Event {
    const task = test.current();
    return { type: onResult ? 'inspect-image-task-recovery-page' : 'open-image-task-account', detail: { taskId: task.id,
      accountId: task.assignedAccountId, runId: task.runtime?.runId, submittedAt: task.runtime?.submittedAt, ...(onResult ? { onResult } : {}) } } as unknown as Event;
  }

  it('重启后旧任务停空根页时先返回原会话未定位，不启动60秒观察或改写任务', async (): Promise<void> => {
    const test = fixture(); test.view.getURL.mockReturnValue('https://www.doubao.com/chat/');
    test.replace({ ...test.current(), status: 'paused' }); const onResult = vi.fn();
    await recoveryPageHandlers(test).inspect(pageEvent(test, onResult));
    expect(onResult).toHaveBeenCalledExactlyOnceWith({ ready: false, message: '原会话未定位，请在原账号历史中打开这次图片对话后继续' });
    expect(test.bindings.waitForSubmittedCreationReadback).not.toHaveBeenCalled(); expect(test.bindings.readAcceptedImageOutputs).not.toHaveBeenCalled();
    expect(test.writes).not.toHaveBeenCalled(); expect(test.complete).not.toHaveBeenCalled(); expect(test.current().status).toBe('paused');
    expect(test.controllers.current.size).toBe(0); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('缺定位旧图片任务可以直接展开原账号，保留现场且不启动恢复或发送', (): void => {
    const test = fixture(); const before = structuredClone(test.current()); test.view.getURL.mockReturnValue('https://www.doubao.com/chat/');
    recoveryPageHandlers(test).open(pageEvent(test));
    const accounts = test.bindings.useAccountStore as { getState: () => { selectAccount: ReturnType<typeof vi.fn> } };
    expect(accounts.getState().selectAccount).toHaveBeenCalledExactlyOnceWith('TEST-account');
    const events = test.bindings.window as { dispatchEvent: ReturnType<typeof vi.fn> };
    expect(events.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'reveal-workspace-browser' }));
    expect(test.bindings.getCurrentCreationConversation).not.toHaveBeenCalled(); expect(test.bindings.waitForSubmittedCreationReadback).not.toHaveBeenCalled();
    expect(test.writes).not.toHaveBeenCalled(); expect(test.current()).toEqual(before); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('根页存在完整真实provider时预检允许继续，但预检本身不改变任务或收取图片', async (): Promise<void> => {
    const test = fixture(); test.view.getURL.mockReturnValue('https://www.doubao.com/chat/local_TEST');
    test.bindings.getCurrentCreationConversation = vi.fn(async (): Promise<CurrentCreationConversationReadback> => providerImage(test.current().prompt));
    const onResult = vi.fn(); await recoveryPageHandlers(test).inspect(pageEvent(test, onResult));
    expect(onResult).toHaveBeenCalledExactlyOnceWith({ ready: true }); expect(test.writes).not.toHaveBeenCalled(); expect(test.complete).not.toHaveBeenCalled();
    expect(test.bindings.waitForSubmittedCreationReadback).not.toHaveBeenCalled(); expect(test.bindings.readAcceptedImageOutputs).not.toHaveBeenCalled();
  });

  it.each(['https://www.doubao.com/chat/', 'https://www.doubao.com/chat/local_TEST'] as const)('地址栏%s尚未具体化，真实provider全文可先保存原媒体收据再收取严格图片卡', async (route): Promise<void> => {
    const test = fixture(); const before = structuredClone(test.current().runtime); test.view.getURL.mockReturnValue(route);
    const page = providerImage(test.current().prompt);
    test.bindings.getCurrentCreationConversation = vi.fn(async (): Promise<CurrentCreationConversationReadback> => page);
    await test.handler()(test.event);
    expect(test.current().status).toBe('done'); expect(test.complete).toHaveBeenCalledTimes(1);
    expect(test.current().runtime?.mediaSubmissionReceipt).toMatchObject({ schemaVersion: 1, source: 'published_message',
      runId: before?.runId, accountId: 'TEST-account', submittedAt: before?.submittedAt, conversationUrl: page.conversationUrl, userMessageId: 'TEST-original-user' });
    expect(test.current().runtime?.conversationUrl).toBe(page.conversationUrl);
    expect(test.current().runtime?.input).toEqual(before?.input);
    expect(test.writes.mock.calls.some((call): boolean => call[1].status === 'generating')).toBe(false);
    const receiptWrite = test.writes.mock.calls.findIndex((call): boolean => !!call[1].runtime?.mediaSubmissionReceipt);
    expect(receiptWrite).toBeGreaterThanOrEqual(0);
    expect(test.writes.mock.invocationCallOrder[receiptWrite]).toBeLessThan(test.complete.mock.invocationCallOrder[0]);
    expect(test.bindings.readAcceptedImageOutputs).toHaveBeenCalledWith(test.view, page.conversationUrl, expect.any(AbortSignal), undefined,
      expect.objectContaining({ prompt: test.current().prompt, runId: before?.runId, userMessageId: 'TEST-original-user' }), expect.objectContaining({ ensureCurrent: expect.any(Function) }));
    expect(test.view.reload).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('地址栏临时页但provider全文与原输入不同，不保存收据或领取当前页图片', async (): Promise<void> => {
    const test = fixture(); test.view.getURL.mockReturnValue('https://www.doubao.com/chat/local_TEST');
    test.bindings.getCurrentCreationConversation = vi.fn(async (): Promise<CurrentCreationConversationReadback> => providerImage('TEST 无关历史图片请求'));
    await test.handler()(test.event);
    expect(test.current().status).toBe('paused'); expect(test.current().runtime?.mediaSubmissionReceipt).toBeUndefined();
    expect(test.current().runtime?.conversationUrl).toBeUndefined(); expect(test.complete).not.toHaveBeenCalled();
    expect(test.bindings.readAcceptedImageOutputs).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('跨重启保存的媒体消息收据沿原messageId恢复，后续聊天不重新触发整会话唯一全文门槛', async (): Promise<void> => {
    const test = fixture(); const originalRuntime = test.current().runtime!; const conversationUrl = test.view.getURL();
    const receipt: NonNullable<NonNullable<Task['runtime']>['mediaSubmissionReceipt']> = { schemaVersion: 1, source: 'published_message',
      runId: originalRuntime.runId, accountId: 'TEST-account', submittedAt: originalRuntime.submittedAt!, conversationUrl,
      userMessageId: 'TEST-original-user', observedAt: originalRuntime.submittedAt! };
    test.replace({ ...test.current(), runtime: { ...originalRuntime, mediaSubmissionReceipt: receipt } });
    const laterPage = providerImage(test.current().prompt, 'TEST-current');
    laterPage.snapshot.messages.push({ role: 'user', text: 'TEST后续无关自由聊天', messageId: 'TEST-later-user' },
      { role: 'assistant', text: 'TEST后续回复', messageId: 'TEST-later-assistant', replyId: 'TEST-later-user' });
    laterPage.messageIds!.push('TEST-later-user', 'TEST-later-assistant');
    expect(inspectCreationReadback(laterPage.snapshot, test.current().prompt, 'image', 0).promptPublished).toBe(false);
    test.bindings.getCurrentCreationConversation = vi.fn(async (): Promise<CurrentCreationConversationReadback> => laterPage);
    await test.handler()({ type: test.event.type, detail: { taskId: test.current().id } } as unknown as Event);
    expect(test.current().status).toBe('done'); expect(test.current().outputs).toEqual(['https://media.example/TEST-image.png']);
    expect(test.bindings.waitForSubmittedCreationReadback).not.toHaveBeenCalled(); expect(test.bindings.getCurrentCreationConversation).not.toHaveBeenCalled();
    expect(test.bindings.readAcceptedImageOutputs).toHaveBeenCalledWith(test.view, conversationUrl, expect.any(AbortSignal), undefined,
      expect.objectContaining({ prompt: originalRuntime.input.prompt, runId: receipt.runId, userMessageId: receipt.userMessageId }),
      expect.objectContaining({ ensureCurrent: expect.any(Function) }));
    expect(test.current().runtime?.mediaSubmissionReceipt).toEqual(receipt);
    expect(test.view.reload).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each([false, true])('旧图片任务缺收据且已有后续消息时，一次扫描定位唯一原全文并保存消息身份（已有URL=%s）', async (knownUrl: boolean): Promise<void> => {
    const test = fixture(); const before = structuredClone(test.current().runtime!);
    const page = providerImage(test.current().prompt, 'TEST-current');
    page.snapshot.generating = false;
    page.snapshot.editorText = 'TEST 用户后续草稿';
    page.snapshot.messages.push({ role: 'user', text: '', messageId: 'TEST-later-user' },
      { role: 'assistant', text: '', messageId: 'TEST-later-assistant', replyId: 'TEST-later-user' });
    page.messageIds!.push('TEST-later-user', 'TEST-later-assistant');
    if (knownUrl) test.replace({ ...test.current(), runtime: { ...test.current().runtime!, conversationUrl: test.view.getURL() } });
    test.bindings.getCurrentCreationConversation = vi.fn(async (): Promise<CurrentCreationConversationReadback> => page);
    await test.handler()(test.event);
    expect(test.current().status).toBe('done'); expect(test.complete).toHaveBeenCalledOnce();
    expect(test.bindings.getCurrentCreationConversation).toHaveBeenCalledOnce();
    expect(test.current().runtime?.mediaSubmissionReceipt).toMatchObject({ runId: before.runId, submittedAt: before.submittedAt,
      userMessageId: 'TEST-original-user', conversationUrl: page.conversationUrl });
    expect(test.current().runtime?.input).toEqual(before.input);
    expect(test.bindings.readAcceptedImageOutputs).toHaveBeenCalledWith(test.view, page.conversationUrl, expect.any(AbortSignal), undefined,
      expect.objectContaining({ userMessageId: 'TEST-original-user' }), expect.objectContaining({ ensureCurrent: expect.any(Function) }));
    expect(test.bindings.synchronizeConversation).not.toHaveBeenCalled();
    expect(test.view.reload).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
    expect(test.errors).not.toHaveBeenCalled();
  });

  it('原要求先返回文字方案，已有生成图片指令及三候选沿原任务恢复，不再发送', async (): Promise<void> => {
    const test = fixture(); const before = structuredClone(test.current().runtime!);
    const page = providerImage(test.current().prompt, 'TEST-current');
    const outputs = [1, 2, 3].map((index: number): string => `https://media.example/TEST-original-${index}.png`);
    page.snapshot.generating = false;
    page.snapshot.messages[1].text = 'TEST 原图片方案';
    page.snapshot.messages.push({ role: 'user', text: '生成图片', messageId: 'TEST-image-command' },
      { role: 'assistant', text: 'TEST 已生成三张图片', messageId: 'TEST-image-result', replyId: 'TEST-image-command', imageArtifactUrls: outputs, imageArtifactPending: false });
    page.messageIds!.push('TEST-image-command', 'TEST-image-result');
    test.bindings.getCurrentCreationConversation = vi.fn(async (): Promise<CurrentCreationConversationReadback> => page);
    test.bindings.readAcceptedImageOutputs = vi.fn(async (_view: unknown, _url: string, _signal: AbortSignal, _timeout: number | undefined,
      context: ImageArtifactReadbackContext, options: ImageArtifactObservationOptions): Promise<string[]> => {
      options.ensureCurrent();
      const evidence = inspectImageArtifactReadback(page.snapshot, context);
      if (evidence.reason !== 'ready') throw new Error('TEST 原生成指令的三张图未定位');
      return evidence.outputs;
    });
    await test.handler()(test.event);
    expect(test.current().status).toBe('done'); expect(test.current().outputs).toEqual(outputs);
    expect(test.current().runtime?.mediaSubmissionReceipt?.userMessageId).toBe('TEST-original-user');
    expect(test.current().runtime?.runId).toBe(before.runId); expect(test.current().runtime?.submittedAt).toBe(before.submittedAt);
    expect(test.current().runtime?.input).toEqual(before.input);
    expect(test.bindings.getCurrentCreationConversation).toHaveBeenCalledOnce();
    expect(test.view.reload).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('已有耐久收据且地址栏仍是local_时，部分provider同原会话可原位核对，不刷新或把部分模型升级成新收据', async (): Promise<void> => {
    const test = fixture(); const runtime = test.current().runtime!; const conversationUrl = 'https://www.doubao.com/chat/TEST-provider-original';
    const receipt: NonNullable<NonNullable<Task['runtime']>['mediaSubmissionReceipt']> = { schemaVersion: 1, source: 'published_message',
      runId: runtime.runId, accountId: 'TEST-account', submittedAt: runtime.submittedAt!, conversationUrl,
      userMessageId: 'TEST-original-user', observedAt: runtime.submittedAt! };
    test.replace({ ...test.current(), runtime: { ...runtime, mediaSubmissionReceipt: receipt } });
    test.view.getURL.mockReturnValue('https://www.doubao.com/chat/local_TEST');
    test.bindings.getCurrentCreationConversation = vi.fn(async (): Promise<CurrentCreationConversationReadback> => ({
      conversationId: 'TEST-provider-original', conversationUrl, messageIds: ['TEST-original-assistant'], reason: 'message_models_incomplete',
      snapshot: { historyComplete: false, conversationId: 'TEST-provider-original', messages: [
        { role: 'assistant', text: 'TEST图片生成中', messageId: 'TEST-original-assistant', replyId: 'TEST-original-user' },
      ], editorPresent: true, editorText: '', generating: true },
    }));
    await test.handler()({ type: test.event.type, detail: { taskId: test.current().id } } as unknown as Event);
    expect(test.current().status).toBe('done'); expect(test.bindings.getCurrentCreationConversation).toHaveBeenCalledOnce();
    expect(test.bindings.waitForSubmittedCreationReadback).not.toHaveBeenCalled(); expect(test.bindings.synchronizeConversation).not.toHaveBeenCalled();
    expect(test.bindings.readAcceptedImageOutputs).toHaveBeenCalledWith(test.view, conversationUrl, expect.any(AbortSignal), undefined,
      expect.objectContaining({ runId: receipt.runId, userMessageId: receipt.userMessageId }), expect.objectContaining({ ensureCurrent: expect.any(Function) }));
    expect(test.writes.mock.calls.every((call): boolean => !call[1].runtime?.mediaSubmissionReceipt)).toBe(true);
    expect(test.current().runtime?.mediaSubmissionReceipt).toEqual(receipt); expect(test.view.getURL()).toBe('https://www.doubao.com/chat/local_TEST');
    expect(test.view.reload).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('自动接力缺URL且正文延迟挂载时，一次观察持续补证并收取原图片，不刷新或发送', async (): Promise<void> => {
    const test = fixture(); const before = structuredClone(test.current().runtime);
    (test.bindings.submittedImagePagesRef as { current: Map<string, object> }).current.set(test.current().id, {
      accountId: test.current().assignedAccountId, runId: before?.runId, submittedAt: before?.submittedAt,
      webview: test.view, conversationUrl: test.view.getURL(),
    });
    let samples = 0;
    test.bindings.getCreationReadbackSnapshot = vi.fn(async (): Promise<ChatPageSnapshot> => ++samples < 3
      ? { messages: [], editorPresent: false, editorText: '', generating: true } : publishedImage(test.current().prompt));
    await test.handler()({ type: test.event.type, detail: { taskId: test.current().id, useCurrentPage: true, automatic: true } } as unknown as Event);
    expect(samples).toBe(3); expect(test.current().status).toBe('done'); expect(test.complete).toHaveBeenCalledTimes(1);
    expect(test.current().runtime?.conversationUrl).toBe(test.view.getURL());
    expect(test.current().runtime?.runId).toBe(before?.runId); expect(test.current().runtime?.submittedAt).toBe(before?.submittedAt);
    expect(test.current().runtime?.input).toEqual(before?.input); expect(test.errors).not.toHaveBeenCalled();
    expect(test.bindings.synchronizeConversation).not.toHaveBeenCalled(); expect(test.view.reload).not.toHaveBeenCalled();
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
    expect(test.guard.current.size).toBe(0); expect(test.controllers.current.size).toBe(0); expect(test.promises.current.size).toBe(0);
  });

  it('自动缺URL恢复不能仅凭当前历史会话的相同全文认领旧图', async (): Promise<void> => {
    const test = fixture();
    test.bindings.getCreationReadbackSnapshot = vi.fn(async (): Promise<ChatPageSnapshot> => publishedImage(test.current().prompt));
    await test.handler()({ type: test.event.type, detail: { taskId: test.current().id, useCurrentPage: true, automatic: true } } as unknown as Event);
    expect(test.current().status).toBe('paused'); expect(test.current().errorInfo?.message).toContain('尚未确认当前页面属于原图片运行');
    expect(test.current().runtime?.conversationUrl).toBeUndefined(); expect(test.complete).not.toHaveBeenCalled();
    expect(test.bindings.getCreationReadbackSnapshot).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('具体原会话路由稍晚出现时，同一次继续等待路由和全文，不要求重复点击', async (): Promise<void> => {
    const test = fixture(); test.view.getURL.mockReturnValue('https://www.doubao.com/chat/local_TEST');
    test.bindings.getChatPageSnapshot = vi.fn(async (): Promise<ChatPageSnapshot> => {
      test.view.getURL.mockReturnValue('https://www.doubao.com/chat/TEST-current');
      return publishedImage(test.current().prompt);
    });
    test.bindings.getCreationReadbackSnapshot = vi.fn(async (): Promise<ChatPageSnapshot> => publishedImage(test.current().prompt));
    await test.handler()(test.event);
    expect(test.current().status).toBe('done'); expect(test.complete).toHaveBeenCalledTimes(1);
    expect(test.current().runtime?.conversationUrl).toBe('https://www.doubao.com/chat/TEST-current');
    expect(test.view.reload).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('已有原会话定位时可安全导航回目标，不把起始的其他会话误当作原页面', async (): Promise<void> => {
    const test = fixture(); const targetUrl = 'https://www.doubao.com/chat/TEST-original';
    test.replace({ ...test.current(), runtime: { ...test.current().runtime!, conversationUrl: targetUrl } });
    test.bindings.synchronizeConversation = vi.fn(async (): Promise<{ ok: true }> => {
      test.view.getURL.mockReturnValue(targetUrl); return { ok: true };
    });
    test.bindings.getCreationReadbackSnapshot = vi.fn(async (): Promise<ChatPageSnapshot> => publishedImage(test.current().prompt));
    await test.handler()(test.event);
    expect(test.bindings.synchronizeConversation).toHaveBeenCalledTimes(1); expect(test.complete).toHaveBeenCalledTimes(1);
    expect(test.current().status).toBe('done'); expect(test.current().runtime?.conversationUrl).toBe(targetUrl);
    expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('用户取消同run后迟到图片不得改成完成或覆盖取消状态', async (): Promise<void> => {
    const test = fixture(); test.bindings.getCreationReadbackSnapshot = vi.fn(async (): Promise<ChatPageSnapshot> => publishedImage(test.current().prompt));
    test.bindings.readAcceptedImageOutputs = vi.fn(async (): Promise<string[]> => {
      test.replace({ ...test.current(), status: 'cancelled' }); test.controllers.current.get(test.current().id)?.abort();
      return ['https://media.example/TEST-late-image.png'];
    });
    await test.handler()(test.event);
    expect(test.current().status).toBe('cancelled'); expect(test.complete).not.toHaveBeenCalled(); expect(test.current().outputs).toEqual([]);
  });

  it('读取原全文期间换run、会话或页面实例时不保存定位、不绑定产物', async (): Promise<void> => {
    for (const change of ['run', 'conversation', 'webview'] as const) {
      const test = fixture();
      test.bindings.getCreationReadbackSnapshot = vi.fn(async (): Promise<ChatPageSnapshot> => {
        if (change === 'run') test.replace({ ...test.current(), runtime: { ...test.current().runtime!, runId: 'TEST-new-run' } });
        else if (change === 'conversation') test.view.getURL.mockReturnValue('https://www.doubao.com/chat/TEST-another');
        else (test.bindings.registryRef as { current: Map<string, typeof test.view> }).current.set('TEST-account', { ...test.view });
        return publishedImage(test.current().prompt);
      });
      await test.handler()(test.event);
      expect(test.current().runtime?.conversationUrl).toBeUndefined(); expect(test.complete).not.toHaveBeenCalled();
      expect(test.current().outputs).toEqual([]); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
      if (change === 'run') expect(test.writes).not.toHaveBeenCalled();
    }
  });

  it('原执行器正在释放时同一次恢复等待交接，再启动一次观察', async (): Promise<void> => {
    const test = fixture(); let checks = 0;
    test.bindings.automationEngine = { hasController: (): boolean => checks++ === 0 };
    const observe = vi.fn(async (): Promise<void> => { test.replace({ ...test.current(), status: 'done' }); });
    await test.handler(observe)(test.event);
    expect(checks).toBeGreaterThan(1); expect(observe).toHaveBeenCalledTimes(1); expect(test.current().status).toBe('done');
    expect(test.controllers.current.size).toBe(0); expect(test.promises.current.size).toBe(0);
  });

  it('等待旧执行器交接期间可取消，取消后不启动观察或覆盖状态', async (): Promise<void> => {
    const test = fixture(); test.bindings.automationEngine = { hasController: (): boolean => true };
    const observe = vi.fn(async (): Promise<void> => undefined);
    const pending = test.handler(observe)(test.event);
    expect(test.controllers.current.has(test.current().id)).toBe(true);
    test.replace({ ...test.current(), status: 'cancelled' }); test.controllers.current.get(test.current().id)?.abort();
    await pending;
    expect(observe).not.toHaveBeenCalled(); expect(test.current().status).toBe('cancelled'); expect(test.writes).not.toHaveBeenCalled();
    expect(test.controllers.current.size).toBe(0); expect(test.promises.current.size).toBe(0);
  });

  it.each(['root', 'unpublished'] as const)('%s页面无法证明原图片已发布时恢复暂停，保留原run、提交意图与草稿', async (failure: string): Promise<void> => {
    const test = fixture(); const before = structuredClone(test.current());
    if (failure === 'root') test.view.getURL.mockReturnValue('https://www.doubao.com/chat/');
    await test.handler()(test.event);
    expect(test.current().status).toBe('paused'); expect(test.current().errorInfo?.code).toBe('submission_uncertain');
    expect(test.current().runtime?.runId).toBe(before.runtime?.runId); expect(test.current().runtime?.submittedAt).toBe(before.runtime?.submittedAt);
    expect(test.current().runtime?.input).toEqual(before.runtime?.input); expect(test.current().prompt).toBe(before.prompt);
    expect(test.writes).toHaveBeenCalledTimes(1); expect(test.guard.current.size).toBe(0); expect(test.controllers.current.size).toBe(0);
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
    expect(test.bindings.openTaskConversation).not.toHaveBeenCalled();
  });

  it('账号页面预检抛出错误也收束暂停，不留下没有控制器的永久观察状态', async (): Promise<void> => {
    const test = fixture(); test.bindings.waitForConversationNavigator = vi.fn(async (): Promise<never> => { throw new Error('TEST page unavailable'); });
    await test.handler()(test.event);
    expect(test.current().status).toBe('paused'); expect(test.guard.current.size).toBe(0); expect(test.controllers.current.size).toBe(0);
    expect(test.current().runtime?.runId).toBe('TEST-original-run'); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('原账号缺失的提前返回也持久化暂停并释放恢复守卫', async (): Promise<void> => {
    const test = fixture(); test.bindings.useAccountStore = { getState: (): object => ({ accounts: [] }) };
    await test.handler()(test.event);
    expect(test.current().status).toBe('paused'); expect(test.guard.current.size).toBe(0); expect(test.writes).toHaveBeenCalledTimes(1);
    expect(test.current().errorInfo?.message).toContain('缺少原账号');
    expect(test.current().errorInfo?.message).not.toContain('原任务提交尚未核对');
  });

  it('只读恢复原结果也不得导航丢弃另一个自由聊天草稿', async (): Promise<void> => {
    const test = fixture();
    test.replace({ ...test.current(), runtime: { ...test.current().runtime!, conversationUrl: 'https://www.doubao.com/chat/TEST-original' } });
    await test.handler()(test.event);
    expect(test.current().status).toBe('paused'); expect(test.current().runtime?.submittedAt).toBeTruthy();
    expect(test.bindings.openTaskConversation).not.toHaveBeenCalled();
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
    expect(test.guard.current.size).toBe(0); expect(test.controllers.current.size).toBe(0);
  });

  it('用户主动查看其他账号时，后台恢复不切账号或抢占输入', async (): Promise<void> => {
    const test = fixture(); const select = vi.fn();
    test.bindings.visibleRef = { current: true };
    test.bindings.useAccountStore = { getState: (): object => ({ accounts: [{ id: 'TEST-account', platform: 'doubao' }], selectedAccountId: 'TEST-free-chat-account', selectAccount: select }) };
    await test.handler()(test.event);
    expect(test.current().status).toBe('paused'); expect(select).not.toHaveBeenCalled();
    expect(test.bindings.openTaskConversation).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled();
    expect(test.view.sendInputEvent).not.toHaveBeenCalled(); expect(test.guard.current.size).toBe(0);
  });

  it('已有恢复守卫时忽略重复事件，不打断正在执行的预检或观察器', async (): Promise<void> => {
    const test = fixture(); test.guard.current.add(test.current().id); const existing = vi.fn(async (): Promise<void> => {});
    await test.handler(existing)(test.event);
    expect(existing).not.toHaveBeenCalled(); expect(test.writes).not.toHaveBeenCalled(); expect(test.current().status).toBe('manual_submission_observing');
  });

  it('观察器尚未结束时保持等待，不抢先写回暂停', async (): Promise<void> => {
    const test = fixture(); let release: (() => void) | undefined;
    const existing = async (): Promise<void> => {
      test.guard.current.add(test.current().id); test.controllers.current.set(test.current().id, new AbortController());
      await new Promise<void>((resolve): void => { release = resolve; });
    };
    const pending = test.handler(existing)(test.event); await Promise.resolve();
    expect(test.writes).not.toHaveBeenCalled(); expect(test.current().status).toBe('manual_submission_observing');
    release?.(); await pending;
    expect(test.writes).not.toHaveBeenCalled(); expect(test.controllers.current.size).toBe(1);
  });

  it('同task重复事件共享一次真实观察，结束并释放全部守卫后才通知各自onSettled', async (): Promise<void> => {
    const test = fixture(); let release!: () => void;
    const existing = vi.fn(async (): Promise<void> => {
      test.guard.current.add(test.current().id);
      await new Promise<void>((resolve): void => { release = resolve; });
      test.replace({ ...test.current(), status: 'done' }); test.guard.current.delete(test.current().id);
    });
    const settled = vi.fn(async (): Promise<void> => {
      expect(test.current().status).toBe('done'); expect(test.controllers.current.size).toBe(0);
      expect(test.guard.current.size).toBe(0); expect(test.promises.current.size).toBe(0);
    });
    const event = { type: test.event.type, detail: { taskId: test.current().id, onSettled: settled } } as unknown as Event;
    const handler = test.handler(existing); const first = handler(event); const second = handler(event);
    expect(existing).toHaveBeenCalledTimes(1); expect(test.promises.current.size).toBe(1); expect(test.controllers.current.size).toBe(1);
    expect(settled).not.toHaveBeenCalled(); expect(test.writes).not.toHaveBeenCalled();
    release(); await Promise.all([first, second]);
    expect(existing).toHaveBeenCalledTimes(1); expect(settled).toHaveBeenCalledTimes(2); expect(test.writes).not.toHaveBeenCalled();
  });

  it('onSettled等待真实finally中的异步验证和暂停写盘完成', async (): Promise<void> => {
    const test = fixture(); let releaseVerification!: () => void;
    const verification = vi.fn((): Promise<void> => new Promise<void>((resolve): void => { releaseVerification = resolve; }));
    test.bindings.assertNoHumanVerification = verification;
    const settled = vi.fn((): void => {
      expect(test.current().status).toBe('paused'); expect(test.writes).toHaveBeenCalledTimes(1);
      expect(test.guard.current.size).toBe(0); expect(test.controllers.current.size).toBe(0); expect(test.promises.current.size).toBe(0);
    });
    const event = { type: test.event.type, detail: { taskId: test.current().id, onSettled: settled } } as unknown as Event;
    const pending = test.handler(async (): Promise<void> => { test.guard.current.add(test.current().id); })(event);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(verification).toHaveBeenCalledTimes(1); expect(settled).not.toHaveBeenCalled(); expect(test.writes).not.toHaveBeenCalled();
    releaseVerification(); await pending; expect(settled).toHaveBeenCalledTimes(1);
  });

  it('账号页面尚未就绪时已有可取消controller；取消立即退出且不刷新或覆盖用户取消状态', async (): Promise<void> => {
    const test = fixture(); let entered = false;
    test.bindings.waitForConversationNavigator = vi.fn(async (_get: () => unknown, options: { wait: (ms: number) => Promise<void> }): Promise<typeof test.view> => {
      entered = true; expect(test.controllers.current.has(test.current().id)).toBe(true);
      await options.wait(30_000); return test.view;
    });
    const settled = vi.fn(); const event = { type: test.event.type, detail: { taskId: test.current().id, useCurrentPage: true, onSettled: settled } } as unknown as Event;
    const pending = test.handler()(event); expect(entered).toBe(true);
    test.replace({ ...test.current(), status: 'cancelled' }); test.controllers.current.get(test.current().id)!.abort();
    await pending;
    expect(test.current().status).toBe('cancelled'); expect(test.writes).not.toHaveBeenCalled(); expect(test.bindings.synchronizeConversation).not.toHaveBeenCalled();
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.reload).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
    expect(test.guard.current.size).toBe(0); expect(test.controllers.current.size).toBe(0); expect(test.promises.current.size).toBe(0); expect(settled).toHaveBeenCalledTimes(1);
  });

  it('实际观察成功保存done后不被收束逻辑改回暂停', async (): Promise<void> => {
    const test = fixture();
    await test.handler(async (): Promise<void> => { test.replace({ ...test.current(), status: 'done' }); })(test.event);
    expect(test.current().status).toBe('done'); expect(test.writes).not.toHaveBeenCalled();
  });

  it('恢复期间run改变时不覆盖后来运行，只移除不再持有观察器的旧守卫', async (): Promise<void> => {
    const test = fixture();
    await test.handler(async (): Promise<void> => {
      test.guard.current.add(test.current().id);
      test.replace({ ...test.current(), runtime: { ...test.current().runtime!, runId: 'TEST-new-run' } });
    })(test.event);
    expect(test.current().runtime?.runId).toBe('TEST-new-run'); expect(test.writes).not.toHaveBeenCalled(); expect(test.guard.current.size).toBe(0);
  });

  it('非PetStory且不属于图片操作的普通任务保持原处理边界', async (): Promise<void> => {
    const test = fixture(); test.replace({ ...test.current(), mode: 'video', petstory: undefined }); const existing = vi.fn(async (): Promise<void> => {});
    test.bindings.isBackgroundPetStoryTask = (): boolean => false;
    await test.handler(existing)(test.event);
    expect(existing).toHaveBeenCalledTimes(1); expect(test.writes).not.toHaveBeenCalled();
  });

  it.each(['image', 'video', 'chat'] as const)('PetStory %s恢复预检提前返回也收束原观察状态', async (mode): Promise<void> => {
    const test = fixture(); test.replace({ ...test.current(), mode });
    await test.handler(async (): Promise<void> => undefined)(test.event);
    expect(test.current().status).toBe('paused'); expect(test.current().runtime?.runId).toBe('TEST-original-run');
    expect(test.current().runtime?.submittedAt).toBeTruthy(); expect(test.controllers.current.size).toBe(0);
  });

  it('画布文字通过正式job关联，也能收束未启动的只读恢复', async (): Promise<void> => {
    const test = fixture(); test.replace({ ...test.current(), mode: 'chat', petstory: undefined });
    test.bindings.isBackgroundPetStoryTask = (): boolean => true;
    await test.handler(async (): Promise<void> => undefined)(test.event);
    expect(test.current().status).toBe('paused'); expect(test.current().runtime?.runId).toBe('TEST-original-run');
    expect(test.current().runtime?.submittedAt).toBeTruthy(); expect(test.controllers.current.size).toBe(0);
  });

  it.each(['image', 'video'] as const)('%s恢复遇到验证码只保留waiting_verification且不导航刷新', async (mode): Promise<void> => {
    const test = fixture(); test.replace({ ...test.current(), mode }); const before = structuredClone(test.current().runtime);
    test.bindings.assertNoHumanVerification = vi.fn(async (): Promise<never> => { throw new OfflineAccountPause('OFFLINE human verification', 'human_verification'); });
    await test.handler()(test.event);
    expect(test.current().status).toBe('waiting_verification'); expect(test.current().errorInfo?.code).toBe('human_verification');
    expect(test.current().runtime?.runId).toBe(before?.runId); expect(test.current().runtime?.submittedAt).toBe(before?.submittedAt);
    expect(test.bindings.openTaskConversation).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
    expect(test.guard.current.size).toBe(0);
  });
});
