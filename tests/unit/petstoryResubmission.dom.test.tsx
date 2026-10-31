import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryCapability, PetStoryProject, Task } from '@doubao-studio/contracts';
import { PetStoryCurrentTasks } from '../../src/components/PetStoryTaskRecovery';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';

const originals = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState() };
const now = '2026-10-31T00:00:00.000Z';
let project: PetStoryProject; let task: Task; let account: Account;
const resubmit = vi.fn(async (): Promise<void> => undefined);
beforeEach((): void => {
  vi.clearAllMocks();
  account = { id: 'TEST-account', name: 'TEST原账号', avatar: '', partition: 'TEST-only', status: 'idle', pinned: false, createdAt: now, updatedAt: now };
  const entry = { state: 'unknown' as const, reason: 'TEST离线入口' };
  const capability: PetStoryCapability = { accountId: account.id, checkedAt: now, durations: [5], image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry } };
  task = { id: 'TEST-old-task', assignedAccountId: account.id, mode: 'image', status: 'paused', prompt: 'TEST离线请求', result: null, outputs: [], createdAt: now, updatedAt: now,
    runtime: { runId: 'TEST-old-run', attempt: 1, stage: 'paused', message: 'TEST', submittedAt: now, conversationUrl: 'https://www.doubao.com/chat/TEST-original', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { mode: 'image', prompt: 'TEST离线请求', attachments: [] } } };
  project = { id: 'TEST-project', schemaVersion: 1, studioProjectId: 'TEST-studio', accountId: account.id, revision: 5, source: { kind: 'script', url: '', status: 'review_required' }, jobs: [], assets: [], updatedAt: now,
    production: { state: 'paused', planHash: 'TEST', approvedAt: now, capability, fallbacks: {}, shots: {}, steps: [{ id: 'TEST-step', kind: 'firstFrame', shotId: 'TEST-shot', taskId: task.id, runId: task.runtime!.runId, status: 'bound', inputHash: 'TEST', attachmentAssetIds: [] }], message: '只读核对原会话，禁止重发' } };
  usePetStoryStore.setState({ ...originals.petstory, project, busy: false, error: '', resubmitProduction: resubmit });
  useTaskStore.setState({ ...originals.tasks, tasks: [task], activeTaskId: null, executingTasks: {}, accountBusy: {}, accountAutomationState: {} });
  useAccountStore.setState({ ...originals.accounts, accounts: [account], selectAccount: vi.fn() });
});
afterEach((): void => {
  usePetStoryStore.setState(originals.petstory); useTaskStore.setState(originals.tasks); useAccountStore.setState(originals.accounts); vi.restoreAllMocks();
});

