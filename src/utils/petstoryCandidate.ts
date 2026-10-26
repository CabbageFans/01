import type { PetStoryChatJob } from '@doubao-studio/contracts';

/** 格式纠正后的审查保留职责；界面与局部修订均使用实际保存 issues 的回复 ID。 */
export function isSavedReviewResult(job: PetStoryChatJob, jobs: PetStoryChatJob[]): boolean {
  if (job.status !== 'applied' || job.resultStatus === 'stale' || !job.parsedResult?.issues) return false;
  if (job.kind === 'review') return true;
  if (job.kind !== 'repair') return false;
  const original = jobs.find((item): boolean => item.id === job.parentJobId);
  return original?.kind === 'review' && !!original.requestId && original.sourceStoryId === job.sourceStoryId;
}

/** 仅识别已持久化的 Chat JSON 候选，用于来源展示，不生成或改写创作正文。 */
export function readSavedPromptCandidate(rawText: string | undefined): string | undefined {
  if (!rawText) return undefined;
  try {
    const value: unknown = JSON.parse(rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (value && typeof value === 'object' && 'optimized' in value && typeof value.optimized === 'string') return value.optimized;
  } catch { /* 无法证明来源时显示已有内容，不猜测为豆包新回复。 */ }
  return undefined;
}
