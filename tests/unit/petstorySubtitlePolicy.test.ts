/** 离线约束回归；沿用既有故事夹具，不代表豆包创作或媒体验收。 */
import { describe, expect, it } from 'vitest';
import type { PetStoryChatJob, PetStoryProject, PetStoryPromptTaskContract } from '@doubao-studio/contracts';
import { subtitlePolicyIssues } from '../../main/utils/petstorySubtitlePolicy';
import { runtimePromptIssues } from '../../main/utils/petstoryValidation';
import examples from '../fixtures/petstory-prompt-quality.json';

const equivalentBans: string[] = [
  '全程无字幕、无对白文字叠加。',
  '全程无字幕，不叠加对白文字。',
  '不生成字幕，也不要将对白以文字叠加在画面上。',
  '全程无字幕；\n无对白文字叠加',
];

function runtimeFixture(dialect: PetStoryPromptTaskContract['dialect']): { project: PetStoryProject; job: PetStoryChatJob } {
  const project = structuredClone(examples[0].project) as unknown as PetStoryProject;
  const shot = project.plan!.shots[0];
  const job: PetStoryChatJob = { id: 'TEST-subtitle-check', taskId: 'TEST-offline', kind: 'optimize', status: 'bound',
    shotId: shot.id, promptKind: 'video', inputHash: 'TEST', sourceUrl: project.source.url,
    promptTask: { dialect, mode: 'reference', references: [{ assetId: 'TEST-first', purpose: 'firstFrame', characterIds: shot.characterIds, order: 1 }] } };
  return { project, job };
}

describe('有限且明确的无字幕等价表达', (): void => {
  it.each(equivalentBans)('接受同义约束及标点差异：%s', (body: string): void => {
    expect(subtitlePolicyIssues(body)).toEqual([]);
  });
  it.each([
    ['只有水印限制', '无水印。', /无字幕/, /对白文字叠加/],
    ['遗漏对白文字限制', '全程无字幕、无水印。', /对白文字叠加/, undefined],
    ['遗漏字幕限制', '无对白文字叠加、无水印。', /无字幕/, undefined],
    ['否定禁令不算禁止', '不要求无字幕，无对白文字叠加。', /无字幕/, undefined],
    ['双重否定不算禁止', '不禁止生成字幕，无对白文字叠加。', /无字幕/, /冲突/],
  ] as const)('%s不能假装通过', (_label: string, body: string, first: RegExp, second: RegExp | undefined): void => {
    const issues = subtitlePolicyIssues(body).join('\n');
    expect(issues).toMatch(first); if (second) expect(issues).toMatch(second);
  });
  it.each([
    '最后添加字幕。', '同时生成对白字幕。', '结尾出现字幕。', '要求字幕。',
    '将对白以文字叠加在画面上。', '同时叠加对白文字。',
  ])('同时要求相反字幕行为时仍阻断：%s', (conflict: string): void => {
    expect(subtitlePolicyIssues(`${equivalentBans[0]}${conflict}`).join('\n')).toContain('冲突');
  });
  it('获准画内文字不被当作对白字幕，角色台词也不充当约束', (): void => {
    expect(subtitlePolicyIssues(`${equivalentBans[1]}招牌保留来源确认的文字及其承载面。`)).toEqual([]);
    expect(subtitlePolicyIssues('{噜妹用中文说：“全程无字幕、无对白文字叠加。”}')).toHaveLength(2);
  });
});

describe('专用正文校验使用同一语义约束，其他严格校验继续有效', (): void => {
  it.each(['seedance20', 'seedance25'] as const)('%s采用前接受有限等价表达，不要求固定句', (dialect: 'seedance20' | 'seedance25'): void => {
    const { project, job } = runtimeFixture(dialect);
    for (const constraint of equivalentBans) expect(runtimePromptIssues(project, job, `@图片1作为本镜首帧参考。${constraint}`)).toEqual([]);
  });
  it('等价禁令不能放过错编号或XML声音标签，也不凭声音词推断内容错误', (): void => {
    const { project, job } = runtimeFixture('seedance20');
    const constraint = equivalentBans[2];
    expect(runtimePromptIssues(project, job, `@图片9作为本镜首帧参考。${constraint}`).join('\n')).toMatch(/编号|标签/);
    expect(runtimePromptIssues(project, job, `@图片1作为本镜首帧参考。<声音>环境声</声音>。${constraint}`).join('\n')).toContain('XML');
    expect(runtimePromptIssues(project, job, `@图片1作为本镜首帧参考。<环境声>。${constraint}`)).toEqual([]);
    expect(runtimePromptIssues(project, job, `@图片1作为本镜首帧参考。声音与表演完整性仍交内容审查。${constraint}`)).toEqual([]);
  });
  it.each(['环境声', '音效', 'sound'])('单对尖括号规则同样拒绝明确的%s XML闭合标签', (tag: string): void => {
    const { project, job } = runtimeFixture('seedance25');
    expect(runtimePromptIssues(project, job, `@图片1作为本镜首帧参考。<${tag}>声音内容</${tag}>。${equivalentBans[1]}`).join('\n')).toContain('XML');
  });
  it('Seedream图片与generic计划不机械套视频字幕句', (): void => {
    for (const dialect of ['seedream', 'generic'] as const) {
      const { project, job } = runtimeFixture(dialect); job.promptKind = 'firstFrame';
      expect(runtimePromptIssues(project, job, '第1张参考图控制本镜起始状态。')).toEqual([]);
    }
  });
});
