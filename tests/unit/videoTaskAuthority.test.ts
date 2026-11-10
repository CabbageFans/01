import { describe, expect, it } from 'vitest';
import type { Task, TaskAddParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';

function task(): Task {
  return { id: 'video', revision: 4, prompt: '镜头正文', mode: 'video', status: 'generating', assignedAccountId: 'account',
    result: null, outputs: [], createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
    runtime: { runId: 'run-new', attempt: 2, stage: 'generating', message: '', startedAt: '2026-11-10T00:00:00.000Z',
      stageStartedAt: '2026-11-10T00:00:00.000Z', lastHeartbeatAt: '2026-11-10T00:00:00.000Z', input: { mode: 'video', prompt: '镜头正文', attachments: [] } } };
}

function fixture(initial: Task[]) {
  let stored = structuredClone(initial);
  const service = new TaskService({ store: { read: (): Task[] => structuredClone(stored), replace: (next: Task[]): boolean => { stored = structuredClone(next); return true; } },
    defaultProjectId: (): string => 'project', id: (): string => 'created', now: (): string => '2026-11-10T01:00:00.000Z' });
  return { service, stored: (): Task[] => stored };
}

describe('视频运行权威边界', (): void => {
  it('旧运行完成回执不能给新运行登记产物', (): void => {
    const { service, stored } = fixture([task()]); const before = stored();
    expect(service.updateStatus({ taskId: 'video', expectedRunId: 'run-old', status: 'done', outputs: ['https://fixture.invalid/old.mp4'] }).success).toBe(false);
    expect(stored()).toEqual(before);
  });

  it('媒体异步完成不能只凭 taskId 更新当前运行', (): void => {
    const { service, stored } = fixture([task()]);
    expect(service.updateStatus({ taskId: 'video', status: 'done', outputs: ['https://fixture.invalid/old.mp4'] }).success).toBe(false);
    expect(stored()[0].outputs).toEqual([]);
  });

  it('无原运行或版本的状态、错误、结果回执不得污染当前运行', (): void => {
    const { service, stored } = fixture([task()]); const before = stored();
    expect(service.updateStatus({ taskId: 'video', status: 'fail', result: '旧运行失败' }).success).toBe(false);
    expect(service.updateRuntime({ taskId: 'video', status: 'paused' }).success).toBe(false);
    expect(service.updateRuntime({ taskId: 'video', errorInfo: { code: 'late_failure', message: '旧错误', recoverable: true, detectedAt: '2026-11-10T01:00:00.000Z' } }).success).toBe(false);
    expect(service.updateRuntime({ taskId: 'video', result: '旧结果' }).success).toBe(false);
    expect(stored()).toEqual(before);
    expect(service.updateRuntime({ taskId: 'video', expectedRevision: 4, status: 'paused' }).success).toBe(true);
  });

  it('可核实旧运行的迟到产物只追加原历史，当前结果与运行不变', (): void => {
    const original = task(); original.runHistory = [{ runId: 'run-old', attempt: 1, startedAt: original.createdAt, outcome: 'done', finalStage: 'completed' }];
    const { service, stored } = fixture([original]);
    expect(service.updateStatus({ taskId: original.id, expectedRunId: 'run-old', status: 'done', outputs: ['https://fixture.invalid/late.mp4'] }).success).toBe(false);
    expect(stored()[0]).toMatchObject({ status: 'generating', outputs: [], runtime: { runId: 'run-new', attempt: 2 } });
    expect(stored()[0].artifacts).toMatchObject([{ runId: 'run-old', url: 'https://fixture.invalid/late.mp4' }]);
  });

  it('正式结束保留同一原运行的迟到产物历史，但不能重启或改成完成', (): void => {
    const original = task(); original.status = 'cancelled'; original.runtime!.stage = 'cancelled';
    original.runtime!.submittedAt = original.createdAt;
    const { service, stored } = fixture([original]);
    const late = service.updateStatus({ taskId: original.id, expectedRunId: 'run-new', status: 'done', outputs: ['https://fixture.invalid/late-ended.mp4'] });
    expect(late.success).toBe(false);
    expect(stored()[0]).toMatchObject({ status: 'cancelled', outputs: [], runtime: original.runtime });
    expect(stored()[0].artifacts).toMatchObject([{ runId: 'run-new', url: 'https://fixture.invalid/late-ended.mp4' }]);
    const before = structuredClone(stored());
    expect(service.updateStatus({ taskId: original.id, expectedRunId: 'run-new', status: 'done' }).success).toBe(false);
    expect(service.updateRuntime({ taskId: original.id, expectedRunId: 'run-new', status: 'manual_submission_observing', runtime: { stage: 'generating' } }).success).toBe(false);
    expect(stored()).toEqual(before);
  });

  it('终态不能被同运行迟到的执行阶段降级', (): void => {
    const initial = task(); initial.status = 'done'; initial.runtime!.stage = 'completed'; initial.outputs = ['https://fixture.invalid/video.mp4'];
    const { service, stored } = fixture([initial]);
    expect(service.updateRuntime({ taskId: initial.id, expectedRunId: 'run-new', status: 'executing', runtime: { stage: 'injecting_prompt' } }).success).toBe(false);
    expect(stored()[0].status).toBe('done');
  });

  it('制作任务重复创建复用同一项目步骤，冲突输入零写入', (): void => {
    const { service, stored } = fixture([]);
    const params: TaskAddParams = { prompts: ['镜头正文'], mode: 'video', petstory: { projectId: 'project', stepId: 'step' } };
    expect(service.create(params).success).toBe(true);
    expect(service.create(params).success).toBe(true);
    expect(stored()).toHaveLength(1);
    expect(service.create({ ...params, prompts: ['不同正文'] }).success).toBe(false);
    expect(stored()).toHaveLength(1);
  });

  it('意图保存不等于发送，确定未派发清除尝试时间且可以原任务重新准备', (): void => {
    const original = task(); original.status = 'executing'; original.runtime!.stage = 'submitting';
    const { service, stored } = fixture([original]);
    const submission = { schemaVersion: 1 as const, operationId: 'operation', runId: 'run-new', updatedAt: '2026-11-10T01:00:00.000Z' };
    expect(service.updateRuntime({ taskId: original.id, expectedRunId: 'run-new', runtime: { submission: { ...submission, state: 'intent_saved' } } }).success).toBe(true);
    expect(stored()[0].runtime!.submittedAt).toBeUndefined();
    expect(service.updateRuntime({ taskId: original.id, expectedRunId: 'run-new', runtime: {
      submittedAt: submission.updatedAt, submission: { ...submission, state: 'dispatch_unknown' },
    } }).success).toBe(true);
    expect(service.updateRuntime({ taskId: original.id, expectedRunId: 'run-new', status: 'paused', runtime: {
      stage: 'paused', submission: { ...submission, state: 'not_dispatched', reason: 'control_disappeared_before_click' },
    } }).success).toBe(true);
    expect(stored()[0].runtime!.submittedAt).toBeUndefined();
    expect(service.retry(original.id).success).toBe(true);
    expect(stored()[0].runtime!.runId).toBe('run-new');
  });

  it('未知派发跨重启保留观察责任，不能回到意图或自动重试', (): void => {
    const original = task(); original.runtime!.submittedAt = '2026-11-10T00:00:00.000Z';
    original.runtime!.submission = { schemaVersion: 1, operationId: 'operation', runId: 'run-new', state: 'dispatch_unknown', updatedAt: '2026-11-10T00:00:00.000Z' };
    const { service, stored } = fixture([original]);
    expect(service.recoverInterruptedTasks().success).toBe(true);
    expect(stored()[0]).toMatchObject({ status: 'paused', runtime: { runId: 'run-new', submission: { state: 'dispatch_unknown' } } });
    expect(service.retry(original.id).success).toBe(false);
    expect(service.updateRuntime({ taskId: original.id, expectedRunId: 'run-new', runtime: { submission: { ...original.runtime!.submission, state: 'intent_saved' } } }).success).toBe(false);
  });

  it('版本不匹配或暂停后的迟到执行回执零写入', (): void => {
    const original = task(); original.status = 'paused'; original.runtime!.stage = 'paused';
    const { service, stored } = fixture([original]); const before = stored();
    expect(service.updateRuntime({ taskId: original.id, expectedRunId: 'run-new', expectedRevision: 3, status: 'paused', runtime: { stage: 'paused' } }).success).toBe(false);
    expect(service.updateRuntime({ taskId: original.id, expectedRunId: 'run-new', status: 'generating', runtime: { stage: 'generating' } }).success).toBe(false);
    expect(stored()).toEqual(before);
  });

  it('运行输入不可被同运行草稿回执改写', (): void => {
    const original = task(); const { service, stored } = fixture([original]);
    expect(service.updateRuntime({ taskId: original.id, expectedRunId: 'run-new', runtime: {
      input: { ...original.runtime!.input, prompt: '迟到的旧草稿' },
    } }).success).toBe(false);
    expect(stored()[0].runtime!.input.prompt).toBe('镜头正文');
  });

  it('完成产物、Task终态、runtime阶段与历史在一次写入内收口，后续IPC失败不留半完成', (): void => {
    const original = task(); original.runHistory = [{ runId: 'run-new', attempt: 2, startedAt: original.createdAt }];
    let stored = [structuredClone(original)]; let writes = 0;
    const service = new TaskService({ store: { read: (): Task[] => structuredClone(stored), replace: (tasks: Task[]): boolean => {
      writes++; if (writes > 1) return false; stored = structuredClone(tasks); return true;
    } }, defaultProjectId: (): string => 'project', now: (): string => '2026-11-10T00:00:05.000Z' });
    expect(service.updateStatus({ taskId: original.id, expectedRunId: 'run-new', status: 'done', outputs: ['https://fixture.invalid/video.mp4'] }).success).toBe(true);
    expect(writes).toBe(1);
    expect(stored[0]).toMatchObject({ status: 'done', runtime: { stage: 'completed', runId: 'run-new' },
      runHistory: [{ runId: 'run-new', outcome: 'done', finalStage: 'completed', durationMs: 5000 }] });
    expect(stored[0].runtime!.phaseHistory?.at(-1)?.stage).toBe('completed');
    expect(service.updateRuntime({ taskId: original.id, expectedRunId: 'run-new', status: 'done', runtime: { stage: 'completed' } }).success).toBe(false);
    expect(stored[0]).toMatchObject({ status: 'done', outputs: ['https://fixture.invalid/video.mp4'], runtime: { stage: 'completed' } });
  });
});
