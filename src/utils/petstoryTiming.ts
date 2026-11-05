import type { PetStoryShot } from '@doubao-studio/contracts';

/** 制作安排的只读展示；新时间表优先，旧项目仍显示原文字安排。 */
export function petStoryTimingText(shot: PetStoryShot): string | undefined {
  if (!shot.timingPlan) return shot.timing;
  const labels: Record<NonNullable<PetStoryShot['timingPlan']>['events'][number]['kind'], string> = {
    action: '动作', dialogue: '发声', reaction: '反应', sound: '声音',
  };
  return shot.timingPlan.events.map((event): string => `${event.startSeconds}～${event.endSeconds} 秒 · ${labels[event.kind]} · ${event.description}`).join('\n');
}
