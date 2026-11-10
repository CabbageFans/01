import { describe, expect, it } from 'vitest';
import { TaskService } from '../../main/core/TaskService';
import { TaskRepository } from '../../main/core/TaskRepository';
import { TaskEventStream } from '../../main/core/TaskEventStream';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';
import type { Task } from '../../src/types';
import {
  completeAcceptedObservation,
  createAcceptedObservationBinding,
  hasPlatformAcceptance,
  renewObservationLease,
  shouldResumeAcceptedObservation,
} from '../../src/utils/acceptedObservation';

const acceptedAt = '2026-09-10T08:00:00.000Z';

function binding() {
  return createAcceptedObservationBinding({
    accountId: 'account-1', runId: 'run-1', conversationUrl: 'https://www.doubao.com/chat/one',
    acceptedAt, ownerId: 'observer-run-1', mode: 'video', generationStartedAt: 123,
    evidence: { generationStarted: true, inputCleared: true, messageCount: 7, promptPublished: true },
  });
}

function task(status: Task['status'], acceptanceObservation = binding()): Task {
  return {
    id: 'task-1', prompt: 'secret prompt', assignedAccountId: 'account-1', status, mode: 'video',
    result: null, outputs: [], createdAt: acceptedAt, updatedAt: acceptedAt,
    runtime: {
      runId: 'run-1', attempt: 1, stage: 'generating', message: 'observing', startedAt: acceptedAt,
      stageStartedAt: acceptedAt, lastHeartbeatAt: acceptedAt,
      conversationUrl: acceptanceObservation?.conversationUrl, acceptanceObservation,
      input: { prompt: 'secret prompt', mode: 'video', attachments: ['D:/secret/image.png'] },
    },
  };
}

describe('accepted observation', () => {
  it('只保留受理观察所需的脱敏字段', () => {
    const value = binding();
    expect(value).toMatchObject({
      schemaVersion: 1, accountId: 'account-1', runId: 'run-1', outcome: 'observing',
      evidence: { kind: 'generation_started', messageCount: 7, generationStartedAt: 123 },
      cursor: { messageCount: 7, generationStartedAt: 123, pollCount: 0 },
      expectedArtifact: { kind: 'video', runId: 'run-1' },
    });
    expect(JSON.stringify(value)).not.toContain('secret prompt');
    expect(JSON.stringify(value)).not.toContain('secret/image');
  });

  it.each([
    ['material authorization', true, 'material_authorization_confirmed'],
    ['prompt published', false, 'prompt_published'],
  ] as const)('%s 生成正确证据类型', (_label, materialAuthorizationConfirmed, kind) => {
    const value = createAcceptedObservationBinding({
      accountId: 'a', runId: 'r', conversationUrl: 'https://www.doubao.com/chat/r', acceptedAt,
      ownerId: 'o', mode: 'chat', materialAuthorizationConfirmed,
      evidence: { generationStarted: false, inputCleared: true, messageCount: 1, promptPublished: true },
    });
    expect(value.evidence.kind).toBe(kind);
    expect(value.expectedArtifact.kind).toBe('file');
  });

  it('只有同一 run 的 observing 绑定或历史 done 满足平台受理', () => {
    expect(hasPlatformAcceptance(task('generating'))).toBe(true);
    expect(hasPlatformAcceptance(task('done', undefined as never))).toBe(true);
    const mismatch = binding(); mismatch.runId = 'old-run';
    expect(hasPlatformAcceptance(task('generating', mismatch))).toBe(false);
    const completed = binding(); completed.outcome = 'completed';
    expect(hasPlatformAcceptance(task('generating', completed))).toBe(false);
  });

  it('acceptance binding 必须使用具体会话且与 runtime 会话同步', () => {
    const value = task('generating');
    value.runtime!.conversationUrl = 'https://www.doubao.com/chat/other';
    expect(hasPlatformAcceptance(value)).toBe(false);
    value.runtime!.conversationUrl = 'https://www.doubao.com/chat/one';
    value.runtime!.acceptanceObservation!.conversationUrl = 'https://www.doubao.com/chat/';
    expect(hasPlatformAcceptance(value)).toBe(false);
    expect(() => createAcceptedObservationBinding({
      accountId: 'a', runId: 'r', conversationUrl: 'https://www.doubao.com/chat/', acceptedAt,
      ownerId: 'o', mode: 'video', evidence: { generationStarted: true, inputCleared: true, messageCount: 1, promptPublished: true },
    })).toThrow('具体的豆包会话 URL');
  });

  it('仅 generating + 有效受理绑定需要在重启后恢复观察', () => {
    expect(shouldResumeAcceptedObservation(task('generating'))).toBe(true);
    expect(shouldResumeAcceptedObservation(task('manual_submission_observing'))).toBe(false);
  });

  it('续租递增游标且完成时绑定稳定 artifact ID', () => {
    const renewed = renewObservationLease(binding(), '2026-09-10T08:00:15.000Z', 30_000);
    expect(renewed.cursor.pollCount).toBe(1);
    expect(renewed.lease.expiresAt).toBe('2026-09-10T08:00:45.000Z');
    const completed = completeAcceptedObservation(renewed, 'artifact-1', '2026-09-10T08:01:00.000Z');
    expect(completed).toMatchObject({ outcome: 'completed', completedAt: '2026-09-10T08:01:00.000Z', expectedArtifact: { artifactId: 'artifact-1' } });
  });
});

