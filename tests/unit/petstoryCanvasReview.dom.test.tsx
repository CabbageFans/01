/** 离线正常控件回归；平台与本地文件读取为明确替身，不计真实 Electron 验收。 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryAsset, PetStoryPlan, PetStoryProject, Task } from '@doubao-studio/contracts';
import { CanvasPromptEditor } from '../../src/components/PetStoryCanvasPrompt';
import { PetStoryResults } from '../../src/components/PetStoryResults';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState() };
const now = '2026-10-29T00:00:00.000Z';
let project: PetStoryProject;
const dirtyChanged = (): void => undefined;
beforeEach((): void => {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  plan.shots = plan.shots.slice(0, 1);
  const prompt = plan.shots[0].prompts.firstFrame;
  prompt.final = 'TEST 已采用首帧正文'; prompt.optimized = 'TEST 新的完整候选'; prompt.edited = false;
  prompt.candidateJobId = 'TEST-candidate';
  project = { schemaVersion: 1, id: 'TEST-canvas-review', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, updatedAt: now, source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now }, assets: [], plan, jobs: [{ id: 'TEST-candidate', kind: 'optimize', taskId: 'TEST-chat', shotId: plan.shots[0].id, promptKind: 'firstFrame', status: 'applied', resultStatus: 'candidate', requestId: 'TEST-request', inputHash: 'TEST', sourceUrl: '', parsedResult: { optimized: prompt.optimized } }] };
  usePetStoryStore.setState({ ...initial.pet, project, busy: false, error: '', promptRepairJobIds: [] });
  useTaskStore.setState({ ...initial.tasks, tasks: [] });
});
afterEach((): void => { usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.tasks); useAccountStore.setState(initial.accounts); vi.restoreAllMocks(); });

describe('画布候选与自然语言修改', (): void => {
  it('节点直接显示完整候选，确认才采用，普通视图没有诊断和专业编辑器', (): void => {
    const adopt = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ adoptPromptCandidate: adopt });
    const { container } = render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(container.querySelector('.canvas-prompt-readonly')?.textContent).toBe('TEST 新的完整候选');
    expect(container.querySelector('.canvas-provenance')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(screen.queryByText('更多提示词操作')).toBeNull();
    expect(adopt).not.toHaveBeenCalled();
    expect(project.plan!.shots[0].prompts.firstFrame.final).toBe('TEST 已采用首帧正文');
    fireEvent.click(screen.getByRole('button', { name: '确认使用' }));
    expect(adopt).toHaveBeenCalledExactlyOnceWith('TEST-candidate');
  });

  it('保存过的手改正文保持只读并保留，浏览全文不触发采用或发送', (): void => {
    const prompt = project.plan!.shots[0].prompts.firstFrame;
    prompt.optimized = prompt.final; prompt.edited = true;
    project.jobs[0].resultStatus = 'adopted';
    const save = vi.fn(async (): Promise<void> => undefined);
    const revise = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ saveShotPrompt: save, revisePrompt: revise });
    const { container } = render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(container.querySelector('.canvas-prompt-readonly')?.textContent).toBe(prompt.final);
    expect(screen.getByText('当前使用 · 手改正文')).toBeDefined();
    expect(screen.queryByRole('button', { name: '确认使用' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '放大镜头1首帧生图提示词' }));
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(save).not.toHaveBeenCalled(); expect(revise).not.toHaveBeenCalled();
  });

  it('明确未发送的原任务在节点重试，复用原job且没有技术操作面板', (): void => {
    const retry = vi.fn(async (): Promise<void> => undefined);
    const job = { ...project.jobs[0], id: 'TEST-original', taskId: 'TEST-original-task', status: 'bound' as const, resultStatus: undefined, sourceStoryId: project.mobileStory!.id };
    project.jobs.push(job);
    const task: Task = { id: job.taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: 'queued', prompt: 'TEST 原请求', outputs: [], result: null, createdAt: now, updatedAt: now };
    useTaskStore.setState({ tasks: [task], activeTaskId: null, accountBusy: {} });
    usePetStoryStore.setState({ resumeCanvasPrompt: retry });
    const { container } = render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    expect(retry).toHaveBeenCalledExactlyOnceWith(job.id);
    expect(container.textContent).not.toContain('原任务尚未发送');
    expect(container.textContent).not.toContain('重新保存回复');
    expect(container.textContent).not.toContain('结束本次等待');
  });

  it('用户主动调整创作时仍可基于实际回复提出可选修改要求', async (): Promise<void> => {
    const prompt = project.plan!.shots[0].prompts.firstFrame;
    prompt.final = ''; prompt.optimized = '';
    project.jobs[0].status = 'invalid'; project.jobs[0].sourceStoryId = project.mobileStory!.id;
    project.jobs[0].parsedResult = { optimized: 'TEST 尚需修订的完整原文' };
    const revise = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ revisePrompt: revise });
    const { container } = render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(container.querySelector('.canvas-prompt-readonly')?.textContent).toBe('TEST 尚需修订的完整原文');
    expect(screen.getByText('上次结果 · 校验未通过')).toBeDefined(); expect(screen.queryByRole('button', { name: '确认使用' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '修改要求' }));
    const dialog = screen.getByRole('dialog'); fireEvent.change(within(dialog).getByRole('textbox', { name: '请说明希望调整哪里' }), { target: { value: 'TEST 补全缺失约束' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '提交修改' }));
    await waitFor((): void => expect(revise).toHaveBeenCalledExactlyOnceWith({ shotId: project.plan!.shots[0].id, promptKind: 'firstFrame', feedback: 'TEST 补全缺失约束', baseJobId: project.jobs[0].id }));
  });

  it('已收取的可修订失败仅显示后台等待状态，不把模型校验问题交给用户', (): void => {
    const prompt = project.plan!.shots[0].prompts.firstFrame; prompt.final = ''; prompt.optimized = '';
    const job = project.jobs[0]; job.status = 'invalid'; job.sourceStoryId = project.mobileStory!.id;
    job.rawText = 'TEST 已保存原回复'; job.parsedResult = { optimized: 'TEST 有待修订的完整正文' };
    const issue = 'TEST 正文遗漏本次素材标签';
    job.validationDetails = [{ code: 'prompt_content', path: '$.optimized', actualType: 'string', expected: 'TEST 完整引用', repairable: true, message: issue }];
    job.validationIssues = [issue];
    const resume = vi.fn(async (): Promise<void> => undefined); const revise = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ resumeCanvasPrompt: resume, revisePrompt: revise });
    const { container } = render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(screen.getByText('提示词待后台修订')).toBeDefined();
    expect(screen.getByText('查看后台校验记录')).toBeDefined();
    expect(screen.getByText(issue)).toBeDefined();
    expect(screen.queryByRole('button', { name: '确认使用' })).toBeNull();
    expect(screen.queryByRole('button', { name: '按原要求修复' })).toBeNull();
    expect(container.textContent).not.toContain('请通过“修改要求”');
    expect(container.querySelector('.canvas-prompt-progress .anticon-loading')).toBeNull();
    expect(screen.queryByText('正在后台修订并校验…')).toBeNull();
    expect(resume).not.toHaveBeenCalled(); expect(revise).not.toHaveBeenCalled(); expect(prompt.final).toBe('');
  });

  it('下一轮确实在准备时显示后台修订进度，禁止并行改写且不要求额外修复授权', (): void => {
    const job = project.jobs[0]; job.status = 'invalid'; job.rawText = 'TEST 已收取原回复';
    job.validationDetails = [{ code: 'prompt_content', path: '$.optimized', actualType: 'string', expected: 'TEST 完整引用', repairable: true, message: 'TEST 缺少引用' }];
    usePetStoryStore.setState({ promptRepairJobIds: [job.id] });
    const view = render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(screen.getByText('正在后台修订并校验…')).toBeDefined();
    expect(view.container.querySelector('.canvas-prompt-progress .anticon-loading')).not.toBeNull();
    expect((screen.getByRole('button', { name: '修改要求' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '按原要求修复' })).toBeNull();
    act((): void => usePetStoryStore.setState({ promptRepairJobIds: [] }));
    expect(screen.getByText('提示词待后台修订')).toBeDefined();
    expect(view.container.querySelector('.canvas-prompt-progress .anticon-loading')).toBeNull();
  });

  it('第二次修订校验失败继续交由后台，不增加修复按钮或把失败正文当作当前使用', (): void => {
    const parent = project.jobs[0]; parent.status = 'invalid'; parent.rawText = 'TEST 原回复';
    const repair = { ...parent, id: 'TEST-failed-repair', taskId: 'TEST-repair-task', requestId: 'TEST-repair-request', kind: 'repair' as const,
      parentJobId: parent.id, repairMode: 'automatic' as const, rawText: 'TEST 自动修订回复', parsedResult: { optimized: 'TEST 修订后仍有缺项' },
      validationDetails: [{ code: 'prompt_content', path: '$.optimized', actualType: 'string', expected: 'TEST 完整引用', repairable: true, message: 'TEST 修订后仍遗漏引用' }] };
    project.jobs.push(repair); usePetStoryStore.setState({ promptRepairJobIds: [repair.id] });
    render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(screen.getByText('TEST 修订后仍有缺项')).toBeDefined();
    expect(screen.getByText('上次结果 · 校验未通过')).toBeDefined();
    expect(screen.getByText('正在后台修订并校验…')).toBeDefined();
    expect(screen.queryByRole('button', { name: '按原要求修复' })).toBeNull();
    expect(project.plan!.shots[0].prompts.firstFrame.final).toBe('TEST 已采用首帧正文');
  });

  it('实际修订任务运行时使用其真实进度，不显示历史失败或确认旧候选', (): void => {
    const parent = project.jobs[0]; parent.status = 'invalid'; parent.rawText = 'TEST 原回复';
    const repair = { ...parent, id: 'TEST-repair-running', taskId: 'TEST-repair-task', kind: 'repair' as const, parentJobId: parent.id,
      status: 'bound' as const, resultStatus: undefined, parsedResult: undefined, rawText: undefined };
    project.jobs.push(repair);
    const task: Task = { id: repair.taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: 'generating', prompt: 'TEST 修订请求', outputs: [], result: null, createdAt: now, updatedAt: now };
    useTaskStore.setState({ tasks: [task] });
    render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(screen.getByText('正在后台修订并校验…')).toBeDefined();
    expect(screen.queryByRole('button', { name: '按原要求修复' })).toBeNull();
    expect(screen.queryByRole('button', { name: '确认使用' })).toBeNull();
    expect((screen.getByRole('button', { name: '修改要求' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText(/当前正文/).textContent).toBe(project.plan!.shots[0].prompts.firstFrame.final);
  });

  it('后台修订任务尚在队列时不要求用户点击重试，也不假称正在生成', (): void => {
    const parent = project.jobs[0]; parent.status = 'invalid'; parent.rawText = 'TEST 原回复';
    const repair = { ...parent, id: 'TEST-repair-queued', taskId: 'TEST-repair-task', kind: 'repair' as const, parentJobId: parent.id,
      status: 'bound' as const, resultStatus: undefined, sourceStoryId: project.mobileStory!.id, parsedResult: undefined, rawText: undefined };
    project.jobs.push(repair);
    const task: Task = { id: repair.taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: 'queued', prompt: 'TEST 修订请求', outputs: [], result: null, createdAt: now, updatedAt: now };
    useTaskStore.setState({ tasks: [task], activeTaskId: null, accountBusy: {} });
    const { container } = render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(screen.getByText('后台修订待启动')).toBeDefined();
    expect(screen.queryByRole('button', { name: /重\s*试/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '按原要求修复' })).toBeNull();
    expect(container.querySelector('.canvas-prompt-progress .anticon-loading')).toBeNull();
  });

  it('原任务暂停但失败回复已经收取时不误报尚未取得结果', (): void => {
    const job = project.jobs[0]; job.status = 'invalid'; job.rawText = 'TEST 已收取的失败回复';
    job.validationDetails = [{ code: 'prompt_content', path: '$.optimized', actualType: 'string', expected: 'TEST 完整引用', repairable: true, message: 'TEST 缺少引用' }];
    const task: Task = { id: job.taskId, assignedAccountId: project.accountId, mode: 'chat', status: 'paused', prompt: 'TEST 原请求', outputs: [], result: null, createdAt: now, updatedAt: now,
      runtime: { runId: 'TEST-collected-run', attempt: 1, stage: 'completed', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
        chatResponse: { text: job.rawText, capturedAt: now }, input: { prompt: 'TEST 原请求', mode: 'chat', attachments: [] } } };
    useTaskStore.setState({ tasks: [task] });
    render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(screen.queryByText('本次结果尚未取得')).toBeNull();
    expect(screen.getByText('提示词待后台修订')).toBeDefined();
    expect(screen.queryByRole('button', { name: '按原要求修复' })).toBeNull();
  });

  it('原请求已提交但尚未取得回复时只提供原会话核对，不提供修复', (): void => {
    const job = project.jobs[0]; job.status = 'bound'; job.parsedResult = undefined;
    const task: Task = { id: job.taskId, assignedAccountId: project.accountId, mode: 'chat', status: 'paused', prompt: 'TEST 原请求', outputs: [], result: null, createdAt: now, updatedAt: now,
      runtime: { runId: 'TEST-unresolved-run', attempt: 1, stage: 'paused', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
        input: { prompt: 'TEST 原请求', mode: 'chat', attachments: [] } } };
    useTaskStore.setState({ tasks: [task] });
    render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(screen.getByText('本次结果尚未取得')).toBeDefined();
    expect(screen.getByRole('button', { name: '查看豆包对话' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '按原要求修复' })).toBeNull();
    expect(screen.queryByText('正在后台修订并校验…')).toBeNull();
  });

  it('已收取失败回复但账号仍待验证时先处理登录，不显示虚假的后台运行', (): void => {
    const job = project.jobs[0]; job.status = 'invalid'; job.rawText = 'TEST 已收取失败回复';
    job.validationDetails = [{ code: 'prompt_content', path: '$.optimized', actualType: 'string', expected: 'TEST 完整引用', repairable: true, message: 'TEST 缺少引用' }];
    const task: Task = { id: job.taskId, assignedAccountId: project.accountId, mode: 'chat', status: 'waiting_verification', prompt: 'TEST 原请求', outputs: [], result: null, createdAt: now, updatedAt: now };
    useTaskStore.setState({ tasks: [task] }); usePetStoryStore.setState({ promptRepairJobIds: [job.id] });
    render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(screen.getByText('需要登录豆包或完成验证')).toBeDefined();
    expect(screen.getByRole('button', { name: '去处理' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '按原要求修复' })).toBeNull();
    expect(screen.queryByText('正在后台修订并校验…')).toBeNull();
  });

  it('不可交给模型修订的问题展示真实原因和原会话，不强制填写修改要求', (): void => {
    const job = project.jobs[0]; job.status = 'invalid'; job.rawText = 'TEST 原回复';
    job.validationDetails = [{ code: 'repair_drift', path: '$', actualType: 'object', expected: 'TEST 当前依据', repairable: false, message: 'TEST 请先确认当前依据' }];
    const task: Task = { id: job.taskId, assignedAccountId: project.accountId, mode: 'chat', status: 'done', prompt: 'TEST 原请求', outputs: [], result: null, createdAt: now, updatedAt: now };
    useTaskStore.setState({ tasks: [task] });
    render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(screen.getByText('TEST 请先确认当前依据')).toBeDefined();
    expect(screen.getByRole('button', { name: '查看豆包对话' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '按原要求修复' })).toBeNull();
    expect(screen.queryByText(/请通过“修改要求”/)).toBeNull();
    expect(screen.queryByText('提示词待后台修订')).toBeNull();
  });

  it('回复结构未解析出正文时后台继续修订，不引导用户补齐或修改空正文', (): void => {
    const prompt = project.plan!.shots[0].prompts.firstFrame; prompt.final = ''; prompt.optimized = '';
    const job = project.jobs[0]; job.status = 'invalid'; job.rawText = 'TEST 待修订的JSON回复'; job.parsedResult = undefined;
    job.error = 'TEST 回复结构不能解析';
    job.validationDetails = [{ code: 'content_contract', path: '$', actualType: 'string', expected: 'TEST 完整JSON回复', repairable: true, message: job.error }];
    usePetStoryStore.setState({ promptRepairJobIds: [job.id] });
    const { container } = render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(screen.getByText('正在后台修订并校验…')).toBeDefined();
    expect(screen.getByText(job.error)).toBeDefined();
    expect((screen.getByRole('button', { name: '修改要求' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '按原要求修复' })).toBeNull();
    expect(container.textContent).not.toContain('可使用顶部提示词按钮补齐');
  });

  it('回复归属异常或未知历史错误不被当作可修订内容，保留原错误供核对', (): void => {
    const job = project.jobs[0]; job.status = 'invalid'; job.rawText = 'TEST 归属待核对的原回复';
    job.error = 'TEST 本次回复requestId不符'; job.validationDetails = undefined;
    render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(screen.getByText(job.error)).toBeDefined();
    expect(screen.queryByRole('button', { name: '按原要求修复' })).toBeNull();
    expect(screen.queryByText('提示词待后台修订')).toBeNull();
  });

  it('失败且没有可读正文时不引导空修改，不伪造候选', (): void => {
    const prompt = project.plan!.shots[0].prompts.firstFrame; prompt.final = ''; prompt.optimized = '';
    project.jobs[0].status = 'invalid'; project.jobs[0].parsedResult = undefined;
    const { container } = render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(screen.getByText('本次回复尚未通过校验')).toBeDefined();
    expect((screen.getByRole('button', { name: '修改要求' }) as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('.canvas-prompt-readonly')).toBeNull();
    expect(container.textContent).not.toContain('请通过“修改要求”');
  });

  it.each(['candidate', 'adopted'] as const)('%s正文的全文会话入口使用实际正文来源，后续失败不提供无效旧候选确认', (source): void => {
    const original = project.jobs[0]; original.resultStatus = source;
    const prompt = project.plan!.shots[0].prompts.firstFrame;
    if (source === 'adopted') { prompt.sourceJobId = original.id; prompt.final = prompt.optimized; }
    project.jobs.push({ ...original, id: 'TEST-failed-new-request', taskId: 'TEST-failed-task', status: 'bound', resultStatus: undefined, requestId: 'TEST-new-request', parsedResult: undefined });
    const account: Account = { id: project.accountId, name: 'TEST', platform: 'doubao', avatar: '', partition: 'TEST-only', status: 'idle', pinned: false, createdAt: now, updatedAt: now };
    useAccountStore.setState({ accounts: [account], selectAccount: vi.fn() });
    const originalTask: Task = { id: original.taskId, assignedAccountId: project.accountId, mode: 'chat', status: 'done', prompt: 'TEST', outputs: [], result: null, createdAt: now, updatedAt: now,
      runtime: { runId: 'TEST-source-run', attempt: 1, stage: 'completed', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, conversationUrl: 'https://www.doubao.com/chat/TEST-source', input: { prompt: 'TEST', mode: 'chat', attachments: [] } } };
    const failedTask: Task = { ...originalTask, id: 'TEST-failed-task', status: 'fail', runtime: undefined };
    useTaskStore.setState({ tasks: [originalTask, failedTask], accountAutomationState: {}, accountBusy: {}, activeTaskId: null });
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(screen.queryByRole('button', { name: '确认使用' })).toBeNull();
    if (source === 'candidate') expect(screen.getByText('保留结果 · 已有后续请求')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '放大镜头1首帧生图提示词' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '查看这次豆包对话' }));
    const event = dispatch.mock.calls.map(([item]): Event => item).find((item): boolean => item.type === 'open-task-conversation') as CustomEvent<{ task: Task }>;
    expect(event.detail.task.id).toBe(original.taskId);
  });

  it('从全文预览进入修改只保留一个弹窗，取消和提交均回到原节点', async (): Promise<void> => {
    const revise = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ revisePrompt: revise });
    render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    for (const action of ['cancel', 'submit'] as const) {
      fireEvent.click(screen.getByRole('button', { name: '放大镜头1首帧生图提示词' }));
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '修改要求' }));
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText('修改镜头 1 · 首帧生图提示词')).toBeDefined();
      if (action === 'cancel') fireEvent.click(within(dialog).getByRole('button', { name: /取\s*消/ }));
      else {
        fireEvent.change(within(dialog).getByRole('textbox', { name: '请说明希望调整哪里' }), { target: { value: 'TEST 修改当前节点' } });
        fireEvent.click(within(dialog).getByRole('button', { name: '提交修改' }));
      }
      await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByText('TEST 新的完整候选')).toBeDefined();
    }
    expect(revise).toHaveBeenCalledOnce();
  });

  it('修改窗口打开后新候选回填不改变选定全文和实际baseJobId', async (): Promise<void> => {
    const revise = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ revisePrompt: revise });
    const { rerender } = render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    fireEvent.click(screen.getByRole('button', { name: '修改要求' }));
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('textbox', { name: '请说明希望调整哪里' }), { target: { value: 'TEST 只修改我打开的这条' } });
    const next = structuredClone(project); const prompt = next.plan!.shots[0].prompts.firstFrame;
    prompt.optimized = 'TEST 期间新回填候选'; prompt.candidateJobId = 'TEST-later-candidate';
    next.jobs.push({ ...next.jobs[0], id: 'TEST-later-candidate', taskId: 'TEST-later-task', requestId: 'TEST-later-request', parsedResult: { optimized: prompt.optimized } });
    act((): void => usePetStoryStore.setState({ project: next }));
    rerender(<CanvasPromptEditor project={next} shot={next.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('TEST 新的完整候选')).toBeDefined(); expect(within(dialog).queryByText('TEST 期间新回填候选')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '提交修改' }));
    await waitFor((): void => expect(revise).toHaveBeenCalledExactlyOnceWith({ shotId: project.plan!.shots[0].id, promptKind: 'firstFrame', feedback: 'TEST 只修改我打开的这条', baseJobId: 'TEST-candidate' }));
  });

  it('无job来源的手改正文在窗口打开后变化，保留意见并提示重选，不发送新正文', (): void => {
    const prompt = project.plan!.shots[0].prompts.firstFrame; prompt.edited = true; prompt.optimized = prompt.final;
    project.jobs[0].resultStatus = 'adopted';
    const revise = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ revisePrompt: revise });
    const { rerender } = render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    fireEvent.click(screen.getByRole('button', { name: '修改要求' }));
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('textbox', { name: '请说明希望调整哪里' }), { target: { value: 'TEST 保留我这次意见' } });
    const next = structuredClone(project); next.plan!.shots[0].prompts.firstFrame.final = 'TEST 期间变化的采用正文';
    act((): void => usePetStoryStore.setState({ project: next }));
    rerender(<CanvasPromptEditor project={next} shot={next.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('TEST 已采用首帧正文')).toBeDefined(); expect(within(dialog).queryByText('TEST 期间变化的采用正文')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '提交修改' }));
    expect(revise).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('alert').textContent).toContain('选定正文已变化');
    expect((within(dialog).getByRole('textbox', { name: '请说明希望调整哪里' }) as HTMLTextAreaElement).value).toBe('TEST 保留我这次意见');
  });

  it('修改弹窗忽略打开前的无关全局错误，只显示本次提交失败并保留意见', async (): Promise<void> => {
    const revise = vi.fn(async (): Promise<void> => { usePetStoryStore.setState({ error: 'TEST 这次修改尚未保存' }); });
    usePetStoryStore.setState({ error: 'TEST 无关批量采用失败', revisePrompt: revise });
    render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    fireEvent.click(screen.getByRole('button', { name: '修改要求' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('alert')).toBeNull(); expect(within(dialog).queryByText('TEST 无关批量采用失败')).toBeNull();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '请说明希望调整哪里' }), { target: { value: 'TEST 保留这次调整意见' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '提交修改' }));
    await waitFor((): void => expect(within(dialog).getByRole('alert').textContent).toBe('TEST 这次修改尚未保存'));
    expect(revise).toHaveBeenCalledOnce();
    expect((within(dialog).getByRole('textbox', { name: '请说明希望调整哪里' }) as HTMLTextAreaElement).value).toBe('TEST 保留这次调整意见');
    fireEvent.click(within(dialog).getByRole('button', { name: /取\s*消/ }));
    fireEvent.click(screen.getByRole('button', { name: '修改要求' }));
    expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull();
  });

  it('提交自然语言修改绑定当前具体候选，自动后台修订，连续第二次修改仍可提交', async (): Promise<void> => {
    const revise = vi.fn(async (): Promise<void> => undefined);
    const openChat = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ revisePrompt: revise, openChatAdjustment: openChat });
    render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    for (const feedback of ['TEST 保留人物，把光线调暖', 'TEST 再弱化背景光']) {
      fireEvent.click(screen.getByRole('button', { name: '修改要求' }));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByRole('textbox', { name: '请说明希望调整哪里' }), { target: { value: feedback } });
      expect(within(dialog).getAllByRole('button').map((button): string => button.textContent || '').filter((text): boolean => !!text)).toEqual(['取 消', '提交修改']);
      fireEvent.click(within(dialog).getByRole('button', { name: '提交修改' }));
      await waitFor((): void => expect(revise).toHaveBeenLastCalledWith({ shotId: project.plan!.shots[0].id, promptKind: 'firstFrame', feedback, baseJobId: 'TEST-candidate' }));
      await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
    }
    expect(revise).toHaveBeenCalledTimes(2); expect(openChat).not.toHaveBeenCalled();
    expect(project.plan!.shots[0].prompts.firstFrame.final).toBe('TEST 已采用首帧正文');
  });
});

function frame(state: 'candidate' | 'adopted'): PetStoryAsset {
  return { id: 'TEST-image', kind: 'firstFrame', shotId: project.plan!.shots[0].id, relativePath: 'TEST/image.png', imageReview: { state, target: { shotId: project.plan!.shots[0].id, kind: 'firstFrame' }, basisHash: 'TEST' }, validation: { decoded: true, sha256: 'TEST', bytes: 1, width: 64, height: 64, checkedAt: now } };
}

describe('成果按实际采用、任务与文件分别交接', (): void => {
  it('当前上传视频显示真实文件来源，不借用同镜头历史任务或生成提示词', (): void => {
    const shot = project.plan!.shots[0];
    const uploaded: PetStoryAsset = { id: 'TEST-uploaded-video', kind: 'video', origin: 'user_upload', shotId: shot.id, relativePath: 'TEST/uploaded.mp4',
      uploadSource: { projectId: project.id, accountId: project.accountId, shotId: shot.id, sha256: 'TEST-uploaded-sha', uploadedAt: now },
      validation: { decoded: true, sha256: 'TEST-uploaded-sha', bytes: 100, width: 720, height: 1280, durationSeconds: 6, checkedAt: now } };
    project.assets.push(uploaded); project.selectedVideos = { [shot.id]: uploaded.id };
    shot.prompts.video.final = 'TEST 与上传视频无生成关系的正文'; shot.prompts.video.needsReview = true;
    const task: Task = { id: 'TEST-historical-video', projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'video', status: 'done',
      prompt: 'TEST 原生成请求', outputs: ['https://TEST.invalid/old.mp4'], result: null, createdAt: now, updatedAt: now,
      runtime: { runId: 'TEST-old-run', attempt: 1, stage: 'completed', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
        input: { mode: 'video', prompt: 'TEST 原生成请求', attachments: [] } } };
    const entry = { state: 'unknown' as const, reason: 'TEST' };
    project.productionHistory = [{ state: 'complete', planHash: 'TEST', approvedAt: now,
      capability: { accountId: project.accountId, image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [] },
      fallbacks: {}, shots: {}, message: 'TEST 历史制作', steps: [{ id: 'TEST-old-step', kind: 'video', shotId: shot.id, taskId: task.id, runId: task.runtime!.runId,
        status: 'complete', inputHash: 'TEST', attachmentAssetIds: [] }] }];
    useTaskStore.setState({ tasks: [task] }); const before = structuredClone(project);
    render(<PetStoryResults project={project} onNavigate={(): void => undefined} />);
    const video = screen.getByRole('region', { name: '本镜视频' });
    expect(within(video).getByText('用户上传视频')).toBeDefined();
    expect(within(video).getByText('文件校验通过')).toBeDefined(); expect(within(video).getByText('对应当前内容')).toBeDefined();
    expect(within(video).queryByText('平台产物已读取')).toBeNull(); expect(within(video).queryByText('TEST 与上传视频无生成关系的正文')).toBeNull();
    expect(screen.queryByRole('button', { name: '查看原任务与质量确认' })).toBeNull(); expect(project).toEqual(before);
  });

  it.each(['needsReview', 'visualBasisStale'] as const)('上传视频%s时显示制作依据复核并保留播放入口', (flag): void => {
    const shot = project.plan!.shots[0];
    const uploaded: PetStoryAsset = { id: 'TEST-uploaded-video', kind: 'video', origin: 'user_upload', shotId: shot.id, relativePath: 'TEST/uploaded.mp4',
      uploadSource: { projectId: project.id, accountId: project.accountId, shotId: shot.id, sha256: 'TEST-sha', uploadedAt: now },
      validation: { decoded: true, sha256: 'TEST-sha', bytes: 100, width: 720, height: 1280, durationSeconds: 6, checkedAt: now }, [flag]: true };
    project.assets.push(uploaded); project.selectedVideos = { [shot.id]: uploaded.id };
    render(<PetStoryResults project={project} onNavigate={(): void => undefined} />);
    const video = screen.getByRole('region', { name: '本镜视频' });
    expect(within(video).getByText('用户上传视频')).toBeDefined();
    expect(within(video).getByText('制作依据已更新，请复核这项成果；原文件已保留。')).toBeDefined();
    expect(within(video).getByRole('button', { name: '播放镜头视频' })).toBeDefined();
    expect(within(video).queryByText('旧产物未记录对应提示词，不能确认与当前版本一致。')).toBeNull();
  });

  it('已保存候选没有正式文件时，入口回到当前镜头采用，浏览不推断已采用', (): void => {
    project.assets.push(frame('candidate'));
    const navigate = vi.fn();
    render(<PetStoryResults project={project} onNavigate={navigate} />);
    const first = screen.getByRole('region', { name: '本镜首帧' });
    expect(within(first).getByText('候选已保存，尚未采用')).toBeDefined();
    expect(within(first).queryByText('文件校验通过')).toBeNull();
    fireEvent.click(within(first).getByRole('button', { name: '查看并采用' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('keyframes', project.plan!.shots[0].id, 'firstFrame');
    expect(project.adoptedImages).toBeUndefined();
  });

  it('已有平台产物而未保存本地文件时，提供下载收取入口且不暗示重新生成', (): void => {
    const task: Task = { id: 'TEST-video', mode: 'video', status: 'done', assignedAccountId: project.accountId, prompt: 'TEST', outputs: ['https://TEST.invalid/output.mp4'], result: null, createdAt: now, updatedAt: now, runtime: { runId: 'TEST-run', attempt: 1, stage: 'completed', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { prompt: 'TEST', mode: 'video', attachments: [] } } };
    const capability = { accountId: project.accountId, checkedAt: now, image: { state: 'unknown' as const, reason: '' }, modes: { first_frame: { state: 'unknown' as const, reason: '' }, first_last_frame: { state: 'unknown' as const, reason: '' }, reference: { state: 'unknown' as const, reason: '' } }, durations: [], };
    project.production = { state: 'paused', planHash: 'TEST', approvedAt: now, capability, fallbacks: {}, shots: {}, steps: [{ id: 'TEST-step', kind: 'video', shotId: project.plan!.shots[0].id, taskId: task.id, runId: 'TEST-run', inputHash: 'TEST', attachmentAssetIds: [], status: 'bound' }], message: 'TEST' };
    useTaskStore.setState({ tasks: [task] });
    const navigate = vi.fn(); render(<PetStoryResults project={project} onNavigate={navigate} />);
    const video = screen.getByRole('region', { name: '本镜视频' });
    expect(within(video).getByText('平台产物已读取')).toBeDefined();
    expect(within(video).getByText('尚无项目内文件')).toBeDefined();
    expect(within(video).queryByRole('button', { name: '去制作本镜视频' })).toBeNull();
    fireEvent.click(within(video).getByRole('button', { name: '查看下载与收取' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('videos', project.plan!.shots[0].id, 'video');
  });

  it('替换参考后的旧采用图仍可查看，优先说明实际复核原因', (): void => {
    const asset = frame('adopted'); asset.needsReview = true;
    project.assets.push(asset); project.adoptedImages = { [project.plan!.shots[0].id]: { firstFrameId: asset.id } };
    render(<PetStoryResults project={project} onNavigate={(): void => undefined} />);
    const first = screen.getByRole('region', { name: '本镜首帧' });
    expect(within(first).getByText('制作依据已更新，请复核这项成果；原文件已保留。')).toBeDefined();
    expect(within(first).queryByText('旧产物未记录对应提示词，不能确认与当前版本一致。')).toBeNull();
    expect(within(first).getByRole('button', { name: '查看图片' })).toBeDefined();
    expect(project.assets).toHaveLength(1);
  });

  it('同一任务的后续运行不能冒充旧采用图的生成事实', (): void => {
    const asset = frame('adopted'); asset.taskId = 'TEST-reused-task'; asset.runId = 'TEST-old-run';
    project.assets.push(asset); project.adoptedImages = { [project.plan!.shots[0].id]: { firstFrameId: asset.id } };
    useTaskStore.setState({ tasks: [{ id: asset.taskId, assignedAccountId: project.accountId, mode: 'image', status: 'done', prompt: 'TEST 后续运行', outputs: ['https://TEST.invalid/new.png'], result: null, createdAt: now, updatedAt: now, runtime: { runId: 'TEST-new-run', attempt: 2, stage: 'completed', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { prompt: 'TEST 后续运行', mode: 'image', attachments: [] } } }] });
    render(<PetStoryResults project={project} onNavigate={(): void => undefined} />);
    const first = screen.getByRole('region', { name: '本镜首帧' });
    expect(within(first).getByText('已保存豆包产物')).toBeDefined();
    expect(within(first).queryByText('平台产物已读取')).toBeNull();
  });
});
