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
    bodyAvailable: !!prompt, promptKind: trustedLast ? 'lastFrame' : trustedVideo ? 'video' : undefined, promptText: prompt?.final, sourceJobId: prompt?.sourceJobId, source: prompt ? prompt.edited ? 'user_edited_final' : 'adopted_chat' : 'no_trusted_adopted_body', needsReview: prompt?.needsReview || false,
    policy: '这是前镜已采用终点的连续性上下文，不是当前首帧的正向画面要求，不能复制前镜动作过程、对白或已经结束的表演。对照当前确认起点，继承仍在持续的持有人、持有手、接触关系、身体依托和世界空间锚点；continue不能无过程换手、转移持物或重置状态，cut允许换机位和构图，也不能无解释重置持续状态。needsReview为true时只作待复核依据，有冲突具体指出，不能覆盖当前确认事实；前镜终点与本镜起点之间确有变化但无过程来源时，不自行补编创作事实。',
  };
}
