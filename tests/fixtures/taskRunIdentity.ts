import type { TaskService } from '../../main/core/TaskService';

/** 集成夹具通过公开任务查询取得本次原运行，模拟真实IPC命令携带身份；不绕过领域检查。 */
export function currentRunId(service: TaskService, taskId: string): string | undefined {
  const result = service.getTasks();
  if (!result.success) throw new Error(result.error);
  return result.data.find((task): boolean => task.id === taskId)?.runtime?.runId;
}

/** 与main的受控本地媒体回执使用同一TaskService命令。 */
export function localMediaPort(service: TaskService): (taskId: string, runId: string, patch: import('@doubao-studio/contracts').TaskLocalMediaUpdate) => import('@doubao-studio/contracts').Task {
  return (taskId: string, runId: string, patch: import('@doubao-studio/contracts').TaskLocalMediaUpdate): import('@doubao-studio/contracts').Task => {
    const result = service.updateLocalMedia(taskId, runId, patch); if (!result.success) throw new Error(result.error); return result.data;
  };
}
