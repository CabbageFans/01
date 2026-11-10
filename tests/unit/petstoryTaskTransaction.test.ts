import fs from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { PetStoryChatJob, PetStoryProject, PetStoryTaskIntent, Task, TaskAddParams } from '@doubao-studio/contracts';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { commitPetStoryTaskIntent, reconcilePetStoryTaskIntents } from '../../main/utils/petstoryTaskTransaction';
import { TaskService } from '../../main/core/TaskService';
import { TaskRepository } from '../../main/core/TaskRepository';
import { TaskEventStream } from '../../main/core/TaskEventStream';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';

const directories: string[] = [];
afterEach(async (): Promise<void> => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

async function fixture(failAt: number, taskFailure: 'create' | 'assign' | undefined = undefined): Promise<{ projects: PetStoryProjects; project: PetStoryProject; tasks: { list: () => Task[]; create: (input: TaskAddParams, account: string) => Task }; intent: PetStoryTaskIntent }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-intent-')); directories.push(directory);
  let writes = 0;
  const projects = new PetStoryProjects(async (from, to): Promise<void> => { if (++writes === failAt) throw new Error('TEST project write injected'); await fs.rename(from, to); });
  const project = await projects.create(directory, 'TEST-studio', 'TEST-account');
  let taskWriteFailure = taskFailure;
  const repository = new TaskRepository({ read: (name, fallback): unknown => existsSync(path.join(directory, name)) ? JSON.parse(readFileSync(path.join(directory, name), 'utf8')) : fallback,
    write: (name, data): boolean => {
      if (taskWriteFailure && data.length > 0 && (taskWriteFailure === 'create' || data.some((task): boolean => task.assignedAccountId === project.accountId))) { taskWriteFailure = undefined; return false; }
      writeFileSync(path.join(directory, name), JSON.stringify(data)); return true;
    }, normalize: normalizeTasks, defaultProjectId: (): string => 'TEST-studio', events: new TaskEventStream() });
  const core = new TaskService({ store: repository, defaultProjectId: (): string => 'TEST-studio' });
  const tasks = { list: (): Task[] => repository.read(), create: (input: TaskAddParams, account: string): Task => {
    const result = core.create(input); if (!result.success) throw new Error(result.error);
    const assigned = core.assign({ taskId: result.data[0].id, accountId: account }); if (!assigned.success) throw new Error(assigned.error); return assigned.data;
  } };
  const prompt = 'TEST stable text'; const jobId = 'TEST-stable-job';
  const chatJob: PetStoryChatJob = { id: jobId, taskId: 'intent:TEST-stable-job', kind: 'analysis', status: 'bound', inputHash: createHash('sha256').update(prompt).digest('hex'), sourceUrl: '' };
  const intent: PetStoryTaskIntent = { operationId: 'chat:TEST-stable-job', targetId: jobId, kind: 'chat', input: { prompts: [prompt], mode: 'chat', executionIntent: 'hold', projectId: project.studioProjectId, petstoryChat: { projectId: project.id, jobId } }, accountId: project.accountId, createdAt: new Date().toISOString(), chatJob };
  return { projects, project, tasks, intent };
}
function bind(project: PetStoryProject, task: Task): void {
  const intent = project.taskIntents![0]; project.jobs.push({ ...intent.chatJob!, taskId: task.id });
}

describe('真实Repository与项目日志跨文件恢复', (): void => {
  it('意图写入失败时零任务；重试同一意图创建唯一hold并回填', async (): Promise<void> => {
    const { projects, project, tasks, intent } = await fixture(1);
    await expect(commitPetStoryTaskIntent(projects, tasks, project, intent, bind)).rejects.toThrow('injected'); expect(tasks.list()).toEqual([]);
    const saved = await projects.read(project.id);
    const result = await commitPetStoryTaskIntent(projects, tasks, saved, intent, bind);
    expect(result.project.jobs[0].taskId).toBe(result.task.id); expect(tasks.list()).toHaveLength(1); expect(result.task.runtime).toBeUndefined();
  });
  it('任务已存项目回填失败，重开只绑定唯一原任务；多次迁移不会重新提交或创建', async (): Promise<void> => {
    const { projects, project, tasks, intent } = await fixture(2);
    await expect(commitPetStoryTaskIntent(projects, tasks, project, intent, bind)).rejects.toThrow('injected');
    const original = tasks.list()[0]; expect(original.executionIntent).toBe('hold'); expect(original.runtime).toBeUndefined();
    const reopened = new PetStoryProjects(); let loaded = await reopened.open(projects.directory(project.id));
    loaded = await reconcilePetStoryTaskIntents(reopened, tasks, loaded);
    expect(loaded.jobs[0].taskId).toBe(original.id); expect(loaded.taskIntents?.[0].taskId).toBe(original.id);
    const again = await reconcilePetStoryTaskIntents(reopened, tasks, loaded); expect(again).toEqual(loaded); expect(tasks.list()).toHaveLength(1);
  });
  it.each(['create', 'assign'] as const)('任务%s写入失败后沿同意图补完唯一hold，项目与账号无孤儿绑定', async (phase): Promise<void> => {
    const { projects, project, tasks, intent } = await fixture(0, phase);
    await expect(commitPetStoryTaskIntent(projects, tasks, project, intent, bind)).rejects.toThrow('写入失败');
    const before = tasks.list(); expect(before.length).toBe(phase === 'assign' ? 1 : 0);
    const saved = await projects.read(project.id); expect(saved.taskIntents).toHaveLength(1); expect(saved.jobs).toEqual([]);
    const recovered = await commitPetStoryTaskIntent(projects, tasks, saved, intent, bind);
    expect(tasks.list()).toHaveLength(1); expect(recovered.task.assignedAccountId).toBe(project.accountId);
    if (before.length) expect(recovered.task.id).toBe(before[0].id);
    expect(recovered.project.jobs[0].taskId).toBe(recovered.task.id); expect(recovered.task.runtime).toBeUndefined();
  });

});
