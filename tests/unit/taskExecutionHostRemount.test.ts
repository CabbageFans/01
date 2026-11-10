import { describe, expect, it, vi } from 'vitest';
import { taskExecutionHostState } from '../../src/automation/taskExecutionHostState';

describe('任务执行宿主跨重挂载保持观察所有权', (): void => {
  it('同一原任务的观察Promise、控制器和已提交现场不会因宿主模块重载被换掉', async (): Promise<void> => {
    const taskId = 'TEST-remount-host'; const controller = new AbortController(); let resolveObservation: (() => void) | undefined;
    const observation = new Promise<void>((resolve): void => { resolveObservation = resolve; });
    taskExecutionHostState.reconciling.add(taskId); taskExecutionHostState.reconciliationPromises.set(taskId, observation);
    taskExecutionHostState.controllers.set(taskId, controller); taskExecutionHostState.reconciliationUsage.add(taskId);
    try {
      vi.resetModules(); const mounted = (await import('../../src/automation/taskExecutionHostState')).taskExecutionHostState;
      expect(mounted).toBe(taskExecutionHostState);
      expect(mounted.reconciliationPromises.get(taskId)).toBe(observation); expect(mounted.controllers.get(taskId)).toBe(controller);
      expect(mounted.reconciling.has(taskId)).toBe(true); expect(mounted.reconciliationUsage.has(taskId)).toBe(true);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      resolveObservation?.(); await observation;
      taskExecutionHostState.reconciling.delete(taskId); taskExecutionHostState.reconciliationPromises.delete(taskId);
      taskExecutionHostState.controllers.delete(taskId); taskExecutionHostState.reconciliationUsage.delete(taskId);
    }
  });
});
