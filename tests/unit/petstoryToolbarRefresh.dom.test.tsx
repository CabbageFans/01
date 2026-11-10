/** 离线 DOM 回归：项目和 IPC 均为替身，不启动豆包、真实账号或图片任务。 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryPlan, PetStoryProject, PetStoryResult } from '@doubao-studio/contracts';
import { PetStoryPanel } from '../../src/components/PetStoryPanel';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

// 保留实际父页面和提示词节点；媒体节点不参与本次只读资格刷新。
vi.mock('../../src/components/PetStoryCanvasMedia', (): object => ({
  CanvasMediaNode: (): React.ReactElement => <div />,
  CanvasReferenceStrip: (): React.ReactElement => <div />,
}));

const originals = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-11-08T00:00:00.000Z';
interface PendingInspection { id: string; revision: number; resolve: (result: PetStoryResult) => void }
let project: PetStoryProject;
let pending: PendingInspection[];
let inspect: ReturnType<typeof vi.fn<(id: string, revision: number) => Promise<PetStoryResult>>>;

function promptTargets(p: PetStoryProject): NonNullable<PetStoryResult['promptTargets']> {
  return [{ shotId: p.plan!.shots[0].id, kind: 'video' }];
}
async function resolveInspection(result: PetStoryResult): Promise<void> {
  const request = pending.shift();
  if (!request) throw new Error('TEST 缺少待返回的只读查询');
  await act(async (): Promise<void> => { request.resolve(result); });
}
function showCanvas(): void {
  fireEvent.click(within(screen.getByRole('navigation', { name: '短剧制作阶段' })).getByRole('button', { name: /制作关键帧/ }));
}
async function openCanvas(): Promise<void> {
  render(<PetStoryPanel />); showCanvas();
  await resolveInspection({ success: true, promptTargets: promptTargets(project) });
}
function savedPrompt(): HTMLElement {
  return screen.getByLabelText('镜头 1 · 首帧生图提示词当前正文');
}

beforeEach((): void => {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  plan.characters = []; plan.props = []; plan.scenes = []; plan.shots = plan.shots.slice(0, 1);
  plan.shots[0].characterIds = []; plan.shots[0].propIds = [];
  plan.shots[0].prompts.firstFrame.final = 'TEST 已保存首帧正文';
  plan.shots[0].prompts.video.final = '';
  delete plan.shots[0].prompts.lastFrame;
  project = { schemaVersion: 1, id: 'TEST-toolbar-A', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 10,
    updatedAt: now, source: { kind: 'script', url: '', status: 'review_required' },
    mobileStory: { id: 'TEST-story', text: 'TEST 剧本', importedAt: now }, storyApproval: { hash: 'TEST', at: now }, plan, assets: [], jobs: [] };
  pending = [];
  inspect = vi.fn((id: string, revision: number): Promise<PetStoryResult> => new Promise((resolve: (result: PetStoryResult) => void): void => { pending.push({ id, revision, resolve }); }));
  window.electronAPI = { petstory: {
    promptStageTargets: inspect,
    inspectGeneration: vi.fn(async (): Promise<object> => ({ success: true, eligibility: { ready: true, blockers: [] } })),
    readReference: vi.fn(async (): Promise<object> => ({ success: false })),
  } } as unknown as typeof window.electronAPI;
  usePetStoryStore.setState({ ...originals.pet, project, projectName: 'TEST 刷新回归', busy: false, error: '', capability: null,
    fallbacks: {}, promptBatch: { status: 'idle', total: 0, completed: 0 } });
  useTaskStore.setState({ ...originals.tasks, tasks: [] });
});
afterEach((): void => { usePetStoryStore.setState(originals.pet); useTaskStore.setState(originals.tasks); vi.restoreAllMocks(); });

describe('移除工具栏后的画布资格刷新', (): void => {
  it('图片轮询的同版本新对象不重复查询，保留同一提示词节点', async (): Promise<void> => {
    await openCanvas(); const prompt = savedPrompt();
    for (let round = 0; round < 3; round++) {
      await act(async (): Promise<void> => { usePetStoryStore.setState({ project: structuredClone(project) }); });
      expect(savedPrompt()).toBe(prompt);
    }
    expect(inspect).toHaveBeenCalledTimes(1); expect(pending).toHaveLength(0);
    expect(document.querySelector('.canvas-toolbar')).toBeNull();
  });

  it('新版查询等待、失败和空目标均保留已有正文，不触发文字生成', async (): Promise<void> => {
    const generate = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ generateCanvasPrompts: generate });
    await openCanvas(); const prompt = savedPrompt();
    const next = structuredClone(project); next.revision++;
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: next }); });
    expect(inspect).toHaveBeenCalledTimes(2); expect(pending[0].revision).toBe(next.revision);
    expect(savedPrompt()).toBe(prompt);
    await resolveInspection({ success: false, error: 'TEST 瞬时读取失败' });
    expect(savedPrompt()).toBe(prompt); expect(prompt.textContent).toBe('TEST 已保存首帧正文');
    const latest = structuredClone(next); latest.revision++;
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: latest }); });
    await resolveInspection({ success: true, promptTargets: [] });
    expect(savedPrompt()).toBe(prompt); expect(prompt.textContent).toBe('TEST 已保存首帧正文');
    expect(generate).not.toHaveBeenCalled(); expect(document.querySelector('.canvas-toolbar')).toBeNull();
  });

  it('较旧版本的迟到查询不覆盖当前镜头正文', async (): Promise<void> => {
    await openCanvas();
    const next = structuredClone(project); next.revision++;
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: next }); });
    const latest = structuredClone(next); latest.revision++; latest.plan!.shots[0].prompts.firstFrame.final = 'TEST 当前新版正文';
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: latest }); });
    await resolveInspection({ success: true, project: next, promptTargets: [] });
    expect(savedPrompt().textContent).toBe('TEST 当前新版正文'); expect(usePetStoryStore.getState().project?.revision).toBe(latest.revision);
    await resolveInspection({ success: true, project: latest, promptTargets: promptTargets(latest) });
    expect(savedPrompt().textContent).toBe('TEST 当前新版正文'); expect(inspect).toHaveBeenCalledTimes(3);
  });

  it('切换项目后旧项目迟到查询不能覆盖新项目正文', async (): Promise<void> => {
    await openCanvas();
    const old = structuredClone(project); old.revision++;
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: old }); });
    const next = structuredClone(project); next.id = 'TEST-toolbar-B'; next.plan!.shots[0].prompts.firstFrame.final = 'TEST 新项目正文';
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: next }); });
    showCanvas();
    expect(savedPrompt().textContent).toBe('TEST 新项目正文');
    await resolveInspection({ success: true, project: old, promptTargets: promptTargets(project) });
    expect(savedPrompt().textContent).toBe('TEST 新项目正文'); expect(usePetStoryStore.getState().project?.id).toBe(next.id);
    await resolveInspection({ success: true, promptTargets: [] });
    expect(savedPrompt().textContent).toBe('TEST 新项目正文');
    expect(inspect.mock.calls.map((call: [string, number]): string => call[0])).toEqual([project.id, project.id, next.id]);
  });

  it('移除方案后旧查询不恢复镜头，重新采用方案后正常刷新', async (): Promise<void> => {
    await openCanvas();
    const next = structuredClone(project); next.revision++;
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: next }); });
    const withoutPlan = structuredClone(next); delete withoutPlan.plan;
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: withoutPlan }); });
    expect(document.querySelector('.canvas-shot-row')).toBeNull();
    await resolveInspection({ success: true, promptTargets: promptTargets(project) });
    expect(document.querySelector('.canvas-shot-row')).toBeNull();
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: next }); });
    await resolveInspection({ success: true, promptTargets: promptTargets(project) });
    expect(savedPrompt().textContent).toBe('TEST 已保存首帧正文'); expect(inspect).toHaveBeenCalledTimes(3);
  });
});
