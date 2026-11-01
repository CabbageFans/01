/** 只运行离线内存 TaskService 与 store；不挂载 Webview，不调用模型。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryPlan, Task, TaskUpdateRuntimeParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';
import { finalTaskInput } from '../../main/utils/petstoryChat';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { automationEngine } from '../../src/automation/AutomationEngine';
import { createAcceptedObservationBinding } from '../../src/utils/acceptedObservation';

let stored: Task[];
let core: TaskService;
const originalTasks = useTaskStore.getState();
const originalAccounts = useAccountStore.getState();
const append = vi.fn();
const now = new Date().toISOString();
function account(): Account {
  return { id: 'TEST-account', name: '离线测试账号', platform: 'doubao', avatar: '', partition: 'TEST-only', status: 'idle', pinned: false,
    seedanceQuota: { date: now.slice(0, 10), usedUnits: 0, estimatedTotalUnits: 6, exhausted: false, updatedAt: now },
    health: { loginState: 'ok', verificationRequired: false, consecutiveFailures: 0, successCount: 0, failureCount: 0,
      availability: { state: 'ready', reason: 'ready', message: '离线测试状态', checkedAt: now, source: 'manual' } },
    scheduling: { enabled: true, weight: 1, preferredModes: [] }, createdAt: now, updatedAt: now };
}
function plan(): PetStoryPlan {
  const prompt = { original: 'TEST original', optimized: 'TEST optimized', final: 'TEST user final %%%%%%%%%% kept', edited: true, rulesVersion: 'petstory-r11-v1' };
  return { sourceSummary: '离线测试梗概', adaptedStory: '离线测试故事', characters: [
    { id: 'lulu', name: '噜噜', role: 'main', purpose: '测试主角', description: '测试蓝衣' },
    { id: 'lumei', name: '噜妹', role: 'main', purpose: '测试主角', description: '测试红衣' },
  ], shots: [{ id: 'TEST-shot', order: 1, characterIds: ['lulu'], scene: '测试场景', action: '测试动作', startState: '测试起点', endState: '测试终点', durationSeconds: 10,
    transition: 'cut', requestedMode: 'auto', prompts: { firstFrame: prompt, video: prompt } }] };
}
beforeEach((): void => {
  stored = [];
  core = new TaskService({ store: { read: (): Task[] => structuredClone(stored), replace: (value: Task[]): boolean => { stored = normalizeTasks(value, 'TEST-project').data; return true; } },
    defaultProjectId: (): string => 'TEST-project', id: (): string => 'TEST-task' });
  vi.stubGlobal('window', { electronAPI: { tasks: {
    list: async (): Promise<Task[]> => structuredClone(stored),
    updateStatus: async (id: string, status: Task['status'], result?: string, outputs?: string[]): Promise<unknown> => core.updateStatus({ taskId: id, status, result, outputs }),
    updateRuntime: async (id: string, patch: Omit<TaskUpdateRuntimeParams, 'taskId'>): Promise<unknown> => {
      const result = core.updateRuntime({ taskId: id, ...patch });
      return result.success ? { success: true, task: result.data } : result;
    },
    acquireLock: async (): Promise<unknown> => ({ success: true }),
    releaseLock: async (): Promise<unknown> => ({ success: true }),
    renewLock: async (): Promise<unknown> => ({ success: true }),
  }, accounts: { setStatus: vi.fn(async (): Promise<void> => {}) }, logs: { append } } });
  useAccountStore.setState({ accounts: [account()], selectedAccountId: 'TEST-account' });
  useTaskStore.setState({ ...originalTasks, tasks: [], schedulerPaused: false, executingTasks: {}, accountBusy: {}, accountAutomationState: {}, accountAutoMessage: {}, processQueue: vi.fn() });
});
afterEach(async (): Promise<void> => {
  await automationEngine.release('TEST-task');
  useTaskStore.setState(originalTasks);
  useAccountStore.setState(originalAccounts);
  vi.unstubAllGlobals();
});

describe('PetStory final prompt and body persistence through actual execution boundary', (): void => {
  async function submittedVideo(): Promise<Task> {
    core.create({ prompts: ['TEST exact video completion'], mode: 'video', projectId: 'TEST-project' });
    core.assign({ taskId: 'TEST-task', accountId: 'TEST-account' });
    useTaskStore.setState({ tasks: structuredClone(stored) });
    expect(await useTaskStore.getState().startAutomation('TEST-task')).toBe(true);
    await useTaskStore.getState().updateTaskRuntime('TEST-task', { runtime: { submittedAt: now } });
    return structuredClone(stored[0]);
  }

  it('media completion uses the authoritative completed task and the original-run artifact', async (): Promise<void> => {
    const original = await submittedVideo(); vi.useFakeTimers();
    try {
      await useTaskStore.getState().completeAutomation(original.id, 'TEST-account', 'https://TEST.invalid/result.mp4', ['https://TEST.invalid/result.mp4']);
      expect(useTaskStore.getState().tasks[0]).toEqual(stored[0]);
      expect(stored[0]).toMatchObject({ status: 'done', outputs: ['https://TEST.invalid/result.mp4'], artifacts: [{ runId: original.runtime?.runId, kind: 'video' }] });
    } finally { vi.useRealTimers(); }
  });

  it('music completion preserves the TaskService file artifact kind', async (): Promise<void> => {
    core.create({ prompts: ['TEST music completion'], mode: 'music', projectId: 'TEST-project' });
    core.assign({ taskId: 'TEST-task', accountId: 'TEST-account' });
    useTaskStore.setState({ tasks: structuredClone(stored) });
    expect(await useTaskStore.getState().startAutomation('TEST-task')).toBe(true);
    await useTaskStore.getState().updateTaskRuntime('TEST-task', { runtime: { submittedAt: now } });
    vi.useFakeTimers();
    try {
      await useTaskStore.getState().completeAutomation('TEST-task', 'TEST-account', 'https://TEST.invalid/result.mp3', ['https://TEST.invalid/result.mp3']);
      expect(useTaskStore.getState().tasks[0]).toEqual(stored[0]);
      expect(stored[0]).toMatchObject({ status: 'done', artifacts: [{ kind: 'file' }] });
    } finally { vi.useRealTimers(); }
  });

  it('success flags without persisted done/output evidence never fabricate completion', async (): Promise<void> => {
    await submittedVideo();
    vi.spyOn(window.electronAPI.tasks, 'updateStatus').mockResolvedValueOnce({ success: true });
    vi.spyOn(window.electronAPI.tasks, 'updateRuntime').mockResolvedValueOnce({ success: true });
    await expect(useTaskStore.getState().completeAutomation('TEST-task', 'TEST-account', 'https://TEST.invalid/result.mp4', ['https://TEST.invalid/result.mp4'])).rejects.toThrow('权威回读不一致');
    expect(useTaskStore.getState().tasks[0].status).toBe('executing'); expect(useTaskStore.getState().tasks[0].outputs).toEqual([]);
  });

  it('a runtime-write failure preserves an already persisted done result instead of downgrading it', async (): Promise<void> => {
    await submittedVideo();
    vi.spyOn(window.electronAPI.tasks, 'updateRuntime').mockRejectedValueOnce(new Error('TEST runtime receipt failed'));
    await expect(useTaskStore.getState().completeAutomation('TEST-task', 'TEST-account', 'https://TEST.invalid/result.mp4', ['https://TEST.invalid/result.mp4'])).rejects.toThrow('receipt failed');
    expect(useTaskStore.getState().tasks[0]).toEqual(stored[0]); expect(stored[0].status).toBe('done'); expect(stored[0].outputs).toHaveLength(1);
  });

  it('a later run in the authoritative completion reply is synchronized and rejected', async (): Promise<void> => {
    const original = await submittedVideo();
    vi.spyOn(window.electronAPI.tasks, 'updateRuntime').mockImplementationOnce(async (): Promise<{ success: boolean; task: Task }> => {
      const changed = structuredClone(stored[0]);
      if (changed.runtime) changed.runtime.runId = 'TEST-later-run';
      stored = [changed]; return { success: true, task: changed };
    });
    await expect(useTaskStore.getState().completeAutomation(original.id, 'TEST-account', 'https://TEST.invalid/result.mp4', ['https://TEST.invalid/result.mp4'])).rejects.toThrow('权威回读不一致');
    expect(useTaskStore.getState().tasks[0].runtime?.runId).toBe('TEST-later-run');
    expect(useTaskStore.getState().tasks[0].artifacts?.[0].runId).toBe(original.runtime?.runId);
  });

  it('uncertain completion readback fences later pause writes until the persisted done can be read', async (): Promise<void> => {
    await submittedVideo();
    vi.spyOn(window.electronAPI.tasks, 'updateRuntime').mockRejectedValueOnce(new Error('TEST runtime receipt failed'));
    const listing = vi.spyOn(window.electronAPI.tasks, 'list').mockRejectedValue(new Error('TEST readback unavailable'));
    await expect(useTaskStore.getState().completeAutomation('TEST-task', 'TEST-account', 'https://TEST.invalid/result.mp4', ['https://TEST.invalid/result.mp4'])).rejects.toThrow('receipt failed');
    const write = vi.spyOn(window.electronAPI.tasks, 'updateRuntime');
    expect(await useTaskStore.getState().updateTaskRuntime('TEST-task', { status: 'paused' })).toBe(false);
    expect(write).not.toHaveBeenCalled(); expect(stored[0].status).toBe('done');
    listing.mockResolvedValue(structuredClone(stored));
    expect(await useTaskStore.getState().updateTaskRuntime('TEST-task', { status: 'paused' })).toBe(false);
    expect(useTaskStore.getState().tasks[0].status).toBe('done'); expect(stored[0].status).toBe('done');
  });

  it('completes a saved Chat reply with no media, persists the completed observation and never fabricates an artifact', async (): Promise<void> => {
    core.create({ prompts: ['TEST Chat completion'], mode: 'chat', projectId: 'TEST-project' });
    core.assign({ taskId: 'TEST-task', accountId: 'TEST-account' });
    useTaskStore.setState({ tasks: structuredClone(stored) });
    expect(await useTaskStore.getState().startAutomation('TEST-task')).toBe(true);
    const runId = stored[0].runtime?.runId || '';
    const observation = createAcceptedObservationBinding({ accountId: 'TEST-account', runId, conversationUrl: 'https://www.doubao.com/chat/TEST-completion',
      acceptedAt: now, ownerId: 'TEST-observer', mode: 'chat', evidence: { generationStarted: true, promptPublished: true, inputCleared: true, messageCount: 2 } });
    await useTaskStore.getState().updateTaskRuntime('TEST-task', { runtime: { acceptanceObservation: observation, chatResponse: { text: 'TEST 完整正文\n保留换行', capturedAt: now } } });
    vi.useFakeTimers();
    try {
      await useTaskStore.getState().completeAutomation('TEST-task', 'TEST-account', '', []);
      expect(stored[0]).toMatchObject({ status: 'done', outputs: [], runtime: { stage: 'completed', chatResponse: { text: 'TEST 完整正文\n保留换行' }, acceptanceObservation: { outcome: 'completed' } } });
      expect(stored[0].runtime?.acceptanceObservation?.expectedArtifact.artifactId).toBeUndefined();
      expect(stored[0].artifacts || []).toEqual([]);
      expect(useTaskStore.getState().tasks[0].runtime?.acceptanceObservation?.outcome).toBe('completed');
      await vi.runOnlyPendingTimersAsync();
    } finally { vi.useRealTimers(); }
  });
  it('copies edited final text into the persisted runtime input only on explicit existing-store start', async (): Promise<void> => {
    const input = finalTaskInput(plan(), 'TEST-shot', 'firstFrame', ['TEST-only-reference.png'], 'TEST-project');
    input.petstory = { projectId: 'TEST-petstory-project', stepId: 'TEST-production-step' };
    expect(core.create(input).success).toBe(true);
    expect(core.assign({ taskId: 'TEST-task', accountId: 'TEST-account' }).success).toBe(true);
    useTaskStore.setState({ tasks: structuredClone(stored) });
    expect(stored[0].executionIntent).toBe('hold');
    expect(stored[0].runtime).toBeUndefined();
    expect(await useTaskStore.getState().startAutomation('TEST-task')).toBe(true);
    expect(stored[0].runtime?.input).toMatchObject({ prompt: 'TEST user final %%%%%%%%%% kept', mode: 'image', promptReadback: 'exact', attachments: ['TEST-only-reference.png'] });
    expect(stored[0].runtime?.input.petstory).toEqual(input.petstory);
    expect(stored).toHaveLength(1);
  });
  it('holds the same task when the project/run binding fails before dispatch', async (): Promise<void> => {
    core.create({ prompts: ['TEST chat binding'], mode: 'chat', projectId: 'TEST-project' });
    core.assign({ taskId: 'TEST-task', accountId: 'TEST-account' });
    useTaskStore.setState({ tasks: structuredClone(stored) });
    const gate = vi.fn(async (task: Task): Promise<void> => {
      expect(task.runtime?.runId).toBeTruthy();
      expect(useTaskStore.getState().executingTasks).toEqual({});
      throw new Error('TEST project binding write failed');
    });
    expect(await useTaskStore.getState().startAutomation('TEST-task', gate)).toBe(false);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(stored[0]).toMatchObject({ executionIntent: 'hold', status: 'paused' });
    expect(stored[0].runtime?.submittedAt).toBeUndefined();
    expect(useTaskStore.getState().executingTasks).toEqual({});
    expect(stored).toHaveLength(1);
  });

  it('persists formatted Chat text through repository normalization and detects a missing readback', async (): Promise<void> => {
    const created = core.create({ prompts: ['TEST chat'], mode: 'chat', projectId: 'TEST-project' });
    expect(created.success).toBe(true);
    core.assign({ taskId: 'TEST-task', accountId: 'TEST-account' });
    useTaskStore.setState({ tasks: structuredClone(stored) });
    expect(await useTaskStore.getState().startAutomation('TEST-task')).toBe(true);
    const raw = '离线测试正文\n\n```json\n{ "value": "不规范化的空白" }\n```';
    expect(await useTaskStore.getState().updateTaskRuntime('TEST-task', { runtime: { chatResponse: { text: raw, capturedAt: now } } })).toBe(true);
    expect(stored[0].runtime?.chatResponse?.text).toBe(raw);
    expect(stored[0].outputs).toEqual([]);
    const diagnostics = core.buildTaskDiagnostics();
    expect(diagnostics.success).toBe(true);
    if (diagnostics.success) {
      expect(diagnostics.data[0].runtime?.chatResponse).toBeUndefined();
      expect(diagnostics.data[0].runtime?.input.prompt).not.toBe('TEST chat');
      expect(JSON.stringify(diagnostics.data)).not.toContain('不规范化的空白');
    }
    const prior = stored[0];
    const broken = new TaskService({ store: {
      read: (): Task[] => structuredClone(stored), replace: (value: Task[]): boolean => { stored = structuredClone(value); if (stored[0].runtime) stored[0].runtime.chatResponse = undefined; return true; },
    }, defaultProjectId: (): string => 'TEST-project' });
    const failed = broken.updateRuntime({ taskId: prior.id, runtime: { chatResponse: { text: raw, capturedAt: now } } });
    expect(failed.success).toBe(false);
    expect(stored).toHaveLength(1);
  });
});
