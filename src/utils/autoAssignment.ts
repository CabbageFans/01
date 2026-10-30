import type { Account, Task } from '../types';
import { getAccountSchedulingScore } from './schedulingScore';

const ACTIVE_STATUSES = new Set<Task['status']>(['queued', 'executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing']);

export interface AutoAssignmentPlan {
  assignments: Array<{ taskId: string; accountId: string }>;
  unassignedTaskIds: string[];
}

/** 为一批新任务生成确定性账号计划，按当前负载分配，不使用本地额度估算阻断。 */
export function buildAutoAssignmentPlan(
  newTasks: readonly Task[],
  existingTasks: readonly Task[],
  accounts: readonly Account[],
  now: number = Date.now(),
): AutoAssignmentPlan {
  const accountLoad: Record<string, number> = {};
  accounts.forEach((account) => {
    accountLoad[account.id] = 0;
  });

  const seen = new Set<string>();
  for (const task of [...existingTasks, ...newTasks]) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    if (!task.assignedAccountId || !ACTIVE_STATUSES.has(task.status)) continue;
    accountLoad[task.assignedAccountId] = (accountLoad[task.assignedAccountId] || 0) + 1;

  }

  const assignments: AutoAssignmentPlan['assignments'] = [];
  const unassignedTaskIds: string[] = [];
  for (const task of newTasks) {
    if (task.assignedAccountId) continue;
    const ranked = accounts
      .map((account) => ({
        account,
        score: getAccountSchedulingScore(
          account,
          accountLoad[account.id] || 0,
          task.mode,
          now,
        ),
      }))
      .filter(({ score }) => Number.isFinite(score))
      .sort((left, right) => left.score - right.score || left.account.id.localeCompare(right.account.id));
    const selected = ranked[0]?.account;
    if (!selected) {
      unassignedTaskIds.push(task.id);
      continue;
    }
    assignments.push({ taskId: task.id, accountId: selected.id });
    accountLoad[selected.id] = (accountLoad[selected.id] || 0) + 1;
  }
  return { assignments, unassignedTaskIds };
}
