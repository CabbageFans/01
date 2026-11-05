/** 离线方案反馈回归：技术占位方案与模拟回复只验证正式任务链，不代表平台验收。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PetStoryChatJob, PetStoryPlan, PetStoryProject, PetStoryRuntimeTarget, Task, TaskAddParams, TaskRunSnapshot } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { PetStoryChatService, type PetStoryTaskPort } from '../../main/utils/petstoryChat';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { syncMaterials } from '../../main/utils/petstoryMaterials';
import { claimConversationGuard, releaseConversationGuard, hasConversationGuard } from '../../main/utils/accountConversationGuard';
import { withOfflineTimingPlan } from '../fixtures/petstoryTimingPlan';

let directory: string; let projects: PetStoryProjects; let p: PetStoryProject; let service: PetStoryChatService; let core: TaskService; let port: PetStoryTaskPort;
let stored: Task[];
const feedbackText = 'TEST 只调整第一镜头的机位，其他镜头与原台词保留';
const oldPrompt = 'TEST obsolete prompt must stay off plan feedback';
function plan(): PetStoryPlan {
  const prompt = { original: oldPrompt, optimized: oldPrompt, final: oldPrompt, edited: false, rulesVersion: 'TEST' };
  return withOfflineTimingPlan({ sourceSummary: 'TEST 原剧本摘要', adaptedStory: 'TEST 原剧本正文与逐字台词', understanding: 'TEST 完整理解', sceneDesign: 'TEST 完整空间',
    characters: [{ id: 'actor', name: 'TEST角色', role: 'main', purpose: 'TEST剧情职责', description: 'TEST剧本设定', continuity: 'TEST连续性', aliases: ['TEST角色'], designOrigin: 'script' }], props: [],
    scenes: [{ id: 'location', name: 'TEST地点', location: 'TEST地点', time: 'TEST时间', lighting: 'TEST光线', layout: 'TEST空间锚点', view: 'TEST视角', designOrigin: 'script' }],
    shots: [1, 2].map((order: number): PetStoryPlan['shots'][number] => ({ id: `shot_${order}`, order, characterIds: ['actor'], propIds: [], propStates: [], sceneId: 'location', scene: 'TEST地点',
      action: `TEST动作${order}`, startState: `TEST开始${order}`, endState: `TEST结束${order}`, durationSeconds: 5, transition: 'cut', requestedMode: 'reference', camera: 'TEST原机位',
      dialogue: order === 1 ? [{ speakerId: 'actor', text: 'TEST原台词逐字保留', tone: 'TEST语气', pace: 'TEST语速' }] : [], prompts: { firstFrame: { ...prompt }, video: { ...prompt } } })) }, 'TEST原台词逐字保留');
}
function selectedDesign(value: PetStoryPlan): object {
  return JSON.parse(JSON.stringify({ ...value, shots: value.shots.map(({ prompts: _prompts, ...shot }): object => { void _prompts; return shot; }) })) as object;
}
function timedThreeShotPlan(durations: [number, number, number]): PetStoryPlan {
  const value = plan(); const third = structuredClone(value.shots[1]);
  third.id = 'shot_3'; third.order = 3; third.action = 'TEST动作3'; third.startState = 'TEST开始3'; third.endState = 'TEST结束3'; value.shots.push(third);
  let elapsed = 0;
  value.shots.forEach((shot: PetStoryPlan['shots'][number], index: number): void => {
    shot.durationSeconds = durations[index]; shot.timing = `TEST ${elapsed}～${elapsed + shot.durationSeconds}秒完成本镜原动作`; elapsed += shot.durationSeconds;
    delete shot.timingPlan;
  });
  return withOfflineTimingPlan(value, 'TEST原台词逐字保留');
}
function target(requestId = 'TEST-click', baseJobId?: string): PetStoryRuntimeTarget {
  return { background: 'canvas', planFeedback: { text: feedbackText, requestId, ...(baseJobId ? { baseJobId } : {}) } };
}
function facts(job: PetStoryChatJob): Record<string, unknown> {
  const block = stored.find((task: Task): boolean => task.id === job.taskId)!.prompt.split('【当前事实与本次附件】\n')[1].split('\n\n【结果约定】')[0];
  return JSON.parse(block.match(/^(`{3,})json\n([\s\S]*)\n\1$/)![2]) as Record<string, unknown>;
}
async function prepare(input: PetStoryRuntimeTarget): Promise<PetStoryChatJob> {
  const result = await service.prepareRuntime(p.id, p.revision, 'analysis', input); p = result.project!; return p.jobs.at(-1)!;
}
async function finish(job: PetStoryChatJob, incoming: PetStoryPlan, invalid = false): Promise<PetStoryChatJob> {
  const task = stored.find((item: Task): boolean => item.id === job.taskId)!; const now = new Date().toISOString();
  const answer = { ...incoming, requestId: job.requestId, targetIds: job.expectedIds, storyUsable: true, contentBasis: { beginning: 'TEST开头', middle: 'TEST变化', ending: 'TEST结局' },
    shots: incoming.shots.map(({ prompts: _prompts, ...shot }: PetStoryPlan['shots'][number], index: number): object => { void _prompts; return invalid && !index ? { ...shot, durationSeconds: '5' } : shot; }) };
  const runtime: TaskRunSnapshot = { runId: `TEST-run-${job.id}`, attempt: 1, stage: 'completed', message: 'TEST 离线回复', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
    input: { mode: 'chat', prompt: task.prompt, attachments: task.attachments || [] }, chatResponse: { text: JSON.stringify(answer), capturedAt: now } };
  const updated = core.updateRuntime({ taskId: task.id, status: 'done', errorInfo: null, runtime }); if (!updated.success) throw new Error(updated.error);
  p = (await service.bindRun(p.id, job.id, runtime.runId)).project!;
  p = (await service.collect(p.id, job.id)).project!; return p.jobs.find((item: PetStoryChatJob): boolean => item.id === job.id)!;
}
async function capturedFeedback(): Promise<PetStoryChatJob> {
  const job = await prepare(target()); await finish(job, plan());
  const captured = p.jobs.find((item: PetStoryChatJob): boolean => item.id === job.id)!;
  captured.status = 'captured'; captured.parsedResult = undefined; captured.resultStatus = undefined;
  p = await projects.write(p); stored[0].runtime!.chatResponse = undefined;
  return p.jobs.find((item: PetStoryChatJob): boolean => item.id === job.id)!;
}
beforeEach(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-plan-feedback-')); projects = new PetStoryProjects(); p = await projects.create(directory, 'TEST-studio', 'TEST-feedback-account');
  p = await projects.saveMobileStory(p.id, p.revision, 'TEST 完整原剧本\nTEST角色说：“TEST原台词逐字保留”\nTEST完整结局');
  p.plan = plan(); p.materials = syncMaterials(p); p.assets = [{ id: 'TEST-existing-image', kind: 'plannedEndImage', shotId: 'shot_2', relativePath: 'shots/shot_2/TEST-existing.png' }];
  await fs.mkdir(path.join(directory, 'shots/shot_2'), { recursive: true }); await fs.writeFile(path.join(directory, p.assets[0].relativePath), 'TEST 离线素材占位');
  p = await projects.write(p);
  stored = []; let sequence = 0;
  core = new TaskService({ store: { read: (): Task[] => structuredClone(stored), replace: (items: Task[]): boolean => { stored = structuredClone(items); return true; } },
    defaultProjectId: (): string => p.studioProjectId, id: (): string => `TEST-task-${++sequence}` });
  port = { list: (): Task[] => structuredClone(stored), create: (input: TaskAddParams, accountId: string): Task => {
    const created = core.create(input); if (!created.success) throw new Error(created.error);
    const assigned = core.assign({ taskId: created.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error); return assigned.data;
  } };
  service = new PetStoryChatService(projects, port);
});
afterEach(async (): Promise<void> => { releaseConversationGuard(p.accountId, 'TEST-existing-adjustment'); await fs.rm(directory, { recursive: true, force: true }); });

describe('完整方案的反馈任务', (): void => {
  it.each([true, false])('通用启动遗漏job.runId后仅凭唯一已完成原运行和严格回读证据恢复收取（有新归属标记=%s），不改Task或重发', async (marked: boolean): Promise<void> => {
    const root = await prepare(target()); await finish(root, plan());
    const task = stored.find((item: Task): boolean => item.id === root.taskId)!; const runtime = task.runtime!;
    const update = core.updateRuntime({ taskId: task.id, runtime: { input: { ...runtime.input, promptReadback: task.promptReadback }, chatReadback: { runId: runtime.runId, baselineMessageCount: 0, requestId: root.requestId, targetIds: root.expectedIds,
      association: 'recorded_turn', userTurnId: 'TEST-user', assistantTurnId: 'TEST-assistant', observedAt: new Date().toISOString() } } });
    expect(update.success).toBe(true);
    if (!marked) delete stored.find((item: Task): boolean => item.id === root.taskId)!.petstoryChat;
    const saved = p.jobs.find((job: PetStoryChatJob): boolean => job.id === root.id)!;
    saved.status = 'bound'; saved.runId = undefined; saved.rawText = undefined; saved.parsedResult = undefined; saved.resultStatus = undefined;
    p = await projects.write(p); const beforeTasks = structuredClone(stored);
    service = new PetStoryChatService(projects, port);
    const collected = await service.collect(p.id, root.id); p = collected.project!;
    expect(collected.success).toBe(true);
    expect(p.jobs.find((job: PetStoryChatJob): boolean => job.id === root.id)).toMatchObject({ runId: runtime.runId, status: 'applied', resultStatus: 'candidate' });
    expect(stored).toEqual(beforeTasks); expect(stored).toHaveLength(1);
  });

  it.each(['project', 'job'] as const)('Task持久文字%s归属不符时bindRun与collect都拒绝，不把同输入借给另一个步骤', async (mismatch: string): Promise<void> => {
    const root = await prepare(target()); await finish(root, plan());
    const saved = p.jobs.find((job: PetStoryChatJob): boolean => job.id === root.id)!;
    saved.status = 'bound'; saved.runId = undefined; saved.rawText = undefined; saved.parsedResult = undefined; saved.resultStatus = undefined; p = await projects.write(p);
    const task = stored.find((item: Task): boolean => item.id === root.taskId)!;
    task.petstoryChat = { projectId: mismatch === 'project' ? 'other' : p.id, jobId: mismatch === 'job' ? 'other' : root.id };
    await expect(service.bindRun(p.id, root.id, task.runtime!.runId)).rejects.toThrow('绑定不符');
    await expect(service.collect(p.id, root.id)).rejects.toThrow('归属不符');
    expect((await projects.read(p.id)).revision).toBe(p.revision);
  });

  it('旧prepare入口也先生成jobId并在Task创建时持久保存文字归属', async (): Promise<void> => {
    const result = await service.prepare(p.id, 'TEST旧入口完整请求', 'analysis');
    const job = result.project!.jobs.at(-1)!;
    expect(stored.find((task: Task): boolean => task.id === job.taskId)?.petstoryChat).toEqual({ projectId: p.id, jobId: job.id });
  });

  it.each(['formal-conflict', 'parent-inherited'] as const)('正式、选定与待修原回复ID完整入请求，%s按准确结构问题处理且必要技术修复可收敛', async (variant: string): Promise<void> => {
    p.plan!.shots[1].id = 'formal_only'; p.materials = syncMaterials(p); p = await projects.write(p);
    const base = await prepare({ background: 'canvas' }); await finish(base, plan());
    const root = await prepare(target('TEST-reserved-all-sources', base.id)); const incoming = plan();
    incoming.shots[1].id = variant === 'formal-conflict' ? 'formal_only' : 'fresh_in_parent'; incoming.shots[1].predecessorShotIds = ['shot_2'];
    const failed = await finish(root, incoming, variant === 'parent-inherited');
    expect(failed.status).toBe('invalid');
    if (variant === 'formal-conflict') expect(failed.validationDetails).toEqual([expect.objectContaining({ code: 'structure', path: '$.shots[1].id', actual: 'formal_only', repairable: true })]);
    p = (await service.prepareRuntime(p.id, p.revision, 'repair', { parentJobId: root.id, repairMode: 'automatic' })).project!;
    const repair = p.jobs.at(-1)!;
    expect(facts(repair).reservedShotIds).toEqual(expect.arrayContaining(['shot_1', 'shot_2', 'formal_only', ...(variant === 'parent-inherited' ? ['fresh_in_parent'] : [])]));
    if (variant === 'formal-conflict') incoming.shots[1].id = 'truly_new';
    const completed = await finish(repair, incoming);
    expect(completed).toMatchObject({ status: 'applied', resultStatus: 'candidate' });
    expect(p.plan!.shots[1].id).toBe('formal_only');
  });

  it('纠正报错镜头时模型顺带重编号其他未采用合镜，按纯技术映射保留父稳定ID并直接收敛，原文完整存档', async (): Promise<void> => {
    const root = await prepare(target()); const incoming = plan();
    incoming.shots[0].id = 'fresh_parent'; incoming.shots[0].predecessorShotIds = ['shot_1']; incoming.shots[1].predecessorShotIds = ['shot_2'];
    await finish(root, incoming);
    p = (await service.prepareRuntime(p.id, p.revision, 'repair', { parentJobId: root.id, repairMode: 'automatic' })).project!;
    const repair = p.jobs.at(-1)!; const response = structuredClone(incoming); response.shots[0].id = 'fresh_alias'; response.shots[1].id = 'fresh_corrected';
    const events = response.shots[0].timingPlan!.events;
    const aliases = new Map(events.map((event, index): [string, string] => [event.id, `alias_event_${index}`]));
    for (const event of events) { event.id = aliases.get(event.id)!; if (event.afterEventId) event.afterEventId = aliases.get(event.afterEventId); }
    const completed = await finish(repair, response);
    expect(completed).toMatchObject({ status: 'applied', resultStatus: 'candidate' });
    expect(completed.parsedResult!.plan!.shots.map((shot): string => shot.id)).toEqual(['fresh_parent', 'fresh_corrected']);
    expect(completed.parsedResult!.plan!.shots[0].timingPlan).toEqual(incoming.shots[0].timingPlan);
    expect(completed.rawText).toContain('fresh_alias'); expect(completed.formatCorrections).toEqual(expect.arrayContaining([expect.stringContaining('fresh_alias→fresh_parent')]));
    expect(p.plan!.shots.map((shot): string => shot.id)).toEqual(['shot_1', 'shot_2']); expect(stored).toHaveLength(2);
  });

  it('未确认方案也能直接反馈，原剧本、完整选定方案、用户要求和完整返回合同均入请求', async (): Promise<void> => {
    const before = structuredClone(p); const job = await prepare(target());
    const request = stored[0].prompt; const data = facts(job);
    expect(job).toMatchObject({ kind: 'analysis', status: 'bound', background: 'canvas', expectedIds: ['plan'], planFeedback: target().planFeedback });
    expect((data.source as { originalText: string }).originalText).toBe(before.mobileStory!.text);
    expect(data.userPlanFeedback).toMatchObject({ text: feedbackText, selectedPlan: selectedDesign(before.plan!), sourceStatus: 'current_saved_plan' });
    expect(request).not.toContain(oldPrompt);
    expect(request).toContain('contentBasis:{beginning,middle,ending}'); expect(request).toContain('不返回prompts或媒体正文'); expect(request).toContain('稳定实体ID');
    expect(p.plan).toEqual(before.plan); expect(p.assets).toEqual(before.assets); expect(p.storyApproval).toBeUndefined(); expect(p.chatAdjustment).toBeUndefined(); expect(hasConversationGuard(p.accountId)).toBe(false);
    expect(stored).toHaveLength(1); expect(stored[0]).toMatchObject({ mode: 'chat', executionIntent: 'hold', assignedAccountId: p.accountId });
    expect(stored[0].petstoryChat).toEqual({ projectId: p.id, jobId: job.id });
    expect(stored[0].runtime?.submittedAt).toBeUndefined();
  });

  it('修改明确选中的未采用候选，后续完整新候选仍不覆盖当前方案、媒体或原候选', async (): Promise<void> => {
    const original = structuredClone(p); const base = await prepare({ background: 'canvas' });
    const selected = plan(); selected.shots[0].camera = 'TEST选中候选的不同机位'; await finish(base, selected);
    const candidate = p.jobs.find((job: PetStoryChatJob): boolean => job.id === base.id)!;
    const input = target('TEST-from-candidate', candidate.id); const revision = p.revision; const next = await prepare(input);
    expect((facts(next).userPlanFeedback as { selectedPlan: object }).selectedPlan).toEqual(selectedDesign(candidate.parsedResult!.plan!));
    expect(stored.at(-1)!.prompt).not.toContain(oldPrompt);
    const retried = await service.prepareRuntime(p.id, revision, 'analysis', input);
    expect(retried.taskId).toBe(next.taskId); expect(stored).toHaveLength(2);
    const adjusted = structuredClone(candidate.parsedResult!.plan!); adjusted.shots[0].camera = 'TEST本次反馈后的机位';
    const completed = await finish(next, adjusted);
    expect(completed).toMatchObject({ status: 'applied', resultStatus: 'candidate' });
    expect(selectedDesign(completed.parsedResult!.plan!)).toEqual(selectedDesign(adjusted));
    expect(p.plan).toEqual(original.plan); expect(p.assets).toEqual(original.assets); expect(p.jobs.find((job: PetStoryChatJob): boolean => job.id === base.id)?.parsedResult).toEqual(candidate.parsedResult);
    expect(p.storyApproval).toBeUndefined(); expect(stored).toHaveLength(2);
  });

  it('同一点击并发及重新打开后的旧 revision 重试只返回唯一原任务，已提交运行不被改写', async (): Promise<void> => {
    const revision = p.revision; const input = target();
    const results = await Promise.all([service.prepareRuntime(p.id, revision, 'analysis', input), service.prepareRuntime(p.id, revision, 'analysis', input)]);
    expect(results[0].taskId).toBe(results[1].taskId); p = results[0].project!; expect(p.jobs).toHaveLength(1); expect(stored).toHaveLength(1);
    const job = p.jobs[0]; await finish(job, plan()); const before = structuredClone(stored);
    const reopened = new PetStoryChatService(projects, port); const retried = await reopened.prepareRuntime(p.id, revision, 'analysis', input);
    expect(retried.project!.jobs).toHaveLength(1); expect(retried.taskId).toBeUndefined(); expect(stored).toEqual(before);
  });

  it('同一标识不能用于不同意图或不同来源，并发时也拒绝替换内容', async (): Promise<void> => {
    const input = target(); const opening = service.prepareRuntime(p.id, p.revision, 'analysis', input);
    await expect(service.prepareRuntime(p.id, p.revision, 'analysis', { ...input, planFeedback: { ...input.planFeedback!, text: 'TEST另一项要求' } })).rejects.toThrow('其他内容');
    p = (await opening).project!;
    await expect(service.prepareRuntime(p.id, p.revision, 'analysis', { ...input, planFeedback: { ...input.planFeedback!, baseJobId: 'TEST-other-base' } })).rejects.toThrow('其他内容');
    expect(stored).toHaveLength(1);
  });

  it('重开项目后可从已捕获的完整原文继续只读解析，不要求再回平台或创建任务', async (): Promise<void> => {
    const captured = await capturedFeedback(); const tasksBefore = structuredClone(stored); const planBefore = structuredClone(p.plan);
    projects = new PetStoryProjects(); p = await projects.open(directory); service = new PetStoryChatService(projects, port);
    const collected = await service.collect(p.id, captured.id); p = collected.project!;
    expect(collected.success).toBe(true); expect(p.jobs.at(-1)).toMatchObject({ id: captured.id, status: 'applied', resultStatus: 'candidate', rawText: captured.rawText });
    expect(p.jobs.at(-1)?.parsedResult?.plan?.shots).toHaveLength(2);
    expect(p.plan).toEqual(planBefore); expect(stored).toEqual(tasksBefore);
  });

  it('Task正文仍存在时优先完整使用该正文，不与已捕获版本拼接或混用', async (): Promise<void> => {
    const captured = await capturedFeedback(); const authoritative = JSON.parse(captured.rawText!) as { shots: { camera: string }[] };
    authoritative.shots[0].camera = 'TEST原运行权威正文的新机位';
    stored[0].runtime!.chatResponse = { text: JSON.stringify(authoritative), capturedAt: new Date().toISOString() };
    const tasksBefore = structuredClone(stored); const result = await service.collect(p.id, captured.id);
    expect(result.success).toBe(true); expect(result.project!.jobs.at(-1)?.rawText).toBe(JSON.stringify(authoritative));
    expect(result.project!.jobs.at(-1)?.parsedResult?.plan?.shots[0].camera).toBe('TEST原运行权威正文的新机位'); expect(stored).toEqual(tasksBefore);
  });

  it.each(['not-captured', 'empty-raw', 'empty-response', 'no-submit', 'run', 'input', 'input-mode', 'attachments', 'account', 'project', 'source', 'story'] as const)('已保存原文的 %s 证据不符仍拒绝恢复，不写入候选或改动任务', async (mismatch: 'not-captured' | 'empty-raw' | 'empty-response' | 'no-submit' | 'run' | 'input' | 'input-mode' | 'attachments' | 'account' | 'project' | 'source' | 'story'): Promise<void> => {
    const captured = await capturedFeedback(); const saved = p.jobs.find((item: PetStoryChatJob): boolean => item.id === captured.id)!; const task = stored[0];
    if (mismatch === 'not-captured') saved.status = 'bound';
    if (mismatch === 'empty-raw') saved.rawText = undefined;
    if (mismatch === 'empty-response') task.runtime!.chatResponse = { text: '', capturedAt: new Date().toISOString() };
    if (mismatch === 'no-submit') task.runtime!.submittedAt = undefined;
    if (mismatch === 'run') task.runtime!.runId = 'TEST-other-run';
    if (mismatch === 'input') task.runtime!.input.prompt = 'TEST-other-input';
    if (mismatch === 'input-mode') task.runtime!.input.mode = 'image';
    if (mismatch === 'attachments') task.runtime!.input.attachments = ['TEST-other-attachment'];
    if (mismatch === 'account') task.assignedAccountId = 'TEST-other-account';
    if (mismatch === 'project') task.projectId = 'TEST-other-studio';
    if (mismatch === 'source') saved.sourceUrl = 'TEST-other-source';
    if (mismatch === 'story') saved.sourceStoryId = 'TEST-other-story';
    p = await projects.write(p); const projectBefore = await fs.readFile(path.join(directory, 'project.json'), 'utf8'); const tasksBefore = structuredClone(stored);
    await expect(service.collect(p.id, saved.id)).rejects.toThrow();
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(projectBefore); expect(stored).toEqual(tasksBefore);
  });

  it.each(['empty', 'long', 'bad-id', 'non-plan', 'wrong-kind'] as const)('无效反馈 %s 不创建任务', async (variant: 'empty' | 'long' | 'bad-id' | 'non-plan' | 'wrong-kind'): Promise<void> => {
    const input = target();
    if (variant === 'empty') input.planFeedback!.text = '  ';
    if (variant === 'long') input.planFeedback!.text = 'a'.repeat(8001);
    if (variant === 'bad-id') input.planFeedback!.requestId = '../bad';
    if (variant === 'non-plan') input.shotId = 'shot_1';
    await expect(service.prepareRuntime(p.id, p.revision, variant === 'wrong-kind' ? 'review' : 'analysis', input)).rejects.toThrow();
    expect(stored).toHaveLength(0);
  });

  it.each(['missing', 'old-story', 'stale', 'facts-changed', 'superseded'] as const)('来源为 %s 时保留当前方案，不创建反馈任务', async (variant: 'missing' | 'old-story' | 'stale' | 'facts-changed' | 'superseded'): Promise<void> => {
    const base = await prepare({}); await finish(base, plan());
    const saved = p.jobs.find((job: PetStoryChatJob): boolean => job.id === base.id)!;
    if (variant === 'old-story') saved.sourceStoryId = 'TEST-other-story';
    if (variant === 'stale') saved.resultStatus = 'stale';
    if (variant === 'facts-changed') p.plan!.shots[0].action += 'TEST用户改变事实';
    if (variant === 'superseded') { await prepare({}); await finish(p.jobs.at(-1)!, plan()); }
    else p = await projects.write(p);
    const count = stored.length; const before = structuredClone(p.plan);
    await expect(service.prepareRuntime(p.id, p.revision, 'analysis', target('TEST-new-click', variant === 'missing' ? 'TEST-missing' : base.id))).rejects.toThrow('选定方案');
    expect(stored).toHaveLength(count); expect((await projects.read(p.id)).plan).toEqual(before);
  });

  it('自动格式修订完整继承本次反馈与选中方案，修好后仍只形成候选', async (): Promise<void> => {
    const before = structuredClone(p); const job = await prepare(target()); const failed = await finish(job, plan(), true);
    expect(failed.status).toBe('invalid'); expect(failed.validationDetails?.some((issue): boolean => issue.path === '$.shots[0].durationSeconds')).toBe(true);
    const repairResult = await service.prepareRuntime(p.id, p.revision, 'repair', { parentJobId: job.id, repairMode: 'automatic' }); p = repairResult.project!;
    const repair = p.jobs.at(-1)!; expect(repair).toMatchObject({ kind: 'repair', originKind: 'analysis', planFeedback: job.planFeedback, background: 'canvas' });
    const data = facts(repair); expect(data.userPlanFeedback).toMatchObject({ text: feedbackText, selectedPlan: selectedDesign(before.plan!) });
    expect(stored.at(-1)!.prompt).toContain(feedbackText); expect(stored.at(-1)!.prompt).toContain('$.shots[0].durationSeconds');
    const completed = await finish(repair, plan()); expect(completed).toMatchObject({ status: 'applied', resultStatus: 'candidate' });
    expect(p.plan).toEqual(before.plan); expect(p.assets).toEqual(before.assets); expect(stored).toHaveLength(2);
    const fromRepair = await prepare(target('TEST-after-repair', completed.id));
    expect(fromRepair.planFeedback?.baseJobId).toBe(completed.id);
    expect((facts(fromRepair).userPlanFeedback as { selectedPlan: object }).selectedPlan).toEqual(selectedDesign(completed.parsedResult!.plan!));
  });

  it('相同自前身错误及完整回复连续三次未变化时暂停，显式继续仍可修好并再次修改方案', async (): Promise<void> => {
    const before = structuredClone(p); const root = await prepare(target()); const bad = plan();
    bad.shots[1].predecessorShotIds = ['shot_2'];
    let current = await finish(root, bad);
    for (let index = 0; index < 2; index += 1) {
      p = (await service.prepareRuntime(p.id, p.revision, 'repair', { parentJobId: current.id, repairMode: 'automatic' })).project!;
      current = await finish(p.jobs.at(-1)!, bad);
    }
    const stopped = await service.collect(p.id, current.id); p = stopped.project!;
    expect(stopped).toMatchObject({ success: false, needsRepair: false, error: expect.stringContaining('自动修订没有进展') });
    const tasksBefore = structuredClone(stored);
    await expect(service.prepareRuntime(p.id, p.revision, 'repair', { parentJobId: current.id, repairMode: 'automatic' })).rejects.toThrow('自动修订没有进展');
    expect(stored).toEqual(tasksBefore); expect(p.plan).toEqual(before.plan); expect(p.assets).toEqual(before.assets);
    const firstRequest = p.jobs[0].requestText;
    const repair = p.jobs.at(-1)!; const data = facts(repair);
    expect(data).not.toHaveProperty('currentPlan');
    expect(data.parentResult).not.toHaveProperty('originalRequest');
    expect(data.parentResult).toMatchObject({ originalRequestArchive: { jobId: root.id, requestId: root.requestId, inputHash: root.inputHash }, originalReply: expect.any(String) });
    expect(data.userPlanFeedback).toMatchObject({ selectedPlan: selectedDesign(before.plan!) });
    expect(repair.requestText).toContain('全新镜头ID');
    expect(repair.requestText!.length).toBeLessThan(firstRequest!.length * 3);
    expect(p.jobs[0].requestText).toBe(firstRequest);
    p = (await new PetStoryProjects().open(directory)); service = new PetStoryChatService(projects, port);
    p = (await service.prepareRuntime(p.id, p.revision, 'repair', { parentJobId: current.id, repairMode: 'explicit' })).project!;
    const completed = await finish(p.jobs.at(-1)!, plan());
    expect(completed).toMatchObject({ status: 'applied', resultStatus: 'candidate' });
    const next = await prepare(target('TEST-after-stalled-repair', completed.id));
    expect(next.planFeedback?.baseJobId).toBe(completed.id); expect(p.plan).toEqual(before.plan);
  });

  it('明确节奏反馈后的已证实过载修订允许自然拆合新ID并保留对白片段与前身，采用前不覆盖', async (): Promise<void> => {
    const before = structuredClone(p); const input = target('TEST-explicit-pacing');
    input.planFeedback!.text = 'TEST前半段太拖，请节奏更紧凑，必要时拆镜或合镜';
    const root = await prepare(input); const overloaded = plan(); overloaded.shots[0].durationSeconds = 12; await finish(root, overloaded);
    p = (await service.prepareRuntime(p.id, p.revision, 'repair', { parentJobId: root.id, repairMode: 'automatic' })).project!;
    const repair = p.jobs.at(-1)!; const revised = plan(); const original = revised.shots[0];
    const sentence = original.dialogue![0].text; const characters = Array.from(sentence); const boundary = 7;
    const fragment = (id: string, start: number, end: number, order: number): PetStoryPlan['shots'][number] => ({ ...structuredClone(original), id, order,
      predecessorShotIds: [original.id], action: `${original.action} TEST离线拆分${order}`,
      dialogue: [{ ...original.dialogue![0], text: characters.slice(start, end).join(''), source: { text: sentence, occurrence: 1, start, end } }],
      timingPlan: { events: [{ id: 'speech', kind: 'dialogue', description: 'TEST原句对应片段', dialogueIndex: 0, startSeconds: 0, endSeconds: 4.6 }],
        estimatedRequiredSeconds: 4.6, durationReason: 'TEST技术拆片时间安排', cutReason: 'TEST技术语义边界' } });
    revised.shots = [fragment('shot_1_part_a', 0, boundary, 1), fragment('shot_1_part_b', boundary, characters.length, 2), { ...revised.shots[1], order: 3 }];
    const completed = await finish(repair, revised);
    expect(completed).toMatchObject({ status: 'applied', resultStatus: 'candidate' });
    expect(completed.parsedResult?.plan?.shots.map((shot): string => shot.id)).toEqual(revised.shots.map((shot): string => shot.id));
    expect(completed.parsedResult?.plan?.shots.flatMap((shot): string[] => shot.dialogue?.map((line): string => line.text) || []).join('')).toBe(sentence);
    expect(completed.parsedResult?.plan?.shots[0].predecessorShotIds).toEqual(['shot_1']);
    expect(p.plan).toEqual(before.plan); expect(p.assets).toEqual(before.assets);
    p = (await service.adoptPlanCandidate(p.id, p.revision, completed.id)).project!;
    expect(p.plan!.shots).toHaveLength(3); expect(p.assets).toEqual(before.assets);
    expect((await new PetStoryProjects().open(directory)).plan!.shots[0].timingPlan).toEqual(revised.shots[0].timingPlan);
    expect(stored).toHaveLength(2); expect(stored.every((task): boolean => task.mode === 'chat')).toBe(true);
  });

  it.each(['不要拆镜、保持节奏不变，只修人物称呼', '保持所有动作不变，只修前身映射'] as const)('结构修订不因反馈“%s”中的关键词而允许偷改动作', async (feedback: string): Promise<void> => {
    const input = target('TEST-no-implicit-restructure'); input.planFeedback!.text = feedback;
    const root = await prepare(input); const bad = plan(); bad.shots[0].predecessorShotIds = ['shot_1']; await finish(root, bad);
    p = (await service.prepareRuntime(p.id, p.revision, 'repair', { parentJobId: root.id, repairMode: 'automatic' })).project!;
    const revised = structuredClone(bad); revised.shots[0].id = 'shot_renamed'; revised.shots[0].action += ' TEST擅改原动作';
    const completed = await finish(p.jobs.at(-1)!, revised);
    expect(completed.status).toBe('invalid');
    expect(completed.validationDetails?.some((issue): boolean => issue.code === 'repair_drift' && issue.message.includes('$.shots[0].action'))).toBe(true);
  });

  it('首次分析超过10秒的明确过载可在原修订链拆镜，不用删台词或夹取数字', async (): Promise<void> => {
    const root = await prepare({}); const overloaded = plan(); overloaded.shots[1].durationSeconds = 12;
    const failed = await finish(root, overloaded); expect(failed.status).toBe('invalid');
    p = (await service.prepareRuntime(p.id, p.revision, 'repair', { parentJobId: root.id, repairMode: 'automatic' })).project!;
    const repair = p.jobs.at(-1)!; const revised = plan(); const original = revised.shots.pop()!;
    revised.shots.push({ ...structuredClone(original), id: 'shot_2_start', order: 2, predecessorShotIds: [original.id], action: 'TEST动作2前半段' },
      { ...structuredClone(original), id: 'shot_2_finish', order: 3, predecessorShotIds: [original.id], action: 'TEST动作2闭合' });
    const completed = await finish(repair, revised);
    expect(completed).toMatchObject({ status: 'applied', resultStatus: 'candidate' });
    expect(completed.parsedResult!.plan!.shots.map((shot): number => shot.durationSeconds)).toEqual([5, 5, 5]);
    expect(completed.parsedResult!.plan!.shots[0].dialogue).toEqual(overloaded.shots[0].dialogue);
    expect(p.plan!.shots).toHaveLength(2); expect(stored).toHaveLength(2);
  });

  it('明确时间结构矛盾进入现有自动修订，修好后只保存完整候选', async (): Promise<void> => {
    const before = structuredClone(p.plan); const root = await prepare({}); const invalid = plan();
    const line = invalid.shots[0].dialogue![0]; line.source = { text: line.text, occurrence: 1, start: 0, end: Array.from(line.text).length };
    invalid.shots[1].timingPlan = { events: [
      { id: 'action', kind: 'action', description: invalid.shots[1].action, startSeconds: 0, endSeconds: 4 },
      { id: 'reaction', kind: 'reaction', description: 'TEST动作完成后的必要反应', startSeconds: 3, endSeconds: 4.8, afterEventId: 'action' }],
      estimatedRequiredSeconds: 4.8, durationReason: 'TEST必要事件跨度', cutReason: 'TEST反应完成' };
    const failed = await finish(root, invalid); expect(failed.status).toBe('invalid');
    expect(failed.validationDetails?.some((issue): boolean => issue.code === 'timing')).toBe(true);
    const recollected = await service.collect(p.id, failed.id); expect(recollected.needsRepair).toBe(true); p = recollected.project!;
    p = (await service.prepareRuntime(p.id, p.revision, 'repair', { parentJobId: failed.id, repairMode: 'automatic' })).project!;
    const repair = p.jobs.at(-1)!; const corrected = structuredClone(invalid); corrected.shots[1].timingPlan!.events[1].startSeconds = 4;
    const completed = await finish(repair, corrected);
    expect(completed).toMatchObject({ status: 'applied', resultStatus: 'candidate' });
    expect(completed.parsedResult?.plan?.shots[1].timingPlan).toEqual(corrected.shots[1].timingPlan);
    expect(p.plan).toEqual(before); expect(stored).toHaveLength(2);
  });

  it.each(['inherited', 'changed-current', 'new-current', 'changed-retired', 'new-retired', 'self', 'reuse-other-id'] as const)('已合并镜头的前身关系%s按基准身份校验，未改历史不误报', async (change: string): Promise<void> => {
    p.plan!.shots[1].id = 'shot_merged'; p.plan!.shots[1].predecessorShotIds = ['retired_a', 'retired_b']; p = await projects.write(p);
    const before = structuredClone(p.plan!); const input = target(`TEST-predecessor-${change}`); input.planFeedback!.text = 'TEST修正合并镜头中的持物与结束状态，保留原镜头关系';
    const root = await prepare(input); const revised = structuredClone(before); const shot = revised.shots[1];
    shot.endState += ' TEST状态修正';
    if (change === 'changed-current') shot.predecessorShotIds = ['shot_1'];
    if (change === 'new-current') { shot.id = 'shot_new'; shot.predecessorShotIds = ['shot_merged']; }
    if (change === 'changed-retired') shot.predecessorShotIds = ['retired_b', 'retired_a'];
    if (change === 'new-retired') shot.id = 'shot_new';
    if (change === 'self') shot.predecessorShotIds = ['shot_merged'];
    if (change === 'reuse-other-id') { revised.shots[0].predecessorShotIds = ['shot_merged']; shot.predecessorShotIds = ['retired_a', 'retired_b']; }
    const completed = await finish(root, revised); const valid = ['inherited', 'new-current'].includes(change);
    expect(completed.status).toBe(valid ? 'applied' : 'invalid'); expect(completed.rawText).toBeTruthy();
    if (valid) expect(completed.parsedResult?.plan?.shots[1].predecessorShotIds).toEqual(shot.predecessorShotIds);
    else expect(completed.validationDetails?.some((issue): boolean => issue.path === `$.shots[${change === 'reuse-other-id' ? 0 : 1}].predecessorShotIds`)).toBe(true);
    expect(p.plan).toEqual(before); expect(stored).toHaveLength(1); expect(stored[0].mode).toBe('chat');
  });

  it('15秒反馈的3+4+8秒原回复修为5+5+5秒时允许必要全镜时长和对应节奏调整，并可本地重收旧repair', async (): Promise<void> => {
    p.plan = timedThreeShotPlan([5, 5, 5]); p.materials = syncMaterials(p); p = await projects.write(p);
    const before = structuredClone(p); const input = target('TEST-total-15'); input.planFeedback!.text = '其他保持不变，整体视频时间控制在15秒';
    const root = await prepare(input); const failed = await finish(root, timedThreeShotPlan([3, 4, 8]));
    expect(failed.status).toBe('invalid'); expect(failed.validationDetails?.map((issue): string => issue.path)).toEqual(['$.shots[0].durationSeconds', '$.shots[1].durationSeconds']);
    p = (await service.prepareRuntime(p.id, p.revision, 'repair', { parentJobId: root.id, repairMode: 'automatic' })).project!;
    const repair = p.jobs.at(-1)!; const completed = await finish(repair, timedThreeShotPlan([5, 5, 5]));
    expect(completed).toMatchObject({ status: 'applied', resultStatus: 'candidate', planFeedback: input.planFeedback });
    expect(completed.parsedResult!.plan!.shots.map((shot): number => shot.durationSeconds)).toEqual([5, 5, 5]);
    expect(completed.parsedResult!.plan!.shots[2].timing).toBe('TEST 10～15秒完成本镜原动作');
    // 模拟旧校验器已保存的repair_drift拒绝；本次只读重新核对同一已完成任务，不再请求平台。
    const historical = p.jobs.find((job: PetStoryChatJob): boolean => job.id === repair.id)!;
    historical.status = 'invalid'; historical.parsedResult = undefined; historical.error = 'TEST旧校验器把必要时间分配判为漂移';
    historical.validationDetails = [{ code: 'repair_drift', path: '$.shots[2].durationSeconds', actualType: 'number', expected: 'TEST旧限制', repairable: false, message: historical.error }];
    p = await projects.write(p); const tasksBefore = structuredClone(stored); service = new PetStoryChatService(projects, port);
    const recollected = await service.collect(p.id, repair.id); p = recollected.project!;
    expect(recollected.success).toBe(true); expect(p.jobs.find((job: PetStoryChatJob): boolean => job.id === repair.id)).toMatchObject({ status: 'applied', resultStatus: 'candidate' });
    expect(p.plan).toEqual(before.plan); expect(p.assets).toEqual(before.assets); expect(stored).toEqual(tasksBefore); expect(stored).toHaveLength(2);
  });

  it.each(['total', 'identity', 'dialogue', 'action', 'order', 'ordinary-analysis'] as const)('总时长修订仍拒绝 %s 无关变化或未授权范围', async (change: 'total' | 'identity' | 'dialogue' | 'action' | 'order' | 'ordinary-analysis'): Promise<void> => {
    p.plan = timedThreeShotPlan([5, 5, 5]); p.materials = syncMaterials(p); p = await projects.write(p);
    const before = structuredClone(p); const root = await prepare(change === 'ordinary-analysis' ? {} : target('TEST-safe-total'));
    await finish(root, timedThreeShotPlan([3, 4, 8]));
    p = (await service.prepareRuntime(p.id, p.revision, 'repair', { parentJobId: root.id, repairMode: 'automatic' })).project!;
    const repair = p.jobs.at(-1)!; const revised = timedThreeShotPlan(change === 'total' ? [5, 5, 6] : [5, 5, 5]);
    if (change === 'identity') revised.characters[0].description += 'TEST改了角色身份';
    if (change === 'dialogue') revised.shots[0].dialogue![0].text = 'TEST改了原台词';
    if (change === 'action') revised.shots[2].action += 'TEST改了剧情动作';
    if (change === 'order') { [revised.shots[0], revised.shots[1]] = [revised.shots[1], revised.shots[0]]; revised.shots.forEach((shot: PetStoryPlan['shots'][number], index: number): void => { shot.order = index + 1; }); }
    const collected = await finish(repair, revised);
    expect(collected.status).toBe('invalid');
    if (change === 'dialogue') expect(collected.validationDetails?.some((issue): boolean => issue.code === 'timing' && issue.path.includes('.dialogue'))).toBe(true);
    else expect(collected.validationDetails?.some((issue): boolean => issue.code === 'repair_drift')).toBe(true);
    expect(p.plan).toEqual(before.plan); expect(p.assets).toEqual(before.assets); expect(stored).toHaveLength(2);
  });

  it.each(['generating', 'waiting_verification', 'lock'] as const)('其他项目在同账号存在 %s 原运行时仍拒绝新反馈，不改变原任务', async (status: 'generating' | 'waiting_verification' | 'lock'): Promise<void> => {
    const added = core.create({ prompts: ['TEST其他原任务'], mode: 'chat', executionIntent: 'hold', projectId: 'TEST-other-studio' }); if (!added.success) throw new Error(added.error);
    const assigned = core.assign({ taskId: added.data[0].id, accountId: p.accountId }); if (!assigned.success) throw new Error(assigned.error);
    const task = stored[0]; task.status = status === 'lock' ? 'paused' : status;
    if (status === 'lock') task.lock = { ownerId: 'TEST-owner', acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    const before = structuredClone(stored);
    await expect(service.prepareRuntime(p.id, p.revision, 'analysis', target())).rejects.toThrow(/原账号/);
    expect(stored).toEqual(before);
  });

  it.each(['job', 'task-binding', 'run-binding'] as const)('通过 %s 明确关联本短剧的提交不明任务仍阻断新反馈', async (binding: 'job' | 'task-binding' | 'run-binding'): Promise<void> => {
    if (binding === 'job') await prepare({});
    else {
      const added = core.create({ prompts: ['TEST当前短剧原任务'], mode: 'chat', executionIntent: 'hold', projectId: p.studioProjectId }); if (!added.success) throw new Error(added.error);
      const assigned = core.assign({ taskId: added.data[0].id, accountId: p.accountId }); if (!assigned.success) throw new Error(assigned.error);
    }
    const task = stored[0]; const now = new Date().toISOString();
    task.status = 'paused'; task.errorInfo = { code: 'submission_uncertain', message: 'TEST本短剧原结果待核对', recoverable: true, detectedAt: now };
    task.runtime ||= { runId: 'TEST-original-run', attempt: 1, stage: 'paused', message: 'TEST原记录', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      submittedAt: now, input: { mode: 'chat', prompt: task.prompt, attachments: [] } };
    if (binding === 'task-binding') task.petstory = { projectId: p.id, stepId: 'TEST-current-step' };
    if (binding === 'run-binding') task.runtime.input.petstory = { projectId: p.id, stepId: 'TEST-current-step' };
    const before = structuredClone(stored);
    await expect(service.prepareRuntime(p.id, p.revision, 'analysis', target())).rejects.toThrow('提交结果待核对');
    expect(stored).toEqual(before);
  });

  it.each(['other-studio', 'same-studio-other-petstory', 'same-studio-unlinked', 'expired-lock'] as const)('无活跃租约的 %s 历史提交不明记录不占用本次明确新方案请求', async (history: 'other-studio' | 'same-studio-other-petstory' | 'same-studio-unlinked' | 'expired-lock'): Promise<void> => {
    const added = core.create({ prompts: ['TEST其他历史请求，保留独立恢复'], mode: 'chat', executionIntent: 'hold', projectId: history === 'other-studio' ? 'TEST-other-studio' : p.studioProjectId }); if (!added.success) throw new Error(added.error);
    const assigned = core.assign({ taskId: added.data[0].id, accountId: p.accountId }); if (!assigned.success) throw new Error(assigned.error);
    const task = stored[0]; const now = new Date().toISOString();
    task.status = 'paused'; task.errorInfo = { code: 'submission_uncertain', message: 'TEST其他项目历史提交待核对', recoverable: true, detectedAt: now };
    task.runtime = { runId: 'TEST-old-run', attempt: 1, stage: 'paused', message: 'TEST其他历史任务', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      submittedAt: now, input: { mode: 'chat', prompt: task.prompt, attachments: [] } };
    if (history === 'same-studio-other-petstory') {
      task.petstory = { projectId: 'TEST-other-petstory', stepId: 'TEST-other-step' }; task.runtime.input.petstory = { ...task.petstory };
    }
    if (history === 'expired-lock') task.lock = { ownerId: 'TEST-old-owner', acquiredAt: new Date(Date.now() - 120000).toISOString(), expiresAt: new Date(Date.now() - 60000).toISOString() };
    const previous = structuredClone(task); const previousPlan = structuredClone(p.plan); const input = target('TEST-fresh-plan-adjustment');
    const job = await prepare(input);
    expect(stored).toHaveLength(2); expect(stored[0]).toEqual(previous); expect(p.plan).toEqual(previousPlan);
    expect(job).toMatchObject({ kind: 'analysis', planFeedback: input.planFeedback, status: 'bound' });
    expect(job.taskId).not.toBe(task.id); expect(stored[1]).toMatchObject({ id: job.taskId, status: 'queued', executionIntent: 'hold' });
    expect(stored[1].runtime).toBeUndefined();
    const retried = await service.prepareRuntime(p.id, p.revision - 1, 'analysis', input);
    expect(retried.taskId).toBe(job.taskId); expect(stored).toHaveLength(2); expect(stored[0]).toEqual(previous);
  });

  it.each(['expired-lock', 'failed'] as const)('历史 %s 不妨碍明确的新方案要求，不复用或重发历史任务', async (status: 'expired-lock' | 'failed'): Promise<void> => {
    const added = core.create({ prompts: ['TEST其他历史任务'], mode: 'chat', executionIntent: 'hold', projectId: 'TEST-other-studio' }); if (!added.success) throw new Error(added.error);
    const assigned = core.assign({ taskId: added.data[0].id, accountId: p.accountId }); if (!assigned.success) throw new Error(assigned.error);
    const task = stored[0]; task.status = status === 'failed' ? 'fail' : 'paused';
    if (status === 'expired-lock') task.lock = { ownerId: 'TEST-old-owner', acquiredAt: new Date(Date.now() - 120000).toISOString(), expiresAt: new Date(Date.now() - 60000).toISOString() };
    const history = structuredClone(task); const job = await prepare(target());
    expect(stored).toHaveLength(2); expect(stored[0]).toEqual(history); expect(job.taskId).not.toBe(task.id);
  });

  it('仍保留已有自由会话保护，反馈流程自身不创建新保护', async (): Promise<void> => {
    claimConversationGuard(p.accountId, p.id, 'TEST-existing-adjustment');
    await expect(service.prepareRuntime(p.id, p.revision, 'analysis', target())).rejects.toThrow('结束当前调整');
    expect(stored).toHaveLength(0); expect(hasConversationGuard(p.accountId)).toBe(true);
  });
});
