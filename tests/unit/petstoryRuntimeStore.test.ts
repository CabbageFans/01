/** 离线 UI 接线测试：沿用原五镜夹具，不属于真实豆包文字验收。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Account, PetStoryCapability, PetStoryChatJob, PetStoryMaterialEditIntent, PetStoryPlan, PetStoryProject, PetStoryResult, PetStoryRuntimeTarget, Task } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { PetStoryRuntime } from '../../src/components/PetStoryRuntime';
import { CanvasPromptEditor } from '../../src/components/PetStoryCanvasPrompt';
import { PetStoryMaterials } from '../../src/components/PetStoryMaterials';

const initial = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState(), projects: useProjectStore.getState() };
let project: PetStoryProject;
let tasks: Task[];
const now = '2026-10-25T01:00:00.000Z';
const prepareRuntime = vi.fn(async (_id: string, _revision: number, kind: PetStoryChatJob['kind'], target?: PetStoryRuntimeTarget): Promise<PetStoryResult> => {
  const index = tasks.length + 1; const id = `TEST-job-${index}`; const taskId = `TEST-task-${index}`;
  project = structuredClone(project); project.revision++;
  project.jobs.push({ id, taskId, kind, status: 'bound', inputHash: 'TEST', sourceUrl: '', sourceStoryId: project.mobileStory!.id, requestId: `TEST-request-${index}`, expectedIds: [target?.materialId || target?.shotId || 'story'], ...target });
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
function capability(): PetStoryCapability {
  const entry = { state: 'unknown' as const, free: 'unknown' as const, reason: 'TEST 仅供文字模型选择' };
  return { accountId: project.accountId, checkedAt: now, freeEvidence: 'unknown', durations: [5], image: entry,
    modes: { first_frame: entry, first_last_frame: entry, reference: entry }, videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' } };
}

beforeEach((): void => {
  vi.clearAllMocks(); tasks = [];
  project = { id: 'TEST-project', schemaVersion: 1, studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 8, source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-source', text: snapshot.mobileStory, importedAt: now }, plan: structuredClone(snapshot.plan) as PetStoryPlan, assets: [], jobs: [], updatedAt: now };
  const account: Account = { id: project.accountId, name: 'TEST 原账号', platform: 'doubao', partition: 'TEST', status: 'idle', avatar: '', pinned: false, createdAt: now, updatedAt: now };
  vi.stubGlobal('window', { electronAPI: { petstory: { prepareRuntime, collectChat, adoptPlanCandidate, adoptAssetsCandidate, adoptPromptCandidate, open: openProject, generateMaterials,
    bindRun: async (_id: string, jobId: string, runId: string): Promise<PetStoryResult> => { project.jobs.find((job): boolean => job.id === jobId)!.runId = runId; return { success: true, project }; }, prepareChat: vi.fn((): never => { throw new Error('运行时入口不得回退到 renderer 提示词'); }) }, tasks: { list: async (): Promise<Task[]> => tasks } } });
  useAccountStore.setState({ accounts: [account] });
  useProjectStore.setState({ projects: [{ id: project.studioProjectId, name: 'TEST 原项目', description: '', color: '#fff', archived: false, createdAt: now, updatedAt: now }] });
  useTaskStore.setState({ startAutomation: async (taskId: string, beforeDispatch?: (task: Task) => Promise<void>): Promise<boolean> => { if (beforeDispatch) await beforeDispatch(tasks.find((task): boolean => task.id === taskId)!); return true; } });
  usePetStoryStore.setState({ project, busy: false, error: '', capability: null, capabilityCheckedInSession: false, freeChatConfirmed: true, promptBatch: { total: 0, completed: 0, status: 'idle' } });
});
afterEach((): void => {
  usePetStoryStore.getState().stopPromptBatch();
  usePetStoryStore.setState(initial.petstory); useTaskStore.setState(initial.tasks); useAccountStore.setState(initial.accounts); useProjectStore.setState(initial.projects);
  vi.unstubAllGlobals();
});
async function finishCurrent(): Promise<void> { await usePetStoryStore.getState().collect(project.jobs.at(-1)!.id); }

describe('产品运行时按钮到主进程请求', (): void => {
  it('已有五镜头仍可分析候选、补资产和定点审查修订，不传入 renderer 撰写正文', async (): Promise<void> => {
    const original = structuredClone(project.plan);
    await usePetStoryStore.getState().analyze(); await finishCurrent();
    await usePetStoryStore.getState().extractAssets(); await finishCurrent();
    await usePetStoryStore.getState().reviewContent({ shotId: 'shot_2', promptKind: 'lastFrame' }); await finishCurrent();
    const reviewId = project.jobs.at(-1)!.id;
    await usePetStoryStore.getState().reviseContent(reviewId, { shotId: 'shot_2', promptKind: 'lastFrame' });
    expect(prepareRuntime.mock.calls.map((call): unknown => call.slice(2))).toEqual([
      ['analysis', undefined], ['assets', undefined], ['review', { shotId: 'shot_2', promptKind: 'lastFrame' }], ['revise', { shotId: 'shot_2', promptKind: 'lastFrame', parentJobId: reviewId }],
    ]);
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
    expect(prepareRuntime).toHaveBeenCalledWith(project.id, 8, 'repair', { parentJobId: 'invalid-reply' });
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
    expect(html).toContain('重新分析与设计分镜候选'); expect(html).toContain('补齐人物／道具／场景'); expect(html).toContain('采用此分镜方案');
    expect(html).toContain('TEST 当前剧本理解'); expect(html).toContain('TEST 全场空间连续性');
    const promptHtml = renderToStaticMarkup(React.createElement(CanvasPromptEditor, { project, shot: project.plan!.shots[0], kind: 'video', disabled: false, generationBlocked: false, dirtyChanged: (): void => undefined }));
    expect(promptHtml).toContain('审查本项正文'); expect(promptHtml).toContain('文字计划稿');
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(tasks).toHaveLength(0);
  });
  it('当前文字模型选择与有界编辑意图沿原 materialPrompt 入口传递，不触发媒体', async (): Promise<void> => {
    const selected = capability(); const editIntent: PetStoryMaterialEditIntent = { baseAssetId: 'TEST-base', changes: 'TEST变化', preserve: 'TEST保持', validity: 'TEST范围' };
    usePetStoryStore.setState({ capability: selected });
    await usePetStoryStore.getState().regenerateMaterialPrompt('scene:location', editIntent);
    expect(prepareRuntime).toHaveBeenCalledWith(project.id, 8, 'materialPrompt', { materialId: 'scene:location', editIntent, capability: selected });
    expect(generateMaterials).not.toHaveBeenCalled(); expect(tasks).toHaveLength(1); expect(tasks[0].mode).toBe('chat');
  });
  it('重开恢复文字模型但不恢复媒体授权，仍可用已保存选择生成文字', async (): Promise<void> => {
    project.promptCapability = capability();
    await usePetStoryStore.getState().openProject();
    expect(usePetStoryStore.getState().capability).toEqual(project.promptCapability); expect(usePetStoryStore.getState().capabilityCheckedInSession).toBe(false);
    await usePetStoryStore.getState().generateMaterials(['scene:location']); expect(generateMaterials).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().error).toContain('当前会话核对');
    usePetStoryStore.getState().setFreeChatConfirmed(true);
    await usePetStoryStore.getState().optimize(project.plan!.shots[0].id, 'video');
    expect(prepareRuntime.mock.calls[0][3]?.capability).toEqual(project.promptCapability);
  });
  it('基础素材卡有真实编辑计划表单且查看表单不调用豆包或媒体', (): void => {
    project.materials = [{ id: 'scene:location', entityId: 'location', name: 'TEST地点', kind: 'scene', designHash: 'TEST', selectedAssetId: 'TEST-base', prompt: { original: 'TEST', optimized: 'TEST', final: 'TEST', edited: false, rulesVersion: 'TEST' } }];
    project.assets = [{ id: 'TEST-base', kind: 'scene', materialId: 'scene:location', relativePath: 'materials/TEST.png' }];
    project.storyApproval = { hash: 'TEST', at: now }; usePetStoryStore.setState({ project });
    const html = renderToStaticMarkup(React.createElement(PetStoryMaterials, { project, disabled: false }));
    expect(html).toContain('变体／局部编辑计划'); expect(html).toContain('scene:location编辑基准图片'); expect(html).toContain('scene:location编辑变化'); expect(html).toContain('scene:location编辑保留项'); expect(html).toContain('scene:location编辑适用范围');
    expect(html).toContain('豆包生成编辑计划候选（不生成图片）'); expect(prepareRuntime).not.toHaveBeenCalled(); expect(generateMaterials).not.toHaveBeenCalled();
  });
});
