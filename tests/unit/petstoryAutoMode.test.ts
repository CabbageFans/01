/** 只验证离线模式规划、目标补齐与数据保留；不连接平台或启动生成。 */
import { describe, expect, it } from 'vitest';
import type { PetStoryAutoModePlan, PetStoryCapability, PetStoryPlan, PetStoryResolvedMode, PetStoryShot } from '@doubao-studio/contracts';
import fixture from '../fixtures/storyboard-five-shots.json';
import { ensurePetStoryAutoModeTargets, petStoryAutoModePlan, plannedPetStoryMode, resolvePetStoryMode } from '../../main/utils/petstoryModes';
import { validatePetStoryPlan } from '../../main/utils/petstoryValidation';
import { buildDramaRequest } from '../../main/utils/petstoryRuntimeRequest';

function plan(): PetStoryPlan { return structuredClone(fixture.plan) as PetStoryPlan; }
function shot(): PetStoryShot {
  const value = plan().shots[0];
  value.requestedMode = 'auto'; value.startState = '盒子放在桌面，盖子关闭'; value.endState = '盒盖打开，礼物露出';
  delete value.prompts.lastFrame;
  return value;
}
const capability: PetStoryCapability = { accountId: 'TEST-account', image: { state: 'unknown', reason: '' }, modes: {
  first_frame: { state: 'unknown', reason: '' }, first_last_frame: { state: 'unknown', reason: '' }, reference: { state: 'unknown', reason: '' },
}, durations: [5, 6, 7, 8, 9, 10] };

describe('逐镜自动模式规划', (): void => {
  it.each(['first_frame', 'first_last_frame', 'reference'] as const)('采用剧情判断%s，历史多参考占位不能覆盖', (mode: PetStoryResolvedMode): void => {
    const value = shot(); const decision: PetStoryAutoModePlan = { mode, reason: '本镜剧情安排的具体判断', source: 'analysis' };
    value.autoModePlan = decision; value.prompts.video.promptTask = { dialect: 'seedance20', mode: 'reference', references: [] };
    expect(petStoryAutoModePlan(value)).toEqual(decision);
    expect(plannedPetStoryMode(value, 'reference')).toBe(mode);
    if (mode === 'first_last_frame') value.prompts.lastFrame = { ...value.prompts.firstFrame, final: 'TEST尾帧正文' };
    expect(resolvePetStoryMode(value, capability)).toMatchObject({ requestedMode: 'auto', resolvedMode: mode, reason: expect.stringContaining(decision.reason) });
  });

  it.each(['first_frame', 'first_last_frame', 'reference'] as const)('用户明确的%s优先于自动判断', (mode: PetStoryResolvedMode): void => {
    const value = shot(); value.requestedMode = mode; value.autoModePlan = { mode: 'first_last_frame', reason: '较早的自动安排' };
    expect(plannedPetStoryMode(value, 'reference')).toBe(mode);
  });

  it('旧方案不同起终状态保守保留尾帧，不从旧视频合同回落多参考', (): void => {
    const value = shot(); value.prompts.video.promptTask = { dialect: 'generic', mode: 'reference', references: [] };
    expect(petStoryAutoModePlan(value)).toMatchObject({ mode: 'first_last_frame', source: 'legacy', reason: expect.stringContaining('未记录逐镜模式判断') });
    expect(plannedPetStoryMode(value, 'reference')).toBe('first_last_frame');
  });

  it('相同起终状态只作兼容规范化，不按语言动作词或字数分类', (): void => {
    const value = shot(); value.startState = ' Ａ　对象，持续前进。'; value.endState = 'A对象持续前进';
    expect(plannedPetStoryMode(value)).toBe('first_frame');
    value.startState = ''; expect(plannedPetStoryMode(value)).toBe('first_frame');
    value.startState = 'state A'; value.endState = 'state B'; expect(plannedPetStoryMode(value)).toBe('first_last_frame');
  });

  it('旧方案已保存的尾帧优先保留，不被起终文字相同移除', (): void => {
    const value = shot(); value.endState = value.startState;
    value.prompts.lastFrame = { ...value.prompts.firstFrame, final: 'TEST已采用尾帧正文', sourceJobId: 'TEST-tail-job' };
    expect(plannedPetStoryMode(value)).toBe('first_last_frame');
    value.autoModePlan = { mode: 'first_frame', reason: '旧兼容安排', source: 'legacy' };
    expect(plannedPetStoryMode(value)).toBe('first_last_frame');
  });

  it('旧兼容安排随起终状态变化重算，自己补的空尾帧不会锁死模式', (): void => {
    const value = shot(); const current = { ...plan(), shots: [value] };
    ensurePetStoryAutoModeTargets(current);
    expect(value.autoModePlan?.mode).toBe('first_last_frame'); expect(value.prompts.lastFrame?.final).toBe('');
    value.endState = value.startState; ensurePetStoryAutoModeTargets(current);
    expect(value.autoModePlan).toMatchObject({ mode: 'first_frame', source: 'legacy' });
    expect(value.prompts.lastFrame).toBeDefined();
  });

  it('仅补当前方案空目标，保留已有正文、图片、候选与任务历史且不产生任务', (): void => {
    const current = { ...plan(), shots: [shot()] };
    const project = { plan: current, assets: [{ id: 'TEST-first-image' }], jobs: [{ id: 'TEST-old-job', parsedResult: { plan: structuredClone(current) } }], productionHistory: [{ id: 'TEST-production', mode: 'reference' }], tasks: [] };
    const preserved = structuredClone({ assets: project.assets, jobs: project.jobs, productionHistory: project.productionHistory, tasks: project.tasks });
    const first = structuredClone(current.shots[0].prompts.firstFrame); const video = structuredClone(current.shots[0].prompts.video);
    ensurePetStoryAutoModeTargets(current); ensurePetStoryAutoModeTargets(current);
    expect(current.shots[0].prompts.lastFrame?.final).toBe('');
    expect(current.shots[0].prompts.firstFrame).toEqual(first); expect(current.shots[0].prompts.video).toEqual(video);
    expect({ assets: project.assets, jobs: project.jobs, productionHistory: project.productionHistory, tasks: project.tasks }).toEqual(preserved);
    const oldTail = { ...first, final: 'TEST已保存尾帧正文' }; current.shots[0].prompts.lastFrame = oldTail;
    ensurePetStoryAutoModeTargets(current); expect(current.shots[0].prompts.lastFrame).toBe(oldTail);
  });
});

