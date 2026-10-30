import { createHash } from 'node:crypto';
import type { PetStoryAsset, PetStoryCompiledPrompt, PetStoryImageOperation, PetStoryImageTarget, PetStoryMaterial, PetStoryProject } from '@doubao-studio/contracts';

function feedbackFacts(project: PetStoryProject, material: PetStoryMaterial | undefined, target: PetStoryImageTarget): unknown {
  if (!material) {
    const shot = project.plan?.shots.find((item): boolean => item.id === target.shotId);
    if (!shot) return undefined;
    const { prompts: _prompts, ...facts } = shot;
    return facts;
  }
  if (material.kind === 'character') return project.plan?.characters.find((item): boolean => item.id === material.entityId);
  if (material.kind === 'prop') return project.plan?.props?.find((item): boolean => item.id === material.entityId);
  return project.plan?.scenes?.find((item): boolean => item.id === material.entityId);
}

/** 直接图片编辑只组织用户原话与已有事实，不冒充豆包创作回复，也不改正式正文。 */
export function compileImageFeedback(project: PetStoryProject, operation: PetStoryImageOperation): PetStoryCompiledPrompt {
  const base = project.assets.find((asset): boolean => asset.id === operation.baseAssetId);
  if (operation.mode !== 'modify' || !base?.validation?.decoded || base.validation.sha256 !== operation.baseSha256
    || !imageTargetMatches(base, operation.target) || !operation.feedback?.trim()) throw new Error('图片修改缺少所选基图或原修改意见');
  if (operation.basisHash !== imageTargetBasis(project, operation.target)) throw new Error('素材事实已变化，请按当前素材重新提交修改意见');
  const material = operation.target.materialId ? project.materials?.find((item): boolean => item.id === operation.target.materialId) : undefined;
  const facts = feedbackFacts(project, material, operation.target);
  const final = ['请以本次上传的唯一图片作为基图，按以下用户意见直接生成修改后的新图片。',
    `用户修改意见（原文）：\n${operation.feedback}`,
    '默认只改变用户要求的部分，尽量保留其余人物身份、服装、造型、场景、构图与风格；用户明确要求改变这些内容时，以本次用户意见为准。',
    `当前图片所属对象事实（用于识别归属，不得抵消用户意见）：\n${JSON.stringify(facts)}`].join('\n\n');
  const kind = material?.kind || operation.target.kind || 'firstFrame';
  return { text: final, final, kind, requestedMode: 'auto', rulesVersion: 'image-feedback-v1', segments: [{ text: final }],
    references: [{ assetId: base.id, materialId: material?.id, entityId: material?.entityId,
      characterIds: base.characterIds || (base.characterId ? [base.characterId] : []),
      purpose: material?.kind === 'character' ? 'identity' : material?.kind || (operation.target.kind === 'lastFrame' ? 'plannedEndImage' : 'firstFrame'), order: 1 }] };
}

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
