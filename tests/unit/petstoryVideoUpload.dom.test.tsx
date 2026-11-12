import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryAsset, PetStoryPlan, PetStoryProduction, PetStoryProject, PetStoryResult, Task } from '@doubao-studio/contracts';
import { CanvasMediaNode } from '../../src/components/PetStoryCanvasMedia';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-11-12T00:00:00.000Z';
let project: PetStoryProject;
const upload = vi.fn<(id: string, revision: number, shotId: string) => Promise<PetStoryResult>>();
const generate = vi.fn<() => Promise<void>>();

function uploaded(): PetStoryProject {
  const saved = structuredClone(project); saved.revision++;
  const asset: PetStoryAsset = { id: 'TEST-uploaded-video', kind: 'video', shotId: saved.plan!.shots[0].id,
    relativePath: 'TEST-uploaded.mp4', origin: 'user_upload',
    uploadSource: { projectId: saved.id, accountId: saved.accountId, shotId: saved.plan!.shots[0].id, sha256: 'TEST-digest', uploadedAt: now },
    validation: { decoded: true, sha256: 'TEST-digest', bytes: 64, width: 1280, height: 720, durationSeconds: 5.2, checkedAt: now } };
  saved.assets.push(asset); saved.selectedVideos = { [asset.shotId!]: asset.id };
  return saved;
}
function node(): React.ReactElement {
  return <CanvasMediaNode project={project} shot={project.plan!.shots[0]} kind="video" disabled={false} />;
}

/** 与真实画布父层一样订阅项目，验证 IPC 保存结果会直接更新当前播放器。 */
const LiveVideoNode: React.FC = (): React.ReactElement | null => {
  const current = usePetStoryStore((state): PetStoryProject | null => state.project);
  if (!current?.plan?.shots[0]) return null;
  return <CanvasMediaNode project={current} shot={current.plan.shots[0]} kind="video" disabled={false} />;
};

function production(state: 'running' | 'paused'): PetStoryProduction {
  const entry = { state: 'supported' as const, reason: 'TEST' };
  return { state, phase: 'shots', approvedAt: now, planHash: 'TEST', message: 'TEST', fallbacks: {}, shots: {}, steps: [],
    capability: { accountId: project.accountId, durations: [5], image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry } } };
}

