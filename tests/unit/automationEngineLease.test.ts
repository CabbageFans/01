import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationEngine } from '../../src/automation/AutomationEngine';

const acquireLock = vi.fn();
const renewLock = vi.fn();
const releaseLock = vi.fn();

describe('AutomationEngine 租约心跳', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    acquireLock.mockReset().mockResolvedValue({ success: true });
    renewLock.mockReset().mockResolvedValue({ success: true });
    releaseLock.mockReset().mockResolvedValue({ success: true });
    vi.stubGlobal('window', {
      electronAPI: { tasks: { acquireLock, renewLock, releaseLock } },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('持锁期间每 30 秒续租，释放后停止心跳并携带 owner', async () => {
    const engine = new AutomationEngine();
    await engine.reserve('task-1', 'account-1', 'owner-1');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renewLock).toHaveBeenCalledWith('task-1', 'owner-1');

    await engine.release('task-1');
    expect(releaseLock).toHaveBeenCalledWith('task-1', 'owner-1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renewLock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['返回失败', () => renewLock.mockResolvedValueOnce({ success: false, error: 'lost' })],
    ['IPC 抛错', () => renewLock.mockRejectedValueOnce(new Error('offline'))],
  ])('%s 时中止控制器并释放本地 reservation', async (_label, arrange) => {
    const engine = new AutomationEngine();
    await engine.reserve('task-2', 'account-2', 'owner-2');
    const controller = engine.createController('task-2', 'account-2');
    const abortSpy = vi.spyOn(controller, 'abort');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    arrange();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(abortSpy).toHaveBeenCalledOnce();
    expect(engine.isReserved('task-2')).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('任务租约续租失败'));
    consoleSpy.mockRestore();
  });

  it('同一 reservation 不得替换或中止原控制器', async (): Promise<void> => {
    const engine = new AutomationEngine();
    await engine.reserve('OFFLINE-exclusive', 'OFFLINE-account', 'OFFLINE-owner');
    const original = engine.createController('OFFLINE-exclusive', 'OFFLINE-account');
    expect((): AbortController => engine.createController('OFFLINE-exclusive', 'OFFLINE-account')).toThrow('不能重复启动');
    expect(original.signal.aborted).toBe(false); expect(engine.ownsController('OFFLINE-exclusive', original)).toBe(true);
    await engine.release('OFFLINE-exclusive', original);
  });

  it('旧控制器的 finally 不得释放新 reservation', async (): Promise<void> => {
    const engine = new AutomationEngine();
    await engine.reserve('OFFLINE-reused-task', 'OFFLINE-account', 'OFFLINE-old-owner');
    const old = engine.createController('OFFLINE-reused-task', 'OFFLINE-account');
    await engine.release('OFFLINE-reused-task', old);
    await engine.reserve('OFFLINE-reused-task', 'OFFLINE-account', 'OFFLINE-new-owner');
    const current = engine.createController('OFFLINE-reused-task', 'OFFLINE-account');
    releaseLock.mockClear();
    await engine.release('OFFLINE-reused-task', old);
    expect(engine.ownsController('OFFLINE-reused-task', current)).toBe(true); expect(releaseLock).not.toHaveBeenCalled();
    await engine.release('OFFLINE-reused-task', current);
    expect(releaseLock).toHaveBeenCalledWith('OFFLINE-reused-task', 'OFFLINE-new-owner');
  });

  it('热更新模块仍复用原执行租约宿主', async (): Promise<void> => {
    const before = await import('../../src/automation/AutomationEngine');
    vi.resetModules();
    const after = await import('../../src/automation/AutomationEngine');
    expect(after.automationEngine).toBe(before.automationEngine);
  });

  it('旧租约迟到的续租失败不能删除新运行或中止新控制器', async (): Promise<void> => {
    let finishRenew: (value: { success: boolean; error: string }) => void = (): void => {};
    renewLock.mockImplementationOnce((): Promise<{ success: boolean; error: string }> => new Promise((resolve): void => { finishRenew = resolve; }));
    const engine = new AutomationEngine();
    await engine.reserve('OFFLINE-renew-race', 'OFFLINE-account', 'OFFLINE-old-owner');
    const old = engine.createController('OFFLINE-renew-race', 'OFFLINE-account');
    await vi.advanceTimersByTimeAsync(30_000);
    await engine.release('OFFLINE-renew-race', old);
    await engine.reserve('OFFLINE-renew-race', 'OFFLINE-account', 'OFFLINE-new-owner');
    const current = engine.createController('OFFLINE-renew-race', 'OFFLINE-account');
    finishRenew({ success: false, error: 'OFFLINE old lease expired' }); await Promise.resolve();
    expect(engine.ownsController('OFFLINE-renew-race', current)).toBe(true); expect(current.signal.aborted).toBe(false);
    await engine.release('OFFLINE-renew-race', current);
  });

  it('提交前确认只允许原账号、原控制器和仍有效的正式租约', async (): Promise<void> => {
    const engine = new AutomationEngine();
    await engine.reserve('OFFLINE-submit', 'OFFLINE-account', 'OFFLINE-owner');
    const controller = engine.createController('OFFLINE-submit', 'OFFLINE-account');
    expect(await engine.confirmSubmissionOwnership('OFFLINE-submit', 'OFFLINE-other', controller)).toBe(false);
    expect(await engine.confirmSubmissionOwnership('OFFLINE-submit', 'OFFLINE-account', new AbortController())).toBe(false);
    expect(renewLock).not.toHaveBeenCalled();
    expect(await engine.confirmSubmissionOwnership('OFFLINE-submit', 'OFFLINE-account', controller)).toBe(true);
    expect(renewLock).toHaveBeenCalledWith('OFFLINE-submit', 'OFFLINE-owner');
    controller.abort();
    expect(await engine.confirmSubmissionOwnership('OFFLINE-submit', 'OFFLINE-account', controller)).toBe(false);
    expect(renewLock).toHaveBeenCalledTimes(1);
    await engine.release('OFFLINE-submit', controller);
  });

  it('提交前续租失败和等待期间换运行都不能取得提交权', async (): Promise<void> => {
    const engine = new AutomationEngine();
    await engine.reserve('OFFLINE-submit-lost', 'OFFLINE-account', 'OFFLINE-owner');
    const controller = engine.createController('OFFLINE-submit-lost', 'OFFLINE-account');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    renewLock.mockResolvedValueOnce({ success: false, error: 'OFFLINE lost' });
    expect(await engine.confirmSubmissionOwnership('OFFLINE-submit-lost', 'OFFLINE-account', controller)).toBe(false);
    expect(controller.signal.aborted).toBe(true); consoleSpy.mockRestore();

    await engine.reserve('OFFLINE-submit-new', 'OFFLINE-account', 'OFFLINE-old-owner');
    const old = engine.createController('OFFLINE-submit-new', 'OFFLINE-account');
    let finishRenew: (value: { success: boolean }) => void = (): void => {};
    renewLock.mockImplementationOnce((): Promise<{ success: boolean }> => new Promise((resolve): void => { finishRenew = resolve; }));
    const pending = engine.confirmSubmissionOwnership('OFFLINE-submit-new', 'OFFLINE-account', old);
    await engine.release('OFFLINE-submit-new', old);
    await engine.reserve('OFFLINE-submit-new', 'OFFLINE-account', 'OFFLINE-new-owner');
    const current = engine.createController('OFFLINE-submit-new', 'OFFLINE-account');
    finishRenew({ success: true }); expect(await pending).toBe(false);
    expect(engine.ownsAccountController('OFFLINE-submit-new', 'OFFLINE-account', current)).toBe(true);
    await engine.release('OFFLINE-submit-new', current);
  });
});
