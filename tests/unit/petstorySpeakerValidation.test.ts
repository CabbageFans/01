/** 角色身份按已保存标签严格解析；括号别名兼容不改写原台词或放宽发声契约。 */
import { describe, expect, it } from 'vitest';
import type { PetStoryCharacter, PetStoryChatJob, PetStoryProject, PetStoryPromptTaskContract } from '@doubao-studio/contracts';
import { seedanceSpeakerLabels } from '../../main/utils/petstoryCharacterLabels';
import { runtimePromptIssues } from '../../main/utils/petstoryValidation';
import examples from '../fixtures/petstory-prompt-quality.json';

const originalLine = '我说你踩住屎了吧！你还不信！';

function character(id: string, name: string, aliases: string[] = []): PetStoryCharacter {
  return { id, name, aliases, role: 'main', purpose: 'TEST剧情身份', description: 'TEST外观' };
}

function fixture(dialect: PetStoryPromptTaskContract['dialect'] = 'seedance20'): { project: PetStoryProject; job: PetStoryChatJob } {
  const project = structuredClone(examples[0].project) as unknown as PetStoryProject;
  project.plan!.characters = [character('ch01', '噜哥', ['白衣女子']), character('ch02', '噜妹（黑衣男子）', ['黑衣男子'])];
  const shot = project.plan!.shots[0];
  shot.characterIds = ['ch02'];
  shot.dialogue = [{ speakerId: 'ch02', text: originalLine, tone: 'TEST语气', pace: 'TEST节奏' }];
  const job: PetStoryChatJob = { id: 'TEST-speaker-check', taskId: 'TEST-offline', kind: 'optimize', status: 'bound',
    shotId: shot.id, promptKind: 'video', inputHash: 'TEST', sourceUrl: project.source.url,
    promptTask: { dialect, mode: 'first_frame', references: [] } };
  return { project, job };
}

function body(label: string, line: string = originalLine, language: string = '中文'): string {
  return `TEST完整画面与动作。{${label}用${language}说：“${line}”} 全程无字幕、无对白文字叠加。`;
}

describe('Seedance 说话者标签绑定唯一已保存角色', (): void => {
  it.each(['seedance20', 'seedance25'] as const)('%s接受完整名、明确别名和可由括号别名证明的主名', (dialect: 'seedance20' | 'seedance25'): void => {
    const { project, job } = fixture(dialect);
    for (const label of ['噜妹（黑衣男子）', '黑衣男子', '噜妹']) expect(runtimePromptIssues(project, job, body(label))).toEqual([]);
    expect(seedanceSpeakerLabels(project.plan!.characters, 'ch02')).toEqual(['噜妹（黑衣男子）', '黑衣男子', '噜妹']);
  });

  it('英文括号和已登记标签的字符宽度规范不影响同一角色身份', (): void => {
    const { project, job } = fixture();
    project.plan!.characters[1].name = '噜妹(黑衣男子)';
    for (const label of ['噜妹(黑衣男子)', '噜妹（黑衣男子）', '噜妹']) expect(runtimePromptIssues(project, job, body(label))).toEqual([]);
  });

  it.each([{ aliases: [] }, { aliases: ['男子'] }, { aliases: ['其他来源称谓'] }])('括号内容未精确登记为别名时不推断主名：$aliases', ({ aliases }: { aliases: string[] }): void => {
    const { project, job } = fixture(); project.plan!.characters[1].aliases = aliases;
    const issues = runtimePromptIssues(project, job, body('噜妹')).join('\n');
    expect(issues).toContain('说话者不匹配'); expect(issues).toContain('标签未登记'); expect(issues).not.toContain('未按花括号');
    expect(runtimePromptIssues(project, job, body('噜妹（黑衣男子）'))).toEqual([]);
  });

  it.each(['噜', '噜妹姐姐', '噜妹（严肃地）', '黑衣'])('未登记简称或临时括号修饰不当作角色身份：%s', (label: string): void => {
    const { project, job } = fixture();
    const issues = runtimePromptIssues(project, job, body(label)).join('\n');
    expect(issues).toContain('标签未登记'); expect(issues).toContain('说话者不匹配'); expect(issues).not.toContain('未按花括号');
  });

  it.each(['full_name', 'alias', 'derived_name'] as const)('全局其他角色通过%s占用同一主名时拒绝歧义，不因其未入镜而放行', (source: 'full_name' | 'alias' | 'derived_name'): void => {
    const { project, job } = fixture();
    project.plan!.characters[0] = source === 'full_name' ? character('ch01', '噜妹')
      : source === 'alias' ? character('ch01', '噜哥', ['噜妹']) : character('ch01', '噜妹（白衣女子）', ['白衣女子']);
    expect(runtimePromptIssues(project, job, body('噜妹')).join('\n')).toContain('标签存在歧义');
    expect(seedanceSpeakerLabels(project.plan!.characters, 'ch02')).not.toContain('噜妹');
    expect(runtimePromptIssues(project, job, body('噜妹（黑衣男子）'))).toEqual([]);
  });

  it.each(['噜妹（黑衣男子）', '黑衣男子'])('完整名和显式别名同样必须全局唯一：%s', (label: string): void => {
    const { project, job } = fixture(); project.plan!.characters[0].aliases = [label];
    expect(runtimePromptIssues(project, job, body(label)).join('\n')).toContain('标签存在歧义');
  });
});

