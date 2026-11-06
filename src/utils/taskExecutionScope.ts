import type { Task } from '@doubao-studio/contracts';

type ScopedTask = Pick<Task, 'assignedAccountId' | 'mode' | 'petstory' | 'petstoryChat'>;
export const IMAGE_EXECUTION_CONCURRENCY = 1;

/** 生图／改图及其明确绑定的准备文字共用全局单个图片执行位置。 */
export function isImageExecutionTask(task: ScopedTask): boolean {
  if (task.mode === 'image') return true;
  const binding = task.mode === 'chat' ? task.petstoryChat : undefined;
  return !!binding && [binding.projectId, binding.imageOperationId].every((value: string | undefined): boolean =>
    typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200);
}

/** 仅正式基础素材绑定使用素材调度范围；镜头图片及缺字段任务仍按账号互斥。 */
export function isMaterialImageTask(task: ScopedTask): boolean {
  const binding = task.mode === 'image' ? task.petstory : task.mode === 'chat' ? task.petstoryChat : undefined;
  return !!task.assignedAccountId && !!binding && [binding.projectId, binding.imageOperationId, binding.materialId]
    .every((value: string | undefined): boolean => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200);
}

/** 正式图片操作及其准备文字各自使用任务页；镜头首尾帧没有 materialId。页面隔离不扩大调度并发。 */
export function usesIndependentImagePage(task: ScopedTask): boolean {
  const binding = task.mode === 'image' ? task.petstory : task.mode === 'chat' ? task.petstoryChat : undefined;
  const ownerId = task.mode === 'image' ? task.petstory?.stepId : task.petstoryChat?.jobId;
  return !!task.assignedAccountId && !!binding && [binding.projectId, binding.imageOperationId, ownerId]
    .every((value: string | undefined): boolean => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200);
}

export function getTaskExecutionScope(task: ScopedTask): string {
  const accountId = task.assignedAccountId || '';
  if (!isMaterialImageTask(task)) return accountId;
  const binding = task.mode === 'image' ? task.petstory : task.petstoryChat;
  if (!binding?.materialId) return accountId;
  return `image:${[accountId, binding.projectId, binding.materialId].map((value: string): string => encodeURIComponent(value)).join(':')}`;
}

export function getTaskAccountIdForScope(scope: string): string {
  if (!scope.startsWith('image:')) return scope;
  const parts = scope.split(':');
  if (parts.length !== 4) return scope;
  try { return decodeURIComponent(parts[1]); } catch { return scope; }
}

/** 普通任务占用整个账号；独立图片槽只与同素材或普通账号槽冲突。 */
export function executionScopesConflict(left: string, right: string): boolean {
  if (!left || !right || getTaskAccountIdForScope(left) !== getTaskAccountIdForScope(right)) return false;
  return left === right || !left.startsWith('image:') || !right.startsWith('image:');
}

export function tasksExecutionConflict(left: ScopedTask, right: ScopedTask): boolean {
  return executionScopesConflict(getTaskExecutionScope(left), getTaskExecutionScope(right));
}
