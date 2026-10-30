/** 离线 UI 接线测试：沿用原五镜夹具，不属于真实豆包文字验收。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Account, PetStoryCapability, PetStoryChatJob, PetStoryMaterial, PetStoryMaterialEditIntent, PetStoryPlan, PetStoryProject, PetStoryPromptBatch, PetStoryResult, PetStoryRuntimeTarget, Task } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { PetStoryRuntime } from '../../src/components/PetStoryRuntime';
import { CanvasPromptEditor } from '../../src/components/PetStoryCanvasPrompt';
import { PetStoryMaterials } from '../../src/components/PetStoryMaterials';
import { PetStoryOpenProject } from '../../src/components/PetStoryOpenProject';

const initial = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState(), projects: useProjectStore.getState() };
let project: PetStoryProject;
let tasks: Task[];
const now = '2026-10-25T01:00:00.000Z';
const prepareRuntime = vi.fn(async (_id: string, _revision: number, kind: PetStoryChatJob['kind'], target?: PetStoryRuntimeTarget): Promise<PetStoryResult> => {
  const index = tasks.length + 1; const id = `TEST-job-${index}`; const taskId = `TEST-task-${index}`;
  project = structuredClone(project); project.revision++;
  project.jobs.push({ id, taskId, kind, status: 'bound', inputHash: 'TEST', sourceUrl: '', sourceStoryId: project.mobileStory!.id, requestId: `TEST-request-${index}`, expectedIds: [target?.materialId || target?.shotId || 'story'], createdAt: new Date(Date.parse(now) + index * 1000).toISOString(), ...target });
  tasks.push({ id: taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: 'queued', prompt: 'TEST 主进程运行时请求替身', runtime: { runId: `TEST-run-${index}` } } as Task);
  return { success: true, project, taskId };
});
const collectChat = vi.fn(async (_id: string, jobId: string): Promise<PetStoryResult> => {
  project = structuredClone(project); project.revision++;
  project.jobs.find((job): boolean => job.id === jobId)!.status = 'applied';
  return { success: true, project };
});
const adoptPlanCandidate = vi.fn(async (): Promise<PetStoryResult> => ({ success: true, project }));
const adoptAssetsCandidate = vi.fn(async (): Promise<PetStoryResult> => ({ success: true, project }));
const adoptPromptCandidate = vi.fn(async (): Promise<PetStoryResult> => ({ success: true, project }));
const openProject = vi.fn(async (): Promise<PetStoryResult> => ({ success: true, project }));
const generateMaterials = vi.fn(async (): Promise<PetStoryResult> => ({ success: true, project }));
const savePromptBatch = vi.fn(async (_id: string, _revision: number, batch: PetStoryPromptBatch): Promise<PetStoryResult> => {
  project = structuredClone(project); project.revision++; project.promptBatch = structuredClone(batch);
  return { success: true, project };
});
const promptStageTargets = vi.fn(async (): Promise<PetStoryResult> => ({ success: true, project, promptTargets: [], pendingCandidateJobIds: [] }));
const endChatWaiting = vi.fn(async (_id: string, _revision: number, jobId: string): Promise<PetStoryResult> => {
  project = structuredClone(project); project.revision++; project.jobs.find((job): boolean => job.id === jobId)!.endedWaitingAt = now;
  if (project.promptBatch) project.promptBatch.status = 'paused';
  return { success: true, project };
});
const savePromptModel = vi.fn(async (_id: string, _revision: number, model?: PetStoryProject['promptModel']): Promise<PetStoryResult> => {
  project = structuredClone(project); project.revision++; project.promptModel = model; return { success: true, project };
});
const retryUnsubmitted = vi.fn(async (_id: string, jobId: string): Promise<PetStoryResult> => {
  project = structuredClone(project); project.revision++;
  const job = project.jobs.find((item): boolean => item.id === jobId)!; job.runId = undefined;
  const task = tasks.find((item): boolean => item.id === job.taskId)!; task.status = 'queued'; task.executionIntent = 'hold';
  return { success: true, project, taskId: task.id };
});
function capability(): PetStoryCapability {
  const entry = { state: 'unknown' as const, reason: 'TEST 仅供文字模型选择' };
  return { accountId: project.accountId, checkedAt: now, durations: [5], image: entry,
    modes: { first_frame: entry, first_last_frame: entry, reference: entry }, videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' } };
}

beforeEach((): void => {
  vi.clearAllMocks(); tasks = [];
  project = { id: 'TEST-project', schemaVersion: 1, studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 8, source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-source', text: snapshot.mobileStory, importedAt: now }, plan: structuredClone(snapshot.plan) as PetStoryPlan, assets: [], jobs: [], updatedAt: now };
  const account: Account = { id: project.accountId, name: 'TEST 原账号', platform: 'doubao', partition: 'TEST', status: 'idle', avatar: '', pinned: false, createdAt: now, updatedAt: now };
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { petstory: { prepareRuntime, collectChat, adoptPlanCandidate, adoptAssetsCandidate, adoptPromptCandidate, open: openProject, generateMaterials, savePromptBatch, promptStageTargets, endChatWaiting, savePromptModel, retryUnsubmitted,
    bindRun: async (_id: string, jobId: string, runId: string): Promise<PetStoryResult> => { project.jobs.find((job): boolean => job.id === jobId)!.runId = runId; return { success: true, project }; }, prepareChat: vi.fn((): never => { throw new Error('运行时入口不得回退到 renderer 提示词'); }) }, tasks: { list: async (): Promise<Task[]> => tasks } } });
  useAccountStore.setState({ accounts: [account] });
  useProjectStore.setState({ projects: [{ id: project.studioProjectId, name: 'TEST 原项目', description: '', color: '#fff', archived: false, createdAt: now, updatedAt: now }] });
  useTaskStore.setState({ activeTaskId: null, accountBusy: {}, startAutomation: async (taskId: string, beforeDispatch?: (task: Task) => Promise<void>): Promise<boolean> => { if (beforeDispatch) await beforeDispatch(tasks.find((task): boolean => task.id === taskId)!); return true; } });
  usePetStoryStore.setState({ project, busy: false, error: '', capability: null, promptBatch: { total: 0, completed: 0, status: 'idle' } });
});
afterEach(async (): Promise<void> => {
  await usePetStoryStore.getState().stopPromptBatch();
  usePetStoryStore.setState(initial.petstory); useTaskStore.setState(initial.tasks); useAccountStore.setState(initial.accounts); useProjectStore.setState(initial.projects);
  vi.unstubAllGlobals();
});
async function finishCurrent(): Promise<void> { await usePetStoryStore.getState().collect(project.jobs.at(-1)!.id); }
it.each([false, 'unknown', undefined])('新建与重开文字任务忽略遗留确认值%s；不补造确认或检查记录', async (legacy): Promise<void> => {
  if (legacy !== undefined) Object.assign(project, { freeChatConfirmed: legacy, freeConfirmed: legacy, capabilityCheckedInSession: legacy });
  const create = vi.fn(async (): Promise<PetStoryResult> => ({ success: true, project })); window.electronAPI.petstory.create = create;
  await usePetStoryStore.getState().createProject({ accountId: project.accountId, studioProjectId: project.studioProjectId });
  await usePetStoryStore.getState().analyze();
  expect(prepareRuntime).toHaveBeenCalledWith(project.id, 8, 'analysis', undefined);
  const firstJob = project.jobs[0]; firstJob.status = 'applied'; firstJob.resultStatus = 'adopted';
  await usePetStoryStore.getState().openProject();
  await usePetStoryStore.getState().optimize(project.plan!.shots[0].id, 'video');
  expect(prepareRuntime).toHaveBeenLastCalledWith(project.id, 9, 'optimize', { shotId: project.plan!.shots[0].id, promptKind: 'video' });
  expect(tasks).toHaveLength(2); expect(usePetStoryStore.getState().error).toBe('');
  expect(usePetStoryStore.getState()).not.toHaveProperty('freeChatConfirmed');
  expect(usePetStoryStore.getState()).not.toHaveProperty('capabilityCheckedInSession');
  expect(usePetStoryStore.getState().capability).toBeNull();
});
it('新建可显式选择账号与关联项目，并保留用户当前浏览账号与全局项目', async (): Promise<void> => {
  const selectedBefore = useAccountStore.getState().selectedAccountId;
  const activeBefore = useProjectStore.getState().activeProjectId;
  const create = vi.fn(async (): Promise<PetStoryResult> => ({ success: true, project }));
  window.electronAPI.petstory.create = create;
  await usePetStoryStore.getState().createProject({ accountId: 'TEST-explicit-account', studioProjectId: 'TEST-explicit-studio' });
  expect(create).toHaveBeenCalledWith('TEST-explicit-studio', 'TEST-explicit-account');
  expect(useAccountStore.getState().selectedAccountId).toBe(selectedBefore);
  expect(useProjectStore.getState().activeProjectId).toBe(activeBefore);
  expect(prepareRuntime).not.toHaveBeenCalled();
});
it.each(['injecting', 'submitting', 'generating'] as const)('打开项目时另一账号%s：保留项目绑定，并按原交互租约决定是否切换浏览账号', async (automationState): Promise<void> => {
  const bound = useAccountStore.getState().accounts[0]; const other = { ...bound, id: 'TEST-other-browsing', name: 'TEST 其他浏览账号', partition: 'TEST-other-partition' };
  vi.stubGlobal('localStorage', { setItem: vi.fn() });
  const select = vi.fn((accountId: string | null): void => useAccountStore.setState({ selectedAccountId: accountId }));
  useAccountStore.setState({ accounts: [bound, other], selectedAccountId: other.id, selectAccount: select }); useTaskStore.setState({ accountAutomationState: { [other.id]: automationState } });
  const before = structuredClone(project); await usePetStoryStore.getState().openProject();
  expect(usePetStoryStore.getState().project).toEqual(before); expect(usePetStoryStore.getState().project?.accountId).toBe(bound.id); expect(usePetStoryStore.getState().error).toBe('');
  if (automationState === 'generating') { expect(select).toHaveBeenCalledWith(bound.id); expect(useAccountStore.getState().selectedAccountId).toBe(bound.id); }
  else { expect(select).not.toHaveBeenCalled(); expect(useAccountStore.getState().selectedAccountId).toBe(other.id); }
  expect(useTaskStore.getState().accountAutomationState).toEqual({ [other.id]: automationState }); expect(prepareRuntime).not.toHaveBeenCalled();
});
it('没有检查状态也能直接开始基础图任务，沿原媒体 IPC 保留实际参数', async (): Promise<void> => {
  const advance = vi.fn(async (): Promise<PetStoryResult> => ({ success: true, project }));
  window.electronAPI.petstory.advanceProduction = advance;
  usePetStoryStore.setState({ capability: null });
  await usePetStoryStore.getState().generateMaterials(['scene:location']);
  expect(generateMaterials).toHaveBeenCalledWith(project.id, project.revision, ['scene:location'], undefined);
  expect(prepareRuntime).not.toHaveBeenCalled();
});
it.each(['done', 'submitted'] as const)('原媒体任务%s后重开沿原任务恢复，不要求额外入口记录', async (status): Promise<void> => {
  const savedCapability = capability();
  const task: Task = { id: 'TEST-media-task', projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'image', status: status === 'done' ? 'done' : 'paused', prompt: 'TEST 原媒体请求', result: null, outputs: [], createdAt: now, updatedAt: now,
    ...(status === 'submitted' ? { runtime: { runId: 'TEST-media-run', attempt: 1, stage: 'generating', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, input: { mode: 'image', prompt: 'TEST 原媒体请求', attachments: [] } } } : {})};
  tasks.push(task); project.production = { phase: 'shots', state: 'paused', planHash: 'TEST', approvedAt: now, capability: savedCapability, fallbacks: {}, shots: {}, steps: [{ id: 'TEST-step', shotId: project.plan!.shots[0].id, kind: 'firstFrame', taskId: task.id, status: 'bound', inputHash: 'TEST', attachmentAssetIds: [] }], message: 'TEST 暂停' };
  const resume = vi.fn(async (): Promise<PetStoryResult> => ({ success: true, project }));
  const advance = vi.fn(async (): Promise<PetStoryResult> => ({ success: true, project }));
  window.electronAPI.petstory.resumeProduction = resume; window.electronAPI.petstory.advanceProduction = advance;
  usePetStoryStore.setState({ project, capability: null}); useTaskStore.setState({ tasks });
  const before = structuredClone(project.production.capability);
  await usePetStoryStore.getState().resumeProduction();
  expect(resume).toHaveBeenCalledWith(project.id, undefined);
  expect(usePetStoryStore.getState().error).toBe('');
  expect(savedCapability).toEqual(before); expect(tasks).toHaveLength(1); expect(prepareRuntime).not.toHaveBeenCalled(); expect(generateMaterials).not.toHaveBeenCalled();
});
it('原媒体任务未发送且没有检查记录时仍沿后台原任务继续', async (): Promise<void> => {
  const task: Task = { id: 'TEST-media-task', projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'image', status: 'paused', prompt: 'TEST 原媒体请求', result: null, outputs: [], createdAt: now, updatedAt: now };
  tasks.push(task); project.production = { phase: 'shots', state: 'paused', planHash: 'TEST', approvedAt: now, capability: capability(), fallbacks: {}, shots: {}, steps: [{ id: 'TEST-step', shotId: project.plan!.shots[0].id, kind: 'firstFrame', taskId: task.id, status: 'bound', inputHash: 'TEST', attachmentAssetIds: [] }], message: 'TEST 暂停' };
  const resume = vi.fn(async (): Promise<PetStoryResult> => ({ success: true, project }));
  const advance = vi.fn(async (): Promise<PetStoryResult> => ({ success: true, project }));
  window.electronAPI.petstory.resumeProduction = resume; window.electronAPI.petstory.advanceProduction = advance;
  usePetStoryStore.setState({ project, capability: null}); useTaskStore.setState({ tasks });
  await usePetStoryStore.getState().resumeProduction();
  expect(resume).toHaveBeenCalledWith(project.id, undefined); expect(advance).toHaveBeenCalledWith(project.id);
  expect(usePetStoryStore.getState().error).toBe(''); expect(tasks).toHaveLength(1);
});
async function failOriginalBatch(): Promise<PetStoryChatJob> {
  await usePetStoryStore.getState().regenerateAllPrompts(); const original = project.jobs[0];
  collectChat.mockImplementationOnce(async (_id: string, jobId: string): Promise<PetStoryResult> => {
    project = structuredClone(project); project.revision++;
    const job = project.jobs.find((item): boolean => item.id === jobId)!;
    job.status = 'invalid'; job.rawText = 'TEST离线原失败回复'; job.error = 'TEST原候选缺项';
    return { success: false, project, error: job.error, needsRepair: false };
  });
  await usePetStoryStore.getState().collect(original.id, false);
  expect(project.promptBatch).toMatchObject({ status: 'paused', completed: 0, jobId: original.id });
  return original;
}
/** 仅模拟正式采用 IPC 的保存结果；正文仍取原五镜夹具，不属于真实豆包产出。 */
function adoptOfflinePrompt(jobId: string): PetStoryResult {
  project = structuredClone(project); project.revision++;
  const job = project.jobs.find((item): boolean => item.id === jobId)!;
  const target = project.plan!.shots.find((shot): boolean => shot.id === job.shotId)!.prompts[job.promptKind!]!;
  job.status = 'applied'; job.resultStatus = 'adopted'; job.parsedResult = { optimized: target.final };
  target.sourceJobId = job.id; target.candidateJobId = job.id; target.edited = false;
  return { success: true, project };
}
/** 同原五镜角色派生容器；只模拟ID变化和空正文，不另写创作正文。 */
function installOriginalMaterialContainers(): void {
  project.materials = project.plan!.characters.slice(0, 2).map((character: PetStoryPlan['characters'][number]): PetStoryMaterial => ({ id: `character:${character.id}`, entityId: character.id, kind: 'character',
    name: character.name, designHash: 'TEST原设计', prompt: { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST离线' } }));
  usePetStoryStore.setState({ project });
}
function replaceFirstMaterialId(): string {
  const material = project.materials![0]; const id = `${material.id}-new-plan`;
  material.id = id; material.entityId = `${material.entityId}-new-plan`; material.designHash = 'TEST新设计';
  usePetStoryStore.setState({ project }); return id;
}

describe('产品运行时按钮到主进程请求', (): void => {
  it('已有五镜头仍可分析候选、补资产和定点审查修订，不传入 renderer 撰写正文', async (): Promise<void> => {
    const original = structuredClone(project.plan);
    await usePetStoryStore.getState().analyze(); await finishCurrent();
    await usePetStoryStore.getState().extractAssets(); await finishCurrent();
    await usePetStoryStore.getState().reviewContent({ shotId: 'shot_2', promptKind: 'lastFrame' }); await finishCurrent();
    const reviewId = project.jobs.at(-1)!.id;
    await usePetStoryStore.getState().reviseContent(reviewId, { shotId: 'shot_2', promptKind: 'lastFrame' });
    expect(prepareRuntime.mock.calls.map((call): unknown => call.slice(2))).toEqual([
      ['analysis', undefined], ['assets', undefined], ['review', { shotId: 'shot_2', promptKind: 'lastFrame' }], ['revise', { shotId: 'shot_2', promptKind: 'lastFrame', parentJobId: reviewId }]]);
    expect(tasks).toHaveLength(4); expect(tasks.every((task): boolean => task.mode === 'chat')).toBe(true);
    expect(usePetStoryStore.getState().project!.plan).toEqual(original);
    expect(usePetStoryStore.getState().error).toBe('');
  });
  it('全部资产文字按当前动态清单串行运行，收取前不创建下一个任务', async (): Promise<void> => {
    project.materials = project.plan!.characters.map((character): NonNullable<PetStoryProject['materials']>[number] => ({ id: `character:${character.id}`, kind: 'character', entityId: character.id, name: character.name, designHash: 'TEST-design', prompt: { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST' } }));
    usePetStoryStore.setState({ project });
    await usePetStoryStore.getState().regenerateAllMaterialPrompts();
    expect(tasks).toHaveLength(1);
    for (let index = 0; index < project.materials.length; index++) {
      expect(prepareRuntime.mock.calls[index][2]).toBe('materialPrompt');
      expect(prepareRuntime.mock.calls[index][3]).toEqual({ materialId: project.materials[index].id });
      await finishCurrent();
      expect(tasks).toHaveLength(Math.min(project.materials.length, index + 2));
    }
    expect(usePetStoryStore.getState().promptBatch).toEqual({ total: project.materials.length, completed: project.materials.length, status: 'complete' });
  });
  it('采用携带明确 job ID 与当前 revision，区别于用户手改保存', async (): Promise<void> => {
    await usePetStoryStore.getState().adoptPlanCandidate('plan-reply');
    await usePetStoryStore.getState().adoptAssetsCandidate('assets-reply');
    await usePetStoryStore.getState().adoptPromptCandidate('prompt-reply');
    expect(adoptPlanCandidate).toHaveBeenCalledWith(project.id, project.revision, 'plan-reply');
    expect(adoptAssetsCandidate).toHaveBeenCalledWith(project.id, project.revision, 'assets-reply');
    expect(adoptPromptCandidate).toHaveBeenCalledWith(project.id, project.revision, 'prompt-reply');
    expect(tasks).toHaveLength(0);
  });
  it('一次格式纠正沿主进程运行时传递父请求，且不自行补造正文', async (): Promise<void> => {
    project.jobs.push({ id: 'invalid-reply', taskId: 'original-task', kind: 'optimize', status: 'invalid', inputHash: 'TEST', sourceUrl: '', sourceStoryId: project.mobileStory!.id, requestId: 'original-request', rawText: '{ TEST 部分回复' });
    usePetStoryStore.setState({ project });
    await usePetStoryStore.getState().correctOnce('invalid-reply');
    expect(prepareRuntime).toHaveBeenCalledWith(project.id, 8, 'repair', { parentJobId: 'invalid-reply', repairMode: 'explicit' });
    expect(project.jobs[0].rawText).toBe('{ TEST 部分回复');
  });
  it('批次首项具体缺项只转交一次修订，修订成功后再继续下一个动态目标', async (): Promise<void> => {
    await usePetStoryStore.getState().regenerateAllPrompts();
    const original = project.jobs[0];
    collectChat.mockImplementationOnce(async (): Promise<PetStoryResult> => {
      project = structuredClone(project); project.revision++;
      project.jobs[0].status = 'invalid'; project.jobs[0].error = 'TEST 缺少目标素材标签'; project.jobs[0].rawText = 'TEST 原候选';
      return { success: false, project, error: project.jobs[0].error, needsRepair: true };
    });
    await usePetStoryStore.getState().collect(original.id, true);
    expect(tasks).toHaveLength(2); expect(project.jobs[1]).toMatchObject({ kind: 'repair', parentJobId: original.id });
    expect(usePetStoryStore.getState().promptBatch).toMatchObject({ completed: 0, status: 'running' });
    await usePetStoryStore.getState().collect(project.jobs[1].id, true);
    expect(tasks).toHaveLength(3); expect(project.jobs[2].kind).toBe('optimize');
    expect(usePetStoryStore.getState().promptBatch).toMatchObject({ completed: 1, status: 'running' });
  });
  it('同项一次修订仍失败时暂停批次，完整候选留在项目中且不创建第三次请求', async (): Promise<void> => {
    await usePetStoryStore.getState().regenerateAllPrompts();
    const failCandidate = async (_id: string, jobId: string): Promise<PetStoryResult> => {
      project = structuredClone(project); project.revision++;
      const job = project.jobs.find((item): boolean => item.id === jobId)!;
      job.status = 'invalid'; job.rawText = 'TEST 不合格完整候选'; job.error = 'TEST 具体缺项';
      return { success: false, project, error: job.error, needsRepair: job.kind !== 'repair' };
    };
    collectChat.mockImplementationOnce(failCandidate).mockImplementationOnce(failCandidate);
    await usePetStoryStore.getState().collect(project.jobs[0].id, true);
    await usePetStoryStore.getState().collect(project.jobs[1].id, true);
    expect(tasks).toHaveLength(2); expect(project.jobs[1].rawText).toBe('TEST 不合格完整候选');
    expect(usePetStoryStore.getState().promptBatch).toMatchObject({ completed: 0, status: 'paused' });
  });
  it('当前画布实际渲染分镜候选、空间说明和逐项审查入口，查看不发请求', (): void => {
    project.plan!.understanding = 'TEST 当前剧本理解'; project.plan!.sceneDesign = 'TEST 全场空间连续性';
    project.jobs.push({ id: 'candidate-reply', taskId: 'candidate-task', kind: 'analysis', status: 'applied', inputHash: 'TEST', sourceUrl: '', sourceStoryId: project.mobileStory!.id, requestId: 'candidate-request', rulesVersion: 'TEST-runtime', ruleFiles: ['TEST/storyboard.md'], resultStatus: 'candidate', parsedResult: { plan: structuredClone(project.plan) }, rawText: 'TEST 原回复记录' });
    const html = renderToStaticMarkup(React.createElement(PetStoryRuntime, { project, disabled: false }));
    expect(html).toContain('重新分析，生成新方案候选'); expect(html).toContain('补齐人物／道具／场景'); expect(html).toContain('确认并采用方案');
    expect(html).toContain('TEST 当前剧本理解'); expect(html).toContain('TEST 全场空间连续性');
    const promptHtml = renderToStaticMarkup(React.createElement(CanvasPromptEditor, { project, shot: project.plan!.shots[0], kind: 'video', disabled: false, generationBlocked: false, dirtyChanged: (): void => undefined }));
    expect(promptHtml).toContain('审查本项正文');
    // 媒体节点按本镜资格显示缺项，提示词不重复整项目的素材阻断。
    expect(promptHtml).not.toContain('基础图片尚未全部采用');
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(tasks).toHaveLength(0);
  });
  it('当前文字模型选择与有界编辑意图沿原 materialPrompt 入口传递，不触发媒体', async (): Promise<void> => {
    const selected = capability(); const editIntent: PetStoryMaterialEditIntent = { baseAssetId: 'TEST-base', changes: 'TEST变化', preserve: 'TEST保持', validity: 'TEST范围' };
    usePetStoryStore.setState({ capability: selected });
    await usePetStoryStore.getState().regenerateMaterialPrompt('scene:location', editIntent);
    expect(prepareRuntime).toHaveBeenCalledWith(project.id, 8, 'materialPrompt', { materialId: 'scene:location', editIntent, capability: selected });
    expect(generateMaterials).not.toHaveBeenCalled(); expect(tasks).toHaveLength(1); expect(tasks[0].mode).toBe('chat');
  });
  it('重开恢复实际模型选择，文字和媒体均无需检查记录', async (): Promise<void> => {
    project.promptCapability = capability();
    await usePetStoryStore.getState().openProject();
    expect(usePetStoryStore.getState().capability).toEqual(project.promptCapability);
    window.electronAPI.petstory.advanceProduction = vi.fn(async (): Promise<PetStoryResult> => ({ success: true, project }));
    await usePetStoryStore.getState().generateMaterials(['scene:location']); expect(generateMaterials).toHaveBeenCalledWith(project.id, project.revision, ['scene:location'], project.promptCapability);
    await usePetStoryStore.getState().optimize(project.plan!.shots[0].id, 'video');
    expect(prepareRuntime.mock.calls[0][3]?.capability).toEqual(project.promptCapability);
  });
  it('按路径打开复用同一正常打开与画布恢复入口，打开本身不调用文字或媒体', async (): Promise<void> => {
    const entered = '/OFFLINE/原五镜头/project.json';
    await usePetStoryStore.getState().openProject(entered);
    expect(openProject).toHaveBeenCalledWith(entered); expect(usePetStoryStore.getState().project?.id).toBe(project.id);

    const html = renderToStaticMarkup(React.createElement(PetStoryOpenProject));
    expect(html).toContain('打开项目'); expect(html).toContain('按路径打开');
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(generateMaterials).not.toHaveBeenCalled(); expect(tasks).toHaveLength(0);
  });
  it.each([undefined, 'https://www.doubao.com/chat/', 'https://www.doubao.com/chat', 'https://www.doubao.com/chat/local_OFFLINE-temporary', 'https://www.doubao.com/chat/OFFLINE-original'])('原运行只读恢复按具体会话定位而非字符串非空判断：%s', async (url?: string): Promise<void> => {
    const dispatchEvent = vi.fn(); Object.assign(window, { dispatchEvent });
    vi.stubGlobal('CustomEvent', class { constructor(public readonly type: string, public readonly options: object) {} });
    await usePetStoryStore.getState().optimize(project.plan!.shots[0].id, 'firstFrame');
    const job = project.jobs.at(-1)!; const task = tasks.at(-1)!;
    task.status = 'paused'; task.runtime!.submittedAt = now; task.runtime!.conversationUrl = url;
    const beforeCount = tasks.length; const prompt = task.prompt; const runId = task.runtime!.runId;
    await usePetStoryStore.getState().recoverChat(job.id);
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'reconcile-task-submission', options: { detail: { taskId: task.id, useCurrentPage: !url?.includes('OFFLINE-original') } } }));
    expect(tasks).toHaveLength(beforeCount); expect(task.prompt).toBe(prompt); expect(task.runtime!.runId).toBe(runId); expect(task.runtime!.submittedAt).toBe(now);
    expect(prepareRuntime).toHaveBeenCalledTimes(1); expect(generateMaterials).not.toHaveBeenCalled();
  });
  it.each(['ambiguous', 'conflict'] as const)('原会话%s时只读恢复不派发当前页面兜底、不重发', async (kind: 'ambiguous' | 'conflict'): Promise<void> => {
    const dispatchEvent = vi.fn(); Object.assign(window, { dispatchEvent });
    await usePetStoryStore.getState().optimize(project.plan!.shots[0].id, 'firstFrame');
    const job = project.jobs.at(-1)!; const task = tasks.at(-1)!;
    task.status = 'paused'; task.runtime!.submittedAt = now;
    if (kind === 'ambiguous') task.artifacts = ['OFFLINE-a', 'OFFLINE-b'].map((id): NonNullable<Task['artifacts']>[number] => ({ id, kind: 'file', source: 'page', runId: task.runtime!.runId, url: `https://OFFLINE.invalid/${id}`, conversationUrl: `https://www.doubao.com/chat/${id}`, discoveredAt: now }));
    else {
      task.runtime!.conversationUrl = 'https://www.doubao.com/chat/OFFLINE-a';
      task.runtime!.acceptanceObservation = { schemaVersion: 1, accountId: project.accountId, runId: task.runtime!.runId, conversationUrl: 'https://www.doubao.com/chat/OFFLINE-b', acceptedAt: now, evidence: { kind: 'prompt_published' }, cursor: { messageCount: 1, pollCount: 0 }, expectedArtifact: { kind: 'file', runId: task.runtime!.runId }, lease: { ownerId: 'OFFLINE', acquiredAt: now, expiresAt: now, lastHeartbeatAt: now }, outcome: 'observing' };
    }
    await usePetStoryStore.getState().recoverChat(job.id);
    expect(dispatchEvent).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().error).toContain('绑定冲突');
    expect(tasks).toHaveLength(1); expect(prepareRuntime).toHaveBeenCalledTimes(1); expect(task.runtime!.submittedAt).toBe(now);
  });
  it.each(['stopped', 'cancelled', 'persist_failure'] as const)('未发送原任务%s后沿startBoundChat正式hold重入队，绑定新run且不创建新请求', async (state: string): Promise<void> => {
    await usePetStoryStore.getState().optimize(project.plan!.shots[0].id, 'firstFrame'); const job = project.jobs[0]; const task = tasks[0];
    job.requestText = task.prompt;
    task.status = state === 'cancelled' ? 'cancelled' : 'waiting_verification'; task.errorInfo = { code: state === 'cancelled' ? 'cancelled' : 'page_unrecognized', message: 'TEST提交前阻断', recoverable: true, detectedAt: now };
    task.runtime = { runId: job.runId!, attempt: 1, stage: 'waiting_verification', message: 'TEST未发送', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { prompt: task.prompt, mode: 'chat', attachments: [] } };
    const bind = vi.fn(window.electronAPI.petstory.bindRun); window.electronAPI.petstory.bindRun = bind;
    const start = vi.fn(async (taskId: string, beforeDispatch?: (target: Task) => Promise<void>): Promise<boolean> => {
      const target = tasks.find((item): boolean => item.id === taskId)!;
      expect(target).toMatchObject({ id: task.id, status: 'queued', executionIntent: 'hold' });
      target.runtime = { ...target.runtime!, runId: 'TEST-new-formally-bound-run', attempt: 2, stage: 'injecting_prompt' };
      await beforeDispatch?.(target); return true;
    });
    useTaskStore.setState({ startAutomation: start });
    if (state === 'persist_failure') {
      retryUnsubmitted.mockImplementationOnce(async (): Promise<PetStoryResult> => {
        project = structuredClone(project); project.revision++; project.jobs[0].runId = undefined;
        return { success: false, project, error: 'TEST旧绑定已解除但TaskService重入队持久化失败' };
      });
      await usePetStoryStore.getState().startBoundChat(job.id);
      expect(project.jobs[0].runId).toBeUndefined(); expect(task.runtime!.runId).toBe(job.runId); expect(start).not.toHaveBeenCalled();
    }
    await usePetStoryStore.getState().startBoundChat(job.id);
    expect(retryUnsubmitted).toHaveBeenCalledWith(project.id, job.id); expect(start).toHaveBeenCalledTimes(1);
    expect(retryUnsubmitted).toHaveBeenCalledTimes(state === 'persist_failure' ? 2 : 1);
    expect(bind).toHaveBeenCalledWith(project.id, job.id, 'TEST-new-formally-bound-run');
    expect(project.jobs).toHaveLength(1); expect(tasks).toHaveLength(1); expect(prepareRuntime).toHaveBeenCalledTimes(1);
    expect(project.jobs[0].runId).toBe('TEST-new-formally-bound-run'); expect(task.runtime?.submittedAt).toBeUndefined(); expect(usePetStoryStore.getState().error).toBe('');
  });
  it.each(['submitted', 'ended', 'run', 'occupied'] as const)('原任务%s证据禁止startBoundChat进入重入队或发送', async (change: string): Promise<void> => {
    await usePetStoryStore.getState().optimize(project.plan!.shots[0].id, 'firstFrame'); const job = project.jobs[0]; const task = tasks[0];
    task.status = 'paused'; task.errorInfo = { code: 'page_loading', message: 'TEST提交前阻断', recoverable: true, detectedAt: now };
    task.runtime = { runId: job.runId!, attempt: 1, stage: 'paused', message: 'TEST未发送', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { prompt: task.prompt, mode: 'chat', attachments: [] } };
    if (change === 'submitted') task.runtime.submittedAt = now;
    if (change === 'ended') job.endedWaitingAt = now;
    if (change === 'run') task.runtime.runId = 'TEST-unrelated-run';
    if (change === 'occupied') useTaskStore.setState({ accountBusy: { [project.accountId]: true } });
    const start = vi.fn(async (): Promise<boolean> => true); useTaskStore.setState({ startAutomation: start });
    await usePetStoryStore.getState().startBoundChat(job.id);
    expect(retryUnsubmitted).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1); expect(project.jobs).toHaveLength(1); expect(usePetStoryStore.getState().error).toContain('请只读核对');
  });
  it('基础素材卡只显示图片操作，查看素材不调用豆包或媒体', (): void => {
    project.materials = [{ id: 'scene:location', entityId: 'location', name: 'TEST地点', kind: 'scene', designHash: 'TEST', selectedAssetId: 'TEST-base', prompt: { original: 'TEST', optimized: 'TEST', final: 'TEST', edited: false, rulesVersion: 'TEST' } }];
    project.assets = [{ id: 'TEST-base', kind: 'scene', materialId: 'scene:location', relativePath: 'materials/TEST.png' }];
    project.storyApproval = { hash: 'TEST', at: now }; usePetStoryStore.setState({ project });
    const html = renderToStaticMarkup(React.createElement(PetStoryMaterials, { project, disabled: false }));
    expect(html).toContain('查看图片'); expect(html).toContain('图片待确认');
    for (const text of ['变体／局部编辑计划', '生成提示词', '采用提示词', '更多操作', '查看与编辑图片提示词', '生成记录／诊断详情']) expect(html).not.toContain(text);
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(generateMaterials).not.toHaveBeenCalled();
  });
  it('补齐入口只使用主进程当前资格清单，已手改且有新候选时不自行循环生成', async (): Promise<void> => {
    const target = { shotId: 'shot_3', kind: 'video' as const };
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [target], pendingCandidateJobIds: ['TEST-current-candidate'] });
    await usePetStoryStore.getState().continuePromptStage();
    expect(promptStageTargets).toHaveBeenCalledWith(project.id, 8);
    expect(prepareRuntime.mock.calls[0].slice(2)).toEqual(['optimize', { shotId: target.shotId, promptKind: target.kind }]);
    expect(usePetStoryStore.getState().error).toContain('新候选待采用'); expect(usePetStoryStore.getState().error).toContain('下游仍引用');
    await finishCurrent(); expect(tasks).toHaveLength(1);
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [], pendingCandidateJobIds: ['TEST-current-candidate'] });
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(1); expect(usePetStoryStore.getState().promptBatch).toMatchObject({ status: 'complete', total: 0 });
    expect(generateMaterials).not.toHaveBeenCalled();
  });
  it('启动失败先保留原任务关联并保存暂停；重复继续只提示只读恢复，不再创建请求', async (): Promise<void> => {
    useTaskStore.setState({ startAutomation: async (): Promise<boolean> => false, error: 'TEST启动未完成' });
    await usePetStoryStore.getState().regenerateAllPrompts();
    expect(tasks).toHaveLength(1); expect(project.promptBatch).toMatchObject({ status: 'paused', jobId: project.jobs[0].id, completed: 0 });
    expect(usePetStoryStore.getState().error).toContain('TEST启动未完成');
    for (let index = 0; index < 2; index++) {
      await usePetStoryStore.getState().continuePromptStage();
      expect(usePetStoryStore.getState().error).toContain('只读重新收取');
    }
    expect(tasks).toHaveLength(1); expect(prepareRuntime).toHaveBeenCalledTimes(1); expect(project.promptBatch?.status).toBe('paused');
  });
  it('批次停止并重开后不自动发送；原结果已收取只推进一次到保存的下一目标', async (): Promise<void> => {
    await usePetStoryStore.getState().regenerateAllPrompts(); const original = project.jobs[0];
    await usePetStoryStore.getState().stopPromptBatch(); expect(project.promptBatch?.status).toBe('paused');
    await usePetStoryStore.getState().collect(original.id); expect(tasks).toHaveLength(1);
    await usePetStoryStore.getState().openProject();
    expect(tasks).toHaveLength(1); expect(usePetStoryStore.getState().promptBatch).toMatchObject({ status: 'paused', completed: 0 });
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(2); expect(project.jobs[1]).toMatchObject({ shotId: 'shot_1', promptKind: 'video' });
    expect(project.promptBatch).toMatchObject({ status: 'running', completed: 1, jobId: project.jobs[1].id });
  });
  it('已失败候选重开继续保持暂停，等待新的明确修订操作，不自动重发', async (): Promise<void> => {
    await usePetStoryStore.getState().regenerateAllPrompts(); await usePetStoryStore.getState().stopPromptBatch();
    project.jobs[0].status = 'invalid'; project.jobs[0].rawText = 'TEST离线失败原回复';
    usePetStoryStore.setState({ project }); await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(1); expect(usePetStoryStore.getState().error).toContain('明确修订'); expect(project.promptBatch?.status).toBe('paused');
  });
  it.each(['regenerate', 'revise'] as const)('旧invalid批次目标经后来明确%s并采用且当前资格通过后，继续消耗该目标并发送保存的下一项', async (operation: 'regenerate' | 'revise'): Promise<void> => {
    const original = await failOriginalBatch(); const first = project.promptBatch!.targets[0]; const next = project.promptBatch!.targets[1];
    const target = { shotId: original.shotId!, promptKind: original.promptKind! };
    if (operation === 'revise') {
      await usePetStoryStore.getState().reviewContent(target); await finishCurrent();
      await usePetStoryStore.getState().reviseContent(project.jobs.at(-1)!.id, target);
    } else await usePetStoryStore.getState().optimize(target.shotId, target.promptKind);
    const replacement = project.jobs.at(-1)!; await finishCurrent();
    adoptPromptCandidate.mockImplementationOnce(async (): Promise<PetStoryResult> => adoptOfflinePrompt(replacement.id));
    await usePetStoryStore.getState().adoptPromptCandidate(replacement.id);
    const before = tasks.length; const remaining = project.promptBatch!.targets.slice(1);
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: remaining, pendingCandidateJobIds: [] });
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(before + 1); expect(project.jobs.at(-1)).toMatchObject({ shotId: next.shotId, promptKind: next.kind });
    expect(project.promptBatch).toMatchObject({ status: 'running', total: 13, completed: 1, targets: remaining, jobId: project.jobs.at(-1)!.id });
    expect(project.promptBatch!.targets).not.toContainEqual(first);
    expect(project.jobs[0]).toMatchObject({ id: original.id, status: 'invalid', rawText: 'TEST离线原失败回复' });
    expect(project.plan!.shots[0].prompts.firstFrame.sourceJobId).toBe(replacement.id);
    expect(generateMaterials).not.toHaveBeenCalled();
  });
  it.each(['candidate', 'invalid', 'ended'] as const)('旧invalid之后的新%s仍未解决原目标时，继续保持暂停且不隐式重发', async (state: 'candidate' | 'invalid' | 'ended'): Promise<void> => {
    const original = await failOriginalBatch(); const target = { shotId: original.shotId!, kind: original.promptKind! };
    const originalFinal = project.plan!.shots[0].prompts.firstFrame.final;
    await usePetStoryStore.getState().optimize(target.shotId, target.kind); const replacement = project.jobs.at(-1)!;
    if (state === 'ended') await usePetStoryStore.getState().endChatWaiting(replacement.id);
    else {
      await finishCurrent(); const current = project.jobs.find((job): boolean => job.id === replacement.id)!;
      current.status = state === 'invalid' ? 'invalid' : 'applied'; current.resultStatus = state === 'candidate' ? 'candidate' : undefined;
      current.parsedResult = { optimized: snapshot.plan.shots[0].prompts.firstFrame.optimized };
      usePetStoryStore.setState({ project });
    }
    const before = tasks.length;
    // 合格未采用候选会使缺项清单排除此目标；宿主仍必须核对“已采用”，不能当完成。
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: state === 'candidate' ? [] : [target], pendingCandidateJobIds: state === 'candidate' ? [replacement.id] : [] });
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(before); expect(project.promptBatch).toMatchObject({ status: 'paused', completed: 0, jobId: original.id });
    expect(project.plan!.shots[0].prompts.firstFrame.final).toBe(originalFinal);
    expect(project.jobs[0]).toMatchObject({ id: original.id, status: 'invalid', rawText: 'TEST离线原失败回复' });
    expect(usePetStoryStore.getState().error).toContain('继续不会自动重发');
  });
  it('后来明确采用过新结果，但主进程仍判当前模型或事实需修订时，不消费旧invalid目标', async (): Promise<void> => {
    const original = await failOriginalBatch();
    await usePetStoryStore.getState().optimize(original.shotId!, original.promptKind!); const replacement = project.jobs.at(-1)!;
    adoptPromptCandidate.mockImplementationOnce(async (): Promise<PetStoryResult> => adoptOfflinePrompt(replacement.id));
    await usePetStoryStore.getState().adoptPromptCandidate(replacement.id);
    const before = tasks.length;
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [{ shotId: original.shotId!, kind: original.promptKind! }], pendingCandidateJobIds: [] });
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(before); expect(project.promptBatch).toMatchObject({ status: 'paused', completed: 0, jobId: original.id });
    expect(project.jobs[0].status).toBe('invalid'); expect(usePetStoryStore.getState().error).toContain('继续不会自动重发');
  });
  it.each(['bound', 'captured'] as const)('原批次%s任务即使另有已采用同目标结果也仍先只读收取或结束等待', async (state: 'bound' | 'captured'): Promise<void> => {
    const original = await failOriginalBatch();
    await usePetStoryStore.getState().optimize(original.shotId!, original.promptKind!); const replacement = project.jobs.at(-1)!;
    adoptPromptCandidate.mockImplementationOnce(async (): Promise<PetStoryResult> => adoptOfflinePrompt(replacement.id));
    await usePetStoryStore.getState().adoptPromptCandidate(replacement.id);
    project.jobs.find((job): boolean => job.id === original.id)!.status = state; usePetStoryStore.setState({ project });
    const before = tasks.length;
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(before); expect(promptStageTargets).not.toHaveBeenCalled();
    expect(project.promptBatch).toMatchObject({ status: 'paused', completed: 0 });
    expect(usePetStoryStore.getState().error).toContain('只读重新收取或明确结束等待');
  });
  it('重开前applied结果已因目标变化失效时，用户本次继续重新按当前资格创作，不把旧完成计入', async (): Promise<void> => {
    await usePetStoryStore.getState().regenerateAllPrompts(); const original = project.jobs[0];
    await usePetStoryStore.getState().stopPromptBatch(); await usePetStoryStore.getState().collect(original.id);
    const targets = [{ shotId: original.shotId!, kind: original.promptKind! }];
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: targets }).mockResolvedValueOnce({ success: true, project, promptTargets: targets });
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(2); expect(project.jobs[0].id).toBe(original.id);
    expect(project.jobs[1]).toMatchObject({ shotId: original.shotId, promptKind: original.promptKind });
    expect(project.promptBatch).toMatchObject({ total: 1, completed: 0, jobId: project.jobs[1].id, status: 'running' });
  });
  it('旧素材批次暂停后正常重新分析并采用动态新ID方案，打开与采用不发送，明确继续才重取当前目标', async (): Promise<void> => {
    installOriginalMaterialContainers();
    await usePetStoryStore.getState().regenerateAllMaterialPrompts(); const original = project.jobs[0];
    await usePetStoryStore.getState().stopPromptBatch(); await usePetStoryStore.getState().collect(original.id);
    const oldTargets = structuredClone(project.promptBatch!.targets);
    await usePetStoryStore.getState().analyze(); await finishCurrent(); const analysis = project.jobs.at(-1)!;
    const nextId = `${project.materials![0].id}-new-plan`;
    adoptPlanCandidate.mockImplementationOnce(async (): Promise<PetStoryResult> => {
      project = structuredClone(project); project.revision++;
      project.plan!.characters[0].id = `${project.plan!.characters[0].id}-new-plan`;
      replaceFirstMaterialId(); return { success: true, project };
    });
    await usePetStoryStore.getState().adoptPlanCandidate(analysis.id); await usePetStoryStore.getState().openProject();
    expect(tasks).toHaveLength(2); expect(promptStageTargets).not.toHaveBeenCalled();
    expect(project.promptBatch).toMatchObject({ targets: oldTargets, status: 'paused', jobId: original.id });
    const currentTargets = [{ materialId: nextId }];
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: currentTargets, pendingCandidateJobIds: [] });
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(3); expect(project.jobs.at(-1)).toMatchObject({ kind: 'materialPrompt', materialId: nextId });
    expect(project.promptBatch).toMatchObject({ total: 1, completed: 0, targets: currentTargets, status: 'running' });
    expect(project.jobs.find((job): boolean => job.id === original.id)).toMatchObject({ status: 'applied', taskId: original.taskId });
    expect(usePetStoryStore.getState().error).toContain('旧设计的文字批次已过期');
    expect(prepareRuntime.mock.calls.slice(2).every((call): boolean => call[3]?.materialId !== original.materialId)).toBe(true);
  });
  it.each(['invalid', 'ended'] as const)('原%s记录保留且目标容器已删除时，明确继续重算当前缺失目标，不重发旧目标', async (state: 'invalid' | 'ended'): Promise<void> => {
    installOriginalMaterialContainers();
    await usePetStoryStore.getState().regenerateAllMaterialPrompts(); const original = project.jobs[0];
    if (state === 'ended') {
      tasks[0].runtime!.submittedAt = now;
      await usePetStoryStore.getState().endChatWaiting(original.id);
    } else {
      await usePetStoryStore.getState().stopPromptBatch();
      project.jobs[0].status = 'invalid'; project.jobs[0].rawText = 'TEST离线原失败回复';
    }
    const oldRecord = structuredClone(project.jobs[0]); const nextId = replaceFirstMaterialId();
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [{ materialId: nextId }], pendingCandidateJobIds: [] });
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(2); expect(project.jobs[1]).toMatchObject({ kind: 'materialPrompt', materialId: nextId });
    expect(project.jobs[0]).toEqual(oldRecord); expect(tasks[0].runtime!.submittedAt).toBe(state === 'ended' ? now : undefined);
    expect(project.promptBatch).toMatchObject({ total: 1, completed: 0, targets: [{ materialId: nextId }] });
    expect(usePetStoryStore.getState().error).toContain('旧设计的文字批次已过期');
  });
  it.each(['bound', 'captured'] as const)('原%s尚未结束等待，即使目标删除也先只读核对，不借新方案重算发送', async (state: 'bound' | 'captured'): Promise<void> => {
    installOriginalMaterialContainers();
    await usePetStoryStore.getState().regenerateAllMaterialPrompts(); const original = project.jobs[0];
    await usePetStoryStore.getState().stopPromptBatch(); project.jobs[0].status = state;
    replaceFirstMaterialId();
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(1); expect(promptStageTargets).not.toHaveBeenCalled();
    expect(project.promptBatch).toMatchObject({ status: 'paused', completed: 0, jobId: original.id });
    expect(usePetStoryStore.getState().error).toContain('只读重新收取或明确结束等待');
  });
  it('任一保存的后续镜头正文容器删除也重算，不能只检查首项并发送已删除尾帧', async (): Promise<void> => {
    await usePetStoryStore.getState().regenerateAllPrompts(); const original = project.jobs[0];
    await usePetStoryStore.getState().stopPromptBatch(); await usePetStoryStore.getState().collect(original.id);
    const tailShot = project.plan!.shots.find((shot): boolean => !!shot.prompts.lastFrame)!;
    const removed = { shotId: tailShot.id, kind: 'lastFrame' as const }; delete tailShot.prompts.lastFrame;
    usePetStoryStore.setState({ project });
    const current = [{ shotId: project.plan!.shots.at(-1)!.id, kind: 'video' as const }];
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: current, pendingCandidateJobIds: [] });
    await usePetStoryStore.getState().continuePromptStage();
    expect(project.jobs.at(-1)).toMatchObject({ shotId: current[0].shotId, promptKind: current[0].kind });
    expect(project.promptBatch).toMatchObject({ total: 1, completed: 0, targets: current });
    expect(project.promptBatch!.targets).not.toContainEqual(removed); expect(tasks).toHaveLength(2);
    expect(project.jobs[0]).toMatchObject({ id: original.id, status: 'applied' });
  });
  it('重算新设计仍保留手改候选和结束等待过滤，不把旧队列删除当作这些目标已采用', async (): Promise<void> => {
    installOriginalMaterialContainers();
    await usePetStoryStore.getState().regenerateAllMaterialPrompts(); const original = project.jobs[0];
    await usePetStoryStore.getState().stopPromptBatch(); await usePetStoryStore.getState().collect(original.id);
    replaceFirstMaterialId();
    const shot = project.plan!.shots[0]; const manual = shot.prompts.firstFrame.final;
    shot.prompts.firstFrame.edited = true; shot.prompts.firstFrame.optimized = 'TEST仅离线新候选';
    const ended: PetStoryChatJob = { ...original, id: 'TEST-ended-current-target', taskId: 'TEST-ended-task', materialId: undefined, kind: 'optimize', shotId: shot.id, promptKind: 'video', endedWaitingAt: now };
    const candidate: PetStoryChatJob = { ...original, id: 'TEST-manual-candidate', taskId: 'TEST-candidate-task', materialId: undefined, kind: 'optimize', shotId: shot.id, promptKind: 'firstFrame', resultStatus: 'candidate' };
    project.jobs.push(ended, candidate); usePetStoryStore.setState({ project });
    const next = { shotId: project.plan!.shots[1].id, kind: 'video' as const };
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [{ shotId: shot.id, kind: 'video' }, next], pendingCandidateJobIds: [candidate.id] });
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(2); expect(project.jobs.at(-1)).toMatchObject({ shotId: next.shotId, promptKind: next.kind });
    expect(project.plan!.shots[0].prompts.firstFrame).toMatchObject({ final: manual, optimized: 'TEST仅离线新候选', edited: true });
    expect(project.jobs.find((job): boolean => job.id === ended.id)?.endedWaitingAt).toBe(now);
    expect(usePetStoryStore.getState().error).toContain('新候选待采用'); expect(usePetStoryStore.getState().error).toContain('本次只补齐其他目标');
    expect(usePetStoryStore.getState().error).toContain('旧设计的文字批次已过期');
  });
  it('删除目标但原saved job记录缺失时保留暂停，不推断原任务已经结束而重发', async (): Promise<void> => {
    installOriginalMaterialContainers();
    await usePetStoryStore.getState().regenerateAllMaterialPrompts(); const jobId = project.jobs[0].id;
    await usePetStoryStore.getState().stopPromptBatch(); project.jobs = []; replaceFirstMaterialId();
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(1); expect(promptStageTargets).not.toHaveBeenCalled();
    expect(project.promptBatch).toMatchObject({ status: 'paused', jobId });
    expect(usePetStoryStore.getState().error).toContain('原任务归属或状态尚未明确');
  });
  it('批次期间更改文字模型暂停后续，原运行保留且晚收取不自动启动另一目标', async (): Promise<void> => {
    await usePetStoryStore.getState().regenerateAllPrompts(); const original = project.jobs[0];
    await usePetStoryStore.getState().savePromptModel('seedance-2.5');
    expect(project.promptModel).toBe('seedance-2.5'); expect(project.promptBatch).toMatchObject({ status: 'paused', jobId: original.id });
    await usePetStoryStore.getState().collect(original.id);
    expect(tasks).toHaveLength(1); expect(usePetStoryStore.getState().promptBatch.status).toBe('paused');
  });
  it('结束等待后继续仅补其他目标，原任务和原目标不被隐式重新创建', async (): Promise<void> => {
    await usePetStoryStore.getState().regenerateAllPrompts(); const original = project.jobs[0];
    await usePetStoryStore.getState().endChatWaiting(original.id);
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [{ shotId: original.shotId!, kind: original.promptKind! }, { shotId: 'shot_3', kind: 'video' }] });
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(2); expect(project.jobs[0].endedWaitingAt).toBe(now); expect(project.jobs[1]).toMatchObject({ shotId: 'shot_3', promptKind: 'video' });
    expect(usePetStoryStore.getState().error).toContain('本次只补齐其他目标');
  });
  it('两个不同目标先后结束等待后，多次继续与重开均排除全部未解决目标，不只排除最近一项', async (): Promise<void> => {
    await usePetStoryStore.getState().regenerateAllPrompts(); const first = project.jobs[0];
    tasks[0].runtime!.submittedAt = now;
    await usePetStoryStore.getState().endChatWaiting(first.id);
    const firstTarget = { shotId: first.shotId!, kind: first.promptKind! };
    const secondTarget = { shotId: 'shot_3', kind: 'video' as const };
    const thirdTarget = { shotId: 'shot_4', kind: 'video' as const };
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [firstTarget, secondTarget, thirdTarget] });
    await usePetStoryStore.getState().continuePromptStage();
    const second = project.jobs[1];
    expect(second).toMatchObject({ shotId: secondTarget.shotId, promptKind: secondTarget.kind });
    tasks[1].runtime!.submittedAt = now;
    await usePetStoryStore.getState().endChatWaiting(second.id);
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [firstTarget, secondTarget, thirdTarget] });
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(3); expect(project.jobs[2]).toMatchObject({ shotId: thirdTarget.shotId, promptKind: thirdTarget.kind });
    await finishCurrent(); await usePetStoryStore.getState().openProject();
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [firstTarget, secondTarget] });
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(3); expect(prepareRuntime).toHaveBeenCalledTimes(3);
    expect(project.jobs.slice(0, 2).map((job): string | undefined => job.endedWaitingAt)).toEqual([now, now]);
    expect(tasks.slice(0, 2).map((task): string | undefined => task.runtime?.submittedAt)).toEqual([now, now]);
    expect(usePetStoryStore.getState().error).toContain('明确单项或批量重新生成');
    expect(usePetStoryStore.getState().promptBatch).toMatchObject({ status: 'complete', total: 0 });
    expect(generateMaterials).not.toHaveBeenCalled();
  });
  it.each(['single', 'batch'] as const)('结束等待记录保留，新的明确%s重新生成仍可创建同目标新请求', async (operation: 'single' | 'batch'): Promise<void> => {
    const shotId = project.plan!.shots[0].id;
    await usePetStoryStore.getState().optimize(shotId, 'firstFrame'); const original = project.jobs[0];
    await usePetStoryStore.getState().endChatWaiting(original.id);
    if (operation === 'single') await usePetStoryStore.getState().optimize(shotId, 'firstFrame');
    else await usePetStoryStore.getState().regenerateAllPrompts();
    expect(tasks).toHaveLength(2); expect(project.jobs[0]).toMatchObject({ id: original.id, endedWaitingAt: now });
    expect(project.jobs[1]).toMatchObject({ kind: 'optimize', shotId, promptKind: 'firstFrame' });
    expect(project.jobs[1].id).not.toBe(original.id); expect(project.jobs[1].endedWaitingAt).toBeUndefined();
    expect(generateMaterials).not.toHaveBeenCalled();
  });
  it('结束等待后的新明确创作成功才解除该目标的继续排除，失败与旧请求迟到均不解除', async (): Promise<void> => {
    const target = { shotId: project.plan!.shots[0].id, kind: 'firstFrame' as const };
    await usePetStoryStore.getState().optimize(target.shotId, target.kind); const original = project.jobs[0];
    await usePetStoryStore.getState().endChatWaiting(original.id);
    project.jobs.push({ ...original, id: 'TEST-older-late', taskId: 'TEST-older-late-task', status: 'applied', endedWaitingAt: undefined, createdAt: '2026-10-24T23:59:59.000Z' });
    usePetStoryStore.setState({ project });
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [target] });
    await usePetStoryStore.getState().continuePromptStage(); expect(tasks).toHaveLength(1);
    await usePetStoryStore.getState().optimize(target.shotId, target.kind); const newRound = project.jobs.at(-1)!;
    newRound.status = 'invalid'; usePetStoryStore.setState({ project });
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [target] });
    await usePetStoryStore.getState().continuePromptStage(); expect(tasks).toHaveLength(2);
    await usePetStoryStore.getState().collect(newRound.id);
    project.jobs.find((job): boolean => job.id === newRound.id)!.resultStatus = 'stale'; usePetStoryStore.setState({ project });
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [target] });
    await usePetStoryStore.getState().continuePromptStage(); expect(tasks).toHaveLength(2);
    project.jobs.find((job): boolean => job.id === newRound.id)!.resultStatus = 'adopted'; usePetStoryStore.setState({ project });
    // 模拟新一轮已成功后，后续模型/事实改变导致主进程再次给出该缺项；旧 ended 不成为终身禁用。
    promptStageTargets.mockResolvedValueOnce({ success: true, project, promptTargets: [target] });
    await usePetStoryStore.getState().continuePromptStage();
    expect(tasks).toHaveLength(3); expect(project.jobs[0].endedWaitingAt).toBe(now);
    expect(project.jobs.at(-1)).toMatchObject({ kind: 'optimize', shotId: target.shotId, promptKind: target.kind });
  });
  it('准备中点击停止会留下已创建hold任务及暂停关联，开始回调不会发送', async (): Promise<void> => {
    const normalPrepare = prepareRuntime.getMockImplementation()!;
    let release: () => void = (): void => undefined;
    const pending = new Promise<void>((resolve): void => { release = resolve; });
    prepareRuntime.mockImplementationOnce(async (...args: Parameters<typeof normalPrepare>): Promise<PetStoryResult> => { await pending; return normalPrepare(...args); });
    const start = vi.fn(async (): Promise<boolean> => true); useTaskStore.setState({ startAutomation: start });
    const operation = usePetStoryStore.getState().regenerateAllPrompts();
    await vi.waitFor((): void => { expect(prepareRuntime).toHaveBeenCalledTimes(1); });
    await usePetStoryStore.getState().stopPromptBatch(); release(); await operation;
    expect(tasks).toHaveLength(1); expect(start).not.toHaveBeenCalled();
    expect(project.promptBatch).toMatchObject({ status: 'paused', jobId: project.jobs[0].id, completed: 0 });
    expect(usePetStoryStore.getState().promptBatch.status).toBe('paused');
  });
});
