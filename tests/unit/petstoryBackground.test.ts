/** 后台图片宿主的纯状态投影；使用原故事快照，不发送平台请求或写入项目。 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { PetStoryChatJob, PetStoryImageOperation, PetStoryPlan, PetStoryProject, Task } from '@doubao-studio/contracts';
import { hasBackgroundImageExecution, hasBackgroundPetStoryExecution, hasForegroundAccountInteraction, isBackgroundCanvasPromptTask, isBackgroundImageOperationTask, isBackgroundPetStoryTask } from '../../src/utils/petstoryBackground';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { getTaskExecutionScope } from '../../src/utils/taskExecutionScope';

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
  it('独立素材执行槽仍识别为当前项目后台任务，不自动展开自由聊天页面', (): void => {
    const current = task('TEST-current-image-task');
    current.petstory = { projectId: project.id, stepId: 'TEST-step', imageOperationId: operation.id, materialId: operation.target.materialId! };
    const scope = getTaskExecutionScope(current);
    expect(hasForegroundAccountInteraction(project, [current], { [scope]: 'injecting' }, { [scope]: current.id })).toBe(false);
    expect(hasBackgroundPetStoryExecution(project, [current], operation.id)).toBe(true);
  });
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

describe('画布首尾帧沿图片操作使用既有后台宿主', (): void => {
  it.each(['firstFrame', 'lastFrame'] as const)('%s只授权精确关联的任务和文字准备，不隐藏同账号其他图像任务', (kind): void => {
    operation.target = { shotId: project.plan!.shots[0].id, kind };
    operation.stage = 'generating';
    const ownTask = task(operation.taskId!);
    expect(isBackgroundImageOperationTask(project, ownTask.id)).toBe(true);
    expect(isBackgroundPetStoryTask(project, ownTask.id)).toBe(true);
    expect(isBackgroundImageOperationTask(project, 'TEST-root-chat-task')).toBe(true);
    expect(isBackgroundImageOperationTask(project, 'TEST-repair-task')).toBe(true);
    expect(hasForegroundAccountInteraction(project, [ownTask], { [project.accountId]: 'injecting' }, {})).toBe(false);
    expect(hasForegroundAccountInteraction(project, [ownTask], { [project.accountId]: 'submitting' }, { [project.accountId]: ownTask.id })).toBe(false);
    for (const status of ['executing', 'generating', 'manual_submission_observing'] as const) {
      expect(hasBackgroundPetStoryExecution(project, [{ ...ownTask, status }], null)).toBe(true);
    }
    for (const mode of ['image', 'video', 'chat'] as const) {
      const freeTask = task(`TEST-free-${mode}`, 'executing', project.accountId, mode);
      expect(isBackgroundPetStoryTask(project, freeTask.id)).toBe(false);
      expect(hasForegroundAccountInteraction(project, [freeTask], { [project.accountId]: 'injecting' }, {})).toBe(true);
      expect(hasBackgroundPetStoryExecution(project, [freeTask], null)).toBe(false);
    }
  });
  it.each(['firstFrame', 'lastFrame'] as const)('%s任务尚未创建及保存间隙依靠原操作身份保留可交互宿主', (kind): void => {
    operation.target = { shotId: project.plan!.shots[0].id, kind };
    delete operation.taskId; delete operation.chatJobId;
    for (const stage of ['preparing', 'generating', 'saving'] as const) {
      operation.stage = stage;
      expect(hasBackgroundPetStoryExecution(project, [], operation.id)).toBe(true);
      expect(hasBackgroundPetStoryExecution(project, [], 'TEST-other-operation')).toBe(false);
    }
    for (const stage of ['complete', 'failed'] as const) {
      operation.stage = stage;
      expect(hasBackgroundPetStoryExecution(project, [], operation.id)).toBe(false);
    }
  });
  it('旧production步骤本身不被宽泛归为后台，必须接入明确图片操作', (): void => {
    const entry = { state: 'unknown' as const, reason: 'TEST 离线入口状态' };
    project.imageOperations = [];
    project.production = { phase: 'shots', target: { shotId: project.plan!.shots[0].id, kind: 'firstFrame' }, state: 'running', planHash: 'TEST', approvedAt: now,
      capability: { accountId: project.accountId, image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [] }, fallbacks: {}, shots: {}, message: 'TEST 原制作步骤',
      steps: [{ id: 'TEST-raw-step', kind: 'firstFrame', shotId: project.plan!.shots[0].id, taskId: 'TEST-raw-image', inputHash: 'TEST', attachmentAssetIds: [], status: 'bound' }] };
    const rawTask = { ...task('TEST-raw-image'), petstory: { projectId: project.id, stepId: 'TEST-raw-step' } };
    expect(isBackgroundPetStoryTask(project, rawTask.id)).toBe(false);
    expect(hasForegroundAccountInteraction(project, [rawTask], { [project.accountId]: 'submitting' }, {})).toBe(true);
    expect(hasBackgroundPetStoryExecution(project, [rawTask], null)).toBe(false);
  });
});

describe('画布文字后台权限沿正式请求关联扩展', (): void => {
  beforeEach((): void => {
    project.jobs.push({ ...job('TEST-canvas-root', 'optimize', 'TEST-canvas-task'), materialId: undefined,
      background: 'canvas', shotId: project.plan!.shots[0].id, promptKind: 'firstFrame' },
    { ...job('TEST-canvas-feedback', 'optimize', 'TEST-feedback-task'), materialId: undefined,
      background: 'canvas', shotId: project.plan!.shots[0].id, promptKind: 'firstFrame' },
    job('TEST-canvas-repair', 'repair', 'TEST-canvas-repair-task', 'TEST-canvas-root'));
  });
  it.each(['TEST-canvas-task', 'TEST-feedback-task', 'TEST-canvas-repair-task'])('批次、用户修改和必要修订 %s 使用同一后台宿主', (taskId: string): void => {
    expect(isBackgroundCanvasPromptTask(project, taskId)).toBe(true);
    expect(isBackgroundPetStoryTask(project, taskId)).toBe(true);
    expect(isBackgroundImageOperationTask(project, taskId)).toBe(false);
    expect(hasForegroundAccountInteraction(project, [task(taskId, 'executing', project.accountId, 'chat')], { [project.accountId]: 'injecting' }, {})).toBe(false);
    expect(hasBackgroundPetStoryExecution(project, [task(taskId, 'generating', project.accountId, 'chat')], null)).toBe(true);
  });
  it('相同账号、相同镜头和相同chat模式不能让无关请求成为后台任务', (): void => {
    project.jobs.push({ ...job('TEST-unmarked', 'optimize', 'TEST-unmarked-task'), shotId: project.plan!.shots[0].id, promptKind: 'firstFrame' });
    expect(isBackgroundCanvasPromptTask(project, 'TEST-unmarked-task')).toBe(false);
    expect(isBackgroundCanvasPromptTask(project, 'TEST-free-chat')).toBe(false);
    expect(hasBackgroundPetStoryExecution(project, [task('TEST-unmarked-task', 'executing', project.accountId, 'chat')], null)).toBe(false);
    expect(hasForegroundAccountInteraction(project, [task('TEST-unmarked-task', 'executing', project.accountId, 'chat')], { [project.accountId]: 'submitting' }, {})).toBe(true);
    const foreignTask = task('TEST-canvas-task', 'executing', 'TEST-foreign-account', 'chat');
    expect(hasForegroundAccountInteraction(project, [foreignTask], { 'TEST-foreign-account': 'injecting' }, {})).toBe(true);
    expect(hasBackgroundPetStoryExecution(project, [foreignTask], null)).toBe(false);
  });
  it('兼容已保存镜头批次及其修订，不把旧素材批次扩展成后台画布', (): void => {
    const root = project.jobs.find((item): boolean => item.id === 'TEST-canvas-root')!;
    delete root.background;
    project.promptBatch = { targets: [{ shotId: project.plan!.shots[0].id, kind: 'firstFrame' }], total: 1, completed: 0, status: 'paused', jobId: root.id };
    expect(isBackgroundCanvasPromptTask(project, root.taskId)).toBe(true);
    expect(isBackgroundCanvasPromptTask(project, 'TEST-canvas-repair-task')).toBe(true);
    project.promptBatch.targets = [{ materialId: operation.target.materialId! }];
    expect(isBackgroundCanvasPromptTask(project, root.taskId)).toBe(false);
  });
  it('循环父链和结束的任务不会制造永久执行状态', (): void => {
    project.jobs.push(job('TEST-cycle-one', 'repair', 'TEST-cycle-task', 'TEST-cycle-two'), job('TEST-cycle-two', 'repair', 'TEST-cycle-other-task', 'TEST-cycle-one'));
    expect(isBackgroundCanvasPromptTask(project, 'TEST-cycle-task')).toBe(false);
    for (const status of ['paused', 'waiting_verification', 'done', 'fail', 'cancelled'] as const) {
      expect(hasBackgroundPetStoryExecution(project, [task('TEST-canvas-task', status, project.accountId, 'chat')], null)).toBe(false);
    }
    expect(hasBackgroundPetStoryExecution(null, [task('TEST-canvas-task')], null)).toBe(false);
  });
});

describe('正式镜头视频沿制作台账维持后台宿主', (): void => {
  function productionVideo(): Task {
    const video = { ...task('TEST-production-video', 'executing', project.accountId, 'video'), petstory: { projectId: project.id, stepId: 'TEST-video-step' } };
    const entry = { state: 'unknown' as const, reason: 'TEST' };
    project.production = { phase: 'shots', target: { shotId: project.plan!.shots[0].id, kind: 'video' }, state: 'running', planHash: 'TEST-hash', approvedAt: now,
      capability: { accountId: project.accountId, image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [] },
      fallbacks: {}, shots: {}, message: 'TEST 正式视频', steps: [{ id: 'TEST-video-step', kind: 'video', shotId: project.plan!.shots[0].id,
        taskId: video.id, inputHash: 'TEST-hash', attachmentAssetIds: [], status: 'bound' }] };
    return video;
  }
  it.each(['executing', 'generating', 'manual_submission_observing'] as const)('正式视频%s保留平台视口，无需自动展开Chat', (status): void => {
    const video = { ...productionVideo(), status };
    expect(isBackgroundPetStoryTask(project, video.id, video)).toBe(true);
    expect(hasBackgroundPetStoryExecution(project, [video], null)).toBe(true);
    for (const state of ['injecting', 'submitting']) {
      expect(hasForegroundAccountInteraction(project, [video], { [project.accountId]: state }, { [project.accountId]: video.id })).toBe(false);
      expect(hasForegroundAccountInteraction(project, [video], { [project.accountId]: state }, {})).toBe(false);
    }
  });
  it('已归档步骤的原视频只读观察继续使用原账号宿主', (): void => {
    const video = productionVideo(); project.productionHistory = [project.production!]; project.production = undefined;
    expect(isBackgroundPetStoryTask(project, video.id, video)).toBe(true);
    expect(hasBackgroundPetStoryExecution(project, [{ ...video, status: 'manual_submission_observing' }], null)).toBe(true);
  });
  it.each(['account', 'studio', 'project', 'step', 'task', 'mode', 'capability-account', 'runtime-run'] as const)('不符的%s不能借正式步骤获得后台权限', (change): void => {
    const video = productionVideo();
    if (change === 'account') video.assignedAccountId = 'TEST-foreign-account';
    if (change === 'studio') video.projectId = 'TEST-foreign-studio';
    if (change === 'project') video.petstory!.projectId = 'TEST-foreign-project';
    if (change === 'step') video.petstory!.stepId = 'TEST-foreign-step';
    if (change === 'task') video.id = 'TEST-unrelated-video';
    if (change === 'mode') video.mode = 'chat';
    if (change === 'capability-account') project.production!.capability.accountId = 'TEST-foreign-account';
    if (change === 'runtime-run') project.production!.steps[0].runId = 'TEST-unknown-run';
    expect(isBackgroundPetStoryTask(project, video.id, video)).toBe(false);
    expect(hasBackgroundPetStoryExecution(project, [video], null)).toBe(false);
    expect(hasForegroundAccountInteraction(project, [video], { [video.assignedAccountId!]: 'injecting' }, {})).toBe(true);
  });
  it('自由视频和只有taskId没有真实任务快照的调用不能借用制作权限', (): void => {
    const video = productionVideo();
    expect(isBackgroundPetStoryTask(project, video.id)).toBe(false);
    delete video.petstory;
    expect(isBackgroundPetStoryTask(project, video.id, video)).toBe(false);
    expect(hasBackgroundPetStoryExecution(project, [video], null)).toBe(false);
  });
  it('调度映射缺失时旧视频只读观察不能遮蔽同账号的新自由视频注入', (): void => {
    const original = { ...productionVideo(), status: 'manual_submission_observing' as const };
    const free = task('TEST-unrelated-front-video', 'executing', project.accountId, 'video');
    expect(hasForegroundAccountInteraction(project, [original, free], { [project.accountId]: 'injecting' }, {})).toBe(true);
  });
  it('明确重发前的原运行仅按保存的task/run/submittedAt获得只读后台观察归属', (): void => {
    const video = productionVideo(); const step = project.production!.steps[0]; step.taskId = 'TEST-replacement-video';
    step.resubmissionHistory = [{ taskId: video.id, runId: 'TEST-original-run', submittedAt: now, authorizedAt: now, authorizationId: 'TEST-resubmit', inputHash: 'TEST', attachmentAssetIds: [] }];
    video.runtime = { runId: 'TEST-original-run', submittedAt: now, stage: 'manual_submission_observing', message: 'TEST', attempt: 1,
      startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { prompt: video.prompt, mode: 'video', attachments: [], petstory: video.petstory } };
    expect(isBackgroundPetStoryTask(project, video.id, video)).toBe(true);
    video.runtime.runId = 'TEST-foreign-run';
    expect(isBackgroundPetStoryTask(project, video.id, video)).toBe(false);
  });
  it('视频暂停、验证、失败和完成后释放后台宿主，保留正式归属', (): void => {
    const video = productionVideo();
    for (const status of ['paused', 'waiting_verification', 'fail', 'cancelled', 'done', 'queued'] as const) {
      expect(hasBackgroundPetStoryExecution(project, [{ ...video, status }], null)).toBe(false);
    }
  });
});
