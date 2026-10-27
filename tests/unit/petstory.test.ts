/** 全部为离线测试数据，不代表真实抖音内容、免费权益或生成验收。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PetStoryPlan, PetStoryProject, PetStoryPrompt, PetStoryResult, Task, TaskRunSnapshot } from '@doubao-studio/contracts';
import { extractDouyinLink, parsePetStoryAnswer, validatePetStoryPlan } from '../../main/utils/petstoryValidation';
import { PetStoryProjects, projectPath } from '../../main/utils/petstoryProject';
import { checkFinalBindings, finalTaskInput, PetStoryChatService, type PetStoryTaskPort } from '../../main/utils/petstoryChat';
import { TaskService } from '../../main/core/TaskService';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';
import { analysisPrompt, optimizationPrompt, mobileStoryPrompt } from '../../src/utils/petstoryPrompts';

const now = '2026-10-24T02:00:00.000Z';
function testPrompt(label: string): PetStoryPrompt {
  return { original: `测试原始 ${label}`, optimized: `测试优化 ${label}`, final: `测试最终 ${label}`, edited: true, rulesVersion: 'petstory-r11-v1' };
}
function testPlan(count = 4): PetStoryPlan {
  return { sourceSummary: '离线测试：店员帮助找到礼物', adaptedStory: '离线测试：噜噜与噜妹在商店找礼物，店员帮助，找回礼物后道谢。',
    props: [], scenes: [{ id: 'test-store', name: '测试商店', location: '测试商店', time: '白天', lighting: '自然光', layout: '入口相对柜台', view: '正面', designOrigin: 'script' }],
    characters: [
      { id: 'lulu', name: '噜噜', role: 'main', purpose: '找礼物', description: '测试蓝衣', referenceAssetId: 'asset-lulu' },
      { id: 'lumei', name: '噜妹', role: 'main', purpose: '收到礼物', description: '测试红衣', referenceAssetId: 'asset-lumei' },
      { id: 'clerk', name: '店员', role: 'supporting', purpose: '帮助主角', description: '测试绿围裙', referenceAssetId: 'asset-clerk' },
    ],
    shots: Array.from({ length: count }, (_, index): PetStoryPlan['shots'][number] => ({
      id: `s${index + 1}`, order: index + 1, characterIds: index === 0 ? ['clerk', 'lulu'] : ['lumei'],
      sceneId: 'test-store', propIds: [], propStates: [], scene: '测试商店', action: '测试展示礼物', startState: '测试手边有盒子', endState: '测试拿起盒子',
      durationSeconds: index % 2 ? 10 : 5, transition: 'cut', requestedMode: 'auto',
      prompts: { firstFrame: testPrompt('单帧构图'), video: testPrompt('动作过程') },
    })),
  };
}
function testAnswer(plan: PetStoryPlan = testPlan()): string {
  return JSON.stringify({ storyUsable: true, contentBasis: { beginning: '测试走进商店', middle: '测试店员找到礼物', ending: '测试道谢离开' }, ...plan });
}

/** 真实 TaskService + 离线内存 Repository，测试不连接任何平台。 */
function taskPort(): { port: PetStoryTaskPort; core: TaskService; tasks: () => Task[] } {
  let stored: Task[] = [];
  let nextId = 0;
  const core = new TaskService({ store: {
    read: (): Task[] => structuredClone(stored),
    replace: (tasks: Task[]): boolean => { stored = normalizeTasks(structuredClone(tasks), 'studio-test', now).data; return true; },
  }, defaultProjectId: (): string => 'studio-test', id: (): string => `test-task-${++nextId}`, now: (): string => now });
  const port: PetStoryTaskPort = {
    list: (): Task[] => structuredClone(stored),
    retryUnsubmitted: (taskId: string): Task => {
      const result = core.retry(taskId, 'hold');
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
    create: (params, accountId: string): Task => {
      const result = core.create(params);
      if (!result.success) throw new Error(result.error);
      const assigned = core.assign({ taskId: result.data[0].id, accountId });
      if (!assigned.success) throw new Error(assigned.error);
      return assigned.data;
    },
  };
  return { port, core, tasks: port.list };
}
async function complete(core: TaskService, task: Task, raw: string, runId: string = 'test-run'): Promise<void> {
  const runtime: TaskRunSnapshot = { runId, attempt: 1, stage: 'completed', message: '离线测试', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
    input: { prompt: task.prompt, mode: task.mode, attachments: task.attachments || [] }, chatResponse: { text: raw, capturedAt: now } };
  const written = core.updateRuntime({ taskId: task.id, status: 'done', runtime });
  if (!written.success) throw new Error(written.error);
  const chat = new PetStoryChatService(projects, { list: (): Task[] => { const result = core.getTasks(); return result.success ? result.data : []; }, create: (): Task => { throw new Error('TEST unexpected create'); } });
  const current = await projects.read(project.id);
  const job = current.jobs.find((j): boolean => j.taskId === task.id);
  if (job) await chat.bindRun(project.id, job.id, runId);
}

let directory: string;
let projects: PetStoryProjects;
let project: PetStoryProject;
beforeEach(async (): Promise<void> => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'petstory-test-')));
  projects = new PetStoryProjects();
  project = await projects.create(directory, 'studio-test', 'account-test');
  project = await projects.saveSource(project.id, project.revision, '测试分享 https://v.douyin.com/TEST_ONLY/');
  project = await projects.saveMobileStory(project.id, project.revision, 'TEST 手机豆包原文\n开头：主角进店找礼物。\n经过：店员帮助找到礼物。\n结局：主角道谢离开。');
});
afterEach(async (): Promise<void> => { await fs.rm(directory, { recursive: true, force: true }); });

