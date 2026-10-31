import type { PetStoryAsset, PetStoryImageTarget, PetStoryProject } from '@doubao-studio/contracts';

/** 图片归属按明确用途匹配；历史身份图兼容原角色映射。 */
export function imageBelongsToTarget(project: PetStoryProject, asset: PetStoryAsset, target: PetStoryImageTarget): boolean {
  if (asset.kind === 'video' || asset.kind === 'actualEndFrame') return false;
  const reviewTarget = asset.imageReview?.target;
  if (reviewTarget) return target.materialId ? reviewTarget.materialId === target.materialId
    : reviewTarget.shotId === target.shotId && reviewTarget.kind === target.kind;
  if (target.materialId) {
    const material = project.materials?.find((item): boolean => item.id === target.materialId);
    return !!material && asset.kind === material.kind && (asset.materialId === material.id
      || material.kind === 'character' && (asset.characterIds || [asset.characterId]).includes(material.entityId));
  }
  return asset.shotId === target.shotId && asset.kind === (target.kind === 'firstFrame' ? 'firstFrame' : 'plannedEndImage');
}

function timestamp(value: string | undefined): number | undefined {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sameImageBatch(left: PetStoryAsset, right: PetStoryAsset): boolean {
  const leftReply = left.imageReview?.sourceReply; const rightReply = right.imageReview?.sourceReply;
  if (leftReply || rightReply) return !!leftReply && !!rightReply && !!leftReply.adjustmentId && !!leftReply.replyKey
    && leftReply.adjustmentId === rightReply.adjustmentId && leftReply.replyKey === rightReply.replyKey;
  return !!left.taskId && !!left.runId && left.taskId === right.taskId && left.runId === right.runId;
}

function currentImage(project: PetStoryProject, target: PetStoryImageTarget, images: PetStoryAsset[], currentAssetId?: string): PetStoryAsset | undefined {
  const material = project.materials?.find((item): boolean => item.id === target.materialId);
  const selected = target.shotId ? project.adoptedImages?.[target.shotId] : undefined;
  const selectedId = currentAssetId || material?.selectedAssetId || (target.kind === 'firstFrame' ? selected?.firstFrameId : selected?.plannedEndImageId);
  return images.find((asset): boolean => asset.id === selectedId);
}

function confirmedAt(project: PetStoryProject, target: PetStoryImageTarget, current: PetStoryAsset | undefined): number | undefined {
  if (!current?.validation?.decoded || !current.validation.sha256 || current.imageReview?.state === 'candidate') return;
  const review = current.imageReview;
  if (review?.state === 'adopted' && review.sha256 === current.validation.sha256) return timestamp(review.adoptedAt);
  const material = project.materials?.find((item): boolean => item.id === target.materialId && item.selectedAssetId === current.id);
  return material?.approved?.assetId === current.id && material.approved.sha256 === current.validation.sha256 ? timestamp(material.approved.at) : undefined;
}

/** 待确认代表尚未解决的选图决定；未选历史图保留，不能因此反复要求采用。 */
export function pendingImageCandidates(project: PetStoryProject, target: PetStoryImageTarget, currentAssetId?: string): PetStoryAsset[] {
  const images = project.assets.filter((asset): boolean => imageBelongsToTarget(project, asset, target));
  const current = currentImage(project, target, images, currentAssetId);
  const at = confirmedAt(project, target, current);
  if (!current || at === undefined) return images.filter((asset): boolean => asset.imageReview?.state !== 'adopted');
  const resolved = current.imageReview?.resolvedCandidateIds;
  const resolvedIds = new Set(resolved || images.filter((asset): boolean => {
    const checkedAt = timestamp(asset.validation?.checkedAt);
    return checkedAt !== undefined && checkedAt <= at;
  }).map((asset): string => asset.id));
  resolvedIds.add(current.id);
  const resolvedImages = images.filter((asset): boolean => resolvedIds.has(asset.id));
  // 原批次的迟到下载沿用已作出的选择；其他生成、回复和新上传仍需要用户决定。
  return images.filter((asset): boolean => asset.imageReview?.state !== 'adopted' && !resolvedIds.has(asset.id)
    && !resolvedImages.some((resolvedAsset): boolean => sameImageBatch(resolvedAsset, asset)));
}
