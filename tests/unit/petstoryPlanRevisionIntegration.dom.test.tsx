/** 正式 Service→磁盘→Store→UI 的离线回归；结构夹具不代表真实平台生成验收。 */
import React from 'react';
import { currentRunId } from '../fixtures/taskRunIdentity';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryChatJob, PetStoryPlan, PetStoryProject, PetStoryResult, Task, TaskAddParams, TaskUpdateRuntimeParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { PetStoryChatService } from '../../main/utils/petstoryChat';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { storyHash, syncMaterials } from '../../main/utils/petstoryMaterials';
import { PetStoryPlanReview } from '../../src/components/PetStoryPlanReview';
import { observePetStoryTasks, usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import { withOfflineTimingPlan } from '../fixtures/petstoryTimingPlan';
import { automationEngine } from '../../src/automation/AutomationEngine';

const initial = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState(), projects: useProjectStore.getState() };
const originalText = 'TEST 完整原剧本。TEST角色说：“TEST原台词逐字保留”。TEST完整结局。';
let directory: string;
let projects: PetStoryProjects;
let service: PetStoryChatService;
let core: TaskService;
let tasks: Task[];
let unobserve: (() => void) | undefined;

function currentProject(): PetStoryProject { return usePetStoryStore.getState().project!; }
function listedTasks(): Task[] { return structuredClone(tasks); }
function originalPlan(): PetStoryPlan {
  const prompt = { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST' };
  return withOfflineTimingPlan({ sourceSummary: 'TEST 原剧本摘要', adaptedStory: 'TEST 原剧本正文与逐字台词', understanding: 'TEST 完整理解', sceneDesign: 'TEST 完整空间',
    characters: [{ id: 'actor', name: 'TEST角色', role: 'main', purpose: 'TEST剧情职责', description: 'TEST剧本设定', continuity: 'TEST连续性', aliases: ['TEST角色'], designOrigin: 'script' }], props: [],
    scenes: [{ id: 'location', name: 'TEST地点', location: 'TEST地点', time: 'TEST时间', lighting: 'TEST光线', layout: 'TEST空间锚点', view: 'TEST视角', designOrigin: 'script' }],
    shots: ['sh01', 'sh02', 'sh03', 'sh04', 'sh07'].map((id: string, index: number): PetStoryPlan['shots'][number] => ({ id, order: index + 1, characterIds: ['actor'], propIds: [], propStates: [], sceneId: 'location', scene: 'TEST地点',
      action: `TEST动作${index + 1}`, startState: `TEST开始${index + 1}`, endState: `TEST结束${index + 1}`, durationSeconds: 5, transition: 'cut', requestedMode: 'reference', camera: 'TEST原机位',
      dialogue: index === 0 ? [{ speakerId: 'actor', text: 'TEST原台词逐字保留', tone: 'TEST语气', pace: 'TEST语速' }] : [], prompts: { firstFrame: { ...prompt }, video: { ...prompt } } })) }, originalText);
}
const View: React.FC = (): React.ReactElement => {
  const project = usePetStoryStore((state) => state.project)!;
  return <PetStoryPlanReview project={project} disabled={false} />;
};

async function completeReply(plan: PetStoryPlan, expectedStatus: 'applied' | 'invalid' = 'applied'): Promise<void> {
  const job = currentProject().jobs.at(-1)!;
  const task = tasks.find((item: Task): boolean => item.id === job.taskId)!;
  const now = new Date().toISOString();
  const answer = { ...plan, requestId: job.requestId, targetIds: job.expectedIds, storyUsable: true,
    contentBasis: { beginning: 'TEST开头', middle: 'TEST变化', ending: 'TEST结局' },
    shots: plan.shots.map(({ prompts: _prompts, ...shot }): object => { void _prompts; return shot; }) };
  const saved = core.updateRuntime({ taskId: task.id, expectedRunId: currentRunId(core, task.id), status: 'done', errorInfo: null,
    runtime: { ...task.runtime!, stage: 'completed', submittedAt: now, chatResponse: { text: JSON.stringify(answer), capturedAt: now } } });
  if (!saved.success) throw new Error(saved.error);
  await automationEngine.release(task.id);
  await act(async (): Promise<void> => { useTaskStore.setState({ tasks: listedTasks(), accountBusy: {}, executingTasks: {}, accountAutomationState: {}, activeTaskId: null }); });
  // 正式 observer 每秒检查一次；真实磁盘收取必须允许跨过一次轮询，不能使用同为一秒的默认等待。
  await waitFor((): void => {
    expect(usePetStoryStore.getState().busy).toBe(false);
    const collected = currentProject().jobs.find((item: PetStoryChatJob): boolean => item.id === job.id);
    expect(collected?.status, collected?.error || usePetStoryStore.getState().error).toBe(expectedStatus);
  }, { timeout: 3_000 });
  if (expectedStatus === 'applied') expect(await screen.findByText('新方案已准备好，请查看。满意后采用，也可以继续提出修改。')).toBeDefined();
}

beforeEach(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-plan-revision-integration-'));
  projects = new PetStoryProjects();
  let project = await projects.create(directory, 'TEST-revision-studio', 'TEST-revision-account');
  project = await projects.saveMobileStory(project.id, project.revision, originalText);
  project.plan = originalPlan(); project.materials = syncMaterials(project);
  project.storyApproval = { hash: storyHash(project), at: new Date().toISOString() };
  project.assets = [{ id: 'TEST-preserved-media', kind: 'plannedEndImage', shotId: 'sh01', relativePath: 'shots/sh01/TEST-existing.png' }];
  await fs.mkdir(path.join(directory, 'shots/sh01'), { recursive: true });
  await fs.writeFile(path.join(directory, project.assets[0].relativePath), 'TEST 历史文件占位');
  project = await projects.write(project);
  tasks = []; let sequence = 0;
  core = new TaskService({ store: { read: listedTasks, replace: (items: Task[]): boolean => { tasks = structuredClone(items); return true; } },
    defaultProjectId: (): string => project.studioProjectId, id: (): string => `TEST-revision-task-${++sequence}` });
  service = new PetStoryChatService(projects, { list: listedTasks, create: (input: TaskAddParams, accountId: string): Task => {
    const created = core.create(input); if (!created.success) throw new Error(created.error);
    const assigned = core.assign({ taskId: created.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error); return assigned.data;
  } });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { petstory: {
    prepareRuntime: service.prepareRuntime.bind(service), bindRun: service.bindRun.bind(service), collectChat: service.collect.bind(service),
    adoptPlanCandidate: service.adoptPlanCandidate.bind(service),
    confirmStory: async (id: string, revision: number): Promise<PetStoryResult> => ({ success: true, project: await projects.confirmStory(id, revision) }),
    open: async (): Promise<PetStoryResult> => ({ success: true, project: await new PetStoryProjects().open(directory) }),
  }, tasks: { list: async (): Promise<Task[]> => listedTasks() } } });
  const now = new Date().toISOString();
  const account: Account = { id: project.accountId, name: 'TEST 原账号', platform: 'doubao', avatar: '', partition: 'TEST-only', status: 'idle', pinned: false, createdAt: now, updatedAt: now };
  useAccountStore.setState({ ...initial.accounts, accounts: [account], selectAccount: (): void => undefined });
  useProjectStore.setState({ ...initial.projects, projects: [{ id: project.studioProjectId, name: 'TEST 隔离项目', description: '', color: '#fff', archived: false, createdAt: now, updatedAt: now }], selectProject: (): void => undefined });
  useTaskStore.setState({ ...initial.tasks, tasks: [], activeTaskId: null, accountBusy: {}, accountAutomationState: {},
    startAutomation: async (taskId: string, beforeDispatch?: (task: Task) => Promise<void>): Promise<boolean> => {
      const task = tasks.find((item: Task): boolean => item.id === taskId)!;
      const started = core.updateRuntime({ taskId, expectedRunId: currentRunId(core, taskId), status: 'executing', runtime: { runId: `TEST-run-${taskId}`, attempt: 1, stage: 'injecting_prompt', message: 'TEST 离线执行替身',
        startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { mode: 'chat', prompt: task.prompt, attachments: task.attachments || [] } } });
      if (!started.success) throw new Error(started.error);
      if (beforeDispatch) await beforeDispatch(listedTasks().find((item: Task): boolean => item.id === taskId)!);
      useTaskStore.setState({ tasks: listedTasks() }); return true;
    } });
  usePetStoryStore.setState({ ...initial.petstory, project, busy: false, error: '', promptBatch: { total: 0, completed: 0, status: 'idle' } });
  unobserve = observePetStoryTasks();
});