describe('PetStory dynamic data and rules — offline tests only', (): void => {
  it.each([1, 2, 4, 6])('accepts %i shots and necessary third character without requiring both leads in every shot', (count: number): void => {
    const p = validatePetStoryPlan(testPlan(count));
    expect(p.shots).toHaveLength(count);
    expect(p.characters).toHaveLength(3);
    expect(p.shots[0].characterIds).toEqual(['clerk', 'lulu']);
  });
  it.each([4, 11, NaN, Infinity, undefined])('rejects invalid duration %s without clamping', (duration: number | undefined): void => {
    const p = testPlan();
    const value = { ...p, shots: [{ ...p.shots[0], durationSeconds: duration }] };
    expect((): PetStoryPlan => validatePetStoryPlan(value)).toThrow('5～10');
    expect(value.shots[0].durationSeconds).toBe(duration);
  });
  it('rejects duplicate IDs, unknown actors, missing fields and broken continuity', (): void => {
    const p = testPlan();
    p.shots[1].id = p.shots[0].id;
    expect((): PetStoryPlan => validatePetStoryPlan(p)).toThrow('重复');
    p.shots[1].id = 's2'; p.shots[0].characterIds = ['unknown'];
    expect((): PetStoryPlan => validatePetStoryPlan(p)).toThrow('未知角色');
    p.shots[0].characterIds = ['lulu']; p.shots[0].scene = '';
    expect((): PetStoryPlan => validatePetStoryPlan(p)).toThrow('scene');
    p.shots[0].scene = 'test'; p.shots[0].transition = 'continue';
    expect((): PetStoryPlan => validatePetStoryPlan(p)).toThrow('连续引用');
  });
  it('rejects invalid modes and allows editing default lead names', (): void => {
    const p = testPlan();
    expect((): PetStoryPlan => validatePetStoryPlan({ ...p, shots: [{ ...p.shots[0], requestedMode: 'fake' }] })).toThrow('模式');
    p.characters[0].name = '其他';
    expect(validatePetStoryPlan(p).characters[0].name).toBe('其他');
  });
  it('parses fenced JSON while preserving whitespace inside prompt strings, and rejects malformed JSON', (): void => {
    const value = { optimized: '第一行\n  保留缩进\n```代码```' };
    expect(parsePetStoryAnswer('```json\n' + JSON.stringify(value) + '\n```')).toEqual(value);
    expect(parsePetStoryAnswer('json\n\n\n```json\n' + JSON.stringify(value) + '\n```')).toEqual(value);
    expect((): unknown => parsePetStoryAnswer('{bad JSON}')).toThrow();
  });
  it('recognizes only Douyin share URLs without fetching content', (): void => {
    expect(extractDouyinLink('测试 https://v.douyin.com/TEST_ONLY/，复制打开')).toBe('https://v.douyin.com/TEST_ONLY/');
    for (const bad of ['file:///test.mp4', '/tmp/test.mp4', 'https://douyin.com.evil.test/video/1', 'https://example.test/video/1', 'https://v.douyin.com/', 'https://v.douyin.com/a/ https://v.douyin.com/b/']) {
      expect((): string => extractDouyinLink(bad)).toThrow();
    }
  });
  it('assembles both distinct rules with actual attachment order and no fabricated story result', (): void => {
    const p = { ...project, plan: testPlan(), assets: [
      { id: 'asset-clerk', kind: 'character' as const, relativePath: 'characters/clerk.png', characterId: 'clerk' },
      { id: 'asset-lulu', kind: 'character' as const, relativePath: 'characters/lulu.png', characterId: 'lulu' },
    ] };
    const analysis = analysisPrompt(p);
    expect(analysis).toContain(project.source.url);
    expect(analysis.indexOf('身份参考图：lulu')).toBeLessThan(analysis.indexOf('身份参考图：clerk'));
    expect(analysis).toContain('明确开始时刻');
    expect(analysis).toContain('中间过程');
    expect(analysis).toContain('不以固定镜数');
    const image = optimizationPrompt(p, 's1', 'firstFrame');
    const video = optimizationPrompt(p, 's1', 'video');
    expect(image).toContain('明确静态时刻');
    expect(video).toContain('中间过程');
    expect(image).not.toBe(video);
  });
  it('detects wrong mapping, missing last frame, empty final and mode conflicts deterministically', (): void => {
    const p = testPlan();
    const good = [{ characterId: 'clerk', assetId: 'asset-clerk' }, { characterId: 'lulu', assetId: 'asset-lulu' }];
    expect(checkFinalBindings(p, 's1', 'firstFrame', good, 'image')).toEqual([]);
    expect(checkFinalBindings(p, 's1', 'firstFrame', [...good].reverse(), 'image').join()).toContain('错绑');
    expect(checkFinalBindings(p, 's1', 'video', good, 'first_last_frame').join()).toContain('缺少');
    p.shots[0].prompts.video.final = ' ';
    expect(checkFinalBindings(p, 's1', 'video', good, 'image').join()).toContain('为空');
    expect(checkFinalBindings(p, 's1', 'video', good, 'image').join()).toContain('冲突');
  });
});

