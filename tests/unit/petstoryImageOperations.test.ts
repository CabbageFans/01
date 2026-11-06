/** 原故事／原五镜头派生的离线集成：TaskService、项目磁盘、上传文件及候选采用；不代表豆包实测。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DownloadJob, PetStoryChatJob, PetStoryImageOperationResult, PetStoryImageTarget, PetStoryPlan, PetStoryProduction, PetStoryProject, Task, TaskAddParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { PetStoryChatService } from '../../main/utils/petstoryChat';
import { PetStoryProductionService } from '../../main/utils/petstoryProduction';
import { productionCapability } from '../../main/utils/petstoryCapability';
import { PetStoryImageOperationService } from '../../main/utils/petstoryImageOperations';
import { mediaCommand } from '../../main/utils/petstoryMedia';
import { compileImageFeedback } from '../../main/utils/petstoryImageReview';
import { compilePrompt } from '../../main/utils/petstoryPromptQuality';
import { seedOfflinePromptContracts } from '../fixtures/petstoryPromptContracts';
import snapshot from '../fixtures/storyboard-five-shots.json';

let root: string; let red: string; let blue: string; let projects: PetStoryProjects; let p: PetStoryProject;
let stored: Task[]; let downloads: DownloadJob[]; let core: TaskService; let chats: PetStoryChatService;
let production: PetStoryProductionService; let operations: PetStoryImageOperationService; let failedDownload: boolean;
function list(): Task[] { return structuredClone(stored); }
function imageRun(project: PetStoryProject = p): PetStoryProduction | undefined {
  const operationId = project.imageOperations?.at(-1)?.id;
  return operationId ? project.imageProductions?.[operationId] || project.production : project.production;
}
function create(params: TaskAddParams, accountId: string): Task {
  const created = core.create(params); if (!created.success) throw new Error(created.error);
  const assigned = core.assign({ taskId: created.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error);
  return assigned.data;
}
function services(): void {
  chats = new PetStoryChatService(projects, { list, create, retryUnsubmitted: (id): Task => {
    const result = core.retry(id, 'hold'); if (!result.success) throw new Error(result.error); return result.data;
  } });
  production = new PetStoryProductionService(projects, { list, create,
    adopt: (id, binding, prompt): Task => { const result = core.bindPetStory(id, binding, prompt); if (!result.success) throw new Error(result.error); return result.data; },
    bindPageInput: (id, runId, prompt): Task => { const result = core.bindPetStoryPageInput(id, runId, prompt); if (!result.success) throw new Error(result.error); return result.data; },
    retryUnsubmitted: (id): Task => { const result = core.retry(id, 'hold'); if (!result.success) throw new Error(result.error); return result.data; },
    resubmitUncertain: (request): Task => { const result = core.resubmitUncertain(request); if (!result.success) throw new Error(result.error); return result.data; },
    downloads: (): DownloadJob[] => structuredClone(downloads), download: async (params): Promise<{ success: boolean; count: number; failed: number; jobIds?: string[] }> => {
      if (failedDownload) return { success: false, count: 0, failed: 1 };
      const output = params.outputs[0]; const id = `TEST-download-${downloads.length}`; const now = new Date().toISOString();
      downloads.push({ id, taskId: output.taskId!, accountId: p.accountId, mode: 'image', url: output.outputs[0], status: 'done', attempts: 1, saveDir: root, filePath: blue, createdAt: now, updatedAt: now });
      return { success: true, count: 1, failed: 0, jobIds: [id] };
    } });
  operations = new PetStoryImageOperationService(projects, chats, production, list);
}
async function read(): Promise<PetStoryProject> { p = await projects.read(p.id); return p; }
async function begin(baseAssetId?: string, feedback?: string, target: PetStoryImageTarget = { materialId: p.materials![0].id }, requestId = `TEST-request-${(p.imageOperations?.length || 0) + 1}`): Promise<PetStoryImageOperationResult> {
  await read(); const result = await operations.begin(p.id, p.revision, { requestId, target, ...(baseAssetId ? { baseAssetId, feedback } : {}) });
  if (result.project) p = result.project; return result;
}
async function finishChat(job: PetStoryChatJob, body: string, raw?: string): Promise<void> {
  const task = list().find((item): boolean => item.id === job.taskId)!; const now = new Date().toISOString(); const runId = `TEST-run-${job.id}`;
  const response = raw ?? JSON.stringify({ requestId: job.requestId, targetIds: job.expectedIds, optimized: body });
  const saved = core.updateRuntime({ taskId: task.id, status: 'done', runtime: { runId, attempt: 1, stage: 'completed', message: 'TEST离线回复', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
    input: { prompt: task.prompt, mode: task.mode, attachments: task.attachments || [] }, chatResponse: { text: response, capturedAt: now } } });
  expect(saved.success).toBe(true); p = (await chats.bindRun(p.id, job.id, runId)).project!;
  const collected = await chats.collect(p.id, job.id); if (collected.project) p = collected.project;
}
async function imageTask(operationId: string): Promise<Task> {
  const result = await operations.advance(p.id, operationId); expect(result.success, result.error).toBe(true);
  expect(result.action).toBe('start'); p = result.project!;
  return list().find((item): boolean => item.id === result.taskId)!;
}
async function finishImage(task: Task): Promise<void> {
  const now = new Date().toISOString(); const runId = `TEST-run-${task.id}`;
  expect(core.updateRuntime({ taskId: task.id, status: 'executing', runtime: { runId, attempt: 1, stage: 'injecting_prompt', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
    input: { prompt: task.prompt, mode: task.mode, attachments: task.attachments || [], videoConfig: task.videoConfig, petstory: task.petstory } } }).success).toBe(true);
  await production.bindRun(p.id, task.id, runId);
  expect((await production.guard(task.id)).success).toBe(true);
  expect(core.updateRuntime({ taskId: task.id, runtime: { submittedAt: now } }).success).toBe(true);
  expect(core.updateStatus({ taskId: task.id, status: 'done', outputs: [`https://TEST.invalid/${task.id}.png`] }).success).toBe(true);
}
async function finishOperation(operationId: string): Promise<string> {
  await finishImage(await imageTask(operationId));
  for (let i = 0; i < 3; i++) { const result = await operations.advance(p.id, operationId); expect(result.success, result.error).toBe(true); p = result.project!; }
  const operation = p.imageOperations!.find((item): boolean => item.id === operationId)!;
  expect(operation.stage).toBe('complete'); return operation.outputAssetId!;
}
/** 只准备原故事中已有的正文及用户已确认的本地图片，不创建任何平台文字／媒体任务。 */
async function prepareShotGeneration(kind: 'firstFrame' | 'lastFrame', adoptFirst = true): Promise<PetStoryImageTarget> {
  for (const material of p.materials!) {
    p = await projects.addMaterialImage(p.id, p.revision, material.id, red);
    p = await projects.adoptImage(p.id, p.revision, { materialId: material.id }, p.assets.at(-1)!.id);
  }
  const shot = kind === 'firstFrame' ? p.plan!.shots[0] : p.plan!.shots.find((item): boolean => !!item.prompts.lastFrame)!;
  const target: PetStoryImageTarget = { shotId: shot.id, kind };
  if (kind === 'lastFrame' && adoptFirst) {
    p = await projects.addShotImage(p.id, p.revision, shot.id, 'firstFrame', red);
    p = await projects.adoptImage(p.id, p.revision, { shotId: shot.id, kind: 'firstFrame' }, p.assets.at(-1)!.id);
  }
  seedOfflinePromptContracts(p); p = await projects.write(p);
  return target;
}
beforeAll(async (): Promise<void> => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-image-feedback-')); red = path.join(root, 'TEST-red.png'); blue = path.join(root, 'TEST-blue.png');
  for (const [color, file] of [['red', red], ['blue', blue]]) await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=64x96`, '-frames:v', '1', '-y', file]);
});
afterAll(async (): Promise<void> => { await fs.rm(root, { recursive: true, force: true }); });
beforeEach(async (): Promise<void> => {
  projects = new PetStoryProjects(); const directory = await fs.mkdtemp(path.join(root, 'project-'));
  p = await projects.create(directory, 'TEST-studio', 'TEST-account'); p = await projects.saveMobileStory(p.id, p.revision, snapshot.mobileStory);
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  plan.props = []; plan.scenes = [{ id: 'road', name: '村道', location: plan.shots[0].scene, time: '未指定', lighting: '原方案暖柔和自然光', layout: '原故事路边与民居', view: '原方案视角', designOrigin: 'script' }];
  for (const character of plan.characters) character.referenceAssetId = undefined;
  for (const shot of plan.shots) { shot.sceneId = 'road'; shot.propIds = []; shot.propStates = []; }
  p.plan = plan; p = await projects.write(p); p = await projects.confirmStory(p.id, p.revision);
  stored = []; downloads = []; failedDownload = false; let sequence = 0;
  core = new TaskService({ store: { read: list, replace: (tasks: Task[]): boolean => { stored = structuredClone(tasks); return true; } }, defaultProjectId: (): string => p.studioProjectId, id: (): string => `TEST-task-${++sequence}` });
  services();
});

describe('一键图片操作的真实服务链（离线）', (): void => {
  it('不同基础素材可各自准备文字与生成，后开始的图片先完成也不会覆盖原操作', async (): Promise<void> => {
    const [firstMaterial, secondMaterial] = p.materials!;
    const first = await begin(undefined, undefined, { materialId: firstMaterial.id });
    const firstJob = p.jobs.find((job): boolean => job.id === first.chatJobId)!;
    const firstTask = list().find((task): boolean => task.id === firstJob.taskId)!;
    const now = new Date().toISOString(); const runId = `TEST-parallel-chat-${firstTask.id}`;
    core.updateRuntime({ taskId: firstTask.id, status: 'generating', runtime: { runId, attempt: 1, stage: 'generating', message: 'TEST等待第一张文字', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
      input: { mode: 'chat', prompt: firstTask.prompt, attachments: firstTask.attachments || [] } } });
    const second = await begin(undefined, undefined, { materialId: secondMaterial.id });
    expect(second.success, second.error).toBe(true); expect(second.operationId).not.toBe(first.operationId);
    const secondJob = p.jobs.find((job): boolean => job.id === second.chatJobId)!;
    expect(list().map((task): unknown => task.petstoryChat)).toEqual(expect.arrayContaining([
      expect.objectContaining({ imageOperationId: first.operationId, materialId: firstMaterial.id }),
      expect.objectContaining({ imageOperationId: second.operationId, materialId: secondMaterial.id }),
    ]));
    await finishChat(secondJob, secondMaterial.prompt.original);
    expect((await operations.advance(p.id, second.operationId!)).success).toBe(true);
    const secondOutput = await finishOperation(second.operationId!);
    expect(p.imageOperations!.find((operation): boolean => operation.id === first.operationId)?.stage).toBe('preparing');
    await finishChat(firstJob, firstMaterial.prompt.original);
    expect((await operations.advance(p.id, first.operationId!)).success).toBe(true);
    const firstOutput = await finishOperation(first.operationId!);
    expect(p.assets.find((asset): boolean => asset.id === firstOutput)?.materialId).toBe(firstMaterial.id);
    expect(p.assets.find((asset): boolean => asset.id === secondOutput)?.materialId).toBe(secondMaterial.id);
    expect(p.production).toBeUndefined(); expect(Object.values(p.imageProductions!).map((run): string => run.state)).toEqual(['complete', 'complete']);
  });
  it('同一目标防重，不同目标的创建在短项目事务中串行且都保留', async (): Promise<void> => {
    const targets = p.materials!.slice(0, 2).map((material): PetStoryImageTarget => ({ materialId: material.id }));
    const results = await Promise.all(targets.map((target, index): Promise<PetStoryImageOperationResult> => projects.serial(p.id, async (): Promise<PetStoryImageOperationResult> => {
      const latest = await projects.read(p.id);
      return operations.begin(latest.id, latest.revision, { requestId: `TEST-concurrent-${index}`, target });
    })));
    expect(results.every((result): boolean => result.success)).toBe(true);
    await read(); expect(p.imageOperations).toHaveLength(2); expect(list()).toHaveLength(2);
    const duplicate = await begin(undefined, undefined, targets[0], 'TEST-duplicate-target');
    expect(duplicate).toMatchObject({ success: false, operationId: results[0].operationId }); expect(list()).toHaveLength(2);
  });
  it.each(['unsubmitted', 'submission_uncertain', 'captured', 'repair'] as const)('准备文字%s时暂停后再次生成仍返回原操作，不遮蔽恢复且其他素材可开始', async (checkpoint): Promise<void> => {
    const [a, b] = p.materials!;
    const first = await begin(undefined, undefined, { materialId: a.id });
    let job = p.jobs.find((item): boolean => item.id === first.chatJobId)!;
    if (checkpoint === 'repair') {
      await finishChat(job, '', JSON.stringify({ requestId: job.requestId, targetIds: job.expectedIds, optimized: '' }));
      const repair = await chats.prepareRuntime(p.id, p.revision, 'repair', { parentJobId: job.id });
      expect(repair.success, repair.error).toBe(true); p = repair.project!;
      job = p.jobs.find((item): boolean => item.taskId === repair.taskId)!;
    } else if (checkpoint !== 'unsubmitted') {
      const task = list().find((item): boolean => item.id === job.taskId)!;
      const now = new Date().toISOString(); const runId = `TEST-run-${job.id}`;
      const response = JSON.stringify({ requestId: job.requestId, targetIds: job.expectedIds, optimized: a.prompt.original });
      core.updateRuntime({ taskId: task.id, status: checkpoint === 'captured' ? 'done' : 'paused', runtime: { runId, attempt: 1, stage: checkpoint === 'captured' ? 'completed' : 'paused', message: 'TEST准备恢复检查点', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
        input: { mode: 'chat', prompt: task.prompt, attachments: task.attachments || [] }, ...(checkpoint === 'captured' ? { chatResponse: { text: response, capturedAt: now } } : {}) } });
      p = (await chats.bindRun(p.id, job.id, runId)).project!;
      if (checkpoint === 'captured') {
        const saved = p.jobs.find((item): boolean => item.id === job.id)!;
        saved.status = 'captured'; saved.rawText = response; p = await projects.write(p);
      }
    }
    p = (await operations.pause(p.id, first.operationId!)).project!;
    const originalTaskCount = list().length;
    const blocked = await begin(undefined, undefined, { materialId: a.id }, 'TEST-preparation-new-request');
    expect(blocked).toMatchObject({ success: false, operationId: first.operationId });
    expect(p.imageOperations).toHaveLength(1); expect(list()).toHaveLength(originalTaskCount);
    const second = await begin(undefined, undefined, { materialId: b.id }); expect(second.success, second.error).toBe(true);
    const resumed = await operations.resume(p.id, first.operationId!);
    expect(resumed.success, resumed.error).toBe(true); expect(resumed.chatJobId).toBe(job.id); p = resumed.project!;
    if (checkpoint === 'captured') {
      const collected = await chats.collect(p.id, job.id); expect(collected.success, collected.error).toBe(true); p = collected.project!;
    } else await finishChat(job, a.prompt.original);
    const ready = await operations.advance(p.id, first.operationId!); expect(ready.success, ready.error).toBe(true); p = ready.project!;
    await finishOperation(first.operationId!);
    expect(p.imageOperations!.find((item): boolean => item.id === first.operationId)?.stage).toBe('complete');
    expect(p.imageOperations!.find((item): boolean => item.id === second.operationId)?.stage).toBe('preparing');
  });
  it('修改A暂停和恢复只影响A，B完成后可继续基于B新候选修改，A基图与任务不变', async (): Promise<void> => {
    const [a, b] = p.materials!;
    p = await projects.addMaterialImage(p.id, p.revision, a.id, red); const aBase = p.assets.at(-1)!.id;
    p = await projects.addMaterialImage(p.id, p.revision, b.id, blue); const bBase = p.assets.at(-1)!.id;
    const first = await begin(aBase, '让表情自然一点。', { materialId: a.id }); const firstTask = await imageTask(first.operationId!);
    const second = await begin(bBase, '让光线柔和一点。', { materialId: b.id });
    const paused = await operations.pause(p.id, first.operationId!); p = paused.project!;
    expect(p.imageProductions![first.operationId!].state).toBe('paused'); expect(p.imageProductions![second.operationId!].state).toBe('running');
    const output = await finishOperation(second.operationId!);
    const third = await begin(output, '把笑容再收敛一点。', { materialId: b.id });
    const thirdTask = await imageTask(third.operationId!);
    expect(thirdTask.attachments).toEqual([await projects.referenceFile(p.id, output)]);
    await finishImage(thirdTask); await operations.advance(p.id, third.operationId!); await operations.advance(p.id, third.operationId!);
    const resumed = await operations.resume(p.id, first.operationId!); expect(resumed.success, resumed.error).toBe(true);
    expect((await imageTask(first.operationId!)).id).toBe(firstTask.id);
    await finishImage(firstTask); await operations.advance(p.id, first.operationId!); p = (await operations.advance(p.id, first.operationId!)).project!;
    expect(p.imageOperations!.find((operation): boolean => operation.id === first.operationId)).toMatchObject({ baseAssetId: aBase, taskId: firstTask.id, stage: 'complete' });
    expect(list()).toHaveLength(3);
  });
  it('停止已提交图片后可上传、预览和采用同目标，原任务和运行证据不变且不会自动重发', async (): Promise<void> => {
    const materialId = p.materials![0].id;
    p = await projects.addMaterialImage(p.id, p.revision, materialId, red); const base = p.assets.at(-1)!.id;
    p = await projects.adoptImage(p.id, p.revision, { materialId }, base);
    const begun = await begin(base, '让光线柔和一些。'); const task = await imageTask(begun.operationId!);
    const startedAt = new Date().toISOString(); const runId = 'TEST-stopped-submitted-image-run';
    expect(core.updateRuntime({ taskId: task.id, status: 'generating', runtime: { runId, attempt: 1, stage: 'generating', message: 'TEST已有平台生成',
      startedAt, stageStartedAt: startedAt, lastHeartbeatAt: startedAt, submittedAt: startedAt,
      input: { mode: task.mode, prompt: task.prompt, attachments: task.attachments || [], videoConfig: task.videoConfig, petstory: task.petstory } } }).success).toBe(true);
    await production.bindRun(p.id, task.id, runId);
    expect(core.updateRuntime({ taskId: task.id, status: 'paused', executionIntent: 'hold', runtime: { stage: 'paused', message: 'TEST用户停止' } }).success).toBe(true);
    p = (await operations.pause(p.id, begun.operationId!)).project!;
    const stopped = structuredClone(p); const originalTasks = list();
    expect(imageRun(p)?.state).toBe('paused'); expect(imageRun(p)?.steps[0]).toMatchObject({ status: 'bound', taskId: task.id, runId });
    p = await projects.addMaterialImage(p.id, p.revision, materialId, blue); const candidate = p.assets.at(-1)!;
    expect(candidate.imageReview?.state).toBe('candidate'); expect(p.materials![0].selectedAssetId).toBe(base);
    p = await projects.selectMaterialImage(p.id, p.revision, materialId, candidate.id);
    expect(p.materials![0].selectedAssetId).toBe(base);
    p = await projects.adoptImage(p.id, p.revision, { materialId }, candidate.id);
    expect(p.materials![0].selectedAssetId).toBe(candidate.id);
    expect(p.imageOperations).toEqual(stopped.imageOperations); expect(p.imageProductions).toEqual(stopped.imageProductions);
    expect(p.productionHistory).toEqual(stopped.productionHistory); expect(list()).toEqual(originalTasks); expect(downloads).toEqual([]);
    expect(await begin(candidate.id, '另一个意见')).toMatchObject({ success: false, operationId: begun.operationId });
    expect(list()).toEqual(originalTasks); expect(p.imageOperations).toHaveLength(1);
  });
  it('A生成期间可上传采用无关B，B换图不会使A制作计划失效', async (): Promise<void> => {
    const [a, b] = p.materials!;
    p = await projects.addMaterialImage(p.id, p.revision, a.id, red); const aBase = p.assets.at(-1)!.id;
    const first = await begin(aBase, '衣服保持不变，表情自然一点。', { materialId: a.id });
    p = await projects.addMaterialImage(p.id, p.revision, b.id, blue); const bBase = p.assets.at(-1)!.id;
    p = await projects.adoptImage(p.id, p.revision, { materialId: b.id }, bBase);
    expect(p.materials!.find((material): boolean => material.id === b.id)?.selectedAssetId).toBe(bBase);
    const output = await finishOperation(first.operationId!);
    expect(p.assets.find((asset): boolean => asset.id === output)?.materialId).toBe(a.id);
    expect(p.imageOperations![0].stage).toBe('complete');
  });
  it('A提交受理不明只保护A原运行，B仍可独立生成并完成', async (): Promise<void> => {
    const [a, b] = p.materials!;
    p = await projects.addMaterialImage(p.id, p.revision, a.id, red); const aBase = p.assets.at(-1)!.id;
    p = await projects.addMaterialImage(p.id, p.revision, b.id, blue); const bBase = p.assets.at(-1)!.id;
    const first = await begin(aBase, '保持服装，眼神更自然。', { materialId: a.id }); const original = await imageTask(first.operationId!);
    const now = new Date().toISOString(); const runId = `TEST-uncertain-isolated-${original.id}`;
    core.updateRuntime({ taskId: original.id, status: 'executing', runtime: { runId, attempt: 1, stage: 'submitting', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { prompt: original.prompt, mode: original.mode, attachments: original.attachments || [], videoConfig: original.videoConfig, petstory: original.petstory } } });
    await production.bindRun(p.id, original.id, runId);
    core.updateRuntime({ taskId: original.id, status: 'paused', runtime: { submittedAt: now }, errorInfo: { code: 'submission_uncertain', message: 'TEST原提交待检查', recoverable: true, detectedAt: now } });
    p = (await operations.pause(p.id, first.operationId!)).project!;
    const blocked = await begin(aBase, '换一条新修改意见。', { materialId: a.id });
    expect(blocked).toMatchObject({ success: false, operationId: first.operationId });
    const second = await begin(bBase, '让光线更自然。', { materialId: b.id }); expect(second.success, second.error).toBe(true);
    await finishOperation(second.operationId!);
    expect(list().find((task): boolean => task.id === original.id)?.runtime).toMatchObject({ runId, submittedAt: now });
    expect(p.imageOperations!.find((operation): boolean => operation.id === first.operationId)).toMatchObject({ taskId: original.id, stage: 'failed', baseAssetId: aBase });
    expect(list()).toHaveLength(2);
  });
  it('旧单图片计划在开始另一素材时迁入独立槽，原任务仍可通过守卫和完成', async (): Promise<void> => {
    const [a, b] = p.materials!;
    p = await projects.addMaterialImage(p.id, p.revision, a.id, red); const aBase = p.assets.at(-1)!.id;
    p = await projects.addMaterialImage(p.id, p.revision, b.id, blue); const bBase = p.assets.at(-1)!.id;
    const first = await begin(aBase, '让表情自然一点。', { materialId: a.id }); const firstTask = await imageTask(first.operationId!);
    p.production = p.imageProductions![first.operationId!]; delete p.imageProductions; p = await projects.write(p);
    const second = await begin(bBase, '让光线柔和一点。', { materialId: b.id }); expect(second.success, second.error).toBe(true);
    expect(p.production).toBeUndefined(); expect(p.imageProductions![first.operationId!].steps[0].taskId).toBe(firstTask.id);
    await finishOperation(second.operationId!); await finishImage(firstTask);
    await operations.advance(p.id, first.operationId!); p = (await operations.advance(p.id, first.operationId!)).project!;
    expect(p.imageOperations!.find((operation): boolean => operation.id === first.operationId)?.stage).toBe('complete');
    expect(list()).toHaveLength(2);
  });
  it('无提示词一次授权自动准备、正式保存并继续生图，只产候选且不启动其他素材或视频', async (): Promise<void> => {
    const initial = structuredClone(p.materials!); const originalShots = structuredClone(p.plan!.shots); const material = p.materials![0]; const body = material.prompt.original;
    const begun = await begin(); expect(begun.chatJobId).toBeTruthy(); expect(list()).toHaveLength(1); expect(list()[0].mode).toBe('chat');
    await finishChat(p.jobs.find((job): boolean => job.id === begun.chatJobId)!, body);
    const continued = await operations.advance(p.id, begun.operationId!); expect(continued.success, continued.error).toBe(true); p = continued.project!;
    expect(p.materials![0].prompt.final).toBe(body); expect(p.materials![0].prompt.sourceJobId).toBe(begun.chatJobId);
    const output = await finishOperation(begun.operationId!);
    expect(list().map((task): string => task.mode)).toEqual(['chat', 'image']);
    expect(p.assets.find((asset): boolean => asset.id === output)?.imageReview?.state).toBe('candidate');
    expect(p.materials![0].selectedAssetId).toBeUndefined(); expect(p.materials!.slice(1)).toEqual(initial.slice(1));
    expect(p.plan!.shots).toEqual(originalShots);
  });
  it('适用手改正文优先复用，重复请求ID与完成通知不多建任务，重开不自动发送', async (): Promise<void> => {
    p = await projects.saveMaterialPrompt(p.id, p.revision, p.materials![0].id, p.materials![0].prompt.original); seedOfflinePromptContracts(p, { materialId: p.materials![0].id }); p = await projects.write(p);
    const original = structuredClone(p.materials![0].prompt); const begun = await begin(undefined, undefined, undefined, 'TEST-idempotent-request');
    expect(begun.chatJobId).toBeUndefined(); await finishOperation(begun.operationId!);
    const duplicate = await operations.begin(p.id, p.revision, { requestId: 'TEST-idempotent-request', target: { materialId: p.materials![0].id } });
    expect(duplicate.operationId).toBe(begun.operationId); expect(list()).toHaveLength(1); expect(p.materials![0].prompt).toEqual(original);
    const directory = projects.directory(p.id); const before = await fs.readFile(path.join(directory, 'project.json'), 'utf8');
    projects = new PetStoryProjects(); p = await projects.open(directory); services();
    await operations.advance(p.id, begun.operationId!);
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(before); expect(list()).toHaveLength(1);
  });
  it('上传候选无需采用即可修改，连续两轮和重选较早候选均绑定所选文件，正式图及正文不变', async (): Promise<void> => {
    const materialId = p.materials![0].id;
    p = await projects.addMaterialImage(p.id, p.revision, materialId, red); const adopted = p.assets.at(-1)!.id;
    p = await projects.adoptImage(p.id, p.revision, { materialId }, adopted);
    p = await projects.addMaterialImage(p.id, p.revision, materialId, blue); const uploaded = p.assets.at(-1)!.id;
    const original = structuredClone(p.materials![0]);
    const first = await begin(uploaded, '表情更自然一些，衣服和背景保持不变。'); const firstOutput = await finishOperation(first.operationId!);
    expect(p.materials![0]).toEqual(original); expect(list()[0].attachments).toEqual([await projects.referenceFile(p.id, uploaded)]);
    const second = await begin(firstOutput, '把笑容收敛一点。'); const secondOutput = await finishOperation(second.operationId!);
    expect(list()[1].attachments).toEqual([await projects.referenceFile(p.id, firstOutput)]);
    const third = await begin(uploaded, '改回这张图作为依据，眼神向左。'); await finishOperation(third.operationId!);
    expect(list()[2].attachments).toEqual([await projects.referenceFile(p.id, uploaded)]);
    expect(p.imageOperations!.map((item): string | undefined => item.baseAssetId)).toEqual([uploaded, firstOutput, uploaded]);
    expect(p.materials![0]).toEqual(original); expect(new Set(p.assets.map((asset): string => asset.relativePath)).size).toBe(p.assets.length);
    p = await projects.adoptImage(p.id, p.revision, { materialId }, secondOutput);
    expect(p.materials![0].selectedAssetId).toBe(secondOutput); expect(p.assets.some((asset): boolean => asset.id === adopted)).toBe(true);
    const directory = projects.directory(p.id); const reopened = await new PetStoryProjects().open(directory);
    expect(reopened.materials![0].selectedAssetId).toBe(secondOutput); expect(reopened.imageOperations).toEqual(p.imageOperations);
  });
  it('下载失败只补原任务产物，保留基图、反馈和当前采用', async (): Promise<void> => {
    p = await projects.addMaterialImage(p.id, p.revision, p.materials![0].id, red); const base = p.assets.at(-1)!.id;
    const begun = await begin(base, '光线柔和一点。'); const task = await imageTask(begun.operationId!); await finishImage(task);
    failedDownload = true; const failed = await operations.advance(p.id, begun.operationId!); expect(failed.success).toBe(false); p = failed.project!;
    expect(p.imageOperations!.at(-1)).toMatchObject({ stage: 'failed', baseAssetId: base, feedback: '光线柔和一点。' }); expect(list()).toHaveLength(1);
    failedDownload = false; const resumed = await operations.resume(p.id, begun.operationId!);
    expect(resumed.project?.imageOperations?.at(-1)).toMatchObject({ stage: 'generating' });
    expect(resumed.project?.imageOperations?.at(-1)?.error).toBeUndefined();
    expect((await read()).imageOperations?.at(-1)?.error).toBeUndefined();
    await operations.advance(p.id, begun.operationId!); const done = await operations.advance(p.id, begun.operationId!); p = done.project!;
    expect(p.imageOperations!.at(-1)?.stage).toBe('complete'); expect(list()).toHaveLength(1); expect(downloads).toHaveLength(1);
    expect(list()[0].runtime?.runId).toBe(task.runtime?.runId || `TEST-run-${task.id}`); expect(p.materials![0].selectedAssetId).toBeUndefined();
  });
  it('跨素材、空意见和文件变化在零创建任务时拒绝；修改不会借用selectedAssetId', async (): Promise<void> => {
    p = await projects.addMaterialImage(p.id, p.revision, p.materials![0].id, red); const base = p.assets.at(-1)!;
    await expect(begin(base.id, '', undefined, 'TEST-empty-feedback')).rejects.toThrow('怎么修改');
    await expect(begin(base.id, '自然一些', { materialId: p.materials![1].id }, 'TEST-wrong-target')).rejects.toThrow('不属于');
    await fs.copyFile(blue, path.join(projects.directory(p.id), base.relativePath));
    await expect(begin(base.id, '自然一些', undefined, 'TEST-file-change')).rejects.toThrow('已变化'); expect(list()).toEqual([]);
  });
  it('图片修改编译保留用户原话及明确改变要求，不要求原生成会话或改写正式prompt', async (): Promise<void> => {
    p = await projects.addMaterialImage(p.id, p.revision, p.materials![0].id, red); const base = p.assets.at(-1)!;
    const feedback = '把衣服改成蓝色，不再保留原来的服装。'; const begun = await begin(base.id, feedback); p = begun.project!;
    const operation = p.imageOperations!.at(-1)!; const compiled = compileImageFeedback(p, operation);
    expect(compiled.final).toContain(feedback); expect(compiled.final).toContain('以本次用户意见为准'); expect(compiled.references.map((ref): string => ref.assetId)).toEqual([base.id]);
    expect(operation.baseAssetId).toBe(base.id); expect(base.taskId).toBeUndefined(); expect(p.materials![0].prompt.final).toBe(''); expect(list()).toEqual([]);
  });
  it('文字结构修订只跟随本次请求，正式采用修订结果后自动继续图片操作', async (): Promise<void> => {
    const body = p.materials![0].prompt.original; const begun = await begin(); const rootJob = p.jobs.find((job): boolean => job.id === begun.chatJobId)!;
    await finishChat(rootJob, '', '{TEST invalid JSON');
    const invalid = await operations.advance(p.id, begun.operationId!); expect(invalid.needsRepair).toBe(true); expect(invalid.repairSourceJobId).toBe(rootJob.id);
    const repair = await chats.prepareRuntime(p.id, p.revision, 'repair', { parentJobId: rootJob.id, repairMode: 'automatic' }); p = repair.project!;
    const repairJob = p.jobs.find((job): boolean => job.id === repair.repairJobId)!;
    expect((await operations.advance(p.id, begun.operationId!)).chatJobId).toBe(repairJob.id);
    await finishChat(repairJob, body);
    const continued = await operations.advance(p.id, begun.operationId!); expect(continued.success, continued.error).toBe(true); p = continued.project!;
    expect(p.materials![0].prompt.sourceJobId).toBe(repairJob.id); await finishOperation(begun.operationId!);
    expect(list().map((task): string => task.mode)).toEqual(['chat', 'chat', 'image']);
    expect(p.jobs.find((job): boolean => job.id === rootJob.id)?.rawText).toBe('{TEST invalid JSON');
  });
  it('旧手改缺少当前来源时不清空，后台新请求保存原手改快照并继续本次图片', async (): Promise<void> => {
    const old = `${p.materials![0].prompt.original}\nTEST旧手改记录`;
    const updated = p.materials![0].prompt.original;
    p = await projects.saveMaterialPrompt(p.id, p.revision, p.materials![0].id, old);
    const begun = await begin(); const job = p.jobs.find((item): boolean => item.id === begun.chatJobId)!;
    expect(p.materials![0].prompt.final).toBe(old); expect(job.inputFinal).toBe(old); expect(job.inputEdited).toBe(true);
    await finishChat(job, updated); const continued = await operations.advance(p.id, begun.operationId!); expect(continued.success, continued.error).toBe(true); p = continued.project!;
    expect(p.materials![0].prompt.final).toBe(updated); expect(p.jobs.find((item): boolean => item.id === job.id)?.inputFinal).toBe(old);
    await finishOperation(begun.operationId!); expect(list().map((task): string => task.mode)).toEqual(['chat', 'image']);
  });
  it('重开未完成操作不创建或发送，显式继续复用原排队图片任务', async (): Promise<void> => {
    p = await projects.addMaterialImage(p.id, p.revision, p.materials![0].id, red);
    const begun = await begin(p.assets.at(-1)!.id, '眼神自然一些。'); const task = await imageTask(begun.operationId!);
    const directory = projects.directory(p.id); const before = await fs.readFile(path.join(directory, 'project.json'), 'utf8');
    projects = new PetStoryProjects(); p = await projects.open(directory); services();
    expect((await operations.advance(p.id, begun.operationId!)).action).toBeUndefined();
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(before); expect(list()).toHaveLength(1);
    await operations.resume(p.id, begun.operationId!); const restored = await operations.advance(p.id, begun.operationId!);
    expect(restored.taskId).toBe(task.id); expect(restored.action).toBe('start'); expect(list()).toHaveLength(1);
  });
  it('共享首帧图片可从上传候选修改，候选不改变正式画布引用且不启动视频', async (): Promise<void> => {
    const shot = p.plan!.shots[0]; const target: PetStoryImageTarget = { shotId: shot.id, kind: 'firstFrame' };
    p = await projects.addShotImage(p.id, p.revision, shot.id, 'firstFrame', red); const base = p.assets.at(-1)!.id;
    const begun = await begin(base, '画面稍微明亮一点。', target); const output = await finishOperation(begun.operationId!);
    expect(list()).toHaveLength(1); expect(list()[0].mode).toBe('image');
    expect(list()[0].attachments).toEqual([await projects.referenceFile(p.id, base)]);
    expect(p.assets.find((asset): boolean => asset.id === output)?.imageReview?.target).toEqual(target); expect(p.adoptedImages).toBeUndefined();
    expect(imageRun(p)?.shots[shot.id].firstFrameId).toBeUndefined();
    p = await projects.adoptImage(p.id, p.revision, target, output); expect(p.adoptedImages?.[shot.id].firstFrameId).toBe(output);
    expect(list()).toHaveLength(1);
  });
  it.each(['firstFrame', 'lastFrame'] as const)('画布%s生成直达一个图片任务，操作与生产原子关联，正文和采用图片保持不变', async (kind): Promise<void> => {
    const target = await prepareShotGeneration(kind); const originalPlan = structuredClone(p.plan);
    const originalJobs = structuredClone(p.jobs); const originalMaterials = structuredClone(p.materials);
    const originalAdopted = structuredClone(p.adoptedImages); const originalAssets = structuredClone(p.assets);
    const directory = projects.directory(p.id); let linkedPlanWrites = 0; let linkedTaskWrites = 0;
    projects = new PetStoryProjects(async (from, to): Promise<void> => {
      const next = JSON.parse(await fs.readFile(from, 'utf8')) as PetStoryProject;
      const run = imageRun(next);
      if (run) {
        const operation = next.imageOperations?.find((item): boolean => item.id === run?.imageOperationId);
        expect(operation).toMatchObject({ mode: 'generate', target });
        expect(operation?.chatJobId).toBeUndefined();
        expect(run.target).toEqual({ shotId: target.shotId, kind });
        if (!run.steps.length) linkedPlanWrites++;
        for (const step of run.steps) {
          expect(step).toMatchObject({ shotId: target.shotId, kind });
          if (step.taskId) {
            expect(list().find((task): boolean => task.id === step.taskId)?.petstory).toMatchObject({ projectId: next.id, stepId: step.id });
            linkedTaskWrites++;
          }
        }
      }
      await fs.rename(from, to);
    });
    p = await projects.open(directory); services();
    const requestId = `TEST-shot-${kind}-generate`;
    const begun = await begin(undefined, undefined, target, requestId);
    expect(begun.success, begun.error).toBe(true); expect(begun.chatJobId).toBeUndefined();
    expect(p.imageOperations).toHaveLength(1); expect(list()).toEqual([]);
    expect(p.imageOperations![0]).toMatchObject({ id: begun.operationId, mode: 'generate', stage: 'generating', target });
    expect(imageRun(p)?.imageOperationId).toBe(begun.operationId); expect(linkedPlanWrites).toBeGreaterThan(0);
    const repeated = await begin(undefined, undefined, target, requestId);
    expect(repeated.operationId).toBe(begun.operationId); expect(list()).toEqual([]);
    const task = await imageTask(begun.operationId!);
    expect(task).toMatchObject({ mode: 'image', executionIntent: 'hold', assignedAccountId: p.accountId });
    expect(list()).toHaveLength(1); expect(linkedTaskWrites).toBeGreaterThan(0);
    const step = imageRun(p)!.steps[0]; const source = p.plan!.shots.find((shot): boolean => shot.id === target.shotId)!.prompts[kind]!;
    expect(task.prompt).toBe(step.compiledPrompt?.text); expect(step.compiledPrompt?.final).toBe(source.final);
    expect((await imageTask(begun.operationId!)).id).toBe(task.id); expect(list()).toHaveLength(1);
    const output = await finishOperation(begun.operationId!);
    expect(list().map((item): string => item.mode)).toEqual(['image']); expect(downloads).toHaveLength(1);
    expect(p.assets.find((asset): boolean => asset.id === output)?.imageReview).toMatchObject({ state: 'candidate', target });
    // 制作前重新解码参考图会更新检查时间；文件摘要、归属及采用事实必须完整保留。
    const assetFacts = (assets: PetStoryProject['assets']): object[] => assets.map((asset): object => ({ ...asset, validation: { ...asset.validation, checkedAt: undefined } }));
    expect(p.adoptedImages).toEqual(originalAdopted); expect(assetFacts(p.assets.filter((asset): boolean => asset.id !== output))).toEqual(assetFacts(originalAssets));
    expect(p.plan).toEqual(originalPlan); expect(p.materials).toEqual(originalMaterials); expect(p.jobs).toEqual(originalJobs);
    const duplicate = await begin(undefined, undefined, target, requestId);
    expect(duplicate.operationId).toBe(begun.operationId); expect((await operations.advance(p.id, begun.operationId!)).action).toBeUndefined();
    expect(list()).toHaveLength(1); expect(p.imageOperations).toHaveLength(1);
  });
  it.each(['firstFrame', 'lastFrame'] as const)('画布%s重开只读，显式恢复只复用原排队图片任务', async (kind): Promise<void> => {
    const target = await prepareShotGeneration(kind); const begun = await begin(undefined, undefined, target);
    const task = await imageTask(begun.operationId!); const originalJobs = structuredClone(p.jobs);
    const directory = projects.directory(p.id); const before = await fs.readFile(path.join(directory, 'project.json'), 'utf8');
    projects = new PetStoryProjects(); p = await projects.open(directory); services();
    const idle = await operations.advance(p.id, begun.operationId!);
    expect(idle.action).toBeUndefined(); expect(list()).toHaveLength(1);
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(before);
    const resumed = await operations.resume(p.id, begun.operationId!); expect(resumed.success, resumed.error).toBe(true); p = resumed.project!;
    const restored = await operations.advance(p.id, begun.operationId!); p = restored.project!;
    expect(restored).toMatchObject({ action: 'start', taskId: task.id });
    await operations.resume(p.id, begun.operationId!); expect((await imageTask(begun.operationId!)).id).toBe(task.id);
    expect(list()).toHaveLength(1); expect(p.imageOperations).toHaveLength(1); expect(p.jobs).toEqual(originalJobs);
    expect(list()[0].runtime?.submittedAt).toBeUndefined(); expect(downloads).toEqual([]);
  });
  it.each([
    ['firstFrame', 'generate'], ['firstFrame', 'modify'], ['lastFrame', 'generate'], ['lastFrame', 'modify'],
  ] as const)('画布%s完成%s后重新生成使用当前正式参考图与手改正文，旧图、采用和任务全部保留', async (kind: 'firstFrame' | 'lastFrame', previousMode: 'generate' | 'modify'): Promise<void> => {
    const target = await prepareShotGeneration(kind); const shotId = target.shotId!;
    p = await projects.addShotImage(p.id, p.revision, shotId, kind, red); const adopted = p.assets.at(-1)!.id;
    p = await projects.adoptImage(p.id, p.revision, target, adopted);
    const previous = await begin(previousMode === 'modify' ? adopted : undefined, previousMode === 'modify' ? '表情稍微自然一点。' : undefined, target);
    expect(previous.success, previous.error).toBe(true); const previousOutput = await finishOperation(previous.operationId!);
    const previousTask = list()[0]; const previousOperation = structuredClone(p.imageOperations!.at(-1)!);
    const original = p.plan!.shots.find((shot): boolean => shot.id === shotId)!.prompts[kind]!.final;
    const final = `${original}\nTEST本次手改：画面右侧留出空地。`;
    p = await projects.saveShotPrompt(p.id, p.revision, shotId, kind, final);
    const originalAdopted = structuredClone(p.adoptedImages); const originalJobs = structuredClone(p.jobs);
    const originalPlan = structuredClone(p.plan); const expected = compilePrompt(p, shotId, kind);
    const assetIds = expected.references.map((reference): string => reference.assetId);
    const attachments = await Promise.all(assetIds.map((assetId): Promise<string> => projects.referenceFile(p.id, assetId)));
    expect(assetIds.length).toBeGreaterThan(0); expect(assetIds).not.toContain(previousOutput); expect(assetIds).not.toContain(adopted);
    const regenerated = await begin(undefined, undefined, target);
    expect(regenerated.success, regenerated.error).toBe(true); expect(regenerated.chatJobId).toBeUndefined();
    expect(regenerated.operationId).not.toBe(previous.operationId);
    expect(p.imageOperations!.at(-1)).toMatchObject({ mode: 'generate', target, stage: 'generating' });
    expect(p.imageOperations!.at(-1)?.baseAssetId).toBeUndefined(); expect(p.imageOperations!.at(-1)?.feedback).toBeUndefined();
    expect(imageRun(p)?.steps).toEqual([]);
    const next = await imageTask(regenerated.operationId!);
    expect(next.id).not.toBe(previousTask.id); expect(next.runtime).toBeUndefined();
    expect(next).toMatchObject({ mode: 'image', executionIntent: 'hold', assignedAccountId: p.accountId, prompt: expected.text, attachments });
    expect(imageRun(p)!.steps[0].compiledPrompt?.final).toBe(final);
    expect(imageRun(p)!.steps[0].attachmentAssetIds).toEqual(assetIds);
    const output = await finishOperation(regenerated.operationId!);
    expect(output).not.toBe(previousOutput); expect(list().map((task): string => task.mode)).toEqual(['image', 'image']);
    expect(list()[0]).toEqual(previousTask); expect(p.imageOperations![0]).toEqual(previousOperation);
    expect(p.productionHistory?.some((run): boolean => run.imageOperationId === previous.operationId && run.steps[0]?.taskId === previousTask.id)).toBe(true);
    expect(p.assets.find((asset): boolean => asset.id === previousOutput)?.imageReview?.state).toBe('candidate');
    expect(p.assets.find((asset): boolean => asset.id === output)?.imageReview).toMatchObject({ state: 'candidate', target });
    expect(p.adoptedImages).toEqual(originalAdopted); expect(p.plan).toEqual(originalPlan); expect(p.jobs).toEqual(originalJobs);
    expect(p.assets.find((asset): boolean => asset.id === adopted)?.imageReview?.state).toBe('adopted');
  });
  it.each(['firstFrame', 'lastFrame'] as const)('画布%s初始参数失败可恢复同一操作，缺少计划时不另造文字或重复图片任务', async (kind): Promise<void> => {
    const target = await prepareShotGeneration(kind); const originalPlan = structuredClone(p.plan); const originalJobs = structuredClone(p.jobs);
    const wrong = productionCapability(p); wrong.accountId = 'TEST-other-account';
    const failed = await operations.begin(p.id, p.revision, { requestId: `TEST-uncreated-${kind}`, target }, wrong); p = failed.project!;
    expect(failed.success).toBe(false); expect(failed.error).toContain('账号不符'); expect(imageRun(p)).toBeUndefined(); expect(list()).toEqual([]);
    expect(p.imageOperations).toHaveLength(1); expect(p.imageOperations![0]).toMatchObject({ id: failed.operationId, mode: 'generate', stage: 'failed', target });
    const directory = projects.directory(p.id); projects = new PetStoryProjects(); p = await projects.open(directory); services();
    expect((await operations.advance(p.id, failed.operationId!)).action).toBeUndefined(); expect(list()).toEqual([]);
    const resumed = await operations.resume(p.id, failed.operationId!); expect(resumed.success, resumed.error).toBe(true); p = resumed.project!;
    expect(imageRun(p)?.imageOperationId).toBe(failed.operationId); expect(p.imageOperations).toHaveLength(1); expect(list()).toEqual([]);
    await finishOperation(failed.operationId!);
    expect(list().map((task): string => task.mode)).toEqual(['image']); expect(p.jobs).toEqual(originalJobs); expect(p.plan).toEqual(originalPlan);
    expect(p.imageOperations![0].error).toBeUndefined(); expect(p.assets.at(-1)?.imageReview?.state).toBe('candidate');
    expect((await operations.resume(p.id, failed.operationId!)).operationId).toBe(failed.operationId); expect(list()).toHaveLength(1);
  });
  it.each(['orphan', 'facts'] as const)('画布生成未建计划的失败遇到%s时保持fail-closed，不补建图片或文字任务', async (reason): Promise<void> => {
    const target = await prepareShotGeneration('firstFrame'); const wrong = productionCapability(p); wrong.accountId = 'TEST-other-account';
    const failed = await operations.begin(p.id, p.revision, { requestId: 'TEST-uncreated-shot-blocker', target }, wrong); p = failed.project!;
    const originalJobs = structuredClone(p.jobs);
    if (reason === 'orphan') create({ prompts: ['TEST孤立hold任务'], mode: 'image', executionIntent: 'hold', projectId: p.studioProjectId, petstory: { projectId: p.id, stepId: 'TEST-orphan-shot-step' } }, p.accountId);
    else {
      const shot = p.plan!.shots.find((item): boolean => item.id === target.shotId)!;
      p = await projects.saveShotPrompt(p.id, p.revision, shot.id, 'firstFrame', `${shot.prompts.firstFrame.final}\nTEST保留本轮手改`);
    }
    const tasksBefore = list();
    await expect(operations.resume(p.id, failed.operationId!)).rejects.toThrow(reason === 'orphan' ? '已有记录或创建结果不明' : '事实已变化');
    await read(); expect(imageRun(p)).toBeUndefined(); expect(p.imageOperations).toHaveLength(1); expect(p.imageOperations![0].stage).toBe('failed');
    expect(list()).toEqual(tasksBefore); expect(p.jobs).toEqual(originalJobs);
  });
  it('画布尾帧缺少用户已采用的首帧时停止，上传候选也不会被偷偷采用或触发补生成', async (): Promise<void> => {
    const target = await prepareShotGeneration('lastFrame', false);
    p = await projects.addShotImage(p.id, p.revision, target.shotId!, 'firstFrame', red);
    const original = structuredClone(p); const failed = await begin(undefined, undefined, target);
    expect(failed.success).toBe(false); expect(failed.error).toContain('首帧'); expect(imageRun(p)).toBeUndefined();
    expect(list()).toEqual([]); expect(p.jobs).toEqual(original.jobs); expect(p.plan).toEqual(original.plan);
    expect(p.assets).toEqual(original.assets); expect(p.adoptedImages).toEqual(original.adoptedImages);
    expect(p.assets.at(-1)?.imageReview?.state).toBe('candidate');
    const resumed = await operations.resume(p.id, failed.operationId!); expect(resumed.success).toBe(false);
    expect(resumed.operationId).toBe(failed.operationId); expect(list()).toEqual([]); expect((await read()).imageOperations).toHaveLength(1);
  });
  it('画布图片任务已创建但关联写盘失败时保留原hold，恢复只停下核对而不重复创建或发送', async (): Promise<void> => {
    const target = await prepareShotGeneration('firstFrame'); const originalJobs = structuredClone(p.jobs); const originalPlan = structuredClone(p.plan);
    const directory = projects.directory(p.id); let failTaskLink = true;
    projects = new PetStoryProjects(async (from, to): Promise<void> => {
      const next = JSON.parse(await fs.readFile(from, 'utf8')) as PetStoryProject;
      if (failTaskLink && imageRun(next)?.steps.some((step): boolean => !!step.taskId)) {
        failTaskLink = false; throw new Error('TEST画布图片关联写盘失败');
      }
      await fs.rename(from, to);
    });
    p = await projects.open(directory); services(); const begun = await begin(undefined, undefined, target);
    const failed = await operations.advance(p.id, begun.operationId!); expect(failed.success).toBe(false); p = failed.project!;
    expect(failed.error).toContain('关联写盘失败'); expect(imageRun(p)?.imageOperationId).toBe(begun.operationId);
    expect(imageRun(p)?.steps[0]).toMatchObject({ status: 'preparing' }); expect(imageRun(p)?.steps[0].taskId).toBeUndefined();
    expect(p.imageOperations![0]).toMatchObject({ stage: 'failed', id: begun.operationId });
    expect(list()).toHaveLength(1); expect(list()[0]).toMatchObject({ mode: 'image', status: 'queued', executionIntent: 'hold' });
    const originalTask = list()[0];
    projects = new PetStoryProjects(); p = await projects.open(directory); services();
    expect((await operations.advance(p.id, begun.operationId!)).action).toBeUndefined(); expect(list()).toEqual([originalTask]);
    const resumed = await operations.resume(p.id, begun.operationId!); expect(resumed.success, resumed.error).toBe(true);
    const blocked = await operations.advance(p.id, begun.operationId!); expect(blocked.success).toBe(false); expect(blocked.error).toContain('禁止自动重建');
    expect(list()).toEqual([originalTask]); expect(list()[0].runtime?.submittedAt).toBeUndefined(); expect(downloads).toEqual([]);
    await read(); expect(p.imageOperations).toHaveLength(1); expect(p.jobs).toEqual(originalJobs); expect(p.plan).toEqual(originalPlan);
  });
  it('确定未提交的修改失败后可明确提交新意见，保留旧任务与意见且只执行新请求', async (): Promise<void> => {
    p = await projects.addMaterialImage(p.id, p.revision, p.materials![0].id, red); const base = p.assets.at(-1)!.id;
    const first = await begin(base, '表情自然一点。'); const task = await imageTask(first.operationId!);
    const startedAt = new Date().toISOString(); const originalRunId = 'TEST-failed-unsubmitted-image-run';
    expect(core.updateRuntime({ taskId: task.id, status: 'executing', runtime: { runId: originalRunId, attempt: 1, stage: 'injecting_prompt', message: 'TEST尚未提交',
      startedAt, stageStartedAt: startedAt, lastHeartbeatAt: startedAt,
      input: { mode: task.mode, prompt: task.prompt, attachments: task.attachments || [], videoConfig: task.videoConfig, petstory: task.petstory } } }).success).toBe(true);
    await production.bindRun(p.id, task.id, originalRunId);
    expect(core.updateStatus({ taskId: task.id, status: 'fail' }).success).toBe(true);
    const failed = await operations.advance(p.id, first.operationId!); expect(failed.success).toBe(false); p = failed.project!;
    const failedTask = list().find((item): boolean => item.id === task.id)!;
    const second = await begin(base, '改成轻微微笑，保持原来的衣服。'); expect(second.success, second.error).toBe(true); p = second.project!;
    expect(p.productionHistory?.at(-1)?.imageOperationId).toBe(first.operationId); expect(p.imageOperations!.find((item): boolean => item.id === first.operationId)?.feedback).toBe('表情自然一点。');
    const next = await imageTask(second.operationId!); expect(next.id).not.toBe(task.id); expect(list()).toHaveLength(2);
    await expect(production.guard(task.id, false)).rejects.toThrow('步骤无效');
    await finishImage(next); await operations.advance(p.id, second.operationId!); p = (await operations.advance(p.id, second.operationId!)).project!;
    expect(p.imageOperations!.at(-1)?.stage).toBe('complete'); expect(list().find((item): boolean => item.id === task.id)?.runtime?.submittedAt).toBeUndefined();
    await expect(operations.resume(p.id, first.operationId!)).rejects.toThrow('已有记录或创建结果不明'); expect(list()).toHaveLength(2);
    const beforeAdoption = structuredClone(p); const originalTasks = list();
    const output = p.imageOperations!.find((item): boolean => item.id === second.operationId)!.outputAssetId!;
    expect(output).toBeTruthy();
    p = await projects.adoptImage(p.id, p.revision, { materialId: p.materials![0].id }, output);
    expect(p.materials![0].selectedAssetId).toBe(output); expect(p.assets.find((asset): boolean => asset.id === output)?.imageReview?.state).toBe('adopted');
    expect(list()).toEqual(originalTasks); expect(list().find((item): boolean => item.id === task.id)).toEqual(failedTask);
    expect(list().find((item): boolean => item.id === task.id)?.runtime?.runId).toBe(originalRunId);
    expect(p.imageOperations!.find((item): boolean => item.id === first.operationId)).toEqual(beforeAdoption.imageOperations!.find((item): boolean => item.id === first.operationId));
    expect(p.imageOperations!.find((item): boolean => item.id === first.operationId)?.feedback).toBe('表情自然一点。');
    expect(p.imageProductions?.[first.operationId!]).toEqual(beforeAdoption.imageProductions?.[first.operationId!]);
    expect(p.productionHistory).toEqual(beforeAdoption.productionHistory); expect(p.assets.find((asset): boolean => asset.id === base)).toEqual(beforeAdoption.assets.find((asset): boolean => asset.id === base));
  });
  it('已提交结果不明或已生成下载失败不能通过新意见再次生成', async (): Promise<void> => {
    p = await projects.addMaterialImage(p.id, p.revision, p.materials![0].id, red); const base = p.assets.at(-1)!.id;
    const first = await begin(base, '光线自然一些。'); const task = await imageTask(first.operationId!); await finishImage(task);
    failedDownload = true; p = (await operations.advance(p.id, first.operationId!)).project!;
    expect(await begin(base, '改成另一种光线。')).toMatchObject({ success: false, operationId: first.operationId }); expect(list()).toHaveLength(1);
    failedDownload = false; await operations.resume(p.id, first.operationId!); await operations.advance(p.id, first.operationId!); p = (await operations.advance(p.id, first.operationId!)).project!;
    const second = await begin(base, '让眼神看左边。'); const pending = await imageTask(second.operationId!);
    const now = new Date().toISOString(); const runId = `TEST-uncertain-${pending.id}`;
    core.updateRuntime({ taskId: pending.id, status: 'paused', runtime: { runId, attempt: 1, stage: 'paused', message: 'TEST提交不明', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
      input: { prompt: pending.prompt, mode: pending.mode, attachments: pending.attachments || [], videoConfig: pending.videoConfig, petstory: pending.petstory } } });
    await production.bindRun(p.id, pending.id, runId); p = (await operations.advance(p.id, second.operationId!)).project!;
    const blocked = await begin(base, '换成新的意见。');
    expect(blocked).toMatchObject({ success: false, operationId: second.operationId }); expect(blocked.error).toContain('已有图片任务'); expect(list()).toHaveLength(2);
  });
  it('显式重发图片沿原操作绑定唯一关联任务，完成后候选可见且保留原提交和已采用图', async (): Promise<void> => {
    const materialId = p.materials![0].id;
    p = await projects.addMaterialImage(p.id, p.revision, materialId, red); const base = p.assets.at(-1)!.id;
    p = await projects.adoptImage(p.id, p.revision, { materialId }, base);
    const begun = await begin(base, '表情稍微放松一些。'); const original = await imageTask(begun.operationId!);
    const now = new Date().toISOString(); const runId = `TEST-uncertain-${original.id}`;
    expect(core.updateRuntime({ taskId: original.id, status: 'executing', runtime: { runId, attempt: 1, stage: 'submitting', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { prompt: original.prompt, mode: original.mode, attachments: original.attachments || [], videoConfig: original.videoConfig, petstory: original.petstory } } }).success).toBe(true);
    await production.bindRun(p.id, original.id, runId);
    core.updateRuntime({ taskId: original.id, status: 'paused', runtime: { submittedAt: now }, errorInfo: { code: 'submission_uncertain', message: 'TEST 原图片受理不明', recoverable: true, detectedAt: now } });
    await operations.pause(p.id, begun.operationId!); p = (await operations.advance(p.id, begun.operationId!)).project!;
    expect(p.imageOperations!.at(-1)?.stage).toBe('failed'); const originalRun = list()[0].runtime;
    const request = { taskId: original.id, runId, submittedAt: now, authorizationId: 'TEST-explicit-image-replacement', acceptDuplicateRisk: true as const };
    const replacement = await production.resubmit(p.id, p.revision, request); p = replacement.project!;
    expect(p.imageOperations!.at(-1)).toMatchObject({ id: begun.operationId, taskId: replacement.taskId, stage: 'generating' });
    expect(p.imageOperations!.at(-1)?.error).toBeUndefined(); expect(list()).toHaveLength(2);
    expect((await production.resubmit(p.id, p.revision, request)).taskId).toBe(replacement.taskId); expect(list()).toHaveLength(2);
    await operations.resume(p.id, begun.operationId!); const next = await imageTask(begun.operationId!);
    expect(next.id).toBe(replacement.taskId); await finishImage(next);
    await operations.advance(p.id, begun.operationId!); p = (await operations.advance(p.id, begun.operationId!)).project!;
    const operation = p.imageOperations!.at(-1)!;
    expect(operation).toMatchObject({ stage: 'complete', taskId: replacement.taskId, outputAssetId: expect.any(String) });
    expect(p.assets.find((asset): boolean => asset.id === operation.outputAssetId)).toMatchObject({ taskId: replacement.taskId, imageReview: { state: 'candidate' }, validation: { decoded: true } });
    expect(p.materials![0].selectedAssetId).toBe(base); expect(list().find((task): boolean => task.id === original.id)?.runtime).toEqual(originalRun);
    expect(imageRun(p)?.steps[0].resubmissionHistory?.[0]).toMatchObject({ taskId: original.id, runId }); expect(list()).toHaveLength(2);
  });
  it('已完成下载的本地缓存缺失时只重下原图片，失败可继续且不永久排除原产物', async (): Promise<void> => {
    const materialId = p.materials![0].id;
    p = await projects.addMaterialImage(p.id, p.revision, materialId, red); const base = p.assets.at(-1)!.id;
    const begun = await begin(base, '光线稍微柔和一些。'); const task = await imageTask(begun.operationId!); await finishImage(task);
    const original = list()[0]; const artifact = original.artifacts![0]; const now = new Date().toISOString();
    downloads.push({ id: 'TEST-missing-cache', taskId: task.id, accountId: p.accountId, mode: 'image', url: artifact.url,
      status: 'done', attempts: 1, saveDir: root, filePath: path.join(root, 'TEST-moved-cache.png'), createdAt: now, updatedAt: now });
    failedDownload = true;
    const stopped = await operations.advance(p.id, begun.operationId!); p = stopped.project!;
    expect(stopped.success).toBe(false); expect(stopped.error).toContain('下载失败');
    expect(imageRun(p)?.steps[0].rejectedArtifactIds).toBeUndefined(); expect(list()).toHaveLength(1);
    failedDownload = false; await operations.resume(p.id, begun.operationId!);
    await operations.advance(p.id, begun.operationId!); p = (await operations.advance(p.id, begun.operationId!)).project!;
    const operation = p.imageOperations!.at(-1)!;
    expect(operation).toMatchObject({ stage: 'complete', taskId: task.id, outputAssetId: expect.any(String) });
    expect(p.assets.find((asset): boolean => asset.id === operation.outputAssetId)).toMatchObject({ artifactId: artifact.id, taskId: task.id,
      downloadJobId: 'TEST-download-1', imageReview: { state: 'candidate' }, validation: { decoded: true } });
    expect(imageRun(p)?.steps[0].rejectedArtifactIds).toBeUndefined(); expect(list()).toEqual([original]); expect(downloads).toHaveLength(2);
  });
  it('图片准备根任务与操作关联一次原子保存，重入只能取得同一任务', async (): Promise<void> => {
    const directory = projects.directory(p.id); let linkedWrites = 0;
    projects = new PetStoryProjects(async (from, to): Promise<void> => {
      const next = JSON.parse(await fs.readFile(from, 'utf8')) as PetStoryProject;
      for (const job of next.jobs.filter((item): boolean => item.kind === 'materialPrompt')) {
        expect(next.imageOperations?.find((operation): boolean => operation.chatJobId === job.id && operation.target.materialId === job.materialId)).toBeTruthy();
        linkedWrites++;
      }
      await fs.rename(from, to);
    });
    p = await projects.open(directory); services(); const begun = await begin();
    expect(begun.success, begun.error).toBe(true); expect(linkedWrites).toBe(1); expect(list()).toHaveLength(1);
    const repeated = await chats.prepareRuntime(p.id, p.revision, 'materialPrompt', { materialId: p.materials![0].id }, begun.operationId);
    expect(repeated.taskId).toBe(list()[0].id); expect(list()).toHaveLength(1); expect(linkedWrites).toBe(1);
  });
  it('任务创建后整个项目写盘失败保留原hold任务且不猜测关联或重发', async (): Promise<void> => {
    const directory = projects.directory(p.id); let fail = true;
    projects = new PetStoryProjects(async (from, to): Promise<void> => {
      const next = JSON.parse(await fs.readFile(from, 'utf8')) as PetStoryProject;
      if (fail && next.jobs.some((job): boolean => job.kind === 'materialPrompt')) { fail = false; throw new Error('TEST项目写盘失败'); }
      await fs.rename(from, to);
    });
    p = await projects.open(directory); services(); const begun = await begin();
    expect(begun.success).toBe(false); expect(p.jobs).toEqual([]); expect(p.imageOperations?.at(-1)?.chatJobId).toBeUndefined();
    expect(list()).toHaveLength(1); expect(list()[0]).toMatchObject({ executionIntent: 'hold', status: 'queued' });
    await expect(operations.resume(p.id, begun.operationId!)).rejects.toThrow('未确定');
    const duplicate = await operations.begin(p.id, p.revision, { requestId: p.imageOperations!.at(-1)!.requestId, target: { materialId: p.materials![0].id } });
    expect(duplicate.operationId).toBe(begun.operationId); expect(list()).toHaveLength(1); expect(list()[0].runtime?.submittedAt).toBeUndefined();
  });
  it('未创建生产计划的修改失败可继续同一授权，不增加任务或操作记录', async (): Promise<void> => {
    p = await projects.addMaterialImage(p.id, p.revision, p.materials![0].id, red); const base = p.assets.at(-1)!.id;
    const wrong = productionCapability(p); wrong.accountId = 'TEST-other-account';
    const failed = await operations.begin(p.id, p.revision, { requestId: 'TEST-uncreated-modification', target: { materialId: p.materials![0].id }, baseAssetId: base, feedback: '稍微微笑。' }, wrong);
    p = failed.project!; expect(failed.success).toBe(false); expect(imageRun(p)).toBeUndefined(); expect(list()).toEqual([]);
    const resumed = await operations.resume(p.id, failed.operationId!); expect(resumed.success, resumed.error).toBe(true); p = resumed.project!;
    expect(p.imageOperations).toHaveLength(1); expect(imageRun(p)?.imageOperationId).toBe(failed.operationId); expect(list()).toEqual([]);
    await finishOperation(failed.operationId!); expect(list()).toHaveLength(1);
  });
  it.each(['orphan', 'facts'] as const)('未建计划的失败修改遇到%s时保持原授权且拒绝补建', async (reason): Promise<void> => {
    p = await projects.addMaterialImage(p.id, p.revision, p.materials![0].id, red); const base = p.assets.at(-1)!.id;
    const wrong = productionCapability(p); wrong.accountId = 'TEST-other-account';
    const failed = await operations.begin(p.id, p.revision, { requestId: 'TEST-uncreated-blocker', target: { materialId: p.materials![0].id }, baseAssetId: base, feedback: '稍微微笑。' }, wrong); p = failed.project!;
    if (reason === 'orphan') create({ prompts: ['TEST孤立hold任务'], mode: 'image', executionIntent: 'hold', projectId: p.studioProjectId, petstory: { projectId: p.id, stepId: 'TEST-orphan-step' } }, p.accountId);
    else p = await projects.saveMaterialPrompt(p.id, p.revision, p.materials![0].id, p.materials![0].prompt.original);
    const count = list().length;
    await expect(operations.resume(p.id, failed.operationId!)).rejects.toThrow(reason === 'orphan' ? '已有记录或创建结果不明' : '事实已变化');
    expect(imageRun(await read())).toBeUndefined(); expect(p.imageOperations).toHaveLength(1); expect(list()).toHaveLength(count);
  });
  it('活跃原运行从提交中到生成中再完成的轮询只等待，不因受理证据尚未保存而暂停或启动新控制器', async (): Promise<void> => {
    p = await projects.addMaterialImage(p.id, p.revision, p.materials![0].id, red); const base = p.assets.at(-1)!.id;
    const begun = await begin(base, '表情更自然一些。'); const task = await imageTask(begun.operationId!);
    const now = new Date().toISOString(); const runId = `TEST-active-${task.id}`;
    expect(core.updateRuntime({ taskId: task.id, status: 'executing', runtime: { runId, attempt: 1, stage: 'submitting', message: 'TEST单次发送', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { prompt: task.prompt, mode: task.mode, attachments: task.attachments || [], videoConfig: task.videoConfig, petstory: task.petstory } } }).success).toBe(true);
    await production.bindRun(p.id, task.id, runId);
    for (const status of ['executing', 'generating', 'manual_submission_observing'] as const) {
      core.updateRuntime({ taskId: task.id, status, runtime: { stage: status === 'executing' ? 'submitting' : status, submittedAt: now } });
      const polled = await operations.advance(p.id, begun.operationId!); expect(polled.success, polled.error).toBe(true); p = polled.project!;
      expect(polled.action).toBe('wait'); expect(polled.taskId).toBeUndefined(); expect(imageRun(p)?.state).toBe('running');
      expect(p.imageOperations!.at(-1)).toMatchObject({ stage: 'generating', taskId: task.id }); expect(list()).toHaveLength(1); expect(downloads).toEqual([]);
      expect(list()[0].runtime?.acceptanceObservation).toBeUndefined();
    }
    // 已误暂停的项目可显式继续仍活跃的原运行；恢复不要求另建受理观察器或重试发送。
    core.updateRuntime({ taskId: task.id, status: 'generating', runtime: { stage: 'generating' } });
    await operations.pause(p.id, begun.operationId!); const before = list();
    const resumed = await operations.resume(p.id, begun.operationId!); expect(resumed.success, resumed.error).toBe(true);
    expect(list()).toEqual(before); const waiting = await operations.advance(p.id, begun.operationId!);
    expect(waiting.action).toBe('wait'); expect(waiting.taskId).toBeUndefined();
    core.updateStatus({ taskId: task.id, status: 'done', outputs: [`https://TEST.invalid/${task.id}.png`] });
    await operations.advance(p.id, begun.operationId!); p = (await operations.advance(p.id, begun.operationId!)).project!;
    expect(p.imageOperations!.at(-1)?.stage).toBe('complete'); expect(list()).toHaveLength(1); expect(downloads).toHaveLength(1);
    expect(list()[0].runtime?.runId).toBe(runId); expect(p.materials![0].selectedAssetId).toBeUndefined();
  });
  it('活跃等待仍校验原任务运行归属，停止后没有受理记录不能伪装为活跃等待', async (): Promise<void> => {
    p = await projects.addMaterialImage(p.id, p.revision, p.materials![0].id, red); const base = p.assets.at(-1)!.id;
    const begun = await begin(base, '光线柔和一些。'); const task = await imageTask(begun.operationId!);
    const now = new Date().toISOString(); const runId = `TEST-stopped-${task.id}`;
    core.updateRuntime({ taskId: task.id, status: 'executing', runtime: { runId, attempt: 1, stage: 'submitting', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
      input: { prompt: task.prompt, mode: task.mode, attachments: task.attachments || [], videoConfig: task.videoConfig, petstory: task.petstory } } });
    await production.bindRun(p.id, task.id, runId);
    core.updateRuntime({ taskId: task.id, status: 'paused', runtime: { stage: 'paused' } });
    const stopped = await operations.advance(p.id, begun.operationId!); expect(stopped).toMatchObject({ success: true, action: 'observe', taskId: task.id });
    expect(list()).toHaveLength(1); expect(list()[0].runtime?.runId).toBe(runId); expect(downloads).toEqual([]);
    await operations.resume(p.id, begun.operationId!);
    core.updateRuntime({ taskId: task.id, status: 'generating', runtime: { ...list()[0].runtime!, runId: 'TEST-other-run', stage: 'generating' } });
    const wrongRun = await operations.advance(p.id, begun.operationId!); expect(wrongRun.success).toBe(false); expect(wrongRun.error).toContain('原运行已变化');
    expect(list()).toHaveLength(1); expect(downloads).toEqual([]);
  });
  it('活跃状态已经明确要求人工核对时仍暂停，不把manual_review当作正常等待', async (): Promise<void> => {
    p = await projects.addMaterialImage(p.id, p.revision, p.materials![0].id, red); const base = p.assets.at(-1)!.id;
    const begun = await begin(base, '表情自然一些。'); const task = await imageTask(begun.operationId!);
    const now = new Date().toISOString(); const runId = `TEST-manual-${task.id}`; const url = 'https://www.doubao.com/chat/TEST-manual';
    core.updateRuntime({ taskId: task.id, status: 'generating', runtime: { runId, attempt: 1, stage: 'generating', message: 'TEST人工核对', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, conversationUrl: url,
      input: { prompt: task.prompt, mode: task.mode, attachments: task.attachments || [], videoConfig: task.videoConfig, petstory: task.petstory },
      acceptanceObservation: { schemaVersion: 1, accountId: p.accountId, runId, conversationUrl: url, acceptedAt: now, evidence: { kind: 'generation_started' }, cursor: { messageCount: 1, pollCount: 0 }, expectedArtifact: { kind: 'image', runId },
        lease: { ownerId: 'TEST', acquiredAt: now, expiresAt: now, lastHeartbeatAt: now }, outcome: 'manual_review' } } });
    await production.bindRun(p.id, task.id, runId);
    const stopped = await operations.advance(p.id, begun.operationId!); expect(stopped.success).toBe(false); expect(stopped.error).toContain('提交受理状态不明');
    expect(list()).toHaveLength(1); expect(downloads).toEqual([]);
  });
});