afterEach(async (): Promise<void> => {
  unobserve?.(); unobserve = undefined; cleanup();
  await usePetStoryStore.getState().stopPromptBatch();
  for (const task of tasks) await automationEngine.release(task.id);
  usePetStoryStore.setState(initial.petstory); useTaskStore.setState(initial.tasks); useAccountStore.setState(initial.accounts); useProjectStore.setState(initial.projects);
  await fs.rm(directory, { recursive: true, force: true }); vi.restoreAllMocks();
});

function useActualScheduler(): void {
  Object.assign(window.electronAPI.tasks, {
    updateRuntime: async (id: string, patch: Omit<TaskUpdateRuntimeParams, 'taskId'>): Promise<unknown> => {
      const result = core.updateRuntime({ taskId: id, expectedRunId: currentRunId(core, id), ...patch }); return result.success ? { success: true, task: result.data } : result;
    }, acquireLock: async (): Promise<{ success: true }> => ({ success: true }),
    releaseLock: async (): Promise<{ success: true }> => ({ success: true }), renewLock: async (): Promise<{ success: true }> => ({ success: true }),
  });
  Object.assign(window.electronAPI, { logs: { append: vi.fn() } });
  const now = new Date().toISOString();
  useAccountStore.setState({ accounts: useAccountStore.getState().accounts.map((account: Account): Account => ({ ...account,
    health: { loginState: 'ok', verificationRequired: false, consecutiveFailures: 0, successCount: 0, failureCount: 0,
      availability: { state: 'ready', reason: 'ready', message: 'TEST', checkedAt: now, source: 'manual' } } })) });
  useTaskStore.setState({ startAutomation: initial.tasks.startAutomation, tasks: listedTasks(), schedulerPaused: false });
}