describe('PetStory project and real service wiring — offline tests only', (): void => {
  it('provides a mobile extraction prompt and requires pasted story before creating any desktop task', async (): Promise<void> => {
    const p = { ...project, mobileStory: undefined };
    const phone = mobileStoryPrompt(p);
    expect(phone).toContain(p.source.url);
    expect(phone).toContain('先后顺序');
    expect(phone).toContain('关键动作和对白');
    expect(phone).toContain('看不清或无法读取就直说');
    expect((): string => analysisPrompt(p)).toThrow('粘贴');
    await projects.write(p);
    const { port, tasks } = taskPort();
    await expect(new PetStoryChatService(projects, port).prepare(p.id, 'TEST link only', 'analysis')).rejects.toThrow('手机豆包');
    expect(tasks()).toEqual([]);
  });
  it('preserves pasted plain text exactly, saves idempotently, reopens it and rejects empty/oversized content', async (): Promise<void> => {
    const raw = '  TEST 手机原文\n\n开头：进店。\n经过：店员找到礼物。\n结局：道谢离开。  ';
    const saved = await projects.saveMobileStory(project.id, project.revision, raw);
    expect(saved.mobileStory?.text).toBe(raw);
    expect(saved.mobileStory?.id).not.toBe(project.mobileStory?.id);
    const same = await projects.saveMobileStory(project.id, saved.revision, raw);
    expect(same.revision).toBe(saved.revision);
    expect((await new PetStoryProjects().open(directory)).mobileStory).toEqual(saved.mobileStory);
    for (const invalid of [' ', 'x'.repeat(50_001)]) await expect(projects.saveMobileStory(project.id, saved.revision, invalid)).rejects.toThrow('50000');
    expect((await projects.read(project.id)).mobileStory?.text).toBe(raw);
  });
  it('creates the actual held request from the pasted story and never asks desktop Chat to read the video', async (): Promise<void> => {
    const { port, tasks } = taskPort();
    const chat = new PetStoryChatService(projects, port);
    await chat.prepare(project.id, analysisPrompt(project), 'analysis');
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0]).toMatchObject({ mode: 'chat', executionIntent: 'hold', assignedAccountId: project.accountId });
    expect(tasks()[0].prompt).toContain(JSON.stringify(project.mobileStory!.text));
    expect(tasks()[0].prompt).toContain('仅溯源，不访问、打开或解析此链接');
    expect(tasks()[0].prompt).not.toContain('读取此抖音链接的视频');
    expect((await projects.read(project.id)).jobs[0].sourceStoryId).toBe(project.mobileStory!.id);
  });
  it('keeps legacy link jobs read-only and allows migrating a blocked project to a new pasted-story task', async (): Promise<void> => {
    const { port, core, tasks } = taskPort();
    const chat = new PetStoryChatService(projects, port);
    await chat.prepare(project.id, 'TEST legacy request', 'analysis');
    let p = await projects.read(project.id);
    p.mobileStory = undefined;
    p.source.status = 'blocked';
    p.jobs[0].sourceStoryId = undefined;
    p = await projects.write(p);
    const oldId = p.jobs[0].id;
    await expect(chat.bindRun(p.id, oldId, 'TEST legacy run')).rejects.toThrow('旧版');
    p = await projects.saveMobileStory(p.id, p.revision, 'TEST 手机新原文：进店找礼物，店员帮忙后道谢离开。');
    expect(p.jobs[0]).toMatchObject({ id: oldId, status: 'invalid', taskId: tasks()[0].id });
    await expect(chat.retryUnsubmitted(p.id, oldId)).rejects.toThrow();
    await chat.prepare(p.id, analysisPrompt(p), 'analysis');
    expect(tasks()).toHaveLength(2);
    expect(tasks()[0].runtime).toBeUndefined();
    await complete(core, tasks()[1], testAnswer());
    const result = await chat.collect(p.id, (await projects.read(p.id)).jobs[1].id);
    expect(result.success).toBe(true);
    expect(result.project!.plan!.shots).toHaveLength(4);
  });
  it('blocks story replacement while a task is bound and protects saved final prompts from source/story replacement', async (): Promise<void> => {
    const { port, core, tasks } = taskPort();
    const chat = new PetStoryChatService(projects, port);
    await chat.prepare(project.id, 'TEST keep story and final', 'analysis');
    let p = await projects.read(project.id);
    await expect(projects.saveMobileStory(p.id, p.revision, 'TEST changed')).rejects.toThrow('尚未核对');
    await complete(core, tasks()[0], testAnswer());
    p = (await chat.collect(p.id, p.jobs[0].id)).project!;
    const edited = structuredClone(p.plan!);
    edited.shots[0].prompts.firstFrame.final = 'TEST user final must survive';
    p = await projects.savePlan(p.id, p.revision, edited);
    await expect(projects.saveMobileStory(p.id, p.revision, 'TEST changed')).rejects.toThrow('保留现有最终提示词');
    await expect(projects.saveSource(p.id, p.revision, 'https://v.douyin.com/TEST_CHANGED/')).rejects.toThrow('保留现有最终提示词');
    expect((await projects.read(p.id)).plan!.shots[0].prompts.firstFrame.final).toBe('TEST user final must survive');
  });
  it('retains a stale story reply as raw text without applying it or requesting a repair', async (): Promise<void> => {
    const { port, core, tasks } = taskPort();
    const chat = new PetStoryChatService(projects, port);
    await chat.prepare(project.id, 'TEST stale story', 'analysis');
    await complete(core, tasks()[0], testAnswer());
    const p = await projects.read(project.id);
    p.mobileStory!.id = '11111111-1111-4111-8111-111111111111';
    await projects.write(p);
    const result = await chat.collect(p.id, p.jobs[0].id);
    expect(result).toMatchObject({ success: false, needsRepair: false });
    expect(result.project!.jobs[0].rawText).toBe(testAnswer());
    expect(result.project!.plan).toBeUndefined();
    expect(tasks()).toHaveLength(1);
  });
  it.each(['video_prompt_not_ready', 'video_assets_not_ready', 'chat_assets_not_ready', 'page_unrecognized', 'page_changed', 'cancelled'] as const)('retries the same never-submitted %s failure as hold and binds a new run without creating another task', async (code): Promise<void> => {
    const { port, core, tasks } = taskPort();
    const chat = new PetStoryChatService(projects, port);
    const prepared = await chat.prepare(project.id, 'TEST analysis', 'analysis');
    const job = prepared.project!.jobs[0];
    const task = tasks()[0];
    const runtime: TaskRunSnapshot = { runId: 'TEST-old-run', attempt: 1, stage: 'failed', message: 'TEST attachment failure', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { prompt: task.prompt, mode: 'chat', attachments: [] } };
    core.updateRuntime({ taskId: task.id, status: code === 'page_unrecognized' ? 'waiting_verification' : 'fail', runtime, errorInfo: { code, message: 'TEST pre-submit error', recoverable: true, detectedAt: now } });
    await chat.bindRun(project.id, job.id, runtime.runId);
    const retried = await chat.retryUnsubmitted(project.id, job.id);
    expect(retried.project!.jobs[0].runId).toBeUndefined();
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0]).toMatchObject({ id: task.id, status: 'queued', executionIntent: 'hold' });
    expect(tasks()[0].runHistory?.[0]).toMatchObject({ runId: runtime.runId });
    core.updateRuntime({ taskId: task.id, status: 'executing', runtime: { ...runtime, runId: 'TEST-new-run', attempt: 2, stage: 'uploading_assets' } });
    expect((await chat.bindRun(project.id, job.id, 'TEST-new-run')).project!.jobs[0].runId).toBe('TEST-new-run');
    expect(tasks()[0].runtime?.submittedAt).toBeUndefined();
    expect(tasks()).toHaveLength(1);
  });
  it.each(['submitted', 'uncertain', 'wrong-run', 'page-changed-submitted'] as const)('refuses attachment retry for %s evidence', async (reason): Promise<void> => {
    const { port, core, tasks } = taskPort();
    const chat = new PetStoryChatService(projects, port);
    const prepared = await chat.prepare(project.id, 'TEST unsafe retry', 'analysis');
    const task = tasks()[0]; const job = prepared.project!.jobs[0];
    const runtime: TaskRunSnapshot = { runId: 'TEST-bound', attempt: 1, stage: 'failed', message: 'TEST failed', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { prompt: task.prompt, mode: 'chat', attachments: [] } };
    core.updateRuntime({ taskId: task.id, status: 'fail', runtime, errorInfo: { code: reason === 'page-changed-submitted' ? 'page_changed' : 'chat_assets_not_ready', message: 'TEST upload', recoverable: true, detectedAt: now } });
    await chat.bindRun(project.id, job.id, runtime.runId);
    core.updateRuntime({ taskId: task.id, runtime: reason === 'wrong-run' ? { ...runtime, runId: 'TEST-other' } : reason === 'submitted' || reason === 'page-changed-submitted' ? { submittedAt: now } : {},
      errorInfo: reason === 'uncertain' ? { code: 'submission_uncertain', message: 'TEST uncertain', recoverable: false, detectedAt: now } : undefined });
    await expect(chat.retryUnsubmitted(project.id, job.id)).rejects.toThrow();
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0].status).toBe('fail');
    expect((await projects.read(project.id)).jobs[0].runId).toBe('TEST-bound');
  });
  it('does not requeue or dispatch when saving the retry binding fails', async (): Promise<void> => {
    const { port, core, tasks } = taskPort();
    const chat = new PetStoryChatService(projects, port);
    const prepared = await chat.prepare(project.id, 'TEST write failure', 'analysis'); const task = tasks()[0];
    const runtime: TaskRunSnapshot = { runId: 'TEST-run', attempt: 1, stage: 'failed', message: 'TEST upload', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { prompt: task.prompt, mode: 'chat', attachments: [] } };
    core.updateRuntime({ taskId: task.id, status: 'fail', runtime, errorInfo: { code: 'chat_assets_not_ready', message: 'TEST upload', recoverable: true, detectedAt: now } });
    await chat.bindRun(project.id, prepared.project!.jobs[0].id, runtime.runId);
    const broken = new PetStoryProjects(async (): Promise<void> => { throw new Error('TEST retry manifest write failed'); });
    const opened = await broken.open(directory);
    await expect(new PetStoryChatService(broken, port).retryUnsubmitted(opened.id, opened.jobs[0].id)).rejects.toThrow('manifest');
    expect(tasks()[0].status).toBe('fail');
    expect((await projects.read(project.id)).jobs[0].runId).toBe(runtime.runId);
  });
  it('atomically preserves prior manifest on rename failure and rejects traversal/symlink escape', async (): Promise<void> => {
    const before = await fs.readFile(path.join(directory, 'project.json'), 'utf8');
    const broken = new PetStoryProjects(async (): Promise<void> => { throw new Error('TEST rename failed'); });
    const opened = await broken.open(directory);
    await expect(broken.write(opened)).rejects.toThrow('rename');
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(before);
    await expect(projectPath(directory, '../outside')).rejects.toThrow('越界');
    await fs.symlink(os.tmpdir(), path.join(directory, 'escape'));
    await expect(projectPath(directory, 'escape/file')).rejects.toThrow('符号链接');
  });
  it('rejects a reopened local-video source and invalid shot duration without altering the file', async (): Promise<void> => {
    const invalid = { ...project, source: { kind: 'local_video', path: '/TEST/source.mp4' } };
    const file = path.join(directory, 'project.json');
    const content = JSON.stringify(invalid);
    await fs.writeFile(file, content);
    await expect(new PetStoryProjects().open(directory)).rejects.toThrow('仅接受抖音');
    expect(await fs.readFile(file, 'utf8')).toBe(content);
  });
  it('binds a held Chat task before execution, saves full raw body/run ID and accepts the dynamic plan', async (): Promise<void> => {
    const { port, core, tasks } = taskPort();
    const chat = new PetStoryChatService(projects, port);
    const prepared = await projects.serial(project.id, (): Promise<unknown> => chat.prepare(project.id, 'TEST request %%%%%%%%%% kept as one task', 'analysis'));
    expect(prepared).toMatchObject({ success: true });
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0].executionIntent).toBe('hold');
    const raw = '```json\n' + testAnswer() + '\n```';
    await complete(core, tasks()[0], raw);
    const result = await chat.collect(project.id, (await projects.read(project.id)).jobs[0].id);
    expect(result.success).toBe(true);
    expect(result.project?.jobs[0]).toMatchObject({ rawText: raw, runId: 'test-run', status: 'applied' });
    expect(result.project?.plan?.shots).toHaveLength(4);
    expect(result.project?.source.status).toBe('review_required');
    expect(tasks()).toHaveLength(1);
    expect((await new PetStoryProjects().open(directory)).jobs[0].rawText).toBe(raw);
  });
  it('stores malformed JSON before parsing and permits only one bound repair task', async (): Promise<void> => {
    const { port, core, tasks } = taskPort();
    const chat = new PetStoryChatService(projects, port);
    await chat.prepare(project.id, 'TEST bad format', 'analysis');
    await complete(core, tasks()[0], '{invalid TEST JSON');
    const id = (await projects.read(project.id)).jobs[0].id;
    expect(await chat.collect(project.id, id)).toMatchObject({ success: false, needsRepair: true });
    expect((await projects.read(project.id)).jobs[0].rawText).toBe('{invalid TEST JSON');
    await chat.prepare(project.id, 'TEST repair', 'repair', id);
    await complete(core, tasks()[1], 'still invalid TEST JSON');
    const repair = (await projects.read(project.id)).jobs[1];
    expect(await chat.collect(project.id, repair.id)).toMatchObject({ success: false, needsRepair: false });
    await expect(chat.prepare(project.id, 'TEST repair again', 'repair', id)).rejects.toThrow('已使用一次');
    expect(tasks()).toHaveLength(2);
  });
  it('keeps the pasted original on insufficient stories, creates no media tasks, and allows correcting the same project link', async (): Promise<void> => {
    const { port, core, tasks } = taskPort();
    const chat = new PetStoryChatService(projects, port);
    await chat.prepare(project.id, 'TEST unavailable', 'analysis');
    await complete(core, tasks()[0], JSON.stringify({ storyUsable: false, reason: 'TEST link unavailable' }));
    const p = await projects.read(project.id);
    const result = await chat.collect(project.id, p.jobs[0].id);
    expect(result.project?.source.status).toBe('blocked');
    expect(result.project?.plan).toBeUndefined();
    expect(result.needsRepair).toBe(false);
    expect(tasks()).toHaveLength(1);
    const corrected = await projects.saveSource(project.id, result.project?.revision || 0, 'https://v.douyin.com/TEST_CORRECTED/');
    expect(corrected.id).toBe(project.id);
    expect(corrected.accountId).toBe(project.accountId);
    expect(corrected.jobs[0].rawText).toContain('TEST link unavailable');
    expect(corrected.mobileStory).toBeUndefined();
  });
  it('does not treat metadata alone or a missing saved body as a completed analysis', async (): Promise<void> => {
    const { port, core, tasks } = taskPort();
    const chat = new PetStoryChatService(projects, port);
    await chat.prepare(project.id, 'TEST metadata', 'analysis');
    const jobId = (await projects.read(project.id)).jobs[0].id;
    await expect(chat.collect(project.id, jobId)).rejects.toThrow('尚无已保存');
    await complete(core, tasks()[0], JSON.stringify({ storyUsable: true, title: 'TEST title', cover: 'TEST cover' }));
    const result = await chat.collect(project.id, jobId);
    expect(result.success).toBe(false);
    expect(result.project?.source.status).toBe('pending');
    expect(result.project?.plan).toBeUndefined();
  });
  it('coalesces duplicate prepares through project serialization and blocks orphan re-creation after uncertain manifest save', async (): Promise<void> => {
    const { port, tasks } = taskPort();
    const chat = new PetStoryChatService(projects, port);
    const results = await Promise.allSettled([1, 2].map((): Promise<PetStoryResult> => projects.serial(project.id, (): Promise<PetStoryResult> => chat.prepare(project.id, 'TEST repeated', 'analysis'))));
    expect(results.filter((r): boolean => r.status === 'fulfilled')).toHaveLength(1);
    expect(tasks()).toHaveLength(1);
    const otherDir = await fs.mkdtemp(path.join(directory, 'other-'));
    let fail = true;
    const broken = new PetStoryProjects(async (a: string, b: string): Promise<void> => { if (fail) throw new Error('TEST disk'); await fs.rename(a, b); });
    const other = await broken.create(otherDir, 'studio-test', 'account-test');
    fail = false;
    const withLink = await broken.saveSource(other.id, 0, 'https://v.douyin.com/TEST_OTHER/');
    const withSource = await broken.saveMobileStory(other.id, withLink.revision, 'TEST 手机原文：进店找礼物，店员找到后道谢离开。');
    fail = true;
    const uncertain = new PetStoryChatService(broken, port);
    await expect(uncertain.prepare(withSource.id, 'TEST uncertain write', 'analysis')).rejects.toThrow('TEST disk');
    fail = false;
    await expect(uncertain.prepare(withSource.id, 'TEST uncertain write', 'analysis')).rejects.toThrow('未绑定任务');
    expect(tasks()).toHaveLength(2);
    expect(tasks().every((t): boolean => t.executionIntent === 'hold')).toBe(true);
  });
  it('preserves a user final edit arriving during selected optimization, with no media regeneration', async (): Promise<void> => {
    const { port, core, tasks } = taskPort();
    const chat = new PetStoryChatService(projects, port);
    await chat.prepare(project.id, 'TEST analysis', 'analysis'); await complete(core, tasks()[0], testAnswer());
    await chat.collect(project.id, (await projects.read(project.id)).jobs[0].id);
    const optimized = await chat.prepare(project.id, 'TEST selected optimization', 'optimize', undefined, 's1', 'video');
    let p = await projects.read(project.id);
    const edit = structuredClone(p.plan) as PetStoryPlan;
    edit.shots[0].prompts.video.final = 'TEST manually edited after request';
    p = await projects.savePlan(p.id, p.revision, edit);
    await complete(core, tasks()[1], JSON.stringify({ optimized: 'TEST newer AI suggestion' }));
    const job = optimized.project?.jobs[1];
    const result = await chat.collect(project.id, job?.id || '');
    const final = result.project?.plan?.shots[0].prompts.video;
    expect(final?.final).toBe('TEST manually edited after request');
    expect(final?.optimized).toBe('TEST newer AI suggestion');
    expect(final?.original).toContain('测试原始');
    expect(tasks().every((t): boolean => t.mode === 'chat')).toBe(true);
    expect(p.plan?.characters).toHaveLength(3);
  });
  it('routes final edited text into actual TaskService hold inputs; no delimiter split or implicit execution', async (): Promise<void> => {
    const { core, tasks } = taskPort();
    const p = testPlan();
    p.shots[0].prompts.firstFrame.final = 'TEST final %%%%%%%%%% one task';
    const input = finalTaskInput(p, 's1', 'firstFrame', ['TEST clerk.png', 'TEST lulu.png'], 'studio-test');
    const result = core.create(input);
    expect(result.success).toBe(true);
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0]).toMatchObject({ prompt: input.prompts[0], executionIntent: 'hold', status: 'queued', mode: 'image', attachments: ['TEST clerk.png', 'TEST lulu.png'] });
    expect(tasks()[0].runtime).toBeUndefined();
    expect((): unknown => finalTaskInput(p, 's1', 'video', [], 'studio-test')).toThrow('已核实');
    for (const duration of [5, 10]) {
      p.shots[0].durationSeconds = duration;
      expect(finalTaskInput(p, 's1', 'video', [], 'studio-test', { model: 'seedance-2.0', duration: `${duration}s` as '5s' | '10s', aspectRatio: '9:16' }).videoConfig?.duration).toBe(`${duration}s`);
    }
  });
});

