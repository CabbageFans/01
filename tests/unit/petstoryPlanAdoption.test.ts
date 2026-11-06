/** 用户原五镜头派生的离线服务回归；临时文件和模拟Chat不是真实媒体验收。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PetStoryAsset, PetStoryChatJob, PetStoryPlan, PetStoryProject, Task, TaskAddParams, TaskRunSnapshot } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { PetStoryChatService } from '../../main/utils/petstoryChat';
import { PetStoryAdjustmentService, conversationReplyKey } from '../../main/utils/petstoryAdjustment';
import { releaseConversationGuard } from '../../main/utils/accountConversationGuard';
import { syncMaterials } from '../../main/utils/petstoryMaterials';
import { imageTargetBasis } from '../../main/utils/petstoryImageReview';
import { promptDesignHash } from '../../main/utils/petstoryEligibility';
import { needsPetStoryReferenceAdaptation } from '../../src/utils/petstoryVisualBasis';
import { seedOfflinePromptContracts } from '../fixtures/petstoryPromptContracts';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { withOfflineTimingPlan } from '../fixtures/petstoryTimingPlan';

const now = '2026-10-29T00:00:00.000Z';
const conversationUrl = 'https://www.doubao.com/chat/TEST-plan-adoption';
let directory: string; let projects: PetStoryProjects; let p: PetStoryProject; let chat: PetStoryChatService; let core: TaskService; let tasks: Task[]; let adjustments: PetStoryAdjustmentService;

function existingPlan(): PetStoryPlan {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  plan.props = [];
  plan.scenes = ['road', 'other-road'].map((id, index): NonNullable<PetStoryPlan['scenes']>[number] => ({ id, name: index ? '路边' : '村道', location: plan.shots[index ? 3 : 0].scene, time: '原方案时间', lighting: '原方案自然光', layout: '原故事民居与路边', view: '原方案视角', designOrigin: 'script' }));
  for (const character of plan.characters) delete character.referenceAssetId;
  for (const shot of plan.shots) { shot.sceneId = shot.order <= 3 ? 'road' : 'other-road'; shot.propIds = []; shot.propStates = []; }
  plan.shots[0].prompts.firstFrame.edited = true;
  plan.shots[0].prompts.video.edited = false;
  return withOfflineTimingPlan(plan, snapshot.mobileStory);
}
async function saveHistoricalFrames(): Promise<void> {
  for (const shot of p.plan!.shots) {
    const target = { shotId: shot.id, kind: 'firstFrame' as const };
    const asset: PetStoryAsset = { id: `TEST-${shot.id}`, kind: 'firstFrame', shotId: shot.id, relativePath: `shots/${shot.id}/first.png`, generationFinal: shot.prompts.firstFrame.final,
      validation: { decoded: true, sha256: 'a'.repeat(64), bytes: 4, width: 64, height: 64, checkedAt: now }, imageReview: { state: 'adopted', target, basisHash: imageTargetBasis(p, target), adoptedAt: now, sha256: 'a'.repeat(64) } };
    p.assets.push(asset); p.adoptedImages = { ...p.adoptedImages, [shot.id]: { firstFrameId: asset.id } };
    await fs.mkdir(path.join(directory, 'shots', shot.id), { recursive: true }); await fs.writeFile(path.join(directory, asset.relativePath), 'TEST');
  }
}
beforeEach(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-plan-adoption-'));
  projects = new PetStoryProjects(); p = await projects.create(directory, 'TEST-studio', 'TEST-plan-account');
  p = await projects.saveMobileStory(p.id, p.revision, snapshot.mobileStory); p.plan = existingPlan(); p.materials = syncMaterials(p);
  seedOfflinePromptContracts(p); await saveHistoricalFrames();
  const entry = { state: 'unknown' as const, reason: 'TEST 仅保留历史' };
  p.productionHistory = [{ state: 'complete', planHash: 'b'.repeat(64), approvedAt: now, capability: { accountId: p.accountId, checkedAt: now, durations: [], image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry } }, fallbacks: {}, shots: {}, steps: [], message: 'TEST 原批次历史' }];
  p = await projects.write(p); tasks = []; let sequence = 0;
  core = new TaskService({ store: { read: (): Task[] => structuredClone(tasks), replace: (items: Task[]): boolean => { tasks = structuredClone(items); return true; } }, defaultProjectId: (): string => p.studioProjectId, id: (): string => `TEST-plan-${++sequence}` });
  const port = { list: (): Task[] => structuredClone(tasks), create: (params: TaskAddParams, accountId: string): Task => { const made = core.create(params); if (!made.success) throw new Error(made.error); const assigned = core.assign({ taskId: made.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error); return assigned.data; } };
  chat = new PetStoryChatService(projects, port); adjustments = new PetStoryAdjustmentService(projects, port, chat);
});
afterEach(async (): Promise<void> => {
  const current = await projects.read(p.id); if (current.chatAdjustment) releaseConversationGuard(current.accountId, current.chatAdjustment.id);
  await fs.rm(directory, { recursive: true, force: true });
});
function answer(plan: PetStoryPlan): Record<string, unknown> {
  return { ...plan, storyUsable: true, contentBasis: { beginning: plan.shots[0].startState, middle: plan.shots[1].action, ending: plan.shots.at(-1)!.endState } };
}
async function candidate(plan: PetStoryPlan): Promise<PetStoryChatJob> {
  p = (await chat.prepareRuntime(p.id, p.revision, 'analysis')).project!; const job = p.jobs.at(-1)!; const task = tasks.at(-1)!;
  const raw = JSON.stringify({ requestId: job.requestId, targetIds: job.expectedIds, ...answer(plan) });
  const runtime: TaskRunSnapshot = { runId: `TEST-run-${job.id}`, attempt: 1, stage: 'completed', message: 'TEST 离线方案', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, conversationUrl, input: { prompt: task.prompt, mode: 'chat', attachments: [] }, chatResponse: { text: raw, capturedAt: now } };
  const complete = core.updateRuntime({ taskId: task.id, status: 'done', runtime }); if (!complete.success) throw new Error(complete.error);
  p = (await chat.bindRun(p.id, job.id, runtime.runId)).project!;
  const collected = await chat.collect(p.id, job.id); expect(collected.success, collected.error).toBe(true); p = collected.project!; return p.jobs.at(-1)!;
}
async function adopt(job: PetStoryChatJob): Promise<void> { p = (await chat.adoptPlanCandidate(p.id, p.revision, job.id)).project!; }

describe('明确采用方案才保留并核对受影响成果', (): void => {
  it('旧方案显式改时长会要求同步正文，沿现有准备入口识别，手改后清除本地标记', async (): Promise<void> => {
    for (const shot of p.plan!.shots) delete shot.timingPlan;
    p = await projects.write(p);
    const shotId = p.plan!.shots[0].id; const incoming = structuredClone(p.plan!); const oldBody = incoming.shots[0].prompts.video.final;
    incoming.shots[0].durationSeconds = 8;
    p = await projects.savePlan(p.id, p.revision, incoming);
    expect(p.plan!.shots[0].prompts.video).toMatchObject({ final: oldBody, timingStale: true });
    expect(needsPetStoryReferenceAdaptation(p, shotId, 'video')).toBe(true);
    expect((await new PetStoryProjects().open(directory)).plan!.shots[0].prompts.video.timingStale).toBe(true);
    p = await projects.saveShotPrompt(p.id, p.revision, shotId, 'video', `${oldBody}\nTEST已按当前8秒安排完成手改`);
    expect(p.plan!.shots[0].prompts.video.timingStale).toBeUndefined();
    expect(p.assets).toHaveLength(5); expect(tasks).toHaveLength(0);
  });

  it('高级保存和历史候选采用都重新核对全片台词切片，遗漏不能绕过原文校验', async (): Promise<void> => {
    const sentence = '这啥呀，咋恁臭啊？'; const incoming = structuredClone(p.plan!);
    incoming.shots[0].dialogue = [{ speakerId: 'lulu', text: sentence, tone: '', pace: '',
      source: { text: sentence, occurrence: 1, start: 0, end: Array.from(sentence).length } }];
    incoming.shots[0].timingPlan!.events.push({ id: 'speech', kind: 'dialogue', description: 'TEST原文发声片段', startSeconds: 0, endSeconds: 4.5, dialogueIndex: 0 });
    const valid = await candidate(incoming); const malformed = structuredClone(valid.parsedResult!.plan!);
    malformed.shots[0].dialogue![0].text = Array.from(sentence).slice(0, 3).join(''); malformed.shots[0].dialogue![0].source!.end = 3;
    const before = structuredClone(p.plan); const beforeFile = await fs.readFile(path.join(directory, 'project.json'), 'utf8');
    await expect(projects.savePlan(p.id, p.revision, malformed)).rejects.toThrow('原台词末尾片段遗漏');
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(beforeFile);
    // 只在隔离技术夹具保存旧版留下的部分候选，模拟升级后从项目重开采用。
    p.jobs.find((job): boolean => job.id === valid.id)!.parsedResult!.plan = malformed; p = await projects.write(p);
    const adopted = await chat.adoptPlanCandidate(p.id, p.revision, valid.id); p = adopted.project!;
    expect(adopted.success).toBe(false); expect(adopted.error).toContain('原台词末尾片段遗漏');
    expect(p.plan).toEqual(before); expect(p.assets).toHaveLength(5); expect(tasks).toHaveLength(1);
  });

  it.each([5, 6, 7, 8, 9, 10])('新%d秒事件安排经过候选、采用、重开，设计hash与局部依赖同步', async (duration: number): Promise<void> => {
    const before = structuredClone(p); const incoming = structuredClone(p.plan!);
    const shot = incoming.shots[0]; shot.durationSeconds = duration;
    shot.timingPlan = { events: [{ id: 'source-action', kind: 'action', description: shot.action, startSeconds: 0, endSeconds: duration - 0.4 }],
      estimatedRequiredSeconds: duration - 0.4, durationReason: 'TEST原动作闭合所需时间向上选择整秒', cutReason: 'TEST原动作结果交付后切出' };
    const target = { shotId: shot.id, promptKind: 'video' as const };
    const beforeHash = promptDesignHash(p, target); const unaffectedId = p.plan!.shots[3].id;
    const unaffectedHash = promptDesignHash(p, { shotId: unaffectedId, promptKind: 'firstFrame' });
    const job = await candidate(incoming);
    expect(job.parsedResult?.plan?.shots[0].timingPlan).toEqual(shot.timingPlan);
    expect(p.plan).toEqual(before.plan); expect(p.assets).toEqual(before.assets);
    await adopt(job); const reopened = await new PetStoryProjects().open(directory);
    expect(reopened.plan!.shots[0].durationSeconds).toBe(duration);
    expect(reopened.plan!.shots[0].timingPlan).toEqual(shot.timingPlan);
    expect(promptDesignHash(reopened, target)).not.toBe(beforeHash);
    expect(promptDesignHash(reopened, { shotId: unaffectedId, promptKind: 'firstFrame' })).toBe(unaffectedHash);
    expect(reopened.plan!.shots[0].prompts.video.needsReview).toBe(true);
    expect(reopened.plan!.shots[3].prompts).toEqual(before.plan!.shots[3].prompts);
    expect(reopened.assets).toEqual(before.assets); expect(reopened.productionHistory).toEqual(before.productionHistory);
    expect(tasks).toHaveLength(1); expect(tasks[0].mode).toBe('chat');
  });

  it('候选到达不变更当前采用方案、手改、图片或批次历史', async (): Promise<void> => {
    const before = structuredClone(p); const incoming = structuredClone(p.plan!); incoming.shots[0].action += ' TEST 调整动作';
    const job = await candidate(incoming);
    expect(job.resultStatus).toBe('candidate'); expect(p.plan).toEqual(before.plan); expect(p.assets).toEqual(before.assets); expect(p.productionHistory).toEqual(before.productionHistory); expect(p.adoptedImages).toEqual(before.adoptedImages);
    expect(tasks).toHaveLength(1); expect(tasks.every((task): boolean => task.mode === 'chat')).toBe(true);
  });

  it('仅摘要与理解更新时，完整保留手改、豆包采用来源及旧图片', async (): Promise<void> => {
    const before = structuredClone(p); const incoming = structuredClone(p.plan!); incoming.sourceSummary += ' TEST 摘要说明'; incoming.understanding = 'TEST 新理解说明';
    const job = await candidate(incoming); await adopt(job);
    expect(p.plan!.sourceSummary).toBe(incoming.sourceSummary); expect(p.plan!.understanding).toBe(incoming.understanding);
    for (const shot of p.plan!.shots) expect(shot.prompts).toEqual(before.plan!.shots.find((old): boolean => old.id === shot.id)!.prompts);
    expect(p.plan!.shots[0].prompts.firstFrame.basisJobId).toBeTruthy(); expect(p.plan!.shots[0].prompts.video.sourceJobId).toBeTruthy();
    expect(p.assets).toEqual(before.assets); expect(p.productionHistory).toEqual(before.productionHistory); expect(tasks).toHaveLength(1);
  });

  it('只标记改变镜头及实际连续下游，保留无关切镜、全部旧文件和来源', async (): Promise<void> => {
    const before = structuredClone(p); const incoming = structuredClone(p.plan!); incoming.shots[0].action += ' TEST 调整动作';
    const job = await candidate(incoming); await adopt(job);
    for (const shot of p.plan!.shots) for (const kind of ['firstFrame', 'lastFrame', 'video'] as const) {
      const prompt = shot.prompts[kind]; const old = before.plan!.shots.find((item): boolean => item.id === shot.id)!.prompts[kind];
      if (prompt && old) expect(prompt).toEqual({ ...old, ...(shot.order <= 3 ? { needsReview: true } : {}) });
    }
    expect(p.assets).toHaveLength(before.assets.length);
    // 已采用图片沿用原决定；变化后的文字仍按上面的正文规则标记。
    expect(p.assets).toEqual(before.assets);
    expect(p.productionHistory).toEqual(before.productionHistory); expect(p.adoptedImages).toEqual(before.adoptedImages);
    for (const asset of p.assets) expect(await fs.readFile(path.join(directory, asset.relativePath), 'utf8')).toBe('TEST');
    expect(tasks).toHaveLength(1);
  });

  it('纯排序不改变切镜制作依据，不误标无关图片或提示词', async (): Promise<void> => {
    for (const shot of p.plan!.shots) { shot.transition = 'cut'; delete shot.previousShotId; }
    p = await projects.write(p); const before = structuredClone(p); const incoming = structuredClone(p.plan!);
    incoming.shots = [...incoming.shots].reverse().map((shot, index): typeof shot => ({ ...shot, order: index + 1 }));
    const job = await candidate(incoming); await adopt(job);
    for (const shot of p.plan!.shots) expect(shot.prompts).toEqual(before.plan!.shots.find((old): boolean => old.id === shot.id)!.prompts);
    expect(p.assets).toEqual(before.assets); expect(p.productionHistory).toEqual(before.productionHistory);
  });

  it('实体设计更新只影响使用该实体的素材和镜头', async (): Promise<void> => {
    const material = p.materials!.find((item): boolean => item.id === 'scene:road')!;
    material.prompt.final = 'TEST 已采用场景提示词'; material.prompt.edited = true; seedOfflinePromptContracts(p, { materialId: material.id });
    const sceneImage: PetStoryAsset = { id: 'TEST-scene-road', kind: 'scene', materialId: material.id, relativePath: 'materials/TEST-scene.png',
      validation: { decoded: true, sha256: 'c'.repeat(64), bytes: 4, width: 64, height: 64, checkedAt: now }, imageReview: { state: 'adopted', target: { materialId: material.id }, basisHash: imageTargetBasis(p, { materialId: material.id }), adoptedAt: now, sha256: 'c'.repeat(64) } };
    material.selectedAssetId = sceneImage.id; material.approved = { assetId: sceneImage.id, sha256: 'c'.repeat(64), at: now }; p.assets.push(sceneImage);
    await fs.mkdir(path.join(directory, 'materials'), { recursive: true }); await fs.writeFile(path.join(directory, sceneImage.relativePath), 'TEST'); p = await projects.write(p);
    const before = structuredClone(p); const incoming = structuredClone(p.plan!); incoming.scenes![0].lighting = 'TEST 更新该场景光线';
    const job = await candidate(incoming); await adopt(job);
    for (const shot of p.plan!.shots) expect(shot.prompts.firstFrame.needsReview).toBe(shot.sceneId === 'road' ? true : undefined);
    expect(p.materials!.find((material): boolean => material.id === 'scene:other-road')).toEqual(before.materials!.find((material): boolean => material.id === 'scene:other-road'));
    expect(p.assets.filter((asset): boolean => !asset.needsReview).map((asset): string => asset.shotId!)).toEqual(before.plan!.shots.map((shot): string => shot.id));
    expect(p.assets.find((asset): boolean => asset.id === sceneImage.id)?.needsReview).toBe(true);
    expect(p.materials!.find((item): boolean => item.id === material.id)?.prompt).toEqual({ ...material.prompt, needsReview: true });
    expect(p.materials!.find((item): boolean => item.id === material.id)?.approved).toBeUndefined();
    expect(p.assets).toHaveLength(before.assets.length); expect(tasks).toHaveLength(1);
  });

  it('新增镜头保留新方案草稿，删除目标只整理当前指针并保留旧图历史', async (): Promise<void> => {
    const incoming = structuredClone(p.plan!); const removed = incoming.shots.pop()!;
    const added = { ...structuredClone(incoming.shots[0]), id: 'TEST-new-shot', order: 5, transition: 'cut' as const }; incoming.shots.push(added);
    const oldAssets = structuredClone(p.assets); const job = await candidate(incoming); await adopt(job);
    expect(p.plan!.shots.at(-1)!.prompts.firstFrame).toMatchObject({ final: '', optimized: '', draft: added.prompts.firstFrame.optimized });
    expect(p.plan!.shots.at(-1)!.prompts.firstFrame.sourceJobId).toBeUndefined();
    expect(p.adoptedImages?.[removed.id]).toBeUndefined(); expect(p.assets).toHaveLength(oldAssets.length);
    expect(p.assets.find((asset): boolean => asset.shotId === removed.id)).toEqual(oldAssets.find((asset): boolean => asset.shotId === removed.id)); expect(p.productionHistory).toHaveLength(1); expect(tasks).toHaveLength(1);
  });

  it('新自动方案省略尾帧字段时保留旧正文、已采用图片和全部媒体历史', async (): Promise<void> => {
    const shot = p.plan!.shots[1]; const target = { shotId: shot.id, kind: 'lastFrame' as const };
    shot.requestedMode = 'auto';
    shot.autoModePlan = { mode: 'first_last_frame', reason: 'TEST原剧情需要明确终点' };
    const tail: PetStoryAsset = { id: 'TEST-auto-tail', kind: 'plannedEndImage', shotId: shot.id, relativePath: `shots/${shot.id}/auto-tail.png`,
      generationFinal: shot.prompts.lastFrame!.final,
      validation: { decoded: true, sha256: 'e'.repeat(64), bytes: 4, width: 64, height: 64, checkedAt: now },
      imageReview: { state: 'adopted', target, basisHash: imageTargetBasis(p, target), adoptedAt: now, sha256: 'e'.repeat(64) } };
    p.assets.push(tail); p.adoptedImages![shot.id].plannedEndImageId = tail.id;
    await fs.writeFile(path.join(directory, tail.relativePath), 'TEST'); p = await projects.write(p);
    const before = structuredClone(p); const incoming = structuredClone(p.plan!);
    incoming.shots[1].autoModePlan = { mode: 'first_frame', reason: 'TEST新判断只需要起点，旧尾帧仍作为用户已采用成果保留' };
    delete incoming.shots[1].prompts.lastFrame;
    const job = await candidate(incoming);
    expect(job.parsedResult?.plan?.shots[1].prompts.lastFrame).toBeUndefined();
    await adopt(job);
    const reopened = await new PetStoryProjects().open(directory);
    for (const project of [p, reopened]) {
      expect(project.plan!.shots[1].autoModePlan?.mode).toBe('first_frame');
      expect(project.plan!.shots[1].prompts.lastFrame).toEqual(before.plan!.shots[1].prompts.lastFrame);
      expect(project.assets).toEqual(before.assets);
      expect(project.adoptedImages).toEqual(before.adoptedImages);
      expect(project.productionHistory).toEqual(before.productionHistory);
      expect(project.production).toBeUndefined();
    }
    expect(await fs.readFile(path.join(directory, tail.relativePath), 'utf8')).toBe('TEST');
    expect(tasks).toHaveLength(1); expect(tasks[0].mode).toBe('chat');
  });

  it('方案取消尾帧时只移出当前引用，旧尾帧文件和历史仍保留', async (): Promise<void> => {
    const shot = p.plan!.shots[1]; const target = { shotId: shot.id, kind: 'lastFrame' as const };
    const tail: PetStoryAsset = { id: 'TEST-tail', kind: 'plannedEndImage', shotId: shot.id, relativePath: `shots/${shot.id}/tail.png`,
      validation: { decoded: true, sha256: 'd'.repeat(64), bytes: 4, width: 64, height: 64, checkedAt: now }, imageReview: { state: 'adopted', target, basisHash: imageTargetBasis(p, target), adoptedAt: now, sha256: 'd'.repeat(64) } };
    p.assets.push(tail); p.adoptedImages![shot.id].plannedEndImageId = tail.id; await fs.writeFile(path.join(directory, tail.relativePath), 'TEST'); p = await projects.write(p);
    const incoming = structuredClone(p.plan!); incoming.shots[1].requestedMode = 'first_frame'; delete incoming.shots[1].prompts.lastFrame;
    const job = await candidate(incoming); await adopt(job);
    expect(p.plan!.shots[1].prompts.lastFrame).toBeUndefined(); expect(p.adoptedImages?.[shot.id].plannedEndImageId).toBeUndefined();
    expect(p.assets.find((asset): boolean => asset.id === tail.id)).toEqual({ ...tail, needsReview: true });
    expect(await fs.readFile(path.join(directory, tail.relativePath), 'utf8')).toBe('TEST'); expect(p.productionHistory).toHaveLength(1); expect(tasks).toHaveLength(1);
  });

  it('自由Chat选定方案采用复用同一保留与影响规则，不创建媒体任务', async (): Promise<void> => {
    const source = await candidate(structuredClone(p.plan!)); const before = structuredClone(p);
    p = (await adjustments.begin(p.id, p.revision, { parentJobId: source.id })).project!; const adjustment = p.chatAdjustment!;
    const incoming = structuredClone(p.plan!); incoming.shots[3].action += ' TEST 自由讨论调整';
    const content = { text: JSON.stringify(answer(incoming)), precedingUserText: 'TEST 选择这一轮具体回复', messageId: 'TEST-message', turnId: 'TEST-turn' };
    const reply = { ...content, key: conversationReplyKey(content), capturedAt: now };
    p = (await adjustments.capture(p.id, adjustment.id, conversationUrl, [reply])).project!;
    p = (await adjustments.adopt(p.id, p.revision, adjustment.id, reply.key)).project!;
    expect(p.plan!.shots[0].prompts).toEqual(before.plan!.shots[0].prompts);
    expect(p.plan!.shots[3].prompts.firstFrame).toEqual({ ...before.plan!.shots[3].prompts.firstFrame, needsReview: true });
    expect(p.plan!.shots[4].prompts.video.needsReview).toBe(true); expect(p.assets).toHaveLength(before.assets.length); expect(p.productionHistory).toEqual(before.productionHistory);
    expect(p.jobs.at(-1)?.rawText).toBe(reply.text); expect(p.jobs.at(-1)?.parsedResult?.plan?.shots[3].prompts.firstFrame.draft).toBe(incoming.shots[3].prompts.firstFrame.optimized);
    expect(tasks).toHaveLength(1); expect(tasks[0].mode).toBe('chat');
  });
});
