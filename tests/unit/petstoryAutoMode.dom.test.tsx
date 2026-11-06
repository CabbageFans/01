/** 离线核对剧情模式的可见目标与原任务事实，不提交或生成媒体。 */
import React from 'react';
import { act, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryPlan, PetStoryProduction, PetStoryProject, PetStoryPrompt, Task } from '@doubao-studio/contracts';
import { PetStoryCanvas } from '../../src/components/PetStoryCanvas';
import { CanvasMediaNode } from '../../src/components/PetStoryCanvasMedia';
import { PetStoryPlanPreview } from '../../src/components/PetStoryPlanPreview';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { selectPetStoryJourney } from '../../src/utils/petstoryJourney';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-11-06T00:00:00.000Z';
let project: PetStoryProject;
const noDirtyChange = (): void => undefined;
function emptyPrompt(): PetStoryPrompt { return { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST' }; }
function production(): PetStoryProduction {
  const entry = { state: 'unknown' as const, reason: 'TEST 未检查网页入口' };
  const shot = project.plan!.shots[0];
  return { state: 'complete', phase: 'shots', planHash: 'TEST-history', approvedAt: now, fallbacks: {}, steps: [], message: 'TEST 保留历史',
    capability: { accountId: project.accountId, image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [] },
    shots: { [shot.id]: { requestedMode: 'auto', resolvedMode: 'reference', reason: 'TEST 仅图片历史' } } };
}
function originalVideo(accepted: boolean): Task {
  const runId = 'TEST-original-run';
  return { id: 'TEST-original-video', projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'video',
    status: accepted ? 'done' : 'paused', prompt: 'TEST 原任务正文', outputs: [], result: null, createdAt: now, updatedAt: now,
    petstory: { projectId: project.id, stepId: 'TEST-original-step' },
    runtime: { runId, attempt: 1, stage: accepted ? 'completed' : 'paused', message: 'TEST 保留原运行', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { mode: 'video', prompt: 'TEST 原任务正文', attachments: [] },
      ...(accepted ? { submittedAt: now, acceptanceObservation: { schemaVersion: 1 as const, accountId: project.accountId, runId,
        conversationUrl: 'https://www.doubao.com/chat/TEST-original', acceptedAt: now, evidence: { kind: 'prompt_published' as const },
        cursor: { messageCount: 1, pollCount: 0 }, expectedArtifact: { kind: 'video' as const, runId },
        lease: { ownerId: 'TEST-observer', acquiredAt: now, expiresAt: now, lastHeartbeatAt: now }, outcome: 'completed' as const } } : {}) } };
}
beforeEach((): void => {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan; plan.shots = plan.shots.slice(0, 1);
  const shot = plan.shots[0]; shot.requestedMode = 'auto'; shot.prompts = { firstFrame: emptyPrompt(), lastFrame: emptyPrompt(), video: emptyPrompt() };
  shot.startState = '两人分别握着礼盒的两端'; shot.endState = '接收者独自抱稳礼盒，交付者松手';
  shot.autoModePlan = { mode: 'first_last_frame', reason: '礼盒从共同持有变为接收者独自抱稳，需要固定交接终态。' };
  project = { schemaVersion: 1, id: 'TEST-auto-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, updatedAt: now,
    source: { kind: 'script', url: '', status: 'review_required' }, plan, assets: [], jobs: [] };
  const inspectGeneration = vi.fn(async (): Promise<{ success: true; eligibility: { ready: false; blockers: []; resolvedMode: 'reference'; modeReason: string } }> => ({ success: true, eligibility: { ready: false, blockers: [], resolvedMode: 'reference', modeReason: 'TEST 旧预检查' } }));
  window.electronAPI = { petstory: { inspectGeneration } } as unknown as typeof window.electronAPI;
  usePetStoryStore.setState({ ...initial.pet, project, busy: false, error: '', capability: null, fallbacks: {}, promptBatch: { total: 0, completed: 0, status: 'idle' },
    generateCanvasPrompts: vi.fn(), generateShotMedia: vi.fn(), resumeProduction: vi.fn(), resumeUnsubmittedVideo: vi.fn() });
  useTaskStore.setState({ ...initial.tasks, tasks: [], executingTasks: {}, activeTaskId: null, accountAutomationState: {} });
});
afterEach((): void => { usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });

describe('自动模式按剧情计划显示，不启动生成', (): void => {
  it('重要终态显示尾帧节点与进度，图片历史及旧预检不能盖掉当前计划', async (): Promise<void> => {
    project.productionHistory = [production()]; const before = structuredClone(project);
    const { container } = render(<PetStoryCanvas project={project} legacyDirty={false} onDirtyChange={noDirtyChange} materials={null} controls={null} />);
    await act(async (): Promise<void> => undefined);
    expect(container.querySelector('[data-media-kind="lastFrame"]')).not.toBeNull();
    const mode = container.querySelector('.canvas-mode')!;
    expect(mode.textContent).toContain('计划模式 首尾帧'); expect(mode.textContent).toContain('执行模式 尚未执行');
    expect(mode.textContent).toContain(project.plan!.shots[0].autoModePlan!.reason);
    const progress = selectPetStoryJourney(project);
    expect(progress.shots[0].requiresLastFrame).toBe(true); expect(progress.shots[0].missing).toContain('缺尾帧'); expect(progress.counts.keyframes.total).toBe(2);
    expect(project).toEqual(before); expect(usePetStoryStore.getState().generateShotMedia).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().generateCanvasPrompts).not.toHaveBeenCalled(); expect(useTaskStore.getState().tasks).toEqual([]);
  });

  it('持续镜头采用首帧计划，预览说明原因且不出现尾帧任务目标', async (): Promise<void> => {
    const shot = project.plan!.shots[0]; delete shot.prompts.lastFrame;
    shot.autoModePlan = { mode: 'first_frame', reason: '人物持续沿路行走，没有必须锁定的交接或终止画面。' };
    const { container } = render(<><PetStoryCanvas project={project} legacyDirty={false} onDirtyChange={noDirtyChange} materials={null} controls={null} /><PetStoryPlanPreview plan={project.plan!} /></>);
    await act(async (): Promise<void> => undefined);
    expect(container.querySelector('[data-media-kind="lastFrame"]')).toBeNull();
    expect(selectPetStoryJourney(project).counts.keyframes.total).toBe(1); expect(selectPetStoryJourney(project).shots[0].requiresLastFrame).toBe(false);
    const preview = within(container.querySelector('.petstory-plan-preview') as HTMLElement);
    expect(preview.getByText('自动选择 · 首帧')).toBeDefined(); expect(preview.getByText(shot.autoModePlan.reason)).toBeDefined();
    expect(usePetStoryStore.getState().generateShotMedia).not.toHaveBeenCalled();
  });

  it('旧项目缺少模式判断时保留现有尾帧目标，不受图片历史模式影响', (): void => {
    delete project.plan!.shots[0].autoModePlan; project.productionHistory = [production()];
    const before = structuredClone(project);
    expect(selectPetStoryJourney(project).shots[0].requiresLastFrame).toBe(true);
    expect(selectPetStoryJourney(project).counts.keyframes.total).toBe(2); expect(project).toEqual(before);
  });

  it.each([true, false])('已有视频原任务（已受理=%s）仍展示原模式，不冒充改为新剧情计划', async (accepted: boolean): Promise<void> => {
    const task = originalVideo(accepted); const original = production(); const shot = project.plan!.shots[0];
    original.state = accepted ? 'complete' : 'paused'; original.shots[shot.id].resolvedMode = accepted ? 'reference' : 'first_frame';
    original.steps = [{ id: 'TEST-original-step', shotId: shot.id, kind: 'video', taskId: task.id, runId: task.runtime!.runId,
      status: accepted ? 'complete' : 'bound', inputHash: 'TEST-input', attachmentAssetIds: [] }];
    project.production = original; useTaskStore.setState({ tasks: [task] });
    const before = structuredClone(project); const beforeTask = structuredClone(task);
    const { container } = render(<CanvasMediaNode project={project} shot={shot} kind="video" disabled />);
    await act(async (): Promise<void> => undefined);
    const mode = container.querySelector('.canvas-mode')!;
    expect(mode.textContent).toContain('计划模式 首尾帧');
    expect(mode.textContent).toContain(accepted ? '执行模式 多参考 · 历史记录，页面绑定未留存' : '执行模式 计划 首帧 · 待实际受理');
    expect(project).toEqual(before); expect(task).toEqual(beforeTask);
    expect(usePetStoryStore.getState().generateShotMedia).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().resumeProduction).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().resumeUnsubmittedVideo).not.toHaveBeenCalled();
  });
});
