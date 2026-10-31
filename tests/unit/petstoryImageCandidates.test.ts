import { describe, expect, it } from 'vitest';
import type { PetStoryAsset, PetStoryImageTarget, PetStoryPlan, PetStoryProject } from '@doubao-studio/contracts';
import { imageBelongsToTarget, pendingImageCandidates } from '../../src/utils/petstoryImageCandidates';
import snapshot from '../fixtures/storyboard-five-shots.json';

const materialTarget: PetStoryImageTarget = { materialId: 'prop:TEST-stick' };
const before = '2026-10-30T00:00:00.000Z';
const adoptedAt = '2026-10-30T01:00:00.000Z';
const after = '2026-10-30T02:00:00.000Z';
const sha256 = 'a'.repeat(64);

function project(): PetStoryProject {
  const prompt = { original: 'TEST', optimized: '', final: 'TEST', edited: false, rulesVersion: 'TEST' };
  return { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [], updatedAt: before,
    plan: structuredClone(snapshot.plan) as PetStoryPlan,
    materials: [
      { id: materialTarget.materialId!, kind: 'prop', entityId: 'TEST-stick', name: '长木棍', designHash: 'TEST', prompt: { ...prompt } },
      { id: 'scene:TEST-road', kind: 'scene', entityId: 'TEST-road', name: '乡村道路', designHash: 'TEST', prompt: { ...prompt } },
      { id: 'character:TEST-character', kind: 'character', entityId: 'TEST-character', name: 'TEST角色', designHash: 'TEST', prompt: { ...prompt } },
    ] };
}

function image(id: string, target: PetStoryImageTarget = materialTarget, changes: Partial<PetStoryAsset> = {}): PetStoryAsset {
  return { id, kind: target.materialId ? target.materialId.startsWith('scene:') ? 'scene' : target.materialId.startsWith('character:') ? 'character' : 'prop'
    : target.kind === 'firstFrame' ? 'firstFrame' : 'plannedEndImage', materialId: target.materialId, shotId: target.shotId,
    relativePath: `assets/${id}.png`, taskId: 'TEST-task', runId: 'TEST-run',
    validation: { decoded: true, sha256, bytes: 100, width: 640, height: 480, checkedAt: before },
    imageReview: { state: 'candidate', target, basisHash: 'TEST-basis' }, ...changes };
}

function adopt(p: PetStoryProject, selected: PetStoryAsset, resolvedCandidateIds?: string[], at: string = adoptedAt): void {
  const target = selected.imageReview!.target;
  selected.imageReview = { ...selected.imageReview!, state: 'adopted', adoptedAt: at, sha256: selected.validation!.sha256,
    ...(resolvedCandidateIds ? { resolvedCandidateIds } : {}) };
  if (target.materialId) {
    const material = p.materials!.find((item): boolean => item.id === target.materialId)!;
    material.selectedAssetId = selected.id;
    material.approved = { assetId: selected.id, sha256: selected.validation!.sha256, at };
  } else if (target.shotId) {
    p.adoptedImages = { ...p.adoptedImages, [target.shotId]: { ...p.adoptedImages?.[target.shotId],
      [target.kind === 'firstFrame' ? 'firstFrameId' : 'plannedEndImageId']: selected.id } };
  }
}

function ids(p: PetStoryProject, target: PetStoryImageTarget = materialTarget, currentAssetId?: string): string[] {
  return pendingImageCandidates(p, target, currentAssetId).map((asset): string => asset.id);
}

