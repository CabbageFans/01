/** 离线 DOM 点击只验证前端入口与并发保存；平台及持久化使用明确替身。 */
import React from 'react';
import { ConfigProvider } from 'antd';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryPlan, PetStoryProject } from '@doubao-studio/contracts';
import { PetStoryCreateProject } from '../../src/components/PetStoryCreateProject';
import { CanvasVideoSettings } from '../../src/components/PetStoryCanvasMedia';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

const original = { pet: usePetStoryStore.getState(), accounts: useAccountStore.getState(), projects: useProjectStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-10-28T00:00:00.000Z';
const account: Account = { id: 'TEST-account', name: 'TEST 豆包', platform: 'doubao', avatar: '', partition: 'TEST-isolated', status: 'idle', pinned: false, createdAt: now, updatedAt: now };
let p: PetStoryProject;
beforeEach((): void => {
  p = { schemaVersion: 1, id: 'TEST-settings', studioProjectId: 'TEST-studio', accountId: account.id, revision: 1, source: { kind: 'script', url: '', status: 'review_required' }, plan: structuredClone(snapshot.plan) as PetStoryPlan, assets: [], jobs: [], updatedAt: now };
  usePetStoryStore.setState({ ...original.pet, project: p, busy: false, error: '', fallbacks: {} });
  useAccountStore.setState({ ...original.accounts, accounts: [account], selectedAccountId: account.id, error: null });
  useProjectStore.setState({ ...original.projects, activeProjectId: p.studioProjectId, projects: [{ id: p.studioProjectId, name: 'TEST 关联项目', description: '', color: '#fff', archived: false, createdAt: now, updatedAt: now }] });
  useTaskStore.setState({ ...original.tasks, accountAutomationState: {} });
});
afterEach((): void => { usePetStoryStore.setState(original.pet); useAccountStore.setState(original.accounts); useProjectStore.setState(original.projects); useTaskStore.setState(original.tasks); vi.restoreAllMocks(); });

describe('新建入口沿用真实账号边界', (): void => {
  it('全局选择 Dola 时不允许用隐藏的 Dola 值创建短剧', (): void => {
    useAccountStore.setState({ accounts: [{ ...account, id: 'TEST-dola', platform: 'dola' }], selectedAccountId: 'TEST-dola' });
    const create = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ createProject: create });
    render(<PetStoryCreateProject />); fireEvent.click(screen.getByRole('button', { name: '新建短剧项目' }));
    const button = screen.getByRole('button', { name: '创建项目' });
    expect(button.hasAttribute('disabled')).toBe(true); fireEvent.click(button); expect(create).not.toHaveBeenCalled();
    expect(screen.getByText('暂无豆包账号，请先在账号管理中添加。')).toBeDefined();
  });
  it('全局选择 Dola 时自动选用豆包，创建不切换正在浏览的账号或项目', async (): Promise<void> => {
    const dola = { ...account, id: 'TEST-dola', platform: 'dola' as const };
    const selectAccount = vi.fn(); const selectProject = vi.fn();
    const create = vi.fn(async (): Promise<void> => undefined);
    useAccountStore.setState({ accounts: [dola, account], selectedAccountId: dola.id, selectAccount });
    useProjectStore.setState({ selectProject }); usePetStoryStore.setState({ createProject: create });
    useTaskStore.setState({ accountAutomationState: { 'TEST-other': 'submitting' } });
    render(<PetStoryCreateProject />); fireEvent.click(screen.getByRole('button', { name: '新建短剧项目' }));
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    await waitFor((): void => expect(create).toHaveBeenCalledWith({ accountId: account.id, studioProjectId: p.studioProjectId }));
    expect(selectAccount).not.toHaveBeenCalled(); expect(selectProject).not.toHaveBeenCalled();
    expect(useAccountStore.getState().selectedAccountId).toBe(dola.id);
  });
  it('所有任务归集项目已归档时不允许创建', (): void => {
    useProjectStore.setState({ projects: useProjectStore.getState().projects.map((project): typeof project => ({ ...project, archived: true })) });
    render(<PetStoryCreateProject />); fireEvent.click(screen.getByRole('button', { name: '新建短剧项目' }));
    expect(screen.getByRole('button', { name: '创建项目' }).hasAttribute('disabled')).toBe(true);
  });
  it('当前项目不可用时自动沿用默认归集项目，不要求选择关联项目', async (): Promise<void> => {
    const archived = { ...useProjectStore.getState().projects[0], archived: true };
    const fallback = { ...archived, id: 'default-project', archived: false };
    useProjectStore.setState({ projects: [archived, fallback] });
    const create = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ createProject: create });
    render(<PetStoryCreateProject />); fireEvent.click(screen.getByRole('button', { name: '新建短剧项目' }));
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    await waitFor((): void => expect(create).toHaveBeenCalledWith({ accountId: account.id, studioProjectId: fallback.id }));
    expect(useProjectStore.getState().activeProjectId).toBe(archived.id);
  });
  it('取消目录选择仅短暂提示，保留原项目并可再次创建', async (): Promise<void> => {
    const created = { ...p, id: 'TEST-created-project' }; const onCreated = vi.fn();
    const create = vi.fn(async (): Promise<void> => { usePetStoryStore.setState({ error: '已取消' }); });
    create.mockImplementationOnce(async (): Promise<void> => { usePetStoryStore.setState({ error: '已取消' }); });
    create.mockImplementationOnce(async (): Promise<void> => { usePetStoryStore.setState({ project: created, error: '' }); });
    usePetStoryStore.setState({ createProject: create });
    // happy-dom 不播放 CSS 退场动画；仅关闭动效，仍验证真实消息定时关闭。
    render(<ConfigProvider theme={{ token: { motion: false } }}><PetStoryCreateProject onCreated={onCreated} /></ConfigProvider>); fireEvent.click(screen.getByRole('button', { name: '新建短剧项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建短剧项目' });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建项目' }));
    await waitFor((): void => expect(screen.getByText('已取消')).toBeDefined());
    expect(within(dialog).queryByText('已取消')).toBeNull();
    expect(usePetStoryStore.getState().error).toBe(''); expect(usePetStoryStore.getState().project?.id).toBe(p.id);
    expect(onCreated).not.toHaveBeenCalled();
    await waitFor((): void => expect(screen.queryByText('已取消')).toBeNull(), { timeout: 3500 });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建项目' }));
    await waitFor((): void => expect(onCreated).toHaveBeenCalledOnce());
    expect(create).toHaveBeenNthCalledWith(2, { accountId: account.id, studioProjectId: p.studioProjectId });
    await waitFor((): void => expect(screen.queryByRole('dialog', { name: '新建短剧项目' })).toBeNull());
  });
  it('不带入其他操作错误，本次创建失败显示实际原因并允许重试', async (): Promise<void> => {
    useAccountStore.setState({ error: 'TEST 无关账号错误' });
    const create = vi.fn(async (): Promise<void> => { usePetStoryStore.setState({ error: 'TEST 目录非空' }); });
    usePetStoryStore.setState({ error: 'TEST 上次操作错误', createProject: create });
    render(<PetStoryCreateProject />); fireEvent.click(screen.getByRole('button', { name: '新建短剧项目' }));
    expect(screen.queryByText('TEST 无关账号错误')).toBeNull(); expect(screen.queryByText('TEST 上次操作错误')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    await waitFor((): void => expect(screen.getByText('TEST 目录非空')).toBeDefined());
    expect(screen.getByRole('button', { name: '创建项目' }).hasAttribute('disabled')).toBe(false);
  });
});

