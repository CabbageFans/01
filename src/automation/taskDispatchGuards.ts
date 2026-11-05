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
