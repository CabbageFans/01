/** 离线项目／TaskService 回归：停止后上传候选不改授权，采用新引用不能清掉旧运行。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryPlan, PetStoryProductionResult, PetStoryProject, Task, TaskAddParams } from '@doubao-studio/contracts';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { seedOfflinePromptContracts } from '../fixtures/petstoryPromptContracts';
import { TaskService } from '../../main/core/TaskService';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { PetStoryProductionService } from '../../main/utils/petstoryProduction';
import { imageTargetBasis } from '../../main/utils/petstoryImageReview';
import { mediaCommand } from '../../main/utils/petstoryMedia';
import { productionCapability } from '../../main/utils/petstoryCapability';

let directory: string; let blue: string; let red: string; let projects: PetStoryProjects;
let p: PetStoryProject; let stored: Task[]; let core: TaskService; let service: PetStoryProductionService;
const create = vi.fn<(params: TaskAddParams, accountId: string) => Task>();
const retry = vi.fn<(id: string) => Task>();
const bindInput = vi.fn<(id: string, runId: string, prompt: string) => Task>();
const operationId = 'TEST-original-image-operation';
function list(): Task[] { return structuredClone(stored); }
async function read(): Promise<PetStoryProject> { p = await projects.read(p.id); return p; }
async function pausedTask(kind: 'firstFrame' | 'video' | 'material', submitted = false, scoped = false): Promise<Task> {
  const shotId = p.plan!.shots[0].id; const materialId = p.materials!.find((item): boolean => item.kind === 'scene')!.id;
  if (kind === 'video') {
    p = await projects.addShotImage(p.id, p.revision, shotId, 'firstFrame', blue);
    p = await projects.adoptImage(p.id, p.revision, { shotId, kind: 'firstFrame' }, p.assets.at(-1)!.id);
  }
  if (kind === 'material') p.materials!.find((item): boolean => item.id === materialId)!.prompt.final = 'TEST独立离线乡村道路空景，保留道路纵深与空间';
  if (kind === 'video') p.plan!.shots[0].prompts.video.final = 'TEST基于本次首帧，画面中的人物缓慢向前走，固定机位，动作连贯。';
  p.promptCapability = productionCapability(p);
  seedOfflinePromptContracts(p, undefined, { completeVideoBody: true });
  const target = kind === 'material' ? { materialId } : { shotId, kind: 'firstFrame' as const };
  if (scoped) {
    p.imageOperations = [{ id: operationId, requestId: 'TEST-original-request', target, mode: 'generate',
      basisHash: imageTargetBasis(p, target), stage: 'generating', createdAt: p.updatedAt }];
  }
  p = await projects.write(p);
  if (kind === 'material') {
    if (scoped) await service.withImageOperation(p.id, operationId, (current): Promise<PetStoryProductionResult> => current.generateMaterials(p.id, p.revision, [materialId], undefined, operationId));
    else await service.generateMaterials(p.id, p.revision, [materialId]);
  } else if (scoped) await service.withImageOperation(p.id, operationId, (current): ReturnType<typeof current.generateShotMedia> => current.generateShotMedia(p.id, p.revision, shotId, kind, undefined, {}, operationId));
  else await service.generateShotMedia(p.id, p.revision, shotId, kind);
  const next = scoped ? await service.withImageOperation(p.id, operationId, (current): ReturnType<typeof current.advance> => current.advance(p.id)) : await service.advance(p.id);
  expect(next).toMatchObject({ success: true, action: 'start' });
  const original = list().find((item): boolean => item.id === next.taskId)!; const now = p.updatedAt;
  expect(core.updateRuntime({ taskId: original.id, status: 'executing', runtime: { runId: 'TEST-original-run', attempt: 1, stage: 'injecting_prompt',
    message: 'TEST准备', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
    input: { prompt: original.prompt, mode: original.mode, attachments: original.attachments || [], videoConfig: original.videoConfig, petstory: original.petstory } } }).success).toBe(true);
  await service.bindRun(p.id, original.id, 'TEST-original-run');
  expect(core.updateRuntime({ taskId: original.id, status: 'paused', runtime: submitted ? { submittedAt: now } : undefined,
    errorInfo: { code: 'cancelled', message: 'TEST用户停止', recoverable: true, detectedAt: now } }).success).toBe(true);
  if (scoped) await service.withImageOperation(p.id, operationId, (current): ReturnType<typeof current.pause> => current.pause(p.id));
  else await service.pause(p.id);
  await read(); create.mockClear(); retry.mockClear(); bindInput.mockClear();
  return list()[0];
}
beforeAll(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-resume-basis-'));
  blue = path.join(directory, 'TEST-blue.png'); red = path.join(directory, 'TEST-red.png');
  await Promise.all([['blue', blue], ['red', red]].map(async ([color, file]): Promise<void> => {
    await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=64x96`, '-frames:v', '1', '-y', file]);
  }));
});
afterAll(async (): Promise<void> => fs.rm(directory, { recursive: true, force: true }));
beforeEach(async (): Promise<void> => {
  projects = new PetStoryProjects(); p = await projects.create(await fs.mkdtemp(path.join(directory, 'project-')), 'TEST-studio', 'TEST-account');
  p = await projects.saveMobileStory(p.id, p.revision, snapshot.mobileStory);
  p.plan = structuredClone(snapshot.plan) as PetStoryPlan; p.plan.shots = p.plan.shots.slice(0, 1); p.plan.props = [];
  p.plan.scenes = [{ id: 'TEST-road', name: '村道', location: '村道', time: '白天', lighting: '自然光', layout: '乡村道路', view: '正面', designOrigin: 'script' }];
  for (const character of p.plan.characters) character.referenceAssetId = undefined;
  p.plan.shots[0].sceneId = 'TEST-road'; p.plan.shots[0].propIds = []; p.plan.shots[0].propStates = []; p.plan.shots[0].requestedMode = 'first_frame';
  p = await projects.write(p); p = await projects.confirmStory(p.id, p.revision);
  for (const material of p.materials!) {
    p = await projects.addMaterialImage(p.id, p.revision, material.id, blue);
    p = await projects.adoptImage(p.id, p.revision, { materialId: material.id }, p.assets.at(-1)!.id);
  }
  stored = []; let sequence = 0;
  core = new TaskService({ store: { read: list, replace: (value: Task[]): boolean => { stored = structuredClone(value); return true; } },
    defaultProjectId: (): string => p.studioProjectId, id: (): string => `TEST-task-${++sequence}` });
  create.mockImplementation((params, accountId): Task => {
    const added = core.create(params); if (!added.success) throw new Error(added.error);
    const assigned = core.assign({ taskId: added.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error); return assigned.data;
  });
  retry.mockImplementation((id): Task => { const result = core.retry(id, 'hold'); if (!result.success) throw new Error(result.error); return result.data; });
  bindInput.mockImplementation((id, runId, prompt): Task => { const result = core.bindPetStoryPageInput(id, runId, prompt); if (!result.success) throw new Error(result.error); return result.data; });
  service = new PetStoryProductionService(projects, { list, create, retryUnsubmitted: retry, bindPageInput: bindInput,
    adopt: (id, binding, prompt): Task => { const result = core.bindPetStory(id, binding, prompt); if (!result.success) throw new Error(result.error); return result.data; },
    downloads: (): [] => [], download: async (): Promise<{ success: boolean; count: number; failed: number }> => ({ success: false, count: 0, failed: 0 }) });
});

describe('停止后明确恢复的原依据边界', (): void => {
  it('只上传未采用候选后，已提交基础图沿用原run只读观察并保留迟到产物', async (): Promise<void> => {
    const task = await pausedTask('material', true, true); const materialId = p.imageOperations![0].target.materialId!;
    const basis = p.imageOperations![0].basisHash;
    p = await projects.addMaterialImage(p.id, p.revision, materialId, red);
    expect(p.assets.at(-1)?.imageReview?.state).toBe('candidate'); expect(imageTargetBasis(p, { materialId })).toBe(basis);
    const before = list();
    await service.withImageOperation(p.id, operationId, (current): ReturnType<typeof current.resume> => current.resume(p.id));
    const observed = await service.withImageOperation(p.id, operationId, (current): ReturnType<typeof current.advance> => current.advance(p.id));
    expect(observed).toMatchObject({ success: true, action: 'observe', taskId: task.id }); expect(list()).toEqual(before);
    expect(core.updateStatus({ taskId: task.id, status: 'done', outputs: ['https://TEST.invalid/late-original.png'] }).success).toBe(true);
    await service.withImageOperation(p.id, operationId, (current): ReturnType<typeof current.resume> => current.resume(p.id));
    expect(list()[0]).toMatchObject({ id: task.id, outputs: ['https://TEST.invalid/late-original.png'], runtime: { runId: task.runtime!.runId, submittedAt: task.runtime!.submittedAt, input: task.runtime!.input } });
    expect(retry).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(bindInput).not.toHaveBeenCalled();
  });
  it.each([false, true])('采用实际素材引用后拒绝旧%s授权，原任务及step完整保留', async (scoped): Promise<void> => {
    await pausedTask('firstFrame', false, scoped);
    const materialId = p.materials!.find((item): boolean => item.kind === 'scene')!.id;
    p = await projects.addMaterialImage(p.id, p.revision, materialId, red);
    p = await projects.adoptImage(p.id, p.revision, { materialId }, p.assets.at(-1)!.id);
    const before = structuredClone(p); const original = list();
    const resume = scoped ? service.withImageOperation(p.id, operationId, (current): ReturnType<typeof current.resume> => current.resume(p.id)) : service.resume(p.id);
    await expect(resume).rejects.toThrow(/依据|素材|确认/);
    expect(await projects.read(p.id)).toEqual(before); expect(list()).toEqual(original);
    expect(retry).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(bindInput).not.toHaveBeenCalled();
  });
  it('视频明确采用新首帧后，在清原run或重置页面输入之前拒绝旧编译引用', async (): Promise<void> => {
    await pausedTask('video'); const shotId = p.plan!.shots[0].id;
    p = await projects.addShotImage(p.id, p.revision, shotId, 'firstFrame', red);
    p = await projects.adoptImage(p.id, p.revision, { shotId, kind: 'firstFrame' }, p.assets.at(-1)!.id);
    const before = structuredClone(p); const original = list();
    await expect(service.resume(p.id)).rejects.toThrow(/素材|引用|编译|快照/);
    expect(await projects.read(p.id)).toEqual(before); expect(list()).toEqual(original);
    expect(retry).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(bindInput).not.toHaveBeenCalled();
  });
});
