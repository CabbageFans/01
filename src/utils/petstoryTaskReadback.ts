import type { Task } from '@doubao-studio/contracts';

interface ReleasedTaskReadbackPort {
  current: () => Task | undefined;
  list: () => Promise<Task[]>;
  replaceIfCurrent: (previous: Task, next: Task) => void;
}

/** 原执行器释放租约后只读同步这次暂停任务，不能用旧锁快照长期隐藏继续入口。 */
export async function readBackReleasedPetStoryTask(taskId: string, runId: string | undefined, port: ReleasedTaskReadbackPort): Promise<void> {
  const previous = port.current();
  if (!runId || previous?.id !== taskId || previous.runtime?.runId !== runId || previous.status !== 'paused'
    || previous.errorInfo?.code !== 'page_unrecognized' || previous.runtime.submittedAt) return;
  try {
    const next = (await port.list()).find((task: Task): boolean => task.id === taskId);
    if (!next || next.runtime?.runId !== runId || next.projectId !== previous.projectId
      || next.assignedAccountId !== previous.assignedAccountId || next.prompt !== previous.prompt || port.current() !== previous) return;
    // 保留权威回读中的提交／产物证据；只替换仍是原对象的单项，不清其他账号的忙碌状态。
    port.replaceIfCurrent(previous, next);
  } catch { /* 只读失败保留旧状态及门禁，用户仍可沿原检查入口再次回读。 */ }
}