describe('自动模式分析与保存合同', (): void => {
  it.each(['first_frame', 'first_last_frame', 'reference'] as const)('剧情判断%s经解析与重新保存仍保持一致', (mode: PetStoryResolvedMode): void => {
    const input = plan(); input.shots[0] = shot(); input.shots[0].autoModePlan = { mode, reason: '镜头剧情的实际模式依据' };
    const before = structuredClone(input); const parsed = validatePetStoryPlan(input, true);
    expect(input).toEqual(before);
    expect(parsed.shots[0].autoModePlan).toEqual({ mode, reason: '镜头剧情的实际模式依据', source: 'analysis' });
    expect(!!parsed.shots[0].prompts.lastFrame).toBe(mode === 'first_last_frame');
    if (mode === 'first_last_frame') expect(parsed.shots[0].prompts.lastFrame?.final).toBe('');
    expect(validatePetStoryPlan(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('普通校验不迁移缺少判断的历史方案或候选', (): void => {
    const input = plan(); input.shots[0] = shot();
    const parsed = validatePetStoryPlan(input);
    expect(parsed.shots[0].autoModePlan).toBeUndefined(); expect(parsed.shots[0].prompts.lastFrame).toBeUndefined();
  });

  it.each([{ mode: 'auto', reason: 'TEST' }, { mode: ['first_frame'], reason: 'TEST' }, { mode: 'first_frame', reason: ' ' }, { mode: 'reference', reason: 1 }, { mode: 'first_frame', reason: 'TEST', source: 'unknown' }, { mode: 'first_frame', reason: 'TEST', source: ['legacy'] }])('拒绝非法判断合同%s', (decision: object): void => {
    const input = plan(); input.shots[0] = { ...shot(), autoModePlan: decision } as PetStoryShot;
    expect((): PetStoryPlan => validatePetStoryPlan(input)).toThrow('autoModePlan');
  });

  it('模型不能把其返回判断伪装成本地兼容来源', (): void => {
    const input = plan(); input.shots[0] = shot(); input.shots[0].autoModePlan = { mode: 'first_frame', reason: '持续动作无需锁尾帧', source: 'legacy' };
    expect(validatePetStoryPlan(input, true).shots[0].autoModePlan?.source).toBe('analysis');
  });

  it('新分析要求逐镜按剧情选择并解释，不能按平台或额度默认跳过尾帧', (): void => {
    const project = { schemaVersion: 1 as const, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 0,
      source: { kind: 'script' as const, url: '', status: 'pending' as const }, assets: [], jobs: [], updatedAt: '2026-11-06T00:00:00.000Z',
      mobileStory: { id: 'TEST-story', text: 'TEST角色打开盒子，露出礼物。', importedAt: '2026-11-06T00:00:00.000Z' } };
    const request = buildDramaRequest(project, { kind: 'analysis', requestId: 'TEST-request' });
    expect(request.prompt).toContain('autoModePlan'); expect(request.prompt).toContain('requestedMode为auto时必填');
    expect(request.prompt).toContain('不得直接默认多参考而跳过尾帧'); expect(request.prompt).toContain('不根据平台入口、免费或额度');
    expect(project.jobs).toHaveLength(0); expect(project.assets).toHaveLength(0);
  });
});
