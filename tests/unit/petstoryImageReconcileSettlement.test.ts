/** 离线执行 BrowserPanel 真实只读恢复及收束函数；不发送、导航或伪造平台受理。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { PetStoryPlan, PetStoryProject, Task } from '@doubao-studio/contracts';
import { isBackgroundImageOperationTask } from '../../src/utils/petstoryBackground';
import { requiresSubmissionReconciliation } from '../../src/utils/realSendStateMachine';
import { inspectCreationReadback } from '../../src/utils/chatReadback';
import { normalizeDoubaoConversationUrl, resolveTaskConversationTarget, supportsDoubaoConversationLocator } from '../../src/utils/taskConversationLocator';
import original from '../fixtures/storyboard-five-shots.json';

type RuntimePatch = { status?: Task['status']; runtime?: Partial<NonNullable<Task['runtime']>>; errorInfo?: Task['errorInfo'] };
type ReconcileHandler = (event: Event) => Promise<void>;
class OfflineAccountPause extends Error { constructor(message: string, readonly code: string) { super(message); } }
function actualHandler(name: string, bindings: Record<string, unknown>): ReconcileHandler {
  const file = ts.createSourceFile('BrowserPanel.tsx', fs.readFileSync(path.resolve('src/components/BrowserPanel.tsx'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let expression = '';
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) expression = node.initializer!.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file); if (!expression) throw new Error(`TEST: actual ${name} not found`);
  const script = ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(script, { ...bindings, Date, AbortController }) as ReconcileHandler;
}

function fixture(): {
  current: () => Task; replace: (task: Task) => void; bindings: Record<string, unknown>; event: Event;
  writes: ReturnType<typeof vi.fn>; errors: ReturnType<typeof vi.fn>; view: { getURL: ReturnType<typeof vi.fn>; loadURL: ReturnType<typeof vi.fn>; sendInputEvent: ReturnType<typeof vi.fn> };
  guard: { current: Set<string> }; controllers: { current: Map<string, AbortController> }; handler: (override?: ReconcileHandler) => ReconcileHandler;
} {
  const now = '2026-10-30T08:30:00.000Z';
  let current: Task = { id: 'TEST-stopped-image', projectId: 'TEST-studio', assignedAccountId: 'TEST-account', mode: 'image', status: 'manual_submission_observing',
    prompt: original.plan.shots[0].prompts.firstFrame.final, result: null, outputs: [], createdAt: now, updatedAt: now,
    petstory: { projectId: 'TEST-project', stepId: 'TEST-step' }, runtime: { runId: 'TEST-original-run', attempt: 1, stage: 'manual_submission_observing', message: 'TEST 原提交只读核对',
      startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, input: { mode: 'image', prompt: original.plan.shots[0].prompts.firstFrame.final, attachments: [] } } };
  const project: PetStoryProject = { id: 'TEST-project', schemaVersion: 1, revision: 1, studioProjectId: 'TEST-studio', accountId: 'TEST-account', updatedAt: now,
    source: { kind: 'script', url: '', status: 'review_required' }, plan: structuredClone(original.plan) as PetStoryPlan, jobs: [], assets: [], imageOperations: [{
      id: 'TEST-operation', requestId: 'TEST-request', target: { materialId: 'TEST-material' }, taskId: current.id, mode: 'modify', stage: 'generating', createdAt: now, basisHash: 'TEST' }] };
  const writes = vi.fn(async (_id: string, patch: RuntimePatch): Promise<boolean> => {
    current = { ...current, ...patch, runtime: { ...current.runtime!, ...patch.runtime } }; return true;
  });
  const errors = vi.fn(); const guard = { current: new Set<string>() }; const controllers = { current: new Map<string, AbortController>() };
  const view = { getURL: vi.fn((): string => 'https://www.doubao.com/chat/TEST-current'), loadURL: vi.fn(), sendInputEvent: vi.fn() };
  const bindings: Record<string, unknown> = {
    useTaskStore: { getState: (): object => ({ tasks: [current], updateTaskRuntime: writes,
      pauseAutomation: async (id: string, _accountId: string, text: string, options: { status: Task['status']; code: string }): Promise<boolean> => writes(id, {
        status: options.status, errorInfo: { code: options.code, message: text, recoverable: true, detectedAt: now }, runtime: { stage: 'waiting_verification', message: text },
      }),
    }) }, usePetStoryStore: { getState: (): object => ({ project }) },
    useAccountStore: { getState: (): object => ({ accounts: [{ id: 'TEST-account', platform: 'doubao' }], selectAccount: vi.fn() }) },
    isBackgroundImageOperationTask, requiresSubmissionReconciliation, hasAccountChatAdjustment: (): boolean => false,
    resolveTaskConversationTarget, supportsDoubaoConversationLocator, normalizeDoubaoConversationUrl,
    inspectCreationReadback, message: { error: errors, warning: vi.fn(), info: vi.fn(), success: vi.fn() },
    submissionReconcileRef: guard, abortControllersRef: controllers,
    registryRef: { current: new Map([['TEST-account', view]]) }, loadingMapRef: { current: new Map([['TEST-account', false]]) },
    waitForConversationNavigator: vi.fn(async (): Promise<typeof view> => view),
    getChatPageSnapshot: vi.fn(async (): Promise<object> => ({ messages: [], editorPresent: true, editorText: current.prompt, generating: false })),
    openTaskConversation: vi.fn(),
    assertNoHumanVerification: vi.fn(async (): Promise<void> => undefined), AccountAvailabilityPauseError: OfflineAccountPause,
  };
  const handler = (override?: ReconcileHandler): ReconcileHandler => actualHandler('handleSubmissionReconcileSafely', {
    ...bindings, handleSubmissionReconcile: override || actualHandler('handleSubmissionReconcile', bindings),
  });
  return { current: (): Task => current, replace: (task: Task): void => { current = task; }, bindings, writes, errors, view, guard, controllers, handler,
    event: { type: 'reconcile-task-submission', detail: { taskId: current.id, useCurrentPage: true } } as unknown as Event };
}

describe('图片只读恢复预检退出后的真实状态收束', (): void => {
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
    test.bindings.isBackgroundImageOperationTask = (): boolean => false;
    await test.handler(existing)(test.event);
    expect(existing).toHaveBeenCalledTimes(1); expect(test.writes).not.toHaveBeenCalled();
  });

  it.each(['image', 'video', 'chat'] as const)('PetStory %s恢复预检提前返回也收束原观察状态', async (mode): Promise<void> => {
    const test = fixture(); test.replace({ ...test.current(), mode });
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
