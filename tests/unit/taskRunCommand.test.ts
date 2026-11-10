import { expect, it } from 'vitest';
import type { Task } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { TaskRepository } from '../../main/core/TaskRepository';
import { TaskEventStream } from '../../main/core/TaskEventStream';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';
import { matchesTaskRunCommand } from '../../src/automation/taskDispatchGuards';

it('旧停止事件和无身份停止事件不能撤销当前运行；原运行命令才可保存暂停', (): void => {
  let data: Task[] = [];
  const repository = new TaskRepository({ read: (): Task[] => structuredClone(data), write: (_file: string, next: Task[]): boolean => { data = structuredClone(next); return true; },
    normalize: normalizeTasks, events: new TaskEventStream(), defaultProjectId: (): string => 'TEST-project' });
  const core = new TaskService({ store: repository, defaultProjectId: (): string => 'TEST-project', id: (): string => 'TEST-task' });
  const created = core.create({ mode: 'video', prompts: ['TEST-shot'], executionIntent: 'armed' });
  if (!created.success) throw new Error(created.error);
  expect(matchesTaskRunCommand(created.data[0], { taskId: 'TEST-task' })).toBe(true);
  const at = '2026-11-10T00:00:00.000Z';
  expect(core.updateRuntime({ taskId: 'TEST-task', status: 'executing', runtime: { runId: 'TEST-current-run', attempt: 2, stage: 'preparing_account', message: '',
    startedAt: at, stageStartedAt: at, lastHeartbeatAt: at, input: { mode: 'video', prompt: 'TEST-shot', attachments: [] } } }).success).toBe(true);
  const current = (): Task => { const result = core.getTasks(); if (!result.success) throw new Error(result.error); return result.data[0]; };
  const before = current();
  for (const command of [{ taskId: 'TEST-task' }, { taskId: 'TEST-task', expectedRunId: 'TEST-old-run' }]) {
    expect(matchesTaskRunCommand(current(), command)).toBe(false);
  }
  expect(current()).toEqual(before);
  const command = { taskId: 'TEST-task', expectedRunId: 'TEST-current-run' };
  expect(matchesTaskRunCommand(current(), command)).toBe(true);
  expect(core.updateStatus({ ...command, status: 'paused' }).success).toBe(true);
  expect(current().status).toBe('paused');
});
