import type { PetStoryProject, Task } from '@doubao-studio/contracts';

/** 与主进程 resume 相同的只读分支事实；任务完整归属和后续提交仍由主进程复核。 */
export function petStoryReadOnlyProductionTask(project: PetStoryProject, tasks: Task[]): Task | undefined {
  const pending = project.production?.steps.find((step): boolean => step.status !== 'complete');
  const task = tasks.find((item): boolean => item.id === pending?.taskId);
  return task?.status === 'done' || task?.runtime?.submittedAt ? task : undefined;
}

export interface PetStoryVideoReadOnlyRecovery {
  task: Task;
  action: 'confirm_parameters' | 'verify_account' | 'check_result';
  label: string;
  status: string;
  reason: string;
}
/** 画布只暴露精确归属的原提交；平台参数确认与只读收取不授权新视频请求。 */
export function petStoryVideoReadOnlyRecovery(project: PetStoryProject, shotId: string, tasks: Task[], activeTaskIds: string[] = []): PetStoryVideoReadOnlyRecovery | undefined {
  const step = project.production?.steps.find((item): boolean => item.status !== 'complete');
  const task = petStoryReadOnlyProductionTask(project, tasks); const runtime = task?.runtime;
  if (!task || !runtime?.submittedAt || !step?.runId || step.kind !== 'video' || step.shotId !== shotId
    || task.mode !== 'video' || runtime.input.mode !== 'video' || runtime.runId !== step.runId
    || task.assignedAccountId !== project.accountId || task.projectId !== project.studioProjectId
    || task.petstory?.projectId !== project.id || task.petstory.stepId !== step.id) return undefined;
  if (task.status === 'waiting_generation_confirmation') return { task, action: 'confirm_parameters', label: '去豆包确认参数', status: '待确认视频参数',
    reason: task.errorInfo?.message || '豆包要求确认视频生成参数，请在原会话完成确认。' };
  if (activeTaskIds.includes(task.id)) return undefined;
  if (task.status === 'waiting_verification') return { task, action: 'verify_account', label: '已完成验证，继续', status: '等待登录或验证',
    reason: task.errorInfo?.message || '请在原执行账号完成人机验证或登录，再继续检查这次原视频请求。' };
  if (['paused', 'fail', 'cancelled'].includes(task.status)) {
    const observation = runtime.executionDiagnostics?.videoObservation as { status?: string } | undefined;
    const statuses: Record<string, string> = { generation_not_started: '平台未启动视频生成', expired: '原视频地址已过期',
      unauthorized: '原账号需要登录或授权', needs_manual_selection: '需要选择原视频', rejected: '平台已停止视频生成', retryable_error: '原视频暂时读取失败' };
    return { task, action: 'check_result', label: '检查原视频结果',
      status: task.errorInfo?.code === 'video_generation_not_started' ? statuses.generation_not_started : statuses[observation?.status || ''] || '等待原视频结果',
      reason: task.errorInfo?.message || runtime.message || '原视频请求已提交，请只读检查原会话中的生成结果。' };
  }
  return undefined;
}
