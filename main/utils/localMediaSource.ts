import { createHash } from 'node:crypto';
import type { PetStoryAsset, PetStoryMediaSourceSnapshot, PetStoryProductionStep, PetStoryProject, Task } from '@doubao-studio/contracts';

export function localMediaSource(project: PetStoryProject, asset: Pick<PetStoryAsset, 'taskId' | 'runId' | 'artifactId' | 'shotId' | 'generationPrompt'>, step?: PetStoryProductionStep, task?: Task): PetStoryMediaSourceSnapshot {
  if (!asset.taskId || !asset.runId || !asset.artifactId) throw new Error('本地视频缺少原运行来源');
  const videoInput = task?.runtime?.input.videoInputSnapshot || step?.videoInputSnapshot;
  return { schemaVersion: 1, projectId: project.id, accountId: project.accountId, taskId: asset.taskId, runId: asset.runId,
    artifactId: asset.artifactId, stepId: step?.id, shotId: asset.shotId, submittedAt: task?.runtime?.submittedAt,
    inputHash: step?.inputHash || (asset.generationPrompt ? createHash('sha256').update(JSON.stringify(asset.generationPrompt)).digest('hex') : undefined),
    videoInput: videoInput ? structuredClone(videoInput) : undefined,
    inputVersion: videoInput?.inputVersion, inputDigest: videoInput?.digest, mode: videoInput?.mode,
    prompt: task?.runtime?.input.prompt || asset.generationPrompt, videoConfig: task?.runtime?.input.videoConfig ? structuredClone(task.runtime.input.videoConfig) : undefined,
    references: (step?.attachmentAssetIds || []).flatMap((id: string): { assetId: string; sha256: string }[] => {
      const reference = project.assets.find((item: PetStoryAsset): boolean => item.id === id);
      return reference?.validation ? [{ assetId: id, sha256: reference.validation.sha256 }] : [];
    }), recordedAt: new Date().toISOString(), ...(task ? {} : { migrated: true as const }) };
}
/** 可重复读入迁移：保留全部文件、旧拒绝事实；只释放无法证明内容损坏的旧工具错误。 */
export function migrateLocalMediaSources(project: PetStoryProject): void {
  const runs = [project.production, ...(project.productionHistory || []), ...Object.values(project.imageProductions || {})];
  const steps = runs.flatMap((run): PetStoryProductionStep[] => run?.steps || []);
  for (const asset of project.assets) {
    if (asset.kind !== 'video' || asset.sourceSnapshot || !asset.validation || !asset.taskId || !asset.runId || !asset.artifactId) continue;
    const step = steps.find((item: PetStoryProductionStep): boolean => item.assetId === asset.id && item.runId === asset.runId);
    asset.sourceSnapshot = localMediaSource(project, asset, step);
    // 迁移时间来自旧资产检查记录，重复读取不制造不同项目快照。
    asset.sourceSnapshot.recordedAt = asset.validation.checkedAt;
  }
  for (const step of steps) {
    if (!step.rejectedArtifactIds?.length || !/^(ffmpeg|ffprobe)媒体处理失败，请检查工具和真实文件/.test(step.error || '')) continue;
    step.mediaRejectionHistory = [...(step.mediaRejectionHistory || []), { artifactIds: [...step.rejectedArtifactIds], reason: step.error || '', code: 'legacy_tool_failure' }];
    step.rejectedArtifactIds = [];
  }
}
export function assertLocalMediaSource(project: PetStoryProject, asset: PetStoryAsset): void {
  const source = asset.sourceSnapshot;
  if (!source || source.schemaVersion !== 1 || source.projectId !== project.id || source.accountId !== project.accountId
    || source.taskId !== asset.taskId || source.runId !== asset.runId || source.artifactId !== asset.artifactId || source.shotId !== asset.shotId) throw new Error('本地视频来源记录不符，请重新打开项目核对');
}
