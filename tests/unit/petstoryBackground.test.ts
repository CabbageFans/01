/** 后台图片宿主的纯状态投影；使用原故事快照，不发送平台请求或写入项目。 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { PetStoryChatJob, PetStoryImageOperation, PetStoryPlan, PetStoryProject, Task } from '@doubao-studio/contracts';
import { hasBackgroundImageExecution, hasForegroundAccountInteraction, isBackgroundImageOperationTask } from '../../src/utils/petstoryBackground';
import snapshot from '../fixtures/storyboard-five-shots.json';

const now = '2026-10-30T07:00:00.000Z';
let project: PetStoryProject;
let operation: PetStoryImageOperation;
function task(id: string, status: Task['status'] = 'executing', accountId: string = project.accountId, mode: Task['mode'] = 'image'): Task {
  return { id, projectId: project.studioProjectId, assignedAccountId: accountId, mode, status, prompt: 'TEST 正式执行输入替身', outputs: [], result: null, createdAt: now, updatedAt: now };
}
function job(id: string, kind: PetStoryChatJob['kind'], taskId: string, parentJobId?: string): PetStoryChatJob {
  return { id, taskId, kind, parentJobId, materialId: operation.target.materialId, inputHash: 'TEST-basis', sourceUrl: '', status: 'bound', createdAt: now };
}
beforeEach((): void => {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  operation = { id: 'TEST-current-operation', requestId: 'TEST-selected-click', mode: 'generate', stage: 'preparing',
    target: { materialId: `character:${plan.characters[0].id}` }, basisHash: 'TEST-basis', createdAt: now,
    chatJobId: 'TEST-root-chat', taskId: 'TEST-current-image-task' };
  project = { schemaVersion: 1, id: 'TEST-image-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-original-story', text: snapshot.mobileStory, importedAt: now },
    plan, assets: [], jobs: [], imageOperations: [operation], updatedAt: now };
  project.jobs = [job('TEST-root-chat', 'materialPrompt', 'TEST-root-chat-task'),
    job('TEST-repair', 'repair', 'TEST-repair-task', 'TEST-root-chat'),
    job('TEST-later-repair', 'repair', 'TEST-later-repair-task', 'TEST-repair'),
    job('TEST-unrelated-chat', 'materialPrompt', 'TEST-unrelated-chat-task'),
    job('TEST-unrelated-repair', 'repair', 'TEST-unrelated-repair-task', 'TEST-unrelated-chat')];
});

describe('图片后台执行的目标归属', (): void => {
  it.each(['TEST-root-chat-task', 'TEST-repair-task', 'TEST-later-repair-task', 'TEST-current-image-task'])('识别本次操作所属的 %s，不要求强制复用原会话', (taskId: string): void => {
    expect(isBackgroundImageOperationTask(project, taskId)).toBe(true);
  });
  it('同素材其他文字请求及其修订不因目标相同而获得后台归属', (): void => {
    expect(isBackgroundImageOperationTask(project, 'TEST-unrelated-chat-task')).toBe(false);
    expect(isBackgroundImageOperationTask(project, 'TEST-unrelated-repair-task')).toBe(false);
    expect(isBackgroundImageOperationTask(project, 'TEST-free-chat')).toBe(false);
    expect(isBackgroundImageOperationTask(null, 'TEST-current-image-task')).toBe(false);
    expect(isBackgroundImageOperationTask(project, undefined)).toBe(false);
  });
  it('已完成操作不继续把历史文字、修订或图片任务当作后台执行', (): void => {
    operation.stage = 'complete';
    for (const taskId of ['TEST-root-chat-task', 'TEST-repair-task', 'TEST-current-image-task']) expect(isBackgroundImageOperationTask(project, taskId)).toBe(false);
  });
});

describe('注入或提交期间的前台账号识别', (): void => {
  it.each(['injecting', 'submitting'])('调度映射尚未重建时，从执行任务回读识别后台图片（%s）', (state: string): void => {
    const tasks = [task('TEST-current-image-task')];
    expect(hasForegroundAccountInteraction(project, tasks, { [project.accountId]: state }, {})).toBe(false);
    expect(hasForegroundAccountInteraction(project, tasks, { [project.accountId]: state }, { [project.accountId]: tasks[0].id })).toBe(false);
  });
  it('同一图片操作的文字准备和结构修订同样不自动展开浏览器', (): void => {
    for (const taskId of ['TEST-root-chat-task', 'TEST-repair-task']) {
      expect(hasForegroundAccountInteraction(project, [task(taskId, 'executing', project.accountId, 'chat')], { [project.accountId]: 'submitting' }, {})).toBe(false);
    }
  });
  it('另一账号或无关任务的交互仍是前台，不被后台图片遮蔽', (): void => {
    const otherAccount = 'TEST-other-account';
    const tasks = [task('TEST-current-image-task'), task('TEST-foreground-task', 'executing', otherAccount, 'chat')];
    expect(hasForegroundAccountInteraction(project, tasks, { [project.accountId]: 'injecting', [otherAccount]: 'submitting' }, {})).toBe(true);
    expect(hasForegroundAccountInteraction(project, [task('TEST-unrelated-chat-task', 'executing', project.accountId, 'chat')], { [project.accountId]: 'injecting' }, {})).toBe(true);
    expect(hasForegroundAccountInteraction(project, [], { [project.accountId]: 'submitting' }, {})).toBe(true);
  });
  it('生成、空闲和完成状态不冒充输入交互', (): void => {
    expect(hasForegroundAccountInteraction(project, [task('TEST-current-image-task', 'generating')], { [project.accountId]: 'generating', 'TEST-other-account': 'idle' }, {})).toBe(false);
    expect(hasForegroundAccountInteraction(project, [], { [project.accountId]: 'completed' }, {})).toBe(false);
  });
});

describe('图片宿主在真实操作生命周期中保持执行状态', (): void => {
  it.each(['preparing', 'generating', 'saving'] as const)('本会话实际授权的 %s 阶段在任务间隙也维持同一宿主', (stage): void => {
    operation.stage = stage;
    expect(hasBackgroundImageExecution(project, [], operation.id)).toBe(true);
    expect(hasBackgroundImageExecution(project, [], null)).toBe(false);
    expect(hasBackgroundImageExecution(project, [], 'TEST-other-operation')).toBe(false);
  });
  it.each(['executing', 'generating', 'manual_submission_observing'] as const)('映射未恢复但实际图片任务 %s 时仍维持宿主', (status): void => {
    operation.stage = 'generating';
    expect(hasBackgroundImageExecution(project, [task(operation.taskId!, status)], null)).toBe(true);
  });
  it('完成、失败、暂停和无关活动任务不延长后台图片执行', (): void => {
    for (const stage of ['complete', 'failed'] as const) {
      operation.stage = stage; expect(hasBackgroundImageExecution(project, [], operation.id)).toBe(false);
    }
    operation.stage = 'generating';
    for (const status of ['paused', 'cancelled', 'done', 'queued'] as const) expect(hasBackgroundImageExecution(project, [task(operation.taskId!, status)], null)).toBe(false);
    expect(hasBackgroundImageExecution(project, [task('TEST-unrelated-image', 'generating')], null)).toBe(false);
    expect(hasBackgroundImageExecution(null, [task('TEST-current-image-task', 'generating')], operation.id)).toBe(false);
    operation.stage = 'complete'; expect(hasBackgroundImageExecution(project, [task(operation.taskId!, 'generating')], null)).toBe(false);
  });
});
