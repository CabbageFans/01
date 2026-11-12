/** 仅离线验证节点恢复接线；不向平台提交确认或视频请求。 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { message } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryPlan, PetStoryProject, Task } from '@doubao-studio/contracts';
import { CanvasMediaNode } from '../../src/components/PetStoryCanvasMedia';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState() };
const now = '2026-11-01T00:00:00.000Z';
let project: PetStoryProject; let task: Task;
function saveFreshAvailability(ready: boolean): void {
  const current = useAccountStore.getState();
  useAccountStore.setState({ availabilityChecking: { [project.accountId]: false }, accounts: current.accounts.map((account: Account): Account => ({ ...account,
    health: { loginState: 'ok', verificationRequired: !ready, consecutiveFailures: 0, successCount: 0, failureCount: 0,
      availability: { state: ready ? 'ready' : 'action_required', reason: ready ? 'ready' : 'human_verification', message: ready ? 'TEST 已就绪' : 'TEST 仍需完成验证', checkedAt: new Date().toISOString(), source: 'manual' } },
  })) });
}
beforeEach((): void => {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan; plan.shots = plan.shots.slice(0, 1);
  const entry = { state: 'supported' as const, reason: 'TEST' };
  project = { schemaVersion: 1, id: 'TEST-confirmation-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, updatedAt: now,
    source: { kind: 'script', url: '', status: 'review_required' }, plan, assets: [], jobs: [],
    production: { state: 'paused', phase: 'shots', planHash: 'TEST', approvedAt: now, message: 'TEST', fallbacks: {}, shots: {},
      capability: { accountId: 'TEST-account', image: entry, durations: [5], modes: { first_frame: entry, first_last_frame: entry, reference: entry } },
      steps: [{ id: 'TEST-step', shotId: plan.shots[0].id, kind: 'video', taskId: 'TEST-task', runId: 'TEST-run', status: 'bound', inputHash: 'TEST', attachmentAssetIds: ['TEST-first', 'TEST-last'] }] } };
  task = { id: 'TEST-task', projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'video', status: 'waiting_generation_confirmation', prompt: 'TEST 原正文', outputs: [], result: null, createdAt: now, updatedAt: now,
    petstory: { projectId: project.id, stepId: 'TEST-step' }, errorInfo: { code: 'generation_confirmation_required', message: 'TEST 豆包要求视频生成参数确认', recoverable: true, detectedAt: now },
    runtime: { runId: 'TEST-run', attempt: 1, stage: 'waiting_generation_confirmation', message: 'TEST 待参数确认', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
      conversationUrl: 'https://www.doubao.com/chat/TEST-original', generationConfirmation: { detectedAt: now, marker: 'parameter_confirmation', model: 'Seedance 2.0 Fast', duration: '5s', aspectRatio: '9:16' },
      input: { mode: 'video', prompt: 'TEST 原正文', attachments: ['TEST-first-file', 'TEST-last-file'] } } };
  const account: Account = { id: project.accountId, name: 'TEST 原账号', platform: 'doubao', partition: 'TEST-partition', status: 'idle', pinned: false, avatar: '', createdAt: now, updatedAt: now };
  window.electronAPI = { petstory: {
    inspectGeneration: vi.fn(async (): Promise<{ success: true; eligibility: { ready: false; blockers: [] } }> => ({ success: true, eligibility: { ready: false, blockers: [] } })),
    readMedia: vi.fn(async (): Promise<{ success: true; data: string }> => ({ success: true, data: 'data:video/mp4;base64,VEVTVA==' })),
  } } as unknown as typeof window.electronAPI;
  usePetStoryStore.setState({ ...initial.pet, project, busy: false, error: '', generateShotMedia: vi.fn(), resumeUnsubmittedVideo: vi.fn(), resumeVideoAsReferences: vi.fn(), resumeProduction: vi.fn(), resubmitProduction: vi.fn() });
  useTaskStore.setState({ ...initial.tasks, tasks: [task], executingTasks: {}, activeTaskId: null, accountAutomationState: {} });
  useAccountStore.setState({ ...initial.accounts, accounts: [account], selectAccount: vi.fn(), requestAvailabilityCheck: vi.fn((): void => saveFreshAvailability(true)) });
});
afterEach(async (): Promise<void> => {
  // 先解除 store 订阅；AntD 静态提示有独立 React 根，须在 DOM 环境销毁前完成异步清理。
  cleanup();
  await act(async (): Promise<void> => { message.destroy(); });
  usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.tasks); useAccountStore.setState(initial.accounts);
  vi.restoreAllMocks();
});
const Node: React.FC = (): React.ReactElement => {
  const current = usePetStoryStore((state) => state.project);
  return current?.plan ? <CanvasMediaNode project={current} shot={current.plan.shots[0]} kind="video" disabled /> : <></>;
};

describe('视频节点直接处理原会话确认与结果', (): void => {
  it('平台要求确认时在节点上方显示实际参数和两步操作，打开原会话不自动确认或重发', (): void => {
    const events = vi.spyOn(window, 'dispatchEvent'); const { container } = render(<Node />);
    const panel = screen.getByRole('region', { name: '视频参数确认' });
    expect(panel.textContent).toContain('Seedance 2.0 Fast · 5s · 9:16');
    expect(screen.getByRole('status').textContent).toContain('在豆包原会话回复“确认”');
    expect(panel.querySelectorAll('.ant-btn-primary')).toHaveLength(1);
    expect(container.querySelector('.canvas-empty-media')).toBeNull();
    expect(Array.from(container.querySelector('.canvas-media-node')!.children).indexOf(panel)).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '去豆包确认参数' }));
    expect(useAccountStore.getState().selectAccount).toHaveBeenCalledExactlyOnceWith(project.accountId);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'open-task-conversation', detail: { task } }));
    expect(usePetStoryStore.getState().resumeProduction).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().generateShotMedia).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().resumeUnsubmittedVideo).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().resumeVideoAsReferences).not.toHaveBeenCalled();
  });

  it('在豆包确认后可直接从同一节点检查原结果，状态未先变化也不再新建视频', async (): Promise<void> => {
    const before = structuredClone(task); const resume = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ resumeProduction: resume }); render(<Node />);
    fireEvent.click(screen.getByRole('button', { name: '我已确认，检查结果' }));
    await waitFor((): void => expect(resume).toHaveBeenCalledOnce());
    expect(usePetStoryStore.getState().generateShotMedia).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().resumeUnsubmittedVideo).not.toHaveBeenCalled();
    expect(task).toEqual(before);
  });

  it('确认后的暂停保留一个检查入口，经原制作只读收取回填后显示视频', async (): Promise<void> => {
    task.status = 'paused'; task.runtime!.stage = 'paused'; task.errorInfo!.code = 'manual_review_required'; task.errorInfo!.message = 'TEST 平台正在生成，尚未出现视频地址';
    const before = structuredClone(task);
    const resume = vi.fn(async (): Promise<void> => {
      const saved = structuredClone(project); saved.revision++; saved.production!.state = 'complete'; saved.production!.steps[0].status = 'complete';
      saved.assets.push({ id: 'TEST-video', shotId: saved.plan!.shots[0].id, kind: 'video', relativePath: 'TEST.mp4', taskId: task.id, runId: task.runtime!.runId });
      usePetStoryStore.setState({ project: saved, error: '' });
    });
    usePetStoryStore.setState({ resumeProduction: resume }); const { container } = render(<Node />);
    expect(screen.getByRole('status').textContent).toBe(task.errorInfo!.message);
    expect(container.querySelectorAll('.canvas-media-actions button')).toHaveLength(4);
    expect(screen.getByRole('button', { name: '上传视频' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '结束本次制作' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '检查原视频结果' }));
    await waitFor((): void => expect(screen.getByRole('button', { name: '查看视频' })).toBeDefined());
    expect(resume).toHaveBeenCalledOnce(); expect(screen.queryByRole('button', { name: '检查原视频结果' })).toBeNull();
    expect(usePetStoryStore.getState().generateShotMedia).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().resumeUnsubmittedVideo).not.toHaveBeenCalled(); expect(task).toEqual(before);
  });

  it('旧界面点击前运行归属已变化时，不打开原会话或调用恢复', async (): Promise<void> => {
    const events = vi.spyOn(window, 'dispatchEvent'); render(<Node />);
    const button = screen.getByRole('button', { name: '去豆包确认参数' });
    task.runtime!.runId = 'TEST-other-run';
    await act(async (): Promise<void> => { fireEvent.click(button); });
    expect(screen.getByRole('alert').textContent).toContain('原视频任务状态已变化');
    expect(events.mock.calls.some(([event]): boolean => event.type === 'open-task-conversation')).toBe(false);
    expect(usePetStoryStore.getState().resumeProduction).not.toHaveBeenCalled(); expect(useAccountStore.getState().selectAccount).not.toHaveBeenCalled();
  });

  it('提交后验证停住且没有会话地址时显示两项恢复操作，打开原账号不导航或刷新验证', (): void => {
    task.status = 'waiting_verification'; task.runtime!.stage = 'waiting_verification'; task.runtime!.conversationUrl = undefined;
    task.errorInfo = { code: 'verification', message: 'TEST 人机验证阻断', recoverable: true, detectedAt: now }; project.production!.state = 'running';
    const events = vi.spyOn(window, 'dispatchEvent'); const before = structuredClone(task); render(<Node />);
    expect(screen.getByRole('region', { name: '原账号验证恢复' }).textContent).toContain('TEST 人机验证阻断');
    expect(screen.getByRole('button', { name: '已完成验证，继续' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '去豆包处理验证' }));
    expect(useAccountStore.getState().selectAccount).toHaveBeenCalledExactlyOnceWith(project.accountId);
    expect(events.mock.calls.some(([event]): boolean => event.type === 'open-task-conversation' || event.type === 'reconcile-task-submission')).toBe(false);
    expect(useAccountStore.getState().requestAvailabilityCheck).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().resumeProduction).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().generateShotMedia).not.toHaveBeenCalled(); expect(task).toEqual(before);
  });

  it('用户声明已验证仍先检测实际原账号，验证未通过时保留原任务且不开始视频', async (): Promise<void> => {
    task.status = 'waiting_verification'; task.runtime!.stage = 'waiting_verification'; task.runtime!.conversationUrl = undefined;
    useAccountStore.setState({ requestAvailabilityCheck: vi.fn((): void => saveFreshAvailability(false)) });
    const before = structuredClone(task); render(<Node />);
    fireEvent.click(screen.getByRole('button', { name: '已完成验证，继续' }));
    await waitFor((): void => expect(screen.getByRole('alert').textContent).toContain('TEST 仍需完成验证'));
    expect(useAccountStore.getState().requestAvailabilityCheck).toHaveBeenCalledExactlyOnceWith(project.accountId);
    expect(usePetStoryStore.getState().resumeProduction).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().generateShotMedia).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().resumeUnsubmittedVideo).not.toHaveBeenCalled(); expect(useTaskStore.getState().tasks).toHaveLength(1); expect(task).toEqual(before);
  });

  it('fresh ready已由账号事件接续原观察时不再重复恢复，不创建新视频', async (): Promise<void> => {
    task.status = 'waiting_verification'; task.runtime!.stage = 'waiting_verification'; task.runtime!.conversationUrl = undefined;
    useAccountStore.setState({ requestAvailabilityCheck: vi.fn((): void => {
      const observed = structuredClone(task); observed.status = 'manual_submission_observing'; observed.runtime!.stage = 'manual_submission_observing';
      useTaskStore.setState({ tasks: [observed], activeTaskId: observed.id });
      saveFreshAvailability(true);
    }) });
    render(<Node />); fireEvent.click(screen.getByRole('button', { name: '已完成验证，继续' }));
    await waitFor((): void => expect(screen.queryByRole('button', { name: '已完成验证，继续' })).toBeNull());
    expect(useAccountStore.getState().requestAvailabilityCheck).toHaveBeenCalledExactlyOnceWith(project.accountId);
    expect(usePetStoryStore.getState().resumeProduction).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().generateShotMedia).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks).toHaveLength(1); expect(useTaskStore.getState().tasks[0].runtime).toMatchObject({ runId: 'TEST-run', submittedAt: now });
  });

  it('fresh ready后原任务仍暂停时仅接续原制作只读检查，缺URL不创建新视频', async (): Promise<void> => {
    task.status = 'waiting_verification'; task.runtime!.stage = 'waiting_verification'; task.runtime!.conversationUrl = undefined;
    useAccountStore.setState({ requestAvailabilityCheck: vi.fn((): void => {
      const paused = structuredClone(task); paused.status = 'paused'; paused.runtime!.stage = 'paused'; useTaskStore.setState({ tasks: [paused] });
      saveFreshAvailability(true);
    }) });
    render(<Node />); fireEvent.click(screen.getByRole('button', { name: '已完成验证，继续' }));
    await waitFor((): void => expect(usePetStoryStore.getState().resumeProduction).toHaveBeenCalledOnce());
    expect(usePetStoryStore.getState().generateShotMedia).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().resumeUnsubmittedVideo).not.toHaveBeenCalled(); expect(useTaskStore.getState().tasks).toHaveLength(1);
  });

  it.each(['paused', 'fail', 'cancelled'] as const)('已提交任务停在%s且无URL时仍显示原结果检查入口', async (status: 'paused' | 'fail' | 'cancelled'): Promise<void> => {
    task.status = status; task.runtime!.stage = status === 'fail' ? 'failed' : status; task.runtime!.conversationUrl = undefined;
    const before = structuredClone(task); render(<Node />); fireEvent.click(screen.getByRole('button', { name: '检查原视频结果' }));
    await waitFor((): void => expect(usePetStoryStore.getState().resumeProduction).toHaveBeenCalledOnce());
    expect(useAccountStore.getState().requestAvailabilityCheck).toHaveBeenCalledExactlyOnceWith(project.accountId);
    expect(usePetStoryStore.getState().generateShotMedia).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().resumeUnsubmittedVideo).not.toHaveBeenCalled(); expect(task).toEqual(before);
  });

  it.each(['run', 'account', 'submitted'] as const)('已提交验证任务的%s归属变化后旧按钮不能接续', async (change: 'run' | 'account' | 'submitted'): Promise<void> => {
    task.status = 'waiting_verification'; task.runtime!.stage = 'waiting_verification'; render(<Node />);
    const button = screen.getByRole('button', { name: '已完成验证，继续' });
    if (change === 'run') task.runtime!.runId = 'TEST-other-run';
    if (change === 'account') task.assignedAccountId = 'TEST-other-account';
    if (change === 'submitted') task.runtime!.submittedAt = '2026-11-02T00:00:00.000Z';
    fireEvent.click(button);
    await waitFor((): void => expect(screen.getByRole('alert').textContent).toContain('原视频任务状态已变化'));
    expect(useAccountStore.getState().requestAvailabilityCheck).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().resumeProduction).not.toHaveBeenCalled();
  });

  it('原任务仍有活动宿主时不展示可重复接续的验证操作', (): void => {
    task.status = 'waiting_verification'; task.runtime!.stage = 'waiting_verification';
    useTaskStore.setState({ executingTasks: { [project.accountId]: task.id }, activeTaskId: task.id }); render(<Node />);
    expect(screen.queryByRole('button', { name: '已完成验证，继续' })).toBeNull(); expect(screen.queryByRole('button', { name: '检查原视频结果' })).toBeNull();
    expect(usePetStoryStore.getState().generateShotMedia).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().resumeProduction).not.toHaveBeenCalled();
  });

  it('正式检查仍受理不明时在视频节点复用单次重发风险确认，未批准不发送', async (): Promise<void> => {
    task.status = 'paused'; task.runtime!.stage = 'paused'; task.runtime!.conversationUrl = undefined;
    task.errorInfo = { code: 'submission_uncertain', message: 'TEST 无法唯一归属原视频结果', recoverable: true, detectedAt: now };
    saveFreshAvailability(true); const before = structuredClone(task); render(<Node />);
    expect(screen.getByRole('region', { name: '原视频结果检查' }).textContent).toContain('确认重发一次');
    expect(screen.getByRole('button', { name: '检查原视频结果' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '确认重发一次' }));
    expect(screen.getByRole('dialog').textContent).toContain('可能产生重复结果或再次消耗额度');
    expect(usePetStoryStore.getState().resubmitProduction).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().generateShotMedia).not.toHaveBeenCalled(); expect(task).toEqual(before);
    fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }));
    await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
    expect(usePetStoryStore.getState().resubmitProduction).not.toHaveBeenCalled();
  });

  it('明确批准一次重发只调用既有原运行授权接口，不调用普通生成或未提交恢复', async (): Promise<void> => {
    task.status = 'paused'; task.runtime!.stage = 'paused'; task.runtime!.conversationUrl = undefined;
    task.errorInfo = { code: 'submission_uncertain', message: 'TEST 本轮检查仍未知', recoverable: true, detectedAt: now }; saveFreshAvailability(true);
    const before = structuredClone(task); render(<Node />);
    fireEvent.click(screen.getByRole('button', { name: '确认重发一次' }));
    fireEvent.click(screen.getByRole('button', { name: '确认风险，重发一次' }));
    await waitFor((): void => expect(usePetStoryStore.getState().resubmitProduction).toHaveBeenCalledExactlyOnceWith({
      taskId: task.id, runId: task.runtime!.runId, submittedAt: task.runtime!.submittedAt, authorizationId: expect.any(String), acceptDuplicateRisk: true,
    }));
    expect(usePetStoryStore.getState().generateShotMedia).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().resumeUnsubmittedVideo).not.toHaveBeenCalled(); expect(task).toEqual(before);
  });

  it('受理不明的原账号仍需验证时重发入口禁用，真实就绪后才可打开风险确认', async (): Promise<void> => {
    task.status = 'paused'; task.runtime!.stage = 'paused'; task.errorInfo = { code: 'submission_uncertain', message: 'TEST 本轮检查仍未知', recoverable: true, detectedAt: now };
    saveFreshAvailability(false); render(<Node />);
    expect(screen.getByRole('button', { name: '确认重发一次' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '确认重发一次' }));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(usePetStoryStore.getState().resubmitProduction).not.toHaveBeenCalled();
    await act(async (): Promise<void> => saveFreshAvailability(true));
    expect(screen.getByRole('button', { name: '确认重发一次' }).hasAttribute('disabled')).toBe(false);
    expect(usePetStoryStore.getState().resubmitProduction).not.toHaveBeenCalled();
  });

  it('风险确认打开后原提交身份变化，旧确认不会授权其他运行重发', async (): Promise<void> => {
    task.status = 'paused'; task.runtime!.stage = 'paused'; task.errorInfo = { code: 'submission_uncertain', message: 'TEST 本轮检查仍未知', recoverable: true, detectedAt: now }; saveFreshAvailability(true);
    render(<Node />); fireEvent.click(screen.getByRole('button', { name: '确认重发一次' }));
    task.runtime!.submittedAt = '2026-11-02T00:00:00.000Z';
    fireEvent.click(screen.getByRole('button', { name: '确认风险，重发一次' }));
    await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
    expect(usePetStoryStore.getState().resubmitProduction).not.toHaveBeenCalled();
  });

  it.each(['parameters', 'ordinary-pause', 'accepted', 'active', 'wrong-account'] as const)('%s没有本轮受理不明的安全出口时不在节点显示重发', (boundary: 'parameters' | 'ordinary-pause' | 'accepted' | 'active' | 'wrong-account'): void => {
    if (boundary !== 'parameters') {
      task.status = 'paused'; task.runtime!.stage = 'paused'; task.errorInfo = { code: boundary === 'ordinary-pause' ? 'manual_review_required' : 'submission_uncertain', message: 'TEST 原任务', recoverable: true, detectedAt: now };
    }
    if (boundary === 'accepted') task.outputs.push('https://example.test/TEST-video.mp4');
    if (boundary === 'active') useTaskStore.setState({ executingTasks: { [project.accountId]: task.id }, activeTaskId: task.id });
    if (boundary === 'wrong-account') task.assignedAccountId = 'TEST-other-account';
    render(<Node />); expect(screen.queryByRole('button', { name: '确认重发一次' })).toBeNull();
    expect(usePetStoryStore.getState().resubmitProduction).not.toHaveBeenCalled();
  });
});
