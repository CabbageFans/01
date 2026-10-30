import type { PetStoryCapability, PetStoryModeResolution, PetStoryResolvedMode, PetStoryShot } from '@doubao-studio/contracts';

/** 文字与媒体共用同一输入计划；选择模式不代表页面已经支持它。 */
export function plannedPetStoryMode(shot: PetStoryShot, previous?: PetStoryResolvedMode): PetStoryResolvedMode {
  if (shot.requestedMode !== 'auto') return shot.requestedMode;
  return previous || shot.prompts.video.promptTask?.mode || 'reference';
}

export function resolvePetStoryMode(shot: PetStoryShot, capability: PetStoryCapability, fallback?: 'first_frame' | 'reference'): PetStoryModeResolution {
  if (!Number.isFinite(shot.durationSeconds) || shot.durationSeconds < 5 || shot.durationSeconds > 10 || !Number.isInteger(shot.durationSeconds)) throw new Error(`${shot.id}时长必须为 5～10 秒，不自动改值`);
  if (capability.durations.length && !capability.durations.includes(shot.durationSeconds)) throw new Error(`${shot.id}计划时长在当前页面选项中不可选`);
  const usable = (mode: PetStoryResolvedMode): boolean => !capability.modes[mode] || ['supported', 'unknown'].includes(capability.modes[mode].state);
  const preferred: PetStoryResolvedMode[] = [plannedPetStoryMode(shot)];
  let mode = preferred.find(usable);
  if (!mode && fallback && usable(fallback)) mode = fallback;
  if (!mode) {
    const entry = capability.modes[preferred[0]];
    const reason = entry?.state === 'implementation_gap' ? '代码尚未适配' : entry?.state === 'unsupported' ? '平台不支持' : '当前页面没有该生成入口';
    throw new Error(`${shot.id}：${reason}；没有可用的已批准备选，保持暂停`);
  }
  if (mode === 'first_last_frame' && !shot.prompts.lastFrame?.final.trim()) throw new Error(`${shot.id}缺少最终尾帧编辑提示词`);
  return { requestedMode: shot.requestedMode, resolvedMode: mode, reason: mode === shot.requestedMode ? '按请求模式执行' : shot.requestedMode === 'auto' ? '按镜头输入自动选择，执行时读取页面控件' : '请求入口不可用，采用已选择的备选' };
}
