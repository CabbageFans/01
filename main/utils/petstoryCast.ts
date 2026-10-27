import type { PetStoryChatJob, PetStoryPlan } from '@doubao-studio/contracts';
import { record } from './petstoryValidation';

export type AnalysisCastBindings = NonNullable<PetStoryChatJob['analysisCastBindings']>;
/** 仅比较已保存的来源称谓标识，不推断外观、物种或剧情职责。 */
function aliasKey(value: string): string { return value.normalize('NFKC').trim().toLocaleLowerCase(); }
export function validateCastBindings(value: unknown): void {
  const owners = new Map<string, string>();
  for (const [id, item] of Object.entries(record(value))) {
    const actor = record(item);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('演员配置ID无效');
    if (actor.aliases !== undefined) {
      if (!Array.isArray(actor.aliases) || !actor.aliases.length || actor.aliases.length > 100
        || Array.from(actor.aliases).some((alias: unknown): boolean => typeof alias !== 'string' || !alias.trim() || alias.length > 200)) throw new Error('角色来源别名无效');
      for (const alias of actor.aliases as string[]) {
        const key = aliasKey(alias); const previous = owners.get(key);
        if (previous !== undefined && previous !== id) throw new Error(`来源别名${alias}同时绑定多个演员，配置存在歧义`);
        owners.set(key, id);
      }
    }
    if (actor.role !== undefined && actor.role !== 'main' && actor.role !== 'supporting') throw new Error('角色主配角配置无效');
  }
}
export function analysisCastIssues(plan: PetStoryPlan, bindings: AnalysisCastBindings): string[] {
  const issues: string[] = [];
  for (const [id, binding] of Object.entries(bindings)) {
    const actor = plan.characters.find((character): boolean => character.id === id);
    if (binding.aliases?.length && !actor) { issues.push(`${id}缺少已配置来源别名的演员`); continue; }
    if (!actor) continue;
    if (binding.role && binding.role !== actor.role) issues.push(`${id}主配角与本次已保存配置不符`);
    for (const alias of binding.aliases || []) {
      const key = aliasKey(alias);
      if (!actor.aliases?.some((value): boolean => aliasKey(value) === key)) issues.push(`${id}未保留已配置来源别名${alias}`);
      const other = plan.characters.find((character): boolean => character.id !== id && !!character.aliases?.some((value): boolean => aliasKey(value) === key));
      if (other) issues.push(`来源别名${alias}被分配给${other.id}，应属于${id}`);
    }
  }
  return issues;
}
