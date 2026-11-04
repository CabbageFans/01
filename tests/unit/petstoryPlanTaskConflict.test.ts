import { describe, expect, it } from 'vitest';
import type { PetStoryProject, Task } from '@doubao-studio/contracts';
import { planFeedbackBlockingTask } from '../../src/utils/petstoryPlanTaskConflict';

const now = '2026-11-03T00:00:00.000Z';
const nowMs = Date.parse(now);
function project(): PetStoryProject {
  return { schemaVersion: 1, id: 'TEST-short-drama', revision: 1, studioProjectId: 'TEST-shared-studio', accountId: 'TEST-account',
    source: { kind: 'script', url: '', status: 'review_required' }, jobs: [], assets: [], updatedAt: now };
}
function task(id: string, fields: Partial<Task> = {}): Task {
  return { id, projectId: 'TEST-shared-studio', assignedAccountId: 'TEST-account', mode: 'chat', status: 'paused', prompt: 'TEST 离线原请求', result: null, outputs: [],
    errorInfo: { code: 'submission_uncertain', message: 'TEST 原结果待核对', recoverable: true, detectedAt: now }, createdAt: now, updatedAt: now, ...fields };
}

describe('方案反馈的任务占用范围', (): void => {
  it('同账号同Studio的其他短剧与未关联smoke历史不占用，查询不改写记录', (): void => {
    const p = project();
    const tasks = [task('TEST-smoke-one'), task('TEST-smoke-two', { petstory: { projectId: 'TEST-other-short-drama', stepId: 'TEST-old-step' } }),
      task('TEST-other-studio', { projectId: 'TEST-other-studio' }), task('TEST-expired-lease', { lock: { ownerId: 'TEST-old-owner', acquiredAt: now, expiresAt: new Date(nowMs - 1).toISOString() } })];
    const before = structuredClone({ project: p, tasks });
    expect(planFeedbackBlockingTask(p, tasks, nowMs)).toBeUndefined(); expect({ project: p, tasks }).toEqual(before);
  });

  it.each(['job', 'production-step', 'task-binding', 'runtime-binding'] as const)('通过%s明确关联当前短剧的提交不明仍须先核对', (binding): void => {
    const p = project(); const original = task('TEST-current-original');
    if (binding === 'job') p.jobs.push({ id: 'TEST-job', taskId: original.id, kind: 'analysis', status: 'bound', inputHash: 'TEST', sourceUrl: '' });
    if (binding === 'task-binding') original.petstory = { projectId: p.id, stepId: 'TEST-step' };
    if (binding === 'runtime-binding') original.runtime = { runId: 'TEST-run', attempt: 1, stage: 'paused', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      submittedAt: now, input: { mode: 'chat', prompt: original.prompt, attachments: [], petstory: { projectId: p.id, stepId: 'TEST-step' } } };
    if (binding === 'production-step') {
      const entry = { state: 'unknown' as const, reason: 'TEST 离线未检查' };
      p.production = { state: 'paused', planHash: 'TEST', approvedAt: now, capability: { accountId: p.accountId, image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [] },
        fallbacks: {}, shots: {}, steps: [{ id: 'TEST-step', kind: 'firstFrame', taskId: original.id, status: 'bound', inputHash: 'TEST', attachmentAssetIds: [] }], message: 'TEST 原制作保留' };
    }
    expect(planFeedbackBlockingTask(p, [task('TEST-unrelated-history'), original], nowMs)).toBe(original);
  });

  it.each(['executing', 'generating', 'manual_submission_observing', 'waiting_verification', 'waiting_generation_confirmation'] as const)('其他短剧在同账号处于%s仍占用执行账号', (status): void => {
    const p = project(); const active = task('TEST-other-live-task', { status, petstory: { projectId: 'TEST-other-short-drama', stepId: 'TEST-other-step' } });
    expect(planFeedbackBlockingTask(p, [active], nowMs)).toBe(active);
  });

  it('其他短剧的有效执行租约仍占用账号，过期后只保留原历史', (): void => {
    const p = project(); const original = task('TEST-leased-other-task', { lock: { ownerId: 'TEST-owner', acquiredAt: now, expiresAt: new Date(nowMs + 1000).toISOString() } });
    expect(planFeedbackBlockingTask(p, [original], nowMs)).toBe(original);
    expect(planFeedbackBlockingTask(p, [original], nowMs + 1000)).toBeUndefined();
  });

  it('当前短剧冲突优先于列表里更早的其他活动任务，不按列表位置打开旧smoke', (): void => {
    const p = project(); const current = task('TEST-current-original', { petstory: { projectId: p.id, stepId: 'TEST-step' } });
    const tasks = [task('TEST-smoke-history'), task('TEST-other-active', { status: 'generating' }), current];
    expect(planFeedbackBlockingTask(p, tasks, nowMs)).toBe(current);
  });

  it('其他账号的运行和租约不占用本账号，当前已完成且无锁任务也不阻断', (): void => {
    const p = project(); const tasks = [task('TEST-other-account', { status: 'generating', assignedAccountId: 'TEST-other-account', petstory: { projectId: p.id, stepId: 'TEST-step' },
      lock: { ownerId: 'TEST-other-owner', acquiredAt: now, expiresAt: new Date(nowMs + 1000).toISOString() } }), task('TEST-done-original', { status: 'done', petstory: { projectId: p.id, stepId: 'TEST-step' } })];
    expect(planFeedbackBlockingTask(p, tasks, nowMs)).toBeUndefined();
  });
});
