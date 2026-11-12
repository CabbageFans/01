/** 本地用户视频导入：真实文件解码、项目保存、来源与历史边界，不访问平台。 */
import fs from 'node:fs/promises';
import type { PathLike } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PetStoryPlan, PetStoryProduction, PetStoryProject } from '@doubao-studio/contracts';
import { PetStoryProjects, validateProject } from '../../main/utils/petstoryProject';
import { PetStoryProductionService, productionPlanHash } from '../../main/utils/petstoryProduction';
import { mediaCommand, mediaDigest, validatePetStoryMedia } from '../../main/utils/petstoryMedia';
import { imageTargetBasis, selectedShotImageId } from '../../main/utils/petstoryImageReview';

let root: string; let video: string; let short: string; let long: string; let picture: string; let part2: string;
beforeAll(async (): Promise<void> => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-shot-video-upload-'));
  video = path.join(root, 'video.mp4'); short = path.join(root, 'short.mp4'); long = path.join(root, 'long.mp4'); picture = path.join(root, 'frame.png');
  part2 = path.join(root, 'TEST-mpeg4-part2.mp4');
  await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=32x48:r=5:d=5', '-c:v', 'mpeg4', '-y', part2]);
  await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=32x48', '-frames:v', '1', '-y', picture]);
  for (const [duration, file] of [[5, video], [4, short], [11, long]] as const) {
    await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=blue:s=32x48:r=5:d=${duration}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file]);
  }
});
afterAll(async (): Promise<void> => { await fs.rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<{ projects: PetStoryProjects; p: PetStoryProject }> {
  const directory = await fs.mkdtemp(path.join(root, 'project-')); const projects = new PetStoryProjects();
  let p = await projects.create(directory, 'TEST-studio', 'TEST-account');
  const prompt = { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST' };
  p.plan = { sourceSummary: 'TEST', adaptedStory: 'TEST门逐渐打开', characters: [], props: [], scenes: [{ id: 'hall', name: '展厅', location: '展厅', time: '白天', lighting: '自然光', layout: '门在左', view: '平视', designOrigin: 'script' }],
    shots: [1, 2, 3].map((order: number): PetStoryPlan['shots'][number] => ({ id: `shot-${order}`, order, characterIds: [], propIds: [], sceneId: 'hall', scene: '展厅', action: '门打开', startState: '门关闭', endState: '门开启', durationSeconds: 5,
      transition: order === 2 ? 'continue' : 'cut', previousShotId: order === 2 ? 'shot-1' : undefined, requestedMode: 'first_frame', prompts: { firstFrame: structuredClone(prompt), video: structuredClone(prompt) } })) };
  p = await projects.write(p); return { projects, p };
}
function production(p: PetStoryProject, state: 'running' | 'paused' | 'complete'): PetStoryProduction {
  const supported = { state: 'supported' as const, reason: 'TEST' };
  return { phase: 'shots', state, planHash: productionPlanHash(p.plan!), approvedAt: new Date().toISOString(), steps: [], message: 'TEST原制作',
    capability: { accountId: p.accountId, image: supported, modes: { first_frame: supported, first_last_frame: supported, reference: supported }, durations: [5, 6, 7, 8, 9, 10] }, fallbacks: {},
    shots: Object.fromEntries(p.plan!.shots.map((shot: PetStoryPlan['shots'][number]): [string, PetStoryProduction['shots'][string]] => [shot.id, { requestedMode: shot.requestedMode, resolvedMode: 'first_frame', reason: 'TEST' }])) };
}

describe('镜头视频上传', (): void => {
  it('无提示词、无文字任务和未确认基础图仍能保存MP4，重开和本地播放不伪造平台来源', async (): Promise<void> => {
    const f = await fixture(); const p = await f.projects.addShotVideo(f.p.id, f.p.revision, 'shot-1', video); const asset = p.assets.at(-1)!;
    expect(asset).toMatchObject({ kind: 'video', shotId: 'shot-1', origin: 'user_upload', validation: { decoded: true, durationSeconds: 5 }, uploadSource: { projectId: p.id, accountId: p.accountId, shotId: 'shot-1' } });
    for (const key of ['taskId', 'runId', 'artifactId', 'downloadJobId', 'sourceSnapshot', 'generationPrompt'] as const) expect(asset[key]).toBeUndefined();
    expect(p.jobs).toEqual([]); expect(p.selectedVideos?.['shot-1']).toBe(asset.id);
    const savedFile = path.join(f.projects.directory(p.id), asset.relativePath);
    expect((await mediaDigest(savedFile)).sha256).toBe((await mediaDigest(video)).sha256);
    const reopened = await new PetStoryProjects().open(f.projects.directory(p.id)); expect(reopened.selectedVideos).toEqual(p.selectedVideos);
    const create = vi.fn(); const service = new PetStoryProductionService(f.projects, { updateLocalMedia: vi.fn(), list: (): [] => [], create, adopt: vi.fn(), retryUnsubmitted: vi.fn(), downloads: (): [] => [], download: vi.fn() });
    expect(await service.assetFile(reopened, asset.id, 'video')).toBe(await fs.realpath(savedFile)); expect(create).not.toHaveBeenCalled();
    await fs.copyFile(short, savedFile); await expect(service.assetFile(reopened, asset.id, 'video')).rejects.toThrow('文件发生变化');
  });
  it('仅上传拒绝真实播放器不支持的MPEG4 Part2，H264保留正常上传且不改变源文件', async (): Promise<void> => {
    const f = await fixture(); const before = await fs.readFile(path.join(f.projects.directory(f.p.id), 'project.json'), 'utf8');
    const original = await mediaDigest(part2);
    // 历史平台媒体的通用解码规则不因上传限制而变化。
    expect((await validatePetStoryMedia(part2, 'video')).decoded).toBe(true);
    await expect(f.projects.addShotVideo(f.p.id, f.p.revision, 'shot-1', part2)).rejects.toThrow('H.264');
    expect(await mediaDigest(part2)).toEqual(original); expect(await fs.readFile(path.join(f.projects.directory(f.p.id), 'project.json'), 'utf8')).toBe(before);
    const uploaded = await f.projects.addShotVideo(f.p.id, f.p.revision, 'shot-1', video);
    expect(uploaded.assets.at(-1)).toMatchObject({ kind: 'video', origin: 'user_upload', validation: { decoded: true, durationSeconds: 5 } });
  });
  it.each(['unrelated', 'target'] as const)('复制期间发生%s写盘，仍保留新进度且只在目标未变化时保存上传', async (change: 'unrelated' | 'target'): Promise<void> => {
    const f = await fixture(); const originalCopy = fs.copyFile.bind(fs); let copied: PathLike | undefined;
    const copy = vi.spyOn(fs, 'copyFile').mockImplementationOnce(async (sourceFile: PathLike, destination: PathLike, mode?: number): Promise<void> => {
      await originalCopy(sourceFile, destination, mode); copied = destination;
      const background = await f.projects.read(f.p.id);
      if (change === 'target') background.plan!.shots[0].action = 'TEST复制期间镜头已改';
      else background.promptModel = 'seedance-2.0';
      await f.projects.write(background);
    });
    try {
      if (change === 'target') {
        await expect(f.projects.addShotVideo(f.p.id, f.p.revision, 'shot-1', video)).rejects.toThrow('已变化');
        const saved = await f.projects.read(f.p.id); expect(saved.plan!.shots[0].action).toBe('TEST复制期间镜头已改'); expect(saved.assets).toEqual([]);
        expect(copied).toBeDefined(); await expect(fs.stat(copied!)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        const saved = await f.projects.addShotVideo(f.p.id, f.p.revision, 'shot-1', video);
        expect(saved.promptModel).toBe('seedance-2.0'); expect(saved.selectedVideos?.['shot-1']).toBe(saved.assets.at(-1)!.id);
        expect(saved.jobs).toEqual([]); expect(saved.taskIntents).toBeUndefined();
      }
    } finally { copy.mockRestore(); }
  });
  it.each(['running', 'paused'] as const)('原%s制作必须先明确结束，上传不改原任务或选中视频', async (state: 'running' | 'paused'): Promise<void> => {
    const f = await fixture(); f.p.production = production(f.p, state); f.p = await f.projects.write(f.p);
    const before = await fs.readFile(path.join(f.projects.directory(f.p.id), 'project.json'), 'utf8');
    await expect(f.projects.addShotVideo(f.p.id, f.p.revision, 'shot-1', video)).rejects.toThrow('请先结束本次制作');
    expect(await fs.readFile(path.join(f.projects.directory(f.p.id), 'project.json'), 'utf8')).toBe(before);
    const service = new PetStoryProductionService(f.projects, { updateLocalMedia: vi.fn(), list: (): [] => [], create: vi.fn(), adopt: vi.fn(), retryUnsubmitted: vi.fn(), downloads: (): [] => [], download: vi.fn() });
    const ended = await service.end(f.p.id); const p = await f.projects.addShotVideo(f.p.id, ended.project!.revision, 'shot-1', video);
    expect(p.production).toBeUndefined(); expect(p.productionHistory).toHaveLength(1); expect(p.productionHistory![0].state).toBe('ended');
    expect(p.selectedVideos?.['shot-1']).toBe(p.assets.at(-1)!.id);
  });
  it.each([
    { state: 'paused', stage: 'failed' },
    { state: 'running', stage: 'generating' },
  ] as const)('独立图片制作 $state/$stage 不阻塞本地视频上传，原图片操作与选图均保留', async (input: { state: 'paused' | 'running'; stage: 'failed' | 'generating' }): Promise<void> => {
    const f = await fixture(); let p = f.p; const target = { shotId: 'shot-3', kind: 'firstFrame' as const };
    const validation = await validatePetStoryMedia(picture, 'image'); const relativePath = 'shots/shot-3/TEST-selected-frame.png';
    const destination = path.join(f.projects.directory(p.id), relativePath); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(picture, destination);
    p.assets.push({ id: 'TEST-selected-frame', kind: 'firstFrame', shotId: target.shotId, relativePath, validation,
      imageReview: { state: 'adopted', target, basisHash: imageTargetBasis(p, target), adoptedAt: new Date().toISOString(), sha256: validation.sha256 } });
    p.adoptedImages = { 'shot-3': { firstFrameId: 'TEST-selected-frame' } };
    const operationId = 'TEST-existing-image-operation';
    p.imageOperations = [{ id: operationId, requestId: 'TEST-existing-image-request', target, mode: 'generate', stage: input.stage,
      createdAt: new Date().toISOString(), basisHash: imageTargetBasis(p, target), taskId: 'TEST-existing-image-task',
      ...(input.stage === 'failed' ? { error: 'TEST原图片任务已暂停' } : {}) }];
    p.imageProductions = { [operationId]: { ...production(p, input.state), imageOperationId: operationId, target: { shotId: target.shotId, kind: target.kind },
      steps: [{ id: 'TEST-existing-image-step', kind: target.kind, shotId: target.shotId, status: 'bound', taskId: 'TEST-existing-image-task', runId: 'TEST-existing-image-run', attachmentAssetIds: [], inputHash: '0'.repeat(64) }] } };
    p = await f.projects.write(p); const before = structuredClone(p);
    const uploaded = await f.projects.addShotVideo(p.id, p.revision, 'shot-1', video);
    const asset = uploaded.assets.at(-1)!;
    expect(asset).toMatchObject({ kind: 'video', shotId: 'shot-1', origin: 'user_upload' }); expect(asset.taskId).toBeUndefined(); expect(asset.runId).toBeUndefined();
    expect(uploaded.selectedVideos?.['shot-1']).toBe(asset.id); expect(uploaded.production).toBeUndefined();
    expect(uploaded.imageOperations).toEqual(before.imageOperations); expect(uploaded.imageProductions).toEqual(before.imageProductions);
    expect(uploaded.productionHistory).toEqual(before.productionHistory); expect(uploaded.jobs).toEqual(before.jobs); expect(uploaded.taskIntents).toEqual(before.taskIntents);
    expect(uploaded.adoptedImages).toEqual(before.adoptedImages); expect(uploaded.assets[0]).toEqual(before.assets[0]); expect(selectedShotImageId(uploaded, 'shot-3', 'firstFrame')).toBe('TEST-selected-frame');
    const reopened = await f.projects.read(p.id); expect(reopened.imageOperations).toEqual(before.imageOperations); expect(reopened.imageProductions).toEqual(before.imageProductions);
    expect((await fs.stat(destination)).isFile()).toBe(true);
  });
  it.each([
    { state: 'paused', type: 'target' },
    { state: 'running', type: 'target' },
    { state: 'paused', type: 'operation' },
    { state: 'running', type: 'materials' },
    { state: 'complete', type: 'target' },
  ] as const)('旧公共槽图片制作 $state/$type 不阻塞上传，也不自动结束或迁移原制作', async (input: { state: 'paused' | 'running' | 'complete'; type: 'target' | 'operation' | 'materials' }): Promise<void> => {
    const f = await fixture(); let p = f.p;
    p.production = { ...production(p, input.state),
      ...(input.type === 'target' ? { target: { shotId: 'shot-3', kind: 'firstFrame' as const } } : {}),
      ...(input.type === 'operation' ? { imageOperationId: 'TEST-legacy-image-operation' } : {}),
      ...(input.type === 'materials' ? { phase: 'materials' as const } : {}),
      steps: [{ id: 'TEST-legacy-image-step', kind: 'firstFrame', shotId: 'shot-3', status: 'bound', taskId: 'TEST-legacy-image-task', runId: 'TEST-legacy-image-run', attachmentAssetIds: [], inputHash: '0'.repeat(64) }] };
    // 完成图片制作也不因本地视频上传而被挪入历史。
    if (input.state === 'complete') p.production.steps[0].status = 'complete';
    p = await f.projects.write(p); const before = structuredClone(p);
    const uploaded = await f.projects.addShotVideo(p.id, p.revision, 'shot-1', video);
    expect(uploaded.assets.at(-1)).toMatchObject({ kind: 'video', origin: 'user_upload', shotId: 'shot-1' });
    expect(uploaded.selectedVideos?.['shot-1']).toBe(uploaded.assets.at(-1)!.id);
    expect(uploaded.production).toEqual(before.production); expect(uploaded.productionHistory).toEqual(before.productionHistory);
    expect(uploaded.imageOperations).toEqual(before.imageOperations); expect(uploaded.imageProductions).toEqual(before.imageProductions);
    expect(uploaded.jobs).toEqual(before.jobs); expect(uploaded.taskIntents).toEqual(before.taskIntents); expect(uploaded.adoptedImages).toEqual(before.adoptedImages);
    expect((await f.projects.read(p.id)).production).toEqual(before.production);
  });
  it.each(['video-target', 'video-step', 'unknown-batch'] as const)('%s 未结束时仍保护原视频或未知整批授权', async (type: 'video-target' | 'video-step' | 'unknown-batch'): Promise<void> => {
    const f = await fixture(); let p = f.p;
    p.production = { ...production(p, 'paused'),
      ...(type === 'video-target' ? { phase: 'materials' as const, imageOperationId: 'TEST-video-is-not-image', target: { shotId: 'shot-1', kind: 'video' as const } } : {}),
      ...(type === 'video-step' ? { target: { shotId: 'shot-1', kind: 'firstFrame' as const } } : {}),
      steps: [{ id: 'TEST-original-step', kind: type === 'video-step' ? 'video' : 'firstFrame', shotId: 'shot-1', status: 'bound', taskId: 'TEST-original-task', runId: 'TEST-original-run', attachmentAssetIds: [], inputHash: '0'.repeat(64) }] };
    p = await f.projects.write(p); const before = await fs.readFile(path.join(f.projects.directory(p.id), 'project.json'), 'utf8');
    await expect(f.projects.addShotVideo(p.id, p.revision, 'shot-1', video)).rejects.toThrow('请先结束本次制作');
    expect(await fs.readFile(path.join(f.projects.directory(p.id), 'project.json'), 'utf8')).toBe(before);
  });
  it('再次上传保留旧视频和制作历史，仅标记实际连续依赖的旧视频', async (): Promise<void> => {
    const f = await fixture(); let p = await f.projects.addShotVideo(f.p.id, f.p.revision, 'shot-1', video); const first = p.assets.at(-1)!;
    p = await f.projects.addShotVideo(p.id, p.revision, 'shot-2', video); const dependent = p.assets.at(-1)!;
    p = await f.projects.addShotVideo(p.id, p.revision, 'shot-3', video); const independent = p.assets.at(-1)!;
    p.production = production(p, 'complete'); const history = structuredClone(p.production); p = await f.projects.write(p);
    p = await f.projects.addShotVideo(p.id, p.revision, 'shot-1', video);
    expect(p.assets).toHaveLength(4); expect(p.assets.find((asset): boolean => asset.id === first.id)).toEqual(first);
    expect(p.assets.find((asset): boolean => asset.id === dependent.id)?.needsReview).toBe(true);
    expect(p.assets.find((asset): boolean => asset.id === independent.id)?.needsReview).toBeUndefined();
    expect(p.production).toBeUndefined(); expect(p.productionHistory).toEqual([history]);
    expect(p.selectedVideos).toEqual({ 'shot-1': p.assets.at(-1)!.id, 'shot-2': dependent.id, 'shot-3': independent.id });
  });
  it('拒绝过期项目、其他镜头、短/长/损坏文件和符号链接，不改变原选择', async (): Promise<void> => {
    const f = await fixture(); const p = await f.projects.addShotVideo(f.p.id, f.p.revision, 'shot-1', video);
    const invalid = path.join(root, 'invalid.mp4'); const link = path.join(root, 'link.mp4'); const png = path.join(root, 'image.png'); const nonMp4 = path.join(root, 'TEST-matroska-named-mp4.mp4');
    await fs.writeFile(invalid, 'TEST不是视频'); await fs.symlink(video, link); await fs.copyFile(video, png);
    await mediaCommand('ffmpeg', ['-v', 'error', '-i', video, '-c', 'copy', '-f', 'matroska', '-y', nonMp4]);
    const before = await fs.readFile(path.join(f.projects.directory(p.id), 'project.json'), 'utf8');
    const originalAsset = p.assets.at(-1)!; const originalFile = path.join(f.projects.directory(p.id), originalAsset.relativePath); const originalDigest = await mediaDigest(originalFile);
    await expect(f.projects.addShotVideo(p.id, p.revision - 1, 'shot-1', video)).rejects.toThrow('版本');
    await expect(f.projects.addShotVideo(p.id, p.revision, 'foreign-shot', video)).rejects.toThrow('镜头不存在');
    for (const file of [short, long, nonMp4]) {
      await expect(f.projects.addShotVideo(p.id, p.revision, 'shot-1', file)).rejects.toThrow('请选择实际时长 5～10 秒的 MP4 视频，原视频保持不变。');
      await expect(validatePetStoryMedia(file, 'video')).rejects.toThrow('真实视频必须为 MP4、实际时长 5～10 秒；素材保留并阻断下游，不重新生成');
    }
    for (const file of [invalid, link, png]) await expect(f.projects.addShotVideo(p.id, p.revision, 'shot-1', file)).rejects.toThrow();
    expect(await fs.readFile(path.join(f.projects.directory(p.id), 'project.json'), 'utf8')).toBe(before);
    expect((await f.projects.read(p.id)).selectedVideos?.['shot-1']).toBe(originalAsset.id); expect(await mediaDigest(originalFile)).toEqual(originalDigest);
  });
  it('替换前镜视频后，依赖旧视频边界的已采用关键帧保留历史并退出活跃读取', async (): Promise<void> => {
    const f = await fixture(); let p = await f.projects.addShotVideo(f.p.id, f.p.revision, 'shot-1', video);
    const validation = await validatePetStoryMedia(picture, 'image'); const target = { shotId: 'shot-2', kind: 'firstFrame' as const };
    const relativePath = 'shots/shot-2/TEST-adopted-frame.png'; const destination = path.join(f.projects.directory(p.id), relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(picture, destination);
    p.assets.push({ id: 'TEST-adopted-frame', kind: 'firstFrame', shotId: 'shot-2', relativePath, validation,
      imageReview: { state: 'adopted', target, basisHash: imageTargetBasis(p, target), adoptedAt: new Date().toISOString(), sha256: validation.sha256 } });
    p.adoptedImages = { 'shot-2': { firstFrameId: 'TEST-adopted-frame' } }; p = await f.projects.write(p);
    expect(selectedShotImageId(p, 'shot-2', 'firstFrame')).toBe('TEST-adopted-frame');
    p = await f.projects.addShotVideo(p.id, p.revision, 'shot-1', video);
    expect(selectedShotImageId(p, 'shot-2', 'firstFrame')).toBeUndefined();
    expect(p.assets.find((asset): boolean => asset.id === 'TEST-adopted-frame')).toMatchObject({ visualBasisStale: true, imageReview: { state: 'adopted' } });
    expect((await fs.stat(destination)).isFile()).toBe(true);
  });
  it('上传来源不能跨项目、镜头、摘要或伪装任务；删除原镜头仍保留历史媒体', async (): Promise<void> => {
    const f = await fixture(); const p = await f.projects.addShotVideo(f.p.id, f.p.revision, 'shot-1', video);
    for (const field of ['projectId', 'accountId', 'shotId', 'sha256'] as const) {
      const invalid = structuredClone(p); invalid.assets[0].uploadSource![field] = 'TEST-mismatched';
      expect((): PetStoryProject => validateProject(invalid)).toThrow('上传视频来源记录不符');
    }
    const invalid = structuredClone(p); invalid.assets[0].taskId = 'TEST-fake-task'; expect((): PetStoryProject => validateProject(invalid)).toThrow('上传视频来源记录不符');
    const historical = structuredClone(p); historical.plan!.shots.shift(); historical.plan!.shots[0].transition = 'cut'; historical.plan!.shots[0].previousShotId = undefined;
    historical.plan!.shots.forEach((shot: PetStoryPlan['shots'][number], index: number): void => { shot.order = index + 1; });
    expect(validateProject(historical).assets).toEqual(p.assets);
  });
});
