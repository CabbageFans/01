/** 离线外壳导航回归；浏览器为挂载计数替身，不连接真实账号或平台。 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import { useTaskStore } from '../../src/store/useTaskStore';

const lifetime = vi.hoisted(() => ({ mounted: 0, unmounted: 0 }));
vi.mock('../../src/components/BrowserPanel', () => ({ default: (): React.ReactElement => { React.useEffect((): (() => void) => { lifetime.mounted++; return (): void => { lifetime.unmounted++; }; }, []); return <div data-testid="resident-browser">TEST browser</div>; } }));
vi.mock('../../src/components/PetStoryChatAdjustmentPanel', () => ({ default: (): React.ReactElement => <div>TEST 目标回复选择</div> }));
vi.mock('../../src/components/PetStoryPanel', () => ({ PetStoryPanel: (): React.ReactElement => <textarea aria-label="短剧草稿" /> }));
vi.mock('../../src/components/WorkspaceOverview', () => ({ WorkspaceOverview: (): React.ReactElement => <div>TEST 当前短剧</div> }));
vi.mock('../../src/components/TaskConsole', () => ({ default: (): React.ReactElement => <div>TEST 当前任务</div> }));
vi.mock('../../src/components/Toolbar', () => ({ Toolbar: (): React.ReactElement => <div /> }));
vi.mock('../../src/store/usePetStoryStore', async (importOriginal) => ({ ...await importOriginal<typeof import('../../src/store/usePetStoryStore')>(), observePetStoryTasks: (): (() => void) => (): void => undefined }));

const originals = { accounts: useAccountStore.getState(), projects: useProjectStore.getState(), tasks: useTaskStore.getState() };
beforeEach((): void => {
  lifetime.mounted = 0; lifetime.unmounted = 0;
  window.electronAPI = { system: { getVersion: vi.fn(async (): Promise<string> => 'TEST-version') }, control: { onCommand: vi.fn((): (() => void) => (): void => undefined), ready: vi.fn() } } as unknown as typeof window.electronAPI;
  useAccountStore.setState({ ...originals.accounts, accounts: [], selectedAccountId: null, error: null, loadAccounts: vi.fn(async (): Promise<void> => undefined), refreshDailyQuota: vi.fn(async (): Promise<void> => undefined) });
  useProjectStore.setState({ ...originals.projects, projects: [], loadProjects: vi.fn(async (): Promise<void> => undefined) });
  useTaskStore.setState({ ...originals.tasks, tasks: [], accountAutomationState: {}, loadTasks: vi.fn(async (): Promise<void> => undefined), processQueue: vi.fn() });
});
afterEach((): void => { cleanup(); useAccountStore.setState(originals.accounts); useProjectStore.setState(originals.projects); useTaskStore.setState(originals.tasks); vi.restoreAllMocks(); });

describe('短剧产品外壳', (): void => {
  it('六个入口只保留短剧创作，导航、打开浏览器和返回均不重挂常驻宿主', async (): Promise<void> => {
    const view = render(<App />); await act(async (): Promise<void> => undefined);
    expect(screen.getByText('短剧工作室')).toBeDefined(); expect(screen.getByRole('heading', { name: '创作工作台' })).toBeDefined();
    expect(screen.queryByText('通用创作')).toBeNull(); expect(screen.queryByRole('radio', { name: '通用创作' })).toBeNull();
    const resident = screen.getByTestId('resident-browser');
    for (const name of ['短剧创作', '任务中心', '素材与下载', '账号与浏览器', '设置与诊断', '工作台总览']) fireEvent.click(screen.getByRole('button', { name }));
    fireEvent.click(screen.getByRole('button', { name: /豆包 Chat/ }));
    expect(screen.getByTestId('resident-browser')).toBe(resident); expect(lifetime.mounted).toBe(1); expect(lifetime.unmounted).toBe(0);
    view.unmount(); expect(lifetime.unmounted).toBe(1);
  });
  it('短剧编辑草稿在管理页往返后保留，浏览只改变可见页面', async (): Promise<void> => {
    render(<App />); await act(async (): Promise<void> => undefined);
    fireEvent.click(screen.getByRole('button', { name: '短剧创作' }));
    const draft = screen.getByRole('textbox', { name: '短剧草稿' }); fireEvent.change(draft, { target: { value: 'TEST 未保存的剧本草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '任务中心' })); expect(screen.queryByRole('textbox', { name: '短剧草稿' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '短剧创作' })); expect((screen.getByRole('textbox', { name: '短剧草稿' }) as HTMLTextAreaElement).value).toBe('TEST 未保存的剧本草稿');
    expect(lifetime.mounted).toBe(1);
  });
});
