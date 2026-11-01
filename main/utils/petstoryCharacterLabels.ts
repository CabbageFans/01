import type { PetStoryCharacter } from '@doubao-studio/contracts';

type CharacterLabels = Pick<PetStoryCharacter, 'id' | 'name' | 'aliases' | 'productionLabel'>;

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

/** 中性制作标签只定位剧情角色，不把黑衣、马尾等来源称谓重新变成造型命令。 */
export function petStoryProductionLabel(characters: readonly CharacterLabels[], characterId: string): string | undefined {
  const index = characters.findIndex((character): boolean => character.id === characterId);
  if (index < 0) return undefined;
  if (characters[index].productionLabel) return characters[index].productionLabel;
  const occupied = new Set(characters.flatMap((character): string[] => petStoryCharacterSpeakerLabels(character)).concat(characters.flatMap((character): string[] => character.productionLabel ? [character.productionLabel] : [])).map(petStoryCharacterLabelKey));
  let label = `角色${index + 1}`;
  while (occupied.has(petStoryCharacterLabelKey(label))) label = `制作${label}`;
  return label;
}

/** 新方案只分配制作元数据；同一稳定角色ID沿用既有标签，角色排序和新增配角不会交换发声对象。 */
export function assignPetStoryProductionLabels(characters: PetStoryCharacter[], previous: readonly CharacterLabels[] = []): void {
  const prior = new Map(previous.map((character): [string, string | undefined] => [character.id, petStoryProductionLabel(previous, character.id)]));
  const used = new Set<string>();
  for (const character of characters) {
    const label = prior.get(character.id) || character.productionLabel;
    const sourceCollision = label && characters.some((other): boolean => other.id !== character.id && petStoryCharacterSpeakerLabels(other).some((source): boolean => petStoryCharacterLabelKey(source) === petStoryCharacterLabelKey(label)));
    if (label && !sourceCollision && !used.has(petStoryCharacterLabelKey(label))) {
      character.productionLabel = label; used.add(petStoryCharacterLabelKey(label));
    } else character.productionLabel = undefined;
  }
  const occupied = new Set([...used, ...characters.flatMap((character): string[] => petStoryCharacterSpeakerLabels(character)).map(petStoryCharacterLabelKey)]);
  for (const character of characters) {
    if (character.productionLabel) continue;
    let index = 1;
    while (occupied.has(petStoryCharacterLabelKey(`角色${index}`))) index += 1;
    character.productionLabel = `角色${index}`;
    occupied.add(petStoryCharacterLabelKey(character.productionLabel));
  }
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
  for (const character of characters) {
    const label = petStoryProductionLabel(characters, character.id);
    if (!label) continue;
    const key = petStoryCharacterLabelKey(label); const ids = owners.get(key) || [];
    if (!ids.includes(character.id)) ids.push(character.id);
    owners.set(key, ids);
  }
  return owners;
}

export function seedanceSpeakerLabels(characters: readonly CharacterLabels[], speakerId: string): string[] {
  const character = characters.find((item): boolean => item.id === speakerId);
  if (!character) return [];
  const owners = petStoryCharacterLabelOwners(characters);
  return [...petStoryCharacterSpeakerLabels(character), petStoryProductionLabel(characters, character.id) || character.id].filter((label): boolean => owners.get(petStoryCharacterLabelKey(label))?.length === 1);
}
