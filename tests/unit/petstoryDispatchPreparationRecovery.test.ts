import { currentRunId, localMediaPort } from '../fixtures/taskRunIdentity';
/** 派发前中止通过真实制作/任务服务恢复；全部文件均属于临时离线测试项目。 */
import fs from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryCapability, PetStoryPlan, PetStoryProject, Task, TaskAddParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { PetStoryProductionService } from '../../main/utils/petstoryProduction';
import { mediaCommand } from '../../main/utils/petstoryMedia';
import { seedOfflinePromptContracts } from '../fixtures/petstoryPromptContracts';

let root: string; let picture: string; let tasksFile: string;
let projects: PetStoryProjects; let service: PetStoryProductionService; let core: TaskService;
let project: PetStoryProject; let taskId: string;
let retry: ReturnType<typeof vi.fn>;

function listed(): Task[] { return JSON.parse(readFileSync(tasksFile, 'utf8')) as Task[]; }
function stored(items: Task[]): boolean { writeFileSync(tasksFile, JSON.stringify(items)); return true; }
function currentTask(): Task {
  const task = listed().find((item: Task): boolean => item.id === taskId);
  if (!task) throw new Error('TEST 原任务缺失');
  return task;
}
function capability(): PetStoryCapability {
  const supported = { state: 'supported' as const, reason: 'TEST 离线控件契约' };
  return { accountId: 'TEST-recovery-account', image: supported,
    modes: { first_frame: supported, first_last_frame: supported, reference: supported }, durations: [5],
    videoConfig: { model: 'seedance-2.0', aspectRatio: '9:16', duration: '5s' } };
}
function plan(): PetStoryPlan {
  const prompt = (kind: string): PetStoryPlan['shots'][number]['prompts']['video'] => ({
    original: `TEST ${kind}`, optimized: `TEST ${kind}`, final: `TEST ${kind} 完整正文`, edited: true, rulesVersion: 'petstory-r11-v1',
  });
  return { sourceSummary: 'TEST 剧本摘要', adaptedStory: 'TEST 完整改编剧情',
    characters: [{ id: 'actor', name: 'TEST角色', role: 'main', purpose: 'TEST剧情', description: 'TEST历史描述' }], props: [],
    scenes: [{ id: 'room', name: 'TEST房间', location: 'TEST地点', time: '白天', lighting: '自然光', layout: '门窗位置', view: '正面', designOrigin: 'script' }],
    shots: [{ id: 'TEST-recovery-shot', order: 1, characterIds: ['actor'], propIds: [], propStates: [], sceneId: 'room', scene: 'TEST房间',
      action: 'TEST动作', startState: 'TEST开始', endState: 'TEST结束', durationSeconds: 5, transition: 'cut', requestedMode: 'first_frame',
      prompts: { firstFrame: prompt('首帧'), video: prompt('视频') } }] };
}
function create(input: TaskAddParams, accountId: string): Task {
  const created = core.create(input); if (!created.success) throw new Error(created.error);
  const assigned = core.assign({ taskId: created.data[0].id, accountId });
  if (!assigned.success) throw new Error(assigned.error);
  return assigned.data;
}
function beginRun(runId: string, attempt: number): Task {
  const task = currentTask(); const now = new Date().toISOString();
  const result = core.updateRuntime({ taskId, expectedRunId: currentRunId(core, taskId), status: 'executing', runtime: {
    runId, attempt, stage: 'preparing_account', message: 'TEST 准备派发', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
    input: { prompt: task.prompt, mode: task.mode, attachments: task.attachments || [], videoConfig: task.videoConfig,
      petstory: task.petstory, promptReadback: task.promptReadback },
  } });
  if (!result.success) throw new Error(result.error);
  return result.data;
}
async function stopBeforeBinding(code: string = 'dispatch_not_ready'): Promise<Task> {
  beginRun('TEST-unbound-run', 1);
  const stopped = core.updateRuntime({ taskId, expectedRunId: currentRunId(core, taskId), status: 'paused', executionIntent: 'hold', errorInfo: {
    code, message: 'TEST 正式派发守卫在页面执行前拒绝', recoverable: true, detectedAt: new Date().toISOString(),
  } });
  if (!stopped.success) throw new Error(stopped.error);
  project = (await service.pause(project.id)).project!;
  expect(project.production!.steps[0]).toMatchObject({ taskId, status: 'bound' });
  expect(project.production!.steps[0].runId).toBeUndefined();
  return currentTask();
}

