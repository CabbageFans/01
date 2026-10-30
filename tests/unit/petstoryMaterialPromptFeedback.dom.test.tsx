/** 原故事素材卡的离线点击回归：使用实际 Store，IPC／调度为替身，不属于平台发送验收。 */
import React from 'react';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryChatJob, PetStoryPlan, PetStoryProject, PetStoryResult, PetStoryRuntimeTarget, Task } from '@doubao-studio/contracts';
import { PetStoryMaterials } from '../../src/components/PetStoryMaterials';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import originalStory from '../fixtures/storyboard-five-shots.json';

vi.mock('../../src/components/usePetStoryGenerationEligibility', (): object => ({
  usePetStoryGenerationEligibility: (): object => ({ eligibility: { ready: true, blockers: [] }, loading: false, error: '', refresh: vi.fn() })}));

const original = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState(), projects: useProjectStore.getState() };
const now = '2026-10-30T03:00:00.000Z';
const materialId = 'prop:TEST-original-electric-bike';
let project: PetStoryProject;
let tasks: Task[];
const prepareRuntime = vi.fn<(id: string, revision: number, kind: PetStoryChatJob['kind'], target?: PetStoryRuntimeTarget) => Promise<PetStoryResult>>();
const startAutomation = vi.fn<(taskId: string, beforeDispatch?: (task: Task) => Promise<void>) => Promise<boolean>>();
const retryUnsubmitted = vi.fn<(projectId: string, jobId: string) => Promise<PetStoryResult>>();

function queuedTask(job: PetStoryChatJob): Task {
  const prompt = 'TEST 原故事电车素材文字任务；离线 IPC 替身';
  return { id: job.taskId, mode: 'chat', projectId: project.studioProjectId, assignedAccountId: project.accountId, prompt, status: 'queued', executionIntent: 'hold', result: null, outputs: [], createdAt: now, updatedAt: now,
    runtime: { runId: `TEST-run-${job.id}`, attempt: 1, stage: 'preparing_account', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { mode: 'chat', prompt, attachments: [] } } };
}
function createPreparedJob(): PetStoryResult {
  project = structuredClone(project); project.revision++;
  const job: PetStoryChatJob = { id: 'TEST-material-job', taskId: 'TEST-material-task', materialId, kind: 'materialPrompt', status: 'bound', inputHash: 'TEST', sourceUrl: '', sourceStoryId: project.mobileStory!.id, requestId: 'TEST-material-request', expectedIds: [materialId], createdAt: now };
  project.jobs.push(job); tasks.push(queuedTask(job));
  return { success: true, project, taskId: job.taskId };
}
function guardedTask(accountId: string = project.accountId): Task {
  const task = queuedTask({ id: 'TEST-guard-source', taskId: 'TEST-guard-source-task' } as PetStoryChatJob);
  task.assignedAccountId = accountId; task.projectId = 'TEST-other-studio'; task.status = 'done';
  if (!task.runtime) throw new Error('TEST 缺少保护快照');
  task.runtime.chatAdjustmentGuard = { active: true, projectId: 'TEST-other-project', adjustmentId: 'TEST-other-adjustment' };
  return task;
}
const LiveMaterials: React.FC = (): React.ReactElement | null => {
  const value = usePetStoryStore();
  return value.project ? <PetStoryMaterials project={value.project} disabled={value.busy} /> : null;
};
function card(): HTMLElement {
  const value = document.getElementById(`material-${materialId}`);
  if (!value) throw new Error('TEST 缺少原故事电车素材卡');
  return value;
}
function generate(): HTMLElement { return within(card()).getByRole('button', { name: /^(?:loading )?生成提示词$/ }); }