beforeEach((): void => {
  vi.resetAllMocks();
  const plan = structuredClone(snapshot.plan) as PetStoryPlan; plan.shots = plan.shots.slice(0, 1);
  plan.shots[0].prompts.video.final = '';
  project = { schemaVersion: 1, id: 'TEST-upload-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, plan, assets: [], jobs: [], updatedAt: now };
  upload.mockImplementation(async (): Promise<PetStoryResult> => ({ success: true, project: uploaded() }));
  window.electronAPI = { petstory: { addShotVideo: upload,
    inspectGeneration: vi.fn(async (): Promise<object> => ({ success: true, eligibility: { ready: false, blockers: [] } })),
    readMedia: vi.fn(async (): Promise<object> => ({ success: true, data: `doubao-media://asset/${'a'.repeat(64)}`, mimeType: 'video/mp4' })),
  } } as unknown as typeof window.electronAPI;
  usePetStoryStore.setState({ ...initial.pet, project, busy: false, error: '', generateShotMedia: generate });
  useTaskStore.setState({ ...initial.tasks, tasks: [], activeTaskId: null, executingTasks: {}, accountBusy: {} });
});
afterEach((): void => { usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });

describe('镜头视频上传入口', (): void => {
  it('无需生成正文或平台就绪即可上传到本镜，保存后使用现有播放器且不创建生成请求', async (): Promise<void> => {
    const view = render(node());
    expect(screen.queryByRole('button', { name: '原请求豆包对话' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '上传视频' }));
    await waitFor((): void => expect(usePetStoryStore.getState().busy).toBe(false));
    expect(upload).toHaveBeenCalledExactlyOnceWith(project.id, project.revision, project.plan!.shots[0].id);
    project = usePetStoryStore.getState().project!; view.rerender(node());
    const player = await screen.findByLabelText('镜头 1 镜头视频');
    expect(player.getAttribute('src')).toMatch(/^doubao-media:/);
    expect(screen.getByText(/用户上传视频 · 1280 × 720/)).toBeDefined();
    expect(project.selectedVideos?.[project.plan!.shots[0].id]).toBe('TEST-uploaded-video');
    expect(project.assets[0].taskId).toBeUndefined(); expect(project.assets[0].runId).toBeUndefined();
    expect(generate).not.toHaveBeenCalled(); expect(useTaskStore.getState().tasks).toEqual([]);
  });

  it('真实项目订阅下连续上传自动切换当前文件与播放来源，先前失败和取消不污染新选择', async (): Promise<void> => {
    let sequence = 0;
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.mocked(window.electronAPI.petstory.readMedia).mockImplementation(async (_id: string, assetId: string): Promise<{ success: true; data: string; mimeType: string }> => ({
      success: true, data: `doubao-media://asset/${assetId.endsWith('-2') ? 'b'.repeat(64) : 'a'.repeat(64)}`, mimeType: 'video/mp4' }));
    upload.mockImplementation(async (): Promise<PetStoryResult> => {
      const saved = structuredClone(usePetStoryStore.getState().project!); saved.revision++;
      const candidate = { ...uploaded().assets.at(-1)!, id: `TEST-live-video-${++sequence}`, relativePath: `TEST-live-${sequence}.mp4` };
      saved.assets.push(candidate); saved.selectedVideos = { ...saved.selectedVideos, [candidate.shotId!]: candidate.id };
      return { success: true, project: saved };
    });
    render(<LiveVideoNode />);
    upload.mockRejectedValueOnce(new Error('TEST 首次文件读取失败'));
    fireEvent.click(screen.getByRole('button', { name: '上传视频' }));
    await waitFor((): void => expect(screen.getByRole('alert').textContent).toBe('TEST 首次文件读取失败'));
    fireEvent.click(screen.getByRole('button', { name: '上传视频' }));
    const first = await screen.findByLabelText('镜头 1 镜头视频'); expect(first.getAttribute('src')).toBe(`doubao-media://asset/${'a'.repeat(64)}`);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '上传视频' }));
    await waitFor((): void => expect(screen.getByLabelText('镜头 1 镜头视频').getAttribute('src')).toBe(`doubao-media://asset/${'b'.repeat(64)}`));
    const second = screen.getByLabelText('镜头 1 镜头视频'); fireEvent.click(screen.getByRole('button', { name: '查看视频' }));
    await waitFor((): void => expect(play).toHaveBeenCalledOnce()); expect(play.mock.instances[0]).toBe(second);
    const beforeCancel = structuredClone(usePetStoryStore.getState().project!); upload.mockResolvedValueOnce({ success: false, error: '已取消' });
    fireEvent.click(screen.getByRole('button', { name: '上传视频' })); await waitFor((): void => expect(usePetStoryStore.getState().busy).toBe(false));
    expect(usePetStoryStore.getState().project).toEqual(beforeCancel); expect(beforeCancel.assets).toHaveLength(2);
    expect(beforeCancel.selectedVideos?.[project.plan!.shots[0].id]).toBe('TEST-live-video-2');
    expect(screen.queryByRole('alert')).toBeNull(); expect(generate).not.toHaveBeenCalled(); expect(useTaskStore.getState().tasks).toEqual([]);
  });

  it('上传期间卸载并切换项目，迟到保存不拉回原项目或覆盖新项目提示', async (): Promise<void> => {
    let finish: (result: PetStoryResult) => void = (): void => undefined;
    upload.mockImplementationOnce((): Promise<PetStoryResult> => new Promise((resolve): void => { finish = resolve; }));
    const view = render(<LiveVideoNode />); fireEvent.click(screen.getByRole('button', { name: '上传视频' })); expect(upload).toHaveBeenCalledOnce();
    const saved = uploaded(); view.unmount();
    const other = { ...structuredClone(project), id: 'TEST-after-unmount' };
    act((): void => { usePetStoryStore.setState({ project: other, error: 'TEST 新项目已有提示' }); });
    await act(async (): Promise<void> => { finish({ success: true, project: saved }); });
    expect(usePetStoryStore.getState().busy).toBe(false); expect(usePetStoryStore.getState().project).toEqual(other);
    expect(usePetStoryStore.getState().error).toBe('TEST 新项目已有提示'); expect(generate).not.toHaveBeenCalled();
  });

  it('选择与校验期间阻止重复点击，取消后释放占用且不显示错误', async (): Promise<void> => {
    let finish: (result: PetStoryResult) => void = (): void => undefined;
    upload.mockImplementationOnce((): Promise<PetStoryResult> => new Promise((resolve): void => { finish = resolve; }));
    render(node()); const button = screen.getByRole('button', { name: '上传视频' });
    fireEvent.click(button); fireEvent.click(button);
    expect(upload).toHaveBeenCalledOnce(); expect(button.hasAttribute('disabled')).toBe(true);
    await act(async (): Promise<void> => { finish({ success: false, error: '已取消' }); });
    expect(button.hasAttribute('disabled')).toBe(false); expect(usePetStoryStore.getState().error).toBe('');
    expect(usePetStoryStore.getState().project).toEqual(project); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('校验失败显示正式原因，保留原视频和选中事实', async (): Promise<void> => {
    project = uploaded(); const before = structuredClone(project);
    usePetStoryStore.setState({ project });
    upload.mockResolvedValueOnce({ success: false, error: 'TEST 视频文件损坏，请重新选择' });
    render(node()); fireEvent.click(screen.getByRole('button', { name: '上传视频' }));
    await waitFor((): void => expect(screen.getByRole('alert').textContent).toContain('视频文件损坏'));
    expect(usePetStoryStore.getState().project).toEqual(before); expect(generate).not.toHaveBeenCalled();
  });

  it.each(['missing_method', 'missing_handler'] as const)('%s 显示重启提示并释放占用，保留项目、选中视频和任务', async (failure: 'missing_method' | 'missing_handler'): Promise<void> => {
    project = uploaded(); const before = structuredClone(project);
    const tasks: Task[] = [{ id: 'TEST-existing-task', projectId: project.studioProjectId, assignedAccountId: project.accountId,
      mode: 'video', prompt: 'TEST 原任务输入', status: 'paused', outputs: [], result: null, createdAt: now, updatedAt: now }];
    usePetStoryStore.setState({ project }); useTaskStore.setState({ tasks: structuredClone(tasks) });
    if (failure === 'missing_method') Reflect.deleteProperty(window.electronAPI.petstory, 'addShotVideo');
    else upload.mockRejectedValueOnce(new Error("Error invoking remote method 'petstory:addShotVideo': Error: No handler registered for 'petstory:addShotVideo'"));
    render(node()); const button = screen.getByRole('button', { name: '上传视频' }); fireEvent.click(button);
    await waitFor((): void => expect(screen.getByRole('alert').textContent).toBe('视频上传功能尚未加载，请关闭并重新打开工作室后再上传。'));
    expect(usePetStoryStore.getState().busy).toBe(false); expect(button.hasAttribute('disabled')).toBe(false);
    expect(usePetStoryStore.getState().project).toEqual(before); expect(usePetStoryStore.getState().project!.selectedVideos).toEqual(before.selectedVideos);
    expect(useTaskStore.getState().tasks).toEqual(tasks); expect(generate).not.toHaveBeenCalled();
    if (failure === 'missing_method') expect(upload).not.toHaveBeenCalled(); else expect(upload).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '重启应用' })).toBeNull();
  });

  it.each(['TEST 视频文件不存在，请重新选择', 'TEST EACCES：没有读取视频文件的权限'])('普通上传异常保留真实原因：%s', async (reason: string): Promise<void> => {
    project = uploaded(); const before = structuredClone(project); usePetStoryStore.setState({ project });
    upload.mockRejectedValueOnce(new Error(reason));
    render(node()); const button = screen.getByRole('button', { name: '上传视频' }); fireEvent.click(button);
    await waitFor((): void => expect(screen.getByRole('alert').textContent).toBe(reason));
    expect(usePetStoryStore.getState().busy).toBe(false); expect(button.hasAttribute('disabled')).toBe(false);
    expect(usePetStoryStore.getState().project).toEqual(before); expect(useTaskStore.getState().tasks).toEqual([]); expect(generate).not.toHaveBeenCalled();
  });

  it('结束未完成制作后上传，不继承历史任务的暂停状态、错误或豆包会话', async (): Promise<void> => {
    project = uploaded(); const shotId = project.plan!.shots[0].id;
    const task: Task = { id: 'TEST-ended-task', projectId: project.studioProjectId, assignedAccountId: project.accountId,
      mode: 'video', prompt: 'TEST 旧视频输入', status: 'paused', outputs: [], result: null, createdAt: now, updatedAt: now,
      petstory: { projectId: project.id, stepId: 'TEST-ended-step' },
      runtime: { runId: 'TEST-ended-run', attempt: 1, stage: 'paused', message: 'TEST 旧任务暂停', startedAt: now, stageStartedAt: now,
        lastHeartbeatAt: now, conversationUrl: 'https://www.doubao.com/chat/TEST-ended', input: { mode: 'video', prompt: 'TEST 旧视频输入', attachments: [] } } };
    const entry = { state: 'supported' as const, reason: 'TEST' };
    project.productionHistory = [{ state: 'ended', phase: 'shots', approvedAt: now, planHash: 'TEST', message: 'TEST 本地制作已结束', fallbacks: {}, shots: {},
      steps: [{ id: 'TEST-ended-step', kind: 'video', shotId, taskId: task.id, runId: task.runtime!.runId, status: 'bound',
        inputHash: 'TEST', attachmentAssetIds: [], error: 'TEST 旧步骤失败' }],
      capability: { accountId: project.accountId, durations: [5], image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry } } }];
    usePetStoryStore.setState({ project }); useTaskStore.setState({ tasks: [task] });
    const open = vi.fn(); window.addEventListener('open-task-conversation', open);
    try {
      render(node()); await screen.findByLabelText('镜头 1 镜头视频');
      expect(screen.getByText('文件校验通过')).toBeDefined();
      expect(screen.queryByText('TEST 旧步骤失败')).toBeNull(); expect(screen.queryByText('已暂停')).toBeNull();
      const conversation = screen.getByRole('button', { name: '进入豆包对话' }); expect(conversation.hasAttribute('disabled')).toBe(true);
      fireEvent.click(conversation); expect(open).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: '上传视频' }).hasAttribute('disabled')).toBe(false);
      expect(generate).not.toHaveBeenCalled();
    } finally { window.removeEventListener('open-task-conversation', open); }
  });

  it.each(['running', 'paused'] as const)('%s 的旧独立图片制作不阻断上传且原制作记录保持', async (state: 'running' | 'paused'): Promise<void> => {
    project.production = { ...production(state), imageOperationId: 'TEST-legacy-image', target: { shotId: project.plan!.shots[0].id, kind: 'firstFrame' } };
    const originalProduction = structuredClone(project.production); usePetStoryStore.setState({ project });
    render(node()); const button = screen.getByRole('button', { name: '上传视频' }); expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button); await waitFor((): void => expect(usePetStoryStore.getState().busy).toBe(false));
    expect(upload).toHaveBeenCalledOnce(); expect(usePetStoryStore.getState().project!.production).toEqual(originalProduction);
    expect(usePetStoryStore.getState().project!.selectedVideos?.[project.plan!.shots[0].id]).toBe('TEST-uploaded-video'); expect(generate).not.toHaveBeenCalled();
  });

  it.each(['materials', 'firstFrame', 'lastFrame'] as const)('无操作标识但明确为 %s 的旧图片制作不阻断上传', async (kind: 'materials' | 'firstFrame' | 'lastFrame'): Promise<void> => {
    project.production = production('paused');
    if (kind === 'materials') project.production.phase = 'materials';
    else project.production.target = { shotId: project.plan!.shots[0].id, kind };
    const originalProduction = structuredClone(project.production); usePetStoryStore.setState({ project });
    render(node()); const button = screen.getByRole('button', { name: '上传视频' }); expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button); await waitFor((): void => expect(usePetStoryStore.getState().busy).toBe(false));
    expect(upload).toHaveBeenCalledOnce(); expect(usePetStoryStore.getState().project!.production).toEqual(originalProduction); expect(generate).not.toHaveBeenCalled();
  });

  it('独立图片槽中的失败等待不阻断上传，不结束或更改图片运行', async (): Promise<void> => {
    const id = 'TEST-failed-image'; const target = { shotId: project.plan!.shots[0].id, kind: 'lastFrame' as const };
    project.imageOperations = [{ id, requestId: 'TEST-image-request', target, mode: 'generate', stage: 'failed', createdAt: now, basisHash: 'TEST', error: 'TEST 图片等待已暂停' }];
    project.imageProductions = { [id]: { ...production('paused'), imageOperationId: id, target } };
    const originalImages = structuredClone({ operations: project.imageOperations, productions: project.imageProductions }); usePetStoryStore.setState({ project });
    render(node()); const button = screen.getByRole('button', { name: '上传视频' }); expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button); await waitFor((): void => expect(usePetStoryStore.getState().busy).toBe(false));
    expect(upload).toHaveBeenCalledOnce(); const saved = usePetStoryStore.getState().project!;
    expect({ operations: saved.imageOperations, productions: saved.imageProductions }).toEqual(originalImages); expect(generate).not.toHaveBeenCalled();
  });

  it.each(['running', 'paused'] as const)('%s 的真实视频制作继续使用已有结束入口', (state: 'running' | 'paused'): void => {
    project.production = { ...production(state), target: { shotId: project.plan!.shots[0].id, kind: 'video' } };
    usePetStoryStore.setState({ project }); render(node()); const button = screen.getByRole('button', { name: '上传视频' });
    expect(button.hasAttribute('disabled')).toBe(true); expect(button.title).toContain('先结束本次制作'); fireEvent.click(button); expect(upload).not.toHaveBeenCalled();
  });

  it.each([false, true])('带图片标识=%s但已有视频步骤时仍阻断上传', (imageMarker: boolean): void => {
    project.production = { ...production('paused'), ...(imageMarker ? { imageOperationId: 'TEST-mixed-image', phase: 'materials' as const } : {}),
      steps: [{ id: 'TEST-video-step', kind: 'video', shotId: project.plan!.shots[0].id, status: 'preparing', inputHash: 'TEST', attachmentAssetIds: [] }] };
    usePetStoryStore.setState({ project }); render(node()); const button = screen.getByRole('button', { name: '上传视频' });
    expect(button.hasAttribute('disabled')).toBe(true); fireEvent.click(button); expect(upload).not.toHaveBeenCalled();
  });

  it.each([false, true])('无明确目标的整批制作已有图片步骤=%s时仍阻断上传', (hasImageStep: boolean): void => {
    project.production = { ...production('paused'), steps: hasImageStep ? [{ id: 'TEST-batch-image-step', kind: 'firstFrame', shotId: project.plan!.shots[0].id, status: 'bound', inputHash: 'TEST', attachmentAssetIds: [] }] : [] };
    usePetStoryStore.setState({ project }); render(node()); const button = screen.getByRole('button', { name: '上传视频' });
    expect(button.hasAttribute('disabled')).toBe(true); fireEvent.click(button); expect(upload).not.toHaveBeenCalled();
  });

  it.each([false, true])('切换项目后迟到上传 success=%s 不切回原项目、不污染新项目错误', async (success: boolean): Promise<void> => {
    let finish: (result: PetStoryResult) => void = (): void => undefined;
    upload.mockImplementationOnce((): Promise<PetStoryResult> => new Promise((resolve): void => { finish = resolve; }));
    const pending = usePetStoryStore.getState().uploadShotVideo(project.plan!.shots[0].id);
    const other = { ...structuredClone(project), id: 'TEST-other-project' };
    usePetStoryStore.setState({ project: other, error: 'TEST 新项目现有提示' });
    finish(success ? { success: true, project: uploaded() } : { success: false, error: 'TEST 原项目上传失败' });
    await pending;
    expect(usePetStoryStore.getState().project).toEqual(other);
    expect(usePetStoryStore.getState().error).toBe('TEST 新项目现有提示');
    expect(generate).not.toHaveBeenCalled();
  });
});
