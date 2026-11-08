/** 离线执行真实浏览器面板；模拟 Electron 事件，不访问账号会话或平台。 */
import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserPanel from '../../src/components/BrowserPanel';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { automationEngine } from '../../src/automation/AutomationEngine';
import type { Account, Task } from '@doubao-studio/contracts';

vi.mock('../../src/utils/accountAvailability', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils/accountAvailability')>(),
  probeAccountAvailability: vi.fn(async (): Promise<object> => ({
    state: 'ready', reason: 'ready', message: 'TEST 页面就绪',
    checkedAt: '2026-11-08T00:00:00.000Z', source: 'navigation',
  })),
}));
vi.mock('../../src/utils/doubaoBridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils/doubaoBridge')>(),
  dismissKnownDesktopDownloadPromotion: vi.fn(async (): Promise<string> => 'absent'),
}));

const originalAccounts = useAccountStore.getState();
const originalTasks = useTaskStore.getState();
const originalPetStory = usePetStoryStore.getState();
const timestamp = '2026-11-08T00:00:00.000Z';
const accounts: Account[] = ['a', 'b', 'c'].map((id: string): Account => ({
  id: `TEST-${id}`, name: `TEST 账号 ${id}`, avatar: '', partition: `TEST-partition-${id}`,
  platform: 'doubao', pinned: false, status: 'idle', createdAt: timestamp, updatedAt: timestamp,
}));

function sharedTask(suffix: string): Task {
  return { id: `TEST-${suffix}-task`, assignedAccountId: accounts[0].id,
    mode: 'chat', status: 'executing', prompt: 'TEST 脱机任务', result: null, outputs: [],
    createdAt: timestamp, updatedAt: timestamp,
    runtime: { runId: `TEST-${suffix}-run`, attempt: 1, stage: 'preparing_account', message: 'TEST',
      startedAt: timestamp, stageStartedAt: timestamp, lastHeartbeatAt: timestamp,
      input: { mode: 'chat', prompt: 'TEST 脱机任务', attachments: [] } } };
}

const Harness: React.FC = (): React.ReactElement => {
  const list = useAccountStore((state) => state.accounts);
  const selected = useAccountStore((state) => state.selectedAccountId);
  return <BrowserPanel accounts={list} activeAccount={list.find((account: Account): boolean => account.id === selected) || null} refreshKey={0} />;
};

function event(webview: Element, name: string, details: Record<string, unknown> = {}): void {
  act((): void => { webview.dispatchEvent(Object.assign(new Event(name), details)); });
}

beforeEach((): void => {
  vi.useFakeTimers();
  // 后台宿主可能暂停绘制帧；页面就绪不能依赖此回调才撤销遮罩。
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((): number => 1);
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((name: string, options?: ElementCreationOptions): HTMLElement => {
    const element = createElement(name, options);
    if (name === 'webview') Object.assign(element, {
      getURL: (): string => 'https://www.doubao.com/chat/',
      getTitle: (): string => '',
      executeJavaScript: vi.fn(async (): Promise<unknown> => false),
      reload: vi.fn(),
    });
    return element;
  }) as typeof document.createElement);
  useAccountStore.setState({ ...originalAccounts, accounts: [], selectedAccountId: null,
    availabilityChecking: {}, availabilityCheckRequests: {},
    setAccountAvailability: vi.fn(async (): Promise<boolean> => true),
  });
  useTaskStore.setState({ ...originalTasks, tasks: [], executingTasks: {}, accountBusy: {}, accountAutomationState: {}, accountAutoMessage: {} });
  usePetStoryStore.setState({ ...originalPetStory, project: null, activeImageOperationId: null });
  window.electronAPI = {
    logs: { append: vi.fn(async (): Promise<void> => undefined) },
    accounts: { setStatus: vi.fn(async (): Promise<object> => ({ success: true })) },
    tasks: {
      updateRuntime: vi.fn(async (): Promise<object> => ({ success: true })),
      acquireLock: vi.fn(async (): Promise<object> => ({ success: true })),
      releaseLock: vi.fn(async (): Promise<object> => ({ success: true })),
    },
  } as unknown as typeof window.electronAPI;
});

