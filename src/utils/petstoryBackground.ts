import type { PetStoryChatJob, PetStoryProject, Task } from '@doubao-studio/contracts';
import { imageOperationForChatJob } from './petstoryImageFlow';

/** 只授权项目台账中的图片操作及其结构修订；自由聊天和其他制作继续沿用原可见规则。 */
export function isBackgroundImageOperationTask(project: PetStoryProject | null, taskId: string | undefined): boolean {
  if (!project || !taskId) return false;
  if (project.imageOperations?.some((operation): boolean => operation.taskId === taskId && operation.stage !== 'complete')) return true;
  const job = project.jobs.find((item): boolean => item.taskId === taskId);
  const operation = job && imageOperationForChatJob(project, job.id);
  return !!operation && operation.stage !== 'complete';
}

/** 仅画布明确发起的文字请求及其修订拥有后台执行权限；不按 chat 模式推断。 */
export function isBackgroundCanvasPromptTask(project: PetStoryProject | null, taskId: string | undefined): boolean {
  if (!project || !taskId) return false;
  const job = project.jobs.find((item): boolean => item.taskId === taskId);
  if (!job) return false;
  // 旧批次尚无显式后台标记，只兼容当前保存批次的镜头请求，不能扩大到素材／自由聊天。
  const legacyBatchJobId = project.promptBatch?.targets.some((target): boolean => !!target.shotId) ? project.promptBatch.jobId : undefined;
  const visited = new Set<string>();
  let current: PetStoryChatJob | undefined = job;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.background === 'canvas' || current.id === legacyBatchJobId) return true;
    const parentJobId: string | undefined = current.parentJobId;
    current = parentJobId ? project.jobs.find((item): boolean => item.id === parentJobId) : undefined;
  }
  return false;
}

/** 视频必须同时匹配真实任务、原账号与正式步骤；历史仅接续对应原运行的只读观察。 */
export function isBackgroundProductionVideoTask(project: PetStoryProject | null, taskId: string | undefined, task?: Task): boolean {
  if (!project || !taskId || !task || task.id !== taskId || task.mode !== 'video' || task.projectId !== project.studioProjectId
    || task.assignedAccountId !== project.accountId || task.petstory?.projectId !== project.id) return false;
  const binding = task.petstory;
  if (task.runtime && (task.runtime.input.mode !== 'video' || task.runtime.input.petstory
    && (task.runtime.input.petstory.projectId !== project.id || task.runtime.input.petstory.stepId !== binding.stepId))) return false;
  return [project.production, ...(project.productionHistory || [])].some((production): boolean => production?.capability.accountId === project.accountId
    && production.steps.some((step): boolean => step.kind === 'video' && !!step.shotId && step.id === binding.stepId
      && (step.taskId === task.id && (!step.runId || step.runId === task.runtime?.runId)
        || !!step.resubmissionHistory?.some((history): boolean => history.taskId === task.id && history.runId === task.runtime?.runId && history.submittedAt === task.runtime?.submittedAt))));
}

/** 共用同一常驻宿主；视频权限由本次真实 Task 与制作步骤精确关联提供。 */
export function isBackgroundPetStoryTask(project: PetStoryProject | null, taskId: string | undefined, task?: Task): boolean {
  return isBackgroundImageOperationTask(project, taskId) || isBackgroundCanvasPromptTask(project, taskId) || isBackgroundProductionVideoTask(project, taskId, task);
}

/** 临时调度映射尚未重建时，仍从正式运行台账识别同一账号的后台任务。 */
export function hasForegroundAccountInteraction(project: PetStoryProject | null, tasks: Task[], automationStates: Record<string, string>, executingTasks: Record<string, string>): boolean {
  return Object.entries(automationStates).some(([accountId, state]): boolean => {
    if (state !== 'injecting' && state !== 'submitting') return false;
    // 状态回写与调度映射可能错开；优先实际注入任务，不能让旧只读观察遮蔽同账号的新前台操作。
    const taskId = executingTasks[accountId]
      || tasks.find((task): boolean => task.assignedAccountId === accountId && task.status === 'executing')?.id
      || tasks.find((task): boolean => task.assignedAccountId === accountId && task.status === 'generating')?.id
      || tasks.find((task): boolean => task.assignedAccountId === accountId && task.status === 'manual_submission_observing')?.id;
    const task = tasks.find((item): boolean => item.id === taskId);
    return !task || task.assignedAccountId !== project?.accountId || accountId !== project?.accountId || !isBackgroundPetStoryTask(project, taskId, task);
  });
}

/** 生成及结果读取同样依赖平台视口懒加载；直到候选保存都保留同一宿主的交集。 */
export function hasBackgroundImageExecution(project: PetStoryProject | null, tasks: Task[], activeOperationId: string | null): boolean {
  if (!project) return false;
  if (activeOperationId && project.imageOperations?.some((operation): boolean => operation.id === activeOperationId && !['complete', 'failed'].includes(operation.stage))) return true;
  return tasks.some((task): boolean => ['executing', 'generating', 'manual_submission_observing'].includes(task.status)
    && isBackgroundImageOperationTask(project, task.id));
}

/** 注入、发送、等待及只读恢复期间维持平台所需的非零、可交互宿主。 */
export function hasBackgroundPetStoryExecution(project: PetStoryProject | null, tasks: Task[], activeOperationId: string | null): boolean {
  return hasBackgroundImageExecution(project, tasks, activeOperationId)
    || tasks.some((task): boolean => ['executing', 'generating', 'manual_submission_observing'].includes(task.status)
      && task.assignedAccountId === project?.accountId && (isBackgroundCanvasPromptTask(project, task.id) || isBackgroundProductionVideoTask(project, task.id, task)));
}
