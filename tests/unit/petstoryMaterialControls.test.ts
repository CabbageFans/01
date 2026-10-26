/** 实际素材卡片权限回归：文字准备不依赖剧本确认，媒体仍受原门禁约束。 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryCapability, PetStoryProject } from '@doubao-studio/contracts';
import { PetStoryMaterials } from '../../src/components/PetStoryMaterials';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';

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
beforeEach((): void => {
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation(<T,>(_subscribe: (onStoreChange: () => void) => () => void, getSnapshot: () => T): T => getSnapshot());
  const entry = { state: 'supported' as const, free: 'free' as const, reason: 'TEST' };
  capability = { accountId: 'TEST-account', checkedAt: now, freeEvidence: 'user_confirmed', durations: [5], image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' } };
  project = {
    schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, updatedAt: now, assets: [],
    plan: { sourceSummary: 'TEST', adaptedStory: 'TEST', characters: [], props: [], scenes: [], shots: [] },
    materials: [{ id: 'scene:location', kind: 'scene', entityId: 'location', name: 'TEST场景', designHash: 'TEST', prompt: { original: 'TEST原文', optimized: 'TEST候选', final: 'TEST原文', edited: false, rulesVersion: 'TEST', candidateJobId: 'TEST-job' } }],
    jobs: [{ id: 'TEST-job', kind: 'materialPrompt', materialId: 'scene:location', taskId: 'TEST-task', inputHash: 'TEST', sourceUrl: '', status: 'applied', createdAt: now, requestId: 'TEST-request', resultStatus: 'candidate', rawText: JSON.stringify({ optimized: 'TEST候选' }) }],
  };
  usePetStoryStore.setState({ project, busy: false, freeChatConfirmed: true, capability, capabilityCheckedInSession: true });
  useTaskStore.setState({ tasks: [] });
});
afterEach((): void => { usePetStoryStore.setState(initial.petstory); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });

describe('素材文字与媒体独立门禁', (): void => {
  it('剧本未确认时单项生成、审查、编辑和候选采用可用，图片操作全部禁用', (): void => {
    const html = render();
    for (const label of ['豆包重新生成此素材提示词', '审查本项素材正文（暂无图片）', '采用此候选']) expect(button(html, label)).not.toContain('disabled');
    expect(editor(html)).not.toContain('disabled');
    for (const label of ['上传图片替换', '接受当前图片', '生成此基础图']) expect(button(html, label)).toContain('disabled');
    const selectInput = html.match(/<input\b[^>]*>/g)?.find((entry): boolean => entry.includes('scene:location选择已有图片'));
    expect(selectInput).toContain('disabled');
  });
  it('锁定仍阻止编辑与采用，免费Chat未核对或有待处理请求时禁止新的文字请求', (): void => {
    const locked = render(true);
    expect(editor(locked)).toContain('disabled'); expect(button(locked, '采用此候选')).toContain('disabled');
    for (const label of ['豆包重新生成此素材提示词', '审查本项素材正文（暂无图片）']) {
      expect(button(locked, label)).toContain('disabled'); expect(button(render(false, true), label)).toContain('disabled');
    }
    usePetStoryStore.setState({ freeChatConfirmed: false });
    for (const label of ['豆包重新生成此素材提示词', '审查本项素材正文（暂无图片）']) expect(button(render(), label)).toContain('disabled');
  });
  it('确认剧本仍不能绕过当前会话媒体能力核对，核对后才启用图片生成', (): void => {
    project.storyApproval = { hash: 'TEST', at: now };
    usePetStoryStore.setState({ capabilityCheckedInSession: false });
    expect(button(render(), '生成此基础图')).toContain('disabled');
    usePetStoryStore.setState({ capabilityCheckedInSession: true, capability: null });
    expect(button(render(), '生成此基础图')).toContain('disabled');
    usePetStoryStore.setState({ capability });
    expect(button(render(), '生成此基础图')).not.toContain('disabled');
    expect(button(render(), '上传图片替换')).not.toContain('disabled');
  });
});
