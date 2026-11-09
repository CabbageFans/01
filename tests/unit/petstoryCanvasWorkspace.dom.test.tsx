/** 离线可见按钮接线；不替代真实 Electron 或豆包验收。 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryPlan, PetStoryProject, PetStoryPromptBatch, Task } from '@doubao-studio/contracts';
import { PetStoryCanvas } from '../../src/components/PetStoryCanvas';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { createVideoModeEntryCheckpoint, VideoControlReadinessError } from '../../src/utils/videoControlReadiness';
import snapshot from '../fixtures/storyboard-five-shots.json';

vi.mock('../../src/components/PetStoryCanvasMedia', (): object => ({
  CanvasMediaNode: (): React.ReactElement => <div>TEST 保留媒体节点</div>,
  CanvasReferenceStrip: (): React.ReactElement => <div>TEST 保留素材引用</div>,
}));
const initial = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
let project: PetStoryProject;
const dirtyChanged = (): void => undefined;
beforeEach((): void => {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  project = { schemaVersion: 1, id: 'TEST-workspace', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, updatedAt: '2026-10-31T00:00:00.000Z', source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-story', text: snapshot.mobileStory, importedAt: '2026-10-31T00:00:00.000Z' }, plan, assets: [], jobs: [] };
  usePetStoryStore.setState({ ...initial.pet, project, projectName: 'TEST 项目', busy: false, error: '', promptBatch: { total: 0, completed: 0, status: 'idle' } });
  useTaskStore.setState({ ...initial.tasks, tasks: [] });
});
afterEach((): void => { usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });
function canvas(promptTargets?: PetStoryPromptBatch['targets']): React.ReactElement { return <PetStoryCanvas project={project} promptTargets={promptTargets} legacyDirty={false} onDirtyChange={dirtyChanged} materials={null} controls={null} />; }

describe('画布唯一工具栏入口', (): void => {
  it('一次点击接入本批生成，真实运行状态替换同一个按钮；生成时仍可浏览全文与缩放', (): void => {
    project.plan!.shots[0].prompts.video.final = '';
    const generate = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ generateCanvasPrompts: generate });
    const { container } = render(canvas());
    expect(container.querySelectorAll('.canvas-toolbar')).toHaveLength(1);
    expect(container.querySelector('.canvas-statusbar')).toBeNull();
    expect(container.textContent).not.toContain('更多提示词操作');
    expect(container.textContent).not.toContain('提交全文与实际素材用途');
    expect(screen.getAllByText('TEST 项目')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '补齐提示词（1项）' }));
    expect(generate).toHaveBeenCalledOnce();
    act((): void => usePetStoryStore.setState({ promptBatch: { total: project.plan!.shots.length * 2, completed: 1, status: 'running' }, busy: true }));
    expect((screen.getByRole('button', { name: /正在生成提示词/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '放大画布' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '放大镜头1首帧生图提示词' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('保存批次17/18仅剩镜头4视频正文时，明确补齐1项且继续沿原批次服务', (): void => {
    const shot = project.plan!.shots[3]; shot.prompts.video.final = '';
    project.promptBatch = { id: 'TEST-real-scope', scope: 'shots', status: 'paused', total: 18, completed: 17, targets: [{ shotId: shot.id, kind: 'video' }] };
    const generate = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ generateCanvasPrompts: generate, promptBatch: { status: 'paused', total: 18, completed: 17 } });
    render(canvas([{ shotId: project.plan!.shots[0].id, kind: 'firstFrame' }]));
    const button = screen.getByRole('button', { name: '补齐提示词（1项）' });
    expect(button.getAttribute('title')).toBe('生成镜头文字：镜头 4 · 视频提示词');
    expect(screen.getByText('提示词：镜头 4 · 视频提示词')).toBeDefined();
    expect(screen.queryByRole('button', { name: '继续生成提示词' })).toBeNull();
    fireEvent.click(button); expect(generate).toHaveBeenCalledOnce();
  });

  it('全部正文已有且无未决原任务时隐藏生成入口，初次空正文仍保留动态范围入口', (): void => {
    usePetStoryStore.setState({ promptBatch: { status: 'paused', total: 18, completed: 17 } });
    const view = render(canvas());
    expect(screen.queryByRole('button', { name: /补齐提示词|生成镜头提示词|继续生成提示词/ })).toBeNull();
    const empty = structuredClone(project);
    let count = 0;
    for (const shot of empty.plan!.shots) for (const prompt of Object.values(shot.prompts)) { if (prompt) { prompt.final = ''; count++; } }
    project = empty; usePetStoryStore.setState({ project, promptBatch: { status: 'idle', total: 0, completed: 0 } });
    view.rerender(canvas());
    expect(screen.getByRole('button', { name: `生成镜头提示词（${count}项）` })).toBeDefined();
  });

  it('初次范围共享现有资格快照，待采用和需在原节点处理的回复不重复计入', (): void => {
    const first = project.plan!.shots[0]; const second = project.plan!.shots[1];
    first.prompts.firstFrame.final = ''; first.prompts.video.final = ''; second.prompts.firstFrame.final = '';
    project.jobs.push({ id: 'TEST-existing-candidate', taskId: 'TEST-candidate-task', kind: 'optimize', shotId: first.id, promptKind: 'firstFrame', inputHash: 'TEST', sourceUrl: '', status: 'applied', resultStatus: 'candidate', parsedResult: { optimized: 'TEST 待采用正文' } },
      { id: 'TEST-original-invalid', taskId: 'TEST-invalid-task', kind: 'optimize', shotId: first.id, promptKind: 'video', inputHash: 'TEST', sourceUrl: '', status: 'invalid' });
    render(canvas([{ shotId: first.id, kind: 'firstFrame' }, { shotId: first.id, kind: 'video' }, { shotId: second.id, kind: 'firstFrame' }, { materialId: 'TEST-material' }]));
    const button = screen.getByRole('button', { name: '补齐提示词（1项）' });
    expect(button.getAttribute('title')).toBe('生成镜头文字：镜头 2 · 首帧提示词');
  });

  it('前置或保存错误在工具栏直接显示，全文仍可通过title查看', (): void => {
    const error = 'TEST 当前真实失败原因，原请求未重发'; usePetStoryStore.setState({ error });
    const { container } = render(canvas());
    const notice = container.querySelector('.canvas-toolbar [role="alert"]');
    expect(notice?.textContent).toBe(error); expect(notice?.getAttribute('title')).toBe(error);
  });

  it('顶部旧视频错误不再要求改用两参考图，保留原始错误供审计', (): void => {
    const error = '当前豆包入口只有参考图上传，不支持独立首尾帧；本次尚未上传或提交。可在本镜制作设置选择“多参考”，经你明确选择后使用已有图片。';
    usePetStoryStore.setState({ error });
    const { container } = render(canvas()); const notice = container.querySelector('.canvas-toolbar [role="alert"]');
    expect(notice?.textContent).toContain('请继续原视频任务');
    expect(notice?.getAttribute('title')).not.toContain('多参考');
    expect(usePetStoryStore.getState().error).toBe(error);
  });

  it('视频入口准备错误显示中文恢复说明，持久化错误码和诊断不改写', (): void => {
    const error = 'video_mode_entry_not_ready: video_entry未在有界等待内就绪（7142ms/1次），已在提交前停止';
    usePetStoryStore.setState({ error });
    const { container } = render(canvas()); const notice = container.querySelector('.canvas-toolbar [role="alert"]');
    expect(notice?.textContent).toContain('视频生成入口尚未准备好');
    expect(notice?.textContent).toContain('请继续原视频任务');
    expect(notice?.getAttribute('title')).not.toContain('video_entry');
    expect(usePetStoryStore.getState().error).toBe(error);
  });

  it('模式归属歧义的具体原因显示在顶部，保留原错误与采样诊断', (): void => {
    const diagnostic = createVideoModeEntryCheckpoint({ ready: false, elapsedMs: 13058, attempts: 17, stableSamples: 0,
      controlOperation: 'mode_option', failureReason: 'ambiguous', missingControl: 'video_entry' }, 13058);
    const failure = new VideoControlReadinessError('mode_entry', diagnostic);
    usePetStoryStore.setState({ error: failure.message });
    const { container } = render(canvas()); const notice = container.querySelector('.canvas-toolbar [role="alert"]');
    expect(notice?.textContent).toContain('存在多个目标，无法确认');
    expect(notice?.getAttribute('title')).toContain('视频生成入口尚未准备好：存在多个目标，无法确认');
    expect(notice?.getAttribute('title')).not.toContain('video_entry');
    expect(usePetStoryStore.getState().error).toBe(failure.message); expect(failure.diagnostic.attempts).toBe(17);
  });

  it.each(['fail', 'paused', 'cancelled'] as const)('bound旧job对应%s任务时工具栏不显示假进度', (status): void => {
    const shot = project.plan!.shots[0];
    project.jobs.push({ id: 'TEST-old-job', taskId: 'TEST-old-task', kind: 'optimize', shotId: shot.id, promptKind: 'firstFrame', inputHash: 'TEST', sourceUrl: '', status: 'bound' });
    const task: Task = { id: 'TEST-old-task', mode: 'chat', status, assignedAccountId: project.accountId, prompt: 'TEST', outputs: [], result: null, createdAt: project.updatedAt, updatedAt: project.updatedAt };
    useTaskStore.setState({ tasks: [task] });
    const { container } = render(canvas()); const progress = container.querySelector('.canvas-batch-progress')!;
    expect(progress.textContent?.trim()).toBe(''); expect(progress.querySelector('.anticon-loading')).toBeNull();
  });

  it('暂停批次中的单项意见修订显示真实动态状态，结束失败即回到批次静态进度', (): void => {
    const shot = project.plan!.shots[0];
    project.jobs.push({ id: 'TEST-feedback-job', taskId: 'TEST-feedback-task', kind: 'optimize', shotId: shot.id, promptKind: 'firstFrame', inputHash: 'TEST', sourceUrl: '', status: 'bound', promptFeedback: { text: 'TEST 修改意见', baseText: 'TEST 选定正文' } });
    const task: Task = { id: 'TEST-feedback-task', mode: 'chat', status: 'generating', assignedAccountId: project.accountId, prompt: 'TEST', outputs: [], result: null, createdAt: project.updatedAt, updatedAt: project.updatedAt };
    useTaskStore.setState({ tasks: [task] }); usePetStoryStore.setState({ promptBatch: { total: 18, completed: 16, status: 'paused' } });
    const { container } = render(canvas()); const progress = container.querySelector('.canvas-batch-progress')!;
    expect(progress.textContent).toContain('正在修改…'); expect(progress.textContent).not.toContain('16/18'); expect(progress.querySelector('.anticon-loading')).not.toBeNull();
    act((): void => useTaskStore.setState({ tasks: [{ ...task, status: 'fail' }] }));
    expect(progress.textContent).toContain('已生成 16/18 · 待继续'); expect(progress.querySelector('.anticon-loading')).toBeNull();
  });

  it('本批完成后通过一个按钮确认本批候选，无手改冲突不增加确认弹窗', (): void => {
    const shot = project.plan!.shots[0];
    shot.prompts.firstFrame.final = ''; shot.prompts.firstFrame.optimized = 'TEST 新候选'; shot.prompts.firstFrame.edited = false; shot.prompts.firstFrame.candidateJobId = 'TEST-candidate';
    project.jobs.push({ id: 'TEST-candidate', taskId: 'TEST-chat', kind: 'optimize', shotId: shot.id, promptKind: 'firstFrame', inputHash: 'TEST', sourceUrl: '', status: 'applied', resultStatus: 'candidate', requestId: 'TEST-request', parsedResult: { optimized: 'TEST 新候选' } });
    project.promptBatch = { id: 'TEST-batch', targets: [], candidateJobIds: ['TEST-candidate'], total: 1, completed: 1, status: 'complete' };
    const adopt = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ adoptPromptBatchCandidates: adopt, promptBatch: { total: 1, completed: 1, status: 'complete' } });
    render(canvas());
    fireEvent.click(screen.getByRole('button', { name: '确认本次结果' }));
    expect(adopt).toHaveBeenCalledOnce(); expect(screen.queryByRole('dialog')).toBeNull();
    expect(shot.prompts.firstFrame.final).toBe('');
  });

  it('本批部分失败暂停后仍可确认合法候选子集，不触碰失败目标', (): void => {
    const shot = project.plan!.shots[0]; shot.prompts.firstFrame.edited = false;
    const failedShot = project.plan!.shots[1]; const failedFinal = failedShot.prompts.video.final;
    project.jobs.push({ id: 'TEST-valid-candidate', taskId: 'TEST-chat', kind: 'optimize', shotId: shot.id, promptKind: 'firstFrame', inputHash: 'TEST', sourceUrl: '', status: 'applied', resultStatus: 'candidate', parsedResult: { optimized: 'TEST 本批合法候选' } });
    project.promptBatch = { id: 'TEST-partial-batch', targets: [{ shotId: failedShot.id, kind: 'video' }], candidateJobIds: ['TEST-valid-candidate'], total: 2, completed: 1, status: 'paused', failedTargets: [{ target: { shotId: failedShot.id, kind: 'video' }, message: 'TEST 原回复未通过' }] };
    const adopt = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ adoptPromptBatchCandidates: adopt, promptBatch: { total: 2, completed: 1, status: 'paused' } });
    render(canvas());
    expect(screen.getByRole('button', { name: '补齐提示词（1项）' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '确认本次结果' }));
    expect(adopt).toHaveBeenCalledOnce(); expect(screen.queryByRole('dialog')).toBeNull();
    expect(project.promptBatch.candidateJobIds).toEqual(['TEST-valid-candidate']);
    expect(failedShot.prompts.video.final).toBe(failedFinal);
    expect(project.promptBatch.failedTargets).toHaveLength(1);
  });

  it('批量确认替换手改前明确列出对应项，取消不采用', async (): Promise<void> => {
    const shot = project.plan!.shots[0]; shot.prompts.firstFrame.edited = true;
    project.jobs.push({ id: 'TEST-candidate', taskId: 'TEST-chat', kind: 'optimize', shotId: shot.id, promptKind: 'firstFrame', inputHash: 'TEST', sourceUrl: '', status: 'applied', resultStatus: 'candidate', parsedResult: { optimized: 'TEST 新候选' } });
    project.promptBatch = { id: 'TEST-batch', targets: [], candidateJobIds: ['TEST-candidate'], total: 1, completed: 1, status: 'complete' };
    const adopt = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ adoptPromptBatchCandidates: adopt, promptBatch: { total: 1, completed: 1, status: 'complete' } });
    render(canvas()); fireEvent.click(screen.getByRole('button', { name: '确认本次结果' }));
    const dialog = screen.getByRole('dialog');
    act((): void => usePetStoryStore.setState({ error: 'TEST 该项未确认，原结果保留' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('TEST 该项未确认，原结果保留');
    expect(within(dialog).getByText('镜头 1 · 首帧提示词')).toBeDefined(); expect(adopt).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: /取\s*消/ }));
    await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
    expect(adopt).not.toHaveBeenCalled();
  });
});
