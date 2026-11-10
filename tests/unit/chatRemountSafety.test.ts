/** 正式稳定执行协调器的重入测试；不挂载网页，不调用平台。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@doubao-studio/contracts';
import { getTaskExecutionScope } from '../../src/utils/taskExecutionScope';
import original from '../fixtures/storyboard-five-shots.json';
import { MaterialImagePages } from '../../src/utils/materialImagePages';
import { executeTaskAutomation, type TaskExecutionHost } from '../../src/automation/TaskExecutionCoordinator';
import { automationEngine } from '../../src/automation/AutomationEngine';
import { useTaskStore } from '../../src/store/useTaskStore';

function host(current: Task): TaskExecutionHost {
  return { runningRef: { current: new Set([getTaskExecutionScope(current)]) }, materialPagesRef: { current: new MaterialImagePages() },
    abortControllersRef: { current: new Map() }, pendingRestartTasksRef: { current: new Map() }, pendingCancellationStatusRef: { current: new Map() }, submittedImagePagesRef: { current: new Map() },
    ownsTaskWebview: (): boolean => true, setInteractiveTaskPageId: vi.fn(), assertNoHumanVerification: vi.fn(), pauseForHumanVerification: vi.fn(), performAvailabilityCheck: vi.fn(), conversationSynchronizations: new WeakMap() };
}
function task(): Task {
  return { id: 'OFFLINE-task', mode: 'chat', prompt: original.mobileStory, assignedAccountId: 'OFFLINE-account', status: 'executing', result: null, outputs: [], createdAt: '2026-10-26', updatedAt: '2026-10-26',
    runtime: { runId: 'OFFLINE-original-run', attempt: 1, startedAt: '2026-10-26', stageStartedAt: '2026-10-26', lastHeartbeatAt: '2026-10-26', stage: 'submitting', message: 'OFFLINE-original', submittedAt: '2026-10-26', input: { prompt: original.mobileStory, mode: 'chat', attachments: [] } } };
}
afterEach((): void => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('F03 组件重挂载／热更新防重复执行（离线）', (): void => {
  it('已有提交记录时仅暂停并派发原任务只读核对，零网页调用且不创建控制器', async (): Promise<void> => {
    const current = task(); const context = host(current);
    const pauseAutomation = vi.fn(async (): Promise<void> => { current.status = 'paused'; });
    const initial = useTaskStore.getState(); vi.spyOn(useTaskStore, 'getState').mockReturnValue({ ...initial, tasks: [current], pauseAutomation });
    const release = vi.spyOn(automationEngine, 'release').mockResolvedValue(); const createController = vi.spyOn(automationEngine, 'createController');
    vi.spyOn(automationEngine, 'hasController').mockReturnValue(false);
    const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('CustomEvent', class { constructor(public readonly type: string, public readonly options: object) {} });
    const webview = { executeJavaScript: vi.fn(), loadURL: vi.fn(), sendInputEvent: vi.fn() };
    const submittedAt = current.runtime!.submittedAt;
    await executeTaskAutomation(context, current.assignedAccountId!, current.id, current.prompt, current.mode!, webview as unknown as HTMLWebViewElement);
    expect(pauseAutomation).toHaveBeenCalledWith(current.id, current.assignedAccountId, expect.any(String), { status: 'paused', code: 'submission_uncertain', expectedRunId: current.runtime!.runId });
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'reconcile-task-submission', options: { detail: { taskId: current.id } } }));
    expect(current.runtime!.submittedAt).toBe(submittedAt); expect(createController).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
    expect(webview.executeJavaScript).not.toHaveBeenCalled(); expect(webview.loadURL).not.toHaveBeenCalled(); expect(webview.sendInputEvent).not.toHaveBeenCalled();
    expect(context.runningRef.current.size).toBe(0);
  });

  it('原控制器仍持有运行时重挂载不暂停、不释放、不接管账号', async (): Promise<void> => {
    const current = task(); const pauseAutomation = vi.fn(); const dispatchEvent = vi.fn();
    const initial = useTaskStore.getState(); vi.spyOn(useTaskStore, 'getState').mockReturnValue({ ...initial, tasks: [current], pauseAutomation });
    vi.spyOn(automationEngine, 'hasController').mockReturnValue(true); const release = vi.spyOn(automationEngine, 'release'); const create = vi.spyOn(automationEngine, 'createController');
    vi.stubGlobal('window', { dispatchEvent });
    await executeTaskAutomation(host(current), current.assignedAccountId!, current.id, current.prompt, current.mode!, {} as HTMLWebViewElement);
    expect(pauseAutomation).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