beforeEach((): void => {
  vi.clearAllMocks(); tasks = [];
  project = { schemaVersion: 1, id: 'TEST-material-project', studioProjectId: 'TEST-material-studio', accountId: 'TEST-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-story', text: originalStory.mobileStory, importedAt: now },
    plan: structuredClone(originalStory.plan) as PetStoryPlan, storyApproval: { hash: 'TEST-original-approval', at: now }, assets: [], jobs: [], updatedAt: now,
    materials: [{ id: materialId, entityId: 'TEST-original-electric-bike', kind: 'prop', name: '粉色电驴', designHash: 'TEST', prompt: { original: 'TEST 原故事既有道具摘要', optimized: '', final: '', edited: false, rulesVersion: 'TEST' } }] };
  const account: Account = { id: project.accountId, platform: 'doubao', name: 'TEST 原账号', partition: 'TEST-only', avatar: '', pinned: false, status: 'idle', createdAt: now, updatedAt: now };
  useAccountStore.setState({ ...original.accounts, accounts: [account], selectedAccountId: account.id });
  useProjectStore.setState({ ...original.projects, projects: [{ id: project.studioProjectId, name: 'TEST 原故事容器', color: '#fff', description: '', archived: false, createdAt: now, updatedAt: now }], activeProjectId: project.studioProjectId });
  prepareRuntime.mockImplementation(async (): Promise<PetStoryResult> => createPreparedJob());
  startAutomation.mockImplementation(async (taskId: string, beforeDispatch?: (task: Task) => Promise<void>): Promise<boolean> => {
    const task = tasks.find((item): boolean => item.id === taskId); if (!task) throw new Error('TEST 未找到原任务');
    if (beforeDispatch) await beforeDispatch(task);
    tasks = tasks.map((item): Task => item.id === taskId ? { ...item, status: 'executing' } : item); useTaskStore.setState({ tasks }); return true;
  });
  retryUnsubmitted.mockImplementation(async (_projectId: string, jobId: string): Promise<PetStoryResult> => {
    project = structuredClone(project); project.revision++;
    const job = project.jobs.find((item): boolean => item.id === jobId); if (!job) throw new Error('TEST 未找到原绑定');
    job.runId = undefined;
    tasks = tasks.map((item): Task => item.id === job.taskId ? { ...item, status: 'queued', executionIntent: 'hold' } : item);
    return { success: true, project, taskId: job.taskId };
  });
  window.electronAPI = { petstory: { prepareRuntime, retryUnsubmitted,
    bindRun: vi.fn(async (_id: string, jobId: string, runId: string): Promise<PetStoryResult> => {
      project = structuredClone(project); project.revision++; const job = project.jobs.find((item): boolean => item.id === jobId);
      if (!job) throw new Error('TEST 缺少已持久化绑定'); job.runId = runId; return { success: true, project };
    }),
    readReference: vi.fn(async (): Promise<{ success: false }> => ({ success: false }))}, tasks: { list: vi.fn(async (): Promise<Task[]> => tasks) } } as unknown as typeof window.electronAPI;
  useTaskStore.setState({ ...original.tasks, tasks, startAutomation, activeTaskId: null, accountBusy: {}, accountAutomationState: {}, error: null });
  usePetStoryStore.setState({ ...original.pet, project, projectName: 'TEST 原故事', busy: false, error: '', capability: null, promptBatch: { total: 0, completed: 0, status: 'idle' } });
});
afterEach((): void => {
  usePetStoryStore.setState(original.pet); useTaskStore.setState(original.tasks); useAccountStore.setState(original.accounts); useProjectStore.setState(original.projects); vi.restoreAllMocks();
});

