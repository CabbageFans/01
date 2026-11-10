import { localMediaPort } from '../fixtures/taskRunIdentity';
/** 真实任务域、项目磁盘与制作服务的离线派发集成；不挂载浏览器或请求平台。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryCapability, PetStoryPlan, PetStoryProductionResult, PetStoryProject, Task, TaskAddParams, TaskUpdateRuntimeParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { PetStoryProductionService } from '../../main/utils/petstoryProduction';
import { mediaCommand } from '../../main/utils/petstoryMedia';
import { seedOfflinePromptContracts } from '../fixtures/petstoryPromptContracts';
import { automationEngine } from '../../src/automation/AutomationEngine';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';

const initial = { account: useAccountStore.getState(), task: useTaskStore.getState(), pet: usePetStoryStore.getState() };
let root: string; let picture: string; let directory: string;
let projects: PetStoryProjects; let service: PetStoryProductionService; let core: TaskService;
let project: PetStoryProject; let tasks: Task[]; let taskId: string;
let advanceGate: ReturnType<typeof deferred<void>> | undefined;
let bindingGate: ReturnType<typeof deferred<void>> | undefined;
let listGate: ReturnType<typeof deferred<void>> | undefined;
let gateListAfterStartAction: boolean;
let pending: Promise<unknown>[];
let bind: ReturnType<typeof vi.fn>; let advance: ReturnType<typeof vi.fn>; let pause: ReturnType<typeof vi.fn>; let list: ReturnType<typeof vi.fn>;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void; const promise = new Promise<T>((done): void => { resolve = done; }); return { promise, resolve };
}
function listed(): Task[] { return structuredClone(tasks); }
function currentTask(): Task { const task = tasks.find((item: Task): boolean => item.id === taskId); if (!task) throw new Error('TEST 任务缺失'); return structuredClone(task); }
function capability(): PetStoryCapability {
  const supported = { state: 'supported' as const, reason: 'TEST 离线控件契约' };
  return { accountId: 'TEST-dispatch-account', image: supported, modes: { first_frame: supported, first_last_frame: supported, reference: supported }, durations: [5],
    videoConfig: { model: 'seedance-2.0', aspectRatio: '9:16', duration: '5s' } };
}
function plan(): PetStoryPlan {
  const prompt = (kind: string): PetStoryPlan['shots'][number]['prompts']['video'] => ({ original: `TEST ${kind}`, optimized: `TEST ${kind}`, final: `TEST ${kind} 完整正文`, edited: true, rulesVersion: 'petstory-r11-v1' });
  return { sourceSummary: 'TEST 剧本摘要', adaptedStory: 'TEST 完整改编剧情', characters: [{ id: 'actor', name: 'TEST角色', role: 'main', purpose: 'TEST剧情', description: 'TEST历史描述' }], props: [],
    scenes: [{ id: 'room', name: 'TEST房间', location: 'TEST地点', time: '白天', lighting: '自然光', layout: '门窗位置', view: '正面', designOrigin: 'script' }],
    shots: [{ id: 'TEST-dispatch-shot', order: 1, characterIds: ['actor'], propIds: [], propStates: [], sceneId: 'room', scene: 'TEST房间', action: 'TEST动作', startState: 'TEST开始', endState: 'TEST结束',
      durationSeconds: 5, transition: 'cut', requestedMode: 'first_frame', prompts: { firstFrame: prompt('首帧'), video: prompt('视频') } }] };
}
function create(input: TaskAddParams, accountId: string): Task {
  const created = core.create(input); if (!created.success) throw new Error(created.error);
  const assigned = core.assign({ taskId: created.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error); return assigned.data;
}
function runtimeResult(id: string, patch: Omit<TaskUpdateRuntimeParams, 'taskId'>): object {
  const result = core.updateRuntime({ taskId: id, ...patch }); return result.success ? { success: true, task: result.data } : result;
}
async function authorizeWhileAdvanceWaits(): Promise<void> {
  advanceGate = deferred<void>();
  const resuming = usePetStoryStore.getState().resumeProduction(); pending.push(resuming);
  await vi.waitFor((): void => { expect(advance).toHaveBeenCalledOnce(); });
  expect(usePetStoryStore.getState().project?.production?.state).toBe('running');
}
async function finishAdvance(): Promise<void> {
  advanceGate?.resolve(); advanceGate = undefined;
  await Promise.all(pending);
}

beforeAll(async (): Promise<void> => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-production-dispatch-'));
  picture = path.join(root, 'TEST-frame.png');
  await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x96', '-frames:v', '1', '-y', picture]);
});
afterAll(async (): Promise<void> => { await fs.rm(root, { recursive: true, force: true }); });
beforeEach(async (): Promise<void> => {
  advanceGate = undefined; bindingGate = undefined; listGate = undefined; gateListAfterStartAction = false; pending = [];
  directory = await fs.mkdtemp(path.join(root, 'project-')); projects = new PetStoryProjects();
  project = await projects.create(directory, 'TEST-dispatch-studio', capability().accountId);
  project = await projects.saveMobileStory(project.id, project.revision, 'TEST 离线完整剧本');
  project.plan = plan(); project.source.status = 'review_required'; project = await projects.write(project);
  project = await projects.confirmStory(project.id, project.revision);
  project = await projects.addReference(project.id, 'actor', picture);
  project = await projects.addMaterialImage(project.id, project.revision, 'scene:room', picture);
  project = await projects.approveMaterials(project.id, project.revision, project.materials!.map((material): { materialId: string; assetId: string } => ({ materialId: material.id, assetId: project.assets.find((asset): boolean => asset.materialId === material.id)!.id })));
  project = await projects.addShotImage(project.id, project.revision, 'TEST-dispatch-shot', 'firstFrame', picture);
  project = await projects.adoptImage(project.id, project.revision, { shotId: 'TEST-dispatch-shot', kind: 'firstFrame' }, project.assets.at(-1)!.id);
  project.promptCapability = capability(); seedOfflinePromptContracts(project, undefined, { completeVideoBody: true }); project = await projects.write(project);
  tasks = []; let sequence = 0;
  core = new TaskService({ store: { read: listed, replace: (items: Task[]): boolean => { tasks = structuredClone(items); return true; } },
    defaultProjectId: (): string => project.studioProjectId, id: (): string => `TEST-production-dispatch-task-${++sequence}` });
  service = new PetStoryProductionService(projects, { updateLocalMedia: localMediaPort(core), list: listed, create,
    adopt: (id: string, binding: NonNullable<Task['petstory']>, text?: string): Task => { const result = core.bindPetStory(id, binding, text); if (!result.success) throw new Error(result.error); return result.data; },
    bindPageInput: (id: string, runId: string, text: string): Task => { const result = core.bindPetStoryPageInput(id, runId, text); if (!result.success) throw new Error(result.error); return result.data; },
    retryUnsubmitted: (id: string): Task => { const result = core.retry(id, 'hold'); if (!result.success) throw new Error(result.error); return result.data; },
    downloads: (): [] => [], download: async (): Promise<never> => { throw new Error('TEST 禁止下载或平台操作'); } });
  const prepared = await service.generateShotMedia(project.id, project.revision, 'TEST-dispatch-shot', 'video', capability());
  expect(prepared.success).toBe(true); const next = await service.advance(project.id); expect(next.action).toBe('start'); taskId = next.taskId!;
  project = (await service.pause(project.id)).project!;
  bind = vi.fn(async (id: string, idTask: string, runId: string): Promise<PetStoryProductionResult> => { if (bindingGate) await bindingGate.promise; return service.bindRun(id, idTask, runId); });
  advance = vi.fn(async (id: string): Promise<PetStoryProductionResult> => {
    if (advanceGate) await advanceGate.promise;
    const result = await service.advance(id);
    // 延迟的是正式列表回读；推进服务仍真实产出start，重现队列在画布回读间先取得同task执行权。
    if (gateListAfterStartAction && result.action === 'start') { gateListAfterStartAction = false; listGate = deferred<void>(); }
    return result;
  });
  pause = vi.fn(async (id: string): Promise<PetStoryProductionResult> => service.pause(id));
  list = vi.fn(async (): Promise<Task[]> => { if (listGate) await listGate.promise; return listed(); });
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { petstory: {
    resumeProduction: service.resume.bind(service), pauseProduction: pause, advanceProduction: advance, bindProductionRun: bind, guardProductionTask: service.guard.bind(service),
  }, tasks: { list, updateRuntime: async (id: string, patch: Omit<TaskUpdateRuntimeParams, 'taskId'>): Promise<object> => runtimeResult(id, patch),
    acquireLock: async (id: string, ownerId: string): Promise<object> => core.acquireLock({ taskId: id, ownerId }),
    releaseLock: async (id: string, ownerId: string): Promise<object> => core.releaseLock({ taskId: id, ownerId }),
    renewLock: async (id: string, ownerId: string): Promise<object> => core.renewLock({ taskId: id, ownerId }),
  }, accounts: { setStatus: vi.fn() }, logs: { append: vi.fn() } } });
  const now = new Date().toISOString(); const account: Account = { id: project.accountId, name: 'TEST隔离账号', platform: 'doubao', partition: 'TEST-partition', avatar: '', status: 'idle', pinned: false, createdAt: now, updatedAt: now,
    health: { loginState: 'ok', verificationRequired: false, consecutiveFailures: 0, successCount: 0, failureCount: 0, availability: { state: 'ready', reason: 'ready', message: 'TEST离线', source: 'manual', checkedAt: now } } };
  useAccountStore.setState({ ...initial.account, accounts: [account] });
  useTaskStore.setState({ ...initial.task, tasks: listed(), schedulerPaused: false, accountBusy: {}, executingTasks: {}, accountAutomationState: {}, accountAutoMessage: {}, activeTaskId: null });
  usePetStoryStore.setState({ ...initial.pet, project, busy: false, error: '', capability: capability() });
});
afterEach(async (): Promise<void> => {
  bindingGate?.resolve(); bindingGate = undefined; listGate?.resolve(); listGate = undefined;
  advanceGate?.resolve(); advanceGate = undefined; await Promise.allSettled(pending);
  await usePetStoryStore.getState().pauseProduction();
  for (const task of tasks) await automationEngine.release(task.id);
  usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.task); useAccountStore.setState(initial.account);
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('通用媒体调度先完成真实制作运行绑定再发布执行权', (): void => {
  it('直接无callback启动必须绑定同一run，绑定等待期间零页面派发', async (): Promise<void> => {
    await authorizeWhileAdvanceWaits(); bindingGate = deferred<void>();
    const starting = useTaskStore.getState().startAutomation(taskId); pending.push(starting);
    await vi.waitFor((): void => { expect(bind.mock.calls.length > 0 || Object.keys(useTaskStore.getState().executingTasks).length > 0).toBe(true); });
    expect(bind).toHaveBeenCalledOnce(); expect(useTaskStore.getState().executingTasks).toEqual({}); expect(useTaskStore.getState().accountBusy).toEqual({});
    const runId = currentTask().runtime!.runId; expect((await projects.read(project.id)).production!.steps[0].runId).toBeUndefined();
    bindingGate.resolve(); bindingGate = undefined; expect(await starting).toBe(true);
    expect((await projects.read(project.id)).production!.steps[0].runId).toBe(runId);
    expect((await service.guard(taskId)).success).toBe(true); expect(useTaskStore.getState().executingTasks[project.accountId]).toBe(taskId);
    expect(currentTask().runtime?.submittedAt).toBeUndefined(); await finishAdvance();
  });

  it('正式队列无callback启动也先持久化同run绑定，不能只依赖画布callback', async (): Promise<void> => {
    await authorizeWhileAdvanceWaits(); expect(core.updateRuntime({ taskId, executionIntent: 'armed' }).success).toBe(true); useTaskStore.setState({ tasks: listed() });
    await useTaskStore.getState().processQueue();
    expect(bind).toHaveBeenCalledOnce(); const task = currentTask(); expect(task.status).toBe('executing');
    expect((await projects.read(project.id)).production!.steps[0].runId).toBe(task.runtime?.runId);
    expect((await service.guard(taskId)).success).toBe(true); expect(useTaskStore.getState().executingTasks[project.accountId]).toBe(taskId);
    expect(task.runtime?.submittedAt).toBeUndefined(); await finishAdvance();
  });

  it('仅打开已保存制作而未显式继续时，通用启动拒绝且零发布', async (): Promise<void> => {
    expect(await useTaskStore.getState().startAutomation(taskId)).toBe(false);
    expect(bind).not.toHaveBeenCalled(); expect(useTaskStore.getState().executingTasks).toEqual({}); expect(useTaskStore.getState().accountBusy).toEqual({});
    expect(currentTask()).toMatchObject({ status: 'paused', executionIntent: 'hold', errorInfo: { code: 'dispatch_not_ready' } });
    expect(currentTask().runtime?.submittedAt).toBeUndefined(); expect((await projects.read(project.id)).production?.state).toBe('paused');
  });

  it('绑定等待时主进程撤销制作授权，旧renderer快照不能放行页面', async (): Promise<void> => {
    await authorizeWhileAdvanceWaits(); bindingGate = deferred<void>();
    const starting = useTaskStore.getState().startAutomation(taskId); pending.push(starting);
    await vi.waitFor((): void => { expect(bind).toHaveBeenCalledOnce(); });
    await service.pause(project.id);
    expect(usePetStoryStore.getState().project?.production?.state).toBe('running');
    bindingGate.resolve(); bindingGate = undefined; expect(await starting).toBe(false);
    expect(useTaskStore.getState().executingTasks).toEqual({}); expect(useTaskStore.getState().accountBusy).toEqual({});
    expect(currentTask()).toMatchObject({ status: 'paused', executionIntent: 'hold', errorInfo: { code: 'dispatch_not_ready' } });
    expect(currentTask().runtime?.submittedAt).toBeUndefined(); expect(automationEngine.isReserved(taskId)).toBe(false);
    expect((await projects.read(project.id)).production!.steps[0].runId).toBeUndefined(); await finishAdvance();
  });

  it('同task队列在画布start前先赢，画布的重复start=false不能暂停已绑定的新run', async (): Promise<void> => {
    gateListAfterStartAction = true;
    const resuming = usePetStoryStore.getState().resumeProduction(); pending.push(resuming);
    await vi.waitFor((): void => { expect(listGate).toBeDefined(); expect(list.mock.calls.length).toBeGreaterThanOrEqual(2); });
    expect(core.updateRuntime({ taskId, executionIntent: 'armed' }).success).toBe(true); useTaskStore.setState({ tasks: listed() });
    await useTaskStore.getState().processQueue(); const winner = currentTask(); expect(winner.status).toBe('executing');
    expect(useTaskStore.getState().executingTasks[project.accountId]).toBe(taskId);
    listGate!.resolve(); listGate = undefined; await resuming;
    expect(pause).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().project?.production?.state).toBe('running');
    expect((await projects.read(project.id)).production!.steps[0].runId).toBe(winner.runtime?.runId);
    expect(currentTask().runtime?.runId).toBe(winner.runtime?.runId); expect(currentTask().runtime?.submittedAt).toBeUndefined();
    expect((await service.guard(taskId)).success).toBe(true); expect(bind).toHaveBeenCalledOnce();
  });
});
