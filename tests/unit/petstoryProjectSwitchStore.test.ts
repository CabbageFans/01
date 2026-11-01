/** 项目切换沿真实 Zustand/TaskStore 暂停链；IPC 与控制器为明确 TEST 离线替身。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryProject, PetStoryResult, Task } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import { automationEngine } from '../../src/automation/AutomationEngine';

const original = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState(), projects: useProjectStore.getState() };
type RuntimePatch = Parameters<ReturnType<typeof useTaskStore.getState>['updateTaskRuntime']>[1];
const now = '2026-11-01T01:30:00.000Z';
let project: PetStoryProject; let other: PetStoryProject; let video: Task; let persisted: Task[]; let controller: AbortController; let order: string[];
const open = vi.fn(); const create = vi.fn(); const pauseProduction = vi.fn(); const updateRuntime = vi.fn();

beforeEach((): void => {
  vi.clearAllMocks(); order = []; controller = new AbortController();
  const entry = { state: 'unknown' as const, reason: 'TEST' };
  project = { id: 'TEST-original-project', schemaVersion: 1, revision: 1, studioProjectId: 'TEST-studio', accountId: 'TEST-account', updatedAt: now,
    source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [], production: { state: 'running', phase: 'shots', planHash: 'TEST', approvedAt: now,
      capability: { accountId: 'TEST-account', image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [] }, fallbacks: {}, shots: {}, message: 'TEST',
      steps: [{ id: 'TEST-video-step', kind: 'video', shotId: 'TEST-shot', taskId: 'TEST-video', runId: 'TEST-run', status: 'bound', inputHash: 'TEST', attachmentAssetIds: [] }] } };
  other = { ...structuredClone(project), id: 'TEST-other-project', production: undefined };
  const binding = { projectId: project.id, stepId: 'TEST-video-step' };
  const config: NonNullable<Task['videoConfig']> = { model: 'seedance-2.0-fast', duration: '5s', aspectRatio: '9:16' };
  video = { id: 'TEST-video', projectId: project.studioProjectId, assignedAccountId: project.accountId, petstory: binding, mode: 'video', videoConfig: config,
    prompt: 'TEST 原视频全文', attachments: ['TEST-first.png', 'TEST-last.png'], status: 'generating', outputs: [], result: null, createdAt: now, updatedAt: now,
    runtime: { runId: 'TEST-run', attempt: 1, stage: 'generating', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
      input: { mode: 'video', prompt: 'TEST 原视频全文', attachments: ['TEST-first.png', 'TEST-last.png'], videoConfig: config, petstory: binding },
      acceptanceObservation: { schemaVersion: 1, accountId: project.accountId, runId: 'TEST-run', conversationUrl: 'https://www.doubao.com/chat/TEST-original',
        acceptedAt: now, evidence: { kind: 'generation_started' }, cursor: { messageCount: 1, pollCount: 0 }, expectedArtifact: { kind: 'video', runId: 'TEST-run' },
        lease: { ownerId: 'TEST-observer', acquiredAt: now, expiresAt: now, lastHeartbeatAt: now }, outcome: 'observing' } } };
  persisted = [structuredClone(video)];
  const target = new EventTarget();
  target.addEventListener('cancel-task-automation', (event: Event): void => {
    const detail = (event as CustomEvent<{ taskId: string; targetStatus?: string }>).detail;
    order.push(`cancel:${detail.taskId}:${detail.targetStatus}`); if (detail.taskId === video.id) controller.abort();
  });
  pauseProduction.mockImplementation(async (id: string): Promise<PetStoryResult> => {
    order.push(`pause:${id}`); expect(controller.signal.aborted).toBe(true);
    project = { ...project, revision: project.revision + 1, production: { ...project.production!, state: 'paused' } };
    return { success: true, project: structuredClone(project) };
  });
  updateRuntime.mockImplementation(async (taskId: string, patch: RuntimePatch): Promise<{ success: true; task: Task }> => {
    const task = persisted.find((item): boolean => item.id === taskId)!;
    const saved: Task = { ...task, ...patch, errorInfo: patch.errorInfo === null ? undefined : patch.errorInfo || task.errorInfo,
      runtime: task.runtime ? { ...task.runtime, ...patch.runtime } : undefined };
    persisted = persisted.map((item): Task => item.id === taskId ? saved : item); order.push(`task:${taskId}:${saved.status}`);
    return { success: true, task: structuredClone(saved) };
  });
  const select = async (): Promise<PetStoryResult> => { order.push('select'); return { success: true, project: structuredClone(other) }; };
  open.mockImplementation(select); create.mockImplementation(select);
  Object.assign(target, { electronAPI: { petstory: { open, create, pauseProduction }, tasks: { list: async (): Promise<Task[]> => structuredClone(persisted), updateRuntime },
    logs: { append: vi.fn() }, accounts: { setStatus: vi.fn(async (): Promise<{ success: true }> => ({ success: true })) } } });
  vi.stubGlobal('window', target); vi.spyOn(automationEngine, 'hasController').mockImplementation((id: string): boolean => id === video.id && !controller.signal.aborted);
  usePetStoryStore.setState({ ...original.petstory, project, busy: false, error: '', activeImageOperationId: null });
  useTaskStore.setState({ ...original.tasks, tasks: structuredClone(persisted), executingTasks: { [project.accountId]: video.id }, accountBusy: { [project.accountId]: true } });
  useAccountStore.setState({ ...original.accounts, accounts: [], selectedAccountId: project.accountId });
  useProjectStore.setState({ ...original.projects, projects: [{ id: project.studioProjectId, name: 'TEST-studio', description: '', color: '#fff', archived: false, createdAt: now, updatedAt: now }], selectProject: vi.fn() });
});
afterEach((): void => { usePetStoryStore.setState(original.petstory); useTaskStore.setState(original.tasks); useAccountStore.setState(original.accounts); useProjectStore.setState(original.projects); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('切换项目前暂停正式视频，保留原提交证据', (): void => {
  it.each(['executing', 'generating', 'manual_submission_observing'] as const)('打开另一项目前同步停止%s原控制器，再保存暂停状态', async (status): Promise<void> => {
    persisted[0].status = status; useTaskStore.setState({ tasks: structuredClone(persisted) }); const evidence = structuredClone(video.runtime!);
    await usePetStoryStore.getState().openProject('TEST/other-project');
    expect(order[0]).toBe(`cancel:${video.id}:paused`); expect(order.indexOf(`pause:${project.id}`)).toBeLessThan(order.indexOf('select'));
    expect(project.production!.state).toBe('paused'); expect(controller.signal.aborted).toBe(true); expect(persisted[0].status).toBe('paused');
    expect(persisted[0].runtime!.runId).toBe(evidence.runId); expect(persisted[0].runtime!.submittedAt).toBe(evidence.submittedAt);
    expect(persisted[0].runtime!.input).toEqual(evidence.input); expect(persisted[0].runtime!.acceptanceObservation).toEqual(evidence.acceptanceObservation);
    expect(usePetStoryStore.getState().project!.id).toBe(other.id); expect(create).not.toHaveBeenCalled();
  });
  it('新建项目同样先暂停原制作，暂停写盘失败时保留原项目且不调用create', async (): Promise<void> => {
    pauseProduction.mockResolvedValueOnce({ success: false, error: 'TEST 暂停写盘失败' });
    await usePetStoryStore.getState().createProject({ accountId: project.accountId, studioProjectId: project.studioProjectId });
    expect(controller.signal.aborted).toBe(true); expect(create).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().project!.id).toBe(project.id); expect(usePetStoryStore.getState().error).toContain('暂停写盘失败');
  });
  it('打开失败仍保留已暂停的原项目和原视频，不复活控制器或清除提交证据', async (): Promise<void> => {
    open.mockResolvedValueOnce({ success: false, error: 'TEST 打开失败' }); const before = structuredClone(video);
    await usePetStoryStore.getState().openProject('TEST/broken-project');
    expect(usePetStoryStore.getState().project!.id).toBe(project.id); expect(usePetStoryStore.getState().project!.production!.state).toBe('paused');
    expect(usePetStoryStore.getState().error).toContain('打开失败'); expect(persisted[0].runtime!.input).toEqual(before.runtime!.input);
    expect(persisted[0].runtime!.acceptanceObservation).toEqual(before.runtime!.acceptanceObservation); expect(controller.signal.aborted).toBe(true);
  });
  it('成功新建只暂停当前项目正式视频，不取消或修改无关联自由任务', async (): Promise<void> => {
    const free: Task = { ...structuredClone(video), id: 'TEST-free-video', assignedAccountId: 'TEST-other-account', petstory: undefined };
    persisted.push(free); useTaskStore.setState({ tasks: structuredClone(persisted) });
    await usePetStoryStore.getState().createProject({ accountId: project.accountId, studioProjectId: project.studioProjectId });
    expect(project.production!.state).toBe('paused'); expect(usePetStoryStore.getState().project!.id).toBe(other.id);
    expect(order.filter((item): boolean => item.startsWith('cancel:'))).toEqual([`cancel:${video.id}:paused`]);
    expect(persisted.find((task): boolean => task.id === free.id)).toEqual(free); expect(open).not.toHaveBeenCalled();
  });
});
