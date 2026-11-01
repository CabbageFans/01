import { createHash } from 'node:crypto';
import { hasCurrentPromptReviewError } from './petstoryReview';
import type { PetStoryProject, PetStoryShot } from '@doubao-studio/contracts';

/** 只传已采用原文，不用代码提炼或补写持物状态；跨镜状态由 Chat 对照确认边界继承。 */
export function previousAdoptedBoundary(project: PetStoryProject, shot: PetStoryShot): object | undefined {
  const shots = project.plan?.shots || [];
  const previous = shots.find((item): boolean => item.id === shot.previousShotId && item.id !== shot.id)
    || shots.filter((item): boolean => item.order < shot.order).sort((a, b): number => b.order - a.order)[0];
  if (!previous) return undefined;
  const last = previous.prompts.lastFrame;
  const video = previous.prompts.video;
  const trustedLast = !!last && (!!last.sourceJobId || last.edited);
  const trustedVideo = !!video.sourceJobId || video.edited;
  const prompt = trustedLast ? last : trustedVideo ? video : undefined;
  return { shotId: previous.id, order: previous.order, relation: shot.transition, boundarySource: shot.previousShotId === previous.id ? 'explicit_previousShotId' : 'previous_in_current_order', endState: previous.endState,
    bodyAvailable: !!prompt, promptKind: trustedLast ? 'lastFrame' : trustedVideo ? 'video' : undefined, promptText: prompt?.needsReview ? undefined : prompt?.final, historicalPromptText: prompt?.needsReview ? prompt.final : undefined, sourceJobId: prompt?.sourceJobId, source: prompt ? prompt.edited ? 'user_edited_final' : 'adopted_chat' : 'no_trusted_adopted_body', needsReview: prompt?.needsReview || false,
    policy: 'promptText只可继承动作、手位、持物、接触和空间状态，不读取其中人物造型；历史服饰、物种、发型不生效。historicalPromptText已退出有效写作依据，只保留追溯，不从中恢复过时外观。这是前镜已采用终点的连续性上下文，不是当前首帧的正向画面要求，不能复制前镜动作过程、对白或已经结束的表演。对照当前确认起点，继承仍在持续的持有人、持有手、接触关系、身体依托和世界空间锚点；continue不能无过程换手、转移持物或重置状态，cut允许换机位和构图，也不能无解释重置持续状态。needsReview为true时只作待复核依据，有冲突具体指出，不能覆盖当前确认事实；前镜终点与本镜起点之间确有变化但无过程来源时，不自行补编创作事实。',
  };
}

/** cut 不继承前镜被替换角色的视觉复核状态，但仍核对真实终态、原采用正文与来源。 */
export function previousBoundaryHashMatches(project: PetStoryProject, shot: PetStoryShot, expected: string): boolean {
  const boundary = previousAdoptedBoundary(project, shot) as { shotId?: string; promptKind?: 'lastFrame' | 'video'; historicalPromptText?: string } | undefined;
  const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value || null)).digest('hex');
  if (expected === digest(boundary)) return true;
  if (shot.transition !== 'cut' || !boundary?.shotId || !boundary.promptKind) return false;
  const previous = project.plan?.shots.find((item): boolean => item.id === boundary.shotId);
  const prompt = previous?.prompts[boundary.promptKind];
  if (!prompt?.visualBasisStale || hasCurrentPromptReviewError(project, prompt, { shotId: previous?.id, promptKind: boundary.promptKind })) return false;
  // 只重现换图前投影的元数据；不改源任务/hash，也不把过时正文重新送入当前写作事实。
  return expected === digest({ ...boundary, promptText: prompt.final, historicalPromptText: undefined, needsReview: false });
}
