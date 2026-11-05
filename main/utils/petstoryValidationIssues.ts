import type { PetStoryPlan, PetStoryValidationIssue } from '@doubao-studio/contracts';
import { collectPetStoryDialogueFragmentIssues, collectPetStoryTimingIssues } from './petstoryTiming';

export type { PetStoryValidationIssue } from '@doubao-studio/contracts';

/** 内容错误携带原值，和网络／磁盘／过期等执行错误保持明确边界。 */
export class PetStoryContentValidationError extends Error {
  readonly issues: PetStoryValidationIssue[];
  constructor(issues: PetStoryValidationIssue[]) {
    super(issues.map((issue): string => issue.message).join('\n'));
    this.name = 'PetStoryContentValidationError';
    this.issues = issues;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function actualType(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}
export function validPetStoryDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 5 && value <= 10;
}
export function formatPetStoryValidationIssue(issue: PetStoryValidationIssue): string {
  const actual = typeof issue.actual === 'number' && !Number.isFinite(issue.actual) ? String(issue.actual) : JSON.stringify(issue.actual) ?? 'undefined';
  return `${issue.path}：${issue.message}；实际值 ${actual}（${issue.actualType}）；期望 ${issue.expected}`;
}

/** 一次收集可以明确诊断的独立问题，不修值、不跳过之后的严格校验。 */
export function collectPetStoryPlanIssues(value: unknown): PetStoryValidationIssue[] {
  const issues: PetStoryValidationIssue[] = [];
  const add = (path: string, actual: unknown, expected: string, message: string, code = 'field', targetId?: string): void => {
    issues.push({ code, path, targetId, actual, actualType: actualType(actual), expected, repairable: true, message });
  };
  const requiredText = (entry: Record<string, unknown>, key: string, path: string, label: string, targetId?: string): void => {
    if (typeof entry[key] !== 'string' || !(entry[key] as string).trim()) add(`${path}.${key}`, entry[key], '非空文本', `${label}不能为空`, 'text', targetId);
  };
  const optionalText = (entry: Record<string, unknown>, key: string, path: string, targetId?: string): void => {
    if (entry[key] !== undefined && typeof entry[key] !== 'string') add(`${path}.${key}`, entry[key], '文本或省略', `${key}必须为文本`, 'type', targetId);
  };
  const validId = (id: unknown, path: string, label: string, targetId?: string): void => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) add(path, id, '1～80位稳定英文、数字、下划线或连字符ID', typeof id !== 'string' ? `${label}必须是字符串（例如 shot_1），不能使用数字或 null` : `${label}必须为稳定的字母数字 ID`, 'id', targetId);
  };
  const array = (entry: Record<string, unknown>, key: string, path: string, required: boolean): unknown[] | undefined => {
    if (entry[key] === undefined && !required) return undefined;
    if (!Array.isArray(entry[key])) { add(`${path}.${key}`, entry[key], '数组', `${key}必须为数组`, 'type'); return undefined; }
    return entry[key] as unknown[];
  };
  const plan = object(value);
  if (!plan) { add('$', value, 'JSON对象', '需要 JSON 对象', 'structure'); return issues; }
  requiredText(plan, 'sourceSummary', '$', '原片梗概'); requiredText(plan, 'adaptedStory', '$', '相似故事');
  for (const key of ['understanding', 'sceneDesign']) optionalText(plan, key, '$');
  const characters = array(plan, 'characters', '$', true);
  const props = array(plan, 'props', '$', false); const scenes = array(plan, 'scenes', '$', false);
  if ((plan.props === undefined) !== (plan.scenes === undefined)) add('$', undefined, 'props与scenes一起提供', '道具和场景集合必须一起提供', 'structure');
  const entityIds = (entries: unknown[] | undefined): Set<unknown> => new Set(entries?.map((item): unknown => object(item)?.id));
  const characterIds = entityIds(characters); const propIds = entityIds(props); const sceneIds = entityIds(scenes);
  for (const [key, entries] of [['characters', characters], ['props', props], ['scenes', scenes]] as const) {
    const seen = new Set<unknown>();
    entries?.forEach((value: unknown, index: number): void => {
      const path = `$.${key}[${index}]`; const entry = object(value);
      if (!entry) { add(path, value, 'JSON对象', `${key}项目需要 JSON 对象`, 'structure'); return; }
      const targetId = typeof entry.id === 'string' ? entry.id : undefined;
      validId(entry.id, `${path}.id`, `${key} ID`, targetId);
      if (seen.has(entry.id)) add(`${path}.id`, entry.id, '集合内唯一ID', `${key}有重复 ID`, 'duplicate', targetId);
      seen.add(entry.id); requiredText(entry, 'name', path, `${key}名称`, targetId);
      if (key === 'characters') {
        if (!['main', 'supporting'].includes(String(entry.role))) add(`${path}.role`, entry.role, 'main或supporting', '角色 role 无效', 'enum', targetId);
        requiredText(entry, 'purpose', path, '剧情作用', targetId); requiredText(entry, 'description', path, '角色外观', targetId);
        optionalText(entry, 'continuity', path, targetId);
      } else if (key === 'props') {
        requiredText(entry, 'description', path, '道具外观', targetId); requiredText(entry, 'keyStates', path, '道具状态', targetId);
        optionalText(entry, 'appearanceState', path, targetId); optionalText(entry, 'scale', path, targetId);
      } else {
        for (const field of ['location', 'time', 'lighting', 'layout', 'view']) requiredText(entry, field, path, field, targetId);
        if (entry.parentSceneId !== undefined && !sceneIds.has(entry.parentSceneId)) add(`${path}.parentSceneId`, entry.parentSceneId, '当前已有场景ID', '场景主图引用不存在或循环', 'reference', targetId);
      }
      if (key !== 'characters' || entry.designOrigin !== undefined) {
        if (!['script', 'proposed'].includes(String(entry.designOrigin))) add(`${path}.designOrigin`, entry.designOrigin, 'script或proposed', '设计来源必须注明 script 或 proposed', 'enum', targetId);
      }
      if (key === 'props' || entry.aliases !== undefined) {
        if (!Array.isArray(entry.aliases) || entry.aliases.some((alias: unknown): boolean => typeof alias !== 'string')) add(`${path}.aliases`, entry.aliases, '文本数组', `${key}别名必须为文本数组`, 'type', targetId);
      }
    });
  }
  const shots = array(plan, 'shots', '$', true);
  if (shots?.length === 0) add('$.shots', shots, '非空镜头数组', 'shots必须是非空数组', 'structure');
  const seenShots = new Set<unknown>();
  shots?.forEach((value: unknown, index: number): void => {
    const shot = object(value); const path = `$.shots[${index}]`;
    if (!shot) { add(path, value, 'JSON对象', '镜头需要 JSON 对象', 'structure'); return; }
    const targetId = typeof shot.id === 'string' ? shot.id : undefined; const label = targetId || `镜头${index + 1}`;
    validId(shot.id, `${path}.id`, '镜头 ID', targetId);
    if (seenShots.has(shot.id)) add(`${path}.id`, shot.id, '镜头集合内唯一ID', 'shots有重复 ID', 'duplicate', targetId);
    seenShots.add(shot.id);
    const predecessors = array(shot, 'predecessorShotIds', path, false);
    const seenPredecessors = new Set<unknown>();
    predecessors?.forEach((predecessor: unknown, predecessorIndex: number): void => {
      validId(predecessor, `${path}.predecessorShotIds[${predecessorIndex}]`, '前身镜头ID', targetId);
      if (seenPredecessors.has(predecessor)) add(`${path}.predecessorShotIds[${predecessorIndex}]`, predecessor, '无重复前身ID', '镜头前身ID重复', 'duplicate', targetId);
      seenPredecessors.add(predecessor);
    });
    if (shot.order !== index + 1) add(`${path}.order`, shot.order, `数值${index + 1}`, `${label}顺序必须与列表一致（从 1 开始）`, 'order', targetId);
    const duration = shot.durationSeconds;
    if (!validPetStoryDuration(duration)) add(`${path}.durationSeconds`, duration, '当前项目5～10秒内的有限整秒数值（5、6、7、8、9、10），不接受字符串', `${label}时长必须是 5～10 秒内的有限数值，并使用可选整秒`, 'duration', targetId);
    for (const field of ['scene', 'action', 'startState', 'endState']) requiredText(shot, field, path, `${label}.${field}`, targetId);
    for (const field of ['sceneView', 'expression', 'gaze', 'interaction', 'camera', 'narrativePurpose', 'framing', 'blocking', 'performance', 'sound', 'timing', 'continuity']) optionalText(shot, field, path, targetId);
    const refs = array(shot, 'characterIds', path, true);
    const shotProps = array(shot, 'propIds', path, !!props);
    for (const [field, entries, available, name] of [['characterIds', refs, characterIds, '角色'], ['propIds', shotProps, propIds, '道具']] as const) {
      const seen = new Set<unknown>();
      entries?.forEach((id: unknown, refIndex: number): void => {
        validId(id, `${path}.${field}[${refIndex}]`, `${name}引用`, targetId);
        if (!available.has(id)) add(`${path}.${field}[${refIndex}]`, id, `当前${name}集合的已知ID`, `${label}引用未知${name}`, 'reference', targetId);
        if (seen.has(id)) add(`${path}.${field}[${refIndex}]`, id, '无重复引用', `${label}.${field}有重复 ID`, 'duplicate', targetId);
        seen.add(id);
      });
    }
    if (scenes && !sceneIds.has(shot.sceneId)) add(`${path}.sceneId`, shot.sceneId, '当前场景集合的已知ID', `${label}场景或道具引用缺失／未知`, 'reference', targetId);
    const states = array(shot, 'propStates', path, !!props && !!shotProps?.length);
    if (shotProps?.some((id: unknown): boolean => !states?.some((entry: unknown): boolean => object(entry)?.propId === id))) add(`${path}.propStates`, shot.propStates, '逐项且仅一次覆盖本镜propIds的状态', `${label}缺少道具状态／持有者说明`, 'reference', targetId);
    states?.forEach((value: unknown, stateIndex: number): void => {
      const state = object(value); const statePath = `${path}.propStates[${stateIndex}]`;
      if (!state) { add(statePath, value, '道具状态对象', '道具状态需要 JSON 对象', 'structure', targetId); return; }
      if (!shotProps?.includes(state.propId) || state.holderId !== undefined && !refs?.includes(state.holderId)) add(statePath, value, '本镜道具及出场角色ID', '道具状态必须属于本镜道具与出场人物', 'reference', targetId);
      requiredText(state, 'state', statePath, '本镜道具状态', targetId);
    });
    const dialogue = array(shot, 'dialogue', path, false);
    dialogue?.forEach((value: unknown, lineIndex: number): void => {
      const line = object(value); const linePath = `${path}.dialogue[${lineIndex}]`;
      if (!line) { add(linePath, value, '台词对象', '台词需要 JSON 对象', 'structure', targetId); return; }
      requiredText(line, 'text', linePath, '已有台词', targetId);
      issues.push(...collectPetStoryDialogueFragmentIssues(line, linePath, targetId));
      if (!characterIds.has(line.speakerId) || !refs?.includes(line.speakerId) && !['offscreen', 'voiceover'].includes(String(line.delivery))) add(`${linePath}.speakerId`, line.speakerId, '已出场角色，或注明OS／VO的已有角色', '画内台词说话者必须出场；OS／VO必须对应已有角色', 'reference', targetId);
      if (line.delivery !== undefined && !['onscreen', 'offscreen', 'voiceover'].includes(String(line.delivery))) add(`${linePath}.delivery`, line.delivery, 'onscreen、offscreen或voiceover', '台词发声方式无效', 'enum', targetId);
      optionalText(line, 'tone', linePath, targetId); optionalText(line, 'pace', linePath, targetId);
    });
    issues.push(...collectPetStoryTimingIssues(shot, path, targetId));
    if (!['cut', 'continue'].includes(String(shot.transition))) add(`${path}.transition`, shot.transition, 'cut或continue', `${label}切镜关系无效`, 'enum', targetId);
    if (!['auto', 'first_frame', 'first_last_frame', 'reference'].includes(String(shot.requestedMode))) add(`${path}.requestedMode`, shot.requestedMode, 'auto、first_frame、first_last_frame或reference', `${label}模式无效`, 'enum', targetId);
    if (shot.transition === 'continue' && (index === 0 || shot.previousShotId !== object(shots[index - 1])?.id)) add(`${path}.previousShotId`, shot.previousShotId, '相邻上一镜头ID', `${label}连续引用必须指向相邻上一镜头`, 'reference', targetId);
    if (shot.transition === 'cut' && shot.previousShotId !== undefined) add(`${path}.previousShotId`, shot.previousShotId, '省略，不绑定前镜', `${label}切镜不应绑定上一镜头`, 'reference', targetId);
  });
  return issues;
}