describe('生成素材提示词的当前卡片反馈与原任务恢复', (): void => {
  it('当前项目的自由调整也就地提示，处理入口只打开原会话而不结束调整', (): void => {
    project.chatAdjustment = { id: 'TEST-current-adjustment', target: {}, sourceJobId: 'TEST-current-source', conversationUrl: 'https://www.doubao.com/chat/TEST-original', basisHash: 'TEST', startedAt: now, status: 'active', replies: [] };
    usePetStoryStore.setState({ project }); const before = structuredClone(project.chatAdjustment); const dispatch = vi.spyOn(window, 'dispatchEvent'); render(<LiveMaterials />);
    expect(generate().hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(card()).getByRole('button', { name: '处理当前豆包调整' }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'petstory-open-adjustment' }));
    expect(usePetStoryStore.getState().project?.chatAdjustment).toEqual(before); expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
  });
  it('同账号另一项目自由调整时就地说明并提供原调整入口，不创建请求或清除保护', (): void => {
    const guard = guardedTask(); tasks = [guard]; useTaskStore.setState({ tasks });
    const before = structuredClone(project); const dispatch = vi.spyOn(window, 'dispatchEvent'); render(<LiveMaterials />);
    expect(generate().hasAttribute('disabled')).toBe(true);
    const action = within(card()).getByRole('button', { name: '处理当前豆包调整' });
    expect(within(card()).getByText(/调整.*(?:结束|采用)|(?:结束|采用).*调整/)).toBeDefined();
    fireEvent.click(action);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'reveal-workspace-browser' }));
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().project).toEqual(before); expect(tasks[0].runtime?.chatAdjustmentGuard?.active).toBe(true);
  });
  it('其他账号的自由调整不阻断原账号，点击实际 Store 后只创建本素材文字请求', async (): Promise<void> => {
    tasks = [guardedTask('TEST-other-account')]; useTaskStore.setState({ tasks }); render(<LiveMaterials />);
    expect(generate().hasAttribute('disabled')).toBe(false); fireEvent.click(generate());
    await waitFor((): void => expect(prepareRuntime).toHaveBeenCalledExactlyOnceWith(project.id, 1, 'materialPrompt', { materialId }));
    await waitFor((): void => expect(startAutomation).toHaveBeenCalledOnce());
    expect(tasks.filter((item): boolean => item.id === 'TEST-material-task')).toHaveLength(1); expect(tasks.at(-1)?.mode).toBe('chat');
    expect(usePetStoryStore.getState().project?.assets).toEqual([]);
  });
  it.each(['returned', 'thrown'] as const)('准备请求%s失败时，原因显示在被点击的素材卡，不能只留在页面顶部', async (failure): Promise<void> => {
    const message = 'TEST 当前文字请求准备失败，请核对绑定账号';
    prepareRuntime.mockImplementation(async (): Promise<PetStoryResult> => { if (failure === 'thrown') throw new Error(message); return { success: false, error: message }; });
    render(<LiveMaterials />); fireEvent.click(generate());
    await waitFor((): void => expect(within(card()).getByText(message)).toBeDefined());
    expect(usePetStoryStore.getState().error).toBe(message); expect(prepareRuntime).toHaveBeenCalledOnce(); expect(startAutomation).not.toHaveBeenCalled();
    expect(project.jobs).toEqual([]); expect(tasks).toEqual([]); expect(generate().hasAttribute('disabled')).toBe(false);
  });
  it('某素材准备失败的即时错误不泄漏到未点击的其他素材卡', async (): Promise<void> => {
    const actor = project.plan!.characters[0];
    project.materials!.push({ id: `character:${actor.id}`, entityId: actor.id, kind: 'character', name: actor.name, designHash: 'TEST', prompt: { original: actor.description, optimized: '', final: '', edited: false, rulesVersion: 'TEST' } });
    usePetStoryStore.setState({ project });
    prepareRuntime.mockResolvedValue({ success: false, error: 'TEST 仅本次电车文字准备失败' }); render(<LiveMaterials />); fireEvent.click(generate());
    await waitFor((): void => expect(within(card()).getByText('TEST 仅本次电车文字准备失败')).toBeDefined());
    const other = document.getElementById(`material-character:${actor.id}`); if (!other) throw new Error('TEST 缺少原故事人物卡');
    expect(within(other).queryByText('TEST 仅本次电车文字准备失败')).toBeNull(); expect(prepareRuntime).toHaveBeenCalledOnce();
  });
  it('请求准备期间立即展示当前卡片进度并禁用重复点击，失败后保留具体原因', async (): Promise<void> => {
    let settle: ((result: PetStoryResult) => void) | undefined;
    prepareRuntime.mockImplementation((): Promise<PetStoryResult> => new Promise((resolve): void => { settle = resolve; }));
    render(<LiveMaterials />); const button = generate(); fireEvent.click(button);
    await waitFor((): void => expect(button.classList.contains('ant-btn-loading')).toBe(true));
    expect(button.hasAttribute('disabled')).toBe(true); fireEvent.click(button); expect(prepareRuntime).toHaveBeenCalledOnce();
    await act(async (): Promise<void> => { if (!settle) throw new Error('TEST 未进入准备'); settle({ success: false, error: 'TEST 请求尚未创建' }); });
    expect(within(card()).getByText('TEST 请求尚未创建')).toBeDefined(); expect(tasks).toEqual([]);
  });
  it('已创建任务但启动失败时就地显示原因，继续原任务不会重新创建任务', async (): Promise<void> => {
    startAutomation.mockImplementationOnce(async (): Promise<boolean> => { useTaskStore.setState({ error: 'TEST 页面暂未就绪，原任务尚未发送' }); return false; });
    render(<LiveMaterials />); fireEvent.click(generate());
    await waitFor((): void => expect(within(card()).getByText('TEST 页面暂未就绪，原任务尚未发送')).toBeDefined());
    expect(tasks).toHaveLength(1); expect(project.jobs).toHaveLength(1); expect(generate().hasAttribute('disabled')).toBe(true);
    const resume = within(card()).getByRole('button', { name: '继续原文字任务（尚未发送）' }); fireEvent.click(resume);
    await waitFor((): void => expect(startAutomation).toHaveBeenCalledTimes(2));
    expect(prepareRuntime).toHaveBeenCalledOnce(); expect(tasks).toHaveLength(1); expect(project.jobs).toHaveLength(1);
  });
  it('任务开始后当前卡展示处理状态；提交后展示等待或核对状态，不能再创建同目标任务', async (): Promise<void> => {
    render(<LiveMaterials />); fireEvent.click(generate()); await waitFor((): void => expect(startAutomation).toHaveBeenCalledOnce());
    await waitFor((): void => expect(within(card()).getByText(/正在准备这次豆包请求|正在生成提示词/)).toBeDefined());
    await act(async (): Promise<void> => {
      tasks = tasks.map((task): Task => ({ ...task, status: 'generating', runtime: task.runtime ? { ...task.runtime, submittedAt: now, stage: 'generating' } : undefined })); useTaskStore.setState({ tasks });
    });
    expect(within(card()).getByText(/正在核对发送结果|正在等待.*回复/)).toBeDefined();
    expect(generate().hasAttribute('disabled')).toBe(true); fireEvent.click(generate());
    expect(prepareRuntime).toHaveBeenCalledOnce(); expect(startAutomation).toHaveBeenCalledOnce(); expect(project.materials?.[0].prompt.final).toBe('');
  });
  it('重开时已暂停原任务就在当前卡可恢复，不因渲染而发送，恢复仍使用相同任务', async (): Promise<void> => {
    createPreparedJob(); const job = project.jobs[0]; job.runId = tasks[0].runtime?.runId;
    tasks[0] = { ...tasks[0], status: 'waiting_verification', errorInfo: { code: 'page_unrecognized', message: 'TEST 请处理原页面', recoverable: true, detectedAt: now } };
    usePetStoryStore.setState({ project }); useTaskStore.setState({ tasks }); render(<LiveMaterials />);
    expect(within(card()).getByText(/原任务尚未发送|请处理原页面/)).toBeDefined();
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(startAutomation).not.toHaveBeenCalled();
    fireEvent.click(within(card()).getByRole('button', { name: /处理阻断后继续原任务/ }));
    await waitFor((): void => expect(retryUnsubmitted).toHaveBeenCalledExactlyOnceWith(project.id, job.id));
    await waitFor((): void => expect(startAutomation).toHaveBeenCalledExactlyOnceWith(job.taskId, expect.any(Function)));
    expect(prepareRuntime).not.toHaveBeenCalled(); expect(tasks).toHaveLength(1); expect(project.jobs).toHaveLength(1);
  });
});
