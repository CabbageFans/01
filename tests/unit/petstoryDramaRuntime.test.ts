/** 离线协议／状态测试：模拟回复仅验证宿主，不代表豆包内容或媒体验收。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PetStoryCapability, PetStoryChatJob, PetStoryMaterialEditIntent, PetStoryPlan, PetStoryProject, PetStoryPrompt, PetStoryReviewIssue, PetStoryRuntimeTarget, Task, TaskAddParams, TaskRunSnapshot } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { PetStoryChatService } from '../../main/utils/petstoryChat';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { syncMaterials } from '../../main/utils/petstoryMaterials';
import { compileMaterialPrompt, compilePrompt } from '../../main/utils/petstoryPromptQuality';
import { PetStoryProductionService } from '../../main/utils/petstoryProduction';
import { buildPetStoryPromptExport } from '../../main/utils/petstoryExport';

const prompt = (body: string): PetStoryPrompt => ({ original: body, optimized: body, final: body, edited: false, rulesVersion: 'TEST-old' });
function capability(accountId = 'TEST-account'): PetStoryCapability {
  const entry = { state: 'unknown' as const, free: 'unknown' as const, reason: 'TEST 仅文字模型选择，媒体能力未知' };
  return { accountId, checkedAt: '2026-10-25T01:00:00.000Z', freeEvidence: 'unknown', durations: [5, 6], image: entry,
    modes: { first_frame: entry, first_last_frame: entry, reference: entry }, videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' } };
}
function technicalPlan(count = 2): PetStoryPlan {
  return { sourceSummary: 'TEST 技术占位', adaptedStory: 'TEST 当前确认原文', understanding: 'TEST 来源对应', sceneDesign: 'TEST 空间关系', characters: [], props: [],
    scenes: [{ id: 'location', name: 'TEST地点', location: 'TEST地点', time: '未指定', lighting: '待确认', layout: 'TEST布局', view: 'TEST视角', designOrigin: 'proposed' }],
    shots: Array.from({ length: count }, (_, index): PetStoryPlan['shots'][number] => ({ id: `shot-${index}`, order: index + 1, characterIds: [], propIds: [], propStates: [], sceneId: 'location', scene: 'TEST地点',
      startState: `TEST起点${index}`, action: `TEST过程${index}`, endState: `TEST终点${index}`, durationSeconds: 5, transition: 'cut', requestedMode: 'reference',
      prompts: { firstFrame: prompt(`TEST首帧${index}`), video: prompt(`TEST视频${index}`) } })) };
}
let directory: string; let projects: PetStoryProjects; let p: PetStoryProject; let core: TaskService; let chat: PetStoryChatService; let tasks: () => Task[];
beforeEach(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-drama-runtime-'));
  projects = new PetStoryProjects(); p = await projects.create(directory, 'TEST-studio', 'TEST-account');
  p = await projects.saveMobileStory(p.id, p.revision, 'TEST 当前确认原文'); p.plan = technicalPlan(); p.materials = syncMaterials(p); p = await projects.write(p);
  let stored: Task[] = []; let sequence = 0; tasks = (): Task[] => structuredClone(stored);
  core = new TaskService({ store: { read: tasks, replace: (items: Task[]): boolean => { stored = structuredClone(items); return true; } }, defaultProjectId: (): string => 'TEST-studio', id: (): string => `TEST-task-${++sequence}` });
  const create = (input: TaskAddParams, accountId: string): Task => { const created = core.create(input); if (!created.success) throw new Error(created.error);
    const assigned = core.assign({ taskId: created.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error); return assigned.data; };
  chat = new PetStoryChatService(projects, { list: tasks, create });
});
afterEach(async (): Promise<void> => { await fs.rm(directory, { recursive: true, force: true }); });
async function prepare(kind: PetStoryChatJob['kind'], target?: PetStoryRuntimeTarget): Promise<PetStoryChatJob> {
  p = await projects.read(p.id); const result = await chat.prepareRuntime(p.id, p.revision, kind, target); p = result.project!;
  return p.jobs[p.jobs.length - 1];
}
async function finish(job: PetStoryChatJob, result: Record<string, unknown>, badIds = false, rawOverride?: string): Promise<PetStoryProject> {
  const task = tasks().find((t): boolean => t.id === job.taskId)!; const now = new Date().toISOString();
  const text = rawOverride ?? JSON.stringify({ requestId: job.requestId, targetIds: badIds ? ['wrong-target'] : job.expectedIds, ...result });
  const runtime: TaskRunSnapshot = { runId: `TEST-run-${job.id}`, attempt: 1, stage: 'completed', message: 'TEST离线完成', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
    input: { prompt: task.prompt, mode: 'chat', attachments: task.attachments || [] }, chatResponse: { text, capturedAt: now } };
  const updated = core.updateRuntime({ taskId: task.id, status: 'done', runtime }); if (!updated.success) throw new Error(updated.error);
  if (!job.runId) await chat.bindRun(p.id, job.id, runtime.runId);
  const collected = await chat.collect(p.id, job.id); p = collected.project!; return p;
}
function issue(id: string, targetId: string, severity: PetStoryReviewIssue['severity']): PetStoryReviewIssue {
  return { id, targetId, severity, evidence: `TEST-${id}-具体证据`, impact: `TEST-${id}-制作影响`, requestedChange: `TEST-${id}-修订目标` };
}
function requestFacts(job: PetStoryChatJob): Record<string, unknown> {
  const block = tasks().find((task): boolean => task.id === job.taskId)!.prompt.split('【当前事实与本次附件】\n')[1].split('\n\n【结果约定】')[0];
  const fenced = block.match(/^(`{3,})json\n([\s\S]*)\n\1$/);
  return JSON.parse(fenced?.[2] || block) as Record<string, unknown>;
}
async function pauseUncertain(job: PetStoryChatJob, submitted = true): Promise<Task> {
  const task = tasks().find((item): boolean => item.id === job.taskId)!; const now = new Date().toISOString();
  const runtime: TaskRunSnapshot = { runId: `TEST-paused-${job.id}`, attempt: 1, stage: 'paused', message: 'TEST原提交不确定，禁止重发', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
    ...(submitted ? { submittedAt: now } : {}), input: { prompt: task.prompt, mode: 'chat', attachments: task.attachments || [] } };
  const updated = core.updateRuntime({ taskId: task.id, status: 'paused', errorInfo: { code: 'submission_uncertain', message: 'TEST保留原任务', recoverable: true, detectedAt: now }, runtime });
  if (!updated.success) throw new Error(updated.error);
  p = (await chat.bindRun(p.id, job.id, runtime.runId)).project!;
  return tasks().find((item): boolean => item.id === task.id)!;
}

describe('drama runtime 完整正文与候选采用', (): void => {
  it.each(['analysis', 'assets'] as const)('%s新建素材只保存设计预览，收取并采用材料Chat正文后才可制作和导出', async (stage: 'analysis' | 'assets'): Promise<void> => {
    if (stage === 'analysis') { p.plan = undefined; p.materials = undefined; p = await projects.write(p); }
    const job = await prepare(stage);
    if (stage === 'analysis') await finish(job, { ...technicalPlan(), storyUsable: true, reason: 'TEST完整来源', contentBasis: { beginning: 'TEST开头', middle: 'TEST经过', ending: 'TEST结束' } });
    else await finish(job, { characters: [], props: [{ id: 'object', name: 'TEST新增道具', aliases: [], description: 'TEST外观', keyStates: 'TEST状态', appearanceState: 'TEST静态', scale: 'TEST比例', designOrigin: 'script' }], scenes: p.plan!.scenes,
      shotBindings: p.plan!.shots.map((shot): object => ({ shotId: shot.id, characterIds: [], propIds: ['object'], propStates: [{ propId: 'object', state: 'TEST起点' }], sceneId: 'location' })) });
    const id = stage === 'analysis' ? 'scene:location' : 'prop:object';
    const material = p.materials!.find((item): boolean => item.id === id)!;
    expect(material.prompt.original.trim()).not.toBe(''); expect(material.prompt.final).toBe(''); expect(material.prompt.optimized).toBe('');
    expect((await new PetStoryProjects().open(directory)).materials!.find((item): boolean => item.id === id)!.prompt.final).toBe('');
    expect((): unknown => compileMaterialPrompt(p, id, true)).toThrow('尚无最终正文');
    const exported = buildPetStoryPromptExport(p, []).prompts.find((entry): boolean => entry.id === id)!;
    expect(exported.modelPrompt).toBeNull(); expect(exported.final).toBe(''); expect(exported.review.warnings.join('\n')).toContain('仅供预览');
    p = await projects.confirmStory(p.id, p.revision);
    const available = capability(); available.checkedAt = new Date().toISOString(); available.freeEvidence = 'user_confirmed'; available.image = { state: 'supported', free: 'free', reason: 'TEST图片入口' };
    const production = new PetStoryProductionService(projects, { list: tasks, create: (): never => { throw new Error('TEST不得自动创建媒体'); }, adopt: (): never => { throw new Error('TEST未授权媒体'); }, retryUnsubmitted: (): never => { throw new Error('TEST未授权重试'); }, downloads: (): [] => [], download: async (): Promise<{ success: boolean; count: number; failed: number }> => ({ success: false, count: 0, failed: 0 }) });
    await expect(production.generateMaterials(p.id, p.revision, [id], available)).rejects.toThrow('尚无最终正文');
    expect((await projects.read(p.id)).production).toBeUndefined(); expect(tasks().every((task): boolean => task.mode === 'chat')).toBe(true);
    const materialJob = await prepare('materialPrompt', { materialId: id }); const body = 'TEST模型完整基础素材正文\n第二段';
    await finish(materialJob, { optimized: body }); expect(p.materials!.find((item): boolean => item.id === id)!.prompt.sourceJobId).toBe(materialJob.id);
    expect(compileMaterialPrompt(p, id).text).toBe(body); expect(buildPetStoryPromptExport(p, []).prompts.find((entry): boolean => entry.id === id)!.modelPrompt).toBe(body);
    const allowed = await production.generateMaterials(p.id, p.revision, [id], available); expect(allowed.success).toBe(true); expect(allowed.project?.production?.phase).toBe('materials');
    expect(tasks().every((task): boolean => task.mode === 'chat')).toBe(true);
  });
  it('旧无来源的素材正文原样保留但不可作为模型输入，用户明确保存正文仍可使用', async (): Promise<void> => {
    const id = p.materials![0].id; const old = 'TEST旧保存基础素材正文';
    p.materials![0].prompt = { original: old, optimized: old, final: old, edited: false, rulesVersion: 'TEST-old' };
    p.plan!.scenes![0].lighting = 'TEST设计变化'; p.materials = syncMaterials(p); p = await projects.write(p);
    expect(p.materials![0].prompt.final).toBe(old); expect(p.materials![0].prompt.needsReview).toBe(true);
    expect((): unknown => compileMaterialPrompt(p, id, true)).toThrow('缺少可核对的豆包 Chat 采用来源');
    const entry = buildPetStoryPromptExport(p, []).prompts.find((item): boolean => item.id === id)!; expect(entry.final).toBe(old); expect(entry.modelPrompt).toBeNull();
    p = await projects.confirmStory(p.id, p.revision); p = await projects.saveMaterialPrompt(p.id, p.revision, id, 'TEST用户明确手改正文');
    expect(compileMaterialPrompt(p, id).text).toBe('TEST用户明确手改正文');
    const candidate = await prepare('materialPrompt', { materialId: id }); await finish(candidate, { optimized: 'TEST新Chat候选' });
    expect(p.materials![0].prompt.final).toBe('TEST用户明确手改正文'); expect(p.materials![0].prompt.edited).toBe(true);
  });
  it.each(['current', 'manual', 'candidate', 'edited-during', 'global'] as const)('单项当前final的review error同步待复核，%s上下文不误改正文或候选', async (scope: 'current' | 'manual' | 'candidate' | 'edited-during' | 'global'): Promise<void> => {
    if (scope === 'manual') p = await projects.saveShotPrompt(p.id, p.revision, 'shot-0', 'video', 'TEST当前用户手改');
    if (scope === 'candidate') { p.plan!.shots[0].prompts.video.optimized = 'TEST未采用候选'; p = await projects.write(p); }
    const review = await prepare('review', scope === 'global' ? {} : { shotId: 'shot-0', promptKind: 'video' });
    if (scope === 'edited-during') p = await projects.saveShotPrompt(p.id, p.revision, 'shot-0', 'video', 'TEST审查期间用户新版');
    const before = structuredClone(p.plan!.shots[0].prompts.video); const tasksBefore = tasks().length;
    await finish(review, { issues: [issue('current-body-error', 'shot-0:video', 'error')] });
    expect(p.plan!.shots[0].prompts.video).toEqual({ ...before, ...(scope === 'current' ? { needsReview: true } : {}) });
    expect(p.jobs.at(-1)?.parsedResult?.issues).toHaveLength(1); expect(tasks()).toHaveLength(tasksBefore);
    expect((await new PetStoryProjects().open(directory)).plan!.shots[0].prompts.video).toEqual(p.plan!.shots[0].prompts.video);
  });
  it.each(['shot', 'material'] as const)('正式暂停且已提交不确定时可继续不同明确%s文字目标，原任务不被改动或重发', async (kind: 'shot' | 'material'): Promise<void> => {
    const original = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video' }); const paused = await pauseUncertain(original);
    const originalJob = structuredClone(p.jobs[0]);
    const next = kind === 'shot' ? await prepare('optimize', { shotId: 'shot-1', promptKind: 'firstFrame' }) : await prepare('materialPrompt', { materialId: 'scene:location' });
    expect(tasks()).toHaveLength(2); expect(tasks().find((task): boolean => task.id === original.taskId)).toEqual(paused);
    expect(p.jobs.find((job): boolean => job.id === original.id)).toEqual(originalJob); expect(next.status).toBe('bound');
    expect(tasks().find((task): boolean => task.id === next.taskId)).toMatchObject({ mode: 'chat', executionIntent: 'hold', status: 'queued' });
  });
  it.each(['same-shot', 'analysis', 'assets', 'global-review', 'captured', 'not-submitted', 'active', 'wrong-run', 'saved-reply'] as const)('暂停未决文字的继续入口仍阻断%s，原任务保持原样', async (caseName: 'same-shot' | 'analysis' | 'assets' | 'global-review' | 'captured' | 'not-submitted' | 'active' | 'wrong-run' | 'saved-reply'): Promise<void> => {
    const original = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video' }); await pauseUncertain(original, caseName !== 'not-submitted');
    if (caseName === 'captured') { p.jobs[0].status = 'captured'; p.jobs[0].rawText = 'TEST已捕获原文'; p = await projects.write(p); }
    if (caseName === 'active') core.updateRuntime({ taskId: original.taskId, status: 'generating', runtime: { stage: 'generating' } });
    if (caseName === 'wrong-run') core.updateRuntime({ taskId: original.taskId, runtime: { runId: 'TEST-other-run' } });
    if (caseName === 'saved-reply') core.updateRuntime({ taskId: original.taskId, runtime: { chatResponse: { text: 'TEST原回复已可收取', capturedAt: new Date().toISOString() } } });
    const before = tasks(); const beforeJob = structuredClone(p.jobs[0]);
    const action = caseName === 'same-shot' ? prepare('optimize', { shotId: 'shot-0', promptKind: 'firstFrame' })
      : caseName === 'analysis' || caseName === 'assets' ? prepare(caseName) : caseName === 'global-review' ? prepare('review') : prepare('optimize', { shotId: 'shot-1', promptKind: 'firstFrame' });
    await expect(action).rejects.toThrow(/待收取原任务|活动任务/); expect(tasks()).toEqual(before); expect((await projects.read(p.id)).jobs[0]).toEqual(beforeJob);
  });
  it.each(['frame', 'target', 'facts'] as const)('坏JSON回复在%s已变化后不再自动修订，原文与当前用户状态保留', async (change: 'frame' | 'target' | 'facts'): Promise<void> => {
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video' });
    if (change === 'frame') p = await projects.saveShotPrompt(p.id, p.revision, 'shot-0', 'firstFrame', 'TEST请求期间新的首帧');
    else if (change === 'target') p = await projects.saveShotPrompt(p.id, p.revision, 'shot-0', 'video', 'TEST请求期间手改视频');
    else { p.plan!.shots[0].startState = 'TEST请求期间新的确认起点'; p = await projects.write(p); }
    const current = structuredClone(p.plan); const raw = '{ TEST保留的坏JSON原回复';
    await finish(job, {}, false, raw); const collected = await chat.collect(p.id, job.id);
    expect(collected.needsRepair).toBe(false); expect(p.jobs.at(-1)).toMatchObject({ status: 'invalid', rawText: raw });
    await expect(prepare('repair', { parentJobId: job.id })).rejects.toThrow('原请求依赖');
    expect(p.plan).toEqual(current); expect(tasks()).toHaveLength(1);
  });
  it.each(['@图片 1', '@图片\n1', '@ 图片1'])('已知Seedance标签内部空白作为具体缺项保留，并随唯一修订反馈：%s', async (first: string): Promise<void> => {
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video', capability: capability() });
    const labels = job.promptTask!.references.map((ref): string => ref.order === 1 ? first : `@图片${ref.order}`).join(' ');
    const body = `${labels} TEST完整视频正文。全程无字幕、无对白文字叠加。`;
    await finish(job, { optimized: body });
    expect(p.jobs.at(-1)).toMatchObject({ status: 'invalid', parsedResult: { optimized: body } });
    expect(p.jobs.at(-1)?.validationIssues?.join('\n')).toContain('目标标签内部含空白'); expect(p.plan!.shots[0].prompts.video.final).toBe('TEST视频0');
    const repair = await prepare('repair', { parentJobId: job.id });
    const parent = requestFacts(repair).parentResult as { validationIssues: string[]; originalReply: string };
    expect(parent.validationIssues.join('\n')).toContain('目标标签内部含空白'); expect((JSON.parse(parent.originalReply) as { optimized: string }).optimized).toBe(body);
  });
  it('Seedance XML声音标签在采用前保留原候选，初次生成失败不误锁当前有效final', async (): Promise<void> => {
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video', capability: capability() });
    const labels = job.promptTask!.references.map((ref): string => `@图片${ref.order}`).join(' ');
    const body = `${labels} TEST完整动作。<声音>TEST原有环境底音</声音>。全程无字幕、无对白文字叠加。`;
    await finish(job, { optimized: body });
    expect(p.jobs.at(-1)).toMatchObject({ status: 'invalid', parsedResult: { optimized: body } }); expect(p.jobs.at(-1)?.validationIssues?.join('\n')).toContain('XML');
    expect(p.plan!.shots[0].prompts.video).toMatchObject({ final: 'TEST视频0' }); expect(p.plan!.shots[0].prompts.video.needsReview).toBeUndefined();
    expect(p.jobs.at(-1)?.rawText).toContain('<声音>TEST原有环境底音</声音>');
  });
  it('已选error的一次修订仍用XML时不再自动修订，保留原final并标记其待复核', async (): Promise<void> => {
    const original = p.plan!.shots[0].prompts.video.final;
    const review = await prepare('review', { shotId: 'shot-0', promptKind: 'video' }); await finish(review, { issues: [issue('sound-format', 'shot-0:video', 'error')] });
    const revision = await prepare('revise', { shotId: 'shot-0', promptKind: 'video', parentJobId: review.id, selectedIssueIds: ['sound-format'], capability: capability() });
    const labels = revision.promptTask!.references.map((ref): string => `@图片${ref.order}`).join(' ');
    const body = `${labels} TEST完整动作。<声音>TEST原有环境底音</声音>。全程无字幕、无对白文字叠加。`;
    await finish(revision, { optimized: body });
    expect(p.jobs.at(-1)).toMatchObject({ status: 'invalid', parsedResult: { optimized: body } });
    expect(p.plan!.shots[0].prompts.video).toMatchObject({ final: original, needsReview: true });
    const collected = await chat.collect(p.id, revision.id); expect(collected.needsRepair).toBe(false);
    await expect(prepare('repair', { parentJobId: revision.id })).rejects.toThrow('已使用一次内容修订');
    expect((await new PetStoryProjects().open(directory)).plan!.shots[0].prompts.video).toMatchObject({ final: original, needsReview: true });
  });
  it.each(['第99张参考图定义当前场景。', '{{ref:missing-material}}定义当前场景。'])('Seedream 引用错误在采用前保留候选并进入唯一一次修订：%s', async (body: string): Promise<void> => {
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'firstFrame' });
    expect(job.promptTask?.dialect).toBe('seedream');
    await finish(job, { optimized: body });
    expect(p.jobs.at(-1)).toMatchObject({ status: 'invalid', parsedResult: { optimized: body } });
    expect(p.jobs.at(-1)?.validationIssues?.join('\n')).toMatch(/引用|编号/); expect(p.plan!.shots[0].prompts.firstFrame.final).toBe('TEST首帧0');
    const repair = await prepare('repair', { parentJobId: job.id });
    expect(requestFacts(repair).parentResult).toMatchObject({ originalReply: expect.stringContaining(body) });
    const corrected = '以第1张参考图的布局和光线为参考，TEST模型返回的完整静态正文。';
    await finish(repair, { optimized: corrected }); expect(p.plan!.shots[0].prompts.firstFrame.final).toBe(corrected);
    await expect(prepare('repair', { parentJobId: job.id })).rejects.toThrow('已使用一次');
  });
  it.each([false, true])('确认剧本重复台词按说话者和发声次数保留，额外声音块才报错：同说话者=%s', async (sameSpeaker: boolean): Promise<void> => {
    p.plan!.characters = [{ id: 'speaker-a', name: 'TEST甲', role: 'main', purpose: 'TEST', description: 'TEST' }, { id: 'speaker-b', name: 'TEST乙', role: 'supporting', purpose: 'TEST', description: 'TEST' }];
    p.plan!.shots[0].characterIds = ['speaker-a', 'speaker-b'];
    p.plan!.shots[0].dialogue = [{ speakerId: 'speaker-a', text: '好', tone: '', pace: '' }, { speakerId: sameSpeaker ? 'speaker-a' : 'speaker-b', text: '好', tone: '', pace: '' }];
    p.materials = syncMaterials(p); p = await projects.write(p);
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video', capability: capability() });
    expect(job.requestText).toContain('按确认dialogue的发声次数保留');
    const labels = job.promptTask!.references.map((ref): string => `@图片${ref.order}`).join(' ');
    const body = `${labels} TEST甲整理好衣服。{TEST甲用中文说：“好”} 随后 {${sameSpeaker ? 'TEST甲' : 'TEST乙'}用中文说：“好”}。全程无字幕、无对白文字叠加。`;
    await finish(job, { optimized: body }); expect(p.jobs.at(-1)?.resultStatus).toBe('adopted'); expect(p.plan!.shots[0].prompts.video.final).toBe(body);
    const extra = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video' });
    await finish(extra, { optimized: `${body} {TEST甲用中文说：“好”}` });
    expect(p.jobs.at(-1)?.validationIssues?.join('\n')).toContain('发声次数与确认剧本不符'); expect(p.plan!.shots[0].prompts.video.final).toBe(body);
  });
  it('具体引用缺项保留完整候选与原因，一次修订携带完整原任务并由新回复采用', async (): Promise<void> => {
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video', capability: capability() });
    expect(job.promptTask?.dialect).toBe('seedance20'); expect(job.promptTask?.references.length).toBeGreaterThan(0);
    expect(job.requestText).toBe(tasks()[0].prompt);
    const original = 'TEST 原回复保留“中文”、{花括号}、<声音>与\n换行，但遗漏引用';
    await finish(job, { optimized: original });
    const invalid = p.jobs.find((item): boolean => item.id === job.id)!;
    expect(invalid).toMatchObject({ status: 'invalid', parsedResult: { optimized: original } });
    expect(invalid.validationIssues?.join('\n')).toContain('@图片');
    expect(p.plan!.shots[0].prompts.video.final).toBe('TEST视频0');
    const repair = await prepare('repair', { parentJobId: job.id });
    const request = tasks().find((task): boolean => task.id === repair.taskId)!.prompt;
    const parentResult = requestFacts(repair).parentResult as { originalReply: string; originalRequest: string };
    expect((JSON.parse(parentResult.originalReply) as { optimized: string }).optimized).toBe(original);
    expect(parentResult.originalRequest).toBe(job.requestText); expect(request).toContain(invalid.validationIssues![0]);
    const body = `TEST 完整修订正文 ${repair.promptTask!.references.map((ref): string => `@图片${ref.order}`).join(' ')}\n保留 <声音> 与 {模型原有语法}。全程无字幕、无对白文字叠加。`;
    await finish(repair, { optimized: body });
    expect(p.plan!.shots[0].prompts.video).toMatchObject({ final: body, sourceJobId: repair.id, promptTask: repair.promptTask });
    expect((await new PetStoryProjects().open(directory)).plan!.shots[0].prompts.video.promptTask).toEqual(repair.promptTask);
    await expect(prepare('repair', { parentJobId: job.id })).rejects.toThrow('已使用一次');
  });
  it('修订后仍缺标签保留第二条候选，不允许递归再修订', async (): Promise<void> => {
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video', capability: capability() });
    await finish(job, { optimized: 'TEST 缺标签的原回复' });
    const repair = await prepare('repair', { parentJobId: job.id });
    await finish(repair, { optimized: 'TEST 第二条仍缺标签的候选' });
    expect(p.jobs.at(-1)).toMatchObject({ status: 'invalid', parsedResult: { optimized: 'TEST 第二条仍缺标签的候选' } });
    expect(p.plan!.shots[0].prompts.video.final).toBe('TEST视频0');
    await expect(prepare('repair', { parentJobId: repair.id })).rejects.toThrow('具体缺项修订一次');
  });
  it('已选 Seedance 方言检查原台词声音花括号，修订原回复自身携带语法且无程序补写', async (): Promise<void> => {
    p.plan!.characters = [{ id: 'speaker', name: 'TEST角色', role: 'main', purpose: 'TEST台词测试', description: 'TEST身份' }];
    p.plan!.shots[0].characterIds = ['speaker']; p.plan!.shots[0].dialogue = [{ speakerId: 'speaker', text: 'TEST逐字台词', tone: '', pace: '' }];
    p.materials = syncMaterials(p); p = await projects.write(p);
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video', capability: capability() });
    const labels = job.promptTask!.references.map((ref): string => `@图片${ref.order}`).join(' ');
    await finish(job, { optimized: `${labels} TEST逐字台词` });
    expect(p.jobs.at(-1)?.validationIssues?.join('\n')).toContain('花括号');
    const repair = await prepare('repair', { parentJobId: job.id });
    const body = `${labels} {TEST角色用中文说：“TEST逐字台词”}\nTEST模型自己返回的完整动作。全程无字幕、无对白文字叠加。`;
    await finish(repair, { optimized: body });
    expect(p.plan!.shots[0].prompts.video.final).toBe(body); expect(p.jobs.at(-1)?.rawText).toContain('TEST角色用中文说');
  });
  it('本次请求加载实质规则，完整新正文自动采用、保存重开、编译保持一致', async (): Promise<void> => {
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'firstFrame' });
    expect(job.ruleFiles?.length).toBeGreaterThan(1); expect(job.rulesVersion).toContain('drama'); expect(job.requestId).toBeTruthy();
    const body = `TEST中文“引号”\n\n${'完整段落。\n'.repeat(500)}结尾`;
    await finish(job, { optimized: body }); const current = p.plan!.shots[0].prompts.firstFrame;
    expect(current.final).toBe(body); expect(current.sourceJobId).toBe(job.id); expect(current.edited).toBe(false);
    expect(p.jobs[0].rawText).toContain('完整段落'); expect(p.jobs[0].resultStatus).toBe('adopted');
    const reopened = await new PetStoryProjects().open(directory); expect(reopened.plan!.shots[0].prompts.firstFrame).toEqual(current);
    expect(compilePrompt(reopened, 'shot-0', 'firstFrame', undefined, true).text.endsWith(body)).toBe(true);
  });
  it('请求前已手改只新增候选，显式采用保存真实候选来源', async (): Promise<void> => {
    p = await projects.saveShotPrompt(p.id, p.revision, 'shot-0', 'video', 'TEST用户手改\n第二段');
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video' });
    await finish(job, { optimized: 'TEST本次完整新正文' });
    expect(p.plan!.shots[0].prompts.video.final).toBe('TEST用户手改\n第二段'); expect(p.jobs[0].resultStatus).toBe('candidate');
    const adopted = await chat.adoptPromptCandidate(p.id, p.revision, job.id); p = adopted.project!;
    expect(p.plan!.shots[0].prompts.video).toMatchObject({ final: 'TEST本次完整新正文', edited: false, sourceJobId: job.id });
    expect(p.plan!.shots[1].prompts.video.final).toBe('TEST视频1');
  });
  it.each(['shot', 'material'] as const)('审查%s正文不会使此前真实创作候选失去采用入口', async (scope: 'shot' | 'material'): Promise<void> => {
    const target: PetStoryRuntimeTarget = scope === 'shot' ? { shotId: 'shot-0', promptKind: 'video' } : { materialId: 'scene:location' };
    if (scope === 'shot') p = await projects.saveShotPrompt(p.id, p.revision, 'shot-0', 'video', 'TEST用户当前正文');
    else { p.materials![0].prompt.edited = true; p = await projects.write(p); }
    const creative = await prepare(scope === 'shot' ? 'optimize' : 'materialPrompt', target); await finish(creative, { optimized: 'TEST待采用的新正文' });
    const review = await prepare('review', target); await finish(review, { issues: [] });
    p = (await chat.adoptPromptCandidate(p.id, p.revision, creative.id)).project!;
    const current = scope === 'shot' ? p.plan!.shots[0].prompts.video : p.materials![0].prompt;
    expect(current).toMatchObject({ final: 'TEST待采用的新正文', sourceJobId: creative.id, edited: false });
  });
  it('较晚收取的创作回复遇到后续待收取审查，仍保存为可采用正文候选', async (): Promise<void> => {
    p = await projects.saveShotPrompt(p.id, p.revision, 'shot-0', 'video', 'TEST用户保留正文');
    let creative = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video' }); await finish(creative, {});
    creative = p.jobs.find((job): boolean => job.id === creative.id)!;
    const review = await prepare('review', { shotId: 'shot-0', promptKind: 'video' });
    await finish(creative, { optimized: 'TEST迟到但有效创作候选' }); expect(p.jobs.find((job): boolean => job.id === creative.id)?.resultStatus).toBe('candidate');
    expect(p.jobs.find((job): boolean => job.id === review.id)?.status).toBe('bound');
    await finish(review, { issues: [] }); p = (await chat.adoptPromptCandidate(p.id, p.revision, creative.id)).project!;
    expect(p.plan!.shots[0].prompts.video.final).toBe('TEST迟到但有效创作候选');
  });
  it('审查的一次格式纠正保持审查职责，不封住同目标待采用创作候选', async (): Promise<void> => {
    p.materials![0].prompt.edited = true; p = await projects.write(p);
    const creative = await prepare('materialPrompt', { materialId: 'scene:location' }); await finish(creative, { optimized: 'TEST新素材完整候选' });
    const review = await prepare('review', { materialId: 'scene:location' }); await finish(review, { issues: 'TEST错误类型' });
    const repair = await prepare('repair', { parentJobId: review.id }); await finish(repair, { issues: [] });
    expect(p.jobs.find((job): boolean => job.id === repair.id)?.status).toBe('applied');
    p = (await chat.adoptPromptCandidate(p.id, p.revision, creative.id)).project!; expect(p.materials![0].prompt.final).toBe('TEST新素材完整候选');
  });
  it('同目标更新创作请求仍拒绝采用旧创作候选，后续审查不能抹去更新关系', async (): Promise<void> => {
    p = await projects.saveShotPrompt(p.id, p.revision, 'shot-0', 'video', 'TEST用户保留正文');
    const old = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video' }); await finish(old, { optimized: 'TEST旧创作候选' });
    const fresh = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video' }); await finish(fresh, { optimized: 'TEST新创作候选' });
    const review = await prepare('review', { shotId: 'shot-0', promptKind: 'video' }); await finish(review, { issues: [] });
    await expect(chat.adoptPromptCandidate(p.id, p.revision, old.id)).rejects.toThrow('已有更新请求');
    p = (await chat.adoptPromptCandidate(p.id, p.revision, fresh.id)).project!; expect(p.plan!.shots[0].prompts.video.final).toBe('TEST新创作候选');
  });
  it.each(['optimize', 'review'] as const)('较晚收取的旧审查遇同目标后续%s变成过期审查', async (next: 'optimize' | 'review'): Promise<void> => {
    let old = await prepare('review', { shotId: 'shot-0', promptKind: 'video' }); await finish(old, {}); old = p.jobs.find((job): boolean => job.id === old.id)!;
    const updated = await prepare(next, { shotId: 'shot-0', promptKind: 'video' }); await finish(updated, next === 'review' ? { issues: [] } : { optimized: 'TEST最新创作正文' });
    await finish(old, { issues: [{ id: 'old-issue', targetId: 'shot-0:video', evidence: 'TEST旧问题证据', impact: 'TEST影响', requestedChange: 'TEST目标', severity: 'warning' }] });
    expect(p.jobs.find((job): boolean => job.id === old.id)?.resultStatus).toBe('stale');
    await expect(prepare('revise', { parentJobId: old.id, shotId: 'shot-0', promptKind: 'video' })).rejects.toThrow('具体目标问题');
  });
  it('已保存的旧审查遇同目标新创作，不能再据旧问题修订当前正文', async (): Promise<void> => {
    const review = await prepare('review', { shotId: 'shot-0', promptKind: 'video' });
    await finish(review, { issues: [{ id: 'saved-old-issue', targetId: 'shot-0:video', evidence: 'TEST旧正文证据', impact: 'TEST制作影响', requestedChange: 'TEST目标', severity: 'warning' }] });
    const creative = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video' }); await finish(creative, { optimized: 'TEST当前新正文' });
    await expect(prepare('revise', { parentJobId: review.id, shotId: 'shot-0', promptKind: 'video' })).rejects.toThrow('已有更新创作或审查');
    expect(p.plan!.shots[0].prompts.video.final).toBe('TEST当前新正文');
  });
  it('请求期间用户改正文后晚到回复只存过期候选，不能显式误采用旧请求', async (): Promise<void> => {
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video' });
    p = await projects.saveShotPrompt(p.id, p.revision, 'shot-0', 'video', 'TEST用户新版本');
    await finish(job, { optimized: 'TEST旧请求晚到' });
    expect(p.jobs[0]).toMatchObject({ resultStatus: 'stale', parsedResult: { optimized: 'TEST旧请求晚到' } });
    expect(p.plan!.shots[0].prompts.video.final).toBe('TEST用户新版本');
    await expect(chat.adoptPromptCandidate(p.id, p.revision, job.id)).rejects.toThrow('已过期');
  });
  it.each(['lastFrame', 'video'] as const)('请求期间改首帧时，%s旧回复不能覆盖共同状态', async (kind: 'lastFrame' | 'video'): Promise<void> => {
    p.plan!.shots[0].prompts.lastFrame = prompt('TEST原尾帧'); p = await projects.write(p);
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: kind });
    expect(job.frameContextHash).toMatch(/^[a-f0-9]{64}$/);
    p = await projects.saveShotPrompt(p.id, p.revision, 'shot-0', 'firstFrame', 'TEST用户新的共同首帧');
    await finish(job, { optimized: 'TEST旧共同状态的晚到候选' });
    expect(p.jobs.at(-1)).toMatchObject({ status: 'applied', resultStatus: 'stale', parsedResult: { optimized: 'TEST旧共同状态的晚到候选' } });
    expect(p.jobs.at(-1)?.staleReason).toContain('已采用首帧或尾帧正文');
    expect(p.plan!.shots[0].prompts[kind]!.final).toBe(kind === 'video' ? 'TEST视频0' : 'TEST原尾帧');
    await expect(chat.adoptPromptCandidate(p.id, p.revision, job.id)).rejects.toThrow('已过期');
  });
  it('候选产生后才修改首帧，显式采用同样检查共同状态依赖', async (): Promise<void> => {
    p = await projects.saveShotPrompt(p.id, p.revision, 'shot-0', 'video', 'TEST用户保留视频');
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video' }); await finish(job, { optimized: 'TEST待采用视频候选' });
    p = await projects.saveShotPrompt(p.id, p.revision, 'shot-0', 'firstFrame', 'TEST用户新的共同首帧');
    await expect(chat.adoptPromptCandidate(p.id, p.revision, job.id)).rejects.toThrow('首帧或尾帧正文已变化');
    expect(p.plan!.shots[0].prompts.video.final).toBe('TEST用户保留视频');
  });
  it('第三镜首帧请求锁定实际携带的前镜采用边界，期间手改前镜尾帧只保留过期候选', async (): Promise<void> => {
    p.plan = technicalPlan(3); p.plan.shots[1].prompts.lastFrame = { ...prompt('TEST前镜采用尾帧'), sourceJobId: 'TEST-adopted-last' };
    p.plan.shots[2].transition = 'continue'; p.plan.shots[2].previousShotId = 'shot-1'; p.materials = syncMaterials(p); p = await projects.write(p);
    const job = await prepare('optimize', { shotId: 'shot-2', promptKind: 'firstFrame' });
    expect(job.previousBoundaryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(requestFacts(job).previousAdoptedBoundary).toMatchObject({ shotId: 'shot-1', promptKind: 'lastFrame', promptText: 'TEST前镜采用尾帧' });
    p = await projects.saveShotPrompt(p.id, p.revision, 'shot-1', 'lastFrame', 'TEST用户新的前镜尾帧');
    await finish(job, { optimized: 'TEST旧前镜状态下返回的第三镜首帧' });
    expect(p.jobs.at(-1)).toMatchObject({ status: 'applied', resultStatus: 'stale', parsedResult: { optimized: 'TEST旧前镜状态下返回的第三镜首帧' } });
    expect(p.jobs.at(-1)?.staleReason).toContain('前镜已采用边界'); expect(p.plan!.shots[2].prompts.firstFrame.final).toBe('TEST首帧2');
    await expect(chat.adoptPromptCandidate(p.id, p.revision, job.id)).rejects.toThrow('已过期');
    const broken = await prepare('optimize', { shotId: 'shot-2', promptKind: 'firstFrame' });
    p = await projects.saveShotPrompt(p.id, p.revision, 'shot-1', 'lastFrame', 'TEST用户再次修改前镜尾帧'); await finish(broken, {});
    const collected = await chat.collect(p.id, broken.id); expect(collected.needsRepair).toBe(false);
    await expect(prepare('repair', { parentJobId: broken.id })).rejects.toThrow('前镜已采用边界发生变化');
  });
  it('用户更换原文后晚到回复只保存过期候选，不覆盖optimized或final', async (): Promise<void> => {
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'firstFrame' });
    const bound = tasks()[0]; const now = new Date().toISOString();
    core.updateRuntime({ taskId: bound.id, runtime: { runId: `TEST-run-${job.id}`, attempt: 1, stage: 'generating', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { prompt: bound.prompt, mode: 'chat', attachments: [] } } });
    await chat.bindRun(p.id, job.id, `TEST-run-${job.id}`); job.runId = `TEST-run-${job.id}`; p = await projects.read(p.id);
    p = await projects.saveOriginalStory(p.id, p.revision, 'TEST 已由用户更新的确认原文');
    await finish(job, { optimized: 'TEST旧请求迟到' });
    expect(p.jobs[0]).toMatchObject({ resultStatus: 'stale', parsedResult: { optimized: 'TEST旧请求迟到' } });
    expect(p.plan!.shots[0].prompts.firstFrame.final).toBe('TEST首帧0'); expect(p.plan!.shots[0].prompts.firstFrame.optimized).toBe('TEST首帧0');
  });
  it('目标缺失、重复或错误不能回落旧正文并标完成', async (): Promise<void> => {
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video' }); await finish(job, { optimized: 'TEST不应采用' }, true);
    expect(p.jobs[0].status).toBe('invalid'); expect(p.jobs[0].rawText).toContain('TEST不应采用'); expect(p.plan!.shots[0].prompts.video.final).toBe('TEST视频0');
  });
  it('同故事可重新动态拆镜为候选，显式采用前不覆盖原镜头', async (): Promise<void> => {
    const original = structuredClone(p.plan); const job = await prepare('analysis');
    await finish(job, { storyUsable: true, contentBasis: { beginning: 'TEST源1', middle: 'TEST源2', ending: 'TEST源3' }, ...technicalPlan(3) });
    expect(p.plan).toEqual(original); expect(p.jobs[0].parsedResult?.plan?.shots).toHaveLength(3); expect(p.jobs[0].resultStatus).toBe('candidate');
    p = (await chat.adoptPlanCandidate(p.id, p.revision, job.id)).project!; expect(p.plan!.shots).toHaveLength(3); expect(p.plan!.understanding).toBe('TEST 来源对应');
  });
  it('补资产保留原镜主要动作、参数、台词及正文；新来源字段可恢复', async (): Promise<void> => {
    const original = structuredClone(p.plan!.shots); const job = await prepare('assets');
    await finish(job, { characters: [], props: [], scenes: p.plan!.scenes, understanding: 'TEST剧本来源映射', sceneDesign: 'TEST空间锚点',
      shotBindings: original.map((s): object => ({ shotId: s.id, characterIds: [], propIds: [], propStates: [], sceneId: 'location', sourceRefs: ['TEST原文段1'], blocking: 'TEST调度' })) });
    expect(p.jobs[0].resultStatus).toBe('adopted');
    p.plan!.shots.forEach((s, index): void => { expect(s.action).toBe(original[index].action); expect(s.startState).toBe(original[index].startState); expect(s.endState).toBe(original[index].endState); expect(s.durationSeconds).toBe(original[index].durationSeconds); expect(s.prompts).toEqual(original[index].prompts); expect(s.sourceRefs).toEqual(['TEST原文段1']); });
    expect((await new PetStoryProjects().open(directory)).plan!.sceneDesign).toBe('TEST空间锚点');
  });
  it.each([{ incoming: [] as string[] }, { incoming: ['replacement'] }])('补资产拒绝模型将原出场角色误删或替换为 $incoming', async ({ incoming }: { incoming: string[] }): Promise<void> => {
    p.plan!.characters = [{ id: 'original', name: 'TEST角色', role: 'main', purpose: 'TEST用途', description: 'TEST已保存外观' }];
    p.plan!.shots[0].characterIds = ['original']; p.materials = syncMaterials(p); p = await projects.write(p);
    const original = structuredClone(p.plan); const job = await prepare('assets');
    await finish(job, { characters: [...p.plan!.characters, { id: 'replacement', name: 'TEST新增角色', role: 'supporting', purpose: 'TEST用途', description: 'TEST候选外观' }], props: [], scenes: p.plan!.scenes,
      shotBindings: p.plan!.shots.map((shot): object => ({ shotId: shot.id, characterIds: shot.id === 'shot-0' ? incoming : [], propIds: [], propStates: [], sceneId: 'location' })) });
    expect(p.jobs.at(-1)?.status).toBe('invalid'); expect(p.jobs.at(-1)?.error).toContain('不能删除或替换'); expect(p.plan).toEqual(original);
  });
  it('补资产允许为剧情追加必要角色，同时保留原出场角色与镜头主要内容', async (): Promise<void> => {
    p.plan!.characters = [{ id: 'original', name: 'TEST原角色', role: 'main', purpose: 'TEST用途', description: 'TEST已保存外观' }];
    p.plan!.shots[0].characterIds = ['original']; p.materials = syncMaterials(p); p = await projects.write(p);
    const original = structuredClone(p.plan!.shots); const job = await prepare('assets');
    await finish(job, { characters: [...p.plan!.characters, { id: 'additional', name: 'TEST必要配角', role: 'supporting', purpose: 'TEST用途', description: 'TEST候选外观' }], props: [], scenes: p.plan!.scenes,
      shotBindings: p.plan!.shots.map((shot): object => ({ shotId: shot.id, characterIds: shot.id === 'shot-0' ? ['original', 'additional'] : [], propIds: [], propStates: [], sceneId: 'location' })) });
    expect(p.jobs.at(-1)?.resultStatus).toBe('adopted'); expect(p.plan!.shots[0].characterIds).toEqual(['original', 'additional']);
    expect(p.plan!.shots[0].action).toBe(original[0].action); expect(p.plan!.shots[0].prompts).toEqual(original[0].prompts);
  });
  it.each(['prop-remove', 'prop-replace', 'scene-replace'] as const)('补资产拒绝静默改变原道具／场景关系：%s', async (change: 'prop-remove' | 'prop-replace' | 'scene-replace'): Promise<void> => {
    p.plan!.props = [{ id: 'existing-prop', name: 'TEST原道具', aliases: [], description: 'TEST外观', keyStates: 'TEST状态', scale: 'TEST比例', designOrigin: 'script' }];
    p.plan!.shots[0].propIds = ['existing-prop']; p.plan!.shots[0].propStates = [{ propId: 'existing-prop', state: 'TEST当前状态' }]; p.materials = syncMaterials(p); p = await projects.write(p);
    const original = structuredClone(p.plan); const job = await prepare('assets');
    await finish(job, { characters: [], props: [...p.plan!.props, { ...p.plan!.props[0], id: 'new-prop', name: 'TEST新道具' }], scenes: [...p.plan!.scenes!, { ...p.plan!.scenes![0], id: 'new-location', location: 'TEST新地点' }],
      shotBindings: p.plan!.shots.map((shot): object => ({ shotId: shot.id, characterIds: [], propIds: shot.id === 'shot-0' ? change === 'prop-remove' ? [] : change === 'prop-replace' ? ['new-prop'] : shot.propIds : [],
        propStates: shot.id === 'shot-0' ? [{ propId: change === 'prop-replace' ? 'new-prop' : 'existing-prop', state: 'TEST状态' }] : [], sceneId: shot.id === 'shot-0' && change === 'scene-replace' ? 'new-location' : 'location' })) });
    expect(p.jobs.at(-1)?.status).toBe('invalid'); expect(p.jobs.at(-1)?.error).toMatch(/不能删除或替换.*道具|不能静默更换/); expect(p.plan).toEqual(original);
  });
  it('原无道具关系可补齐新道具，已选与确认图片和原sceneId保持', async (): Promise<void> => {
    const material = p.materials!.find((item): boolean => item.id === 'scene:location')!;
    p.assets.push({ id: 'TEST-approved-scene', kind: 'scene', materialId: material.id, relativePath: 'materials/TEST-approved.png', validation: { decoded: true, sha256: 'a'.repeat(64), bytes: 4, width: 1, height: 1, checkedAt: new Date().toISOString() } });
    material.selectedAssetId = 'TEST-approved-scene'; material.approved = { assetId: 'TEST-approved-scene', sha256: 'a'.repeat(64), at: new Date().toISOString() }; p = await projects.write(p);
    const approved = structuredClone(p.materials!.find((item): boolean => item.id === 'scene:location')!); const job = await prepare('assets');
    await finish(job, { characters: [], props: [{ id: 'new-prop', name: 'TEST新增道具', aliases: [], description: 'TEST外观', keyStates: 'TEST状态', scale: 'TEST比例', designOrigin: 'proposed' }], scenes: p.plan!.scenes,
      shotBindings: p.plan!.shots.map((shot): object => ({ shotId: shot.id, characterIds: [], propIds: shot.id === 'shot-0' ? ['new-prop'] : [], propStates: shot.id === 'shot-0' ? [{ propId: 'new-prop', state: 'TEST状态' }] : [], sceneId: 'location' })) });
    expect(p.jobs.at(-1)?.resultStatus).toBe('adopted'); expect(p.plan!.shots[0].propIds).toEqual(['new-prop']);
    expect(p.materials!.find((item): boolean => item.id === 'scene:location')).toEqual(approved);
  });
  it('即使无当前镜头依赖，也不能删除或重命名已选图片的库存实体', async (): Promise<void> => {
    p.plan!.props = [{ id: 'saved-prop', name: 'TEST库存道具', aliases: [], description: 'TEST外观', keyStates: 'TEST状态', scale: 'TEST比例', designOrigin: 'script' }];
    p.assets.push({ id: 'TEST-saved-image', kind: 'prop', materialId: 'prop:saved-prop', relativePath: 'materials/TEST-saved.png' });
    p.materials!.push({ id: 'prop:saved-prop', kind: 'prop', entityId: 'saved-prop', name: 'TEST库存道具', designHash: 'b'.repeat(64), prompt: prompt('TEST库存正文'), selectedAssetId: 'TEST-saved-image' }); p = await projects.write(p);
    const original = structuredClone(p.materials); const job = await prepare('assets');
    await finish(job, { characters: [], props: [{ ...p.plan!.props![0], id: 'renamed-prop' }], scenes: p.plan!.scenes,
      shotBindings: p.plan!.shots.map((shot): object => ({ shotId: shot.id, characterIds: [], propIds: [], propStates: [], sceneId: 'location' })) });
    expect(p.jobs.at(-1)?.status).toBe('invalid'); expect(p.jobs.at(-1)?.error).toContain('实体 ID'); expect(p.materials).toEqual(original);
  });
  it.each(['shot-1:video', 'shot-0:firstFrame'])('局部审查拒绝本次选中范围之外的问题 %s，保留原文与所有正文', async (targetId: string): Promise<void> => {
    const original = structuredClone(p.plan); const review = await prepare('review', { shotId: 'shot-0', promptKind: 'video' });
    await finish(review, { issues: [{ id: 'out-of-scope', targetId, evidence: 'TEST具体证据', impact: 'TEST制作影响', requestedChange: 'TEST局部目标', severity: 'warning' }] });
    expect(p.jobs.at(-1)?.status).toBe('invalid'); expect(p.jobs.at(-1)?.error).toContain('目标范围之外'); expect(p.jobs.at(-1)?.rawText).toContain(targetId); expect(p.plan).toEqual(original);
  });
  it('全项目审查允许多个实际目标，局部审查接受明确对应的镜头和正文类型', async (): Promise<void> => {
    const issue = { id: 'TEST-issue', evidence: 'TEST具体证据', impact: 'TEST制作影响', requestedChange: 'TEST局部目标', severity: 'suggestion' };
    const global = await prepare('review'); await finish(global, { issues: [{ ...issue, targetId: 'shot-1:video' }] });
    expect(p.jobs.at(-1)?.status).toBe('applied');
    const local = await prepare('review', { shotId: 'shot-0', promptKind: 'video' }); await finish(local, { issues: [{ ...issue, targetId: 'shot-0', promptKind: 'video' }] });
    expect(p.jobs.at(-1)?.parsedResult?.issues).toHaveLength(1); expect(p.jobs.at(-1)?.status).toBe('applied');
  });
  it('审查必须给证据，定点修订每批一次且不改变其他正文', async (): Promise<void> => {
    const review = await prepare('review', { shotId: 'shot-0', promptKind: 'video' });
    await finish(review, { issues: [{ id: 'issue-0', targetId: 'shot-0:video', evidence: 'TEST正文证据', impact: 'TEST制作影响', requestedChange: 'TEST局部修订目标', severity: 'warning' }] });
    const revision = await prepare('revise', { shotId: 'shot-0', promptKind: 'video', parentJobId: review.id, selectedIssueIds: ['issue-0'] });
    await finish(revision, { optimized: 'TEST局部修订结果' }); expect(p.plan!.shots[0].prompts.video.final).toBe('TEST局部修订结果'); expect(p.plan!.shots[1].prompts.video.final).toBe('TEST视频1');
    await expect(prepare('revise', { shotId: 'shot-0', promptKind: 'video', parentJobId: review.id })).rejects.toThrow('已修订一次');
  });
  it('未显式选择仅修订本目标error，不把其他目标或建议证据送进创作请求', async (): Promise<void> => {
    const review = await prepare('review'); await finish(review, { issues: [issue('required', 'shot-0:video', 'error'), issue('optional', 'shot-0:video', 'suggestion'), issue('other-target', 'shot-1:video', 'error')] });
    const revision = await prepare('revise', { shotId: 'shot-0', promptKind: 'video', parentJobId: review.id });
    expect(revision.selectedIssueIds).toEqual(['required']);
    expect(requestFacts(revision).parentResult).toMatchObject({ selectedIssueIds: ['required'], issues: [issue('required', 'shot-0:video', 'error')] });
    expect(JSON.stringify(requestFacts(revision).parentResult)).not.toContain('TEST-optional'); expect(JSON.stringify(requestFacts(revision).parentResult)).not.toContain('TEST-other-target');
    await finish(revision, { optimized: 'TEST仅落实选中问题的新正文' });
    expect((await new PetStoryProjects().open(directory)).jobs.at(-1)?.selectedIssueIds).toEqual(['required']);
  });
  it('只有warning或suggestion时不能默认修订，明确选择建议后仍保护手改final', async (): Promise<void> => {
    p = await projects.saveShotPrompt(p.id, p.revision, 'shot-0', 'video', 'TEST用户必须保留正文');
    const review = await prepare('review', { shotId: 'shot-0', promptKind: 'video' }); await finish(review, { issues: [issue('optional', 'shot-0:video', 'suggestion'), issue('note', 'shot-0:video', 'warning')] });
    const count = tasks().length;
    await expect(prepare('revise', { shotId: 'shot-0', promptKind: 'video', parentJobId: review.id })).rejects.toThrow('明确选择'); expect(tasks()).toHaveLength(count);
    const revision = await prepare('revise', { shotId: 'shot-0', promptKind: 'video', parentJobId: review.id, selectedIssueIds: ['optional'] });
    expect(revision.selectedIssueIds).toEqual(['optional']); expect(requestFacts(revision).parentResult).toMatchObject({ issues: [issue('optional', 'shot-0:video', 'suggestion')] });
    await finish(revision, { optimized: 'TEST用户选建议后的完整候选' }); expect(p.plan!.shots[0].prompts.video.final).toBe('TEST用户必须保留正文'); expect(p.jobs.at(-1)?.resultStatus).toBe('candidate');
  });
  it.each([{ selected: [] }, { selected: ['required', 'required'] }, { selected: ['missing'] }, { selected: ['other-target'] }])('修订拒绝空、重复、未知或跨目标问题选择 $selected', async ({ selected }: { selected: string[] }): Promise<void> => {
    const review = await prepare('review'); await finish(review, { issues: [issue('required', 'shot-0:video', 'error'), issue('other-target', 'shot-1:video', 'error')] });
    const before = tasks().length;
    await expect(prepare('revise', { shotId: 'shot-0', promptKind: 'video', parentJobId: review.id, selectedIssueIds: selected })).rejects.toThrow(/非空且不重复|不属于父审查/);
    expect(tasks()).toHaveLength(before); expect((await projects.read(p.id)).jobs).toHaveLength(1);
  });
  it('一次内容修订结构仍错误时保留所选问题，不追加第二次自动改写', async (): Promise<void> => {
    const review = await prepare('review', { materialId: 'scene:location' }); await finish(review, { issues: [issue('required', 'scene:location', 'error'), issue('optional', 'scene:location', 'suggestion')] });
    const original = p.materials![0].prompt.final;
    const revision = await prepare('revise', { materialId: 'scene:location', parentJobId: review.id, selectedIssueIds: ['required'] }); await finish(revision, {});
    expect(requestFacts(revision).parentResult).toMatchObject({ selectedIssueIds: ['required'], issues: [issue('required', 'scene:location', 'error')] });
    const collected = await chat.collect(p.id, revision.id); expect(collected.needsRepair).toBe(false);
    await expect(prepare('repair', { parentJobId: revision.id })).rejects.toThrow('已使用一次内容修订');
    expect(p.materials![0].prompt).toMatchObject({ final: original, needsReview: true });
    expect((await new PetStoryProjects().open(directory)).jobs.at(-1)?.selectedIssueIds).toEqual(['required']);
  });
  it('审查关注点trim后进入本次事实与job，允许查证后无问题且不修改任何final', async (): Promise<void> => {
    const original = structuredClone(p.plan);
    const review = await prepare('review', { reviewFocus: '  TEST核对相邻边界是否一致，不预设有错。\n  ' });
    expect(review.reviewFocus).toBe('TEST核对相邻边界是否一致，不预设有错。');
    expect(requestFacts(review)).toMatchObject({ userReviewFocus: review.reviewFocus, userReviewFocusPolicy: expect.stringContaining('不是已经认定的事实') });
    await finish(review, { issues: [] }); expect(p.plan).toEqual(original); expect(p.jobs.at(-1)?.parsedResult?.issues).toEqual([]);
    const reopened = await new PetStoryProjects().open(directory); expect(reopened.jobs.at(-1)?.reviewFocus).toBe(review.reviewFocus); expect(reopened.plan).toEqual(original);
  });
  it('审查关注点只接受最多2000字符文本，纯空白归为未提供且超长不建任务', async (): Promise<void> => {
    const accepted = await prepare('review', { reviewFocus: '  ' + '核'.repeat(2000) + '  ' }); expect(accepted.reviewFocus).toHaveLength(2000); await finish(accepted, { issues: [] });
    const before = tasks().length;
    await expect(prepare('review', { reviewFocus: '核'.repeat(2001) })).rejects.toThrow('最多 2000');
    await expect(prepare('review', { reviewFocus: 42 as unknown as string })).rejects.toThrow('必须为文本'); expect(tasks()).toHaveLength(before);
    const blank = await prepare('review', { reviewFocus: ' \n\t ' }); expect(blank.reviewFocus).toBeUndefined(); expect(requestFacts(blank)).not.toHaveProperty('userReviewFocus');
  });
  it.each(['analysis', 'assets', 'optimize', 'materialPrompt', 'revise', 'repair'] as const)('%s阶段拒绝把审查疑点当创作或修订指令', async (kind: PetStoryChatJob['kind']): Promise<void> => {
    await expect(prepare(kind, { shotId: 'shot-0', promptKind: 'video', reviewFocus: 'TEST仅应供审查核对' })).rejects.toThrow('核对疑点只能用于内容审查'); expect(tasks()).toHaveLength(0);
  });
  it('一次审查格式纠正继承原疑点范围，格式修正与空问题结果均不改final', async (): Promise<void> => {
    const original = structuredClone(p.plan); const review = await prepare('review', { shotId: 'shot-0', promptKind: 'video', reviewFocus: 'TEST只核对本镜当前来源与边界' }); await finish(review, {});
    const repair = await prepare('repair', { parentJobId: review.id }); expect(repair.reviewFocus).toBe(review.reviewFocus);
    expect(requestFacts(repair).userReviewFocus).toBe(review.reviewFocus); await finish(repair, { issues: [] });
    expect(p.jobs.at(-1)?.status).toBe('applied'); expect(p.plan).toEqual(original); expect((await new PetStoryProjects().open(directory)).jobs.at(-1)?.reviewFocus).toBe(review.reviewFocus);
  });
  it('素材Chat正文不因规则版本或syncMaterials变回本地模板，设计变更保留待复核', async (): Promise<void> => {
    const job = await prepare('materialPrompt', { materialId: 'scene:location' }); await finish(job, { optimized: 'TEST豆包完整场景正文\n第二段' });
    const accepted = structuredClone(p.materials![0].prompt);
    expect(accepted.sourceJobId).toBe(job.id);
    p.materials = syncMaterials(p); p = await projects.write(p); expect(p.materials![0].prompt).toEqual(accepted);
    p.plan!.scenes![0].lighting = 'TEST用户修改光线'; p.materials = syncMaterials(p);
    expect(p.materials![0].prompt).toEqual({ ...accepted, needsReview: true });
    p = await projects.write(p); const reopened = await new PetStoryProjects().open(directory);
    expect(reopened.materials![0].prompt.sourceJobId).toBe(job.id); expect(reopened.materials![0].prompt.final).toBe('TEST豆包完整场景正文\n第二段');
  });
  it('设计变更保留未采用的真实素材Chat候选和用户final，不重新套入初始模板', async (): Promise<void> => {
    p.materials![0].prompt.edited = true; p.materials![0].prompt.final = 'TEST用户手改素材正文'; p = await projects.write(p);
    const job = await prepare('materialPrompt', { materialId: 'scene:location' }); await finish(job, { optimized: 'TEST本次真实回读候选\n完整第二段' });
    const prompt = structuredClone(p.materials![0].prompt);
    expect(prompt).toMatchObject({ final: 'TEST用户手改素材正文', optimized: 'TEST本次真实回读候选\n完整第二段', candidateJobId: job.id, edited: true });
    p.plan!.scenes![0].lighting = 'TEST修改场景光线'; p.materials = syncMaterials(p);
    expect(p.materials![0].prompt).toEqual({ ...prompt, needsReview: true });
  });
  it('生产前已检查模型选择进入本次文字请求与项目，重开不丢方言来源', async (): Promise<void> => {
    const selected = capability(); const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video', capability: selected });
    expect(p.production).toBeUndefined(); expect(p.promptCapability).toEqual(selected); expect(job.capability).toEqual(selected);
    expect(job.stage).toBe('video+video20'); expect(tasks()[0].prompt).toContain('seedance-2.0');
    const reopened = await new PetStoryProjects().open(directory); expect(reopened.promptCapability).toEqual(selected);
  });
  it('其他账号能力和不存在的编辑基准在创建任务前拒绝', async (): Promise<void> => {
    await expect(prepare('optimize', { shotId: 'shot-0', promptKind: 'video', capability: capability('TEST-other-account') })).rejects.toThrow('项目原账号');
    await expect(prepare('materialPrompt', { materialId: 'scene:location', editIntent: { baseAssetId: 'TEST-missing', changes: 'TEST变化', preserve: 'TEST保留', validity: 'TEST本镜' } })).rejects.toThrow('实际基础图');
    expect(tasks()).toHaveLength(0);
  });
  it('局部编辑沿完整回复候选链，显式采用才保存基准与保持集，普通重生清旧编辑意图', async (): Promise<void> => {
    await fs.mkdir(path.join(directory, 'materials'));
    await fs.writeFile(path.join(directory, 'materials/TEST-edit-base.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
    p.assets.push({ id: 'TEST-edit-base', kind: 'scene', materialId: 'scene:location', relativePath: 'materials/TEST-edit-base.png' });
    p.materials![0].selectedAssetId = 'TEST-edit-base'; p = await projects.write(p);
    const previous = p.materials![0].prompt.final;
    const editIntent: PetStoryMaterialEditIntent = { baseAssetId: 'TEST-edit-base', changes: 'TEST 指定变化', preserve: 'TEST 保留的区域', validity: 'TEST 适用本镜' };
    const job = await prepare('materialPrompt', { materialId: 'scene:location', editIntent });
    expect(job.editIntent).toEqual(editIntent); expect(job.stage).toContain('imageEdit');
    await finish(job, { optimized: 'TEST本次豆包编辑候选\n完整第二段' });
    expect(p.materials![0].prompt.final).toBe(previous); expect(p.materials![0].prompt.optimized).toBe('TEST本次豆包编辑候选\n完整第二段'); expect(p.jobs.at(-1)?.resultStatus).toBe('candidate');
    p = (await chat.adoptPromptCandidate(p.id, p.revision, job.id)).project!;
    expect(p.materials![0].prompt.editIntent).toEqual(editIntent); expect((await new PetStoryProjects().open(directory)).materials![0].prompt.editIntent).toEqual(editIntent);
    const regenerated = await prepare('materialPrompt', { materialId: 'scene:location' }); await finish(regenerated, { optimized: 'TEST新的普通基础图正文' });
    expect(p.materials![0].prompt.final).toBe('TEST新的普通基础图正文'); expect(p.materials![0].prompt.editIntent).toBeUndefined();
  });
  it('文字模型选择变化使已发请求过期，晚回仅保留完整候选', async (): Promise<void> => {
    const job = await prepare('optimize', { shotId: 'shot-0', promptKind: 'video', capability: capability() });
    p.promptCapability!.videoConfig!.model = 'seedance-2.5'; p = await projects.write(p);
    await finish(job, { optimized: 'TEST旧模型较晚回复' });
    expect(p.jobs.at(-1)).toMatchObject({ resultStatus: 'stale', parsedResult: { optimized: 'TEST旧模型较晚回复' } });
    expect(p.plan!.shots[0].prompts.video.final).toBe('TEST视频0');
  });
});
