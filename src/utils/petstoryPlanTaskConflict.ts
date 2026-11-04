import type { PetStoryProject, Task } from '@doubao-studio/contracts';

/** Studio 项目可含多个短剧，不能把它当作本次方案的任务归属。 */
export function taskBelongsToPetStory(project: PetStoryProject, task: Task): boolean {
  return task.petstory?.projectId === project.id || task.runtime?.input.petstory?.projectId === project.id
    || project.jobs.some((job): boolean => job.taskId === task.id)
    || !!project.production?.steps.some((step): boolean => step.taskId === task.id);
}

/** 活动执行仍占用整个账号；无锁且已暂停的其他创作只保留独立恢复记录。 */
export function planFeedbackBlockingTask(project: PetStoryProject, tasks: Task[], nowMs: number = Date.now()): Task | undefined {
  const blockers = tasks.filter((task): boolean => {
    if (task.assignedAccountId !== project.accountId) return false;
    if (['executing', 'generating', 'manual_submission_observing', 'waiting_verification', 'waiting_generation_confirmation'].includes(task.status)) return true;
    if (task.lock && Date.parse(task.lock.expiresAt) > nowMs) return true;
    return task.status === 'paused' && task.errorInfo?.code === 'submission_uncertain' && taskBelongsToPetStory(project, task);
  });
  return blockers.find((task): boolean => taskBelongsToPetStory(project, task)) || blockers[0];
}
