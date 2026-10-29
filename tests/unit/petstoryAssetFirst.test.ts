/** 工具级离线验收：互不相关的剧本，真实项目文件／TaskService／媒体校验，无平台请求。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DownloadJob, PetStoryCapability, PetStoryPlan, PetStoryProject, PetStoryPrompt, PetStoryResolvedMode, Task, TaskAddParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { PetStoryProductionService } from '../../main/utils/petstoryProduction';
import { PetStoryChatService } from '../../main/utils/petstoryChat';
import { compilePrompt } from '../../main/utils/petstoryPromptQuality';
import { requiredMaterialKeys } from '../../main/utils/petstoryMaterials';
import { validatePetStoryPlan } from '../../main/utils/petstoryValidation';
import { mediaCommand } from '../../main/utils/petstoryMedia';
import { bindReferenceText } from '../../main/utils/petstoryReferenceText';
import { seedOfflinePromptContracts } from '../fixtures/petstoryPromptContracts';
import { analysisPrompt } from '../../src/utils/petstoryPrompts';

let root: string; let red: string; let blue: string;
const prompt = (text: string): PetStoryPrompt => ({ original: text, optimized: text, final: text, edited: false, rulesVersion: 'TEST' });
function story(which: 'music' | 'repair'): PetStoryPlan {
  const music = which === 'music';
  const names = music ? ['小提琴学徒'] : ['巡检员', '修理机器人', '信号员'];
  const characters = names.map((name, i): PetStoryPlan['characters'][number] => ({ id: `actor-${i}`, name, role: i === 0 ? 'main' : 'supporting', purpose: music ? '试奏后收起乐器' : '传递校准器修复信标', description: `剧本未指定，待确认的${i}号角色设计`, designOrigin: 'proposed', continuity: '项目接受图片的身份与外观' }));
  const scenes: NonNullable<PetStoryPlan['scenes']> = [{ id: 'place-a', name: music ? '练习室' : '检修舱', location: music ? '音乐楼练习室' : '空间站检修舱', time: '白天', lighting: '柔和顶灯', layout: '入口在左，工作区在右', view: '主视角', designOrigin: 'script' }];
  if (!music) scenes.push({ id: 'place-b', name: '外部信标台', location: '空间站外部平台', time: '同一时间', lighting: '恒星侧光', layout: '栏杆在外，信标在内侧', view: '主视角', designOrigin: 'script' });
  return { sourceSummary: music ? '学徒试奏后把琴收好' : '三位工作人员传递校准器修复外部信标', adaptedStory: music ? '学徒拉出一段旋律，再把琴收进盒子' : '巡检员把校准器交给机器人，机器人检查后交给信号员，信号员去外部平台修复信标', characters,
    props: [{ id: 'object-a', name: music ? '小提琴' : '校准器', aliases: music ? ['琴'] : ['校准装置'], description: music ? '棕色木质弦乐器，四根琴弦' : '银色手持圆盘，中央蓝色刻度', keyStates: music ? '试奏／放入琴盒' : '交接／接入信标', scale: '小于持有者躯干', designOrigin: 'script' }], scenes,
    shots: Array.from({ length: music ? 2 : 3 }, (_, i): PetStoryPlan['shots'][number] => ({ id: `moment-${i}`, order: i + 1,
      characterIds: music ? ['actor-0'] : i === 0 ? ['actor-0', 'actor-1'] : i === 1 ? ['actor-1', 'actor-2'] : ['actor-2'],
      propIds: ['object-a'], propStates: [{ propId: 'object-a', holderId: music ? 'actor-0' : `actor-${Math.min(i, 2)}`, state: music ? '演奏后准备收好' : '交接到下一位操作者' }],
      sceneId: !music && i === 2 ? 'place-b' : 'place-a', scene: !music && i === 2 ? '外部信标台' : scenes[0].name, sceneView: i === 0 ? '全景' : '侧面近景',
      startState: '人物及道具处于明确起点', endState: '本次操作完成', action: music ? '放下琴弓并把琴收好' : '双手接触装置后完成交接或插接', expression: '先专注后放松', gaze: '先看道具，再看操作对象', interaction: '按出场人员完成操作',
      dialogue: !music && i === 0 ? [{ speakerId: 'actor-0', text: '校准值是三，请接稳。', tone: '认真', pace: '清楚而简短' }] : [], camera: '固定机位', durationSeconds: 5, transition: 'cut', requestedMode: 'reference',
      prompts: { firstFrame: prompt('明确静态起点，{{ref:prop:object-a}}定义道具外形。'), lastFrame: prompt('以{{ref:first}}为基础只编辑到操作终态。'), video: prompt('从起点执行已确认的操作过程，再结束。') } })) };
}
function capability(): PetStoryCapability {
  const supported = { state: 'supported' as const, free: 'free' as const, reason: 'TEST离线入口' };
  return { allowPlainReferences: true, accountId: 'TEST-account', checkedAt: new Date().toISOString(), image: supported, modes: { first_frame: supported, first_last_frame: supported, reference: supported }, videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' }, durations: [5], freeEvidence: 'user_confirmed' };
}
async function harness(which: 'music' | 'repair' = 'repair'): Promise<{
  projects: PetStoryProjects; project: PetStoryProject; core: TaskService; service: PetStoryProductionService;
  list: () => Task[]; downloads: DownloadJob[]; setDownloadFailure: (value: boolean) => void; finish: (taskId: string) => Promise<void>;
}> {
  const directory = await fs.mkdtemp(path.join(root, `${which}-`)); const projects = new PetStoryProjects();
  let project = await projects.create(directory, 'TEST-studio', 'TEST-account');
  project = await projects.saveSource(project.id, project.revision, 'https://v.douyin.com/TEST-offline/');
  project = await projects.saveMobileStory(project.id, project.revision, story(which).adaptedStory);
  project.plan = validatePetStoryPlan(story(which)); project.source.status = 'review_required'; project = await projects.write(project);
  let stored: Task[] = []; let sequence = 0; let failure = false; const downloads: DownloadJob[] = [];
  const list = (): Task[] => structuredClone(stored);
  const core = new TaskService({ store: { read: list, replace: (tasks: Task[]): boolean => { stored = structuredClone(tasks); return true; } }, defaultProjectId: (): string => 'TEST-studio', id: (): string => `TEST-${++sequence}` });
  const create = (params: TaskAddParams, accountId: string): Task => { const result = core.create(params); if (!result.success) throw new Error(result.error); const assigned = core.assign({ taskId: result.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error); return assigned.data; };
  const service = new PetStoryProductionService(projects, { list, create,
    adopt: (id, binding, text): Task => { const r = core.bindPetStory(id, binding, text); if (!r.success) throw new Error(r.error); return r.data; },
    bindPageInput: (id, runId, text): Task => { const r = core.bindPetStoryPageInput(id, runId, text); if (!r.success) throw new Error(r.error); return r.data; },
    retryUnsubmitted: (id): Task => { const r = core.retry(id, 'hold'); if (!r.success) throw new Error(r.error); return r.data; }, downloads: (): DownloadJob[] => downloads,
    download: async (params): Promise<{ success: boolean; count: number; failed: number; jobIds?: string[] }> => {
      if (failure) return { success: false, count: 0, failed: 1 };
      const output = params.outputs[0]; const time = new Date().toISOString(); const id = `download-${downloads.length}`;
      downloads.push({ id, taskId: output.taskId!, accountId: 'TEST-account', mode: 'image', url: output.outputs[0], status: 'done', attempts: 1, saveDir: root, filePath: red, createdAt: time, updatedAt: time });
      return { success: true, count: 1, failed: 0, jobIds: [id] };
    } });
  const finish = async (taskId: string): Promise<void> => {
    const task = list().find((t): boolean => t.id === taskId)!; const now = new Date().toISOString(); const runId = `run-${task.id}`;
    const result = core.updateRuntime({ taskId, status: 'executing', runtime: { runId, attempt: 1, stage: 'injecting_prompt', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { prompt: task.prompt, mode: task.mode, attachments: task.attachments || [], videoConfig: task.videoConfig, petstory: task.petstory } } });
    expect(result.success).toBe(true); await service.bindRun(project.id, taskId, runId);
    core.updateRuntime({ taskId, runtime: { submittedAt: now } }); core.updateStatus({ taskId, status: 'done', outputs: [`https://TEST.invalid/${task.id}.png`] });
  };
  return { projects, project, core, service, list, downloads, finish, setDownloadFailure: (value: boolean): void => { failure = value; } };
}
async function accepted(h: Awaited<ReturnType<typeof harness>>): Promise<PetStoryProject> {
  let p = await h.projects.read(h.project.id); p = await h.projects.confirmStory(p.id, p.revision);
  for (const m of p.materials!) p = await h.projects.addMaterialImage(p.id, p.revision, m.id, m.kind === 'scene' ? blue : red);
  p = await h.projects.approveMaterials(p.id, p.revision, p.materials!.map((m): { materialId: string; assetId: string } => ({ materialId: m.id, assetId: p.assets.find((asset): boolean => asset.materialId === m.id)!.id })));
  p.promptCapability = capability(); seedOfflinePromptContracts(p); return h.projects.write(p);
}
beforeAll(async (): Promise<void> => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-asset-first-')); red = path.join(root, 'red.png'); blue = path.join(root, 'blue.png');
  await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x96', '-frames:v', '1', '-y', red]);
  await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x96', '-frames:v', '1', '-y', blue]);
});
afterAll(async (): Promise<void> => fs.rm(root, { recursive: true, force: true }));

describe('通用剧本资产与确认', (): void => {
  it('只读资格复用正式校验，分别定位入口、正文、确认和首尾帧缺项，不创建任务或写项目', async (): Promise<void> => {
    const h = await harness('music'); let p = h.project;
    const firstTarget = { shotId: p.plan!.shots[0].id, promptKind: 'firstFrame' as const };
    const original = await fs.readFile(path.join(h.projects.directory(p.id), 'project.json'), 'utf8');
    const initial = await h.service.inspectGeneration(p.id, p.revision, firstTarget);
    expect(initial.eligibility?.ready).toBe(false);
    expect(initial.eligibility?.blockers.map((item): string => item.code)).toEqual(expect.arrayContaining(['story', 'materials', 'prompt', 'capability']));
    expect(initial.eligibility?.blockers.some((item): boolean => !!item.materialId)).toBe(true);
    expect(await fs.readFile(path.join(h.projects.directory(p.id), 'project.json'), 'utf8')).toBe(original); expect(h.list()).toEqual([]);
    p = await accepted(h);
    const saved = await fs.readFile(path.join(h.projects.directory(p.id), 'project.json'), 'utf8');
    const c = capability(); c.modes = { first_frame: { state: 'unknown', free: 'unknown', reason: 'TEST未检查视频' }, first_last_frame: { state: 'unknown', free: 'unknown', reason: 'TEST未检查视频' }, reference: { state: 'unknown', free: 'unknown', reason: 'TEST未检查视频' } }; c.durations = []; c.videoConfig = undefined;
    expect((await h.service.inspectGeneration(p.id, p.revision, firstTarget, c)).eligibility).toMatchObject({ ready: true, blockers: [] });
    const videoTarget = { shotId: firstTarget.shotId, promptKind: 'video' as const };
    const video = await h.service.inspectGeneration(p.id, p.revision, videoTarget, capability());
    expect(video.eligibility).toMatchObject({ ready: false, resolvedMode: 'reference', blockers: expect.arrayContaining([expect.objectContaining({ code: 'firstFrame', shotId: firstTarget.shotId, promptKind: 'firstFrame' })]) });
    expect(await fs.readFile(path.join(h.projects.directory(p.id), 'project.json'), 'utf8')).toBe(saved); expect(h.list()).toEqual([]);
    await expect(h.service.inspectGeneration(p.id, p.revision - 1, firstTarget, capability())).rejects.toThrow('项目已变化');
    await expect(h.service.inspectGeneration(p.id, p.revision, { shotId: 'not-owned', promptKind: 'video' }, capability())).rejects.toThrow('不属于当前方案');
  });
  it('只读资格与真实单节点生成一致，已完成首帧可进入视频，未知入口和未结束任务仍阻断', async (): Promise<void> => {
    const h = await harness('music'); let p = await accepted(h); const shotId = p.plan!.shots[0].id;
    const target = { shotId, promptKind: 'firstFrame' as const };
    expect((await h.service.inspectGeneration(p.id, p.revision, target, capability())).eligibility?.ready).toBe(true);
    p = (await h.service.generateShotMedia(p.id, p.revision, shotId, 'firstFrame', capability(), {})).project!;
    expect((await h.service.inspectGeneration(p.id, p.revision, target, capability())).eligibility?.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'task' })]));
    const next = await h.service.advance(p.id); await h.finish(next.taskId!); await h.service.advance(p.id); await h.service.advance(p.id);
    p = await h.projects.read(p.id);
    const frame = p.assets.find((asset): boolean => asset.shotId === shotId && asset.imageReview?.state === 'candidate')!;
    expect((await h.service.inspectGeneration(p.id, p.revision, { shotId, promptKind: 'video' }, capability())).eligibility?.ready).toBe(false);
    p = await h.projects.adoptImage(p.id, p.revision, frame.imageReview!.target, frame.id);
    const before = await fs.readFile(path.join(h.projects.directory(p.id), 'project.json'), 'utf8');
    const result = await h.service.inspectGeneration(p.id, p.revision, { shotId, promptKind: 'video' }, capability());
    expect(result.eligibility).toMatchObject({ ready: true, resolvedMode: 'reference', blockers: [] });
    expect(await fs.readFile(path.join(h.projects.directory(p.id), 'project.json'), 'utf8')).toBe(before); expect(h.list()).toHaveLength(1);
    const expired = capability(); expired.checkedAt = '2000-01-01T00:00:00.000Z';
    expect((await h.service.inspectGeneration(p.id, p.revision, { shotId, promptKind: 'video' }, expired)).eligibility?.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'capability', message: expect.stringContaining('已过期') })]));
    p.plan!.shots[0].requestedMode = 'first_last_frame'; p = await h.projects.savePlan(p.id, p.revision, p.plan!); seedOfflinePromptContracts(p); p = await h.projects.write(p);
    expect((await h.service.inspectGeneration(p.id, p.revision, { shotId, promptKind: 'video' }, capability())).eligibility).toMatchObject({ ready: false, resolvedMode: 'first_last_frame', blockers: expect.arrayContaining([expect.objectContaining({ code: 'lastFrame', shotId, promptKind: 'lastFrame' })]) });
  });
  it('直接保存剧本无需来源链接；无人物环境镜头与默认主演配置彼此独立', async (): Promise<void> => {
    const directory = await fs.mkdtemp(path.join(root, 'direct-script-')); const projects = new PetStoryProjects();
    let p = await projects.create(directory, 'TEST-studio', 'TEST-account');
    p = await projects.saveMobileStory(p.id, p.revision, '清晨阳光穿过温室玻璃，镜头落到整齐的幼苗。');
    expect(p.source.kind).toBe('script'); expect(p.source.reason).not.toContain('原视频'); expect(p.source.url).toBe(''); expect(analysisPrompt(p)).toContain('直接提供的剧本');
    const plan = story('music'); plan.characters = []; plan.props = []; plan.shots = [plan.shots[0]]; plan.shots[0].characterIds = []; plan.shots[0].propIds = []; plan.shots[0].propStates = [];
    expect(validatePetStoryPlan(plan).characters).toEqual([]); expect(p.promptProfile?.characters.lulu).toBeDefined();
  });
  it('同物别名重复、同地误拆和派生循环都会要求修正逻辑引用', (): void => {
    const duplicateProp = story('repair'); duplicateProp.props!.push({ ...duplicateProp.props![0], id: 'duplicate', name: '校准装置' });
    expect((): PetStoryPlan => validatePetStoryPlan(duplicateProp)).toThrow('同名或别名');
    const duplicateScene = story('music'); duplicateScene.scenes!.push({ ...duplicateScene.scenes![0], id: 'duplicate' });
    expect((): PetStoryPlan => validatePetStoryPlan(duplicateScene)).toThrow('主场景重复');
    const cycle = story('music'); cycle.scenes![0].parentSceneId = cycle.scenes![0].id;
    expect((): PetStoryPlan => validatePetStoryPlan(cycle)).toThrow('循环');
  });
  it.each(['music', 'repair'] as const)('%s 动态集合、同地点切镜、跨场景及道具交接保持稳定逻辑ID', async (which): Promise<void> => {
    const h = await harness(which); const p = await h.projects.confirmStory(h.project.id, h.project.revision); const plan = p.plan!;
    expect(plan.characters).toHaveLength(which === 'music' ? 1 : 3); expect(plan.shots).toHaveLength(which === 'music' ? 2 : 3);
    expect(plan.shots[0].sceneId).toBe(plan.shots[1].sceneId); expect(new Set(plan.shots.flatMap((s): string[] => s.propIds!)).size).toBe(1);
    if (which === 'repair') { expect(plan.shots[2].sceneId).not.toBe(plan.shots[1].sceneId); expect(plan.shots.map((s): string | undefined => s.propStates![0].holderId)).toEqual(['actor-0', 'actor-1', 'actor-2']); }
    expect(p.materials!.map((m): string => m.id).sort()).toEqual([...requiredMaterialKeys(plan)].sort());
    expect(p.materials!.every((m): boolean => !m.approved && !m.selectedAssetId)).toBe(true);
  });
  it('未确认图片阻断草稿与镜头批准，分析和保存不创建媒体任务', async (): Promise<void> => {
    const h = await harness(); const chat = new PetStoryChatService(h.projects, { list: h.list, create: (): never => { throw new Error('TEST禁止创建'); } });
    await expect(h.service.approve(h.project.id, h.project.revision, capability(), {})).rejects.toThrow('确认当前剧本');
    let p = await h.projects.confirmStory(h.project.id, h.project.revision);
    p = await h.projects.addMaterialImage(p.id, p.revision, p.materials![0].id, red);
    await expect(h.service.approve(p.id, p.revision, capability(), {})).rejects.toThrow('尚未确认');
    await expect(chat.draft(p.id, 'moment-0', 'firstFrame')).rejects.toThrow('确认实际基础图片'); expect(h.list()).toEqual([]);
    expect(analysisPrompt(p)).toContain('props:[]');
  });
  it('新候选和历史预览不改变当前采用，明确替换后旧图仍保留', async (): Promise<void> => {
    const h = await harness('music'); let p = await accepted(h); const id = p.materials![0].id; const old = p.materials![0].selectedAssetId!;
    const oldApproval = structuredClone(p.materials![0].approved);
    p = await h.projects.addMaterialImage(p.id, p.revision, id, blue); const replacement = p.assets.at(-1)!.id;
    expect(p.materials![0]).toMatchObject({ selectedAssetId: old, approved: oldApproval });
    p = await h.projects.selectMaterialImage(p.id, p.revision, id, replacement); expect(p.materials![0].selectedAssetId).toBe(old);
    p = await h.projects.approveMaterials(p.id, p.revision, [{ materialId: id, assetId: replacement }]);
    expect(p.materials![0].selectedAssetId).toBe(replacement); expect(p.assets.some((asset): boolean => asset.id === old)).toBe(true);
    p = await h.projects.approveMaterials(p.id, p.revision, [{ materialId: id, assetId: old }]);
    const original = p.assets.find((asset): boolean => asset.id === old)!; await fs.copyFile(blue, path.join(h.projects.directory(p.id), original.relativePath));
    await expect(h.service.approve(p.id, p.revision, capability(), {})).rejects.toThrow('发生变化');
  });
  it('基础图成功只保存待确认候选，失败只重试下载并保留原任务身份', async (): Promise<void> => {
    const h = await harness('music'); let p = await h.projects.confirmStory(h.project.id, h.project.revision); const id = p.materials![0].id;
    p = await h.projects.saveMaterialPrompt(p.id, p.revision, id, 'TEST用户明确保存的基础图正文');
    p.promptCapability = capability(); seedOfflinePromptContracts(p); p = await h.projects.write(p);
    await h.service.generateMaterials(p.id, p.revision, [id], capability()); const next = await h.service.advance(p.id); await h.finish(next.taskId!);
    h.setDownloadFailure(true); expect((await h.service.advance(p.id)).success).toBe(false); expect(h.list()).toHaveLength(1);
    h.setDownloadFailure(false); const c = capability(); c.freeEvidence = 'unknown'; c.image.free = 'unknown'; await h.service.resume(p.id, c);
    expect((await h.service.advance(p.id)).success).toBe(true); await h.service.advance(p.id); p = await h.projects.read(p.id);
    expect(h.list()).toHaveLength(1); expect(p.production?.phase).toBe('materials'); expect(p.production?.state).toBe('complete');
    expect(p.materials![0].selectedAssetId).toBeUndefined(); expect(p.assets.at(-1)?.imageReview?.state).toBe('candidate'); expect(p.materials![0].approved).toBeUndefined(); expect(p.production?.shots).toEqual({});
    const chat = new PetStoryChatService(h.projects, { list: h.list, create: (params, accountId): Task => {
      const r = h.core.create(params); if (!r.success) throw new Error(r.error); const assigned = h.core.assign({ taskId: r.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error); return assigned.data;
    } });
    const optimized = await chat.prepare(p.id, 'TEST仅完善分镜提示词', 'optimize', undefined, 'moment-0', 'firstFrame');
    expect(optimized.project?.production).toBeUndefined(); expect(optimized.project?.productionHistory?.[0].phase).toBe('materials'); expect(h.list()[1].mode).toBe('chat');
  });
  it('重新生成已接受角色时真实上传原身份图，完成后新图重新待确认', async (): Promise<void> => {
    const h = await harness('music'); let p = await accepted(h); const material = p.materials!.find((m): boolean => m.kind === 'character')!; const old = material.selectedAssetId!;
    p = await h.projects.saveMaterialPrompt(p.id, p.revision, material.id, '沿用身份，只把外套改成用户确认的绿色。');
    p.promptCapability = capability(); seedOfflinePromptContracts(p); p = await h.projects.write(p);
    await h.service.generateMaterials(p.id, p.revision, [material.id], capability()); const next = await h.service.advance(p.id);
    expect(next.success, next.error).toBe(true); expect(h.list()[0].attachments).toEqual([await h.projects.referenceFile(p.id, old)]);
    expect(h.list()[0].prompt).toContain('只把外套改成用户确认的绿色'); await h.finish(next.taskId!); await h.service.advance(p.id); await h.service.advance(p.id);
    p = await h.projects.read(p.id); const generated = p.materials!.find((m): boolean => m.id === material.id)!;
    expect(generated.selectedAssetId).toBe(old); expect(generated.approved?.assetId).toBe(old); expect(p.assets.at(-1)?.imageReview?.state).toBe('candidate'); expect(p.assets.some((a): boolean => a.id === old)).toBe(true);
  });
  it('派生视角必须从已确认主场景生成，而非独立造景', async (): Promise<void> => {
    const h = await harness('music'); let p = h.project; const plan = p.plan!; const main = plan.scenes![0];
    plan.scenes!.push({ ...main, id: 'view-b', parentSceneId: main.id, view: '从入口反向看工作区' }); plan.shots[1].sceneId = 'view-b';
    p = await h.projects.write(p); p = await h.projects.confirmStory(p.id, p.revision);
    p = await h.projects.saveMaterialPrompt(p.id, p.revision, 'scene:view-b', `TEST用户派生视角正文，基于{{ref:scene:${main.id}}}的空间。`);
    p.promptCapability = capability(); seedOfflinePromptContracts(p); p = await h.projects.write(p);
    await h.service.generateMaterials(p.id, p.revision, ['scene:view-b'], capability()); expect((await h.service.advance(p.id)).success).toBe(false); expect(h.list()).toHaveLength(0);
    p = await h.projects.read(p.id); p = await h.projects.addMaterialImage(p.id, p.revision, `scene:${main.id}`, blue); const selected = p.materials!.find((m): boolean => m.entityId === main.id)!;
    p = await h.projects.approveMaterials(p.id, p.revision, [{ materialId: selected.id, assetId: p.assets.at(-1)!.id }]); await h.service.resume(p.id, capability()); const next = await h.service.advance(p.id);
    expect(next.action).toBe('start'); expect(h.list()[0].attachments).toEqual([await h.projects.referenceFile(p.id, p.assets.find((asset): boolean => asset.materialId === selected.id)!.id)]);
    expect(next.project?.production?.steps[0].compiledPrompt?.references[0].materialId).toBe(selected.id);
  });
});

describe('镜头输入与实际引用', (): void => {
  it('同组确认素材跨镜复用，人物顺序变化仍按逻辑ID映射，手改final重开后用于原任务', async (): Promise<void> => {
    const h = await harness(); let p = await accepted(h); const plan = structuredClone(p.plan!); const final = '用户手改全文\n保留“校准值是三，请接稳。”\n{{ref:prop:object-a}}是校准器。';
    plan.shots[0].prompts.firstFrame.final = final; plan.shots[0].characterIds.reverse(); p = await h.projects.savePlan(p.id, p.revision, plan); seedOfflinePromptContracts(p); p = await h.projects.write(p);
    const reopened = await new PetStoryProjects().open(h.projects.directory(p.id)); expect(reopened.plan!.shots[0].prompts.firstFrame.final).toBe(final);
    const first = compilePrompt(reopened, 'moment-0', 'firstFrame'); const second = compilePrompt(reopened, 'moment-1', 'firstFrame');
    expect(first.references.map((r): string | undefined => r.materialId)).toEqual(['character:actor-1', 'character:actor-0', 'prop:object-a', 'scene:place-a']);
    expect(first.references.find((r): boolean => r.purpose === 'prop')?.assetId).toBe(second.references.find((r): boolean => r.purpose === 'prop')?.assetId);
    expect(first.references.find((r): boolean => r.purpose === 'scene')?.assetId).toBe(second.references.find((r): boolean => r.purpose === 'scene')?.assetId);
    const incorrect = structuredClone(reopened); incorrect.plan!.shots[0].prompts.firstFrame.final = '@图片99是人物';
    expect((): unknown => compilePrompt(incorrect, 'moment-0', 'firstFrame', undefined, true)).toThrow('没有对应实际上传');
    await h.service.approve(p.id, p.revision, capability(), {}); const next = await h.service.advance(p.id); const task = h.list()[0];
    expect(next.success, next.error).toBe(true); expect(next.action).toBe('start'); expect(task.prompt).toBe(first.text); expect(task.prompt.endsWith(first.final.replace('{{ref:prop:object-a}}', '第 3 张图'))).toBe(true);
    expect(task.attachments).toEqual(await Promise.all(first.references.map((r): Promise<string> => h.projects.referenceFile(p.id, r.assetId))));
    const generic = h.core.create({ prompts: ['普通Studio自己的文本'], mode: 'image' }); expect(generic.success && generic.data[0].prompt).toBe('普通Studio自己的文本');
  });
  it.each(['first_frame', 'first_last_frame', 'reference'] as const)('%s 严格组装互斥输入，不以文本冒充首尾槽', async (mode: PetStoryResolvedMode): Promise<void> => {
    const h = await harness('music'); let p = await accepted(h); p.plan!.shots = [p.plan!.shots[0]]; p.plan!.shots[0].requestedMode = mode;
    seedOfflinePromptContracts(p); p = await h.projects.write(p); await h.service.approve(p.id, p.revision, capability(), {});
    for (let i = 0; i < 12; i++) { const next = await h.service.advance(p.id); expect(next.success, next.error).toBe(true); if (next.project?.production?.state === 'paused') { let current = await h.projects.read(p.id); const candidate = current.assets.find((asset): boolean => asset.imageReview?.state === 'candidate' && !!asset.shotId)!; current = await h.projects.adoptImage(current.id, current.revision, candidate.imageReview!.target, candidate.id); await h.service.resume(current.id, capability()); } if (next.taskId && next.action === 'start') { if (h.list().find((t): boolean => t.id === next.taskId)?.mode === 'video') break; await h.finish(next.taskId); } }
    const video = h.list().find((t): boolean => t.mode === 'video')!; const saved = await h.projects.read(p.id); const step = saved.production!.steps.find((s): boolean => s.kind === 'video')!;
    expect(video.attachments).toHaveLength(mode === 'first_last_frame' ? 2 : mode === 'reference' ? 4 : 1); expect(step.compiledPrompt?.references.map((r): string | undefined => r.slot)).toEqual(mode === 'first_last_frame' ? ['first', 'last'] : mode === 'first_frame' ? ['first'] : [undefined, undefined, undefined, undefined]);
    expect(video.videoConfig?.duration).toBe('5s');
  });
  it.each(['submitted', 'safe_retry'] as const)('实际编号重排后保存绑定并保护普通任务与恢复：%s', async (outcome): Promise<void> => {
    const h = await harness('music'); let p = await accepted(h); await h.service.approve(p.id, p.revision, capability(), {}); const next = await h.service.advance(p.id); const task = h.list()[0]; const now = new Date().toISOString(); const runId = 'TEST-binding-run';
    h.core.updateRuntime({ taskId: task.id, status: 'executing', runtime: { runId, attempt: 1, stage: 'injecting_prompt', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { prompt: task.prompt, mode: 'image', attachments: task.attachments! } } });
    await h.service.bindRun(p.id, task.id, runId); const source = next.project!.production!.steps[0].compiledPrompt!;
    const bindings = source.references.map((ref, index): import('@doubao-studio/contracts').PetStoryPageBinding => ({ assetId: ref.assetId, order: index + 1, slot: 'reference', previewHash: String(index + 1).repeat(64), label: `@图片${source.references.length - index}`, reference: 'mention', nodeId: `node-${index}`, targetId: `asset-${index}`, fileSha256: p.assets.find((a): boolean => a.id === ref.assetId)!.validation!.sha256, occurrenceCount: source.segments!.filter((s): boolean => 'referenceOrder' in s && s.referenceOrder === ref.order).length, nodeIds: source.segments!.filter((s): boolean => 'referenceOrder' in s && s.referenceOrder === ref.order).map((): string => `node-${index}`) }));
    const reordered = bindReferenceText(source, bindings); const saved = await h.service.recordPageBindings(p.id, task.id, runId, bindings);
    expect(saved.compiledPrompt?.text).toBe(reordered.text); expect(h.list()[0].runtime?.input.prompt).toBe(reordered.text); expect((await h.service.guard(task.id)).success).toBe(true);
    p = await h.projects.read(p.id); expect(p.plan!.shots[0].prompts.firstFrame.final).toBe(source.final);
    await expect(h.service.recordPageBindings(p.id, task.id, runId, bindings)).rejects.toThrow('已经固定');
    if (outcome === 'safe_retry') {
      h.core.updateRuntime({ taskId: task.id, status: 'paused', errorInfo: { code: 'petstory_controls_unconfirmed', message: 'TEST提交前页面变化', recoverable: true, detectedAt: now } });
      expect((await h.service.advance(p.id)).success).toBe(false);
      await h.service.resume(p.id, capability()); const resumed = await h.service.advance(p.id);
      expect(resumed.taskId).toBe(task.id); expect(h.list()).toHaveLength(1); expect(h.list()[0].prompt).toBe(source.text);
      const step = resumed.project!.production!.steps[0]; expect(step.pageBindings).toBeUndefined(); expect(step.pageBindingHistory?.[0].compiledPrompt.text).toBe(reordered.text);
      return;
    }
    h.core.updateRuntime({ taskId: task.id, runtime: { submittedAt: now } }); expect(h.core.bindPetStoryPageInput(task.id, runId, 'changed').success).toBe(false);
    const generic = h.core.create({ prompts: ['普通文本'], mode: 'image' }); if (!generic.success) throw new Error('TEST'); expect(h.core.bindPetStoryPageInput(generic.data[0].id, runId, 'changed').success).toBe(false);
  });
});
