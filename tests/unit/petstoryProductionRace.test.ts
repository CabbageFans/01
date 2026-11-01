/** 离线接力竞态：IPC 和正式调度均为替身，不访问或发送豆包页面。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryProductionResult, PetStoryProject, Task } from '@doubao-studio/contracts';
import { tickPetStoryProduction, usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';

const initial = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-11-01T00:00:00.000Z';
let project: PetStoryProject;
let task: Task;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no): void => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function snapshot(state: 'running' | 'paused' | 'complete', revision: number): PetStoryProject {
  return { ...project, revision, production: { ...project.production!, state } };
}
beforeEach((): void => {
  const entry = { state: 'unknown' as const, reason: 'TEST 离线入口' };
  project = { schemaVersion: 1, id: 'TEST-race-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, updatedAt: now,
    source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [],
    production: { state: 'paused', phase: 'shots', planHash: 'TEST', approvedAt: now, fallbacks: {}, shots: {}, message: 'TEST',
      capability: { accountId: 'TEST-account', image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [] },
      steps: [{ id: 'TEST-step', shotId: 'TEST-shot', kind: 'video', taskId: 'TEST-task', status: 'bound', inputHash: 'TEST', attachmentAssetIds: [] }] } };
  task = { id: 'TEST-task', projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'video', status: 'queued', prompt: 'TEST', outputs: [], result: null, createdAt: now, updatedAt: now,
    runtime: { runId: 'TEST-run', attempt: 1, stage: 'preparing_account', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { mode: 'video', prompt: 'TEST', attachments: [] } } };
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), electronAPI: { petstory: {
    resumeProduction: vi.fn(async (): Promise<PetStoryProductionResult> => ({ success: true, project: snapshot('running', 2) })),
    pauseProduction: vi.fn(async (): Promise<PetStoryProductionResult> => ({ success: true, project: snapshot('paused', 4) })),
    advanceProduction: vi.fn(async (): Promise<PetStoryProductionResult> => ({ success: true, project: snapshot('complete', 5) })),
  }, tasks: { list: vi.fn(async (): Promise<Task[]> => [task]) } } });
  usePetStoryStore.setState({ ...initial.pet, project, busy: false, error: '' });
  useTaskStore.setState({ ...initial.tasks, tasks: [task], activeTaskId: null, executingTasks: {}, startAutomation: vi.fn(async (): Promise<boolean> => true) });
});
afterEach(async (): Promise<void> => {
  window.electronAPI.petstory.advanceProduction = vi.fn(async (): Promise<PetStoryProductionResult> => ({ success: true, project: snapshot('complete', 10) }));
  await tickPetStoryProduction();
  usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.tasks); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('视频制作接力保持暂停和项目归属', (): void => {
  it('暂停后迟到的推进快照不能把制作重新显示为运行或启动页面', async (): Promise<void> => {
    const advance = deferred<PetStoryProductionResult>();
    const read = vi.fn((): Promise<PetStoryProductionResult> => advance.promise); window.electronAPI.petstory.advanceProduction = read;
    const continuing = initial.pet.resumeProduction();
    await vi.waitFor((): void => expect(read).toHaveBeenCalledOnce());
    await initial.pet.pauseProduction();
    advance.resolve({ success: true, project: snapshot('running', 3), taskId: task.id, action: 'start' });
    await continuing;
    expect(usePetStoryStore.getState().project).toMatchObject({ revision: 4, production: { state: 'paused' } });
    expect(useTaskStore.getState().startAutomation).not.toHaveBeenCalled();
  });

  it('运行绑定期间暂停，回读后也必须停止页面分派并保留暂停版本', async (): Promise<void> => {
    const binding = deferred<PetStoryProductionResult>(); const dispatch = vi.fn();
    window.electronAPI.petstory.advanceProduction = vi.fn(async (): Promise<PetStoryProductionResult> => ({ success: true, project: snapshot('running', 3), taskId: task.id, action: 'start' }));
    const bind = vi.fn((): Promise<PetStoryProductionResult> => binding.promise); window.electronAPI.petstory.bindProductionRun = bind;
    useTaskStore.setState({ startAutomation: vi.fn(async (_taskId: string, beforeDispatch?: (current: Task) => Promise<void>): Promise<boolean> => {
      try { await beforeDispatch?.(task); dispatch(); return true; } catch { return false; }
    }) });
    const continuing = initial.pet.resumeProduction();
    await vi.waitFor((): void => expect(bind).toHaveBeenCalledOnce());
    await initial.pet.pauseProduction();
    binding.resolve({ success: true, project: snapshot('running', 3) });
    await continuing;
    expect(dispatch).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().project).toMatchObject({ revision: 4, production: { state: 'paused' } });
    expect(window.electronAPI.petstory.pauseProduction).toHaveBeenCalledTimes(1);
  });

  it('启动失败的暂停回读迟到时，不覆盖新打开项目或给它添加旧错误', async (): Promise<void> => {
    const pause = deferred<PetStoryProductionResult>(); const paused = vi.fn((): Promise<PetStoryProductionResult> => pause.promise);
    window.electronAPI.petstory.pauseProduction = paused;
    window.electronAPI.petstory.advanceProduction = vi.fn(async (): Promise<PetStoryProductionResult> => ({ success: true, project: snapshot('running', 3), taskId: task.id, action: 'start' }));
    useTaskStore.setState({ startAutomation: vi.fn(async (): Promise<boolean> => false), error: 'TEST 原项目启动失败' });
    const continuing = initial.pet.resumeProduction();
    await vi.waitFor((): void => expect(paused).toHaveBeenCalledOnce());
    const other = { ...project, id: 'TEST-other-project', revision: 1 }; usePetStoryStore.setState({ project: other, error: '' });
    pause.resolve({ success: true, project: snapshot('paused', 4) });
    await continuing;
    expect(usePetStoryStore.getState().project).toBe(other); expect(usePetStoryStore.getState().error).toBe('');
  });

  it('旧项目推进失败不污染用户已切换的项目', async (): Promise<void> => {
    const advance = deferred<PetStoryProductionResult>(); const read = vi.fn((): Promise<PetStoryProductionResult> => advance.promise);
    window.electronAPI.petstory.advanceProduction = read;
    const continuing = initial.pet.resumeProduction();
    await vi.waitFor((): void => expect(read).toHaveBeenCalledOnce());
    const other = { ...project, id: 'TEST-other-project' }; usePetStoryStore.setState({ project: other, error: '' });
    advance.reject(new Error('TEST 原项目推进失败')); await continuing;
    expect(usePetStoryStore.getState().project).toBe(other); expect(usePetStoryStore.getState().error).toBe('');
  });
});
