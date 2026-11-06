import type { AccountAvailability } from '../types';

export interface PageAvailabilityProbeToken {
  readonly accountId: string;
  readonly page: object;
  readonly accountEpoch: number;
}

export interface PageAvailabilityProbeResult {
  /** 始终为本页证据，不以同账号其他页的缓存替换。 */
  page: AccountAvailability;
  /** 页面实例、同页探测和账号验证保护均未失效。 */
  current: boolean;
  accountUpdate?: AccountAvailability;
  accountBlock?: AccountAvailability;
}

interface AccountProbeGuard {
  epoch: number;
  block?: AccountAvailability;
  observedBlocks: Set<string>;
}

export interface SettlePageAvailabilityOptions {
  isCurrent?: () => boolean;
  /** 仅在用户处理登录／验证后的正式核对流程中授予。 */
  allowAccountRecovery?: boolean;
}

export function isAccountAvailabilityBlock(availability: AccountAvailability): boolean {
  return availability.state === 'login_required'
    || availability.state === 'action_required' && availability.reason === 'human_verification';
}

/** 每页各自取得证据；账号只共享明确的登录／验证码事实和验证代次。 */
export class PageAvailabilityCoordinator {
  private pageProbes = new WeakMap<object, PageAvailabilityProbeToken>();
  private recoveredEpochs = new WeakMap<PageAvailabilityProbeToken, number>();
  private active = new Set<PageAvailabilityProbeToken>();
  private accounts = new Map<string, AccountProbeGuard>();

  private account(accountId: string): AccountProbeGuard {
    const existing = this.accounts.get(accountId);
    if (existing) return existing;
    const guard: AccountProbeGuard = { epoch: 0, observedBlocks: new Set() };
    this.accounts.set(accountId, guard);
    return guard;
  }

  begin(accountId: string, page: object): PageAvailabilityProbeToken {
    const previous = this.pageProbes.get(page);
    if (previous) this.cancel(previous);
    const token = { accountId, page, accountEpoch: this.account(accountId).epoch };
    this.pageProbes.set(page, token);
    this.active.add(token);
    return token;
  }

  /** settled ready 经过异步写盘后仍须属于原页面和同一次账号验证代次。 */
  isCurrent(token: PageAvailabilityProbeToken): boolean {
    return this.pageProbes.get(token.page) === token
      && this.account(token.accountId).epoch === (this.recoveredEpochs.get(token) ?? token.accountEpoch);
  }

  currentAccountBlock(accountId: string): AccountAvailability | undefined {
    return this.accounts.get(accountId)?.block;
  }

  /** 页面外的权威验证码检测也撤销此前所有页面的 ready 发布权。 */
  blockAccount(accountId: string, availability: AccountAvailability): boolean {
    if (!isAccountAvailabilityBlock(availability)) throw new Error('账号阻断必须来自真实登录或人机验证证据');
    const guard = this.account(accountId);
    const fact = JSON.stringify([availability.state, availability.reason, availability.checkedAt]);
    // 恢复写盘期间其他页仍可能读到旧缓存；已消费的同一阻断事实不再生效。
    if (guard.observedBlocks.has(fact)) return false;
    guard.observedBlocks.add(fact);
    guard.epoch += 1;
    guard.block = availability;
    return true;
  }

  settle(token: PageAvailabilityProbeToken, page: AccountAvailability, options: SettlePageAvailabilityOptions = {}): PageAvailabilityProbeResult {
    const pending = this.active.delete(token);
    const guard = this.account(token.accountId);
    const pageCurrent = pending && this.pageProbes.get(token.page) === token && options.isCurrent?.() !== false;
    const current = pageCurrent && guard.epoch === token.accountEpoch;
    if (!pageCurrent) return { page, current: false, ...(guard.block ? { accountBlock: guard.block } : {}) };

    // 真实验证码／登录阻断始终保护账号；另一个页面的 ready 不能清除它。
    if (isAccountAvailabilityBlock(page)) {
      const changed = this.blockAccount(token.accountId, page);
      return { page, current, ...(changed ? { accountUpdate: page } : {}), ...(guard.block ? { accountBlock: guard.block } : {}) };
    }

    if (current && page.state === 'ready' && (!guard.block || options.allowAccountRecovery === true)) {
      if (guard.block) {
        // 恢复本身也是新代次；同一验证期间已发出的其他回读不能迟到认领恢复。
        guard.epoch += 1;
        guard.block = undefined;
        // 本次恢复自己的 ready 保持有效；同代次其他旧探测仍不得认领恢复。
        this.recoveredEpochs.set(token, guard.epoch);
      }
      return { page, current: true, accountUpdate: page };
    }

    // 未挂载输入区、加载失败或未知登录导航均属于本页，不覆盖账号的验证事实。
    return { page, current, ...(guard.block ? { accountBlock: guard.block } : {}) };
  }

  cancel(token: PageAvailabilityProbeToken): void {
    this.active.delete(token);
    if (this.pageProbes.get(token.page) === token) this.pageProbes.delete(token.page);
  }

  invalidatePage(page: object): void {
    const token = this.pageProbes.get(page);
    if (token) this.cancel(token);
  }

  isChecking(accountId: string): boolean {
    return [...this.active].some((token): boolean => token.accountId === accountId);
  }
}
