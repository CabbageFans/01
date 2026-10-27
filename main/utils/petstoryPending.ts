import type { PetStoryChatJob, PetStoryProject, PetStoryRuntimeTarget } from '@doubao-studio/contracts';

/** 使用既有素材和前镜关系限定等待范围；不释放账号任务或执行租约。 */
export function pendingChatConflicts(project: PetStoryProject, target?: PetStoryRuntimeTarget): PetStoryChatJob[] {
  const pending = project.jobs.filter((job): boolean => !job.endedWaitingAt && ['bound', 'captured'].includes(job.status));
  if (!target || !target.shotId && !target.materialId) return pending;
  const shot = project.plan?.shots.find((item): boolean => item.id === target.shotId);
  const previous = shot && (project.plan?.shots.find((item): boolean => item.id === shot.previousShotId) || project.plan?.shots.find((item): boolean => item.order === shot.order - 1));
  const materialIds = shot ? new Set([...(shot.characterIds.map((id): string => `character:${id}`)), ...(shot.propIds || []).map((id): string => `prop:${id}`), ...(shot.sceneId ? [`scene:${shot.sceneId}`] : [])]) : undefined;
  return pending.filter((job): boolean => {
    if (!job.shotId && !job.materialId) return true;
    if (target.materialId) return job.materialId === target.materialId;
    if (job.materialId) return !!materialIds?.has(job.materialId);
    return job.shotId === target.shotId || job.shotId === previous?.id;
  });
}
