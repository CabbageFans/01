import { describe, expect, it } from 'vitest';
import type { PetStoryChatJob, PetStoryProject } from '@doubao-studio/contracts';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { normalizeRepairShotAliases } from '../../main/utils/petstoryRepairIds';

function fixture(): { project: PetStoryProject; parent: PetStoryChatJob; job: PetStoryChatJob; original: Record<string, unknown>; answer: Record<string, unknown> } {
  const shots = ['sh01', 'sh06', 'sh07'].map((id: string, index: number): Record<string, unknown> => ({ id, order: index + 1, action: `TEST原动作${index}`, predecessorShotIds: index ? [`base${index}`] : [],
    ...(index === 2 ? { previousShotId: 'sh06' } : {}), dialogue: [{ speakerId: 'actor', text: 'TEST原台词' }],
    timingPlan: { events: [{ id: `${id}-a`, kind: 'action', description: 'TEST动作', startSeconds: 0, endSeconds: 1 }, { id: `${id}-b`, kind: 'reaction', description: 'TEST反应', startSeconds: 1, endSeconds: 2, afterEventId: `${id}-a` }], estimatedRequiredSeconds: 2 } }));
  const original = { shots }; const incoming = structuredClone(shots);
  incoming[1].id = 'sh08'; incoming[2].id = 'sh09'; incoming[2].previousShotId = 'sh08';
  const timing = incoming[1].timingPlan as { events: { id: string; afterEventId?: string }[] };
  timing.events[0].id = 'sh08-a'; timing.events[1].id = 'sh08-b'; timing.events[1].afterEventId = 'sh08-a';
  const parent: PetStoryChatJob = { id: 'parent', taskId: 'task-parent', kind: 'repair', originKind: 'analysis', status: 'invalid', inputHash: 'test', sourceUrl: '',
    validationDetails: [{ code: 'structure', path: '$.shots[2].id', actual: 'sh07', actualType: 'string', expected: '新ID', repairable: true, message: 'TEST被占用' }] };
  const job: PetStoryChatJob = { id: 'child', taskId: 'task-child', kind: 'repair', originKind: 'analysis', parentJobId: parent.id, status: 'bound', inputHash: 'test', sourceUrl: '' };
  const project: PetStoryProject = { schemaVersion: 1, id: 'project', accountId: 'account', studioProjectId: 'studio', revision: 1, source: { kind: 'script', url: '', status: 'review_required' }, jobs: [parent, job], assets: [], drafts: [], updatedAt: '2026-11-05T00:00:00.000Z' };
  return { project, parent, job, original, answer: { shots: incoming } };
}

describe('未采用新镜头纯技术别名规范化', (): void => {
  it('只还原未报错镜头与事件编号、精确同步连续引用，不恢复真正报错的旧ID且不改变原文', (): void => {
    const data = fixture(); const before = structuredClone(data);
    const result = normalizeRepairShotAliases(data.project, data.job, data.parent, data.original, data.answer);
    const shots = result.answer.shots as Record<string, unknown>[];
    expect(shots.map((shot): unknown => shot.id)).toEqual(['sh01', 'sh06', 'sh09']);
    expect(shots[1]).toEqual((data.original.shots as unknown[])[1]); expect(shots[2].previousShotId).toBe('sh06');
    expect(result.corrections).toEqual([expect.stringContaining('sh08→sh06')]); expect(data).toEqual(before);
  });

  it.each(['action', 'dialogue', 'window', 'event-description', 'dependency', 'extra-event-field', 'predecessor', 'order', 'targeted-error', 'global-error', 'formal-id', 'adopted-history', 'media', 'new-id-collision', 'duplicate-event-id'] as const)('%s不构成无损未采用别名，不进行编号回填', (change: string): void => {
    const data = fixture(); const shots = data.answer.shots as Record<string, unknown>[]; const shot = shots[1];
    const events = (shot.timingPlan as { events: Record<string, unknown>[] }).events;
    if (change === 'action') shot.action = 'TEST不同动作';
    if (change === 'dialogue') shot.dialogue = [{ speakerId: 'actor', text: 'TEST不同台词' }];
    if (change === 'window') events[0].endSeconds = 0.8;
    if (change === 'event-description') events[0].description = 'TEST不同事件';
    if (change === 'dependency') delete events[1].afterEventId;
    if (change === 'extra-event-field') events[0].parallel = true;
    if (change === 'predecessor') shot.predecessorShotIds = ['other'];
    if (change === 'order') shot.order = 3;
    if (change === 'targeted-error') data.parent.validationDetails![0].path = '$.shots[1].id';
    if (change === 'global-error') data.parent.validationDetails![0].path = '$';
    if (change === 'formal-id') data.project.plan = { ...structuredClone(snapshot.plan), shots: [{ ...snapshot.plan.shots[0], id: 'sh06' }] } as NonNullable<PetStoryProject['plan']>;
    if (change === 'adopted-history') data.project.jobs.push({ ...data.parent, id: 'adopted', status: 'applied', resultStatus: 'adopted', parsedResult: { plan: { ...structuredClone(snapshot.plan), shots: [{ ...snapshot.plan.shots[0], id: 'sh06' }] } as NonNullable<PetStoryProject['plan']> } });
    if (change === 'media') data.project.assets.push({ id: 'media', kind: 'firstFrame', shotId: 'sh06', relativePath: 'test.png' });
    if (change === 'new-id-collision') shot.id = 'sh07';
    if (change === 'duplicate-event-id') events[1].id = events[0].id;
    const result = normalizeRepairShotAliases(data.project, data.job, data.parent, data.original, data.answer);
    expect(result.corrections).toEqual([]); expect(result.answer).toBe(data.answer);
  });
});
