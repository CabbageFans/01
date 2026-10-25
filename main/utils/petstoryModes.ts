import type { PetStoryCapability, PetStoryModeResolution, PetStoryResolvedMode, PetStoryShot } from '@doubao-studio/contracts';

export function resolvePetStoryMode(shot: PetStoryShot, capability: PetStoryCapability, fallback?: 'first_frame' | 'reference'): PetStoryModeResolution {
  if (!Number.isFinite(shot.durationSeconds) || shot.durationSeconds < 5 || shot.durationSeconds > 10 || !Number.isInteger(shot.durationSeconds)) throw new Error(`${shot.id}时长必须为 5～10 秒且在当前免费入口可选，不自动改值`);
  if (!capability.durations.includes(shot.durationSeconds) || !capability.videoConfig) throw new Error(`${shot.id}计划时长在当前已核实的免费选项中不可选`);
  const usable = (mode: PetStoryResolvedMode): boolean => capability.modes[mode]?.state === 'supported' && capability.modes[mode].free === 'free';
  const preferred: PetStoryResolvedMode[] = shot.requestedMode === 'auto'
    ? [...(shot.prompts.lastFrame ? ['first_last_frame' as const] : []), 'first_frame', 'reference'] : [shot.requestedMode];
  let mode = preferred.find(usable);
  if (!mode && fallback && usable(fallback)) mode = fallback;
  if (!mode) {
    const entry = capability.modes[preferred[0]];
    const reason = entry?.state === 'implementation_gap' ? '代码尚未适配' : entry?.state === 'unsupported' ? '平台不支持' : entry?.free === 'paid' ? '平台要求付费' : entry?.free === 'exhausted' ? '免费额度不足' : '入口或免费权益待确认';
    throw new Error(`${shot.id}：${reason}；没有可用的已批准备选，保持暂停`);
  }
  if (mode === 'first_last_frame' && !shot.prompts.lastFrame?.final.trim()) throw new Error(`${shot.id}缺少最终尾帧编辑提示词`);
  return { requestedMode: shot.requestedMode, resolvedMode: mode, reason: mode === shot.requestedMode ? '当前普通免费入口支持并按请求执行' : shot.requestedMode === 'auto' ? '按当前已核实免费入口自动选择' : '请求入口不可用，采用本人已批准的备选' };
}
