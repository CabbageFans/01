/** 素材卡片离线权限投影回归；静态渲染不计作真实界面验收。主进程资格测试另行覆盖。 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryCapability, PetStoryProject, Task } from '@doubao-studio/contracts';
import { PetStoryMaterials } from '../../src/components/PetStoryMaterials';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { petStoryWritingModel } from '../../src/utils/petstoryCandidate';
import { promptWritingTarget } from '../../main/utils/petstoryEligibility';

vi.mock('../../src/components/usePetStoryGenerationEligibility', () => ({ usePetStoryGenerationEligibility: () => ({ eligibility: { ready: true, blockers: [] }, loading: false, error: '', refresh: vi.fn() }) }));

const initial = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-10-26T00:00:00.000Z';
let project: PetStoryProject;
let capability: PetStoryCapability;
function button(html: string, label: string): string {
  const result = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((entry): boolean => entry.replace(/<[^>]*>/g, '') === label);
  if (!result) throw new Error(`缺少界面按钮：${label}`);
  return result;
}
function render(disabled = false, generationBlocked = false): string {
  return renderToStaticMarkup(React.createElement(PetStoryMaterials, { project, disabled, generationBlocked }));
}
function editor(html: string): string {
  const result = html.match(/<textarea\b[^>]*>/g)?.find((entry): boolean => entry.includes('scene:location基础图最终提示词'));
  if (!result) throw new Error('缺少实际正文编辑框');
  return result;
}
function editPlanField(html: string): string {
  const field = html.match(/<textarea\b[^>]*>/g)?.find((entry): boolean => entry.includes('scene:location编辑变化'));
  if (!field) throw new Error('缺少实际素材编辑意图输入框');
  return field;
}
beforeEach((): void => {
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation(<T,>(_subscribe: (onStoreChange: () => void) => () => void, getSnapshot: () => T): T => getSnapshot());
  const entry = { state: 'supported' as const, reason: 'TEST' };
  capability = { accountId: 'TEST-account', checkedAt: now, durations: [5], image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' } };
  project = {
    schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, updatedAt: now, assets: [],
    storyApproval: { hash: 'TEST', at: now },
    plan: { sourceSummary: 'TEST', adaptedStory: 'TEST', characters: [], props: [], scenes: [], shots: [] },
    materials: [{ id: 'scene:location', kind: 'scene', entityId: 'location', name: 'TEST场景', designHash: 'TEST', prompt: { original: 'TEST原文', optimized: 'TEST候选', final: 'TEST原文', edited: false, rulesVersion: 'TEST', candidateJobId: 'TEST-job' } }],
    jobs: [{ id: 'TEST-job', kind: 'materialPrompt', materialId: 'scene:location', taskId: 'TEST-task', inputHash: 'TEST', sourceUrl: '', status: 'applied', createdAt: now, requestId: 'TEST-request', resultStatus: 'candidate', rawText: JSON.stringify({ optimized: 'TEST候选' }) }]};
  usePetStoryStore.setState({ project, busy: false, capability});
  useTaskStore.setState({ tasks: [] });
});
afterEach((): void => { usePetStoryStore.setState(initial.petstory); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });

describe('素材文字与媒体独立门禁', (): void => {
  it('文字目标投影与实际请求顺序一致，显式generic覆盖曾经核对的模型', (): void => {
    const production = { capability } as NonNullable<PetStoryProject['production']>;
    project.productionHistory = [production];
    expect(petStoryWritingModel(project)).toBe('seedance-2.0');
    project.production = { ...production, capability: { ...capability, videoConfig: { ...capability.videoConfig!, model: 'seedance-2.5' } } };
    expect(petStoryWritingModel(project)).toBe('seedance-2.5');
    project.promptCapability = capability; expect(petStoryWritingModel(project)).toBe('seedance-2.0');
    project.promptModel = 'generic'; expect(petStoryWritingModel(project)).toBe('generic');
    for (const model of ['generic', 'seedance-2.5', undefined] as const) {
      project.promptModel = model; expect(petStoryWritingModel(project)).toBe(promptWritingTarget(project, {}).model);
    }
  });
  it('剧本未确认只保留回到方案审阅的单一操作，不投影素材和入口设置', (): void => {
    delete project.storyApproval;
    const html = render();
    expect(button(html, '查看并确认方案')).not.toContain('disabled');
    expect(html.match(/<button\b/g)).toHaveLength(1);
    for (const label of ['重新生成提示词', '检查正文', '采用此候选', '上传图片', '生成图片', '入口检查', '批量准备', '基础图最终提示词']) expect(html).not.toContain(label);
  });
  it('方案已确认后素材文字编辑与候选采用保留，未展开不触发请求', (): void => {
    const html = render();
    for (const label of ['重新生成提示词', '检查正文', '采用此候选']) expect(button(html, label)).not.toContain('disabled');
    expect(editor(html)).not.toContain('disabled');
    expect(html).not.toContain('scene:location选择已有图片');
    expect(html).not.toContain('采用这张');
  });
  it('锁定及未保存前置仍阻止编辑与采用，空闲文字入口不需额外确认', (): void => {
    const locked = render(true);
    expect(editor(locked)).toContain('disabled'); expect(button(locked, '采用此候选')).toContain('disabled');
    for (const label of ['重新生成提示词', '检查正文']) {
      expect(button(locked, label)).toContain('disabled'); expect(button(render(false, true), label)).toContain('disabled');
    }
    for (const label of ['重新生成提示词', '检查正文']) expect(button(render(), label)).not.toContain('disabled');
  });
  it('确认剧本后图片生成无需当前会话检查，上传保持独立', (): void => {
    project.storyApproval = { hash: 'TEST', at: now };
    expect(button(render(), '生成图片')).not.toContain('disabled');
    usePetStoryStore.setState({ capability: null });
    expect(button(render(), '生成图片')).not.toContain('disabled');
    usePetStoryStore.setState({ capability });
    expect(button(render(), '生成图片')).not.toContain('disabled');
    expect(button(render(), '上传图片')).not.toContain('disabled');
  });
  it('待采用的真实提示词回复可直接审阅，历史已采用或过期正文不冒充新候选', (): void => {
    project.materials![0].prompt.final = '';
    usePetStoryStore.setState({ capability: null});
    expect(button(render(), '查看并采用提示词')).not.toContain('disabled');
    for (const resultStatus of ['adopted', 'stale'] as const) {
      project.jobs[0].resultStatus = resultStatus;
      expect(render()).not.toContain('查看并采用提示词');
      expect(button(render(), '生成提示词')).not.toContain('disabled');
    }
  });
  it('结束等待保留原bound记录，素材重生与编辑计划恢复；无关待收取素材不锁本项', (): void => {
    const job = project.jobs[0]; job.status = 'bound'; job.endedWaitingAt = now;
    project.jobs.push({ ...job, id: 'TEST-other-job', taskId: 'TEST-other-task', materialId: 'scene:other', endedWaitingAt: undefined });
    const before = structuredClone(project); const html = render();
    expect(button(html, '重新生成提示词')).not.toContain('disabled');
    expect(button(html, '检查正文')).not.toContain('disabled');
    expect(editPlanField(html)).not.toContain('disabled');
    expect(project).toEqual(before); expect(useTaskStore.getState().tasks).toEqual([]);
  });
  it.each(['bound', 'captured'] as const)('本素材%s仍锁新的创作操作，全局待收取仍阻断', (status): void => {
    project.jobs[0].status = status;
    for (const global of [false, true]) {
      project.jobs[0].materialId = global ? undefined : 'scene:location';
      const html = render(); expect(button(html, '重新生成提示词')).toContain('disabled');
      expect(editPlanField(html)).toContain('disabled');
    }
  });
  it('结束等待不释放仍活动的原账号任务或租约，其他账号活动不冒充本账号占用', (): void => {
    project.jobs[0].status = 'bound'; project.jobs[0].endedWaitingAt = now;
    const active: Task = { id: 'TEST-original-task', projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: 'executing', prompt: 'TEST', result: null, outputs: [], createdAt: now, updatedAt: now };
    useTaskStore.setState({ tasks: [active] });
    expect(button(render(), '重新生成提示词')).toContain('disabled'); expect(editPlanField(render())).toContain('disabled');
    expect(useTaskStore.getState().tasks).toEqual([active]);
    useTaskStore.setState({ tasks: [{ ...active, assignedAccountId: 'TEST-other-account' }] });
    expect(button(render(), '重新生成提示词')).not.toContain('disabled'); expect(editPlanField(render())).not.toContain('disabled');
  });
});
