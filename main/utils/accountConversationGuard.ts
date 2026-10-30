/** 自由对话期间保留账号写入权；任务仍使用原 TaskService 锁与调度链。 */
const guards = new Map<string, { projectId: string; adjustmentId: string; allowedTaskId?: string }>();
export function claimConversationGuard(accountId: string, projectId: string, adjustmentId: string, allowedTaskId?: string): void {
  const old = guards.get(accountId);
  if (old && (old.projectId !== projectId || old.adjustmentId !== adjustmentId)) throw new Error('这个账号正在调整另一项创作，请先采用回复或结束该次调整');
  guards.set(accountId, { projectId, adjustmentId, allowedTaskId });
}
export function releaseConversationGuard(accountId: string, adjustmentId: string): void {
  if (guards.get(accountId)?.adjustmentId === adjustmentId) guards.delete(accountId);
}
export function hasConversationGuard(accountId: string | null | undefined, taskId?: string): boolean {
  const guard = accountId ? guards.get(accountId) : undefined;
  return !!guard && (!taskId || guard.allowedTaskId !== taskId);
}
