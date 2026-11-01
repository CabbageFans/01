import type { Account, Task } from '../types';
import { getAssignedAccountBlockReason } from './queueAccountDecision';

export interface TaskVerificationRecoveryDetail {
  taskId: string;
  accountId: string;
  runId: string;
  submittedAt?: string;
  verificationCheckedAt: string;
}

export interface UnsubmittedVerificationRecovery {
  runId: string;
  checkedAt: string;
}

export function matchesVerificationRecoveryRun(task: Task | undefined, expected: Pick<TaskVerificationRecoveryDetail, 'taskId' | 'accountId' | 'runId' | 'submittedAt'>): task is Task & { runtime: NonNullable<Task['runtime']> } {
  return !!task && task.id === expected.taskId && task.assignedAccountId === expected.accountId
    && task.runtime?.runId === expected.runId && task.runtime.submittedAt === expected.submittedAt;
}

export function hasVerificationRecoveryConflict(tasks: Task[], accountId: string, taskId: string): boolean {
  return tasks.some((item: Task): boolean => item.assignedAccountId === accountId
    && (item.runtime?.chatAdjustmentGuard?.active === true || item.id !== taskId
      && ['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'].includes(item.status)));
}

/** 只有本次真实页面检测能解除原验证等待；普通 ready 不授予新的执行意图。 */
export function canRecoverTaskAfterVerification(task: Task, account: Account | undefined, checkedAt: string, now: number = Date.now()): boolean {
  const availability = account?.health?.availability;
  const checkedMs = Date.parse(checkedAt);
  const blockedMs = Date.parse(task.errorInfo?.detectedAt || '');
  return !!account && (account.platform || 'doubao') === 'doubao' && task.assignedAccountId === account.id
    && availability?.state === 'ready' && availability.checkedAt === checkedAt && !getAssignedAccountBlockReason(account, now)
    && Number.isFinite(checkedMs) && checkedMs <= now + 5_000 && checkedMs >= now - 60_000
    && Number.isFinite(blockedMs) && checkedMs >= blockedMs
    && task.status === 'waiting_verification' && ['human_verification', 'verification'].includes(task.errorInfo?.code || '')
    && !!task.runtime?.runId && task.runtime.stage === 'waiting_verification'
    && (Boolean(task.runtime.submittedAt || task.runtime.acceptanceObservation) || task.executionIntent === 'armed');
}

/** 输入被用户修改过时，不把后来内容接入旧运行，也不将旧提交证据换绑到新正文。 */
export function verificationRecoveryInputMatches(task: Task): boolean {
  const input = task.runtime?.input;
  return !!input && input.prompt === task.prompt && input.mode === task.mode
    && JSON.stringify(input.videoConfig) === JSON.stringify(task.videoConfig)
    && JSON.stringify(input.attachments) === JSON.stringify(task.attachments || [])
    && input.audioAttachment === task.audioAttachment
    && JSON.stringify(input.petstory) === JSON.stringify(task.petstory)
    && input.promptReadback === task.promptReadback;
}

export function canContinueUnsubmittedVerification(task: Task, account: Account | undefined, recovery: UnsubmittedVerificationRecovery): boolean {
  return canRecoverTaskAfterVerification(task, account, recovery.checkedAt) && task.runtime?.runId === recovery.runId
    && !task.runtime.submittedAt && !task.runtime.acceptanceObservation && task.executionIntent === 'armed'
    && !task.runtime.chatReadback && !task.runtime.chatResponse && !task.runtime.manualObservation && !task.outputs.length
    && verificationRecoveryInputMatches(task) && !task.blockedByTaskIds?.length;
}
