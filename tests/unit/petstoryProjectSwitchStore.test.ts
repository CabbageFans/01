/** 项目切换不撤销当前视频运行；IPC 与控制器为明确TEST离线替身。 */
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
const open = vi.fn(); const create = vi.fn(); const pauseProduction = vi.fn(); const detachProduction = vi.fn(); const updateRuntime = vi.fn();

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
  detachProduction.mockImplementation(async (id: string): Promise<PetStoryResult> => {
    order.push(`detach:${id}`);
    project = { ...project, revision: project.revision + 1, production: { ...project.production!, stopAfterCurrent: true } };
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
  Object.assign(target, { electronAPI: { petstory: { open, create, pauseProduction, detachProduction }, tasks: { list: async (): Promise<Task[]> => structuredClone(persisted), updateRuntime },
    logs: { append: vi.fn() }, accounts: { setStatus: vi.fn(async (): Promise<{ success: true }> => ({ success: true })) } } });
  vi.stubGlobal('window', target); vi.spyOn(automationEngine, 'hasController').mockImplementation((id: string): boolean => id === video.id && !controller.signal.aborted);
  usePetStoryStore.setState({ ...original.petstory, project, busy: false, error: '', activeImageOperationId: null });
  useTaskStore.setState({ ...original.tasks, tasks: structuredClone(persisted), executingTasks: { [project.accountId]: video.id }, accountBusy: { [project.accountId]: true } });
  useAccountStore.setState({ ...original.accounts, accounts: [], selectedAccountId: project.accountId });
  useProjectStore.setState({ ...original.projects, projects: [{ id: project.studioProjectId, name: 'TEST-studio', description: '', color: '#fff', archived: false, createdAt: now, updatedAt: now }], selectProject: vi.fn() });
});
afterEach((): void => { usePetStoryStore.setState(original.petstory); useTaskStore.setState(original.tasks); useAccountStore.setState(original.accounts); useProjectStore.setState(original.projects); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('切换项目保留当前视频执行与阶段身份', (): void => {
  it.each(['executing', 'generating', 'manual_submission_observing'] as const)('打开另一项目不停止%s原运行；只安排完成本镜后停止后续', async (status): Promise<void> => {
    persisted[0].status = status; useTaskStore.setState({ tasks: structuredClone(persisted) }); const evidence = structuredClone(persisted[0]);
    await usePetStoryStore.getState().openProject('TEST/other-project');
    expect(order).toEqual([`detach:${project.id}`, 'select']); expect(pauseProduction).not.toHaveBeenCalled(); expect(updateRuntime).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false); expect(project.production).toMatchObject({ state: 'running', stopAfterCurrent: true }); expect(persisted[0]).toEqual(evidence);
    expect(usePetStoryStore.getState().project!.id).toBe(other.id); expect(create).not.toHaveBeenCalled();
  });
  it('后续安排落盘失败时保留原项目和执行权，错误明确且不调用create', async (): Promise<void> => {
    detachProduction.mockResolvedValueOnce({ success: false, error: 'TEST 安排写盘失败' });
    await usePetStoryStore.getState().createProject({ accountId: project.accountId, studioProjectId: project.studioProjectId });
    expect(controller.signal.aborted).toBe(false); expect(create).not.toHaveBeenCalled(); expect(pauseProduction).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().project!.id).toBe(project.id); expect(usePetStoryStore.getState().error).toContain('安排写盘失败');
  });
  it('打开失败保留原项目与运行；原提交、观察和输入均不变', async (): Promise<void> => {
    open.mockResolvedValueOnce({ success: false, error: 'TEST 打开失败' }); const before = structuredClone(video);
    await usePetStoryStore.getState().openProject('TEST/broken-project');
    expect(usePetStoryStore.getState().project!.id).toBe(project.id); expect(usePetStoryStore.getState().project!.production!.state).toBe('running');
    expect(usePetStoryStore.getState().error).toContain('打开失败'); expect(persisted[0]).toEqual(before); expect(controller.signal.aborted).toBe(false);
  });
  it('成功新建仅改变原项目后续安排，不取消或修改任何当前Task', async (): Promise<void> => {
    const free: Task = { ...structuredClone(video), id: 'TEST-free-video', assignedAccountId: 'TEST-other-account', petstory: undefined };
    persisted.push(free); useTaskStore.setState({ tasks: structuredClone(persisted) }); const before = structuredClone(persisted);
    await usePetStoryStore.getState().createProject({ accountId: project.accountId, studioProjectId: project.studioProjectId });
    expect(project.production).toMatchObject({ state: 'running', stopAfterCurrent: true }); expect(usePetStoryStore.getState().project!.id).toBe(other.id);
    expect(order).toEqual([`detach:${project.id}`, 'select']); expect(persisted).toEqual(before); expect(open).not.toHaveBeenCalled();
  });
});
