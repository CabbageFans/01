import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/types';
import { needsTaskAttention, taskNextAction } from '../../src/utils/workspace';

function task(patch: Partial<Task> = {}): Task {
  return { id: 'TEST-ui', prompt: 'TEST offline UI state', projectId: 'TEST-project', assignedAccountId: 'TEST-account', mode: 'video', status: 'queued', executionIntent: 'hold', result: null, outputs: [], createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z', ...patch };
}

describe('工作台只呈现既有执行事实', (): void => {
  it('指派账号和缺省意图仍显示待授权；仅 armed 显示等待调度', (): void => {
    expect(taskNextAction(task())).toBe('待授权执行');
    expect(taskNextAction(task({ executionIntent: undefined }))).toBe('待授权执行');
    expect(taskNextAction(task({ executionIntent: 'armed' }))).toContain('已授权');
  });
  it('依赖阻断优先于排队状态，进入人工处理入口', (): void => {
    const blocked = task({ errorInfo: { code: 'dependency_missing', message: 'TEST dependency', recoverable: false, detectedAt: '2026-10-25T00:00:00Z' } });
    expect(taskNextAction(blocked)).toBe('查看前置任务');
    expect(needsTaskAttention(blocked)).toBe(true);
  });
  it('提交不明只呈现核对原会话，不能表示普通重试', (): void => {
    const uncertain = task({ status: 'paused', runtime: { submittedAt: '2026-10-25T00:00:00Z' } as Task['runtime'], errorInfo: { code: 'submission_uncertain', message: 'TEST uncertain', recoverable: false, detectedAt: '2026-10-25T00:00:00Z' } });
    expect(taskNextAction(uncertain)).toBe('核对原会话');
    expect(needsTaskAttention(uncertain)).toBe(true);
  });
  it('平台等待参数确认与已受理观察分别呈现', (): void => {
    expect(taskNextAction(task({ status: 'waiting_generation_confirmation' }))).toContain('确认参数后只读回读');
    expect(taskNextAction(task({ status: 'manual_submission_observing' }))).toBe('核对原会话');
    expect(needsTaskAttention(task({ status: 'waiting_generation_confirmation' }))).toBe(true);
  });
  it('生成完成不会自动得到人工质量结论，拒收也不修改生成状态', (): void => {
    const completed = task({ status: 'done', outputs: ['TEST-output'] });
    expect(taskNextAction(completed)).toContain('人工质量未评');
    const rejected = task({ ...completed, qualityVerdict: { status: 'rejected', decidedAt: '2026-10-25T01:00:00Z', rejectionTags: ['character_consistency'] } });
    const before = structuredClone(rejected);
    expect(taskNextAction(rejected)).toContain('质量结论');
    expect(rejected).toEqual(before);
    expect(rejected.status).toBe('done');
  });
  it('正常未授权草稿和正在生成的任务不被误计为人工异常', (): void => {
    expect(needsTaskAttention(task())).toBe(false);
    expect(needsTaskAttention(task({ status: 'generating' }))).toBe(false);
    expect(needsTaskAttention(task({ status: 'waiting_verification' }))).toBe(true);
  });
});
