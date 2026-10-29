/** 离线自由对话回归：真实项目文件与正式 Chat 校验，任务仅保存在内存，不访问平台。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadJob, PetStoryChatAdjustment, PetStoryChatJob, PetStoryConversationReply, PetStoryPlan, PetStoryProject, Task, TaskAddParams, TaskDownloadOutputsParams, TaskDownloadOutputsResult, TaskRunSnapshot } from '@doubao-studio/contracts';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { PetStoryChatService } from '../../main/utils/petstoryChat';
import { PetStoryAdjustmentService, adjustmentConversationUrl, conversationReplyKey } from '../../main/utils/petstoryAdjustment';
import { claimConversationGuard, hasConversationGuard, releaseConversationGuard } from '../../main/utils/accountConversationGuard';
import { TaskService } from '../../main/core/TaskService';
import { syncMaterials } from '../../main/utils/petstoryMaterials';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { mediaCommand } from '../../main/utils/petstoryMedia';

let directory: string; let projects: PetStoryProjects; let project: PetStoryProject; let core: TaskService; let chats: PetStoryChatService; let service: PetStoryAdjustmentService; let stored: Task[]; let source: PetStoryChatJob;
const url = 'https://www.doubao.com/chat/TEST-original-conversation';
const target = { shotId: 'shot_1', promptKind: 'firstFrame' as const };
const originalBody = snapshot.plan.shots[0].prompts.firstFrame.optimized;
function plan(): PetStoryPlan {
  const result = structuredClone(snapshot.plan) as PetStoryPlan;
  result.props = []; result.scenes = [{ id: 'road', name: '村道', location: result.shots[0].scene, time: '未指定', lighting: '原方案自然光', layout: '路边与民居', view: '原方案视角', designOrigin: 'script' }];
  for (const character of result.characters) delete character.referenceAssetId;
  for (const shot of result.shots) { shot.sceneId = 'road'; shot.propIds = []; shot.propStates = []; }
  return result;
}
function reply(text: string, index: number): PetStoryConversationReply {
  const content = { text, precedingUserText: `TEST 自由讨论 ${index}`, turnId: `TEST-turn-${index}`, messageId: `TEST-message-${index}` };
  return { ...content, key: conversationReplyKey(content), capturedAt: new Date().toISOString() };
}
async function begin(): Promise<PetStoryChatAdjustment> {
  const result = await service.begin(project.id, project.revision, target);
  project = result.project!; return result.adjustment!;
}
async function capture(adjustment: PetStoryChatAdjustment, replies: PetStoryConversationReply[]): Promise<void> {
  const result = await service.capture(project.id, adjustment.id, url, replies); project = result.project!;
}
async function collectPlanJob(job: PetStoryChatJob, valid: boolean, invalidDuration = false): Promise<void> {
  const task = stored.find((item): boolean => item.id === job.taskId)!; const now = new Date().toISOString(); const incoming = plan();
  if (!valid && invalidDuration) incoming.shots[0].durationSeconds = 4;
  // 完整结构但演员角色与已保存配置不符：保留 parsedResult.plan 的真实 invalid 分支。
  else if (!valid) incoming.characters[0].role = 'supporting';
  const content = { requestId: job.requestId, targetIds: job.expectedIds, storyUsable: true, contentBasis: { beginning: incoming.shots[0].startState, middle: incoming.shots[2].action, ending: incoming.shots.at(-1)!.endState }, ...incoming };
  const runtime: TaskRunSnapshot = { runId: `TEST-plan-${job.id}`, attempt: 1, stage: 'completed', message: 'TEST 离线方案原回复', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, conversationUrl: `${url}-${job.kind}`, input: { prompt: task.prompt, mode: 'chat', attachments: [] }, chatResponse: { text: JSON.stringify(content), capturedAt: now } };
  const completed = core.updateRuntime({ taskId: task.id, status: 'done', runtime }); if (!completed.success) throw new Error(completed.error);
  project = (await chats.bindRun(project.id, job.id, runtime.runId)).project!;
  const collected = await chats.collect(project.id, job.id); project = collected.project!; expect(collected.success).toBe(valid);
}
beforeEach(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-petstory-adjustment-'));
  projects = new PetStoryProjects(); project = await projects.create(directory, 'TEST-studio', 'TEST-adjustment-account');
  project = await projects.saveMobileStory(project.id, project.revision, snapshot.mobileStory);
  project.plan = plan(); project.materials = syncMaterials(project); project = await projects.write(project);
  stored = []; let sequence = 0;
  core = new TaskService({ store: { read: (): Task[] => structuredClone(stored), replace: (items: Task[]): boolean => { stored = structuredClone(items); return true; } }, defaultProjectId: (): string => project.studioProjectId, id: (): string => `TEST-adjustment-task-${++sequence}` });
  const port = { setConversationGuard: (taskId: string, projectId: string, adjustmentId: string, active: boolean): void => core.setConversationGuard(taskId, projectId, adjustmentId, active), list: (): Task[] => structuredClone(stored), create: (params: TaskAddParams, accountId: string): Task => { const made = core.create(params); if (!made.success) throw new Error(made.error); const assigned = core.assign({ taskId: made.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error); return assigned.data; } };
  chats = new PetStoryChatService(projects, port); service = new PetStoryAdjustmentService(projects, port, chats);
  const prepared = await chats.prepareRuntime(project.id, project.revision, 'optimize', target); project = prepared.project!; source = project.jobs.at(-1)!;
  const task = stored[0]; const now = new Date().toISOString();
  const runtime: TaskRunSnapshot = { runId: 'TEST-original-run', attempt: 1, stage: 'completed', message: 'TEST 离线已保存回复', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, conversationUrl: url, input: { prompt: task.prompt, mode: 'chat', attachments: task.attachments || [] }, chatResponse: { text: JSON.stringify({ requestId: source.requestId, targetIds: source.expectedIds, optimized: originalBody }), capturedAt: now } };
  const updated = core.updateRuntime({ taskId: task.id, status: 'done', runtime }); if (!updated.success) throw new Error(updated.error);
  project = (await chats.bindRun(project.id, source.id, runtime.runId)).project!; project = (await chats.collect(project.id, source.id)).project!;
  source = project.jobs.find((job): boolean => job.id === source.id)!;
});
afterEach(async (): Promise<void> => {
  vi.restoreAllMocks();
  const current = await projects.read(project.id).catch((): null => null);
  if (current?.chatAdjustment) releaseConversationGuard(current.accountId, current.chatAdjustment.id);
  releaseConversationGuard('TEST-guard-account', 'TEST-adjustment-a'); releaseConversationGuard('TEST-guard-account', 'TEST-adjustment-b');
  await fs.rm(directory, { recursive: true, force: true });
});

describe('具体回复与目标保护', (): void => {
  it('选择具体纯图片回复后沿原账号下载并保存候选，未确认前保留旧图；重收取不重复下载', async (): Promise<void> => {
    project = await projects.confirmStory(project.id, project.revision);
    const file = path.join(directory, 'TEST-reply.png'); await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=green:s=64x96', '-frames:v', '1', '-y', file]);
    project = await projects.addShotImage(project.id, project.revision, target.shotId, target.promptKind, file); const old = project.assets.at(-1)!;
    project = await projects.adoptImage(project.id, project.revision, { shotId: target.shotId, kind: target.promptKind }, old.id);
    const adjustment = await begin(); const jobs: DownloadJob[] = []; const beforeTasks = structuredClone(stored);
    const download = vi.fn(async (params: TaskDownloadOutputsParams): Promise<TaskDownloadOutputsResult> => {
      const item = params.outputs[0]; const job: DownloadJob = { id: `TEST-download-${jobs.length}`, taskId: item.taskId, accountId: item.accountId, mode: 'image', url: item.outputs[0], status: 'done', filePath: file, attempts: 1, saveDir: directory, createdAt: project.updatedAt, updatedAt: project.updatedAt };
      jobs.push(job); return { success: true, count: 1, failed: 0, jobIds: [job.id] };
    });
    const images = new PetStoryAdjustmentService(projects, { list: (): Task[] => stored, create: (): never => { throw new Error('不可新增生成任务'); } }, chats, { downloads: (): DownloadJob[] => jobs, download });
    const content = { ...reply('', 7), imageUrls: ['https://p3.byteimg.com/TEST-chosen.png', 'https://p3.byteimg.com/TEST-chosen-2.png'] }; content.key = conversationReplyKey(content);
    project = (await images.capture(project.id, adjustment.id, url, [content])).project!;
    const result = await images.importImages(project.id, project.revision, adjustment.id, content.key); expect(result.success).toBe(true); project = result.project!;
    expect(project.adoptedImages?.[target.shotId]?.firstFrameId).toBe(old.id); expect(project.assets).toHaveLength(3);
    const candidate = project.assets.at(-1)!; expect(candidate.imageReview).toMatchObject({ state: 'candidate', target: { shotId: target.shotId, kind: target.promptKind }, sourceReply: { adjustmentId: adjustment.id, replyKey: content.key } });
    expect(download).toHaveBeenCalledTimes(2); expect(download.mock.calls[0][0].outputs[0]).toMatchObject({ taskId: source.taskId, accountId: project.accountId, mode: 'image', outputs: [content.imageUrls[0]] });
    project = (await images.importImages(project.id, project.revision, adjustment.id, content.key)).project!;
    expect(download).toHaveBeenCalledTimes(2); expect(project.assets).toHaveLength(3); expect(stored).toEqual(beforeTasks);
    project = await projects.adoptImage(project.id, project.revision, { shotId: target.shotId, kind: target.promptKind }, candidate.id);
    expect(project.adoptedImages?.[target.shotId]?.firstFrameId).toBe(candidate.id); expect(project.assets.find((asset): boolean => asset.id === old.id)).toBeDefined();
    expect(project.assets.find((asset): boolean => asset.id === candidate.id)?.imageReview?.sourceReply?.replyKey).toBe(content.key);
  });

  it('图片回复没有本次稳定核对、key不符或来源不明时不会下载或改变正式图片', async (): Promise<void> => {
    project = await projects.confirmStory(project.id, project.revision); const adjustment = await begin();
    const download = vi.fn(async (): Promise<TaskDownloadOutputsResult> => ({ success: false, count: 0, failed: 1 }));
    const images = new PetStoryAdjustmentService(projects, { list: (): Task[] => stored, create: (): never => { throw new Error('不可新增生成任务'); } }, chats, { downloads: (): DownloadJob[] => [], download });
    const content = { ...reply('', 8), imageUrls: ['https://unrelated.invalid/TEST.png'] }; content.key = conversationReplyKey(content);
    await expect(images.importImages(project.id, project.revision, adjustment.id, content.key)).rejects.toThrow('核对');
    await expect(images.capture(project.id, adjustment.id, url, [{ ...content, imageUrls: ['https://p3.byteimg.com/TEST.png'] }])).rejects.toThrow('读取期间发生变化');
    project = (await images.capture(project.id, adjustment.id, url, [content])).project!;
    const result = await images.importImages(project.id, project.revision, adjustment.id, content.key);
    expect(result.success).toBe(false); expect(result.error).toMatch(/不是可核对的豆包图片来源/); expect(download).not.toHaveBeenCalled(); expect(result.project?.assets).toEqual(project.assets);
  });
  it('图片候选及回复来源一次原子保存；写入失败再试不会遗留无来源候选或重复图片', async (): Promise<void> => {
    project = await projects.confirmStory(project.id, project.revision); const adjustment = await begin();
    const file = path.join(directory, 'TEST-atomic.png'); await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x96', '-frames:v', '1', '-y', file]);
    const imageUrl = 'https://p3.byteimg.com/TEST-atomic.png'; const job: DownloadJob = { id: 'TEST-atomic-download', taskId: source.taskId, accountId: project.accountId, mode: 'image', url: imageUrl, status: 'done', filePath: file, attempts: 1, saveDir: directory, createdAt: project.updatedAt, updatedAt: project.updatedAt };
    const download = vi.fn(async (): Promise<TaskDownloadOutputsResult> => { throw new Error('已下载原图不重复请求'); });
    const images = new PetStoryAdjustmentService(projects, { list: (): Task[] => stored, create: (): never => { throw new Error('不可新增生成任务'); } }, chats, { downloads: (): DownloadJob[] => [job], download });
    const content = { ...reply('', 10), imageUrls: [imageUrl] }; content.key = conversationReplyKey(content); project = (await images.capture(project.id, adjustment.id, url, [content])).project!;
    const before = await fs.readFile(path.join(directory, 'project.json'), 'utf8');
    const failedWrite = vi.spyOn(projects, 'write').mockRejectedValueOnce(new Error('TEST 原子保存失败'));
    const failure = await images.importImages(project.id, project.revision, adjustment.id, content.key);
    expect(failedWrite).toHaveBeenCalledOnce(); expect(failedWrite.mock.calls[0][0].assets[0].imageReview?.sourceReply).toMatchObject({ adjustmentId: adjustment.id, replyKey: content.key });
    expect(failure.success).toBe(false); expect(failure.project?.assets).toEqual([]); expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(before);
    failedWrite.mockRestore(); project = (await images.importImages(project.id, project.revision, adjustment.id, content.key)).project!;
    expect(project.assets).toHaveLength(1); expect(project.assets[0].imageReview?.sourceReply?.replyKey).toBe(content.key); expect(download).not.toHaveBeenCalled();
  });
  it('回复多图的后续下载失败保住先取得的候选，明确重试只补原回复缺图', async (): Promise<void> => {
    project = await projects.confirmStory(project.id, project.revision); const adjustment = await begin();
    const file = path.join(directory, 'TEST-retry.png'); await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x96', '-frames:v', '1', '-y', file]);
    const jobs: DownloadJob[] = []; let failSecond = true;
    const download = vi.fn(async (params: TaskDownloadOutputsParams): Promise<TaskDownloadOutputsResult> => {
      const item = params.outputs[0]; const selectedUrl = item.outputs[0];
      if (failSecond && selectedUrl.endsWith('second.png')) return { success: false, count: 0, failed: 1 };
      const job: DownloadJob = { id: `TEST-retry-${jobs.length}`, taskId: item.taskId, accountId: item.accountId, mode: 'image', url: selectedUrl, status: 'done', filePath: file, attempts: 1, saveDir: directory, createdAt: project.updatedAt, updatedAt: project.updatedAt };
      jobs.push(job); return { success: true, count: 1, failed: 0, jobIds: [job.id] };
    });
    const images = new PetStoryAdjustmentService(projects, { list: (): Task[] => stored, create: (): never => { throw new Error('不可新增生成任务'); } }, chats, { downloads: (): DownloadJob[] => jobs, download });
    const content = { ...reply('', 9), imageUrls: ['https://p3.byteimg.com/TEST-first.png', 'https://p3.byteimg.com/TEST-second.png'] }; content.key = conversationReplyKey(content);
    project = (await images.capture(project.id, adjustment.id, url, [content])).project!;
    const partial = await images.importImages(project.id, project.revision, adjustment.id, content.key); project = partial.project!;
    expect(partial.success).toBe(false); expect(project.assets).toHaveLength(1); expect(project.assets[0].imageReview?.state).toBe('candidate'); expect(project.adoptedImages).toBeUndefined();
    failSecond = false; project = (await images.capture(project.id, adjustment.id, url, [content])).project!;
    const completed = await images.importImages(project.id, project.revision, adjustment.id, content.key); project = completed.project!;
    expect(completed.success).toBe(true); expect(project.assets).toHaveLength(2);
    expect(download.mock.calls.map(([params]): string => params.outputs[0].outputs[0])).toEqual([content.imageUrls[0], content.imageUrls[1], content.imageUrls[1]]);
    expect(stored).toHaveLength(1); expect(project.adoptedImages).toBeUndefined();
  });
  it('尚无正式方案时可从未采用repair方案候选进入自由聊，不提前采用候选或创建任务', async (): Promise<void> => {
    project.plan = undefined; project.materials = undefined; project.storyApproval = undefined; project = await projects.write(project);
    project = (await chats.prepareRuntime(project.id, project.revision, 'analysis')).project!;
    const analysis = project.jobs.at(-1)!; await collectPlanJob(analysis, false, true);
    expect(project.jobs.find((job): boolean => job.id === analysis.id)?.status).toBe('invalid');
    await expect(service.begin(project.id, project.revision, { parentJobId: analysis.id })).rejects.toThrow('具体方案');
    project = (await chats.prepareRuntime(project.id, project.revision, 'repair', { parentJobId: analysis.id })).project!;
    const repair = project.jobs.at(-1)!; await collectPlanJob(repair, true);
    expect(project.plan).toBeUndefined(); expect(project.jobs.find((job): boolean => job.id === repair.id)).toMatchObject({ kind: 'repair', status: 'applied', resultStatus: 'candidate', parsedResult: { plan: expect.any(Object) } });
    const count = stored.length; const started = await service.begin(project.id, project.revision, { parentJobId: repair.id }); project = started.project!;
    expect(started.adjustment).toMatchObject({ sourceJobId: repair.id, target: {}, conversationUrl: `${url}-repair` });
    expect(project.plan).toBeUndefined(); expect(project.materials).toBeUndefined(); expect(project.storyApproval).toBeUndefined();
    expect(project.jobs.find((job): boolean => job.id === repair.id)?.resultStatus).toBe('candidate'); expect(stored).toHaveLength(count);
    expect((await new PetStoryProjects().open(directory)).plan).toBeUndefined();
  });
  it('分析未通过但保留完整候选时不误用；纠正并采用的方案复用真实repair原任务与会话', async (): Promise<void> => {
    project = (await chats.prepareRuntime(project.id, project.revision, 'analysis')).project!;
    const analysis = project.jobs.at(-1)!; await collectPlanJob(analysis, false);
    expect(project.jobs.find((job): boolean => job.id === analysis.id)).toMatchObject({ status: 'invalid', parsedResult: { plan: expect.any(Object) } });
    await expect(service.begin(project.id, project.revision, {})).rejects.toThrow('没有可定位');
    await expect(service.begin(project.id, project.revision, { parentJobId: analysis.id })).rejects.toThrow('没有可定位');
    expect(hasConversationGuard(project.accountId)).toBe(false);
    project = (await chats.prepareRuntime(project.id, project.revision, 'repair', { parentJobId: analysis.id })).project!;
    const repair = project.jobs.at(-1)!; await collectPlanJob(repair, true);
    project = (await chats.adoptPlanCandidate(project.id, project.revision, repair.id)).project!;
    expect(project.jobs.find((job): boolean => job.id === repair.id)).toMatchObject({ kind: 'repair', status: 'applied', resultStatus: 'adopted', parsedResult: { plan: expect.any(Object) } });
    const task = stored.find((item): boolean => item.id === repair.taskId)!; const runId = task.runtime!.runId;
    task.runtime!.runId = 'TEST-later-repair-run';
    await expect(service.begin(project.id, project.revision, {})).rejects.toThrow('没有可定位');
    task.runtime!.runId = runId;
    const count = stored.length; const started = await service.begin(project.id, project.revision, {}); project = started.project!;
    expect(started.adjustment).toMatchObject({ sourceJobId: repair.id, target: {}, conversationUrl: `${url}-repair` });
    expect(stored).toHaveLength(count);
    expect(stored.find((item): boolean => item.id === repair.taskId)?.runtime?.chatAdjustmentGuard?.active).toBe(true);
    expect(stored.find((item): boolean => item.id === analysis.taskId)?.runtime?.chatAdjustmentGuard).toBeUndefined();
  });
  it('重启前已保存的任务保护先于项目重开阻止排队提交，结束后才释放', async (): Promise<void> => {
    const adjustment = await begin();
    expect(stored[0].runtime?.chatAdjustmentGuard).toEqual({ projectId: project.id, adjustmentId: adjustment.id, active: true });
    releaseConversationGuard(project.accountId, adjustment.id);
    const restarted = new TaskService({ store: { read: (): Task[] => structuredClone(stored), replace: (items: Task[]): boolean => { stored = structuredClone(items); return true; } }, defaultProjectId: (): string => project.studioProjectId, id: (): string => 'TEST-queued-after-restart' });
    const made = restarted.create({ prompts: ['TEST queued'], mode: 'chat', executionIntent: 'hold' }); if (!made.success) throw new Error(made.error);
    const assigned = restarted.assign({ taskId: made.data[0].id, accountId: project.accountId }); if (!assigned.success) throw new Error(assigned.error);
    expect(restarted.acquireLock({ taskId: assigned.data.id, ownerId: 'TEST-owner' })).toMatchObject({ success: false, error: expect.stringContaining('豆包调整') });
    core = restarted; service.restore(project); expect(hasConversationGuard(project.accountId)).toBe(true);
    await service.end(project.id, project.revision, adjustment.id);
    expect(restarted.acquireLock({ taskId: assigned.data.id, ownerId: 'TEST-owner' }).success).toBe(true);
  });
  it('项目已采用但释放保护失败时可幂等重试，不重复添加采用回复', async (): Promise<void> => {
    const adjustment = await begin(); const chosen = reply(`${originalBody}\n`, 1); await capture(adjustment, [chosen]);
    const original = core.setConversationGuard.bind(core); let failed = false;
    vi.spyOn(core, 'setConversationGuard').mockImplementation((taskId: string, projectId: string, adjustmentId: string, active: boolean): void => { if (!active && !failed) { failed = true; throw new Error('TEST release save failed'); } original(taskId, projectId, adjustmentId, active); });
    await expect(service.adopt(project.id, project.revision, adjustment.id, chosen.key)).rejects.toThrow('TEST release save failed');
    const saved = await projects.read(project.id); expect(saved.chatAdjustment?.status).toBe('adopted'); expect(stored[0].runtime?.chatAdjustmentGuard?.active).toBe(true);
    const result = await service.adopt(project.id, project.revision, adjustment.id, chosen.key);
    expect(result.project?.jobs.length).toBe(saved.jobs.length); expect(stored[0].runtime?.chatAdjustmentGuard?.active).toBe(false);
  });

  it('回读不自动采用最后一条；明确采用所选回复只更新当前镜头并保留真实原文', async (): Promise<void> => {
    const before = structuredClone(project.plan); const adjustment = await begin(); const chosen = reply(`${originalBody}\n`, 1); const latest = reply(`${originalBody}\n\n`, 2);
    const tasksBefore = structuredClone(stored); await capture(adjustment, [chosen, latest]);
    expect(project.plan).toEqual(before); expect(project.chatAdjustment?.adoptedReplyKey).toBeUndefined();
    const result = await service.adopt(project.id, project.revision, adjustment.id, chosen.key); project = result.project!;
    expect(project.plan!.shots[0].prompts.firstFrame.final).toBe(chosen.text);
    expect(project.plan!.shots.slice(1)).toEqual(before!.shots.slice(1)); expect(project.plan!.shots[0].prompts.video).toEqual(before!.shots[0].prompts.video);
    expect(project.jobs.at(-1)?.conversationReply?.reply).toMatchObject({ key: chosen.key, text: chosen.text, precedingUserText: chosen.precedingUserText, turnId: chosen.turnId, messageId: chosen.messageId }); expect(project.chatAdjustment).toMatchObject({ status: 'adopted', adoptedReplyKey: chosen.key });
    expect(stored).toHaveLength(tasksBefore.length);
    expect(stored.map((task): object => ({ id: task.id, prompt: task.prompt, runId: task.runtime?.runId, response: task.runtime?.chatResponse }))).toEqual(tasksBefore.map((task): object => ({ id: task.id, prompt: task.prompt, runId: task.runtime?.runId, response: task.runtime?.chatResponse })));
    expect(stored[0].runtime?.chatAdjustmentGuard?.active).toBe(false); expect(hasConversationGuard(project.accountId)).toBe(false);
    expect((await new PetStoryProjects().open(directory)).plan).toEqual(project.plan);
  });
  it('正文预览返回将采用的完整正文，但不写盘、不修改任务或释放账号保护', async (): Promise<void> => {
    const adjustment = await begin(); const chosen = reply(`${originalBody}\n`, 1); await capture(adjustment, [chosen]);
    const before = await fs.readFile(path.join(directory, 'project.json'), 'utf8'); const tasksBefore = structuredClone(stored);
    const result = await service.preview(project.id, project.revision, adjustment.id, chosen.key);
    expect(result.preview).toEqual({ target, previousBody: project.plan!.shots[0].prompts.firstFrame.final, body: chosen.text });
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(before); expect(stored).toEqual(tasksBefore); expect(hasConversationGuard(project.accountId)).toBe(true);
    expect((await projects.read(project.id)).chatAdjustment?.status).toBe('active');
  });
  it('方案预览返回完整将采用方案，含人物场景与全部镜头；确认前不保存，确认后与预览一致', async (): Promise<void> => {
    const prepared = await chats.prepareRuntime(project.id, project.revision, 'analysis'); project = prepared.project!;
    const job = project.jobs.at(-1)!; const task = stored.find((item): boolean => item.id === job.taskId)!; const now = new Date().toISOString(); const incoming = plan();
    const content = { requestId: job.requestId, targetIds: job.expectedIds, storyUsable: true, contentBasis: { beginning: incoming.shots[0].startState, middle: incoming.shots[2].action, ending: incoming.shots.at(-1)!.endState }, ...incoming };
    const runtime: TaskRunSnapshot = { runId: 'TEST-analysis-run', attempt: 1, stage: 'completed', message: 'TEST 离线方案原回复', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, conversationUrl: url, input: { prompt: task.prompt, mode: 'chat', attachments: [] }, chatResponse: { text: JSON.stringify(content), capturedAt: now } };
    const completed = core.updateRuntime({ taskId: task.id, status: 'done', runtime }); if (!completed.success) throw new Error(completed.error);
    project = (await chats.bindRun(project.id, job.id, runtime.runId)).project!; project = (await chats.collect(project.id, job.id)).project!;
    const started = await service.begin(project.id, project.revision, {}); project = started.project!; const adjustment = started.adjustment!;
    const chosen = reply(JSON.stringify({ ...content, understanding: 'TEST 完整方案理解', sceneDesign: 'TEST 完整空间与场景安排' }), 3); await capture(adjustment, [chosen]);
    const before = await fs.readFile(path.join(directory, 'project.json'), 'utf8'); const tasksBefore = structuredClone(stored);
    const result = await service.preview(project.id, project.revision, adjustment.id, chosen.key);
    expect(result.preview?.target).toEqual({}); expect(result.preview?.body).toBeUndefined(); expect(result.preview?.previousPlan).toEqual(project.plan);
    expect(result.preview?.plan).toMatchObject({ understanding: 'TEST 完整方案理解', sceneDesign: 'TEST 完整空间与场景安排', characters: incoming.characters, scenes: incoming.scenes });
    expect(result.preview?.plan?.shots).toHaveLength(incoming.shots.length); expect(result.preview?.plan?.shots[2]).toMatchObject({ id: incoming.shots[2].id, action: incoming.shots[2].action, startState: incoming.shots[2].startState, endState: incoming.shots[2].endState });
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(before); expect(stored).toEqual(tasksBefore); expect(hasConversationGuard(project.accountId)).toBe(true);
    const adopted = await service.adopt(project.id, project.revision, adjustment.id, chosen.key); project = adopted.project!; expect(project.plan).toEqual(result.preview?.plan); expect(hasConversationGuard(project.accountId)).toBe(false);
  });
  it('未知回复或旧版本不能取得看似可采用的正式预览', async (): Promise<void> => {
    const adjustment = await begin(); const chosen = reply(originalBody, 1); await capture(adjustment, [chosen]); const before = await fs.readFile(path.join(directory, 'project.json'), 'utf8');
    await expect(service.preview(project.id, project.revision, adjustment.id, 'TEST-missing')).rejects.toThrow('具体回复');
    await expect(service.preview(project.id, project.revision - 1, adjustment.id, chosen.key)).rejects.toThrow('已更新');
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(before); expect(hasConversationGuard(project.accountId)).toBe(true);
  });
  it('没有最近稳定回读或选中的具体回复时拒绝采用', async (): Promise<void> => {
    const adjustment = await begin(); const chosen = reply(originalBody, 1);
    await expect(service.adopt(project.id, project.revision, adjustment.id, chosen.key)).rejects.toThrow('尚未完成本次核对');
    await capture(adjustment, [chosen]); await expect(service.adopt(project.id, project.revision, adjustment.id, 'TEST-no-such-reply')).rejects.toThrow('具体回复');
    expect((await projects.read(project.id)).chatAdjustment?.status).toBe('active');
  });
  it('回读超过有效时间后不能采用旧观察，重新回读后仍由用户明确选择', async (): Promise<void> => {
    const adjustment = await begin(); const chosen = reply(originalBody, 1); await capture(adjustment, [chosen]);
    const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 8001);
    await expect(service.adopt(project.id, project.revision, adjustment.id, chosen.key)).rejects.toThrow('读取稳定');
    await capture(adjustment, [chosen]); const result = await service.adopt(project.id, project.revision, adjustment.id, chosen.key); expect(result.adjustment?.status).toBe('adopted'); clock.mockRestore();
  });
  it('调整中当前正文、素材或目标事实变化时，不覆盖新保存内容', async (): Promise<void> => {
    const adjustment = await begin(); const chosen = reply(originalBody, 1); await capture(adjustment, [chosen]);
    const oldRevision = project.revision; project = await projects.saveShotPrompt(project.id, project.revision, target.shotId, 'firstFrame', 'TEST 用户在别处保存的新正文');
    await expect(service.adopt(project.id, oldRevision, adjustment.id, chosen.key)).rejects.toThrow('不覆盖新版本');
    await expect(service.adopt(project.id, project.revision, adjustment.id, chosen.key)).rejects.toThrow('不覆盖新版本');
    expect((await projects.read(project.id)).plan!.shots[0].prompts.firstFrame.final).toBe('TEST 用户在别处保存的新正文');
  });
  it('当前调整未结束时不能换到其他对象，同目标重开复用原调整', async (): Promise<void> => {
    const adjustment = await begin(); const reopened = await service.begin(project.id, project.revision, target);
    expect(reopened.adjustment?.id).toBe(adjustment.id);
    await expect(service.begin(project.id, project.revision, { shotId: 'shot_2', promptKind: 'video' })).rejects.toThrow('结束当前调整');
    expect(stored).toHaveLength(1);
  });
  it('方案目标相同但候选来源不同不能复用当前调整；同一候选重开保持原会话和保护', async (): Promise<void> => {
    project = (await chats.prepareRuntime(project.id, project.revision, 'analysis')).project!;
    const previous = project.jobs.at(-1)!; await collectPlanJob(previous, true);
    project = (await chats.prepareRuntime(project.id, project.revision, 'analysis')).project!;
    const current = project.jobs.at(-1)!; await collectPlanJob(current, true);
    const started = await service.begin(project.id, project.revision, { parentJobId: current.id }); project = started.project!;
    const adjustment = structuredClone(started.adjustment!); const tasksBefore = structuredClone(stored); const saved = await fs.readFile(path.join(directory, 'project.json'), 'utf8');
    const reopened = await service.begin(project.id, project.revision, { parentJobId: current.id });
    expect(reopened.adjustment).toEqual(adjustment);
    await expect(service.begin(project.id, project.revision, { parentJobId: previous.id })).rejects.toThrow('另一版候选');
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(saved); expect(stored).toEqual(tasksBefore);
    expect((await projects.read(project.id)).chatAdjustment).toEqual(adjustment); expect(hasConversationGuard(project.accountId)).toBe(true);
  });
});

describe('会话归属、回复完整性与账号保护', (): void => {
  it('其他会话、无效页面和键值不匹配的回复都不能进入候选', async (): Promise<void> => {
    const adjustment = await begin(); const chosen = reply(originalBody, 1); const before = project.revision;
    await expect(service.capture(project.id, adjustment.id, 'https://www.doubao.com/chat/TEST-other', [chosen])).rejects.toThrow('不是本次调整');
    await expect(service.capture(project.id, adjustment.id, 'https://evil.invalid/chat/TEST-original-conversation', [chosen])).rejects.toThrow('不是本次调整');
    await expect(service.capture(project.id, adjustment.id, url, [{ ...chosen, text: 'TEST changed after observation' }])).rejects.toThrow('读取期间发生变化');
    await expect(service.capture(project.id, adjustment.id, url, [chosen, chosen])).rejects.toThrow('不能唯一识别');
    expect((await projects.read(project.id)).revision).toBe(before); expect((await projects.read(project.id)).chatAdjustment?.replies).toEqual([]);
  });
  it.each(['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'] as const)('同账号仍在%s时不能开始自由调整', async (status): Promise<void> => {
    stored[0].status = status; await expect(service.begin(project.id, project.revision, target)).rejects.toThrow('未完成或待核对'); expect(hasConversationGuard(project.accountId)).toBe(false);
  });
  it('原Job与当前任务运行不一致时，不能把旧创作依据绑定到后续会话', async (): Promise<void> => {
    if (!stored[0].runtime) throw new Error('TEST 原运行缺失');
    stored[0].runtime.runId = 'TEST-later-run'; stored[0].runtime.conversationUrl = 'https://www.doubao.com/chat/TEST-later-conversation';
    await expect(service.begin(project.id, project.revision, target)).rejects.toThrow(/会话|运行/);
    expect(hasConversationGuard(project.accountId)).toBe(false);
  });
  it('提交不明的暂停记录仍阻止开始，不把暂停当作安全重发窗口', async (): Promise<void> => {
    stored[0].status = 'paused'; stored[0].errorInfo = { code: 'submission_uncertain', message: 'TEST 未决', recoverable: false, detectedAt: new Date().toISOString() };
    await expect(service.begin(project.id, project.revision, target)).rejects.toThrow('未完成或待核对'); expect(stored).toHaveLength(1);
  });
  it('结束调整保留历史回读并释放账号，结束后的迟到回读和采用被拒绝', async (): Promise<void> => {
    const adjustment = await begin(); const chosen = reply(originalBody, 1); await capture(adjustment, [chosen]);
    const result = await service.end(project.id, project.revision, adjustment.id); project = result.project!;
    expect(project.chatAdjustment?.status).toBe('ended'); expect(project.chatAdjustment?.replies).toMatchObject([{ key: chosen.key, text: chosen.text }]); expect(hasConversationGuard(project.accountId)).toBe(false);
    await expect(service.capture(project.id, adjustment.id, url, [chosen])).rejects.toThrow('已结束');
    await expect(service.adopt(project.id, project.revision, adjustment.id, chosen.key)).rejects.toThrow('已结束');
    const next = await service.begin(project.id, project.revision, target); expect(next.adjustment?.id).not.toBe(adjustment.id); project = next.project!; expect(project.chatAdjustmentHistory?.[0].id).toBe(adjustment.id);
  });
  it('同账号不能被另一项目或调整占用，错误释放者不能解除保护', (): void => {
    claimConversationGuard('TEST-guard-account', 'TEST-project-a', 'TEST-adjustment-a'); claimConversationGuard('TEST-guard-account', 'TEST-project-a', 'TEST-adjustment-a');
    expect(() => claimConversationGuard('TEST-guard-account', 'TEST-project-b', 'TEST-adjustment-b')).toThrow('另一项创作');
    releaseConversationGuard('TEST-guard-account', 'TEST-adjustment-b'); expect(hasConversationGuard('TEST-guard-account')).toBe(true);
    releaseConversationGuard('TEST-guard-account', 'TEST-adjustment-a'); expect(hasConversationGuard('TEST-guard-account')).toBe(false);
    claimConversationGuard('TEST-guard-account', 'TEST-project-b', 'TEST-adjustment-b'); expect(hasConversationGuard('TEST-guard-account')).toBe(true);
  });
  it('只接受正常原会话地址，剥离查询参数并拒绝临时和其他平台地址', (): void => {
    expect(adjustmentConversationUrl(`${url}?from=TEST#reply`)).toBe(url);
    for (const value of ['https://www.doubao.com/chat/local_TEST', 'https://dola.com/chat/TEST', 'https://www.doubao.com/chat/', 'http://www.doubao.com/chat/TEST']) expect(adjustmentConversationUrl(value)).toBeUndefined();
  });
});
