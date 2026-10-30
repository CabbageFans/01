import type { PetStoryCapability, PetStoryProject, Task } from '@doubao-studio/contracts';

/** 仅投影正常参数和实际控件事实；兼容旧对象，但不把废弃声明带入新请求。 */
export function capabilityParameters(value: PetStoryCapability, accountId: string): PetStoryCapability {
  if (value.accountId !== accountId) throw new Error('生成参数与项目原账号不符');
  const entry = (item: PetStoryCapability['image'] | undefined): PetStoryCapability['image'] => ({
    state: item?.state || 'unknown', reason: typeof item?.reason === 'string' ? item.reason : '',
  });
  return { accountId,
    image: entry(value.image), modes: { first_frame: entry(value.modes?.first_frame), first_last_frame: entry(value.modes?.first_last_frame), reference: entry(value.modes?.reference) },
    durations: Array.isArray(value.durations) ? [...value.durations] : [],
    ...(value.videoConfig ? { videoConfig: { model: value.videoConfig.model, duration: value.videoConfig.duration, aspectRatio: value.videoConfig.aspectRatio } } : {}) };
}

/** 开始动作只保存请求参数。历史入口状态不充当当前页面的执行证据。 */
export function productionCapability(project: PetStoryProject, supplied?: PetStoryCapability): PetStoryCapability {
  const saved = supplied || project.production?.capability || project.promptCapability
    || [...(project.productionHistory || [])].reverse().find((item): boolean => !!item.capability)?.capability;
  if (saved && saved.accountId !== project.accountId) throw new Error('生成参数与项目原账号不符');
  const selectedModel = project.promptModel && project.promptModel !== 'generic' ? project.promptModel : undefined;
  const videoConfig: NonNullable<Task['videoConfig']> = { model: selectedModel || saved?.videoConfig?.model || 'seedance-2.0-fast',
    duration: saved?.videoConfig?.duration || '5s', aspectRatio: saved?.videoConfig?.aspectRatio || '9:16' };
  const unknown = (): PetStoryCapability['image'] => ({ state: 'unknown', reason: '' });
  return { accountId: project.accountId, image: unknown(), modes: { first_frame: unknown(), first_last_frame: unknown(), reference: unknown() }, durations: [], videoConfig };
}
