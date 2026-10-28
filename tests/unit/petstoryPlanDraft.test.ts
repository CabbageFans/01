import { describe, expect, it } from 'vitest';
import type { PetStoryPlan, PetStoryShot } from '@doubao-studio/contracts';
import { mergePetStoryPlanDraft } from '../../src/utils/petstoryPlanDraft';
import snapshot from '../fixtures/storyboard-five-shots.json';

function plan(): PetStoryPlan { return structuredClone(snapshot.plan) as PetStoryPlan; }
function newShot(base: PetStoryPlan): PetStoryShot {
  return { ...structuredClone(base.shots[0]), id: 'TEST-new-shot', order: base.shots.length + 1 };
}

describe('高级方案草稿只合并真实修改并保护并发结果', (): void => {
  it('原本为空的对白同时收到不同新增时拒绝覆盖，双方台词均保留原样', (): void => {
    const base = plan(); base.shots[0].dialogue = [];
    const draft = structuredClone(base); const latest = structuredClone(base);
    draft.shots[0].dialogue!.push({ speakerId: base.characters[0].id, text: 'TEST 本地新增台词', tone: 'TEST', pace: 'TEST' });
    latest.shots[0].dialogue!.push({ speakerId: base.characters[1].id, text: 'TEST 并发新增台词', tone: 'TEST', pace: 'TEST' });
    const before = structuredClone({ base, draft, latest });
    expect((): PetStoryPlan => mergePetStoryPlanDraft(base, draft, latest)).toThrow(/已有新保存内容/);
    expect({ base, draft, latest }).toEqual(before);
  });
  it('原本为空的对白仅本地添加时仍可保存，并保留并发提示词', (): void => {
    const base = plan(); base.shots[0].dialogue = [];
    const draft = structuredClone(base); const latest = structuredClone(base);
    draft.shots[0].dialogue!.push({ speakerId: base.characters[0].id, text: 'TEST 本地新增台词', tone: 'TEST', pace: 'TEST' });
    latest.shots[0].prompts.video.final = 'TEST 并发新正文';
    const result = mergePetStoryPlanDraft(base, draft, latest);
    expect(result.shots[0].dialogue).toEqual(draft.shots[0].dialogue); expect(result.shots[0].prompts.video.final).toBe('TEST 并发新正文');
  });
  it('仅改镜头动作时保留后来收到的正文、候选、来源及其他镜头修改', (): void => {
    const base = plan(); const draft = structuredClone(base); const latest = structuredClone(base);
    draft.shots[0].action += ' TEST 用户修改';
    latest.shots[0].prompts.firstFrame = { ...latest.shots[0].prompts.firstFrame, final: 'TEST 后来采用正文', optimized: 'TEST 后来候选', sourceJobId: 'TEST-source', candidateJobId: 'TEST-candidate' };
    latest.shots[1].action += ' TEST 另一位置新保存';
    const snapshots = structuredClone({ base, draft, latest });
    const result = mergePetStoryPlanDraft(base, draft, latest);
    expect(result.shots[0].action).toBe(draft.shots[0].action);
    expect(result.shots[0].prompts).toEqual(latest.shots[0].prompts);
    expect(result.shots[1]).toEqual(latest.shots[1]);
    expect({ base, draft, latest }).toEqual(snapshots);
  });
  it('同一字段双方内容不同拒绝保存，原草稿和最新成果保持原样', (): void => {
    const base = plan(); const draft = structuredClone(base); const latest = structuredClone(base);
    draft.shots[0].action += ' TEST 草稿'; latest.shots[0].action += ' TEST 新结果';
    const before = structuredClone({ base, draft, latest });
    expect((): PetStoryPlan => mergePetStoryPlanDraft(base, draft, latest)).toThrow(/已有新保存内容/);
    expect({ base, draft, latest }).toEqual(before);
  });
  it('同一字段已被保存成与草稿相同内容时允许复用，不产生假冲突', (): void => {
    const base = plan(); const draft = structuredClone(base); draft.shots[0].action += ' TEST 同一修改';
    const latest = structuredClone(draft); latest.shots[1].prompts.video.final += ' TEST 新回填';
    expect(mergePetStoryPlanDraft(base, draft, latest)).toEqual(latest);
  });
  it('用户重排镜头和order字段后按ID保留各镜头最新提示词', (): void => {
    const base = plan(); const draft = structuredClone(base); const latest = structuredClone(base);
    draft.shots = [...draft.shots].reverse().map((shot, index): PetStoryShot => ({ ...shot, order: index + 1 }));
    latest.shots[0].prompts.video.final = 'TEST 第一个镜头新正文'; latest.shots[2].prompts.firstFrame.optimized = 'TEST 第三个镜头新候选';
    const result = mergePetStoryPlanDraft(base, draft, latest);
    expect(result.shots.map((shot): string => shot.id)).toEqual(draft.shots.map((shot): string => shot.id));
    expect(result.shots.map((shot): number => shot.order)).toEqual(draft.shots.map((shot): number => shot.order));
    for (const shot of result.shots) expect(shot.prompts).toEqual(latest.shots.find((item): boolean => item.id === shot.id)?.prompts);
  });
  it('用户新增镜头保留该新对象，同时保留既有镜头的并发回填', (): void => {
    const base = plan(); const draft = structuredClone(base); const latest = structuredClone(base); const added = newShot(base); draft.shots.push(added);
    latest.shots[0].prompts.firstFrame.optimized += ' TEST 新候选';
    const result = mergePetStoryPlanDraft(base, draft, latest);
    expect(result.shots.at(-1)).toEqual(added); expect(result.shots[0].prompts).toEqual(latest.shots[0].prompts);
  });
  it('删除未变化镜头可保存，并保留其他镜头的新提示词', (): void => {
    const base = plan(); const draft = structuredClone(base); const latest = structuredClone(base); const removed = draft.shots.pop()!;
    latest.shots[0].prompts.video.optimized += ' TEST 新候选';
    const result = mergePetStoryPlanDraft(base, draft, latest);
    expect(result.shots.some((shot): boolean => shot.id === removed.id)).toBe(false); expect(result.shots[0].prompts).toEqual(latest.shots[0].prompts);
  });
  it('将被删除镜头期间收到新正文时拒绝删除，不吞掉并发成果', (): void => {
    const base = plan(); const draft = structuredClone(base); const latest = structuredClone(base); draft.shots.pop();
    latest.shots.at(-1)!.prompts.firstFrame.optimized += ' TEST 稍后回复';
    expect((): PetStoryPlan => mergePetStoryPlanDraft(base, draft, latest)).toThrow(/不能直接删除/);
    expect(latest.shots).toHaveLength(base.shots.length);
  });
  it('latest镜头清单已被别处增删时，过期的本地镜头清单修改拒绝保存', (): void => {
    const base = plan(); const draft = structuredClone(base); const latest = structuredClone(base); draft.shots[0].action += ' TEST 草稿'; latest.shots.push(newShot(base));
    expect((): PetStoryPlan => mergePetStoryPlanDraft(base, draft, latest)).toThrow(/已被其他结果更新/);
  });
  it('latest只重排镜头而用户只改故事时，沿用最新镜头顺序', (): void => {
    const base = plan(); const draft = structuredClone(base); const latest = structuredClone(base); draft.adaptedStory += ' TEST 编辑'; latest.shots.reverse();
    const result = mergePetStoryPlanDraft(base, draft, latest);
    expect(result.adaptedStory).toBe(draft.adaptedStory); expect(result.shots).toEqual(latest.shots);
  });
  it('可选字段删除准确移除键，删除时存在并发新值则报冲突', (): void => {
    const base = plan(); base.understanding = 'TEST 已存理解'; const draft = structuredClone(base); const latest = structuredClone(base); delete draft.understanding;
    expect(Object.hasOwn(mergePetStoryPlanDraft(base, draft, latest), 'understanding')).toBe(false);
    latest.understanding += ' TEST 新理解';
    expect((): PetStoryPlan => mergePetStoryPlanDraft(base, draft, latest)).toThrow(/已有新保存内容/);
  });
});
