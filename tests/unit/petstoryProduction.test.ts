/** P4 离线集成：真实 TaskService/归一化/项目磁盘/FFmpeg，网页与下载仅用明确 TEST 夹具。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadJob, PetStoryCapability, PetStoryPageBinding, PetStoryPlan, PetStoryProductionResult, PetStoryProject, Task, TaskAddParams } from '@doubao-studio/contracts';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { PetStoryProductionService, productionCounts, checkProductionReferences, productionPlanHash, legacyProductionPlanHash } from '../../main/utils/petstoryProduction';
import { resolvePetStoryMode } from '../../main/utils/petstoryModes';
import { productionCapability } from '../../main/utils/petstoryCapability';
import { PetStoryExistingMediaService } from '../../main/utils/petstoryExistingMedia';
import { extractActualEndFrame, mediaCommand, validatePetStoryMedia } from '../../main/utils/petstoryMedia';
import { TaskService } from '../../main/core/TaskService';
import { legacyApprovedMaterialHash, syncMaterials } from '../../main/utils/petstoryMaterials';
import { seedOfflinePromptContracts } from '../fixtures/petstoryPromptContracts';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';
import { promptTimingPlanHash } from '../../main/utils/petstoryEligibility';

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
  p.promptCapability = value; seedOfflinePromptContracts(p, undefined, { completeVideoBody: true }); p = await projects.write(p);
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
  it('同一采用图的旧人物设计文字变化不撤销当前制作，实际角色剧情改变仍拒绝原授权', async (): Promise<void> => {
    await approve(); const originalHash = p.production!.planHash; const materialHash = p.production!.materialHash;
    p.plan!.characters[0].description = 'TEST仅修改已被采用图替代的旧造型文字';
    p.materials = syncMaterials(p); p = await projects.write(p);
    const resumed = await service.resume(p.id, capability()); expect(resumed.success).toBe(true);
    p = resumed.project!; expect(p.production).toMatchObject({ planHash: originalHash, materialHash });
    const next = await service.advance(p.id); expect(next.success, next.error).toBe(true);
    p = await projects.read(p.id); p.plan!.characters[0].purpose += 'TEST实际剧情职责改变'; p = await projects.write(p);
    await expect(service.resume(p.id, capability())).rejects.toThrow('计划不存在或已经改变');
  });
  it('旧制作摘要仅精确兼容原内容，继续不重写planHash或素材hash', async (): Promise<void> => {
    await approve(); const planHash = legacyProductionPlanHash(p.plan!); const materialHash = legacyApprovedMaterialHash(p);
    p.production!.planHash = planHash; p.production!.materialHash = materialHash; p = await projects.write(p);
    p = (await service.resume(p.id, capability())).project!;
    expect(p.production).toMatchObject({ planHash, materialHash });
    const next = await service.advance(p.id); expect(next.success, next.error).toBe(true);
    p = await projects.read(p.id); expect(p.production).toMatchObject({ planHash, materialHash });
    p.plan!.characters[0].purpose += 'TEST真实剧情改变'; p = await projects.write(p);
    await expect(service.resume(p.id, capability())).rejects.toThrow('计划不存在或已经改变');
  });

  it.each(['firstFrame', 'lastFrame', 'video'] as const)('空final的%s原回复校验失败时说明后台持续修订，不要求用户修复', async (kind): Promise<void> => {
    const shot = p.plan!.shots[2]; p.promptCapability = capability();
    seedOfflinePromptContracts(p, { shotId: shot.id, promptKind: kind }, { completeVideoBody: true });
    const prompt = shot.prompts[kind]!; const job = p.jobs.at(-1)!;
    prompt.final = ''; job.status = 'invalid'; job.resultStatus = undefined;
    job.validationDetails = [{ code: 'TEST-invalid-contract', path: '$.optimized', actualType: 'string', expected: '完整原要求正文', repairable: true, message: 'TEST 缺少本次素材标签' }];
    p = await projects.write(p); const before = structuredClone(p);
    await expect(service.generateShotMedia(p.id, p.revision, shot.id, kind, capability())).rejects.toThrow('软件会在后台按原要求持续修订并校验');
    const inspected = await service.inspectGeneration(p.id, p.revision, { shotId: shot.id, promptKind: kind }, capability());
    expect(inspected.eligibility?.blockers.find((item): boolean => item.code === 'prompt')?.message).toContain('后台按原要求持续修订并校验');
    expect(inspected.eligibility?.blockers.find((item): boolean => item.code === 'prompt')?.message).not.toContain('点击');
    expect(await projects.read(p.id)).toEqual(before); expect(tasks).toEqual([]); expect(createdInputs).toEqual([]);
  });
  it.each(['firstFrame', 'lastFrame', 'video'] as const)('空final的%s已有合格候选时提示确认使用，不重新生成', async (kind): Promise<void> => {
    const shot = p.plan!.shots[2]; p.promptCapability = capability();
    seedOfflinePromptContracts(p, { shotId: shot.id, promptKind: kind }, { completeVideoBody: true });
    const prompt = shot.prompts[kind]!; const job = p.jobs.at(-1)!;
    prompt.final = ''; prompt.candidateJobId = job.id; job.resultStatus = 'candidate';
    p = await projects.write(p); const before = structuredClone(p);
    await expect(service.generateShotMedia(p.id, p.revision, shot.id, kind, capability())).rejects.toThrow('已有待采用候选，请先在对应提示词节点“确认使用”');
    expect(await projects.read(p.id)).toEqual(before); expect(tasks).toEqual([]); expect(createdInputs).toEqual([]);
  });
  it.each(['absent', 'stale', 'wrong-target', 'changed-facts'] as const)('空final且原回复%s时不提供失效的修复或候选采用引导', async (scenario): Promise<void> => {
    const shot = p.plan!.shots[2]; const kind = 'video'; p.promptCapability = capability();
    seedOfflinePromptContracts(p, { shotId: shot.id, promptKind: kind }, { completeVideoBody: true });
    const job = p.jobs.at(-1)!; shot.prompts.video.final = ''; job.status = 'invalid'; job.resultStatus = undefined;
    job.validationDetails = [{ code: 'TEST-invalid-contract', path: '$.optimized', actualType: 'string', expected: '完整原要求正文', repairable: true, message: 'TEST 校验原因' }];
    if (scenario === 'absent') p.jobs = [];
    if (scenario === 'stale') job.resultStatus = 'stale';
    if (scenario === 'wrong-target') job.shotId = p.plan!.shots[0].id;
    if (scenario === 'changed-facts') shot.action = 'TEST 已修改当前镜头动作';
    p = await projects.write(p); const before = structuredClone(p);
    await expect(service.generateShotMedia(p.id, p.revision, shot.id, kind, capability())).rejects.toThrow('尚未准备；开始本镜制作后将先在后台准备并校验');
    expect(await projects.read(p.id)).toEqual(before); expect(tasks).toEqual([]); expect(createdInputs).toEqual([]);
  });
  it.each([
    ['executing', undefined, '正在后台准备并校验'],
    ['queued', 'hold', '文字任务等待继续'],
    ['waiting_verification', undefined, '请先完成原账号登录或人机验证'],
    ['paused', undefined, 'TEST 真实平台阻断'],
  ] as const)('已有当前后台正文任务为%s时区分真实准备状态，不创建媒体任务', async (status, executionIntent, message): Promise<void> => {
    const shot = p.plan!.shots[2]; p.promptCapability = capability();
    seedOfflinePromptContracts(p, { shotId: shot.id, promptKind: 'video' }, { completeVideoBody: true });
    const parent = p.jobs.at(-1)!; shot.prompts.video.final = ''; parent.status = 'invalid'; parent.resultStatus = undefined;
    const child = { ...parent, id: 'TEST-newer-repair', taskId: 'TEST-repair-task', kind: 'repair' as const, parentJobId: parent.id, status: 'bound' as const, rawText: undefined };
    p.jobs.push(child);
    tasks.push({ id: child.taskId, projectId: p.studioProjectId, assignedAccountId: p.accountId, mode: 'chat', status, executionIntent,
      prompt: 'TEST 后台文字请求', outputs: [], result: null, createdAt: p.updatedAt, updatedAt: p.updatedAt,
      errorInfo: status === 'paused' ? { code: 'quota_exhausted', message: 'TEST 真实平台阻断', recoverable: false, detectedAt: p.updatedAt } : undefined });
    p = await projects.write(p); const before = structuredClone(p); const originalTasks = structuredClone(tasks);
    await expect(service.generateShotMedia(p.id, p.revision, shot.id, 'video', capability())).rejects.toThrow(message);
    const inspected = await service.inspectGeneration(p.id, p.revision, { shotId: shot.id, promptKind: 'video' }, capability());
    expect(inspected.eligibility?.blockers.find((item): boolean => item.code === 'prompt')?.message).toContain(message);
    expect(await projects.read(p.id)).toEqual(before); expect(tasks).toEqual(originalTasks); expect(createdInputs).toEqual([]);
  });
  it.each(['missing-details', 'empty-details', 'unrepairable', 'ownership-error'] as const)('空final的原回复%s时要求核对原会话，不引导改写', async (scenario): Promise<void> => {
    const shot = p.plan!.shots[2]; p.promptCapability = capability();
    seedOfflinePromptContracts(p, { shotId: shot.id, promptKind: 'video' }, { completeVideoBody: true });
    const job = p.jobs.at(-1)!; shot.prompts.video.final = ''; job.status = 'invalid'; job.resultStatus = undefined;
    if (scenario === 'empty-details') job.validationDetails = [];
    if (scenario === 'unrepairable') job.validationDetails = [{ code: 'TEST-ownership', path: '$.requestId', actualType: 'string', expected: '原请求身份', repairable: false, message: 'TEST 归属不符' }];
    if (scenario === 'ownership-error') job.error = 'TEST requestId 与原请求不符';
    p = await projects.write(p); const before = structuredClone(p);
    await expect(service.generateShotMedia(p.id, p.revision, shot.id, 'video', capability())).rejects.toThrow('请先查看豆包对话并核对原结果');
    expect(await projects.read(p.id)).toEqual(before); expect(tasks).toEqual([]); expect(createdInputs).toEqual([]);
  });
  it('镜头已不存在时明确提示重新选择，保留现有提示词和任务', async (): Promise<void> => {
    const before = structuredClone(p);
    await expect(service.generateShotMedia(p.id, p.revision, 'TEST-missing-shot', 'video', capability())).rejects.toThrow('镜头不存在或已不属于当前方案');
    expect(await projects.read(p.id)).toEqual(before); expect(tasks).toEqual([]); expect(createdInputs).toEqual([]);
  });
  async function prepareReferenceContinuation(nativeClaim: boolean = false, framePurpose?: string): Promise<{ request: import('@doubao-studio/contracts').PetStoryVideoReferenceRequest; original: Task; source: PetStoryProject['plan'] }> {
    const shotId = p.plan!.shots[2].id;
    p = await projects.addShotImage(p.id, p.revision, shotId, 'firstFrame', picture);
    p = await projects.adoptImage(p.id, p.revision, { shotId, kind: 'firstFrame' }, p.assets.at(-1)!.id);
    p = await projects.addShotImage(p.id, p.revision, shotId, 'lastFrame', picture);
    p = await projects.adoptImage(p.id, p.revision, { shotId, kind: 'lastFrame' }, p.assets.at(-1)!.id);
    if (nativeClaim) p.plan!.shots[2].prompts.video.final = `原生首尾帧。${p.plan!.shots[2].prompts.video.final}`;
    if (framePurpose) p.plan!.shots[2].prompts.video.final = `${framePurpose}。${p.plan!.shots[2].prompts.video.final}`;
    const fast = capability(); fast.videoConfig!.model = 'seedance-2.0-fast';
    p.promptCapability = fast; seedOfflinePromptContracts(p, { shotId, promptKind: 'video' }, { completeVideoBody: true }); p = await projects.write(p);
    const generated = await service.generateShotMedia(p.id, p.revision, shotId, 'video', fast); expect(generated.success).toBe(true);
    const pending = await service.advance(p.id); const original = await start(pending.taskId!);
    expect(core.updateRuntime({ taskId: original.id, status: 'paused', errorInfo: { code: 'petstory_controls_unconfirmed', message: 'TEST 仅有普通参考上传，尚未上传或提交', recoverable: true, detectedAt: new Date().toISOString() } }).success).toBe(true);
    expect((await service.advance(p.id)).success).toBe(false); p = await projects.read(p.id);
    const step = p.production!.steps[0];
    return { request: { shotId, taskId: original.id, runId: original.runtime!.runId, inputHash: step.inputHash,
      firstFrameId: step.attachmentAssetIds[0], lastFrameId: step.attachmentAssetIds[1], authorizationId: 'TEST-reference-authorization', useExistingFrames: true }, original: list()[0], source: structuredClone(p.plan) };
  }
  async function resumeFrameIntent(nativeClaim: boolean = false, framePurpose?: string): Promise<{ task: Task; bindings: PetStoryPageBinding[]; original: Task; source: PetStoryProject['plan'] }> {
    const { original, source } = await prepareReferenceContinuation(nativeClaim, framePurpose);
    const resumed = await service.resume(p.id);
    expect(resumed.project!.production!.shots[p.plan!.shots[2].id].resolvedMode).toBe('first_last_frame');
    const task = await start(original.id); p = await projects.read(p.id); const step = p.production!.steps[0];
    const bindings = step.compiledPrompt!.references.map((reference, index): PetStoryPageBinding => ({
      assetId: reference.assetId, order: index + 1, slot: 'reference', label: `@图片${index + 1}`, reference: 'mention',
      previewHash: String(index + 1).padStart(64, '0'), fileSha256: p.assets.find((asset): boolean => asset.id === reference.assetId)!.validation!.sha256,
      targetId: `TEST-unified-target-${index}`, nodeId: `TEST-unified-node-${index}`, nodeIds: [`TEST-unified-node-${index}`], occurrenceCount: 1,
    }));
    return { task, bindings, original, source };
  }
  async function resumeFirstFrameIntent(): Promise<{ task: Task; bindings: PetStoryPageBinding[]; original: Task; source: PetStoryProject['plan'] }> {
    const shotId = p.plan!.shots[0].id;
    p = await projects.addShotImage(p.id, p.revision, shotId, 'firstFrame', picture);
    p = await projects.adoptImage(p.id, p.revision, { shotId, kind: 'firstFrame' }, p.assets.at(-1)!.id);
    p.promptCapability = capability(); seedOfflinePromptContracts(p, { shotId, promptKind: 'video' }, { completeVideoBody: true }); p = await projects.write(p);
    const source = structuredClone(p.plan);
    expect((await service.generateShotMedia(p.id, p.revision, shotId, 'video', capability())).success).toBe(true);
    const pending = await service.advance(p.id); const running = await start(pending.taskId!);
    expect(core.updateRuntime({ taskId: running.id, status: 'paused', errorInfo: { code: 'petstory_controls_unconfirmed', message: 'TEST 统一首帧上传入口，尚未上传或提交', recoverable: true, detectedAt: new Date().toISOString() } }).success).toBe(true);
    expect((await service.advance(p.id)).success).toBe(false); p = await projects.read(p.id);
    const original = list()[0]; await service.resume(p.id);
    const task = await start(original.id); p = await projects.read(p.id);
    const reference = p.production!.steps[0].compiledPrompt!.references[0];
    const bindings: PetStoryPageBinding[] = [{ assetId: reference.assetId, order: 1, slot: 'reference', label: '@图片1', reference: 'mention',
      previewHash: '1'.repeat(64), fileSha256: p.assets.find((asset): boolean => asset.id === reference.assetId)!.validation!.sha256,
      targetId: 'TEST-first-target', nodeId: 'TEST-first-node', nodeIds: ['TEST-first-node'], occurrenceCount: 1 }];
    return { task, bindings, original, source };
  }
  it.each(['mention', 'plain'] as const)('单张首帧经统一上传按真实%s绑定，原task继续并在重开后保持首帧用途', async (reference): Promise<void> => {
    const { task, bindings, original, source } = await resumeFirstFrameIntent();
    const originalReferences = structuredClone(p.production!.steps[0].compiledPrompt!.references);
    if (reference === 'plain') { const binding = bindings[0]; binding.reference = 'plain'; binding.label = '第 1 张图'; delete binding.nodeId; delete binding.targetId; delete binding.nodeIds; delete binding.occurrenceCount; }
    const result = await service.recordPageBindings(p.id, task.id, task.runtime!.runId, bindings);
    const saved = await projects.read(p.id); const step = saved.production!.steps[0];
    expect(result.success).toBe(true); expect(saved.plan).toEqual(source);
    expect(saved.production!.shots[p.plan!.shots[0].id].resolvedMode).toBe('first_frame');
    expect(step.compiledPrompt!.resolvedMode).toBe('first_frame'); expect(step.compiledPrompt!.references).toEqual(originalReferences);
    expect(step.compiledPrompt!.references.map((item): string | undefined => item.slot)).toEqual(['first']);
    expect(step.compiledPrompt!.final).toBe(source!.shots[0].prompts.video.final); expect(step.pageBindings).toEqual(bindings);
    expect(step.compiledPrompt!.text).toContain(reference === 'mention' ? '@图片1' : '第 1 张图');
    const actual = list()[0]; expect(actual.id).toBe(original.id); expect(actual.videoConfig).toEqual(original.videoConfig);
    expect(actual.attachments).toEqual(original.attachments); expect(actual.runtime!.input.prompt).toBe(step.compiledPrompt!.text);
    expect(actual.runtime!.submittedAt).toBeUndefined(); expect(saved.production!.referenceContinuations).toBeUndefined();
    const reopened = new PetStoryProjects(); await reopened.open(projects.directory(p.id)); const recovered = makeService(reopened);
    await expect(recovered.guard(task.id)).rejects.toThrow('尚未显式继续');
    expect((await recovered.resume(p.id)).success).toBe(true);
    const guarded = (await recovered.guard(task.id)).guard!;
    expect(guarded.mode).toBe('first_frame'); expect(guarded.compiledPrompt).toEqual(step.compiledPrompt);
    expect(guarded.attachmentAssetIds).toEqual([bindings[0].assetId]);
    expect(tasks).toHaveLength(1); expect(createdInputs).toHaveLength(1);
  });
  it.each(['count', 'order', 'asset', 'file-hash', 'preview', 'fake-slot', 'mention-nodes'] as const)('单张首帧统一上传拒绝%s错绑，保留原任务和正文', async (change): Promise<void> => {
    const { task, bindings } = await resumeFirstFrameIntent();
    if (change === 'count') bindings.push({ ...bindings[0], order: 2 });
    if (change === 'order') bindings[0].order = 2;
    if (change === 'asset') bindings[0].assetId = p.assets[0].id;
    if (change === 'file-hash') bindings[0].fileSha256 = '0'.repeat(64);
    if (change === 'preview') bindings[0].previewHash = 'TEST-not-a-preview-hash';
    if (change === 'fake-slot') bindings[0].reference = 'slot';
    if (change === 'mention-nodes') bindings[0].nodeIds = [];
    const before = await projects.read(p.id); const beforeTasks = list();
    await expect(service.recordPageBindings(p.id, task.id, task.runtime!.runId, bindings)).rejects.toThrow();
    expect(await projects.read(p.id)).toEqual(before); expect(list()).toEqual(beforeTasks);
  });
  it('单张首帧统一上传不能满足已保存正文明确要求的原生首帧槽', async (): Promise<void> => {
    const { task, bindings } = await resumeFirstFrameIntent();
    const declared = await projects.read(p.id); declared.production!.steps[0].compiledPrompt!.final = `原生首帧。${declared.production!.steps[0].compiledPrompt!.final}`;
    await projects.write(declared); const before = await projects.read(p.id); const beforeTasks = list();
    await expect(service.recordPageBindings(p.id, task.id, task.runtime!.runId, bindings)).rejects.toThrow('当前统一上传方式无法满足');
    expect(await projects.read(p.id)).toEqual(before); expect(list()).toEqual(beforeTasks);
  });
  it('提交守卫重新校验已保存的统一单首帧文件摘要，拒绝篡改且不提交', async (): Promise<void> => {
    const { task, bindings } = await resumeFirstFrameIntent();
    await service.recordPageBindings(p.id, task.id, task.runtime!.runId, bindings);
    const changed = await projects.read(p.id); changed.production!.steps[0].pageBindings![0].fileSha256 = '0'.repeat(64); await projects.write(changed);
    await expect(service.guard(task.id)).rejects.toThrow('文件摘要'); expect(list()[0].runtime!.submittedAt).toBeUndefined();
  });
  it.each(['mention', 'plain'] as const)('首尾两图经统一上传按真实%s绑定，继续同一原任务并保留本镜首尾用途', async (reference): Promise<void> => {
    const { task, bindings, original, source } = await resumeFrameIntent();
    if (reference === 'plain') for (const binding of bindings) { binding.reference = 'plain'; binding.label = `第 ${binding.order} 张图`; delete binding.nodeId; delete binding.targetId; delete binding.nodeIds; delete binding.occurrenceCount; }
    const result = await service.recordPageBindings(p.id, task.id, task.runtime!.runId, bindings);
    expect(result.success).toBe(true); const saved = result.project!; const step = saved.production!.steps[0];
    expect(saved.plan).toEqual(source); expect(saved.production!.shots[p.plan!.shots[2].id].resolvedMode).toBe('first_last_frame');
    expect(step.compiledPrompt!.references.map((item): string | undefined => item.slot)).toEqual(['first', 'last']);
    expect(step.pageBindings).toEqual(bindings); expect(step.compiledPrompt!.final).toBe(source!.shots[2].prompts.video.final);
    expect(step.compiledPrompt!.text).toContain(reference === 'mention' ? '@图片1、@图片2' : '第 1 张图、第 2 张图');
    expect((await service.guard(task.id)).guard?.mode).toBe('first_last_frame');
    const actual = list()[0]; expect(actual.id).toBe(original.id); expect(actual.videoConfig).toEqual(original.videoConfig);
    expect(actual.attachments).toEqual(original.attachments); expect(actual.runtime!.input.prompt).toBe(step.compiledPrompt!.text);
    expect(saved.production!.referenceContinuations).toBeUndefined(); expect(tasks).toHaveLength(1); expect(createdInputs).toHaveLength(1);
  });
  it('原生首尾槽绑定保留原校验，按角色渲染引用而不改最终正文', async (): Promise<void> => {
    const { task, bindings, source } = await resumeFrameIntent();
    bindings.forEach((binding, index): void => { binding.slot = index === 0 ? 'first_frame' : 'last_frame'; binding.reference = 'slot'; });
    const result = await service.recordPageBindings(p.id, task.id, task.runtime!.runId, bindings);
    expect(result.compiledPrompt!.text).toContain('首帧画面、尾帧画面'); expect(result.compiledPrompt!.final).toBe(source!.shots[2].prompts.video.final);
    expect((await service.guard(task.id)).guard?.mode).toBe('first_last_frame');
  });
  it.each(['mixed', 'count', 'order', 'asset', 'file-hash', 'preview', 'fake-slot', 'mention-nodes'] as const)('首尾两图统一上传拒绝%s错位，原任务和正文保持原样', async (change): Promise<void> => {
    const { task, bindings } = await resumeFrameIntent();
    if (change === 'mixed') { bindings[0].slot = 'first_frame'; bindings[0].reference = 'slot'; }
    if (change === 'count') bindings.pop();
    if (change === 'order') bindings[0].order = 2;
    if (change === 'asset') [bindings[0].assetId, bindings[1].assetId] = [bindings[1].assetId, bindings[0].assetId];
    if (change === 'file-hash') bindings[0].fileSha256 = '0'.repeat(64);
    if (change === 'preview') bindings[1].previewHash = bindings[0].previewHash;
    if (change === 'fake-slot') bindings[0].reference = 'slot';
    if (change === 'mention-nodes') bindings[0].nodeIds = [];
    const before = await projects.read(p.id); const beforeTasks = list();
    await expect(service.recordPageBindings(p.id, task.id, task.runtime!.runId, bindings)).rejects.toThrow();
    expect(await projects.read(p.id)).toEqual(before); expect(list()).toEqual(beforeTasks);
  });
  it('正文明确要求原生首尾槽时拒绝统一上传，不自动改写正文或切换模式', async (): Promise<void> => {
    const { task, bindings, source } = await resumeFrameIntent(true); const before = list();
    await expect(service.recordPageBindings(p.id, task.id, task.runtime!.runId, bindings)).rejects.toThrow('原生首尾');
    expect(list()).toEqual(before); expect((await projects.read(p.id)).plan).toEqual(source);
    expect((await projects.read(p.id)).production!.shots[p.plan!.shots[2].id].resolvedMode).toBe('first_last_frame');
  });
  it.each(['尾帧作为目标结尾', '以首帧作为开头、尾帧作为结束画面'])('首尾用途“%s”允许统一上传，不误判为原生槽要求', async (framePurpose): Promise<void> => {
    const { task, bindings, source } = await resumeFrameIntent(false, framePurpose);
    const result = await service.recordPageBindings(p.id, task.id, task.runtime!.runId, bindings);
    expect(result.compiledPrompt!.final).toBe(source!.shots[2].prompts.video.final);
    expect((await service.guard(task.id)).guard?.mode).toBe('first_last_frame');
  });
  it('提交守卫重新核对已保存的统一首尾图文件摘要，不能沿用被篡改的页面回执', async (): Promise<void> => {
    const { task, bindings } = await resumeFrameIntent();
    await service.recordPageBindings(p.id, task.id, task.runtime!.runId, bindings);
    const changed = await projects.read(p.id); changed.production!.steps[0].pageBindings![0].fileSha256 = '0'.repeat(64); await projects.write(changed);
    await expect(service.guard(task.id)).rejects.toThrow('文件摘要'); expect(list()[0].runtime!.submittedAt).toBeUndefined();
  });
  it('明确两参考图恢复复用原task、原全文和同Fast，只改变当前实际槽位并保存旧运行审计', async (): Promise<void> => {
    const { request, original, source } = await prepareReferenceContinuation();
    const result = await service.resumeReferenceVideo(p.id, p.revision, request); expect(result.success).toBe(true);
    const saved = result.project!; const step = saved.production!.steps[0]; const record = saved.production!.referenceContinuations![request.shotId];
    expect(saved.plan).toEqual(source); expect(tasks).toHaveLength(1); expect(createdInputs).toHaveLength(1);
    expect(saved.production!.fallbacks[request.shotId]).toBe('reference'); expect(saved.production!.shots[request.shotId].resolvedMode).toBe('reference');
    expect(step.compiledPrompt!.references.map((ref): unknown => [ref.assetId, ref.slot])).toEqual([[request.firstFrameId, undefined], [request.lastFrameId, undefined]]);
    expect(step.compiledPrompt!.text).toBe(original.prompt); expect(step.compiledPrompt!.final).toBe(source!.shots[2].prompts.video.final);
    expect(record.sourceRuntime).toEqual(original.runtime); expect(record.sourceError).toEqual(original.errorInfo); expect(record.model).toBe('seedance-2.0-fast');
    expect(list()[0].videoConfig).toEqual(original.videoConfig); expect(list()[0].runtime!.input).toEqual(original.runtime!.input);
    expect((await service.advance(p.id))).toMatchObject({ success: true, action: 'start', taskId: original.id });
    expect((await service.guard(original.id, false)).guard).toMatchObject({ mode: 'reference', attachmentAssetIds: [request.firstFrameId, request.lastFrameId] });
    const beforeReplay = list()[0].runtime;
    const replay = await service.resumeReferenceVideo(p.id, p.revision, request); expect(replay.success).toBe(true); expect(tasks).toHaveLength(1); expect(list()[0].runtime).toEqual(beforeReplay);
    const nextAt = new Date().toISOString();
    expect(core.updateRuntime({ taskId: original.id, status: 'executing', runtime: { runId: 'TEST-reference-next-run', attempt: 2, stage: 'preparing_account', message: 'TEST',
      startedAt: nextAt, stageStartedAt: nextAt, lastHeartbeatAt: nextAt, input: original.runtime!.input } }).success).toBe(true);
    await service.bindRun(p.id, original.id, 'TEST-reference-next-run');
    const nextRun = list()[0].runtime;
    expect((await service.resumeReferenceVideo(p.id, p.revision, request)).action).toBe('wait'); expect(list()[0].runtime).toEqual(nextRun);
  });
  it('两图授权落盘后重试失败，重开可用同一授权接续，保留原审计且不另建任务', async (): Promise<void> => {
    const { request, original } = await prepareReferenceContinuation();
    const retry = vi.spyOn(core, 'retry').mockImplementationOnce((): never => { throw new Error('TEST 首次重试写盘失败'); });
    await expect(service.resumeReferenceVideo(p.id, p.revision, request)).rejects.toThrow('首次重试写盘失败');
    retry.mockRestore();
    const held = await projects.read(p.id); const record = structuredClone(held.production!.referenceContinuations![request.shotId]);
    expect(held.production!.state).toBe('paused'); expect(list()[0].id).toBe(original.id); expect(list()[0].runtime).toEqual(original.runtime);
    service = makeService();
    expect((await service.resumeReferenceVideo(p.id, p.revision, request)).success).toBe(true);
    expect((await service.advance(p.id))).toMatchObject({ action: 'start', taskId: original.id });
    expect((await projects.read(p.id)).production!.referenceContinuations![request.shotId]).toEqual(record); expect(createdInputs).toHaveLength(1);
  });
  it('两参考图授权后的明确重发保留原模式授权，新hold任务可通过正式运行守卫', async (): Promise<void> => {
    const { request, original } = await prepareReferenceContinuation();
    await service.resumeReferenceVideo(p.id, p.revision, request);
    const now = new Date().toISOString(); const runId = 'TEST-reference-submitted-run';
    expect(core.updateRuntime({ taskId: original.id, status: 'executing', runtime: { runId, attempt: 2, stage: 'preparing_account', message: 'TEST',
      startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: original.runtime!.input } }).success).toBe(true);
    await service.bindRun(p.id, original.id, runId);
    expect(core.updateRuntime({ taskId: original.id, status: 'waiting_verification', runtime: { submittedAt: now },
      errorInfo: { code: 'human_verification', message: 'TEST 验证阻断', recoverable: true, detectedAt: now } }).success).toBe(true);
    await service.pause(p.id); const paused = await projects.read(p.id);
    const result = await service.resubmit(p.id, paused.revision, { taskId: original.id, runId, submittedAt: now,
      authorizationId: 'TEST-reference-resubmission', acceptDuplicateRisk: true });
    expect(result).toMatchObject({ success: true, action: 'start' });
    expect(result.project!.production!.steps[0].resubmissionHistory![0].taskId).toBe(original.id);
    expect((await service.guard(result.taskId!, false)).guard).toMatchObject({ mode: 'reference', attachmentAssetIds: [request.firstFrameId, request.lastFrameId] });
    const reopened = new PetStoryProjects(); await reopened.open(projects.directory(p.id)); service = makeService(reopened);
    await service.resume(p.id);
    expect((await service.guard(result.taskId!, false)).guard?.mode).toBe('reference');
    expect((await service.resumeReferenceVideo(p.id, p.revision, request))).toMatchObject({ action: 'wait', taskId: result.taskId });
    expect(tasks).toHaveLength(2); expect(createdInputs).toHaveLength(1);
  });
  it.each(['submittedAt', 'acceptanceObservation', 'chatResponse', 'chatReadback', 'chatReadbackReview', 'manualObservation', 'outputs', 'artifacts', 'lock', 'resubmissionOf'] as const)('两参考图恢复拒绝%s证据，不清旧记录或改mode', async (evidence): Promise<void> => {
    const { request } = await prepareReferenceContinuation();
    const task = tasks[0];
    if (evidence === 'outputs') task.outputs = ['https://TEST.invalid/late.mp4'];
    else if (evidence === 'artifacts') Object.assign(task, { artifacts: [{ id: 'TEST-late' }] });
    else if (evidence === 'lock') Object.assign(task, { lock: { expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    else if (evidence === 'resubmissionOf') Object.assign(task, { resubmissionOf: {} });
    else Object.assign(task.runtime!, { [evidence]: evidence === 'submittedAt' ? new Date().toISOString() : {} });
    const before = structuredClone(tasks);
    await expect(service.resumeReferenceVideo(p.id, p.revision, request)).rejects.toThrow();
    expect(tasks).toEqual(before); expect((await projects.read(p.id)).production!.shots[request.shotId].resolvedMode).toBe('first_last_frame');
  });
  it('两参考图恢复拒绝错序选图或非模式准备失败，不扩充附件', async (): Promise<void> => {
    const { request } = await prepareReferenceContinuation();
    await expect(service.resumeReferenceVideo(p.id, p.revision, { ...request, lastFrameId: request.firstFrameId })).rejects.toThrow('原顺序');
    tasks[0].errorInfo!.code = 'video_duration_control_not_ready';
    await expect(service.resumeReferenceVideo(p.id, p.revision, request)).rejects.toThrow('明确未提交');
    expect(tasks).toHaveLength(1); expect((await projects.read(p.id)).production!.referenceContinuations).toBeUndefined();
  });
  it('原final严格声明原生首尾时拒绝两图降级，不自动改写正文或落授权', async (): Promise<void> => {
    const { request, original } = await prepareReferenceContinuation(true);
    await expect(service.resumeReferenceVideo(p.id, p.revision, request)).rejects.toThrow('最终文本仍声明原生首尾帧');
    expect(list()[0]).toEqual(original); expect((await projects.read(p.id)).production!.referenceContinuations).toBeUndefined();
  });
  it('两参考图授权不能顺带改变当前模型', async (): Promise<void> => {
    const { request, original } = await prepareReferenceContinuation();
    p.promptModel = 'seedance-2.5'; p = await projects.write(p);
    await expect(service.resumeReferenceVideo(p.id, p.revision, request)).rejects.toThrow('当前模型或比例与原任务不一致');
    expect(list()[0]).toEqual(original); expect((await projects.read(p.id)).production!.referenceContinuations).toBeUndefined();
  });
  it.each(['firstFrame', 'lastFrame', 'video'] as const)('手动确定%s候选后，正式hold任务和运行输入精确使用新正文', async (kind): Promise<void> => {
    const shotId = p.plan!.shots[2].id;
    if (kind !== 'firstFrame') {
      p = await projects.addShotImage(p.id, p.revision, shotId, 'firstFrame', picture);
      p = await projects.adoptImage(p.id, p.revision, { shotId, kind: 'firstFrame' }, p.assets.at(-1)!.id);
    }
    if (kind === 'video') {
      p = await projects.addShotImage(p.id, p.revision, shotId, 'lastFrame', picture);
      p = await projects.adoptImage(p.id, p.revision, { shotId, kind: 'lastFrame' }, p.assets.at(-1)!.id);
    }
    p.promptCapability = capability(); seedOfflinePromptContracts(p, { shotId, promptKind: kind }, { completeVideoBody: true });
    const prompt = p.plan!.shots[2].prompts[kind]!; const job = p.jobs.at(-1)!;
    const candidate = `${prompt.final}\nTEST 候选光线${kind === 'video' ? `；${job.promptTask!.references.map((ref): string => `@图片${ref.order}`).join('、')}。全程无字幕，不叠加对白文字。` : ''}`;
    job.resultStatus = 'candidate'; job.parsedResult = { optimized: candidate }; job.rawText = JSON.stringify({ optimized: candidate });
    prompt.optimized = candidate; prompt.candidateJobId = job.id; p = await projects.write(p);
    const final = `${candidate}\nTEST 人工要求：保留 9:16 和普通数字 12，使用柔和光线。`;
    p = await projects.saveShotPrompt(p.id, p.revision, shotId, kind, final, { expectedFinal: prompt.final, baseJobId: job.id });
    await service.generateShotMedia(p.id, p.revision, shotId, kind, capability());
    const result = await service.advance(p.id);
    expect(result.action).toBe('start'); expect(list()).toHaveLength(1);
    expect(createdInputs[0].prompts).toEqual([final]); expect(list()[0].prompt).toBe(final);
    expect(result.project!.production!.steps[0].compiledPrompt!.final).toBe(final);
    const started = await start(result.taskId!);
    expect(started.runtime!.input.prompt).toBe(final); expect(started.runtime!.input.promptReadback).toBe('exact');
    expect(started.runtime!.submittedAt).toBeUndefined();
  });
  it('未收取Chat阻断相关镜头入口，独立素材仍须具有正式正文', async (): Promise<void> => {
    p.jobs.push({ id: 'TEST-unresolved-chat', taskId: 'TEST-uncertain-chat', kind: 'optimize', status: 'bound', inputHash: 'a'.repeat(64), sourceUrl: p.source.url, sourceStoryId: p.mobileStory!.id, shotId: p.plan!.shots[0].id, promptKind: 'video' });
    p = await projects.write(p); const c = capability();
    await expect(service.preview(p.id, c, {})).rejects.toThrow('未收取');
    await expect(service.approve(p.id, p.revision, c, {})).rejects.toThrow('未收取');
    await expect(service.generateShotMedia(p.id, p.revision, p.plan!.shots[0].id, 'firstFrame', c, {})).rejects.toThrow('未收取');
    await expect(service.generateMaterials(p.id, p.revision, [p.materials![0].id], c)).rejects.toThrow('采用图');
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
  it.each([5, 6, 7, 8, 9, 10])('采用的%s秒时间安排经正式TaskService创建视频任务并保持运行输入与guard一致（离线）', async (duration: number): Promise<void> => {
    const shot = p.plan!.shots[0];
    p.plan!.shots = [shot]; shot.durationSeconds = duration;
    shot.timingPlan = { events: [{ id: 'TEST-action', kind: 'action', description: 'TEST完整动作与必要结果', startSeconds: 0, endSeconds: duration - 0.5 }],
      estimatedRequiredSeconds: duration - 0.5, durationReason: `TEST必要跨度${duration - 0.5}秒取${duration}整秒`, cutReason: 'TEST动作完成且结果可读后切出' };
    shot.prompts.video.final = `TEST采用的${duration}秒离线视频正文，完成本镜动作与结果。`;
    p = await projects.write(p);
    await approve();
    const expectedTimingHash = promptTimingPlanHash(p.plan!.shots[0]);
    expect(p.plan!.shots[0].prompts.video.promptTask?.timingPlanHash).toBe(expectedTimingHash);

    const next = await advanceToVideo();
    const task = await start(next.taskId!);
    const saved = await projects.read(p.id);
    const step = saved.production!.steps.find((item): boolean => item.taskId === task.id)!;
    const created = createdInputs.find((input): boolean => input.mode === 'video')!;
    expect(tasks.filter((item): boolean => item.mode === 'video')).toHaveLength(1);
    expect(created.videoConfig?.duration).toBe(`${duration}s`);
    expect(task.videoConfig?.duration).toBe(`${duration}s`);
    expect(task.runtime!.input.videoConfig?.duration).toBe(`${duration}s`);
    expect(step.compiledPrompt!.final).toBe(saved.plan!.shots[0].prompts.video.final);
    expect(step.compiledPrompt!.final).toContain(`TEST采用的${duration}秒`);
    expect(created.prompts).toEqual([step.compiledPrompt!.text]);
    expect(task.prompt).toBe(step.compiledPrompt!.text);
    expect(task.runtime!.input.prompt).toBe(step.compiledPrompt!.text);
    expect((await service.guard(task.id)).guard).toMatchObject({ durationSeconds: duration, compiledPrompt: step.compiledPrompt });
    expect(task.runtime!.submittedAt).toBeUndefined();

    const reopened = await new PetStoryProjects().open(projects.directory(p.id));
    expect(reopened.plan!.shots[0]).toMatchObject({ durationSeconds: duration, timingPlan: shot.timingPlan });
    expect(reopened.plan!.shots[0].prompts.video.promptTask?.timingPlanHash).toBe(expectedTimingHash);
  });
  it('新auto计划按尾帧目标选择首尾，但重开原批次仍沿用原reference执行快照', async (): Promise<void> => {
    await approve(); p = await projects.read(p.id);
    const shot = p.plan!.shots.find((item): boolean => !!item.prompts.lastFrame)!;
    shot.requestedMode = 'auto';
    Object.assign(p.production!.shots[shot.id], { requestedMode: 'auto', resolvedMode: 'reference' });
    seedOfflinePromptContracts(p, undefined, { completeVideoBody: true }); p = await projects.write(p);
    p.production!.planHash = productionPlanHash(p.plan!); p = await projects.write(p);
    expect(resolvePetStoryMode(shot, productionCapability(p)).resolvedMode).toBe('first_last_frame');
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
  it.each(legacyPreparationErrors.flatMap((error) => (['acceptance', 'media-receipt', 'reply', 'readback', 'review', 'observation', 'outputs', 'artifacts'] as const).map((evidence) => ({ error, evidence }))))('发送前错误 $error.code 遇到 $evidence 证据仍禁止重新发送', async ({ error, evidence }): Promise<void> => {
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
    else if (evidence === 'media-receipt') runtime.mediaSubmissionReceipt = { schemaVersion: 1, source: 'published_message', accountId: p.accountId,
      runId, submittedAt: now, observedAt: now, conversationUrl: 'https://www.doubao.com/chat/TEST-evidence', userMessageId: 'TEST-user-message' };
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
  it('实际视频短于原请求时保留真实文件和原任务，不增加复核门槛或重建生成', async (): Promise<void> => {
    p.plan!.shots = [p.plan!.shots[0]]; p.plan!.shots[0].durationSeconds = 7; p = await projects.write(p);
    await approve(); const next = await advanceToVideo(); await complete(next.taskId || '');
    const original = list().find((task): boolean => task.id === next.taskId)!;
    expect(original.videoConfig?.duration).toBe('7s'); expect(original.runtime?.input.videoConfig?.duration).toBe('7s');
    const count = tasks.length;
    const collected = await service.advance(p.id);
    expect(collected.success, collected.error).toBe(true);
    const saved = await projects.read(p.id); const asset = saved.assets.find((item): boolean => item.kind === 'video')!;
    expect(asset).toMatchObject({ taskId: original.id, runId: original.runtime?.runId, validation: { decoded: true, durationSeconds: 6 } });
    expect(asset.needsReview).toBeUndefined();
    expect(saved.plan!.shots[0].durationSeconds).toBe(7);
    expect(saved.selectedVideos?.[saved.plan!.shots[0].id]).toBe(asset.id);
    expect(await fs.readFile(await service.assetFile(saved, asset.id, 'video'))).toEqual(await fs.readFile(video));
    expect(tasks).toHaveLength(count); expect(list().find((task): boolean => task.id === original.id)).toEqual(original);
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
  it('显式关联重发前迟到的历史视频后可读取原视频，归属仍核对原运行与原素材', async (): Promise<void> => {
    const shotId = p.plan!.shots[0].id; const c = capability();
    p = await projects.addShotImage(p.id, p.revision, shotId, 'firstFrame', picture);
    p = await projects.adoptImage(p.id, p.revision, { shotId, kind: 'firstFrame' }, p.assets.at(-1)!.id);
    p.promptCapability = c; seedOfflinePromptContracts(p, { shotId, promptKind: 'video' }, { completeVideoBody: true }); p = await projects.write(p);
    await service.generateShotMedia(p.id, p.revision, shotId, 'video', c);
    const prepared = await service.advance(p.id); const original = await start(prepared.taskId!); const submittedAt = new Date().toISOString();
    core.updateRuntime({ taskId: original.id, status: 'waiting_verification', runtime: { submittedAt },
      errorInfo: { code: 'human_verification', message: 'TEST 验证阻断', recoverable: true, detectedAt: submittedAt } });
    await service.pause(p.id); const paused = await projects.read(p.id);
    const replacement = await service.resubmit(p.id, paused.revision, { taskId: original.id, runId: original.runtime!.runId, submittedAt,
      authorizationId: 'TEST-late-video-authorization', acceptDuplicateRisk: true }, c);
    await complete(replacement.taskId!); await service.advance(p.id); await service.advance(p.id);
    core.updateStatus({ taskId: original.id, status: 'done', outputs: ['https://TEST.invalid/late-original.mp4'] });
    const source = list().find((task): boolean => task.id === original.id)!; const artifact = source.artifacts![0]; const now = new Date().toISOString();
    jobs.push({ id: 'TEST-late-video-download', taskId: source.id, accountId: p.accountId, mode: 'video', url: artifact.url, status: 'done', attempts: 1,
      saveDir: root, filePath: video, createdAt: now, updatedAt: now });
    const existing = new PetStoryExistingMediaService(projects, { list, downloads: (): DownloadJob[] => structuredClone(jobs) });
    const ready = await projects.read(p.id); const linked = (await existing.link(p.id, ready.revision, shotId, 'video', source.id, artifact.id)).project!;
    const imported = linked.assets.at(-1)!; const replacementAsset = linked.production!.steps[0].assetId;
    expect(imported).toMatchObject({ kind: 'video', origin: 'historical_task', taskId: source.id, runId: source.runtime!.runId, artifactId: artifact.id });
    expect(imported.id).not.toBe(replacementAsset);
    expect(linked.production).toEqual(ready.production); expect(linked.selectedVideos?.[shotId]).toBe(imported.id);
    expect(await service.assetFile(linked, imported.id, 'video')).toBe(path.join(projects.directory(p.id), imported.relativePath));
    const replacementTask = list().find((task): boolean => task.id === replacement.taskId)!;
    const reselected = (await existing.link(p.id, linked.revision, shotId, 'video', replacementTask.id, replacementTask.artifacts![0].id)).project!;
    expect(reselected.selectedVideos?.[shotId]).toBe(replacementAsset); expect(reselected.assets).toHaveLength(linked.assets.length);
    const selectedOriginal = (await existing.link(p.id, reselected.revision, shotId, 'video', source.id, artifact.id)).project!;
    expect(selectedOriginal.selectedVideos?.[shotId]).toBe(imported.id); expect(selectedOriginal.assets).toHaveLength(linked.assets.length);
    const reopened = new PetStoryProjects(); p = await reopened.open(projects.directory(p.id));
    expect(p.selectedVideos?.[shotId]).toBe(imported.id);
    const nextShotId = p.plan!.shots[1].id;
    seedOfflinePromptContracts(p, { shotId: nextShotId, promptKind: 'firstFrame' }); p = await projects.write(p);
    // 当前镜头可能保留之前从替代视频提取的末帧；重新生成必须读取本次明确选择的原视频。
    const oldProduction = p.production!; const oldSource = oldProduction.shots[nextShotId];
    oldSource.actualEndFrameId = 'TEST-previous-end'; oldSource.startFromPreviousEnd = { assetId: replacementAsset!, taskId: replacementTask.id,
      runId: replacementTask.runtime!.runId, sha256: p.assets.find((item): boolean => item.id === replacementAsset)!.validation!.sha256, atSeconds: 5 };
    p.assets.push({ id: 'TEST-previous-end', kind: 'actualEndFrame', shotId: nextShotId, relativePath: `shots/${nextShotId}/TEST-previous-end.png`,
      sourceVideo: oldSource.startFromPreviousEnd });
    p = await projects.write(p);
    const continuation = await service.generateShotMedia(p.id, p.revision, nextShotId, 'firstFrame', c);
    expect(continuation.project!.production!.shots[nextShotId].startFromPreviousEnd?.assetId).toBe(imported.id);
    tasks.find((task): boolean => task.id === original.id)!.runtime!.runId = 'TEST-foreign-video-run';
    await expect(service.assetFile(linked, imported.id, 'video')).rejects.toThrow('归属无效');
    expect(tasks).toHaveLength(2);
  });
  it.each(['shape', 'missing', 'other-shot', 'image'] as const)('镜头视频选择%s无效时拒绝读盘，不沿用其他视频', async (change): Promise<void> => {
    const invalid = structuredClone(p); const shotId = invalid.plan!.shots[0].id;
    invalid.selectedVideos = change === 'shape' ? [] as unknown as Record<string, string> : { [shotId]: change === 'missing' ? 'TEST-missing-video' : invalid.assets[0].id };
    if (change === 'other-shot') {
      const otherShotId = invalid.plan!.shots[1].id;
      invalid.assets.push({ id: 'TEST-other-shot-video', kind: 'video', shotId: otherShotId, relativePath: `shots/${otherShotId}/TEST-other-video.mp4`,
        taskId: 'TEST-other-task', runId: 'TEST-other-run', artifactId: 'TEST-other-artifact', downloadJobId: 'TEST-other-download', validation: await validatePetStoryMedia(video, 'video') });
      invalid.selectedVideos[shotId] = 'TEST-other-shot-video';
    }
    await expect(projects.write(invalid)).rejects.toThrow(change === 'shape' ? '视频选择记录无效' : '选中视频缺失或归属不符');
    expect((await projects.read(p.id)).selectedVideos).toBeUndefined();
  });
  it('旧项目没有视频选择字段仍可保存，删除镜头后保留旧文件与选择历史且不阻断新方案', async (): Promise<void> => {
    expect((await projects.read(p.id)).selectedVideos).toBeUndefined();
    const removedShotId = p.plan!.shots.at(-1)!.id;
    p.assets.push({ id: 'TEST-removed-shot-video', kind: 'video', shotId: removedShotId, relativePath: `shots/${removedShotId}/TEST-removed-video.mp4`,
      taskId: 'TEST-old-task', runId: 'TEST-old-run', artifactId: 'TEST-old-artifact', downloadJobId: 'TEST-old-download', validation: await validatePetStoryMedia(video, 'video') });
    p.selectedVideos = { [removedShotId]: 'TEST-removed-shot-video' }; p = await projects.write(p);
    const nextPlan = structuredClone(p.plan!); nextPlan.shots.pop();
    const saved = await projects.savePlan(p.id, p.revision, nextPlan);
    expect(saved.plan!.shots.some((shot): boolean => shot.id === removedShotId)).toBe(false);
    expect(saved.assets.find((asset): boolean => asset.id === 'TEST-removed-shot-video')).toEqual(p.assets.at(-1));
    const reopened = new PetStoryProjects(); const loaded = await reopened.open(projects.directory(p.id));
    expect(loaded.selectedVideos).toEqual(p.selectedVideos);
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
