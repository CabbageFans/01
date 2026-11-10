import type { PetStoryCompiledPrompt, PetStoryProject, PetStoryPromptKind, PetStoryResolvedMode } from '@doubao-studio/contracts';
import { compileMaterialPromptFacts, compilePromptFacts } from './petstoryPromptReferences';
import { requirePromptEligibility } from './petstoryEligibility';
import { requireMaterialPromptSource } from './petstoryMaterials';

export * from './petstoryPromptReferences';

/** 唯一正式编译边界：资格检查先于纯引用映射；只读计划不伪造执行资格。 */
export function compilePrompt(project: PetStoryProject, shotId: string, kind: PetStoryPromptKind, mode?: PetStoryResolvedMode, planned = false): PetStoryCompiledPrompt {
  const prompt = project.plan?.shots.find((shot): boolean => shot.id === shotId)?.prompts[kind];
  if (!prompt) throw new Error('镜头或提示词不存在');
  if (!planned) requirePromptEligibility(project, prompt, { shotId, promptKind: kind, mode });
  return compilePromptFacts(project, shotId, kind, mode, planned);
}

export function compileMaterialPrompt(project: PetStoryProject, materialId: string, planned = false): PetStoryCompiledPrompt {
  if (!planned) requireMaterialPromptSource(project, materialId);
  return compileMaterialPromptFacts(project, materialId, planned);
}
