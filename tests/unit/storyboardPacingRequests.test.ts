/** 原项目派生的离线请求接线用例；不把模拟正文当真实豆包创作结果。 */
import { describe, expect, it } from 'vitest';
import type { PetStoryChatJob, PetStoryProject, PetStoryShot } from '@doubao-studio/contracts';
import fixture from '../fixtures/drama-runtime-input.json';
import runtime from '../../main/resources/drama/runtime.json';
import { buildDramaRequest } from '../../main/utils/petstoryRuntimeRequest';
import { promptStageContext, repairPrompt } from '../../src/utils/petstoryPrompts';

function project(): PetStoryProject { return structuredClone(fixture) as PetStoryProject; }
function facts(prompt: string): Record<string, unknown> {
  const block = prompt.split('【当前事实与本次附件】\n')[1].split('\n\n【结果约定】')[0];
  const fenced = block.match(/^(`{3,})json\n([\s\S]*)\n\1$/);
  return JSON.parse(fenced?.[2] || block) as Record<string, unknown>;
}
function timing(shot: PetStoryShot): void {
  shot.durationSeconds = 6;
  shot.dialogue = [{ speakerId: shot.characterIds[0], text: 'TEST原句', tone: '自然', pace: '自然', source: { text: 'TEST原句', occurrence: 1, start: 0, end: 6 } }];
  shot.timing = 'TEST失效旧10秒铺垫';
  shot.timingPlan = { events: [
    { id: 'speech', kind: 'dialogue', description: 'TEST逐字说话', startSeconds: 0, endSeconds: 4.2, dialogueIndex: 0 },
    { id: 'look', kind: 'action', description: 'TEST边说边抬眼', startSeconds: 0.5, endSeconds: 2 },
    { id: 'result', kind: 'reaction', description: 'TEST说完后必要反应', startSeconds: 4.2, endSeconds: 5.6, afterEventId: 'speech' },
  ], estimatedRequiredSeconds: 5.6, durationReason: 'TEST必要跨度5.6秒取6秒', cutReason: 'TEST反应交付后切出' };
}

describe('分镜节奏真实请求接线（离线）', (): void => {
  it('首次分析与重分析携带事件先后、最短够用和原文覆盖合同，不继承旧镜头结构', (): void => {
    const p = project();
    for (const hasPlan of [true, false]) {
      if (!hasPlan) p.plan = undefined;
      const request = buildDramaRequest(p, { kind: 'analysis', requestId: 'TEST-pacing-analysis' });
      expect(request.planTimingVersion).toBe('events-v1');
      expect(facts(request.prompt).source).toMatchObject({ originalText: p.mobileStory!.text });
      expect(facts(request.prompt)).not.toHaveProperty('currentPlan');
      expect(request.prompt).toContain('timingPlan:{events:');
      expect(request.prompt).toContain('约5.6秒可选6');
      expect(request.prompt).toContain('完整analysis及用户明确要求节奏调整的planFeedback允许必要拆镜、合镜');
      expect(request.prompt).toContain('回看原剧本检查，不能只对账自己提炼的节拍');
      expect(request.prompt).toContain('不能每镜重复整句或用集合删除有意重复');
      expect(request.prompt).toContain('推荐仅返回source:{text,occurrence}，同时省略start和end');
      expect(request.prompt).toContain('部分片段必须同时给出准确start/end');
      expect(request.prompt).not.toContain('完整原句不拆时start为0、end为Unicode字符数');
      expect(request.prompt).toContain('predecessorShotIds');
    }
  });
  it('完整方案反馈允许按意图拆合，候选时间结构完整传入且当前项目不变', (): void => {
    const p = project(); timing(p.plan!.shots[0]); const before = structuredClone(p);
    const request = buildDramaRequest(p, { kind: 'analysis', requestId: 'TEST-pacing-feedback', planFeedback: { text: '前半段太拖，节奏紧凑一些', requestId: 'TEST-feedback' } });
    expect(request.planTimingVersion).toBe('events-v1');
    const data = facts(request.prompt).userPlanFeedback as { selectedPlan: PetStoryProject['plan']; policy: string };
    expect(data.selectedPlan?.shots[0].timingPlan).toEqual(p.plan!.shots[0].timingPlan);
    expect(data.policy).toContain('拆镜、合镜和在5～10秒内改时长');
    expect(data.policy).toContain('非节奏反馈仍只改其明确目标');
    expect(p).toEqual(before);
  });
  it.each(['firstFrame', 'lastFrame', 'video'] as const)('%s与修订共用采用时间轴且不恢复自由timing旧铺垫', (kind: 'firstFrame' | 'lastFrame' | 'video'): void => {
    const p = project(); const shot = p.plan!.shots[0]; timing(shot);
    const request = buildDramaRequest(p, { kind: 'optimize', requestId: 'TEST-pacing-body', shotId: shot.id, promptKind: kind });
    expect(request.planTimingVersion).toBeUndefined();
    const state = facts(request.prompt).sharedShotState as { productionTiming: { durationSeconds: number; timingPlan: PetStoryShot['timingPlan'] } };
    expect(state.productionTiming).toMatchObject({ durationSeconds: 6, timingPlan: shot.timingPlan });
    expect(request.promptTask?.timingPlanHash).toMatch(/^[a-f0-9]{64}$/);
    expect(request.prompt).not.toContain('TEST失效旧10秒铺垫');
    const parent: PetStoryChatJob = { id: 'TEST-parent', taskId: 'TEST-task', kind: 'optimize', shotId: shot.id, promptKind: kind,
      status: 'invalid', inputHash: 'a'.repeat(64), sourceUrl: p.source.url, requestText: 'TEST历史请求', rawText: 'TEST待修回复', promptTask: request.promptTask };
    p.jobs.push(parent);
    const repaired = buildDramaRequest(p, { kind: 'repair', requestId: 'TEST-pacing-repair', shotId: shot.id, promptKind: kind, parentJob: parent });
    expect(repaired.planTimingVersion).toBeUndefined();
    expect(facts(repaired.prompt).sharedShotState).toMatchObject({ productionTiming: state.productionTiming });
    if (kind === 'video') {
      expect(facts(request.prompt).shot).toMatchObject({ durationSeconds: 6, timingPlan: shot.timingPlan, dialogue: shot.dialogue });
      expect(request.prompt).toContain('不得重新添加无来源开场、等待、每镜缓推或长时间凝视');
    } else expect(facts(request.prompt).shot).not.toHaveProperty('action');
  });
  it('assets职责保持补齐，输出合同不要求改镜长或重排', (): void => {
    const p = project(); timing(p.plan!.shots[0]);
    const request = buildDramaRequest(p, { kind: 'assets', requestId: 'TEST-pacing-assets' });
    expect(request.planTimingVersion).toBeUndefined();
    expect(request.prompt).toContain('不得重新拆镜');
    const contract = request.prompt.split('【结果约定】\n')[1];
    expect(contract).toContain('shotBindings精确覆盖当前镜头');
    expect(contract).toContain('不要返回／修改action、startState、endState、durationSeconds');
    expect(contract).not.toContain('timingPlan:{events:');
  });
  it('新完整方案格式修订保留events-v1职责，旧提示词修订不误加方案合同', (): void => {
    const p = project();
    const parent: PetStoryChatJob = { id: 'TEST-analysis-parent', taskId: 'TEST-analysis-task', kind: 'analysis', status: 'invalid', inputHash: 'TEST', sourceUrl: '', requestId: 'TEST-analysis-request', rawText: 'TEST待修完整方案' };
    p.jobs.push(parent);
    expect(buildDramaRequest(p, { kind: 'repair', requestId: 'TEST-analysis-repair', parentJob: parent }).planTimingVersion).toBe('events-v1');
    const repaired = buildDramaRequest(p, { kind: 'repair', requestId: 'TEST-analysis-range-repair', parentJob: parent });
    expect(facts(repaired.prompt).repairScope).toMatchObject({ allowedChanges: expect.stringContaining('可同时省略start/end交程序计算完整范围') });
    expect(repaired.prompt).toContain('已提供错误范围不会被自动修补');
  });
  it('无requestId的历史格式修订仍收到已保存时间安排与整秒边界', (): void => {
    const p = project(); const shot = p.plan!.shots[0]; timing(shot);
    const job: PetStoryChatJob = { id: 'TEST-legacy', taskId: 'TEST-legacy-task', kind: 'analysis', status: 'invalid', inputHash: 'TEST', sourceUrl: '', rawText: 'TEST历史原回复' };
    const prompt = repairPrompt(p, job);
    expect(prompt).toContain('当前已保存镜头时间安排');
    expect(prompt).toContain(JSON.stringify(shot.timingPlan));
    expect(prompt).toContain('有限整秒number（只能5、6、7、8、9、10，不能字符串）');
    expect(prompt).toContain('TEST历史原回复');
    expect(prompt).toContain('推荐只给source:{text,occurrence}并同时省略start/end');
    expect(prompt).toContain('部分片段必须同时给准确start/end');
    for (const kind of ['firstFrame', 'lastFrame', 'video'] as const) expect(promptStageContext(shot, kind)).toMatchObject({ productionTiming: { durationSeconds: 6, timingPlan: shot.timingPlan } });
  });
  it('规则保留三个上游的方法来源而不引入外部协议、范围或镜长配额', (): void => {
    expect(runtime.pacingSources.map((source): string => source.repository)).toEqual([
      'https://github.com/zenstory-ai/drama-skills', 'https://github.com/oiuv/ai-short-drama', 'https://github.com/yzsp-studio/novel-storyboard',
    ]);
    expect(runtime.stages.storyboard.rules).toContain('不默认8或10，不全部5');
    expect(runtime.stages.storyboard.rules).toContain('8秒拆两个5秒增加成本');
    expect(runtime.stages.video.rules).toContain('不能在单项正文中偷偷拆合全片');
  });
});