function pipelineFixture() {
  const original = task('executing');
  original.runtime!.acceptanceObservation = undefined; original.runtime!.submittedAt = acceptedAt;
  let json = JSON.stringify([original]); let writable = true;
  const events = new TaskEventStream();
  const repository = new TaskRepository({ read: (): unknown => JSON.parse(json), write: (_filename: string, value: Task[]): boolean => {
    if (!writable) return false; json = JSON.stringify(value); return true;
  }, normalize: (raw: unknown) => normalizeTasks(raw, 'project', acceptedAt), defaultProjectId: (): string => 'project', events });
  const service = new TaskService({ store: repository, defaultProjectId: (): string => 'project', now: (): string => acceptedAt });
  repository.read();
  return { service, repository, events, failWrites: (): void => { writable = false; } };
}

describe('accepted observation 正式持久化与恢复组合', (): void => {
  it('受理状态与原会话观察绑定在同一事务落盘，事件只在落盘后发布', (): void => {
    const { service, repository, events } = pipelineFixture();
    const recorded: Task[] = [];
    events.subscribe((): void => { recorded.push(repository.read()[0]); });
    const result = service.updateRuntime({ taskId: 'task-1', expectedRunId: 'run-1', status: 'generating',
      runtime: { stage: 'generating', acceptanceObservation: binding() } });
    expect(result.success).toBe(true);
    expect(recorded.length).toBeGreaterThan(0);
    for (const saved of recorded) expect(saved).toMatchObject({ status: 'generating', revision: 1,
      runtime: { runId: 'run-1', submittedAt: acceptedAt, conversationUrl: 'https://www.doubao.com/chat/one', acceptanceObservation: { outcome: 'observing', runId: 'run-1' } } });
  });

  it('受理保存失败不会发布运行事件，也不会假造平台完成', (): void => {
    const { service, repository, events, failWrites } = pipelineFixture(); failWrites();
    expect(service.updateRuntime({ taskId: 'task-1', expectedRunId: 'run-1', status: 'generating', runtime: { stage: 'generating', acceptanceObservation: binding() } }).success).toBe(false);
    expect(events.after()).toEqual([]);
    expect(repository.read()[0]).toMatchObject({ status: 'executing', runtime: { runId: 'run-1', submittedAt: acceptedAt } });
    expect(repository.read()[0].runtime!.acceptanceObservation).toBeUndefined();
  });

  it('重启只恢复原运行观察，拒绝重发并能按原运行完成产物', (): void => {
    const { service, repository } = pipelineFixture();
    expect(service.updateRuntime({ taskId: 'task-1', expectedRunId: 'run-1', status: 'generating', runtime: { stage: 'generating', acceptanceObservation: binding() } }).success).toBe(true);
    const restarted = new TaskService({ store: repository, defaultProjectId: (): string => 'project', now: (): string => acceptedAt });
    expect(restarted.recoverInterruptedTasks().success).toBe(true);
    const restored = repository.read()[0];
    expect(restored).toMatchObject({ status: 'manual_submission_observing', runtime: { runId: 'run-1', attempt: 1, submittedAt: acceptedAt, acceptanceObservation: { outcome: 'observing' } } });
    expect(restarted.retry('task-1').success).toBe(false);
    expect(restarted.updateStatus({ taskId: 'task-1', expectedRunId: 'run-1', status: 'done', outputs: ['https://fixture.invalid/original.mp4'] }).success).toBe(true);
    const completed = repository.read()[0];
    expect(completed.artifacts?.[0]).toMatchObject({ runId: 'run-1', url: 'https://fixture.invalid/original.mp4' });
    expect(completed.runtime!.acceptanceObservation).toMatchObject({ outcome: 'completed', expectedArtifact: { artifactId: completed.artifacts?.[0].id } });
  });
});
