import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryCapability, PetStoryProductionResult, PetStoryProject, Task, TaskResubmitUncertainParams } from '@doubao-studio/contracts';
import { tickPetStoryProduction, usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';

const initial = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState() };
const now = '2026-10-31T00:00:00.000Z';
let project: PetStoryProject; let tasks: Task[]; let account: Account; let request: TaskResubmitUncertainParams;
const resubmit = vi.fn<(...args: unknown[]) => Promise<PetStoryProductionResult>>();
const advance = vi.fn<(...args: unknown[]) => Promise<PetStoryProductionResult>>();
const start = vi.fn(); const bind = vi.fn(); const list = vi.fn();
beforeEach((): void => {
  vi.clearAllMocks();
  account = { id: 'TEST-account', name: 'TEST离线账号', avatar: '', partition: 'TEST', status: 'idle', pinned: false, createdAt: now, updatedAt: now };
  const entry = { state: 'unknown' as const, reason: 'TEST离线' };
  const capability: PetStoryCapability = { accountId: account.id, checkedAt: now, durations: [5], image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry } };
  tasks = [{ id: 'TEST-original', assignedAccountId: account.id, status: 'paused', mode: 'image', prompt: 'TEST离线请求', result: null, outputs: [], createdAt: now, updatedAt: now,
    runtime: { runId: 'TEST-original-run', submittedAt: now, attempt: 1, stage: 'paused', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { mode: 'image', prompt: 'TEST离线请求', attachments: [] } } }];
  project = { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: account.id, revision: 5, source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [], updatedAt: now,
    production: { state: 'paused', planHash: 'TEST', approvedAt: now, capability, fallbacks: {}, shots: {}, steps: [{ id: 'TEST-step', kind: 'firstFrame', taskId: tasks[0].id, runId: tasks[0].runtime!.runId, status: 'bound', inputHash: 'TEST', attachmentAssetIds: [] }], message: 'TEST不明提交' } };
  request = { taskId: tasks[0].id, runId: tasks[0].runtime!.runId, submittedAt: now, authorizationId: 'TEST-authorization', acceptDuplicateRisk: true };
  list.mockImplementation(async (): Promise<Task[]> => tasks);
  resubmit.mockImplementation(async (): Promise<PetStoryProductionResult> => {
    project = structuredClone(project); project.revision++; project.production!.state = 'running';
    tasks = [...tasks, { ...structuredClone(tasks[0]), id: 'TEST-replacement', status: 'queued', runtime: { ...tasks[0].runtime!, runId: 'TEST-new-run', submittedAt: undefined } }];
    project.production!.steps[0].taskId = 'TEST-replacement'; project.production!.steps[0].runId = undefined;
    return { success: true, project, taskId: 'TEST-replacement' };
  });
  advance.mockImplementation(async (): Promise<PetStoryProductionResult> => ({ success: true, project, taskId: 'TEST-replacement', action: 'start' }));
  bind.mockImplementation(async (): Promise<PetStoryProductionResult> => ({ success: true, project }));
  start.mockImplementation(async (taskId: string, beforeDispatch: (task: Task) => Promise<void>): Promise<boolean> => { await beforeDispatch(tasks.find((item): boolean => item.id === taskId)!); return true; });
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { petstory: { resubmitProduction: resubmit, advanceProduction: advance, bindProductionRun: bind, pauseProduction: async (): Promise<PetStoryProductionResult> => ({ success: true, project }) }, tasks: { list } } });
  useTaskStore.setState({ ...initial.tasks, tasks, activeTaskId: null, executingTasks: {}, accountBusy: {}, startAutomation: start });
  useAccountStore.setState({ ...initial.accounts, accounts: [account] });
  usePetStoryStore.setState({ ...initial.petstory, project, busy: false, error: '', capability: null });
});
afterEach(async (): Promise<void> => {
  await usePetStoryStore.getState().pauseProduction();
  usePetStoryStore.setState(initial.petstory); useTaskStore.setState(initial.tasks); useAccountStore.setState(initial.accounts); vi.unstubAllGlobals();
});

