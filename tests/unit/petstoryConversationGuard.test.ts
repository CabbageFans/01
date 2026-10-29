/** TaskService/Repository 持久对话保护；不访问平台、不创建第二存储。 */
import { describe, expect, it } from 'vitest';
import type { Task, TaskRunSnapshot } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { TaskRepository } from '../../main/core/TaskRepository';
import { TaskEventStream } from '../../main/core/TaskEventStream';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';

const now = '2026-10-29T07:00:00.000Z';
function task(id: string, status: Task['status'] = 'done', accountId = 'TEST-account'): Task {
  return { id, projectId: 'TEST-studio', prompt: 'TEST source text', assignedAccountId: accountId, mode: 'chat', status, executionIntent: 'hold', result: null, outputs: [], artifacts: [],
    createdAt: now, updatedAt: now, runtime: { runId: `TEST-run-${id}`, attempt: 1, stage: 'completed', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { prompt: 'TEST source text', mode: 'chat', attachments: [] } } };
}
function fixture(initial: Task[] = [task('source'), task('queued', 'queued'), task('other-account', 'queued', 'TEST-other-account')]): {
  service: TaskService; reopen: () => TaskService; read: () => Task[]; fail: (enabled: boolean) => void; drift: (enabled: boolean) => void;
} {
  let data: Task[] = structuredClone(initial); let fail = false; let drift = false;
  const repository = new TaskRepository({ read: (): unknown => structuredClone(data), write: (_name: string, items: Task[]): boolean => {
    if (fail) return false;
    data = structuredClone(items);
    if (drift) for (const item of data) if (item.runtime?.chatAdjustmentGuard) item.runtime.chatAdjustmentGuard.active = !item.runtime.chatAdjustmentGuard.active;
    return true;
  }, normalize: normalizeTasks, defaultProjectId: (): string => 'TEST-studio', events: new TaskEventStream() });
  const reopen = (): TaskService => new TaskService({ store: repository, defaultProjectId: (): string => 'TEST-studio', now: (): string => now, nowMs: (): number => Date.parse(now) });
  return { service: reopen(), reopen, read: (): Task[] => structuredClone(data), fail: (enabled: boolean): void => { fail = enabled; }, drift: (enabled: boolean): void => { drift = enabled; } };
}

