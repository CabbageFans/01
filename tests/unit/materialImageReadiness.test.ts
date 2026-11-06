/** 离线运行真实执行入口和catch；输入区就绪由事件promise提供，不访问豆包或发送。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { AccountAvailability, PetStoryProject, Task } from '@doubao-studio/contracts';
import { availabilityBlocksAutomation } from '../../src/utils/accountAvailability';
import { getTaskExecutionScope, isMaterialImageTask, usesIndependentImagePage } from '../../src/utils/taskExecutionScope';
import { isBackgroundPetStoryTask } from '../../src/utils/petstoryBackground';
import { classifyTaskError } from '../../src/utils/taskRuntime';
import { HumanVerificationRequiredError } from '../../src/utils/humanVerification';
import { PetStoryControlError } from '../../src/utils/doubaoBridge';
import { VideoControlReadinessError } from '../../src/utils/videoControlReadiness';
import { ChatAttachmentUploadError } from '../../src/utils/chatAttachments';

type ExecuteAutomation = (accountId: string, taskId: string, prompt: string, mode: string, webview: object) => Promise<void>;
type RuntimePatch = Partial<Omit<Task, 'runtime'>> & { runtime?: Partial<NonNullable<Task['runtime']>> };
type PauseOptions = { status: Task['status']; code: string };

function actual<T>(name: string, bindings: Record<string, unknown> = {}): T {
  const file = ts.createSourceFile('BrowserPanel.tsx', fs.readFileSync(path.resolve('src/components/BrowserPanel.tsx'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let expression = '';
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) expression = node.initializer!.getText(file);
    if (ts.isClassDeclaration(node) && node.name?.getText(file) === name) expression = node.getText(file);
    if (ts.isFunctionDeclaration(node) && node.name?.getText(file) === name) expression = node.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file); if (!expression) throw new Error(`TEST actual ${name} not found`);
  const script = ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(script, { ...bindings, Error, Date, AbortController, DOMException, setTimeout, clearTimeout }) as T;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = (): void => { throw new Error('TEST promise not initialized'); };
  const promise = new Promise<T>((done): void => { resolve = done; }); return { promise, resolve };
}

function evidence(state: AccountAvailability['state'], reason: string): AccountAvailability {
  return { state, reason, message: `TEST ${reason}`, source: 'pre_task', checkedAt: '2026-11-05T00:00:00.000Z' };
}

interface FixtureOptions {
  mode?: 'chat' | 'image';
  target?: 'material' | 'firstFrame' | 'lastFrame';
  visible?: boolean;
}

function fixture(availability: AccountAvailability, options: FixtureOptions = {}): {
  run: () => Promise<void>; task: () => Task; readiness: ReturnType<typeof deferred<boolean>>; entered: Promise<void>;
  waitForChatReady: ReturnType<typeof vi.fn>; probe: ReturnType<typeof vi.fn>; newConversation: ReturnType<typeof vi.fn>;
  promotion: ReturnType<typeof vi.fn>;
  inject: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; failed: ReturnType<typeof vi.fn>;
  runtimeWrites: ReturnType<typeof vi.fn>; view: object; controllers: Map<string, AbortController>; running: Set<string>; gateRelease: ReturnType<typeof vi.fn>;
  visible: { current: boolean };
} {
  const now = '2026-11-05T00:00:00.000Z';
  const mode = options.mode || 'chat';
  const target = options.target || 'material';
  const binding = { projectId: 'TEST-project', jobId: 'TEST-job', imageOperationId: 'TEST-op', ...(target === 'material' ? { materialId: 'character:TEST-person' } : {}) };
  const productionBinding = { projectId: binding.projectId, stepId: 'TEST-step', imageOperationId: binding.imageOperationId, materialId: binding.materialId };
  let task: Task = { id: 'TEST-preparing-image', projectId: 'TEST-studio', assignedAccountId: 'TEST-account', mode, status: 'executing',
    prompt: 'TEST 图片操作的后台准备请求', ...(mode === 'chat' ? { petstoryChat: binding } : { petstory: productionBinding }), executionIntent: 'armed', promptReadback: 'exact', outputs: [], result: null,
    createdAt: now, updatedAt: now, runtime: { runId: 'TEST-run', attempt: 1, stage: 'preparing_account', message: '', startedAt: now,
      stageStartedAt: now, lastHeartbeatAt: now, input: { mode, prompt: 'TEST 图片操作的后台准备请求', attachments: [], ...(mode === 'image' ? { petstory: productionBinding } : {}) } } };
  const project: PetStoryProject = { id: 'TEST-project', schemaVersion: 1, revision: 1, studioProjectId: 'TEST-studio', accountId: 'TEST-account',
    source: { kind: 'script', url: '', status: 'review_required' }, assets: [], updatedAt: now,
    jobs: [{ id: binding.jobId, taskId: task.id, kind: 'materialPrompt', materialId: binding.materialId, status: 'bound', inputHash: 'TEST', sourceUrl: '', createdAt: now }],
    imageOperations: [{ id: binding.imageOperationId, requestId: 'TEST-request', target: target === 'material' ? { materialId: 'character:TEST-person' } : { shotId: 'TEST-shot', kind: target }, mode: 'generate', stage: mode === 'chat' ? 'preparing' : 'generating', basisHash: 'TEST', createdAt: now, chatJobId: binding.jobId, ...(mode === 'image' ? { taskId: task.id } : {}) }] };
  const readiness = deferred<boolean>(); const entered = deferred<void>();
  const view = { getURL: vi.fn((): string => 'https://www.doubao.com/chat/'), executeJavaScript: vi.fn(), loadURL: vi.fn(), sendInputEvent: vi.fn() };
  const waitForChatReady = vi.fn(async (): Promise<boolean> => { entered.resolve(); return readiness.promise; });
  const probe = vi.fn(async (): Promise<AccountAvailability> => availability);
  const promotion = vi.fn(async (): Promise<string> => 'none');
  const newConversation = vi.fn(async (): Promise<{ ok: false; reason: string }> => ({ ok: false, reason: 'EDITOR_NOT_FOUND' }));
  const inject = vi.fn(); const send = vi.fn(); const failed = vi.fn(); const gateRelease = vi.fn();
  const runtimeWrites = vi.fn(async (_id: string, patch: RuntimePatch): Promise<boolean> => {
    task = { ...task, ...patch, runtime: { ...task.runtime!, ...patch.runtime } }; return true;
  });
  const pause = vi.fn(async (_id: string, _accountId: string, text: string, options: PauseOptions): Promise<void> => {
    task = { ...task, status: options.status, errorInfo: { code: options.code, message: text, recoverable: true, detectedAt: now } };
  });
  const controllers = new Map<string, AbortController>(); const running = new Set([getTaskExecutionScope(task)]);
  const visible = { current: options.visible === true };
  let ownedController: AbortController | undefined;
  const bindings: Record<string, unknown> = {
    getTaskExecutionScope, isMaterialImageTask, usesIndependentImagePage, isBackgroundPetStoryTask, availabilityBlocksAutomation, classifyTaskError,
    HumanVerificationRequiredError, PetStoryControlError, VideoControlReadinessError, ChatAttachmentUploadError,
    AccountAvailabilityPauseError: actual('AccountAvailabilityPauseError'), SubmissionSafetyPauseError: actual('SubmissionSafetyPauseError'),
    GenerationConfirmationPauseError: actual('GenerationConfirmationPauseError'),
    useTaskStore: { getState: (): object => ({ tasks: [task], setAccountAutomationState: vi.fn(), updateTaskRuntime: runtimeWrites,
      pauseAutomation: pause, failAutomation: failed, armTasks: vi.fn(), updateTask: vi.fn(), completeAutomation: vi.fn(), processQueue: vi.fn() }) },
    usePetStoryStore: { getState: (): object => ({ project }) },
    useAccountStore: { getState: (): object => ({ selectAccount: vi.fn(), recordAccountOutcome: vi.fn(), markSeedanceExhausted: vi.fn() }) },
    automationEngine: {
      hasController: (id: string): boolean => id === task.id && !!ownedController,
      createController: (id: string, accountId: string): AbortController => {
        if (id !== task.id || accountId !== task.assignedAccountId || ownedController) throw new Error('TEST wrong controller owner');
        ownedController = new AbortController(); return ownedController;
      },
      ownsController: (id: string, controller: AbortController): boolean => id === task.id && ownedController === controller,
      release: vi.fn(async (id: string, controller: AbortController): Promise<void> => { if (id === task.id && ownedController === controller) ownedController = undefined; }),
    },
    abortControllersRef: { current: controllers }, runningRef: { current: running }, visibleRef: visible,
    pendingRestartTasksRef: { current: new Map() }, pendingCancellationStatusRef: { current: new Map() },
    conversationSynchronizations: new WeakMap(),
    initializationGate: { acquire: vi.fn(async (): Promise<object> => ({ waitedMs: 0, release: gateRelease })) },
    window: { electronAPI: { settings: { get: vi.fn(async (): Promise<object> => ({ initializationConcurrency: 3 })) },
      petstory: { guardProductionTask: vi.fn(async (): Promise<object> => ({ success: true, guard: {} })) } } },
    setInteractiveTaskPageId: vi.fn(), materialPagesRef: { current: { uses: usesIndependentImagePage, activate: vi.fn() } },
    forceWebviewLayoutRepaint: vi.fn(async (): Promise<void> => undefined), assertNoHumanVerification: vi.fn(async (): Promise<void> => undefined),
    dismissKnownDesktopDownloadPromotion: promotion,
    resumableRepairDraft: actual('resumableRepairDraft'), waitForChatReady,
    performAvailabilityCheck: probe, startNewConversation: newConversation, injectPrompt: inject, submitPromptOnce: send,
    notification: { destroy: vi.fn() }, console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const execute = actual<ExecuteAutomation>('executeAutomation', bindings);
  return { run: (): Promise<void> => execute(task.assignedAccountId!, task.id, task.prompt, task.mode!, view), task: (): Task => task,
    readiness, entered: entered.promise, waitForChatReady, promotion, probe, newConversation, inject, send, pause, failed, runtimeWrites, view, controllers, running, gateRelease, visible };
}

describe('独立图片页输入区实际就绪后才判账号及准备发送', (): void => {
  it.each([
    { mode: 'chat', target: 'firstFrame' }, { mode: 'chat', target: 'lastFrame' },
    { mode: 'image', target: 'firstFrame' }, { mode: 'image', target: 'lastFrame' },
  ] as const)('Chat已打开时$target的$mode任务无materialId也等待自己的输入区，并继续核对新会话', async ({ mode, target }): Promise<void> => {
    const test = fixture(evidence('ready', 'ready'), { mode, target, visible: true });
    expect(isMaterialImageTask(test.task())).toBe(false);
    expect(getTaskExecutionScope(test.task())).toBe(test.task().assignedAccountId);
    const pending = test.run();
    expect(await Promise.race([test.entered.then((): string => 'readiness'), pending.then((): string => 'finished')])).toBe('readiness');
    expect(test.probe).not.toHaveBeenCalled(); expect(test.pause).not.toHaveBeenCalled();
    test.readiness.resolve(true); await pending;
    expect(test.waitForChatReady).toHaveBeenCalledExactlyOnceWith(test.view, 15000);
    expect(test.newConversation).toHaveBeenCalledExactlyOnceWith(test.view, 20_000, mode === 'chat', true, undefined);
    expect(test.pause).toHaveBeenCalledOnce();
    expect(test.pause.mock.calls[0][2]).toContain('输入区尚未就绪');
    expect(test.pause.mock.calls[0][2]).not.toContain('豆包对话正在打开');
    expect(test.task().runtime?.submittedAt).toBeUndefined(); expect(test.task().runtime?.attempt).toBe(1);
    expect(test.inject).not.toHaveBeenCalled(); expect(test.send).not.toHaveBeenCalled(); expect(test.failed).not.toHaveBeenCalled();
  });

  it.each(['chat', 'image'] as const)('关键帧%s准备期间打开Chat不撤销本次独立页面的执行权', async (mode: 'chat' | 'image'): Promise<void> => {
    const test = fixture(evidence('ready', 'ready'), { mode, target: 'firstFrame' }); const pending = test.run();
    expect(await Promise.race([test.entered.then((): string => 'readiness'), pending.then((): string => 'finished')])).toBe('readiness');
    test.visible.current = true; test.readiness.resolve(true); await pending;
    expect(test.newConversation).toHaveBeenCalledOnce();
    expect(test.pause.mock.calls[0][2]).not.toContain('豆包对话正在打开');
    expect(test.task().runtime?.submittedAt).toBeUndefined(); expect(test.controllers.size).toBe(0); expect(test.running.size).toBe(0);
  });

  it('dom-ready后输入区promise未完成时零probe/导航/注入/发送，完成后本页unknown精确暂停', async (): Promise<void> => {
    const test = fixture(evidence('unknown', 'page_unrecognized')); const pending = test.run();
    expect(await Promise.race([test.entered.then((): string => 'readiness'), pending.then((): string => 'finished')])).toBe('readiness');
    expect(test.waitForChatReady).toHaveBeenCalledExactlyOnceWith(test.view, 15000);
    for (const operation of [test.promotion, test.probe, test.newConversation, test.inject, test.send, test.pause]) expect(operation).not.toHaveBeenCalled();
    expect(test.task().runtime?.submittedAt).toBeUndefined(); test.readiness.resolve(true); await pending;
    expect(test.probe).toHaveBeenCalledExactlyOnceWith(test.task().assignedAccountId, test.view, 'pre_task');
    expect(test.promotion).toHaveBeenCalledExactlyOnceWith(test.view);
    expect(test.waitForChatReady.mock.invocationCallOrder[0]).toBeLessThan(test.promotion.mock.invocationCallOrder[0]);
    expect(test.promotion.mock.invocationCallOrder[0]).toBeLessThan(test.probe.mock.invocationCallOrder[0]);
    expect(test.pause).toHaveBeenCalledExactlyOnceWith(test.task().id, test.task().assignedAccountId, 'TEST page_unrecognized', { status: 'paused', code: 'page_unrecognized' });
    expect(test.task().status).toBe('paused'); expect(test.failed).not.toHaveBeenCalled();
    for (const operation of [test.newConversation, test.inject, test.send]) expect(operation).not.toHaveBeenCalled();
    expect(test.task().runtime?.submittedAt).toBeUndefined(); expect(test.controllers.size).toBe(0); expect(test.running.size).toBe(0); expect(test.gateRelease).toHaveBeenCalledOnce();
    expect(test.waitForChatReady).toHaveBeenCalledOnce(); expect(test.probe).toHaveBeenCalledOnce();
  });

  it('输入区未就绪时按原任务暂停，无账号探测、导航、提交或追加尝试', async (): Promise<void> => {
    const test = fixture(evidence('ready', 'ready')); const pending = test.run(); await test.entered;
    test.readiness.resolve(false); await pending;
    expect(test.pause).toHaveBeenCalledWith(test.task().id, test.task().assignedAccountId, expect.any(String), { status: 'paused', code: 'page_unrecognized' });
    for (const operation of [test.promotion, test.probe, test.newConversation, test.inject, test.send, test.failed]) expect(operation).not.toHaveBeenCalled();
    expect(test.waitForChatReady).toHaveBeenCalledOnce(); expect(test.task().runtime?.attempt).toBe(1); expect(test.task().runtime?.submittedAt).toBeUndefined();
  });

  it('就绪及本页真实probe通过后才创建新对话，后续控件不稳定仍不注入或发送', async (): Promise<void> => {
    const test = fixture(evidence('ready', 'ready')); const pending = test.run(); await test.entered;
    expect(test.promotion).not.toHaveBeenCalled(); expect(test.probe).not.toHaveBeenCalled(); expect(test.newConversation).not.toHaveBeenCalled(); test.readiness.resolve(true); await pending;
    expect(test.probe).toHaveBeenCalledOnce(); expect(test.newConversation).toHaveBeenCalledOnce();
    expect(test.waitForChatReady.mock.invocationCallOrder[0]).toBeLessThan(test.promotion.mock.invocationCallOrder[0]);
    expect(test.promotion.mock.invocationCallOrder[0]).toBeLessThan(test.probe.mock.invocationCallOrder[0]);
    expect(test.probe.mock.invocationCallOrder[0]).toBeLessThan(test.newConversation.mock.invocationCallOrder[0]);
    expect(test.task().status).toBe('paused'); expect(test.task().errorInfo?.code).toBe('page_unrecognized');
    expect(test.inject).not.toHaveBeenCalled(); expect(test.send).not.toHaveBeenCalled(); expect(test.task().runtime?.submittedAt).toBeUndefined();
  });
});
