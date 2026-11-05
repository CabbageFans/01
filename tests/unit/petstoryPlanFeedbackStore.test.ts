/** 方案修改沿正式文字任务链；仅离线接线与失败恢复测试。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryChatJob, PetStoryPlan, PetStoryProject, PetStoryPromptBatch, PetStoryResult, PetStoryRuntimeTarget, Task } from '@doubao-studio/contracts';
import { observePetStoryTasks, usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import { registerPetStoryDraft, unregisterPetStoryDraft } from '../../src/utils/petstoryDraftPresence';
import { isBackgroundCanvasPromptTask } from '../../src/utils/petstoryBackground';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState(), projects: useProjectStore.getState() };
const now = '2026-11-03T01:00:00.000Z';
const feedback = { text: 'TEST 保留人物，改为三个镜头，结尾停在举棒迎战。', baseJobId: 'TEST-base', requestId: 'TEST-feedback-authorization' };
let project: PetStoryProject;
let tasks: Task[];
const prepareRuntime = vi.fn(async (_id: string, _revision: number, kind: PetStoryChatJob['kind'], target?: PetStoryRuntimeTarget): Promise<PetStoryResult> => {
  const existing = target?.planFeedback && project.jobs.find((job): boolean => job.kind === 'analysis' && job.planFeedback?.requestId === target.planFeedback?.requestId);
  if (existing) return { success: true, project, taskId: existing.taskId };
  const index = tasks.length + 1; const parent = project.jobs.find((job): boolean => job.id === target?.parentJobId);
  project = structuredClone(project); project.revision++;
  const job: PetStoryChatJob = { id: `TEST-feedback-job-${index}`, taskId: `TEST-feedback-task-${index}`, kind, status: 'bound', inputHash: 'TEST', sourceUrl: '',
    sourceStoryId: project.mobileStory!.id, requestId: `TEST-runtime-contract-${index}`, ...(parent?.background ? { background: parent.background } : {}), ...(parent?.planFeedback ? { planFeedback: parent.planFeedback } : {}), ...target };
  project.jobs.push(job);
  tasks.push({ id: job.taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: 'queued', prompt: 'TEST 主进程组装的请求', result: null, outputs: [], createdAt: now, updatedAt: now,
    runtime: { runId: `TEST-run-${index}`, attempt: 1, stage: 'preparing_account', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { mode: 'chat', prompt: 'TEST 主进程组装的请求', attachments: [] } } });
  return { success: true, project, taskId: job.taskId };
});
const listTasks = vi.fn(async (): Promise<Task[]> => tasks);
const beginAdjustment = vi.fn();
const adoptPlanCandidate = vi.fn();
const confirmStory = vi.fn();
const dispatch = vi.fn();
const startAutomation = vi.fn(async (taskId: string, beforeDispatch?: (task: Task) => Promise<void>): Promise<boolean> => {
  const task = tasks.find((item): boolean => item.id === taskId)!;
  if (beforeDispatch) await beforeDispatch(task);
  task.status = 'generating';
  return true;
});
const saveCollectedCandidate = async (_id: string, jobId: string): Promise<PetStoryResult> => {
  project = structuredClone(project); project.revision++;
  const job = project.jobs.find((item): boolean => item.id === jobId)!;
  job.status = 'applied'; job.resultStatus = 'candidate'; job.parsedResult = { plan: structuredClone(snapshot.plan) as PetStoryPlan };
  return { success: true, project };
};
const collectChat = vi.fn(saveCollectedCandidate);
const openProject = vi.fn(async (): Promise<PetStoryResult> => ({ success: true, project }));

function savedFeedback(kind: 'analysis' | 'repair' = 'analysis'): { job: PetStoryChatJob; task: Task } {
  const root: PetStoryChatJob = { id: 'TEST-reopened-root', taskId: 'TEST-reopened-root-task', kind: 'analysis', status: 'bound', background: 'canvas', planFeedback: feedback,
    sourceStoryId: project.mobileStory!.id, sourceUrl: project.source.url, requestId: 'TEST-reopened-root-contract', requestText: 'TEST 已保存的原方案请求', inputHash: 'TEST', runId: 'TEST-reopened-root-run' };
  project.jobs.push(root);
  const job: PetStoryChatJob = kind === 'analysis' ? root : { ...root, id: 'TEST-reopened-repair', taskId: 'TEST-reopened-repair-task', kind: 'repair', originKind: 'analysis', parentJobId: root.id,
    requestId: 'TEST-reopened-repair-contract', requestText: 'TEST 已保存的原方案修订请求', runId: 'TEST-reopened-repair-run' };
  if (kind === 'repair') { root.status = 'invalid'; root.rawText = 'TEST 原失败回复'; project.jobs.push(job); }
  const task: Task = { id: job.taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: 'done', prompt: job.requestText!, result: null, outputs: [], createdAt: now, updatedAt: now,
    runtime: { runId: job.runId!, attempt: 1, stage: 'completed', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
      chatResponse: { text: 'TEST 原运行完整回复', capturedAt: now }, input: { mode: 'chat', prompt: job.requestText!, attachments: [] } } };
  tasks.push(task); return { job, task };
}

function accepted(task: Task): void {
  const runtime = task.runtime!; const url = 'https://www.doubao.com/chat/TEST-reopened-original';
  task.status = 'manual_submission_observing'; runtime.stage = 'manual_submission_observing'; runtime.chatResponse = undefined; runtime.conversationUrl = url;
  runtime.acceptanceObservation = { schemaVersion: 1, accountId: project.accountId, runId: runtime.runId, conversationUrl: url, acceptedAt: now,
    evidence: { kind: 'prompt_published', messageCount: 1 }, cursor: { messageCount: 1, pollCount: 0 }, expectedArtifact: { kind: 'file', runId: runtime.runId },
    lease: { ownerId: 'TEST-original-observer', acquiredAt: now, expiresAt: now, lastHeartbeatAt: now }, outcome: 'observing' };
}

beforeEach((): void => {
  vi.clearAllMocks(); tasks = [];
  collectChat.mockImplementation(saveCollectedCandidate);
  project = { schemaVersion: 1, id: 'TEST-plan-feedback', revision: 1, studioProjectId: 'TEST-studio', accountId: 'TEST-account', source: { kind: 'script', url: '', status: 'review_required' },
    mobileStory: { id: 'TEST-source', text: snapshot.mobileStory, importedAt: now }, plan: structuredClone(snapshot.plan) as PetStoryPlan,
    storyApproval: { hash: 'TEST-approved', at: now }, assets: [{ id: 'TEST-existing-media', kind: 'video', relativePath: 'TEST-existing.mp4' }], updatedAt: now,
    jobs: [{ id: feedback.baseJobId, taskId: 'TEST-base-task', kind: 'analysis', status: 'applied', resultStatus: 'candidate', inputHash: 'TEST-base', sourceUrl: '', sourceStoryId: 'TEST-source', requestId: 'TEST-base-contract', parsedResult: { plan: structuredClone(snapshot.plan) as PetStoryPlan } }] };
  const account: Account = { id: project.accountId, name: 'TEST 原豆包账号', platform: 'doubao', partition: 'TEST-partition', status: 'idle', avatar: '', pinned: false, createdAt: now, updatedAt: now };
  vi.stubGlobal('window', { dispatchEvent: dispatch, addEventListener: vi.fn(), removeEventListener: vi.fn(), electronAPI: { petstory: { prepareRuntime, beginAdjustment, adoptPlanCandidate, confirmStory, collectChat, open: openProject,
    bindRun: async (_id: string, jobId: string, runId: string): Promise<PetStoryResult> => { project.jobs.find((job): boolean => job.id === jobId)!.runId = runId; return { success: true, project }; },
    savePromptBatch: async (_id: string, _revision: number, batch: PetStoryPromptBatch): Promise<PetStoryResult> => { project = structuredClone(project); project.revision++; project.promptBatch = structuredClone(batch); return { success: true, project }; } }, tasks: { list: listTasks } } });
  useAccountStore.setState({ ...initial.accounts, accounts: [account], selectAccount: vi.fn() });
  useProjectStore.setState({ ...initial.projects, selectProject: vi.fn(), projects: [{ id: project.studioProjectId, name: 'TEST Studio', description: '', color: '#fff', archived: false, createdAt: now, updatedAt: now }] });
  useTaskStore.setState({ ...initial.tasks, tasks: [], activeTaskId: null, accountBusy: {}, accountAutomationState: {}, startAutomation });
  usePetStoryStore.setState({ ...initial.pet, project, busy: false, error: '', capability: null, promptBatch: { total: 0, completed: 0, status: 'idle' } });
});
afterEach(async (): Promise<void> => {
  unregisterPetStoryDraft(`${project.id}:plan`);
  await usePetStoryStore.getState().stopPromptBatch();
  usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.tasks); useAccountStore.setState(initial.accounts); useProjectStore.setState(initial.projects);
  vi.unstubAllGlobals();
});

describe('方案自然语言修改任务', (): void => {
  it('提交即创建后台 analysis；保留原候选、采用方案及媒体，绝不自动采用或打开浏览器', async (): Promise<void> => {
    const before = structuredClone(project);
    const jobId = await usePetStoryStore.getState().revisePlan(feedback);
    expect(jobId).toBe('TEST-feedback-job-1');
    expect(prepareRuntime).toHaveBeenCalledExactlyOnceWith(project.id, 1, 'analysis', { planFeedback: feedback, background: 'canvas' });
    expect(startAutomation).toHaveBeenCalledOnce();
    expect(project.plan).toEqual(before.plan); expect(project.storyApproval).toEqual(before.storyApproval); expect(project.assets).toEqual(before.assets); expect(project.jobs[0]).toEqual(before.jobs[0]);
    expect(project.jobs[1].runId).toBe('TEST-run-1'); expect(project.jobs[1].requestId).not.toBe(feedback.requestId);
    expect(beginAdjustment).not.toHaveBeenCalled(); expect(adoptPlanCandidate).not.toHaveBeenCalled(); expect(confirmStory).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
    expect(isBackgroundCanvasPromptTask(project, project.jobs[1].taskId)).toBe(true);
  });

  it('调度因账号未决任务失败时返回已保存步骤和明确原因，重复请求只接回原步骤', async (): Promise<void> => {
    startAutomation.mockImplementationOnce(async (): Promise<boolean> => { useTaskStore.setState({ error: '该账号仍绑定生成确认或人工提交观察会话；请先完成只读回读或人工取消' }); return false; });
    const jobId = await usePetStoryStore.getState().revisePlan(feedback);
    expect(jobId).toBe('TEST-feedback-job-1'); expect(usePetStoryStore.getState().error).toContain('只读回读或人工取消');
    const same = await usePetStoryStore.getState().revisePlan(feedback);
    expect(same).toBe(jobId); expect(project.jobs).toHaveLength(2); expect(tasks).toHaveLength(1); expect(startAutomation).toHaveBeenCalledTimes(2);
  });

  it('保存成功后任务列表回读失败仍返回原步骤，不吞掉恢复原因', async (): Promise<void> => {
    listTasks.mockRejectedValueOnce(new Error('TEST 任务回读暂时失败'));
    expect(await usePetStoryStore.getState().revisePlan(feedback)).toBe('TEST-feedback-job-1');
    expect(usePetStoryStore.getState().error).toBe('TEST 任务回读暂时失败'); expect(startAutomation).not.toHaveBeenCalled();
    expect(project.jobs[1].planFeedback?.requestId).toBe(feedback.requestId);
  });

  it('主进程拒绝时保留服务原因，未制造恢复步骤或跳到旧自由调整', async (): Promise<void> => {
    prepareRuntime.mockResolvedValueOnce({ success: false, error: 'TEST 原方案任务仍在等待结果', project });
    expect(await usePetStoryStore.getState().revisePlan(feedback)).toBeUndefined();
    expect(usePetStoryStore.getState().error).toBe('TEST 原方案任务仍在等待结果'); expect(project.jobs).toHaveLength(1); expect(startAutomation).not.toHaveBeenCalled(); expect(beginAdjustment).not.toHaveBeenCalled();
  });

  it('保留未保存草稿保护，并对繁忙重复点击给出明确反馈', async (): Promise<void> => {
    registerPetStoryDraft(`${project.id}:plan`, 'TEST 未保存镜头');
    expect(await usePetStoryStore.getState().revisePlan(feedback)).toBeUndefined(); expect(usePetStoryStore.getState().error).toContain('尚未保存'); expect(prepareRuntime).not.toHaveBeenCalled();
    unregisterPetStoryDraft(`${project.id}:plan`); usePetStoryStore.setState({ busy: true, error: '' });
    expect(await usePetStoryStore.getState().revisePlan(feedback)).toBeUndefined(); expect(usePetStoryStore.getState().error).toContain('当前操作仍在处理'); expect(prepareRuntime).not.toHaveBeenCalled();
    usePetStoryStore.setState({ busy: false });
  });

  it('先暂停文字批次，保留原文字任务，再创建方案修改步骤', async (): Promise<void> => {
    await usePetStoryStore.getState().regenerateAllPrompts();
    const original = project.jobs[1];
    expect(usePetStoryStore.getState().promptBatch.status).toBe('running');
    await usePetStoryStore.getState().revisePlan(feedback);
    expect(usePetStoryStore.getState().promptBatch.status).toBe('paused'); expect(project.promptBatch?.status).toBe('paused');
    expect(project.jobs.find((job): boolean => job.id === original.id)?.taskId).toBe(original.taskId);
    expect(prepareRuntime).toHaveBeenLastCalledWith(project.id, expect.any(Number), 'analysis', { planFeedback: feedback, background: 'canvas' });
  });

  it('正式收取可自动转 repair，仍作为后台候选并保留采用方案', async (): Promise<void> => {
    usePetStoryStore.setState({ autoRepair: false });
    const originalPlan = structuredClone(project.plan); const rootId = await usePetStoryStore.getState().revisePlan(feedback);
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => {
      project = structuredClone(project); project.revision++;
      const job = project.jobs.find((item): boolean => item.id === jobId)!; job.status = 'invalid'; job.rawText = 'TEST 需要修订的完整回复'; job.error = 'TEST 镜头缺少时长';
      return { success: false, project, error: job.error, needsRepair: true };
    });
    await usePetStoryStore.getState().collect(rootId!, true);
    const repair = project.jobs.at(-1)!;
    expect(repair).toMatchObject({ kind: 'repair', parentJobId: rootId, repairMode: 'automatic' }); expect(isBackgroundCanvasPromptTask(project, repair.taskId)).toBe(true);
    await usePetStoryStore.getState().collect(repair.id, true);
    expect(project.jobs.at(-1)).toMatchObject({ status: 'applied', resultStatus: 'candidate' }); expect(project.plan).toEqual(originalPlan); expect(adoptPlanCandidate).not.toHaveBeenCalled(); expect(confirmStory).not.toHaveBeenCalled();
  });

  it('后台完成事件沿已有监控自动收为候选，用户无需打开网页或手动收取', async (): Promise<void> => {
    const rootId = await usePetStoryStore.getState().revisePlan(feedback);
    const unsubscribe = observePetStoryTasks();
    try {
      const task = tasks[0]; task.status = 'done'; task.runtime!.chatResponse = { text: 'TEST 完整方案回复', capturedAt: now };
      useTaskStore.setState({ tasks: [...tasks] });
      await vi.waitFor((): void => expect(project.jobs.find((job): boolean => job.id === rootId)?.resultStatus).toBe('candidate'));
      expect(collectChat).toHaveBeenCalledExactlyOnceWith(project.id, rootId); expect(adoptPlanCandidate).not.toHaveBeenCalled(); expect(confirmStory).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it('收取暂时失败后有限重读已完成原回复，不永久漏掉任务或重发', async (): Promise<void> => {
    vi.useFakeTimers();
    const rootId = await usePetStoryStore.getState().revisePlan(feedback);
    collectChat.mockRejectedValueOnce(new Error('TEST 临时读取失败'));
    const unsubscribe = observePetStoryTasks();
    try {
      const task = tasks[0]; task.status = 'done'; task.runtime!.chatResponse = { text: 'TEST 已落盘完整回复', capturedAt: now };
      useTaskStore.setState({ tasks: [...tasks] });
      await vi.advanceTimersByTimeAsync(3000);
      expect(collectChat).toHaveBeenCalledTimes(2);
      expect(project.jobs.find((job): boolean => job.id === rootId)?.resultStatus).toBe('candidate');
      expect(prepareRuntime).toHaveBeenCalledTimes(1); expect(startAutomation).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); vi.useRealTimers(); }
  });

  it('收取持续失败只有限重读，保留明确原因及原任务供用户恢复', async (): Promise<void> => {
    vi.useFakeTimers();
    await usePetStoryStore.getState().revisePlan(feedback);
    collectChat.mockRejectedValue(new Error('TEST 原回复读取持续失败'));
    const unsubscribe = observePetStoryTasks();
    try {
      tasks[0].status = 'done'; tasks[0].runtime!.chatResponse = { text: 'TEST 原运行完整回复', capturedAt: now };
      useTaskStore.setState({ tasks: [...tasks] }); await vi.advanceTimersByTimeAsync(20_000);
      expect(collectChat).toHaveBeenCalledTimes(3);
      expect(usePetStoryStore.getState().error).toBe('TEST 原回复读取持续失败');
      expect(prepareRuntime).toHaveBeenCalledTimes(1); expect(startAutomation).toHaveBeenCalledTimes(1);
      collectChat.mockImplementationOnce(async (): Promise<PetStoryResult> => {
        project = structuredClone(project); const job = project.jobs.at(-1)!;
        job.status = 'applied'; job.resultStatus = 'candidate'; job.parsedResult = { plan: structuredClone(snapshot.plan) as PetStoryPlan };
        return { success: true, project };
      });
      await usePetStoryStore.getState().collect(project.jobs.at(-1)!.id);
      expect(project.jobs.at(-1)?.resultStatus).toBe('candidate');
    } finally { unsubscribe(); vi.useRealTimers(); }
  });

  it('无批次方案在收取期间停止，迟到无效回复只保存，不能重新授权下一轮发送', async (): Promise<void> => {
    const rootId = await usePetStoryStore.getState().revisePlan(feedback);
    let release: ((result: PetStoryResult) => void) | undefined;
    collectChat.mockImplementationOnce((): Promise<PetStoryResult> => new Promise((resolve): void => { release = resolve; }));
    const collecting = usePetStoryStore.getState().collect(rootId!);
    await usePetStoryStore.getState().stopPromptBatch();
    project = structuredClone(project); project.revision++;
    const job = project.jobs.at(-1)!; job.status = 'invalid'; job.rawText = 'TEST 停止后收到的原回复'; job.error = 'TEST 需要修订';
    release!({ success: false, project, error: job.error, needsRepair: true }); await collecting;
    expect(prepareRuntime).toHaveBeenCalledTimes(1); expect(startAutomation).toHaveBeenCalledTimes(1);
    expect(project.jobs.at(-1)).toMatchObject({ status: 'invalid', rawText: job.rawText });
    expect(usePetStoryStore.getState().busy).toBe(false);
  });

  it('已有失败子回复重校验期间停止，不由递归修订重新取得发送权', async (): Promise<void> => {
    const rootId = await usePetStoryStore.getState().revisePlan(feedback);
    await prepareRuntime(project.id, project.revision, 'repair', { parentJobId: rootId, repairMode: 'automatic' });
    const child = project.jobs.at(-1)!; child.status = 'invalid'; child.rawText = 'TEST 已有失败子回复';
    let release: ((result: PetStoryResult) => void) | undefined;
    collectChat.mockResolvedValueOnce({ success: false, project, needsRepair: true, repairJobId: child.id });
    collectChat.mockImplementationOnce((): Promise<PetStoryResult> => new Promise((resolve): void => { release = resolve; }));
    const collecting = usePetStoryStore.getState().collect(rootId!);
    await vi.waitFor((): void => expect(collectChat).toHaveBeenCalledTimes(2));
    await usePetStoryStore.getState().stopPromptBatch();
    release!({ success: false, project, error: 'TEST 原子回复仍有缺项', needsRepair: true }); await collecting;
    expect(prepareRuntime).toHaveBeenCalledTimes(2); expect(startAutomation).toHaveBeenCalledTimes(1);
    expect(project.jobs).toHaveLength(3); expect(usePetStoryStore.getState().busy).toBe(false);
  });

  it('重读旧父回复接到已停止子修订时，保留最新真实暂停原因', async (): Promise<void> => {
    const rootId = await usePetStoryStore.getState().revisePlan(feedback);
    await prepareRuntime(project.id, project.revision, 'repair', { parentJobId: rootId, repairMode: 'automatic' });
    const child = project.jobs.at(-1)!; child.status = 'invalid'; child.rawText = 'TEST 最新原回复';
    child.error = 'TEST 自动修订没有进展，已暂停';
    collectChat.mockResolvedValueOnce({ success: false, project, needsRepair: true, repairJobId: child.id, error: 'TEST 旧父回复的结构问题' });
    collectChat.mockResolvedValueOnce({ success: false, project, needsRepair: false, error: child.error });
    await usePetStoryStore.getState().collect(rootId!);
    expect(usePetStoryStore.getState().error).toBe(child.error);
    expect(prepareRuntime).toHaveBeenCalledTimes(2); expect(project.jobs).toHaveLength(3);
  });

  it('停止期间原回复读取失败，后续观察不能重新激活方案修订', async (): Promise<void> => {
    vi.useFakeTimers();
    const rootId = await usePetStoryStore.getState().revisePlan(feedback);
    let reject: ((error: Error) => void) | undefined;
    collectChat.mockImplementationOnce((): Promise<PetStoryResult> => new Promise((_resolve, fail): void => { reject = fail; }));
    const unsubscribe = observePetStoryTasks();
    try {
      tasks[0].status = 'done'; tasks[0].runtime!.chatResponse = { text: 'TEST 原运行完整回复', capturedAt: now };
      useTaskStore.setState({ tasks: [...tasks] });
      await usePetStoryStore.getState().stopPromptBatch(); reject!(new Error('TEST 停止期间读取失败'));
      await vi.advanceTimersByTimeAsync(5000);
      expect(collectChat).toHaveBeenCalledTimes(1); expect(prepareRuntime).toHaveBeenCalledTimes(1);
      expect(project.jobs.find((job): boolean => job.id === rootId)?.status).toBe('bound');
    } finally { unsubscribe(); vi.useRealTimers(); }
  });
});

describe('重开方案反馈只读收取', (): void => {
  it.each(['analysis', 'repair'] as const)('重开后只收取当前%s叶子的已完成原回复，不新建或发送任务', async (kind): Promise<void> => {
    const { job } = savedFeedback(kind); const beforePlan = structuredClone(project.plan); const beforeTasks = structuredClone(tasks);
    usePetStoryStore.setState({ project: null });
    await usePetStoryStore.getState().openProject('TEST-saved-directory');
    expect(collectChat).toHaveBeenCalledExactlyOnceWith(project.id, job.id);
    expect(project.jobs.find((item): boolean => item.id === job.id)).toMatchObject({ status: 'applied', resultStatus: 'candidate' });
    expect(project.plan).toEqual(beforePlan); expect(tasks).toEqual(beforeTasks); expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });

  it('已捕获正文不依赖重新打开网页，重开直接解析原rawText', async (): Promise<void> => {
    const { job, task } = savedFeedback(); job.status = 'captured'; job.rawText = 'TEST 已捕获的完整原回复'; task.runtime!.chatResponse = undefined;
    usePetStoryStore.setState({ project: null }); await usePetStoryStore.getState().openProject();
    expect(collectChat).toHaveBeenCalledExactlyOnceWith(project.id, job.id); expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
  });

  it('重开后沿既有已受理观察等待完成，再自动收取原结果', async (): Promise<void> => {
    const { job, task } = savedFeedback('repair'); accepted(task); usePetStoryStore.setState({ project: null });
    await usePetStoryStore.getState().openProject();
    expect(collectChat).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
    const unsubscribe = observePetStoryTasks();
    try {
      task.status = 'done'; task.runtime!.chatResponse = { text: 'TEST 原观察迟到回复', capturedAt: now }; useTaskStore.setState({ tasks: [...tasks] });
      await vi.waitFor((): void => expect(project.jobs.find((item): boolean => item.id === job.id)?.resultStatus).toBe('candidate'));
      expect(collectChat).toHaveBeenCalledExactlyOnceWith(project.id, job.id); expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it('重开收取遇到无效正文只展示待继续，不继承新格式修订发送权', async (): Promise<void> => {
    const { job } = savedFeedback();
    collectChat.mockImplementationOnce(async (): Promise<PetStoryResult> => {
      project = structuredClone(project); project.revision++; const saved = project.jobs.find((item): boolean => item.id === job.id)!;
      saved.status = 'invalid'; saved.rawText = 'TEST 原回复格式缺项'; saved.error = 'TEST 请继续原步骤整理镜头时长';
      return { success: false, project, error: saved.error, needsRepair: true };
    });
    usePetStoryStore.setState({ project: null, autoRepair: true }); await usePetStoryStore.getState().openProject();
    expect(usePetStoryStore.getState().error).toBe('TEST 请继续原步骤整理镜头时长'); expect(project.jobs).toHaveLength(2);
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
  });

  it.each(['run', 'account', 'project', 'story', 'source', 'input', 'request', 'attachments', 'ended', 'parent-ended'] as const)('重开不收取%s不符的回复', async (mismatch): Promise<void> => {
    const { job, task } = savedFeedback('repair');
    if (mismatch === 'run') task.runtime!.runId = 'TEST-other-run';
    if (mismatch === 'account') task.assignedAccountId = 'TEST-other-account';
    if (mismatch === 'project') task.projectId = 'TEST-other-studio';
    if (mismatch === 'story') job.sourceStoryId = 'TEST-other-story';
    if (mismatch === 'source') job.sourceUrl = 'https://example.invalid/TEST-other-source';
    if (mismatch === 'input') task.runtime!.input.prompt = 'TEST different runtime input';
    if (mismatch === 'request') job.requestText = 'TEST different saved request';
    if (mismatch === 'attachments') task.runtime!.input.attachments = ['TEST-other-attachment'];
    if (mismatch === 'ended') job.endedWaitingAt = now;
    if (mismatch === 'parent-ended') project.jobs.find((item): boolean => item.id === job.parentJobId)!.endedWaitingAt = now;
    usePetStoryStore.setState({ project: null }); await usePetStoryStore.getState().openProject();
    expect(collectChat).not.toHaveBeenCalled(); expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
  });

  it.each(['queued', 'paused', 'cancelled'] as const)('重开%s步骤不自动开始、读取或重新发送', async (status): Promise<void> => {
    const { task } = savedFeedback(); task.status = status;
    usePetStoryStore.setState({ project: null }); await usePetStoryStore.getState().openProject();
    expect(collectChat).not.toHaveBeenCalled(); expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled(); expect(task.status).toBe(status);
  });

  it.each(['run', 'story', 'stop', 'pause'] as const)('只读观察完成前%s变化即撤回收取，不覆盖后来状态', async (change): Promise<void> => {
    const { job, task } = savedFeedback(); accepted(task); usePetStoryStore.setState({ project: null }); await usePetStoryStore.getState().openProject();
    if (change === 'run') task.runtime!.runId = 'TEST-newer-run';
    if (change === 'story') project.mobileStory!.id = 'TEST-newer-story';
    if (change === 'stop') await usePetStoryStore.getState().stopPromptBatch();
    const unsubscribe = observePetStoryTasks();
    try {
      if (change === 'pause') { task.status = 'paused'; useTaskStore.setState({ tasks: [...tasks] }); }
      task.status = 'done'; task.runtime!.chatResponse = { text: 'TEST 迟到原回复', capturedAt: now }; useTaskStore.setState({ tasks: [...tasks] });
      expect(collectChat).not.toHaveBeenCalled(); expect(project.jobs.find((item): boolean => item.id === job.id)?.status).toBe('bound'); expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });
});
