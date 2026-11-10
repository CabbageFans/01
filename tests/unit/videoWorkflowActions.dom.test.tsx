import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryAsset, PetStoryPlan, PetStoryProject, Task, TaskLocalMediaUpdate } from '@doubao-studio/contracts';
import { CanvasVideoSettings, CanvasMediaNode } from '../../src/components/PetStoryCanvasMedia';
import { PetStoryImageReview } from '../../src/components/PetStoryImageReview';
import { PetStoryCurrentTasks } from '../../src/components/PetStoryTaskRecovery';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { TaskService } from '../../main/core/TaskService';

const initial = { pet: usePetStoryStore.getState(), task: useTaskStore.getState(), account: useAccountStore.getState() };
const now = '2026-11-10T01:00:00.000Z';
let project: PetStoryProject; let task: Task;
const resume = vi.fn(); const generate = vi.fn(); const readMedia = vi.fn();
function asset(): PetStoryAsset { return { id: 'TEST-old-video', kind: 'video', shotId: project.plan!.shots[0].id, relativePath: 'shots/TEST-old-video.mp4', taskId: 'TEST-original-task', runId: 'TEST-original-run', artifactId: 'TEST-artifact', downloadJobId: 'TEST-download',
  validation: { decoded: true, sha256: 'a'.repeat(64), bytes: 200, width: 64, height: 96, durationSeconds: 5, checkedAt: now } }; }
function localFailure(phase: TaskLocalMediaUpdate['phase']): void {
  task.runtime!.localMedia = { operationId: 'media:TEST-original-run:TEST-artifact', artifactId: 'TEST-artifact', phase, state: 'failed', updatedAt: now,
    error: { code: phase === 'validating' ? 'tool_missing' : 'TEST_LOCAL_FAILURE', message: 'TEST 原产物本地处理失败' } };
  // 对应旧数据中的失效投影不能改变当前Task权威恢复动作。
  project.production!.steps[0].failure = { stage: phase === 'downloading' ? 'validation' : 'download', code: 'TEST_OLD_PROJECTION', message: 'TEST过期投影' };
  useTaskStore.setState({ tasks: [structuredClone(task)] });
}
const Node: React.FC = (): React.ReactElement => {
  const p = usePetStoryStore((state) => state.project)!;
  return <CanvasMediaNode project={p} shot={p.plan!.shots[0]} kind="video" disabled={false} />;
};
const Recovery: React.FC = (): React.ReactElement => {
  const p = usePetStoryStore((state) => state.project)!; return <PetStoryCurrentTasks project={p} />;
};
beforeEach((): void => {
  vi.clearAllMocks();
  const plan = structuredClone(snapshot.plan) as PetStoryPlan; plan.shots = plan.shots.slice(0, 1); plan.shots[0].requestedMode = 'first_frame';
  const entry = { state: 'supported' as const, reason: 'TEST仅UI契约' };
  project = { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 10, updatedAt: now, source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [], plan,
    production: { state: 'paused', phase: 'shots', planHash: 'a'.repeat(64), approvedAt: now, message: 'TEST本地保存尚未完成', fallbacks: {}, shots: { [plan.shots[0].id]: { requestedMode: 'first_frame', resolvedMode: 'first_frame', reason: 'TEST' } },
      capability: { accountId: 'TEST-account', image: entry, durations: [5], modes: { first_frame: entry, first_last_frame: entry, reference: entry } },
      steps: [{ id: 'TEST-step', shotId: plan.shots[0].id, kind: 'video', status: 'bound', taskId: 'TEST-original-task', runId: 'TEST-original-run', inputHash: 'b'.repeat(64), attachmentAssetIds: [] }] } };
  task = { id: 'TEST-original-task', revision: 5, mode: 'video', status: 'done', prompt: 'TEST原输入', assignedAccountId: project.accountId, projectId: project.studioProjectId, createdAt: now, updatedAt: now, result: null, outputs: ['https://TEST.invalid/original.mp4'],
    petstory: { projectId: project.id, stepId: 'TEST-step' }, artifacts: [{ id: 'TEST-artifact', url: 'https://TEST.invalid/original.mp4', kind: 'video', source: 'network', runId: 'TEST-original-run', discoveredAt: now }],
    runtime: { runId: 'TEST-original-run', attempt: 1, stage: 'completed', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, message: 'TEST平台生成完成', input: { mode: 'video', prompt: 'TEST原输入', attachments: [] } } };
  readMedia.mockResolvedValue({ success: false, error: 'TEST 本地文件暂不可读' }); resume.mockResolvedValue(undefined); generate.mockResolvedValue(undefined);
  window.electronAPI = { petstory: { inspectGeneration: vi.fn(async (): Promise<object> => ({ success: true, eligibility: { ready: true, blockers: [] } })), readMedia } } as unknown as typeof window.electronAPI;
  usePetStoryStore.setState({ ...initial.pet, project, busy: false, error: '', generateShotMedia: generate, resumeProduction: resume });
  useTaskStore.setState({ ...initial.task, tasks: [task], accountAutomationState: {}, executingTasks: {}, activeTaskId: null });
  useAccountStore.setState({ ...initial.account, accounts: [] });
});
afterEach((): void => { cleanup(); usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.task); useAccountStore.setState(initial.account); vi.restoreAllMocks(); });