/** 总时长不变时，修正过短／过长分镜会连带调整原本合法镜头的分配；只放行数值和对应节奏字段。 */
function durationReallocationPaths(original: Record<string, unknown>, revisedPlan: PetStoryPlan, issues: PetStoryValidationIssue[], enabled: boolean): Set<string> {
  const paths = new Set<string>();
  if (!enabled || !Array.isArray(original.shots) || original.shots.length !== revisedPlan.shots.length) return paths;
  const shots: unknown[] = original.shots;
  const timed = shots.map((value: unknown): Record<string, unknown> | undefined => object(value));
  if (timed.some((shot: Record<string, unknown> | undefined, index: number): boolean => !shot || shot.id !== revisedPlan.shots[index].id || shot.order !== revisedPlan.shots[index].order
    || typeof shot.durationSeconds !== 'number' || !Number.isFinite(shot.durationSeconds) || shot.durationSeconds <= 0 || !validPetStoryDuration(revisedPlan.shots[index].durationSeconds))) return paths;
  if (!issues.some((issue: PetStoryValidationIssue): boolean => issue.code === 'duration' && issue.repairable && timed.some((shot: Record<string, unknown> | undefined, index: number): boolean => issue.path === `$.shots[${index}].durationSeconds` && !validPetStoryDuration(shot?.durationSeconds)))) return paths;
  const originalTotal = timed.reduce((sum: number, shot: Record<string, unknown> | undefined): number => typeof shot?.durationSeconds === 'number' ? sum + shot.durationSeconds : Number.NaN, 0);
  const revisedTotal = revisedPlan.shots.reduce((sum: number, shot: PetStoryPlan['shots'][number]): number => sum + shot.durationSeconds, 0);
  if (!Number.isFinite(originalTotal) || Math.abs(originalTotal - revisedTotal) > 0.000001) return paths;
  timed.forEach((shot: Record<string, unknown> | undefined, index: number): void => {
    paths.add(`$.shots[${index}].durationSeconds`);
    if (shot?.durationSeconds !== revisedPlan.shots[index].durationSeconds) { paths.add(`$.shots[${index}].timing`); paths.add(`$.shots[${index}].timingPlan`); }
  });
  return paths;
}