describe('不明媒体提交的显式单次重发入口', (): void => {
  it('先显示风险确认，取消不创建授权、不调用重发', (): void => {
    render(<PetStoryCurrentTasks project={project} />);
    expect(screen.getByText('受理仍未确认，可检查原结果或确认重发一次')).toBeDefined();
    expect(screen.queryByText('只读核对原会话，禁止重发')).toBeNull();
    expect(screen.getByRole('button', { name: '检查原制作结果（不重复发送）' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '确认重发一次' }));
    const dialog = screen.getByRole('dialog'); expect(within(dialog).getByText('原请求可能已受理，重发可能产生重复结果或再次消耗额度。原请求与产物保留。')).toBeDefined();
    expect(resubmit).not.toHaveBeenCalled(); fireEvent.click(within(dialog).getByRole('button', { name: '取 消' })); expect(resubmit).not.toHaveBeenCalled();
  });
  it('只在确认后生成新的 UUID，并固定绑定原任务、运行与提交时间', async (): Promise<void> => {
    render(<PetStoryCurrentTasks project={project} />);
    fireEvent.click(screen.getByRole('button', { name: '确认重发一次' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认风险，重发一次' }));
    await waitFor((): void => expect(resubmit).toHaveBeenCalledOnce());
    expect(resubmit).toHaveBeenCalledWith({ taskId: task.id, runId: task.runtime!.runId, submittedAt: now, authorizationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i), acceptDuplicateRisk: true });
    expect(task.runtime!.submittedAt).toBe(now); expect(task.outputs).toEqual([]);
  });
  it.each(['accepted', 'manual-observing', 'manual-completed', 'outputs', 'reply', 'completed', 'generating', 'observing', 'active'] as const)('%s 证据或活跃任务不暴露重发入口', (condition): void => {
    if (condition === 'accepted') task.runtime!.acceptanceObservation = { runId: task.runtime!.runId, outcome: 'observing' } as NonNullable<Task['runtime']>['acceptanceObservation'];
    if (condition === 'manual-observing' || condition === 'manual-completed') task.runtime!.manualObservation = { startedAt: now, expiresAt: now, source: 'stored_conversation', outcome: condition === 'manual-observing' ? 'observing' : 'completed' };
    if (condition === 'outputs') task.outputs = ['TEST-artifact'];
    if (condition === 'reply') task.runtime!.chatResponse = { text: 'TEST已收到', capturedAt: now };
    if (condition === 'completed') task.runtime!.stage = 'completed';
    if (condition === 'generating') task.status = 'generating';
    if (condition === 'observing') task.status = 'manual_submission_observing';
    useTaskStore.setState({ tasks: [task], ...(condition === 'active' ? { executingTasks: { [account.id]: task.id } } : {}) });
    render(<PetStoryCurrentTasks project={project} />); expect(screen.queryByRole('button', { name: '确认重发一次' })).toBeNull();
  });
  it.each(['acceptance-review', 'manual-review', 'generation-confirmation'] as const)('%s 已停止且受理仍不明时仍提供显式风险确认', (condition): void => {
    if (condition === 'acceptance-review') task.runtime!.acceptanceObservation = { runId: task.runtime!.runId, outcome: 'manual_review' } as NonNullable<Task['runtime']>['acceptanceObservation'];
    if (condition === 'manual-review') task.runtime!.manualObservation = { startedAt: now, expiresAt: now, source: 'stored_conversation', outcome: 'manual_review' };
    if (condition === 'generation-confirmation') task.status = 'waiting_generation_confirmation';
    useTaskStore.setState({ tasks: [task] }); render(<PetStoryCurrentTasks project={project} />);
    expect(screen.getByRole('button', { name: '确认重发一次' }).hasAttribute('disabled')).toBe(false);
  });
  it.each(['verification', 'login'] as const)('%s 未解除时按钮禁用并给直接处理指引', (block): void => {
    account.health = { loginState: block === 'login' ? 'expired' : 'ok', verificationRequired: block === 'verification', consecutiveFailures: 0, failureCount: 0, successCount: 0,
      availability: { state: block === 'login' ? 'login_required' : 'action_required', reason: block === 'login' ? 'login_required' : 'human_verification', message: 'TEST', source: 'pre_submit', checkedAt: now } };
    useAccountStore.setState({ accounts: [account] }); render(<PetStoryCurrentTasks project={project} />);
    expect(screen.getByRole('button', { name: '确认重发一次' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('status').textContent).toContain(block === 'login' ? '完成登录' : '完成人机验证');
    fireEvent.click(screen.getByRole('button', { name: '确认重发一次' })); expect(screen.queryByRole('dialog')).toBeNull(); expect(resubmit).not.toHaveBeenCalled();
  });
  it('确认弹窗打开后出现受理结果时重新核对并拒绝旧授权', async (): Promise<void> => {
    render(<PetStoryCurrentTasks project={project} />); fireEvent.click(screen.getByRole('button', { name: '确认重发一次' }));
    act((): void => { useTaskStore.setState({ tasks: [{ ...task, outputs: ['TEST-late-artifact'] }] }); });
    await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull()); expect(resubmit).not.toHaveBeenCalled();
  });
  it('缺少原会话地址时先由用户找原会话并明确确认，再允许检查当前页归属', (): void => {
    task.runtime!.conversationUrl = undefined; useTaskStore.setState({ tasks: [task] });
    const dispatch = vi.spyOn(window, 'dispatchEvent'); render(<PetStoryCurrentTasks project={project} />);
    fireEvent.click(screen.getByRole('button', { name: '检查原制作结果（不重复发送）' }));
    const dialog = screen.getByRole('dialog', { name: '核对当前原会话' });
    expect(within(dialog).getByText(/在豆包历史对话中手动找到原请求所在会话/)).toBeDefined();
    expect(dispatch.mock.calls.some(([event]): boolean => event.type === 'reconcile-task-submission' || event.type === 'open-task-conversation')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: '打开原执行账号' }));
    expect(useAccountStore.getState().selectAccount).toHaveBeenCalledWith(account.id);
    expect(dispatch.mock.calls.some(([event]): boolean => event.type === 'open-task-conversation')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: '当前页就是原会话，检查结果' }));
    const checks = dispatch.mock.calls.map(([event]): Event => event).filter((event): boolean => event.type === 'reconcile-task-submission');
    expect(checks).toHaveLength(1); expect((checks[0] as CustomEvent).detail).toEqual({ taskId: task.id, useCurrentPage: true }); expect(resubmit).not.toHaveBeenCalled();
  });
  it('有保存的原具体会话时沿原定位检查，不隐式授权使用当前页', (): void => {
    const dispatch = vi.spyOn(window, 'dispatchEvent'); render(<PetStoryCurrentTasks project={project} />);
    fireEvent.click(screen.getByRole('button', { name: '检查原制作结果（不重复发送）' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const check = dispatch.mock.calls.find(([event]): boolean => event.type === 'reconcile-task-submission');
    expect((check?.[0] as CustomEvent).detail).toEqual({ taskId: task.id }); expect(resubmit).not.toHaveBeenCalled();
  });
  it('取消当前会话归属确认不观察、不导航、不重发', (): void => {
    task.runtime!.conversationUrl = undefined; useTaskStore.setState({ tasks: [task] });
    const dispatch = vi.spyOn(window, 'dispatchEvent'); render(<PetStoryCurrentTasks project={project} />);
    fireEvent.click(screen.getByRole('button', { name: '检查原制作结果（不重复发送）' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取 消' }));
    expect(dispatch.mock.calls.some(([event]): boolean => event.type === 'reconcile-task-submission' || event.type === 'open-task-conversation')).toBe(false); expect(resubmit).not.toHaveBeenCalled();
  });
  it('保留历史任务入口，并打开原账号的原会话', (): void => {
    const original: Task = { ...task, id: 'TEST-earlier-task', runtime: { ...task.runtime!, runId: 'TEST-earlier-run' } };
    task.resubmissionOf = { taskId: original.id, runId: original.runtime!.runId, submittedAt: now, authorizationId: 'TEST-explicit', authorizedAt: now };
    project.production!.steps[0].resubmissionHistory = [{ ...task.resubmissionOf, inputHash: 'TEST', attachmentAssetIds: [] }];
    useTaskStore.setState({ tasks: [original, task] }); const dispatch = vi.spyOn(window, 'dispatchEvent');
    render(<PetStoryCurrentTasks project={project} />); fireEvent.click(screen.getByRole('button', { name: '打开原制作任务' }));
    expect(useAccountStore.getState().selectAccount).toHaveBeenCalledWith(account.id);
    expect(dispatch.mock.calls.some(([event]): boolean => event.type === 'open-task-conversation' && (event as CustomEvent<{ task: Task }>).detail.task.id === original.id)).toBe(true);
  });
});