describe('连续方案修改的真实服务与页面集成', (): void => {
  it.each(['unopened', 'wrong_job'] as const)('持久文字任务归属%s时通用启动拒绝，不能退回普通聊天发送', async (mismatch): Promise<void> => {
    const project = currentProject();
    const prepared = await service.prepareRuntime(project.id, project.revision, 'analysis', { background: 'canvas', planFeedback: { text: 'TEST 持久归属任务', requestId: 'TEST-persisted-owner' } });
    if (mismatch === 'unopened') usePetStoryStore.setState({ project: null });
    else {
      usePetStoryStore.setState({ project: prepared.project! });
      tasks[0].petstoryChat = { projectId: project.id, jobId: 'TEST-unrelated-job' };
    }
    useActualScheduler(); const binding = vi.spyOn(window.electronAPI.petstory, 'bindRun');
    await act(async (): Promise<void> => { expect(await useTaskStore.getState().startAutomation(prepared.taskId!)).toBe(false); });
    expect(binding).not.toHaveBeenCalled(); expect(tasks[0]).toMatchObject({ status: 'paused', executionIntent: 'hold' });
    expect(tasks[0].runtime?.submittedAt).toBeUndefined(); expect(useTaskStore.getState().executingTasks).toEqual({});
  });

  it.each([false, true])('任务中心通用start无callback也先绑定实际job并由observer收取；伪成功缺回读=%s', async (missingReadback: boolean): Promise<void> => {
    const project = currentProject();
    const prepared = await service.prepareRuntime(project.id, project.revision, 'analysis', { background: 'canvas', planFeedback: { text: 'TEST 仅调整机位', requestId: 'TEST-generic-start' } });
    usePetStoryStore.setState({ project: prepared.project! }); useActualScheduler();
    const binding = vi.spyOn(window.electronAPI.petstory, 'bindRun');
    if (missingReadback) binding.mockResolvedValueOnce({ success: true, project: structuredClone(currentProject()) });
    await act(async (): Promise<void> => { expect(await useTaskStore.getState().startAutomation(prepared.taskId!)).toBe(!missingReadback); });
    expect(binding).toHaveBeenCalledOnce();
    if (missingReadback) {
      expect(tasks[0]).toMatchObject({ status: 'paused', executionIntent: 'hold' });
      expect(useTaskStore.getState().executingTasks).toEqual({}); expect(automationEngine.isReserved(tasks[0].id)).toBe(false); return;
    }
    expect(currentProject().jobs.at(-1)?.runId).toBe(tasks[0].runtime?.runId);
    expect((await projects.read(project.id)).jobs.at(-1)?.runId).toBe(tasks[0].runtime?.runId);
    render(<View />); fireEvent.click(screen.getByRole('button', { name: '查看调整进度' }));
    const plan = structuredClone(project.plan!); plan.shots[0].camera = 'TEST 通用启动后的候选机位';
    await completeReply(plan);
    expect(currentProject().jobs.at(-1)?.resultStatus).toBe('candidate'); expect(tasks).toHaveLength(1);
  });

  it('真实卡点的自身前身映射连续三次无进展即暂停；显式继续后正确合镜完成且不重发原任务', async (): Promise<void> => {
    const before = structuredClone(currentProject()); render(<View />);
    fireEvent.click(screen.getByRole('button', { name: '在豆包中调整' }));
    const dialog = await screen.findByRole('dialog', { name: '调整方案' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '方案修改要求' }), { target: { value: 'TEST 将五镜合为三镜，保留逐字台词与结局。' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '开始调整' }));
    await waitFor((): void => { expect(tasks).toHaveLength(1); expect(usePetStoryStore.getState().busy).toBe(false); });
    const invalid = structuredClone(before.plan!);
    invalid.shots = [invalid.shots[0], invalid.shots[1], invalid.shots[3]];
    invalid.shots[1].predecessorShotIds = ['sh02', 'sh03'];
    invalid.shots[2].id = 'merged_3'; invalid.shots[2].order = 3; invalid.shots[2].predecessorShotIds = ['sh04', 'sh07'];
    for (let round = 0; round < 3; round++) {
      await completeReply(invalid, 'invalid');
      expect(currentProject().jobs).toHaveLength(Math.min(round + 2, 3));
      expect(tasks).toHaveLength(Math.min(round + 2, 3));
    }
    const stopped = currentProject().jobs.at(-1)!;
    expect(stopped.error).toContain('自动修订没有进展，已暂停');
    expect(usePetStoryStore.getState().error).toContain('自动修订没有进展，已暂停');
    expect(screen.queryByRole('heading', { name: '正在请豆包修正分镜方案…' })).toBeNull();
    expect(currentProject().plan).toEqual(before.plan); expect(currentProject().assets).toEqual(before.assets);
    const completedBefore = listedTasks();
    await act(async (): Promise<void> => { await usePetStoryStore.getState().correctOnce(stopped.id); });
    expect(tasks).toHaveLength(4); expect(currentProject().jobs.at(-1)?.repairMode).toBe('explicit');
    const valid = structuredClone(invalid); valid.shots[1].id = 'merged_2';
    await completeReply(valid);
    expect(tasks.slice(0, 3)).toEqual(completedBefore); expect(currentProject().jobs).toHaveLength(4);
    expect(currentProject().jobs.at(-1)?.resultStatus).toBe('candidate'); expect(currentProject().plan).toEqual(before.plan);
    expect(currentProject().jobs.slice(0, 3).every((job: PetStoryChatJob): boolean => job.status === 'invalid' && !!job.rawText)).toBe(true);
  });

  it('候选改名、五镜合三镜及八次连续反馈均自动完成回读，明确采用后可从磁盘重开', async (): Promise<void> => {
    const before = structuredClone(currentProject()); render(<View />);
    fireEvent.click(screen.getByRole('button', { name: '在豆包中调整' }));
    const dialog = await screen.findByRole('dialog', { name: '调整方案' });
    let plan = structuredClone(before.plan!);
    for (let round = 0; round < 8; round++) {
      if (round) fireEvent.click(within(dialog).getByRole('button', { name: '继续调整' }));
      fireEvent.change(within(dialog).getByRole('textbox', { name: '方案修改要求' }), { target: { value: `TEST 第${round + 1}次修改，保留逐字台词与结局。` } });
      fireEvent.click(within(dialog).getByRole('button', { name: '开始调整' }));
      await waitFor((): void => { expect(tasks).toHaveLength(round + 1); expect(usePetStoryStore.getState().busy).toBe(false); });
      const job = currentProject().jobs.at(-1)!;
      expect(job.planFeedback?.baseJobId).toBe(round ? currentProject().jobs.at(-2)!.id : undefined);
      expect(within(dialog).queryByText('新方案已准备好，请查看。满意后采用，也可以继续提出修改。')).toBeNull();
      plan = structuredClone(plan);
      if (round === 1) for (const shot of plan.shots) delete shot.predecessorShotIds;
      if (round === 0) { plan.shots[4].id = 'sh05'; plan.shots[4].predecessorShotIds = ['sh07']; }
      if (round === 1) {
        plan.shots = [plan.shots[0], plan.shots[1], plan.shots[3]];
        plan.shots[1].id = 'merged_2'; plan.shots[1].predecessorShotIds = ['sh02', 'sh03'];
        plan.shots[2].id = 'merged_3'; plan.shots[2].order = 3; plan.shots[2].predecessorShotIds = ['sh04', 'sh05'];
      }
      plan.understanding = `TEST 第${round + 1}轮完整方案`; plan.shots[0].camera = `TEST 第${round + 1}轮机位`;
      await completeReply(plan);
      expect(tasks).toHaveLength(round + 1); expect(currentProject().jobs).toHaveLength(round + 1);
      expect(currentProject().plan).toEqual(before.plan); expect(currentProject().assets).toEqual(before.assets);
      expect(currentProject().storyApproval).toEqual(before.storyApproval); expect(usePetStoryStore.getState().error).toBe('');
      expect((await projects.read(before.id)).jobs.at(-1)?.resultStatus).toBe('candidate');
    }
    fireEvent.click(within(dialog).getByRole('button', { name: '确认并采用新方案' }));
    await waitFor((): void => { expect(currentProject().jobs.at(-1)?.resultStatus).toBe('adopted'); expect(usePetStoryStore.getState().busy).toBe(false); expect(currentProject().storyApproval).toBeDefined(); });
    const reopened = await new PetStoryProjects().open(directory);
    expect(reopened.plan?.shots).toHaveLength(3); expect(reopened.plan?.understanding).toBe('TEST 第8轮完整方案');
    expect(reopened.jobs).toHaveLength(8); expect(reopened.assets).toEqual(before.assets); expect(reopened.mobileStory).toEqual(before.mobileStory);
    expect(tasks.every((task: Task): boolean => task.mode === 'chat' && task.status === 'done')).toBe(true);
    expect(reopened.jobs.every((job: PetStoryChatJob): boolean => !!job.rawText && !!job.runId)).toBe(true);
    cleanup();
    await act(async (): Promise<void> => { await usePetStoryStore.getState().openProject(directory); });
    render(<View />);
    expect(screen.getByRole('heading', { name: '方案已采用' })).toBeDefined();
    expect(screen.getByText('3 个镜头 · 1 人物 / 0 道具 / 1 场景 · 共 15 秒')).toBeDefined();
    expect(screen.queryByRole('progressbar')).toBeNull(); expect(tasks).toHaveLength(8);
  }, 20_000);
});
