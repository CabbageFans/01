import type { PetStoryProject, PetStoryPromptKind } from '@doubao-studio/contracts';

/** 只判断已知的换图关系，不猜测正文中的颜色、身体词或剧情含义。 */
export function needsPetStoryReferenceAdaptation(project: PetStoryProject, shotId: string, kind: PetStoryPromptKind): boolean {
  const shot = project.plan?.shots.find((item): boolean => item.id === shotId);
  const prompt = shot?.prompts[kind];
  if (!shot || !prompt?.final.trim()) return true;
  if (prompt.timingStale) return true;
  if (prompt.promptTask?.visualPolicy === 'reference-first-v1') return false;
  return !!project.materials?.some((material): boolean => material.kind === 'character' && shot.characterIds.includes(material.entityId) && !!material.visualBasis);
}