describe('图片待确认只表示尚未解决的新候选', (): void => {
  it('首次一次生成多张图片仍全部待选，选择其中一张后同批其余图不再反复要求确认', (): void => {
    const p = project(); p.assets = [image('TEST-one'), image('TEST-two'), image('TEST-three')];
    expect(ids(p)).toEqual(['TEST-one', 'TEST-two', 'TEST-three']);
    adopt(p, p.assets[1], ['TEST-one', 'TEST-three']);
    expect(ids(p)).toEqual([]);
    expect(p.assets[0].imageReview?.state).toBe('candidate');
    expect(p.assets[2].imageReview?.state).toBe('candidate');
  });

  it('连续修改后采用最终图会解决此前各轮候选，但后续新修改仍待确认', (): void => {
    const p = project();
    const original = image('TEST-original'); const first = image('TEST-first-edit', materialTarget, { taskId: 'TEST-edit-one' });
    const second = image('TEST-second-edit', materialTarget, { taskId: 'TEST-edit-two' });
    p.assets = [original, first, second]; adopt(p, second, [original.id, first.id]);
    expect(ids(p)).toEqual([]);
    p.assets.push(image('TEST-third-edit', materialTarget, { taskId: 'TEST-edit-three', validation: { ...second.validation!, checkedAt: after } }));
    expect(ids(p)).toEqual(['TEST-third-edit']);
  });

  it('重新采用历史候选时按本次快照解决后来图，不按资产数组位置推断新旧', (): void => {
    const p = project(); const old = image('TEST-old'); const latest = image('TEST-latest', materialTarget, { taskId: 'TEST-latest-task' });
    p.assets = [latest, old]; adopt(p, latest, [old.id]);
    adopt(p, old, [latest.id]);
    expect(ids(p)).toEqual([]);
    expect(p.assets.map((asset): string => asset.id)).toEqual([latest.id, old.id]);
  });

  it('采用同一批中的任一张后，迟到下载和重复导入的同任务同运行图片不会重新制造待确认', (): void => {
    const p = project(); const selected = image('TEST-selected'); p.assets = [selected]; adopt(p, selected, []);
    p.assets.push(image('TEST-late-download', materialTarget, { validation: { ...selected.validation!, checkedAt: after } }),
      image('TEST-reimport', materialTarget, { artifactId: 'TEST-another-download-record', validation: { ...selected.validation!, checkedAt: after } }));
    expect(ids(p)).toEqual([]);
  });

  it('已解决的较早一轮候选也可识别同批迟到图片', (): void => {
    const p = project(); const old = image('TEST-old-batch'); const selected = image('TEST-selected-edit', materialTarget, { taskId: 'TEST-edit-task' });
    p.assets = [old, selected]; adopt(p, selected, [old.id]);
    p.assets.push(image('TEST-old-batch-late', materialTarget, { validation: { ...old.validation!, checkedAt: after } }));
    expect(ids(p)).toEqual([]);
  });

  it.each(['task', 'run', 'upload'] as const)('采用后新%s来源即使文件摘要相同也必须保持待选', (source): void => {
    const p = project(); const selected = image('TEST-selected'); p.assets = [selected]; adopt(p, selected, []);
    const newImage = image('TEST-new', materialTarget, { taskId: source === 'task' ? 'TEST-new-task' : source === 'upload' ? undefined : selected.taskId,
      runId: source === 'run' ? 'TEST-new-run' : source === 'upload' ? undefined : selected.runId,
      validation: { ...selected.validation!, checkedAt: after } });
    p.assets.push(newImage); expect(ids(p)).toEqual([newImage.id]);
  });

  it.each(['taskId', 'runId'] as const)('来源缺少%s时不把两张无可靠同批证据的图片合并', (field): void => {
    const p = project(); const selected = image('TEST-selected', materialTarget, { [field]: undefined }); p.assets = [selected]; adopt(p, selected, []);
    p.assets.push(image('TEST-incomplete-origin', materialTarget, { [field]: undefined, validation: { ...selected.validation!, checkedAt: after } }));
    expect(ids(p)).toEqual(['TEST-incomplete-origin']);
  });

  it('具体回复图片以修改会话和回复键区分，同回复多图完成确认后不要求逐张采用', (): void => {
    const p = project(); const sourceReply = { adjustmentId: 'TEST-adjustment', replyKey: 'TEST-reply-one', urlHash: 'TEST-url-one' };
    const selected = image('TEST-reply-selected'); selected.imageReview!.sourceReply = sourceReply; p.assets = [selected]; adopt(p, selected, []);
    const sameReply = image('TEST-same-reply', materialTarget, { validation: { ...selected.validation!, checkedAt: after } });
    sameReply.imageReview!.sourceReply = { ...sourceReply, urlHash: 'TEST-url-two' };
    const newReply = image('TEST-new-reply', materialTarget, { validation: { ...selected.validation!, checkedAt: after } });
    newReply.imageReview!.sourceReply = { ...sourceReply, replyKey: 'TEST-reply-two' };
    const newAdjustment = image('TEST-new-adjustment', materialTarget, { validation: { ...selected.validation!, checkedAt: after } });
    newAdjustment.imageReview!.sourceReply = { ...sourceReply, adjustmentId: 'TEST-another-adjustment' };
    p.assets.push(sameReply, newReply, newAdjustment);
    expect(ids(p)).toEqual([newReply.id, newAdjustment.id]);
  });

  it('具体回复和普通生成图不因共用任务与运行而混为同批', (): void => {
    const p = project(); const selected = image('TEST-selected'); p.assets = [selected]; adopt(p, selected, []);
    const reply = image('TEST-reply', materialTarget, { validation: { ...selected.validation!, checkedAt: after } });
    reply.imageReview!.sourceReply = { adjustmentId: 'TEST-adjustment', replyKey: 'TEST-reply', urlHash: 'TEST-url' };
    p.assets.push(reply); expect(ids(p)).toEqual([reply.id]);
    selected.imageReview!.sourceReply = reply.imageReview!.sourceReply; delete reply.imageReview!.sourceReply;
    expect(ids(p)).toEqual([reply.id]);
  });

  it.each(['adjustmentId', 'replyKey'] as const)('具体回复缺少有效%s时不合并两个未知来源', (field): void => {
    const p = project(); const selected = image('TEST-selected');
    selected.imageReview!.sourceReply = { adjustmentId: 'TEST-adjustment', replyKey: 'TEST-reply', urlHash: 'TEST-url', [field]: '' };
    p.assets = [selected]; adopt(p, selected, []);
    const unknown = image('TEST-unknown-reply', materialTarget, { validation: { ...selected.validation!, checkedAt: after } });
    unknown.imageReview!.sourceReply = { ...selected.imageReview!.sourceReply, urlHash: 'TEST-another-url' };
    p.assets.push(unknown); expect(ids(p)).toEqual([unknown.id]);
  });

  it('解决候选快照仅对当前目标有效，不能吞掉其他素材或首尾帧的待选图片', (): void => {
    const p = project(); const shotId = p.plan!.shots[0].id;
    const first: PetStoryImageTarget = { shotId, kind: 'firstFrame' }; const last: PetStoryImageTarget = { shotId, kind: 'lastFrame' };
    const selected = image('TEST-selected'); const scene = image('TEST-scene', { materialId: 'scene:TEST-road' });
    const firstFrame = image('TEST-first', first); const lastFrame = image('TEST-last', last);
    p.assets = [selected, scene, firstFrame, lastFrame]; adopt(p, selected, [scene.id, firstFrame.id, lastFrame.id]);
    expect(ids(p)).toEqual([]); expect(ids(p, { materialId: 'scene:TEST-road' })).toEqual([scene.id]);
    expect(ids(p, first)).toEqual([firstFrame.id]); expect(ids(p, last)).toEqual([lastFrame.id]);
    adopt(p, firstFrame, []); expect(ids(p, first)).toEqual([]); expect(ids(p, last)).toEqual([lastFrame.id]);
  });

  it('采用不会删除历史文件或清除真实待复核标记，投影本身也不写项目', (): void => {
    const p = project(); const old = image('TEST-old'); const selected = image('TEST-selected', materialTarget, { taskId: 'TEST-edit-task', needsReview: true });
    p.assets = [old, selected]; adopt(p, selected, [old.id]); const saved = structuredClone(p);
    ids(p, materialTarget, selected.id);
    expect(p).toEqual(saved); expect(selected.needsReview).toBe(true); expect(p.assets).toHaveLength(2);
  });
});

