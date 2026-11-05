import { describe, expect, it } from 'vitest';
import type { PetStoryChatJob, PetStoryProject } from '@doubao-studio/contracts';
import { stalledAutomaticRepairMessage } from '../../main/utils/petstoryRepairProgress';

function failed(id: string, parent?: string, change?: string): PetStoryChatJob {
  return { id, taskId: `task-${id}`, requestId: id, inputHash: 'test', sourceUrl: 'test', kind: parent ? 'repair' : 'analysis',
    status: 'invalid', parentJobId: parent, repairMode: parent ? 'automatic' : undefined,
    rawText: JSON.stringify({ requestId: id, targetIds: ['plan'], storyUsable: true, reason: `TEST本轮回执${id}`, ignored: `TEST模型额外回执${id}`, shots: [{ id: 'merged', predecessorShotIds: ['merged', 'old'], action: change || 'TEST完整动作' }] }),
    validationDetails: [{ code: 'structure', path: '$.shots[0].predecessorShotIds', expected: '不能包含自身', actualType: 'array', actual: ['merged', 'old'], repairable: true, message: 'TEST自身前身' }] };
}
function project(jobs: PetStoryChatJob[]): PetStoryProject { return { jobs } as PetStoryProject; }

describe('自动修订进展判定', (): void => {
  it('三份完整内容与实际错误相同才停止，传输标识和JSON键序不算进展', (): void => {
    const jobs = [failed('root'), failed('r1', 'root'), failed('r2', 'r1')];
    const reply = JSON.parse(jobs[2].rawText!) as Record<string, unknown>;
    jobs[2].rawText = `\n\`\`\`json\n${JSON.stringify({ shots: reply.shots, reason: reply.reason, storyUsable: true, targetIds: reply.targetIds, requestId: reply.requestId }, null, 2)}\n\`\`\``;
    jobs[2].validationDetails![0].expected += ' TEST新版诊断增加解释';
    expect(stalledAutomaticRepairMessage(project(jobs), jobs[1])).toBeUndefined();
    expect(stalledAutomaticRepairMessage(project(jobs), jobs[2])).toContain('自动修订没有进展');
  });

  it.each(['body', 'actual', 'fewer-issues', 'explicit'] as const)('有%s变化时继续观察，不以相同报错或总轮数判定停滞', (change: string): void => {
    const jobs = Array.from({ length: 12 }, (_value: unknown, index: number): PetStoryChatJob => failed(`r${index}`, index ? `r${index - 1}` : undefined, `TEST改善${index}`));
    const latest = jobs.at(-1)!; const previous = jobs.at(-2)!;
    if (change !== 'body') latest.rawText = previous.rawText!.replace(previous.requestId!, latest.requestId!);
    if (change === 'actual') latest.validationDetails![0].actual = ['merged'];
    if (change === 'fewer-issues') previous.validationDetails!.push({ ...previous.validationDetails![0], path: '$.shots[1].id' });
    if (change === 'explicit') latest.repairMode = 'explicit';
    expect(stalledAutomaticRepairMessage(project(jobs), latest)).toBeUndefined();
  });

  it.each(['answer', 'nested-answer'] as const)('校验actual包含%s对象时不因每轮requestId或回执变化漏掉停滞', (kind: string): void => {
    const jobs = [failed('root'), failed('r1', 'root'), failed('r2', 'r1')];
    for (const job of jobs) {
      const answer = JSON.parse(job.rawText!) as Record<string, unknown>;
      job.validationDetails![0].actual = kind === 'answer' ? answer : { failedAnswer: answer };
      job.validationDetails![0].actualType = 'object';
    }
    expect(stalledAutomaticRepairMessage(project(jobs), jobs[2])).toContain('自动修订没有进展');
    const actual = jobs[2].validationDetails![0].actual as Record<string, unknown>;
    (kind === 'answer' ? actual : actual.failedAnswer as Record<string, unknown>).optimized = 'TEST实际创作值已变化';
    expect(stalledAutomaticRepairMessage(project(jobs), jobs[2])).toBeUndefined();
  });

  it('显式继续从新授权段重新观察，不借历史重复结果阻断本轮', (): void => {
    const jobs = [failed('root'), failed('r1', 'root'), failed('r2', 'r1'), failed('explicit', 'r2'), failed('r3', 'explicit'), failed('r4', 'r3')];
    jobs[3].repairMode = 'explicit';
    expect(stalledAutomaticRepairMessage(project(jobs), jobs[3])).toBeUndefined();
    expect(stalledAutomaticRepairMessage(project(jobs), jobs[4])).toBeUndefined();
    expect(stalledAutomaticRepairMessage(project(jobs), jobs[5])).toContain('自动修订没有进展');
  });

  it('不存在可修复错误或真实原文时不猜测停滞，父链环不死循环', (): void => {
    const job = failed('loop', 'loop');
    expect(stalledAutomaticRepairMessage(project([job]), job)).toBeUndefined();
    job.validationDetails = undefined;
    expect(stalledAutomaticRepairMessage(project([job]), job)).toBeUndefined();
  });
});
