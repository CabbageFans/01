import type { PetStoryCharacter } from '@doubao-studio/contracts';

type CharacterLabels = Pick<PetStoryCharacter, 'id' | 'name' | 'aliases'>;

/** 与已保存方案的实体重名检查一致，只规范字符宽度、空白与大小写，不推断称谓。 */
export function petStoryCharacterLabelKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
}

/** 仅从已登记的同一角色别名证明括号主名，不把任意括号说明自动当作可用简称。 */
export function petStoryCharacterSpeakerLabels(character: CharacterLabels): string[] {
  const labels = [character.name, ...(character.aliases || [])];
  const suffix = character.name.normalize('NFKC').trim().match(/^([^()]+)\(([^()]+)\)$/u);
  if (suffix && character.aliases?.some((alias): boolean => petStoryCharacterLabelKey(alias) === petStoryCharacterLabelKey(suffix[2]))) labels.push(suffix[1].trim());
  const seen = new Set<string>();
  return labels.filter((label): boolean => {
    const key = petStoryCharacterLabelKey(label);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 必须使用全部角色，避免同镜未入画角色的同名标签被误认成唯一身份。 */
export function petStoryCharacterLabelOwners(characters: readonly CharacterLabels[]): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const character of characters) for (const label of petStoryCharacterSpeakerLabels(character)) {
    const key = petStoryCharacterLabelKey(label);
    const ids = owners.get(key) || [];
    if (!ids.includes(character.id)) ids.push(character.id);
    owners.set(key, ids);
  }
  return owners;
}

export function seedanceSpeakerLabels(characters: readonly CharacterLabels[], speakerId: string): string[] {
  const character = characters.find((item): boolean => item.id === speakerId);
  if (!character) return [];
  const owners = petStoryCharacterLabelOwners(characters);
  return petStoryCharacterSpeakerLabels(character).filter((label): boolean => owners.get(petStoryCharacterLabelKey(label))?.length === 1);
}
