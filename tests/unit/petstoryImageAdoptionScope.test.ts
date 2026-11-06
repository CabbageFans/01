/** 离线使用真实项目文件与采用入口复现：暂停的无关图片流程不得锁住当前候选。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PetStoryImageOperation, PetStoryPlan, PetStoryProduction, PetStoryProject, PetStoryPrompt } from '@doubao-studio/contracts';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { mediaCommand } from '../../main/utils/petstoryMedia';
import { imageOperationBlocksTargets, imageOperationHasPendingWork } from '../../main/utils/petstoryImageLifecycle';

let root: string; let picture: string;
const now = '2026-11-06T04:00:00.000Z';
const hash = 'a'.repeat(64);
const storages = ['independent', 'legacy'] as const;
type ImageProductionStorage = typeof storages[number];
function prompt(): PetStoryPrompt { return { original: '', optimized: '', final: 'TEST离线正文', edited: true, rulesVersion: 'TEST' }; }
function plan(): PetStoryPlan {
  return { sourceSummary: 'TEST', adaptedStory: 'TEST', characters: [{ id: 'actor', name: '测试角色', role: 'main', purpose: 'TEST', description: 'TEST形象' }],
    props: [{ id: 'box', name: '测试盒', description: 'TEST道具', aliases: [], keyStates: '闭合', scale: '手持', designOrigin: 'script' }],
    scenes: [{ id: 'room', name: '测试房间', location: '室内', time: '白天', lighting: '自然光', layout: '窗在左', view: '正面', designOrigin: 'script' }],
    shots: [{ id: 'shot-1', order: 1, characterIds: ['actor'], propIds: ['box'], propStates: [{ propId: 'box', holderId: 'actor', state: '手持闭合盒子' }], sceneId: 'room', scene: '室内',
      action: '放下盒子', startState: '拿盒子', endState: '盒子落桌', durationSeconds: 5, transition: 'cut', requestedMode: 'first_last_frame',
      prompts: { firstFrame: prompt(), lastFrame: prompt(), video: prompt() } }] };
}
async function fixture(): Promise<{ projects: PetStoryProjects; project: PetStoryProject; candidateId: string }> {
  const projects = new PetStoryProjects(); const directory = await fs.mkdtemp(path.join(root, 'project-'));
  let project = await projects.create(directory, 'TEST-studio', 'TEST-account');
  project = await projects.saveOriginalStory(project.id, project.revision, 'TEST原文'); project.plan = plan(); project = await projects.write(project);
  project = await projects.confirmStory(project.id, project.revision);
  project = await projects.addMaterialImage(project.id, project.revision, 'character:actor', picture);
  return { projects, project, candidateId: project.assets.at(-1)!.id };
}
function pausedOperation(materialId: string, status: 'bound' | 'complete', attachmentAssetIds: string[] = []): { operation: PetStoryImageOperation; production: PetStoryProduction } {
  const operation: PetStoryImageOperation = { id: 'TEST-paused-operation', requestId: 'TEST-paused-request', mode: 'generate',
    target: { materialId }, stage: status === 'complete' ? 'complete' : 'generating', basisHash: hash, createdAt: now, taskId: 'TEST-original-task' };
  const entry = { state: 'supported' as const, reason: 'TEST离线能力' };
  const kind = materialId.startsWith('character:') ? 'character' as const : 'prop' as const;
  const production: PetStoryProduction = { phase: 'materials', imageOperationId: operation.id, state: 'paused', planHash: hash, approvedAt: now,
    materialIds: [materialId], capability: { accountId: 'TEST-account', image: entry, durations: [], modes: { first_frame: entry, first_last_frame: entry, reference: entry } },
    fallbacks: {}, shots: {}, message: 'TEST原任务暂停', steps: [{ id: 'TEST-paused-step', kind, materialId, taskId: 'TEST-original-task', runId: 'TEST-original-run',
      status, attachmentAssetIds, inputHash: hash }] };
  return { operation, production };
}
function attach(project: PetStoryProject, operation: PetStoryImageOperation, production: PetStoryProduction, storage: ImageProductionStorage): void {
  project.imageOperations = [operation];
  if (storage === 'independent') { project.imageProductions = { [operation.id]: production }; project.production = undefined; }
  else { project.production = production; project.imageProductions = undefined; }
}
beforeAll(async (): Promise<void> => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-adoption-scope-')); picture = path.join(root, 'candidate.png');
  await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x96', '-frames:v', '1', '-y', picture]);
});
afterAll(async (): Promise<void> => { await fs.rm(root, { recursive: true, force: true }); });

describe('图片采用只保护当前图片与未结束步骤的实际引用', (): void => {
  it.each(storages)('同项目同镜头中的其他基础素材独立暂停，不阻断当前图片采用也不改动原运行（%s）', async (storage): Promise<void> => {
    const test = await fixture(); const paused = pausedOperation('prop:box', 'bound'); attach(test.project, paused.operation, paused.production, storage);
    const saved = await test.projects.write(test.project);
    const adopted = await test.projects.approveMaterials(saved.id, saved.revision, [{ materialId: 'character:actor', assetId: test.candidateId }]);
    expect(adopted.materials!.find((item): boolean => item.id === 'character:actor')?.selectedAssetId).toBe(test.candidateId);
    expect(adopted.imageProductions).toEqual(saved.imageProductions); expect(adopted.production).toEqual(saved.production); expect(adopted.imageOperations).toEqual(saved.imageOperations);
  });

  it.each(storages)('同目标图片步骤已经完成，遗留paused制作标记不应永久阻断明确采用（%s）', async (storage): Promise<void> => {
    const test = await fixture(); const paused = pausedOperation('character:actor', 'complete');
    paused.operation.outputAssetId = test.candidateId; paused.production.steps[0].assetId = test.candidateId;
    attach(test.project, paused.operation, paused.production, storage); const saved = await test.projects.write(test.project);
    const adopted = await test.projects.adoptImage(saved.id, saved.revision, { materialId: 'character:actor' }, test.candidateId);
    expect(adopted.materials!.find((item): boolean => item.id === 'character:actor')?.selectedAssetId).toBe(test.candidateId);
  });

  it.each(storages)('其他暂停制作只有已完成步骤引用当前图片时，不应保留该步骤的输入锁（%s）', async (storage): Promise<void> => {
    const test = await fixture();
    test.project = await test.projects.addMaterialImage(test.project.id, test.project.revision, 'prop:box', picture);
    const completedProp = test.project.assets.at(-1)!;
    expect(completedProp.kind).toBe('prop'); expect(completedProp.materialId).toBe('prop:box');
    const paused = pausedOperation('prop:box', 'bound');
    paused.production.steps.unshift({ ...paused.production.steps[0], id: 'TEST-completed-reference-step', status: 'complete', assetId: completedProp.id, attachmentAssetIds: [test.candidateId] });
    attach(test.project, paused.operation, paused.production, storage); const saved = await test.projects.write(test.project);
    const adopted = await test.projects.adoptImage(saved.id, saved.revision, { materialId: 'character:actor' }, test.candidateId);
    expect(adopted.materials!.find((item): boolean => item.id === 'character:actor')?.selectedAssetId).toBe(test.candidateId);
  });

  it.each(storages.flatMap((storage: ImageProductionStorage): { storage: ImageProductionStorage; variant: 'same-target' | 'actual-reference' }[] =>
    (['same-target', 'actual-reference'] as const).map((variant): { storage: ImageProductionStorage; variant: typeof variant } => ({ storage, variant }))))('正在运行的$variant仍拒绝上传和替换，候选与原制作保持不变（$storage）', async ({ storage, variant }): Promise<void> => {
    const test = await fixture(); const paused = pausedOperation(variant === 'same-target' ? 'character:actor' : 'prop:box', 'bound',
      variant === 'actual-reference' ? [test.candidateId] : []);
    paused.production.state = 'running';
    attach(test.project, paused.operation, paused.production, storage); const saved = await test.projects.write(test.project);
    await expect(test.projects.addMaterialImage(saved.id, saved.revision, 'character:actor', picture)).rejects.toThrow('未结束');
    await expect(test.projects.adoptImage(saved.id, saved.revision, { materialId: 'character:actor' }, test.candidateId)).rejects.toThrow('未结束');
    expect(await test.projects.read(saved.id)).toEqual(saved);
  });

  it.each(storages.flatMap((storage: ImageProductionStorage): { storage: ImageProductionStorage; variant: 'same-target' | 'actual-reference' }[] =>
    (['same-target', 'actual-reference'] as const).map((variant): { storage: ImageProductionStorage; variant: typeof variant } => ({ storage, variant }))))('停止的$variant允许上传、预览和明确采用，原可恢复制作保持不变（$storage）', async ({ storage, variant }): Promise<void> => {
    const test = await fixture(); const paused = pausedOperation(variant === 'same-target' ? 'character:actor' : 'prop:box', 'bound',
      variant === 'actual-reference' ? [test.candidateId] : []);
    paused.operation.stage = 'failed'; paused.operation.error = '本次图片任务已暂停，请继续原任务';
    attach(test.project, paused.operation, paused.production, storage); const saved = await test.projects.write(test.project);
    const uploaded = await test.projects.addMaterialImage(saved.id, saved.revision, 'character:actor', picture);
    const candidate = uploaded.assets.at(-1)!;
    expect(candidate.imageReview?.state).toBe('candidate');
    expect(uploaded.materials!.find((item): boolean => item.id === 'character:actor')?.selectedAssetId).toBeUndefined();
    const previewed = await test.projects.selectMaterialImage(uploaded.id, uploaded.revision, 'character:actor', candidate.id);
    const adopted = await test.projects.adoptImage(previewed.id, previewed.revision, { materialId: 'character:actor' }, candidate.id);
    expect(adopted.materials!.find((item): boolean => item.id === 'character:actor')?.selectedAssetId).toBe(candidate.id);
    expect(adopted.imageProductions).toEqual(saved.imageProductions); expect(adopted.production).toEqual(saved.production); expect(adopted.imageOperations).toEqual(saved.imageOperations);
    expect(adopted.assets.some((asset): boolean => asset.id === test.candidateId)).toBe(true);
  });

  it.each(storages)('已停止的画布图片允许上传和采用，仍保留原任务绑定（%s）', async (storage): Promise<void> => {
    const test = await fixture(); const paused = pausedOperation('character:actor', 'bound');
    paused.operation.stage = 'failed'; paused.operation.target = { shotId: 'shot-1', kind: 'firstFrame' };
    paused.production.phase = 'shots'; paused.production.target = { shotId: 'shot-1', kind: 'firstFrame' };
    paused.production.shots = { 'shot-1': { requestedMode: 'first_last_frame', resolvedMode: 'first_last_frame', reason: 'TEST原模式' } };
    paused.production.steps[0] = { ...paused.production.steps[0], kind: 'firstFrame', materialId: undefined, shotId: 'shot-1' };
    attach(test.project, paused.operation, paused.production, storage); const saved = await test.projects.write(test.project);
    const uploaded = await test.projects.addShotImage(saved.id, saved.revision, 'shot-1', 'firstFrame', picture); const candidate = uploaded.assets.at(-1)!;
    expect(candidate.imageReview?.state).toBe('candidate'); expect(uploaded.adoptedImages?.['shot-1']?.firstFrameId).toBeUndefined();
    const adopted = await test.projects.adoptImage(uploaded.id, uploaded.revision, { shotId: 'shot-1', kind: 'firstFrame' }, candidate.id);
    expect(adopted.adoptedImages?.['shot-1']?.firstFrameId).toBe(candidate.id);
    expect(adopted.imageProductions).toEqual(saved.imageProductions); expect(adopted.imageOperations).toEqual(saved.imageOperations);
  });

  it('本目标已停止但另一运行中的步骤仍实际引用它时，继续保护原输入', async (): Promise<void> => {
    const test = await fixture(); const stopped = pausedOperation('character:actor', 'bound'); stopped.operation.stage = 'failed';
    attach(test.project, stopped.operation, stopped.production, 'independent');
    const dependent = pausedOperation('prop:box', 'bound', [test.candidateId]);
    dependent.operation.id = 'TEST-running-dependent'; dependent.operation.requestId = 'TEST-running-dependent-request';
    dependent.production.imageOperationId = dependent.operation.id; dependent.production.state = 'running';
    test.project.imageOperations!.push(dependent.operation); test.project.imageProductions![dependent.operation.id] = dependent.production;
    const saved = await test.projects.write(test.project);
    await expect(test.projects.addMaterialImage(saved.id, saved.revision, 'character:actor', picture)).rejects.toThrow('实际引用');
    await expect(test.projects.adoptImage(saved.id, saved.revision, { materialId: 'character:actor' }, test.candidateId)).rejects.toThrow('实际引用');
    expect(await test.projects.read(saved.id)).toEqual(saved);
  });

  it('旧全批次制作运行时仍全局保护原输入', async (): Promise<void> => {
    const test = await fixture(); const paused = pausedOperation('prop:box', 'bound');
    delete paused.production.imageOperationId; paused.production.state = 'running'; test.project.production = paused.production;
    const saved = await test.projects.write(test.project);
    await expect(test.projects.addMaterialImage(saved.id, saved.revision, 'character:actor', picture)).rejects.toThrow('未结束');
    await expect(test.projects.adoptImage(saved.id, saved.revision, { materialId: 'character:actor' }, test.candidateId)).rejects.toThrow('未结束');
    expect(await test.projects.read(saved.id)).toEqual(saved);
  });

  it('旧全批次暂停后只释放图片编辑，剧本与正文仍保留原制作锁', async (): Promise<void> => {
    const test = await fixture(); const paused = pausedOperation('prop:box', 'bound');
    delete paused.production.imageOperationId; test.project.production = paused.production;
    const saved = await test.projects.write(test.project);
    await expect(test.projects.confirmStory(saved.id, saved.revision)).rejects.toThrow('未结束');
    await expect(test.projects.saveMaterialPrompt(saved.id, saved.revision, 'character:actor', 'TEST不得改正文')).rejects.toThrow('未结束');
    const uploaded = await test.projects.addMaterialImage(saved.id, saved.revision, 'character:actor', picture); const candidate = uploaded.assets.at(-1)!;
    const previewed = await test.projects.selectMaterialImage(uploaded.id, uploaded.revision, 'character:actor', candidate.id);
    const adopted = await test.projects.approveMaterials(previewed.id, previewed.revision, [{ materialId: 'character:actor', assetId: candidate.id }]);
    expect(adopted.materials!.find((item): boolean => item.id === 'character:actor')?.selectedAssetId).toBe(candidate.id);
    expect(adopted.production).toEqual(saved.production);
  });

  it.each(storages)('独立图片停止后仍禁止改剧本或基础正文（%s）', async (storage): Promise<void> => {
    const test = await fixture(); const paused = pausedOperation('character:actor', 'bound'); paused.operation.stage = 'failed';
    attach(test.project, paused.operation, paused.production, storage); const saved = await test.projects.write(test.project);
    await expect(test.projects.confirmStory(saved.id, saved.revision)).rejects.toThrow('未结束');
    await expect(test.projects.saveMaterialPrompt(saved.id, saved.revision, 'character:actor', 'TEST不得改正文')).rejects.toThrow('未结束');
  });
});

describe('图片操作保护策略不依赖存储位置且不改写历史', (): void => {
  function policyProject(): PetStoryProject {
    return { id: 'TEST-policy-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', schemaVersion: 1, revision: 1,
      source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [], updatedAt: now };
  }

  it.each(storages)('已由后续同目标请求取代的失败操作不阻断，但原记录和制作历史保持不变（%s）', (storage): void => {
    const project = policyProject(); const paused = pausedOperation('character:actor', 'bound'); paused.operation.stage = 'failed';
    attach(project, paused.operation, paused.production, storage);
    project.imageOperations!.push({ ...paused.operation, id: 'TEST-new-operation', requestId: 'TEST-new-request', stage: 'complete' });
    const before = structuredClone(project);
    expect(imageOperationHasPendingWork(project, paused.operation)).toBe(false);
    expect(imageOperationBlocksTargets(project, paused.operation, [{ materialId: 'character:actor' }])).toBe(false);
    expect(project).toEqual(before);
  });

  it.each(storages.flatMap((storage: ImageProductionStorage): { storage: ImageProductionStorage; stage: 'preparing' | 'generating' | 'saving' }[] =>
    (['preparing', 'generating', 'saving'] as const).map((stage): { storage: ImageProductionStorage; stage: typeof stage } => ({ storage, stage }))))('旧操作$stage尚非终态时，即使后有同目标记录仍保护原步骤（$storage）', ({ storage, stage }): void => {
    const project = policyProject(); const paused = pausedOperation('character:actor', 'bound'); paused.operation.stage = stage;
    paused.production.state = 'running';
    attach(project, paused.operation, paused.production, storage);
    project.imageOperations!.push({ ...paused.operation, id: 'TEST-new-operation', requestId: 'TEST-new-request', stage: 'complete' });
    const before = structuredClone(project);
    expect(imageOperationHasPendingWork(project, paused.operation)).toBe(true);
    expect(imageOperationBlocksTargets(project, paused.operation, [{ materialId: 'character:actor' }])).toBe(true);
    expect(project).toEqual(before);
  });

  it.each(storages)('暂停制作仍可恢复但不持有图片编辑锁，非媒体编辑仍受保护（%s）', (storage): void => {
    const project = policyProject(); const paused = pausedOperation('character:actor', 'bound'); paused.operation.stage = 'failed'; paused.production.steps = [];
    attach(project, paused.operation, paused.production, storage);
    expect(imageOperationHasPendingWork(project, paused.operation)).toBe(true);
    expect(imageOperationBlocksTargets(project, paused.operation, [{ materialId: 'character:actor' }])).toBe(false);
    expect(imageOperationBlocksTargets(project, paused.operation)).toBe(true);
  });
});
