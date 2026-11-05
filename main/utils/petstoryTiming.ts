import type { PetStoryPlan, PetStoryValidationIssue } from '@doubao-studio/contracts';
import { petStoryCharacterLabelKey, petStoryCharacterLabelOwners } from './petstoryCharacterLabels';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function issue(path: string, actual: unknown, expected: string, message: string, targetId?: string): PetStoryValidationIssue {
  return { code: 'timing', path, targetId, actual, actualType: actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual, expected, message, repairable: true };
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

/** 仅检查明确的时序与引用矛盾；不把审美、语速估计或空白时间变成门禁。 */
export function collectPetStoryTimingIssues(shot: Record<string, unknown>, path: string, targetId?: string): PetStoryValidationIssue[] {
  if (shot.timingPlan === undefined) return [];
  const issues: PetStoryValidationIssue[] = [];
  const add = (suffix: string, actual: unknown, expected: string, message: string): void => { issues.push(issue(`${path}.timingPlan${suffix}`, actual, expected, message, targetId)); };
  const plan = object(shot.timingPlan);
  if (!plan) return [issue(`${path}.timingPlan`, shot.timingPlan, '时间安排对象或省略', '时间安排必须为对象', targetId)];
  for (const field of ['durationReason', 'cutReason']) if (!nonempty(plan[field])) add(`.${field}`, plan[field], '非空文本', `${field}须说明本镜时长依据或切出位置`);
  if (!finite(plan.estimatedRequiredSeconds) || plan.estimatedRequiredSeconds <= 0 || finite(shot.durationSeconds) && plan.estimatedRequiredSeconds > shot.durationSeconds) add('.estimatedRequiredSeconds', plan.estimatedRequiredSeconds, '大于0且不超过镜长的有限数值', '估计必要时间不能超出本镜时长');
  if (!Array.isArray(plan.events) || !plan.events.length) { add('.events', plan.events, '非空事件数组', '时间安排必须包含必要事件'); return issues; }
  const events = plan.events.map(object);
  const ids = new Set<unknown>(); const dialogueCounts = new Map<number, number>();
  events.forEach((event: Record<string, unknown> | undefined, index: number): void => {
    const prefix = `.events[${index}]`;
    if (!event) { add(prefix, plan.events, '事件对象', '镜内事件必须为对象'); return; }
    if (!nonempty(event.id) || !/^[a-zA-Z0-9_-]{1,80}$/.test(event.id) || ids.has(event.id)) add(`${prefix}.id`, event.id, '镜内唯一稳定ID', '镜内事件ID无效或重复');
    ids.add(event.id);
    if (!['action', 'dialogue', 'reaction', 'sound'].includes(String(event.kind))) add(`${prefix}.kind`, event.kind, 'action、dialogue、reaction或sound', '镜内事件类别无效');
    if (!nonempty(event.description)) add(`${prefix}.description`, event.description, '非空文本', '镜内事件需要具体内容');
    if (!finite(event.startSeconds) || event.startSeconds < 0) add(`${prefix}.startSeconds`, event.startSeconds, '不小于0的有限数值', '事件开始时间无效');
    if (!finite(event.endSeconds) || finite(event.startSeconds) && event.endSeconds <= event.startSeconds || finite(shot.durationSeconds) && event.endSeconds > shot.durationSeconds) add(`${prefix}.endSeconds`, event.endSeconds, '晚于开始且不超过镜长的有限数值', '事件结束时间无效或超出镜长');
    if (event.kind === 'dialogue' || event.dialogueIndex !== undefined) {
      if (event.kind !== 'dialogue' || !Number.isInteger(event.dialogueIndex) || typeof event.dialogueIndex !== 'number' || !Array.isArray(shot.dialogue) || event.dialogueIndex < 0 || event.dialogueIndex >= shot.dialogue.length) add(`${prefix}.dialogueIndex`, event.dialogueIndex, '本镜dialogue数组的0起有效索引，且kind为dialogue', '发声事件引用了未知台词');
      else dialogueCounts.set(event.dialogueIndex, (dialogueCounts.get(event.dialogueIndex) || 0) + 1);
    }
    if (event.afterEventId !== undefined) {
      const previous = events.find((candidate): boolean => candidate?.id === event.afterEventId);
      if (!previous || previous === event || !finite(previous.endSeconds) || !finite(event.startSeconds) || event.startSeconds < previous.endSeconds) add(`${prefix}.afterEventId`, event.afterEventId, '本镜已结束的前置事件ID', '顺序事件不能在前置事件完成前开始');
    }
  });
  const end = Math.max(...events.map((event): number => finite(event?.endSeconds) ? event.endSeconds : 0));
  if (finite(plan.estimatedRequiredSeconds) && end > plan.estimatedRequiredSeconds) add('.estimatedRequiredSeconds', plan.estimatedRequiredSeconds, `不早于必要事件终点${end}`, '估计必要时间早于已安排的必要事件终点');
  if (Array.isArray(shot.dialogue)) shot.dialogue.forEach((_: unknown, index: number): void => {
    if (dialogueCounts.get(index) !== 1) add('.events', plan.events, `dialogue[${index}]恰有一次发声事件`, '本镜台词在时间安排中遗漏或重复');
  });
  return issues;
}

/** 完整原句未提供任何区间时，只补可确定的字符边界；已提供范围及片段绝不猜测或纠正。 */
export function normalizePetStoryDialogueSource(line: Record<string, unknown>): unknown {
  const source = object(line.source);
  if (!source || typeof source.text !== 'string' || line.text !== source.text || Object.hasOwn(source, 'start') || Object.hasOwn(source, 'end')) return line.source;
  return { ...source, start: 0, end: Array.from(source.text).length };
}

export function collectPetStoryDialogueFragmentIssues(line: Record<string, unknown>, path: string, targetId?: string): PetStoryValidationIssue[] {
  if (line.source === undefined) return [];
  const source = object(normalizePetStoryDialogueSource(line));
  const chars = source && typeof source.text === 'string' ? Array.from(source.text) : undefined;
  const expected = chars ? `原句共${chars.length}个Unicode字符；完整原句应start=0、end=${chars.length}，片段使用有效半开区间，occurrence从1起` : '完整原句、1起出现次数及有效Unicode字符半开区间';
  if (!source || !nonempty(source.text) || !Number.isInteger(source.occurrence) || typeof source.occurrence !== 'number' || source.occurrence < 1 || !Number.isInteger(source.start) || typeof source.start !== 'number' || source.start < 0 || !Number.isInteger(source.end) || typeof source.end !== 'number' || source.end <= source.start || source.end > Array.from(source.text).length) return [issue(`${path}.source`, line.source, expected, '台词来源或切片区间无效', targetId)];
  const fragment = Array.from(source.text).slice(source.start, source.end).join('');
  return fragment === line.text ? [] : [issue(`${path}.text`, line.text, `${expected}；当前区间实际片段为${JSON.stringify(fragment)}，须逐字相同`, '台词片段与原句来源不符', targetId)];
}

/** 回到完整原文核对来源，保持相同原句不同出现和长句不同片段的区别。 */
export function collectPetStoryDialogueSourceIssues(plan: PetStoryPlan, originalText: string): PetStoryValidationIssue[] {
  if (!plan.shots.some((shot): boolean => !!shot.timingPlan || !!shot.dialogue?.some((line): boolean => !!line.source))) return [];
  const issues: PetStoryValidationIssue[] = [];
  const groups = new Map<string, { text: string; occurrence: number; end: number; speakerId: string; delivery: string; path: string; targetId: string }>();
  const occurrences = new Map<string, number>();
  plan.shots.forEach((shot, shotIndex: number): void => shot.dialogue?.forEach((line, lineIndex: number): void => {
    const path = `$.shots[${shotIndex}].dialogue[${lineIndex}]`;
    if (!line.source) { if (shot.timingPlan) issues.push(issue(`${path}.source`, undefined, '逐字原句及本次出现和片段范围', '新时间方案的台词缺少原文来源', shot.id)); return; }
    const source = line.source;
    if (source.occurrence < (occurrences.get(source.text) || 1)) issues.push(issue(`${path}.source.occurrence`, source.occurrence, '保持原文中各次出现的顺序', '重复原台词的出现顺序错误', shot.id));
    occurrences.set(source.text, source.occurrence);
    const count = originalText.split(source.text).length - 1;
    if (source.occurrence > count) issues.push(issue(`${path}.source`, source, '完整原故事中真实存在的原句及出现次数', '台词来源在完整原剧本中不存在', shot.id));
    const key = JSON.stringify([source.text, source.occurrence]); const saved = groups.get(key);
    if (source.start !== (saved?.end || 0)) issues.push(issue(`${path}.source.start`, source.start, `前一片段结尾${saved?.end || 0}`, '同一次原台词存在遗漏、重复或顺序错误', shot.id));
    if (saved && (saved.speakerId !== line.speakerId || saved.delivery !== (line.delivery || 'onscreen'))) issues.push(issue(path, line, '同一次原台词保持说话者及发声方式', '原台词片段改变了说话者或发声方式', shot.id));
    groups.set(key, { text: source.text, occurrence: source.occurrence, end: source.end, speakerId: line.speakerId, delivery: line.delivery || 'onscreen', path, targetId: shot.id });
  }));
  for (const group of groups.values()) if (group.end !== Array.from(group.text).length) issues.push(issue(`${group.path}.source.end`, group.end, `完整原句字符数${Array.from(group.text).length}`, '原台词末尾片段遗漏', group.targetId));
  const owners = petStoryCharacterLabelOwners(plan.characters);
  // 仅识别明确引号对白和“已登记姓名：整行台词”。带镜头标题、表演叙述的混合行不猜切点。
  const quoted = [...originalText.matchAll(/(?:^|[\n\r])\s*([^\n\r：:“”"]{1,40})(?:（[^\n\r]*?）)?[：:]\s*[“"]([^”"\n\r]+)[”"]/gu)];
  const explicit: { text: string; speaker: string; position: number }[] = quoted.map((match: RegExpMatchArray): { text: string; speaker: string; position: number } => ({
    text: match[2], speaker: match[1].trim().replace(/[（(][^（）()]*[）)]$/u, '').trim(), position: (match.index || 0) + match[0].lastIndexOf(match[2]),
  }));
  const unquoted = [...originalText.matchAll(/(?:^|[\n\r])([^\n\r：:]{1,80})[：:]([^\n\r]+)/gu)];
  for (const match of unquoted) {
    const speaker = match[1].trim(); const text = match[2].trim();
    if (!text || /^[“"「『]/u.test(text) || owners.get(petStoryCharacterLabelKey(speaker))?.length !== 1) continue;
    explicit.push({ text, speaker, position: (match.index || 0) + match[0].lastIndexOf(text) });
  }
  for (const { text, speaker, position } of explicit) {
    const occurrence = originalText.slice(0, position).split(text).length;
    if (!groups.has(JSON.stringify([text, occurrence]))) issues.push(issue('$.shots', { text, occurrence }, '完整原故事中每次明确标注的逐字对白', '原剧本明确对白遗漏或未建立本次出现的来源'));
    const ids = owners.get(petStoryCharacterLabelKey(speaker)); const actual = groups.get(JSON.stringify([text, occurrence]));
    if (ids?.length === 1 && actual && actual.speakerId !== ids[0]) issues.push(issue(`${actual.path}.speakerId`, actual.speakerId, `原文明确说话者${ids[0]}`, '台词归属与原剧本明确说话者不符', actual.targetId));
  }
  return issues;
}