describe('显式重发沿既有制作绑定与执行链启动', (): void => {
  it('提交授权tuple与revision，绑定新任务运行后调用原自动化驱动', async (): Promise<void> => {
    const original = structuredClone(tasks[0]);
    await usePetStoryStore.getState().resubmitProduction(request);
    expect(resubmit).toHaveBeenCalledExactlyOnceWith('TEST-project', 5, request, undefined);
    expect(list).toHaveBeenCalled(); expect(advance).toHaveBeenCalledExactlyOnceWith('TEST-project');
    expect(start).toHaveBeenCalledExactlyOnceWith('TEST-replacement', expect.any(Function));
    expect(bind).toHaveBeenCalledExactlyOnceWith('TEST-project', 'TEST-replacement', 'TEST-new-run');
    expect(tasks[0]).toEqual(original); expect(useTaskStore.getState().tasks).toHaveLength(2); expect(usePetStoryStore.getState().error).toBe('');
  });
  it('主进程拒绝授权时显示原因且不推进或启动新任务', async (): Promise<void> => {
    resubmit.mockResolvedValueOnce({ success: false, error: 'TEST原任务已受理', project });
    await usePetStoryStore.getState().resubmitProduction(request);
    expect(usePetStoryStore.getState().error).toBe('TEST原任务已受理'); expect(advance).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled();
    await tickPetStoryProduction(); expect(start).not.toHaveBeenCalled();
  });
  it.each(['acceptance-review', 'manual-review', 'generation-confirmation'] as const)('%s 停止记录可显式申请新授权', async (condition): Promise<void> => {
    if (condition === 'acceptance-review') tasks[0].runtime!.acceptanceObservation = { runId: request.runId, outcome: 'manual_review' } as NonNullable<Task['runtime']>['acceptanceObservation'];
    if (condition === 'manual-review') tasks[0].runtime!.manualObservation = { startedAt: now, expiresAt: now, source: 'stored_conversation', outcome: 'manual_review' };
    if (condition === 'generation-confirmation') tasks[0].status = 'waiting_generation_confirmation';
    await usePetStoryStore.getState().resubmitProduction(request); expect(resubmit).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledOnce();
  });
  it('缺少具体原会话地址时不进入假观察，原停止记录仍可确认重发', async (): Promise<void> => {
    const before = structuredClone(tasks[0]);
    const resume = vi.fn(async (): Promise<PetStoryProductionResult> => { project = structuredClone(project); project.production!.state = 'running'; return { success: true, project }; });
    window.electronAPI.petstory.resumeProduction = resume;
    const pause = vi.fn(async (): Promise<PetStoryProductionResult> => { project = structuredClone(project); project.production!.state = 'paused'; return { success: true, project }; });
    window.electronAPI.petstory.pauseProduction = pause;
    advance.mockImplementationOnce(async (): Promise<PetStoryProductionResult> => ({ success: true, project, taskId: before.id, action: 'observe' }));
    const updateRuntime = vi.fn(async (): Promise<boolean> => true); useTaskStore.setState({ updateTaskRuntime: updateRuntime });
    await usePetStoryStore.getState().resumeProduction();
    expect(updateRuntime).not.toHaveBeenCalled(); expect(window.dispatchEvent).not.toHaveBeenCalled(); expect(tasks[0]).toEqual(before);
    expect(project.production!.state).toBe('paused'); expect(usePetStoryStore.getState().error).toContain('具体会话');
    await usePetStoryStore.getState().resubmitProduction(request); expect(resubmit).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledOnce();
  });
  it.each(['tuple', 'accepted', 'observing', 'verification', 'login'] as const)('%s 状态变化在API前拒绝，不绕过原任务或验证', async (condition): Promise<void> => {
    if (condition === 'tuple') request.runId = 'TEST-other-run';
    if (condition === 'accepted') tasks[0].outputs.push('TEST-late-artifact');
    if (condition === 'observing') useTaskStore.setState({ executingTasks: { [account.id]: tasks[0].id } });
    if (condition === 'verification' || condition === 'login') account.health = { loginState: condition === 'login' ? 'expired' : 'ok', verificationRequired: condition === 'verification', failureCount: 0, successCount: 0, consecutiveFailures: 0 };
    await usePetStoryStore.getState().resubmitProduction(request);
    expect(resubmit).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().error).toBeTruthy();
  });
});
