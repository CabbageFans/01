/** 离线执行BrowserPanel正式路由和派发effect，确保展开Chat不把关键帧交还共享页面。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryProject, Task } from '@doubao-studio/contracts';
import { MaterialImagePages } from '../../src/utils/materialImagePages';
import { isBackgroundPetStoryTask } from '../../src/utils/petstoryBackground';

const source = ts.createSourceFile('BrowserPanel.tsx', fs.readFileSync(path.resolve('src/components/BrowserPanel.tsx'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);

function actual<T>(name: string, bindings: Record<string, unknown>): T {
  let expression = '';
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) expression = node.initializer!.getText(source);
    if (name === 'dispatchEffect' && ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect'
      && node.arguments[0]?.getText(source).includes('Object.entries(executingTasks)')) expression = node.arguments[0].getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source); if (!expression) throw new Error(`TEST 正式入口 ${name} 缺失`);
  return vm.runInNewContext(ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { ...bindings, Error, Date, setTimeout, clearTimeout }) as T;
}

const now = '2026-11-06T00:00:00.000Z';
const account: Account = { id: 'TEST-account', name: 'TEST', avatar: '', pinned: false, partition: 'TEST-partition', platform: 'doubao', status: 'idle', createdAt: now, updatedAt: now };

function frame(mode: 'chat' | 'image'): Task {
  const binding = { projectId: 'TEST-project', imageOperationId: 'TEST-operation' };
  const petstory = { ...binding, stepId: 'TEST-step' };
  return { id: `TEST-frame-${mode}`, projectId: 'TEST-studio', assignedAccountId: account.id, mode, status: 'executing', prompt: 'TEST',
    outputs: [], result: null, createdAt: now, updatedAt: now,
    ...(mode === 'image' ? { petstory } : { petstoryChat: { ...binding, jobId: 'TEST-job' } }),
    runtime: { runId: 'TEST-run', attempt: 1, stage: 'preparing_account', message: 'TEST', startedAt: now, stageStartedAt: now,
      lastHeartbeatAt: now, input: { mode, prompt: 'TEST', attachments: [], ...(mode === 'image' ? { petstory } : {}) } } };
}

function fixture(task: Task): {
  pages: MaterialImagePages; shared: HTMLWebViewElement; container: HTMLDivElement;
  get: (task: Task) => HTMLWebViewElement | undefined; ensure: (task: Task) => HTMLWebViewElement | undefined;
  ready: (task: Task) => boolean; dispatch: () => void; execute: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>;
} {
  const pages = new MaterialImagePages(); const container = document.createElement('div'); document.body.appendChild(container);
  const shared = document.createElement('webview') as HTMLWebViewElement; shared.textContent = 'TEST 保留的人工草稿'; container.appendChild(shared);
  const project: PetStoryProject = { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: account.id, revision: 1,
    source: { kind: 'script', status: 'review_required', url: '' }, assets: [], updatedAt: now,
    jobs: [{ id: 'TEST-job', taskId: task.id, kind: 'optimize', promptKind: 'firstFrame', shotId: 'TEST-shot', status: 'bound', inputHash: 'TEST', sourceUrl: '', createdAt: now }],
    imageOperations: [{ id: 'TEST-operation', requestId: 'TEST-request', target: { shotId: 'TEST-shot', kind: 'firstFrame' },
      mode: 'generate', stage: 'preparing', basisHash: 'TEST', createdAt: now, chatJobId: 'TEST-job', taskId: task.id }] };
  const execute = vi.fn(async (): Promise<void> => undefined); const pause = vi.fn(async (): Promise<void> => undefined);
  const bindings: Record<string, unknown> = {
    useCallback: <T>(callback: T): T => callback,
    materialPagesRef: { current: pages }, registryRef: { current: new Map([[account.id, shared]]) },
    loadingMapRef: { current: new Map([[account.id, false]]) }, loadErrorsRef: { current: new Map() }, poolRef: { current: container }, setWebviewEpoch: vi.fn(),
    useAccountStore: { getState: (): object => ({ accounts: [account] }) },
    useTaskStore: { getState: (): object => ({ tasks: [task], pauseAutomation: pause, failAutomation: vi.fn(async (): Promise<void> => undefined) }) },
    usePetStoryStore: { getState: (): object => ({ project }) },
    visibleRef: { current: true }, runningRef: { current: new Set<string>() },
    accountBusy: { [account.id]: true }, executingTasks: { [account.id]: task.id }, tasks: [task],
    executeAutomation: execute, pauseFailedTaskPage: vi.fn(), isBackgroundPetStoryTask,
    automationEngine: { release: vi.fn(async (): Promise<void> => undefined) },
    message: { error: vi.fn() }, readBackReleasedPetStoryTask: vi.fn(async (): Promise<void> => undefined),
  };
  const get = actual<(task: Task) => HTMLWebViewElement | undefined>('getTaskWebview', bindings); bindings.getTaskWebview = get;
  const ready = actual<(task: Task) => boolean>('taskWebviewReady', bindings); bindings.taskWebviewReady = ready;
  const ensure = actual<(task: Task) => HTMLWebViewElement | undefined>('ensureTaskWebview', bindings); bindings.ensureTaskWebview = ensure;
  return { pages, shared, container, get, ensure, ready, dispatch: actual<() => void>('dispatchEffect', bindings), execute, pause };
}

afterEach((): void => { document.body.replaceChildren(); });

describe('关键帧正式浏览器路由与派发', (): void => {
  it.each(['chat', 'image'] as const)('Chat可见时%s派发等待独立页就绪，随后执行一次且不触发面板暂停', async (mode: 'chat' | 'image'): Promise<void> => {
    const task = frame(mode); const test = fixture(task);
    test.dispatch(); expect(test.execute).not.toHaveBeenCalled(); expect(test.pause).not.toHaveBeenCalled();
    const page = test.get(task); expect(page).toBeDefined(); expect(page).not.toBe(test.shared); expect(test.ready(task)).toBe(false);
    page!.dispatchEvent(new Event('dom-ready')); expect(test.ready(task)).toBe(true);
    test.dispatch(); test.dispatch(); await Promise.resolve();
    expect(test.execute).toHaveBeenCalledExactlyOnceWith(account.id, task.id, task.prompt, mode, page, undefined, undefined, undefined);
    expect(test.pause).not.toHaveBeenCalled(); expect(test.shared.textContent).toBe('TEST 保留的人工草稿');
    test.pages.dispose();
  });

  it.each(['chat', 'image'] as const)('旧%s已提交缺定位时get/ensure/ready共同保留共享原现场，不创建空页', (mode: 'chat' | 'image'): void => {
    const task = frame(mode); task.runtime!.submittedAt = now; const test = fixture(task);
    expect(test.get(task)).toBe(test.shared); expect(test.ensure(task)).toBe(test.shared); expect(test.ready(task)).toBe(true);
    expect(test.pages.get(task)).toBeUndefined(); expect(test.container.children).toHaveLength(1);
    expect(test.shared.textContent).toBe('TEST 保留的人工草稿'); test.pages.dispose();
  });
});
