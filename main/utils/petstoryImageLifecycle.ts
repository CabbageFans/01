import type { PetStoryImageOperation, PetStoryImageTarget, PetStoryProduction, PetStoryProductionStep, PetStoryProject } from '@doubao-studio/contracts';
import { imageTargetMatches } from './petstoryImageReview';

/** 图片目标以稳定素材／镜头身份比较，不以名称或账号范围代替。 */
export function sameImageTarget(left: PetStoryImageTarget, right: PetStoryImageTarget): boolean {
  return left.materialId ? left.materialId === right.materialId : left.shotId === right.shotId && left.kind === right.kind;
}

export function imageOperationProduction(project: PetStoryProject, operationId: string): PetStoryProduction | undefined {
  return project.imageProductions?.[operationId] || (project.production?.imageOperationId === operationId ? project.production : undefined);
}

/** 创建与恢复都已把同目标的后续请求作为当前操作；旧失败记录只保留历史，不再占用采用入口。 */
export function isCurrentImageOperation(project: PetStoryProject, operation: PetStoryImageOperation): boolean {
  const operations = project.imageOperations || [];
  const index = operations.findIndex((item): boolean => item.id === operation.id);
  return index >= 0 && !operations.slice(index + 1).some((item): boolean => sameImageTarget(item.target, operation.target));
}

function unfinishedSteps(production: PetStoryProduction): PetStoryProductionStep[] {
  return production.steps.filter((step): boolean => step.status !== 'complete');
}

/** 恢复与防重复创建使用的未完成事实；暂停仍保留原步骤、任务和提交证据。 */
export function imageOperationHasPendingWork(project: PetStoryProject, operation: PetStoryImageOperation): boolean {
  if (operation.endedAt) return false;
  if (!isCurrentImageOperation(project, operation) && ['complete', 'failed'].includes(operation.stage)) return false;
  const production = imageOperationProduction(project, operation.id);
  if (production?.steps.length) return unfinishedSteps(production).length > 0;
  if (production && production.state !== 'complete') return true;
  return !['complete', 'failed'].includes(operation.stage);
}

/** 暂停释放图片编辑锁，但不把可恢复的原任务标记完成或授权重发。 */
export function imageOperationHoldsInputLock(project: PetStoryProject, operation: PetStoryImageOperation): boolean {
  return imageOperationHasPendingWork(project, operation) && imageOperationProduction(project, operation.id)?.state !== 'paused';
}

/** 图片编辑只保护仍持锁操作的真实附件；无目标的剧本／正文编辑继续保留原未完成约束。 */
export function imageOperationBlocksTargets(project: PetStoryProject, operation: PetStoryImageOperation, targets?: PetStoryImageTarget[]): boolean {
  if (!targets) return imageOperationHasPendingWork(project, operation);
  if (!imageOperationHoldsInputLock(project, operation)) return false;
  const production = imageOperationProduction(project, operation.id);
  const pending = production ? unfinishedSteps(production) : [];
  return targets.some((target): boolean => sameImageTarget(target, operation.target) || pending.some((step): boolean => step.attachmentAssetIds.some((assetId): boolean => {
    const asset = project.assets.find((item): boolean => item.id === assetId);
    return !!asset && imageTargetMatches(asset, target);
  })));
}
