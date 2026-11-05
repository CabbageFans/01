/** 从原五镜头派生的离线技术用例；不是新豆包回复或创作质量验收。 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PetStoryPlan, PetStoryShot, PetStoryTimingPlan } from '@doubao-studio/contracts';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { collectPetStoryDialogueSourceIssues, collectPetStoryPlanIssues, planRepairPreservationIssues, validatePetStoryPlan } from '../../main/utils/petstoryValidation';
import { PetStoryProjects } from '../../main/utils/petstoryProject';

function plan(): PetStoryPlan { return structuredClone(snapshot.plan) as PetStoryPlan; }
function timing(duration: number): PetStoryTimingPlan {
  return { events: [{ id: 'action', kind: 'action', description: '沿原动作完成一次', startSeconds: 0, endSeconds: duration - 0.5 }], estimatedRequiredSeconds: duration - 0.5, durationReason: '必要动作与自然表演所需', cutReason: '动作结果交付时切出' };
}
function timedPlan(duration = 6): PetStoryPlan {
  const p = plan();
  p.shots.forEach((shot: PetStoryShot): void => { shot.dialogue = []; shot.durationSeconds = duration; shot.timingPlan = timing(duration); });
  return p;
}
function dialogue(text: string, full = text, start = 0, end = Array.from(text).length, occurrence = 1): NonNullable<PetStoryShot['dialogue']>[number] {
  return { speakerId: 'lulu', text, tone: '原语气', pace: '自然', source: { text: full, start, end, occurrence } };
}
function attachDialogue(p: PetStoryPlan, lines: NonNullable<PetStoryShot['dialogue']>, index = 0): void {
  const shot = p.shots[index]; shot.characterIds = ['lulu']; shot.dialogue = lines;
  shot.timingPlan!.events.push(...lines.map((_: unknown, lineIndex: number): PetStoryTimingPlan['events'][number] => ({ id: `speech_${lineIndex}`, kind: 'dialogue', description: '按自然发声安排原对白', startSeconds: lineIndex, endSeconds: lineIndex + 2, dialogueIndex: lineIndex })));
}

describe('5～10秒与轻量镜内时间结构', (): void => {
  it.each([5, 6, 7, 8, 9, 10])('合法%d秒完整保留时间安排与前身，不改写输入', (duration: number): void => {
    const input = timedPlan(duration); input.shots[0].predecessorShotIds = ['previous_a', 'previous_b'];
    const saved = structuredClone(input); const parsed = validatePetStoryPlan(input, true);
    expect(parsed.shots[0].timingPlan).toEqual(input.shots[0].timingPlan);
    expect(parsed.shots[0].predecessorShotIds).toEqual(['previous_a', 'previous_b']); expect(input).toEqual(saved);
  });
  it.each([4, 11, 15, 5.5, '5', Infinity, -Infinity, NaN])('非法时长%s不夹取为合法值', (duration: unknown): void => {
    const p = timedPlan(); const input = { ...p, shots: [{ ...p.shots[0], durationSeconds: duration }] };
    expect(collectPetStoryPlanIssues(input)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'duration', actual: duration })]));
    expect((): PetStoryPlan => validatePetStoryPlan(input)).toThrow('5～10');
  });
  it('说话和动作可重叠，按同一时间跨度安排而不把秒数相加', (): void => {
    const p = timedPlan(5); attachDialogue(p, [dialogue('你好')]);
    p.shots[0].timingPlan!.events[0].endSeconds = 4.5;
    expect(collectPetStoryPlanIssues(p)).toEqual([]);
    expect(p.shots[0].timingPlan!.estimatedRequiredSeconds).toBe(4.5);
  });
  it('显式必须等待的动作不能与前置对白重叠', (): void => {
    const p = timedPlan(); attachDialogue(p, [dialogue('先听我说完')]);
    p.shots[0].timingPlan!.events[0].afterEventId = 'speech_0';
    expect(collectPetStoryPlanIssues(p)).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('前置事件完成前') })]));
    p.shots[0].timingPlan!.events[0].startSeconds = 2;
    expect(collectPetStoryPlanIssues(p)).toEqual([]);
  });
  it.each(['negative', 'reverse', 'overflow', 'nonfinite', 'unknown', 'repeat', 'span'])('检测明确时间矛盾：%s', (kind: string): void => {
    const p = timedPlan(); attachDialogue(p, [dialogue('原句')]); const tp = p.shots[0].timingPlan!;
    if (kind === 'negative') tp.events[0].startSeconds = -1;
    if (kind === 'reverse') tp.events[0].endSeconds = 0;
    if (kind === 'overflow') tp.events[0].endSeconds = 7;
    if (kind === 'nonfinite') tp.events[0].endSeconds = NaN;
    if (kind === 'unknown') tp.events[1].dialogueIndex = 2;
    if (kind === 'repeat') tp.events.push({ ...tp.events[1], id: 'repeated' });
    if (kind === 'span') tp.estimatedRequiredSeconds = 1;
    expect(collectPetStoryPlanIssues(p).some((issue): boolean => issue.code === 'timing')).toBe(true);
    expect((): PetStoryPlan => validatePetStoryPlan(p)).toThrow();
  });
  it('旧方案没有新时间字段仍正常打开', (): void => { expect(validatePetStoryPlan(plan()).shots).toHaveLength(snapshot.plan.shots.length); });
});

describe('原句出现与Unicode片段的逐字覆盖', (): void => {
  it('完整原句仅省略全部区间时确定性计算Unicode边界，解析保存重开保持canonical必需范围', async (): Promise<void> => {
    const p = timedPlan(); const text = '𠮷安，照原话说。'; attachDialogue(p, [dialogue(text)]);
    const rawSource = p.shots[0].dialogue![0].source! as unknown as Record<string, unknown>; delete rawSource.start; delete rawSource.end;
    const raw = structuredClone(p); expect(collectPetStoryPlanIssues(p)).toEqual([]);
    const parsed = validatePetStoryPlan(p, true);
    expect(parsed.shots[0].dialogue![0].source).toEqual({ text, occurrence: 1, start: 0, end: Array.from(text).length });
    expect(p).toEqual(raw); expect(collectPetStoryDialogueSourceIssues(parsed, text)).toEqual([]);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-canonical-dialogue-source-'));
    try {
      const projects = new PetStoryProjects(); let project = await projects.create(directory, 'TEST-source-studio', 'TEST-source-account');
      project = await projects.saveMobileStory(project.id, project.revision, text); project.plan = parsed; project = await projects.write(project);
      project = await projects.savePlan(project.id, project.revision, parsed);
      const reopened = await new PetStoryProjects().open(directory);
      expect(reopened.plan!.shots[0].dialogue![0].source).toEqual(parsed.shots[0].dialogue![0].source);
      expect(reopened.plan!.shots[0].dialogue![0].text).toBe(text);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  it.each(['start', 'end', 'fragment', 'wrong', 'explicit-undefined'])('不替缺失或错误范围%s猜测切片，也不改写原文', (kind: string): void => {
    const p = timedPlan(); attachDialogue(p, [dialogue('完整原句')]);
    const line = p.shots[0].dialogue![0]; const source = line.source! as unknown as Record<string, unknown>;
    if (kind === 'start') delete source.start;
    if (kind === 'end') delete source.end;
    if (kind === 'fragment') { line.text = '完整'; delete source.start; delete source.end; }
    if (kind === 'wrong') source.end = 3;
    if (kind === 'explicit-undefined') { source.start = undefined; delete source.end; }
    const before = structuredClone(p); expect((): PetStoryPlan => validatePetStoryPlan(p, true)).toThrow(); expect(p).toEqual(before);
  });
  it('完整句补边界后仍严格检查原文出现次数和说话者', (): void => {
    const p = timedPlan(); const text = '原句'; attachDialogue(p, [dialogue(text)]);
    const source = p.shots[0].dialogue![0].source! as unknown as Record<string, unknown>; delete source.start; delete source.end;
    source.occurrence = 0; expect((): PetStoryPlan => validatePetStoryPlan(p, true)).toThrow('台词来源');
    source.occurrence = 2; expect(collectPetStoryDialogueSourceIssues(validatePetStoryPlan(p, true), text).some((issue): boolean => issue.message.includes('不存在'))).toBe(true);
    source.occurrence = 1; const speaker = p.characters.find((character): boolean => character.id === 'lumei')!.name;
    expect(collectPetStoryDialogueSourceIssues(validatePetStoryPlan(p, true), `${speaker}：“${text}”`).some((issue): boolean => issue.message.includes('说话者'))).toBe(true);
  });
  it('长对白自然分片完整拼接，原文台词只发声一次', (): void => {
    const p = timedPlan(); const full = '先完成这件事，再告诉我结果。'; const split = 7;
    attachDialogue(p, [dialogue(Array.from(full).slice(0, split).join(''), full, 0, split)]);
    attachDialogue(p, [dialogue(Array.from(full).slice(split).join(''), full, split, Array.from(full).length)], 1);
    expect(collectPetStoryDialogueSourceIssues(p, full)).toEqual([]);
    expect(validatePetStoryPlan(p).shots[1].dialogue?.[0].source?.start).toBe(split);
  });
  it.each(['missing', 'overlap', 'speaker', 'text', 'order'])('拒绝分片%s', (kind: string): void => {
    const p = timedPlan(); const full = '前半句后半句';
    attachDialogue(p, [dialogue('前半句', full, 0, 3)]); attachDialogue(p, [dialogue('后半句', full, 3, 6)], 1);
    if (kind === 'missing') p.shots[1].dialogue = [];
    if (kind === 'overlap') p.shots[1].dialogue![0].source!.start = 2;
    if (kind === 'speaker') p.shots[1].dialogue![0].speakerId = 'lumei';
    if (kind === 'text') p.shots[1].dialogue![0].text = '改词';
    if (kind === 'order') { const line = p.shots[0].dialogue![0]; p.shots[0].dialogue![0] = p.shots[1].dialogue![0]; p.shots[1].dialogue![0] = line; }
    expect([...collectPetStoryPlanIssues(p), ...collectPetStoryDialogueSourceIssues(p, full)].length).toBeGreaterThan(0);
  });
  it('明确重复对白分别绑定出现序号，遗漏第二次可诊断', (): void => {
    const p = timedPlan(); const source = '人物甲：“别动！”\n人物甲：“别动！”';
    attachDialogue(p, [dialogue('别动！')]);
    expect(collectPetStoryDialogueSourceIssues(p, source).some((issue): boolean => issue.message.includes('本次出现'))).toBe(true);
    attachDialogue(p, [dialogue('别动！', '别动！', 0, 3, 2)], 1);
    expect(collectPetStoryDialogueSourceIssues(p, source)).toEqual([]);
  });
  it('原文中叙述对同句的重复引用不自动当再次发声', (): void => {
    const p = timedPlan(); attachDialogue(p, [dialogue('别动！')]);
    expect(collectPetStoryDialogueSourceIssues(p, '他说“别动！”。\n这一声“别动！”改变了局面。')).toEqual([]);
  });
  it('原剧本独立无引号对白可查遗漏和重复，混合镜头行不吞尾部动作', (): void => {
    // 原222字剧本的两行派生，仍是离线解析技术用例，不是新创作结果。
    const source = '小伙：这啥呀？咋恁臭啊！\n【11-14s｜双人镜头】黑衣男得意：看，我说你踩住屎了吧！你还不信！转身快步走开';
    const p = timedPlan(); p.characters.find((character): boolean => character.id === 'lulu')!.aliases = ['小伙'];
    const line = dialogue('这啥呀？咋恁臭啊！'); attachDialogue(p, [line]);
    expect(collectPetStoryDialogueSourceIssues(p, source)).toEqual([]);
    p.shots[0].dialogue = [];
    expect(collectPetStoryDialogueSourceIssues(p, source)).toEqual([expect.objectContaining({ message: expect.stringContaining('对白遗漏'), actual: { text: line.text, occurrence: 1 } })]);
    attachDialogue(p, [line]); attachDialogue(p, [structuredClone(line)], 1);
    expect(collectPetStoryDialogueSourceIssues(p, source).some((issue): boolean => issue.message.includes('遗漏、重复或顺序'))).toBe(true);
  });
  it('无引号的两次独立原对白分别保留，未知叙述标签不推断为对白', (): void => {
    const p = timedPlan(); p.characters.find((character): boolean => character.id === 'lulu')!.aliases = ['小伙'];
    const line = dialogue('这啥呀？咋恁臭啊！'); const source = `小伙：${line.text}\n小伙：${line.text}\n旁注：人物正在走开`;
    attachDialogue(p, [line]);
    expect(collectPetStoryDialogueSourceIssues(p, source).some((issue): boolean => issue.message.includes('本次出现'))).toBe(true);
    attachDialogue(p, [dialogue(line.text, line.text, 0, Array.from(line.text).length, 2)], 1);
    expect(collectPetStoryDialogueSourceIssues(p, source)).toEqual([]);
  });
  it('明确说话者不能换人，未知引语人物不猜测', (): void => {
    const p = timedPlan(); attachDialogue(p, [dialogue('原话')]);
    const name = p.characters.find((character): boolean => character.id === 'lumei')!.name;
    expect(collectPetStoryDialogueSourceIssues(p, `${name}：“原话”`).some((issue): boolean => issue.message.includes('说话者'))).toBe(true);
  });
  it('Unicode字符区间不切断增补平面字符', (): void => {
    const p = timedPlan(); attachDialogue(p, [dialogue('𠮷', '𠮷安', 0, 1), dialogue('安', '𠮷安', 1, 2)]);
    expect(validatePetStoryPlan(p).shots[0].dialogue?.[0].text).toBe('𠮷');
    expect(collectPetStoryDialogueSourceIssues(p, '𠮷安')).toEqual([]);
  });
  it('完整句区间计数错误给出确定字符数与实际切片，程序不改原台词或数字', (): void => {
    const p = timedPlan(); const text = '看，我说你踩住屎了吧！你还不信！'; const length = Array.from(text).length;
    attachDialogue(p, [dialogue(text, text, 0, length - 1)]); const before = structuredClone(p);
    const found = collectPetStoryPlanIssues(p).find((issue): boolean => issue.path === '$.shots[0].dialogue[0].text');
    expect(found?.expected).toContain(`共${length}个Unicode字符`); expect(found?.expected).toContain(`start=0、end=${length}`);
    expect(found?.expected).toContain(JSON.stringify(Array.from(text).slice(0, length - 1).join(''))); expect(p).toEqual(before);
  });
  it('节奏授权修订允许合理拆合，但保留对白原文顺序次数和发声对象', (): void => {
    const before = timedPlan(); attachDialogue(before, [dialogue('原句前半后半')]);
    const after = structuredClone(before); after.shots[0].dialogue = [dialogue('原句前半', '原句前半后半', 0, 4)];
    after.shots[1].dialogue = [dialogue('后半', '原句前半后半', 4, 6)]; after.shots.pop();
    expect(planRepairPreservationIssues(before, after, [], { allowShotRestructure: true })).toEqual([]);
    expect(planRepairPreservationIssues(before, after, [])).not.toEqual([]);
    after.shots[1].dialogue![0].text = '删改';
    expect(planRepairPreservationIssues(before, after, [], { allowShotRestructure: true })).not.toEqual([]);
  });
});
