import { describe, expect, it } from 'vitest';
import type { PetStoryPlan, PetStoryValidationIssue } from '@doubao-studio/contracts';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { planRepairPreservationIssues } from '../../main/utils/petstoryValidationIssues';

function original(): PetStoryPlan {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  plan.shots[0].dialogue = [{ speakerId: plan.characters[0].id, text: 'TEST逐字台词', tone: 'TEST语气', pace: 'TEST语速' }];
  plan.shots[0].predecessorShotIds = [plan.shots[0].id, 'retired'];
  plan.shots[1].transition = 'continue'; plan.shots[1].previousShotId = plan.shots[0].id;
  plan.shots[2].transition = 'continue'; plan.shots[2].previousShotId = plan.shots[1].id;
  return plan;
}
const issues: PetStoryValidationIssue[] = [{ code: 'structure', path: '$.shots[0].predecessorShotIds', actualType: 'array', expected: '新拆合使用新ID', repairable: true, message: 'TEST原ID与自身前身冲突' }];

describe('前身结构错误的最小技术修订', (): void => {
  it('镜头换名允许事件ID与afterEventId精确同步，完整时间、描述和对白保持', (): void => {
    const before = original(); before.shots[0].timingPlan = { events: [
      { id: 'old-action', kind: 'action', description: 'TEST原动作', startSeconds: 0, endSeconds: 1 },
      { id: 'old-dialogue', kind: 'dialogue', description: 'TEST原对白', dialogueIndex: 0, startSeconds: 1, endSeconds: 4, afterEventId: 'old-action' }],
    estimatedRequiredSeconds: 4, durationReason: 'TEST原时长', cutReason: 'TEST原切点' };
    const revised = structuredClone(before); revised.shots[0].id = 'fresh-shot'; revised.shots[1].previousShotId = 'fresh-shot';
    revised.shots[0].timingPlan!.events[0].id = 'new-action'; revised.shots[0].timingPlan!.events[1].id = 'new-dialogue'; revised.shots[0].timingPlan!.events[1].afterEventId = 'new-action';
    expect(planRepairPreservationIssues(before, revised, issues)).toEqual([]);
  });

  it.each(['window', 'description', 'dialogue-index', 'new-after', 'new-field', 'remove-after', 'wrong-after', 'duplicate-id', 'add-event'] as const)('事件技术换名仍拒绝%s改变真实语义', (change: string): void => {
    const before = original(); before.shots[0].timingPlan = { events: [
      { id: 'old-action', kind: 'action', description: 'TEST原动作', startSeconds: 0, endSeconds: 1 },
      { id: 'old-dialogue', kind: 'dialogue', description: 'TEST原对白', dialogueIndex: 0, startSeconds: 1, endSeconds: 4, afterEventId: 'old-action' }],
    estimatedRequiredSeconds: 4, durationReason: 'TEST原时长', cutReason: 'TEST原切点' };
    const revised = structuredClone(before); revised.shots[0].id = 'fresh-shot'; revised.shots[1].previousShotId = 'fresh-shot';
    const events = revised.shots[0].timingPlan!.events;
    events[0].id = 'new-action'; events[1].id = 'new-dialogue'; events[1].afterEventId = 'new-action';
    if (change === 'window') events[1].endSeconds += 0.1;
    if (change === 'description') events[0].description += 'TEST新动作';
    if (change === 'dialogue-index') events[1].dialogueIndex = 1;
    if (change === 'new-after') { delete before.shots[0].timingPlan!.events[1].afterEventId; }
    if (change === 'new-field') Object.assign(events[0], { parallel: true });
    if (change === 'remove-after') delete events[1].afterEventId;
    if (change === 'wrong-after') events[1].afterEventId = 'new-dialogue';
    if (change === 'duplicate-id') events[1].id = 'new-action';
    if (change === 'add-event') events.push({ ...events[0], id: 'extra' });
    expect(planRepairPreservationIssues(before, revised, issues).length).toBeGreaterThan(0);
  });

  it('允许错误镜头换全新ID与其连续引用精确同步，不要求额外确认', (): void => {
    const before = original(); const revised = structuredClone(before);
    revised.shots[0].id = 'merged_new'; revised.shots[1].previousShotId = 'merged_new';
    expect(planRepairPreservationIssues(before, revised, issues)).toEqual([]);
    expect(before.shots[0].id).toBe(snapshot.plan.shots[0].id);
  });

  it.each(['action', 'dialogue', 'unrelated-id', 'wrong-reference', 'unrelated-reference-removal', 'reuse-id', 'order', 'count'] as const)('修正结构时仍拒绝%s无关改动', (change: string): void => {
    const before = original(); const revised = structuredClone(before);
    revised.shots[0].id = 'merged_new'; revised.shots[1].previousShotId = 'merged_new';
    if (change === 'action') revised.shots[0].action += 'TEST改剧情';
    if (change === 'dialogue') revised.shots.find((shot): boolean => !!shot.dialogue?.length)!.dialogue![0].text += 'TEST改对白';
    if (change === 'unrelated-id') revised.shots[2].id = 'unrelated_new';
    if (change === 'wrong-reference') revised.shots[1].previousShotId = revised.shots[2].id;
    if (change === 'unrelated-reference-removal') revised.shots[2].previousShotId = undefined;
    if (change === 'reuse-id') revised.shots[0].id = before.shots[2].id;
    if (change === 'order') revised.shots[0].order = 2;
    if (change === 'count') revised.shots.pop();
    expect(planRepairPreservationIssues(before, revised, issues).length).toBeGreaterThan(0);
  });

  it('无前身错误证据时不放开普通方案的改名或引用变更', (): void => {
    const before = original(); const revised = structuredClone(before);
    revised.shots[0].id = 'merged_new'; revised.shots[1].previousShotId = 'merged_new';
    expect(planRepairPreservationIssues(before, revised, []).some((message): boolean => message.includes('$.shots[0].id'))).toBe(true);
  });

  it('精确结构修正不能通过清空前身、复用当前正式或选定方案中保留的旧ID认领媒体', (): void => {
    const before = original(); const revised = structuredClone(before);
    revised.shots[0].id = 'adopted_reserved'; revised.shots[0].predecessorShotIds = [];
    revised.shots[1].previousShotId = 'adopted_reserved';
    expect(planRepairPreservationIssues(before, revised, issues, { reservedShotIds: ['adopted_reserved'] }).some((message): boolean => message.includes('$.shots[0].id'))).toBe(true);
  });
});