describe('历史项目没有解决快照时以真实采用时间兼容', (): void => {
  it('旧多候选和历史已采用图按校验时间解决，候选数组重排不影响结果', (): void => {
    const p = project(); const old = image('TEST-old', materialTarget, { taskId: 'TEST-old-task' });
    const selected = image('TEST-selected', materialTarget, { taskId: 'TEST-selected-task' });
    const newUpload = image('TEST-new-upload', materialTarget, { taskId: undefined, runId: undefined, validation: { ...selected.validation!, checkedAt: after } });
    p.assets = [newUpload, selected, old]; adopt(p, old); adopt(p, selected);
    expect(ids(p)).toEqual([newUpload.id]);
    p.assets.reverse(); expect(ids(p)).toEqual([newUpload.id]);
  });

  it('旧素材 approved 记录在没有 imageReview 时仍可证明采用并解决此前候选', (): void => {
    const p = project(); const selected = image('TEST-legacy', materialTarget, { imageReview: undefined });
    const old = image('TEST-old', materialTarget, { taskId: 'TEST-old-task' }); p.assets = [selected, old];
    p.materials![0].selectedAssetId = selected.id; p.materials![0].approved = { assetId: selected.id, sha256, at: adoptedAt };
    expect(ids(p)).toEqual([]);
  });

  it('旧快照按采用时间解决后，仍能延伸识别已解决批次的迟到图片', (): void => {
    const p = project(); const old = image('TEST-old'); const selected = image('TEST-selected', materialTarget, { taskId: 'TEST-edited-task' });
    const late = image('TEST-old-late', materialTarget, { validation: { ...old.validation!, checkedAt: after } });
    p.assets = [late, selected, old]; adopt(p, selected);
    expect(ids(p)).toEqual([]);
  });

  it.each(['missing-time', 'invalid-time', 'missing-sha', 'empty-validation-sha', 'mismatched-sha', 'candidate'] as const)('采用证据%s不能悄悄解决其他候选', (invalid): void => {
    const p = project(); const selected = image('TEST-selected'); const other = image('TEST-other', materialTarget, { taskId: 'TEST-other-task' });
    p.assets = [selected, other]; adopt(p, selected, [other.id]);
    if (invalid === 'missing-time') { delete selected.imageReview!.adoptedAt; p.materials![0].approved!.at = ''; }
    if (invalid === 'invalid-time') { selected.imageReview!.adoptedAt = 'not-a-date'; p.materials![0].approved!.at = 'not-a-date'; }
    if (invalid === 'missing-sha') { delete selected.imageReview!.sha256; p.materials![0].approved!.sha256 = ''; }
    if (invalid === 'empty-validation-sha') { selected.validation!.sha256 = ''; selected.imageReview!.sha256 = ''; p.materials![0].approved!.sha256 = ''; }
    if (invalid === 'mismatched-sha') { selected.imageReview!.sha256 = 'b'.repeat(64); p.materials![0].approved!.sha256 = 'b'.repeat(64); }
    if (invalid === 'candidate') selected.imageReview!.state = 'candidate';
    expect(ids(p)).toContain(other.id);
  });

  it.each(['', 'invalid-date'] as const)('历史候选校验时间%s不可靠且不属于已知批次时仍待确认', (checkedAt): void => {
    const p = project(); const selected = image('TEST-selected'); const unknown = image('TEST-unknown-time', materialTarget, { taskId: 'TEST-other-task', validation: { ...selected.validation!, checkedAt } });
    p.assets = [selected, unknown]; adopt(p, selected);
    expect(ids(p)).toEqual([unknown.id]);
  });

  it('有显式空快照时不反过来用旧时间推断未被本次确认的其他来源', (): void => {
    const p = project(); const selected = image('TEST-selected'); const other = image('TEST-old-unresolved', materialTarget, { taskId: 'TEST-another-task' });
    p.assets = [selected, other]; adopt(p, selected, []);
    expect(ids(p)).toEqual([other.id]);
  });
});