beforeAll(async (): Promise<void> => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-dispatch-recovery-'));
  picture = path.join(root, 'TEST-frame.png');
  await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x96', '-frames:v', '1', '-y', picture]);
});
afterAll(async (): Promise<void> => { await fs.rm(root, { recursive: true, force: true }); });
beforeEach(async (): Promise<void> => {
  const directory = await fs.mkdtemp(path.join(root, 'project-'));
  projects = new PetStoryProjects(); project = await projects.create(directory, 'TEST-recovery-studio', capability().accountId);
  project = await projects.saveMobileStory(project.id, project.revision, 'TEST 离线完整剧本');
  project.plan = plan(); project.source.status = 'review_required'; project = await projects.write(project);
  project = await projects.confirmStory(project.id, project.revision);
  project = await projects.addReference(project.id, 'actor', picture);
  project = await projects.addMaterialImage(project.id, project.revision, 'scene:room', picture);
  project = await projects.approveMaterials(project.id, project.revision, project.materials!.map((material): { materialId: string; assetId: string } => ({
    materialId: material.id, assetId: project.assets.find((asset): boolean => asset.materialId === material.id)!.id,
  })));
  project = await projects.addShotImage(project.id, project.revision, 'TEST-recovery-shot', 'firstFrame', picture);
  project = await projects.adoptImage(project.id, project.revision, { shotId: 'TEST-recovery-shot', kind: 'firstFrame' }, project.assets.at(-1)!.id);
  project.promptCapability = capability(); seedOfflinePromptContracts(project, undefined, { completeVideoBody: true }); project = await projects.write(project);
  tasksFile = path.join(directory, 'TEST-tasks.json'); stored([]); let sequence = 0;
  core = new TaskService({ store: { read: listed, replace: stored }, defaultProjectId: (): string => project.studioProjectId,
    id: (): string => `TEST-recovery-task-${++sequence}` });
  retry = vi.fn((id: string): Task => { const result = core.retry(id, 'hold'); if (!result.success) throw new Error(result.error); return result.data; });
  service = new PetStoryProductionService(projects, { updateLocalMedia: localMediaPort(core), list: listed, create, retryUnsubmitted: retry,
    adopt: (id: string, binding: NonNullable<Task['petstory']>, text?: string): Task => {
      const result = core.bindPetStory(id, binding, text); if (!result.success) throw new Error(result.error); return result.data;
    },
    downloads: (): [] => [], download: async (): Promise<never> => { throw new Error('TEST 禁止平台写入或下载'); },
  });
  const generated = await service.generateShotMedia(project.id, project.revision, 'TEST-recovery-shot', 'video', capability());
  expect(generated.success).toBe(true);
  const next = await service.advance(project.id); expect(next.action).toBe('start'); taskId = next.taskId!;
});

