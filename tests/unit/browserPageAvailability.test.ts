/** 离线运行真实BrowserPanel探测闭包，账号写盘仅为可控promise，不操作平台。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { AccountAvailability, AccountAvailabilitySource } from '@doubao-studio/contracts';
import { PageAvailabilityCoordinator, isAccountAvailabilityBlock } from '../../src/utils/pageAvailability';

type Probe = (accountId: string, page: object, source: AccountAvailabilitySource) => Promise<AccountAvailability>;
function actual<T>(name: string, bindings: Record<string, unknown> = {}): T {
  const file = ts.createSourceFile('BrowserPanel.tsx', fs.readFileSync(path.resolve('src/components/BrowserPanel.tsx'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let expression = '';
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) expression = node.initializer!.getText(file);
    if (ts.isClassDeclaration(node) && node.name?.getText(file) === name) expression = node.getText(file);
    ts.forEachChild(node, visit);
  };
  visit(file); if (!expression) throw new Error(`TEST actual ${name} not found`);
  const script = ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(script, { ...bindings, Error, Date }) as T;
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = (): void => { throw new Error('TEST promise not initialized'); };
  const promise = new Promise<T>((done): void => { resolve = done; }); return { promise, resolve };
}
function evidence(state: AccountAvailability['state'], reason: string): AccountAvailability {
  return { state, reason, source: 'pre_task', message: `TEST ${reason}`, checkedAt: '2026-11-05T00:00:00.000Z' };
}

function fixture(kind: 'account' | 'material', existing: AccountAvailability = evidence('ready', 'ready')): {
  probe: Probe; page: object; otherPage: object; coordinator: PageAvailabilityCoordinator;
  writeEntered: Promise<void>; releaseWrite: (saved: boolean) => void; removePage: () => void;
  writes: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; schedule: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>; setChecking: ReturnType<typeof vi.fn>;
} {
  const page = {}; const otherPage = {}; const registry = new Map<string, object>(); const materialPages = new Set<object>();
  if (kind === 'account') registry.set('TEST-account', page); else materialPages.add(page);
  materialPages.add(otherPage);
  const coordinator = new PageAvailabilityCoordinator(); const write = deferred<boolean>(); const entered = deferred<void>();
  const account = { id: 'TEST-account', name: 'TEST 账号', platform: 'doubao', health: { availability: existing } };
  const writes = vi.fn(async (id: string, availability: AccountAvailability): Promise<boolean> => {
    expect(id).toBe(account.id); entered.resolve(); const saved = await write.promise;
    if (saved) account.health.availability = availability;
    return saved;
  });
  const resume = vi.fn(async (): Promise<void> => undefined); const schedule = vi.fn(); const setChecking = vi.fn();
  const read = vi.fn(async (): Promise<AccountAvailability> => evidence('ready', 'ready'));
  const probe = actual<Probe>('performAvailabilityCheck', {
    useCallback: <T>(callback: T): T => callback,
    useAccountStore: { getState: (): object => ({ accounts: [account], setAvailabilityChecking: setChecking, setAccountAvailability: writes }) },
    useTaskStore: { getState: (): object => ({ resumeAfterAccountVerification: resume, processQueue: vi.fn() }) },
    availabilityProbesRef: { current: coordinator }, registryRef: { current: registry },
    materialPagesRef: { current: { contains: (candidate: object): boolean => materialPages.has(candidate) } },
    probeAccountAvailability: read, isAccountAvailabilityBlock,
    AccountAvailabilityPauseError: actual('AccountAvailabilityPauseError'),
    message: { success: vi.fn(), warning: vi.fn() }, setTimeout: schedule,
  });
  return { probe, page, otherPage, coordinator, writeEntered: entered.promise, releaseWrite: write.resolve,
    removePage: (): void => { registry.delete('TEST-account'); materialPages.delete(page); }, writes, resume, schedule, read, setChecking };
}

describe('页面可用性写盘后的真实归属与验证代次', (): void => {
  it.each(['account', 'material'] as const)('%s页在账号写盘期间被移除时不能返回可控制ready或恢复任务', async (kind): Promise<void> => {
    const test = fixture(kind); const pending = test.probe('TEST-account', test.page, 'pre_task'); await test.writeEntered;
    test.removePage(); test.releaseWrite(true);
    await expect(pending).rejects.toMatchObject({ name: 'AccountAvailabilityPauseError', code: 'page_changed' });
    expect(test.resume).not.toHaveBeenCalled(); expect(test.schedule).not.toHaveBeenCalled(); expect(test.writes).toHaveBeenCalledOnce();
    expect(test.coordinator.isChecking('TEST-account')).toBe(false); expect(test.setChecking).toHaveBeenLastCalledWith('TEST-account', false);
  });

  it('页面归属不变时返回本页证据，并在写盘结束后恢复任务', async (): Promise<void> => {
    const test = fixture('material'); const ready = evidence('ready', 'ready'); test.read.mockResolvedValueOnce(ready);
    const pending = test.probe('TEST-account', test.page, 'pre_task'); await test.writeEntered;
    expect(test.resume).not.toHaveBeenCalled(); test.releaseWrite(true);
    expect(await pending).toBe(ready); expect(test.resume).toHaveBeenCalledExactlyOnceWith('TEST-account', ready.checkedAt);
    expect(test.schedule).toHaveBeenCalledOnce(); expect(test.coordinator.isChecking('TEST-account')).toBe(false);
  });

  it('写盘期间出现真实验证码时保留账号阻断，不以原ready恢复任务', async (): Promise<void> => {
    const test = fixture('material'); const pending = test.probe('TEST-account', test.page, 'pre_submit'); await test.writeEntered;
    const block = evidence('action_required', 'human_verification'); test.coordinator.blockAccount('TEST-account', block); test.releaseWrite(true);
    await expect(pending).rejects.toMatchObject({ name: 'AccountAvailabilityPauseError', code: 'human_verification' });
    expect(test.coordinator.currentAccountBlock('TEST-account')).toBe(block); expect(test.resume).not.toHaveBeenCalled(); expect(test.schedule).not.toHaveBeenCalled();
  });

  it('正式恢复写盘期间另一页重播旧账号验证码缓存，不会把恢复重新锁定或污染本页unknown', async (): Promise<void> => {
    const block = evidence('action_required', 'human_verification'); const test = fixture('account', block);
    const ready = evidence('ready', 'ready'); const unknown = evidence('unknown', 'page_unrecognized');
    test.read.mockResolvedValueOnce(ready).mockResolvedValueOnce(unknown);
    const recovering = test.probe('TEST-account', test.page, 'manual'); await test.writeEntered;
    expect(test.coordinator.currentAccountBlock('TEST-account')).toBeUndefined();
    expect(await test.probe('TEST-account', test.otherPage, 'pre_task')).toBe(unknown);
    expect(test.coordinator.currentAccountBlock('TEST-account')).toBeUndefined(); expect(test.writes).toHaveBeenCalledOnce();
    test.releaseWrite(true); expect(await recovering).toBe(ready);
    expect(test.resume).toHaveBeenCalledOnce(); expect(test.schedule).toHaveBeenCalledOnce();
  });
});
