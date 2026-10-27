import type { PetStoryProject } from '@doubao-studio/contracts';

/** 仅由用户明确编辑／创作操作调用；读盘和启动不改变授权或生产历史。 */
export function archiveCompletedPetStoryProduction(project: PetStoryProject): boolean {
  const production = project.production;
  if (!production || production.state !== 'complete' || production.steps.some((step): boolean => step.status !== 'complete')) return false;
  project.productionHistory = [...(project.productionHistory || []), production];
  project.production = undefined;
  return true;
}
