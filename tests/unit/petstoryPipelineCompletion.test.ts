/** 原五镜头已保存数据派生的离线技术状态；模拟响应不作为豆包产出或业务验收。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PetStoryChatJob, PetStoryPlan, PetStoryProject, PetStoryPromptBatch, PetStoryPromptKind, Task, TaskAddParams, TaskRunSnapshot } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { PetStoryChatService } from '../../main/utils/petstoryChat';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { pendingChatConflicts } from '../../main/utils/petstoryPending';
import { syncMaterials } from '../../main/utils/petstoryMaterials';
import { validatePetStoryPlan } from '../../main/utils/petstoryValidation';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { seedOfflinePromptContracts } from '../fixtures/petstoryPromptContracts';
import { inspectPromptEligibility } from '../../main/utils/petstoryEligibility';
import { promptReferences } from '../../main/utils/petstoryPromptQuality';

function originalPlan(): PetStoryPlan {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  plan.props = [];
  plan.scenes = [{ id: 'road', name: '村道', location: plan.shots[0].scene, time: '未指定', lighting: '原方案暖柔和自然光', layout: '原故事路边与民居', view: '原方案视角', designOrigin: 'script' }];
  for (const character of plan.characters) character.referenceAssetId = undefined;
  for (const shot of plan.shots) { shot.sceneId = 'road'; shot.propIds = []; shot.propStates = []; }
  return plan;
}
let directory: string; let projects: PetStoryProjects; let p: PetStoryProject; let core: TaskService; let chat: PetStoryChatService; let stored: Task[];
beforeEach(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-prompt-pipeline-'));
  projects = new PetStoryProjects(); p = await projects.create(directory, 'TEST-studio', 'TEST-account');
  p = await projects.saveMobileStory(p.id, p.revision, snapshot.mobileStory);
  stored = []; let nextId = 0;
  core = new TaskService({ store: { read: (): Task[] => structuredClone(stored), replace: (tasks: Task[]): boolean => { stored = structuredClone(tasks); return true; } },
    defaultProjectId: (): string => p.studioProjectId, id: (): string => `TEST-pipeline-${++nextId}` });
  chat = new PetStoryChatService(projects, { list: (): Task[] => structuredClone(stored), create: (params: TaskAddParams, accountId: string): Task => {
    const result = core.create(params); if (!result.success) throw new Error(result.error);
    const assigned = core.assign({ taskId: result.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error); return assigned.data;
  } });
});
afterEach(async (): Promise<void> => { await fs.rm(directory, { recursive: true, force: true }); });

async function withOriginalPlan(): Promise<void> { p.plan = originalPlan(); p.materials = syncMaterials(p); p = await projects.write(p); }
async function prepare(shotId: string = 'shot_1', promptKind: PetStoryPromptKind = 'firstFrame'): Promise<PetStoryChatJob> {
  const result = await chat.prepareRuntime(p.id, p.revision, 'optimize', { shotId, promptKind }); p = result.project!;
  return p.jobs.at(-1)!;
}
async function recordRun(job: PetStoryChatJob, response?: string, active = false): Promise<TaskRunSnapshot> {
  const task = stored.find((item): boolean => item.id === job.taskId)!; const now = new Date().toISOString();
  const runtime: TaskRunSnapshot = { runId: `TEST-run-${job.id}`, attempt: 1, stage: response ? 'completed' : active ? 'generating' : 'paused', message: '离线原任务状态', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
    input: { prompt: task.prompt, mode: 'chat', attachments: task.attachments || [] }, ...(response ? { chatResponse: { text: response, capturedAt: now } } : {}) };
  const result = core.updateRuntime({ taskId: task.id, status: response ? 'done' : active ? 'generating' : 'paused', runtime }); if (!result.success) throw new Error(result.error);
  if (!job.runId) p = (await chat.bindRun(p.id, job.id, runtime.runId)).project!;
  return runtime;
}
function response(job: PetStoryChatJob, optimized: string): string { return JSON.stringify({ requestId: job.requestId, targetIds: job.expectedIds, optimized }); }

describe('F01 分析只产出设计与兼容草稿', (): void => {
  it('原五镜头旧综合正文可见为draft，不赋予final、专用来源或合同', (): void => {
    const input = originalPlan(); const parsed = validatePetStoryPlan(input, true);
    expect(parsed.shots).toHaveLength(snapshot.plan.shots.length);
    for (const shot of parsed.shots) for (const kind of ['firstFrame', 'lastFrame', 'video'] as const) {
      const target = shot.prompts[kind]; const old = input.shots.find((item): boolean => item.id === shot.id)!.prompts[kind];
      if (!target) continue;
      expect(target.final).toBe(''); expect(target.optimized).toBe(''); expect(target.edited).toBe(false);
      expect(target.draft).toBe(old?.optimized); expect(target.sourceJobId).toBeUndefined(); expect(target.promptTask).toBeUndefined();
    }
  });
  it('分析不带prompts仍保留动态设计，为首尾模式创建空态容器', (): void => {
    const input = originalPlan();
    const raw = { ...input, shots: input.shots.map((shot): object => { const design: Partial<typeof shot> = { ...shot }; delete design.prompts; return design; }) };
    const parsed = validatePetStoryPlan(raw, true);
    for (const shot of parsed.shots) {
      expect(shot.startState).toBe(input.shots.find((item): boolean => item.id === shot.id)!.startState);
      expect(shot.prompts.firstFrame.final).toBe(''); expect(shot.prompts.video.final).toBe('');
      expect(!!shot.prompts.lastFrame).toBe(shot.requestedMode === 'first_last_frame');
    }
  });
  it('新建分析收取、保存重开保留空final；专用请求另有来源，文字操作不创建媒体', async (): Promise<void> => {
    const prepared = await chat.prepareRuntime(p.id, p.revision, 'analysis'); p = prepared.project!; const job = p.jobs.at(-1)!;
    const plan = originalPlan(); const raw = JSON.stringify({ requestId: job.requestId, targetIds: job.expectedIds, storyUsable: true,
      contentBasis: { beginning: plan.shots[0].startState, middle: plan.shots[2].action, ending: plan.shots.at(-1)!.endState }, ...plan });
    await recordRun(job, raw); const collected = await chat.collect(p.id, job.id); p = collected.project!;
    expect(collected.success).toBe(true); expect(p.jobs[0].rawText).toBe(raw); expect(p.jobs[0].resultStatus).toBe('candidate');
    p = (await chat.adoptPlanCandidate(p.id, p.revision, job.id)).project!;
    expect(p.jobs[0].resultStatus).toBe('adopted');
    const reopened = await new PetStoryProjects().open(directory);
    expect(reopened.mobileStory!.text).toBe(snapshot.mobileStory); expect(reopened.plan).toEqual(p.plan);
    for (const shot of reopened.plan!.shots) expect(shot.prompts.firstFrame).toMatchObject({ final: '', optimized: '', edited: false });
    const dedicated = await prepare();
    expect(dedicated.stage).toBe('firstFrame'); expect(dedicated.promptTask?.dialect).toBe('seedream'); expect(dedicated.promptTask?.designHash).toMatch(/^[a-f0-9]{64}$/);
    expect(dedicated.requestId).not.toBe(job.requestId); expect(dedicated.expectedIds).toEqual(['shot_1:firstFrame']);
    expect(stored).toHaveLength(2); expect(stored.every((task): boolean => task.mode === 'chat' && task.executionIntent === 'hold')).toBe(true);
  });
  it('旧项目正文、手改、任务历史原样重开，保存手改保持来源基础且不伪造专用来源', async (): Promise<void> => {
    await withOriginalPlan(); const original = structuredClone(p.plan); const shot = p.plan!.shots[0];
    shot.prompts.firstFrame.sourceJobId = 'TEST-real-adopted-basis'; p = await projects.write(p);
    const changed = `${shot.prompts.firstFrame.final}\n`; p = await projects.saveShotPrompt(p.id, p.revision, shot.id, 'firstFrame', changed);
    expect(p.plan!.shots[0].prompts.firstFrame).toMatchObject({ final: changed, edited: true, basisJobId: 'TEST-real-adopted-basis' });
    expect(p.plan!.shots[0].prompts.firstFrame.sourceJobId).toBeUndefined(); expect(p.plan!.shots[1]).toEqual(original!.shots[1]);
    expect((await new PetStoryProjects().open(directory)).plan).toEqual(p.plan); expect(stored).toEqual([]);
  });
});

describe('F03 明确结束等待、迟到回复与依赖范围', (): void => {
  it('结束等待持久化并暂停批次，原submittedAt、运行与任务状态不变，禁止自动重试', async (): Promise<void> => {
    await withOriginalPlan(); const job = await prepare(); await recordRun(job);
    const batch: PetStoryPromptBatch = { targets: [{ shotId: job.shotId!, kind: 'firstFrame' }], total: 1, completed: 0, status: 'running', jobId: job.id };
    p = await projects.savePromptBatch(p.id, p.revision, batch); const tasksBefore = structuredClone(stored); const requestBefore = structuredClone(p.jobs[0]);
    p = (await chat.endWaiting(p.id, p.revision, job.id)).project!;
    expect(p.jobs[0]).toMatchObject({ ...requestBefore, endedWaitingAt: expect.any(String), status: 'bound' });
    expect(p.promptBatch?.status).toBe('paused'); expect(stored).toEqual(tasksBefore); expect(stored[0].runtime?.submittedAt).toBeTruthy();
    expect((await new PetStoryProjects().open(directory)).jobs[0].endedWaitingAt).toBe(p.jobs[0].endedWaitingAt);
    await expect(chat.retryUnsubmitted(p.id, job.id)).rejects.toThrow('禁止重试'); expect(stored).toEqual(tasksBefore);
  });
  it('结束等待后的原回复只留候选，手改final、任务与发送次数不被迟到回复覆盖', async (): Promise<void> => {
    await withOriginalPlan(); const job = await prepare(); await recordRun(job);
    const oldFinal = p.plan!.shots[0].prompts.firstFrame.final;
    p = (await chat.endWaiting(p.id, p.revision, job.id)).project!;
    const body = snapshot.plan.shots[0].prompts.firstFrame.optimized;
    await recordRun({ ...job, runId: stored[0].runtime!.runId }, response(job, body));
    const count = stored.length; const result = await chat.collect(p.id, job.id); p = result.project!;
    expect(result.success).toBe(true); expect(result.needsRepair).toBeUndefined(); expect(p.jobs[0]).toMatchObject({ resultStatus: 'candidate', parsedResult: { optimized: body } });
    expect(p.plan!.shots[0].prompts.firstFrame.final).toBe(oldFinal); expect(stored).toHaveLength(count);
    expect((await new PetStoryProjects().open(directory)).jobs[0]).toEqual(p.jobs[0]);
  });
  it('已结束等待的坏回复保留原文与原因，不发起自动纠正', async (): Promise<void> => {
    await withOriginalPlan(); const job = await prepare(); await recordRun(job); p = (await chat.endWaiting(p.id, p.revision, job.id)).project!;
    const raw = '{ 离线坏JSON原回复'; await recordRun({ ...job, runId: stored[0].runtime!.runId }, raw);
    const result = await chat.collect(p.id, job.id); p = result.project!;
    expect(result.success).toBe(false); expect(result.needsRepair).toBe(false); expect(p.jobs[0]).toMatchObject({ status: 'invalid', rawText: raw, endedWaitingAt: expect.any(String) });
    expect(p.jobs[0].validationIssues?.length).toBeGreaterThan(0); expect(stored).toHaveLength(1);
  });
  it('旧版未保存requestId的原任务结束等待后，迟到回复也只能成为历史候选', async (): Promise<void> => {
    await withOriginalPlan(); const shot = p.plan!.shots[1]; const oldFinal = shot.prompts.firstFrame.final;
    const prepared = await chat.prepare(p.id, 'TEST离线旧请求', 'optimize', undefined, shot.id, 'firstFrame'); p = prepared.project!;
    const job = p.jobs.at(-1)!; expect(job.requestId).toBeUndefined(); await recordRun(job);
    p = (await chat.endWaiting(p.id, p.revision, job.id)).project!;
    const body = `${snapshot.plan.shots[1].prompts.firstFrame.optimized}\n`;
    await recordRun({ ...job, runId: stored[0].runtime!.runId }, JSON.stringify({ optimized: body }));
    p = (await chat.collect(p.id, job.id)).project!;
    expect(p.plan!.shots[1].prompts.firstFrame.final).toBe(oldFinal);
    expect(p.jobs.at(-1)).toMatchObject({ endedWaitingAt: expect.any(String), resultStatus: 'candidate', parsedResult: { optimized: body } });
    expect(stored).toHaveLength(1);
  });
  it('未决只锁同镜、前镜与所用素材；全局任务保持依赖，结束等待不解除活动账号互斥', async (): Promise<void> => {
    await withOriginalPlan(); const job = await prepare('shot_2'); await recordRun(job);
    expect(pendingChatConflicts(p, { shotId: 'shot_2' }).map((item): string => item.id)).toEqual([job.id]);
    expect(pendingChatConflicts(p, { shotId: 'shot_3' }).map((item): string => item.id)).toEqual([job.id]);
    expect(pendingChatConflicts(p, { shotId: 'shot_5' })).toEqual([]);
    p.jobs.push({ ...job, id: 'TEST-material', materialId: 'character:friend', shotId: undefined, promptKind: undefined });
    expect(pendingChatConflicts(p, { shotId: 'shot_1' })).toEqual([]);
    expect(pendingChatConflicts(p, { shotId: 'shot_5' }).map((item): string => item.id)).toEqual(['TEST-material']);
    p.jobs.pop(); p = await projects.write(p);
    await recordRun({ ...job, runId: stored[0].runtime!.runId }, undefined, true); p = (await chat.endWaiting(p.id, p.revision, job.id)).project!;
    expect(pendingChatConflicts(p)).toEqual([]);
    await expect(prepare('shot_5')).rejects.toThrow('活动任务'); expect(stored).toHaveLength(1);
  });
});

describe('文字模型与批次持久化', (): void => {
  it('模型意图独立保存重开，批次只恢复状态，打开不创建请求', async (): Promise<void> => {
    await withOriginalPlan(); p = await projects.savePromptModel(p.id, p.revision, 'seedance-2.5');
    const batch: PetStoryPromptBatch = { targets: [{ shotId: 'shot_2', kind: 'firstFrame' }, { shotId: 'shot_2', kind: 'lastFrame' }, { shotId: 'shot_2', kind: 'video' }], total: 3, completed: 0, status: 'paused' };
    p = await projects.savePromptBatch(p.id, p.revision, batch); const reopened = await new PetStoryProjects().open(directory);
    expect(reopened.promptModel).toBe('seedance-2.5'); expect(reopened.promptCapability).toBeUndefined(); expect(reopened.production).toBeUndefined(); expect(reopened.promptBatch).toEqual(batch); expect(stored).toEqual([]);
  });
  it('损坏进度、混合目标、旧revision不能覆盖已保存批次', async (): Promise<void> => {
    const batch: PetStoryPromptBatch = { targets: [{ shotId: 'shot_1', kind: 'firstFrame' }], total: 1, completed: 0, status: 'paused' };
    p = await projects.savePromptBatch(p.id, p.revision, batch);
    await expect(projects.savePromptBatch(p.id, p.revision - 1, batch)).rejects.toThrow('版本已变化');
    await expect(projects.savePromptBatch(p.id, p.revision, { ...batch, total: 2 })).rejects.toThrow('进度无效');
    await expect(projects.savePromptBatch(p.id, p.revision, { ...batch, targets: [{ shotId: 'shot_1', kind: 'video', materialId: 'character:lulu' }] } as unknown as PetStoryPromptBatch)).rejects.toThrow('目标无效');
    expect((await projects.read(p.id)).promptBatch).toEqual(batch); expect(stored).toEqual([]);
  });
});

describe('主进程当前阶段资格清单', (): void => {
  async function withDedicatedPlans(): Promise<void> {
    p.plan = originalPlan(); p.materials = undefined; p.promptModel = 'generic';
    p = await projects.write(p);
    // 原旧视频正文把人物图编号用于视频首帧，是本轮必须拒绝的旧错绑。
    // 这里只为独立的资格/批次测试建立显式离线响应，复用同一原镜动作与真实目标表；不改真实项目或创作结果。
    for (const shot of p.plan!.shots) for (const kind of ['firstFrame', 'lastFrame', 'video'] as const) {
      const target = shot.prompts[kind]; if (!target) continue;
      const mode = shot.requestedMode === 'auto' ? undefined : shot.requestedMode;
      const references = promptReferences(p, shot, kind, mode, true).map((ref): string => `第${ref.order}张参考图`).join('，');
      const fact = kind === 'firstFrame' ? shot.startState : kind === 'lastFrame' ? shot.endState : `${shot.startState}；${shot.action}；${shot.endState}`;
      target.original = target.optimized = target.final = `TEST离线技术响应：${references}。${fact}`;
    }
    seedOfflinePromptContracts(p); p = await projects.write(p);
  }
  it('先补动态基础素材；来源检查只读，不创建任务、不修改原项目', async (): Promise<void> => {
    await withOriginalPlan(); const before = structuredClone(p);
    const result = await chat.promptStageTargets(p.id, p.revision);
    expect(result.promptTargets).toEqual(p.materials!.map((material): { materialId: string } => ({ materialId: material.id })));
    expect(result.pendingCandidateJobIds).toEqual([]); expect(await projects.read(p.id)).toEqual(before); expect(stored).toEqual([]);
    await expect(chat.promptStageTargets(p.id, p.revision - 1)).rejects.toThrow('项目已变化');
  });
  it('已完成专用generic计划不会反复生成；切换到已知模型重新选择视频及随后边界依赖', async (): Promise<void> => {
    await withDedicatedPlans(); expect((await chat.promptStageTargets(p.id, p.revision)).promptTargets, JSON.stringify(inspectPromptEligibility(p, p.plan!.shots[0].prompts.firstFrame, { shotId: 'shot_1', promptKind: 'firstFrame', model: 'generic' }))).toEqual([]);
    p = await projects.savePromptModel(p.id, p.revision, 'seedance-2.0');
    const result = await chat.promptStageTargets(p.id, p.revision);
    expect(result.promptTargets?.[0]).toEqual({ shotId: 'shot_1', kind: 'video' });
    expect(result.promptTargets?.slice(1, 4)).toEqual([{ shotId: 'shot_2', kind: 'firstFrame' }, { shotId: 'shot_2', kind: 'lastFrame' }, { shotId: 'shot_2', kind: 'video' }]);
    expect(result.promptTargets).toHaveLength(12); expect(stored).toEqual([]);
  });
  it('改起始设计后同批补齐本镜首尾视频和后镜已采用边界依赖', async (): Promise<void> => {
    await withDedicatedPlans(); p.plan!.shots[1].startState += '\n'; p = await projects.write(p);
    const targets = (await chat.promptStageTargets(p.id, p.revision)).promptTargets;
    expect(targets?.slice(0, 3)).toEqual([{ shotId: 'shot_2', kind: 'firstFrame' }, { shotId: 'shot_2', kind: 'lastFrame' }, { shotId: 'shot_2', kind: 'video' }]);
    expect(targets?.some((target): boolean => target.shotId === 'shot_3' && target.kind === 'firstFrame')).toBe(true);
    expect(targets?.some((target): boolean => target.shotId === 'shot_1')).toBe(false); expect(stored).toEqual([]);
  });
  it('保护旧手改final且已有当前专用新候选时返回待采用信息，不重复写同一目标', async (): Promise<void> => {
    await withDedicatedPlans(); const shot = p.plan!.shots[0]; shot.prompts.firstFrame.rulesVersion = 'TEST保留旧手改规则'; p = await projects.write(p);
    const job = await prepare(shot.id); const body = snapshot.plan.shots[0].prompts.firstFrame.optimized;
    await recordRun(job, response(job, body)); p = (await chat.collect(p.id, job.id)).project!;
    const currentFinal = p.plan!.shots[0].prompts.firstFrame.final;
    const result = await chat.promptStageTargets(p.id, p.revision);
    expect(result.promptTargets).toEqual([]); expect(result.pendingCandidateJobIds).toEqual([job.id]);
    expect((await projects.read(p.id)).plan!.shots[0].prompts.firstFrame.final).toBe(currentFinal); expect(stored).toHaveLength(1);
  });
  it('旧候选的模式或事实变化时不冒充当前新候选，继续清单重新适配', async (): Promise<void> => {
    await withDedicatedPlans(); const shot = p.plan!.shots[1]; shot.prompts.firstFrame.edited = true; p = await projects.write(p);
    const job = await prepare(shot.id); await recordRun(job, response(job, snapshot.plan.shots[1].prompts.firstFrame.optimized));
    p = (await chat.collect(p.id, job.id)).project!;
    p.plan!.shots[1].requestedMode = 'reference'; p = await projects.write(p);
    const result = await chat.promptStageTargets(p.id, p.revision);
    expect(result.promptTargets?.[0]).toEqual({ shotId: shot.id, kind: 'firstFrame' }); expect(result.pendingCandidateJobIds).not.toContain(job.id);
    expect(stored).toHaveLength(1);
  });
});

describe('用户明确授权新的局部修订轮次', (): void => {
  it('首轮仍失败时不自动追加修订，但用户可对未变的审查正文发起新请求并保留全部历史', async (): Promise<void> => {
    await withOriginalPlan();
    p = (await chat.prepareRuntime(p.id, p.revision, 'review', { shotId: 'shot_1', promptKind: 'firstFrame' })).project!;
    const review = p.jobs.at(-1)!;
    const issues = [{ id: 'TEST-frame-issue', targetId: 'shot_1:firstFrame', severity: 'error', evidence: snapshot.plan.shots[0].startState,
      impact: 'TEST离线核对起始边界', requestedChange: 'TEST仅核对既有确认起始状态' }];
    await recordRun(review, JSON.stringify({ requestId: review.requestId, targetIds: review.expectedIds, issues })); p = (await chat.collect(p.id, review.id)).project!;
    const target = { shotId: 'shot_1', promptKind: 'firstFrame' as const, parentJobId: review.id };
    p = (await chat.prepareRuntime(p.id, p.revision, 'revise', target)).project!; const first = p.jobs.at(-1)!;
    const raw = '{ TEST离线不合格原回复'; await recordRun(first, raw);
    const failed = await chat.collect(p.id, first.id); p = failed.project!;
    expect(failed.needsRepair).toBe(false); await expect(chat.prepareRuntime(p.id, p.revision, 'repair', { parentJobId: first.id })).rejects.toThrow('已使用一次内容修订');
    p = (await chat.prepareRuntime(p.id, p.revision, 'revise', target)).project!; const second = p.jobs.at(-1)!;
    expect(second.requestId).not.toBe(first.requestId); expect(second.parentJobId).toBe(review.id);
    await recordRun(second, response(second, snapshot.plan.shots[0].prompts.firstFrame.optimized));
    p = (await chat.collect(p.id, second.id)).project!;
    expect(p.jobs.find((job): boolean => job.id === first.id)?.rawText).toBe(raw);
    expect(p.jobs.at(-1)?.resultStatus).toBe('candidate'); expect(p.plan!.shots[0].prompts.firstFrame.final).toBe(snapshot.plan.shots[0].prompts.firstFrame.final);
    expect(stored).toHaveLength(3); expect((await new PetStoryProjects().open(directory)).jobs).toEqual(p.jobs);
  });
});

describe('原待发送请求恢复时重新核对事实', (): void => {
  function simulatedOriginalVideo(job: PetStoryChatJob): string {
    const shot = p.plan!.shots.find((item): boolean => item.id === job.shotId)!;
    const references = job.promptTask!.references.map((ref): string => `@图片${ref.order}用于${ref.purpose === 'firstFrame' ? '首帧' : '尾帧'}边界`).join('；');
    const dialogue = (shot.dialogue || []).map((line): string => `{${p.plan!.characters.find((character): boolean => character.id === line.speakerId)!.name}用中文说：“${line.text}”}`).join('');
    return `TEST离线视频技术响应：${references}。${shot.startState}；${shot.action}；${shot.endState}。${dialogue}全程无字幕，不叠加对白文字。`;
  }
  async function saveUnboundRun(job: PetStoryChatJob, submitted: boolean): Promise<TaskRunSnapshot> {
    const task = stored.find((item): boolean => item.id === job.taskId)!; const now = new Date().toISOString();
    const body = job.promptKind === 'video' ? simulatedOriginalVideo(job) : snapshot.plan.shots[2].prompts.firstFrame.optimized;
    const runtime: TaskRunSnapshot = { runId: `TEST-held-${job.id}`, attempt: 1, stage: submitted ? 'completed' : 'injecting_prompt', message: 'TEST离线原运行', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { prompt: task.prompt, mode: 'chat', attachments: task.attachments || [] }, ...(submitted ? { submittedAt: now, chatResponse: { text: response(job, body), capturedAt: now } } : {}) };
    const saved = core.updateRuntime({ taskId: task.id, status: submitted ? 'done' : 'executing', runtime }); if (!saved.success) throw new Error(saved.error);
    return runtime;
  }
  it.each(['model', 'facts', 'boundary'] as const)('未提交原hold的%s变化时不允许启动，原任务保留且不创建新请求', async (change: 'model' | 'facts' | 'boundary'): Promise<void> => {
    await withOriginalPlan(); p = await projects.savePromptModel(p.id, p.revision, 'seedance-2.0');
    const job = await prepare('shot_3', change === 'model' ? 'video' : 'firstFrame'); const runtime = await saveUnboundRun(job, false);
    if (change === 'model') p = await projects.savePromptModel(p.id, p.revision, 'seedance-2.5');
    else if (change === 'facts') { p.plan!.shots[2].startState += '\n'; p = await projects.write(p); }
    else p = await projects.saveShotPrompt(p.id, p.revision, 'shot_2', 'lastFrame', `${p.plan!.shots[1].prompts.lastFrame!.final}\n`);
    await expect(chat.bindRun(p.id, job.id, runtime.runId)).rejects.toThrow('未发送');
    expect((await projects.read(p.id)).jobs.at(-1)?.runId).toBeUndefined(); expect(stored).toHaveLength(1); expect(stored[0].runtime?.submittedAt).toBeUndefined();
  });
  it('仅切换视频模型时，匹配的Seedream图片原hold仍可继续，不因无关方言变化失效', async (): Promise<void> => {
    await withOriginalPlan(); p = await projects.savePromptModel(p.id, p.revision, 'seedance-2.0');
    const job = await prepare('shot_3'); const runtime = await saveUnboundRun(job, false);
    p = await projects.savePromptModel(p.id, p.revision, 'seedance-2.5');
    p = (await chat.bindRun(p.id, job.id, runtime.runId)).project!;
    expect(p.jobs.at(-1)?.runId).toBe(runtime.runId); expect(stored).toHaveLength(1); expect(job.promptTask?.dialect).toBe('seedream');
  });
  it('已提交原运行在模型变化后仍可只读绑定收取，原回复仅存过期候选', async (): Promise<void> => {
    await withOriginalPlan(); p = await projects.savePromptModel(p.id, p.revision, 'seedance-2.0');
    const job = await prepare('shot_3', 'video'); const runtime = await saveUnboundRun(job, true); const final = p.plan!.shots[2].prompts.video.final;
    p = await projects.savePromptModel(p.id, p.revision, 'seedance-2.5'); p = (await chat.bindRun(p.id, job.id, runtime.runId)).project!;
    p = (await chat.collect(p.id, job.id)).project!;
    expect(p.jobs.at(-1)).toMatchObject({ status: 'applied', resultStatus: 'stale', rawText: runtime.chatResponse!.text });
    expect(p.plan!.shots[2].prompts.video.final).toBe(final); expect(stored).toHaveLength(1);
  });
});
