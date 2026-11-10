import { describe, expect, it } from 'vitest';
import type { DownloadJob, Task, TaskArtifact } from '@doubao-studio/contracts';
import { downloadBelongsToArtifact } from '../../main/utils/downloadIdentity';
const startedAt = '2026-11-10T00:00:00.000Z';
const task: Task = { id: 'task', projectId: 'project', assignedAccountId: 'account', prompt: 'TEST', mode: 'video', status: 'done', outputs: ['https://fixture.test/shared'], result: null, createdAt: startedAt, updatedAt: startedAt,
  runtime: { runId: 'current', attempt: 2, stage: 'completed', message: 'TEST', startedAt, stageStartedAt: startedAt, lastHeartbeatAt: startedAt, input: { prompt: 'TEST', mode: 'video', attachments: [] } } };
const artifact: TaskArtifact = { id: 'artifact', kind: 'video', source: 'network', url: task.outputs[0], runId: 'current', discoveredAt: startedAt };
const job: DownloadJob = { id: 'download', taskId: 'task', accountId: 'account', mode: 'video', url: artifact.url, status: 'done', attempts: 1, saveDir: '', filePath: '', createdAt: startedAt, updatedAt: startedAt };
describe('原下载与产物身份', (): void => {
  it('签名URL可刷新，显式run/artifact仍属于原媒体', (): void => { expect(downloadBelongsToArtifact({ ...job, runId: 'current', artifactId: 'artifact', url: 'https://fixture.test/old-signature' }, task, artifact, 'account')).toBe(true); });
  it('相同URL不能借用显式旧run或旧artifact', (): void => {
    expect(downloadBelongsToArtifact({ ...job, runId: 'old', artifactId: 'artifact' }, task, artifact, 'account')).toBe(false);
    expect(downloadBelongsToArtifact({ ...job, runId: 'current', artifactId: 'old-artifact' }, task, artifact, 'account')).toBe(false);
  });
  it('旧字段兼容只接受当前运行开始后的精确原URL记录', (): void => {
    expect(downloadBelongsToArtifact(job, task, artifact, 'account')).toBe(true);
    expect(downloadBelongsToArtifact({ ...job, createdAt: '2026-11-09T23:59:00.000Z' }, task, artifact, 'account')).toBe(false);
    expect(downloadBelongsToArtifact({ ...job, url: 'https://fixture.test/other' }, task, artifact, 'account')).toBe(false);
  });
});
