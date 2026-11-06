/** 旧项目兼容与原制作快照的离线回归；不连接平台、不创建生成任务。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PetStoryAsset, PetStoryCapability, PetStoryPlan, PetStoryProduction, PetStoryProject, PetStoryPrompt } from '@doubao-studio/contracts';
import { PetStoryProjects, validateProject } from '../../main/utils/petstoryProject';
import { imageTargetBasis } from '../../main/utils/petstoryImageReview';
import { promptDesignHash } from '../../main/utils/petstoryEligibility';
import { productionPlanHash } from '../../main/utils/petstoryProduction';

const now = '2026-11-06T00:00:00.000Z';
let directory: string;
let projects: PetStoryProjects;
let original: PetStoryProject;

function prompt(final: string): PetStoryPrompt {
  return { original: final, optimized: final, final, edited: true, rulesVersion: 'TEST-historical' };
}
function legacyPlan(): PetStoryPlan {
  return { sourceSummary: 'TEST旧方案', adaptedStory: 'TEST人物放下盒子',
    characters: [{ id: 'actor', name: '测试角色', role: 'main', purpose: '放置盒子', description: 'TEST仅保留来源记录' }],
    shots: [{ id: 'shot-1', order: 1, characterIds: ['actor'], scene: '测试室内',
      action: '人物将手中盒子放在桌面并松手', startState: '人物双手持盒，盒子离开桌面', endState: '盒子落在桌面，人物双手松开',
      durationSeconds: 5, transition: 'cut', requestedMode: 'auto',
      prompts: { firstFrame: prompt('TEST原首帧正文'), video: prompt('TEST原视频正文') } }] };
}
function capability(): PetStoryCapability {
  const entry = { state: 'unknown' as const, reason: 'TEST未读取页面' };
  return { accountId: original.accountId, image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [] };
}
function production(state: PetStoryProduction['state']): PetStoryProduction {
  return { phase: 'shots', state, planHash: productionPlanHash(original.plan!), approvedAt: now, capability: capability(), fallbacks: {},
    shots: { 'shot-1': { requestedMode: 'auto', resolvedMode: 'reference', reason: 'TEST旧运行真实模式', firstFrameId: 'TEST-first' } },
    steps: [{ id: 'TEST-video-step', kind: 'video', shotId: 'shot-1', taskId: 'TEST-existing-task', runId: 'TEST-existing-run', inputHash: 'c'.repeat(64), attachmentAssetIds: ['TEST-first'], status: 'bound' }],
    message: 'TEST保留原任务与运行，不创建新任务' };
}
function evidence(project: PetStoryProject): object {
  return { assets: project.assets, jobs: project.jobs, adoptedImages: project.adoptedImages,
    productionHistory: project.productionHistory, imageOperations: project.imageOperations, imageProductions: project.imageProductions };
}
async function saveLegacyFixture(project: PetStoryProject): Promise<string> {
  // 只向本测试独占的临时目录写旧版清单，不能借新写入服务提前迁移它。
  const checked = validateProject(project, true);
  const text = JSON.stringify(checked, null, 2);
  await fs.writeFile(path.join(directory, 'project.json'), text);
  return text;
}

beforeEach(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-auto-mode-preservation-'));
  projects = new PetStoryProjects(); original = await projects.create(directory, 'TEST-studio', 'TEST-auto-account');
  original.plan = legacyPlan();
  const target = { shotId: 'shot-1', kind: 'firstFrame' as const };
  const first: PetStoryAsset = { id: 'TEST-first', kind: 'firstFrame', shotId: 'shot-1', relativePath: 'shots/shot-1/first.png',
    generationFinal: 'TEST原首帧正文', validation: { decoded: true, sha256: 'a'.repeat(64), bytes: 4, width: 64, height: 64, checkedAt: now },
    imageReview: { state: 'adopted', target, basisHash: imageTargetBasis(original, target), adoptedAt: now, sha256: 'a'.repeat(64) } };
  const tailTarget = { shotId: 'shot-1', kind: 'lastFrame' as const };
  const tail: PetStoryAsset = { id: 'TEST-tail-history', kind: 'plannedEndImage', shotId: 'shot-1', relativePath: 'shots/shot-1/tail.png',
    validation: { decoded: true, sha256: 'b'.repeat(64), bytes: 4, width: 64, height: 64, checkedAt: now },
    imageReview: { state: 'adopted', target: tailTarget, basisHash: imageTargetBasis(original, tailTarget), adoptedAt: now, sha256: 'b'.repeat(64) } };
  original.assets = [first, tail];
  original.adoptedImages = { 'shot-1': { firstFrameId: first.id, plannedEndImageId: tail.id } };
  original.jobs = [{ id: 'TEST-historical-analysis', taskId: 'TEST-historical-task', kind: 'analysis', status: 'applied', inputHash: 'd'.repeat(64), sourceUrl: '',
    rawText: 'TEST原回复完整留存', resultStatus: 'adopted', parsedResult: { plan: structuredClone(original.plan) } }];
  original.productionHistory = [{ ...production('complete'), steps: [], message: 'TEST原图片制作留下的多参考历史' }];
  await fs.mkdir(path.join(directory, 'shots', 'shot-1'), { recursive: true });
  await fs.writeFile(path.join(directory, first.relativePath), 'TEST');
  await fs.writeFile(path.join(directory, tail.relativePath), 'TEST');
  original = validateProject(original, true);
  await saveLegacyFixture(original);
});
afterEach(async (): Promise<void> => { await fs.rm(directory, { recursive: true, force: true }); });

describe('自动模式补齐只作用于当前可编辑方案', (): void => {
  it('读盘和重开补必要尾帧目标，保留旧图片、采用决定和全部历史且不写盘', async (): Promise<void> => {
    const beforeFile = await fs.readFile(path.join(directory, 'project.json'), 'utf8');
    const loaded = await projects.read(original.id);
    const reopened = await new PetStoryProjects().open(directory);
    for (const project of [loaded, reopened]) {
      expect(project.plan!.shots[0].autoModePlan?.mode).toBe('first_last_frame');
      expect(project.plan!.shots[0].prompts.lastFrame).toMatchObject({ final: '', original: '', optimized: '', edited: false });
      expect(project.plan!.shots[0].prompts.firstFrame).toEqual(original.plan!.shots[0].prompts.firstFrame);
      expect(project.plan!.shots[0].prompts.video).toEqual(original.plan!.shots[0].prompts.video);
      expect(project.revision).toBe(original.revision);
      expect(evidence(project)).toEqual(evidence(original));
      expect(project.jobs[0].parsedResult?.plan?.shots[0].prompts.lastFrame).toBeUndefined();
      expect(project.jobs[0].parsedResult?.plan?.shots[0].autoModePlan).toBeUndefined();
      expect(project.production).toBeUndefined();
    }
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(beforeFile);
    for (const asset of original.assets) expect(await fs.readFile(path.join(directory, asset.relativePath), 'utf8')).toBe('TEST');
  });

  it('正常保存后仅保留新目标与判断，不新增任务、图片操作或改写历史候选', async (): Promise<void> => {
    const loaded = await projects.read(original.id);
    const saved = await projects.write(loaded);
    const reopened = await new PetStoryProjects().open(directory);
    expect(saved.revision).toBe(original.revision + 1);
    expect(reopened.plan!.shots[0].autoModePlan?.mode).toBe('first_last_frame');
    expect(reopened.plan!.shots[0].prompts.lastFrame?.final).toBe('');
    expect(evidence(saved)).toEqual(evidence(original));
    expect(evidence(reopened)).toEqual(evidence(original));
    expect(reopened.jobs).toHaveLength(1);
    expect(reopened.imageOperations).toBeUndefined();
    expect(reopened.imageProductions).toBeUndefined();
    expect(reopened.production).toBeUndefined();
  });

  it('高级保存的自动判断省略尾帧字段时，保留旧尾帧正文和已采用图片', async (): Promise<void> => {
    original.plan!.shots[0].prompts.lastFrame = prompt('TEST旧尾帧手改全文');
    await saveLegacyFixture(original);
    const loaded = await projects.read(original.id);
    const beforeTail = structuredClone(loaded.plan!.shots[0].prompts.lastFrame);
    const incoming = structuredClone(loaded.plan!);
    incoming.shots[0].autoModePlan = { mode: 'first_frame', reason: 'TEST新自动判断不再要求精确终点，但旧尾帧仍作为历史成果保留' };
    delete incoming.shots[0].prompts.lastFrame;
    const saved = await projects.savePlan(loaded.id, loaded.revision, incoming);
    const reopened = await new PetStoryProjects().open(directory);
    for (const project of [saved, reopened]) {
      expect(project.plan!.shots[0].autoModePlan?.mode).toBe('first_frame');
      expect(project.plan!.shots[0].prompts.lastFrame).toEqual(beforeTail);
      expect(project.adoptedImages?.['shot-1'].plannedEndImageId).toBe('TEST-tail-history');
      expect(evidence(project)).toEqual(evidence(original));
      expect(project.production).toBeUndefined();
    }
    expect(await fs.readFile(path.join(directory, 'shots/shot-1/tail.png'), 'utf8')).toBe('TEST');
  });

  it('手改剧情终态后不沿用原首帧判断，重算必要尾帧但保留图片与历史', async (): Promise<void> => {
    const shot = original.plan!.shots[0];
    shot.action = '人物抱着盒子持续站立'; shot.startState = '人物抱着盒子站立'; shot.endState = shot.startState;
    shot.autoModePlan = { mode: 'first_frame', reason: 'TEST持续姿态没有需要锁定的不同终点' };
    // 本例没有当前采用尾图；旧尾图资产仍留在历史，不能遮住剧情变更的重算验证。
    delete original.adoptedImages!['shot-1'].plannedEndImageId;
    await saveLegacyFixture(original);
    const loaded = await projects.read(original.id);
    expect(loaded.plan!.shots[0].prompts.lastFrame).toBeUndefined();
    const incoming = structuredClone(loaded.plan!);
    incoming.shots[0].endState = '盒子已放到桌面，人物双手完全松开';
    const saved = await projects.savePlan(loaded.id, loaded.revision, incoming);
    expect(saved.plan!.shots[0].autoModePlan?.mode).toBe('first_last_frame');
    expect(saved.plan!.shots[0].autoModePlan?.reason).not.toBe(shot.autoModePlan.reason);
    expect(saved.plan!.shots[0].prompts.lastFrame).toMatchObject({ final: '', edited: false });
    expect(saved.plan!.shots[0].prompts.firstFrame).toEqual(original.plan!.shots[0].prompts.firstFrame);
    expect(evidence(saved)).toEqual(evidence(original));
    expect(saved.production).toBeUndefined();
  });

  it('补判断元数据或修改说明不使原图片及正文设计依据失效', (): void => {
    const firstTarget = { shotId: 'shot-1', kind: 'firstFrame' as const };
    const videoTarget = { shotId: 'shot-1', promptKind: 'video' as const };
    const beforeImage = imageTargetBasis(original, firstTarget);
    const beforePrompt = promptDesignHash(original, videoTarget);
    original.plan!.shots[0].autoModePlan = { mode: 'first_last_frame', reason: 'TEST根据盒子落桌的明确终态保留尾帧' };
    expect(imageTargetBasis(original, firstTarget)).toBe(beforeImage);
    expect(promptDesignHash(original, videoTarget)).toBe(beforePrompt);
    original.plan!.shots[0].autoModePlan.reason = 'TEST同一判断的说明更新';
    expect(imageTargetBasis(original, firstTarget)).toBe(beforeImage);
    expect(promptDesignHash(original, videoTarget)).toBe(beforePrompt);
  });

  it.each(['running', 'paused'] as const)('原%s视频制作保留模式、任务和计划摘要，重开不迁移在途快照', async (state: 'running' | 'paused'): Promise<void> => {
    original.production = production(state);
    const beforeFile = await saveLegacyFixture(original);
    const before = validateProject(JSON.parse(beforeFile) as unknown, true);
    const loaded = await projects.read(original.id);
    const reopened = await new PetStoryProjects().open(directory);
    for (const project of [loaded, reopened]) {
      expect(project.plan).toEqual(before.plan);
      expect(project.production).toEqual(before.production);
      expect(project.production?.shots['shot-1'].resolvedMode).toBe('reference');
      expect(project.production?.steps[0]).toMatchObject({ taskId: 'TEST-existing-task', runId: 'TEST-existing-run', inputHash: 'c'.repeat(64) });
      expect(evidence(project)).toEqual(evidence(before));
      expect(project.jobs).toHaveLength(1);
    }
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(beforeFile);
  });

  it('原制作和步骤全部完成后可补当前目标，同时完整保留制作记录及原计划摘要', async (): Promise<void> => {
    original.production = production('complete');
    for (const step of original.production.steps) step.status = 'complete';
    const beforeFile = await saveLegacyFixture(original);
    const before = validateProject(JSON.parse(beforeFile) as unknown, true);
    const loaded = await projects.read(original.id);
    const reopened = await new PetStoryProjects().open(directory);
    for (const project of [loaded, reopened]) {
      expect(project.plan!.shots[0].autoModePlan?.mode).toBe('first_last_frame');
      expect(project.plan!.shots[0].prompts.lastFrame).toMatchObject({ final: '', edited: false });
      expect(project.production).toEqual(before.production);
      expect(project.production?.planHash).toBe(before.production!.planHash);
      expect(project.production?.steps).toEqual(before.production!.steps);
      expect(project.revision).toBe(before.revision);
      expect(evidence(project)).toEqual(evidence(before));
    }
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(beforeFile);
  });

  it('旧方案起止相同但已有合法采用尾图时仍恢复尾帧用途，不隐藏用户已有图片', async (): Promise<void> => {
    original.plan!.shots[0].endState = original.plan!.shots[0].startState;
    const beforeFile = await saveLegacyFixture(original);
    const loaded = await projects.read(original.id);
    const reopened = await new PetStoryProjects().open(directory);
    for (const project of [loaded, reopened]) {
      expect(project.plan!.shots[0].prompts.lastFrame).toBeDefined();
      expect(project.adoptedImages?.['shot-1'].plannedEndImageId).toBe('TEST-tail-history');
      expect(evidence(project)).toEqual(evidence(original));
      expect(project.revision).toBe(original.revision);
      expect(project.production).toBeUndefined();
    }
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(beforeFile);
    expect(await fs.readFile(path.join(directory, 'shots/shot-1/tail.png'), 'utf8')).toBe('TEST');
  });

  it('暂停的独立图片制作不阻断尾帧目标补齐，原操作、运行和输入依据保持不变', async (): Promise<void> => {
    const target = { shotId: 'shot-1', kind: 'firstFrame' as const };
    const beforeBasis = imageTargetBasis(original, target);
    const operationId = 'TEST-paused-image-operation';
    original.imageOperations = [{ id: operationId, requestId: 'TEST-paused-image-request', target,
      mode: 'generate', stage: 'generating', createdAt: now, basisHash: beforeBasis, taskId: 'TEST-paused-image-task',
      ...{ pausedAt: now } }];
    original.imageProductions = { [operationId]: { ...production('paused'), imageOperationId: operationId, target,
      steps: [{ id: 'TEST-paused-image-step', kind: 'firstFrame', shotId: 'shot-1', taskId: 'TEST-paused-image-task',
        runId: 'TEST-paused-image-run', inputHash: 'f'.repeat(64), attachmentAssetIds: ['TEST-first'], status: 'bound' }],
      message: 'TEST图片已暂停；读取不会恢复原任务' } };
    const beforeFile = await saveLegacyFixture(original);
    const before = validateProject(JSON.parse(beforeFile) as unknown, true);
    const loaded = await projects.read(original.id);
    const reopened = await new PetStoryProjects().open(directory);
    for (const project of [loaded, reopened]) {
      expect(project.plan!.shots[0].autoModePlan?.mode).toBe('first_last_frame');
      expect(project.plan!.shots[0].prompts.lastFrame).toMatchObject({ final: '', edited: false });
      expect(evidence(project)).toEqual(evidence(before));
      expect(project.imageProductions?.[operationId].steps[0]).toMatchObject({ taskId: 'TEST-paused-image-task',
        runId: 'TEST-paused-image-run', inputHash: 'f'.repeat(64), attachmentAssetIds: ['TEST-first'], status: 'bound' });
      expect(project.imageProductions?.[operationId].planHash).toBe(before.imageProductions![operationId].planHash);
      expect(imageTargetBasis(project, target)).toBe(beforeBasis);
      expect(project.jobs).toHaveLength(1);
      expect(project.production).toBeUndefined();
      expect(project.revision).toBe(before.revision);
    }
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(beforeFile);
    for (const asset of original.assets) expect(await fs.readFile(path.join(directory, asset.relativePath), 'utf8')).toBe('TEST');
  });
});
