/** 离线管理界面回归；账号、下载和平台接口均为替身，不读取生产数据。 */
import React from 'react';
import { message } from 'antd';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountList } from '../../src/components/AccountList';
import { DownloadQueueModal } from '../../src/components/DownloadQueueModal';
import { ArtifactCenterModal } from '../../src/components/ArtifactCenterModal';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import type { Account, DownloadJob, Task } from '../../src/types';

const originals = { accounts: useAccountStore.getState(), tasks: useTaskStore.getState(), projects: useProjectStore.getState() };
const now = '2026-10-29T06:00:00.000Z';
function account(id: string): Account { return { id, name: id, platform: 'doubao', avatar: '', partition: `TEST-${id}`, status: 'idle', pinned: false, createdAt: now, updatedAt: now }; }
const job: DownloadJob = { id: 'TEST-download', taskId: 'TEST-private-task', accountId: 'TEST-first', mode: 'video', url: 'https://example.invalid/TEST-video.mp4', status: 'failed', filePath: '/TEST-private-directory/final-video.mp4', saveDir: '/TEST-private-directory', attempts: 1, error: 'TEST-download-error', createdAt: now, updatedAt: now };

beforeEach((): void => {
  window.electronAPI = { tasks: { listDownloads: vi.fn(async (): Promise<DownloadJob[]> => []) } } as unknown as typeof window.electronAPI;
  useAccountStore.setState({ ...originals.accounts, accounts: [account('TEST-first'), account('TEST-second')], selectedAccountId: 'TEST-first', error: null });
  useTaskStore.setState({ ...originals.tasks, tasks: [], accountAutomationState: {}, accountBusy: {} });
  useProjectStore.setState({ ...originals.projects, activeProjectId: 'TEST-project' });
});
afterEach((): void => { message.destroy(); useAccountStore.setState(originals.accounts); useTaskStore.setState(originals.tasks); useProjectStore.setState(originals.projects); vi.restoreAllMocks(); });

describe('管理界面的真实操作边界', (): void => {
  it('账号键盘切换同样遵守提交租约；释放后可切换，更多动作不抢占选中', async (): Promise<void> => {
    const select = vi.fn(); useAccountStore.setState({ selectAccount: select });
    useTaskStore.setState({ accountAutomationState: { 'TEST-first': 'submitting' } }); render(<AccountList />);
    fireEvent.keyDown(screen.getByRole('button', { name: '选择账号TEST-second' }), { key: 'Enter' }); expect(select).not.toHaveBeenCalled();
    await act(async (): Promise<void> => { useTaskStore.setState({ accountAutomationState: {} }); });
    fireEvent.keyDown(screen.getByRole('button', { name: '选择账号TEST-second' }), { key: ' ' }); expect(select).toHaveBeenCalledWith('TEST-second');
    select.mockClear(); fireEvent.click(screen.getByRole('button', { name: 'TEST-second更多操作' })); expect(select).not.toHaveBeenCalled();
  });
  it('下载失败只重新下载原记录，普通列表显示文件名，完整归属和路径留在诊断详情', (): void => {
    const retry = vi.fn(async (): Promise<void> => undefined);
    render(<DownloadQueueModal embedded open jobs={[job]} loading={false} onClose={vi.fn()} onRefresh={vi.fn()} onRetry={retry} />);
    expect(screen.getByText('final-video.mp4')).toBeDefined();
    const diagnostic = screen.getByText('/TEST-private-directory/final-video.mp4').closest('details'); expect(diagnostic?.open).toBe(false);
    expect(screen.getByText('TEST-private-task').closest('details')).toBe(diagnostic);
    fireEvent.click(screen.getByRole('button', { name: '重新下载' })); expect(retry).toHaveBeenCalledExactlyOnceWith(job);
    expect(screen.queryByRole('button', { name: /重新生成/ })).toBeNull();
  });
  it('产物列表不用系统请求充当标题，视频查看使用实际产物地址且不自动播放', async (): Promise<void> => {
    const task: Task = { id: 'TEST-task', projectId: 'TEST-project', assignedAccountId: 'TEST-first', prompt: 'TEST-private-system-request', mode: 'video', status: 'done', result: null, outputs: [job.url], artifacts: [{ id: 'TEST-artifact', url: job.url, kind: 'video', source: 'page', discoveredAt: now }], petstory: { projectId: 'TEST-short', stepId: 'TEST-step' }, createdAt: now, updatedAt: now };
    useTaskStore.setState({ tasks: [task] }); render(<ArtifactCenterModal open embedded onClose={vi.fn()} />);
    await waitFor((): void => expect(window.electronAPI.tasks.listDownloads).toHaveBeenCalled());
    expect(screen.queryByText('TEST-private-system-request')).toBeNull(); expect(screen.getByText('短剧视频产物')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '查看产物' }));
    const video = screen.getByRole('dialog', { name: '产物详情' }).querySelector('video'); expect(video?.getAttribute('src')).toBe(job.url); expect(video?.autoplay).toBe(false);
  });
});