describe('统一视频恢复动作的DOM接线', (): void => {
  it('原视频仅返回文字建议时显示检查原结果和独立重发确认，不自动新增请求', (): void => {
    task.status = 'paused'; task.outputs = []; task.artifacts = []; task.runtime!.stage = 'paused';
    task.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-original';
    task.errorInfo = { code: 'video_generation_not_started', message: '平台只返回提示词，尚未启动视频生成', recoverable: true, detectedAt: now };
    useTaskStore.setState({ tasks: [task] }); const original = structuredClone(task); render(<Node />);
    expect(screen.getByRole('button', { name: '检查原视频结果' })).toBeDefined();
    expect(screen.getByRole('button', { name: '确认重发一次' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '生成视频' })).toBeNull();
    expect(useTaskStore.getState().tasks).toEqual([original]); expect(generate).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
  });
  it('画布暂停和结束只属于当前活动视频节点，结束解锁输入且保留原Task事实', async (): Promise<void> => {
    const otherShots = structuredClone(snapshot.plan.shots.slice(1, 3)) as PetStoryPlan['shots']; project.plan!.shots.push(...otherShots);
    project.production!.state = 'running';
    project.productionHistory = [{ ...structuredClone(project.production!), state: 'paused', steps: [{ ...structuredClone(project.production!.steps[0]), id: 'TEST-history-step', shotId: otherShots[1].id, taskId: 'TEST-history-task', runId: 'TEST-history-run' }] }];
    const paused = structuredClone(project); paused.revision++; paused.production!.state = 'paused';
    const ended = structuredClone(paused); ended.revision++; ended.productionHistory!.push({ ...ended.production!, state: 'ended', endedAt: now }); ended.production = undefined;
    const pause = vi.fn(async (): Promise<object> => ({ success: true, project: paused })); const end = vi.fn(async (): Promise<object> => ({ success: true, project: ended }));
    window.electronAPI.petstory.pauseProduction = pause as typeof window.electronAPI.petstory.pauseProduction; window.electronAPI.petstory.endProduction = end as typeof window.electronAPI.petstory.endProduction;
    usePetStoryStore.setState({ project, pauseProduction: initial.pet.pauseProduction, endProduction: initial.pet.endProduction }); const original = structuredClone(task);
    const View: React.FC = (): React.ReactElement => { const p = usePetStoryStore((state) => state.project)!; return <>{p.plan!.shots.map((shot, index): React.ReactElement => <section key={shot.id} aria-label={['当前镜头', '独立镜头', '历史镜头'][index]}><CanvasMediaNode project={p} shot={shot} kind="video" disabled /></section>)}</>; };
    render(<View />); const active = screen.getByRole('region', { name: '当前镜头' });
    expect(within(active).getByRole('button', { name: '暂停后续制作' }).closest('.canvas-media-actions')).toBeTruthy();
    expect((within(active).getByLabelText('镜头1视频请求模式', { selector: 'input' }) as HTMLInputElement).disabled).toBe(true);
    for (const name of ['独立镜头', '历史镜头']) { const region = within(screen.getByRole('region', { name })); expect(region.queryByRole('button', { name: '暂停后续制作' })).toBeNull(); expect(region.queryByRole('button', { name: '结束本次制作' })).toBeNull(); }
    await act(async (): Promise<void> => { fireEvent.click(within(active).getByRole('button', { name: '暂停后续制作' })); });
    await waitFor((): void => expect(usePetStoryStore.getState().project?.production?.state).toBe('paused'));
    expect(pause).toHaveBeenCalledExactlyOnceWith(project.id); expect(within(active).queryByRole('button', { name: '暂停后续制作' })).toBeNull();
    fireEvent.click(within(active).getByRole('button', { name: /结束本次制作/ }));
    await waitFor((): void => expect(usePetStoryStore.getState().project?.production).toBeUndefined());
    expect(end).toHaveBeenCalledExactlyOnceWith(project.id); expect((within(active).getByLabelText('镜头1视频请求模式', { selector: 'input' }) as HTMLInputElement).disabled).toBe(false);
    expect(useTaskStore.getState().tasks).toEqual([original]); expect(usePetStoryStore.getState().project?.productionHistory?.at(-1)?.steps[0].taskId).toBe(original.id); expect(generate).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
  });
  it.each([['downloading', '重试下载'], ['validating', '重新校验'], ['library', '重试入库']] as const)('%s失败仅恢复本地原阶段，过期step投影不能引导重发', async (phase, label): Promise<void> => {
    localFailure(phase); const before = structuredClone(task); render(<Node />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor((): void => expect(resume).toHaveBeenCalledOnce());
    expect(generate).not.toHaveBeenCalled(); expect(readMedia).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: '生成视频' })).toBeNull();
    expect(task).toEqual(before); expect(useAccountStore.getState().accounts).toEqual([]);
  });
  it('已有视频始终提供生成新版本，点击后旧文件与选中成果保留', async (): Promise<void> => {
    const old = asset(); project.assets.push(old); project.selectedVideos = { [old.shotId!]: old.id }; project.production!.state = 'complete'; project.production!.steps[0].status = 'complete'; project.production!.steps[0].assetId = old.id;
    usePetStoryStore.setState({ project }); render(<Node />);
    expect(screen.getByRole('button', { name: '查看视频' })).toBeDefined(); fireEvent.click(screen.getByRole('button', { name: /生成新版本/ }));
    await waitFor((): void => expect(generate).toHaveBeenCalledExactlyOnceWith(old.shotId, 'video'));
    expect(usePetStoryStore.getState().project?.assets).toEqual([old]); expect(usePetStoryStore.getState().project?.selectedVideos?.[old.shotId!]).toBe(old.id);
  });
  it('预览失败重新读取只调用原资产读取，不触发下载、校验或生成', async (): Promise<void> => {
    project.assets.push(asset()); project.production!.state = 'complete'; project.production!.steps[0].status = 'complete'; project.production!.steps[0].assetId = project.assets[0].id;
    usePetStoryStore.setState({ project }); render(<Node />);
    fireEvent.click(await screen.findByRole('button', { name: '重新读取' }));
    await waitFor((): void => expect(readMedia).toHaveBeenCalledTimes(2));
    expect(readMedia).toHaveBeenLastCalledWith(project.id, project.assets[0].id); expect(resume).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });
  it('结束写入失败保持原槽位并能重试；成功后解除槽位且原任务与成果保留', async (): Promise<void> => {
    localFailure('library'); const old = asset(); project.assets.push(old);
    const ended = structuredClone(project); ended.revision++; ended.production!.state = 'ended'; ended.productionHistory = [ended.production!]; ended.production = undefined;
    const end = vi.fn().mockResolvedValueOnce({ success: false, error: 'TEST结束写入失败' }).mockResolvedValueOnce({ success: true, project: ended });
    window.electronAPI.petstory.endProduction = end;
    usePetStoryStore.setState({ endProduction: initial.pet.endProduction }); render(<Recovery />);
    fireEvent.click(screen.getByRole('button', { name: '结束本次制作' }));
    await waitFor((): void => expect(usePetStoryStore.getState().error).toContain('TEST结束写入失败'));
    expect(usePetStoryStore.getState().project?.production).toBeDefined(); expect(screen.getByRole('button', { name: '结束本次制作' })).toBeDefined();
    await act(async (): Promise<void> => { fireEvent.click(screen.getByRole('button', { name: '结束本次制作' })); });
    await waitFor((): void => expect(usePetStoryStore.getState().project?.production).toBeUndefined());
    expect(usePetStoryStore.getState().project?.assets).toEqual([old]); expect(useTaskStore.getState().tasks[0].id).toBe(task.id); expect(generate).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
  });
  it('项目先存complete而Task入库回执尚未保存时，恢复入口仍可见', (): void => {
    localFailure('library'); project.production!.state = 'complete'; project.production!.steps[0].status = 'complete'; project.assets.push(asset());
    usePetStoryStore.setState({ project }); render(<Recovery />); expect(screen.getByRole('button', { name: '重试入库' })).toBeDefined();
  });
});