describe('镜头视频设置保护并发新结果', (): void => {
  function renderSettings(): ReturnType<typeof render> { return render(<CanvasVideoSettings project={p} shot={p.plan!.shots[0]} />); }
  function changeDuration(): number { const initial = p.plan!.shots[0].durationSeconds; const duration = initial === 8 ? 6 : 8; fireEvent.change(screen.getByRole('spinbutton', { name: '镜头1视频时长' }), { target: { value: String(duration) } }); return duration; }
  it('只改时长保留别处新保存模式与新正文', async (): Promise<void> => {
    const save = vi.fn(async (plan: PetStoryPlan): Promise<void> => { usePetStoryStore.setState({ project: { ...p, plan }, error: '' }); }); usePetStoryStore.setState({ savePlan: save });
    const view = renderSettings(); const duration = changeDuration();
    const latest = structuredClone(p); latest.revision++; latest.plan!.shots[0].requestedMode = p.plan!.shots[0].requestedMode === 'reference' ? 'first_frame' : 'reference'; latest.plan!.shots[0].prompts.video.final = 'TEST 并发新正文';
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: latest }); }); view.rerender(<CanvasVideoSettings project={latest} shot={latest.plan!.shots[0]} />);
    fireEvent.click(screen.getByRole('button', { name: '保存视频设置' }));
    await waitFor((): void => expect(save).toHaveBeenCalledOnce()); const saved = save.mock.calls[0][0];
    expect(saved.shots[0].durationSeconds).toBe(duration); expect(saved.shots[0].requestedMode).toBe(latest.plan!.shots[0].requestedMode); expect(saved.shots[0].prompts.video.final).toBe('TEST 并发新正文');
  });
  it('同一时长存在不同新值时保留草稿并拒绝覆盖', async (): Promise<void> => {
    const save = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ savePlan: save }); const view = renderSettings(); const duration = changeDuration();
    const latest = structuredClone(p); latest.revision++; latest.plan!.shots[0].durationSeconds = [5, 6, 7, 8, 9, 10].find((value): boolean => value !== duration && value !== p.plan!.shots[0].durationSeconds)!;
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: latest }); }); view.rerender(<CanvasVideoSettings project={latest} shot={latest.plan!.shots[0]} />);
    fireEvent.click(screen.getByRole('button', { name: '保存视频设置' }));
    await waitFor((): void => expect(screen.getByRole('status').textContent).toMatch(/已有新保存内容/)); expect(save).not.toHaveBeenCalled(); expect((screen.getByRole('spinbutton', { name: '镜头1视频时长' }) as HTMLInputElement).value).toBe(String(duration)); expect(screen.getByRole('button', { name: '放弃修改' })).toBeDefined();
  });
});
