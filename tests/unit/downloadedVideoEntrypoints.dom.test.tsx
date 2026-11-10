/** 桌面视频入口只使用已登记本地job，DOM测试不代替真实Chromium解码验收。 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadJob, Task } from '@doubao-studio/contracts';
import { DownloadQueueModal } from '../../src/components/DownloadQueueModal';
import { ArtifactCenterModal } from '../../src/components/ArtifactCenterModal';
import { OutputPreviewModal, type OutputItem } from '../../src/components/OutputPreviewModal';
import { DownloadedVideoPreview } from '../../src/components/DownloadedVideoPreview';
import { projectDownloadJobs } from '../../src/utils/localDownloads';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useProjectStore } from '../../src/store/useProjectStore';

const original = { tasks: useTaskStore.getState(), projects: useProjectStore.getState() };
const now = '2026-11-10T00:00:00.000Z'; const localUrl = `doubao-media://asset/${'a'.repeat(64)}`;
const job: DownloadJob = { id: 'TEST-download', taskId: 'TEST-task', projectId: 'TEST-project', runId: 'TEST-run', artifactId: 'TEST-artifact', accountId: 'TEST-account', mode: 'video', url: 'https://expired.test/video.mp4', status: 'done', attempts: 1, saveDir: '/TEST', filePath: '/TEST/video.mp4', bytes: 100, createdAt: now, updatedAt: now };
const read = vi.fn(); const download = vi.fn();
beforeEach((): void => {
  read.mockReset().mockResolvedValue({ success: true, data: localUrl, mimeType: 'video/mp4' }); download.mockReset();
  window.electronAPI = { tasks: { readDownloadedMedia: read, listDownloads: vi.fn(async (): Promise<DownloadJob[]> => [job]), downloadOutputs: download }, settings: { get: vi.fn(async (): Promise<object> => ({})) } } as unknown as typeof window.electronAPI;
  useTaskStore.setState({ ...original.tasks, tasks: [], loadTasks: vi.fn() }); useProjectStore.setState({ ...original.projects, activeProjectId: 'TEST-project' });
});
afterEach((): void => { useTaskStore.setState(original.tasks); useProjectStore.setState(original.projects); vi.restoreAllMocks(); });

describe('桌面已下载视频入口', (): void => {
  it('任务被清理后下载列表仍能本地查看，读取失败只重读原job', async (): Promise<void> => {
    read.mockResolvedValueOnce({ success: false, error: '本地文件暂不可读' });
    const retry = vi.fn(); render(<DownloadQueueModal embedded open jobs={[job]} loading={false} onClose={vi.fn()} onRefresh={vi.fn()} onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: '查看本地视频' })); expect((await screen.findByRole('alert')).textContent).toContain('本地文件暂不可读');
    fireEvent.click(screen.getByRole('button', { name: '重新读取' })); const player = await screen.findByLabelText('本地视频播放器'); expect(player.getAttribute('src')).toBe(localUrl);
    expect(read.mock.calls.map((args: unknown[]): unknown => args[0])).toEqual([job.id, job.id]); expect(download).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled(); expect(useTaskStore.getState().tasks).toEqual([]);
  });
  it('产物中心优先已下载job，即使远端地址标记过期仍可使用受控本地URL', async (): Promise<void> => {
    const task: Task = { id: job.taskId, projectId: 'TEST-project', assignedAccountId: job.accountId, mode: 'video', prompt: 'TEST 原输入', status: 'done', outputs: [job.url], result: null, createdAt: now, updatedAt: now,
      artifacts: [{ id: job.artifactId!, runId: job.runId, url: job.url, kind: 'video', source: 'page', discoveredAt: now, validation: { state: 'expired', checkedAt: now } }] };
    useTaskStore.setState({ tasks: [task] }); render(<ArtifactCenterModal embedded open onClose={vi.fn()} />);
    await screen.findByText('已下载 · 文件校验未检查'); fireEvent.click(screen.getByRole('button', { name: '查看产物' }));
    expect((await screen.findByLabelText('本地视频播放器')).getAttribute('src')).toBe(localUrl); expect(read).toHaveBeenCalledExactlyOnceWith(job.id); expect(download).not.toHaveBeenCalled();
  });
  it('批次产物预览选择已下载原run，不把远端URL直接交给video', async (): Promise<void> => {
    const onDownload = vi.fn(); render(<OutputPreviewModal open outputs={[{ taskId: job.taskId, projectId: 'TEST-project', batchId: 'TEST-batch', runId: job.runId, artifactIds: [job.artifactId!], prompt: 'TEST', outputs: [job.url], accountId: job.accountId, mode: 'video' }]} onClose={vi.fn()} onDownload={onDownload} />);
    fireEvent.click(screen.getByTitle('播放视频')); expect((await screen.findByLabelText('本地视频播放器')).getAttribute('src')).toBe(localUrl);
    expect(read).toHaveBeenCalledExactlyOnceWith(job.id); expect(onDownload).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
  });
  it('未下载视频给出明确下载动作，成功后只按新job读取本地文件', async (): Promise<void> => {
    vi.mocked(window.electronAPI.tasks.listDownloads).mockResolvedValueOnce([]).mockResolvedValueOnce([job]); const onDownload = vi.fn(async (selected: OutputItem[]): Promise<void> => { expect(selected).toHaveLength(1); });
    render(<OutputPreviewModal open outputs={[{ taskId: job.taskId, projectId: 'TEST-project', batchId: 'TEST-batch', runId: job.runId, prompt: 'TEST', outputs: [job.url], accountId: job.accountId, mode: 'video' }]} onClose={vi.fn()} onDownload={onDownload} />);
    fireEvent.click(screen.getByTitle('播放视频')); await screen.findByText('请先下载原视频，下载完成后即可本地播放。'); expect(document.querySelector('video')).toBeNull(); expect(read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '下载此视频' })); expect((await screen.findByLabelText('本地视频播放器')).getAttribute('src')).toBe(localUrl);
    expect(onDownload).toHaveBeenCalledOnce(); expect(onDownload.mock.calls[0][0][0]).toMatchObject({ taskId: job.taskId, runId: job.runId, outputs: [job.url] });
  });
  it('旧job读取晚到不能覆盖新选择的本地播放器', async (): Promise<void> => {
    let resolveOld!: (value: object) => void; read.mockImplementationOnce((): Promise<object> => new Promise((resolve): void => { resolveOld = resolve; }));
    const currentUrl = `doubao-media://asset/${'b'.repeat(64)}`; read.mockResolvedValueOnce({ success: true, data: currentUrl });
    const rendered = render(<DownloadedVideoPreview jobId="old" />); rendered.rerender(<DownloadedVideoPreview jobId="new" />);
    expect((await screen.findByLabelText('本地视频播放器')).getAttribute('src')).toBe(currentUrl); resolveOld({ success: true, data: localUrl });
    await waitFor((): void => expect(screen.getByLabelText('本地视频播放器').getAttribute('src')).toBe(currentUrl)); expect(download).not.toHaveBeenCalled();
  });
  it('明确项目下载保持项目隔离，任务清理后的未知历史记录仍可查看', (): void => {
    const unknown = { ...job, id: 'unknown-history', projectId: undefined }; const other = { ...job, id: 'other-project', projectId: 'other' };
    expect(projectDownloadJobs([job, unknown, other], [], 'TEST-project').map((item: DownloadJob): string => item.id)).toEqual([job.id, unknown.id]);
  });
});
