import { createHash } from 'node:crypto';
import type { PetStoryAsset, PetStoryImageTarget, PetStoryProject } from '@doubao-studio/contracts';

export function imageTargetMatches(asset: PetStoryAsset, target: PetStoryImageTarget): boolean {
  if (target.materialId) {
    return asset.materialId === target.materialId || target.materialId.startsWith('character:') && asset.kind === 'character'
      && (asset.characterIds || (asset.characterId ? [asset.characterId] : [])).includes(target.materialId.slice(10));
  }
  return asset.shotId === target.shotId && asset.kind === (target.kind === 'lastFrame' ? 'plannedEndImage' : 'firstFrame');
}

/** 用当前对象和实际参考锁定候选用途，不把无关对象保存当作候选过期。 */
export function imageTargetBasis(project: PetStoryProject, target: PetStoryImageTarget): string {
  let facts: object;
  if (target.materialId) {
    const material = project.materials?.find((item): boolean => item.id === target.materialId);
    if (!material) throw new Error('图片目标素材不存在');
    facts = { story: project.mobileStory?.id, target, design: material.designHash, prompt: material.prompt.final };
  } else {
    const shot = project.plan?.shots.find((item): boolean => item.id === target.shotId);
    if (!shot || !['firstFrame', 'lastFrame'].includes(target.kind || '')) throw new Error('图片目标镜头不存在');
    const kind = target.kind;
    if (!kind) throw new Error('图片用途无效');
    const { prompts, ...design } = shot;
    facts = { story: project.mobileStory?.id, target, design, prompt: prompts[kind]?.final,
      materials: project.materials?.filter((item): boolean => shot.characterIds.includes(item.entityId) || !!shot.propIds?.includes(item.entityId) || shot.sceneId === item.entityId)
        .map((item): object => ({ id: item.id, designHash: item.designHash, approved: item.approved })),
      firstFrame: target.kind === 'lastFrame' ? selectedShotImageId(project, shot.id, 'firstFrame') : undefined };
  }
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

/** 旧基础素材的明确确认继续有效；旧关键帧只有文件不等于用户已采用。 */
export function isPetStoryImageAdopted(project: PetStoryProject, asset: PetStoryAsset): boolean {
  if (asset.kind === 'video' || !asset.validation?.decoded || asset.needsReview || asset.imageReview?.state === 'candidate') return false;
  if (asset.kind === 'actualEndFrame') return !!asset.sourceVideo;
  if (asset.imageReview?.state === 'adopted') return asset.imageReview.sha256 === asset.validation.sha256 && !!asset.imageReview.adoptedAt;
  return !!project.materials?.some((item): boolean => item.selectedAssetId === asset.id && item.approved?.assetId === asset.id
    && item.approved.sha256 === asset.validation?.sha256
    && (item.kind !== 'character' || item.approved.identity?.assetId === asset.id && item.approved.identity.description === project.plan?.characters.find((character): boolean => character.id === item.entityId)?.description));
}

export function selectedShotImageId(project: PetStoryProject, shotId: string, kind: 'firstFrame' | 'lastFrame'): string | undefined {
  const field = kind === 'firstFrame' ? 'firstFrameId' : 'plannedEndImageId';
  const selected = project.adoptedImages?.[shotId]?.[field];
  const runs = [project.production, ...(project.productionHistory || []).slice().reverse()];
  const prior = runs.find((run): boolean => !!run?.shots[shotId])?.shots[shotId]?.[field];
  const id = selected || prior;
  const asset = project.assets.find((item): boolean => item.id === id);
  return asset && isPetStoryImageAdopted(project, asset) ? asset.id : undefined;
}

/** 采用新方案只整理当前指针；历史文件与原任务始终保留，不做自动重生成。 */
export function reconcileAdoptedImages(project: PetStoryProject): void {
  for (const [shotId, selected] of Object.entries(project.adoptedImages || {})) {
    if (!project.plan?.shots.some((shot): boolean => shot.id === shotId)) {
      for (const asset of project.assets.filter((item): boolean => item.shotId === shotId)) asset.needsReview = true;
      delete project.adoptedImages?.[shotId];
      continue;
    }
    for (const [field, kind] of [['firstFrameId', 'firstFrame'], ['plannedEndImageId', 'lastFrame']] as const) {
      const asset = project.assets.find((item): boolean => item.id === selected[field]);
      if (asset?.imageReview && asset.imageReview.basisHash !== imageTargetBasis(project, { shotId, kind })) asset.needsReview = true;
    }
  }
}
