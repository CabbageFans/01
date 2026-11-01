/** 参数确认恢复沿真实 Zustand/TaskStore；IPC 与页面观察事件为明确 TEST 离线替身。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryProductionResult, PetStoryProject, Task } from '@doubao-studio/contracts';
import { observePetStoryTasks, usePetStoryStore, tickPetStoryProduction } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';

const original = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState() };
let unobserve: (() => void) | undefined;
type RuntimePatch = Parameters<ReturnType<typeof useTaskStore.getState>['updateTaskRuntime']>[1];
const now = '2026-11-01T02:30:00.000Z';
const reason = 'TEST 平台仍在等待视频生成参数确认，请人工确认后只读检查';
let project: PetStoryProject; let video: Task; let persisted: Task[]; let observed: string[]; let settlements: Array<() => Promise<void>>;
const list = vi.fn(); const pause = vi.fn(); const resume = vi.fn(); const advance = vi.fn(); const updateRuntime = vi.fn(); const start = vi.fn();

function saveProduction(state: 'running' | 'paused'): PetStoryProductionResult {
  project = { ...project, revision: project.revision + 1, production: { ...project.production!, state } };
  return { success: true, project: structuredClone(project) };
}
function restoreWaiting(): void {
  persisted[0].status = 'waiting_generation_confirmation';
  persisted[0].errorInfo = { code: 'generation_confirmation_required', message: reason, recoverable: true, detectedAt: now };
  useTaskStore.setState({ tasks: structuredClone(persisted) });
}
beforeEach((): void => {
  vi.clearAllMocks(); observed = []; settlements = [];
  const entry = { state: 'unknown' as const, reason: 'TEST' };
  project = { id: 'TEST-confirmation-project', schemaVersion: 1, revision: 1, studioProjectId: 'TEST-studio', accountId: 'TEST-account', updatedAt: now,
    source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [], production: { state: 'paused', phase: 'shots', planHash: 'TEST', approvedAt: now,
      capability: { accountId: 'TEST-account', image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [] }, fallbacks: {}, shots: {}, message: 'TEST',
      steps: [{ id: 'TEST-video-step', kind: 'video', shotId: 'TEST-shot', taskId: 'TEST-video', runId: 'TEST-run', status: 'bound', inputHash: 'TEST', attachmentAssetIds: [] }] } };
  const binding = { projectId: project.id, stepId: 'TEST-video-step' };
  const config: NonNullable<Task['videoConfig']> = { model: 'seedance-2.0-fast', duration: '7s', aspectRatio: '9:16' };
  video = { id: 'TEST-video', projectId: project.studioProjectId, assignedAccountId: project.accountId, petstory: binding, mode: 'video', videoConfig: config,
    prompt: 'TEST 原视频全文', attachments: ['TEST-first.png', 'TEST-last.png'], status: 'waiting_generation_confirmation', outputs: [], result: null, createdAt: now, updatedAt: now,
    errorInfo: { code: 'generation_confirmation_required', message: reason, recoverable: true, detectedAt: now },
    runtime: { runId: 'TEST-run', attempt: 1, stage: 'waiting_generation_confirmation', message: reason, startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
      conversationUrl: 'https://www.doubao.com/chat/TEST-original', generationConfirmation: { detectedAt: now, marker: 'confirm_before_generation', model: config.model, duration: config.duration, aspectRatio: config.aspectRatio },
      input: { mode: 'video', prompt: 'TEST 原视频全文', attachments: ['TEST-first.png', 'TEST-last.png'], videoConfig: config, petstory: binding },
      acceptanceObservation: { schemaVersion: 1, accountId: project.accountId, runId: 'TEST-run', conversationUrl: 'https://www.doubao.com/chat/TEST-original',
        acceptedAt: now, evidence: { kind: 'prompt_published' }, cursor: { messageCount: 1, pollCount: 0 }, expectedArtifact: { kind: 'video', runId: 'TEST-run' },
        lease: { ownerId: 'TEST-observer', acquiredAt: now, expiresAt: now, lastHeartbeatAt: now }, outcome: 'observing' } } };
  persisted = [structuredClone(video)];
  list.mockImplementation(async (): Promise<Task[]> => structuredClone(persisted));
  pause.mockImplementation(async (): Promise<PetStoryProductionResult> => saveProduction('paused'));
  resume.mockImplementation(async (): Promise<PetStoryProductionResult> => saveProduction('running'));
  advance.mockImplementation(async (): Promise<PetStoryProductionResult> => ({ success: true, project: structuredClone(project), taskId: video.id,
    action: ['executing', 'generating', 'manual_submission_observing', 'done'].includes(persisted[0].status) ? 'wait' : 'observe' }));
  updateRuntime.mockImplementation(async (taskId: string, patch: RuntimePatch): Promise<{ success: true; task: Task }> => {
    const task = persisted.find((item): boolean => item.id === taskId)!;
    const saved: Task = { ...task, ...patch, errorInfo: patch.errorInfo === null ? undefined : patch.errorInfo || task.errorInfo,
      runtime: task.runtime ? { ...task.runtime, ...patch.runtime } : undefined };
    persisted = persisted.map((item): Task => item.id === taskId ? saved : item);
    return { success: true, task: structuredClone(saved) };
  });
  const target = new EventTarget();
  target.addEventListener('reconcile-task-submission', (event: Event): void => {
    const detail = (event as CustomEvent<{ taskId: string; onSettled: () => Promise<void> }>).detail;
    observed.push(detail.taskId); settlements.push(detail.onSettled);
  });
  Object.assign(target, { electronAPI: { petstory: { generateShotMedia: resume, resumeProduction: resume, pauseProduction: pause, advanceProduction: advance }, tasks: { list, updateRuntime } } });
  vi.stubGlobal('window', target);
  usePetStoryStore.setState({ ...original.petstory, project, busy: false, error: '', capability: null });
  useTaskStore.setState({ ...original.tasks, tasks: structuredClone(persisted), activeTaskId: null, executingTasks: {}, accountBusy: {}, startAutomation: start });
});
afterEach(async (): Promise<void> => { unobserve?.(); unobserve = undefined; await Promise.all(settlements.map((settle): Promise<void> => settle())); usePetStoryStore.setState(original.petstory); useTaskStore.setState(original.tasks); useAccountStore.setState(original.accounts); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('平台视频参数确认保留真实原因并仅按显式操作回读', (): void => {
  it('验证后缺会话的原提交可显式核对当前页，保持原run并仅派发一次只读观察', async (): Promise<void> => {
    persisted[0].status = 'waiting_verification'; persisted[0].runtime!.stage = 'waiting_verification';
    persisted[0].runtime!.conversationUrl = undefined; persisted[0].runtime!.acceptanceObservation = undefined;
    persisted[0].errorInfo = { code: 'human_verification', message: 'TEST 人工验证', recoverable: true, detectedAt: now };
    useTaskStore.setState({ tasks: structuredClone(persisted) }); const before = structuredClone(persisted[0].runtime!);
    const events = vi.spyOn(window, 'dispatchEvent');
    await usePetStoryStore.getState().resumeProduction();
    expect(observed).toEqual([video.id]);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'reconcile-task-submission', detail: expect.objectContaining({ taskId: video.id, useCurrentPage: true }) }));
    expect(persisted[0].runtime!.runId).toBe(before.runId); expect(persisted[0].runtime!.submittedAt).toBe(before.submittedAt); expect(persisted[0].runtime!.input).toEqual(before.input);
    await tickPetStoryProduction(); expect(observed).toEqual([video.id]); expect(start).not.toHaveBeenCalled();
  });

  it('fresh验证恢复事件接回正在观察的原任务，缺URL也不另开观察，产物完成后继续接力', async (): Promise<void> => {
    const readyAt = new Date().toISOString();
    const account: Account = { id: project.accountId, name: 'TEST', platform: 'doubao', partition: 'TEST', status: 'idle', pinned: false, avatar: '', createdAt: now, updatedAt: now,
      health: { loginState: 'ok', verificationRequired: false, consecutiveFailures: 0, successCount: 0, failureCount: 0, availability: { state: 'ready', reason: 'ready', message: 'TEST', checkedAt: readyAt, source: 'manual' } } };
    useAccountStore.setState({ ...original.accounts, accounts: [account] });
    persisted[0].status = 'manual_submission_observing'; persisted[0].runtime!.stage = 'manual_submission_observing';
    persisted[0].runtime!.conversationUrl = undefined; persisted[0].runtime!.acceptanceObservation = undefined;
    useTaskStore.setState({ tasks: structuredClone(persisted) }); unobserve = observePetStoryTasks();
    const detail = { taskId: video.id, accountId: project.accountId, runId: video.runtime!.runId, submittedAt: video.runtime!.submittedAt, verificationCheckedAt: readyAt };
    window.dispatchEvent(new CustomEvent('task-verification-recovery-started', { detail }));
    window.dispatchEvent(new CustomEvent('task-verification-recovery-started', { detail }));
    await vi.waitFor((): void => { expect(resume).toHaveBeenCalledTimes(1); expect(usePetStoryStore.getState().busy).toBe(false); });
    expect(project.production!.state).toBe('running'); expect(observed).toEqual([]); expect(pause).not.toHaveBeenCalled();
    // 主进程回读期间状态可能由 paused 变为 manual，渲染进程也必须只等待既有观察器。
    advance.mockResolvedValueOnce({ success: true, project: structuredClone(project), taskId: video.id, action: 'observe' });
    await tickPetStoryProduction(); expect(observed).toEqual([]); expect(pause).not.toHaveBeenCalled();
    persisted[0].status = 'done';
    advance.mockImplementationOnce(async (): Promise<PetStoryProductionResult> => {
      project = { ...project, revision: project.revision + 1, production: { ...project.production!, state: 'complete', steps: project.production!.steps.map((step) => ({ ...step, status: 'complete' })) } };
      return { success: true, project: structuredClone(project), action: 'wait' };
    });
    await tickPetStoryProduction(); expect(usePetStoryStore.getState().project!.production!.state).toBe('complete'); expect(start).not.toHaveBeenCalled();
  });

  it('正式生成后的自动tick遇到参数确认直接暂停制作，不额外开启观察或覆盖成泛错误', async (): Promise<void> => {
    const before = structuredClone(video);
    await usePetStoryStore.getState().generateShotMedia('TEST-shot', 'video');
    expect(pause).toHaveBeenCalledWith(project.id); expect(observed).toEqual([]); expect(updateRuntime).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().project!.production!.state).toBe('paused'); expect(usePetStoryStore.getState().error).toBe(reason);
    expect(persisted).toEqual([before]);
    await tickPetStoryProduction(); expect(advance).toHaveBeenCalledTimes(1);
  });
  it('显式检查同一原任务只派发一次只读观察；仍需确认时保留真实原因，下一次显式检查可再次回读', async (): Promise<void> => {
    const before = structuredClone(video.runtime!);
    await usePetStoryStore.getState().resumeProduction();
    expect(observed).toEqual([video.id]); expect(persisted[0].status).toBe('manual_submission_observing'); expect(pause).not.toHaveBeenCalled();
    restoreWaiting(); await settlements[0](); await tickPetStoryProduction(); await tickPetStoryProduction();
    expect(observed).toEqual([video.id]); expect(usePetStoryStore.getState().error).toBe(reason); expect(project.production!.state).toBe('paused');
    expect(persisted[0].runtime!.runId).toBe(before.runId); expect(persisted[0].runtime!.submittedAt).toBe(before.submittedAt);
    expect(persisted[0].runtime!.input).toEqual(before.input); expect(persisted[0].runtime!.acceptanceObservation).toEqual(before.acceptanceObservation);
    expect(persisted[0].runtime!.generationConfirmation).toEqual(before.generationConfirmation);
    await usePetStoryStore.getState().resumeProduction(); expect(observed).toEqual([video.id, video.id]); expect(usePetStoryStore.getState().error).toBe(''); expect(start).not.toHaveBeenCalled();
  });
  it('确认完成后的原观察保持活跃，普通tick只等待原运行，不重复派发或暂停', async (): Promise<void> => {
    await usePetStoryStore.getState().resumeProduction();
    persisted[0].status = 'generating'; useTaskStore.setState({ tasks: structuredClone(persisted) });
    await tickPetStoryProduction(); await tickPetStoryProduction();
    expect(observed).toEqual([video.id]); expect(pause).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().error).toBe(''); expect(start).not.toHaveBeenCalled();
  });
  it('原会话读取失败后保留该次真实原因，并允许显式重新检查同一原运行', async (): Promise<void> => {
    await usePetStoryStore.getState().resumeProduction();
    const failure = 'TEST 原对话未同时匹配任务提示词与平台提交回执，无法安全绑定结果';
    persisted[0].status = 'paused'; persisted[0].errorInfo = { code: 'submission_uncertain', message: failure, recoverable: true, detectedAt: now };
    useTaskStore.setState({ tasks: structuredClone(persisted) }); await tickPetStoryProduction();
    // 状态写回早于页面finally；真实旧观察退出前先等待，不能覆盖错误或抢开第二轮。
    expect(pause).not.toHaveBeenCalled(); expect(observed).toEqual([video.id]); await settlements[0]();
    expect(usePetStoryStore.getState().error).toBe(failure); expect(observed).toEqual([video.id]);
    await usePetStoryStore.getState().resumeProduction();
    expect(observed).toEqual([video.id, video.id]); expect(usePetStoryStore.getState().error).toBe(''); expect(start).not.toHaveBeenCalled();
  });
  it('显式回读授权只属于捕获的原run，刷新发现run变化时不得沿旧授权继续观察', async (): Promise<void> => {
    const changed = structuredClone(video); changed.runtime!.runId = 'TEST-other-run';
    list.mockResolvedValueOnce([structuredClone(video)]).mockResolvedValueOnce([changed]);
    await usePetStoryStore.getState().resumeProduction();
    expect(observed).toEqual([]); expect(updateRuntime).not.toHaveBeenCalled(); expect(pause).toHaveBeenCalled(); expect(usePetStoryStore.getState().error).toBe(reason); expect(start).not.toHaveBeenCalled();
  });
  it('旧advance仍在途时显式检查保留原run的一次回读，待旧tick退出后执行且不自动循环', async (): Promise<void> => {
    await usePetStoryStore.getState().resumeProduction();
    persisted[0].status = 'generating'; useTaskStore.setState({ tasks: structuredClone(persisted) });
    const previous = structuredClone(project);
    let finishAdvance!: (result: PetStoryProductionResult) => void;
    advance.mockImplementationOnce((): Promise<PetStoryProductionResult> => new Promise((resolve): void => { finishAdvance = resolve; }));
    const oldTick = tickPetStoryProduction(); restoreWaiting();
    await usePetStoryStore.getState().resumeProduction();
    expect(observed).toEqual([video.id]); expect(usePetStoryStore.getState().busy).toBe(false);
    finishAdvance({ success: true, project: previous, action: 'wait' }); await oldTick; await settlements[0]();
    await tickPetStoryProduction();
    expect(observed).toEqual([video.id, video.id]); expect(pause).not.toHaveBeenCalled();
    restoreWaiting(); await settlements[1](); await tickPetStoryProduction();
    expect(observed).toEqual([video.id, video.id]); expect(usePetStoryStore.getState().error).toBe(reason); expect(start).not.toHaveBeenCalled();
  });
  it.each(['project', 'run', 'submittedAt'] as const)('等待旧tick时%s变化使待消费回读失效，不能沿旧授权观察', async (changed): Promise<void> => {
    await usePetStoryStore.getState().resumeProduction();
    persisted[0].status = 'generating'; useTaskStore.setState({ tasks: structuredClone(persisted) });
    const previous = structuredClone(project);
    let finishAdvance!: (result: PetStoryProductionResult) => void;
    advance.mockImplementationOnce((): Promise<PetStoryProductionResult> => new Promise((resolve): void => { finishAdvance = resolve; }));
    const oldTick = tickPetStoryProduction(); restoreWaiting(); await usePetStoryStore.getState().resumeProduction();
    if (changed === 'project') {
      usePetStoryStore.setState({ project: { ...structuredClone(project), id: 'TEST-other-project' } });
      await tickPetStoryProduction(); usePetStoryStore.setState({ project: structuredClone(project) });
    } else if (changed === 'run') persisted[0].runtime!.runId = 'TEST-other-run';
    else persisted[0].runtime!.submittedAt = '2026-11-01T02:31:00.000Z';
    finishAdvance({ success: true, project: previous, action: 'wait' }); await oldTick; await settlements[0](); await tickPetStoryProduction();
    expect(observed).toEqual([video.id]); expect(updateRuntime).toHaveBeenCalledTimes(1); expect(usePetStoryStore.getState().error).toBe(reason); expect(start).not.toHaveBeenCalled();
  });
  it('页面退出后仍残留manual观察状态时保存暂停，恢复检查入口且不自动循环', async (): Promise<void> => {
    await usePetStoryStore.getState().resumeProduction(); const before = structuredClone(persisted[0].runtime!);
    persisted[0].errorInfo = undefined; persisted[0].runtime!.message = 'TEST 原视频结果尚未读到';
    await settlements[0]();
    expect(persisted[0].status).toBe('paused'); expect(project.production!.state).toBe('paused'); expect(usePetStoryStore.getState().error).toBe('TEST 原视频结果尚未读到');
    expect(persisted[0].runtime!.input).toEqual(before.input); expect(persisted[0].runtime!.submittedAt).toBe(before.submittedAt); expect(persisted[0].runtime!.acceptanceObservation).toEqual(before.acceptanceObservation);
    await tickPetStoryProduction(); expect(observed).toEqual([video.id]);
    await usePetStoryStore.getState().resumeProduction(); expect(observed).toEqual([video.id, video.id]); expect(start).not.toHaveBeenCalled();
  });
  it('旧观察结束回调不能停止已显式恢复的新观察，成功产物不会被回调改成暂停', async (): Promise<void> => {
    await usePetStoryStore.getState().resumeProduction(); restoreWaiting(); await usePetStoryStore.getState().resumeProduction();
    expect(observed).toEqual([video.id]); await settlements[0](); expect(pause).not.toHaveBeenCalled();
    await tickPetStoryProduction(); expect(observed).toEqual([video.id, video.id]);
    await settlements[0](); expect(persisted[0].status).toBe('manual_submission_observing'); expect(pause).not.toHaveBeenCalled();
    persisted[0].status = 'done'; await settlements[1]();
    expect(persisted[0].status).toBe('done'); expect(pause).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
  it('显式resume写盘仍在途时旧observer结束也不暂停新恢复，随后只启动一次回读', async (): Promise<void> => {
    await usePetStoryStore.getState().resumeProduction(); restoreWaiting();
    let finishResume!: (result: PetStoryProductionResult) => void;
    resume.mockImplementationOnce((): Promise<PetStoryProductionResult> => new Promise((resolve): void => { finishResume = resolve; }));
    const resuming = usePetStoryStore.getState().resumeProduction(); expect(usePetStoryStore.getState().busy).toBe(true);
    await settlements[0](); expect(pause).not.toHaveBeenCalled();
    finishResume(saveProduction('running')); await resuming;
    expect(observed).toEqual([video.id, video.id]); expect(pause).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
  it('同项目制作已转到新task/run时，旧观察结束不得暂停新步骤', async (): Promise<void> => {
    await usePetStoryStore.getState().resumeProduction(); persisted[0].status = 'paused';
    project.production!.steps[0] = { ...project.production!.steps[0], taskId: 'TEST-new-video', runId: 'TEST-new-run' };
    usePetStoryStore.setState({ project: structuredClone(project) }); await settlements[0]();
    expect(project.production!.state).toBe('running'); expect(pause).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().error).toBe(''); expect(start).not.toHaveBeenCalled();
  });
  it('结束握手读取失败也会收回本轮授权并显示真实原因，不抛出未处理拒绝', async (): Promise<void> => {
    await usePetStoryStore.getState().resumeProduction(); list.mockRejectedValueOnce(new Error('TEST 结束状态回读失败'));
    await expect(settlements[0]()).resolves.toBeUndefined();
    expect(usePetStoryStore.getState().error).toBe('TEST 结束状态回读失败'); await tickPetStoryProduction(); expect(observed).toEqual([video.id]);
  });
});
