/** 原故事派生的离线边界；不代表真实豆包输出。 */
import { describe, expect, it } from 'vitest';
import type { PetStoryAsset, PetStoryPlan, PetStoryProject } from '@doubao-studio/contracts';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { needsPetStoryReferenceAdaptation } from '../../src/utils/petstoryVisualBasis';
import { journeyAssetMatchesPrompt, journeyMaterialImageApproved } from '../../src/utils/petstoryJourney';
import { pendingChatConflicts } from '../../main/utils/petstoryPending';
import { buildPetStoryPromptExport } from '../../main/utils/petstoryExport';
import { compileImageFeedback, imageTargetBasis } from '../../main/utils/petstoryImageReview';

function fixture(): PetStoryProject {
  return { schemaVersion: 1, id: 'TEST-reference-first', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, updatedAt: '2026-11-01T00:00:00.000Z', assets: [], jobs: [],
    mobileStory: { id: 'TEST-story', text: snapshot.mobileStory, importedAt: '2026-11-01T00:00:00.000Z' }, plan: structuredClone(snapshot.plan) as PetStoryPlan };
}

describe('正常制作入口的角色图适配与当前状态', (): void => {
  it('关键帧反馈只使用实际选图和原意见，不将旧换装字段或旧正文重新发给媒体', (): void => {
    const p = fixture(); const shot = p.plan!.shots[0]; const target = { shotId: shot.id, kind: 'firstFrame' as const };
    shot.appearanceOverrides = { [shot.characterIds[0]]: 'TEST 过时黑衣马尾造型规格' };
    shot.prompts.firstFrame.final = 'TEST 旧帧人物外观全文';
    const image: PetStoryAsset = { id: 'TEST-selected-candidate', shotId: shot.id, kind: 'firstFrame', relativePath: 'shots/TEST.png',
      validation: { decoded: true, sha256: 'a'.repeat(64), bytes: 1, width: 1, height: 1, checkedAt: p.updatedAt } };
    p.assets.push(image);
    const feedback = '眉头收紧，伸手摘帽，其他保持基图。';
    const compiled = compileImageFeedback(p, { id: 'TEST-feedback', requestId: 'TEST-feedback-request', mode: 'modify', stage: 'preparing', createdAt: p.updatedAt,
      target, baseAssetId: image.id, baseSha256: image.validation!.sha256, feedback, basisHash: imageTargetBasis(p, target) });
    expect(compiled.text).toContain(feedback); expect(compiled.references.map((ref): string => ref.assetId)).toEqual([image.id]);
    expect(compiled.text).not.toContain('TEST 过时黑衣马尾造型规格'); expect(compiled.text).not.toContain('TEST 旧帧人物外观全文');
  });
  it('只有受换图影响的旧正文需要普通Chat适配，新规则表演正文继续走正式引用映射', (): void => {
    const p = fixture(); const shot = p.plan!.shots[0]; const character = p.plan!.characters.find((item): boolean => shot.characterIds.includes(item.id))!;
    const prompt = shot.prompts.video; prompt.final = 'TEST 保留完整动作、逐字台词及运镜的历史正文';
    expect(needsPetStoryReferenceAdaptation(p, shot.id, 'video')).toBe(false);
    p.materials = [{ id: `character:${character.id}`, entityId: character.id, name: character.name, kind: 'character', designHash: 'TEST',
      visualBasis: { assetId: 'TEST-new-image', sha256: 'a'.repeat(64), adoptedAt: p.updatedAt }, prompt: { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST' } }];
    expect(needsPetStoryReferenceAdaptation(p, shot.id, 'video')).toBe(true);
    prompt.promptTask = { visualPolicy: 'reference-first-v1', characterVisualBasis: { [`character:${character.id}`]: 'TEST-old-image:TEST-old-digest' }, references: [], dialect: 'seedance20' };
    expect(needsPetStoryReferenceAdaptation(p, shot.id, 'video')).toBe(false);
    const unrelated = p.plan!.shots.find((item): boolean => !item.characterIds.includes(character.id));
    if (unrelated) expect(needsPetStoryReferenceAdaptation(p, unrelated.id, 'video')).toBe(false);
  });

  it('已采用上传图只依赖图片绑定和指纹，旧description变化不降低就绪', (): void => {
    const p = fixture(); const character = p.plan!.characters[0];
    const asset: PetStoryAsset = { id: 'TEST-upload', kind: 'character' as const, characterId: character.id, relativePath: 'characters/TEST-upload.png',
      validation: { decoded: true, sha256: 'a'.repeat(64), bytes: 1, width: 1, height: 1, checkedAt: p.updatedAt } };
    const material = { id: `character:${character.id}`, entityId: character.id, name: character.name, kind: 'character' as const, designHash: 'TEST', selectedAssetId: asset.id,
      approved: { assetId: asset.id, sha256: 'a'.repeat(64), at: p.updatedAt, identity: { assetId: asset.id } }, prompt: { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST', supersededByAssetId: asset.id } };
    p.assets = [asset]; p.materials = [material]; character.referenceAssetId = asset.id;
    expect(journeyMaterialImageApproved(p, material)).toBe(true);
    character.description = 'TEST 历史角色描述被改动';
    expect(journeyMaterialImageApproved(p, material)).toBe(true);
    material.approved.sha256 = 'b'.repeat(64);
    expect(journeyMaterialImageApproved(p, material)).toBe(false);
  });

  it('真实换图标记使旧帧退出当前成果，而普通历史复核标记不撤销采用', (): void => {
    const p = fixture(); const prompt = p.plan!.shots[0].prompts.firstFrame;
    const image: PetStoryAsset = { id: 'TEST-old-frame', kind: 'firstFrame' as const, relativePath: 'shots/TEST.png', needsReview: true,
      validation: { decoded: true, sha256: 'a'.repeat(64), bytes: 1, width: 1, height: 1, checkedAt: p.updatedAt },
      imageReview: { state: 'adopted' as const, target: { shotId: p.plan!.shots[0].id, kind: 'firstFrame' as const }, adoptedAt: p.updatedAt, sha256: 'a'.repeat(64), basisHash: 'TEST' } };
    expect(journeyAssetMatchesPrompt(image, prompt)).toBe(true);
    expect(journeyAssetMatchesPrompt({ ...image, visualBasisStale: true }, prompt)).toBe(false);
  });

  it('采用图替代的在途基础文字保留历史，不继续阻断相关镜头或导出为当前模型正文', (): void => {
    const p = fixture(); const character = p.plan!.characters[0]; const shot = p.plan!.shots.find((item): boolean => item.characterIds.includes(character.id))!;
    const materialId = `character:${character.id}`;
    p.materials = [{ id: materialId, entityId: character.id, name: character.name, kind: 'character', designHash: 'TEST',
      visualBasis: { assetId: 'TEST-upload', sha256: 'a'.repeat(64), adoptedAt: p.updatedAt },
      prompt: { original: 'TEST 原始设计', final: 'TEST 过时服装和人物造型', optimized: 'TEST 旧候选', edited: false, rulesVersion: 'TEST', supersededByAssetId: 'TEST-upload' } }];
    p.jobs = [{ id: 'TEST-late', taskId: 'TEST-original-task', kind: 'materialPrompt', materialId, inputHash: 'TEST', sourceUrl: '', status: 'bound', resultStatus: 'stale' }];
    expect(pendingChatConflicts(p, { shotId: shot.id, promptKind: 'firstFrame' })).toEqual([]);
    expect(p.jobs[0].status).toBe('bound');
    const exported = buildPetStoryPromptExport(p, []).prompts.find((item): boolean => item.id === materialId)!;
    expect(exported.final).toBe(''); expect(exported.modelPrompt).toBeNull(); expect(exported.candidate).toBeUndefined();
    expect(exported.review.metadata).toMatchObject({ historicalPrompt: { final: 'TEST 过时服装和人物造型' } });
    expect(p.materials[0].prompt.final).toBe('TEST 过时服装和人物造型');
  });
});
