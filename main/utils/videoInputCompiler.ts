import { createHash } from 'node:crypto';
import type { PetStoryCompiledPrompt, PetStoryProject, VideoInputSnapshot, Task } from '@doubao-studio/contracts';

/** 只消费已通过资格检查的编译结果和真实文件摘要；与项目编辑、网页和调度均无运行时依赖。 */
export function compileVideoInputSnapshot(project: PetStoryProject, stepId: string, shotId: string, compiled: PetStoryCompiledPrompt, config: NonNullable<Task['videoConfig']>): VideoInputSnapshot {
  const shot = project.plan?.shots.find((item): boolean => item.id === shotId);
  if (!shot || compiled.kind !== 'video' || !compiled.resolvedMode || !compiled.text.trim()) throw new Error('视频输入编译缺少当前镜头或模式');
  if (!Number.isInteger(shot.durationSeconds) || shot.durationSeconds < 5 || shot.durationSeconds > 10 || config.duration !== `${shot.durationSeconds}s`) throw new Error('视频输入时长必须与本镜5～10秒整秒安排一致');
  const references = compiled.references.map((reference): VideoInputSnapshot['references'][number] => {
    const asset = project.assets.find((item): boolean => item.id === reference.assetId);
    if (!asset?.validation || !/^[a-f0-9]{64}$/.test(asset.validation.sha256)) throw new Error('视频输入缺少实际参考文件摘要');
    return { assetId: asset.id, order: reference.order, sha256: asset.validation.sha256, purpose: reference.purpose, ...(reference.slot ? { slot: reference.slot } : {}) };
  });
  const input = { schemaVersion: 1 as const, inputVersion: project.revision + 1, projectId: project.id, shotId, stepId, accountId: project.accountId,
    sourceText: project.mobileStory?.text || '', dialogue: JSON.stringify(shot.dialogue || []), prompt: compiled.text, mode: compiled.resolvedMode,
    videoConfig: structuredClone(config), references };
  return { ...input, digest: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
}
