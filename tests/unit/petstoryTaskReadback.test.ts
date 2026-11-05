/** 隔离技术用例：模拟释放后的任务回读，不调用IPC、网页或真实项目。 */
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@doubao-studio/contracts';
import { readBackReleasedPetStoryTask } from '../../src/utils/petstoryTaskReadback';

function paused(): Task {
  const now = '2026-11-05T00:00:00.000Z';
  return { id: 'TEST-task', projectId: 'TEST-studio', assignedAccountId: 'TEST-account', mode: 'chat', status: 'paused', prompt: 'TEST原请求',
    outputs: [], result: null, createdAt: now, updatedAt: now, lock: { ownerId: 'TEST-owner', acquiredAt: now, expiresAt: '2999-01-01T00:00:00.000Z' },
    errorInfo: { code: 'page_unrecognized', message: 'TEST尚未发送', recoverable: true, detectedAt: now },
    runtime: { runId: 'TEST-run', attempt: 1, stage: 'paused', message: 'TEST尚未发送', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { mode: 'chat', prompt: 'TEST原请求', attachments: [] } } };
}

describe('后台Chat未发送暂停后的单任务租约回读', (): void => {
  it('采用释放后权威锁状态，保持同任务同运行且不修改其他任务或账号占用', async (): Promise<void> => {
    let current = paused(); const next = structuredClone(current); delete next.lock;
    const other = { ...paused(), id: 'TEST-other' }; const busy = { 'TEST-other-account': true };
    const list = vi.fn(async (): Promise<Task[]> => [next, other]);
    const replace = vi.fn((previous: Task, saved: Task): void => { if (current === previous) current = saved; });
    await readBackReleasedPetStoryTask(current.id, current.runtime!.runId, { current: (): Task => current, list, replaceIfCurrent: replace });
    expect(current).toBe(next); expect(current.lock).toBeUndefined(); expect(list).toHaveBeenCalledOnce(); expect(replace).toHaveBeenCalledOnce();
    expect(other.lock).toBeDefined(); expect(busy).toEqual({ 'TEST-other-account': true });
  });

  it('回读期间出现提交或产物证据时如实同步，不能凭释放动作清除', async (): Promise<void> => {
    let current = paused(); const next = structuredClone(current); delete next.lock;
    next.runtime!.submittedAt = next.updatedAt; next.runtime!.chatResponse = { text: 'TEST已取得原回复', capturedAt: next.updatedAt };
    await readBackReleasedPetStoryTask(current.id, current.runtime!.runId, { current: (): Task => current, list: async (): Promise<Task[]> => [next],
      replaceIfCurrent: (previous: Task, saved: Task): void => { if (current === previous) current = saved; } });
    expect(current.runtime!.submittedAt).toBe(next.updatedAt); expect(current.runtime!.chatResponse).toEqual(next.runtime!.chatResponse);
  });

  it.each(['new-run', 'new-local-state', 'account', 'project', 'prompt', 'missing'] as const)('拒绝%s的过期回读覆盖', async (change: string): Promise<void> => {
    let current = paused(); const before = current; const next = structuredClone(current); delete next.lock;
    if (change === 'new-run') next.runtime!.runId = 'TEST-new-run';
    if (change === 'account') next.assignedAccountId = 'TEST-other-account';
    if (change === 'project') next.projectId = 'TEST-other-studio';
    if (change === 'prompt') next.prompt = 'TEST另一输入';
    const replace = vi.fn();
    await readBackReleasedPetStoryTask(before.id, before.runtime!.runId, { current: (): Task => current,
      list: async (): Promise<Task[]> => { if (change === 'new-local-state') current = { ...before, result: 'TEST本地新状态' }; return change === 'missing' ? [] : [next]; }, replaceIfCurrent: replace });
    expect(replace).not.toHaveBeenCalled(); expect(current.lock).toEqual(before.lock);
    if (change === 'new-local-state') expect(current.result).toBe('TEST本地新状态');
    else expect(current).toBe(before);
  });

  it.each(['submitted', 'running', 'wrong-error', 'unknown-run'] as const)('当前已%s时不发起此未发送暂停回读', async (change: string): Promise<void> => {
    const current = paused(); const list = vi.fn(); const replace = vi.fn();
    if (change === 'submitted') current.runtime!.submittedAt = current.updatedAt;
    if (change === 'running') current.status = 'executing';
    if (change === 'wrong-error') current.errorInfo!.code = 'submission_uncertain';
    await readBackReleasedPetStoryTask(current.id, change === 'unknown-run' ? undefined : current.runtime!.runId,
      { current: (): Task => current, list, replaceIfCurrent: replace });
    expect(list).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
  });

  it('读取失败时保留陈旧锁的保守状态，不能伪装已经释放', async (): Promise<void> => {
    const current = paused(); const replace = vi.fn();
    await readBackReleasedPetStoryTask(current.id, current.runtime!.runId, { current: (): Task => current,
      list: async (): Promise<Task[]> => { throw new Error('TEST读取失败'); }, replaceIfCurrent: replace });
    expect(replace).not.toHaveBeenCalled(); expect(current.lock).toBeDefined();
  });
});