it('结束已暂停图片等待后解除同镜视频设置锁；原任务和候选保留', async (): Promise<void> => {
  const shot = project.plan!.shots[0]; const operation = { id: 'TEST-image-op', requestId: 'TEST-image-request', target: { shotId: shot.id, kind: 'firstFrame' as const }, mode: 'generate' as const, stage: 'failed' as const, createdAt: now, basisHash: 'a'.repeat(64), taskId: task.id, error: 'TEST图片只回文字，已停止等待' };
  const imageRun = structuredClone(project.production!); imageRun.imageOperationId = operation.id; imageRun.target = { shotId: shot.id, kind: 'firstFrame' }; imageRun.steps[0].kind = 'firstFrame'; imageRun.state = 'paused';
  project.imageOperations = [operation]; project.imageProductions = { [operation.id]: imageRun }; project.production = undefined;
  task.mode = 'image'; task.status = 'paused'; task.runtime!.input.mode = 'image'; task.runtime!.stage = 'paused'; task.errorInfo = { code: 'cancelled', message: 'TEST已暂停', recoverable: true, detectedAt: now }; task.outputs = [];
  const ended = structuredClone(project); ended.revision++; ended.imageOperations![0].endedAt = now; ended.productionHistory = [{ ...imageRun, state: 'ended', endedAt: now }]; ended.imageProductions = { 'TEST-old-material': { ...imageRun, imageOperationId: 'TEST-old-material', target: undefined, phase: 'materials' } };
  ended.imageOperations!.push({ ...operation, id: 'TEST-old-material', requestId: 'TEST-old-material-request', target: { materialId: 'character:TEST' } });
  const end = vi.fn(async (): Promise<object> => ({ success: true, project: ended, operationId: operation.id })); window.electronAPI.petstory.endImageOperation = end as typeof window.electronAPI.petstory.endImageOperation;
  useTaskStore.setState({ tasks: [task] }); usePetStoryStore.setState({ project, endImageOperation: initial.pet.endImageOperation });
  const View: React.FC = (): React.ReactElement => { const current = usePetStoryStore((state) => state.project)!; return <><CanvasVideoSettings project={current} shot={current.plan!.shots[0]} /><PetStoryImageReview project={current} target={operation.target} title="TEST首帧" disabled={false} onUpload={async (): Promise<void> => undefined} onGenerate={generate} onAdopt={async (): Promise<void> => undefined} /></>; };
  render(<View />);
  expect((screen.getByRole('combobox', { name: `镜头${shot.order}视频请求模式` }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '结束本次图片等待' }));
  await waitFor((): void => expect((screen.getByRole('combobox', { name: `镜头${shot.order}视频请求模式` }) as HTMLInputElement).disabled).toBe(false));
  expect(end).toHaveBeenCalledExactlyOnceWith(project.id, operation.id); expect(useTaskStore.getState().tasks[0]).toEqual(task);
  expect(usePetStoryStore.getState().project?.productionHistory?.[0].steps[0].taskId).toBe(task.id); expect(generate).not.toHaveBeenCalled();
});


