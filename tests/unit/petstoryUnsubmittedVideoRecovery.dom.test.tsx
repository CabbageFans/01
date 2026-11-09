/** 离线恢复回归：平台与 IPC 均为替身，验证未发送任务的身份与点击边界。 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryPlan, PetStoryProductionResult, PetStoryProject, Task } from '@doubao-studio/contracts';
import { CanvasMediaNode } from '../../src/components/PetStoryCanvasMedia';
import { observePetStoryTasks, petStoryReferenceVideoTask, petStoryUnsubmittedVideoTask, tickPetStoryProduction, usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { automationEngine } from '../../src/automation/AutomationEngine';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState() };
const now = '2026-10-31T00:00:00.000Z';
let project: PetStoryProject;
let task: Task;
let unobserve: (() => void) | undefined;

beforeEach((): void => {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan; plan.shots = plan.shots.slice(0, 1);
  const entry = { state: 'supported' as const, reason: 'TEST 离线入口' };
  project = { schemaVersion: 1, id: 'TEST-recovery-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, updatedAt: now,
    source: { kind: 'script', url: '', status: 'review_required' }, plan, assets: [], jobs: [],
    production: { state: 'paused', phase: 'shots', planHash: 'TEST', approvedAt: now, message: 'TEST 生成前停止', fallbacks: {}, shots: {},
      capability: { accountId: 'TEST-account', checkedAt: now, durations: [5], image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry } },
      steps: [{ id: 'TEST-original-step', shotId: plan.shots[0].id, kind: 'video', taskId: 'TEST-original-task', runId: 'TEST-original-run', status: 'bound', inputHash: 'TEST', attachmentAssetIds: ['TEST-first', 'TEST-last'] }] } };
  task = { id: 'TEST-original-task', projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'video', status: 'paused', prompt: 'TEST 保存的视频正文', outputs: [], result: null, createdAt: now, updatedAt: now,
    petstory: { projectId: project.id, stepId: 'TEST-original-step' },
    errorInfo: { code: 'petstory_controls_unconfirmed', message: 'TEST 当前实际模式槽位与批准模式不符，未上传、未发送', recoverable: true, detectedAt: now },
    runtime: { runId: 'TEST-original-run', attempt: 1, stage: 'configuring', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { mode: 'video', prompt: 'TEST 保存的视频正文', attachments: ['TEST-first-file', 'TEST-last-file'] } } };
  window.electronAPI = { petstory: { inspectGeneration: vi.fn(async (): Promise<{ success: true; eligibility: { ready: false; blockers: [] } }> => ({ success: true, eligibility: { ready: false, blockers: [] } })) }, tasks: { list: vi.fn(async (): Promise<Task[]> => [task]) } } as unknown as typeof window.electronAPI;
  usePetStoryStore.setState({ ...initial.pet, project, busy: false, error: '' });
  useTaskStore.setState({ ...initial.tasks, tasks: [task], executingTasks: {}, activeTaskId: null });
});
afterEach(async (): Promise<void> => {
  unobserve?.(); unobserve = undefined; vi.useRealTimers();
  // 完成离线 tick 以释放本文件显式恢复产生的内存授权，避免泄漏到下一用例。
  window.electronAPI.petstory.advanceProduction = vi.fn(async (): Promise<PetStoryProductionResult> => ({ success: true, project: { ...project, production: { ...project.production!, state: 'complete' } } }));
  await tickPetStoryProduction();
  usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.tasks); useAccountStore.setState(initial.accounts); vi.restoreAllMocks();
});

describe('未发送视频任务的画布恢复', (): void => {
  function withReferenceFrames(): void {
    const shot = project.plan!.shots[0]; shot.requestedMode = 'first_last_frame';
    shot.prompts.video.promptTask = { mode: 'first_last_frame', dialect: 'seedance20', references: [] };
    project.assets = (['firstFrame', 'plannedEndImage'] as const).map((kind, index): PetStoryProject['assets'][number] => ({ id: index ? 'TEST-last' : 'TEST-first', shotId: shot.id, kind, relativePath: 'TEST.png',
      validation: { decoded: true, sha256: 'a'.repeat(64), bytes: 1, width: 64, height: 96, checkedAt: now }, imageReview: { state: 'adopted', target: { shotId: shot.id, kind: index ? 'lastFrame' : 'firstFrame' }, basisHash: 'TEST', sha256: 'a'.repeat(64), adoptedAt: now } }));
    project.adoptedImages = { [shot.id]: { firstFrameId: 'TEST-first', plannedEndImageId: 'TEST-last' } };
    project.production!.shots[shot.id] = { requestedMode: 'first_last_frame', resolvedMode: 'first_last_frame', reason: 'TEST', firstFrameId: 'TEST-first', plannedEndImageId: 'TEST-last' };
    const step = project.production!.steps[0];
    step.compiledPrompt = { text: task.prompt, final: shot.prompts.video.final, rulesVersion: 'TEST', kind: 'video', requestedMode: 'first_last_frame', resolvedMode: 'first_last_frame',
      references: [{ assetId: 'TEST-first', characterIds: [], order: 1, purpose: 'firstFrame', slot: 'first' }, { assetId: 'TEST-last', characterIds: [], order: 2, purpose: 'plannedEndImage', slot: 'last' }] };
    task.attachments = ['TEST-first-file', 'TEST-last-file'];
  }
  function withUnboundRun(): void {
    withReferenceFrames(); delete project.production!.steps[0].runId;
    task.promptReadback = 'exact'; task.runtime!.input.promptReadback = 'exact'; task.runtime!.input.petstory = structuredClone(task.petstory);
    task.runtime!.stage = 'paused';
    task.runHistory = [{ runId: task.runtime!.runId, attempt: task.runtime!.attempt, startedAt: task.runtime!.startedAt,
      finishedAt: now, finalStage: 'paused', outcome: 'paused', errorCode: task.errorInfo!.code }];
  }
  it.each(['petstory_controls_unconfirmed', 'dispatch_not_ready'])('未派发新run以%s停止，完整原输入与运行记录只提供服务器复核入口', async (code: string): Promise<void> => {
    task.errorInfo!.code = code; withUnboundRun();
    expect(petStoryUnsubmittedVideoTask(project, project.plan!.shots[0].id, [task])).toBe(task);
    const resume = vi.fn(); usePetStoryStore.setState({ resumeUnsubmittedVideo: resume });
    render(<CanvasMediaNode project={project} shot={project.plan!.shots[0]} kind="video" disabled />);
    expect(screen.getByRole('button', { name: /继续生成视频/ }).hasAttribute('disabled')).toBe(false);
    expect(resume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /继续生成视频/ }));
    await waitFor((): void => expect(resume).toHaveBeenCalledExactlyOnceWith(project.plan!.shots[0].id, task.id, task.runtime!.runId));
    expect(project.production!.steps[0].runId).toBeUndefined(); expect(task.runtime!.submittedAt).toBeUndefined();
  });
  it.each(['missing-record', 'marker', 'body', 'attachments', 'config', 'compiled', 'reference-order', 'nonempty-old-run', 'submitted', 'media-receipt'] as const)('未绑定新run的%s事实不符时不开放恢复', (change): void => {
    withUnboundRun();
    if (change === 'missing-record') task.runHistory = [];
    if (change === 'marker') task.runtime!.input.petstory!.stepId = 'TEST-foreign-step';
    if (change === 'body') task.runtime!.input.prompt = 'TEST-user-changed-body';
    if (change === 'attachments') task.runtime!.input.attachments = ['TEST-foreign-file'];
    if (change === 'config') task.runtime!.input.videoConfig = { model: 'seedance-2.0', duration: '5s', aspectRatio: '16:9' };
    if (change === 'compiled') project.production!.steps[0].compiledPrompt!.text = 'TEST-old-input';
    if (change === 'reference-order') project.production!.steps[0].compiledPrompt!.references.reverse();
    if (change === 'nonempty-old-run') project.production!.steps[0].runId = 'TEST-other-run';
    if (change === 'submitted') task.runtime!.submittedAt = now;
    if (change === 'media-receipt') Object.assign(task.runtime!, { mediaSubmissionReceipt: { source: 'published_message' } });
    expect(petStoryUnsubmittedVideoTask(project, project.plan!.shots[0].id, [task])).toBeUndefined();
  });
  it('已有首尾图时只提供原任务继续入口，不要求额外改模式授权', async (): Promise<void> => {
    withReferenceFrames(); const resume = vi.fn(async (): Promise<void> => undefined); const references = vi.fn(); const generate = vi.fn();
    usePetStoryStore.setState({ project, resumeUnsubmittedVideo: resume, resumeVideoAsReferences: references, generateShotMedia: generate });
    const view = render(<CanvasMediaNode project={project} shot={project.plan!.shots[0]} kind="video" disabled />);
    expect(screen.queryByRole('button', { name: '改用两张参考图继续' })).toBeNull();
    expect(view.container.querySelectorAll('.canvas-media-actions button')).toHaveLength(2);
    expect(view.container.textContent).not.toContain('首尾图作为普通参考上传');
    fireEvent.click(screen.getByRole('button', { name: /继续生成视频/ }));
    await waitFor((): void => expect(resume).toHaveBeenCalledExactlyOnceWith(project.plan!.shots[0].id, task.id, task.runtime!.runId));
    expect(references).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });
  it.each([
    '当前豆包入口只有参考图上传，不支持独立首尾帧；本次尚未上传或提交。可在本镜制作设置选择“多参考”，经你明确选择后使用已有图片。',
    '已选图片已保留；当前豆包入口未确认独立首尾帧上传槽，本次尚未上传或提交。也可明确选择“改用两张参考图继续”（不保证原生首尾帧约束）。',
  ])('旧步骤错误不再引导已撤销的改模式入口，原记录保持原样', (error: string): void => {
    withReferenceFrames(); project.production!.steps[0].error = error;
    const view = render(<CanvasMediaNode project={project} shot={project.plan!.shots[0]} kind="video" disabled />);
    expect(view.container.textContent).toContain('请继续原视频任务，重新读取当前入口');
    expect(view.container.textContent).not.toContain('改用两张参考图继续');
    expect(view.container.textContent).not.toContain('可在本镜制作设置选择');
    expect(project.production!.steps[0].error).toBe(error);
    expect(screen.getByRole('button', { name: /继续生成视频/ })).toBeDefined();
  });
  it.each(['video_duration_control_not_ready', 'video_aspect_ratio_control_not_ready'])('%s不显示改用两参考图授权', (code: string): void => {
    withReferenceFrames(); task.errorInfo!.code = code;
    expect(petStoryReferenceVideoTask(project, project.plan!.shots[0].id, [task])).toBeUndefined();
  });
  it('两图授权刷新后采用图已变化时不调用正式恢复接口', async (): Promise<void> => {
    withReferenceFrames(); const resume = vi.fn(); window.electronAPI.petstory.resumeReferenceVideo = resume;
    window.electronAPI.tasks.list = vi.fn(async (): Promise<Task[]> => { usePetStoryStore.setState({ project: { ...project, adoptedImages: {} } }); return [task]; });
    await initial.pet.resumeVideoAsReferences(project.plan!.shots[0].id, task.id, task.runtime!.runId);
    expect(resume).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().error).toContain('首尾选图已变化');
  });
  it('store明确授权只调用具体两参考图接口，传当前版本和原输入身份', async (): Promise<void> => {
    withReferenceFrames(); const resume = vi.fn(async (): Promise<PetStoryProductionResult> => ({ success: true, project }));
    const generate = vi.fn(); window.electronAPI.petstory.resumeReferenceVideo = resume; window.electronAPI.petstory.generateShotMedia = generate;
    window.electronAPI.petstory.advanceProduction = vi.fn(async (): Promise<PetStoryProductionResult> => ({ success: true, project }));
    await initial.pet.resumeVideoAsReferences(project.plan!.shots[0].id, task.id, task.runtime!.runId);
    expect(resume).toHaveBeenCalledExactlyOnceWith(project.id, project.revision, { shotId: project.plan!.shots[0].id, taskId: task.id, runId: task.runtime!.runId, inputHash: 'TEST',
      firstFrameId: 'TEST-first', lastFrameId: 'TEST-last', authorizationId: expect.any(String), useExistingFrames: true });
    expect(generate).not.toHaveBeenCalled(); expect(task.runtime!.submittedAt).toBeUndefined();
  });
  it.each(['petstory_controls_unconfirmed', 'video_aspect_ratio_control_not_ready', 'video_duration_control_not_ready', 'page_unrecognized', 'page_loading', 'page_changed', 'authentication_unconfirmed', 'cancelled'])('%s 保留原任务恢复入口', (code: string): void => {
    task.errorInfo!.code = code;
    expect(petStoryUnsubmittedVideoTask(project, project.plan!.shots[0].id, [task])).toBe(task);
  });

  const exclusions: [string, (p: PetStoryProject, t: Task) => void][] = [
    ['已有 submittedAt', (_p, t): void => { t.runtime!.submittedAt = now; }],
    ['已有受理记录', (_p, t): void => { Object.assign(t.runtime!, { acceptanceObservation: { outcome: 'manual_review' } }); }],
    ['已有媒体提交回执', (_p, t): void => { Object.assign(t.runtime!, { mediaSubmissionReceipt: { source: 'published_message' } }); }],
    ['已有 Chat 回复', (_p, t): void => { t.runtime!.chatResponse = { text: 'TEST', capturedAt: now }; }],
    ['已有 Chat 回读', (_p, t): void => { Object.assign(t.runtime!, { chatReadback: { runId: t.runtime!.runId } }); }],
    ['已有 Chat 核对候选', (_p, t): void => { t.runtime!.chatReadbackReview = { runId: t.runtime!.runId, checkedAt: now, reason: 'TEST', candidates: [] }; }],
    ['已有只读观察', (_p, t): void => { t.runtime!.manualObservation = { startedAt: now, expiresAt: now, source: 'stored_conversation', outcome: 'manual_review' }; }],
    ['已有产物输出', (_p, t): void => { t.outputs = ['TEST-output']; }],
    ['已有结构化产物', (_p, t): void => { Object.assign(t, { artifacts: [{ id: 'TEST-artifact' }] }); }],
    ['已有有效任务锁', (_p, t): void => { Object.assign(t, { lock: { expiresAt: new Date(Date.now() + 60_000).toISOString() } }); }],
    ['有 Chat 调整保护', (_p, t): void => { t.runtime!.chatAdjustmentGuard = { projectId: project.id, adjustmentId: 'TEST-adjustment', active: true }; }],
    ['运行身份已改变', (_p, t): void => { t.runtime!.runId = 'TEST-new-run'; }],
    ['步骤身份不符', (_p, t): void => { t.petstory!.stepId = 'TEST-other-step'; }],
    ['账号不符', (_p, t): void => { t.assignedAccountId = 'TEST-other-account'; }],
    ['归属项目不符', (_p, t): void => { t.projectId = 'TEST-other-studio'; }],
    ['制作正在运行', (p): void => { p.production!.state = 'running'; }],
    ['正在等待人工验证', (_p, t): void => { t.status = 'waiting_verification'; t.errorInfo!.code = 'page_unrecognized'; }],
    ['非明确准备错误', (_p, t): void => { t.errorInfo!.code = 'submission_uncertain'; }],
  ];
  it.each(exclusions)('%s 时不提供未发送恢复', (_label: string, change: (p: PetStoryProject, t: Task) => void): void => {
    change(project, task);
    expect(petStoryUnsubmittedVideoTask(project, project.plan!.shots[0].id, [task])).toBeUndefined();
  });

  it.each(['network_error', 'page_error', 'invalid_page_url', 'platform_mismatch', 'region_restricted', 'material_authorization_required', 'human_verification', 'unknown', 'submission_uncertain'])('%s 不属于页面准备恢复白名单', (code: string): void => {
    task.errorInfo!.code = code;
    expect(petStoryUnsubmittedVideoTask(project, project.plan!.shots[0].id, [task])).toBeUndefined();
  });

  it.each([
    { code: 'page_unrecognized', status: 'paused' }, { code: 'page_loading', status: 'paused' },
    { code: 'page_changed', status: 'paused' }, { code: 'authentication_unconfirmed', status: 'paused' },
    { code: 'cancelled', status: 'paused' }, { code: 'cancelled', status: 'cancelled' },
  ] as const)('准备阶段$code／$status停止后，画布显式点击仅经正式恢复和调度继续原任务', async ({ code, status }): Promise<void> => {
    task.errorInfo!.code = code; task.status = status; task.runtime!.stage = 'paused';
    const before = structuredClone(task); const start = vi.fn(async (): Promise<boolean> => true);
    const resumed = { ...project, revision: 2, production: { ...project.production!, state: 'running' as const } };
    const resume = vi.fn(async (): Promise<PetStoryProductionResult> => ({ success: true, project: resumed }));
    const advance = vi.fn(async (): Promise<PetStoryProductionResult> => ({ success: true, project: resumed, taskId: task.id, action: 'start' }));
    const generate = vi.fn(); window.electronAPI.petstory.resumeProduction = resume; window.electronAPI.petstory.advanceProduction = advance;
    window.electronAPI.petstory.generateShotMedia = generate; useTaskStore.setState({ startAutomation: start });
    const view = render(<CanvasMediaNode project={project} shot={project.plan!.shots[0]} kind="video" disabled />);
    const button = screen.getByRole('button', { name: /继续生成视频/ }); expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('button', { name: /^生成视频$/ })).toBeNull();
    expect(resume).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor((): void => expect(start).toHaveBeenCalledExactlyOnceWith(task.id, expect.any(Function)));
    expect(resume).toHaveBeenCalledExactlyOnceWith(project.id, undefined); expect(advance).toHaveBeenCalledExactlyOnceWith(project.id);
    expect(generate).not.toHaveBeenCalled(); expect(task).toEqual(before); expect(useTaskStore.getState().tasks).toHaveLength(1);
    expect(usePetStoryStore.getState().error).toBe(''); view.unmount();
  });

  it.each(['waiting_verification', 'submission_uncertain', 'media_receipt'] as const)('画布遇到%s仍不提供未提交继续入口，也不调度新任务', (reason): void => {
    task.errorInfo!.code = 'page_unrecognized';
    if (reason === 'waiting_verification') task.status = 'waiting_verification';
    if (reason === 'submission_uncertain') task.errorInfo!.code = reason;
    if (reason === 'media_receipt') Object.assign(task.runtime!, { mediaSubmissionReceipt: { source: 'published_message' } });
    const before = structuredClone(task); const resume = vi.fn(); const generate = vi.fn(); const start = vi.fn();
    usePetStoryStore.setState({ resumeUnsubmittedVideo: resume, generateShotMedia: generate }); useTaskStore.setState({ startAutomation: start });
    const view = render(<CanvasMediaNode project={project} shot={project.plan!.shots[0]} kind="video" disabled />);
    expect(screen.queryByRole('button', { name: /继续生成视频/ })).toBeNull();
    const generateButton = screen.queryByRole('button', { name: /^生成视频$/ });
    if (generateButton) expect(generateButton.hasAttribute('disabled')).toBe(true);
    expect(resume).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(task).toEqual(before);
    view.unmount();
  });

  it('活跃执行任务不提供恢复', (): void => {
    expect(petStoryUnsubmittedVideoTask(project, project.plan!.shots[0].id, [task], [task.id])).toBeUndefined();
  });

  it('入口失败后正式锁已释放但本地仍有旧锁，补读原任务后恢复单一继续入口，不自动发送', async (): Promise<void> => {
    vi.useFakeTimers(); withReferenceFrames(); task.status = 'fail'; task.executionIntent = 'armed';
    task.errorInfo!.code = 'video_mode_entry_not_ready'; task.runtime!.stage = 'failed';
    task.lock = { ownerId: 'TEST-old-owner', acquiredAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const current = structuredClone(task); delete current.lock;
    const listed = vi.fn(async (): Promise<Task[]> => [current]); window.electronAPI.tasks.list = listed;
    const resume = vi.fn(async (): Promise<void> => undefined); const generate = vi.fn(); const references = vi.fn();
    usePetStoryStore.setState({ resumeUnsubmittedVideo: resume, generateShotMedia: generate, resumeVideoAsReferences: references });
    const view = render(<CanvasMediaNode project={project} shot={project.plan!.shots[0]} kind="video" disabled />);
    expect(screen.queryByRole('button', { name: /继续生成视频/ })).toBeNull();
    unobserve = observePetStoryTasks();
    await act(async (): Promise<void> => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(listed).toHaveBeenCalledOnce();
    expect(view.container.querySelectorAll('.canvas-media-actions button')).toHaveLength(2);
    const button = screen.getByRole('button', { name: /继续生成视频/ }); expect(button.hasAttribute('disabled')).toBe(false);
    expect(resume).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled(); expect(references).not.toHaveBeenCalled();
    await act(async (): Promise<void> => { fireEvent.click(button); });
    expect(resume).toHaveBeenCalledExactlyOnceWith(project.plan!.shots[0].id, task.id, task.runtime!.runId);
    expect(useTaskStore.getState().tasks[0].runtime?.input).toEqual(task.runtime!.input);
  });

  it('锁释放落盘晚于首次回读时保持阻止，后续只读回读确认释放才开放继续', async (): Promise<void> => {
    vi.useFakeTimers(); task.status = 'fail'; task.errorInfo!.code = 'video_mode_entry_not_ready';
    task.lock = { ownerId: 'TEST-owner', acquiredAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const released = structuredClone(task); delete released.lock;
    const listed = vi.fn(async (): Promise<Task[]> => [task]).mockResolvedValueOnce([structuredClone(task)]).mockResolvedValueOnce([released]);
    const reserved = vi.spyOn(automationEngine, 'isReserved').mockReturnValue(true);
    window.electronAPI.tasks.list = listed; unobserve = observePetStoryTasks();
    await vi.advanceTimersByTimeAsync(1_000); expect(listed).not.toHaveBeenCalled();
    reserved.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(petStoryUnsubmittedVideoTask(project, project.plan!.shots[0].id, useTaskStore.getState().tasks)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(petStoryUnsubmittedVideoTask(project, project.plan!.shots[0].id, useTaskStore.getState().tasks)?.id).toBe(task.id);
    expect(listed).toHaveBeenCalledTimes(2);
  });

  it('旧锁回读期间开始新运行，迟到快照不覆盖新运行或开放继续', async (): Promise<void> => {
    vi.useFakeTimers(); task.status = 'fail'; task.errorInfo!.code = 'video_mode_entry_not_ready';
    task.lock = { ownerId: 'TEST-old-owner', acquiredAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    let resolveRead!: (tasks: Task[]) => void;
    window.electronAPI.tasks.list = vi.fn((): Promise<Task[]> => new Promise((resolve): void => { resolveRead = resolve; }));
    unobserve = observePetStoryTasks(); await vi.advanceTimersByTimeAsync(1_000);
    const running = { ...task, status: 'executing' as const, runtime: { ...task.runtime!, runId: 'TEST-new-run' } };
    useTaskStore.setState({ tasks: [running], executingTasks: { [project.accountId]: task.id } });
    const released = structuredClone(task); delete released.lock; resolveRead([released]); await Promise.resolve();
    expect(useTaskStore.getState().tasks[0]).toBe(running);
    expect(petStoryUnsubmittedVideoTask(project, project.plan!.shots[0].id, useTaskStore.getState().tasks)).toBeUndefined();
  });

  it('模式核验失败直接显示继续按钮，点击传原 taskId/runId，不新建图片或视频请求', async (): Promise<void> => {
    const resume = vi.fn(async (): Promise<void> => undefined); const generate = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ resumeUnsubmittedVideo: resume, generateShotMedia: generate });
    render(<CanvasMediaNode project={project} shot={project.plan!.shots[0]} kind="video" disabled />);
    const button = screen.getByRole('button', { name: /继续生成视频/ });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('生成前准备未完成，尚未发送')).toBeDefined();
    expect(screen.queryByText('等待原任务产物')).toBeNull();
    expect(resume).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor((): void => expect(resume).toHaveBeenCalledExactlyOnceWith(project.plan!.shots[0].id, task.id, task.runtime!.runId));
    expect(generate).not.toHaveBeenCalled();
  });

  it('已提交但没有参数确认记录的暂停任务只检查原结果，不开放继续生成', async (): Promise<void> => {
    task.runtime!.submittedAt = now;
    const resume = vi.fn(async (): Promise<void> => undefined); const generate = vi.fn();
    const account: Account = { id: project.accountId, name: 'TEST 原执行账号', platform: 'doubao', partition: 'persist:TEST-original-account', status: 'idle', pinned: false, avatar: '', createdAt: now, updatedAt: now };
    const check = vi.fn((): void => useAccountStore.setState({ accounts: [{ ...account, health: {
      loginState: 'ok', verificationRequired: false, consecutiveFailures: 0, successCount: 0, failureCount: 0,
      availability: { state: 'ready', reason: 'ready', message: 'TEST 原账号真实检测就绪', checkedAt: new Date().toISOString(), source: 'manual' },
    } }], availabilityChecking: { [account.id]: false } }));
    useAccountStore.setState({ accounts: [account], requestAvailabilityCheck: check });
    usePetStoryStore.setState({ resumeProduction: resume, generateShotMedia: generate });
    render(<CanvasMediaNode project={project} shot={project.plan!.shots[0]} kind="video" disabled />);
    await act(async (): Promise<void> => undefined);
    expect(screen.queryByRole('button', { name: /继续生成视频/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^生成视频$/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '检查原视频结果' }));
    await waitFor((): void => expect(resume).toHaveBeenCalledOnce());
    expect(check).toHaveBeenCalledExactlyOnceWith(project.accountId); expect(generate).not.toHaveBeenCalled();
  });

  it('恢复前刷新运行状态，变为已提交则不调用服务或开始自动化', async (): Promise<void> => {
    const resume = vi.fn(); const start = vi.fn();
    window.electronAPI.petstory.resumeProduction = resume;
    window.electronAPI.tasks.list = vi.fn(async (): Promise<Task[]> => [{ ...task, runtime: { ...task.runtime!, submittedAt: now } }]);
    useTaskStore.setState({ startAutomation: start });
    await initial.pet.resumeUnsubmittedVideo(project.plan!.shots[0].id, task.id, task.runtime!.runId);
    expect(resume).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().error).toContain('原任务状态已变化');
  });

  it('显式继续只恢复并调度原 taskId，保留原输入和首尾素材', async (): Promise<void> => {
    const before = structuredClone(task); const start = vi.fn(async (): Promise<boolean> => true);
    const resumed = { ...project, revision: 2, production: { ...project.production!, state: 'running' as const } };
    const resume = vi.fn(async (): Promise<PetStoryProductionResult> => ({ success: true, project: resumed }));
    const advance = vi.fn(async (): Promise<PetStoryProductionResult> => ({ success: true, project: resumed, taskId: task.id, action: 'start' }));
    const generate = vi.fn(); window.electronAPI.petstory.resumeProduction = resume; window.electronAPI.petstory.advanceProduction = advance;
    window.electronAPI.petstory.generateShotMedia = generate; useTaskStore.setState({ startAutomation: start });
    await initial.pet.resumeUnsubmittedVideo(project.plan!.shots[0].id, task.id, task.runtime!.runId);
    expect(resume).toHaveBeenCalledExactlyOnceWith(project.id, undefined);
    expect(advance).toHaveBeenCalledExactlyOnceWith(project.id);
    expect(start).toHaveBeenCalledExactlyOnceWith(task.id, expect.any(Function));
    expect(generate).not.toHaveBeenCalled(); expect(task).toEqual(before);
    expect(usePetStoryStore.getState().error).toBe('');
  });
});