describe('PetStory final draft integration — offline tests only', (): void => {
  it('requires approved base images and the explicit shot production entry before a new draft', async (): Promise<void> => {
    const { port, core, tasks } = taskPort(); const chat = new PetStoryChatService(projects, port);
    await chat.prepare(project.id, 'TEST analysis', 'analysis');
    await complete(core, tasks()[0], testAnswer());
    const p = await projects.read(project.id); await chat.collect(p.id, p.jobs[0].id);
    await expect(chat.draft(p.id, 's1', 'firstFrame')).rejects.toThrow('确认实际基础图片');
    expect(tasks().filter((t): boolean => t.mode !== 'chat')).toHaveLength(0);
  });
  it('retains the current plan when saving the same source link again, and does not clamp invalid manual edits', async (): Promise<void> => {
    const { port, core, tasks } = taskPort();
    const chat = new PetStoryChatService(projects, port);
    await chat.prepare(project.id, 'TEST preserve plan', 'analysis');
    await complete(core, tasks()[0], testAnswer());
    const result = await chat.collect(project.id, (await projects.read(project.id)).jobs[0].id);
    const p = result.project as PetStoryProject;
    const same = await projects.saveSource(p.id, p.revision, p.source.url);
    expect(same.plan?.shots).toHaveLength(4);
    const edited = structuredClone(same.plan) as PetStoryPlan;
    edited.shots[0].durationSeconds = 11;
    await expect(projects.savePlan(same.id, same.revision, edited)).rejects.toThrow('5～10');
    expect((await projects.read(p.id)).plan?.shots[0].durationSeconds).toBe(5);
  });
});
