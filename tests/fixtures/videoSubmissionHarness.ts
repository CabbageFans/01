import type { Task } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import type { SubmissionDispatchSafety } from '../../src/utils/doubaoBridge';

export interface SubmissionHarness {
  service: TaskService;
  current: () => Task;
  persist: (state: 'dispatch_unknown' | 'not_dispatched' | 'accepted', reason?: string) => Promise<void>;
  safety: SubmissionDispatchSafety;
  controller: AbortController;
  failWrite: () => void;
}
export function videoSubmissionHarness(mode: 'chat' | 'image' | 'video' = 'video'): SubmissionHarness {
  const now = '2026-11-10T00:00:00.000Z';
  let stored: Task[] = [{ id: 'fixture-task', projectId: 'fixture-project', assignedAccountId: 'fixture-account', mode, prompt: 'fixture prompt', outputs: [], result: null,
    createdAt: now, updatedAt: now, status: 'executing', runtime: { runId: 'fixture-run', attempt: 1, stage: 'submitting', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      submission: { schemaVersion: 1, operationId: 'fixture-operation', runId: 'fixture-run', state: 'intent_saved', updatedAt: now },
      input: { prompt: 'fixture prompt', mode, attachments: [] } } }];
  let fail = false;
  const service = new TaskService({ defaultProjectId: (): string => 'fixture-project', now: (): string => now,
    store: { read: (): Task[] => structuredClone(stored), replace: (tasks: Task[]): boolean => { if (fail) { fail = false; return false; } stored = structuredClone(tasks); return true; } } });
  const controller = new AbortController();
  return { service, controller, current: (): Task => structuredClone(stored[0]), failWrite: (): void => { fail = true; },
    safety: { dispatchKey: 'fixture-operation', deadlineAt: Date.now() + 10_000, expectedPrompt: 'fixture prompt', signal: controller.signal,
      isCurrent: (): boolean => !controller.signal.aborted && stored[0].runtime?.runId === 'fixture-run', verifyLease: async (): Promise<boolean> => true },
    persist: async (state, reason): Promise<void> => {
      const result = service.updateRuntime({ taskId: 'fixture-task', expectedRunId: 'fixture-run', runtime: {
        ...(state === 'dispatch_unknown' ? { submittedAt: now } : {}),
        submission: { schemaVersion: 1, operationId: 'fixture-operation', runId: 'fixture-run', state, updatedAt: now, reason },
      } });
      if (!result.success) throw new Error(result.error);
    },
  };
}
