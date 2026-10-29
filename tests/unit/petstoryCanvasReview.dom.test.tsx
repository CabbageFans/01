/** 离线正常控件回归；平台与本地文件读取为明确替身，不计真实 Electron 验收。 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryAsset, PetStoryPlan, PetStoryProject, Task } from '@doubao-studio/contracts';
import { CanvasPromptEditor } from '../../src/components/PetStoryCanvasPrompt';
import { PetStoryResults } from '../../src/components/PetStoryResults';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-10-29T00:00:00.000Z';
let project: PetStoryProject;
const dirtyChanged = (): void => undefined;
beforeEach((): void => {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  plan.shots = plan.shots.slice(0, 1);
  const prompt = plan.shots[0].prompts.firstFrame;
  prompt.final = 'TEST 已采用首帧正文'; prompt.optimized = 'TEST 新的完整候选'; prompt.edited = false;
  prompt.candidateJobId = 'TEST-candidate';
  project = { schemaVersion: 1, id: 'TEST-canvas-review', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, updatedAt: now, source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now }, assets: [], plan, jobs: [{ id: 'TEST-candidate', kind: 'optimize', taskId: 'TEST-chat', shotId: plan.shots[0].id, promptKind: 'firstFrame', status: 'applied', resultStatus: 'candidate', requestId: 'TEST-request', inputHash: 'TEST', sourceUrl: '', parsedResult: { optimized: prompt.optimized } }] };
  usePetStoryStore.setState({ ...initial.pet, project, busy: false, freeChatConfirmed: true, error: '' });
  useTaskStore.setState({ ...initial.tasks, tasks: [] });
});
afterEach((): void => { usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });

describe('画布候选与低频操作收敛', (): void => {
  it('长候选与诊断默认收起，打开候选后才可明确采用，浏览不修改正文', (): void => {
    const adopt = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ adoptPromptCandidate: adopt });
    const { container } = render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    const candidate = container.querySelector<HTMLDetailsElement>('.canvas-candidate')!;
    expect(candidate.open).toBe(false);
    expect(container.querySelector<HTMLDetailsElement>('.canvas-provenance')!.open).toBe(false);
    expect(screen.queryByRole('button', { name: '保存修改' })).toBeNull();
    expect(adopt).not.toHaveBeenCalled();
    fireEvent.click(within(candidate).getByText('新提示词待确认 · 查看完整候选'));
    expect(candidate.open).toBe(true);
    expect(project.plan!.shots[0].prompts.firstFrame.final).toBe('TEST 已采用首帧正文');
    fireEvent.click(within(candidate).getByRole('button', { name: '采用这条回复' }));
    expect(adopt).toHaveBeenCalledExactlyOnceWith('TEST-candidate');
  });

  it('已采用正文不再显示候选采用按钮，修改后出现唯一保存动作', (): void => {
    const prompt = project.plan!.shots[0].prompts.firstFrame;
    prompt.optimized = prompt.final;
    const save = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ saveShotPrompt: save });
    const { container } = render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    fireEvent.click(within(container.querySelector('.canvas-candidate')!).getByText('查看已采用的豆包回复'));
    expect(screen.queryByRole('button', { name: '采用这条回复' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '镜头1首帧生图提示词最终正文' }), { target: { value: 'TEST 用户明确修改' } });
    expect(screen.getAllByRole('button', { name: '保存修改' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(save).toHaveBeenCalledExactlyOnceWith(project.plan!.shots[0].id, 'firstFrame', 'TEST 用户明确修改');
  });
});

function frame(state: 'candidate' | 'adopted'): PetStoryAsset {
  return { id: 'TEST-image', kind: 'firstFrame', shotId: project.plan!.shots[0].id, relativePath: 'TEST/image.png', imageReview: { state, target: { shotId: project.plan!.shots[0].id, kind: 'firstFrame' }, basisHash: 'TEST' }, validation: { decoded: true, sha256: 'TEST', bytes: 1, width: 64, height: 64, checkedAt: now } };
}

describe('成果按实际采用、任务与文件分别交接', (): void => {
  it('已保存候选没有正式文件时，入口回到当前镜头采用，浏览不推断已采用', (): void => {
    project.assets.push(frame('candidate'));
    const navigate = vi.fn();
    render(<PetStoryResults project={project} onNavigate={navigate} />);
    const first = screen.getByRole('region', { name: '本镜首帧' });
    expect(within(first).getByText('候选已保存，尚未采用')).toBeDefined();
    expect(within(first).queryByText('文件校验通过')).toBeNull();
    fireEvent.click(within(first).getByRole('button', { name: '查看并采用' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('keyframes', project.plan!.shots[0].id, 'firstFrame');
    expect(project.adoptedImages).toBeUndefined();
  });

  it('已有平台产物而未保存本地文件时，提供下载收取入口且不暗示重新生成', (): void => {
    const task: Task = { id: 'TEST-video', mode: 'video', status: 'done', assignedAccountId: project.accountId, prompt: 'TEST', outputs: ['https://TEST.invalid/output.mp4'], result: null, createdAt: now, updatedAt: now, runtime: { runId: 'TEST-run', attempt: 1, stage: 'completed', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { prompt: 'TEST', mode: 'video', attachments: [] } } };
    const capability = { accountId: project.accountId, checkedAt: now, image: { state: 'unknown' as const, free: 'unknown' as const, reason: '' }, modes: { first_frame: { state: 'unknown' as const, free: 'unknown' as const, reason: '' }, first_last_frame: { state: 'unknown' as const, free: 'unknown' as const, reason: '' }, reference: { state: 'unknown' as const, free: 'unknown' as const, reason: '' } }, durations: [], freeEvidence: 'unknown' as const };
    project.production = { state: 'paused', planHash: 'TEST', approvedAt: now, capability, fallbacks: {}, shots: {}, steps: [{ id: 'TEST-step', kind: 'video', shotId: project.plan!.shots[0].id, taskId: task.id, runId: 'TEST-run', inputHash: 'TEST', attachmentAssetIds: [], status: 'bound' }], message: 'TEST' };
    useTaskStore.setState({ tasks: [task] });
    const navigate = vi.fn(); render(<PetStoryResults project={project} onNavigate={navigate} />);
    const video = screen.getByRole('region', { name: '本镜视频' });
    expect(within(video).getByText('平台产物已读取')).toBeDefined();
    expect(within(video).getByText('尚无项目内文件')).toBeDefined();
    expect(within(video).queryByRole('button', { name: '去制作本镜视频' })).toBeNull();
    fireEvent.click(within(video).getByRole('button', { name: '查看下载与收取' }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('videos', project.plan!.shots[0].id, 'video');
  });

  it('替换参考后的旧采用图仍可查看，优先说明实际复核原因', (): void => {
    const asset = frame('adopted'); asset.needsReview = true;
    project.assets.push(asset); project.adoptedImages = { [project.plan!.shots[0].id]: { firstFrameId: asset.id } };
    render(<PetStoryResults project={project} onNavigate={(): void => undefined} />);
    const first = screen.getByRole('region', { name: '本镜首帧' });
    expect(within(first).getByText('制作依据已更新，请复核这项成果；原文件已保留。')).toBeDefined();
    expect(within(first).queryByText('旧产物未记录对应提示词，不能确认与当前版本一致。')).toBeNull();
    expect(within(first).getByRole('button', { name: '查看图片' })).toBeDefined();
    expect(project.assets).toHaveLength(1);
  });

  it('同一任务的后续运行不能冒充旧采用图的生成事实', (): void => {
    const asset = frame('adopted'); asset.taskId = 'TEST-reused-task'; asset.runId = 'TEST-old-run';
    project.assets.push(asset); project.adoptedImages = { [project.plan!.shots[0].id]: { firstFrameId: asset.id } };
    useTaskStore.setState({ tasks: [{ id: asset.taskId, assignedAccountId: project.accountId, mode: 'image', status: 'done', prompt: 'TEST 后续运行', outputs: ['https://TEST.invalid/new.png'], result: null, createdAt: now, updatedAt: now, runtime: { runId: 'TEST-new-run', attempt: 2, stage: 'completed', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { prompt: 'TEST 后续运行', mode: 'image', attachments: [] } } }] });
    render(<PetStoryResults project={project} onNavigate={(): void => undefined} />);
    const first = screen.getByRole('region', { name: '本镜首帧' });
    expect(within(first).getByText('已保存豆包产物')).toBeDefined();
    expect(within(first).queryByText('平台产物已读取')).toBeNull();
  });
});
