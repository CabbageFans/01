/** 离线 DOM 点击只验证前端入口与并发保存；平台及持久化使用明确替身。 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    render(<PetStoryCreateProject />); fireEvent.click(screen.getByRole('button', { name: '新建萌宠短剧' }));
    const button = screen.getByRole('button', { name: '选择保存目录并创建' });
    expect(button.hasAttribute('disabled')).toBe(true); fireEvent.click(button); expect(create).not.toHaveBeenCalled();
    expect(screen.getByText('还没有选择可用的豆包执行账号；可在这里选择、添加，或前往登录后返回。')).toBeDefined();
  });
  it('其他账号配置／提交期间登录入口保留弹窗，不抢占前台租约', (): void => {
    const select = vi.fn(); const navigate = vi.fn(); window.addEventListener('navigate-workspace', navigate);
    useAccountStore.setState({ selectAccount: select }); useTaskStore.setState({ accountAutomationState: { 'TEST-other': 'submitting' } });
    render(<PetStoryCreateProject />); fireEvent.click(screen.getByRole('button', { name: '新建萌宠短剧' }));
    fireEvent.click(screen.getByRole('button', { name: '去登录／检查账号（返回后继续新建）' }));
    expect(select).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled(); expect(screen.getByRole('dialog', { name: '新建萌宠短剧' })).toBeDefined();
    window.removeEventListener('navigate-workspace', navigate);
  });
  it('关联项目已归档时选择保存目录不可用', (): void => {
    useProjectStore.setState({ projects: useProjectStore.getState().projects.map((project): typeof project => ({ ...project, archived: true })) });
    render(<PetStoryCreateProject />); fireEvent.click(screen.getByRole('button', { name: '新建萌宠短剧' }));
    expect(screen.getByRole('button', { name: '选择保存目录并创建' }).hasAttribute('disabled')).toBe(true);
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
    await waitFor((): void => expect(screen.getByRole('status').textContent).toMatch(/已有新保存内容/)); expect(save).not.toHaveBeenCalled(); expect((screen.getByRole('spinbutton', { name: '镜头1视频时长' }) as HTMLInputElement).value).toBe(String(duration)); expect(screen.getByRole('button', { name: '放弃本次修改' })).toBeDefined();
  });
});
