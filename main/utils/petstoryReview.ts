import type { PetStoryChatJob } from '@doubao-studio/contracts';

/** 缺逐项快照的旧全局审查仅留历史；旧单项只兼容其本目标的 inputFinal。 */
export function reviewedPromptFinal(job: PetStoryChatJob, targetId: string): string | undefined {
  if (job.reviewInputFinals !== undefined) return Object.prototype.hasOwnProperty.call(job.reviewInputFinals, targetId) ? job.reviewInputFinals[targetId] : undefined;
  const selected = job.materialId || (job.shotId && job.promptKind ? `${job.shotId}:${job.promptKind}` : undefined);
  return selected === targetId ? job.inputFinal : undefined;
}

/** 比较正文原文，不能以新候选、相似内容或项目当前状态补齐审查历史。 */
export function reviewMatchesPrompt(job: PetStoryChatJob, targetId: string, currentFinal: string): boolean {
  const reviewed = reviewedPromptFinal(job, targetId);
  return reviewed !== undefined && reviewed === currentFinal;
}