describe('角色标签兼容保持台词内容、语言和发声次数严格校验', (): void => {
  it('合法声音块使用错误角色时明确报说话者问题', (): void => {
    const { project, job } = fixture();
    const issues = runtimePromptIssues(project, job, body('噜哥')).join('\n');
    expect(issues).toContain('说话者不匹配'); expect(issues).toContain('不是该角色已确认的逐字台词'); expect(issues).not.toContain('未按花括号');
  });

  it('没有声音块时仍准确要求花括号格式', (): void => {
    const { project, job } = fixture();
    expect(runtimePromptIssues(project, job, `噜妹说：“${originalLine}” 全程无字幕、无对白文字叠加。`).join('\n')).toContain('未按花括号声音格式');
  });

  it('中文台词即使身份正确也不得改用其他语言声明', (): void => {
    const { project, job } = fixture();
    const issues = runtimePromptIssues(project, job, body('噜妹', originalLine, '英文')).join('\n');
    expect(issues).toContain('台词语言不匹配'); expect(issues).not.toContain('未按花括号');
  });

  it('台词必须逐字保留，不能把原台词放在声音块外充数', (): void => {
    const { project, job } = fixture();
    expect(runtimePromptIssues(project, job, body('噜妹', '你踩到东西了！')).join('\n')).toContain('遗漏已确认原台词');
    const issues = runtimePromptIssues(project, job, `${originalLine} ${body('噜妹', '你踩到东西了！')}`).join('\n');
    expect(issues).toContain('未按花括号声音格式'); expect(issues).toContain('不是该角色已确认的逐字台词');
  });

  it('同一角色混用完整名和主名仍按角色ID累计，额外发声不放过', (): void => {
    const { project, job } = fixture();
    const repeated = `${body('噜妹')} {噜妹（黑衣男子）用中文说：“${originalLine}”}`;
    expect(runtimePromptIssues(project, job, repeated).join('\n')).toContain('应发声1次，实际2次');
    project.plan!.shots[0].dialogue!.push({ ...project.plan!.shots[0].dialogue![0] });
    expect(runtimePromptIssues(project, job, repeated)).toEqual([]);
  });

  it('已有一次正确发声也不能掩盖额外的错角色声音块', (): void => {
    const { project, job } = fixture();
    expect(runtimePromptIssues(project, job, `${body('噜妹')} {噜哥用中文说：“${originalLine}”}`).join('\n')).toContain('不是该角色已确认的逐字台词');
  });

  it('同句原台词属于两个角色时分别计数，不混淆身份', (): void => {
    const { project, job } = fixture();
    project.plan!.shots[0].dialogue!.push({ ...project.plan!.shots[0].dialogue![0], speakerId: 'ch01' });
    expect(runtimePromptIssues(project, job, `${body('噜妹')} {噜哥用中文说：“${originalLine}”}`)).toEqual([]);
  });
});
