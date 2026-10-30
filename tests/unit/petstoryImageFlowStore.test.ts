/** 原故事／原五镜头的离线接线回归；任务和图片均为替身，不代表真实豆包输出。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryChatJob, PetStoryImageOperation, PetStoryImageOperationRequest, PetStoryImageOperationResult, PetStoryPlan, PetStoryProject, PetStoryResult, Task } from '@doubao-studio/contracts';
import { observePetStoryTasks, tickPetStoryImageOperation, usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import { imageConversationTask, petStoryImageProgress } from '../../src/utils/petstoryImageFlow';
import snapshot from '../fixtures/storyboard-five-shots.json';

const original = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState(), studio: useProjectStore.getState() };
type RuntimePatch = Parameters<ReturnType<typeof useTaskStore.getState>['updateTaskRuntime']>[1];
const now = '2026-10-30T05:00:00.000Z';
let project: PetStoryProject; let tasks: Task[]; let serial = 0; let unobserve: (() => void) | undefined;
const begin = vi.fn<(id: string, revision: number, request: PetStoryImageOperationRequest) => Promise<PetStoryImageOperationResult>>();
const advance = vi.fn<(id: string, operationId: string) => Promise<PetStoryImageOperationResult>>();
const resume = vi.fn<(id: string, operationId: string) => Promise<PetStoryImageOperationResult>>();
const collect = vi.fn<(id: string, jobId: string) => Promise<PetStoryResult>>();
const start = vi.fn<(taskId: string, beforeDispatch?: (task: Task) => Promise<void>) => Promise<boolean>>();
const bindProduction = vi.fn<(id: string, taskId: string, runId: string) => Promise<PetStoryResult>>();
const prepareRuntime = vi.fn<() => Promise<PetStoryResult>>();
const adoptPrompt = vi.fn<() => Promise<PetStoryResult>>();
const dispatch = vi.fn<(event: Event) => boolean>();

function save(): PetStoryProject { project = structuredClone(project); project.revision++; return project; }
function operation(id: string): PetStoryImageOperation { return project.imageOperations!.find((item): boolean => item.id === id)!; }
function task(id: string, mode: 'chat' | 'image'): Task {
  return { id, projectId: project.studioProjectId, assignedAccountId: project.accountId, status: 'queued', mode,
    prompt: 'TEST 正式请求替身', executionIntent: 'hold', outputs: [], result: null, createdAt: now, updatedAt: now };
}
function chatJob(op: PetStoryImageOperation): PetStoryChatJob {
  const job: PetStoryChatJob = { id: `TEST-image-chat-${serial}`, taskId: `TEST-image-chat-task-${serial}`, kind: 'materialPrompt', materialId: op.target.materialId,
    status: 'bound', inputHash: 'TEST', sourceUrl: '', sourceStoryId: project.mobileStory!.id, createdAt: now, requestId: `TEST-request-${serial}`, expectedIds: [op.target.materialId!] };
  project.jobs.push(job); tasks.push(task(job.taskId, 'chat')); op.chatJobId = job.id; return job;
}
function response(op: PetStoryImageOperation): PetStoryImageOperationResult {
  return { success: op.stage !== 'failed', project, operationId: op.id, ...(op.stage === 'preparing' ? { chatJobId: op.chatJobId } : {}) };
}
async function finishMedia(): Promise<void> {
  const media = tasks.at(-1)!; media.status = 'done';
  await tickPetStoryImageOperation();
}
async function stoppedSubmittedImage(): Promise<{ media: Task; op: PetStoryImageOperation }> {
  await usePetStoryStore.getState().modifyImage({ materialId: project.materials![0].id }, 'TEST-old-adopted', '调整表情');
  const media = tasks.at(-1)!; const op = project.imageOperations!.at(-1)!;
  const stepId = 'TEST-stopped-image-step';
  media.status = 'paused'; media.runtime!.submittedAt = now; media.petstory = { projectId: project.id, stepId };
  const entry = { state: 'unknown' as const, reason: 'TEST 只读原运行，不要求预检查' };
  project.production = { phase: 'materials', imageOperationId: op.id, state: 'paused', planHash: 'TEST', approvedAt: now,
    capability: { accountId: project.accountId, image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [] },
    fallbacks: {}, shots: {}, message: 'TEST 原提交结果尚未确认', steps: [{ id: stepId, kind: 'character', materialId: op.target.materialId,
      taskId: media.id, runId: media.runtime!.runId, inputHash: 'TEST', attachmentAssetIds: [], status: 'bound' }] };
  usePetStoryStore.setState({ project }); return { media, op };
}

beforeEach((): void => {
  vi.resetAllMocks(); tasks = []; serial++;
  project = { id: `TEST-image-project-${serial}`, schemaVersion: 1, studioProjectId: 'TEST-image-studio', accountId: 'TEST-image-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-image-story', text: snapshot.mobileStory, importedAt: now },
    plan: structuredClone(snapshot.plan) as PetStoryPlan, assets: [], jobs: [], updatedAt: now };
  const character = project.plan!.characters[0];
  project.materials = [{ id: `character:${character.id}`, entityId: character.id, kind: 'character', name: character.name, designHash: 'TEST', selectedAssetId: 'TEST-old-adopted',
    prompt: { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST' } }];
  project.assets.push({ id: 'TEST-old-adopted', kind: 'character', materialId: project.materials[0].id, characterId: character.id, relativePath: 'TEST/old.png' });
  begin.mockImplementation(async (_id: string, _revision: number, request: PetStoryImageOperationRequest): Promise<PetStoryImageOperationResult> => {
    save(); const count = (project.imageOperations?.length || 0) + 1;
    const op: PetStoryImageOperation = { id: `TEST-operation-${serial}-${count}`, requestId: request.requestId, target: request.target,
      mode: request.baseAssetId ? 'modify' : 'generate', stage: request.baseAssetId ? 'generating' : 'preparing', basisHash: 'TEST', createdAt: now,
      baseAssetId: request.baseAssetId, feedback: request.feedback };
    project.imageOperations = [...(project.imageOperations || []), op];
    if (op.mode === 'generate') chatJob(op);
    return response(op);
  });
  advance.mockImplementation(async (_id: string, id: string): Promise<PetStoryImageOperationResult> => {
    save(); const op = operation(id);
    if (op.stage === 'preparing') {
      const job = project.jobs.find((item): boolean => item.id === op.chatJobId)!;
      if (job.status !== 'applied') return response(op);
      job.resultStatus = 'adopted'; op.stage = 'generating';
    }
    if (!op.taskId) { op.taskId = `TEST-image-task-${op.id}`; tasks.push(task(op.taskId, 'image')); }
    const media = tasks.find((item): boolean => item.id === op.taskId)!;
    if (media.status === 'done') {
      if (!op.outputAssetId) {
        op.outputAssetId = `TEST-output-${op.id}`;
        project.assets.push({ id: op.outputAssetId, kind: 'character', materialId: op.target.materialId, taskId: media.id, runId: media.runtime?.runId, relativePath: 'TEST/candidate.png',
          imageReview: { target: op.target, state: 'candidate', basisHash: 'TEST' }, validation: { decoded: true, sha256: 'a'.repeat(64), bytes: 1, width: 1, height: 1, checkedAt: now } });
      }
      op.stage = 'complete'; return response(op);
    }
    return { ...response(op), taskId: media.id, action: media.status === 'queued' ? 'start' : 'wait' };
  });
  resume.mockImplementation(async (_id: string, id: string): Promise<PetStoryImageOperationResult> => { save(); const op = operation(id); op.error = undefined; op.stage = op.taskId ? 'generating' : 'preparing'; return response(op); });
  collect.mockImplementation(async (_id: string, jobId: string): Promise<PetStoryResult> => { save(); const job = project.jobs.find((item): boolean => item.id === jobId)!; job.status = 'applied'; job.resultStatus = 'candidate'; return { success: true, project }; });
  start.mockImplementation(async (id: string, beforeDispatch?: (started: Task) => Promise<void>): Promise<boolean> => {
    const started = tasks.find((item): boolean => item.id === id)!;
    started.status = 'executing'; started.runtime = { runId: `TEST-run-${id}`, attempt: 1, stage: 'preparing_account', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { mode: started.mode, prompt: started.prompt, attachments: [] } };
    await beforeDispatch?.(started); return true;
  });
  bindProduction.mockImplementation(async (): Promise<PetStoryResult> => ({ success: true, project }));
  dispatch.mockReturnValue(true);
  vi.stubGlobal('window', { dispatchEvent: dispatch, electronAPI: { petstory: { beginImageOperation: begin, advanceImageOperation: advance, resumeImageOperation: resume,
    collectChat: collect, prepareRuntime, adoptPromptCandidate: adoptPrompt, bindProductionRun: bindProduction,
    bindRun: async (_id: string, jobId: string, runId: string): Promise<PetStoryResult> => { project.jobs.find((job): boolean => job.id === jobId)!.runId = runId; return { success: true, project }; },
    open: async (): Promise<PetStoryResult> => ({ success: true, project }),
  }, tasks: { list: async (): Promise<Task[]> => tasks } } });
  const account: Account = { id: project.accountId, name: 'TEST 原账号', platform: 'doubao', partition: 'TEST-image-partition', status: 'idle', avatar: '', pinned: false, createdAt: now, updatedAt: now };
  useAccountStore.setState({ ...original.accounts, accounts: [account], selectedAccountId: account.id, selectAccount: vi.fn() });
  useProjectStore.setState({ ...original.studio, projects: [{ id: project.studioProjectId, name: 'TEST 原故事隔离项目', description: '', color: '#fff', archived: false, createdAt: now, updatedAt: now }], selectProject: vi.fn() });
  useTaskStore.setState({ ...original.tasks, tasks, startAutomation: start, error: '', activeTaskId: null, accountBusy: {}, accountAutomationState: {},
    updateTaskRuntime: async (id: string, patch: RuntimePatch): Promise<boolean> => { const item = tasks.find((entry): boolean => entry.id === id)!; Object.assign(item, patch, { runtime: { ...item.runtime, ...patch.runtime } }); return true; } });
  usePetStoryStore.setState({ ...original.petstory, project, busy: false, error: '', activeImageOperationId: null });
});

afterEach(async (): Promise<void> => {
  unobserve?.(); unobserve = undefined;
  await usePetStoryStore.getState().openProject('TEST/原故事副本');
  usePetStoryStore.setState(original.petstory); useTaskStore.setState(original.tasks); useAccountStore.setState(original.accounts); useProjectStore.setState(original.studio);
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('单次图片意图的后台接力', (): void => {
  it('只点击一次，从文字收取自动继续媒体，下载候选前后不改变已采用图', async (): Promise<void> => {
    const materialId = project.materials![0].id;
    await usePetStoryStore.getState().generateMaterialImage(materialId);
    expect(begin).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
    const job = project.jobs[0]; const chat = tasks[0]; chat.status = 'done'; chat.runtime!.chatResponse = { text: 'TEST 豆包回复替身', capturedAt: now };
    await usePetStoryStore.getState().collect(job.id);
    await tickPetStoryImageOperation();
    expect(start).toHaveBeenCalledTimes(2); expect(bindProduction).toHaveBeenCalledTimes(1);
    expect(project.jobs[0].resultStatus).toBe('adopted'); expect(adoptPrompt).not.toHaveBeenCalled();
    expect(project.materials![0].selectedAssetId).toBe('TEST-old-adopted');
    await finishMedia(); await tickPetStoryImageOperation();
    expect(project.imageOperations![0].stage).toBe('complete'); expect(project.assets.at(-1)!.imageReview!.state).toBe('candidate');
    expect(project.materials![0].selectedAssetId).toBe('TEST-old-adopted'); expect(begin).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().activeImageOperationId).toBeNull();
  });

  it('选未采用上传图及上一轮候选连续修改，两轮都绑定调用时选定的具体图片', async (): Promise<void> => {
    const target = { materialId: project.materials![0].id };
    project.assets.push({ id: 'TEST-uploaded-unadopted', kind: 'character', materialId: target.materialId, relativePath: 'TEST/upload.png', imageReview: { state: 'candidate', target, basisHash: 'TEST' } });
    await usePetStoryStore.getState().modifyImage(target, 'TEST-uploaded-unadopted', '表情更自然，衣服和背景保持不变');
    await finishMedia(); const first = project.imageOperations![0].outputAssetId!;
    await usePetStoryStore.getState().modifyImage(target, first, '再把笑容收敛一点');
    await finishMedia();
    expect(begin.mock.calls.map((call): unknown => ({ base: call[2].baseAssetId, feedback: call[2].feedback }))).toEqual([
      { base: 'TEST-uploaded-unadopted', feedback: '表情更自然，衣服和背景保持不变' }, { base: first, feedback: '再把笑容收敛一点' }]);
    expect(project.imageOperations).toHaveLength(2); expect(project.jobs).toHaveLength(0); expect(start).toHaveBeenCalledTimes(2);
    expect(project.materials![0].selectedAssetId).toBe('TEST-old-adopted'); expect(dispatch).not.toHaveBeenCalled();
  });

  it('空反馈不创建请求，开始中的重复点击只进入一次IPC', async (): Promise<void> => {
    const target = { materialId: project.materials![0].id };
    await usePetStoryStore.getState().modifyImage(target, 'TEST-old-adopted', '   ');
    expect(begin).not.toHaveBeenCalled();
    const first = usePetStoryStore.getState().generateMaterialImage(target.materialId);
    const duplicate = usePetStoryStore.getState().generateMaterialImage(target.materialId);
    await Promise.all([first, duplicate]); expect(begin).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
  });

  it('重开保留任务但不自动发送，有明确继续入口且不重复创建操作', async (): Promise<void> => {
    vi.useFakeTimers(); await usePetStoryStore.getState().generateMaterialImage(project.materials![0].id);
    const opId = project.imageOperations![0].id;
    await usePetStoryStore.getState().openProject('TEST/原故事副本');
    const before = advance.mock.calls.length;
    unobserve = observePetStoryTasks(); await vi.advanceTimersByTimeAsync(2200);
    expect(advance).toHaveBeenCalledTimes(before); expect(start).toHaveBeenCalledTimes(1);
    const progress = petStoryImageProgress(project, project.imageOperations![0].target, tasks, usePetStoryStore.getState().activeImageOperationId);
    expect(progress.busy).toBe(false); expect(progress.resumable).toBe(true);
    await usePetStoryStore.getState().recoverImageOperation(opId);
    expect(resume).toHaveBeenCalledWith(project.id, opId, undefined); expect(begin).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
  });

  it('已提交的文字失败只读恢复，不再启动或创建任务', async (): Promise<void> => {
    await usePetStoryStore.getState().generateMaterialImage(project.materials![0].id);
    const chat = tasks[0]; chat.status = 'paused'; chat.runtime!.submittedAt = now; chat.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-image-original';
    await usePetStoryStore.getState().openProject('TEST/原故事副本');
    await usePetStoryStore.getState().recoverImageOperation(project.imageOperations![0].id);
    expect(start).toHaveBeenCalledTimes(1); expect(begin).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls.map((call): string => call[0].type)).toEqual(['reconcile-task-submission']);
    expect(chat.status).toBe('manual_submission_observing'); expect(chat.runtime!.submittedAt).toBe(now);
  });

  it.each([undefined, 'https://www.doubao.com/chat/', 'https://www.doubao.com/chat/local_TEST-transient', 'https://www.doubao.com/chat/TEST-image-original'])('图片提交不明显式恢复%s：只读原运行，不再次启动或发送', async (url?: string): Promise<void> => {
    const { media, op } = await stoppedSubmittedImage(); media.runtime!.conversationUrl = url;
    const originalRun = media.runtime!.runId; const originalPrompt = media.prompt;
    await tickPetStoryImageOperation(); expect(dispatch).not.toHaveBeenCalled();
    await usePetStoryStore.getState().recoverImageOperation(op.id);
    const explicitCurrentPage = url !== 'https://www.doubao.com/chat/TEST-image-original';
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ type: 'reconcile-task-submission', detail: { taskId: media.id, useCurrentPage: explicitCurrentPage } });
    expect(media.status).toBe('manual_submission_observing'); expect(media.runtime!.runId).toBe(originalRun);
    expect(media.runtime!.submittedAt).toBe(now); expect(media.prompt).toBe(originalPrompt);
    expect(start).toHaveBeenCalledTimes(1); expect(begin).toHaveBeenCalledTimes(1); expect(tasks).toHaveLength(1);
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(advance.mock.invocationCallOrder.at(-1)!);
    await usePetStoryStore.getState().recoverImageOperation(op.id); expect(dispatch).toHaveBeenCalledTimes(1); expect(start).toHaveBeenCalledTimes(1);
  });

  it.each(['run', 'account', 'project', 'step'] as const)('原图片%s关联不符时不读取当前页、不标记观察且不重发', async (mismatch: string): Promise<void> => {
    const { media, op } = await stoppedSubmittedImage();
    if (mismatch === 'run') project.production!.steps[0].runId = 'TEST-other-run';
    else if (mismatch === 'account') media.assignedAccountId = 'TEST-other-account';
    else if (mismatch === 'project') media.projectId = 'TEST-other-studio';
    else media.petstory!.stepId = 'TEST-other-step';
    await usePetStoryStore.getState().recoverImageOperation(op.id);
    expect(dispatch).not.toHaveBeenCalled(); expect(media.status).toBe('paused'); expect(start).toHaveBeenCalledTimes(1);
    expect(usePetStoryStore.getState().error).toContain('运行不一致'); expect(usePetStoryStore.getState().activeImageOperationId).toBeNull();
  });

  it('原图片会话存在歧义时显式恢复也拒绝当前页兜底', async (): Promise<void> => {
    const { media, op } = await stoppedSubmittedImage();
    media.artifacts = ['TEST-origin-one', 'TEST-origin-two'].map((id: string): NonNullable<Task['artifacts']>[number] => ({ id, kind: 'file', source: 'page',
      runId: media.runtime!.runId, url: `https://TEST.invalid/${id}`, conversationUrl: `https://www.doubao.com/chat/${id}`, discoveredAt: now }));
    await usePetStoryStore.getState().recoverImageOperation(op.id);
    expect(dispatch).not.toHaveBeenCalled(); expect(media.status).toBe('paused'); expect(start).toHaveBeenCalledTimes(1);
    expect(usePetStoryStore.getState().error).toContain('绑定冲突');
  });
});

describe('候选进度及精确来源投影', (): void => {
  it('无可预览文件时不会将complete投影成完成或伪造100%', async (): Promise<void> => {
    await usePetStoryStore.getState().modifyImage({ materialId: project.materials![0].id }, 'TEST-old-adopted', '调整表情');
    const op = project.imageOperations![0]; op.stage = 'complete'; op.outputAssetId = 'TEST-not-downloaded';
    const progress = petStoryImageProgress(project, op.target, tasks);
    expect(progress.stage).toBe('saving'); expect(progress.message).toBe('正在保存图片…'); expect(progress.candidateAssetId).toBeUndefined();
  });

  it('文字和图片各用实际阶段会话，上传图无来源，旧图运行不符时不猜链接', async (): Promise<void> => {
    await usePetStoryStore.getState().generateMaterialImage(project.materials![0].id);
    const target = project.imageOperations![0].target;
    tasks[0].runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-text-stage';
    expect(imageConversationTask(project, target, tasks)?.id).toBe(tasks[0].id);
    await usePetStoryStore.getState().collect(project.jobs[0].id); await tickPetStoryImageOperation();
    const media = tasks.at(-1)!; media.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-media-stage';
    await finishMedia(); const asset = project.assets.at(-1)!;
    expect(imageConversationTask(project, target, tasks, asset.id)?.id).toBe(media.id);
    expect(imageConversationTask(project, target, tasks, 'TEST-old-adopted')).toBeUndefined();
    media.runtime!.runId = 'TEST-unrelated-new-run';
    expect(imageConversationTask(project, target, tasks, asset.id)).toBeUndefined();
  });

  it('显式查看来源才展开浏览器；另一张图正在生成时不导航到旧会话', async (): Promise<void> => {
    await usePetStoryStore.getState().modifyImage({ materialId: project.materials![0].id }, 'TEST-old-adopted', '调整表情');
    const media = tasks.at(-1)!; media.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-output-session'; await finishMedia();
    const candidate = project.assets.at(-1)!; const target = candidate.imageReview!.target;
    await usePetStoryStore.getState().openImageConversation(target, candidate.id);
    expect(dispatch.mock.calls.map((call): string => call[0].type)).toEqual(['reveal-workspace-browser', 'open-task-conversation']);
    dispatch.mockClear(); const busy = task('TEST-other-task', 'image'); busy.status = 'generating'; tasks.push(busy); useTaskStore.setState({ tasks: [...tasks] });
    await usePetStoryStore.getState().openImageConversation(target, candidate.id);
    expect(dispatch).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().error).toContain('另一段对话');
  });

  it('AI完成后又上传新候选，卡片不把旧AI会话伪装成新上传图的来源', async (): Promise<void> => {
    const target = { materialId: project.materials![0].id };
    await usePetStoryStore.getState().modifyImage(target, 'TEST-old-adopted', '调整表情');
    const media = tasks.at(-1)!; media.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-prior-ai-session'; await finishMedia();
    expect(imageConversationTask(project, target, tasks)?.id).toBe(media.id);
    project.assets.push({ id: 'TEST-new-upload', kind: 'character', materialId: target.materialId, relativePath: 'TEST/new-upload.png', imageReview: { state: 'candidate', target, basisHash: 'TEST' } });
    expect(imageConversationTask(project, target, tasks)).toBeUndefined();
    expect(imageConversationTask(project, target, tasks, project.imageOperations![0].outputAssetId)?.id).toBe(media.id);
  });
});