describe('确定派发前停止的原视频运行恢复', (): void => {
  it('未绑定run的派发失败只在显式继续后复用同task，下一run仍必须正式绑定', async (): Promise<void> => {
    const original = await stopBeforeBinding();
    await expect(service.guard(taskId)).rejects.toThrow('未授权提交');
    expect(retry).not.toHaveBeenCalled();
    expect((await service.resume(project.id, capability())).success).toBe(true);
    expect(retry).toHaveBeenCalledExactlyOnceWith(taskId);
    expect(await service.advance(project.id)).toMatchObject({ success: true, action: 'start', taskId });
    expect(listed()).toHaveLength(1);
    expect(currentTask()).toMatchObject({ id: original.id, prompt: original.prompt, attachments: original.attachments,
      videoConfig: original.videoConfig, petstory: original.petstory, executionIntent: 'hold', status: 'queued', runHistory: original.runHistory });
    expect(currentTask().runtime?.submittedAt).toBeUndefined();
    await expect(service.guard(taskId)).rejects.toThrow('原制作运行尚未绑定');
    beginRun('TEST-next-authorized-run', 2);
    await expect(service.guard(taskId)).rejects.toThrow('原制作运行尚未绑定');
    expect((await service.bindRun(project.id, taskId, 'TEST-next-authorized-run')).success).toBe(true);
    expect((await service.guard(taskId)).success).toBe(true);
    expect(currentTask().runtime?.submittedAt).toBeUndefined();
  });

  it('其他错误不能靠相同未提交文案恢复', async (): Promise<void> => {
    await stopBeforeBinding('unknown'); const before = listed();
    await expect(service.resume(project.id, capability())).rejects.toThrow('未确认可安全恢复');
    expect(listed()).toEqual(before); expect(retry).not.toHaveBeenCalled();
  });

  it('步骤真实绑定另一run时仍拒绝，不把派发失败当成跨运行授权', async (): Promise<void> => {
    beginRun('TEST-bound-run', 1); await service.bindRun(project.id, taskId, 'TEST-bound-run');
    const stopped = core.updateRuntime({ taskId, expectedRunId: currentRunId(core, taskId), status: 'paused', errorInfo: {
      code: 'dispatch_not_ready', message: 'TEST 派发前停止', recoverable: true, detectedAt: new Date().toISOString(),
    } }); expect(stopped.success).toBe(true);
    beginRun('TEST-other-run', 2);
    expect(core.updateRuntime({ taskId, expectedRunId: currentRunId(core, taskId), status: 'paused' }).success).toBe(true);
    await service.pause(project.id); const before = listed();
    await expect(service.resume(project.id, capability())).rejects.toThrow('原运行已变化');
    expect(listed()).toEqual(before); expect(retry).not.toHaveBeenCalled();
    expect((await projects.read(project.id)).production!.steps[0].runId).toBe('TEST-bound-run');
  });

  it.each(['acceptance', 'media-receipt', 'reply', 'readback', 'review', 'observation', 'outputs', 'artifacts'] as const)(
    '任何%s证据均阻断派发前重试并保留原记录', async (evidence): Promise<void> => {
      await stopBeforeBinding(); const items = listed(); const task = items[0]; const runtime = task.runtime!;
      const now = new Date().toISOString(); const runId = runtime.runId;
      if (evidence === 'acceptance') runtime.acceptanceObservation = {
        schemaVersion: 1, accountId: project.accountId, runId, conversationUrl: 'https://www.doubao.com/chat/TEST-evidence', acceptedAt: now,
        evidence: { kind: 'generation_started' }, cursor: { messageCount: 1, pollCount: 0 }, expectedArtifact: { kind: 'video', runId },
        lease: { ownerId: 'TEST', acquiredAt: now, expiresAt: now, lastHeartbeatAt: now }, outcome: 'observing',
      };
      else if (evidence === 'media-receipt') runtime.mediaSubmissionReceipt = { schemaVersion: 1, source: 'published_message',
        accountId: project.accountId, runId, submittedAt: now, observedAt: now,
        conversationUrl: 'https://www.doubao.com/chat/TEST-evidence', userMessageId: 'TEST-user-message' };
      else if (evidence === 'reply') runtime.chatResponse = { text: 'TEST 已收到回复', capturedAt: now };
      else if (evidence === 'readback') runtime.chatReadback = { runId, baselineMessageCount: 1, association: 'full_prompt', observedAt: now };
      else if (evidence === 'review') runtime.chatReadbackReview = { runId, checkedAt: now, reason: 'TEST 待核对', candidates: [] };
      else if (evidence === 'observation') runtime.manualObservation = { startedAt: now, expiresAt: now, source: 'stored_conversation', outcome: 'observing' };
      else if (evidence === 'outputs') task.outputs = ['https://TEST.invalid/already-produced.mp4'];
      else task.artifacts = [{ id: 'TEST-existing-artifact', url: 'https://TEST.invalid/already-produced.mp4', kind: 'video', source: 'page', runId, discoveredAt: now }];
      // 模拟重启读取的既有提交事实；不调用任何平台或正式数据仓库。
      stored(items); const before = listed(); const beforeProject = await projects.read(project.id);
      await expect(service.resume(project.id, capability())).rejects.toThrow('未确认可安全恢复');
      expect(listed()).toEqual(before); expect(await projects.read(project.id)).toEqual(beforeProject);
      expect(retry).not.toHaveBeenCalled();
    },
  );

  it('已持久化提交意图时只观察同一运行，不走准备重试', async (): Promise<void> => {
    await stopBeforeBinding(); const submittedAt = new Date().toISOString();
    expect(core.updateRuntime({ taskId, expectedRunId: currentRunId(core, taskId), runtime: { submittedAt } }).success).toBe(true);
    const before = listed();
    expect((await service.resume(project.id, capability())).success).toBe(true);
    expect(await service.advance(project.id)).toMatchObject({ success: true, action: 'observe', taskId });
    expect(listed()).toEqual(before); expect(retry).not.toHaveBeenCalled(); expect(listed()).toHaveLength(1);
  });
});
