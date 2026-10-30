/** 原五镜头的离线入口回归；IPC 与网页均为替身，不属于真实豆包验收。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryAdjustmentPreviewResult, PetStoryChatJob, PetStoryPlan, PetStoryProject, PetStoryPromptBatch, PetStoryResult, PetStoryRuntimeTarget, Task } from '@doubao-studio/contracts';
import { observePetStoryTasks, usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import { registerPetStoryDraft, unregisterPetStoryDraft } from '../../src/utils/petstoryDraftPresence';
import snapshot from '../fixtures/storyboard-five-shots.json';

const original = { studio: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState(), projects: useProjectStore.getState() };
const now = '2026-10-30T01:00:00.000Z';
let project: PetStoryProject;
let tasks: Task[];
let unobserve: (() => void) | undefined;
let fixtureSerial = 0;
const prepareRuntime = vi.fn<(id: string, revision: number, kind: PetStoryChatJob['kind'], target?: PetStoryRuntimeTarget) => Promise<PetStoryResult>>();
const collectChat = vi.fn<(id: string, jobId: string) => Promise<PetStoryResult>>();
const previewReply = vi.fn<(id: string, revision: number, adjustmentId: string, replyKey: string) => Promise<PetStoryAdjustmentPreviewResult>>();
const startAutomation = vi.fn<(taskId: string, beforeDispatch?: (task: Task) => Promise<void>) => Promise<boolean>>();
const promptStageTargets = vi.fn<() => Promise<PetStoryResult>>();
const savePromptBatch = vi.fn<(id: string, revision: number, batch: PetStoryPromptBatch) => Promise<PetStoryResult>>();
const retryUnsubmitted = vi.fn<(id: string, jobId: string) => Promise<PetStoryResult>>();
const adoptPrompt = vi.fn<(id: string, revision: number, jobId: string) => Promise<PetStoryResult>>();
const adoptReply = vi.fn<(id: string, revision: number, adjustmentId: string, replyKey: string) => Promise<PetStoryResult>>();

function taskFor(job: PetStoryChatJob): Task {
  return { id: job.taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: 'queued',
    prompt: 'TEST 正式文字请求替身', executionIntent: 'hold', result: null, outputs: [], createdAt: now, updatedAt: now,
    runtime: { runId: `TEST-run-${job.id}`, attempt: 1, stage: 'preparing_account', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { prompt: 'TEST 正式文字请求替身', mode: 'chat', attachments: [] } } };
}

function installJob(kind: PetStoryChatJob['kind'], target: PetStoryRuntimeTarget = {}): PetStoryChatJob {
  const index = project.jobs.length + 1;
  const job: PetStoryChatJob = { id: `TEST-auto-job-${fixtureSerial}-${index}`, taskId: `TEST-auto-task-${fixtureSerial}-${index}`, kind, status: 'bound', inputHash: 'TEST', sourceUrl: '',
    sourceStoryId: project.mobileStory!.id, requestId: `TEST-auto-request-${index}`, expectedIds: [target.materialId || target.shotId || 'story'],
    createdAt: new Date(Date.parse(now) + index * 1000).toISOString(), ...target };
  project.jobs.push(job); tasks.push(taskFor(job)); return job;
}

function saveCollected(jobId: string, valid: boolean, candidate = false): PetStoryResult {
  project = structuredClone(project); project.revision++;
  const job = project.jobs.find((item): boolean => item.id === jobId)!;
  job.rawText = JSON.stringify({ requestId: job.requestId, targetIds: job.expectedIds, ...structuredClone(snapshot.plan) });
  job.status = valid ? 'applied' : 'invalid'; job.resultStatus = candidate ? 'candidate' : undefined;
  if (valid) {
    job.error = undefined;
    job.parsedResult = job.shotId && job.promptKind ? { optimized: snapshot.plan.shots[0].prompts.firstFrame.final } : { plan: structuredClone(snapshot.plan) as PetStoryPlan };
  } else { job.error = 'TEST 原回复时长不符合当前项目约束'; job.validationIssues = [job.error]; }
  return { success: valid, project, ...(valid ? {} : { error: job.error, needsRepair: true }) };
}

function installAdjustment(): void {
  project.chatAdjustment = { id: 'TEST-auto-adjustment', sourceJobId: 'TEST-source', target: {}, basisHash: 'TEST',
    conversationUrl: 'https://www.doubao.com/chat/TEST-auto-original', startedAt: now, status: 'active', replies: [
      { key: 'TEST-selected', text: JSON.stringify(snapshot.plan), precedingUserText: 'TEST 原故事完整方案', capturedAt: now },
      { key: 'TEST-later', text: 'TEST 后来的讨论', precedingUserText: 'TEST 讨论', capturedAt: now }] };
  usePetStoryStore.setState({ project });
}

beforeEach((): void => {
  vi.resetAllMocks(); tasks = []; fixtureSerial++;
  project = { id: 'TEST-auto-project', schemaVersion: 1, studioProjectId: 'TEST-auto-studio', accountId: 'TEST-auto-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-auto-source', text: snapshot.mobileStory, importedAt: now },
    plan: structuredClone(snapshot.plan) as PetStoryPlan, assets: [], jobs: [], updatedAt: now };
  prepareRuntime.mockImplementation(async (_id: string, _revision: number, kind: PetStoryChatJob['kind'], target?: PetStoryRuntimeTarget): Promise<PetStoryResult> => {
    project = structuredClone(project); project.revision++;
    const parent = project.jobs.find((job): boolean => job.id === target?.parentJobId);
    const inherited = kind === 'repair' && parent ? { shotId: parent.shotId, promptKind: parent.promptKind, materialId: parent.materialId } : {};
    const job = installJob(kind, { ...inherited, ...target }); return { success: true, project, taskId: job.taskId };
  });
  collectChat.mockImplementation(async (_id: string, jobId: string): Promise<PetStoryResult> => saveCollected(jobId, true));
  previewReply.mockImplementation(async (): Promise<PetStoryAdjustmentPreviewResult> => ({ success: true, project, preview: { target: {}, plan: structuredClone(snapshot.plan) as PetStoryPlan } }));
  startAutomation.mockImplementation(async (taskId: string, beforeDispatch?: (task: Task) => Promise<void>): Promise<boolean> => {
    await beforeDispatch?.(tasks.find((task): boolean => task.id === taskId)!); return true;
  });
  promptStageTargets.mockImplementation(async (): Promise<PetStoryResult> => ({ success: true, project, promptTargets: [], pendingCandidateJobIds: [] }));
  savePromptBatch.mockImplementation(async (_id: string, _revision: number, batch: PetStoryPromptBatch): Promise<PetStoryResult> => {
    project = structuredClone(project); project.revision++; project.promptBatch = structuredClone(batch); return { success: true, project };
  });
  retryUnsubmitted.mockImplementation(async (_id: string, jobId: string): Promise<PetStoryResult> => ({ success: true, project, taskId: project.jobs.find((job): boolean => job.id === jobId)!.taskId }));
  adoptPrompt.mockImplementation(async (_id: string, _revision: number, jobId: string): Promise<PetStoryResult> => {
    project = structuredClone(project); project.revision++;
    project.jobs.find((job): boolean => job.id === jobId)!.resultStatus = 'adopted'; return { success: true, project };
  });
  adoptReply.mockImplementation(async (_id: string, _revision: number, adjustmentId: string, replyKey: string): Promise<PetStoryResult> => {
    project = structuredClone(project); project.revision++;
    const child = installJob('repair'); child.repairReplySource = { adjustmentId, replyKey };
    project.chatAdjustment!.repairJobId = child.id; project.chatAdjustment!.selectedReplyKey = replyKey;
    return { success: true, project, taskId: child.taskId, repairJobId: child.id };
  });
  vi.stubGlobal('localStorage', { setItem: vi.fn() });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { electronAPI: { petstory: { prepareRuntime, collectChat, previewAdjustmentReply: previewReply, adoptAdjustmentReply: adoptReply, adoptPromptCandidate: adoptPrompt, savePromptBatch, promptStageTargets, retryUnsubmitted,
    open: async (): Promise<PetStoryResult> => ({ success: true, project }),
    bindRun: async (_id: string, jobId: string, runId: string): Promise<PetStoryResult> => { project.jobs.find((job): boolean => job.id === jobId)!.runId = runId; return { success: true, project }; },
    endChatWaiting: async (_id: string, _revision: number, jobId: string): Promise<PetStoryResult> => {
      project = structuredClone(project); project.revision++; project.jobs.find((job): boolean => job.id === jobId)!.endedWaitingAt = now;
      if (project.promptBatch) project.promptBatch.status = 'paused'; return { success: true, project };
    },
    endAdjustment: async (): Promise<PetStoryResult> => {
      project = structuredClone(project); project.revision++; project.chatAdjustment!.status = 'ended';
      const job = project.jobs.find((item): boolean => item.id === project.chatAdjustment!.repairJobId); if (job) job.endedWaitingAt = now;
      return { success: true, project };
    },
    prepareChat: vi.fn((): never => { throw new Error('本轮不能回退到渲染进程生成修订正文'); })}, tasks: { list: async (): Promise<Task[]> => tasks } } }));
  const account: Account = { id: project.accountId, name: 'TEST 原账号', platform: 'doubao', partition: 'TEST-auto-partition', status: 'idle', avatar: '', pinned: false, createdAt: now, updatedAt: now };
  useAccountStore.setState({ ...original.accounts, accounts: [account], selectedAccountId: account.id });
  useProjectStore.setState({ ...original.projects, projects: [{ id: project.studioProjectId, name: 'TEST 原故事项目', description: '', color: '#fff', archived: false, createdAt: now, updatedAt: now }] });
  useTaskStore.setState({ ...original.tasks, tasks, activeTaskId: null, accountBusy: {}, accountAutomationState: {}, startAutomation, error: '' });
  usePetStoryStore.setState({ ...original.studio, project, busy: false, error: '', autoRepair: true, capability: null, promptBatch: { total: 0, completed: 0, status: 'idle' } });
  window.addEventListener('petstory-verify-adjustment-reply', ((event: CustomEvent<{ resolve: () => void }>): void => event.detail.resolve()) as EventListener);
});

afterEach(async (): Promise<void> => {
  unobserve?.(); unobserve = undefined;
  await usePetStoryStore.getState().stopPromptBatch();
  unregisterPetStoryDraft(`${project.id}:TEST-auto-draft`);
  usePetStoryStore.setState(original.studio); useTaskStore.setState(original.tasks); useAccountStore.setState(original.accounts); useProjectStore.setState(original.projects);
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('原五镜头的自动修订与明确入口', (): void => {
  it('合格原回复的手动收取不额外创建修订，也不改变当前采用方案', async (): Promise<void> => {
    await usePetStoryStore.getState().analyze(); const job = project.jobs[0]; const adopted = structuredClone(project.plan);
    await usePetStoryStore.getState().collect(job.id);
    expect(prepareRuntime).toHaveBeenCalledTimes(1); expect(project.jobs).toHaveLength(1);
    expect(usePetStoryStore.getState().project?.plan).toEqual(adopted); expect(usePetStoryStore.getState().error).toBe('');
  });

  it('明确手动收取本轮坏回复自动安排一次原目标修订，不要求调用方另传allowRepair', async (): Promise<void> => {
    await usePetStoryStore.getState().analyze(); const job = project.jobs[0];
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => saveCollected(jobId, false));
    await usePetStoryStore.getState().collect(job.id);
    expect(prepareRuntime.mock.calls.filter((call): boolean => call[2] === 'repair')).toEqual([[project.id, expect.any(Number), 'repair', { parentJobId: job.id, repairMode: 'automatic' }]]);
    expect(project.jobs).toHaveLength(2); expect(project.jobs[1].parentJobId).toBe(job.id);
    expect(project.jobs[0].rawText).toBeDefined(); expect(usePetStoryStore.getState().error).toBe('');
  });

  it('只预览明确选中回复不发送；不能默认处理后来另一条回复', async (): Promise<void> => {
    installAdjustment();
    const result = await usePetStoryStore.getState().previewChatReply('TEST-selected');
    expect(previewReply).toHaveBeenCalledExactlyOnceWith(project.id, project.revision, 'TEST-auto-adjustment', 'TEST-selected');
    expect(result?.plan).toEqual(snapshot.plan); expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
    expect(project.chatAdjustment?.status).toBe('active'); expect(project.chatAdjustment?.adoptedReplyKey).toBeUndefined();
  });

  it('自动观察与手动收取并发只进入一次收取及一次修订', async (): Promise<void> => {
    vi.useFakeTimers();
    await usePetStoryStore.getState().analyze(); const job = project.jobs[0]; const task = tasks[0];
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve): void => { release = resolve; });
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => { await pending; return saveCollected(jobId, false); });
    unobserve = observePetStoryTasks();
    task.status = 'done'; task.runtime!.chatResponse = { text: JSON.stringify(snapshot.plan), capturedAt: now };
    useTaskStore.setState({ tasks: [...tasks] });
    const manual = usePetStoryStore.getState().collect(job.id);
    release?.(); await manual;
    await vi.waitFor((): void => { expect(usePetStoryStore.getState().busy).toBe(false); });
    expect(collectChat).toHaveBeenCalledTimes(1); expect(prepareRuntime.mock.calls.filter((call): boolean => call[2] === 'repair')).toHaveLength(1);
    expect(project.jobs.filter((item): boolean => item.parentJobId === job.id)).toHaveLength(1);
  });

  it('重开历史坏回复与观察器挂载不新增请求，保留历史错误', async (): Promise<void> => {
    vi.useFakeTimers();
    const job = installJob('analysis'); saveCollected(job.id, false);
    usePetStoryStore.setState({ project });
    await usePetStoryStore.getState().openProject('/OFFLINE/原故事副本');
    unobserve = observePetStoryTasks(); useTaskStore.setState({ tasks: [...tasks] }); await vi.advanceTimersByTimeAsync(2000);
    expect(collectChat).not.toHaveBeenCalled(); expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().project?.jobs[0].status).toBe('invalid');
  });

  it('修订合格仍停在原目标候选，确认采用后只结算一次并继续原批次', async (): Promise<void> => {
    const preserved = structuredClone(project.plan);
    await usePetStoryStore.getState().regenerateAllPrompts(); const parent = project.jobs[0];
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => saveCollected(jobId, false));
    await usePetStoryStore.getState().collect(parent.id);
    const repair = project.jobs[1];
    expect(project.promptBatch).toMatchObject({ completed: 0, jobId: repair.id, status: 'running' });
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => saveCollected(jobId, true, true));
    await usePetStoryStore.getState().collect(repair.id);
    expect(project.promptBatch).toMatchObject({ completed: 0, jobId: repair.id, status: 'paused' });
    expect(prepareRuntime).toHaveBeenCalledTimes(2); expect(project.plan).toEqual(preserved);
    await usePetStoryStore.getState().adoptPromptCandidate(repair.id);
    expect(prepareRuntime).toHaveBeenCalledTimes(3);
    expect(project.jobs.at(-1)).toMatchObject({ kind: 'optimize', shotId: parent.shotId, promptKind: 'video' });
    expect(project.promptBatch).toMatchObject({ completed: 1, status: 'running' });
    await usePetStoryStore.getState().adoptPromptCandidate(repair.id);
    expect(prepareRuntime).toHaveBeenCalledTimes(3); expect(project.promptBatch?.completed).toBe(1);
    expect(project.jobs[0]).toMatchObject({ id: parent.id, status: 'invalid', error: 'TEST 原回复时长不符合当前项目约束' });
  });

  it('收取等待期间用户暂停批次，不再创建或发送自动修订', async (): Promise<void> => {
    await usePetStoryStore.getState().regenerateAllPrompts(); const parent = project.jobs[0];
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve): void => { release = resolve; });
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => { await pending; return saveCollected(jobId, false); });
    const collecting = usePetStoryStore.getState().collect(parent.id);
    await usePetStoryStore.getState().stopPromptBatch(); release?.(); await collecting;
    expect(prepareRuntime).toHaveBeenCalledTimes(1); expect(project.jobs).toHaveLength(1);
    expect(project.promptBatch).toMatchObject({ status: 'paused', completed: 0, jobId: parent.id });
  });

  it('唯一自动修订仍失败时停止；用户显式新轮次可修订且只获得一次新的自动预算', async (): Promise<void> => {
    await usePetStoryStore.getState().analyze(); const parent = project.jobs[0];
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => saveCollected(jobId, false));
    await usePetStoryStore.getState().collect(parent.id); const repair = project.jobs[1];
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => ({ ...saveCollected(jobId, false), needsRepair: false }));
    await usePetStoryStore.getState().collect(repair.id);
    expect(project.jobs).toHaveLength(2); expect(usePetStoryStore.getState().error).toContain('豆包还未修好，你可以继续调整');
    expect(project.jobs.find((job): boolean => job.id === repair.id)?.error).toBe('TEST 原回复时长不符合当前项目约束');
    await usePetStoryStore.getState().correctOnce(repair.id);
    expect(prepareRuntime.mock.calls.at(-1)?.slice(2)).toEqual(['repair', { parentJobId: repair.id, repairMode: 'explicit' }]);
    expect(project.jobs).toHaveLength(3); expect(project.jobs[0].rawText).toBeDefined(); expect(project.jobs[1].rawText).toBeDefined();
    const explicit = project.jobs[2];
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => saveCollected(jobId, false));
    await usePetStoryStore.getState().collect(explicit.id);
    const automatic = project.jobs[3];
    expect(automatic).toMatchObject({ kind: 'repair', parentJobId: explicit.id, repairMode: 'automatic' });
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => ({ ...saveCollected(jobId, false), needsRepair: false }));
    await usePetStoryStore.getState().collect(automatic.id);
    expect(project.jobs).toHaveLength(4); expect(prepareRuntime).toHaveBeenCalledTimes(4);
  });

  it.each(['网络连接失败', '需要重新登录', '尚未收到完整回复', '程序映射错误'])('%s由恢复处理，不发内容修订', async (error: string): Promise<void> => {
    await usePetStoryStore.getState().analyze(); const parent = project.jobs[0];
    collectChat.mockResolvedValueOnce({ success: false, project, error, needsRepair: false });
    await usePetStoryStore.getState().collect(parent.id);
    expect(prepareRuntime).toHaveBeenCalledTimes(1); expect(project.jobs).toHaveLength(1); expect(usePetStoryStore.getState().error).toBe(error);
  });

  it('选定自由回复合格时只返回完整预览，不自动采用或发送', async (): Promise<void> => {
    installAdjustment();
    const result = await usePetStoryStore.getState().applyChatReply('TEST-selected');
    expect(previewReply).toHaveBeenCalledExactlyOnceWith(project.id, project.revision, 'TEST-auto-adjustment', 'TEST-selected');
    expect(result?.plan).toEqual(snapshot.plan); expect(adoptReply).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
    expect(project.chatAdjustment?.status).toBe('active'); expect(project.chatAdjustment?.adoptedReplyKey).toBeUndefined();
  });

  it('明确应用无效自由回复仅启动该回复关联修订，保留保护和原方案；其他创作不能抢输入框', async (): Promise<void> => {
    installAdjustment(); const adopted = structuredClone(project.plan); const replies = structuredClone(project.chatAdjustment!.replies);
    previewReply.mockResolvedValueOnce({ success: false, project, needsRepair: true, error: 'TEST 选定回复的时长需要修订' });
    const value = await usePetStoryStore.getState().applyChatReply('TEST-selected');
    expect(value).toBeNull(); expect(adoptReply).toHaveBeenCalledExactlyOnceWith(project.id, expect.any(Number), 'TEST-auto-adjustment', 'TEST-selected');
    const repair = project.jobs[0]; expect(startAutomation).toHaveBeenCalledExactlyOnceWith(repair.taskId, expect.any(Function));
    expect(project.chatAdjustment).toMatchObject({ status: 'active', selectedReplyKey: 'TEST-selected', repairJobId: repair.id, replies });
    expect(project.plan).toEqual(adopted);
    await usePetStoryStore.getState().analyze();
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).toHaveBeenCalledTimes(1); expect(project.chatAdjustment?.status).toBe('active');
  });

  it('应用所选自由回复遇未保存工作室草稿时先保留草稿，不核对或发送整理请求', async (): Promise<void> => {
    installAdjustment(); registerPetStoryDraft(`${project.id}:TEST-auto-draft`, '原五镜头首帧草稿');
    const result = await usePetStoryStore.getState().applyChatReply('TEST-selected');
    expect(result).toBeNull(); expect(previewReply).not.toHaveBeenCalled(); expect(adoptReply).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().error).toContain('尚未保存'); expect(project.chatAdjustment?.status).toBe('active');
  });

  it('自由交流期间自动观察只收取已绑定的选定回复修订，不处理普通任务', async (): Promise<void> => {
    vi.useFakeTimers();
    await usePetStoryStore.getState().analyze(); const ordinary = project.jobs[0];
    installAdjustment();
    previewReply.mockResolvedValueOnce({ success: false, project, needsRepair: true, error: 'TEST 选定回复需整理' });
    await usePetStoryStore.getState().applyChatReply('TEST-selected'); const repair = project.jobs[1];
    for (const task of tasks) { task.status = 'done'; task.runtime!.chatResponse = { text: JSON.stringify(snapshot.plan), capturedAt: now }; }
    unobserve = observePetStoryTasks(); useTaskStore.setState({ tasks: [...tasks] });
    await vi.waitFor((): void => expect(usePetStoryStore.getState().busy).toBe(false));
    expect(collectChat).toHaveBeenCalledExactlyOnceWith(project.id, repair.id);
    expect(project.jobs.find((job): boolean => job.id === ordinary.id)?.status).toBe('bound');
    expect(project.chatAdjustment?.status).toBe('active');
  });

  it.each(['queued', 'submission_uncertain'] as const)('再次收取父回复连接已有%s修订，不新建子任务或重发已提交请求', async (state): Promise<void> => {
    const parent = installJob('analysis'); const repair = installJob('repair', { parentJobId: parent.id, repairMode: 'automatic' });
    const task = tasks[1];
    if (state === 'submission_uncertain') { task.status = 'paused'; task.runtime!.submittedAt = now; task.errorInfo = { code: 'submission_uncertain', message: 'TEST 原提交不明', recoverable: false, detectedAt: now }; }
    usePetStoryStore.setState({ project });
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => ({ ...saveCollected(jobId, false), repairJobId: repair.id }));
    await usePetStoryStore.getState().collect(parent.id);
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(project.jobs).toHaveLength(2);
    if (state === 'queued') expect(startAutomation).toHaveBeenCalledExactlyOnceWith(repair.taskId, expect.any(Function));
    else { expect(startAutomation).not.toHaveBeenCalled(); expect(task.runtime!.submittedAt).toBe(now); expect(task.status).toBe('paused'); }
  });

  it('父回复恢复时修订已完成，busy期间的完成事件无需再次发生也能收取原修订', async (): Promise<void> => {
    vi.useFakeTimers();
    const parent = installJob('analysis'); const repair = installJob('repair', { parentJobId: parent.id, repairMode: 'automatic' });
    const task = tasks[1]; task.status = 'done'; task.runtime!.submittedAt = now; task.runtime!.chatResponse = { text: JSON.stringify(snapshot.plan), capturedAt: now };
    usePetStoryStore.setState({ project }); unobserve = observePetStoryTasks();
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => ({ ...saveCollected(jobId, false), repairJobId: repair.id }));
    await usePetStoryStore.getState().collect(parent.id); await vi.advanceTimersByTimeAsync(1200);
    expect(collectChat.mock.calls).toEqual([[project.id, parent.id], [project.id, repair.id]]);
    expect(project.jobs.find((job): boolean => job.id === repair.id)?.status).toBe('applied');
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
  });

  it.each(['source', 'repair'] as const)('已结束%s等待的记录可读但不重新启动或安排修订', async (ended): Promise<void> => {
    const parent = installJob('analysis');
    if (ended === 'source') parent.endedWaitingAt = now;
    else installJob('repair', { parentJobId: parent.id, repairMode: 'automatic' }).endedWaitingAt = now;
    usePetStoryStore.setState({ project });
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => saveCollected(jobId, false));
    await usePetStoryStore.getState().collect(parent.id);
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
    expect(project.jobs).toHaveLength(ended === 'source' ? 1 : 2);
  });

  it.each([
    ['adjustment', false], ['adjustment', true], ['waiting', false], ['waiting', true], ['batch', false], ['batch', true]] as const)('结束%s时暂停原修订控制器，保留已提交=%s的原事实且不重发', async (action, submitted): Promise<void> => {
    if (action === 'adjustment') {
      installAdjustment();
      previewReply.mockResolvedValueOnce({ success: false, project, needsRepair: true, error: 'TEST 选定回复需要修订' });
      await usePetStoryStore.getState().applyChatReply('TEST-selected');
    } else {
      if (action === 'batch') await usePetStoryStore.getState().regenerateAllPrompts();
      else await usePetStoryStore.getState().analyze();
      collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => saveCollected(jobId, false));
      await usePetStoryStore.getState().collect(project.jobs[0].id);
    }
    const repair = project.jobs.at(-1)!; const task = tasks.find((item): boolean => item.id === repair.taskId)!;
    if (submitted) { task.runtime!.submittedAt = now; task.status = 'generating'; }
    useTaskStore.setState({ tasks });
    const runtime = structuredClone(task.runtime); const jobsBefore = project.jobs.length; const startsBefore = startAutomation.mock.calls.length; const requestsBefore = prepareRuntime.mock.calls.length;
    const events = vi.spyOn(window, 'dispatchEvent');
    if (action === 'adjustment') await usePetStoryStore.getState().endChatAdjustment();
    else if (action === 'waiting') await usePetStoryStore.getState().endChatWaiting(repair.id);
    else await usePetStoryStore.getState().stopPromptBatch();
    const cancellation = events.mock.calls.map((call): Event => call[0]).filter((event): boolean => event.type === 'cancel-task-automation');
    if (action === 'batch' && submitted) expect(cancellation).toHaveLength(0);
    else expect(cancellation).toEqual([expect.objectContaining({ detail: { taskId: repair.taskId, targetStatus: 'paused' } })]);
    expect(task.runtime).toEqual(runtime); expect(project.jobs).toHaveLength(jobsBefore); expect(startAutomation).toHaveBeenCalledTimes(startsBefore); expect(prepareRuntime).toHaveBeenCalledTimes(requestsBefore);
    if (action === 'adjustment') expect(project.chatAdjustment?.status).toBe('ended');
    else if (action === 'waiting') expect(project.jobs.find((job): boolean => job.id === repair.id)?.endedWaitingAt).toBe(now);
    else expect(project.promptBatch?.status).toBe('paused');
  });

  it('收取旧父回复发现修订已是合格候选，交接待确认并在采用后只完成原目标一次', async (): Promise<void> => {
    await usePetStoryStore.getState().regenerateAllPrompts(); const parent = project.jobs[0];
    const repair = installJob('repair', { parentJobId: parent.id, shotId: parent.shotId, promptKind: parent.promptKind, repairMode: 'automatic' });
    saveCollected(repair.id, true, true); usePetStoryStore.setState({ project });
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => ({ ...saveCollected(jobId, false), repairJobId: repair.id }));
    const startsBefore = startAutomation.mock.calls.length;
    await usePetStoryStore.getState().collect(parent.id);
    expect(project.promptBatch).toMatchObject({ jobId: repair.id, status: 'paused', completed: 0 });
    expect(startAutomation).toHaveBeenCalledTimes(startsBefore); expect(prepareRuntime).toHaveBeenCalledTimes(1); expect(usePetStoryStore.getState().error).toBe('');
    await usePetStoryStore.getState().adoptPromptCandidate(repair.id);
    expect(project.promptBatch).toMatchObject({ status: 'running', completed: 1 });
    expect(prepareRuntime).toHaveBeenCalledTimes(2); expect(project.jobs.at(-1)).toMatchObject({ kind: 'optimize', shotId: parent.shotId, promptKind: 'video' });
    await usePetStoryStore.getState().adoptPromptCandidate(repair.id);
    expect(project.promptBatch?.completed).toBe(1); expect(prepareRuntime).toHaveBeenCalledTimes(2); expect(project.jobs[0].status).toBe('invalid');
  });
});
