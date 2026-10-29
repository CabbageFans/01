import type { PetStoryChatJob, PetStoryPlan, PetStoryProject } from '@doubao-studio/contracts';

/** 只在只读界面把已知实体标识投影为名称，原回复和创作正文不改写。 */
export function planDisplayText(plan: PetStoryPlan | undefined, text: string): string {
  if (!plan) return text;
  const entries = [...plan.characters, ...(plan.props || []), ...(plan.scenes || []), ...plan.shots.map((shot): { id: string; name: string } => ({ id: shot.id, name: `镜头 ${shot.order}` }))];
  return entries.sort((left, right): number => right.id.length - left.id.length).reduce((body, item): string => {
    const escaped = item.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return body.replace(new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`, 'g'), (): string => item.name);
  }, text);
}

/** 将一次分析及其格式修订投影为同一创作结果，原始请求仍完整保留。 */
export function planRequestRoot(project: PetStoryProject, job: PetStoryChatJob): PetStoryChatJob | undefined {
  const seen = new Set<string>();
  let current: PetStoryChatJob | undefined = job;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.kind === 'analysis') return current;
    if (current.kind !== 'repair' || !current.parentJobId) return undefined;
    current = project.jobs.find((item): boolean => item.id === current?.parentJobId);
  }
  return undefined;
}

export interface PetStoryPlanReviewSelection {
  job?: PetStoryChatJob;
  family: PetStoryChatJob[];
  history: PetStoryChatJob[];
}

export function selectPlanReview(project: PetStoryProject): PetStoryPlanReviewSelection {
  const history = project.jobs.filter((job): boolean => !!planRequestRoot(project, job));
  const current = history.filter((job): boolean => !job.sourceStoryId || job.sourceStoryId === project.mobileStory?.id);
  const root = [...current].reverse().find((job): boolean => job.kind === 'analysis');
  const family = root ? current.filter((job): boolean => planRequestRoot(project, job)?.id === root.id) : [];
  // 迟到的父回复不得盖过后续修订；一轮请求只显示最后的真实处理结果。
  return { job: family.at(-1), family, history };
}
