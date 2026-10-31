/** 真实文件与项目存储的图片采用门；不调用平台或模型。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PetStoryPlan, PetStoryProject, PetStoryPrompt } from '@doubao-studio/contracts';
import { PetStoryProjects, validateProject } from '../../main/utils/petstoryProject';
import { mediaCommand } from '../../main/utils/petstoryMedia';
import { isPetStoryImageAdopted, selectedShotImageId } from '../../main/utils/petstoryImageReview';
import { materialAsset } from '../../main/utils/petstoryMaterials';

let root: string; let red: string; let blue: string;
const prompt = (): PetStoryPrompt => ({ original: '', optimized: '', final: 'TEST 离线正文', edited: true, rulesVersion: 'TEST' });
function plan(): PetStoryPlan {
  return { sourceSummary: 'TEST', adaptedStory: 'TEST', characters: [{ id: 'actor', name: '测试角色', role: 'main', purpose: 'TEST', description: '红衣' }],
    props: [{ id: 'box', name: '测试盒', description: '方形', aliases: [], keyStates: '闭合', scale: '手持', designOrigin: 'script' }],
    scenes: [{ id: 'room', name: '测试房间', location: '室内', time: '白天', lighting: '自然光', layout: '窗在左', view: '正面', designOrigin: 'script' }],
    shots: [1, 2].map((order): PetStoryPlan['shots'][number] => ({ id: `shot-${order}`, order, characterIds: ['actor'], propIds: ['box'], propStates: [{ propId: 'box', holderId: 'actor', state: '手持闭合盒子' }], sceneId: 'room', scene: '室内',
      action: '放下盒子', startState: '拿盒子', endState: '盒子落桌', durationSeconds: 5, transition: 'cut', requestedMode: 'first_last_frame', prompts: { firstFrame: prompt(), lastFrame: prompt(), video: prompt() } })) };
}
async function fixture(): Promise<{ projects: PetStoryProjects; p: PetStoryProject }> {
  const projects = new PetStoryProjects(); const dir = await fs.mkdtemp(path.join(root, 'project-'));
  let p = await projects.create(dir, 'TEST-studio', 'TEST-account');
  p = await projects.saveOriginalStory(p.id, p.revision, 'TEST 原文'); p.plan = plan(); p.source.status = 'review_required'; p = await projects.write(p);
  return { projects, p: await projects.confirmStory(p.id, p.revision) };
}
beforeAll(async (): Promise<void> => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-image-adoption-')); red = path.join(root, 'red.png'); blue = path.join(root, 'blue.png');
  for (const [color, file] of [['red', red], ['blue', blue]]) await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=64x96`, '-frames:v', '1', '-y', file]);
});
afterAll(async (): Promise<void> => { await fs.rm(root, { recursive: true, force: true }); });

describe('图片候选与明确采用', (): void => {
  it('多图选一只确认所选图，其余同目标图片结束待选并在重开后保持为历史备选', async (): Promise<void> => {
    const f = await fixture(); let p = await f.projects.addMaterialImage(f.p.id, f.p.revision, 'prop:box', red);
    const first = p.assets.at(-1)!;
    p = await f.projects.addMaterialImage(p.id, p.revision, 'prop:box', blue); const second = p.assets.at(-1)!;
    p = await f.projects.addMaterialImage(p.id, p.revision, 'scene:room', blue); const otherTarget = p.assets.at(-1)!;
    p = await f.projects.approveMaterials(p.id, p.revision, [{ materialId: 'prop:box', assetId: first.id }]);
    const chosen = p.assets.find((asset): boolean => asset.id === first.id)!;
    expect(chosen.imageReview).toMatchObject({ state: 'adopted', resolvedCandidateIds: [second.id] });
    expect(p.assets.find((asset): boolean => asset.id === second.id)?.imageReview?.state).toBe('candidate');
    expect(isPetStoryImageAdopted(p, p.assets.find((asset): boolean => asset.id === second.id)!)).toBe(false);
    expect(p.assets.find((asset): boolean => asset.id === otherTarget.id)?.imageReview?.state).toBe('candidate');
    expect((await f.projects.open(f.projects.directory(p.id))).assets).toEqual(p.assets);
    // 后续新上传不篡改原决定，只有下一次明确采用才结束它的待选。
    p = await f.projects.addMaterialImage(p.id, p.revision, 'prop:box', red); const fresh = p.assets.at(-1)!;
    expect(p.assets.find((asset): boolean => asset.id === first.id)?.imageReview?.resolvedCandidateIds).toEqual([second.id]);
    p = await f.projects.adoptImage(p.id, p.revision, { materialId: 'prop:box' }, second.id);
    expect(p.assets.find((asset): boolean => asset.id === second.id)?.imageReview?.resolvedCandidateIds).toEqual([first.id, fresh.id]);
    expect(p.materials!.find((material): boolean => material.id === 'prop:box')?.selectedAssetId).toBe(second.id);
    expect(p.assets).toHaveLength(4);
  });
  it('首帧选图决定不混入同镜尾帧和其他镜头，连续采用保留旧批次记录', async (): Promise<void> => {
    const f = await fixture(); let p = await f.projects.addShotImage(f.p.id, f.p.revision, 'shot-1', 'firstFrame', red);
    const first = p.assets.at(-1)!;
    p = await f.projects.addShotImage(p.id, p.revision, 'shot-1', 'firstFrame', blue); const alternative = p.assets.at(-1)!;
    p = await f.projects.addShotImage(p.id, p.revision, 'shot-1', 'lastFrame', red);
    p = await f.projects.addShotImage(p.id, p.revision, 'shot-2', 'firstFrame', red);
    p = await f.projects.adoptImage(p.id, p.revision, { shotId: 'shot-1', kind: 'firstFrame' }, first.id);
    expect(p.assets.find((asset): boolean => asset.id === first.id)?.imageReview?.resolvedCandidateIds).toEqual([alternative.id]);
    p = await f.projects.addShotImage(p.id, p.revision, 'shot-1', 'firstFrame', blue); const revised = p.assets.at(-1)!;
    p = await f.projects.adoptImage(p.id, p.revision, { shotId: 'shot-1', kind: 'firstFrame' }, revised.id);
    expect(p.assets.find((asset): boolean => asset.id === revised.id)?.imageReview?.resolvedCandidateIds).toEqual([first.id, alternative.id]);
    expect(p.assets.find((asset): boolean => asset.id === first.id)?.imageReview?.state).toBe('adopted');
    expect(p.assets.find((asset): boolean => asset.id === alternative.id)?.imageReview?.state).toBe('candidate');
  });
  it('无效选图决定不能跨目标、引用缺失图片、重复或伪装为候选确认', async (): Promise<void> => {
    const f = await fixture(); let p = await f.projects.addMaterialImage(f.p.id, f.p.revision, 'prop:box', red); const first = p.assets.at(-1)!;
    p = await f.projects.addMaterialImage(p.id, p.revision, 'prop:box', blue); const alternative = p.assets.at(-1)!;
    p = await f.projects.addMaterialImage(p.id, p.revision, 'scene:room', red); const foreign = p.assets.at(-1)!;
    p = await f.projects.adoptImage(p.id, p.revision, { materialId: 'prop:box' }, first.id);
    for (const ids of [[foreign.id], ['TEST-missing'], [first.id], [alternative.id, alternative.id]]) {
      const invalid = structuredClone(p); invalid.assets.find((asset): boolean => asset.id === first.id)!.imageReview!.resolvedCandidateIds = ids;
      expect((): PetStoryProject => validateProject(invalid)).toThrow('候选归属无效');
    }
    const invalid = structuredClone(p); invalid.assets.find((asset): boolean => asset.id === alternative.id)!.imageReview!.resolvedCandidateIds = [];
    expect((): PetStoryProject => validateProject(invalid)).toThrow('候选归属无效');
  });
  it.each(['character:actor', 'prop:box', 'scene:room'])('%s 上传只保存候选，明确采用才更新归属，替换前保留当前图', async (materialId): Promise<void> => {
    const f = await fixture(); let p = await f.projects.addMaterialImage(f.p.id, f.p.revision, materialId, red);
    const first = p.assets.at(-1)!;
    expect(first.imageReview).toMatchObject({ state: 'candidate', target: { materialId } });
    expect(p.materials!.find((m): boolean => m.id === materialId)?.selectedAssetId).toBeUndefined();
    expect((): unknown => materialAsset(p, materialId)).toThrow();
    p = await f.projects.approveMaterials(p.id, p.revision, [{ materialId, assetId: first.id }]);
    const approved = structuredClone(p.materials!.find((m): boolean => m.id === materialId)!.approved);
    expect(isPetStoryImageAdopted(p, p.assets[0])).toBe(true);
    p = await f.projects.addMaterialImage(p.id, p.revision, materialId, blue); const replacement = p.assets.at(-1)!;
    expect(p.materials!.find((m): boolean => m.id === materialId)).toMatchObject({ selectedAssetId: first.id, approved });
    const unchanged = await f.projects.selectMaterialImage(p.id, p.revision, materialId, replacement.id);
    expect(unchanged.revision).toBe(p.revision); expect(unchanged.materials!.find((m): boolean => m.id === materialId)?.selectedAssetId).toBe(first.id);
    p = await f.projects.adoptImage(p.id, p.revision, { materialId }, replacement.id);
    expect(p.materials!.find((m): boolean => m.id === materialId)?.selectedAssetId).toBe(replacement.id);
    expect(p.assets.some((a): boolean => a.id === first.id)).toBe(true);
    expect((await f.projects.open(f.projects.directory(p.id))).assets).toEqual(p.assets);
  });
  it('首尾帧上传待确认，采用只更新指定镜头与用途，旧图保持历史', async (): Promise<void> => {
    const f = await fixture(); let p = await f.projects.addShotImage(f.p.id, f.p.revision, 'shot-1', 'firstFrame', red);
    const first = p.assets.at(-1)!; expect(selectedShotImageId(p, 'shot-1', 'firstFrame')).toBeUndefined();
    p = await f.projects.adoptImage(p.id, p.revision, { shotId: 'shot-1', kind: 'firstFrame' }, first.id);
    expect(p.adoptedImages).toEqual({ 'shot-1': { firstFrameId: first.id } });
    p = await f.projects.addShotImage(p.id, p.revision, 'shot-1', 'lastFrame', blue); const last = p.assets.at(-1)!;
    expect(selectedShotImageId(p, 'shot-1', 'lastFrame')).toBeUndefined();
    await expect(f.projects.adoptImage(p.id, p.revision, { shotId: 'shot-2', kind: 'lastFrame' }, last.id)).rejects.toThrow('不属于');
    await expect(f.projects.adoptImage(p.id, p.revision, { shotId: 'shot-1', kind: 'firstFrame' }, last.id)).rejects.toThrow('不属于');
    p = await f.projects.adoptImage(p.id, p.revision, { shotId: 'shot-1', kind: 'lastFrame' }, last.id);
    p = await f.projects.addShotImage(p.id, p.revision, 'shot-1', 'firstFrame', blue); const replacement = p.assets.at(-1)!;
    expect(selectedShotImageId(p, 'shot-1', 'firstFrame')).toBe(first.id);
    p = await f.projects.adoptImage(p.id, p.revision, { shotId: 'shot-1', kind: 'firstFrame' }, replacement.id);
    expect(p.assets.find((a): boolean => a.id === last.id)?.needsReview).toBe(true);
    expect(p.assets.some((a): boolean => a.id === first.id)).toBe(true);
    expect(selectedShotImageId(p, 'shot-1', 'firstFrame')).toBe(replacement.id);
    expect(selectedShotImageId(p, 'shot-1', 'lastFrame')).toBeUndefined();
  });
  it('过期版本、变更对象、篡改文件、跨目标采用均不改变正式图片', async (): Promise<void> => {
    const f = await fixture(); let p = await f.projects.addMaterialImage(f.p.id, f.p.revision, 'prop:box', red); const asset = p.assets.at(-1)!;
    await expect(f.projects.adoptImage(p.id, p.revision - 1, { materialId: 'prop:box' }, asset.id)).rejects.toThrow('版本');
    await expect(f.projects.adoptImage(p.id, p.revision, { materialId: 'scene:room' }, asset.id)).rejects.toThrow('不属于');
    p = await f.projects.saveMaterialPrompt(p.id, p.revision, 'prop:box', 'TEST 改变后的正文');
    await expect(f.projects.adoptImage(p.id, p.revision, { materialId: 'prop:box' }, asset.id)).rejects.toThrow('依据已变化');
    p = await f.projects.addMaterialImage(p.id, p.revision, 'prop:box', red); const fresh = p.assets.at(-1)!;
    await fs.copyFile(blue, path.join(f.projects.directory(p.id), fresh.relativePath));
    await expect(f.projects.adoptImage(p.id, p.revision, { materialId: 'prop:box' }, fresh.id)).rejects.toThrow('文件已变化');
    expect((await f.projects.read(p.id)).materials!.find((m): boolean => m.id === 'prop:box')?.selectedAssetId).toBeUndefined();
  });
  it('旧明确确认基础图兼容；旧关键帧无采用记录仍可预览但不能作正式引用', async (): Promise<void> => {
    const f = await fixture(); let p = await f.projects.addMaterialImage(f.p.id, f.p.revision, 'scene:room', red);
    p = await f.projects.approveMaterials(p.id, p.revision, [{ materialId: 'scene:room', assetId: p.assets.at(-1)!.id }]);
    delete p.assets[0].imageReview; p = await f.projects.write(p);
    expect(isPetStoryImageAdopted(p, p.assets[0])).toBe(true);
    p = await f.projects.addShotImage(p.id, p.revision, 'shot-1', 'firstFrame', red); const frame = p.assets.at(-1)!; delete frame.imageReview;
    p = await f.projects.write(p);
    expect(await f.projects.referenceFile(p.id, frame.id)).toBe(path.join(f.projects.directory(p.id), frame.relativePath));
    expect(isPetStoryImageAdopted(p, p.assets.at(-1)!)).toBe(false);
    p = await f.projects.adoptImage(p.id, p.revision, { shotId: 'shot-1', kind: 'firstFrame' }, frame.id);
    expect(selectedShotImageId(p, 'shot-1', 'firstFrame')).toBe(frame.id);
  });
  it('基础素材替换后相关关键帧保留但待复核，无关镜头文件不受影响', async (): Promise<void> => {
    const f = await fixture(); let p = await f.projects.addMaterialImage(f.p.id, f.p.revision, 'character:actor', red);
    p = await f.projects.approveMaterials(p.id, p.revision, [{ materialId: 'character:actor', assetId: p.assets.at(-1)!.id }]);
    p = await f.projects.addShotImage(p.id, p.revision, 'shot-1', 'firstFrame', red); const frame = p.assets.at(-1)!;
    p = await f.projects.adoptImage(p.id, p.revision, { shotId: 'shot-1', kind: 'firstFrame' }, frame.id);
    p = await f.projects.addMaterialImage(p.id, p.revision, 'character:actor', blue); const replacement = p.assets.at(-1)!;
    expect(p.assets.find((a): boolean => a.id === frame.id)?.needsReview).toBeUndefined();
    p = await f.projects.adoptImage(p.id, p.revision, { materialId: 'character:actor' }, replacement.id);
    expect(p.assets.find((a): boolean => a.id === frame.id)?.needsReview).toBe(true); expect(p.assets).toHaveLength(3);
  });
  it('新方案删除旧镜头时只清理当前采用指针，旧文件及记录仍可读取', async (): Promise<void> => {
    const f = await fixture(); let p = await f.projects.addShotImage(f.p.id, f.p.revision, 'shot-1', 'firstFrame', red);
    const asset = p.assets.at(-1)!; p = await f.projects.adoptImage(p.id, p.revision, { shotId: 'shot-1', kind: 'firstFrame' }, asset.id);
    const revised = structuredClone(p.plan!); revised.shots = [{ ...revised.shots[1], order: 1 }];
    p = await f.projects.savePlan(p.id, p.revision, revised);
    expect(p.adoptedImages?.['shot-1']).toBeUndefined(); expect(p.assets.find((item): boolean => item.id === asset.id)?.needsReview).toBe(true);
    expect(await f.projects.referenceFile(p.id, asset.id)).toBe(path.join(f.projects.directory(p.id), asset.relativePath));
    expect((await f.projects.open(f.projects.directory(p.id))).plan?.shots).toHaveLength(1);
  });
  it('批量采用任一目标无效时整个采用保存失败，不留下部分正式指针', async (): Promise<void> => {
    const f = await fixture(); let p = await f.projects.addMaterialImage(f.p.id, f.p.revision, 'prop:box', red);
    const asset = p.assets.at(-1)!; const before = await fs.readFile(path.join(f.projects.directory(p.id), 'project.json'), 'utf8');
    await expect(f.projects.approveMaterials(p.id, p.revision, [{ materialId: 'prop:box', assetId: asset.id }, { materialId: 'scene:room', assetId: asset.id }])).rejects.toThrow('不属于');
    expect(await fs.readFile(path.join(f.projects.directory(p.id), 'project.json'), 'utf8')).toBe(before);
    p = await f.projects.read(p.id); expect(p.assets[0].imageReview?.state).toBe('candidate'); expect(p.materials!.some((item): boolean => !!item.approved)).toBe(false);
  });
});
