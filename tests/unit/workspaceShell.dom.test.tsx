/** 离线外壳导航回归；浏览器为挂载计数替身，不连接真实账号或平台。 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/App';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import type { PetStoryProject, Task } from '@doubao-studio/contracts';

const lifetime = vi.hoisted(() => ({ mounted: 0, unmounted: 0 }));
vi.mock('../../src/components/BrowserPanel', () => ({ default: (): React.ReactElement => { React.useEffect((): (() => void) => { lifetime.mounted++; return (): void => { lifetime.unmounted++; }; }, []); return <div data-testid="resident-browser">TEST browser</div>; } }));
vi.mock('../../src/components/PetStoryChatAdjustmentPanel', () => ({ default: (): React.ReactElement => <div>TEST 目标回复选择</div> }));
vi.mock('../../src/components/PetStoryPanel', () => ({ PetStoryPanel: (): React.ReactElement => <textarea aria-label="短剧草稿" /> }));
vi.mock('../../src/components/WorkspaceOverview', () => ({ WorkspaceOverview: (): React.ReactElement => <div>TEST 当前短剧</div> }));
vi.mock('../../src/components/TaskConsole', () => ({ default: (): React.ReactElement => <div>TEST 当前任务</div> }));
vi.mock('../../src/components/Toolbar', () => ({ Toolbar: (): React.ReactElement => <div /> }));
vi.mock('../../src/store/usePetStoryStore', async (importOriginal) => ({ ...await importOriginal<typeof import('../../src/store/usePetStoryStore')>(), observePetStoryTasks: (): (() => void) => (): void => undefined }));

const originals = { accounts: useAccountStore.getState(), projects: useProjectStore.getState(), tasks: useTaskStore.getState(), petstory: usePetStoryStore.getState() };
beforeEach((): void => {
  lifetime.mounted = 0; lifetime.unmounted = 0;
  window.electronAPI = { system: { getVersion: vi.fn(async (): Promise<string> => 'TEST-version') }, control: { onCommand: vi.fn((): (() => void) => (): void => undefined), ready: vi.fn() } } as unknown as typeof window.electronAPI;
  useAccountStore.setState({ ...originals.accounts, accounts: [], selectedAccountId: null, error: null, loadAccounts: vi.fn(async (): Promise<void> => undefined), refreshDailyQuota: vi.fn(async (): Promise<void> => undefined) });
  useProjectStore.setState({ ...originals.projects, projects: [], loadProjects: vi.fn(async (): Promise<void> => undefined) });
  useTaskStore.setState({ ...originals.tasks, tasks: [], accountAutomationState: {}, loadTasks: vi.fn(async (): Promise<void> => undefined), processQueue: vi.fn() });
  usePetStoryStore.setState({ ...originals.petstory, project: null, activeImageOperationId: null });
});
afterEach((): void => { cleanup(); useAccountStore.setState(originals.accounts); useProjectStore.setState(originals.projects); useTaskStore.setState(originals.tasks); usePetStoryStore.setState(originals.petstory); vi.restoreAllMocks(); });

function backgroundProject(): PetStoryProject {
  return { id: 'TEST-canvas-project', schemaVersion: 1, revision: 1, studioProjectId: 'default-project', accountId: 'TEST-account', updatedAt: '2026-10-31T00:00:00Z',
    source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [{ id: 'TEST-canvas-job', taskId: 'TEST-canvas-task', kind: 'optimize', background: 'canvas',
      shotId: 'TEST-shot', promptKind: 'firstFrame', inputHash: 'TEST', sourceUrl: '', status: 'bound' }] };
}
function canvasTask(status: Task['status']): Task {
  return { id: 'TEST-canvas-task', assignedAccountId: 'TEST-account', projectId: 'default-project', mode: 'chat', prompt: 'TEST 脱机文字请求', status, result: null, outputs: [],
    createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z' };
}
function shotImageProject(kind: 'firstFrame' | 'lastFrame'): PetStoryProject {
  const project = backgroundProject();
  project.jobs = [];
  project.imageOperations = [{ id: `TEST-${kind}-operation`, requestId: `TEST-${kind}-click`, mode: 'generate', stage: 'preparing',
    target: { shotId: 'TEST-shot', kind }, basisHash: 'TEST-selected-shot', createdAt: '2026-10-31T00:00:00Z' }];
  return project;
}
function shotImageTask(kind: 'firstFrame' | 'lastFrame', status: Task['status']): Task {
  return { ...canvasTask(status), id: `TEST-${kind}-image-task`, mode: 'image', petstory: { projectId: 'TEST-canvas-project', stepId: `TEST-${kind}-step` } };
}

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
  it('画布模式贯穿外壳，离开创作页恢复普通页面布局', async (): Promise<void> => {
    const view = render(<App />); await act(async (): Promise<void> => undefined);
    fireEvent.click(screen.getByRole('button', { name: '短剧创作' }));
    act((): void => { window.dispatchEvent(new CustomEvent('petstory-canvas-mode', { detail: { active: true } })); });
    expect(view.container.querySelector('.workspace-body.is-canvas-workspace')).not.toBeNull();
    expect(view.container.querySelector('.workspace-content.is-canvas-workspace > .page-fill.is-canvas-workspace')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '任务中心' }));
    expect(view.container.querySelector('.workspace-body.is-canvas-workspace')).toBeNull();
  });
  it('后台文字注入及登录等待只保留宿主，主动查看才展开', async (): Promise<void> => {
    usePetStoryStore.setState({ project: backgroundProject() });
    useTaskStore.setState({ tasks: [canvasTask('queued')], executingTasks: {}, accountAutomationState: {} });
    const view = render(<App />); await act(async (): Promise<void> => undefined);
    act((): void => { useTaskStore.setState({ tasks: [canvasTask('executing')], executingTasks: { 'TEST-account': 'TEST-canvas-task' }, accountAutomationState: { 'TEST-account': 'injecting' } }); });
    const host = view.container.querySelector('.browser-host')!;
    expect(host.classList.contains('is-parked')).toBe(true); expect(host.classList.contains('is-background-executing')).toBe(true);
    expect(host.hasAttribute('inert')).toBe(false);
    act((): void => { useTaskStore.setState({ tasks: [canvasTask('waiting_verification')], executingTasks: {}, accountAutomationState: { 'TEST-account': 'idle' } }); });
    expect(host.classList.contains('is-parked')).toBe(true);
    act((): void => { window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: 'TEST-canvas-task' } })); });
    expect(host.classList.contains('is-parked')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /豆包 Chat/ }));
    expect(host.classList.contains('is-assist')).toBe(true); expect(lifetime.mounted).toBe(1);
  });
  it('无关自由chat的前台交互仍然可见，不能按模式一律隐藏', async (): Promise<void> => {
    usePetStoryStore.setState({ project: backgroundProject() });
    useTaskStore.setState({ tasks: [{ ...canvasTask('executing'), id: 'TEST-free-chat' }], executingTasks: { 'TEST-account': 'TEST-free-chat' }, accountAutomationState: { 'TEST-account': 'injecting' } });
    const view = render(<App />); await act(async (): Promise<void> => undefined);
    expect(view.container.querySelector('.browser-host.is-assist')).not.toBeNull();
    expect(view.container.querySelector('.browser-host.is-background-executing')).toBeNull();
  });
  it.each(['firstFrame', 'lastFrame'] as const)('%s从创建间隙到输入、提交、等待及原结果核对均保持收起，主动点击才展开', async (kind): Promise<void> => {
    const project = shotImageProject(kind); const operationId = project.imageOperations![0].id;
    usePetStoryStore.setState({ project, activeImageOperationId: operationId });
    const view = render(<App />); await act(async (): Promise<void> => undefined);
    const host = view.container.querySelector('.browser-host')!;
    expect(host.classList.contains('is-parked')).toBe(true); expect(host.classList.contains('is-background-executing')).toBe(true);
    expect(host.hasAttribute('inert')).toBe(false); expect(host.getAttribute('aria-hidden')).toBe('true');
    const running = shotImageTask(kind, 'executing');
    act((): void => { usePetStoryStore.setState({ project: { ...project, imageOperations: [{ ...project.imageOperations![0], stage: 'generating', taskId: running.id }] }, activeImageOperationId: null }); });
    for (const state of ['injecting', 'submitting'] as const) {
      act((): void => { useTaskStore.setState({ tasks: [running], executingTasks: { 'TEST-account': running.id }, accountAutomationState: { 'TEST-account': state } }); });
      expect(host.classList.contains('is-parked')).toBe(true); expect(host.classList.contains('is-background-executing')).toBe(true); expect(host.hasAttribute('inert')).toBe(false);
      expect(screen.getByRole('button', { name: /豆包 Chat/ }).getAttribute('aria-pressed')).toBe('false');
    }
    for (const status of ['generating', 'manual_submission_observing'] as const) {
      act((): void => { useTaskStore.setState({ tasks: [{ ...running, status }], accountAutomationState: { 'TEST-account': 'generating' } }); });
      expect(host.classList.contains('is-parked')).toBe(true); expect(host.classList.contains('is-background-executing')).toBe(true);
    }
    act((): void => { window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: running.id } })); });
    expect(host.classList.contains('is-parked')).toBe(true);
    for (const status of ['waiting_verification', 'waiting_generation_confirmation'] as const) {
      act((): void => { useTaskStore.setState({ tasks: [{ ...running, status }], executingTasks: {}, accountAutomationState: { 'TEST-account': 'idle' } }); });
      expect(host.classList.contains('is-parked')).toBe(true); expect(host.classList.contains('is-background-executing')).toBe(false);
    }
    fireEvent.click(screen.getByRole('button', { name: /豆包 Chat/ }));
    expect(host.classList.contains('is-assist')).toBe(true); expect(host.getAttribute('aria-hidden')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '收起浏览器' }));
    expect(host.classList.contains('is-parked')).toBe(true); expect(lifetime.mounted).toBe(1); expect(lifetime.unmounted).toBe(0);
  });
  it.each(['image', 'video'] as const)('同账号无关联%s仍沿前台交互规则，不能被首尾帧后台识别吞掉', async (mode): Promise<void> => {
    const project = shotImageProject('firstFrame');
    project.imageOperations![0].stage = 'generating'; project.imageOperations![0].taskId = 'TEST-other-operation-task';
    usePetStoryStore.setState({ project });
    const task = { ...canvasTask('executing'), id: `TEST-free-${mode}`, mode };
    useTaskStore.setState({ tasks: [task], executingTasks: { 'TEST-account': task.id }, accountAutomationState: { 'TEST-account': 'injecting' } });
    const view = render(<App />); await act(async (): Promise<void> => undefined);
    expect(view.container.querySelector('.browser-host.is-assist')).not.toBeNull();
    expect(view.container.querySelector('.browser-host.is-background-executing')).toBeNull();
  });
  it('正式镜头视频从模式切换到生成和原结果观察保留后台视口，验证暂停不强制打开Chat', async (): Promise<void> => {
    const project = backgroundProject(); const entry = { state: 'unknown' as const, reason: 'TEST' };
    const video: Task = { ...canvasTask('queued'), id: 'TEST-shot-video', mode: 'video', petstory: { projectId: project.id, stepId: 'TEST-video-step' } };
    project.production = { phase: 'shots', target: { shotId: 'TEST-shot', kind: 'video' }, state: 'running', approvedAt: project.updatedAt, planHash: 'TEST',
      capability: { accountId: project.accountId, image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [] },
      fallbacks: {}, shots: {}, message: 'TEST', steps: [{ id: 'TEST-video-step', taskId: video.id, kind: 'video', shotId: 'TEST-shot',
        status: 'bound', inputHash: 'TEST', attachmentAssetIds: [] }] };
    usePetStoryStore.setState({ project }); useTaskStore.setState({ tasks: [video], executingTasks: {}, accountAutomationState: {} });
    const view = render(<App />); await act(async (): Promise<void> => undefined); const host = view.container.querySelector('.browser-host')!;
    for (const status of ['executing', 'generating', 'manual_submission_observing'] as const) {
      act((): void => { useTaskStore.setState({ tasks: [{ ...video, status }], executingTasks: { [project.accountId]: video.id }, accountAutomationState: { [project.accountId]: status === 'executing' ? 'injecting' : 'generating' } }); });
      expect(host.classList.contains('is-parked')).toBe(true); expect(host.classList.contains('is-background-executing')).toBe(true);
      expect(host.hasAttribute('inert')).toBe(false); expect(screen.getByRole('button', { name: /豆包 Chat/ }).getAttribute('aria-pressed')).toBe('false');
    }
    act((): void => { window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: video.id } })); });
    expect(host.classList.contains('is-parked')).toBe(true);
    act((): void => { useTaskStore.setState({ tasks: [{ ...video, status: 'waiting_verification' }], executingTasks: {}, accountAutomationState: { [project.accountId]: 'idle' } }); });
    expect(host.classList.contains('is-parked')).toBe(true); expect(host.classList.contains('is-background-executing')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /豆包 Chat/ })); expect(host.classList.contains('is-assist')).toBe(true);
    expect(lifetime.mounted).toBe(1); expect(lifetime.unmounted).toBe(0);
  });
});