describe('源任务持久对话保护', (): void => {
  it.each(['done', 'fail', 'paused', 'cancelled'] as const)('源任务%s也保护同账号，归一化和重新创建服务后仍阻断，另一账号可执行', (status): void => {
    const f = fixture([task('source', status), task('queued', 'queued'), task('other-account', 'queued', 'TEST-other-account')]);
    f.service.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', true);
    expect(f.read()[0].runtime?.chatAdjustmentGuard).toEqual({ projectId: 'TEST-project', adjustmentId: 'TEST-adjustment', active: true });
    const restored = f.reopen(); expect(restored.acquireLock({ taskId: 'queued', ownerId: 'TEST-owner' }).success).toBe(false);
    expect(restored.acquireLock({ taskId: 'other-account', ownerId: 'TEST-owner' }).success).toBe(true);
    restored.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', false);
    restored.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', false);
    expect(restored.acquireLock({ taskId: 'queued', ownerId: 'TEST-owner' }).success).toBe(true);
  });
  it('错误项目／调整不能释放或覆盖；源任务不能改派、删除、编辑或重跑来绕过保护', (): void => {
    const f = fixture(); f.service.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', true);
    for (const active of [true, false]) expect((): void => f.service.setConversationGuard('source', 'TEST-other-project', 'TEST-other-adjustment', active)).toThrow('不属于');
    expect(f.service.assign({ taskId: 'source', accountId: 'TEST-other-account' }).success).toBe(false);
    expect(f.service.delete('source').success).toBe(false); expect(f.service.update({ taskId: 'source', updates: { prompt: 'TEST changed' } }).success).toBe(false);
    expect(f.service.updateStatus({ taskId: 'source', status: 'cancelled', result: 'TEST renderer race' }).success).toBe(false);
    expect(f.service.retry('source').success).toBe(false);
    expect(f.service.updateRuntime({ taskId: 'source', runtime: { chatAdjustmentGuard: undefined } }).success).toBe(false);
    for (const runId of ['TEST-other-run', '', undefined]) expect(f.service.updateRuntime({ taskId: 'source', runtime: { runId } }).success).toBe(false);
    expect(f.service.updateRuntime({ taskId: 'source', runtime: { message: 'TEST passive update', stage: 'paused' } }).success).toBe(true);
    expect(f.reopen().acquireLock({ taskId: 'queued', ownerId: 'TEST-owner' }).success).toBe(false);
  });
  it('同账号不同源任务不能抢已存在保护，调用无保护的任务也不能解除它', (): void => {
    const f = fixture([task('source'), task('another-source')]); f.service.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', true);
    expect((): void => f.service.setConversationGuard('another-source', 'TEST-next-project', 'TEST-next-adjustment', true)).toThrow('另一项');
    expect((): void => f.service.setConversationGuard('another-source', 'TEST-project', 'TEST-adjustment', false)).toThrow('不属于');
    expect(f.read()[0].runtime?.chatAdjustmentGuard?.active).toBe(true);
  });
  it.each(['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'] as const)('开始时重查同账号%s，原检查后的竞态不得授予自由聊保护', (status): void => {
    const f = fixture([task('source'), task('racing-task', status)]);
    expect((): void => f.service.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', true)).toThrow('请先处理');
    expect(f.read()[0].runtime?.chatAdjustmentGuard).toBeUndefined();
  });
  it('任何同账号有效执行锁和提交不明均阻止新保护，不依赖任务显示状态', (): void => {
    const queued = task('racing-task', 'queued'); queued.lock = { ownerId: 'TEST-owner', acquiredAt: now, expiresAt: '2026-10-29T07:01:00.000Z' };
    expect((): void => fixture([task('source'), queued]).service.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', true)).toThrow('请先处理');
    const uncertain = task('racing-task', 'paused'); uncertain.runtime!.submittedAt = now; uncertain.errorInfo = { code: 'submission_uncertain', message: 'TEST', detectedAt: now, recoverable: false };
    expect((): void => fixture([task('source'), uncertain]).service.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', true)).toThrow('请先处理');
  });
  it('明确取消旧提交不明任务只结束占用，另一done会话可保护，原任务仍禁止重发且证据完整保留', (): void => {
    const uncertain = task('old-test', 'paused'); uncertain.runtime!.submittedAt = now;
    uncertain.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-original-conversation';
    uncertain.errorInfo = { code: 'submission_uncertain', message: 'TEST 原提交待核对', detectedAt: now, recoverable: false };
    const f = fixture([task('source'), uncertain]);
    expect((): void => f.service.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', true)).toThrow('请先处理');
    const preserved = f.read()[1];
    expect(f.service.updateStatus({ taskId: uncertain.id, status: 'cancelled', result: 'TEST 本人明确结束旧等待' }).success).toBe(true);
    f.service.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', true);
    expect(f.read()[0].runtime?.chatAdjustmentGuard?.active).toBe(true);
    expect(f.read()[1]).toEqual({ ...preserved, status: 'cancelled', result: 'TEST 本人明确结束旧等待' });
    expect(f.service.retry(uncertain.id)).toMatchObject({ success: false, error: expect.stringContaining('禁止重新发送') });
    expect(f.read()[1].runtime).toEqual(preserved.runtime); expect(f.read()[1].errorInfo).toEqual(preserved.errorInfo);
  });
  it('已取消记录仍带有效执行锁或其他创作保护时，不授予另一对话保护', (): void => {
    const locked = task('old-test', 'cancelled'); locked.lock = { ownerId: 'TEST-owner', acquiredAt: now, expiresAt: '2026-10-29T07:01:00.000Z' };
    expect((): void => fixture([task('source'), locked]).service.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', true)).toThrow('请先处理');
    const guarded = task('old-test', 'cancelled'); guarded.runtime!.chatAdjustmentGuard = { projectId: 'TEST-other-project', adjustmentId: 'TEST-other-adjustment', active: true };
    expect((): void => fixture([task('source'), guarded]).service.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', true)).toThrow('另一项');
  });
  it('缺运行／账号／源任务时不伪造运行；普通runtime写入不能伪造保护', (): void => {
    const missing = task('source'); delete missing.runtime;
    const f = fixture([missing, { ...task('no-account'), assignedAccountId: null }]);
    for (const id of ['source', 'no-account', 'missing']) expect((): void => f.service.setConversationGuard(id, 'TEST-project', 'TEST-adjustment', true)).toThrow('记录缺失');
    const runtime: Partial<TaskRunSnapshot> = { chatAdjustmentGuard: { projectId: 'TEST-project', adjustmentId: 'TEST-adjustment', active: true } };
    expect(f.service.updateRuntime({ taskId: 'source', runtime }).success).toBe(false); expect(f.read()[0].runtime).toBeUndefined();
  });
  it('写入失败不宣称保护／解除成功，解除失败后重启仍阻断', (): void => {
    const f = fixture(); f.fail(true);
    expect((): void => f.service.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', true)).toThrow('写入失败');
    f.fail(false); f.service.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', true); f.fail(true);
    expect((): void => f.service.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', false)).toThrow('写入失败');
    f.fail(false); expect(f.reopen().acquireLock({ taskId: 'queued', ownerId: 'TEST-owner' }).success).toBe(false);
    f.service.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', false);
  });
  it('写后回读漂移必须抛错，不能把未确认的落盘结果当成功', (): void => {
    const f = fixture(); f.drift(true);
    expect((): void => f.service.setConversationGuard('source', 'TEST-project', 'TEST-adjustment', true)).toThrow('回读不一致');
  });
});
