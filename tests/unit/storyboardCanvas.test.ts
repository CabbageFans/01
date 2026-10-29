/** 仅用户原五镜头的离线接线测试；快照/技术图片不属于本轮新生成验收。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadJob, PetStoryCapability, PetStoryPlan, PetStoryProject, Task, TaskAddParams, TaskDownloadOutputsParams, TaskDownloadOutputsResult, Account } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { PetStoryChatService } from '../../main/utils/petstoryChat';
import { storyHash } from '../../main/utils/petstoryMaterials';
import { PetStoryExistingMediaService } from '../../main/utils/petstoryExistingMedia';
import { PetStoryProductionService } from '../../main/utils/petstoryProduction';
import { TaskService } from '../../main/core/TaskService';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';
import { mediaCommand } from '../../main/utils/petstoryMedia';
import { optimizationPrompt } from '../../src/utils/petstoryPrompts';
import { seedOfflinePromptContracts } from '../fixtures/petstoryPromptContracts';

let root: string; let projects: PetStoryProjects; let p: PetStoryProject; let core: TaskService; let tasks: Task[]; let chats: PetStoryChatService;
const list = (): Task[] => structuredClone(tasks);
function create(params: TaskAddParams, accountId: string): Task {
  const created = core.create(params); if (!created.success) throw new Error(created.error);
  const assigned = core.assign({ taskId: created.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error);
  return assigned.data;
}
function capability(imageOnly = false): PetStoryCapability {
  const supported = { state: 'supported' as const, free: 'free' as const, reason: 'TEST 离线控件核验替身' };
  const unknown = { state: 'unknown' as const, free: 'unknown' as const, reason: '尚未核对视频入口' };
  return { accountId: p.accountId, checkedAt: new Date().toISOString(), image: supported,
    modes: { first_frame: imageOnly ? unknown : supported, first_last_frame: imageOnly ? unknown : supported, reference: imageOnly ? unknown : supported },
    durations: imageOnly ? [] : [5, 6, 7, 8, 9, 10], videoConfig: imageOnly ? undefined : { model: 'seedance-2.0-fast', duration: '6s', aspectRatio: '9:16' }, freeEvidence: 'user_confirmed' };
}
async function runtime(task: Task, chatText?: string): Promise<void> {
  const now = new Date().toISOString();
  const result = core.updateRuntime({ taskId: task.id, status: chatText ? 'done' : 'executing', runtime: { runId: `TEST-run-${task.id}`, attempt: 1, stage: chatText ? 'completed' : 'injecting_prompt', message: 'TEST 离线运行', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
    input: { prompt: task.prompt, mode: task.mode, attachments: task.attachments || [], videoConfig: task.videoConfig, petstory: task.petstory, promptReadback: task.promptReadback }, submittedAt: chatText ? now : undefined,
    chatResponse: chatText ? { text: chatText, capturedAt: now } : undefined } });
  if (!result.success) throw new Error(result.error);
}
beforeEach(async (): Promise<void> => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-five-shot-canvas-'));
  projects = new PetStoryProjects(); p = await projects.create(root, 'TEST-five-studio', 'TEST-five-account');
  p = await projects.saveMobileStory(p.id, p.revision, snapshot.mobileStory);
  p.plan = structuredClone(snapshot.plan) as PetStoryPlan; p.source.status = 'review_required'; p = await projects.write(p);
  let sequence = 0; tasks = [];
  core = new TaskService({ store: { read: list, replace: (value: Task[]): boolean => { tasks = normalizeTasks(structuredClone(value), p.studioProjectId).data; return true; } }, defaultProjectId: (): string => p.studioProjectId, id: (): string => `TEST-five-task-${++sequence}` });
  chats = new PetStoryChatService(projects, { list, create });
});
afterEach(async (): Promise<void> => { await fs.rm(root, { recursive: true, force: true }); });

describe('原五镜头画布持久化与操作边界', (): void => {
  it('binds and restores all 13 Chat replies without changing story, manual finals or creating media', async (): Promise<void> => {
    const before = structuredClone(p.plan!); let count = 0;
    for (const shot of before.shots) {
      for (const kind of ['firstFrame', 'lastFrame', 'video'] as const) {
        const source = shot.prompts[kind]; if (!source) continue;
        p = await projects.read(p.id);
        const prepared = await chats.prepare(p.id, optimizationPrompt(p, shot.id, kind), 'optimize', undefined, shot.id, kind);
        const task = list().find((t): boolean => t.id === prepared.taskId)!;
        // 旧的真实正文仅作回读夹具，绝不称为本轮重新生成结果。
        await runtime(task, JSON.stringify({ optimized: source.optimized }));
        const job = prepared.project!.jobs.at(-1)!;
        await chats.bindRun(p.id, job.id, `TEST-run-${task.id}`);
        const collected = await chats.collect(p.id, job.id);
        expect(collected.success, collected.error).toBe(true);
        expect(collected.project!.plan!.shots.find((s): boolean => s.id === shot.id)!.prompts[kind]!.optimized).toBe(source.optimized);
        count++;
      }
    }
    p = await new PetStoryProjects().open(root);
    expect(count).toBe(13); expect(p.jobs).toHaveLength(13); expect(p.jobs.every((j): boolean => j.status === 'applied' && !!j.rawText && !!j.runId)).toBe(true);
    expect(p.mobileStory!.text).toBe(snapshot.mobileStory); expect(p.plan!.adaptedStory).toBe(before.adaptedStory);
    expect(p.plan!.shots.map((s): string => s.id)).toEqual(before.shots.map((s): string => s.id));
    expect(p.plan!.shots[0].prompts.firstFrame.final).toBe(before.shots[0].prompts.firstFrame.final);
    expect(p.plan!.shots[0].prompts.video.final).toBe(before.shots[0].prompts.video.final);
    expect(tasks).toHaveLength(13); expect(tasks.every((t): boolean => t.mode === 'chat' && !t.outputs.length)).toBe(true);
    expect(p.production).toBeUndefined(); expect(p.assets).toEqual([]);
  });
  it('the page store serializes the same 13 text items and only advances after successful collection', async (): Promise<void> => {
    const initial = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState(), projects: useProjectStore.getState() };
    const now = new Date().toISOString();
    const account: Account = { id: p.accountId, name: 'TEST 原账号替身', platform: 'doubao', avatar: '', partition: 'TEST-only', status: 'idle', pinned: false, createdAt: now, updatedAt: now };
    vi.stubGlobal('window', { electronAPI: { petstory: { prepareRuntime: chats.prepareRuntime.bind(chats), bindRun: chats.bindRun.bind(chats), collectChat: chats.collect.bind(chats),
      savePromptBatch: async (...args: Parameters<PetStoryProjects['savePromptBatch']>): Promise<{ success: true; project: PetStoryProject }> => ({ success: true, project: await projects.savePromptBatch(...args) }) }, tasks: { list: async (): Promise<Task[]> => list() } } });
    useAccountStore.setState({ accounts: [account] });
    useProjectStore.setState({ projects: [{ id: p.studioProjectId, name: 'TEST 原五镜头容器', description: '', color: '#fff', archived: false, createdAt: now, updatedAt: now }] });
    useTaskStore.setState({ startAutomation: async (taskId: string, beforeDispatch?: (task: Task) => Promise<void>): Promise<boolean> => {
      const task = list().find((t): boolean => t.id === taskId)!; await runtime(task);
      if (beforeDispatch) await beforeDispatch(list().find((t): boolean => t.id === taskId)!); return true;
    } });
    usePetStoryStore.setState({ project: p, busy: false, freeChatConfirmed: true, error: '' });
    try {
      await usePetStoryStore.getState().regenerateAllPrompts();
      expect(tasks).toHaveLength(1);
      expect(usePetStoryStore.getState().promptBatch).toEqual({ total: 13, completed: 0, status: 'running' });
      for (let index = 0; index < 13; index++) {
        const current = usePetStoryStore.getState().project!; const job = current.jobs.at(-1)!;
        const source = current.plan!.shots.find((s): boolean => s.id === job.shotId)!.prompts[job.promptKind!]!;
        const task = list().find((t): boolean => t.id === job.taskId)!;
        await runtime(task, JSON.stringify({ requestId: job.requestId, targetIds: job.expectedIds, optimized: source.optimized }));
        await usePetStoryStore.getState().collect(job.id);
        expect(usePetStoryStore.getState().error).toBe('');
        expect(tasks).toHaveLength(Math.min(13, index + 2));
      }
      expect(usePetStoryStore.getState().promptBatch).toEqual({ total: 13, completed: 13, status: 'complete' });
      expect(tasks.every((t): boolean => t.mode === 'chat')).toBe(true);
      expect(usePetStoryStore.getState().project!.jobs.every((j): boolean => j.status === 'applied')).toBe(true);
    } finally {
      usePetStoryStore.getState().stopPromptBatch();
      usePetStoryStore.setState(initial.petstory); useTaskStore.setState(initial.tasks); useAccountStore.setState(initial.accounts); useProjectStore.setState(initial.projects);
      vi.unstubAllGlobals();
    }
  });
  it('merges a stale-revision single final save while retaining the latest Chat candidate and other shots', async (): Promise<void> => {
    const shot = p.plan!.shots[1]; const oldRevision = p.revision;
    const prepared = await chats.prepare(p.id, optimizationPrompt(p, shot.id, 'firstFrame'), 'optimize', undefined, shot.id, 'firstFrame');
    const task = list()[0]; await runtime(task, JSON.stringify({ optimized: shot.prompts.firstFrame.optimized }));
    const job = prepared.project!.jobs.at(-1)!; await chats.bindRun(p.id, job.id, `TEST-run-${task.id}`); await chats.collect(p.id, job.id);
    const latest = await projects.read(p.id);
    const saved = await projects.saveShotPrompt(p.id, oldRevision, shot.id, 'firstFrame', shot.prompts.firstFrame.original);
    expect(saved.jobs).toEqual(latest.jobs);
    expect(saved.plan!.shots[1].prompts.firstFrame).toMatchObject({ optimized: shot.prompts.firstFrame.optimized, final: shot.prompts.firstFrame.original, edited: true });
    expect(saved.plan!.shots[2]).toEqual(latest.plan!.shots[2]);
    expect(list()).toHaveLength(1);
  });
  it('saves an explicit original-story edit without replacing plan/history, and rejects stale-story Chat bindings', async (): Promise<void> => {
    p.storyApproval = { hash: storyHash(p), at: new Date().toISOString() }; p = await projects.write(p);
    const shot = p.plan!.shots[0];
    const prepared = await chats.prepare(p.id, optimizationPrompt(p, shot.id, 'firstFrame'), 'optimize', undefined, shot.id, 'firstFrame');
    await expect(projects.saveOriginalStory(p.id, prepared.project!.revision, snapshot.mobileStory + '\n')).rejects.toThrow('Chat');
    const task = list()[0]; await runtime(task, JSON.stringify({ optimized: shot.prompts.firstFrame.optimized }));
    const job = prepared.project!.jobs.at(-1)!; await chats.bindRun(p.id, job.id, `TEST-run-${task.id}`); await chats.collect(p.id, job.id);
    p = await projects.read(p.id); p.jobs.at(-1)!.status = 'invalid'; p = await projects.write(p);
    const before = structuredClone(p);
    p = await projects.saveOriginalStory(p.id, p.revision, snapshot.mobileStory + '\n');
    expect(p.mobileStory!.id).not.toBe(before.mobileStory!.id); expect(p.mobileStory!.text).toBe(snapshot.mobileStory + '\n');
    expect(p.plan).toEqual(before.plan); expect(p.assets).toEqual(before.assets); expect(p.jobs).toEqual(before.jobs); expect(p.storyApproval).toBeUndefined();
    await expect(chats.bindRun(p.id, job.id, `TEST-run-${task.id}`)).rejects.toThrow('故事');
    const stale = await chats.collect(p.id, job.id); expect(stale.success).toBe(false); expect(stale.project!.plan).toEqual(before.plan); expect(tasks).toHaveLength(1);
  });
  it('lists and links only the exact same-shot historical image task, without creating generation or changing current finals', async (): Promise<void> => {
    const picture = path.join(root, 'TEST-historical-pixel.png');
    await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x96', '-frames:v', '1', '-y', picture]);
    // 旧快照先通过正式方案确认入口补齐素材清单，再上传并明确采用身份图。
    p.plan!.props = []; p.plan!.scenes = [{ id: 'original-village-road', name: '原村道', location: p.plan!.shots[0].scene, time: '原项目自然光', lighting: '原项目暖自然光', layout: '原项目村道路边', view: '原镜头视角', designOrigin: 'script' }];
    p.plan!.shots.forEach((shot): void => { shot.propIds = []; shot.sceneId = 'original-village-road'; });
    p = await projects.write(p); p = await projects.confirmStory(p.id, p.revision);
    for (const character of p.plan!.characters) {
      p = await projects.addReference(p.id, character.id, picture);
      const uploaded = p.assets.at(-1)!; expect(uploaded.imageReview?.state).toBe('candidate');
      p = await projects.approveMaterials(p.id, p.revision, [{ materialId: `character:${character.id}`, assetId: uploaded.id }]);
    }
    const shot = p.plan!.shots[0]; const body = shot.prompts.firstFrame.optimized;
    const request = await chats.prepare(p.id, optimizationPrompt(p, shot.id, 'firstFrame'), 'optimize', undefined, shot.id, 'firstFrame');
    const chatTask = list()[0]; await runtime(chatTask, JSON.stringify({ optimized: body }));
    const job = request.project!.jobs.at(-1)!; await chats.bindRun(p.id, job.id, `TEST-run-${chatTask.id}`); await chats.collect(p.id, job.id);
    p = await projects.read(p.id);
    const references = shot.characterIds.map((id: string): PetStoryProject['assets'][number] => p.assets.find((a): boolean => a.characterId === id)!);
    const lines = shot.characterIds.map((id: string, index: number): string => `第 ${index + 1} 张：${p.plan!.characters.find((c): boolean => c.id === id)!.name}身份与当前外观参考，不复制背景和姿势；明确换装以正文为准。`);
    const prompt = `生成一张静态首帧，呈现已确认的开始时刻，不拼贴多个动作阶段。\n${lines.join('\n')}\n\n${body}`;
    const attachments = await Promise.all(references.map((a): Promise<string> => projects.referenceFile(p.id, a.id)));
    const image = create({ prompts: [prompt], mode: 'image', promptReadback: 'exact', executionIntent: 'hold', projectId: p.studioProjectId, attachments }, p.accountId);
    await runtime(image); core.updateRuntime({ taskId: image.id, runtime: { submittedAt: new Date().toISOString() } }); core.updateStatus({ taskId: image.id, status: 'done', outputs: ['https://TEST.invalid/historical-five.png'] });
    const completed = list().find((t): boolean => t.id === image.id)!; const artifact = completed.artifacts![0]; const now = new Date().toISOString();
    const download: DownloadJob = { id: 'TEST-historical-download', taskId: image.id, accountId: p.accountId, mode: 'image', url: artifact.url, status: 'done', attempts: 1, saveDir: root, filePath: picture, createdAt: now, updatedAt: now };
    const media = new PetStoryExistingMediaService(projects, { list, downloads: (): DownloadJob[] => [download] });
    const candidates = await media.candidates(p.id, shot.id, 'firstFrame'); expect(candidates).toEqual([{ taskId: image.id, artifactId: artifact.id, createdAt: image.createdAt }]);
    expect(await media.candidates(p.id, p.plan!.shots[1].id, 'firstFrame')).toEqual([]);
    const before = structuredClone(p.plan); const count = tasks.length;
    const linked = await media.link(p.id, p.revision, shot.id, 'firstFrame', image.id, artifact.id);
    expect(linked.project!.plan).toEqual(before); expect(tasks).toHaveLength(count);
    const asset = linked.project!.assets.at(-1)!;
    expect(asset).toMatchObject({ origin: 'historical_task', generationPrompt: prompt, generationFinal: body, promptJobId: job.id, shotId: shot.id, taskId: image.id, artifactId: artifact.id, downloadJobId: download.id });
    expect(asset.validation!.decoded).toBe(true); expect(asset.generationFinal).not.toBe(shot.prompts.firstFrame.final);
    expect(asset.imageReview?.state).toBe('candidate'); expect(linked.project!.adoptedImages?.[shot.id]?.firstFrameId).toBeUndefined();
    expect((await media.link(p.id, linked.project!.revision, shot.id, 'firstFrame', image.id, artifact.id)).project!.assets).toHaveLength(linked.project!.assets.length);
    await expect(media.link(p.id, linked.project!.revision, p.plan!.shots[1].id, 'firstFrame', image.id, artifact.id)).rejects.toThrow('无法精确对应');
    const changed = list().find((t): boolean => t.id === image.id)!; changed.runtime!.input.attachments = [...attachments].reverse();
    tasks = tasks.map((t): Task => t.id === changed.id ? changed : t);
    expect(await media.candidates(p.id, shot.id, 'firstFrame')).toEqual([]);
  });
  it('rejects node generation against the unconfirmed legacy inventory without creating tasks', async (): Promise<void> => {
    const production = new PetStoryProductionService(projects, { list, create, adopt: (): Task => { throw new Error('TEST unexpected adoption'); }, retryUnsubmitted: (): Task => { throw new Error('TEST unexpected retry'); }, downloads: (): DownloadJob[] => [], download: async (): Promise<TaskDownloadOutputsResult> => ({ success: true, count: 0, failed: 0 }) });
    await expect(production.generateShotMedia(p.id, p.revision, p.plan!.shots[0].id, 'firstFrame', capability(true), {})).rejects.toThrow('确认');
    expect(tasks).toEqual([]); expect((await projects.read(p.id)).production).toBeUndefined();
  });
  it('generates only the clicked first-frame node, and video/tail buttons never silently generate missing predecessors', async (): Promise<void> => {
    const picture = path.join(root, 'TEST-technical-pixel.png');
    await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x96', '-frames:v', '1', '-y', picture]);
    // 只补测试所需的关系字段，故事、五镜动作/时长/模式及13项正文保持原快照。
    p.plan!.props = []; p.plan!.scenes = [{ id: 'original-village-road', name: '原村道', location: p.plan!.shots[0].scene, time: '原项目自然光', lighting: '原项目暖自然光', layout: '原项目村道路边', view: '原镜头视角', designOrigin: 'script' }];
    p.plan!.shots.forEach((s): void => { s.propIds = []; s.sceneId = 'original-village-road'; });
    p = await projects.write(p);
    p = await projects.confirmStory(p.id, p.revision);
    for (const character of p.plan!.characters) {
      p = await projects.addReference(p.id, character.id, picture);
      p = await projects.approveMaterials(p.id, p.revision, [{ materialId: `character:${character.id}`, assetId: p.assets.at(-1)!.id }]);
    }
    p = await projects.addMaterialImage(p.id, p.revision, 'scene:original-village-road', picture);
    p = await projects.approveMaterials(p.id, p.revision, [{ materialId: 'scene:original-village-road', assetId: p.assets.at(-1)!.id }]);
    const downloads: DownloadJob[] = [];
    const production = new PetStoryProductionService(projects, { list, create, adopt: (): Task => { throw new Error('TEST unexpected adoption'); }, retryUnsubmitted: (): Task => { throw new Error('TEST unexpected retry'); }, downloads: (): DownloadJob[] => downloads,
      download: async (params: TaskDownloadOutputsParams): Promise<TaskDownloadOutputsResult> => { const output = params.outputs[0]; const now = new Date().toISOString(); const job: DownloadJob = { id: 'TEST-five-download', taskId: output.taskId, accountId: p.accountId, mode: output.mode, url: output.outputs[0], status: 'done', attempts: 1, saveDir: root, filePath: picture, createdAt: now, updatedAt: now }; downloads.push(job); return { success: true, count: 1, failed: 0, jobIds: [job.id] }; } });
    const continuousShotId = p.plan!.shots[1].id;
    await expect(production.generateShotMedia(p.id, p.revision, continuousShotId, 'video', capability(), {})).rejects.toThrow('首帧');
    await expect(production.generateShotMedia(p.id, p.revision, continuousShotId, 'lastFrame', capability(true), {})).rejects.toThrow('首帧');
    expect(tasks).toEqual([]);
    seedOfflinePromptContracts(p); p = await projects.write(p);
    await expect(production.generateShotMedia(p.id, p.revision, continuousShotId, 'firstFrame', capability(true), {})).rejects.toThrow('前镜实际视频／末帧');
    expect(tasks).toEqual([]);
    // 同一原五镜头中，cut节点可独立生成；continue保留真实前镜依赖，不能假造末帧。
    const shotId = p.plan!.shots[0].id;
    await production.generateShotMedia(p.id, p.revision, shotId, 'firstFrame', capability(true), {});
    const prepared = await production.advance(p.id); expect(prepared.action).toBe('start');
    const task = list()[0]; expect(task.mode).toBe('image'); expect(task.petstory?.stepId).toBeTruthy();
    expect(task.prompt).toContain(p.plan!.shots[0].prompts.firstFrame.final);
    await runtime(task); await production.bindRun(p.id, task.id, `TEST-run-${task.id}`);
    expect(core.updateRuntime({ taskId: task.id, runtime: { submittedAt: new Date().toISOString() } }).success).toBe(true);
    expect(core.updateStatus({ taskId: task.id, status: 'done', outputs: ['https://TEST.invalid/five-node.png'] }).success).toBe(true);
    expect((await production.advance(p.id)).success).toBe(true);
    const completed = await production.advance(p.id);
    expect(completed.project!.production).toMatchObject({ state: 'complete', target: { shotId, kind: 'firstFrame' } });
    expect(completed.project!.production!.steps).toHaveLength(1); expect(tasks).toHaveLength(1);
    expect(completed.project!.production!.shots[shotId].firstFrameId).toBeUndefined();
    const generated = completed.project!.assets.find((asset): boolean => asset.shotId === shotId && asset.kind === 'firstFrame')!;
    expect(generated.imageReview?.state).toBe('candidate'); expect(completed.project!.adoptedImages?.[shotId]?.firstFrameId).toBeUndefined();
    expect(completed.project!.production!.shots[shotId].plannedEndImageId).toBeUndefined(); expect(completed.project!.production!.shots[shotId].videoId).toBeUndefined();
    p = completed.project!;
    await expect(production.generateShotMedia(p.id, p.revision, continuousShotId, 'video', capability(), {})).rejects.toThrow('首帧');
    expect(tasks).toHaveLength(1);
    const oldTask = list()[0]; const oldProduction = structuredClone(p.production);
    expect(generated.generationFinal).toBe(p.plan!.shots[0].prompts.firstFrame.final);
    p = await projects.adoptImage(p.id, p.revision, { shotId, kind: 'firstFrame' }, generated.id);
    expect(p.adoptedImages?.[shotId]?.firstFrameId).toBe(generated.id);
    expect(p.assets.find((asset): boolean => asset.id === generated.id)?.imageReview?.state).toBe('adopted');
    p = await projects.savePlan(p.id, p.revision, p.plan!);
    expect(p.production).toBeUndefined(); expect(p.productionHistory!.at(-1)).toEqual(oldProduction);
    const chat = await chats.prepare(p.id, optimizationPrompt(p, shotId, 'firstFrame'), 'optimize', undefined, shotId, 'firstFrame');
    expect(chat.success).toBe(true); expect(list()[0]).toEqual(oldTask); expect(list()).toHaveLength(2); expect(list()[1].mode).toBe('chat');
  });
});
