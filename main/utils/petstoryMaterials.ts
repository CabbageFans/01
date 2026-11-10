import type { PetStoryMaterial, PetStoryProject } from '@doubao-studio/contracts';
import { materialPromptSourceFacts } from './petstoryMaterialFacts';
import { requirePromptEligibility } from './petstoryEligibility';

export * from './petstoryMaterialFacts';

/** 内容资格只在输入边界执行；素材事实模块不反向调用正文编译和资格检查。 */
export function requireMaterialPromptSource(project: PetStoryProject, materialId: string): PetStoryMaterial {
  const material = materialPromptSourceFacts(project, materialId);
  requirePromptEligibility(project, material.prompt, { materialId });
  return material;
}
