/** P4 离线集成：真实 TaskService/归一化/项目磁盘/FFmpeg，网页与下载仅用明确 TEST 夹具。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadJob, PetStoryCapability, PetStoryPlan, PetStoryProductionResult, PetStoryProject, Task, TaskAddParams } from '@doubao-studio/contracts';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { PetStoryProductionService, productionCounts, checkProductionReferences, productionPlanHash } from '../../main/utils/petstoryProduction';
import { resolvePetStoryMode } from '../../main/utils/petstoryModes';
import { productionCapability } from '../../main/utils/petstoryCapability';
import { extractActualEndFrame, mediaCommand, validatePetStoryMedia } from '../../main/utils/petstoryMedia';
import { TaskService } from '../../main/core/TaskService';
import { seedOfflinePromptContracts } from '../fixtures/petstoryPromptContracts';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';

let root: string;
let picture: string;
let video: string;
let projects: PetStoryProjects;
let p: PetStoryProject;
let tasks: Task[];
let jobs: DownloadJob[];
let core: TaskService;
let service: PetStoryProductionService;
let sequence: number;
let downloadFailure = false;
const download = vi.fn();
const createdInputs: TaskAddParams[] = [];
const legacyPreparationErrors = [
  { code: 'submission_uncertain', message: '最终全文或段落回读不一致，未提交' },
  { code: 'unknown', message: '图片模式入口未就绪，已在提交前停止' },
] as const;
function capability(): PetStoryCapability {
  const supported = { state: 'supported' as const, reason: 'TEST 可见槽位' };
  return { accountId: 'TEST-account', checkedAt: new Date().toISOString(), image: supported,
    modes: { first_frame: supported, first_last_frame: supported, reference: supported },
    videoConfig: { model: 'seedance-2.0', duration: '6s', aspectRatio: '9:16' }, durations: [5, 6, 7, 8, 9, 10], };
}
function plan(): PetStoryPlan {
  const prompt = (label: string): PetStoryPlan['shots'][number]['prompts']['video'] => ({ original: `TEST original ${label}`, optimized: `TEST optimized ${label}`, final: `TEST final ${label} %%%%%%%%%% 保留单个任务`, edited: true, rulesVersion: 'petstory-r11-v1' });
  return { sourceSummary: 'TEST 原故事', adaptedStory: 'TEST 改编故事', characters: [
    { id: 'lulu', name: '噜噜', role: 'main', purpose: '测试', description: '蓝衣' },
    { id: 'lumei', name: '噜妹', role: 'main', purpose: '测试', description: '红衣' },
    { id: 'friend', name: '朋友', role: 'supporting', purpose: '交接盒子', description: '绿衣' },
    { id: 'unused', name: '背景角色', role: 'supporting', purpose: '未被镜头使用', description: '黄衣' },
  ], props: [], scenes: [{ id: 'test-room', name: '测试房间', location: '测试房间', time: '白天', lighting: '自然光', layout: '门相对窗', view: '正面', designOrigin: 'script' }], shots: Array.from({ length: 4 }, (_, i): PetStoryPlan['shots'][number] => ({ id: `TEST-shot-${i + 1}`, order: i + 1,
    characterIds: i === 0 ? ['friend', 'lulu'] : i === 1 ? ['lumei'] : i === 2 ? ['friend'] : ['lulu'],
    sceneId: 'test-room', propIds: [], propStates: [], scene: '测试房间', action: '交接盒子', startState: '拿盒子', endState: '放下盒子', durationSeconds: i % 2 ? 10 : 5,
    transition: i === 1 ? 'continue' : 'cut', previousShotId: i === 1 ? 'TEST-shot-1' : undefined,
    requestedMode: i === 2 ? 'first_last_frame' : i === 0 ? 'first_frame' : 'reference',
    prompts: { firstFrame: prompt(`首帧${i}`), lastFrame: i === 2 ? prompt(`基于首帧编辑终态${i}`) : undefined, video: prompt(`视频${i}`) } })) };
}
function list(): Task[] { return structuredClone(tasks); }
function create(params: TaskAddParams, accountId: string): Task {
  createdInputs.push(structuredClone(params));
  const result = core.create(params);
  if (!result.success) throw new Error(result.error);
  const assigned = core.assign({ taskId: result.data[0].id, accountId });
  if (!assigned.success) throw new Error(assigned.error);
  return assigned.data;
}
function makeService(storage: PetStoryProjects = projects): PetStoryProductionService {
  return new PetStoryProductionService(storage, { list, create,
    bindPageInput: (id, runId, body): Task => { const result = core.bindPetStoryPageInput(id, runId, body); if (!result.success) throw new Error(result.error); return result.data; },
    adopt: (id, binding, compiledPrompt): Task => { const result = core.bindPetStory(id, binding, compiledPrompt); if (!result.success) throw new Error(result.error); return result.data; },
    retryUnsubmitted: (id): Task => { const result = core.retry(id, 'hold'); if (!result.success) throw new Error(result.error); return result.data; },
    resubmitUncertain: (request): Task => { const result = core.resubmitUncertain(request); if (!result.success) throw new Error(result.error); return result.data; },
    downloads: (): DownloadJob[] => structuredClone(jobs), download });
}
async function start(taskId: string): Promise<Task> {
  const task = tasks.find((t): boolean => t.id === taskId);
  if (!task) throw new Error('TEST missing task');
  const now = new Date().toISOString();
  const runtime = { runId: `TEST-run-${taskId}`, attempt: 1, stage: 'injecting_prompt' as const, message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
    input: { prompt: task.prompt, mode: task.mode, attachments: task.attachments || [], videoConfig: task.videoConfig, petstory: task.petstory, promptReadback: task.promptReadback } };
  expect(core.updateRuntime({ taskId, status: 'executing', runtime }).success).toBe(true);
  const bound = await service.bindRun(p.id, taskId, runtime.runId);
  expect(bound.success).toBe(true);
  expect((await service.guard(taskId)).success).toBe(true);
  return list().find((t): boolean => t.id === taskId) as Task;
}
async function complete(taskId: string): Promise<void> {
  const task = await start(taskId);
  expect(core.updateRuntime({ taskId, runtime: { submittedAt: new Date().toISOString() } }).success).toBe(true);
  expect(core.updateStatus({ taskId, status: 'done', outputs: [`https://TEST.invalid/${task.id}.${task.mode === 'video' ? 'mp4' : 'png'}`] }).success).toBe(true);
}
async function approve(value: PetStoryCapability = capability()): Promise<void> {
  p = await projects.read(p.id);
  p.promptCapability = value; seedOfflinePromptContracts(p); p = await projects.write(p);
  const result = await service.approve(p.id, p.revision, value, {});
  expect(result.success).toBe(true);
  p = result.project as PetStoryProject;
}
async function adoptGeneratedImages(): Promise<void> {
  let current = await projects.read(p.id);
  if (current.production?.state !== 'paused' || current.production.steps.some((step): boolean => step.status !== 'complete')) return;
  for (const asset of current.assets.filter((item): boolean => item.imageReview?.state === 'candidate' && !!item.shotId)) {
    current = await projects.adoptImage(current.id, current.revision, asset.imageReview!.target, asset.id);
  }
  await service.resume(current.id, capability());
}
async function advanceToVideo(): Promise<PetStoryProductionResult> {
  for (let i = 0; i < 15; i++) {
    const result = await service.advance(p.id);
    expect(result.success, result.error).toBe(true);
    await adoptGeneratedImages();
    if (result.taskId && result.action === 'start') {
      if (tasks.find((t): boolean => t.id === result.taskId)?.mode === 'video') return result;
      await complete(result.taskId);
    }
  }
  throw new Error('TEST video not reached');
}
beforeAll(async (): Promise<void> => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-petstory-p4-'));
  picture = path.join(root, 'TEST-blue.png'); video = path.join(root, 'TEST-red-then-black.mp4');
  await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x96', '-frames:v', '1', '-y', picture]);
  await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x96:r=10:d=5', '-f', 'lavfi', '-i', 'color=c=black:s=64x96:r=10:d=1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video]);
});
afterAll(async (): Promise<void> => { await fs.rm(root, { recursive: true, force: true }); });
beforeEach(async (): Promise<void> => {
  const directory = await fs.mkdtemp(path.join(root, 'TEST-project-'));
  projects = new PetStoryProjects();
  p = await projects.create(directory, 'TEST-studio', 'TEST-account');
  p = await projects.saveSource(p.id, p.revision, 'https://v.douyin.com/TEST-p4/');
  p = await projects.saveMobileStory(p.id, p.revision, 'TEST 离线故事，无平台请求');
  p.plan = plan(); p.source.status = 'review_required'; p = await projects.write(p);
  p = await projects.confirmStory(p.id, p.revision);
  p = await projects.addReference(p.id, 'lulu', picture); p = await projects.addReference(p.id, 'lumei', picture);
  p = await projects.addReference(p.id, 'friend', picture);
  p = await projects.addMaterialImage(p.id, p.revision, 'scene:test-room', picture);
  p = await projects.approveMaterials(p.id, p.revision, p.materials!.map((m): { materialId: string; assetId: string } => ({ materialId: m.id, assetId: p.assets.find((asset): boolean => asset.materialId === m.id)!.id })));
  tasks = []; jobs = []; sequence = 0; createdInputs.length = 0; downloadFailure = false; download.mockReset();
  core = new TaskService({ store: { read: list, replace: (value: Task[]): boolean => { tasks = normalizeTasks(structuredClone(value), 'TEST-studio').data; return true; } }, defaultProjectId: (): string => 'TEST-studio', id: (): string => `TEST-task-${++sequence}` });
  download.mockImplementation(async (params: { outputs: { taskId: string; accountId: string; mode: Task['mode']; outputs: string[] }[] }): Promise<object> => {
    if (downloadFailure) return { success: false, failed: 1, count: 0 };
    const output = params.outputs[0]; const now = new Date().toISOString();
    const job: DownloadJob = { id: `TEST-download-${jobs.length}`, taskId: output.taskId, accountId: output.accountId, mode: output.mode, url: output.outputs[0], status: 'done', attempts: 1, saveDir: root, filePath: output.mode === 'video' ? video : picture, createdAt: now, updatedAt: now };
    jobs.push(job); return { success: true, failed: 0, count: 1, jobIds: [job.id] };
  });
  service = makeService();
});

describe('P4 实际入口和请求模式', (): void => {
  it('未收取Chat阻断相关镜头入口，独立素材仍须具有正式正文', async (): Promise<void> => {
    p.jobs.push({ id: 'TEST-unresolved-chat', taskId: 'TEST-uncertain-chat', kind: 'optimize', status: 'bound', inputHash: 'a'.repeat(64), sourceUrl: p.source.url, sourceStoryId: p.mobileStory!.id, shotId: p.plan!.shots[0].id, promptKind: 'video' });
    p = await projects.write(p); const c = capability();
    await expect(service.preview(p.id, c, {})).rejects.toThrow('未收取');
    await expect(service.approve(p.id, p.revision, c, {})).rejects.toThrow('未收取');
    await expect(service.generateShotMedia(p.id, p.revision, p.plan!.shots[0].id, 'firstFrame', c, {})).rejects.toThrow('未收取');
    await expect(service.generateMaterials(p.id, p.revision, [p.materials![0].id], c)).rejects.toThrow('尚无最终正文');
    expect(tasks).toEqual([]); expect(createdInputs).toEqual([]); expect((await projects.read(p.id)).production).toBeUndefined();
  });
  it('strict native mode never uses two generic images as first/last; explicit fallback retains requested mode', (): void => {
    const c = capability(); const shot = plan().shots[2];
    c.modes.first_last_frame = { state: 'unsupported', reason: 'TEST 平台无槽' };
    expect((): unknown => resolvePetStoryMode(shot, c)).toThrow('平台不支持');
    expect(resolvePetStoryMode(shot, c, 'reference')).toMatchObject({ requestedMode: 'first_last_frame', resolvedMode: 'reference' });
    c.modes.first_last_frame.state = 'implementation_gap';
    expect((): unknown => resolvePetStoryMode(shot, c)).toThrow('代码尚未适配');
  });
  it.each([4, 11, NaN, Infinity, 5.5])('duration %s never silently maps to another value', (duration): void => {
    const shot = plan().shots[0]; shot.durationSeconds = duration;
    expect((): unknown => resolvePetStoryMode(shot, capability())).toThrow('时长');
  });
  it('重开旧auto批次沿用已选reference模式，不从未知入口改成首尾帧或要求检查', async (): Promise<void> => {
    await approve(); p = await projects.read(p.id);
    const shot = p.plan!.shots.find((item): boolean => !!item.prompts.lastFrame)!;
    shot.requestedMode = 'auto';
    Object.assign(p.production!.shots[shot.id], { requestedMode: 'auto', resolvedMode: 'reference' });
    seedOfflinePromptContracts(p); p = await projects.write(p);
    p.production!.planHash = productionPlanHash(p.plan!); p = await projects.write(p);
    expect(resolvePetStoryMode(shot, productionCapability(p)).resolvedMode).toBe('reference');
    await service.pause(p.id); const reopenedProjects = new PetStoryProjects(); await reopenedProjects.open(projects.directory(p.id)); service = makeService(reopenedProjects);
    const reopened = await service.resume(p.id);
    expect(reopened.success).toBe(true); expect(reopened.project?.production?.shots[shot.id].resolvedMode).toBe('reference');
    expect(tasks).toHaveLength(0);
  });
  it.each([false, 'unknown', undefined])('legacy free state %s does not block a real task with selected parameters', async (legacy): Promise<void> => {
    const c = capability(); delete c.checkedAt;
    Object.assign(c, { freeEvidence: legacy, freeChatConfirmed: legacy });
    Object.assign(c.image, { free: legacy }); Object.assign(c.modes.first_frame, { free: legacy });
    await approve(c);
    const result = await service.advance(p.id);
    expect(result.action).toBe('start'); expect(tasks).toHaveLength(1);
    expect(result.project?.production?.capability).toMatchObject({ accountId: p.accountId, videoConfig: c.videoConfig, durations: [], image: { state: 'unknown' } });
    expect(result.project?.production?.capability).not.toHaveProperty('freeEvidence');
    expect(result.project?.production?.capability.image).not.toHaveProperty('free');
    expect(result.project?.production?.capability).not.toHaveProperty('checkedAt');
  });
});

describe('P4 顺序素材接力与持久化', (): void => {
  it('正文没有显式引用的真实附件只保存零节点证据，不补写素材句或接受伪造节点', async (): Promise<void> => {
    await approve();
    const next = await service.advance(p.id);
    expect(next.taskId).toBeTruthy();
    const task = await start(next.taskId!);
    p = await projects.read(p.id);
    const step = p.production!.steps.find((item): boolean => item.taskId === task.id)!;
    expect(step.compiledPrompt!.text).toBe(step.compiledPrompt!.final);
    const bindings = step.compiledPrompt!.references.map((reference, index): import('@doubao-studio/contracts').PetStoryPageBinding => ({
      assetId: reference.assetId, order: index + 1, slot: 'reference', label: `@图片${index + 1}`,
      previewHash: String(index + 1).padStart(64, '0'), reference: 'mention', targetId: `TEST-target-${index}`,
      fileSha256: p.assets.find((asset): boolean => asset.id === reference.assetId)!.validation!.sha256,
      nodeIds: [], occurrenceCount: 0,
    }));
    const forged = structuredClone(bindings); forged[0].occurrenceCount = 1;
    await expect(service.recordPageBindings(p.id, task.id, task.runtime!.runId, forged)).rejects.toThrow('引用节点');
    const saved = await service.recordPageBindings(p.id, task.id, task.runtime!.runId, bindings);
    expect(saved.success).toBe(true);
    expect(saved.compiledPrompt!.text).toBe(step.compiledPrompt!.final);
    expect(tasks.find((item): boolean => item.id === task.id)!.runtime!.input.prompt).toBe(step.compiledPrompt!.final);
  });
  it('executes four dynamic shots, one necessary supporting reference, native tail editing and real-video continuation', async (): Promise<void> => {
    expect(productionCounts(p, capability(), {})).toEqual({ shots: 4, supporting: 1, newCharacters: 0, firstFrames: 4, lastFrames: 1, videos: 4 });
    await approve();
    for (let i = 0; i < 50; i++) {
      const result = await service.advance(p.id);
      expect(result.success, result.error).toBe(true);
      await adoptGeneratedImages();
      if (result.action === 'start' && result.taskId) {
        const repeated = await service.advance(p.id);
        expect(repeated.taskId).toBe(result.taskId);
        await complete(result.taskId);
      }
      if (result.project?.production?.state === 'complete') break;
    }
    const saved = await projects.read(p.id);
    expect(saved.production?.state).toBe('complete');
    expect(tasks).toHaveLength(9);
    expect(saved.production?.steps.filter((s): boolean => s.kind === 'character')).toHaveLength(0);
    expect(saved.assets.some((a): boolean => a.characterId === 'unused')).toBe(false);
    const firstStep = saved.production?.steps.find((s): boolean => s.shotId === 'TEST-shot-1' && s.kind === 'firstFrame');
    expect(firstStep?.attachmentAssetIds.map((id): string | undefined => saved.assets.find((a): boolean => a.id === id)?.characterId)).toEqual(['friend', 'lulu', undefined]);
    const tail = saved.production?.steps.find((s): boolean => s.kind === 'lastFrame');
    expect(tail?.attachmentAssetIds).toEqual([saved.production?.shots['TEST-shot-3'].firstFrameId]);
    expect(saved.production?.steps.filter((s): boolean => s.kind === 'lastFrame')).toHaveLength(1);
    const nativeVideo = tasks.find((t): boolean => t.petstory?.stepId === saved.production?.steps.find((s): boolean => s.shotId === 'TEST-shot-3' && s.kind === 'video')?.id);
    expect(nativeVideo?.attachments).toHaveLength(2);
    expect(nativeVideo?.runtime?.input.videoConfig?.duration).toBe('5s');
    for (const task of tasks.filter((t): boolean => t.mode === 'video')) expect(task.runtime?.input.videoConfig?.duration).toBe(task.videoConfig?.duration);
    const continued = saved.production?.shots['TEST-shot-2'];
    const frame = saved.assets.find((a): boolean => a.id === continued?.actualEndFrameId);
    expect(frame?.kind).toBe('actualEndFrame');
    expect(frame?.sourceVideo?.assetId).toBe(saved.production?.shots['TEST-shot-1'].videoId);
    expect(frame?.sourceVideo?.atSeconds).toBeCloseTo(4.9, 2);
    expect(frame?.validation?.sha256).not.toBe(saved.assets.find((a): boolean => a.kind === 'plannedEndImage')?.validation?.sha256);
    expect(saved.production?.shots['TEST-shot-3'].startFromPreviousEnd).toBeUndefined();
    const reopened = await new PetStoryProjects().open(projects.directory(p.id));
    expect(reopened.production).toEqual(saved.production);
    for (const step of reopened.production?.steps || []) {
      if (!['firstFrame', 'lastFrame', 'video'].includes(step.kind)) continue;
      const task = tasks.find((t): boolean => t.id === step.taskId);
      expect(step.compiledPrompt?.text).toBe(task?.runtime?.input.prompt);
      expect(step.compiledPrompt?.references.map((r): string => r.assetId)).toEqual(step.attachmentAssetIds);
      expect(task?.runtime?.input.promptReadback).toBe('exact');
      expect(step.compiledPrompt?.final).toBe(reopened.plan?.shots.find((s): boolean => s.id === step.shotId)?.prompts[step.kind as 'firstFrame' | 'lastFrame' | 'video']?.final);
    }
    expect(reopened.assets.filter((a): boolean => a.kind === 'video').every((a): boolean => a.validation?.decoded === true && a.validation.durationSeconds === 6 && a.validation.width === 64)).toBe(true);
    expect(createdInputs.filter((i): boolean => i.mode === 'video').every((i): boolean => i.prompts.length === 1 && i.prompts[0].includes('TEST final'))).toBe(true);
    // 四镜头完整接力包含多次真实 FFmpeg 解码与写盘，独立设置集成用例时限。
  }, 30_000);
  it('adopts the existing P3 hold draft rather than creating another first-frame task', async (): Promise<void> => {
    const reduced = p.plan as PetStoryPlan; reduced.shots = [reduced.shots[3]]; reduced.shots[0].order = 1;
    p.plan = reduced; p = await projects.write(p);
    const asset = p.assets.find((a): boolean => a.characterId === 'lulu');
    const task = create({ prompts: [reduced.shots[0].prompts.firstFrame.final], mode: 'image', executionIntent: 'hold', projectId: p.studioProjectId, attachments: [await projects.referenceFile(p.id, asset?.id || ''), await projects.referenceFile(p.id, p.materials!.find((m): boolean => m.id === 'scene:test-room')!.selectedAssetId!)] }, p.accountId);
    p.drafts = [{ taskId: task.id, shotId: reduced.shots[0].id, kind: 'firstFrame', final: task.prompt }]; p = await projects.write(p);
    await approve();
    const next = await service.advance(p.id);
    expect(next.taskId).toBe(task.id); expect(tasks).toHaveLength(1); expect(tasks[0].petstory?.projectId).toBe(p.id);
  });
  it('only uploads the current shot scene after its ordered character references', async (): Promise<void> => {
    p = await projects.addSceneReference(p.id, 'TEST-shot-1', picture);
    p = await projects.addSceneReference(p.id, 'TEST-shot-4', picture);
    await approve();
    await complete((await service.advance(p.id)).taskId || '');
    await service.advance(p.id);
    const first = await service.advance(p.id);
    expect(first.success, first.error).toBe(true);
    const saved = first.project as PetStoryProject;
    const step = saved.production?.steps.find((item): boolean => item.shotId === 'TEST-shot-1');
    const assets = step?.attachmentAssetIds.map((id): unknown => { const a = saved.assets.find((item): boolean => item.id === id); return a?.kind === 'scene' ? a.materialId : a?.characterId; });
    expect(assets).toEqual(['friend', 'lulu', 'scene:test-room']);
  });
  it('concurrent starts serialize to one hold task; repeated resume retains that identity', async (): Promise<void> => {
    await approve();
    const results = await Promise.all([projects.serial(p.id, (): Promise<PetStoryProductionResult> => service.advance(p.id)), projects.serial(p.id, (): Promise<PetStoryProductionResult> => service.advance(p.id))]);
    expect(results[0].taskId).toBe(results[1].taskId); expect(tasks).toHaveLength(1);
    await service.pause(p.id); await service.resume(p.id, capability()); await service.resume(p.id, capability());
    expect((await service.advance(p.id)).taskId).toBe(results[0].taskId); expect(tasks).toHaveLength(1);
  });
  it.each(['video_assets_not_ready', 'quota_exhausted', 'membership_required', 'login_required', 'petstory_controls_unconfirmed', 'page_changed'])('safe preparation failure %s reuses the original task only after explicit resume', async (code): Promise<void> => {
    await approve(); const next = await service.advance(p.id); const original = await start(next.taskId || '');
    core.updateRuntime({ taskId: original.id, status: 'paused', errorInfo: { code, message: 'TEST upload', recoverable: true, detectedAt: new Date().toISOString() } });
    const stopped = await service.advance(p.id);
    expect(stopped.success).toBe(false); expect(tasks).toHaveLength(1);
    await service.resume(p.id, capability());
    const continued = await service.advance(p.id);
    expect(continued.taskId).toBe(original.id); expect(continued.action).toBe('start');
    expect(tasks).toHaveLength(1); expect(tasks[0].executionIntent).toBe('hold'); expect(tasks[0].runtime?.submittedAt).toBeUndefined();
  });
  it.each(legacyPreparationErrors)('旧版发送前错误 $code：$message 可显式继续同一个任务', async (error): Promise<void> => {
    await approve(); const next = await service.advance(p.id); const original = await start(next.taskId || '');
    core.updateRuntime({ taskId: original.id, status: error.code === 'unknown' ? 'fail' : 'paused', errorInfo: { ...error, recoverable: true, detectedAt: new Date().toISOString() } });
    expect((await service.advance(p.id)).success).toBe(false);
    await service.resume(p.id, capability());
    const continued = await service.advance(p.id);
    expect(continued).toMatchObject({ success: true, action: 'start', taskId: original.id });
    expect(tasks).toHaveLength(1); expect(createdInputs).toHaveLength(1); expect(tasks[0].prompt).toBe(original.prompt);
    expect(tasks[0].executionIntent).toBe('hold'); expect(tasks[0].runtime?.submittedAt).toBeUndefined();
    expect((await projects.read(p.id)).production?.steps[0].runId).toBeUndefined();
  });
  it.each(['发送动作结果不确定，请人工核对豆包会话；系统未自动重发', '发送按钮不可用或点击结果不确定；系统已停止且未自动重发', '最终全文或段落回读不一致，未提交；请重试', 'TEST 未确认的其他错误'])('其他 submission_uncertain 错误仍保留原运行：%s', async (errorMessage): Promise<void> => {
    await approve(); const next = await service.advance(p.id); const original = await start(next.taskId || '');
    core.updateRuntime({ taskId: original.id, status: 'paused', errorInfo: { code: 'submission_uncertain', message: errorMessage, recoverable: true, detectedAt: new Date().toISOString() } });
    await service.advance(p.id); const before = list();
    await expect(service.resume(p.id, capability())).rejects.toThrow('未确认可安全恢复');
    expect(list()).toEqual(before); expect(tasks).toHaveLength(1); expect(download).not.toHaveBeenCalled();
  });
  it.each(['图片模式入口未就绪，已在提交前停止；请重试', '视频模式入口未就绪，已在提交前停止', 'TEST 未知错误，未提交'])('其他 unknown 错误仍拒绝恢复：%s', async (message): Promise<void> => {
    await approve(); const next = await service.advance(p.id); const original = await start(next.taskId || '');
    core.updateRuntime({ taskId: original.id, status: 'fail', errorInfo: { code: 'unknown', message, recoverable: true, detectedAt: new Date().toISOString() } });
    await service.advance(p.id); const before = list();
    await expect(service.resume(p.id, capability())).rejects.toThrow('未确认可安全恢复');
    expect(list()).toEqual(before); expect(tasks).toHaveLength(1);
  });
  it.each(legacyPreparationErrors.flatMap((error) => (['acceptance', 'reply', 'readback', 'review', 'observation', 'outputs', 'artifacts'] as const).map((evidence) => ({ error, evidence }))))('发送前错误 $error.code 遇到 $evidence 证据仍禁止重新发送', async ({ error, evidence }): Promise<void> => {
    await approve(); const next = await service.advance(p.id); const original = await start(next.taskId || '');
    const now = new Date().toISOString();
    core.updateRuntime({ taskId: original.id, status: 'paused', errorInfo: { ...error, recoverable: true, detectedAt: now } });
    await service.advance(p.id);
    const task = tasks[0]; const runtime = task.runtime!; const runId = runtime.runId;
    if (evidence === 'acceptance') runtime.acceptanceObservation = {
      schemaVersion: 1, accountId: p.accountId, runId, conversationUrl: 'https://www.doubao.com/chat/TEST-evidence', acceptedAt: now,
      evidence: { kind: 'generation_started' }, cursor: { messageCount: 1, pollCount: 0 }, expectedArtifact: { kind: 'image', runId },
      lease: { ownerId: 'TEST', acquiredAt: now, expiresAt: now, lastHeartbeatAt: now }, outcome: 'observing',
    };
    else if (evidence === 'reply') runtime.chatResponse = { text: 'TEST 已收到回复', capturedAt: now };
    else if (evidence === 'readback') runtime.chatReadback = { runId, baselineMessageCount: 1, association: 'full_prompt', observedAt: now };
    else if (evidence === 'review') runtime.chatReadbackReview = { runId, checkedAt: now, reason: 'TEST 需要核对', candidates: [] };
    else if (evidence === 'observation') runtime.manualObservation = { startedAt: now, expiresAt: now, source: 'stored_conversation', outcome: 'observing' };
    else if (evidence === 'outputs') task.outputs = ['https://TEST.invalid/already-produced.png'];
    else task.artifacts = [{ id: 'TEST-existing-artifact', url: 'https://TEST.invalid/already-produced.png', kind: 'image', source: 'page', runId, discoveredAt: now }];
    const before = list();
    await expect(service.resume(p.id, capability())).rejects.toThrow('未确认可安全恢复');
    expect(list()).toEqual(before); expect(createdInputs).toHaveLength(1); expect(download).not.toHaveBeenCalled();
  });
  it.each(['run', 'mode'] as const)('旧版发送前错误也必须核对原运行 %s 归属', async (mismatch): Promise<void> => {
    await approve(); const next = await service.advance(p.id); const original = await start(next.taskId || '');
    core.updateRuntime({ taskId: original.id, status: 'paused', errorInfo: { code: 'submission_uncertain', message: '最终全文或段落回读不一致，未提交', recoverable: true, detectedAt: new Date().toISOString() } });
    await service.advance(p.id);
    if (mismatch === 'run') tasks[0].runtime!.runId = 'TEST-foreign-run';
    else tasks[0].runtime!.input.mode = 'video';
    const before = list();
    await expect(service.resume(p.id, capability())).rejects.toThrow(mismatch === 'run' ? '原运行已变化' : '原运行输入快照');
    expect(list()).toEqual(before); expect(tasks).toHaveLength(1);
  });
  it.each(legacyPreparationErrors)('旧版发送前错误 $code 缺少生产步骤的运行绑定时不猜测恢复', async (error): Promise<void> => {
    await approve(); const next = await service.advance(p.id); const original = await start(next.taskId || '');
    core.updateRuntime({ taskId: original.id, status: 'paused', errorInfo: { ...error, recoverable: true, detectedAt: new Date().toISOString() } });
    await service.advance(p.id);
    const stopped = await projects.read(p.id); stopped.production!.steps[0].runId = undefined; await projects.write(stopped);
    const before = list();
    await expect(service.resume(p.id, capability())).rejects.toThrow('未确认可安全恢复');
    expect(list()).toEqual(before); expect(tasks).toHaveLength(1); expect(download).not.toHaveBeenCalled();
  });
  it('即使错误文案声称未提交，已有提交意图仍只能核对原运行', async (): Promise<void> => {
    await approve(); const next = await service.advance(p.id); const original = await start(next.taskId || '');
    core.updateRuntime({ taskId: original.id, status: 'paused', runtime: { submittedAt: new Date().toISOString() }, errorInfo: { code: 'submission_uncertain', message: '最终全文或段落回读不一致，未提交', recoverable: true, detectedAt: new Date().toISOString() } });
    await service.advance(p.id); const before = list();
    await service.resume(p.id, capability());
    const continued = await service.advance(p.id);
    expect(continued).toMatchObject({ success: true, action: 'observe', taskId: original.id });
    expect(list()).toEqual(before); expect(tasks).toHaveLength(1); expect(download).not.toHaveBeenCalled();
  });
  it('already generated assets download without any page inspection record', async (): Promise<void> => {
    await approve(); const next = await service.advance(p.id); await complete(next.taskId || ''); await service.pause(p.id);
    await service.resume(p.id);
    expect((await service.advance(p.id)).success).toBe(true); expect(download).toHaveBeenCalledTimes(1); expect(tasks).toHaveLength(1);
    expect((await service.advance(p.id)).project?.production?.state).toBe('paused'); expect(tasks).toHaveLength(1);
  });
  it('an expired or foreign-run artifact cannot enter a download or downstream task', async (): Promise<void> => {
    await approve(); const next = await service.advance(p.id); await complete(next.taskId || '');
    const artifact = tasks[0].artifacts?.[0];
    if (!artifact) throw new Error('TEST artifact missing');
    artifact.validation = { state: 'expired', checkedAt: new Date().toISOString() };
    expect((await service.advance(p.id)).success).toBe(false); expect(download).not.toHaveBeenCalled(); expect(tasks).toHaveLength(1);
  });
  it('保存同一运行的可解码图片候选，跳过损坏文件且不自动采用或重生成', async (): Promise<void> => {
    await approve(); const next = await service.advance(p.id); await complete(next.taskId || '');
    const original = tasks[0].outputs[0];
    core.updateStatus({ taskId: tasks[0].id, status: 'done', outputs: [original, 'https://TEST.invalid/second.png'] });
    const corrupt = path.join(root, 'TEST-corrupt-image.png'); await fs.writeFile(corrupt, 'TEST not image');
    download.mockImplementationOnce(async (): Promise<object> => {
      const now = new Date().toISOString();
      jobs.push({ id: 'TEST-corrupt', taskId: tasks[0].id, accountId: p.accountId, mode: 'image', url: original, status: 'done', attempts: 1, saveDir: root, filePath: corrupt, createdAt: now, updatedAt: now });
      return { success: true, failed: 0, count: 1, jobIds: ['TEST-corrupt'] };
    });
    const result = await service.advance(p.id);
    expect(result.success, result.error).toBe(true); expect(tasks).toHaveLength(1); expect(download).toHaveBeenCalledTimes(2);
    const selected = result.project?.assets.find((a): boolean => a.id === result.project?.production?.steps[0].assetId);
    expect(selected?.artifactId).toBe(tasks[0].artifacts?.find((a): boolean => a.url.endsWith('second.png'))?.id);
  });
  it('多个图片均为候选，用户选择具体产物后采用，保留其他候选与任务身份', async (): Promise<void> => {
    await approve(); const next = await service.advance(p.id); await complete(next.taskId || '');
    core.updateStatus({ taskId: tasks[0].id, status: 'done', outputs: [...tasks[0].outputs, 'https://TEST.invalid/choice.png'] });
    const imported = await service.advance(p.id);
    const current = imported.project!; const candidates = current.assets.filter((asset): boolean => asset.imageReview?.state === 'candidate');
    expect(candidates).toHaveLength(2); expect(current.production?.shots['TEST-shot-1'].firstFrameId).toBeUndefined();
    const alternative = candidates.find((asset): boolean => asset.artifactId === tasks[0].artifacts?.find((item): boolean => item.url.endsWith('choice.png'))?.id)!;
    const adopted = await projects.adoptImage(current.id, current.revision, alternative.imageReview!.target, alternative.id);
    expect(adopted.adoptedImages?.['TEST-shot-1'].firstFrameId).toBe(alternative.id);
    expect(adopted.assets.filter((asset): boolean => asset.imageReview?.state === 'candidate')).toHaveLength(1);
    expect(tasks).toHaveLength(1);
    await service.resume(p.id, capability());
    expect((await service.advance(p.id)).action).toBe('start');
  });
  it('第二张候选下载失败仍保存第一张，恢复只补下载原缺项，不再次生成', async (): Promise<void> => {
    await approve(); const next = await service.advance(p.id); await complete(next.taskId || '');
    core.updateStatus({ taskId: tasks[0].id, status: 'done', outputs: [...tasks[0].outputs, 'https://TEST.invalid/second-download.png'] });
    const originalDownload = download.getMockImplementation(); if (!originalDownload) throw new Error('TEST download missing');
    download.mockImplementationOnce(originalDownload).mockImplementationOnce(async (): Promise<object> => ({ success: false, failed: 1, count: 0 }));
    expect((await service.advance(p.id)).success).toBe(false);
    let saved = await projects.read(p.id);
    expect(saved.assets.filter((asset): boolean => asset.imageReview?.state === 'candidate')).toHaveLength(1);
    expect(saved.production?.steps[0].status).toBe('bound'); expect(saved.production?.shots['TEST-shot-1'].firstFrameId).toBeUndefined();
    await service.resume(p.id, capability()); expect((await service.advance(p.id)).success).toBe(true);
    saved = await projects.read(p.id);
    expect(saved.assets.filter((asset): boolean => asset.imageReview?.state === 'candidate')).toHaveLength(2);
    expect(saved.production?.steps[0].status).toBe('complete'); expect(tasks).toHaveLength(1); expect(download).toHaveBeenCalledTimes(3);
  });
  it('does not accept a download job for a different account', async (): Promise<void> => {
    await approve(); const next = await service.advance(p.id); await complete(next.taskId || '');
    download.mockImplementationOnce(async (): Promise<object> => {
      const now = new Date().toISOString();
      jobs.push({ id: 'TEST-foreign', taskId: tasks[0].id, accountId: 'TEST-other', mode: 'image', url: tasks[0].outputs[0], status: 'done', attempts: 1, saveDir: root, filePath: picture, createdAt: now, updatedAt: now });
      return { success: true, failed: 0, count: 1, jobIds: ['TEST-foreign'] };
    });
    expect((await service.advance(p.id)).success).toBe(false); expect((await projects.read(p.id)).production?.steps[0].assetId).toBeUndefined(); expect(tasks).toHaveLength(1);
  });
  it('actual out-of-range video pauses before continuation and never recreates the generation', async (): Promise<void> => {
    await approve(); const next = await advanceToVideo(); await complete(next.taskId || '');
    const invalidVideo = path.join(root, 'TEST-production-four-seconds.mp4');
    await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x48:r=5:d=4', '-c:v', 'libx264', '-y', invalidVideo]);
    download.mockImplementationOnce(async (): Promise<object> => {
      const task = tasks.find((t): boolean => t.id === next.taskId) as Task; const now = new Date().toISOString();
      jobs.push({ id: 'TEST-invalid-duration', taskId: task.id, accountId: p.accountId, mode: 'video', url: task.outputs[0], status: 'done', attempts: 1, saveDir: root, filePath: invalidVideo, createdAt: now, updatedAt: now });
      return { success: true, failed: 0, count: 1, jobIds: ['TEST-invalid-duration'] };
    });
    const count = tasks.length; const stopped = await service.advance(p.id);
    expect(stopped.success).toBe(false); expect(stopped.error).toContain('5～10');
    await service.resume(p.id, capability()); expect((await service.advance(p.id)).success).toBe(false);
    expect(tasks).toHaveLength(count); expect((await projects.read(p.id)).production?.shots['TEST-shot-2'].firstFrameId).toBeUndefined();
  });
  it('wrong character image order and nonexistent prompt references fail closed', (): void => {
    const lulu = p.plan?.characters.find((c): boolean => c.id === 'lulu')?.referenceAssetId || '';
    const lumei = p.plan?.characters.find((c): boolean => c.id === 'lumei')?.referenceAssetId || '';
    expect((): void => checkProductionReferences('图1：噜噜，图2：噜妹', p, [lulu, lumei])).not.toThrow();
    expect((): void => checkProductionReferences('图1：噜噜，图2：噜妹', p, [lumei, lulu])).toThrow('错绑');
    expect((): void => checkProductionReferences('第一张参考图：噜噜，第二张参考图：噜妹', p, [lulu, lumei])).not.toThrow();
    expect((): void => checkProductionReferences('第一张参考图：噜噜', p, [lumei])).toThrow('错绑');
    expect((): void => checkProductionReferences('参考图3', p, [lulu, lumei])).toThrow('没有对应');
    expect((): void => checkProductionReferences('/Users/TEST/reference.png', p, [lulu])).toThrow('文件路径');
  });
  it('download failure and explicit resume reuse the accepted generation and never regenerate', async (): Promise<void> => {
    await approve(); const next = await service.advance(p.id); await complete(next.taskId || '');
    downloadFailure = true;
    expect((await service.advance(p.id)).success).toBe(false);
    expect(tasks).toHaveLength(1); expect(tasks[0].status).toBe('done');
    downloadFailure = false;
    await service.resume(p.id, capability());
    expect((await service.advance(p.id)).success).toBe(true);
    expect(tasks).toHaveLength(1); expect(download).toHaveBeenCalledTimes(2);
    expect((await projects.read(p.id)).production?.steps[0].status).toBe('complete');
  });
  it('accepted task resumes observation of the same run, unknown submission never retries', async (): Promise<void> => {
    await approve(); const next = await service.advance(p.id); const task = await start(next.taskId || '');
    const now = new Date().toISOString(); const runId = task.runtime?.runId || '';
    core.updateRuntime({ taskId: task.id, status: 'paused', runtime: { submittedAt: now, conversationUrl: 'https://www.doubao.com/chat/TEST-existing', acceptanceObservation: {
      schemaVersion: 1, accountId: p.accountId, runId, conversationUrl: 'https://www.doubao.com/chat/TEST-existing', acceptedAt: now,
      evidence: { kind: 'generation_started' }, cursor: { messageCount: 1, pollCount: 0 }, expectedArtifact: { kind: 'image', runId },
      lease: { ownerId: 'TEST', acquiredAt: now, expiresAt: now, lastHeartbeatAt: now }, outcome: 'observing',
    } } });
    await service.pause(p.id); await service.resume(p.id, capability());
    const observe = await service.advance(p.id);
    expect(observe).toMatchObject({ success: true, action: 'observe', taskId: task.id }); expect(tasks).toHaveLength(1);
    core.updateRuntime({ taskId: task.id, runtime: { acceptanceObservation: undefined } });
    // 明确删除该受理凭证，模拟“发送过但平台受理不明”。
    tasks[0].runtime = { ...tasks[0].runtime as NonNullable<Task['runtime']>, acceptanceObservation: undefined };
    const uncertain = await service.advance(p.id);
    expect(uncertain).toMatchObject({ success: true, action: 'observe', taskId: task.id }); expect(tasks).toHaveLength(1);
  });
  async function uncertainProduction(): Promise<{ task: Task; request: import('@doubao-studio/contracts').TaskResubmitUncertainParams; current: PetStoryProject }> {
    await approve(); const next = await service.advance(p.id); const task = await start(next.taskId || '');
    const submittedAt = new Date().toISOString();
    expect(core.updateRuntime({ taskId: task.id, status: 'waiting_verification', runtime: { submittedAt }, errorInfo: { code: 'human_verification', message: 'TEST 验证阻断', recoverable: true, detectedAt: submittedAt } }).success).toBe(true);
    await service.pause(p.id);
    return { task: list().find((item): boolean => item.id === task.id)!, current: await projects.read(p.id),
      request: { taskId: task.id, runId: task.runtime!.runId, submittedAt, authorizationId: `TEST-authorization-${task.id}`, acceptDuplicateRisk: true } };
  }
  it('explicit resubmission binds one new hold task, retains source evidence, and starts only after normal run guard', async (): Promise<void> => {
    const { task, current, request } = await uncertainProduction();
    const result = await service.resubmit(p.id, current.revision, request, capability());
    expect(result).toMatchObject({ success: true, action: 'start' });
    expect(tasks).toHaveLength(2);
    const replacement = list().find((item): boolean => item.id === result.taskId)!;
    expect(replacement).toMatchObject({ executionIntent: 'hold', status: 'queued', resubmissionOf: { taskId: task.id, runId: request.runId } });
    expect(replacement.runtime).toBeUndefined();
    expect(list().find((item): boolean => item.id === task.id)?.runtime).toEqual(task.runtime);
    const step = result.project!.production!.steps[0];
    expect(step).toMatchObject({ taskId: replacement.id, status: 'bound', resubmissionHistory: [{ taskId: task.id, runId: request.runId, submittedAt: request.submittedAt, inputHash: current.production!.steps[0].inputHash }] });
    expect(step.runId).toBeUndefined();
    await expect(service.guard(replacement.id)).rejects.toThrow('运行尚未绑定');
    expect((await start(replacement.id)).runtime?.runId).not.toBe(request.runId);
    const duplicate = await service.resubmit(p.id, current.revision, request, capability());
    expect(duplicate).toMatchObject({ success: true, action: 'wait', taskId: replacement.id }); expect(tasks).toHaveLength(2);
  });
  it('project write failure leaves one held replacement and retries the same authorization without another task', async (): Promise<void> => {
    const { task, current, request } = await uncertainProduction();
    const write = vi.spyOn(projects, 'write'); write.mockRejectedValueOnce(new Error('TEST project disk failure'));
    await expect(service.resubmit(p.id, current.revision, request, capability())).rejects.toThrow('TEST project disk failure');
    write.mockRestore();
    expect(tasks).toHaveLength(2);
    const replacement = tasks.find((item): boolean => item.id !== task.id)!;
    expect(replacement).toMatchObject({ executionIntent: 'hold', status: 'queued' });
    expect((await projects.read(p.id)).production!.steps[0].taskId).toBe(task.id);
    await expect(service.guard(replacement.id, false)).rejects.toThrow('制作已暂停');
    const recovered = await service.resubmit(p.id, current.revision, request, capability());
    expect(recovered).toMatchObject({ success: true, action: 'start', taskId: replacement.id }); expect(tasks).toHaveLength(2);
  });
  it('lost success response and reopened service reauthorize the same unstarted replacement, never another task', async (): Promise<void> => {
    const { current, request } = await uncertainProduction();
    const result = await service.resubmit(p.id, current.revision, request, capability());
    const reopened = new PetStoryProjects(); await reopened.open(projects.directory(p.id));
    const recovered = makeService(reopened);
    await expect(recovered.guard(result.taskId!, false)).rejects.toThrow('尚未显式继续');
    const replay = await recovered.resubmit(p.id, current.revision, request, capability());
    expect(replay).toMatchObject({ success: true, action: 'start', taskId: result.taskId });
    expect((await recovered.guard(result.taskId!, false)).success).toBe(true); expect(tasks).toHaveLength(2);
  });
  it('resubmission archives original page references and requires fresh bindings for the new task', async (): Promise<void> => {
    await approve(); const next = await service.advance(p.id); const task = await start(next.taskId!);
    const before = await projects.read(p.id); const step = before.production!.steps[0];
    const bindings = step.compiledPrompt!.references.map((reference, index): import('@doubao-studio/contracts').PetStoryPageBinding => ({
      assetId: reference.assetId, order: index + 1, slot: 'reference', label: `@图片${index + 1}`, previewHash: String(index + 1).padStart(64, '0'),
      reference: 'mention', targetId: `TEST-old-target-${index}`, fileSha256: before.assets.find((asset): boolean => asset.id === reference.assetId)!.validation!.sha256,
      nodeIds: [], occurrenceCount: 0,
    }));
    await service.recordPageBindings(p.id, task.id, task.runtime!.runId, bindings);
    const submittedAt = new Date().toISOString();
    core.updateRuntime({ taskId: task.id, status: 'paused', runtime: { submittedAt } });
    await service.pause(p.id); const current = await projects.read(p.id); const originalRuntime = list()[0].runtime;
    const result = await service.resubmit(p.id, current.revision, { taskId: task.id, runId: task.runtime!.runId, submittedAt, authorizationId: 'TEST-page-binding-retry', acceptDuplicateRisk: true }, capability());
    const replacementStep = result.project!.production!.steps[0];
    expect(replacementStep.pageBindings).toBeUndefined(); expect(replacementStep.pageBindingHistory?.[0].bindings).toEqual(bindings);
    expect(replacementStep.resubmissionHistory?.[0]).toMatchObject({ taskId: task.id, runId: task.runtime!.runId, pageBindings: bindings });
    expect(list().find((item): boolean => item.id === task.id)?.runtime).toEqual(originalRuntime);
    expect(list().find((item): boolean => item.id === result.taskId)?.runtime).toBeUndefined();
    expect((await service.guard(result.taskId!, false)).success).toBe(true);
  });
  it('resubmission rejects stale run, changed revision and unacknowledged risk before creating a task', async (): Promise<void> => {
    const { current, request } = await uncertainProduction();
    await expect(service.resubmit(p.id, current.revision, { ...request, runId: 'TEST-stale' }, capability())).rejects.toThrow('原提交已变化');
    await expect(service.resubmit(p.id, current.revision - 1, request, capability())).rejects.toThrow('项目版本已变化');
    await expect(service.resubmit(p.id, current.revision, { ...request, acceptDuplicateRisk: false as true }, capability())).rejects.toThrow('请明确确认');
    expect(tasks).toHaveLength(1);
  });
  it('late original completion prevents a new request while existing results remain available', async (): Promise<void> => {
    const { task, current, request } = await uncertainProduction();
    expect(core.updateStatus({ taskId: task.id, status: 'done', outputs: ['https://TEST.invalid/late.png'] }).success).toBe(true);
    await expect(service.resubmit(p.id, current.revision, request, capability())).rejects.toThrow('原任务仍在运行或已有回复');
    expect(tasks).toHaveLength(1); expect(tasks[0].outputs).toEqual(['https://TEST.invalid/late.png']);
  });
  it('reopening alone never authorizes a queued task or creates another generation', async (): Promise<void> => {
    await approve(); const next = await service.advance(p.id);
    const reopened = new PetStoryProjects(); await reopened.open(projects.directory(p.id));
    const recovered = makeService(reopened);
    expect((await recovered.advance(p.id)).action).toBeUndefined();
    await expect(recovered.guard(next.taskId || '')).rejects.toThrow('尚未显式继续');
    await recovered.resume(p.id, capability());
    expect((await recovered.advance(p.id)).taskId).toBe(next.taskId); expect(tasks).toHaveLength(1);
  });
  it('task binding write failure leaves the original hold task and zero dispatch authorization', async (): Promise<void> => {
    await approve();
    let writes = 0;
    const failing = new PetStoryProjects(async (from, to): Promise<void> => { writes++; if (writes === 3) throw new Error('TEST uncertain binding'); await fs.rename(from, to); });
    await failing.open(projects.directory(p.id)); const unsafe = makeService(failing);
    await unsafe.resume(p.id, capability());
    const failed = await unsafe.advance(p.id);
    expect(failed.success).toBe(false); expect(tasks).toHaveLength(1); expect(tasks[0].executionIntent).toBe('hold'); expect(tasks[0].runtime).toBeUndefined();
    await unsafe.resume(p.id, capability());
    expect((await unsafe.advance(p.id)).error).toContain('创建或写盘结果不确定'); expect(tasks).toHaveLength(1);
  });
  it('wrong task ownership is rejected before downloading or downstream generation', async (): Promise<void> => {
    await approve(); const next = await service.advance(p.id); await complete(next.taskId || '');
    tasks[0].assignedAccountId = 'TEST-other';
    expect((await service.advance(p.id)).success).toBe(false); expect(download).not.toHaveBeenCalled(); expect(tasks).toHaveLength(1);
  });
  it('a selected video file changed on disk blocks continuation; planned tail cannot substitute', async (): Promise<void> => {
    await approve(); const next = await advanceToVideo(); await complete(next.taskId || '');
    expect((await service.advance(p.id)).success).toBe(true);
    const saved = await projects.read(p.id); const id = saved.production?.shots['TEST-shot-1'].videoId;
    const asset = saved.assets.find((a): boolean => a.id === id);
    await fs.writeFile(path.join(projects.directory(p.id), asset?.relativePath || ''), 'TEST corrupted');
    const stopped = await service.advance(p.id);
    expect(stopped.success).toBe(false); expect(stopped.error).toContain('发生变化');
    expect((await projects.read(p.id)).production?.shots['TEST-shot-2'].firstFrameId).toBeUndefined();
  });
});

describe('P4 真实离线媒体校验', (): void => {
  it.each([5, 10])('accepts actual %s-second decodable MP4', async (duration): Promise<void> => {
    const file = path.join(root, `TEST-valid-${duration}.mp4`);
    await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=red:s=32x48:r=5:d=${duration}`, '-c:v', 'libx264', '-y', file]);
    expect((await validatePetStoryMedia(file, 'video')).durationSeconds).toBe(duration);
  });
  it.each([4, 11])('rejects actual %s-second videos without generating again', async (duration): Promise<void> => {
    const file = path.join(root, `TEST-invalid-${duration}.mp4`);
    await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=red:s=32x48:r=5:d=${duration}`, '-c:v', 'libx264', '-y', file]);
    await expect(validatePetStoryMedia(file, 'video')).rejects.toThrow('5～10');
    expect(tasks).toHaveLength(0);
  });
  it('rejects thumbnail PNG masquerading as MP4 and a truncated video', async (): Promise<void> => {
    const fake = path.join(root, 'TEST-thumbnail.mp4'); await fs.copyFile(picture, fake);
    await expect(validatePetStoryMedia(fake, 'video')).rejects.toThrow();
    const broken = path.join(root, 'TEST-truncated.mp4'); await fs.writeFile(broken, (await fs.readFile(video)).subarray(0, 80));
    await expect(validatePetStoryMedia(broken, 'video')).rejects.toThrow();
  });
  it('black-only video never supplies a fake continuation frame', async (): Promise<void> => {
    const black = path.join(root, 'TEST-black.mp4');
    await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x48:r=5:d=5', '-c:v', 'libx264', '-y', black]);
    await expect(extractActualEndFrame(black, path.join(root, 'TEST-no-frame.png'))).rejects.toThrow('非黑画面');
  });
});
