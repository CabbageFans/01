/** 原五镜头派生的离线合同回归；TEST回复和本地色块仅模拟技术状态，不代表豆包业务产出。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PetStoryCapability, PetStoryChatJob, PetStoryPlan, PetStoryProject, Task, TaskAddParams, TaskRunSnapshot } from '@doubao-studio/contracts';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { TaskService } from '../../main/core/TaskService';
import { PetStoryChatService } from '../../main/utils/petstoryChat';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { syncMaterials } from '../../main/utils/petstoryMaterials';
import { mediaCommand } from '../../main/utils/petstoryMedia';
import { inspectPromptCandidate, inspectPromptEligibility, promptWritingTarget } from '../../main/utils/petstoryEligibility';
import { PetStoryProductionService } from '../../main/utils/petstoryProduction';
import { requiredMaterialKeys } from '../../main/utils/petstoryMaterials';
import { buildPetStoryPromptExport } from '../../main/utils/petstoryExport';

let directory: string; let projects: PetStoryProjects; let p: PetStoryProject; let chat: PetStoryChatService; let core: TaskService; let stored: Task[];
function capability(): PetStoryCapability {
  const entry = { state: 'supported' as const, free: 'free' as const, reason: 'TEST离线状态' };
  return { accountId: p.accountId, checkedAt: '2026-10-26T00:00:00.000Z', freeEvidence: 'user_confirmed', durations: [5, 6, 7, 8], image: entry,
    modes: { first_frame: entry, first_last_frame: entry, reference: entry }, videoConfig: { model: 'seedance-2.0', duration: '6s', aspectRatio: '9:16' } };
}
beforeEach(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-candidate-adaptation-')); projects = new PetStoryProjects();
  p = await projects.create(directory, 'TEST-studio', 'TEST-account'); p = await projects.saveMobileStory(p.id, p.revision, snapshot.mobileStory);
  p.plan = structuredClone(snapshot.plan) as PetStoryPlan; p.plan.props = []; p.plan.scenes = [{ id: 'road', name: '村道', location: p.plan.shots[0].scene, time: '未指定', lighting: '原方案自然光', layout: '原故事村道', view: '原方案视角', designOrigin: 'script' }];
  for (const character of p.plan.characters) character.referenceAssetId = undefined;
  for (const shot of p.plan.shots) { shot.sceneId = 'road'; shot.propIds = []; shot.propStates = []; }
  p.plan.shots[0].prompts.firstFrame.edited = true; p.materials = syncMaterials(p); p.promptModel = 'seedance-2.0'; p.promptCapability = capability(); p.source.status = 'review_required'; p = await projects.write(p); p = await projects.confirmStory(p.id, p.revision);
  stored = []; let sequence = 0;
  core = new TaskService({ store: { read: (): Task[] => structuredClone(stored), replace: (tasks: Task[]): boolean => { stored = structuredClone(tasks); return true; } }, defaultProjectId: (): string => p.studioProjectId, id: (): string => `TEST-candidate-task-${++sequence}` });
  chat = new PetStoryChatService(projects, { list: (): Task[] => structuredClone(stored), create: (params: TaskAddParams, accountId: string): Task => {
    const created = core.create(params); if (!created.success) throw new Error(created.error);
    const assigned = core.assign({ taskId: created.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error); return assigned.data;
  } });
});
afterEach(async (): Promise<void> => fs.rm(directory, { recursive: true, force: true }));
async function prepare(kind: 'firstFrame' | 'video' = 'firstFrame', shotIndex = 0): Promise<PetStoryChatJob> {
  p = (await chat.prepareRuntime(p.id, p.revision, 'optimize', { shotId: p.plan!.shots[shotIndex].id, promptKind: kind })).project!;
  return p.jobs.at(-1)!;
}
function body(job: PetStoryChatJob): string {
  const shot = p.plan!.shots.find((item): boolean => item.id === job.shotId)!;
  return `TEST离线技术响应：${job.promptTask!.references.map((ref): string => `第${ref.order}张参考图`).join('，')}。${shot.startState}`;
}
async function record(job: PetStoryChatJob, optimized: string = body(job)): Promise<string> {
  const raw = JSON.stringify({ TEST: '离线模拟', requestId: job.requestId, targetIds: job.expectedIds, optimized }); const task = stored.find((item): boolean => item.id === job.taskId)!;
  const at = '2026-10-26T01:00:00.000Z';
  const runtime: TaskRunSnapshot = { runId: `TEST-run-${job.id}`, attempt: 1, stage: 'completed', message: 'TEST离线结果', startedAt: at, stageStartedAt: at, lastHeartbeatAt: at, submittedAt: at,
    input: { mode: 'chat', prompt: task.prompt, attachments: task.attachments || [] }, chatResponse: { text: raw, capturedAt: at } };
  const updated = core.updateRuntime({ taskId: task.id, status: 'done', runtime }); if (!updated.success) throw new Error(updated.error);
  p = (await chat.bindRun(p.id, job.id, runtime.runId)).project!; return raw;
}
async function collectCandidate(job: PetStoryChatJob): Promise<void> {
  await record(job); const result = await chat.collect(p.id, job.id); expect(result.success, result.error).toBe(true); p = result.project!;
  expect(p.jobs.find((item): boolean => item.id === job.id)?.resultStatus).toBe('candidate');
}
async function importConfirmedImage(color: string = 'red', materialId: string = p.materials!.find((item): boolean => item.kind === 'character')!.id): Promise<void> {
  const filename = path.join(directory, `TEST-${color}.png`);
  await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=64x96`, '-frames:v', '1', '-y', filename]);
  p = await projects.addMaterialImage(p.id, p.revision, materialId, filename);
  p = await projects.approveMaterials(p.id, p.revision, [{ materialId, assetId: p.assets.at(-1)!.id }]);
}
function productionService(): PetStoryProductionService {
  return new PetStoryProductionService(projects, { list: (): Task[] => structuredClone(stored), create: (params: TaskAddParams, accountId: string): Task => {
    const created = core.create(params); if (!created.success) throw new Error(created.error);
    const assigned = core.assign({ taskId: created.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error); return assigned.data;
  }, adopt: (): never => { throw new Error('TEST不应采用旧草稿'); }, retryUnsubmitted: (): never => { throw new Error('TEST不应自动重试'); }, downloads: (): [] => [], download: async (): Promise<never> => { throw new Error('TEST不应下载媒体'); } });
}

describe('专用候选按当前创作事实收取及采用', (): void => {
  it('计划占位正常导入并确认真实图片后仍可收取和采用，保留原回复及手改直到明确采用', async (): Promise<void> => {
    const original = p.plan!.shots[0].prompts.firstFrame.final; const job = await prepare(); const raw = await record(job);
    await importConfirmedImage(); const result = await chat.collect(p.id, job.id); expect(result.success, result.error).toBe(true); p = result.project!;
    expect(p.jobs.find((item): boolean => item.id === job.id)).toMatchObject({ rawText: raw, resultStatus: 'candidate', status: 'applied' });
    expect(p.plan!.shots[0].prompts.firstFrame.final).toBe(original); expect(inspectPromptCandidate(p, p.jobs.at(-1)!).writingReady).toBe(true);
    p = (await chat.adoptPromptCandidate(p.id, p.revision, job.id)).project!;
    expect(p.plan!.shots[0].prompts.firstFrame).toMatchObject({ final: body(job), sourceJobId: job.id, edited: false });
    expect(inspectPromptEligibility(p, p.plan!.shots[0].prompts.firstFrame, promptWritingTarget(p, job)).writingReady).toBe(true);
    expect((await new PetStoryProjects().open(directory)).plan!.shots[0].prompts.firstFrame).toEqual(p.plan!.shots[0].prompts.firstFrame); expect(stored).toHaveLength(1);
  });
  it('候选已收取后计划落地图及同模型重新核对不会采用死锁，也不触发任何额外任务', async (): Promise<void> => {
    const job = await prepare(); await collectCandidate(job); await importConfirmedImage();
    p.promptCapability!.checkedAt = '2026-10-26T02:00:00.000Z'; p = await projects.write(p);
    p = (await chat.adoptPromptCandidate(p.id, p.revision, job.id)).project!;
    expect(p.jobs.at(-1)!.resultStatus).toBe('adopted'); expect(p.plan!.shots[0].prompts.firstFrame.final).toBe(body(job)); expect(stored).toHaveLength(1);
  });
  it.each(['design', 'replacement'] as const)('真正%s变化仍拒绝旧候选，不能仅凭designHash相同或source标签采用', async (variant): Promise<void> => {
    if (variant === 'replacement') await importConfirmedImage();
    const job = await prepare(); await collectCandidate(job);
    if (variant === 'replacement') await importConfirmedImage('blue'); else { p.plan!.shots[0].startState += '\nTEST用户改变起点'; p = await projects.write(p); }
    const before = structuredClone(p); await expect(chat.adoptPromptCandidate(p.id, p.revision, job.id)).rejects.toThrow('当前候选需按当前事实修订');
    expect(await projects.read(p.id)).toEqual(before); expect(stored).toHaveLength(1);
  });
  it('坏正文在同素材确认后仍进入一次修订资格，不误标过期来绕过内容问题', async (): Promise<void> => {
    const job = await prepare(); await record(job, 'TEST离线错误正文：@图片999'); await importConfirmedImage();
    const result = await chat.collect(p.id, job.id); expect(result.success).toBe(false); expect(result.needsRepair).toBe(true);
    const saved = result.project!.jobs.at(-1)!; expect(saved.status).toBe('invalid'); expect(saved.resultStatus).toBe('candidate'); expect(saved.rawText).toContain('@图片999'); expect(stored).toHaveLength(1);
  });
  it('旧合同继续使用原contextHash检查，不能借缺失designHash放过过期候选', async (): Promise<void> => {
    const job = await prepare(); await collectCandidate(job); delete p.jobs.at(-1)!.promptTask!.designHash;
    p.promptCapability!.checkedAt = '2026-10-26T02:00:00.000Z'; p = await projects.write(p);
    await expect(chat.adoptPromptCandidate(p.id, p.revision, job.id)).rejects.toThrow('当前事实已变化'); expect(stored).toHaveLength(1);
  });
  it('同目标新请求和已采用边界变更仍保护旧候选，候选不自动覆盖final', async (): Promise<void> => {
    const job = await prepare(); await collectCandidate(job); await prepare();
    await expect(chat.adoptPromptCandidate(p.id, p.revision, job.id)).rejects.toThrow('更新请求'); expect(stored).toHaveLength(2);
  });
});

describe('媒体确认遵守本批实际镜头素材范围', (): void => {
  it.each(['missing', 'expired'] as const)('剧本确认%s时基础正文写完但导出等待确认，正常确认后可创建首张基础图hold而不要求自身图已接受', async (approval): Promise<void> => {
    const material = p.materials!.find((item): boolean => item.kind === 'scene')!;
    p.storyApproval = approval === 'missing' ? undefined : { hash: '0'.repeat(64), at: p.updatedAt }; p = await projects.write(p);
    p = (await chat.prepareRuntime(p.id, p.revision, 'materialPrompt', { materialId: material.id })).project!;
    const job = p.jobs.at(-1)!; const optimized = `TEST离线基础素材正文：${p.plan!.scenes!.find((item): boolean => item.id === material.entityId)!.location}`;
    await record(job, optimized); const collected = await chat.collect(p.id, job.id); expect(collected.success, collected.error).toBe(true); p = collected.project!;
    expect(p.jobs.at(-1)?.resultStatus).toBe('candidate');
    p = (await chat.adoptPromptCandidate(p.id, p.revision, job.id)).project!;
    const current = p.materials!.find((item): boolean => item.id === material.id)!; const target = { materialId: material.id };
    expect(inspectPromptEligibility(p, current.prompt, target)).toMatchObject({ state: 'adopted_unbound', writingReady: true });
    const before = structuredClone(p); const entry = buildPetStoryPromptExport(p, []).prompts.find((item): boolean => item.id === material.id)!;
    expect(entry).toMatchObject({ final: optimized, modelPrompt: optimized, review: { eligibility: 'adopted_unbound', submissionBlocked: true } });
    expect(entry.review.warnings.join('；')).toContain('当前剧本尚未确认或确认已过期'); expect(p).toEqual(before);
    const service = productionService(); const c = { ...capability(), checkedAt: new Date().toISOString() };
    await expect(service.generateMaterials(p.id, p.revision, [material.id], c)).rejects.toThrow('确认当前剧本'); expect(stored).toHaveLength(1);
    p = await projects.confirmStory(p.id, p.revision);
    expect(p.materials!.find((item): boolean => item.id === material.id)?.approved).toBeUndefined();
    expect(inspectPromptEligibility(p, p.materials!.find((item): boolean => item.id === material.id)!.prompt, target)).toMatchObject({ state: 'submittable', writingReady: true });
    expect(buildPetStoryPromptExport(p, []).prompts.find((item): boolean => item.id === material.id)!.review).toMatchObject({ eligibility: 'submittable', submissionBlocked: false });
    p = (await service.generateMaterials(p.id, p.revision, [material.id], c)).project!;
    const next = await service.advance(p.id); expect(next.action).toBe('start'); expect(stored).toHaveLength(2); expect(stored.at(-1)).toMatchObject({ mode: 'image', executionIntent: 'hold', status: 'queued' });
  });
  async function adoptedWithRelevantImages(): Promise<void> {
    const job = await prepare(); await collectCandidate(job);
    for (const materialId of requiredMaterialKeys(p.plan!, [p.plan!.shots[0].id])) await importConfirmedImage('red', materialId);
    p = (await chat.adoptPromptCandidate(p.id, p.revision, job.id)).project!;
  }
  it('其他镜头角色未确认时本镜可正式创建hold并通过实际guard，整批仍要求它用到的角色图', async (): Promise<void> => {
    await adoptedWithRelevantImages(); const service = productionService(); const c = { ...capability(), checkedAt: new Date().toISOString() };
    const unconfirmed = p.materials!.filter((item): boolean => !item.approved); expect(unconfirmed.map((item): string => item.id)).toContain('character:friend');
    await expect(service.approve(p.id, p.revision, c, {})).rejects.toThrow('缺少对应实际基础图'); expect(stored).toHaveLength(1);
    p = (await service.generateShotMedia(p.id, p.revision, p.plan!.shots[0].id, 'firstFrame', c, {})).project!;
    const next = await service.advance(p.id); expect(next.action).toBe('start'); expect(stored).toHaveLength(2);
    expect((await service.guard(next.taskId!, false)).success).toBe(true); expect(stored.at(-1)).toMatchObject({ mode: 'image', executionIntent: 'hold', status: 'queued' });
  });
  it('本镜实际用到的角色未确认仍阻断，不因无关依赖已放开而绕过真实素材确认', async (): Promise<void> => {
    await adoptedWithRelevantImages(); const material = p.materials!.find((item): boolean => item.id === 'character:lulu')!; material.approved = undefined; p = await projects.write(p);
    await expect(productionService().generateShotMedia(p.id, p.revision, p.plan!.shots[0].id, 'firstFrame', { ...capability(), checkedAt: new Date().toISOString() }, {})).rejects.toThrow('当前图片尚未确认'); expect(stored).toHaveLength(1);
  });
});
