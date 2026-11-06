/** 同版本只读规划同步不覆盖草稿、正文或历史，也不启动生成。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryPlan, PetStoryProject, PetStoryResult } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { registerPetStoryDraft, unregisterPetStoryDraft } from '../../src/utils/petstoryDraftPresence';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = usePetStoryStore.getState();
type PetStoryStoreSnapshot = ReturnType<typeof usePetStoryStore.getState>;
type ReadbackDifference = 'action' | 'firstFrame' | 'nonemptyTail' | 'removeTail' | 'replaceDecision' | 'otherProject' | 'olderRevision';
const read = vi.fn<() => Promise<PetStoryResult>>();
const prepare = vi.fn(); const image = vi.fn(); const video = vi.fn();
let project: PetStoryProject; let normalized: PetStoryProject;
const draftId = 'TEST-auto-readback:plan';
beforeEach((): void => {
  vi.clearAllMocks();
  const plan = structuredClone(snapshot.plan) as PetStoryPlan; plan.shots = plan.shots.slice(0, 1);
  plan.shots[0].requestedMode = 'auto'; delete plan.shots[0].prompts.lastFrame; delete plan.shots[0].autoModePlan;
  project = { schemaVersion: 1, id: 'TEST-auto-readback', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 5,
    source: { kind: 'script', url: '', status: 'review_required' }, plan, jobs: [], assets: [], updatedAt: '2026-11-06T00:00:00.000Z' };
  normalized = structuredClone(project);
  const shot = normalized.plan!.shots[0];
  shot.autoModePlan = { mode: 'first_last_frame', reason: '起止状态存在需要保留的明确变化。', source: 'legacy' };
  shot.prompts.lastFrame = { original: '', optimized: '', final: '', edited: false, rulesVersion: shot.prompts.firstFrame.rulesVersion };
  read.mockImplementation(async (): Promise<PetStoryResult> => ({ success: true, project: structuredClone(normalized), promptTargets: [{ shotId: shot.id, kind: 'lastFrame' }] }));
  window.electronAPI = { petstory: { promptStageTargets: read, prepareRuntime: prepare, beginImageOperation: image, generateShotMedia: video } } as unknown as typeof window.electronAPI;
  usePetStoryStore.setState({ ...initial, project, busy: false, error: '' });
});
afterEach((): void => { unregisterPetStoryDraft(draftId); usePetStoryStore.setState(initial); vi.restoreAllMocks(); });

describe('同版本读取补齐自动模式', (): void => {
  it('只合并判断和必要空尾帧，重复查询保留对象引用且不创建任务', async (): Promise<void> => {
    // 同版本返回的其他项目字段不能作为这次规划补齐的写入口。
    normalized.source.reason = 'TEST 读取端其他内容';
    let updates = 0;
    const stop = usePetStoryStore.subscribe((state: PetStoryStoreSnapshot, previous: PetStoryStoreSnapshot): void => { if (state.project !== previous.project) updates++; });
    try {
      const before = structuredClone(project);
      await usePetStoryStore.getState().inspectPromptStageTargets('shots');
      const current = usePetStoryStore.getState().project!;
      expect(current.plan).toEqual(normalized.plan); expect(current.revision).toBe(before.revision);
      expect(current.source).toEqual(before.source); expect(current.assets).toEqual(before.assets); expect(current.jobs).toEqual(before.jobs);
      expect(current.plan!.shots[0].prompts.firstFrame).toEqual(before.plan!.shots[0].prompts.firstFrame);
      expect(current.plan!.shots[0].prompts.video).toEqual(before.plan!.shots[0].prompts.video);
      await usePetStoryStore.getState().inspectPromptStageTargets('shots');
      expect(usePetStoryStore.getState().project).toBe(current); expect(updates).toBe(1);
      expect(prepare).not.toHaveBeenCalled(); expect(image).not.toHaveBeenCalled(); expect(video).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it('有未保存草稿时保留当前方案，草稿结束后才能同步只读规划', async (): Promise<void> => {
    registerPetStoryDraft(draftId, 'TEST未保存方案');
    await usePetStoryStore.getState().inspectPromptStageTargets('shots');
    expect(usePetStoryStore.getState().project).toBe(project);
    unregisterPetStoryDraft(draftId);
    await usePetStoryStore.getState().inspectPromptStageTargets('shots');
    expect(usePetStoryStore.getState().project!.plan).toEqual(normalized.plan);
    expect(prepare).not.toHaveBeenCalled(); expect(image).not.toHaveBeenCalled(); expect(video).not.toHaveBeenCalled();
  });

  it.each(['action', 'firstFrame', 'nonemptyTail', 'removeTail', 'replaceDecision', 'otherProject', 'olderRevision'] as const)('读取差异%s不是允许的补齐时保留全部当前内容', async (kind: ReadbackDifference): Promise<void> => {
    const shot = normalized.plan!.shots[0];
    if (kind === 'action') shot.action += ' TEST其他动作修改';
    if (kind === 'firstFrame') shot.prompts.firstFrame.final += ' TEST其他正文';
    if (kind === 'nonemptyTail') shot.prompts.lastFrame!.final = 'TEST不是空目标';
    if (kind === 'removeTail') {
      project.plan!.shots[0].prompts.lastFrame = { ...shot.prompts.lastFrame!, final: 'TEST已保存尾帧正文' };
      delete shot.prompts.lastFrame;
    }
    if (kind === 'replaceDecision') project.plan!.shots[0].autoModePlan = { mode: 'first_frame', reason: 'TEST当前已采用判断', source: 'analysis' };
    if (kind === 'otherProject') normalized.id = 'TEST-other-project';
    if (kind === 'olderRevision') normalized.revision--;
    const before = structuredClone(project);
    await usePetStoryStore.getState().inspectPromptStageTargets('shots');
    expect(usePetStoryStore.getState().project).toBe(project); expect(project).toEqual(before);
    expect(prepare).not.toHaveBeenCalled(); expect(image).not.toHaveBeenCalled(); expect(video).not.toHaveBeenCalled();
  });
});
