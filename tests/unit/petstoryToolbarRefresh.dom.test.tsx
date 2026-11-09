/** 离线 DOM 回归：项目和 IPC 均为替身，不启动豆包、真实账号或图片任务。 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryPlan, PetStoryProject, PetStoryResult } from '@doubao-studio/contracts';
import { PetStoryPanel } from '../../src/components/PetStoryPanel';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

// 保留实际父页面和画布工具栏；媒体节点不参与本次只读范围刷新。
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
function targetButton(): HTMLElement {
  return screen.getByRole('button', { name: '补齐提示词（1项）' });
}
function scopeLabel(): HTMLElement {
  return screen.getByText('提示词：镜头 1 · 视频提示词');
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

describe('画布工具栏的提示词范围刷新', (): void => {
  it('图片轮询的同版本新对象不重复查询，保留同一按钮和说明节点', async (): Promise<void> => {
    await openCanvas(); const button = targetButton(); const label = scopeLabel();
    for (let round = 0; round < 3; round++) {
      await act(async (): Promise<void> => { usePetStoryStore.setState({ project: structuredClone(project) }); });
      expect(targetButton()).toBe(button); expect(scopeLabel()).toBe(label);
    }
    expect(inspect).toHaveBeenCalledTimes(1); expect(pending).toHaveLength(0);
  });

  it('新版查询等待及失败期间保留已知范围，成功的空结果才移除入口', async (): Promise<void> => {
    await openCanvas(); const button = targetButton(); const label = scopeLabel();
    const next = structuredClone(project); next.revision++;
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: next }); });
    expect(inspect).toHaveBeenCalledTimes(2); expect(pending[0].revision).toBe(next.revision);
    expect(targetButton()).toBe(button); expect(scopeLabel()).toBe(label);
    await resolveInspection({ success: false, error: 'TEST 瞬时读取失败' });
    expect(targetButton()).toBe(button); expect(scopeLabel()).toBe(label);
    const latest = structuredClone(next); latest.revision++;
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: latest }); });
    expect(targetButton()).toBe(button); expect(scopeLabel()).toBe(label);
    await resolveInspection({ success: true, promptTargets: [] });
    expect(screen.queryByRole('button', { name: '补齐提示词（1项）' })).toBeNull();
    expect(screen.queryByText('提示词：镜头 1 · 视频提示词')).toBeNull();
  });

  it('较旧版本的迟到查询不覆盖当前范围，也不让刷新中的按钮闪动', async (): Promise<void> => {
    await openCanvas(); const button = targetButton();
    const next = structuredClone(project); next.revision++;
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: next }); });
    const latest = structuredClone(next); latest.revision++;
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: latest }); });
    expect(targetButton()).toBe(button);
    await resolveInspection({ success: true, promptTargets: [] });
    expect(targetButton()).toBe(button);
    await resolveInspection({ success: true, promptTargets: promptTargets(latest) });
    expect(targetButton()).toBe(button); expect(inspect).toHaveBeenCalledTimes(3);
  });

  it('切换项目清空旧范围，旧项目迟到查询不能串到新项目', async (): Promise<void> => {
    await openCanvas();
    const old = structuredClone(project); old.revision++;
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: old }); });
    const next = structuredClone(project); next.id = 'TEST-toolbar-B';
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: next }); });
    showCanvas();
    expect(screen.queryByRole('button', { name: '补齐提示词（1项）' })).toBeNull();
    await resolveInspection({ success: true, promptTargets: promptTargets(project) });
    expect(screen.queryByRole('button', { name: '补齐提示词（1项）' })).toBeNull();
    await resolveInspection({ success: true, promptTargets: [] });
    expect(screen.queryByRole('button', { name: '补齐提示词（1项）' })).toBeNull();
    expect(inspect.mock.calls.map((call: [string, number]): string => call[0])).toEqual([project.id, project.id, next.id]);
  });

  it('移除方案使待返回的旧查询失效，恢复方案前不显示旧范围', async (): Promise<void> => {
    await openCanvas();
    const next = structuredClone(project); next.revision++;
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: next }); });
    const withoutPlan = structuredClone(next); delete withoutPlan.plan;
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: withoutPlan }); });
    expect(screen.queryByRole('button', { name: '补齐提示词（1项）' })).toBeNull();
    await resolveInspection({ success: true, promptTargets: promptTargets(project) });
    expect(screen.queryByRole('button', { name: '补齐提示词（1项）' })).toBeNull();
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: next }); });
    expect(screen.queryByRole('button', { name: '补齐提示词（1项）' })).toBeNull();
    await resolveInspection({ success: true, promptTargets: promptTargets(project) });
    expect(targetButton()).toBeDefined(); expect(inspect).toHaveBeenCalledTimes(3);
  });
});