afterEach((): void => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useAccountStore.setState(originalAccounts);
  useTaskStore.setState(originalTasks);
  usePetStoryStore.setState(originalPetStory);
});

describe('账号浏览器首屏与常驻页面', (): void => {
  it.each([{ list: [] }, { list: [accounts[0]] }])('未选择账号时展示真实空态，不叠加永久加载遮罩 %#', ({ list }: { list: Account[] }): void => {
    useAccountStore.setState({ accounts: list });
    const view = render(<Harness />);
    expect(view.container.querySelector('.browser-panel-empty')).not.toBeNull();
    expect(view.container.querySelector('.browser-loading-overlay')).toBeNull();
    expect(view.container.textContent).toContain(list.length ? '请选择要查看的账号' : '尚无账号');
  });

  it('DOM 已就绪后立即显示，后台暂停 requestAnimationFrame 也不遮挡', (): void => {
    useAccountStore.setState({ accounts: [accounts[0]], selectedAccountId: accounts[0].id });
    const view = render(<Harness />);
    const webview = view.container.querySelector('webview')!;
    expect(webview).not.toBeNull();
    expect(view.container.querySelector('.browser-loading-overlay')).not.toBeNull();
    event(webview, 'dom-ready');
    expect(view.container.querySelector('.browser-loading-overlay')).toBeNull();
    expect((webview as HTMLElement).style.pointerEvents).toBe('auto');
  });

  it('清空当前选择时立即显示空态，并将原账号页面移出可视区', (): void => {
    useAccountStore.setState({ accounts: [accounts[0]], selectedAccountId: accounts[0].id });
    const view = render(<Harness />);
    const webview = view.container.querySelector('webview') as HTMLElement;
    act((): void => { useAccountStore.getState().selectAccount(null); });
    expect(view.container.querySelector('.browser-loading-overlay')).toBeNull();
    expect(view.container.querySelector('.browser-panel-empty')).not.toBeNull();
    expect(webview.isConnected).toBe(true);
    expect(webview.style.pointerEvents).toBe('none');
    expect(webview.style.transform).toContain('-200vw');
  });

  it('资源、子框架、页内及后续主框架导航保留已显示页面，不重新用全屏遮罩覆盖', (): void => {
    useAccountStore.setState({ accounts: [accounts[0]], selectedAccountId: accounts[0].id });
    const view = render(<Harness />);
    const webview = view.container.querySelector('webview')!;
    event(webview, 'dom-ready');
    event(webview, 'did-start-loading');
    expect(view.container.querySelector('.browser-loading-overlay')).toBeNull();
    event(webview, 'did-start-navigation', { isMainFrame: false, isInPlace: false });
    expect(view.container.querySelector('.browser-loading-overlay')).toBeNull();
    event(webview, 'did-start-navigation', { isMainFrame: true, isInPlace: true });
    expect(view.container.querySelector('.browser-loading-overlay')).toBeNull();
    event(webview, 'did-start-navigation', { isMainFrame: true, isInPlace: false });
    expect(view.container.querySelector('.browser-loading-overlay')).toBeNull();
    event(webview, 'dom-ready');
    expect(view.container.querySelector('.browser-loading-overlay')).toBeNull();
  });

  it('切换账号保留尚在加载的原页面，返回时复用原 guest 与 partition', (): void => {
    useAccountStore.setState({ accounts: accounts.slice(0, 2), selectedAccountId: accounts[0].id });
    const view = render(<Harness />);
    const first = view.container.querySelector('webview')!;
    const partition = first.getAttribute('partition');
    act((): void => { useAccountStore.getState().selectAccount(accounts[1].id); });
    expect(first.isConnected).toBe(true);
    expect(view.container.querySelectorAll('webview')).toHaveLength(2);
    act((): void => { useAccountStore.getState().selectAccount(accounts[0].id); });
    expect(view.container.querySelectorAll('webview')).toHaveLength(2);
    expect(view.container.querySelector('webview')).toBe(first);
    expect(first.getAttribute('partition')).toBe(partition);
  });

  it('首屏连接超时显示可操作的错误，迟到的真实页面仍可正常显示', async (): Promise<void> => {
    useAccountStore.setState({ accounts: [accounts[0]], selectedAccountId: accounts[0].id });
    const view = render(<Harness />);
    const webview = view.container.querySelector('webview') as HTMLWebViewElement;
    await act(async (): Promise<void> => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(view.container.querySelector('.browser-loading-overlay')).toBeNull();
    expect(view.getByRole('alert').textContent).toContain('页面连接较慢');
    expect(webview.reload).not.toHaveBeenCalled();
    event(webview, 'dom-ready');
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.container.querySelector('.browser-loading-overlay')).toBeNull();
  });

  it('网络失败保留真实错误与刷新入口，不被迟到加载事件改写且不自动重载', async (): Promise<void> => {
    useAccountStore.setState({ accounts: [accounts[0]], selectedAccountId: accounts[0].id });
    const view = render(<Harness />);
    const webview = view.container.querySelector('webview') as HTMLWebViewElement;
    event(webview, 'did-fail-load', { errorCode: -3, isMainFrame: true });
    event(webview, 'did-fail-load', { errorCode: -105, isMainFrame: false });
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.container.querySelector('.browser-loading-overlay')).not.toBeNull();
    event(webview, 'did-fail-load', { errorCode: -105, isMainFrame: true });
    expect(view.container.querySelector('.browser-loading-overlay')).toBeNull();
    expect(view.getByRole('alert').textContent).toContain('页面加载失败');
    for (const name of ['did-stop-loading', 'did-finish-load', 'dom-ready']) event(webview, name);
    await act(async (): Promise<void> => { await vi.advanceTimersByTimeAsync(2000); });
    expect(view.getByRole('alert').textContent).toContain('页面加载失败');
    expect(webview.reload).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: '刷新页面' }));
    expect(webview.reload).toHaveBeenCalledOnce();
    event(webview, 'did-start-navigation', { isMainFrame: true, isInPlace: false });
    event(webview, 'dom-ready');
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.container.querySelector('.browser-loading-overlay')).toBeNull();
  });

  it('共享账号页面明确加载失败后暂停原任务并释放执行槽，迟到停止事件也不能授予执行权', async (): Promise<void> => {
    useAccountStore.setState({ accounts: [accounts[0]], selectedAccountId: accounts[0].id });
    const view = render(<Harness />);
    const webview = view.container.querySelector('webview')!;
    event(webview, 'did-fail-load', { errorCode: -105, isMainFrame: true });
    event(webview, 'did-stop-loading');
    const task = sharedTask('failed-page');
    expect(await automationEngine.reserve(task.id, accounts[0].id, 'TEST-owner', task)).toEqual({ ok: true });
    const createController = vi.spyOn(automationEngine, 'createController');
    const pause = vi.spyOn(useTaskStore.getState(), 'pauseAutomation');
    await act(async (): Promise<void> => {
      useTaskStore.setState({ tasks: [task], executingTasks: { [accounts[0].id]: task.id }, accountBusy: { [accounts[0].id]: true } });
    });
    expect(pause).toHaveBeenCalledExactlyOnceWith(task.id, accounts[0].id, expect.stringContaining('页面加载失败'), { status: 'paused', code: 'page_loading' });
    const state = useTaskStore.getState();
    expect(state.tasks[0].status).toBe('paused');
    expect(state.tasks[0].runtime?.runId).toBe(task.runtime?.runId);
    expect(state.tasks[0].runtime?.input).toEqual(task.runtime?.input);
    expect(state.executingTasks[accounts[0].id]).toBeUndefined();
    expect(state.accountBusy[accounts[0].id]).toBeUndefined();
    expect(automationEngine.isReserved(task.id)).toBe(false);
    expect(window.electronAPI.tasks.releaseLock).toHaveBeenCalledExactlyOnceWith(task.id, 'TEST-owner');
    expect(createController).not.toHaveBeenCalled();
    expect(view.getByRole('alert').textContent).toContain('页面加载失败');
  });

  it('共享页面首屏超时主动暂停等待文档的任务，并释放账号槽和任务租约', async (): Promise<void> => {
    useAccountStore.setState({ accounts: [accounts[0]], selectedAccountId: accounts[0].id });
    const task = sharedTask('timeout-page');
    expect(await automationEngine.reserve(task.id, accounts[0].id, 'TEST-timeout-owner', task)).toEqual({ ok: true });
    const createController = vi.spyOn(automationEngine, 'createController');
    const pause = vi.spyOn(useTaskStore.getState(), 'pauseAutomation');
    useTaskStore.setState({ tasks: [task], executingTasks: { [accounts[0].id]: task.id }, accountBusy: { [accounts[0].id]: true } });
    const view = render(<Harness />);
    expect(pause).not.toHaveBeenCalled();
    await act(async (): Promise<void> => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(pause).toHaveBeenCalledExactlyOnceWith(task.id, accounts[0].id, expect.stringContaining('页面连接较慢'), { status: 'paused', code: 'page_loading' });
    const state = useTaskStore.getState();
    expect(state.tasks[0].status).toBe('paused');
    expect(state.tasks[0].runtime?.runId).toBe(task.runtime?.runId);
    expect(state.tasks[0].runtime?.input).toEqual(task.runtime?.input);
    expect(state.executingTasks[accounts[0].id]).toBeUndefined();
    expect(state.accountBusy[accounts[0].id]).toBeUndefined();
    expect(automationEngine.isReserved(task.id)).toBe(false);
    expect(window.electronAPI.tasks.releaseLock).toHaveBeenCalledExactlyOnceWith(task.id, 'TEST-timeout-owner');
    expect(createController).not.toHaveBeenCalled();
    expect(view.container.querySelector('.browser-loading-overlay')).toBeNull();
    expect(view.getByRole('alert').textContent).toContain('页面连接较慢');
  });

  it('共享账号任务等待首个文档就绪，dom-ready 主动唤醒派发', (): void => {
    useAccountStore.setState({ accounts: [accounts[0]], selectedAccountId: accounts[0].id });
    const enterExecution = vi.spyOn(automationEngine, 'hasController').mockReturnValue(true);
    const task: Task = { id: 'TEST-loading-page-task', assignedAccountId: accounts[0].id,
      mode: 'chat', status: 'executing', prompt: 'TEST 脱机任务', result: null, outputs: [],
      createdAt: timestamp, updatedAt: timestamp };
    useTaskStore.setState({ tasks: [task], executingTasks: { [accounts[0].id]: task.id }, accountBusy: { [accounts[0].id]: true } });
    const view = render(<Harness />);
    expect(enterExecution).not.toHaveBeenCalled();
    const webview = view.container.querySelector('webview')!;
    event(webview, 'dom-ready');
    expect(enterExecution).toHaveBeenCalledExactlyOnceWith(task.id);
    expect(view.container.querySelector('.browser-loading-overlay')).toBeNull();
  });

  it('后台单通道预热不被任务快照刷新回收，完成后继续预热下一账号', async (): Promise<void> => {
    useAccountStore.setState({ accounts, selectedAccountId: accounts[0].id });
    const view = render(<Harness />);
    const first = view.container.querySelector('webview')!;
    await act(async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); });
    expect(view.container.querySelectorAll('webview')).toHaveLength(1);
    event(first, 'dom-ready');
    await act(async (): Promise<void> => { await vi.advanceTimersByTimeAsync(1000); });
    const second = view.container.querySelectorAll('webview')[1];
    expect(second).toBeDefined();
    expect(view.container.querySelectorAll('webview')).toHaveLength(2);
    act((): void => { useTaskStore.setState({ tasks: [] }); });
    expect(second.isConnected).toBe(true);
    await act(async (): Promise<void> => { await vi.advanceTimersByTimeAsync(1000); });
    expect(view.container.querySelectorAll('webview')).toHaveLength(2);
    event(second, 'dom-ready');
    await act(async (): Promise<void> => { await vi.advanceTimersByTimeAsync(250); });
    expect(second.isConnected).toBe(true);
    expect(view.container.querySelectorAll('webview')).toHaveLength(3);
  });
});
