import type { PetStoryResolvedMode } from '@doubao-studio/contracts';
import type { PetStoryComposerSnapshot } from './petstoryControls';

/** 首尾是镜头选图用途；统一入口按实际图数判断能力，并保存真实物理绑定。 */
export function usesSharedPetStoryFrames(snapshot: PetStoryComposerSnapshot, mode: PetStoryResolvedMode | 'image' | undefined): boolean {
  const supportsFrameCount = mode === 'first_frame' || mode === 'first_last_frame' && snapshot.referenceMultiple === true;
  return supportsFrameCount && snapshot.generic && !snapshot.first && !snapshot.last;
}

/** 仅明确的原生控件要求必须有原生槽；普通起止状态描述不能被误当成控件要求。 */
export function requiresNativePetStoryFrames(text: string): boolean {
  return /原生(?:独立)?(?:首帧|尾帧|首尾帧)|首尾帧(?:专用|独立)槽|(?:独立|专用)(?:首帧|尾帧|首尾帧)(?:上传)?槽|(?:首帧|尾帧)(?:独立|专用)(?:上传)?槽/.test(text);
}
