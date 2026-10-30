import type { PetStoryProject, Task } from '@doubao-studio/contracts';
import { imageOperationForChatJob } from './petstoryImageFlow';

/** 只授权项目台账中的图片操作及其结构修订；自由聊天和其他制作继续沿用原可见规则。 */
export function isBackgroundImageOperationTask(project: PetStoryProject | null, taskId: string | undefined): boolean {
  if (!project || !taskId) return false;
  if (project.imageOperations?.some((operation): boolean => operation.taskId === taskId && operation.stage !== 'complete')) return true;
  const job = project.jobs.find((item): boolean => item.taskId === taskId);
  const operation = job && imageOperationForChatJob(project, job.id);
  return !!operation && operation.stage !== 'complete';
}

/** 任务回读时临时调度映射可能尚未重建，仍从正式运行台账识别同一账号的图片任务。 */
export function hasForegroundAccountInteraction(project: PetStoryProject | null, tasks: Task[], automationStates: Record<string, string>, executingTasks: Record<string, string>): boolean {
  return Object.entries(automationStates).some(([accountId, state]): boolean => {
    if (state !== 'injecting' && state !== 'submitting') return false;
    const taskId = executingTasks[accountId] || tasks.find((task): boolean => task.assignedAccountId === accountId && task.status === 'executing')?.id;
    return !isBackgroundImageOperationTask(project, taskId);
  });
}

/** 生成及结果读取同样依赖平台视口懒加载；直到候选保存都保留同一宿主的交集。 */
export function hasBackgroundImageExecution(project: PetStoryProject | null, tasks: Task[], activeOperationId: string | null): boolean {
  if (!project) return false;
  if (activeOperationId && project.imageOperations?.some((operation): boolean => operation.id === activeOperationId && !['complete', 'failed'].includes(operation.stage))) return true;
  return tasks.some((task): boolean => ['executing', 'generating', 'manual_submission_observing'].includes(task.status)
    && isBackgroundImageOperationTask(project, task.id));
}
