/** 只测试前端反馈映射和已保存记录投影；不替代真实 Electron 点击或主进程生成资格。 */
import { describe, expect, it, vi } from 'vitest';
import type { PetStoryGenerationBlocker, PetStoryMaterial, PetStoryProduction, PetStoryProject } from '@doubao-studio/contracts';
import { generationBlockerAction } from '../../src/components/PetStoryGenerationBlockers';
import { isPetStoryMaterialImageApproved } from '../../src/components/PetStoryMaterials';
import { resolveMediaBlocker, selectedPetStoryMedia } from '../../src/components/PetStoryCanvasMedia';
import snapshot from '../fixtures/storyboard-five-shots.json';

function project(): PetStoryProject {
  return { schemaVersion: 1, id: 'TEST-feedback', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, plan: structuredClone(snapshot.plan) as NonNullable<PetStoryProject['plan']>, jobs: [], assets: [], updatedAt: '2026-10-28T00:00:00.000Z' };
}
function material(kind: PetStoryMaterial['kind'], id: string): PetStoryMaterial {
  return { id: `${kind}:${id}`, kind, entityId: id, name: 'TEST素材', designHash: 'TEST', prompt: { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST' }, selectedAssetId: 'TEST-image' };
}
const validation = { decoded: true as const, sha256: 'TEST-sha', bytes: 100, width: 100, height: 100, checkedAt: '2026-10-28T00:00:00.000Z' };

describe('媒体前置处理反馈', (): void => {
  it.each<[PetStoryGenerationBlocker['code'], string]>([
    ['story', '查看并确认方案'], ['prompt', '查看本项提示词'], ['materials', '查看并补齐素材'],
    ['firstFrame', '去制作本镜首帧'], ['lastFrame', '去制作本镜尾帧'], ['capability', '重新读取制作条件'], ['task', '处理当前任务'],
  ])('主进程%s阻断指向对应动作', (code, action): void => {
    expect(generationBlockerAction({ code, message: 'TEST' })).toBe(action);
  });
  it('连续首帧缺少前镜视频时准确指向前镜视频，不误指向本镜首帧', (): void => {
    const p = project(); const shot = p.plan!.shots[1];
    const blocker: PetStoryGenerationBlocker = { code: 'firstFrame', message: 'TEST 前镜视频尚未生成', shotId: p.plan!.shots[0].id, promptKind: 'video' };
    const navigate = vi.fn();
    expect(generationBlockerAction(blocker)).toBe('去制作前镜视频');
    resolveMediaBlocker(blocker, shot, 'firstFrame', vi.fn(), navigate);
    expect(navigate).toHaveBeenCalledWith('videoPrompt', p.plan!.shots[0].id, 'video');
  });
  it('选中、文件已校验和本人确认分别投影，旧确认不能算当前图片已确认', (): void => {
    const p = project(); const m = material('scene', 'location'); p.materials = [m];
    expect(isPetStoryMaterialImageApproved(p, m)).toBe(false);
    p.assets = [{ id: 'TEST-image', kind: 'scene', materialId: m.id, relativePath: 'TEST.png', validation }];
    expect(isPetStoryMaterialImageApproved(p, m)).toBe(false);
    m.approved = { assetId: 'TEST-image', sha256: 'TEST-sha', at: validation.checkedAt };
    expect(isPetStoryMaterialImageApproved(p, m)).toBe(true);
    m.selectedAssetId = 'TEST-replacement';
    expect(isPetStoryMaterialImageApproved(p, m)).toBe(false);
    m.selectedAssetId = 'TEST-image'; p.assets[0].validation = { ...validation, sha256: 'TEST-changed' };
    expect(isPetStoryMaterialImageApproved(p, m)).toBe(false);
  });
  it('人物确认必须同时对应当前图片与当前身份外观文字', (): void => {
    const p = project(); const character = p.plan!.characters[0]; const m = material('character', character.id); p.materials = [m];
    p.assets = [{ id: 'TEST-image', kind: 'character', characterId: character.id, materialId: m.id, relativePath: 'TEST.png', validation }];
    m.approved = { assetId: 'TEST-image', sha256: validation.sha256, at: validation.checkedAt };
    expect(isPetStoryMaterialImageApproved(p, m)).toBe(false);
    m.approved.identity = { assetId: 'TEST-image', description: character.description };
    expect(isPetStoryMaterialImageApproved(p, m)).toBe(true);
    character.description += 'TEST变更';
    expect(isPetStoryMaterialImageApproved(p, m)).toBe(false);
  });
  it('候选、待复核或采用摘要不一致的素材不能计入已采用数量', (): void => {
    const p = project(); const m = material('scene', 'location'); p.materials = [m];
    p.assets = [{ id: 'TEST-image', kind: 'scene', materialId: m.id, relativePath: 'TEST.png', validation, needsReview: true }];
    m.approved = { assetId: 'TEST-image', sha256: validation.sha256, at: validation.checkedAt };
    expect(isPetStoryMaterialImageApproved(p, m)).toBe(false);
    p.assets[0].needsReview = false;
    p.assets[0].imageReview = { state: 'candidate', target: { materialId: m.id }, basisHash: 'TEST' };
    expect(isPetStoryMaterialImageApproved(p, m)).toBe(false);
    p.assets[0].imageReview = { ...p.assets[0].imageReview, state: 'adopted', adoptedAt: validation.checkedAt, sha256: 'TEST-other' };
    expect(isPetStoryMaterialImageApproved(p, m)).toBe(false);
    p.assets[0].imageReview.sha256 = validation.sha256;
    expect(isPetStoryMaterialImageApproved(p, m)).toBe(true);
  });
  it('历史镜头产物可显示，但不会把尾帧或其他镜头图片当本镜首帧', (): void => {
    const p = project(); const shot = p.plan!.shots[0];
    p.assets = [
      { id: 'TEST-first', kind: 'firstFrame', shotId: shot.id, taskId: 'TEST-task', relativePath: 'TEST.png', validation },
      { id: 'TEST-last', kind: 'plannedEndImage', shotId: shot.id, taskId: 'TEST-task2', relativePath: 'TEST2.png', validation },
      { id: 'TEST-other-shot', kind: 'firstFrame', shotId: 'TEST-other', taskId: 'TEST-task3', relativePath: 'TEST3.png', validation },
    ];
    p.assets[0].imageReview = { state: 'adopted', target: { shotId: shot.id, kind: 'firstFrame' }, basisHash: 'TEST', adoptedAt: validation.checkedAt };
    p.assets[1].imageReview = { state: 'adopted', target: { shotId: shot.id, kind: 'lastFrame' }, basisHash: 'TEST', adoptedAt: validation.checkedAt };
    p.adoptedImages = { [shot.id]: { firstFrameId: 'TEST-first', plannedEndImageId: 'TEST-last' } };
    expect(selectedPetStoryMedia(p, shot, 'firstFrame')?.id).toBe('TEST-first');
    expect(selectedPetStoryMedia(p, shot, 'lastFrame')?.id).toBe('TEST-last');
    expect(selectedPetStoryMedia(p, shot, 'video')).toBeUndefined();
  });
  it('画布沿用总览与正式制作的历史选用优先级', (): void => {
    const p = project(); const shot = p.plan!.shots[0];
    p.assets = [{ id: 'TEST-chosen', kind: 'firstFrame', shotId: shot.id, taskId: 'TEST-task', relativePath: 'TEST.png', validation }, { id: 'TEST-later', kind: 'firstFrame', shotId: shot.id, taskId: 'TEST-task2', relativePath: 'TEST2.png', validation }];
    const history = { shots: { [shot.id]: { firstFrameId: 'TEST-chosen' } } } as unknown as PetStoryProduction;
    p.productionHistory = [history]; p.production = { shots: {} } as PetStoryProduction;
    p.assets[0].imageReview = { state: 'adopted', target: { shotId: shot.id, kind: 'firstFrame' }, basisHash: 'TEST', adoptedAt: validation.checkedAt };
    p.adoptedImages = { [shot.id]: { firstFrameId: 'TEST-chosen' } };
    expect(selectedPetStoryMedia(p, shot, 'firstFrame')?.id).toBe('TEST-chosen');
    p.production.shots[shot.id] = { requestedMode: 'first_frame', resolvedMode: 'first_frame', reason: 'TEST 新条目未选首帧' };
    expect(selectedPetStoryMedia(p, shot, 'firstFrame')?.id).toBe('TEST-chosen');
  });
});
