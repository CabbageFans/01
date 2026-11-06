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

/** 与渲染进程保持相同的保守资格规则；真正发送仍须正式业务归属回读。 */
export function isMaterialImageTask(task: ScopedTask): boolean {
  const binding = task.mode === 'image' ? task.petstory : task.mode === 'chat' ? task.petstoryChat : undefined;
  return !!task.assignedAccountId && !!binding && [binding.projectId, binding.imageOperationId, binding.materialId]
    .every((value: string | undefined): boolean => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200);
}

export function getTaskExecutionScope(task: ScopedTask): string {
  const accountId = task.assignedAccountId || '';
  if (!isMaterialImageTask(task)) return accountId;
  const binding = task.mode === 'image' ? task.petstory : task.petstoryChat;
  if (!binding?.materialId) return accountId;
  return `image:${[accountId, binding.projectId, binding.materialId].map((value: string): string => encodeURIComponent(value)).join(':')}`;
}

export function tasksExecutionConflict(left: ScopedTask, right: ScopedTask): boolean {
  if (!left.assignedAccountId || left.assignedAccountId !== right.assignedAccountId) return false;
  return !isMaterialImageTask(left) || !isMaterialImageTask(right) || getTaskExecutionScope(left) === getTaskExecutionScope(right);
}
