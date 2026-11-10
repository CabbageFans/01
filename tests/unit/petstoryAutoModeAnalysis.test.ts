import { currentRunId } from '../fixtures/taskRunIdentity';
/** 新旧分析合同的离线收取测试；仅创建内存hold任务，不连接平台或生成图片。 */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PetStoryChatJob, PetStoryPlan, PetStoryProject, PetStoryResolvedMode, PetStoryResult, Task, TaskAddParams, TaskRunSnapshot } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { PetStoryChatService } from '../../main/utils/petstoryChat';
import { PetStoryProjects } from '../../main/utils/petstoryProject';

const now = '2026-11-06T00:00:00.000Z';
const story = 'TEST桌上的盒子被打开，露出礼物。';
let directory: string; let projects: PetStoryProjects; let project: PetStoryProject; let chat: PetStoryChatService; let core: TaskService; let tasks: Task[]; let oldContract: boolean;

function plan(): PetStoryPlan {
  const prompt = { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST-analysis' };
  return { sourceSummary: story, adaptedStory: story, characters: [], props: [],
    scenes: [{ id: 'room', name: 'TEST室内', location: 'TEST房间', time: '白天', lighting: '自然光', layout: '桌面靠墙', view: '平视', designOrigin: 'script' }],
    shots: [{ id: 'shot-box', order: 1, characterIds: [], sceneId: 'room', scene: 'TEST室内', propIds: [], propStates: [],
      action: '盒子从关闭到打开并露出礼物', startState: '盒盖关闭', endState: '盒盖打开，露出礼物', durationSeconds: 5, transition: 'cut', requestedMode: 'auto',
      timingPlan: { events: [{ id: 'opening', kind: 'action', description: 'TEST盒盖打开', startSeconds: 0, endSeconds: 4.5 }], estimatedRequiredSeconds: 4.5, durationReason: 'TEST开盒动作的必要时间', cutReason: 'TEST露出礼物后切出' },
      prompts: { firstFrame: { ...prompt }, video: { ...prompt } } }] };
}

beforeEach(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-auto-mode-analysis-'));
  projects = new PetStoryProjects(); project = await projects.create(directory, 'TEST-studio', 'TEST-account');
  project = await projects.saveMobileStory(project.id, project.revision, story);
  tasks = []; oldContract = false; let sequence = 0;
  core = new TaskService({ store: { read: (): Task[] => structuredClone(tasks), replace: (items: Task[]): boolean => { tasks = structuredClone(items); return true; } },
    defaultProjectId: (): string => project.studioProjectId, id: (): string => `TEST-auto-analysis-${++sequence}` });
  chat = new PetStoryChatService(projects, { list: (): Task[] => structuredClone(tasks), create: (params: TaskAddParams, accountId: string): Task => {
    const created = core.create(params);
    if (!created.success) throw new Error(created.error);
    const assigned = core.assign({ taskId: created.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error);
    return assigned.data;
  } });
});
afterEach(async (): Promise<void> => { await fs.rm(directory, { recursive: true, force: true }); });

async function collect(incoming: PetStoryPlan): Promise<PetStoryResult> {
  project = (await chat.prepareRuntime(project.id, project.revision, 'analysis')).project!;
  if (oldContract) {
    // 导入真实旧格式记录；新生产不能允许create端把已保存意图换成另一正文。
    const task = tasks[0]; task.prompt = 'TEST旧版分析请求，尚无逐镜自动模式必填合同';
    const job = project.jobs.at(-1)!; job.requestText = task.prompt; job.planTimingVersion = undefined; job.inputHash = createHash('sha256').update(task.prompt).digest('hex');
    project.taskIntents = undefined; project = await projects.write(project);
  }
  return collectPrepared(incoming, project.jobs.at(-1)!);
}
async function collectPrepared(incoming: PetStoryPlan, job: PetStoryChatJob): Promise<PetStoryResult> {
  const task = tasks.find((item: Task): boolean => item.id === job.taskId)!;
  const raw = JSON.stringify({ ...incoming, storyUsable: true, contentBasis: { beginning: 'TEST盒子关闭', middle: 'TEST盒盖打开', ending: 'TEST礼物露出' }, requestId: job.requestId, targetIds: job.expectedIds });
  const runtime: TaskRunSnapshot = { runId: 'TEST-auto-analysis-run', attempt: 1, stage: 'completed', message: 'TEST离线返回', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
    submittedAt: now, conversationUrl: 'https://www.doubao.com/chat/TEST-auto-mode', input: { prompt: task.prompt, mode: 'chat', attachments: task.attachments || [] }, chatResponse: { text: raw, capturedAt: now } };
  const complete = core.updateRuntime({ taskId: task.id, expectedRunId: currentRunId(core, task.id), status: 'done', runtime }); if (!complete.success) throw new Error(complete.error);
  await chat.bindRun(project.id, job.id, runtime.runId);
  return chat.collect(project.id, job.id);
}

describe('新分析逐镜模式判断必填，旧请求保留兼容', (): void => {
  it('新请求漏判断保留原回复并给可修订结构问题，不接受为旧方案兼容', async (): Promise<void> => {
    const result = await collect(plan()); const job = result.project!.jobs.at(-1)!;
    expect(result.success).toBe(false); expect(result.needsRepair).toBe(true);
    expect(job.status).toBe('invalid'); expect(job.rawText).toContain('shot-box');
    expect(job.validationDetails).toContainEqual(expect.objectContaining({ code: 'structure', path: '$.shots[0].autoModePlan', targetId: 'shot-box', repairable: true }));
    expect(job.parsedResult?.plan).toBeUndefined(); expect(result.project!.plan).toBeUndefined();
    expect(result.project!.assets).toHaveLength(0); expect(tasks).toHaveLength(1); expect(tasks[0].executionIntent).toBe('hold');
  });

  it('旧请求缺判断仍按原合同收取，历史候选不被迁移', async (): Promise<void> => {
    oldContract = true; const result = await collect(plan()); const job = result.project!.jobs.at(-1)!;
    expect(result.success, result.error).toBe(true);
    expect(job.parsedResult?.plan?.shots[0].autoModePlan).toBeUndefined(); expect(job.parsedResult?.plan?.shots[0].prompts.lastFrame).toBeUndefined();
    expect(result.project!.plan).toBeUndefined(); expect(result.project!.assets).toHaveLength(0); expect(tasks).toHaveLength(1);
  });

  it('补齐缺失判断沿原内容修订成为新候选，不误判为无关剧情改写', async (): Promise<void> => {
    const invalid = await collect(plan()); project = invalid.project!;
    const source = project.jobs.at(-1)!; const originalReply = source.rawText;
    project = (await chat.prepareRuntime(project.id, project.revision, 'repair', { parentJobId: source.id })).project!;
    const incoming = plan(); incoming.shots[0].autoModePlan = { mode: 'first_last_frame', reason: 'TEST礼物露出的具体终态需要固定' };
    const repaired = await collectPrepared(incoming, project.jobs.at(-1)!);
    expect(repaired.success, repaired.error).toBe(true);
    expect(repaired.project!.jobs.at(-1)?.parsedResult?.plan?.shots[0].autoModePlan?.mode).toBe('first_last_frame');
    expect(repaired.project!.jobs.at(-1)?.parsedResult?.requiresConfirmation).toBeUndefined();
    expect(repaired.project!.jobs.find((job: PetStoryChatJob): boolean => job.id === source.id)?.rawText).toBe(originalReply);
    expect(repaired.project!.plan).toBeUndefined(); expect(repaired.project!.assets).toHaveLength(0); expect(tasks).toHaveLength(2);
  });

  it.each(['first_frame', 'first_last_frame', 'reference'] as const)('新请求明确%s判断保存为候选，不自动生成或采用', async (mode: PetStoryResolvedMode): Promise<void> => {
    const incoming = plan(); incoming.shots[0].autoModePlan = { mode, reason: 'TEST本镜具体剧情的模式依据' };
    const result = await collect(incoming); const job = result.project!.jobs.at(-1)!;
    expect(result.success, result.error).toBe(true); expect(job.resultStatus).toBe('candidate');
    expect(job.parsedResult?.plan?.shots[0].autoModePlan).toEqual({ mode, reason: 'TEST本镜具体剧情的模式依据', source: 'analysis' });
    expect(!!job.parsedResult?.plan?.shots[0].prompts.lastFrame).toBe(mode === 'first_last_frame');
    expect(result.project!.plan).toBeUndefined(); expect(result.project!.assets).toHaveLength(0); expect(tasks).toHaveLength(1);
  });

  it('显式模式不要求重复自动判断', async (): Promise<void> => {
    const incoming = plan(); incoming.shots[0].requestedMode = 'first_frame';
    const result = await collect(incoming);
    expect(result.success, result.error).toBe(true); expect(result.project!.jobs.at(-1)?.parsedResult?.plan?.shots[0].requestedMode).toBe('first_frame');
    expect(tasks).toHaveLength(1);
  });
});
