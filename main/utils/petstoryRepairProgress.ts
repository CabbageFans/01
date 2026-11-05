import { createHash } from 'node:crypto';
import type { PetStoryAssetBindings, PetStoryChatJob, PetStoryPlan, PetStoryProject } from '@doubao-studio/contracts';
import { parsePetStoryAnswer } from './petstoryValidation';

/** 创作正文、镜头顺序及全部问题实际值都参与比较；不把键序当成内容。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]): number => a.localeCompare(b)).map(([key, item]): [string, unknown] => [key, canonical(item)]));
}
// 计划与资产合同的全部字段由类型检查穷尽；未知顶层回执不构成实际创作进展。
const planAndAssetFields: Record<keyof (PetStoryPlan & PetStoryAssetBindings), true> = {
  sourceSummary: true, adaptedStory: true, understanding: true, sceneDesign: true,
  characters: true, props: true, scenes: true, shots: true, shotBindings: true,
};
const creativeFields = new Set([...Object.keys(planAndAssetFields), 'storyUsable', 'contentBasis', 'requiresConfirmation', 'changeReason', 'optimized', 'issues']);
function withoutEnvelope(value: Record<string, unknown>): Record<string, unknown> {
  const answer = Object.fromEntries(Object.entries(value).filter(([key]): boolean => creativeFields.has(key)));
  // storyUsable=true时reason只是“已修正”等回执，不属于实际方案；false时保留不足原因。
  if (answer.storyUsable !== true && value.reason !== undefined) answer.reason = value.reason;
  return answer;
}
function failureValue(value: unknown, job: PetStoryChatJob): unknown {
  if (Array.isArray(value)) return value.map((item: unknown): unknown => failureValue(item, job));
  if (!value || typeof value !== 'object') return value;
  const entry = value as Record<string, unknown>;
  const normalized = job.requestId && entry.requestId === job.requestId ? withoutEnvelope(entry) : entry;
  return Object.fromEntries(Object.entries(normalized).map(([key, item]): [string, unknown] => [key, failureValue(item, job)]));
}
function replySignature(job: PetStoryChatJob): string {
  try {
    return JSON.stringify(canonical(withoutEnvelope(parsePetStoryAnswer(job.rawText || ''))));
  } catch {
    return (job.rawText || '').split(job.requestId || '\u0000').join('[本轮请求标识]').trim();
  }
}
function failureSignature(job: PetStoryChatJob): string | undefined {
  if (job.status !== 'invalid' || !job.rawText || !job.validationDetails?.length || job.validationDetails.some((issue): boolean => !issue.repairable)) return undefined;
  const reply = replySignature(job);
  // 诊断措辞更新不算创作进展；比较问题位置、类型和真实失败值。
  const issues = job.validationDetails.map((issue): object => ({ code: issue.code, path: issue.path,
    actualType: issue.actualType, actual: issue.actual === job.rawText ? reply : failureValue(issue.actual, job) })).map((issue): string => JSON.stringify(canonical(issue))).sort();
  return createHash('sha256').update(JSON.stringify({ reply, issues })).digest('hex');
}

/** 不按轮数限流：只有连续三份完整创作结果与具体错误都相同，才认定自动修订没有进展。 */
export function stalledAutomaticRepairMessage(project: PetStoryProject, job: PetStoryChatJob): string | undefined {
  const signature = failureSignature(job);
  if (!signature) return undefined;
  let current: PetStoryChatJob | undefined = job;
  const seen = new Set<string>();
  for (let repeats = 0; current && !seen.has(current.id) && failureSignature(current) === signature; repeats += 1) {
    if (repeats === 2) return '连续三次回复的方案或正文及校验问题完全相同，自动修订没有进展，已暂停。原回复和当前采用内容均已保留，可查看原回复或明确继续修正。';
    seen.add(current.id);
    // 用户明确继续后从该轮重新观察；不继承上一次授权段的停滞判定。
    if (current.kind !== 'repair' || current.repairMode === 'explicit') break;
    current = project.jobs.find((item): boolean => item.id === current?.parentJobId);
  }
  return undefined;
}
