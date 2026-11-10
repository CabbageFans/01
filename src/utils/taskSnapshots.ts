import type { Task } from '../types';

/** 所有任务列表与命令回执使用同一比较口径，优先采用服务端单调版本。 */
export function newerTaskSnapshot(current: Task, incoming: Task): Task {
  if (current.revision !== undefined || incoming.revision !== undefined) {
    return (incoming.revision || 0) >= (current.revision || 0) ? incoming : current;
  }
  const currentAttempt = current.runtime?.attempt || 0;
  const incomingAttempt = incoming.runtime?.attempt || 0;
  if (currentAttempt !== incomingAttempt) return incomingAttempt > currentAttempt ? incoming : current;
  return Date.parse(incoming.updatedAt) < Date.parse(current.updatedAt) ? current : incoming;
}

/** baseline 固定 list 发起前状态；返回缺项只能移除请求期间未变化的任务。 */
export function mergeTaskSnapshots(current: Task[], incoming: Task[], baseline?: Task[], deleted: ReadonlySet<string> = new Set<string>()): Task[] {
  const fresh = new Map(incoming.filter((task: Task): boolean => !deleted.has(task.id)).map((task: Task): [string, Task] => [task.id, task]));
  const previous = baseline ? new Map(baseline.map((task: Task): [string, Task] => [task.id, task])) : undefined;
  const merged: Task[] = [];
  for (const task of current) {
    if (deleted.has(task.id)) continue;
    const candidate = fresh.get(task.id);
    if (candidate) { merged.push(newerTaskSnapshot(task, candidate)); fresh.delete(task.id); }
    else if (!previous || previous.get(task.id) !== task) merged.push(task);
  }
  return [...merged, ...fresh.values()];
}
