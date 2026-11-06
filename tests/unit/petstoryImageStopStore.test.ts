/** 停止只撤销本地自动化与原操作授权；所有平台发送、下载及项目均为离线替身。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { Account, PetStoryChatJob, PetStoryImageOperationRequest, PetStoryImageOperationResult, PetStoryPlan, PetStoryProject, PetStoryResult, Task } from '@doubao-studio/contracts';
import { tickPetStoryImageOperation, usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import { automationEngine } from '../../src/automation/AutomationEngine';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState(), studio: useProjectStore.getState() };
const target = { materialId: 'character:TEST-a' };
const now = '2026-11-06T00:00:00.000Z';
let project: PetStoryProject; let tasks: Task[]; let serial = 0;
type RuntimePatch = Parameters<typeof initial.tasks.updateTaskRuntime>[1];
const begin = vi.fn<(id: string, revision: number, request: PetStoryImageOperationRequest) => Promise<PetStoryImageOperationResult>>();
const advance = vi.fn<(id: string, operationId: string) => Promise<PetStoryImageOperationResult>>();
const pause = vi.fn<(id: string, operationId: string) => Promise<PetStoryImageOperationResult>>();
const resume = vi.fn<(id: string, operationId: string) => Promise<PetStoryImageOperationResult>>();
const bind = vi.fn<() => Promise<PetStoryResult>>();
const update = vi.fn<(id: string, patch: RuntimePatch) => Promise<{ success: boolean; task?: Task; error?: string }>>();
const start = vi.fn<(id: string, before?: (task: Task) => Promise<void>) => Promise<boolean>>();
let events: MockInstance<(event: Event) => boolean>;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done): void => { resolve = done; }), resolve: (value: T): void => resolve(value) };
}
function saved(): PetStoryProject { project = structuredClone(project); project.revision++; return project; }
function result(): PetStoryImageOperationResult { return { success: true, project: saved(), operationId: project.imageOperations![0].id }; }
function createOperation(request: PetStoryImageOperationRequest): PetStoryImageOperationResult {
  const operationId = `TEST-stop-operation-${serial}`; const taskId = `TEST-stop-task-${serial}`;
  project.imageOperations = [{ id: operationId, requestId: request.requestId, target: request.target, mode: 'modify', stage: 'generating',
    createdAt: now, basisHash: 'TEST', taskId, baseAssetId: request.baseAssetId, feedback: request.feedback }];
  const capability = { state: 'unknown' as const, reason: 'TEST' };
  project.imageProductions = { [operationId]: { phase: 'materials', state: 'running', imageOperationId: operationId, planHash: 'TEST', approvedAt: now,
    materialIds: [target.materialId], capability: { accountId: project.accountId, image: capability, durations: [], modes: { first_frame: capability, first_last_frame: capability, reference: capability } },
    fallbacks: {}, shots: {}, message: 'TEST', steps: [{ id: 'TEST-step', kind: 'character', materialId: target.materialId, status: 'bound',
      taskId, inputHash: 'TEST', attachmentAssetIds: [] }] } };
  tasks.push({ id: taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'image', status: 'queued', executionIntent: 'hold',
    prompt: 'TEST 原图片完整请求', outputs: [], result: null, createdAt: now, updatedAt: now,
    petstory: { projectId: project.id, stepId: 'TEST-step', imageOperationId: operationId, materialId: target.materialId } });
  return result();
}
function cancelEvents(): CustomEvent<{ taskId: string; targetStatus: string }>[] {
  return events.mock.calls.map(([event]): Event => event as Event).filter((event): boolean => event.type === 'cancel-task-automation') as CustomEvent<{ taskId: string; targetStatus: string }>[];
}
function run(): Promise<void> { return usePetStoryStore.getState().modifyImage(target, 'TEST-base', '光线柔和一点'); }
function submitted(status: Task['status'] = 'generating'): Task {
  const task = tasks[0]; task.status = status;
  task.runtime = { runId: 'TEST-original-run', attempt: 1, stage: status === 'manual_submission_observing' ? 'manual_submission_observing' : 'generating', message: 'TEST',
    startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, conversationUrl: 'https://www.doubao.com/chat/TEST-original',
    input: { mode: task.mode, prompt: task.prompt, attachments: [], petstory: task.petstory } };
  project.imageProductions![project.imageOperations![0].id].steps[0].runId = task.runtime.runId;
  useTaskStore.setState({ tasks: structuredClone(tasks) }); usePetStoryStore.setState({ project: structuredClone(project) }); return task;
}
function shotPreparation(status: PetStoryChatJob['status'] = 'invalid'): { shotId: string; job: PetStoryChatJob } {
  const shot = project.plan!.shots[0]; shot.prompts.firstFrame.final = '';
  const job: PetStoryChatJob = { id: 'TEST-shot-prepare', taskId: 'TEST-shot-prepare-task', kind: 'optimize', shotId: shot.id, promptKind: 'firstFrame',
    status, inputHash: 'TEST', sourceUrl: '', sourceStoryId: project.mobileStory!.id, createdAt: now, requestId: 'TEST-shot-prepare-request',
    ...(status === 'invalid' ? { rawText: 'TEST 原回复缺项', validationDetails: [{ code: 'prompt_content', path: 'optimized', actualType: 'string', expected: '完整正文', message: 'TEST可修订', repairable: true }] } : {}) };
  project.jobs = [job];
  tasks = [{ id: job.taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: status === 'invalid' ? 'done' : 'queued',
    executionIntent: 'hold', prompt: 'TEST 原文字请求', outputs: [], result: null, createdAt: now, updatedAt: now,
    petstoryChat: { projectId: project.id, jobId: job.id } }];
  usePetStoryStore.setState({ project: structuredClone(project) }); useTaskStore.setState({ tasks: structuredClone(tasks) });
  return { shotId: shot.id, job };
}

beforeEach((): void => {
  vi.resetAllMocks(); serial++; tasks = [];
  project = { id: `TEST-stop-project-${serial}`, studioProjectId: 'TEST-studio', accountId: 'TEST-account', schemaVersion: 1, revision: 1, updatedAt: now,
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now },
    plan: structuredClone(snapshot.plan) as PetStoryPlan, jobs: [], assets: [], materials: [{ id: target.materialId, entityId: 'TEST-a', name: 'TEST角色', kind: 'character',
      designHash: 'TEST', prompt: { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST' } }] };
  begin.mockImplementation(async (_id: string, _revision: number, request: PetStoryImageOperationRequest): Promise<PetStoryImageOperationResult> => createOperation(request));
  advance.mockImplementation(async (): Promise<PetStoryImageOperationResult> => ({ ...result(), taskId: tasks[0].id, action: tasks[0].status === 'queued' ? 'start' : 'wait' }));
  pause.mockImplementation(async (_id: string, operationId: string): Promise<PetStoryImageOperationResult> => {
    const operation = project.imageOperations!.find((item): boolean => item.id === operationId)!;
    if (operation.stage !== 'complete') { operation.stage = 'failed'; operation.error = '本次图片任务已暂停，请继续原任务'; if (project.imageProductions?.[operationId]) project.imageProductions[operationId].state = 'paused'; }
    return { ...result(), success: operation.stage === 'complete', error: operation.error };
  });
  resume.mockImplementation(async (): Promise<PetStoryImageOperationResult> => { project.imageOperations![0].stage = 'generating'; return result(); });
  bind.mockImplementation(async (): Promise<PetStoryResult> => ({ success: true, project: saved() }));
  update.mockImplementation(async (id: string, patch: RuntimePatch): Promise<{ success: boolean; task: Task }> => {
    const task = tasks.find((item): boolean => item.id === id)!;
    Object.assign(task, patch, { runtime: task.runtime || patch.runtime ? { ...task.runtime, ...patch.runtime } : undefined });
    return { success: true, task: structuredClone(task) };
  });
  start.mockImplementation(async (id: string, before?: (task: Task) => Promise<void>): Promise<boolean> => {
    const task = tasks.find((item): boolean => item.id === id)!;
    task.status = 'executing'; task.runtime = { runId: 'TEST-original-run', attempt: 1, stage: 'preparing_account', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { mode: task.mode, prompt: task.prompt, attachments: [], petstory: task.petstory } };
    useTaskStore.setState({ tasks: structuredClone(tasks) });
    try { await before?.(task); return true; } catch { return false; }
  });
  const windowStub = Object.assign(new EventTarget(), { electronAPI: { petstory: { beginImageOperation: begin, advanceImageOperation: advance, pauseImageOperation: pause,
    resumeImageOperation: resume, bindProductionRun: bind, open: async (): Promise<PetStoryResult> => ({ success: true, project }) },
  tasks: { list: async (): Promise<Task[]> => structuredClone(tasks), updateRuntime: update, releaseLock: vi.fn(async (): Promise<{ success: true }> => ({ success: true })) } } });
  events = vi.spyOn(windowStub, 'dispatchEvent'); vi.stubGlobal('window', windowStub);
  vi.spyOn(automationEngine, 'abort').mockReturnValue(true); vi.spyOn(automationEngine, 'hasController').mockReturnValue(false); vi.spyOn(automationEngine, 'release').mockResolvedValue();
  const account: Account = { id: project.accountId, name: 'TEST账号', platform: 'doubao', partition: 'TEST', status: 'idle', pinned: false, avatar: '', createdAt: now, updatedAt: now };
  useAccountStore.setState({ ...initial.accounts, accounts: [account] });
  useProjectStore.setState({ ...initial.studio, projects: [{ id: project.studioProjectId, name: 'TEST项目', description: '', archived: false, color: '#fff', createdAt: now, updatedAt: now }], selectProject: vi.fn() });
  useTaskStore.setState({ ...initial.tasks, tasks, startAutomation: start, accountBusy: {}, executingTasks: {}, accountAutomationState: {} });
  usePetStoryStore.setState({ ...initial.pet, project, busy: false, activeImageOperationId: null, activeImageOperationIds: [], pendingImageTargets: [], imageTargetErrors: {} });
});
afterEach(async (): Promise<void> => {
  vi.useRealTimers();
  await usePetStoryStore.getState().openProject('TEST-clear-authorization');
  usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.tasks); useAccountStore.setState(initial.accounts); useProjectStore.setState(initial.studio);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('图片停止的发送授权与原记录收束', (): void => {
  it('begin IPC未返回时立即撤回pending；迟到hold任务只暂停，不启动或推进', async (): Promise<void> => {
    const gate = deferred<PetStoryImageOperationResult>(); begin.mockReturnValue(gate.promise);
    const pending = run(); await vi.waitFor((): void => { expect(begin).toHaveBeenCalledOnce(); });
    await usePetStoryStore.getState().stopImageOperation(target);
    expect(usePetStoryStore.getState().pendingImageTargets).toEqual([]); expect(usePetStoryStore.getState().activeImageOperationIds).toEqual([]);
    gate.resolve(createOperation(begin.mock.calls[0][2])); await pending;
    expect(start).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled(); expect(pause).toHaveBeenCalledOnce();
    expect(tasks[0]).toMatchObject({ status: 'paused', executionIntent: 'hold' }); expect(tasks[0].runtime).toBeUndefined();
  });

  it('生成中立即打断原controller，持久化paused/hold并保留原输入提交会话与候选', async (): Promise<void> => {
    await run(); const task = submitted(); const before = structuredClone(task.runtime);
    project.assets.push({ id: 'TEST-old-candidate', kind: 'character', materialId: target.materialId, relativePath: 'TEST.png' });
    usePetStoryStore.setState({ project: structuredClone(project) });
    const stopped = usePetStoryStore.getState().stopImageOperation(target);
    expect(automationEngine.abort).toHaveBeenCalledWith(task.id); expect(cancelEvents().some((event): boolean => event.detail.taskId === task.id && event.detail.targetStatus === 'paused')).toBe(true);
    await stopped;
    expect(tasks[0]).toMatchObject({ status: 'paused', executionIntent: 'hold', runtime: { runId: before?.runId, submittedAt: before?.submittedAt, input: before?.input, conversationUrl: before?.conversationUrl } });
    expect(usePetStoryStore.getState().project?.assets).toEqual(project.assets); expect(usePetStoryStore.getState().activeImageOperationIds).toEqual([]); expect(usePetStoryStore.getState().pendingImageTargets).toEqual([]);
    const calls = advance.mock.calls.length; await tickPetStoryImageOperation(); expect(advance).toHaveBeenCalledTimes(calls);
  });

  it('bind IPC在途停止不等待currentWork，迟到绑定不能授予发送权', async (): Promise<void> => {
    const gate = deferred<PetStoryResult>(); bind.mockReturnValue(gate.promise);
    const pending = run(); await vi.waitFor((): void => { expect(bind).toHaveBeenCalledOnce(); });
    await usePetStoryStore.getState().stopImageOperation(target);
    expect(tasks[0]).toMatchObject({ status: 'paused', executionIntent: 'hold' });
    gate.resolve({ success: true, project: structuredClone(project) }); await pending;
    expect(usePetStoryStore.getState().activeImageOperationIds).toEqual([]); expect(start).toHaveBeenCalledOnce(); expect(pause).toHaveBeenCalledOnce();
    expect(tasks[0].runtime?.submittedAt).toBeUndefined();
  });

  it('saving暂停等待已有下载完成后保留complete候选和done，不降为paused或自动采用', async (): Promise<void> => {
    await run(); submitted(); tasks[0].status = 'done'; tasks[0].outputs = ['https://TEST.invalid/original.png'];
    useTaskStore.setState({ tasks: structuredClone(tasks) });
    pause.mockImplementationOnce(async (): Promise<PetStoryImageOperationResult> => {
      const operation = project.imageOperations![0]; operation.stage = 'complete'; operation.outputAssetId = 'TEST-saved';
      project.imageProductions![operation.id].state = 'complete'; project.assets.push({ id: 'TEST-saved', kind: 'character', materialId: target.materialId, relativePath: 'TEST.png', imageReview: { state: 'candidate', target, basisHash: 'TEST' } });
      return result();
    });
    await usePetStoryStore.getState().stopImageOperation(target);
    expect(tasks[0].status).toBe('done'); expect(update).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().project?.imageOperations![0].stage).toBe('complete');
    expect(usePetStoryStore.getState().project?.assets[0].imageReview?.state).toBe('candidate');
  });

  it('暂停写入失败显示真实错误，不把乐观本地状态当成已持久化停止', async (): Promise<void> => {
    await run(); submitted(); update.mockResolvedValueOnce({ success: false, error: 'TEST 暂停落盘失败' });
    await expect(usePetStoryStore.getState().stopImageOperation(target)).rejects.toThrow('TEST 暂停落盘失败');
    expect(usePetStoryStore.getState().error).toContain('TEST 暂停落盘失败'); expect(tasks[0].status).toBe('generating');
    expect(usePetStoryStore.getState().activeImageOperationIds).toEqual([]); expect(automationEngine.abort).toHaveBeenCalled();
  });

  it('独立原结果观察收到停止事件，迟到onSettled不得复活授权或自动推进', async (): Promise<void> => {
    await run(); const task = submitted('paused');
    await usePetStoryStore.getState().recoverImageOperation(project.imageOperations![0].id);
    const observed = events.mock.calls.map(([event]): Event => event as Event).find((event): boolean => event.type === 'reconcile-task-submission') as CustomEvent<{ onSettled: () => Promise<void> }>;
    expect(observed).toBeDefined(); expect(tasks[0].status).toBe('manual_submission_observing');
    const before = structuredClone(task.runtime); const advanceCount = advance.mock.calls.length;
    await usePetStoryStore.getState().stopImageOperation(target);
    expect(cancelEvents().some((event): boolean => event.detail.taskId === task.id && event.detail.targetStatus === 'paused')).toBe(true);
    await observed.detail.onSettled();
    expect(usePetStoryStore.getState().activeImageOperationIds).toEqual([]); expect(advance).toHaveBeenCalledTimes(advanceCount);
    expect(tasks[0].runtime).toMatchObject({ runId: before?.runId, submittedAt: before?.submittedAt, input: before?.input });
  });

  it('controller退出前迟到写回观察状态，停止必须在cleanup后再次回读为paused/hold', async (): Promise<void> => {
    await run(); submitted(); vi.useFakeTimers();
    let controlling = true; vi.mocked(automationEngine.hasController).mockImplementation((): boolean => controlling);
    setTimeout((): void => { tasks[0].status = 'manual_submission_observing'; controlling = false; }, 100);
    const stopped = usePetStoryStore.getState().stopImageOperation(target);
    await vi.advanceTimersByTimeAsync(200); await stopped;
    expect(tasks[0]).toMatchObject({ status: 'paused', executionIntent: 'hold', runtime: { runId: 'TEST-original-run', submittedAt: now } });
    expect(usePetStoryStore.getState().pendingImageTargets).toEqual([]); expect(usePetStoryStore.getState().activeImageOperationIds).toEqual([]);
  });

  it('暂停IPC等待期间同task进入后来run，旧停止不再中断或改写该新运行', async (): Promise<void> => {
    await run(); submitted();
    const gate = deferred<PetStoryImageOperationResult>(); pause.mockReturnValueOnce(gate.promise);
    const stopped = usePetStoryStore.getState().stopImageOperation(target);
    await vi.waitFor((): void => { expect(update).toHaveBeenCalledOnce(); });
    const abortCount = vi.mocked(automationEngine.abort).mock.calls.length;
    tasks[0] = { ...tasks[0], status: 'generating', executionIntent: 'armed', runtime: { ...tasks[0].runtime!, runId: 'TEST-later-run', submittedAt: '2026-11-06T01:00:00.000Z' } };
    useTaskStore.setState({ tasks: structuredClone(tasks) });
    project.imageOperations![0].stage = 'failed'; project.imageProductions![project.imageOperations![0].id].state = 'paused';
    gate.resolve({ ...result(), success: false }); await stopped;
    expect(tasks[0]).toMatchObject({ status: 'generating', executionIntent: 'armed', runtime: { runId: 'TEST-later-run' } });
    expect(automationEngine.abort).toHaveBeenCalledTimes(abortCount); expect(update).toHaveBeenCalledOnce();
  });

  it('后台准备的repair IPC在途停止，迟到新hold子任务保留并暂停且不派发', async (): Promise<void> => {
    const jobId = 'TEST-prepare-job'; const taskId = 'TEST-prepare-task';
    const rootJob: PetStoryChatJob = { id: jobId, taskId, kind: 'materialPrompt', materialId: target.materialId, status: 'bound', inputHash: 'TEST', sourceUrl: '',
      sourceStoryId: project.mobileStory!.id, createdAt: now, requestId: 'TEST-original-request', expectedIds: [target.materialId] };
    begin.mockImplementationOnce(async (_id: string, _revision: number, request: PetStoryImageOperationRequest): Promise<PetStoryImageOperationResult> => {
      createOperation(request); const operation = project.imageOperations![0]; operation.stage = 'preparing'; operation.taskId = undefined; operation.chatJobId = jobId;
      project.imageProductions = undefined; project.jobs = [rootJob];
      tasks = [{ ...tasks[0], id: taskId, mode: 'chat', petstory: undefined, petstoryChat: { projectId: project.id, jobId, imageOperationId: operation.id, materialId: target.materialId } }];
      return { ...result(), chatJobId: jobId };
    });
    const api = window.electronAPI.petstory;
    api.bindRun = vi.fn(async (): Promise<PetStoryResult> => { project.jobs.find((job): boolean => job.id === jobId)!.runId = 'TEST-original-run'; return { success: true, project: saved() }; });
    await usePetStoryStore.getState().generateMaterialImage(target.materialId);
    tasks[0].status = 'done'; tasks[0].runtime!.submittedAt = now;
    tasks[0].runtime!.chatResponse = { text: 'TEST invalid reply', capturedAt: now };
    useTaskStore.setState({ tasks: structuredClone(tasks) });
    api.collectChat = vi.fn(async (): Promise<PetStoryResult> => {
      project.jobs[0].status = 'invalid'; project.jobs[0].rawText = 'TEST invalid reply';
      project.jobs[0].validationDetails = [{ code: 'prompt_content', path: 'optimized', actualType: 'string', expected: '完整提示词', message: 'TEST 可修订', repairable: true, targetId: target.materialId }];
      return { success: false, needsRepair: true, repairSourceJobId: jobId, project: saved() };
    });
    const gate = deferred<PetStoryResult>(); api.prepareRuntime = vi.fn((): Promise<PetStoryResult> => gate.promise);
    const collecting = usePetStoryStore.getState().collect(jobId, true);
    await vi.waitFor((): void => { expect(api.prepareRuntime).toHaveBeenCalledOnce(); });
    const startCount = start.mock.calls.length;
    await usePetStoryStore.getState().stopImageOperation(target);
    const child: PetStoryChatJob = { ...rootJob, id: 'TEST-repair-job', taskId: 'TEST-repair-task', kind: 'repair', parentJobId: jobId, status: 'bound', runId: undefined };
    project.jobs.push(child); tasks.push({ ...tasks[0], id: child.taskId, status: 'queued', runtime: undefined, executionIntent: 'hold',
      petstoryChat: { projectId: project.id, jobId: child.id, imageOperationId: project.imageOperations![0].id, materialId: target.materialId } });
    gate.resolve({ success: true, project: saved(), taskId: child.taskId }); await collecting;
    expect(start).toHaveBeenCalledTimes(startCount); expect(tasks[1]).toMatchObject({ status: 'paused', executionIntent: 'hold' });
    expect(tasks[0].status).toBe('done'); expect(tasks).toHaveLength(2); expect(usePetStoryStore.getState().activeImageOperationIds).toEqual([]);
  });

  it('画布图片先接续已有文字任务时，停止同样阻止迟到任务列表触发派发', async (): Promise<void> => {
    const shot = project.plan!.shots[0]; shot.prompts.firstFrame.final = '';
    const job: PetStoryChatJob = { id: 'TEST-existing-optimize', taskId: 'TEST-existing-optimize-task', kind: 'optimize', shotId: shot.id, promptKind: 'firstFrame',
      status: 'bound', inputHash: 'TEST', sourceUrl: '', sourceStoryId: project.mobileStory!.id, createdAt: now, requestId: 'TEST-existing-optimize-request' };
    project.jobs.push(job);
    tasks = [{ id: job.taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: 'queued', executionIntent: 'hold',
      prompt: 'TEST 原文字请求', outputs: [], result: null, createdAt: now, updatedAt: now, petstoryChat: { projectId: project.id, jobId: job.id } }];
    usePetStoryStore.setState({ project: structuredClone(project) }); useTaskStore.setState({ tasks: structuredClone(tasks) });
    const gate = deferred<Task[]>(); const list = vi.fn(async (): Promise<Task[]> => structuredClone(tasks)); list.mockReturnValueOnce(gate.promise); window.electronAPI.tasks.list = list;
    const pending = usePetStoryStore.getState().generateShotMedia(shot.id, 'firstFrame');
    await vi.waitFor((): void => { expect(list).toHaveBeenCalledOnce(); });
    await usePetStoryStore.getState().stopImageOperation({ shotId: shot.id, kind: 'firstFrame' });
    gate.resolve(structuredClone(tasks)); await pending;
    expect(start).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled(); expect(tasks[0]).toMatchObject({ status: 'paused', executionIntent: 'hold' });
  });

  it('画布图片旧文字collect在途停止，只保存迟到回复，不创建格式修订或生图', async (): Promise<void> => {
    const { shotId } = shotPreparation();
    const gate = deferred<PetStoryResult>(); window.electronAPI.petstory.collectChat = vi.fn((): Promise<PetStoryResult> => gate.promise);
    window.electronAPI.petstory.prepareRuntime = vi.fn(async (): Promise<PetStoryResult> => ({ success: false, error: 'TEST 不应准备新任务' }));
    const pending = usePetStoryStore.getState().generateShotMedia(shotId, 'firstFrame');
    await vi.waitFor((): void => { expect(window.electronAPI.petstory.collectChat).toHaveBeenCalledOnce(); });
    await usePetStoryStore.getState().stopImageOperation({ shotId, kind: 'firstFrame' });
    gate.resolve({ success: false, needsRepair: true, repairSourceJobId: project.jobs[0].id, project: saved() }); await pending;
    expect(window.electronAPI.petstory.prepareRuntime).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().project?.jobs[0].rawText).toBe('TEST 原回复缺项');
  });

  it('画布图片旧修订recheck在途停止，不递归创建下一项修订', async (): Promise<void> => {
    const { shotId, job } = shotPreparation(); const gate = deferred<PetStoryResult>();
    const collect = vi.fn(async (): Promise<PetStoryResult> => {
      const child: PetStoryChatJob = { ...job, id: 'TEST-existing-repair', taskId: 'TEST-existing-repair-task', kind: 'repair', parentJobId: job.id };
      project.jobs.push(child);
      return { success: false, needsRepair: true, repairSourceJobId: job.id, repairJobId: child.id, project: saved() };
    });
    collect.mockReturnValueOnce(Promise.resolve().then((): PetStoryResult => {
      project.jobs.push({ ...job, id: 'TEST-existing-repair', taskId: 'TEST-existing-repair-task', kind: 'repair', parentJobId: job.id });
      return { success: false, needsRepair: true, repairSourceJobId: job.id, repairJobId: 'TEST-existing-repair', project: saved() };
    })).mockReturnValueOnce(gate.promise);
    window.electronAPI.petstory.collectChat = collect;
    window.electronAPI.petstory.prepareRuntime = vi.fn(async (): Promise<PetStoryResult> => ({ success: false, error: 'TEST 不应准备新任务' }));
    const pending = usePetStoryStore.getState().generateShotMedia(shotId, 'firstFrame');
    await vi.waitFor((): void => { expect(collect).toHaveBeenCalledTimes(2); });
    await usePetStoryStore.getState().stopImageOperation({ shotId, kind: 'firstFrame' });
    gate.resolve({ success: false, needsRepair: true, repairSourceJobId: 'TEST-existing-repair', project: saved() }); await pending;
    expect(window.electronAPI.petstory.prepareRuntime).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });

  it('没有imageOperation的新画布文字在bind期间停止，迟到绑定仍不能派发', async (): Promise<void> => {
    const { shotId, job } = shotPreparation('bound'); project.jobs = []; tasks = []; usePetStoryStore.setState({ project: structuredClone(project) }); useTaskStore.setState({ tasks: [] });
    window.electronAPI.petstory.prepareRuntime = vi.fn(async (): Promise<PetStoryResult> => {
      project.jobs = [job]; tasks = [{ id: job.taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: 'queued', executionIntent: 'hold',
        prompt: 'TEST 原文字请求', outputs: [], result: null, createdAt: now, updatedAt: now, petstoryChat: { projectId: project.id, jobId: job.id } }];
      return { success: true, project: saved(), taskId: job.taskId };
    });
    const gate = deferred<PetStoryResult>(); window.electronAPI.petstory.bindRun = vi.fn((): Promise<PetStoryResult> => gate.promise);
    const pending = usePetStoryStore.getState().generateShotMedia(shotId, 'firstFrame');
    await vi.waitFor((): void => { expect(window.electronAPI.petstory.bindRun).toHaveBeenCalledOnce(); });
    await usePetStoryStore.getState().stopImageOperation({ shotId, kind: 'firstFrame' });
    project.jobs[0].runId = 'TEST-original-run'; gate.resolve({ success: true, project: saved() }); await pending;
    expect(await start.mock.results[0].value).toBe(false); expect(tasks[0]).toMatchObject({ status: 'paused', executionIntent: 'hold' });
    expect(tasks[0].runtime?.submittedAt).toBeUndefined(); expect(begin).not.toHaveBeenCalled();
  });

  it('画布旧文字retry IPC迟到只保留同任务paused/hold，不能重新派发', async (): Promise<void> => {
    const { shotId, job } = shotPreparation('bound'); job.runId = 'TEST-original-run';
    tasks[0].status = 'paused'; tasks[0].errorInfo = { code: 'cancelled', message: 'TEST暂停', recoverable: true, detectedAt: now };
    tasks[0].runtime = { runId: job.runId, attempt: 1, stage: 'paused', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { mode: 'chat', prompt: tasks[0].prompt, attachments: [] } };
    usePetStoryStore.setState({ project: structuredClone(project) }); useTaskStore.setState({ tasks: structuredClone(tasks) });
    const gate = deferred<PetStoryResult>(); window.electronAPI.petstory.retryUnsubmitted = vi.fn((): Promise<PetStoryResult> => gate.promise);
    const pending = usePetStoryStore.getState().generateShotMedia(shotId, 'firstFrame');
    await vi.waitFor((): void => { expect(window.electronAPI.petstory.retryUnsubmitted).toHaveBeenCalledOnce(); });
    await usePetStoryStore.getState().stopImageOperation({ shotId, kind: 'firstFrame' });
    tasks[0].status = 'queued'; gate.resolve({ success: true, project: saved() }); await pending;
    expect(start).not.toHaveBeenCalled(); expect(tasks[0]).toMatchObject({ status: 'paused', executionIntent: 'hold', runtime: { runId: 'TEST-original-run' } });
  });

  it('画布retry等待期间原对象被改为新run，旧回调不abort、不暂停也不等待新controller', async (): Promise<void> => {
    const { shotId, job } = shotPreparation('bound'); job.runId = 'TEST-original-run';
    tasks[0].status = 'paused'; tasks[0].errorInfo = { code: 'cancelled', message: 'TEST暂停', recoverable: true, detectedAt: now };
    tasks[0].runtime = { runId: job.runId, attempt: 1, stage: 'paused', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { mode: 'chat', prompt: tasks[0].prompt, attachments: [] } };
    usePetStoryStore.setState({ project: structuredClone(project) }); useTaskStore.setState({ tasks: structuredClone(tasks) });
    const gate = deferred<PetStoryResult>(); window.electronAPI.petstory.retryUnsubmitted = vi.fn((): Promise<PetStoryResult> => gate.promise);
    const pending = usePetStoryStore.getState().generateShotMedia(shotId, 'firstFrame');
    await vi.waitFor((): void => { expect(window.electronAPI.petstory.retryUnsubmitted).toHaveBeenCalledOnce(); });
    await usePetStoryStore.getState().stopImageOperation({ shotId, kind: 'firstFrame' });
    const abortCount = vi.mocked(automationEngine.abort).mock.calls.length; const writeCount = update.mock.calls.length;
    const current = useTaskStore.getState().tasks[0]; current.runtime!.runId = 'TEST-later-run'; current.runtime!.submittedAt = '2026-11-06T02:00:00.000Z'; current.status = 'executing';
    tasks[0].runtime!.runId = current.runtime!.runId; tasks[0].runtime!.submittedAt = current.runtime!.submittedAt; tasks[0].status = 'executing'; tasks[0].executionIntent = 'armed';
    vi.mocked(automationEngine.hasController).mockReturnValue(true);
    gate.resolve({ success: true, project: saved() }); await pending;
    expect(automationEngine.abort).toHaveBeenCalledTimes(abortCount); expect(update).toHaveBeenCalledTimes(writeCount); expect(start).not.toHaveBeenCalled();
    expect(tasks[0]).toMatchObject({ status: 'executing', executionIntent: 'armed', runtime: { runId: 'TEST-later-run' } });
    vi.mocked(automationEngine.hasController).mockReturnValue(false);
  });

  it('新hold尚无run快照时，迟到列表中的后来executing运行不能被当作原停止对象', async (): Promise<void> => {
    const { shotId, job } = shotPreparation('bound'); project.jobs = []; tasks = []; usePetStoryStore.setState({ project: structuredClone(project) }); useTaskStore.setState({ tasks: [] });
    window.electronAPI.petstory.prepareRuntime = vi.fn(async (): Promise<PetStoryResult> => {
      project.jobs = [job]; tasks = [{ id: job.taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: 'queued', executionIntent: 'hold',
        prompt: 'TEST 原文字请求', outputs: [], result: null, createdAt: now, updatedAt: now, petstoryChat: { projectId: project.id, jobId: job.id } }];
      return { success: true, project: saved(), taskId: job.taskId };
    });
    const gate = deferred<Task[]>(); const list = vi.fn(async (): Promise<Task[]> => structuredClone(tasks)); list.mockReturnValueOnce(gate.promise); window.electronAPI.tasks.list = list;
    const pending = usePetStoryStore.getState().generateShotMedia(shotId, 'firstFrame');
    await vi.waitFor((): void => { expect(list).toHaveBeenCalledOnce(); });
    await usePetStoryStore.getState().stopImageOperation({ shotId, kind: 'firstFrame' });
    const abortCount = vi.mocked(automationEngine.abort).mock.calls.length;
    tasks[0].status = 'executing'; tasks[0].executionIntent = 'armed'; tasks[0].runtime = { runId: 'TEST-newer-explicit-run', attempt: 2, stage: 'preparing_account', message: 'TEST',
      startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { mode: 'chat', prompt: tasks[0].prompt, attachments: [] } };
    gate.resolve(structuredClone(tasks)); await pending;
    expect(automationEngine.abort).toHaveBeenCalledTimes(abortCount); expect(update).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect(tasks[0]).toMatchObject({ status: 'executing', executionIntent: 'armed', runtime: { runId: 'TEST-newer-explicit-run' } });
  });

  it('未知hold的旧IPC回执首次到达前当前已是新run，不能从当前记录补造旧停止身份', async (): Promise<void> => {
    const { shotId, job } = shotPreparation('bound'); project.jobs = []; tasks = []; usePetStoryStore.setState({ project: structuredClone(project) }); useTaskStore.setState({ tasks: [] });
    const gate = deferred<PetStoryResult>(); window.electronAPI.petstory.prepareRuntime = vi.fn((): Promise<PetStoryResult> => gate.promise);
    const pending = usePetStoryStore.getState().generateShotMedia(shotId, 'firstFrame');
    await vi.waitFor((): void => { expect(window.electronAPI.petstory.prepareRuntime).toHaveBeenCalledOnce(); });
    await usePetStoryStore.getState().stopImageOperation({ shotId, kind: 'firstFrame' });
    project.jobs = [job]; tasks = [{ id: job.taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: 'executing', executionIntent: 'armed',
      prompt: 'TEST 原文字请求', outputs: [], result: null, createdAt: now, updatedAt: now, petstoryChat: { projectId: project.id, jobId: job.id },
      runtime: { runId: 'TEST-running-before-old-receipt', attempt: 2, stage: 'preparing_account', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
        input: { mode: 'chat', prompt: 'TEST 原文字请求', attachments: [] } } }];
    useTaskStore.setState({ tasks: structuredClone(tasks) });
    gate.resolve({ success: true, project: saved(), taskId: job.taskId }); await pending;
    expect(automationEngine.abort).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect(tasks[0]).toMatchObject({ status: 'executing', executionIntent: 'armed', runtime: { runId: 'TEST-running-before-old-receipt' } });
  });
});