it('画布结束已受理视频以原run原子取消本地等待，保留提交并释放账号槽', async (): Promise<void> => {
  task.status = 'generating'; task.runtime!.stage = 'generating'; task.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-original';
  task.runtime!.acceptanceObservation = { schemaVersion: 1, accountId: project.accountId, runId: task.runtime!.runId, conversationUrl: task.runtime!.conversationUrl, acceptedAt: now,
    evidence: { kind: 'generation_started' }, cursor: { messageCount: 1, pollCount: 0 }, expectedArtifact: { kind: 'video', runId: task.runtime!.runId },
    lease: { ownerId: 'TEST-observer', acquiredAt: now, expiresAt: now, lastHeartbeatAt: now }, outcome: 'observing' };
  project.production!.state = 'running'; let persisted = [structuredClone(task)]; const source = structuredClone(task.runtime);
  const core = new TaskService({ store: { read: (): Task[] => structuredClone(persisted), replace: (items: Task[]): boolean => { persisted = structuredClone(items); return true; } }, defaultProjectId: (): string => project.studioProjectId });
  const ended = structuredClone(project); ended.revision++; ended.productionHistory = [{ ...ended.production!, state: 'ended', endedAt: now }]; ended.production = undefined;
  window.electronAPI.petstory.endProduction = vi.fn(async (): Promise<object> => { expect(persisted[0].status).toBe('cancelled'); return { success: true, project: ended }; }) as typeof window.electronAPI.petstory.endProduction;
  window.electronAPI.tasks = { list: async (): Promise<Task[]> => structuredClone(persisted), updateRuntime: async (id: string, patch: Omit<import('@doubao-studio/contracts').TaskUpdateRuntimeParams, 'taskId'>): Promise<object> => {
    const result = core.updateRuntime({ taskId: id, ...patch }); return result.success ? { success: true, task: result.data } : result;
  } } as typeof window.electronAPI.tasks;
  const unexpectedAccountAction = async (): Promise<never> => { throw new Error('TEST结束等待不调用其他账号操作'); };
  window.electronAPI.logs = { list: async (): Promise<[]> => [], append: vi.fn(async (): Promise<{ success: boolean }> => ({ success: true })), clear: async (): Promise<{ success: boolean }> => ({ success: true }) };
  window.electronAPI.accounts = { list: unexpectedAccountAction, add: unexpectedAccountAction, update: unexpectedAccountAction, delete: unexpectedAccountAction, refresh: unexpectedAccountAction,
    setStatus: vi.fn(async (): Promise<{ success: boolean }> => ({ success: true })), setPinned: unexpectedAccountAction, updateSeedanceQuota: unexpectedAccountAction, updateHealth: unexpectedAccountAction, setAvailability: unexpectedAccountAction, updateScheduling: unexpectedAccountAction, getPartition: unexpectedAccountAction };
  useTaskStore.setState({ tasks: [task], pauseAutomation: initial.task.pauseAutomation, accountBusy: { [project.accountId]: true }, executingTasks: { [project.accountId]: task.id } });
  usePetStoryStore.setState({ project, endProduction: initial.pet.endProduction }); const events = vi.spyOn(window, 'dispatchEvent'); render(<Node />);
  fireEvent.click(screen.getByRole('button', { name: '结束本次制作' }));
  await waitFor((): void => expect(usePetStoryStore.getState().project?.production).toBeUndefined());
  expect(persisted[0]).toMatchObject({ status: 'cancelled', runtime: { stage: 'cancelled', runId: source!.runId, submittedAt: source!.submittedAt, input: source!.input, conversationUrl: source!.conversationUrl, acceptanceObservation: { outcome: 'manual_review' } } });
  expect(useTaskStore.getState().accountBusy[project.accountId]).toBeUndefined(); expect(useTaskStore.getState().executingTasks[project.accountId]).toBeUndefined();
  expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'cancel-task-automation', detail: { taskId: task.id, expectedRunId: source!.runId, targetStatus: 'cancelled' } }));
});
