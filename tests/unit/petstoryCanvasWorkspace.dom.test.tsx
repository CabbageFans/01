/** 离线可见按钮接线；不替代真实 Electron 或豆包验收。 */
import React from 'react';
import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryChatJob, PetStoryPlan, PetStoryProject } from '@doubao-studio/contracts';
import { PetStoryCanvas } from '../../src/components/PetStoryCanvas';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

vi.mock('../../src/components/PetStoryCanvasMedia', (): object => ({
  CanvasMediaNode: (): React.ReactElement => <div>TEST 保留媒体节点</div>,
  CanvasReferenceStrip: (): React.ReactElement => <div>TEST 保留素材引用</div>,
}));
const initial = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
let project: PetStoryProject;
const dirtyChanged = (): void => undefined;
beforeEach((): void => {
  localStorage.removeItem('petstory-canvas:TEST-workspace');
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  project = { schemaVersion: 1, id: 'TEST-workspace', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, updatedAt: '2026-10-31T00:00:00.000Z', source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-story', text: snapshot.mobileStory, importedAt: '2026-10-31T00:00:00.000Z' }, plan, assets: [], jobs: [] };
  usePetStoryStore.setState({ ...initial.pet, project, projectName: 'TEST 项目', busy: false, error: '', promptBatch: { total: 0, completed: 0, status: 'idle' } });
  useTaskStore.setState({ ...initial.tasks, tasks: [] });
});
afterEach((): void => { usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });
function canvas(): React.ReactElement { return <PetStoryCanvas project={project} legacyDirty={false} onDirtyChange={dirtyChanged} materials={null} controls={null} />; }

describe('直接进入分镜画布', (): void => {
  it('移除整条顶部工具栏，保留故事、四列节点与全文浏览，不在打开时补齐或采用', (): void => {
    project.plan!.shots[0].prompts.video.final = '';
    const generate = vi.fn(async (): Promise<void> => undefined);
    const adopt = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ generateCanvasPrompts: generate, adoptPromptBatchCandidates: adopt, promptBatch: { total: 18, completed: 17, status: 'paused' }, error: 'TEST 原结果待检查' });
    const { container } = render(canvas());
    expect(container.querySelector('.canvas-toolbar')).toBeNull();
    expect(screen.queryByRole('button', { name: /补齐提示词|生成镜头提示词|确认本次结果|缩小画布|放大画布|定位镜头/ })).toBeNull();
    expect(container.querySelector('.canvas-story-column')).not.toBeNull();
    expect(container.querySelector('.canvas-shot-row')?.children).toHaveLength(4);
    expect(screen.getAllByText('TEST 保留媒体节点')).toHaveLength(project.plan!.shots.reduce((count, shot): number => count + (shot.prompts.lastFrame ? 3 : 2), 0));
    fireEvent.click(screen.getByRole('button', { name: '放大镜头1首帧生图提示词' }));
    expect(screen.getByRole('dialog', { name: '镜头 1 · 首帧生图提示词' })).toBeDefined();
    expect(generate).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().error).toBe('TEST 原结果待检查');
  });

  it('空白处滚轮仍可平移和缩放，镜头编号与卡片聚焦同步当前镜头', (): void => {
    const { container } = render(canvas());
    const viewport = container.querySelector<HTMLElement>('.canvas-viewport')!;
    const content = container.querySelector<HTMLElement>('.canvas-content')!;
    const original = content.style.transform;
    fireEvent.wheel(viewport, { deltaX: 60, deltaY: 120 });
    expect(content.style.transform).not.toBe(original);
    expect(content.style.transform).toContain('translate(-60px, -120px)');
    // happy-dom 的 WheelEvent 不保留 ctrlKey；补齐真实浏览器的修饰键事实。
    const zoomEvent = createEvent.wheel(viewport, { deltaY: -100, clientX: 100, clientY: 100 });
    Object.defineProperty(zoomEvent, 'ctrlKey', { value: true });
    fireEvent(viewport, zoomEvent);
    expect(content.style.transform).toContain('scale(1.1)');
    const navigation = container.querySelector<HTMLElement>('.canvas-navigation')!;
    fireEvent.click(within(navigation).getByRole('button', { name: '02' }));
    expect(container.querySelector('.canvas-shot-row.is-focused')?.getAttribute('data-shot-id')).toBe(project.plan!.shots[1].id);
    expect(within(navigation).getByRole('button', { name: '02' }).classList.contains('active')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '聚焦镜头1' }));
    expect(within(navigation).getByRole('button', { name: '01' }).classList.contains('active')).toBe(true);
  });

  it('旧批次候选继续在对应节点逐项确认，不自动采用其他镜头或替换手改正文', (): void => {
    const [first, second] = project.plan!.shots;
    const candidate = (id: string, shotId: string, body: string): PetStoryChatJob => ({ id, taskId: `TEST-task-${id}`, kind: 'optimize', shotId, promptKind: 'firstFrame', inputHash: 'TEST', sourceUrl: '', status: 'applied', resultStatus: 'candidate', parsedResult: { optimized: body } });
    project.jobs = [candidate('TEST-first-candidate', first.id, 'TEST 第一镜新候选'), candidate('TEST-second-candidate', second.id, 'TEST 第二镜新候选')];
    for (const [index, shot] of [first, second].entries()) {
      const job = project.jobs[index]; shot.prompts.firstFrame.edited = false; shot.prompts.firstFrame.candidateJobId = job.id; shot.prompts.firstFrame.optimized = job.parsedResult!.optimized!;
    }
    project.promptBatch = { id: 'TEST-batch', scope: 'shots', targets: [], candidateJobIds: project.jobs.map((job): string => job.id), total: 2, completed: 2, status: 'complete' };
    const originals = [first.prompts.firstFrame.final, second.prompts.firstFrame.final];
    const adopt = vi.fn(async (): Promise<void> => undefined);
    const adoptBatch = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ adoptPromptCandidate: adopt, adoptPromptBatchCandidates: adoptBatch });
    const { container } = render(canvas());
    const node = container.querySelector<HTMLElement>(`#prompt-${first.id}-firstFrame`)!;
    expect(within(node).getByText('TEST 第一镜新候选')).toBeDefined();
    fireEvent.click(within(node).getByRole('button', { name: '确认使用' }));
    expect(adopt).toHaveBeenCalledExactlyOnceWith('TEST-first-candidate'); expect(adoptBatch).not.toHaveBeenCalled();
    expect([first.prompts.firstFrame.final, second.prompts.firstFrame.final]).toEqual(originals);
    act((): void => usePetStoryStore.setState({ busy: true }));
    expect(screen.getByRole('button', { name: '放大镜头1首帧生图提示词' }).hasAttribute('disabled')).toBe(false);
  });
});
