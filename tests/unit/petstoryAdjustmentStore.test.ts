/** 离线 Store 回归：验证原方案调整的打开顺序，不代替真实豆包会话验收。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryAdjustmentResult, PetStoryPlan, PetStoryProject, PetStoryRuntimeTarget, Task } from '@doubao-studio/contracts';
import { useAccountStore } from '../../src/store/useAccountStore';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = { petstory: usePetStoryStore.getState(), accounts: useAccountStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-11-02T01:00:00.000Z';
const target: PetStoryRuntimeTarget = { parentJobId: 'TEST-plan-candidate' };
let project: PetStoryProject;
const actions: string[] = [];
const dispatchEvent = vi.fn((event: Event): boolean => { actions.push(event.type); return true; });
const selectAccount = vi.fn((accountId: string | null): void => {
  actions.push(`select:${accountId}`);
  useAccountStore.setState({ selectedAccountId: accountId });
});
const beginAdjustment = vi.fn<(id: string, revision: number, target: PetStoryRuntimeTarget) => Promise<PetStoryAdjustmentResult>>();
const listTasks = vi.fn<() => Promise<Task[]>>();
const prepareRuntime = vi.fn();
const adoptPlanCandidate = vi.fn();
const confirmStory = vi.fn();

function adjustmentResult(): PetStoryAdjustmentResult {
  const next = structuredClone(project); next.revision++;
  next.chatAdjustment = { id: 'TEST-adjustment', target: {}, sourceJobId: target.parentJobId!, conversationUrl: 'https://www.doubao.com/chat/TEST-plan-original',
    basisHash: 'TEST', previousText: 'null', startedAt: now, status: 'active', replies: [] };
  return { success: true, project: next, adjustment: next.chatAdjustment };
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise: (value: T | PromiseLike<T>) => void, rejectPromise: (reason?: unknown) => void): void => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

beforeEach((): void => {
  vi.resetAllMocks(); actions.length = 0;
  project = { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-original-account', revision: 4,
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now }, assets: [], updatedAt: now,
    jobs: [{ id: target.parentJobId!, taskId: 'TEST-plan-task', kind: 'analysis', status: 'applied', resultStatus: 'candidate', requestId: 'TEST-request',
      inputHash: 'TEST', sourceUrl: '', sourceStoryId: 'TEST-story', parsedResult: { plan: structuredClone(snapshot.plan) as PetStoryPlan } }] };
  const account: Account = { id: project.accountId, name: 'TEST 原账号', platform: 'doubao', partition: 'TEST-isolated-session', status: 'idle', avatar: '', pinned: false, createdAt: now, updatedAt: now };
  dispatchEvent.mockImplementation((event: Event): boolean => { actions.push(event.type); return true; });
  selectAccount.mockImplementation((accountId: string | null): void => { actions.push(`select:${accountId}`); useAccountStore.setState({ selectedAccountId: accountId }); });
  beginAdjustment.mockImplementation(async (): Promise<PetStoryAdjustmentResult> => adjustmentResult());
  listTasks.mockImplementation(async (): Promise<Task[]> => { actions.push('tasks:list'); return []; });
  vi.stubGlobal('window', { dispatchEvent, electronAPI: { petstory: { beginAdjustment, prepareRuntime, adoptPlanCandidate, confirmStory }, tasks: { list: listTasks } } });
  useAccountStore.setState({ ...initial.accounts, accounts: [account], selectedAccountId: 'TEST-other-account', selectAccount });
  useTaskStore.setState({ ...initial.tasks, tasks: [], accountBusy: {}, accountAutomationState: {} });
  usePetStoryStore.setState({ ...initial.petstory, project, busy: false, error: '', chatReadbackError: '', promptBatch: { total: 0, completed: 0, status: 'idle' } });
});
afterEach((): void => {
  usePetStoryStore.setState(initial.petstory); useAccountStore.setState(initial.accounts); useTaskStore.setState(initial.tasks); vi.unstubAllGlobals();
});

describe('方案调整先打开原会话，再刷新任务', (): void => {
  it('候选按 parentJobId 打开原账号会话，保留候选且不采用或发送', async (): Promise<void> => {
    const before = structuredClone(project);
    await usePetStoryStore.getState().openChatAdjustment(target);
    expect(beginAdjustment).toHaveBeenCalledExactlyOnceWith(project.id, project.revision, target);
    expect(actions).toEqual([`select:${project.accountId}`, 'reveal-workspace-browser', 'petstory-open-adjustment', 'tasks:list']);
    const current = usePetStoryStore.getState();
    expect(current.project?.jobs).toEqual(before.jobs); expect(current.project?.plan).toBeUndefined(); expect(current.project?.storyApproval).toBeUndefined();
    expect(current.project?.chatAdjustment).toMatchObject({ sourceJobId: target.parentJobId, status: 'active' });
    expect(useAccountStore.getState().selectedAccountId).toBe(project.accountId);
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(adoptPlanCandidate).not.toHaveBeenCalled(); expect(confirmStory).not.toHaveBeenCalled();
    expect(current.error).toBe(''); expect(current.busy).toBe(false);
  });

  it('任务刷新一直未完成时也已打开会话并解除操作忙碌状态', async (): Promise<void> => {
    const pending = deferred<Task[]>(); listTasks.mockReturnValueOnce(pending.promise);
    await usePetStoryStore.getState().openChatAdjustment(target);
    expect(dispatchEvent.mock.calls.map(([event]: [Event]): string => event.type)).toEqual(['reveal-workspace-browser', 'petstory-open-adjustment']);
    expect(usePetStoryStore.getState().busy).toBe(false); expect(usePetStoryStore.getState().project?.chatAdjustment?.status).toBe('active');
    pending.resolve([]); await pending.promise;
  });

  it('任务刷新失败保留已打开调整，以简短提示说明后台刷新情况', async (): Promise<void> => {
    listTasks.mockRejectedValueOnce(new Error('TEST 任务列表读取失败'));
    await usePetStoryStore.getState().openChatAdjustment(target);
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'petstory-open-adjustment' }));
    expect(usePetStoryStore.getState().chatReadbackError).toBe('任务状态暂未刷新，可继续在关联会话中调整');
    expect(usePetStoryStore.getState().error).toBe(''); expect(usePetStoryStore.getState().busy).toBe(false);
  });

  it.each(['reply-error', 'ended', 'other-adjustment', 'other-project'] as const)('迟到的刷新失败不覆盖 %s', async (changed: 'reply-error' | 'ended' | 'other-adjustment' | 'other-project'): Promise<void> => {
    const pending = deferred<Task[]>(); listTasks.mockReturnValueOnce(pending.promise);
    await usePetStoryStore.getState().openChatAdjustment(target);
    const current = structuredClone(usePetStoryStore.getState().project!);
    if (changed === 'ended') current.chatAdjustment!.status = 'ended';
    if (changed === 'other-adjustment') current.chatAdjustment!.id = 'TEST-another-adjustment';
    if (changed === 'other-project') current.id = 'TEST-another-project';
    const readback = changed === 'reply-error' ? 'TEST 当前会话有未发送草稿' : '';
    usePetStoryStore.setState({ project: current, chatReadbackError: readback });
    pending.reject(new Error('TEST 旧刷新失败')); await pending.promise.catch((): void => undefined);
    expect(usePetStoryStore.getState().chatReadbackError).toBe(readback);
  });

  it.each(['result', 'exception'] as const)('主进程通过 %s 拒绝时保留原因，不刷新、不切账号或展开', async (failure: 'result' | 'exception'): Promise<void> => {
    const reason = 'TEST 原会话暂时无法核对';
    if (failure === 'result') beginAdjustment.mockResolvedValueOnce({ success: false, error: reason });
    else beginAdjustment.mockRejectedValueOnce(new Error(reason));
    await usePetStoryStore.getState().openChatAdjustment(target);
    expect(usePetStoryStore.getState().error).toBe(reason); expect(usePetStoryStore.getState().project).toEqual(project);
    expect(listTasks).not.toHaveBeenCalled(); expect(selectAccount).not.toHaveBeenCalled(); expect(dispatchEvent).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().busy).toBe(false);
  });

  it('其他账号持有前台交互租约时保留账号保护，不调用调整或展开', async (): Promise<void> => {
    useTaskStore.setState({ accountAutomationState: { 'TEST-other-account': 'submitting' } });
    await usePetStoryStore.getState().openChatAdjustment(target);
    expect(usePetStoryStore.getState().error).toBe('这个账号仍在执行任务，请等待原任务结束再调整');
    expect(beginAdjustment).not.toHaveBeenCalled(); expect(listTasks).not.toHaveBeenCalled(); expect(selectAccount).not.toHaveBeenCalled(); expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('调整尚在建立时重复调用复用前台操作保护，只打开一次原会话', async (): Promise<void> => {
    const pending = deferred<PetStoryAdjustmentResult>(); beginAdjustment.mockReturnValueOnce(pending.promise);
    const opening = usePetStoryStore.getState().openChatAdjustment(target);
    // 进入主进程前仍需先完成批次暂停，重复点击受同一 busy 状态保护。
    await usePetStoryStore.getState().openChatAdjustment(target);
    expect(usePetStoryStore.getState().busy).toBe(true);
    pending.resolve(adjustmentResult()); await opening;
    expect(beginAdjustment).toHaveBeenCalledTimes(1); expect(listTasks).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls.map(([event]: [Event]): string => event.type)).toEqual(['reveal-workspace-browser', 'petstory-open-adjustment']);
    expect(usePetStoryStore.getState().busy).toBe(false);
  });
});
