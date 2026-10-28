import type { PetStoryPlan } from '@doubao-studio/contracts';
/** 只合并用户真正改过的字段；并发回复的新正文不能被旧高级表单覆盖。冲突保留草稿。 */
export function mergePetStoryPlanDraft(base: PetStoryPlan, draft: PetStoryPlan, latest: PetStoryPlan): PetStoryPlan {
  const merge = (before: unknown, edited: unknown, current: unknown, path: string): unknown => {
    if (JSON.stringify(before) === JSON.stringify(edited)) return current;
    if (JSON.stringify(edited) === JSON.stringify(current)) return current;
    // 空数组不能凭 every 的空真值当作 ID 集合；对白等有序列表并发修改必须报冲突。
    if (Array.isArray(before) && Array.isArray(edited) && Array.isArray(current) && [...before, ...edited, ...current].every((item: unknown): boolean => !!item && typeof item === 'object' && 'id' in item && typeof item.id === 'string')) {
      const id = (item: unknown): string => (item as { id: string }).id;
      if (before.map(id).join('|') !== current.map(id).join('|')) throw new Error(`${path}已被其他结果更新，请保留草稿并重新核对`);
      for (const removed of before.filter((item: unknown): boolean => !edited.some((entry: unknown): boolean => id(entry) === id(item)))) {
        const currentItem = current.find((entry: unknown): boolean => id(entry) === id(removed));
        if (JSON.stringify(removed) !== JSON.stringify(currentItem)) throw new Error(`${path}.${id(removed)}已有新保存内容，不能直接删除；请保留草稿并重新核对`);
      }
      return edited.map((item: unknown): unknown => { const old = before.find((entry: unknown): boolean => id(entry) === id(item)); return old ? merge(old, item, current.find((entry: unknown): boolean => id(entry) === id(item)), `${path}.${id(item)}`) : item; });
    }
    if (before && edited && current && typeof before === 'object' && typeof edited === 'object' && typeof current === 'object' && !Array.isArray(before)) {
      const result = { ...current as Record<string, unknown> };
      for (const key of new Set([...Object.keys(before), ...Object.keys(edited)])) {
        const value = merge((before as Record<string, unknown>)[key], (edited as Record<string, unknown>)[key], (current as Record<string, unknown>)[key], `${path}.${key}`);
        if (!Object.prototype.hasOwnProperty.call(edited, key) && value === undefined) delete result[key];
        else result[key] = value;
      }
      return result;
    }
    if (JSON.stringify(before) !== JSON.stringify(current)) throw new Error(`${path}已有新保存内容，请核对冲突后再保存`);
    return edited;
  };
  return merge(base, draft, latest, '方案') as PetStoryPlan;
}
