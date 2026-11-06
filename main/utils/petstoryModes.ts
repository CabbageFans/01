import type { PetStoryAutoModePlan, PetStoryCapability, PetStoryModeResolution, PetStoryPlan, PetStoryResolvedMode, PetStoryShot } from '@doubao-studio/contracts';
import { validPetStoryDuration } from './petstoryValidationIssues';

function normalizedFrameState(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}]/gu, '');
}

/** 新方案采用逐镜剧情判断；旧方案仅按已记录的起终状态保守保留目标，不猜动作词义。 */
export function petStoryAutoModePlan(shot: PetStoryShot): PetStoryAutoModePlan {
  if (shot.requestedMode !== 'auto') return { mode: shot.requestedMode, reason: '本镜已明确选择视频模式。' };
  if (shot.autoModePlan && shot.autoModePlan.source !== 'legacy') return { ...shot.autoModePlan };
  const tail = shot.prompts.lastFrame;
  const savedTail = !!tail && !!(tail.original || tail.optimized || tail.final || tail.edited || tail.draft || tail.sourceJobId || tail.basisJobId || tail.candidateJobId || tail.promptTask);
  if (tail && (shot.autoModePlan?.source !== 'legacy' || savedTail)) return { mode: 'first_last_frame', reason: '旧方案已保留本镜尾帧目标，继续使用首尾帧安排。', source: 'legacy' };
  const start = normalizedFrameState(shot.startState); const end = normalizedFrameState(shot.endState);
  if (start && end && start !== end) return { mode: 'first_last_frame', reason: '旧方案未记录逐镜模式判断；已记录的起止状态不同，先保留尾帧目标，重新分析可按剧情细化。', source: 'legacy' };
  return { mode: 'first_frame', reason: '旧方案未记录逐镜模式判断，当前未记录不同的有效起终状态，先使用首帧，重新分析可按剧情细化。', source: 'legacy' };
}

/** 仅补当前方案的模式依据与空尾帧目标；不删除正文、不处理历史，也不创建生成任务。 */
export function ensurePetStoryAutoModeTargets(plan: PetStoryPlan): void {
  for (const shot of plan.shots) {
    if (shot.requestedMode !== 'auto') continue;
    const decision = petStoryAutoModePlan(shot);
    if (!shot.autoModePlan || shot.autoModePlan.source === 'legacy') shot.autoModePlan = decision;
    if (decision.mode === 'first_last_frame' && !shot.prompts.lastFrame) {
      shot.prompts.lastFrame = { original: '', optimized: '', final: '', edited: false, rulesVersion: shot.prompts.firstFrame.rulesVersion };
    }
  }
}

/** 文字与媒体共用同一输入计划；选择模式不代表页面已经支持它。 */
export function plannedPetStoryMode(shot: PetStoryShot, _previous?: PetStoryResolvedMode): PetStoryResolvedMode {
  return petStoryAutoModePlan(shot).mode;
}

export function resolvePetStoryMode(shot: PetStoryShot, capability: PetStoryCapability, fallback?: 'first_frame' | 'reference'): PetStoryModeResolution {
  if (!validPetStoryDuration(shot.durationSeconds)) throw new Error(`${shot.id}时长必须为 5～10 秒，不自动改值`);
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
  const automaticReason = shot.requestedMode === 'auto' ? `${petStoryAutoModePlan(shot).reason} 执行时读取页面控件。` : '';
  return { requestedMode: shot.requestedMode, resolvedMode: mode, reason: mode === shot.requestedMode ? '按请求模式执行' : mode !== preferred[0] ? `${automaticReason}请求入口不可用，采用已选择的备选` : automaticReason };
}