describe('图片归属匹配', (): void => {
  it('明确 imageReview 目标优先，不能被残留素材字段挪到另一目标', (): void => {
    const p = project(); const asset = image('TEST-conflicting', { materialId: 'scene:TEST-road' }, { materialId: materialTarget.materialId, kind: 'prop' });
    expect(imageBelongsToTarget(p, asset, materialTarget)).toBe(false);
    expect(imageBelongsToTarget(p, asset, { materialId: 'scene:TEST-road' })).toBe(true);
  });

  it('兼容无 review 的素材图片及共同角色身份图，同时隔离其他素材种类', (): void => {
    const p = project(); const legacy = image('TEST-legacy', materialTarget, { imageReview: undefined });
    const character = image('TEST-shared-character', { materialId: 'character:TEST-character' }, { materialId: undefined, characterIds: ['TEST-character', 'TEST-another-character'], imageReview: undefined });
    expect(imageBelongsToTarget(p, legacy, materialTarget)).toBe(true);
    expect(imageBelongsToTarget(p, { ...legacy, kind: 'scene' }, materialTarget)).toBe(false);
    expect(imageBelongsToTarget(p, character, { materialId: 'character:TEST-character' })).toBe(true);
    expect(imageBelongsToTarget(p, character, materialTarget)).toBe(false);
  });

  it('镜头首帧和计划尾帧按镜头与用途精确匹配，不把实际视频尾帧纳入候选', (): void => {
    const p = project(); const target: PetStoryImageTarget = { shotId: p.plan!.shots[0].id, kind: 'lastFrame' };
    const last = image('TEST-last', target, { imageReview: undefined });
    expect(imageBelongsToTarget(p, last, target)).toBe(true);
    expect(imageBelongsToTarget(p, last, { shotId: target.shotId, kind: 'firstFrame' })).toBe(false);
    expect(imageBelongsToTarget(p, last, { shotId: 'TEST-another-shot', kind: 'lastFrame' })).toBe(false);
    expect(imageBelongsToTarget(p, { ...last, kind: 'actualEndFrame' }, target)).toBe(false);
  });
});
