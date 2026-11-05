/** 原项目派生的离线边界用例，不代表真实创作或平台生成结果。 */
import { describe, expect, it } from 'vitest';
import type { PetStoryCapability, PetStoryShot } from '@doubao-studio/contracts';
import fixture from '../fixtures/storyboard-five-shots.json';
import { resolvePetStoryMode } from '../../main/utils/petstoryModes';
import { capabilityParameters } from '../../main/utils/petstoryCapability';
import { petStoryTimingText } from '../../src/utils/petstoryTiming';

const capability: PetStoryCapability = { accountId: 'TEST-account', image: { state: 'unknown', reason: '' }, modes: { first_frame: { state: 'unknown', reason: '' }, first_last_frame: { state: 'unknown', reason: '' }, reference: { state: 'unknown', reason: '' } }, durations: [4, 5, 6, 7, 8, 9, 10, 11, 15] };
function shot(duration: unknown): PetStoryShot { return { ...structuredClone(fixture.plan.shots[0]), durationSeconds: duration, requestedMode: 'reference' } as PetStoryShot; }

describe('产品时长与实际页面范围的交集', (): void => {
  it.each([5, 6, 7, 8, 9, 10])('更宽能力表仍可使用合法%s秒', (duration: number): void => {
    expect(resolvePetStoryMode(shot(duration), capabilityParameters(capability, 'TEST-account')).resolvedMode).toBe('reference');
  });
  it.each([4, 11, 15, 5.6, '5', NaN, Infinity, -Infinity])('更宽能力表不能允许非法值%s', (duration: unknown): void => {
    expect((): void => { resolvePetStoryMode(shot(duration), capability); }).toThrow('5～10');
  });
  it('页面选项较窄时保留实际选择校验，未知时仍可规划', (): void => {
    expect((): void => { resolvePetStoryMode(shot(6), { ...capability, durations: [5, 10] }); }).toThrow('不可选');
    expect(resolvePetStoryMode(shot(6), { ...capability, durations: [] }).resolvedMode).toBe('reference');
  });
  it('新时间表展示优先于旧文字，不输出内部事件ID', (): void => {
    const value = shot(6); value.timing = '旧的固定开场与停留';
    value.timingPlan = { events: [{ id: 'INTERNAL-event', kind: 'action', description: '原动作与发声并行', startSeconds: 0, endSeconds: 5.6 }], estimatedRequiredSeconds: 5.6, durationReason: '原动作需要约5.6秒', cutReason: '动作闭合' };
    expect(petStoryTimingText(value)).toBe('0～5.6 秒 · 动作 · 原动作与发声并行');
    delete value.timingPlan; expect(petStoryTimingText(value)).toBe(value.timing);
  });
});
