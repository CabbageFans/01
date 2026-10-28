import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task, TaskResult } from '@doubao-studio/contracts';

type IpcHandler = (event: unknown, params: unknown) => unknown;
const state = vi.hoisted(() => ({
  files: {} as Record<string, unknown>,
  writes: [] as string[],
  failWrites: false,
  handlers: new Map<string, IpcHandler>(),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn((): string => '/TEST-user-data') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler): void => { state.handlers.set(channel, handler); }),
    removeHandler: vi.fn((channel: string): void => { state.handlers.delete(channel); }),
  },
  dialog: {},
  session: { fromPartition: vi.fn(), defaultSession: {} },
}));
vi.mock('../../main/utils/store', () => ({
  readJSON: vi.fn((filename: string, fallback: unknown): unknown => structuredClone(state.files[filename] ?? fallback)),
  writeJSON: vi.fn((filename: string, value: unknown): boolean => {
    if (state.failWrites) return false;
    state.files[filename] = structuredClone(value);
    state.writes.push(filename);
    return true;
  }),
}));
vi.mock('../../main/utils/persistenceNormalization', () => ({
  normalizeTasks: (value: unknown): object => ({ data: structuredClone(value), changed: false, warnings: [] }),
  normalizeDownloadJobs: (value: unknown): object => ({ data: structuredClone(value), changed: false, warnings: [] }),
}));

import { registerTaskIPC } from '../../main/ipc/tasks';
import { useTaskStore } from '../../src/store/useTaskStore';

const initialTask: Task = {
  id: 'TEST-assignment-task', projectId: 'default-project', prompt: 'TEST待指派草稿',
  mode: 'chat', status: 'queued', executionIntent: 'hold', assignedAccountId: null,
  result: null, outputs: [], artifacts: [], createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z',
};
let dispose: (() => void) | undefined;

/** 复用已注册的真实 IPC 处理器，不能模拟一个预先修正过的成功返回值。 */
async function assignThroughIpc(taskId: string, accountId: string): Promise<TaskResult> {
  const handler = state.handlers.get('tasks:assign');
  if (!handler) throw new Error('任务指派 IPC 未注册');
  return await handler({}, { taskId, accountId }) as TaskResult;
}

describe('真实任务指派 IPC 到渲染 Store 的契约', () => {
  beforeEach((): void => {
    state.files = {
      'tasks.json': [structuredClone(initialTask)],
      'projects.json': [{ id: 'default-project', name: 'TEST项目', archived: false }],
    };
    state.failWrites = false;
    state.writes = [];
    dispose = registerTaskIPC();
    state.writes = [];
    vi.stubGlobal('window', {
      electronAPI: { tasks: { assign: vi.fn(assignThroughIpc), updateRuntime: vi.fn() } },
      dispatchEvent: vi.fn(),
    });
    useTaskStore.setState({ tasks: [structuredClone(initialTask)], error: null, processQueue: vi.fn(), startAutomation: vi.fn() });
  });
  afterEach((): void => { dispose?.(); vi.unstubAllGlobals(); });

  it('指派成功同时回填界面和持久化账号，保持hold且不授权或发送', async (): Promise<void> => {
    await expect(useTaskStore.getState().assignTask(initialTask.id, 'TEST-account')).resolves.toBe(true);
    const stored = (state.files['tasks.json'] as Task[])[0];
    expect(stored).toMatchObject({ assignedAccountId: 'TEST-account', status: 'queued', executionIntent: 'hold' });
    expect(stored.runtime).toBeUndefined();
    expect(useTaskStore.getState().tasks[0]).toEqual(stored);
    expect(useTaskStore.getState().error).toBeNull();
    expect(useTaskStore.getState().processQueue).not.toHaveBeenCalled();
    expect(useTaskStore.getState().startAutomation).not.toHaveBeenCalled();
    expect(window.electronAPI.tasks.updateRuntime).not.toHaveBeenCalled();
    expect(window.dispatchEvent).not.toHaveBeenCalled();
    expect(state.writes).toEqual(['tasks.json']);
  });

  it('返回共享TaskResult的task字段，不把内部data结构泄漏给界面', async (): Promise<void> => {
    const result = await assignThroughIpc(initialTask.id, 'TEST-account');
    expect(result).toEqual({ success: true, task: (state.files['tasks.json'] as Task[])[0] });
    expect(result).not.toHaveProperty('data');
  });

  it('真实拒绝原因透传，执行中的任务不被重置', async (): Promise<void> => {
    const active: Task = { ...initialTask, status: 'generating', assignedAccountId: 'TEST-original-account' };
    state.files['tasks.json'] = [structuredClone(active)];
    useTaskStore.setState({ tasks: [structuredClone(active)] });
    await expect(useTaskStore.getState().assignTask(initialTask.id, 'TEST-new-account')).resolves.toBe(false);
    expect(useTaskStore.getState().error).toBe('任务正在自动化执行中，无法重新指派');
    expect(useTaskStore.getState().tasks[0]).toEqual(active);
    expect(state.files['tasks.json']).toEqual([active]);
    expect(state.writes).toEqual([]);
  });

  it('保存失败不会伪报指派成功或改变界面中的账号', async (): Promise<void> => {
    state.failWrites = true;
    await expect(useTaskStore.getState().assignTask(initialTask.id, 'TEST-account')).resolves.toBe(false);
    expect(useTaskStore.getState().tasks[0].assignedAccountId).toBeNull();
    expect(useTaskStore.getState().error).toBeTruthy();
    expect(useTaskStore.getState().error).not.toBe('指派失败');
    expect(state.files['tasks.json']).toEqual([initialTask]);
    expect(state.writes).toEqual([]);
    expect(useTaskStore.getState().processQueue).not.toHaveBeenCalled();
  });
});
