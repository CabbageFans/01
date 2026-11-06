import { getTaskAccountIdForScope } from './taskExecutionScope';

export type InteractiveAutomationState = 'idle' | 'injecting' | 'submitting' | 'generating' | 'completed' | 'failed';

/**
 * DOM 配置、上传和原生输入期间只能有一个前台账号。
 * 生成/产物轮询可在隐藏 webview 中继续，不占用前台交互租约。
 */
export function findInteractiveAccountId(
  states: Readonly<Record<string, InteractiveAutomationState | undefined>>,
): string | null {
  for (const [accountId, state] of Object.entries(states)) {
    if (state === 'injecting' || state === 'submitting') return getTaskAccountIdForScope(accountId);
  }
  return null;
}

export function isAccountExecutionBusy(states: Readonly<Record<string, boolean | undefined>>, accountId: string): boolean {
  return Object.entries(states).some(([scope, busy]: [string, boolean | undefined]): boolean => !!busy && getTaskAccountIdForScope(scope) === accountId);
}

/** 账号行展示优先呈现正在输入的槽，再呈现仍在生成的槽。 */
export function getAccountAutomationScope(
  states: Readonly<Record<string, InteractiveAutomationState | undefined>>,
  accountId: string,
): string {
  const priority: InteractiveAutomationState[] = ['injecting', 'submitting', 'generating', 'failed', 'completed', 'idle'];
  return Object.keys(states).filter((scope: string): boolean => getTaskAccountIdForScope(scope) === accountId)
    .sort((left: string, right: string): number => priority.indexOf(states[left] || 'idle') - priority.indexOf(states[right] || 'idle'))[0] || accountId;
}

export function canSelectAccount(
  requestedAccountId: string,
  interactiveAccountId: string | null,
): boolean {
  return !interactiveAccountId || requestedAccountId === interactiveAccountId;
}

