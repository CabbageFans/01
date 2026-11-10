import type { Task } from '../types';

export type TaskDispatchGuard = (task: Task) => Promise<void>;
const guards = new Map<string, TaskDispatchGuard>();

/** 按稳定名称注册业务发送前校验；通用调度器不依赖具体业务 Store。 */
export function registerTaskDispatchGuard(name: string, guard: TaskDispatchGuard): () => void {
  guards.set(name, guard);
  return (): void => { if (guards.get(name) === guard) guards.delete(name); };
}

/** 所有启动入口都先完成正式运行绑定及回读，再发布可执行状态。 */
export async function runTaskDispatchGuards(task: Task): Promise<void> {
  for (const guard of guards.values()) await guard(task);
}

/** 停止事件也绑定原运行；旧组件/旧异步操作不能撤销同task的新执行权。 */
export function matchesTaskRunCommand(task: Pick<Task, 'id' | 'runtime'> | undefined,
  command: { taskId: string; expectedRunId?: string; runId?: string }): boolean {
  if (!task || task.id !== command.taskId) return false;
  const expected = command.expectedRunId || command.runId;
  return task.runtime ? !!expected && expected === task.runtime.runId : !expected;
}
