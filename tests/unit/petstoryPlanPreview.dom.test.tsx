/** 完整方案只读预览：字段、引用名称与未填写内容都不能在采用前被省略。 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PetStoryPlan, PetStoryPrompt, PetStoryProject } from '@doubao-studio/contracts';
import { PetStoryPlanPreview } from '../../src/components/PetStoryPlanPreview';

function prompt(prefix: string): PetStoryPrompt {
  return { original: `${prefix}原始`, optimized: `${prefix}候选`, final: `${prefix}采用`, draft: `${prefix}草稿`, edited: true, needsReview: true, rulesVersion: 'INTERNAL-rule', basisJobId: 'INTERNAL-job',
    editIntent: { baseAssetId: 'INTERNAL-base-image', changes: `${prefix}变化`, preserve: `${prefix}保留`, validity: `${prefix}用途` },
    promptTask: { dialect: 'seedream', mode: 'first_frame', designHash: 'INTERNAL-design', references: [{ order: 1, assetId: 'INTERNAL-asset', characterIds: ['INTERNAL-character'], purpose: 'identity', slot: 'first' }] } };
}
function plan(): PetStoryPlan {
  return {
    sourceSummary: 'TEST故事梗概', understanding: 'TEST故事理解', adaptedStory: 'TEST本次故事', sceneDesign: 'TEST空间安排',
    characters: [{ id: 'INTERNAL-character', name: '阿青', role: 'main', aliases: ['TEST人物称谓'], purpose: 'TEST人物作用', description: 'TEST人物外观', continuity: 'TEST人物连续性', designOrigin: 'script', referenceAssetId: 'INTERNAL-reference' }],
    props: [{ id: 'INTERNAL-prop', name: '白瓷杯', aliases: ['TEST道具称谓'], description: 'TEST道具描述', keyStates: 'TEST道具关键状态', scale: 'TEST道具比例', appearanceState: 'TEST道具静态状态', designOrigin: 'proposed' }],
    scenes: [{ id: 'INTERNAL-main-scene', name: '厨房', location: 'TEST主场地点', time: 'TEST主场时间', lighting: 'TEST主场光线', layout: 'TEST主场布局', view: 'TEST主场视角', designOrigin: 'script' }, { id: 'INTERNAL-close-scene', name: '厨房窗边', location: 'TEST分场地点', time: 'TEST分场时间', lighting: 'TEST分场光线', layout: 'TEST分场布局', view: 'TEST分场视角', designOrigin: 'proposed', parentSceneId: 'INTERNAL-main-scene' }],
    shots: [{ id: 'INTERNAL-shot-one', order: 1, characterIds: [], scene: '厨房', action: 'TEST第一镜动作', startState: 'TEST第一镜起点', endState: 'TEST第一镜终点', durationSeconds: 5, transition: 'cut', requestedMode: 'first_frame', prompts: { firstFrame: prompt('TEST第一镜首帧'), video: prompt('TEST第一镜视频') } },
      { id: 'INTERNAL-shot-two', order: 2, characterIds: ['INTERNAL-character'], propIds: ['INTERNAL-prop'], sceneId: 'INTERNAL-close-scene', scene: 'TEST第二镜画面', sceneView: 'TEST第二镜视角', narrativePurpose: 'TEST镜头目的', sourceRefs: ['TEST原文段落'], framing: 'TEST景别构图', blocking: 'TEST站位调度', action: 'TEST主要动作', startState: 'TEST开始状态', endState: 'TEST结束状态', performance: 'TEST表演', expression: 'TEST表情', gaze: 'TEST视线', interaction: 'TEST互动', camera: 'TEST运镜', sound: 'TEST声音', timing: 'TEST节奏安排', continuity: 'TEST镜头连续性', durationSeconds: 8, requestedMode: 'first_last_frame', transition: 'continue', previousShotId: 'INTERNAL-shot-one', sceneReferenceAssetIds: ['INTERNAL-scene-image'], appearanceOverrides: { 'INTERNAL-character': 'TEST本场造型' }, propStates: [{ propId: 'INTERNAL-prop', holderId: 'INTERNAL-character', state: 'TEST手持道具状态' }], dialogue: [{ speakerId: 'INTERNAL-character', text: 'TEST原台词', tone: 'TEST语气', pace: 'TEST台词节奏', delivery: 'offscreen' }], prompts: { firstFrame: prompt('TEST第二镜首帧'), lastFrame: prompt('TEST第二镜尾帧'), video: prompt('TEST第二镜视频') } }],
  };
}

describe('完整只读方案预览', (): void => {
  it('显示所有创作字段、提示词各版本和引用名称，渲染不改写方案', (): void => {
    const value = plan(); const before = structuredClone(value);
    const contentBasis: PetStoryProject['contentBasis'] = { beginning: 'TEST起始事件', middle: 'TEST发展过程', ending: 'TEST结尾结果' };
    const { container } = render(<PetStoryPlanPreview plan={value} contentBasis={contentBasis} />);
    for (const text of ['TEST故事梗概', 'TEST故事理解', 'TEST本次故事', 'TEST空间安排', 'TEST起始事件', 'TEST发展过程', 'TEST结尾结果', 'TEST人物称谓', 'TEST人物作用', 'TEST人物外观', 'TEST人物连续性', 'TEST道具称谓', 'TEST道具描述', 'TEST道具关键状态', 'TEST道具比例', 'TEST道具静态状态', 'TEST主场地点', 'TEST主场时间', 'TEST主场光线', 'TEST主场布局', 'TEST主场视角', 'TEST分场地点', 'TEST分场时间', 'TEST分场光线', 'TEST分场布局', 'TEST分场视角']) expect(screen.getAllByText(text, { exact: true }).length).toBeGreaterThan(0);
    const second = screen.getByRole('article', { name: '镜头 2 完整方案' });
    for (const text of ['TEST第二镜画面', 'TEST第二镜视角', 'TEST镜头目的', 'TEST原文段落', 'TEST景别构图', 'TEST站位调度', 'TEST主要动作', 'TEST开始状态', 'TEST结束状态', 'TEST表演', 'TEST表情', 'TEST视线', 'TEST互动', 'TEST运镜', 'TEST声音', 'TEST节奏安排', 'TEST镜头连续性', '8 秒', '首尾帧', '延续上一镜', '镜头 1 · 厨房', '阿青：TEST本场造型', '白瓷杯 · 阿青：TEST手持道具状态', 'TEST原台词', 'TEST语气', 'TEST台词节奏', '画外说话']) expect(within(second).getAllByText(text, { exact: true }).length).toBeGreaterThan(0);
    for (const kind of ['首帧', '尾帧', '视频']) {
      const section = within(second).getByRole('region', { name: `镜头 2 · ${kind}提示词` });
      for (const version of ['原始', '候选', '采用', '草稿', '变化', '保留', '用途']) expect(within(section).getByText(`TEST第二镜${kind}${version}`, { exact: true })).toBeDefined();
      expect(within(section).getByText('图片 1 · 人物身份参考 · 阿青 · 首帧位置')).toBeDefined();
    }
    expect(container.textContent).not.toContain('INTERNAL-');
    expect(screen.queryAllByRole('textbox')).toHaveLength(0); expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(value).toEqual(before);
  });

  it('空白与无法对应的引用清楚标记，不把内部编号当人物或场景名', (): void => {
    const value = plan(); value.shots[1].characterIds = ['INTERNAL-missing-person']; value.shots[1].sceneId = 'INTERNAL-missing-scene'; value.shots[1].previousShotId = 'INTERNAL-missing-shot'; value.shots[1].action = '';
    const { container } = render(<PetStoryPlanPreview plan={value} />);
    expect(screen.getAllByText('未对应人物').length).toBeGreaterThan(0); expect(screen.getAllByText('没有对应场景').length).toBeGreaterThan(0);
    expect(screen.getByText('未对应到前一镜头，请核对')).toBeDefined(); expect(screen.getAllByText('未填写').length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('INTERNAL-');
  });
});
