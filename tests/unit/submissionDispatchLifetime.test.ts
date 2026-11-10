import { describe, expect, it, vi } from 'vitest';
import { dispatchSubmissionAttempt } from '../../src/automation/SubmissionCoordinator';
import { HumanVerificationRequiredError } from '../../src/utils/humanVerification';
import type { SubmissionDispatchSafety } from '../../src/utils/doubaoBridge';
import { videoSubmissionHarness } from '../fixtures/videoSubmissionHarness';

/** 公共协调器与真实TaskService组合；不再从React源码截取一段函数执行。 */
describe('单次派发的耐久事实', (): void => {
  it.each(['chat', 'image', 'video'] as const)('%s 意图保存不代表已发，激活前必须先落盘未知派发', async (mode): Promise<void> => {
    const fixture = videoSubmissionHarness(mode); const events: string[] = [];
    expect(fixture.current().runtime?.submittedAt).toBeUndefined();
    const dispatch = vi.fn(async (safety: SubmissionDispatchSafety): Promise<{ kind: 'dispatch_attempted'; activated: true }> => {
      expect(safety.dispatchKey).toBe('fixture-operation'); expect(safety.expectedPrompt).toBe('fixture prompt');
      await safety.beforeDispatch?.(); events.push(fixture.current().runtime?.submission?.state || 'missing');
      events.push('activate'); return { kind: 'dispatch_attempted', activated: true };
    });
    expect(await dispatchSubmissionAttempt({ ...fixture, dispatch })).toMatchObject({ kind: 'dispatch_attempted' });
    expect(events).toEqual(['dispatch_unknown', 'activate']); expect(dispatch).toHaveBeenCalledOnce();
  });
  it('关键保存失败绝不激活最终控件，仍保留未发送意图', async (): Promise<void> => {
    const fixture = videoSubmissionHarness(); fixture.failWrite(); const activate = vi.fn();
    await expect(dispatchSubmissionAttempt({ ...fixture, dispatch: async (safety: SubmissionDispatchSafety) => { await safety.beforeDispatch?.(); activate(); return { kind: 'dispatch_attempted', activated: true }; } })).rejects.toThrow('写入失败');
    expect(activate).not.toHaveBeenCalled(); expect(fixture.current().runtime?.submittedAt).toBeUndefined();
  });
  it('同步确认未点击允许原任务继续准备，未知派发不能被改写成未发', async (): Promise<void> => {
    const fixture = videoSubmissionHarness();
    await dispatchSubmissionAttempt({ ...fixture, dispatch: async (safety: SubmissionDispatchSafety) => { await safety.beforeDispatch?.(); return { kind: 'not_dispatched', reason: 'guest_preflight_refused' }; } });
    expect(fixture.current().runtime?.submission?.state).toBe('not_dispatched'); expect(fixture.current().runtime?.submittedAt).toBeUndefined();
    expect(fixture.service.updateRuntime({ taskId: 'fixture-task', expectedRunId: 'fixture-run', status: 'paused', runtime: { stage: 'paused' } }).success).toBe(true);
    expect(fixture.service.retry('fixture-task').success).toBe(true);
  });
  it('ACK未知只保留观察责任，不补点，也不允许重启自动重试', async (): Promise<void> => {
    const fixture = videoSubmissionHarness(); const dispatch = vi.fn(async (safety: SubmissionDispatchSafety) => { await safety.beforeDispatch?.(); return { kind: 'dispatch_unknown' as const, reason: 'ack_lost' }; });
    expect(await dispatchSubmissionAttempt({ ...fixture, dispatch })).toMatchObject({ kind: 'dispatch_unknown' });
    expect(dispatch).toHaveBeenCalledOnce(); expect(fixture.service.recoverInterruptedTasks().success).toBe(true);
    expect(fixture.service.retry('fixture-task').success).toBe(false); expect(fixture.current().runtime?.submission?.state).toBe('dispatch_unknown');
  });
  it('人机验证在派发前出现时保留原意图，零派发记录', async (): Promise<void> => {
    const fixture = videoSubmissionHarness();
    await expect(dispatchSubmissionAttempt({ ...fixture, dispatch: async () => { throw new HumanVerificationRequiredError(); } })).rejects.toBeInstanceOf(HumanVerificationRequiredError);
    expect(fixture.current().runtime?.submission?.state).toBe('intent_saved'); expect(fixture.current().runtime?.submittedAt).toBeUndefined();
  });
  it('未派发结果保存失败不能报告完成恢复', async (): Promise<void> => {
    const fixture = videoSubmissionHarness(); fixture.failWrite();
    await expect(dispatchSubmissionAttempt({ ...fixture, dispatch: async () => ({ kind: 'not_dispatched', reason: 'lease_withdrawn' }) })).rejects.toThrow('写入失败');
  });
});
