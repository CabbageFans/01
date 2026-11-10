import { automationEngine } from './AutomationEngine';
import { matchesTaskRunCommand } from './taskDispatchGuards';
import { useTaskStore } from '../store/useTaskStore';
import type { TaskUpdateInput } from '../types';

export interface TaskStopCommand {
  taskId: string;
  expectedRunId?: string;
  runId?: string;
  restartTask?: TaskUpdateInput;
  targetStatus?: 'paused' | 'cancelled';
}

export interface TaskStopHost {
  abortControllersRef: { current: Map<string, AbortController> };
  pendingRestartTasksRef: { current: Map<string, TaskUpdateInput> };
  pendingCancellationStatusRef: { current: Map<string, 'paused' | 'cancelled'> };
}

/** 用户停止是命令，不靠迟到catch猜测意图；先撤本地执行权，再保存原运行暂停事实。 */
export async function stopTaskAutomation(host: TaskStopHost, command: TaskStopCommand): Promise<boolean> {
  const task = useTaskStore.getState().tasks.find((item): boolean => item.id === command.taskId);
  if (!matchesTaskRunCommand(task, command) || !task) return false;
  const targetStatus = command.targetStatus || 'paused';
  host.pendingCancellationStatusRef.current.set(task.id, targetStatus);
  const restartPrompt = command.restartTask?.prompt?.trim();
  if (restartPrompt && command.restartTask) host.pendingRestartTasksRef.current.set(task.id, { ...command.restartTask, prompt: restartPrompt });
  automationEngine.abort(task.id); host.abortControllersRef.current.get(task.id)?.abort();
  // 编辑重跑沿原协调器在停止后消费已经保存的授权输入，不能抢先清掉其pending交接。
  if (restartPrompt) return true;
  if (!task.assignedAccountId) return useTaskStore.getState().updateTaskStatus(task.id, targetStatus, targetStatus === 'cancelled' ? '本地等待已结束' : '用户已暂停');
  await useTaskStore.getState().pauseAutomation(task.id, task.assignedAccountId,
    targetStatus === 'cancelled' ? '本地处理与等待已结束，平台原请求和已有成果保留' : '用户已暂停本地等待；原平台请求保留，可检查原结果',
    { expectedRunId: task.runtime?.runId, status: targetStatus, code: targetStatus === 'cancelled' ? 'local_wait_ended' : 'cancelled', endObservation: true });
  const saved = useTaskStore.getState().tasks.find((item): boolean => item.id === task.id);
  return saved?.runtime?.runId === task.runtime?.runId && saved?.status === targetStatus
    && saved.runtime?.acceptanceObservation?.outcome !== 'observing' && saved.runtime?.manualObservation?.outcome !== 'observing';
}
