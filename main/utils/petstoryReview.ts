import type { PetStoryChatJob, PetStoryProject, PetStoryPrompt, PetStoryReviewIssue, PetStoryRuntimeTarget } from '@doubao-studio/contracts';

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

/** 泛设计变更标记不等于正文错误；只保留精确对应当前正文的实际审查证据。 */
export function hasCurrentPromptReviewError(p: PetStoryProject, prompt: PetStoryPrompt, target: PetStoryRuntimeTarget): boolean {
  if (!prompt.needsReview || prompt.edited) return false;
  const key = target.materialId || (target.shotId && target.promptKind ? `${target.shotId}:${target.promptKind}` : undefined);
  if (!key) return false;
  const matches = (issue: PetStoryReviewIssue): boolean => issue.severity === 'error'
    && (issue.targetId === key || issue.targetId === target.shotId && (!issue.promptKind || issue.promptKind === target.promptKind));
  return p.jobs.some((job): boolean => {
    if (job.sourceStoryId !== p.mobileStory?.id || job.resultStatus === 'stale') return false;
    const review = job.kind === 'review' || job.kind === 'repair' && (job.originKind === 'review'
      || p.jobs.some((parent): boolean => parent.id === job.parentJobId && parent.kind === 'review'));
    if (review && job.status === 'applied' && reviewMatchesPrompt(job, key, prompt.final)) return !!job.parsedResult?.issues?.some(matches);
    if (job.kind !== 'revise' || job.status !== 'invalid' || job.inputFinal !== prompt.final
      || (target.materialId ? job.materialId !== target.materialId : job.shotId !== target.shotId || job.promptKind !== target.promptKind)) return false;
    const parent = p.jobs.find((item): boolean => item.id === job.parentJobId && item.sourceStoryId === p.mobileStory?.id
      && item.resultStatus !== 'stale' && reviewMatchesPrompt(item, key, prompt.final));
    return !!parent?.parsedResult?.issues?.some((issue): boolean => matches(issue) && !!job.selectedIssueIds?.includes(issue.id));
  });
}
