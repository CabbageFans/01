import type { PetStoryPromptProfile } from '@doubao-studio/contracts';
import presets from './petstoryPresets.json';
import legacyDefaults from './petstoryLegacyDefaults.json';

export function defaultPromptProfile(): PetStoryPromptProfile { return structuredClone(presets.profile) as PetStoryPromptProfile; }
/** 仅排除旧版原样继承的默认值；不改写磁盘历史，不按角色名推断用户意图。 */
export function effectivePromptProfile(saved?: PetStoryPromptProfile): PetStoryPromptProfile {
  const profile = structuredClone(saved || defaultPromptProfile());
  for (const [id, legacy] of Object.entries(legacyDefaults.characters)) {
    const current = profile.characters[id];
    if (current && current.identity === legacy.identity && current.appearance === legacy.appearance
      && (current.role === undefined || current.role === legacy.role)
      && Object.keys(current).every((key: string): boolean => ['identity', 'appearance', 'role'].includes(key))) delete profile.characters[id];
  }
  if (profile.assetStyles?.common === legacyDefaults.commonStyle) profile.assetStyles.common = '';
  return profile;
}
