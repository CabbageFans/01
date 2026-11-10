import { describe, expect, it } from 'vitest';
import type { Task, TaskLocalMediaUpdate, VideoInputSnapshot } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { TaskRepository } from '../../main/core/TaskRepository';
import { TaskEventStream } from '../../main/core/TaskEventStream';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';

const now = '2026-11-10T00:00:00.000Z';
function fixture() {
  const snapshot: VideoInputSnapshot = { schemaVersion: 1, inputVersion: 2, projectId: 'project', shotId: 'shot', stepId: 'step', accountId: 'account',
    prompt: '测试镜头', sourceText: '测试剧情', dialogue: '', mode: 'first_frame', references: [], digest: 'd'.repeat(64),
    videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' } };
  const initial: Task = { id: 'task', revision: 0, prompt: snapshot.prompt, mode: 'video', assignedAccountId: 'account', status: 'done',
    outputs: ['https://fixture.invalid/original.mp4'], result: null, createdAt: now, updatedAt: now,
    artifacts: [{ id: 'artifact', runId: 'run', kind: 'video', source: 'network', url: 'https://fixture.invalid/original.mp4', discoveredAt: now }],
    runtime: { runId: 'run', attempt: 1, stage: 'completed', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
      input: { prompt: snapshot.prompt, mode: 'video', attachments: [], videoInputSnapshot: snapshot } } };
  let json = JSON.stringify([initial]); let writable = true;
  const events = new TaskEventStream();
  const repository = new TaskRepository({ read: (): unknown => JSON.parse(json), write: (_file: string, data: Task[]): boolean => { if (!writable) return false; json = JSON.stringify(data); return true; },
    normalize: normalizeTasks, defaultProjectId: (): string => 'project', events });
  const createService = (): TaskService => new TaskService({ store: repository, defaultProjectId: (): string => 'project', now: (): string => now });
  const service = createService();
  const current = (): Task => repository.read()[0];
  const base: TaskLocalMediaUpdate = { operationId: 'media:run:artifact', artifactId: 'artifact', inputVersion: 2, inputDigest: snapshot.digest, phase: 'downloading', state: 'working' };
  const update = (patch: Partial<TaskLocalMediaUpdate> = {}): ReturnType<TaskService['updateLocalMedia']> => service.updateLocalMedia('task', 'run', { ...base, expectedRevision: current().revision, ...patch });
  return { service, createService, repository, current, update, events, base, setWritable: (value: boolean): void => { writable = value; } };
}

describe('原视频运行拥有本地媒体处理阶段', (): void => {
  it('下载→文件已保存→校验→入库→ready沿同一权威运行递增，旧阶段回执不得回退', (): void => {
    const test = fixture();
    expect(test.update().success).toBe(true);
    expect(test.service.delete('task').success).toBe(false);
    expect(test.update({ phase: 'downloaded', downloadJobId: 'download' }).success).toBe(true);
    expect(test.update({ phase: 'validating' }).success).toBe(true);
    expect(test.update({ phase: 'library', assetId: 'asset', sha256: 'a'.repeat(64), mediaInfo: {
      decoded: true, sha256: 'a'.repeat(64), bytes: 1024, width: 1280, height: 720, durationSeconds: 5, checkedAt: now,
    } }).success).toBe(true);
    expect(test.update({ phase: 'ready', state: 'ready' }).success).toBe(true);
    const ready = test.current();
    expect(ready).toMatchObject({ status: 'done', runtime: { runId: 'run', localMedia: { phase: 'ready', state: 'ready', downloadJobId: 'download', assetId: 'asset', sha256: 'a'.repeat(64), mediaInfo: { decoded: true } } } });
    expect(test.update({ phase: 'downloading' }).success).toBe(false);
    expect(test.current()).toEqual(ready);
    expect(test.events.after().filter((event): boolean => event.eventType === 'task.local_media_changed')).toHaveLength(5);
    expect(test.service.delete('task').success).toBe(true);
  });

  it('暂停/结束更新版本后，旧网络或工具回执零写入', (): void => {
    const test = fixture(); expect(test.update().success).toBe(true); const beforePause = test.current();
    expect(test.update({ phase: 'downloading', state: 'paused' }).success).toBe(true);
    const paused = test.current();
    expect(test.service.updateLocalMedia('task', 'run', { ...test.base, expectedRevision: beforePause.revision, phase: 'downloaded', downloadJobId: 'late' }).success).toBe(false);
    expect(test.current()).toEqual(paused);
    expect(test.update({ phase: 'downloading', state: 'failed', error: { code: 'late_network', message: '迟到网络失败' } }).success).toBe(false);
    expect(test.current()).toEqual(paused);
    expect(test.update({ phase: 'validating', state: 'working' }).success).toBe(false);
    expect(test.update({ phase: 'downloading', state: 'working' }).success).toBe(true);
  });

  it('重启把未完成本地工作标为原阶段paused，恢复只继续校验且不撤销平台完成', (): void => {
    const test = fixture(); expect(test.update({ phase: 'validating', downloadJobId: 'download' }).success).toBe(true);
    const restarted = test.createService();
    expect(restarted.recoverInterruptedTasks().success).toBe(true);
    expect(test.current()).toMatchObject({ status: 'done', runtime: { submittedAt: now, runId: 'run', localMedia: {
      phase: 'validating', state: 'paused', downloadJobId: 'download', error: { code: 'local_media_interrupted' },
    } } });
    expect(test.update({ phase: 'validating', state: 'working' }).success).toBe(true);
    expect(test.current().runtime!.localMedia!.phase).toBe('validating');
  });

  it('旧run/错产物/错输入版本以及裸runtime字段均不能伪造媒体回执', (): void => {
    const test = fixture(); const before = test.current();
    expect(test.service.updateLocalMedia('task', 'old-run', test.base).success).toBe(false);
    expect(test.update({ artifactId: 'other-artifact' }).success).toBe(false);
    expect(test.update({ inputVersion: 1 }).success).toBe(false);
    expect(test.service.updateRuntime({ taskId: 'task', expectedRunId: 'run', runtime: { localMedia: { ...test.base, updatedAt: now } } }).success).toBe(false);
    expect(test.current()).toEqual(before);
  });

  it('关键落盘失败不能推进阶段或发布成功事件', (): void => {
    const test = fixture(); expect(test.update().success).toBe(true); const before = test.current(); const count = test.events.after().length;
    test.setWritable(false);
    expect(test.update({ phase: 'downloaded', downloadJobId: 'download' }).success).toBe(false);
    expect(test.current()).toEqual(before); expect(test.events.after()).toHaveLength(count);
  });
});
