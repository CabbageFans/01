import type { PetStoryAsset, PetStoryProduction, PetStoryProductionStep, PetStoryProject, Task } from '@doubao-studio/contracts';

export type VideoWorkflowActionKind = 'generate' | 'generate_version' | 'continue_preparation' | 'check_original' | 'retry_download' | 'revalidate' | 'retry_library' | 'select_original' | 'verify_account' | 'refresh_original' | 'view_local' | 'pause' | 'end';
export interface VideoWorkflowAction { kind: VideoWorkflowActionKind; label: string }
interface VideoActionContext {
  task?: Task;
  step?: PetStoryProductionStep;
  production?: PetStoryProduction;
  asset?: PetStoryAsset;
  canPrepare?: boolean;
  canCheckOriginal?: boolean;
}
const RETRY_ACTIONS: Record<string, VideoWorkflowAction> = {
  downloading: { kind: 'retry_download', label: '重试下载' }, downloaded: { kind: 'revalidate', label: '继续校验' },
  validating: { kind: 'revalidate', label: '重新校验' }, library: { kind: 'retry_library', label: '重试入库' }, ready: { kind: 'retry_library', label: '恢复本地关联' },
};
/** UI仅消费原Task运行事实；旧step.failure只在历史未保存localMedia时适配。 */
export function localVideoRecoveryAction(task: Task | undefined, step?: PetStoryProductionStep): VideoWorkflowAction | undefined {
  if (!task || task.mode !== 'video' || task.status !== 'done' || step?.runId && task.runtime?.runId !== step.runId) return undefined;
  const local = task.runtime?.localMedia;
  if (local) return local.state === 'failed' || local.state === 'paused' ? RETRY_ACTIONS[local.phase] : undefined;
  const legacyPhase = step?.failure?.stage;
  if (legacyPhase) return RETRY_ACTIONS[{ download: 'downloading', validation: 'validating', library: 'library' }[legacyPhase]];
  return step && step.status !== 'complete' ? { kind: 'retry_download', label: '下载并保存原视频' } : undefined;
}
export function originalVideoResultAction(task: Task | undefined): VideoWorkflowAction {
  const observed = task?.runtime?.executionDiagnostics?.videoObservation as { status?: string } | undefined;
  if (observed?.status === 'needs_manual_selection') return { kind: 'select_original', label: '选择原视频' };
  if (observed?.status === 'unauthorized') return { kind: 'verify_account', label: '先登录验证' };
  if (observed?.status === 'expired') return { kind: 'refresh_original', label: '刷新原视频下载地址' };
  return { kind: 'check_original', label: '检查原视频结果' };
}
export function selectVideoWorkflowActions(context: VideoActionContext): VideoWorkflowAction[] {
  const actions: VideoWorkflowAction[] = [];
  const pausedLocal = context.task?.runtime?.localMedia;
  const local = localVideoRecoveryAction(context.task, context.step) || (context.production?.state !== 'running' && pausedLocal?.state === 'working' ? RETRY_ACTIONS[pausedLocal.phase] : undefined)
    || (pausedLocal?.state === 'ready' && !context.asset && context.step?.status !== 'complete' ? RETRY_ACTIONS.ready : undefined);
  if (local) actions.push(local);
  else if (context.canPrepare) actions.push({ kind: 'continue_preparation', label: '继续生成视频' });
  else if (context.canCheckOriginal) actions.push(originalVideoResultAction(context.task));
  else actions.push({ kind: context.asset ? 'generate_version' : 'generate', label: context.asset ? '生成新版本' : '生成视频' });
  if (context.asset) actions.push({ kind: 'view_local', label: '查看视频' });
  if (context.production?.state === 'running') actions.push({ kind: 'pause', label: '暂停后续制作' });
  if (context.production && context.production.state !== 'ended') actions.push({ kind: 'end', label: '结束本次制作' });
  return actions;
}
/** 项目step是投影；project写成功但Task就绪回执尚未保存时仍须提供入库恢复。 */
export function pendingVideoProductionStep(project: PetStoryProject, tasks: readonly Task[]): PetStoryProductionStep | undefined {
  return project.production?.steps.find((step): boolean => step.status !== 'complete')
    || project.production?.steps.find((step): boolean => step.kind === 'video' && tasks.some((task): boolean => task.id === step.taskId && task.runtime?.runId === step.runId && !!task.runtime?.localMedia && task.runtime.localMedia.state !== 'ready'));
}

export function videoLocalPhaseLabel(task: Task | undefined): string | undefined {
  const local = task?.runtime?.localMedia; if (!local) return undefined;
  const labels = { downloading: '视频下载', downloaded: '视频已下载，等待校验', validating: '视频文件校验', library: '保存到项目', ready: '本地视频已保存' };
  if (local.state === 'ready') return labels.ready;
  if (local.state === 'failed') return `${labels[local.phase]}失败`;
  if (local.state === 'paused') return `${labels[local.phase]}已暂停`;
  return `${labels[local.phase]}中`;
}
