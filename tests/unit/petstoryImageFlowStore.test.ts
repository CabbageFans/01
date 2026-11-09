/** 原故事／原五镜头的离线接线回归；任务和图片均为替身，不代表真实豆包输出。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryChatJob, PetStoryImageOperation, PetStoryImageOperationRequest, PetStoryImageOperationResult, PetStoryPlan, PetStoryProject, PetStoryResult, Task } from '@doubao-studio/contracts';
import { observePetStoryTasks, tickPetStoryImageOperation, usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import { imageConversationTask, petStoryImageProgress } from '../../src/utils/petstoryImageFlow';
import snapshot from '../fixtures/storyboard-five-shots.json';

const original = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState(), studio: useProjectStore.getState() };
type RuntimePatch = Parameters<ReturnType<typeof useTaskStore.getState>['updateTaskRuntime']>[1];
type PetStoryState = ReturnType<typeof usePetStoryStore.getState>;
const now = '2026-10-30T05:00:00.000Z';
let project: PetStoryProject; let tasks: Task[]; let serial = 0; let unobserve: (() => void) | undefined;
const begin = vi.fn<(id: string, revision: number, request: PetStoryImageOperationRequest) => Promise<PetStoryImageOperationResult>>();
const advance = vi.fn<(id: string, operationId: string) => Promise<PetStoryImageOperationResult>>();
const resume = vi.fn<(id: string, operationId: string) => Promise<PetStoryImageOperationResult>>();
const collect = vi.fn<(id: string, jobId: string) => Promise<PetStoryResult>>();
const start = vi.fn<(taskId: string, beforeDispatch?: (task: Task) => Promise<void>) => Promise<boolean>>();
const bindProduction = vi.fn<(id: string, taskId: string, runId: string) => Promise<PetStoryResult>>();
const pauseProduction = vi.fn<(id: string) => Promise<PetStoryResult>>();
const prepareRuntime = vi.fn<() => Promise<PetStoryResult>>();
const adoptPrompt = vi.fn<() => Promise<PetStoryResult>>();
const saveStory = vi.fn<(id: string, revision: number, text: string) => Promise<PetStoryResult>>();
const dispatch = vi.fn<(event: Event) => boolean>();

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = (): void => { throw new Error('TEST 异步结果尚未初始化'); };
  const promise = new Promise<T>((done: (value: T | PromiseLike<T>) => void): void => { resolve = done; });
  return { promise, resolve };
}
function save(): PetStoryProject { project = structuredClone(project); project.revision++; return project; }
function operation(id: string): PetStoryImageOperation { return project.imageOperations!.find((item): boolean => item.id === id)!; }
function task(id: string, mode: 'chat' | 'image'): Task {
  return { id, projectId: project.studioProjectId, assignedAccountId: project.accountId, status: 'queued', mode,
    prompt: 'TEST 正式请求替身', executionIntent: 'hold', outputs: [], result: null, createdAt: now, updatedAt: now };
}
function chatJob(op: PetStoryImageOperation): PetStoryChatJob {
  const job: PetStoryChatJob = { id: `TEST-image-chat-${serial}`, taskId: `TEST-image-chat-task-${serial}`, kind: 'materialPrompt', materialId: op.target.materialId,
    status: 'bound', inputHash: 'TEST', sourceUrl: '', sourceStoryId: project.mobileStory!.id, createdAt: now, requestId: `TEST-request-${serial}`, expectedIds: [op.target.materialId!] };
  project.jobs.push(job); tasks.push(task(job.taskId, 'chat')); op.chatJobId = job.id; return job;
}
function response(op: PetStoryImageOperation): PetStoryImageOperationResult {
  return { success: op.stage !== 'failed', project, operationId: op.id, ...(op.stage === 'preparing' ? { chatJobId: op.chatJobId } : {}) };
}
async function finishMedia(): Promise<void> {
  const media = tasks.at(-1)!; media.status = 'done';
  await tickPetStoryImageOperation();
}
async function stoppedSubmittedImage(): Promise<{ media: Task; op: PetStoryImageOperation }> {
  await usePetStoryStore.getState().modifyImage({ materialId: project.materials![0].id }, 'TEST-old-adopted', '调整表情');
  const media = tasks.at(-1)!; const op = project.imageOperations!.at(-1)!;
  const stepId = 'TEST-stopped-image-step';
  media.status = 'paused'; media.runtime!.submittedAt = now; media.petstory = { projectId: project.id, stepId, imageOperationId: op.id };
  const entry = { state: 'unknown' as const, reason: 'TEST 只读原运行，不要求预检查' };
  project.production = { phase: 'materials', imageOperationId: op.id, state: 'paused', planHash: 'TEST', approvedAt: now,
    capability: { accountId: project.accountId, image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [] },
    fallbacks: {}, shots: {}, message: 'TEST 原提交结果尚未确认', steps: [{ id: stepId, kind: 'character', materialId: op.target.materialId,
      taskId: media.id, runId: media.runtime!.runId, inputHash: 'TEST', attachmentAssetIds: [], status: 'bound' }] };
  project.imageProductions = { ...project.imageProductions, [op.id]: project.production };
  usePetStoryStore.setState({ project }); return { media, op };
}
type ImageReconcileDetail = { taskId: string; accountId: string; runId: string; submittedAt: string; useCurrentPage: boolean; automatic: boolean; onSettled: () => Promise<void> };
function imageReconciles(): Event[] { return dispatch.mock.calls.map(([item]): Event => item).filter((item): boolean => item.type === 'reconcile-task-submission'); }
function lastImageReconcile(): ImageReconcileDetail {
  const event = imageReconciles().at(-1);
  if (!event) throw new Error('TEST 原图片观察事件尚未分派');
  return (event as CustomEvent<ImageReconcileDetail>).detail;
}

beforeEach((): void => {
  vi.resetAllMocks(); tasks = []; serial++;
  project = { id: `TEST-image-project-${serial}`, schemaVersion: 1, studioProjectId: 'TEST-image-studio', accountId: 'TEST-image-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-image-story', text: snapshot.mobileStory, importedAt: now },
    plan: structuredClone(snapshot.plan) as PetStoryPlan, assets: [], jobs: [], updatedAt: now };
  const character = project.plan!.characters[0];
  project.materials = [{ id: `character:${character.id}`, entityId: character.id, kind: 'character', name: character.name, designHash: 'TEST', selectedAssetId: 'TEST-old-adopted',
    prompt: { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST' } }];
  project.assets.push({ id: 'TEST-old-adopted', kind: 'character', materialId: project.materials[0].id, characterId: character.id, relativePath: 'TEST/old.png' });
  begin.mockImplementation(async (_id: string, _revision: number, request: PetStoryImageOperationRequest): Promise<PetStoryImageOperationResult> => {
    save(); const count = (project.imageOperations?.length || 0) + 1;
    const op: PetStoryImageOperation = { id: `TEST-operation-${serial}-${count}`, requestId: request.requestId, target: request.target,
      mode: request.baseAssetId ? 'modify' : 'generate', stage: request.baseAssetId || request.target.shotId ? 'generating' : 'preparing', basisHash: 'TEST', createdAt: now,
      baseAssetId: request.baseAssetId, feedback: request.feedback };
    project.imageOperations = [...(project.imageOperations || []), op];
    if (op.mode === 'generate' && op.target.materialId) chatJob(op);
    return response(op);
  });
  advance.mockImplementation(async (_id: string, id: string): Promise<PetStoryImageOperationResult> => {
    save(); const op = operation(id);
    if (op.stage === 'preparing') {
      const job = project.jobs.find((item): boolean => item.id === op.chatJobId)!;
      if (job.status !== 'applied') return response(op);
      job.resultStatus = 'adopted'; op.stage = 'generating';
    }
    if (!op.taskId) { op.taskId = `TEST-image-task-${op.id}`; tasks.push(task(op.taskId, 'image')); }
    const media = tasks.find((item): boolean => item.id === op.taskId)!;
    if (!media.petstory) media.petstory = { projectId: project.id, stepId: `TEST-step-${op.id}`, imageOperationId: op.id, materialId: op.target.materialId };
    const entry = { state: 'unknown' as const, reason: 'TEST 当前操作' };
    const priorProduction = project.imageProductions?.[op.id];
    if (!priorProduction || priorProduction.steps[0]?.taskId !== media.id) project.imageProductions = { ...project.imageProductions, [op.id]: {
      imageOperationId: op.id, phase: 'materials', state: 'running', planHash: 'TEST', approvedAt: now, fallbacks: {}, shots: {}, message: 'TEST 本次图片',
      capability: { accountId: project.accountId, image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [] },
      steps: [{ id: media.petstory.stepId, kind: 'character', materialId: op.target.materialId, shotId: op.target.shotId, taskId: media.id, status: 'bound', inputHash: 'TEST', attachmentAssetIds: [] }],
    } };
    if (media.status === 'done') {
      if (!op.outputAssetId) {
        op.outputAssetId = `TEST-output-${op.id}`;
        project.assets.push({ id: op.outputAssetId, kind: op.target.kind === 'lastFrame' ? 'plannedEndImage' : op.target.kind || 'character', materialId: op.target.materialId, shotId: op.target.shotId, taskId: media.id, runId: media.runtime?.runId, relativePath: 'TEST/candidate.png',
          imageReview: { target: op.target, state: 'candidate', basisHash: 'TEST' }, validation: { decoded: true, sha256: 'a'.repeat(64), bytes: 1, width: 1, height: 1, checkedAt: now } });
      }
      op.stage = 'complete'; return response(op);
    }
    return { ...response(op), taskId: media.id, action: media.status === 'queued' ? 'start' : 'wait' };
  });
  resume.mockImplementation(async (_id: string, id: string): Promise<PetStoryImageOperationResult> => { save(); const op = operation(id); op.error = undefined; op.stage = op.taskId ? 'generating' : 'preparing'; return response(op); });
  collect.mockImplementation(async (_id: string, jobId: string): Promise<PetStoryResult> => { save(); const job = project.jobs.find((item): boolean => item.id === jobId)!; job.status = 'applied'; job.resultStatus = 'candidate'; return { success: true, project }; });
  start.mockImplementation(async (id: string, beforeDispatch?: (started: Task) => Promise<void>): Promise<boolean> => {
    const started = tasks.find((item): boolean => item.id === id)!;
    started.status = 'executing'; started.runtime = { runId: `TEST-run-${id}`, attempt: 1, stage: 'preparing_account', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { mode: started.mode, prompt: started.prompt, attachments: [], petstory: started.petstory } };
    await beforeDispatch?.(started); return true;
  });
  bindProduction.mockImplementation(async (_id: string, taskId: string, runId: string): Promise<PetStoryResult> => {
    const media = tasks.find((item): boolean => item.id === taskId)!; const production = project.imageProductions![media.petstory!.imageOperationId!];
    production.steps[0].runId = runId; save(); return { success: true, project };
  });
  pauseProduction.mockImplementation(async (): Promise<PetStoryResult> => {
    save(); if (project.production) project.production.state = 'paused'; return { success: true, project };
  });
  saveStory.mockImplementation(async (_id: string, _revision: number, text: string): Promise<PetStoryResult> => {
    save(); project.mobileStory!.text = text; return { success: true, project };
  });
  dispatch.mockImplementation((event: Event): boolean => {
    if (event.type === 'inspect-image-task-recovery-page') (event as CustomEvent<{ onResult: (result: { ready: boolean }) => void }>).detail.onResult({ ready: true });
    return true;
  });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { dispatchEvent: dispatch, electronAPI: { petstory: { beginImageOperation: begin, advanceImageOperation: advance, resumeImageOperation: resume,
    collectChat: collect, prepareRuntime, adoptPromptCandidate: adoptPrompt, bindProductionRun: bindProduction, pauseProduction, saveOriginalStory: saveStory,
    bindRun: async (_id: string, jobId: string, runId: string): Promise<PetStoryResult> => { project.jobs.find((job): boolean => job.id === jobId)!.runId = runId; return { success: true, project }; },
    open: async (): Promise<PetStoryResult> => ({ success: true, project }),
  }, tasks: { list: async (): Promise<Task[]> => tasks } } }));
  const account: Account = { id: project.accountId, name: 'TEST 原账号', platform: 'doubao', partition: 'TEST-image-partition', status: 'idle', avatar: '', pinned: false, createdAt: now, updatedAt: now };
  useAccountStore.setState({ ...original.accounts, accounts: [account], selectedAccountId: account.id, selectAccount: vi.fn() });
  useProjectStore.setState({ ...original.studio, projects: [{ id: project.studioProjectId, name: 'TEST 原故事隔离项目', description: '', color: '#fff', archived: false, createdAt: now, updatedAt: now }], selectProject: vi.fn() });
  useTaskStore.setState({ ...original.tasks, tasks, startAutomation: start, error: '', activeTaskId: null, accountBusy: {}, accountAutomationState: {},
    updateTaskRuntime: async (id: string, patch: RuntimePatch): Promise<boolean> => { const item = tasks.find((entry): boolean => entry.id === id)!; Object.assign(item, patch, { runtime: { ...item.runtime, ...patch.runtime } }); return true; } });
  usePetStoryStore.setState({ ...original.petstory, project, busy: false, error: '', activeImageOperationId: null });
});

afterEach(async (): Promise<void> => {
  unobserve?.(); unobserve = undefined;
  await usePetStoryStore.getState().openProject('TEST/原故事副本');
  usePetStoryStore.setState(original.petstory); useTaskStore.setState(original.tasks); useAccountStore.setState(original.accounts); useProjectStore.setState(original.studio);
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('单次图片意图的后台接力', (): void => {
  it('点击立即占用唯一图片资格，其他素材与修改不排队，候选保存后允许下一项', async (): Promise<void> => {
    const firstTarget = { materialId: project.materials![0].id }; const secondTarget = { materialId: 'prop:TEST-independent' };
    const gate = deferred<void>(); const implementation = begin.getMockImplementation()!;
    begin.mockImplementation(async (id: string, revision: number, request: PetStoryImageOperationRequest): Promise<PetStoryImageOperationResult> => {
      await gate.promise; return implementation(id, revision, request);
    });
    const first = usePetStoryStore.getState().modifyImage(firstTarget, 'TEST-old-adopted', '调整表情');
    await usePetStoryStore.getState().modifyImage(secondTarget, 'TEST-other-original', '调整角度');
    await usePetStoryStore.getState().generateMaterialImage(secondTarget.materialId);
    expect(usePetStoryStore.getState().pendingImageTargets).toHaveLength(1);
    gate.resolve(); await first; await tickPetStoryImageOperation();
    expect(begin).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
    expect(usePetStoryStore.getState().activeImageOperationIds).toHaveLength(1);
    expect(usePetStoryStore.getState().imageTargetErrors['material:prop:TEST-independent']).toContain('已有图片流程');
    tasks.find((item): boolean => item.id === project.imageOperations![0].taskId)!.status = 'done';
    await tickPetStoryImageOperation();
    expect(project.imageOperations![0].stage).toBe('complete'); expect(usePetStoryStore.getState().activeImageOperationIds).toEqual([]);
    await usePetStoryStore.getState().modifyImage(secondTarget, 'TEST-other-original', '调整角度');
    expect(begin).toHaveBeenCalledTimes(2); expect(start).toHaveBeenCalledTimes(2);
  });

  it('失败释放授权及真实执行后，历史generating阶段不会永久阻止下一张', async (): Promise<void> => {
    await usePetStoryStore.getState().modifyImage({ materialId: project.materials![0].id }, 'TEST-old-adopted', '调整表情');
    const first = project.imageOperations![0]; const implementation = advance.getMockImplementation()!;
    tasks.find((item): boolean => item.id === first.taskId)!.status = 'fail';
    advance.mockImplementation(async (id: string, operationId: string): Promise<PetStoryImageOperationResult> => {
      if (operationId === first.id) throw new Error('TEST 当前图片失败');
      return implementation(id, operationId);
    });
    await tickPetStoryImageOperation();
    expect(usePetStoryStore.getState().activeImageOperationIds).toEqual([]); expect(operation(first.id).stage).toBe('generating');
    await usePetStoryStore.getState().modifyImage({ materialId: 'prop:TEST-independent' }, 'TEST-other-original', '调整角度');
    expect(begin).toHaveBeenCalledTimes(2); expect(usePetStoryStore.getState().activeImageOperationIds).toEqual([project.imageOperations![1].id]);
  });

  it('图片准备自动修订沿同一授权接续，其他图片仍不可启动', async (): Promise<void> => {
    await usePetStoryStore.getState().generateMaterialImage(project.materials![0].id);
    const first = project.imageOperations![0]; const parent = project.jobs.find((job): boolean => job.id === first.chatJobId)!;
    const repair: PetStoryChatJob = { ...structuredClone(parent), id: 'TEST-single-repair', taskId: 'TEST-single-repair-task', kind: 'repair', parentJobId: parent.id, runId: undefined };
    project.jobs.push(repair); tasks.push(task(repair.taskId, 'chat'));
    collect.mockImplementationOnce(async (): Promise<PetStoryResult> => {
      save(); project.jobs.find((job): boolean => job.id === parent.id)!.status = 'invalid';
      return { success: false, project, needsRepair: true, repairSourceJobId: parent.id, repairJobId: repair.id };
    });
    await usePetStoryStore.getState().collect(parent.id, true);
    await usePetStoryStore.getState().modifyImage({ materialId: 'prop:TEST-independent' }, 'TEST-other-original', '调整角度');
    expect(begin).toHaveBeenCalledOnce(); expect(usePetStoryStore.getState().activeImageOperationIds).toEqual([first.id]);
    expect(start.mock.calls.map(([id]): string => id)).toEqual([parent.taskId, repair.taskId]);
  });

  it('旧排队准备的授权失败后，即使启动下一张也不能借新授权发送迟到旧任务', async (): Promise<void> => {
    let queuedDispatch: ((task: Task) => Promise<void>) | undefined;
    start.mockImplementationOnce(async (taskId: string, beforeDispatch?: (task: Task) => Promise<void>): Promise<boolean> => { queuedDispatch = beforeDispatch; return !!taskId; });
    await usePetStoryStore.getState().generateMaterialImage(project.materials![0].id);
    const first = project.imageOperations![0]; const implementation = advance.getMockImplementation()!;
    advance.mockImplementation(async (id: string, operationId: string): Promise<PetStoryImageOperationResult> => {
      if (operationId === first.id) { operation(first.id).stage = 'failed'; return { ...response(operation(first.id)), error: 'TEST 当前已停止' }; }
      return implementation(id, operationId);
    });
    await tickPetStoryImageOperation();
    await usePetStoryStore.getState().modifyImage({ materialId: 'prop:TEST-independent' }, 'TEST-other-original', '调整角度');
    const prepared = tasks.find((item): boolean => item.id === project.jobs.find((job): boolean => job.id === first.chatJobId)?.taskId)!;
    prepared.runtime = { runId: 'TEST-late-queued-run', attempt: 1, stage: 'preparing_account', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { mode: 'chat', prompt: prepared.prompt, attachments: [] } };
    if (!queuedDispatch) throw new Error('TEST 缺少原排队任务派发回调');
    await expect(queuedDispatch(prepared)).rejects.toThrow('本轮文字准备已停止');
    expect(usePetStoryStore.getState().activeImageOperationIds).toEqual([project.imageOperations![1].id]);
  });
  it.each(['firstFrame', 'lastFrame'] as const)('画布%s生成复用图片操作和进度，不进入旧制作调度或打开浏览器', async (kind): Promise<void> => {
    const shot = project.plan!.shots.find((item): boolean => !!item.prompts[kind])!;
    const target = { shotId: shot.id, kind };
    const originalPlan = structuredClone(project.plan); const originalAssets = structuredClone(project.assets);
    await usePetStoryStore.getState().generateShotMedia(shot.id, kind);
    expect(usePetStoryStore.getState().error).toBe('');
    expect(begin).toHaveBeenCalledExactlyOnceWith(project.id, 1, { target, requestId: expect.any(String) }, undefined);
    expect(start).toHaveBeenCalledOnce(); expect(bindProduction).toHaveBeenCalledOnce();
    expect(tasks.map((item): Task['mode'] => item.mode)).toEqual(['image']); expect(project.jobs).toEqual([]);
    const state = usePetStoryStore.getState(); const op = state.project!.imageOperations!.at(-1)!;
    expect(state.activeImageOperationId).toBe(op.id);
    expect(petStoryImageProgress(state.project!, target, tasks, state.activeImageOperationId)).toMatchObject({ busy: true, stage: 'generating', task: { id: tasks[0].id } });
    expect(dispatch.mock.calls.some(([event]): boolean => event.type === 'reveal-browser')).toBe(false);
    expect(project.plan).toEqual(originalPlan); expect(project.assets).toEqual(originalAssets);
    await finishMedia();
    const completed = usePetStoryStore.getState();
    expect(completed.activeImageOperationId).toBeNull(); expect(tasks).toHaveLength(1);
    expect(petStoryImageProgress(completed.project!, target, tasks, completed.activeImageOperationId)).toMatchObject({ busy: false, stage: 'complete', candidateAssetId: expect.any(String) });
    expect(project.assets.at(-1)?.imageReview).toMatchObject({ target, state: 'candidate' });
    expect(project.adoptedImages).toBeUndefined(); expect(project.plan).toEqual(originalPlan);
  });

  it('连续及未返回的后台推进不切换全局忙碌，当前图片持续显示生成状态并保留已有错误', async (): Promise<void> => {
    const target = { materialId: project.materials![0].id };
    await usePetStoryStore.getState().modifyImage(target, 'TEST-old-adopted', '调整表情');
    usePetStoryStore.setState({ error: 'TEST 保留其他操作的错误' });
    const busy: boolean[] = [];
    const unsubscribe = usePetStoryStore.subscribe((state: PetStoryState): void => { busy.push(state.busy); });
    const gate = deferred<PetStoryImageOperationResult>();
    let pending: Promise<void> | undefined;
    try {
      await tickPetStoryImageOperation(); await tickPetStoryImageOperation();
      const before = advance.mock.calls.length;
      advance.mockReturnValueOnce(gate.promise);
      pending = tickPetStoryImageOperation();
      await vi.waitFor((): void => { expect(advance).toHaveBeenCalledTimes(before + 1); });
      const during = usePetStoryStore.getState();
      const progress = petStoryImageProgress(during.project!, target, tasks, during.activeImageOperationId);
      gate.resolve(response(operation(project.imageOperations![0].id))); await pending;
      expect(during.busy).toBe(false); expect(progress.busy).toBe(true); expect(progress.stage).toBe('generating');
      expect(busy).not.toContain(true); expect(usePetStoryStore.getState().busy).toBe(false);
      expect(usePetStoryStore.getState().error).toBe('TEST 保留其他操作的错误');
    } finally {
      gate.resolve(response(operation(project.imageOperations![0].id))); await pending; unsubscribe();
    }
  });

  it('未返回的后台推进期间重复轮询及直接推进只进入一次IPC', async (): Promise<void> => {
    await usePetStoryStore.getState().modifyImage({ materialId: project.materials![0].id }, 'TEST-old-adopted', '调整表情');
    const before = advance.mock.calls.length;
    const gate = deferred<PetStoryImageOperationResult>(); advance.mockReturnValueOnce(gate.promise);
    const pending = tickPetStoryImageOperation();
    try {
      await tickPetStoryImageOperation(); await usePetStoryStore.getState().advanceImageOperation();
      await vi.waitFor((): void => { expect(advance).toHaveBeenCalledTimes(before + 1); });
      expect(usePetStoryStore.getState().busy).toBe(false);
    } finally {
      gate.resolve(response(operation(project.imageOperations![0].id))); await pending;
    }
    expect(begin).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledOnce();
  });

  it('轮询期间点击保存会等待原推进并用最新版本执行，前台等待时不插入其他轮询', async (): Promise<void> => {
    await usePetStoryStore.getState().modifyImage({ materialId: project.materials![0].id }, 'TEST-old-adopted', '调整表情');
    const before = advance.mock.calls.length;
    const gate = deferred<PetStoryImageOperationResult>(); advance.mockReturnValueOnce(gate.promise);
    const pending = tickPetStoryImageOperation();
    let foreground: Promise<void> | undefined;
    const projectId = project.id; const text = 'TEST 用户在轮询期间保存的剧本';
    let nextRevision = 0;
    try {
      await vi.waitFor((): void => { expect(advance).toHaveBeenCalledTimes(before + 1); });
      foreground = usePetStoryStore.getState().saveOriginalStory(text);
      expect(usePetStoryStore.getState().busy).toBe(true); expect(saveStory).not.toHaveBeenCalled();
      await tickPetStoryImageOperation(); await usePetStoryStore.getState().advanceImageOperation();
      expect(advance).toHaveBeenCalledTimes(before + 1); expect(saveStory).not.toHaveBeenCalled();
      nextRevision = save().revision;
    } finally {
      gate.resolve(response(operation(project.imageOperations![0].id))); await pending; await foreground;
    }
    expect(saveStory).toHaveBeenCalledExactlyOnceWith(projectId, nextRevision, text);
    expect(usePetStoryStore.getState().project?.mobileStory?.text).toBe(text); expect(usePetStoryStore.getState().busy).toBe(false);
    expect(begin).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledOnce();
  });

  it('后台推进期间到达的文字完成事件最终只收取一次并接续同一图片任务', async (): Promise<void> => {
    vi.useFakeTimers(); await usePetStoryStore.getState().generateMaterialImage(project.materials![0].id);
    unobserve = observePetStoryTasks();
    const gate = deferred<PetStoryImageOperationResult>(); advance.mockReturnValueOnce(gate.promise);
    const pending = tickPetStoryImageOperation();
    try {
      const chat = tasks[0]; chat.status = 'done'; chat.runtime!.chatResponse = { text: 'TEST 轮询期间完成的原回复', capturedAt: now };
      useTaskStore.setState({ tasks: [...tasks] });
      await vi.advanceTimersByTimeAsync(0); expect(collect).not.toHaveBeenCalled();
    } finally {
      gate.resolve(response(operation(project.imageOperations![0].id))); await pending;
    }
    await vi.advanceTimersByTimeAsync(2200);
    expect(collect).toHaveBeenCalledExactlyOnceWith(project.id, project.jobs[0].id);
    expect(begin).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledTimes(2); expect(tasks).toHaveLength(2);
  });

  it('后台推进异常后释放串行占用并停止自动推进，不创建或重新发送原图片任务', async (): Promise<void> => {
    await usePetStoryStore.getState().modifyImage({ materialId: project.materials![0].id }, 'TEST-old-adopted', '调整表情');
    const operationId = project.imageOperations![0].id;
    advance.mockRejectedValueOnce(new Error('TEST 后台图片状态读取失败'));
    await tickPetStoryImageOperation();
    expect(usePetStoryStore.getState().error).toContain('TEST 后台图片状态读取失败');
    expect(usePetStoryStore.getState().busy).toBe(false); expect(usePetStoryStore.getState().activeImageOperationId).toBeNull();
    const before = advance.mock.calls.length;
    await tickPetStoryImageOperation(); await usePetStoryStore.getState().advanceImageOperation();
    expect(advance).toHaveBeenCalledTimes(before);
    await usePetStoryStore.getState().saveOriginalStory('TEST 异常后的正常保存');
    expect(saveStory).toHaveBeenCalledOnce(); expect(usePetStoryStore.getState().busy).toBe(false);
    expect(project.imageOperations).toHaveLength(1); expect(project.imageOperations![0].id).toBe(operationId);
    expect(begin).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledOnce(); expect(dispatch).not.toHaveBeenCalled();
  });

  it('只点击一次，从文字收取自动继续媒体，下载候选前后不改变已采用图', async (): Promise<void> => {
    const materialId = project.materials![0].id;
    await usePetStoryStore.getState().generateMaterialImage(materialId);
    expect(begin).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
    const job = project.jobs[0]; const chat = tasks[0]; chat.status = 'done'; chat.runtime!.chatResponse = { text: 'TEST 豆包回复替身', capturedAt: now };
    await usePetStoryStore.getState().collect(job.id);
    await tickPetStoryImageOperation();
    expect(start).toHaveBeenCalledTimes(2); expect(bindProduction).toHaveBeenCalledTimes(1);
    expect(project.jobs[0].resultStatus).toBe('adopted'); expect(adoptPrompt).not.toHaveBeenCalled();
    expect(project.materials![0].selectedAssetId).toBe('TEST-old-adopted');
    await finishMedia(); await tickPetStoryImageOperation();
    expect(project.imageOperations![0].stage).toBe('complete'); expect(project.assets.at(-1)!.imageReview!.state).toBe('candidate');
    expect(project.materials![0].selectedAssetId).toBe('TEST-old-adopted'); expect(begin).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().activeImageOperationId).toBeNull();
  });

  it('选未采用上传图及上一轮候选连续修改，两轮都绑定调用时选定的具体图片', async (): Promise<void> => {
    const target = { materialId: project.materials![0].id };
    project.assets.push({ id: 'TEST-uploaded-unadopted', kind: 'character', materialId: target.materialId, relativePath: 'TEST/upload.png', imageReview: { state: 'candidate', target, basisHash: 'TEST' } });
    await usePetStoryStore.getState().modifyImage(target, 'TEST-uploaded-unadopted', '表情更自然，衣服和背景保持不变');
    await finishMedia(); const first = project.imageOperations![0].outputAssetId!;
    await usePetStoryStore.getState().modifyImage(target, first, '再把笑容收敛一点');
    await finishMedia();
    expect(begin.mock.calls.map((call): unknown => ({ base: call[2].baseAssetId, feedback: call[2].feedback }))).toEqual([
      { base: 'TEST-uploaded-unadopted', feedback: '表情更自然，衣服和背景保持不变' }, { base: first, feedback: '再把笑容收敛一点' }]);
    expect(project.imageOperations).toHaveLength(2); expect(project.jobs).toHaveLength(0); expect(start).toHaveBeenCalledTimes(2);
    expect(project.materials![0].selectedAssetId).toBe('TEST-old-adopted'); expect(dispatch).not.toHaveBeenCalled();
  });

  it('空反馈不创建请求，开始中的重复点击只进入一次IPC', async (): Promise<void> => {
    const target = { materialId: project.materials![0].id };
    await usePetStoryStore.getState().modifyImage(target, 'TEST-old-adopted', '   ');
    expect(begin).not.toHaveBeenCalled();
    const first = usePetStoryStore.getState().generateMaterialImage(target.materialId);
    const duplicate = usePetStoryStore.getState().generateMaterialImage(target.materialId);
    await Promise.all([first, duplicate]); expect(begin).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
  });

  it('重开保留任务但不自动发送，有明确继续入口且不重复创建操作', async (): Promise<void> => {
    vi.useFakeTimers(); await usePetStoryStore.getState().generateMaterialImage(project.materials![0].id);
    const opId = project.imageOperations![0].id;
    await usePetStoryStore.getState().openProject('TEST/原故事副本');
    const before = advance.mock.calls.length;
    unobserve = observePetStoryTasks(); await vi.advanceTimersByTimeAsync(2200);
    expect(advance).toHaveBeenCalledTimes(before); expect(start).toHaveBeenCalledTimes(1);
    const progress = petStoryImageProgress(project, project.imageOperations![0].target, tasks, usePetStoryStore.getState().activeImageOperationId);
    expect(progress.busy).toBe(false); expect(progress.resumable).toBe(true);
    await usePetStoryStore.getState().recoverImageOperation(opId);
    expect(resume).toHaveBeenCalledWith(project.id, opId, undefined); expect(begin).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
  });

  it('已提交的文字失败只读恢复，不再启动或创建任务', async (): Promise<void> => {
    await usePetStoryStore.getState().generateMaterialImage(project.materials![0].id);
    const chat = tasks[0]; chat.status = 'paused'; chat.runtime!.submittedAt = now; chat.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-image-original';
    await usePetStoryStore.getState().openProject('TEST/原故事副本');
    await usePetStoryStore.getState().recoverImageOperation(project.imageOperations![0].id);
    expect(start).toHaveBeenCalledTimes(1); expect(begin).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls.map((call): string => call[0].type)).toEqual(['reconcile-task-submission']);
    expect(chat.status).toBe('manual_submission_observing'); expect(chat.runtime!.submittedAt).toBe(now);
  });

  it.each([undefined, 'https://www.doubao.com/chat/', 'https://www.doubao.com/chat/local_TEST-transient', 'https://www.doubao.com/chat/TEST-image-original'])('图片提交不明显式恢复%s：只读原运行，不再次启动或发送', async (url?: string): Promise<void> => {
    const { media, op } = await stoppedSubmittedImage(); media.runtime!.conversationUrl = url;
    const originalRun = media.runtime!.runId; const originalPrompt = media.prompt;
    await tickPetStoryImageOperation(); expect(dispatch).not.toHaveBeenCalled();
    await usePetStoryStore.getState().recoverImageOperation(op.id);
    const explicitCurrentPage = url !== 'https://www.doubao.com/chat/TEST-image-original';
    expect(imageReconciles()).toHaveLength(1);
    expect(imageReconciles()[0]).toMatchObject({ type: 'reconcile-task-submission', detail: { taskId: media.id, useCurrentPage: explicitCurrentPage, automatic: false } });
    expect(dispatch.mock.calls.some(([event]): boolean => event.type === 'inspect-image-task-recovery-page')).toBe(explicitCurrentPage);
    expect(media.status).toBe('manual_submission_observing'); expect(media.runtime!.runId).toBe(originalRun);
    expect(media.runtime!.submittedAt).toBe(now); expect(media.prompt).toBe(originalPrompt);
    expect(start).toHaveBeenCalledTimes(1); expect(begin).toHaveBeenCalledTimes(1); expect(tasks).toHaveLength(1);
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(advance.mock.invocationCallOrder.at(-1)!);
    await usePetStoryStore.getState().recoverImageOperation(op.id); expect(imageReconciles()).toHaveLength(1); expect(start).toHaveBeenCalledTimes(1);
  });

  it('自动接力的原图片缺少会话地址时仍分派一次有账号及运行约束的只读检查', async (): Promise<void> => {
    const { media, op } = await stoppedSubmittedImage();
    project.production!.state = 'running';
    advance.mockImplementation(async (): Promise<PetStoryImageOperationResult> => ({ ...response(operation(op.id)), taskId: media.id, action: 'observe' }));
    await tickPetStoryImageOperation();
    expect(lastImageReconcile()).toMatchObject({ taskId: media.id, accountId: project.accountId, runId: media.runtime!.runId,
      submittedAt: now, useCurrentPage: true, automatic: true, onSettled: expect.any(Function) });
    await tickPetStoryImageOperation(); await usePetStoryStore.getState().recoverImageOperation(op.id);
    expect(dispatch).toHaveBeenCalledTimes(1); expect(resume).not.toHaveBeenCalled(); expect(start).toHaveBeenCalledTimes(1);
  });

  it('重启后缺URL的原图片位于空根页时先提示定位，不重置任务、不假进入观察或盲等', async (): Promise<void> => {
    const { media, op } = await stoppedSubmittedImage();
    await usePetStoryStore.getState().openProject('TEST/原故事副本'); const before = structuredClone(media);
    dispatch.mockImplementationOnce((event: Event): boolean => {
      expect(event.type).toBe('inspect-image-task-recovery-page');
      const detail = (event as CustomEvent<{ taskId: string; runId: string; onResult: (result: { ready: boolean; message: string }) => void }>).detail;
      expect(detail).toMatchObject({ taskId: media.id, runId: media.runtime!.runId });
      detail.onResult({ ready: false, message: '原会话未定位，请在原账号历史中打开这次图片对话后继续。' }); return true;
    });
    await usePetStoryStore.getState().recoverImageOperation(op.id);
    expect(resume).not.toHaveBeenCalled(); expect(imageReconciles()).toHaveLength(0); expect(media).toEqual(before);
    expect(usePetStoryStore.getState().activeImageOperationId).toBeNull(); expect(usePetStoryStore.getState().error).toContain('原账号历史');
    const count = advance.mock.calls.length; await tickPetStoryImageOperation(); expect(advance).toHaveBeenCalledTimes(count);
    await usePetStoryStore.getState().openImageConversation(op.target);
    expect(dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'open-image-task-account', detail: { taskId: media.id, accountId: project.accountId,
      runId: media.runtime!.runId, submittedAt: now } });
    expect(dispatch.mock.calls.some(([event]): boolean => event.type === 'open-task-conversation')).toBe(false);
    expect(imageConversationTask(project, op.target, tasks)?.id).toBe(media.id);
    expect(petStoryImageProgress(project, op.target, tasks, null)).toMatchObject({ conversationMissing: true, busy: false, error: expect.stringContaining('原账号历史') });
  });

  it('用户确认重发图片后继续原操作的候选接力，原提交与正式采用图保留', async (): Promise<void> => {
    const { media, op } = await stoppedSubmittedImage(); op.stage = 'failed'; op.error = 'TEST 原请求未定位';
    const originalRun = structuredClone(media.runtime);
    const resubmit = vi.fn(async (): Promise<PetStoryImageOperationResult> => {
      save(); const replacement: Task = { ...structuredClone(media), id: 'TEST-image-replacement', status: 'queued', runtime: undefined, errorInfo: undefined };
      tasks.push(replacement); const current = operation(op.id); current.taskId = replacement.id; current.stage = 'generating'; current.error = undefined;
      project.production!.state = 'running'; project.production!.steps[0].taskId = replacement.id; project.production!.steps[0].runId = undefined;
      return { ...response(current), taskId: replacement.id, action: 'start' };
    });
    window.electronAPI.petstory.resubmitProduction = resubmit;
    await usePetStoryStore.getState().resubmitProduction({ taskId: media.id, runId: media.runtime!.runId, submittedAt: now,
      authorizationId: 'TEST-explicit-image-resubmit', acceptDuplicateRisk: true });
    expect(resubmit).toHaveBeenCalledOnce(); expect(resume).toHaveBeenCalledExactlyOnceWith(project.id, op.id, undefined);
    expect(usePetStoryStore.getState().activeImageOperationId).toBe(op.id); expect(start).toHaveBeenCalledTimes(2);
    expect(operation(op.id)).toMatchObject({ stage: 'generating', taskId: 'TEST-image-replacement' });
    await finishMedia();
    expect(operation(op.id).stage).toBe('complete'); expect(operation(op.id).outputAssetId).toBeTruthy();
    expect(project.assets.at(-1)).toMatchObject({ taskId: 'TEST-image-replacement', imageReview: { state: 'candidate' } });
    expect(media.runtime).toEqual(originalRun); expect(media.status).toBe('paused'); expect(project.materials![0].selectedAssetId).toBe('TEST-old-adopted');
    expect(tasks).toHaveLength(2); expect(begin).toHaveBeenCalledOnce();
  });

  it('真实图片观察结束成功后立即接续下载候选，仍保留正式采用图且不发送第二次', async (): Promise<void> => {
    const { media, op } = await stoppedSubmittedImage();
    await usePetStoryStore.getState().recoverImageOperation(op.id);
    media.status = 'done'; media.outputs = ['https://TEST.invalid/original.png'];
    await lastImageReconcile().onSettled();
    expect(operation(op.id).stage).toBe('complete'); expect(operation(op.id).outputAssetId).toBeTruthy();
    expect(project.assets.at(-1)?.imageReview?.state).toBe('candidate'); expect(project.materials![0].selectedAssetId).toBe('TEST-old-adopted');
    expect(usePetStoryStore.getState().activeImageOperationId).toBeNull(); expect(start).toHaveBeenCalledTimes(1); expect(tasks).toHaveLength(1);
  });

  it('本轮图片观察失败停止自动轮询，释放真实观察占用后一次显式继续可再检查原运行', async (): Promise<void> => {
    const { media, op } = await stoppedSubmittedImage();
    await usePetStoryStore.getState().recoverImageOperation(op.id);
    const first = lastImageReconcile();
    media.status = 'paused'; media.errorInfo = { code: 'submission_uncertain', message: 'TEST 原图片尚未核对稳定', recoverable: true, detectedAt: now };
    await first.onSettled();
    expect(pauseProduction).toHaveBeenCalledExactlyOnceWith(project.id); expect(usePetStoryStore.getState().activeImageOperationId).toBeNull();
    const before = advance.mock.calls.length;
    await tickPetStoryImageOperation(); await tickPetStoryImageOperation();
    expect(advance).toHaveBeenCalledTimes(before); expect(imageReconciles()).toHaveLength(1);
    await usePetStoryStore.getState().recoverImageOperation(op.id);
    expect(imageReconciles()).toHaveLength(2); expect(media.status).toBe('manual_submission_observing');
    expect(lastImageReconcile()).toMatchObject({ runId: first.runId, submittedAt: first.submittedAt, taskId: media.id });
    await first.onSettled();
    expect(media.status).toBe('manual_submission_observing'); expect(usePetStoryStore.getState().activeImageOperationId).toBe(op.id);
    expect(pauseProduction).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1); expect(tasks).toHaveLength(1);
  });

  it('图片观察结束时保留用户取消，不把取消任务写回活跃或普通暂停', async (): Promise<void> => {
    const { media, op } = await stoppedSubmittedImage();
    await usePetStoryStore.getState().recoverImageOperation(op.id);
    media.status = 'cancelled'; media.runtime!.stage = 'cancelled';
    await lastImageReconcile().onSettled();
    expect(media.status).toBe('cancelled'); expect(media.runtime!.stage).toBe('cancelled');
    expect(usePetStoryStore.getState().activeImageOperationId).toBeNull(); expect(pauseProduction).toHaveBeenCalledOnce();
    expect(imageReconciles()).toHaveLength(1); expect(start).toHaveBeenCalledTimes(1);
  });

  it('图片观察回调迟到遇到新run时不暂停或收取新运行，释放后仍可显式检查', async (): Promise<void> => {
    const { media, op } = await stoppedSubmittedImage();
    await usePetStoryStore.getState().recoverImageOperation(op.id);
    const first = lastImageReconcile();
    media.runtime!.runId = 'TEST-new-image-run'; project.production!.steps[0].runId = media.runtime!.runId;
    media.status = 'paused'; usePetStoryStore.setState({ project });
    await first.onSettled();
    expect(pauseProduction).not.toHaveBeenCalled(); expect(media.status).toBe('paused'); expect(operation(op.id).outputAssetId).toBeUndefined();
    await usePetStoryStore.getState().recoverImageOperation(op.id);
    expect(imageReconciles()).toHaveLength(2); expect(lastImageReconcile().runId).toBe('TEST-new-image-run'); expect(start).toHaveBeenCalledTimes(1);
  });

  it.each(['run', 'account', 'project', 'step'] as const)('原图片%s关联不符时不读取当前页、不标记观察且不重发', async (mismatch: string): Promise<void> => {
    const { media, op } = await stoppedSubmittedImage();
    if (mismatch === 'run') project.production!.steps[0].runId = 'TEST-other-run';
    else if (mismatch === 'account') media.assignedAccountId = 'TEST-other-account';
    else if (mismatch === 'project') media.projectId = 'TEST-other-studio';
    else media.petstory!.stepId = 'TEST-other-step';
    await usePetStoryStore.getState().recoverImageOperation(op.id);
    expect(dispatch).not.toHaveBeenCalled(); expect(media.status).toBe('paused'); expect(start).toHaveBeenCalledTimes(1);
    expect(usePetStoryStore.getState().error).toContain('运行不一致'); expect(usePetStoryStore.getState().activeImageOperationId).toBeNull();
  });

  it('原图片会话存在歧义时显式恢复也拒绝当前页兜底', async (): Promise<void> => {
    const { media, op } = await stoppedSubmittedImage();
    media.artifacts = ['TEST-origin-one', 'TEST-origin-two'].map((id: string): NonNullable<Task['artifacts']>[number] => ({ id, kind: 'file', source: 'page',
      runId: media.runtime!.runId, url: `https://TEST.invalid/${id}`, conversationUrl: `https://www.doubao.com/chat/${id}`, discoveredAt: now }));
    await usePetStoryStore.getState().recoverImageOperation(op.id);
    expect(dispatch).not.toHaveBeenCalled(); expect(media.status).toBe('paused'); expect(start).toHaveBeenCalledTimes(1);
    expect(usePetStoryStore.getState().error).toContain('绑定冲突');
  });
});

describe('候选进度及精确来源投影', (): void => {
  it('无可预览文件时不会将complete投影成完成或伪造100%', async (): Promise<void> => {
    await usePetStoryStore.getState().modifyImage({ materialId: project.materials![0].id }, 'TEST-old-adopted', '调整表情');
    const op = project.imageOperations![0]; op.stage = 'complete'; op.outputAssetId = 'TEST-not-downloaded';
    const progress = petStoryImageProgress(project, op.target, tasks);
    expect(progress.stage).toBe('saving'); expect(progress.message).toBe('正在保存图片…'); expect(progress.candidateAssetId).toBeUndefined();
  });

  it('文字和图片各用实际阶段会话，上传图无来源，旧图运行不符时不猜链接', async (): Promise<void> => {
    await usePetStoryStore.getState().generateMaterialImage(project.materials![0].id);
    const target = project.imageOperations![0].target;
    tasks[0].runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-text-stage';
    expect(imageConversationTask(project, target, tasks)?.id).toBe(tasks[0].id);
    await usePetStoryStore.getState().collect(project.jobs[0].id); await tickPetStoryImageOperation();
    const media = tasks.at(-1)!; media.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-media-stage';
    await finishMedia(); const asset = project.assets.at(-1)!;
    expect(imageConversationTask(project, target, tasks, asset.id)?.id).toBe(media.id);
    expect(imageConversationTask(project, target, tasks, 'TEST-old-adopted')).toBeUndefined();
    media.runtime!.runId = 'TEST-unrelated-new-run';
    expect(imageConversationTask(project, target, tasks, asset.id)).toBeUndefined();
  });

  it('显式查看来源才展开浏览器；另一张图正在生成时不导航到旧会话', async (): Promise<void> => {
    await usePetStoryStore.getState().modifyImage({ materialId: project.materials![0].id }, 'TEST-old-adopted', '调整表情');
    const media = tasks.at(-1)!; media.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-output-session'; await finishMedia();
    // 本用例覆盖没有独立任务页的旧图片会话；独立图片操作按自己的页面隔离规则处理。
    delete media.petstory!.imageOperationId;
    const candidate = project.assets.at(-1)!; const target = candidate.imageReview!.target;
    await usePetStoryStore.getState().openImageConversation(target, candidate.id);
    expect(dispatch.mock.calls.map((call): string => call[0].type)).toEqual(['reveal-workspace-browser', 'open-task-conversation']);
    dispatch.mockClear(); const busy = task('TEST-other-task', 'image'); busy.status = 'generating'; tasks.push(busy); useTaskStore.setState({ tasks: [...tasks] });
    await usePetStoryStore.getState().openImageConversation(target, candidate.id);
    expect(dispatch).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().error).toContain('另一段对话');
  });

  it('AI完成后又上传新候选，卡片不把旧AI会话伪装成新上传图的来源', async (): Promise<void> => {
    const target = { materialId: project.materials![0].id };
    await usePetStoryStore.getState().modifyImage(target, 'TEST-old-adopted', '调整表情');
    const media = tasks.at(-1)!; media.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-prior-ai-session'; await finishMedia();
    expect(imageConversationTask(project, target, tasks)?.id).toBe(media.id);
    project.assets.push({ id: 'TEST-new-upload', kind: 'character', materialId: target.materialId, relativePath: 'TEST/new-upload.png', imageReview: { state: 'candidate', target, basisHash: 'TEST' } });
    expect(imageConversationTask(project, target, tasks)).toBeUndefined();
    expect(imageConversationTask(project, target, tasks, project.imageOperations![0].outputAssetId)?.id).toBe(media.id);
  });
});
