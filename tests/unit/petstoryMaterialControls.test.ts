/** 素材卡片离线权限投影回归；静态渲染不计作真实界面验收。主进程资格测试另行覆盖。 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryCapability, PetStoryProject, Task } from '@doubao-studio/contracts';
import { PetStoryMaterials } from '../../src/components/PetStoryMaterials';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { isMaterialPromptBlocked, petStoryWritingModel } from '../../src/utils/petstoryCandidate';
import { promptWritingTarget } from '../../main/utils/petstoryEligibility';


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

describe('素材图片入口与后台文字安全边界', (): void => {
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
  it('方案已确认后只提供图片操作，渲染不采用已有文字候选或改动手改正文', (): void => {
    project.materials![0].prompt.edited = true;
    const before = structuredClone(project); const html = render();
    expect(button(html, '生成图片')).not.toContain('disabled'); expect(button(html, '上传图片')).not.toContain('disabled');
    for (const label of ['重新生成提示词', '检查正文', '采用此候选', '查看与编辑图片提示词', '更多操作', '变体／局部编辑计划']) expect(html).not.toContain(label);
    expect(html).not.toContain('<textarea'); expect(html).not.toContain('TEST候选');
    expect(project).toEqual(before); expect(useTaskStore.getState().tasks).toEqual([]);
  });
  it('锁定与未保存前置阻止图片生成，上传不受正文准备状态限制', (): void => {
    const locked = render(true); expect(button(locked, '生成图片')).toContain('disabled'); expect(button(locked, '上传图片')).toContain('disabled');
    const sourceDirty = render(false, true); expect(button(sourceDirty, '生成图片')).toContain('disabled'); expect(button(sourceDirty, '上传图片')).not.toContain('disabled');
    expect(button(render(), '生成图片')).not.toContain('disabled'); expect(locked).not.toContain('<textarea');
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
  it('新候选、已采用或过期文字均不暴露中间采用按钮，也不因查看素材而改变来源', (): void => {
    project.materials![0].prompt.final = ''; usePetStoryStore.setState({ capability: null });
    for (const resultStatus of ['candidate', 'adopted', 'stale'] as const) {
      project.jobs[0].resultStatus = resultStatus; const before = structuredClone(project); const html = render();
      expect(button(html, '生成图片')).not.toContain('disabled');
      for (const label of ['查看并采用提示词', '生成提示词', '采用此候选']) expect(html).not.toContain(label);
      expect(project).toEqual(before); expect(project.materials![0].prompt.final).toBe('');
    }
  });
  it('结束等待保留原绑定和历史，无关待收取素材不锁本目标的后台安全判断', (): void => {
    const job = project.jobs[0]; job.status = 'bound'; job.endedWaitingAt = now;
    project.jobs.push({ ...job, id: 'TEST-other-job', taskId: 'TEST-other-task', materialId: 'scene:other', endedWaitingAt: undefined });
    const before = structuredClone(project); const html = render();
    expect(isMaterialPromptBlocked(project, 'scene:location', [])).toBe(false);
    expect(button(html, '生成图片')).not.toContain('disabled'); expect(html).not.toContain('编辑变化');
    expect(project).toEqual(before); expect(useTaskStore.getState().tasks).toEqual([]);
  });
  it.each(['bound', 'captured'] as const)('本素材%s和全局待收取继续保留后台冲突事实，不恢复旧编辑表单', (status): void => {
    project.jobs[0].status = status;
    for (const global of [false, true]) {
      project.jobs[0].materialId = global ? undefined : 'scene:location'; const before = structuredClone(project);
      expect(isMaterialPromptBlocked(project, 'scene:location', [])).toBe(true);
      const html = render(); expect(html).not.toContain('<textarea'); expect(html).not.toContain('变体／局部编辑计划'); expect(project).toEqual(before);
    }
  });
  it('结束等待不释放仍活动的原账号任务或租约，其他账号活动不冒充本账号占用', (): void => {
    project.jobs[0].status = 'bound'; project.jobs[0].endedWaitingAt = now;
    const active: Task = { id: 'TEST-original-task', projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: 'executing', prompt: 'TEST', result: null, outputs: [], createdAt: now, updatedAt: now };
    useTaskStore.setState({ tasks: [active] });
    expect(isMaterialPromptBlocked(project, 'scene:location', useTaskStore.getState().tasks)).toBe(true);
    expect(render()).not.toContain('<textarea'); expect(useTaskStore.getState().tasks).toEqual([active]);
    useTaskStore.setState({ tasks: [{ ...active, assignedAccountId: 'TEST-other-account' }] });
    expect(isMaterialPromptBlocked(project, 'scene:location', useTaskStore.getState().tasks)).toBe(false);
    expect(button(render(), '生成图片')).not.toContain('disabled');
  });

});
