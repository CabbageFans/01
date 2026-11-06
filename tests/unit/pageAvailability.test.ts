import { describe, expect, it } from 'vitest';
import type { AccountAvailability } from '@doubao-studio/contracts';
import { PageAvailabilityCoordinator } from '../../src/utils/pageAvailability';

function availability(state: AccountAvailability['state'], reason: string, checkedAt: string = '2026-11-05T00:00:00.000Z'): AccountAvailability {
  return { state, reason, checkedAt, source: 'pre_task', message: `TEST ${reason}` };
}

describe('独立页面的可用性证据与账号验证保护', (): void => {
  it.each(['A-first', 'B-first'] as const)('A可用、B尚无输入区，%s返回仍各自保留本页证据', (order): void => {
    const coordinator = new PageAvailabilityCoordinator();
    const a = coordinator.begin('TEST-account', {}); const b = coordinator.begin('TEST-account', {});
    const ready = availability('ready', 'ready'); const loading = availability('unknown', 'page_unrecognized');
    const first = order === 'A-first' ? coordinator.settle(a, ready) : coordinator.settle(b, loading);
    const second = order === 'A-first' ? coordinator.settle(b, loading) : coordinator.settle(a, ready);
    const resultA = order === 'A-first' ? first : second; const resultB = order === 'A-first' ? second : first;
    expect(resultA).toEqual({ page: ready, current: true, accountUpdate: ready });
    expect(resultB).toEqual({ page: loading, current: true });
    expect(resultA.page).toBe(ready); expect(resultB.page).toBe(loading); expect(coordinator.isChecking('TEST-account')).toBe(false);
  });

  it.each(['page_loading', 'page_unrecognized', 'authentication_unconfirmed', 'network_error', 'page_error', 'platform_mismatch'] as const)('%s只影响本页，不写入账号共享状态', (reason): void => {
    const coordinator = new PageAvailabilityCoordinator(); const page = {};
    const evidence = availability(reason === 'network_error' || reason === 'page_error' || reason === 'platform_mismatch' ? 'unavailable' : 'unknown', reason);
    expect(coordinator.settle(coordinator.begin('TEST-account', page), evidence)).toEqual({ page: evidence, current: true });
  });

  it('同页新探测取代旧探测，旧结果不得持久化或替换成新结果', (): void => {
    const coordinator = new PageAvailabilityCoordinator(); const page = {};
    const first = coordinator.begin('TEST-account', page); const second = coordinator.begin('TEST-account', page);
    const ready = availability('ready', 'ready'); const login = availability('login_required', 'login_required');
    expect(coordinator.settle(second, ready)).toEqual({ page: ready, current: true, accountUpdate: ready });
    expect(coordinator.settle(first, login)).toEqual({ page: login, current: false });
    expect(coordinator.settle(first, ready)).toEqual({ page: ready, current: false });
  });

  it.each(['page-disposed', 'owner-changed'] as const)('页面%s后即使回读ready，也不能认领结果或更新账号', (change): void => {
    const coordinator = new PageAvailabilityCoordinator(); const page = {}; const token = coordinator.begin('TEST-account', page);
    if (change === 'page-disposed') coordinator.invalidatePage(page);
    const ready = availability('ready', 'ready');
    expect(coordinator.settle(token, ready, { isCurrent: (): boolean => change !== 'owner-changed' })).toEqual({ page: ready, current: false });
    expect(coordinator.isChecking('TEST-account')).toBe(false);
  });

  it.each(['login_required', 'human_verification'] as const)('其他页发现%s后，迟到ready仍保留原读数但失去发布权并带上账号阻断', (reason): void => {
    const coordinator = new PageAvailabilityCoordinator(); const a = coordinator.begin('TEST-account', {}); const b = coordinator.begin('TEST-account', {});
    const block = availability(reason === 'login_required' ? 'login_required' : 'action_required', reason);
    const ready = availability('ready', 'ready');
    expect(coordinator.settle(b, block)).toEqual({ page: block, current: true, accountUpdate: block, accountBlock: block });
    expect(coordinator.settle(a, ready, { allowAccountRecovery: true })).toEqual({ page: ready, current: false, accountBlock: block });
    const ordinary = coordinator.begin('TEST-account', {});
    expect(coordinator.settle(ordinary, ready)).toEqual({ page: ready, current: true, accountBlock: block });
  });

  it('只有验证后当前代次的明确核对可解除阻断，验证期间旧回读不能迟到恢复', (): void => {
    const coordinator = new PageAvailabilityCoordinator(); const block = availability('action_required', 'human_verification'); const ready = availability('ready', 'ready');
    coordinator.blockAccount('TEST-account', block);
    const oldRecovery = coordinator.begin('TEST-account', {}); const recovery = coordinator.begin('TEST-account', {});
    expect(coordinator.settle(recovery, ready, { allowAccountRecovery: true })).toEqual({ page: ready, current: true, accountUpdate: ready });
    expect(coordinator.settle(oldRecovery, ready, { allowAccountRecovery: true })).toEqual({ page: ready, current: false });
    const newerBlock = availability('action_required', 'human_verification', '2026-11-05T00:00:01.000Z');
    coordinator.blockAccount('TEST-account', newerBlock);
    expect(coordinator.settle(coordinator.begin('TEST-account', {}), ready)).toEqual({ page: ready, current: true, accountBlock: newerBlock });
  });

  it('页面外检测到验证码也撤销旧ready，其他账号仍可独立核对', (): void => {
    const coordinator = new PageAvailabilityCoordinator(); const a = coordinator.begin('TEST-a', {}); const b = coordinator.begin('TEST-b', {});
    const block = availability('action_required', 'human_verification'); const ready = availability('ready', 'ready');
    coordinator.blockAccount('TEST-a', block);
    expect(coordinator.settle(a, ready)).toEqual({ page: ready, current: false, accountBlock: block });
    expect(coordinator.settle(b, ready)).toEqual({ page: ready, current: true, accountUpdate: ready });
    expect((): void => { coordinator.blockAccount('TEST-a', availability('unknown', 'page_unrecognized')); }).toThrow('真实登录或人机验证证据');
  });

  it('一个页面结束探测不提前撤销同账号另一页的检查状态', (): void => {
    const coordinator = new PageAvailabilityCoordinator(); const a = coordinator.begin('TEST-account', {}); const b = coordinator.begin('TEST-account', {});
    coordinator.settle(a, availability('unknown', 'page_loading'));
    expect(coordinator.isChecking('TEST-account')).toBe(true);
    coordinator.cancel(b); expect(coordinator.isChecking('TEST-account')).toBe(false);
  });

  it('settle后的原ready token仍可在写盘后核对，换探测或释放页面立即失效', (): void => {
    const coordinator = new PageAvailabilityCoordinator(); const page = {};
    const original = coordinator.begin('TEST-account', page);
    coordinator.settle(original, availability('ready', 'ready'));
    expect(coordinator.isCurrent(original)).toBe(true);
    const replacement = coordinator.begin('TEST-account', page);
    expect(coordinator.isCurrent(original)).toBe(false); expect(coordinator.isCurrent(replacement)).toBe(true);
    coordinator.invalidatePage(page); expect(coordinator.isCurrent(replacement)).toBe(false);
  });

  it('写盘期间出现真实验证码使原ready token失效，查询只返回当前账号真实阻断', (): void => {
    const coordinator = new PageAvailabilityCoordinator(); const ready = availability('ready', 'ready');
    const original = coordinator.begin('TEST-account', {}); coordinator.settle(original, ready);
    const block = availability('action_required', 'human_verification'); coordinator.blockAccount('TEST-account', block);
    expect(coordinator.isCurrent(original)).toBe(false); expect(coordinator.currentAccountBlock('TEST-account')).toBe(block);
    expect(coordinator.currentAccountBlock('TEST-other-account')).toBeUndefined();
    const recovery = coordinator.begin('TEST-account', {}); coordinator.settle(recovery, ready, { allowAccountRecovery: true });
    expect(coordinator.currentAccountBlock('TEST-account')).toBeUndefined(); expect(coordinator.isCurrent(recovery)).toBe(true);
    const newerBlock = availability('action_required', 'human_verification', '2026-11-05T00:00:01.000Z');
    coordinator.blockAccount('TEST-account', newerBlock);
    expect(coordinator.isCurrent(recovery)).toBe(false); expect(coordinator.currentAccountBlock('TEST-account')).toBe(newerBlock);
  });

  it('恢复后重播旧缓存阻断不重新锁定账号，也不覆盖后来真实的新验证事实', (): void => {
    const coordinator = new PageAvailabilityCoordinator(); const block = availability('action_required', 'human_verification'); const ready = availability('ready', 'ready');
    coordinator.blockAccount('TEST-account', block);
    const recovery = coordinator.begin('TEST-account', {}); coordinator.settle(recovery, ready, { allowAccountRecovery: true });
    expect(coordinator.blockAccount('TEST-account', { ...block })).toBe(false);
    expect(coordinator.currentAccountBlock('TEST-account')).toBeUndefined(); expect(coordinator.isCurrent(recovery)).toBe(true);
    const replay = coordinator.begin('TEST-account', {});
    expect(coordinator.settle(replay, { ...block })).toEqual({ page: block, current: true });
    const newer = availability('action_required', 'human_verification', '2026-11-05T00:00:02.000Z');
    coordinator.blockAccount('TEST-account', newer); const current = coordinator.begin('TEST-account', {});
    coordinator.blockAccount('TEST-account', { ...block });
    expect(coordinator.currentAccountBlock('TEST-account')).toBe(newer); expect(coordinator.isCurrent(current)).toBe(true);
    expect(coordinator.isCurrent(recovery)).toBe(false);
  });
});
