import type { PetStoryChatJob, PetStoryProject, PetStoryRuntimeTarget } from '@doubao-studio/contracts';

/** 使用既有素材和前镜关系限定等待范围；不释放账号任务或执行租约。 */
export function pendingChatConflicts(project: PetStoryProject, target?: PetStoryRuntimeTarget): PetStoryChatJob[] {
  const pending = project.jobs.filter((job): boolean => {
    if (job.endedWaitingAt || !['bound', 'captured'].includes(job.status)) return false;
    const material = project.materials?.find((item): boolean => item.id === job.materialId);
    // 采用图已替代的文字请求仍保留原任务；它不再是后续画面的文字依赖。
    // 真实账号运行锁仍由调度器管理，此处不释放或重发平台任务。
    return !(material?.kind === 'character' && material.visualBasis && material.prompt.supersededByAssetId && job.resultStatus === 'stale');
  });
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
