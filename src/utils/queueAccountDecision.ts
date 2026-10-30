import type { Account } from '../types';
import { getAvailabilityBlockReason } from './accountAvailability';

export function getAssignedAccountBlockReason(account: Account | undefined, now: number = Date.now()): string | null {
  if (!account) return '指派账号不存在';
  if (account.status === 'error') return '指派账号当前异常';
  const availabilityBlock = getAvailabilityBlockReason(account.health?.availability);
  if (availabilityBlock) return `指派账号${availabilityBlock}`;
  if (account.health?.verificationRequired) return '指派账号正在等待人工验证';
  if (account.health?.loginState === 'expired') return '指派账号登录已失效';
  if (account.health?.cooldownUntil && new Date(account.health.cooldownUntil).getTime() > now) return '指派账号处于自动冷却期';
  if (account.scheduling?.enabled === false) return '指派账号已暂停调度';
  if (account.scheduling?.manualCooldownUntil && new Date(account.scheduling.manualCooldownUntil).getTime() > now) return '指派账号处于手动冷却期';
  return null;
}
