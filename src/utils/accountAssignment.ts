import type { Account } from '../types';
import { getAutomaticSchedulingBlockReason } from './schedulingScore';

export interface ManualAssignmentOption {
  value: string;
  label: string;
  automaticBlockReason: string | null;
}

/** 手动指派始终列出全部现存账号；自动调度阻塞只作为说明，不删除选项。 */
export function buildManualAssignmentOptions(
  accounts: readonly Account[],
  now: number = Date.now(),
): ManualAssignmentOption[] {
  return accounts.map((account) => {
    const automaticBlockReason = getAutomaticSchedulingBlockReason(account, now);
    const platform = (account.platform || 'doubao') === 'dola' ? 'Dola' : '豆包';
    return {
      value: account.id,
      label: `${account.name} · ${platform}${automaticBlockReason ? ` · ${automaticBlockReason}` : ''}`,
      automaticBlockReason,
    };
  });
}