/** 前身结构纠正可更换该镜头的技术ID，并精确同步仍指向它的连续镜头引用；不放开正文、顺序或数量。 */
function predecessorRepairPaths(original: Record<string, unknown>, revisedPlan: PetStoryPlan, issues: PetStoryValidationIssue[], reservedIds: string[] = []): Set<string> {
  const paths = new Set<string>();
  if (!Array.isArray(original.shots) || original.shots.length !== revisedPlan.shots.length) return paths;
  const shots: unknown[] = original.shots;
  const ids = shots.map((value: unknown): unknown => object(value)?.id);
  const renamed = new Map<string, string>();
  for (const issue of issues) {
    const match = issue.repairable && issue.code === 'structure' ? issue.path.match(/^\$\.shots\[(\d+)\]\.(?:predecessorShotIds(?:\.|\[|$)|id$)/) : undefined;
    if (!match) continue;
    const index = Number(match[1]); const before = object(shots[index]); const after = revisedPlan.shots[index];
    if (typeof before?.id !== 'string' || !after || before.id === after.id || before.order !== after.order
      || ids.includes(after.id) || reservedIds.includes(after.id) || ids.filter((id: unknown): boolean => id === before.id).length !== 1) continue;
    renamed.set(before.id, after.id); paths.add(`$.shots[${index}].id`);
    for (const path of renamedEventPaths(before, after, index)) paths.add(path);
  }
  shots.forEach((value: unknown, index: number): void => {
    const before = object(value); const after = revisedPlan.shots[index];
    if (typeof before?.previousShotId === 'string' && renamed.has(before.previousShotId) && renamed.get(before.previousShotId) === after.previousShotId) paths.add(`$.shots[${index}].previousShotId`);
  });
  return paths;
}

/** 镜头技术换名可连带重命名内部事件；只放行同序事件的唯一ID及其精确依赖映射。 */
function renamedEventPaths(before: Record<string, unknown>, after: PetStoryPlan['shots'][number], shotIndex: number): string[] {
  const oldEvents = object(before.timingPlan)?.events; const newEvents = after.timingPlan?.events;
  if (!Array.isArray(oldEvents) || !newEvents || oldEvents.length !== newEvents.length) return [];
  const oldIds = oldEvents.map((event: unknown): unknown => object(event)?.id);
  if (oldIds.some((id: unknown): boolean => typeof id !== 'string') || new Set(oldIds).size !== oldIds.length || new Set(newEvents.map((event): string => event.id)).size !== newEvents.length) return [];
  const mapping = new Map(oldIds.map((id: unknown, index: number): [unknown, string] => [id, newEvents[index].id]));
  return oldEvents.flatMap((event: unknown, index: number): string[] => {
    const previous = object(event)?.afterEventId;
    const path = `$.shots[${shotIndex}].timingPlan.events[${index}]`;
    return [`${path}.id`, ...(typeof previous === 'string' && mapping.get(previous) === newEvents[index].afterEventId ? [`${path}.afterEventId`] : [])];
  });
}

/** 对比模型原文而非代码补稿；仅放行明确问题字段与其必要技术引用，以及时长修订必要的节奏说明。 */
export function planRepairPreservationIssues(originalReply: unknown, revisedPlan: PetStoryPlan, issues: PetStoryValidationIssue[], options: { allowTotalDurationReallocation?: boolean; allowShotRestructure?: boolean; reservedShotIds?: string[] } = {}): string[] {
  const original = object(originalReply);
  if (!original) return [];
  const changes: string[] = [];
  const timingPaths = durationReallocationPaths(original, revisedPlan, issues, options.allowTotalDurationReallocation === true);
  const predecessorPaths = predecessorRepairPaths(original, revisedPlan, issues, options.reservedShotIds);
  const timingRepairs = issues.flatMap((issue: PetStoryValidationIssue): string[] => {
    const match = issue.code === 'timing' && issue.repairable ? issue.path.match(/^(\$\.shots\[\d+\]\.timingPlan)(?:\.|\[|$)/) : undefined;
    return match ? [match[1]] : [];
  });
  const allowed = (path: string): boolean => predecessorPaths.has(path) || timingPaths.has(path) || timingRepairs.some((prefix: string): boolean => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`))
    || issues.some((issue): boolean => issue.path !== '$' && (path === issue.path || path.startsWith(`${issue.path}.`) || path.startsWith(`${issue.path}[`)));
  const same = (before: unknown, after: unknown): boolean => JSON.stringify(before) === JSON.stringify(after);
  const compare = (before: unknown, after: unknown, path: string): void => {
    if (before === undefined || allowed(path) || same(before, after)) return;
    if (Array.isArray(before) && Array.isArray(after)) {
      compare(before.length, after.length, `${path}.length`);
      before.forEach((value: unknown, index: number): void => compare(value, after[index], `${path}[${index}]`));
      return;
    }
    const entry = object(before); const revised = object(after);
    if (entry && revised) {
      // 事件换名仅改变符号：旧对象没有的新依赖、并行标志或其他语义也必须比较，不能从旧键遍历中漏掉。
      if (/\.timingPlan\.events\[\d+\]$/.test(path)) for (const field of Object.keys(revised)) {
        if (!(field in entry) && revised[field] !== undefined && !allowed(`${path}.${field}`)) changes.push(`修订改变了无关内容 ${path}.${field}；技术换名不能新增事件语义或依赖`);
      }
      for (const [field, value] of Object.entries(entry)) compare(value, revised[field], `${path}.${field}`);
      return;
    }
    changes.push(`修订改变了无关内容 ${path}；请保留原剧情、身份、镜头顺序和逐字台词，涉及拆镜或改变已锁定内容须作为新候选另行确认`);
  };
  for (const key of ['sourceSummary', 'adaptedStory'] as const) compare(original[key], revisedPlan[key], `$.${key}`);
  for (const key of ['characters', 'props', 'scenes'] as const) {
    const before = original[key]; const after = revisedPlan[key];
    if (!Array.isArray(before) || !Array.isArray(after)) continue;
    compare(before.length, after.length, `$.${key}.length`);
    before.forEach((value: unknown, index: number): void => {
      const entry = object(value); const revised = object(after[index]);
      if (!entry || !revised) return;
      for (const [field, saved] of Object.entries(entry)) {
        if (!['referenceAssetId', 'prompts'].includes(field)) compare(saved, revised[field], `$.${key}[${index}].${field}`);
      }
    });
  }
  if (!Array.isArray(original.shots)) return changes;
  if (options.allowShotRestructure) {
    const spoken = (shots: unknown[]): { speakerId: unknown; delivery: unknown; text: string }[] => {
      const result: { speakerId: unknown; delivery: unknown; text: string }[] = [];
      for (const value of shots) {
        const shot = object(value);
        if (!Array.isArray(shot?.dialogue)) continue;
        for (const value of shot.dialogue) {
          const line = object(value);
          if (!line || typeof line.text !== 'string') continue;
          const delivery = line.delivery || 'onscreen'; const last = result.at(-1);
          if (last && last.speakerId === line.speakerId && last.delivery === delivery) last.text += line.text;
          else result.push({ speakerId: line.speakerId, delivery, text: line.text });
        }
      }
      return result;
    };
    if (!same(spoken(original.shots), spoken(revisedPlan.shots))) changes.push('节奏修订改变了全片逐字台词顺序、次数、说话者或发声方式；拆片必须完整拼接回原对白');
    return changes;
  }
  const originalShots: unknown[] = original.shots;
  compare(originalShots.length, revisedPlan.shots.length, '$.shots.length');
  originalShots.forEach((value: unknown, index: number): void => {
    const shot = object(value); const revised = object(revisedPlan.shots[index]);
    if (!shot || !revised) return;
    for (const [field, saved] of Object.entries(shot)) {
      if (['prompts', 'sceneReferenceAssetIds'].includes(field)) continue;
      // 与normalizeAnalysisCuts完全相同的无损清理，不将多余绑定误判为剧情漂移。
      if (field === 'previousShotId' && shot.transition === 'cut' && index > 0 && shot.order === index + 1
        && object(originalShots[index - 1])?.order === index && saved === object(originalShots[index - 1])?.id) continue;
      if (['timing', 'timingPlan'].includes(field) && issues.some((issue): boolean => issue.path === `$.shots[${index}].durationSeconds`)) continue;
      compare(saved, revised[field], `$.shots[${index}].${field}`);
    }
  });
  return changes;
}
