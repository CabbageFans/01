import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../src/types';
import { useTaskStore } from '../../src/store/useTaskStore';

const originalQueue = useTaskStore.getState().processQueue;
const now = '2026-10-23T00:00:00.000Z';
let stored: Task[];
const retry = vi.fn();
const patch = vi.fn();

function pausedTask(submitted = false): Task {
  return {
    id: 'resume-smoke', projectId: 'default-project', prompt: 'test', mode: 'chat',
    assignedAccountId: null, status: 'paused', executionIntent: 'hold',
    result: null, outputs: [], createdAt: now, updatedAt: now,
    runtime: submitted ? { runId: 'prior-run', attempt: 1, stage: 'paused', message: '', startedAt: now,
      stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
      input: { prompt: 'test', mode: 'chat', attachments: [] } } : undefined,
  };
}

describe('resume does not grant a new submission intent', (): void => {
  beforeEach((): void => {
    stored = [pausedTask()];
    retry.mockReset().mockImplementation(async (id: string): Promise<unknown> => {
      stored = stored.map((task: Task): Task => task.id === id
        ? { ...task, status: 'queued', executionIntent: 'armed', runtime: undefined }
        : task);
      return { success: true, task: stored[0] };
    });
    patch.mockReset().mockImplementation(async (id: string, update: Partial<Task>): Promise<unknown> => {
      stored = stored.map((task: Task): Task => task.id === id ? { ...task, ...update } : task);
      return { success: true, task: stored[0] };
    });
    vi.stubGlobal('window', { electronAPI: { tasks: {
      list: async (): Promise<Task[]> => structuredClone(stored),
      retry, updateRuntime: patch, releaseLock: vi.fn(async (): Promise<unknown> => ({ success: true })),
    } } });
    useTaskStore.setState({ tasks: structuredClone(stored), schedulerPaused: true, processQueue: vi.fn() });
  });

  afterEach((): void => {
    useTaskStore.setState({ tasks: [], processQueue: originalQueue });
    vi.unstubAllGlobals();
  });

  it('keeps a never-started hold task held when continuing the queue', async (): Promise<void> => {
    expect(await useTaskStore.getState().resumeAll()).toBe(true);
    expect(retry).not.toHaveBeenCalled();
    expect(stored[0]).toMatchObject({ status: 'queued', executionIntent: 'hold' });
  });

  it('keeps an uncertain submitted task paused without calling retry', async (): Promise<void> => {
    stored = [pausedTask(true)];
    useTaskStore.setState({ tasks: structuredClone(stored) });
    expect(await useTaskStore.getState().resumeAll()).toBe(false);
    expect(retry).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(stored[0].runtime?.submittedAt).toBe(now);
    expect(stored[0].status).toBe('paused');
  });

  it('coalesces simultaneous continue clicks and preserves hold on a second read', async (): Promise<void> => {
    const first = useTaskStore.getState().resumeAll();
    const second = useTaskStore.getState().resumeAll();
    expect(first).toBe(second);
    expect(await first).toBe(true);
    expect(await useTaskStore.getState().resumeAll()).toBe(true);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(stored[0].executionIntent).toBe('hold');
  });

  it('resumes an accepted task as observation with the same run and submission marker', async (): Promise<void> => {
    const task = pausedTask(true);
    const runtime = task.runtime!;
    runtime.conversationUrl = 'https://www.doubao.com/chat/1';
    runtime.acceptanceObservation = {
      schemaVersion: 1, accountId: 'account-1', runId: runtime.runId!,
      conversationUrl: runtime.conversationUrl, acceptedAt: now,
      evidence: { kind: 'prompt_published' }, cursor: { messageCount: 1, pollCount: 0 },
      expectedArtifact: { kind: 'file', runId: runtime.runId! },
      lease: { ownerId: 'observer', acquiredAt: now, expiresAt: now, lastHeartbeatAt: now },
      outcome: 'observing',
    };
    stored = [task];
    useTaskStore.setState({ tasks: structuredClone(stored) });
    expect(await useTaskStore.getState().resumeAll()).toBe(true);
    expect(retry).not.toHaveBeenCalled();
    expect(stored[0].status).toBe('manual_submission_observing');
    expect(stored[0].runtime?.runId).toBe('prior-run');
    expect(stored[0].runtime?.submittedAt).toBe(now);
    expect(stored[0].runtime?.acceptanceObservation?.cursor.messageCount).toBe(1);
  });
});
