/** 原五镜头派生的离线生命周期测试；TEST产物记录不代表真实豆包媒体。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PetStoryCapability, PetStoryPlan, PetStoryProduction, PetStoryProject, Task, TaskAddParams } from '@doubao-studio/contracts';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { PetStoryChatService } from '../../main/utils/petstoryChat';
import { TaskService } from '../../main/core/TaskService';
import { productionPlanHash } from '../../main/utils/petstoryProduction';
import { isCanvasPlanLocked } from '../../src/components/petStoryCanvasShared';
import { seedOfflinePromptContracts } from '../fixtures/petstoryPromptContracts';

let directory: string; let projects: PetStoryProjects; let p: PetStoryProject; let chat: PetStoryChatService; let stored: Task[];
const now = '2026-10-26T00:00:00.000Z';
function production(): PetStoryProduction {
  const entry = { state: 'supported' as const, reason: 'TEST离线记录' };
  const capability: PetStoryCapability = { accountId: p.accountId, checkedAt: now, durations: [5, 6, 7, 8], image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, videoConfig: { model: 'seedance-2.0', duration: '6s', aspectRatio: '9:16' } };
  return { phase: 'shots', state: 'complete', planHash: productionPlanHash(p.plan!), approvedAt: now, capability, fallbacks: {}, message: 'TEST完整批次已完成',
    shots: Object.fromEntries(p.plan!.shots.map((shot): [string, PetStoryProduction['shots'][string]] => [shot.id, { requestedMode: shot.requestedMode, resolvedMode: shot.requestedMode === 'auto' ? 'reference' : shot.requestedMode, reason: 'TEST', ...(shot.id === p.plan!.shots[0].id ? { firstFrameId: 'TEST-frame' } : {}) }])),
    steps: [{ id: 'TEST-completed-step', kind: 'firstFrame', shotId: p.plan!.shots[0].id, taskId: 'TEST-prior-task', runId: 'TEST-prior-run', assetId: 'TEST-frame', status: 'complete', attachmentAssetIds: [], inputHash: 'a'.repeat(64) }] };
}
beforeEach(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-completed-production-')); projects = new PetStoryProjects();
  p = await projects.create(directory, 'TEST-studio', 'TEST-account'); p = await projects.saveMobileStory(p.id, p.revision, snapshot.mobileStory);
  p.plan = structuredClone(snapshot.plan) as PetStoryPlan; for (const character of p.plan.characters) character.referenceAssetId = undefined;
  p.assets = [{ id: 'TEST-frame', kind: 'firstFrame', shotId: p.plan.shots[0].id, taskId: 'TEST-prior-task', runId: 'TEST-prior-run', relativePath: `shots/${p.plan.shots[0].id}/TEST-frame.png` }];
  p.production = production(); p = await projects.write(p);
  stored = []; const core = new TaskService({ store: { read: (): Task[] => structuredClone(stored), replace: (tasks: Task[]): boolean => { stored = structuredClone(tasks); return true; } }, defaultProjectId: (): string => p.studioProjectId, id: (): string => 'TEST-new-chat' });
  chat = new PetStoryChatService(projects, { list: (): Task[] => structuredClone(stored), create: (params: TaskAddParams, accountId: string): Task => {
    const created = core.create(params); if (!created.success) throw new Error(created.error); const assigned = core.assign({ taskId: created.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error); return assigned.data;
  } });
});
afterEach(async (): Promise<void> => fs.rm(directory, { recursive: true, force: true }));

describe('完整P4完成后的明确文字操作', (): void => {
  it('打开与读盘保留原完成批次且不创建任务，画布允许新的明确文字操作', async (): Promise<void> => {
    const before = structuredClone(p); const reopened = await new PetStoryProjects().open(directory);
    expect(reopened).toEqual(before); expect(reopened.productionHistory).toBeUndefined(); expect(isCanvasPlanLocked(reopened)).toBe(false); expect(stored).toEqual([]);
  });
  it('专用Chat只在明确请求时归档原完成批次，保留素材与原任务归属且只创建文字hold', async (): Promise<void> => {
    const before = structuredClone(p); const result = await chat.prepareRuntime(p.id, p.revision, 'optimize', { shotId: p.plan!.shots[0].id, promptKind: 'firstFrame' });
    expect(result.project?.production).toBeUndefined(); expect(result.project?.productionHistory).toEqual([before.production]); expect(result.project?.assets).toEqual(before.assets);
    expect(stored).toHaveLength(1); expect(stored[0]).toMatchObject({ mode: 'chat', executionIntent: 'hold', status: 'queued' });
    const reopened = await new PetStoryProjects().open(directory); expect(reopened.productionHistory).toEqual([before.production]); expect(reopened.assets).toEqual(before.assets);
  });
  it.each(['model', 'profile', 'plan', 'final'] as const)('明确保存%s后归档完整完成批次，历史和媒体不丢失', async (operation): Promise<void> => {
    const before = structuredClone(p);
    if (operation === 'model') p = await projects.savePromptModel(p.id, p.revision, 'seedance-2.5');
    else if (operation === 'profile') p = await projects.savePromptProfile(p.id, p.revision, p.promptProfile!);
    else if (operation === 'plan') p = await projects.savePlan(p.id, p.revision, p.plan!);
    else p = await projects.saveShotPrompt(p.id, p.revision, p.plan!.shots[0].id, 'firstFrame', p.plan!.shots[0].prompts.firstFrame.final);
    expect(p.production).toBeUndefined(); expect(p.productionHistory).toEqual([before.production]); expect(p.assets).toEqual(before.assets); expect(stored).toEqual([]);
  });
  it.each(['running', 'paused', 'unfinished'] as const)('真实%s制作仍保护输入，不归档、不释放或新建Chat', async (variant): Promise<void> => {
    p.production!.state = variant === 'unfinished' ? 'complete' : variant;
    if (variant === 'unfinished') p.production!.steps[0].status = 'bound'; p = await projects.write(p); const before = structuredClone(p);
    expect(isCanvasPlanLocked(p)).toBe(true);
    await expect(chat.prepareRuntime(p.id, p.revision, 'optimize', { shotId: p.plan!.shots[0].id, promptKind: 'firstFrame' })).rejects.toThrow('原制作方案仍在使用');
    await expect(projects.savePromptModel(p.id, p.revision, 'seedance-2.5')).rejects.toThrow('原制作仍在使用');
    expect(await projects.read(p.id)).toEqual(before); expect(stored).toEqual([]);
  });
  it('原账号仍有真实活动任务时即使历史P4已完成也不创建新请求或持久化归档', async (): Promise<void> => {
    stored.push({ id: 'TEST-active', mode: 'chat', projectId: p.studioProjectId, assignedAccountId: p.accountId, status: 'executing', prompt: 'TEST', result: null, outputs: [], createdAt: now, updatedAt: now });
    const before = structuredClone(p); const priorTasks = structuredClone(stored);
    await expect(chat.prepareRuntime(p.id, p.revision, 'optimize', { shotId: p.plan!.shots[0].id, promptKind: 'firstFrame' })).rejects.toThrow('活动任务');
    expect(await projects.read(p.id)).toEqual(before); expect(stored).toEqual(priorTasks);
  });
  it('补齐阶段核对新编辑候选自己的基图合同，保留当前旧手改final和编辑意图', async (): Promise<void> => {
    const character = p.plan!.characters[0]; const materialId = `character:${character.id}`;
    for (const id of ['TEST-old-base', 'TEST-new-base']) p.assets.push({ id, kind: 'character', characterId: character.id, materialId, relativePath: `characters/${id}.png` });
    character.referenceAssetId = 'TEST-new-base';
    const oldIntent = { baseAssetId: 'TEST-old-base', changes: 'TEST旧变化', preserve: 'TEST旧保持', validity: 'TEST旧范围' };
    const newIntent = { baseAssetId: 'TEST-new-base', changes: 'TEST新变化', preserve: 'TEST新保持', validity: 'TEST新范围' };
    p.materials = [{ id: materialId, entityId: character.id, kind: 'character', name: character.name, designHash: 'a'.repeat(64), selectedAssetId: 'TEST-new-base', prompt: {
      original: 'TEST离线旧编辑正文', optimized: 'TEST离线旧编辑正文', final: 'TEST离线旧编辑正文', edited: true, needsReview: true, rulesVersion: 'TEST', editIntent: oldIntent,
    } }];
    seedOfflinePromptContracts(p, { materialId });
    const candidateProject = structuredClone(p); const candidatePrompt = candidateProject.materials![0].prompt;
    candidatePrompt.final = 'TEST离线新编辑候选'; candidatePrompt.optimized = candidatePrompt.final; candidatePrompt.edited = false; candidatePrompt.editIntent = newIntent;
    seedOfflinePromptContracts(candidateProject, { materialId });
    const candidate = candidateProject.jobs.at(-1)!; candidate.resultStatus = 'candidate'; p.jobs.push(candidate);
    p.materials[0].prompt.candidateJobId = candidate.id; p.materials[0].prompt.optimized = candidatePrompt.final; p = await projects.write(p);
    const before = structuredClone(p); const result = await chat.promptStageTargets(p.id, p.revision);
    expect(result.pendingCandidateJobIds).toContain(candidate.id); expect(result.promptTargets?.some((target): boolean => target.materialId === materialId)).toBe(false);
    expect(await projects.read(p.id)).toEqual(before); expect(p.materials![0].prompt).toMatchObject({ final: 'TEST离线旧编辑正文', edited: true, editIntent: oldIntent }); expect(stored).toEqual([]);
  });
});
