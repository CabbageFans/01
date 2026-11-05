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
function saveRepairableFailure(jobId: string): PetStoryResult {
  const result = saveCollected(jobId, false); const job = project.jobs.find((item): boolean => item.id === jobId)!;
  job.parsedResult = { optimized: 'TEST 本轮完整但未通过校验的正文' };
  job.validationDetails = [{ code: 'prompt_content', path: '$.optimized', actualType: 'string', expected: 'TEST 本轮完整约束', repairable: true, message: 'TEST 修正本轮引用或台词格式' }];
  return result;
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
    markCanvasChat: async (_id: string, _revision: number, jobId: string): Promise<PetStoryResult> => {
      project = structuredClone(project); project.revision++; project.jobs.find((job): boolean => job.id === jobId)!.background = 'canvas'; return { success: true, project };
    },
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
  it.each([false, true])('验证暂停保留文字批次接续；用户明确停止=%s时验证就绪不能复活后续发送', async (userStopped: boolean): Promise<void> => {
    await usePetStoryStore.getState().regenerateAllPrompts(); const job = project.jobs[0]; const task = tasks[0];
    task.status = 'waiting_verification'; task.runtime!.stage = 'waiting_verification'; task.runtime!.submittedAt = now;
    task.errorInfo = { code: 'human_verification', message: 'TEST 人机验证等待', detectedAt: now, recoverable: true };
    unobserve = observePetStoryTasks(); useTaskStore.setState({ tasks: structuredClone(tasks) });
    await vi.waitFor((): void => { expect(project.promptBatch?.status).toBe('paused'); expect(usePetStoryStore.getState().busy).toBe(false); });
    if (userStopped) await usePetStoryStore.getState().stopPromptBatch();
    const checkedAt = new Date().toISOString();
    const account = useAccountStore.getState().accounts[0];
    useAccountStore.setState({ accounts: [{ ...account, health: { loginState: 'ok', verificationRequired: false, consecutiveFailures: 0, successCount: 0, failureCount: 0,
      availability: { state: 'ready', reason: 'ready', message: 'TEST', source: 'manual', checkedAt } } }] });
    task.status = 'manual_submission_observing'; task.runtime!.stage = 'manual_submission_observing';
    useTaskStore.setState({ tasks: structuredClone(tasks) });
    window.dispatchEvent(new CustomEvent('task-verification-recovery-started', { detail: { taskId: task.id, accountId: account.id, runId: task.runtime!.runId, submittedAt: now, verificationCheckedAt: checkedAt } }));
    if (!userStopped) await vi.waitFor((): void => { expect(project.promptBatch?.status).toBe('running'); expect(usePetStoryStore.getState().busy).toBe(false); });
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => saveCollected(jobId, true, true));
    task.status = 'done'; task.runtime!.chatResponse = { text: 'TEST 原结果', capturedAt: now };
    useTaskStore.setState({ tasks: structuredClone(tasks) });
    if (userStopped) {
      expect(project.promptBatch?.status).toBe('paused'); expect(collectChat).not.toHaveBeenCalled(); expect(prepareRuntime).toHaveBeenCalledTimes(1);
    } else {
      await vi.waitFor((): void => { expect(project.promptBatch?.completed).toBe(1); expect(usePetStoryStore.getState().busy).toBe(false); });
      expect(project.promptBatch?.candidateJobIds).toEqual([job.id]); expect(prepareRuntime).toHaveBeenCalledTimes(2);
    }
    expect(startAutomation.mock.calls.filter(([id]): boolean => id === task.id)).toHaveLength(1);
  });

  it('一次开始后观察器连续处理三轮失败，直至合格候选才推进且不自动采用', async (): Promise<void> => {
    const preserved = structuredClone(project.plan); let received = 0;
    collectChat.mockImplementation(async (_id: string, jobId: string): Promise<PetStoryResult> => ++received <= 3 ? saveRepairableFailure(jobId) : saveCollected(jobId, true, true));
    usePetStoryStore.setState({ autoRepair: false });
    await usePetStoryStore.getState().regenerateAllPrompts();
    unobserve = observePetStoryTasks();
    for (let round = 0; round < 4; round++) {
      const job = project.jobs.at(-1)!; const task = tasks.find((item): boolean => item.id === job.taskId)!;
      task.status = 'done'; task.runtime!.chatResponse = { text: 'TEST 本轮平台原回复', capturedAt: now };
      useTaskStore.setState({ tasks: structuredClone(tasks) });
      await vi.waitFor((): void => { expect(collectChat).toHaveBeenCalledTimes(round + 1); expect(usePetStoryStore.getState().busy).toBe(false); });
      expect(project.jobs).toHaveLength(round + 2);
      expect(usePetStoryStore.getState().error).toBe('');
      expect(usePetStoryStore.getState().promptRepairJobIds).toEqual([]);
    }
    expect(project.jobs.slice(0, 3).every((job): boolean => job.status === 'invalid' && !!job.rawText)).toBe(true);
    expect(project.jobs[3]).toMatchObject({ status: 'applied', resultStatus: 'candidate', parentJobId: project.jobs[2].id });
    expect(project.promptBatch).toMatchObject({ completed: 1, candidateJobIds: [project.jobs[3].id], status: 'running' });
    expect(project.plan).toEqual(preserved); expect(adoptPrompt).not.toHaveBeenCalled();
  });

  it('视频点击自动接续最新失败修订，不重新创建原目标或提前创建视频', async (): Promise<void> => {
    const shot = project.plan!.shots[0]; shot.prompts.video.final = '';
    const parent = installJob('optimize', { shotId: shot.id, promptKind: 'video', background: 'canvas' }); saveRepairableFailure(parent.id);
    const failed = installJob('repair', { shotId: shot.id, promptKind: 'video', parentJobId: parent.id, repairMode: 'automatic' }); saveRepairableFailure(failed.id);
    project.promptBatch = { scope: 'shots', total: 1, completed: 0, status: 'paused', jobId: failed.id, targets: [{ shotId: shot.id, kind: 'video' }] };
    const media = vi.fn(); Object.assign(window.electronAPI.petstory, { generateShotMedia: media });
    collectChat.mockImplementation(async (_id: string, jobId: string): Promise<PetStoryResult> => saveRepairableFailure(jobId));
    usePetStoryStore.setState({ project, error: '镜头或最终提示词不存在' });
    await usePetStoryStore.getState().generateShotMedia(shot.id, 'video');
    expect(collectChat).toHaveBeenCalledExactlyOnceWith(project.id, failed.id);
    expect(prepareRuntime).toHaveBeenCalledExactlyOnceWith(project.id, expect.any(Number), 'repair', { parentJobId: failed.id, repairMode: 'automatic' });
    expect(media).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().error).toBe('');
    expect(project.plan!.shots[0].prompts.video.final).toBe('');
  });

  it('视频已有合格未采用候选时等待确认，不再生成文字或视频', async (): Promise<void> => {
    const shot = project.plan!.shots[0]; shot.prompts.video.final = '';
    const job = installJob('optimize', { shotId: shot.id, promptKind: 'video' }); saveCollected(job.id, true, true);
    const media = vi.fn(); Object.assign(window.electronAPI.petstory, { generateShotMedia: media });
    usePetStoryStore.setState({ project }); await usePetStoryStore.getState().generateShotMedia(shot.id, 'video');
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(collectChat).not.toHaveBeenCalled(); expect(media).not.toHaveBeenCalled();
  });

  it('已有进行中制作时不因空正文绕进文字链，仍由原制作规则处理', async (): Promise<void> => {
    const shot = project.plan!.shots[0]; shot.prompts.video.final = '';
    const entry = { state: 'unknown' as const, reason: 'TEST 未检查' };
    project.production = { phase: 'shots', state: 'paused', planHash: 'TEST', approvedAt: now,
      capability: { accountId: project.accountId, checkedAt: now, durations: [5], image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry } },
      fallbacks: {}, shots: {}, steps: [], message: 'TEST 原制作暂停' };
    const media = vi.fn(async (): Promise<PetStoryResult> => ({ success: false, project, error: 'TEST 请先处理原制作任务' }));
    Object.assign(window.electronAPI.petstory, { generateShotMedia: media });
    usePetStoryStore.setState({ project }); await usePetStoryStore.getState().generateShotMedia(shot.id, 'video');
    expect(media).toHaveBeenCalledTimes(1); expect(prepareRuntime).not.toHaveBeenCalled(); expect(collectChat).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().error).toBe('TEST 请先处理原制作任务');
  });

  it('视频等待正文原运行时仅恢复观察，不新建修订或重发', async (): Promise<void> => {
    const shot = project.plan!.shots[0]; shot.prompts.video.final = '';
    const job = installJob('optimize', { shotId: shot.id, promptKind: 'video', background: 'canvas' }); const task = tasks[0];
    job.runId = task.runtime!.runId; task.status = 'paused'; task.runtime!.submittedAt = now;
    task.errorInfo = { code: 'submission_uncertain', message: 'TEST 原受理未明', recoverable: true, detectedAt: now };
    useTaskStore.setState({ updateTaskRuntime: vi.fn(async (): Promise<boolean> => true) });
    const dispatch = vi.spyOn(window, 'dispatchEvent'); usePetStoryStore.setState({ project });
    await usePetStoryStore.getState().generateShotMedia(shot.id, 'video');
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled(); expect(retryUnsubmitted).not.toHaveBeenCalled();
    expect(dispatch.mock.calls.some(([event]): boolean => event.type === 'reconcile-task-submission')).toBe(true);
    expect(task.runtime!.submittedAt).toBe(now);
  });

  it('本镜缺正文且未生成时后台创建原文字任务，归属异常则停止', async (): Promise<void> => {
    const shot = project.plan!.shots[0]; shot.prompts.video.final = '';
    usePetStoryStore.setState({ project }); await usePetStoryStore.getState().generateShotMedia(shot.id, 'video');
    expect(prepareRuntime).toHaveBeenCalledExactlyOnceWith(project.id, expect.any(Number), 'optimize', { shotId: shot.id, promptKind: 'video', background: 'canvas' });
    const job = project.jobs.at(-1)!; job.status = 'invalid'; job.rawText = 'TEST 归属不符回复'; job.error = 'TEST requestId不符';
    usePetStoryStore.setState({ project }); await usePetStoryStore.getState().generateShotMedia(shot.id, 'video');
    expect(prepareRuntime).toHaveBeenCalledTimes(1); expect(collectChat).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().error).toBe(job.error);
  });

  it('显式改镜长后仍有旧正文时，生成视频沿原入口准备新正文并保留旧final，不提前发媒体', async (): Promise<void> => {
    const shot = project.plan!.shots[0]; const oldBody = shot.prompts.video.final;
    shot.durationSeconds = 8; shot.prompts.video.timingStale = true;
    shot.prompts.video.promptTask = { visualPolicy: 'reference-first-v1', references: [], dialect: 'seedance20' };
    const media = vi.fn(); Object.assign(window.electronAPI.petstory, { generateShotMedia: media });
    usePetStoryStore.setState({ project }); await usePetStoryStore.getState().generateShotMedia(shot.id, 'video');
    expect(prepareRuntime).toHaveBeenCalledExactlyOnceWith(project.id, expect.any(Number), 'optimize', { shotId: shot.id, promptKind: 'video', background: 'canvas' });
    expect(media).not.toHaveBeenCalled(); expect(project.plan!.shots[0].prompts.video.final).toBe(oldBody);
    expect(project.plan!.shots[0].prompts.video.timingStale).toBe(true); expect(tasks.every((task): boolean => task.mode === 'chat')).toBe(true);
  });

  it('单镜修订准备期间停止，保留新hold任务但不启动下一轮', async (): Promise<void> => {
    const shot = project.plan!.shots[0]; shot.prompts.video.final = '';
    const parent = installJob('optimize', { shotId: shot.id, promptKind: 'video', background: 'canvas' }); saveRepairableFailure(parent.id);
    const prepare = prepareRuntime.getMockImplementation()!; let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve): void => { release = resolve; });
    prepareRuntime.mockImplementationOnce(async (...args: Parameters<typeof prepare>): Promise<PetStoryResult> => { await pending; return prepare(...args); });
    collectChat.mockImplementation(async (_id: string, jobId: string): Promise<PetStoryResult> => saveRepairableFailure(jobId));
    usePetStoryStore.setState({ project }); const preparing = usePetStoryStore.getState().generateShotMedia(shot.id, 'video');
    await vi.waitFor((): void => expect(prepareRuntime).toHaveBeenCalledTimes(1));
    expect(usePetStoryStore.getState().promptRepairJobIds).toEqual([parent.id]);
    await usePetStoryStore.getState().stopPromptBatch(); release?.(); await preparing;
    expect(project.jobs).toHaveLength(2); expect(project.jobs[1]).toMatchObject({ kind: 'repair', status: 'bound', parentJobId: parent.id });
    expect(startAutomation).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().promptRepairJobIds).toEqual([]);
  });

  it('继续旧失败批次时衔接原修订链，不另外优化相同目标', async (): Promise<void> => {
    const shot = project.plan!.shots[0]; const parent = installJob('optimize', { shotId: shot.id, promptKind: 'video', background: 'canvas' }); saveRepairableFailure(parent.id);
    const failed = installJob('repair', { shotId: shot.id, promptKind: 'video', parentJobId: parent.id }); saveRepairableFailure(failed.id);
    project.promptBatch = { scope: 'shots', total: 1, completed: 0, status: 'paused', jobId: parent.id, targets: [{ shotId: shot.id, kind: 'video' }] };
    promptStageTargets.mockImplementation(async (): Promise<PetStoryResult> => ({ success: true, project, promptTargets: project.promptBatch!.targets }));
    collectChat.mockImplementation(async (_id: string, jobId: string): Promise<PetStoryResult> => saveRepairableFailure(jobId));
    usePetStoryStore.setState({ project }); await usePetStoryStore.getState().generateCanvasPrompts();
    expect(collectChat).toHaveBeenCalledExactlyOnceWith(project.id, failed.id);
    expect(prepareRuntime).toHaveBeenCalledExactlyOnceWith(project.id, expect.any(Number), 'repair', { parentJobId: failed.id, repairMode: 'automatic' });
  });

  it('本批部分确认按动态镜头与种类汇总失败和成功数，详细原因进入现有日志且保留失败候选', async (): Promise<void> => {
    const shots = project.plan!.shots; const ids: string[] = [];
    for (const target of [{ shotId: shots[0].id, promptKind: 'firstFrame' as const }, { shotId: shots[1].id, promptKind: 'firstFrame' as const }, { shotId: shots[3].id, promptKind: 'firstFrame' as const }, { shotId: shots[3].id, promptKind: 'lastFrame' as const }]) {
      const job = installJob('optimize', target); job.status = 'applied'; job.resultStatus = 'candidate'; job.parsedResult = { optimized: 'TEST离线完整候选' }; ids.push(job.id);
    }
    project.promptBatch = { total: ids.length, completed: ids.length, status: 'complete', targets: [], candidateJobIds: ids };
    usePetStoryStore.setState({ project, promptBatch: { total: ids.length, completed: ids.length, status: 'complete' } });
    const detail = 'TEST原始合同校验原因'; const append = vi.fn<(entry: { message: string }) => Promise<void>>().mockResolvedValue(undefined);
    Object.assign(window.electronAPI, { logs: { append } });
    adoptPrompt.mockImplementation(async (_id: string, _revision: number, id: string): Promise<PetStoryResult> => {
      if (id !== ids[0]) return { success: false, project, error: detail };
      project = structuredClone(project); project.revision++; project.jobs.find((job): boolean => job.id === id)!.resultStatus = 'adopted'; return { success: true, project };
    });
    await usePetStoryStore.getState().adoptPromptBatchCandidates();
    expect(usePetStoryStore.getState().error).toBe(`已确认1项；镜头${shots[1].order}首帧、镜头${shots[3].order}首帧／尾帧需修改后确认。`);
    expect(usePetStoryStore.getState().error).not.toContain(detail); expect(append).toHaveBeenCalledTimes(3);
    expect(append.mock.calls.every((call): boolean => call[0].message === detail)).toBe(true);
    expect(project.jobs.filter((job): boolean => job.resultStatus === 'candidate')).toHaveLength(3);
  });

  it('打开项目等待任务列表时较新的资格结果不会被最初打开快照覆盖', async (): Promise<void> => {
    const shot = project.plan!.shots[0];
    project.promptBatch = { total: 2, completed: 0, status: 'paused', targets: [{ shotId: shot.id, kind: 'firstFrame' }, { shotId: shot.id, kind: 'video' }] };
    const corrected = structuredClone(project); corrected.revision++; corrected.promptBatch!.completed = 1; corrected.promptBatch!.targets.shift();
    window.electronAPI.tasks.list = async (): Promise<Task[]> => { usePetStoryStore.setState({ project: corrected, promptBatch: { total: 2, completed: 1, status: 'paused' } }); return tasks; };
    await usePetStoryStore.getState().openProject('/OFFLINE/原故事副本');
    expect(usePetStoryStore.getState().project?.revision).toBe(corrected.revision);
    expect(usePetStoryStore.getState().promptBatch).toEqual({ total: 2, completed: 1, status: 'paused' });
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
  });

  it('无运行队列时采用响应同步持久进度；恢复前发现合法候选已完成便不发送', async (): Promise<void> => {
    const shot = project.plan!.shots[0]; const job = installJob('optimize', { shotId: shot.id, promptKind: 'firstFrame', promptBatchId: 'TEST-counter' });
    saveCollected(job.id, true, true);
    project.promptBatch = { id: 'TEST-counter', scope: 'shots', targets: [{ shotId: shot.id, kind: 'firstFrame' }], failedTargets: [{ target: { shotId: shot.id, kind: 'firstFrame' }, message: 'TEST旧失败' }], total: 1, completed: 0, status: 'paused', candidateJobIds: [job.id] };
    usePetStoryStore.setState({ project, promptBatch: { total: 1, completed: 0, status: 'paused' } });
    adoptPrompt.mockImplementationOnce(async (): Promise<PetStoryResult> => {
      project = structuredClone(project); project.revision++; project.promptBatch = { ...project.promptBatch!, targets: [], failedTargets: [], completed: 1, status: 'complete' };
      return { success: true, project };
    });
    await usePetStoryStore.getState().adoptPromptCandidate(job.id);
    expect(usePetStoryStore.getState().promptBatch).toEqual({ total: 1, completed: 1, status: 'complete' });
    // 模拟重开的是旧计数，但主进程恢复前资格核对已结算现存合法候选。
    const old = structuredClone(project); old.promptBatch = { ...old.promptBatch!, targets: [{ shotId: shot.id, kind: 'firstFrame' }], completed: 0, status: 'paused' };
    usePetStoryStore.setState({ project: old, promptBatch: { total: 1, completed: 0, status: 'paused' } });
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [], pendingCandidateJobIds: [job.id] });
    await usePetStoryStore.getState().generateCanvasPrompts();
    expect(usePetStoryStore.getState().promptBatch).toEqual({ total: 1, completed: 1, status: 'complete' });
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled(); expect(tasks).toHaveLength(1);
  });

  it.each([false, true])('画布节点恢复明确标记后台并复用原任务：已提交=%s', async (submitted: boolean): Promise<void> => {
    const job = installJob('optimize', { shotId: project.plan!.shots[0].id, promptKind: 'firstFrame' }); const task = tasks[0]; job.runId = task.runtime!.runId;
    task.status = 'paused'; task.errorInfo = { code: submitted ? 'submission_uncertain' : 'page_loading', message: 'TEST原任务', recoverable: true, detectedAt: now };
    if (submitted) task.runtime!.submittedAt = now;
    usePetStoryStore.setState({ project });
    const events: string[] = [];
    window.addEventListener('reconcile-task-submission', ((event: CustomEvent<{ taskId: string }>): void => { events.push(event.detail.taskId); }) as EventListener);
    const update = vi.fn(async (): Promise<boolean> => true); useTaskStore.setState({ updateTaskRuntime: update });
    await usePetStoryStore.getState().resumeCanvasPrompt(job.id);
    expect(project.jobs).toHaveLength(1); expect(tasks).toHaveLength(1); expect(project.jobs[0].background).toBe('canvas');
    expect(prepareRuntime).not.toHaveBeenCalled();
    if (submitted) { expect(startAutomation).not.toHaveBeenCalled(); expect(retryUnsubmitted).not.toHaveBeenCalled(); expect(events).toEqual([task.id]); expect(task.runtime!.submittedAt).toBe(now); }
    else { expect(startAutomation).toHaveBeenCalledExactlyOnceWith(task.id, expect.any(Function)); expect(retryUnsubmitted).toHaveBeenCalledExactlyOnceWith(project.id, job.id); expect(events).toEqual([]); }
  });

  it('画布有可读失败正文且自动修订已失败时，按原要求修复不需要用户填写修改意见', async (): Promise<void> => {
    const target = { shotId: project.plan!.shots[0].id, promptKind: 'video' as const };
    const parent = installJob('optimize', target); saveCollected(parent.id, false);
    const automatic = installJob('repair', { ...target, parentJobId: parent.id, repairMode: 'automatic' }); saveCollected(automatic.id, false);
    const before = structuredClone(project.jobs); const adopted = structuredClone(project.plan);
    usePetStoryStore.setState({ project });

    await usePetStoryStore.getState().resumeCanvasPrompt(parent.id);

    expect(prepareRuntime).toHaveBeenCalledExactlyOnceWith(project.id, expect.any(Number), 'repair', { parentJobId: automatic.id, repairMode: 'explicit' });
    expect(project.jobs).toHaveLength(3);
    expect(project.jobs[2]).toMatchObject({ ...target, kind: 'repair', parentJobId: automatic.id, repairMode: 'explicit' });
    expect(project.jobs[2].promptFeedback).toBeUndefined();
    expect(startAutomation).toHaveBeenCalledExactlyOnceWith(project.jobs[2].taskId, expect.any(Function));
    expect(project.jobs.slice(0, 2).map((job): unknown => ({ rawText: job.rawText, validationIssues: job.validationIssues, error: job.error })))
      .toEqual(before.map((job): unknown => ({ rawText: job.rawText, validationIssues: job.validationIssues, error: job.error })));
    expect(project.plan).toEqual(adopted); expect(usePetStoryStore.getState().error).toBe('');
  });

  it.each([false, true])('画布原要求修复入口复用已有修订子任务，已提交=%s时不另建或重发', async (submitted: boolean): Promise<void> => {
    const target = { shotId: project.plan!.shots[0].id, promptKind: 'video' as const };
    const parent = installJob('optimize', target); saveCollected(parent.id, false);
    const repair = installJob('repair', { ...target, parentJobId: parent.id, repairMode: 'explicit' }); const task = tasks[1]; repair.runId = task.runtime!.runId;
    if (submitted) { task.status = 'paused'; task.runtime!.submittedAt = now; task.errorInfo = { code: 'submission_uncertain', message: 'TEST 原受理不明', recoverable: true, detectedAt: now }; }
    const events: string[] = [];
    window.addEventListener('reconcile-task-submission', ((event: CustomEvent<{ taskId: string }>): void => { events.push(event.detail.taskId); }) as EventListener);
    useTaskStore.setState({ updateTaskRuntime: vi.fn(async (): Promise<boolean> => true) });
    usePetStoryStore.setState({ project });

    await usePetStoryStore.getState().resumeCanvasPrompt(parent.id);

    expect(project.jobs).toHaveLength(2); expect(tasks).toHaveLength(2); expect(prepareRuntime).not.toHaveBeenCalled();
    expect(project.jobs[1].background).toBe('canvas');
    if (submitted) {
      expect(startAutomation).not.toHaveBeenCalled(); expect(retryUnsubmitted).not.toHaveBeenCalled(); expect(events).toEqual([task.id]);
      expect(task.runtime!.submittedAt).toBe(now); expect(task.runtime!.runId).toBe(repair.runId);
    } else { expect(startAutomation).toHaveBeenCalledExactlyOnceWith(task.id, expect.any(Function)); expect(events).toEqual([]); }
  });

  it('画布原要求修复在保存归属期间连点只创建并启动一次修订', async (): Promise<void> => {
    const parent = installJob('optimize', { shotId: project.plan!.shots[0].id, promptKind: 'video' }); saveCollected(parent.id, false);
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve): void => { release = resolve; });
    const originalMark = window.electronAPI.petstory.markCanvasChat; const mark = vi.spyOn(window.electronAPI.petstory, 'markCanvasChat');
    mark.mockImplementationOnce(async (...args: Parameters<typeof originalMark>): Promise<PetStoryResult> => { await pending; return originalMark(...args); });
    usePetStoryStore.setState({ project });

    const first = usePetStoryStore.getState().resumeCanvasPrompt(parent.id);
    await usePetStoryStore.getState().resumeCanvasPrompt(parent.id);
    expect(mark).toHaveBeenCalledTimes(1); expect(prepareRuntime).not.toHaveBeenCalled();
    release?.(); await first;

    expect(prepareRuntime).toHaveBeenCalledTimes(1); expect(startAutomation).toHaveBeenCalledTimes(1);
    expect(project.jobs).toHaveLength(2); expect(usePetStoryStore.getState().busy).toBe(false);
  });

  it('已有修订的画布归属保存失败时不继续恢复或发送', async (): Promise<void> => {
    const target = { shotId: project.plan!.shots[0].id, promptKind: 'video' as const };
    const parent = installJob('optimize', target); saveCollected(parent.id, false);
    installJob('repair', { ...target, parentJobId: parent.id, repairMode: 'explicit' });
    const originalMark = window.electronAPI.petstory.markCanvasChat; const mark = vi.spyOn(window.electronAPI.petstory, 'markCanvasChat');
    mark.mockImplementationOnce(originalMark).mockResolvedValueOnce({ success: false, project, error: 'TEST 画布归属未保存' });
    usePetStoryStore.setState({ project });

    await usePetStoryStore.getState().resumeCanvasPrompt(parent.id);

    expect(mark).toHaveBeenCalledTimes(2); expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
    expect(retryUnsubmitted).not.toHaveBeenCalled(); expect(project.jobs).toHaveLength(2); expect(usePetStoryStore.getState().error).toBe('TEST 画布归属未保存');
  });

  it('画布恢复已保存批次时优先接回后续未决原任务，不另建旧失败队首或重复请求', async (): Promise<void> => {
    const failed = installJob('optimize', { shotId: project.plan!.shots[0].id, promptKind: 'firstFrame' }); failed.status = 'invalid'; failed.rawText = 'TEST原失败回复';
    const pending = installJob('optimize', { shotId: project.plan!.shots[1].id, promptKind: 'firstFrame' }); pending.runId = tasks[1].runtime!.runId;
    tasks[1].status = 'paused'; tasks[1].errorInfo = { code: 'page_loading', message: 'TEST尚未发送', recoverable: true, detectedAt: now };
    project.promptBatch = { targets: [{ shotId: failed.shotId!, kind: 'firstFrame' }, { shotId: pending.shotId!, kind: 'firstFrame' }], total: 2, completed: 0, status: 'paused', jobId: failed.id };
    usePetStoryStore.setState({ project });
    await usePetStoryStore.getState().generateCanvasPrompts();
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(project.jobs).toHaveLength(2); expect(tasks).toHaveLength(2);
    expect(startAutomation).toHaveBeenCalledExactlyOnceWith(pending.taskId, expect.any(Function));
    expect(project.promptBatch).toMatchObject({ scope: 'shots', status: 'running', jobId: pending.id, completed: 0 });
    expect(project.promptBatch!.targets.map((target): string | undefined => target.shotId)).toEqual([pending.shotId, failed.shotId]);
    expect(project.jobs[0].rawText).toBe('TEST原失败回复');
  });

  it('画布一次生成连续保存候选，进度按保存推进，重复入口不创建任务且本批确认不波及历史', async (): Promise<void> => {
    const firstShot = project.plan!.shots[0]; const before = structuredClone(project.plan);
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [{ shotId: firstShot.id, kind: 'firstFrame' }, { shotId: firstShot.id, kind: 'video' }] });
    await usePetStoryStore.getState().generateCanvasPrompts(); const first = project.jobs[0];
    await usePetStoryStore.getState().generateCanvasPrompts(); expect(prepareRuntime).toHaveBeenCalledTimes(1);
    collectChat.mockImplementationOnce(async (_id: string, id: string): Promise<PetStoryResult> => saveCollected(id, true, true));
    await usePetStoryStore.getState().collect(first.id); const second = project.jobs[1];
    expect(second).toMatchObject({ background: 'canvas', promptBatchId: first.promptBatchId, textContextJobIds: [first.id], promptKind: 'video' });
    expect(project.promptBatch).toMatchObject({ completed: 1, total: 2, status: 'running', candidateJobIds: [first.id] });
    collectChat.mockImplementationOnce(async (_id: string, id: string): Promise<PetStoryResult> => saveCollected(id, true, true));
    await usePetStoryStore.getState().collect(second.id);
    expect(project.promptBatch).toMatchObject({ completed: 2, total: 2, status: 'complete', candidateJobIds: [first.id, second.id], targets: [] });
    expect(project.plan).toEqual(before); expect(adoptPrompt).not.toHaveBeenCalled();
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [], pendingCandidateJobIds: [first.id, second.id] });
    await usePetStoryStore.getState().generateCanvasPrompts();
    expect(prepareRuntime).toHaveBeenCalledTimes(2); expect(project.promptBatch?.candidateJobIds).toEqual([first.id, second.id]);
    project.promptBatch!.candidateJobIds = [second.id, first.id]; // 反馈回填可能把上游候选放到末尾，确认仍按真实依赖顺序。
    const historical = installJob('optimize', { shotId: project.plan!.shots[1].id, promptKind: 'firstFrame' }); historical.status = 'applied'; historical.resultStatus = 'candidate'; historical.parsedResult = { optimized: 'TEST历史候选' };
    usePetStoryStore.setState({ project });
    await usePetStoryStore.getState().adoptPromptBatchCandidates();
    expect(adoptPrompt.mock.calls.map((call): string => call[2])).toEqual([first.id, second.id]);
    expect(project.jobs.find((job): boolean => job.id === historical.id)?.resultStatus).toBe('candidate');
  });

  it('画布单项明确失败保留候选及原回复，跳过其依赖并继续独立镜头', async (): Promise<void> => {
    const [first, second] = project.plan!.shots; second.transition = 'cut';
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [{ shotId: first.id, kind: 'firstFrame' }, { shotId: first.id, kind: 'video' }, { shotId: second.id, kind: 'firstFrame' }] });
    await usePetStoryStore.getState().generateCanvasPrompts(); const failed = project.jobs[0];
    collectChat.mockImplementationOnce(async (_id: string, id: string): Promise<PetStoryResult> => ({ ...saveCollected(id, false), needsRepair: false }));
    await usePetStoryStore.getState().collect(failed.id);
    expect(project.jobs.at(-1)).toMatchObject({ shotId: second.id, promptKind: 'firstFrame' });
    expect(project.jobs).toHaveLength(2); expect(project.jobs[0].rawText).toBeTruthy();
    collectChat.mockImplementationOnce(async (_id: string, id: string): Promise<PetStoryResult> => saveCollected(id, true, true));
    await usePetStoryStore.getState().collect(project.jobs.at(-1)!.id);
    expect(project.promptBatch).toMatchObject({ total: 3, completed: 1, status: 'paused', failedTargets: [expect.objectContaining({ jobId: failed.id }), expect.objectContaining({ message: '等待前序提示词完成后继续' })] });
    expect(project.promptBatch?.targets).toHaveLength(2); expect(adoptPrompt).not.toHaveBeenCalled();
  });

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

  it('修订合格保存候选即继续原批次，确认采用不会再次结算目标', async (): Promise<void> => {
    const preserved = structuredClone(project.plan);
    await usePetStoryStore.getState().regenerateAllPrompts(); const parent = project.jobs[0];
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => saveCollected(jobId, false));
    await usePetStoryStore.getState().collect(parent.id);
    const repair = project.jobs[1];
    expect(project.promptBatch).toMatchObject({ completed: 0, jobId: repair.id, status: 'running' });
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => saveCollected(jobId, true, true));
    await usePetStoryStore.getState().collect(repair.id);
    expect(project.promptBatch).toMatchObject({ completed: 1, candidateJobIds: [repair.id], status: 'running' });
    expect(prepareRuntime).toHaveBeenCalledTimes(3); expect(project.plan).toEqual(preserved);
    await usePetStoryStore.getState().adoptPromptCandidate(repair.id);
    expect(prepareRuntime).toHaveBeenCalledTimes(3);
    expect(project.jobs.at(-1)).toMatchObject({ kind: 'optimize', shotId: parent.shotId, promptKind: 'video' });
    expect(project.promptBatch).toMatchObject({ completed: 1, status: 'running' });
    await usePetStoryStore.getState().adoptPromptCandidate(repair.id);
    expect(prepareRuntime).toHaveBeenCalledTimes(3); expect(project.promptBatch?.completed).toBe(1);
    expect(project.jobs[0]).toMatchObject({ id: parent.id, status: 'invalid', error: 'TEST 原回复时长不符合当前项目约束' });
  });

  it('后台重校验直接接纳同一原回复，批次结算候选且不重发原任务', async (): Promise<void> => {
    const preserved = structuredClone(project.plan);
    await usePetStoryStore.getState().regenerateAllPrompts(); const parent = project.jobs[0];
    const originalTask = tasks[0]; originalTask.status = 'done'; originalTask.runtime!.submittedAt = now;
    originalTask.runtime!.chatResponse = { text: 'TEST 已保存的合格原回复', capturedAt: now };
    const taskSnapshot = structuredClone(originalTask);
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => saveRepairableFailure(jobId));
    prepareRuntime.mockImplementationOnce(async (): Promise<PetStoryResult> => ({ ...saveCollected(parent.id, true, true), taskId: parent.taskId, repairJobId: parent.id, repairSourceJobId: parent.id }));
    await usePetStoryStore.getState().collect(parent.id);
    expect(project.promptBatch).toMatchObject({ completed: 1, candidateJobIds: [parent.id], failedTargets: [], status: 'running' });
    expect(project.jobs[0]).toMatchObject({ id: parent.id, status: 'applied', resultStatus: 'candidate' });
    expect(project.jobs).toHaveLength(2); // 后续目标正常推进，未给原回复创建修订子任务。
    expect(project.jobs[1]).toMatchObject({ kind: 'optimize', promptKind: 'video' });
    expect(project.jobs.some((job): boolean => job.kind === 'repair')).toBe(false);
    expect(startAutomation.mock.calls.filter(([taskId]): boolean => taskId === parent.taskId)).toHaveLength(1);
    expect(tasks[0]).toEqual(taskSnapshot); expect(project.plan).toEqual(preserved);
    expect(adoptPrompt).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().error).toBe('');
    expect(usePetStoryStore.getState().promptRepairJobIds).toEqual([]);
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

  it('方案分析也不再按修订次数停止，主进程判可修复就连续处理到合格', async (): Promise<void> => {
    await usePetStoryStore.getState().analyze();
    for (let round = 0; round < 3; round++) {
      collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => saveCollected(jobId, false));
      await usePetStoryStore.getState().collect(project.jobs.at(-1)!.id);
      expect(project.jobs).toHaveLength(round + 2); expect(usePetStoryStore.getState().error).toBe('');
    }
    const last = project.jobs.at(-1)!;
    await usePetStoryStore.getState().collect(last.id);
    expect(project.jobs).toHaveLength(4); expect(project.jobs[3].status).toBe('applied');
    expect(project.jobs.slice(0, 3).every((job): boolean => !!job.rawText && job.status === 'invalid')).toBe(true);
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

  it('收取旧父回复发现修订已是合格候选，保留待确认并立即推进一次', async (): Promise<void> => {
    await usePetStoryStore.getState().regenerateAllPrompts(); const parent = project.jobs[0];
    const repair = installJob('repair', { parentJobId: parent.id, shotId: parent.shotId, promptKind: parent.promptKind, repairMode: 'automatic' });
    saveCollected(repair.id, true, true); usePetStoryStore.setState({ project });
    collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => ({ ...saveCollected(jobId, false), repairJobId: repair.id }));
    const startsBefore = startAutomation.mock.calls.length;
    await usePetStoryStore.getState().collect(parent.id);
    expect(project.promptBatch).toMatchObject({ candidateJobIds: [repair.id], status: 'running', completed: 1 });
    expect(startAutomation).toHaveBeenCalledTimes(startsBefore + 1); expect(prepareRuntime).toHaveBeenCalledTimes(2); expect(usePetStoryStore.getState().error).toBe('');
    await usePetStoryStore.getState().adoptPromptCandidate(repair.id);
    expect(project.promptBatch).toMatchObject({ status: 'running', completed: 1 });
    expect(prepareRuntime).toHaveBeenCalledTimes(2); expect(project.jobs.at(-1)).toMatchObject({ kind: 'optimize', shotId: parent.shotId, promptKind: 'video' });
    await usePetStoryStore.getState().adoptPromptCandidate(repair.id);
    expect(project.promptBatch?.completed).toBe(1); expect(prepareRuntime).toHaveBeenCalledTimes(2); expect(project.jobs[0].status).toBe('invalid');
  });
});
