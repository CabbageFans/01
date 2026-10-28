import type { PetStoryProject, Task } from '@doubao-studio/contracts';

/** 与主进程 resume 相同的只读分支事实；任务完整归属和后续提交仍由主进程复核。 */
export function petStoryReadOnlyProductionTask(project: PetStoryProject, tasks: Task[]): Task | undefined {
  const pending = project.production?.steps.find((step): boolean => step.status !== 'complete');
  const task = tasks.find((item): boolean => item.id === pending?.taskId);
  return task?.status === 'done' || task?.runtime?.submittedAt ? task : undefined;
}
