import { isDeepStrictEqual } from 'node:util';
import type { PetStoryChatJob, PetStoryProject } from '@doubao-studio/contracts';

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function shotId(value: unknown): string | undefined { const id = object(value)?.id; return typeof id === 'string' && !!id ? id : undefined; }
function reservedIds(project: PetStoryProject, job: PetStoryChatJob): Set<string> {
  const selected = job.planFeedback?.baseJobId ? project.jobs.find((item): boolean => item.id === job.planFeedback?.baseJobId)?.parsedResult?.plan : undefined;
  const adoptedPlans = project.jobs.filter((item): boolean => item.resultStatus === 'adopted').flatMap((item): string[] => item.parsedResult?.plan?.shots.map((shot): string => shot.id) || []);
  const production = [project.production, ...(project.productionHistory || [])].flatMap((item): string[] => item ? [...Object.keys(item.shots), ...item.steps.flatMap((step): string[] => step.shotId ? [step.shotId] : [])] : []);
  return new Set([...[...(project.plan?.shots || []), ...(selected?.shots || [])].map((shot): string => shot.id), ...adoptedPlans, ...production,
    ...project.assets.flatMap((asset): string[] => asset.shotId ? [asset.shotId] : []), ...(project.drafts || []).map((draft): string => draft.shotId)]);
}
function untouched(parent: PetStoryChatJob, index: number, id: string): boolean {
  return !!parent.validationDetails?.length && parent.validationDetails.every((issue): boolean => issue.path !== '$' && issue.path !== '$.shots' && issue.path !== '$.shots.length'
    && issue.targetId !== id && !issue.path.startsWith(`$.shots[${index}]`));
}
function eventAliases(before: Record<string, unknown>, after: Record<string, unknown>): Map<string, string> | undefined {
  const oldEvents = object(before.timingPlan)?.events; const newEvents = object(after.timingPlan)?.events;
  if (oldEvents === undefined && newEvents === undefined) return new Map();
  if (!Array.isArray(oldEvents) || !Array.isArray(newEvents) || oldEvents.length !== newEvents.length) return undefined;
  const oldIds = oldEvents.map(shotId); const newIds = newEvents.map(shotId);
  if (oldIds.some((id): boolean => !id) || newIds.some((id): boolean => !id) || new Set(oldIds).size !== oldIds.length || new Set(newIds).size !== newIds.length) return undefined;
  return new Map(newIds.flatMap((id, index): [string, string][] => { const oldId = oldIds[index]; return id && oldId ? [[id, oldId]] : []; }));
}
function normalizeShot(value: unknown, before: unknown, aliases: Map<string, string>): unknown {
  const shot = object(value); const original = object(before);
  if (!shot || !original) return value;
  const normalized = structuredClone(shot);
  if (typeof shot.previousShotId === 'string' && aliases.has(shot.previousShotId)) normalized.previousShotId = aliases.get(shot.previousShotId);
  if (typeof shot.id !== 'string' || !aliases.has(shot.id)) return normalized;
  normalized.id = aliases.get(shot.id);
  const events = eventAliases(original, shot);
  const timing = object(normalized.timingPlan);
  if (events && timing && Array.isArray(timing.events)) timing.events = timing.events.map((value: unknown): unknown => {
    const event = object(value);
    if (!event) return value;
    return { ...event, id: events.get(String(event.id)) || event.id,
      ...(typeof event.afterEventId === 'string' && events.has(event.afterEventId) ? { afterEventId: events.get(event.afterEventId) } : {}) };
  });
  return normalized;
}

/** 只把未采用、未报错且语义逐字段完全相同的新镜头别名还原父稳定ID；不补写任何创作值。 */
export function normalizeRepairShotAliases(project: PetStoryProject, job: PetStoryChatJob, parent: PetStoryChatJob | undefined, original: Record<string, unknown> | undefined,
  answer: Record<string, unknown>): { answer: Record<string, unknown>; corrections: string[] } {
  if (job.kind !== 'repair' || parent?.status !== 'invalid' || parent.resultStatus === 'adopted' || !original || !Array.isArray(original.shots) || !Array.isArray(answer.shots)
    || original.shots.length !== answer.shots.length) return { answer, corrections: [] };
  const previous: unknown[] = original.shots; const incoming: unknown[] = answer.shots;
  const oldIds = previous.map(shotId); const newIds = incoming.map(shotId); const reserved = reservedIds(project, job);
  if (oldIds.some((id): boolean => !id) || newIds.some((id): boolean => !id) || new Set(oldIds).size !== oldIds.length || new Set(newIds).size !== newIds.length) return { answer, corrections: [] };
  const aliases = new Map<string, string>();
  incoming.forEach((value: unknown, index: number): void => {
    const before = object(previous[index]); const after = object(value); const oldId = oldIds[index]; const newId = newIds[index];
    if (!before || !after || !oldId || !newId || oldId === newId || reserved.has(oldId) || reserved.has(newId) || oldIds.includes(newId) || newIds.includes(oldId)
      || !untouched(parent, index, oldId) || !eventAliases(before, after)) return;
    aliases.set(newId, oldId);
  });
  // 一个别名被否决时，依赖它的别名也重新比较；集合只缩小，有限步收敛，不依赖任意轮数上限。
  let removed: boolean;
  do {
    removed = false;
    incoming.forEach((value: unknown, index: number): void => {
      const id = newIds[index];
      if (id && aliases.has(id) && !isDeepStrictEqual(normalizeShot(value, previous[index], aliases), previous[index])) { aliases.delete(id); removed = true; }
    });
  } while (removed);
  if (!aliases.size) return { answer, corrections: [] };
  return { answer: { ...answer, shots: incoming.map((value: unknown, index: number): unknown => normalizeShot(value, previous[index], aliases)) },
    corrections: [...aliases].map(([from, to]): string => `未采用镜头纯技术别名${from}→${to}，事件编号与连续引用按同一映射还原；创作内容未改写`) };
}
