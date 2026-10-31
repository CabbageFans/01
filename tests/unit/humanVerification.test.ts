/** 只使用 OFFLINE DOM／任务替身，验证不触发网页动作或真实请求。 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Account, AccountAvailability, Task } from '../../src/types';
import { detectRobotVerification } from '../../src/utils/doubaoBridge';
import { classifyAccountAvailability } from '../../src/utils/accountAvailability';
import { hasHumanVerificationEvidence, HumanVerificationRequiredError, observeWithHumanVerification, readHumanVerificationEvidence } from '../../src/utils/humanVerification';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { createAcceptedObservationBinding } from '../../src/utils/acceptedObservation';
import { getAssignedAccountBlockReason } from '../../src/utils/queueAccountDecision';

class VerificationNode {
  parentElement: VerificationNode | null = null;
  hidden = false; message = false; innerText = '人机验证'; src = ''; attributes: Record<string, string> = {};
  bounds = { left: 20, top: 20, right: 320, bottom: 220, width: 300, height: 200 };
  getBoundingClientRect(): typeof this.bounds { return this.bounds; }
  getAttribute(name: string): string | null { return this.attributes[name] || null; }
  hasAttribute(name: string): boolean { return name in this.attributes; }
  closest(): VerificationNode | null { return this.message ? this : null; }
}
function page(options: { frame?: boolean; hidden?: boolean; message?: boolean; ancestorHidden?: boolean; text?: string } = {}): { document: Document; window: Window; view: Parameters<typeof detectRobotVerification>[0] } {
  const node = new VerificationNode(); node.hidden = !!options.hidden; node.message = !!options.message; node.innerText = options.text ?? '人机验证'; node.src = 'https://OFFLINE.invalid/captcha';
  if (options.ancestorHidden) { node.parentElement = new VerificationNode(); node.parentElement.hidden = true; }
  const document = { querySelectorAll: (selector: string): VerificationNode[] => selector === 'iframe' ? options.frame ? [node] : [] : options.frame ? [] : [node] } as unknown as Document;
  const window = { innerWidth: 800, innerHeight: 600, getComputedStyle: (element: VerificationNode): object => ({ display: element.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' }) } as unknown as Window;
  return { document, window, view: { executeJavaScript: async (code: string): Promise<unknown> => vm.runInNewContext(code, { document, window }), getURL: (): string => 'https://www.doubao.com/chat/OFFLINE', loadURL: vi.fn(), sendInputEvent: vi.fn(), focus: vi.fn() } };
}
function account(id: string): Account {
  return { id, name: id, avatar: '', platform: 'doubao', partition: `persist:OFFLINE-${id}`, status: 'idle', pinned: false, createdAt: 'OFFLINE', updatedAt: 'OFFLINE',
    health: { loginState: 'ok', verificationRequired: false, consecutiveFailures: 0, successCount: 0, failureCount: 0,
      availability: { state: 'ready', reason: 'ready', message: 'OFFLINE', checkedAt: '2026-10-31T00:00:00.000Z', source: 'manual' } } };
}

function actualFailurePause(bindings: Record<string, unknown>): () => Promise<void> {
  const file = ts.createSourceFile('BrowserPanel.tsx', readFileSync(resolve('src/components/BrowserPanel.tsx'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let expression = '';
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'pauseAutomation' && node.arguments[3]?.getText(file).includes('acceptedObservationActive')) expression = node.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file); if (!expression) throw new Error('OFFLINE failure pause missing');
  return vm.runInNewContext(ts.transpileModule(`(async () => { await ${expression}; })`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, bindings) as () => Promise<void>;
}

function actualFailureGuard(bindings: Record<string, unknown>): () => Promise<unknown> {
  const file = ts.createSourceFile('BrowserPanel.tsx', readFileSync(resolve('src/components/BrowserPanel.tsx'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const statements: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && node.variableDeclaration?.name.getText(file) === 'caught' && node.block.getText(file).includes('currentFailedTask')) {
      for (const statement of node.block.statements) {
        if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration): boolean => declaration.name.getText(file) === 'cancelled')) break;
        statements.push(statement.getText(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file); if (!statements.length) throw new Error('OFFLINE failure guard missing');
  return vm.runInNewContext(ts.transpileModule(`(async () => { ${statements.join('\n')}; return afterGuard(); })`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, bindings) as () => Promise<unknown>;
}
function actualPanelCallback(name: string, bindings: Record<string, unknown>): (...args: unknown[]) => Promise<unknown> {
  const file = ts.createSourceFile('BrowserPanel.tsx', readFileSync(resolve('src/components/BrowserPanel.tsx'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let expression = '';
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file); if (!expression) throw new Error('OFFLINE callback missing');
  return vm.runInNewContext(ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { ...bindings, Date }) as (...args: unknown[]) => Promise<unknown>;
}

class OfflineVerificationPause extends Error { constructor(message: string, readonly code: string) { super(message); } }
afterEach((): void => { vi.useRealTimers(); vi.unstubAllGlobals(); useAccountStore.setState({ accounts: [], selectedAccountId: null }); useTaskStore.setState({ tasks: [], executingTasks: {}, accountBusy: {} }); });

describe('真实可见验证证据共用分类', (): void => {
  it.each([{ frame: true }, { text: '人机验证' }, { text: 'Security verification' }])('当前可见验证被账号探针和发送探针一致识别%j', async (options): Promise<void> => {
    const test = page(options); const evidence = readHumanVerificationEvidence(test.document, test.window);
    expect(hasHumanVerificationEvidence(evidence)).toBe(true); expect(await detectRobotVerification(test.view)).toBe(true);
    expect(classifyAccountAvailability({ platform: 'doubao', url: test.view.getURL(), ...evidence }, 'pre_submit').reason).toBe('human_verification');
    expect(test.view.sendInputEvent).not.toHaveBeenCalled(); expect(test.view.focus).not.toHaveBeenCalled();
  });
  it.each([{ frame: true, hidden: true }, { frame: true, ancestorHidden: true }, { message: true }, { hidden: true }, { text: '普通说明文字' }])('隐藏iframe、历史正文及普通文字均不冒充验证%j', async (options): Promise<void> => {
    const test = page(options); expect(hasHumanVerificationEvidence(readHumanVerificationEvidence(test.document, test.window))).toBe(false);
    expect(await detectRobotVerification(test.view)).toBe(false);
  });
  it('账号探针显式的可见结论不被其它层或正文里的验证关键词覆盖', (): void => {
    expect(classifyAccountAvailability({ platform: 'doubao', url: 'https://www.doubao.com/chat/OFFLINE', hasUsableEditor: true, hasAuthenticatedControl: true,
      bodyText: '讨论人机验证', visibleLayerText: '历史说明：安全验证', iframeSources: ['OFFLINE/captcha'], humanVerification: false }, 'pre_submit').state).toBe('ready');
  });
});

describe('账号验证阻断与旧ready回执', (): void => {
  it('立即阻断所属账号、保持其他账号可用，并丢弃先前ready的迟到回执', async (): Promise<void> => {
    const original = account('OFFLINE-a'); const other = account('OFFLINE-b'); useAccountStore.setState({ accounts: [original, other] });
    const pending: Array<(value: unknown) => void> = [];
    const setAvailability = vi.fn((): Promise<unknown> => new Promise((resolve): void => { pending.push(resolve); }));
    vi.stubGlobal('window', { electronAPI: { accounts: { setAvailability } } });
    const ready = { ...original.health!.availability!, checkedAt: '2026-10-31T00:00:01.000Z' };
    const first = useAccountStore.getState().setAccountAvailability(original.id, ready);
    const blocked: AccountAvailability = { state: 'action_required', reason: 'human_verification', message: 'OFFLINE', checkedAt: '2026-10-31T00:00:02.000Z', source: 'pre_submit' };
    const second = useAccountStore.getState().setAccountAvailability(original.id, blocked);
    expect(getAssignedAccountBlockReason(useAccountStore.getState().accounts[0])).toContain('验证'); expect(getAssignedAccountBlockReason(other)).toBeNull();
    const blockedAccount = { ...original, health: { ...original.health!, verificationRequired: true, availability: blocked } };
    pending[1]({ success: true, account: blockedAccount }); expect(await second).toBe(true);
    pending[0]({ success: true, account: { ...original, health: { ...original.health!, availability: ready } } }); expect(await first).toBe(false);
    expect(useAccountStore.getState().accounts[0].health?.availability?.reason).toBe('human_verification');
    expect(await useAccountStore.getState().setAccountAvailability(original.id, ready)).toBe(false); expect(setAvailability).toHaveBeenCalledTimes(2);
    const newReady = { ...ready, checkedAt: '2026-10-31T00:00:03.000Z' }; const third = useAccountStore.getState().setAccountAvailability(original.id, newReady);
    pending[2]({ success: true, account: { ...original, health: { ...original.health!, verificationRequired: false, availability: newReady } } });
    expect(await third).toBe(true); expect(getAssignedAccountBlockReason(useAccountStore.getState().accounts[0])).toBeNull();
  });
  it('BrowserPanel的真实暂停回调使该账号旧探测失效，并保留独立账号状态', async (): Promise<void> => {
    const accounts = [account('OFFLINE-a'), account('OFFLINE-b')]; useAccountStore.setState({ accounts });
    vi.stubGlobal('window', { electronAPI: { accounts: { setAvailability: async (id: string, availability: AccountAvailability): Promise<object> => ({ success: true, account: { ...accounts[0], id, health: { ...accounts[0].health!, verificationRequired: true, availability } } }) } } });
    const sequence = { current: { 'OFFLINE-a': 7 } };
    const pause = actualPanelCallback('pauseForHumanVerification', { availabilityProbeSequenceRef: sequence, useAccountStore, AccountAvailabilityPauseError: OfflineVerificationPause });
    await expect(pause('OFFLINE-a')).rejects.toMatchObject({ code: 'human_verification' });
    expect(sequence.current['OFFLINE-a']).toBe(8); expect(useAccountStore.getState().selectedAccountId).toBe('OFFLINE-a');
    expect(getAssignedAccountBlockReason(useAccountStore.getState().accounts[0])).toContain('验证'); expect(getAssignedAccountBlockReason(useAccountStore.getState().accounts[1])).toBeNull();
  });
});

describe('只读观察中的验证守卫', (): void => {
  it.each(['new-run', 'lost-controller', 'completed'] as const)('迟到验证回读遇到%s不暂停后来运行，账号真实验证仍保持阻断', async (change): Promise<void> => {
    const accountId = 'OFFLINE-late-account'; const taskId = 'OFFLINE-late-task'; const originalAccount = account(accountId);
    useAccountStore.setState({ accounts: [originalAccount] });
    vi.stubGlobal('window', { electronAPI: { accounts: { setAvailability: async (_id: string, availability: AccountAvailability): Promise<object> => ({ success: true,
      account: { ...originalAccount, health: { ...originalAccount.health!, verificationRequired: true, availability } } }) } } });
    const pauseAccount = actualPanelCallback('pauseForHumanVerification', { availabilityProbeSequenceRef: { current: {} }, useAccountStore, AccountAvailabilityPauseError: OfflineVerificationPause });
    let release: (() => void) | undefined; let owns = true;
    const current = { id: taskId, status: 'generating', runtime: { runId: 'OFFLINE-old-run', submittedAt: 'OFFLINE-intent' } };
    const afterGuard = vi.fn(async (): Promise<void> => undefined);
    const checkHumanVerification = vi.fn(async (): Promise<never> => {
      await new Promise<void>((resolve): void => { release = resolve; });
      await pauseAccount(accountId);
      throw new Error('OFFLINE unreachable');
    });
    const pending = actualFailureGuard({ caught: new Error('OFFLINE readback failure'), taskId, accountId, controller: {}, expectedRunId: 'OFFLINE-old-run',
      automationEngine: { ownsController: (): boolean => owns }, useTaskStore: { getState: (): object => ({ tasks: [current] }) },
      checkHumanVerification, pauseForHumanVerification: pauseAccount, HumanVerificationRequiredError, AccountAvailabilityPauseError: OfflineVerificationPause, afterGuard })();
    expect(checkHumanVerification).toHaveBeenCalledOnce();
    if (change === 'new-run') current.runtime.runId = 'OFFLINE-new-run';
    if (change === 'lost-controller') owns = false;
    if (change === 'completed') current.status = 'done';
    release?.(); await pending;
    expect(afterGuard).not.toHaveBeenCalled(); expect(current.status).toBe(change === 'completed' ? 'done' : 'generating');
    expect(current.runtime.submittedAt).toBe('OFFLINE-intent'); expect(getAssignedAccountBlockReason(useAccountStore.getState().accounts[0])).toContain('验证');
  });
  it('真实失败暂停分支优先保留human原因，原提交和已受理观察不丢失', async (): Promise<void> => {
    const now = '2026-10-31T00:00:00.000Z'; const accountId = 'OFFLINE-account'; const taskId = 'OFFLINE-task'; const runId = 'OFFLINE-run';
    const observation = createAcceptedObservationBinding({ accountId, runId, conversationUrl: 'https://www.doubao.com/chat/OFFLINE', acceptedAt: now, ownerId: 'OFFLINE-owner', mode: 'image', evidence: { inputCleared: true, promptPublished: true, generationStarted: false, messageCount: 1 } });
    const task: Task = { id: taskId, prompt: 'OFFLINE input', mode: 'image', status: 'generating', assignedAccountId: accountId, outputs: [], result: null, createdAt: now, updatedAt: now,
      runtime: { runId, submittedAt: now, attempt: 1, startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, stage: 'generating', message: 'OFFLINE', conversationUrl: observation.conversationUrl, acceptanceObservation: observation, input: { prompt: 'OFFLINE input', mode: 'image', attachments: [] } } };
    useTaskStore.setState({ tasks: [task], executingTasks: { [accountId]: taskId }, accountBusy: { [accountId]: true } });
    const updateRuntime = vi.fn(async (): Promise<object> => ({ success: true }));
    vi.stubGlobal('window', { electronAPI: { logs: { append: vi.fn(async (): Promise<void> => undefined) }, tasks: { updateRuntime }, accounts: { setStatus: vi.fn(async (): Promise<object> => ({ success: true })) } } });
    await actualFailurePause({ taskId, accountId, cancelled: false, requestedCancellationStatus: undefined, errorMessage: 'OFFLINE visible verification',
      availabilityPaused: true, err: { code: 'human_verification' }, acceptedObservationActive: true, confirmationPaused: false, petstoryPaused: false, safetyPaused: false,
      pauseAutomation: useTaskStore.getState().pauseAutomation })();
    const current = useTaskStore.getState().tasks[0];
    expect(current.status).toBe('waiting_verification'); expect(current.errorInfo?.code).toBe('human_verification'); expect(current.runtime?.runId).toBe(runId);
    expect(current.runtime?.submittedAt).toBe(now); expect(current.runtime?.conversationUrl).toBe(observation.conversationUrl); expect(current.runtime?.acceptanceObservation).toEqual(observation);
    expect(useTaskStore.getState().accountBusy[accountId]).toBeUndefined(); expect(updateRuntime).toHaveBeenCalledOnce();
  });
  it('长观察遇到验证时立即结束原观察且不抹去原提交身份', async (): Promise<void> => {
    vi.useFakeTimers(); const controller = new AbortController(); let verify = false; let observerSignal: AbortSignal | undefined;
    const runtime = { runId: 'OFFLINE-run', submittedAt: 'OFFLINE-intent', conversationUrl: 'OFFLINE-conversation', acceptanceObservation: { outcome: 'observing' } };
    const observe = vi.fn((signal: AbortSignal): Promise<string> => { observerSignal = signal; return new Promise((): void => undefined); });
    const pending = observeWithHumanVerification(observe, async (): Promise<void> => { if (verify) throw new OfflineVerificationPause('OFFLINE', 'human_verification'); }, controller.signal)
      .catch((error: unknown): unknown => error);
    await Promise.resolve(); verify = true; await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ code: 'human_verification' }); expect(observerSignal?.aborted).toBe(true); expect(observe).toHaveBeenCalledOnce();
    expect(runtime).toEqual({ runId: 'OFFLINE-run', submittedAt: 'OFFLINE-intent', conversationUrl: 'OFFLINE-conversation', acceptanceObservation: { outcome: 'observing' } }); expect(vi.getTimerCount()).toBe(0);
  });
  it('验证尚在时不启动观察，解除后可执行正常的只读观察', async (): Promise<void> => {
    let verify = true; const observe = vi.fn(async (): Promise<string> => 'OFFLINE original result');
    const check = async (): Promise<void> => { if (verify) throw new OfflineVerificationPause('OFFLINE', 'human_verification'); };
    await expect(observeWithHumanVerification(observe, check)).rejects.toMatchObject({ code: 'human_verification' }); expect(observe).not.toHaveBeenCalled();
    verify = false; expect(await observeWithHumanVerification(observe, check)).toBe('OFFLINE original result'); expect(observe).toHaveBeenCalledOnce();
  });
});
