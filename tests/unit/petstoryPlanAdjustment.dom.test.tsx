/** 方案反馈的离线交互回归；任务与 Chat 结果为服务替身，不构成真实平台验收。 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryChatJob, PetStoryPlan, PetStoryProject, PetStoryRuntimeTarget, Task } from '@doubao-studio/contracts';
import { PetStoryPlanReview } from '../../src/components/PetStoryPlanReview';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

type PlanFeedback = NonNullable<PetStoryRuntimeTarget['planFeedback']>;
const initial = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-11-03T00:00:00.000Z';
const baseId = 'TEST-unadopted-plan';
const revise = vi.fn<(feedback: PlanFeedback) => Promise<string | undefined>>();
const adopt = vi.fn<(jobId: string) => Promise<void>>();
const confirm = vi.fn<() => Promise<void>>();
const oldAdjustment = vi.fn<() => Promise<void>>();
let sequence = 0;

function currentProject(): PetStoryProject { return usePetStoryStore.getState().project!; }
function updateProject(change: (project: PetStoryProject) => void): void {
  const next = structuredClone(currentProject()); change(next); next.revision++;
  usePetStoryStore.setState({ project: next, error: '' });
}
function chatTask(job: PetStoryChatJob, status: Task['status'] = 'generating'): Task {
  const project = currentProject();
  return { id: job.taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status,
    prompt: 'TEST 后台受控请求替身', result: null, outputs: [], createdAt: now, updatedAt: now };
}
function createAdjustment(feedback: PlanFeedback): string {
  const id = `TEST-feedback-${++sequence}`;
  const job: PetStoryChatJob = { id, taskId: `${id}-task`, kind: 'analysis', status: 'bound', requestId: `${id}-chat-request`, inputHash: 'TEST-input',
    sourceStoryId: currentProject().mobileStory!.id, sourceUrl: '', planFeedback: structuredClone(feedback) };
  updateProject((project): void => { project.jobs.push(job); });
  useTaskStore.setState({ tasks: [...useTaskStore.getState().tasks, chatTask(job)] });
  return id;
}
function startRepair(rootId: string): string {
  const root = currentProject().jobs.find((job): boolean => job.id === rootId)!;
  const repair: PetStoryChatJob = { ...root, id: `${rootId}-repair`, taskId: `${rootId}-repair-task`, kind: 'repair', originKind: 'analysis', parentJobId: rootId, status: 'bound' };
  updateProject((project): void => {
    const parent = project.jobs.find((job): boolean => job.id === rootId)!;
    parent.status = 'invalid'; parent.error = 'TEST 父回复结构问题仅作历史'; parent.rawText = 'TEST-INTERNAL-RAW-JSON';
    project.jobs.push(repair);
  });
  useTaskStore.setState({ tasks: [...useTaskStore.getState().tasks.map((task): Task => task.id === root.taskId ? { ...task, status: 'done' } : task), chatTask(repair)] });
  return repair.id;
}
function completeCandidate(jobId: string, understanding: string): PetStoryPlan {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  plan.understanding = understanding;
  for (const shot of plan.shots) for (const prompt of Object.values(shot.prompts)) {
    if (!prompt) continue;
    prompt.final = `TEST-INTERNAL-PROMPT-${shot.id}`;
    prompt.original = 'TEST-INTERNAL-ORIGINAL'; prompt.optimized = 'TEST-INTERNAL-OPTIMIZED'; prompt.draft = 'TEST-INTERNAL-DRAFT';
  }
  updateProject((project): void => {
    const job = project.jobs.find((item): boolean => item.id === jobId)!;
    job.status = 'applied'; job.resultStatus = 'candidate'; job.parsedResult = { plan }; job.rawText = JSON.stringify(plan); delete job.error;
  });
  const job = currentProject().jobs.find((item): boolean => item.id === jobId)!;
  useTaskStore.setState({ tasks: useTaskStore.getState().tasks.map((task): Task => task.id === job.taskId ? { ...task, status: 'done' } : task) });
  return plan;
}
const View: React.FC = (): React.ReactElement => {
  const project = usePetStoryStore((state) => state.project)!;
  return <PetStoryPlanReview project={project} disabled={false} />;
};
async function openDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: '在豆包中调整' }));
  return screen.findByRole('dialog', { name: '调整方案' });
}
async function finishDialogClose(dialog: HTMLElement): Promise<void> {
  // happy-dom 不运行 CSS 动画；沿真实离场事件结束 Modal，而不是修改生产动效。
  await waitFor((): void => {
    if (screen.queryByRole('dialog', { name: '调整方案' })) expect(dialog.classList.contains('ant-zoom-leave-active')).toBe(true);
  });
  if (screen.queryByRole('dialog', { name: '调整方案' })) fireEvent.animationEnd(dialog);
  await waitFor((): void => expect(screen.queryByRole('dialog', { name: '调整方案' })).toBeNull());
}
async function submitFeedback(dialog: HTMLElement, text: string): Promise<void> {
  fireEvent.change(within(dialog).getByRole('textbox', { name: '方案修改要求' }), { target: { value: text } });
  fireEvent.click(within(dialog).getByRole('button', { name: '开始调整' }));
  await waitFor((): void => expect(revise).toHaveBeenCalled());
}

beforeEach((): void => {
  vi.resetAllMocks(); sequence = 0;
  const oldPlan = structuredClone(snapshot.plan) as PetStoryPlan; oldPlan.understanding = 'TEST 原采用方案';
  const basePlan = structuredClone(snapshot.plan) as PetStoryPlan; basePlan.understanding = 'TEST 当前预览的未采用方案';
  const project: PetStoryProject = { schemaVersion: 1, id: 'TEST-adjustment-project', revision: 1, studioProjectId: 'TEST-studio', accountId: 'TEST-account',
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now },
    plan: oldPlan, storyApproval: { hash: 'TEST-old-approval', at: now },
    assets: [{ id: 'TEST-preserved-video', kind: 'video', shotId: oldPlan.shots[0].id, relativePath: 'TEST/preserved.mp4' }], updatedAt: now,
    jobs: [{ id: baseId, taskId: 'TEST-base-task', kind: 'analysis', status: 'applied', resultStatus: 'candidate', requestId: 'TEST-base-request',
      inputHash: 'TEST-base-input', sourceUrl: '', sourceStoryId: 'TEST-story', parsedResult: { plan: basePlan } }] };
  revise.mockImplementation(async (feedback: PlanFeedback): Promise<string> => createAdjustment(feedback));
  adopt.mockImplementation(async (jobId: string): Promise<void> => {
    updateProject((value): void => {
      const job = value.jobs.find((item): boolean => item.id === jobId)!;
      value.plan = structuredClone(job.parsedResult!.plan!); job.resultStatus = 'adopted'; delete value.storyApproval;
    });
  });
  confirm.mockImplementation(async (): Promise<void> => updateProject((value): void => { value.storyApproval = { hash: 'TEST-new-approval', at: now }; }));
  useTaskStore.setState({ ...initial.tasks, tasks: [], activeTaskId: null, accountBusy: {} });
  usePetStoryStore.setState({ ...initial.petstory, project, busy: false, error: '', promptRepairJobIds: [], revisePlan: revise,
    adoptPlanCandidate: adopt, confirmStory: confirm, openChatAdjustment: oldAdjustment });
});
afterEach((): void => { cleanup(); usePetStoryStore.setState(initial.petstory); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });

describe('方案意见弹窗与后台候选', (): void => {
  it('未采用方案可直接填写；空白禁用，取消不发任务或采用', async (): Promise<void> => {
    const before = structuredClone(currentProject()); render(<View />); const dialog = await openDialog();
    const start = within(dialog).getByRole('button', { name: '开始调整' });
    expect(start.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox', { name: '方案修改要求' }), { target: { value: '   \n ' } });
    expect(start.hasAttribute('disabled')).toBe(true); fireEvent.click(start);
    fireEvent.change(within(dialog).getByRole('textbox', { name: '方案修改要求' }), { target: { value: 'TEST 取消的修改意见' } });
    expect(start.hasAttribute('disabled')).toBe(false); fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await finishDialogClose(dialog);
    expect(revise).not.toHaveBeenCalled(); expect(oldAdjustment).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    expect(currentProject()).toEqual(before); expect(useTaskStore.getState().tasks).toEqual([]);
  });

  it('原账号等待验证时有处理入口，取消后重开同一候选保留草稿且不发送', async (): Promise<void> => {
    const before = structuredClone(currentProject()); const originalTask = chatTask(before.jobs[0], 'waiting_verification');
    useTaskStore.setState({ tasks: [originalTask] }); render(<View />); const dialog = await openDialog();
    expect(within(dialog).getByRole('button', { name: '查看占用任务' })).toBeDefined();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '方案修改要求' }), { target: { value: 'TEST 处理验证后继续使用的意见' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' })); await finishDialogClose(dialog);
    const reopened = await openDialog();
    expect((within(reopened).getByRole('textbox', { name: '方案修改要求' }) as HTMLTextAreaElement).value).toBe('TEST 处理验证后继续使用的意见');
    expect(within(reopened).getByRole('button', { name: '查看占用任务' })).toBeDefined();
    expect(reopened.textContent).not.toContain('请先采用');
    expect(revise).not.toHaveBeenCalled(); expect(oldAdjustment).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    expect(currentProject()).toEqual(before); expect(useTaskStore.getState().tasks).toEqual([originalTask]);
  });

  it('同账号同Studio的无关暂停smoke历史不阻断明确新反馈，原记录完整保留', async (): Promise<void> => {
    const source = currentProject().jobs[0];
    const histories: Task[] = [
      { ...chatTask(source, 'paused'), id: 'TEST-old-smoke-one', errorInfo: { code: 'submission_uncertain', message: 'TEST 旧smoke结果待核对', recoverable: true, detectedAt: now } },
      { ...chatTask(source, 'paused'), id: 'TEST-old-smoke-two', petstory: { projectId: 'TEST-other-short-drama', stepId: 'TEST-other-step' },
        errorInfo: { code: 'submission_uncertain', message: 'TEST 其他短剧旧结果待核对', recoverable: true, detectedAt: now } },
    ];
    const before = structuredClone(histories); useTaskStore.setState({ tasks: histories });
    render(<View />); const dialog = await openDialog();
    expect(within(dialog).queryByRole('button', { name: '查看占用任务' })).toBeNull();
    expect(dialog.textContent).not.toContain('原账号当前有任务需要处理');
    await submitFeedback(dialog, 'TEST 当前候选的新方案意见');
    await within(dialog).findByText('正在按你的要求调整方案');
    expect(revise).toHaveBeenCalledExactlyOnceWith({ text: 'TEST 当前候选的新方案意见', baseJobId: baseId, requestId: expect.any(String) });
    expect(useTaskStore.getState().tasks.slice(0, 2)).toEqual(before); expect(useTaskStore.getState().tasks).toHaveLength(3);
    expect(currentProject().jobs.at(-1)?.taskId).not.toBe(histories[0].id); expect(adopt).not.toHaveBeenCalled();
  });

  it('当前短剧提交不明优先定位具体占用任务，不打开任意豆包会话', async (): Promise<void> => {
    const source = currentProject().jobs[0];
    const unrelated = { ...chatTask(source), id: 'TEST-other-active-task' };
    const current = { ...chatTask(source, 'paused'), id: 'TEST-current-uncertain-task', petstory: { projectId: currentProject().id, stepId: 'TEST-current-step' },
      errorInfo: { code: 'submission_uncertain' as const, message: 'TEST 本短剧原结果待核对', recoverable: true, detectedAt: now } };
    const before = structuredClone([unrelated, current]); useTaskStore.setState({ tasks: [unrelated, current] });
    const dispatched = vi.spyOn(window, 'dispatchEvent'); render(<View />); const dialog = await openDialog();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '方案修改要求' }), { target: { value: 'TEST 定位原任务后继续的意见' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '查看占用任务' })); await finishDialogClose(dialog);
    expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({ type: 'navigate-workspace', detail: expect.objectContaining({ page: 'tasks' }) }));
    const shown = dispatched.mock.calls.filter((call): boolean => call[0].type === 'show-workspace-task');
    expect(shown).toHaveLength(1); expect((shown[0][0] as CustomEvent<{ taskId: string }>).detail).toEqual({ taskId: current.id });
    expect(dispatched.mock.calls.some((call): boolean => ['open-task-conversation', 'reveal-workspace-browser'].includes(call[0].type))).toBe(false);
    expect(revise).not.toHaveBeenCalled(); expect(oldAdjustment).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks).toEqual(before);
  });

  it('明确结束上一段自由调整后保留本次意见，不要求采用旧回复', async (): Promise<void> => {
    updateProject((project): void => {
      project.chatAdjustment = { id: 'TEST-previous-adjustment', target: {}, sourceJobId: baseId,
        conversationUrl: 'https://www.doubao.com/chat/TEST-previous', basisHash: 'TEST-previous-basis', startedAt: now, status: 'active', replies: [] };
    });
    const before = structuredClone(currentProject());
    const end = vi.fn(async (): Promise<void> => updateProject((project): void => { project.chatAdjustment!.status = 'ended'; }));
    const adoptReply = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ endChatAdjustment: end, adoptChatReply: adoptReply });
    render(<View />); const dialog = await openDialog();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '方案修改要求' }), { target: { value: 'TEST 本轮完整方案的修改意见' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '结束上一段调整' }));
    await waitFor((): void => expect(within(dialog).queryByRole('button', { name: '结束上一段调整' })).toBeNull());
    expect(end).toHaveBeenCalledOnce(); expect(currentProject().chatAdjustment?.status).toBe('ended');
    expect((within(dialog).getByRole('textbox', { name: '方案修改要求' }) as HTMLTextAreaElement).value).toBe('TEST 本轮完整方案的修改意见');
    expect(within(dialog).getByRole('button', { name: '开始调整' }).hasAttribute('disabled')).toBe(false);
    expect(revise).not.toHaveBeenCalled(); expect(oldAdjustment).not.toHaveBeenCalled(); expect(adoptReply).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    expect(currentProject().plan).toEqual(before.plan); expect(currentProject().assets).toEqual(before.assets); expect(currentProject().jobs).toEqual(before.jobs);
  });

  it('提交绑定所选候选和授权ID，运行时可返回页面且自动显示新结果', async (): Promise<void> => {
    const before = structuredClone(currentProject()); render(<View />); const dialog = await openDialog();
    await submitFeedback(dialog, '  TEST 放慢第二镜动作  ');
    expect(revise).toHaveBeenCalledExactlyOnceWith({ text: 'TEST 放慢第二镜动作', baseJobId: baseId, requestId: expect.any(String) });
    expect(revise.mock.calls[0][0].requestId).toMatch(/^[0-9a-f-]{36}$/i);
    await within(dialog).findByText('正在按你的要求调整方案');
    expect(within(dialog).queryByRole('button', { name: /确认并采用/ })).toBeNull();
    expect(currentProject().plan).toEqual(before.plan); expect(currentProject().assets).toEqual(before.assets); expect(adopt).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '返回方案' }));
    await finishDialogClose(dialog);
    expect(screen.getByRole('heading', { name: '正在按你的要求调整方案' })).toBeDefined();
    expect(currentProject().jobs.at(-1)?.planFeedback?.requestId).toBe(revise.mock.calls[0][0].requestId);
    expect(useTaskStore.getState().tasks.at(-1)?.status).toBe('generating'); expect(revise).toHaveBeenCalledOnce();
    const taskId = currentProject().jobs.at(-1)?.taskId;
    fireEvent.click(screen.getByRole('button', { name: '查看调整进度' }));
    const reopened = await screen.findByRole('dialog', { name: '调整方案' });
    await within(reopened).findByText('正在按你的要求调整方案');
    expect(reopened.textContent).toContain('TEST 放慢第二镜动作');
    expect(within(reopened).queryByRole('textbox', { name: '方案修改要求' })).toBeNull();
    expect(currentProject().jobs.at(-1)?.taskId).toBe(taskId); expect(useTaskStore.getState().tasks).toHaveLength(1);
    expect(revise).toHaveBeenCalledOnce(); expect(oldAdjustment).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled();
    fireEvent.click(within(reopened).getByRole('button', { name: '返回方案' })); await finishDialogClose(reopened);
    act((): void => { completeCandidate('TEST-feedback-1', 'TEST 返回页面后完成的新方案'); });
    await waitFor((): void => expect(screen.getByRole('button', { name: '确认并采用方案' })).toBeDefined());
    expect(screen.getAllByText('TEST 返回页面后完成的新方案').length).toBeGreaterThan(0);
    expect(currentProject().plan).toEqual(before.plan); expect(adopt).not.toHaveBeenCalled(); expect(revise).toHaveBeenCalledOnce();
  });

  it('提交失败保留反馈，重试复用同一授权ID且不切换至旧自由会话API', async (): Promise<void> => {
    revise.mockRejectedValueOnce(new Error('TEST 本次提交暂未保存')); render(<View />); const dialog = await openDialog();
    await submitFeedback(dialog, 'TEST 保留结尾字幕');
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'TEST 本次提交暂未保存');
    expect((within(dialog).getByRole('textbox', { name: '方案修改要求' }) as HTMLTextAreaElement).value).toBe('TEST 保留结尾字幕');
    expect(currentProject().jobs).toHaveLength(1); const first = structuredClone(revise.mock.calls[0][0]);
    fireEvent.click(within(dialog).getByRole('button', { name: '开始调整' }));
    await waitFor((): void => expect(revise).toHaveBeenCalledTimes(2));
    expect(revise.mock.calls[1][0]).toEqual(first); expect(first.baseJobId).toBe(baseId);
    await within(dialog).findByText('正在按你的要求调整方案');
    expect(oldAdjustment).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled();
  });

  it('后台修订后自动展示完整创作方案，隐藏提示词和JSON，明确确认才采用', async (): Promise<void> => {
    const before = structuredClone(currentProject()); render(<View />); const dialog = await openDialog();
    await submitFeedback(dialog, 'TEST 修改动作安排'); await within(dialog).findByText('正在按你的要求调整方案');
    let repairId = ''; act((): void => { repairId = startRepair('TEST-feedback-1'); });
    await within(dialog).findByText('正在检查并整理新方案');
    expect(within(dialog).queryByText('TEST 父回复结构问题仅作历史')).toBeNull(); expect(adopt).not.toHaveBeenCalled();
    let candidate: PetStoryPlan | undefined;
    act((): void => { candidate = completeCandidate(repairId, 'TEST 修订后的完整新方案'); });
    await within(dialog).findByText('TEST 修订后的完整新方案');
    for (const shot of snapshot.plan.shots) expect(within(dialog).getByRole('article', { name: `镜头 ${shot.order} 完整方案` })).toBeDefined();
    for (const hidden of ['提示词', 'TEST-INTERNAL-PROMPT', 'TEST-INTERNAL-ORIGINAL', 'TEST-INTERNAL-OPTIMIZED', 'TEST-INTERNAL-DRAFT', 'TEST-INTERNAL-RAW-JSON', 'sourceSummary', '"shots"']) expect(dialog.textContent).not.toContain(hidden);
    expect(dialog.querySelector('pre')).toBeNull(); expect(currentProject().plan).toEqual(before.plan); expect(currentProject().assets).toEqual(before.assets);
    expect(adopt).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认并采用新方案' }));
    await finishDialogClose(dialog);
    expect(adopt).toHaveBeenCalledExactlyOnceWith(repairId); expect(confirm).toHaveBeenCalledOnce();
    expect(currentProject().plan).toEqual(candidate); expect(currentProject().assets).toEqual(before.assets);
    expect(currentProject().jobs.find((job): boolean => job.id === baseId)?.resultStatus).toBe('candidate');
    expect(currentProject().jobs.find((job): boolean => job.id === 'TEST-feedback-1')?.error).toBe('TEST 父回复结构问题仅作历史');
  });

  it('继续调整直接使用最新修订候选ID，无须中途采用并创建新的反馈授权', async (): Promise<void> => {
    const before = structuredClone(currentProject()); render(<View />); const dialog = await openDialog();
    await submitFeedback(dialog, 'TEST 第一轮修改'); await within(dialog).findByText('正在按你的要求调整方案');
    let repairId = ''; act((): void => { repairId = startRepair('TEST-feedback-1'); completeCandidate(repairId, 'TEST 第一轮新方案'); });
    await within(dialog).findByText('TEST 第一轮新方案'); fireEvent.click(within(dialog).getByRole('button', { name: '继续调整' }));
    const input = within(dialog).getByRole('textbox', { name: '方案修改要求' }) as HTMLTextAreaElement;
    expect(input.value).toBe(''); expect(adopt).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    await submitFeedback(dialog, 'TEST 再精简最后一个镜头');
    await waitFor((): void => expect(revise).toHaveBeenCalledTimes(2));
    expect(revise.mock.calls[1][0]).toMatchObject({ text: 'TEST 再精简最后一个镜头', baseJobId: repairId });
    expect(revise.mock.calls[1][0].requestId).not.toBe(revise.mock.calls[0][0].requestId);
    await within(dialog).findByText('正在按你的要求调整方案');
    expect(currentProject().jobs.at(-1)?.planFeedback?.baseJobId).toBe(repairId);
    expect(currentProject().plan).toEqual(before.plan); expect(currentProject().assets).toEqual(before.assets); expect(adopt).not.toHaveBeenCalled();
  });
});
