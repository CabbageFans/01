/** 离线界面门禁回归：恢复的模型选择不恢复当前会话媒体提交授权。 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryCapability, PetStoryPlan, PetStoryProject } from '@doubao-studio/contracts';
import { CanvasMediaNode } from '../../src/components/PetStoryCanvasMedia';
import { ProductionControls } from '../../src/components/PetStoryPanel';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-10-25T01:00:00.000Z';
let project: PetStoryProject;
let capability: PetStoryCapability;
const generate = vi.fn(async (): Promise<void> => undefined);

function buttonMarkup(html: string, label: string): string {
  const button = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((markup): boolean => markup.replace(/<[^>]*>/g, '') === label);
  if (!button) throw new Error(`未找到实际按钮：${label}`);
  return button;
}
function prepareMarkup(): string {
  return renderToStaticMarkup(React.createElement(ProductionControls, { project, disabled: false, view: 'prepare', showMaterials: false }));
}
beforeEach((): void => {
  vi.clearAllMocks();
  // 离线渲染核对当前客户端快照；默认 SSR 会固定读取 Zustand 的初始空状态。
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation(<T,>(_subscribe: (onStoreChange: () => void) => () => void, getSnapshot: () => T): T => getSnapshot());
  const entry = { state: 'supported' as const, free: 'free' as const, reason: 'TEST 已保存检查' };
  capability = { accountId: 'TEST-account', checkedAt: now, freeEvidence: 'user_confirmed', durations: [5], image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' } };
  project = { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now }, plan: structuredClone(snapshot.plan) as PetStoryPlan, assets: [], jobs: [], updatedAt: now, storyApproval: { hash: 'TEST', at: now }, materials: [{ id: 'scene:location', entityId: 'location', kind: 'scene', name: 'TEST地点', designHash: 'TEST', selectedAssetId: 'TEST-image', approved: { assetId: 'TEST-image', sha256: 'TEST', at: now }, prompt: { original: 'TEST', optimized: 'TEST', final: 'TEST', edited: false, rulesVersion: 'TEST' } }] };
  usePetStoryStore.setState({ project, busy: false, capability, capabilityCheckedInSession: false, generateShotMedia: generate, productionCounts: { shots: 5, supporting: 1, newCharacters: 0, firstFrames: 5, lastFrames: 3, videos: 5 }, productionResolutions: {}, fallbacks: {} });
  useTaskStore.setState({ tasks: [] });
});
afterEach((): void => { usePetStoryStore.setState(initial.petstory); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });

describe('当前会话媒体入口授权', (): void => {
  it('已恢复能力时画布首帧和视频仍禁用，异步资格返回前也不凭会话检查解除禁用', (): void => {
    for (const kind of ['firstFrame', 'video'] as const) {
      const html = renderToStaticMarkup(React.createElement(CanvasMediaNode, { project, shot: project.plan!.shots[0], kind, disabled: false }));
      expect(buttonMarkup(html, kind === 'video' ? '生成视频' : '生成图片')).toContain('disabled');
      expect(html).toContain(`本次尚未检查${kind === 'video' ? '视频' : '图片'}入口`);
      expect(html).toContain('<summary>生成设置／入口检查</summary>');
      expect(html).not.toMatch(/<details[^>]*id="shot-entry-[^"]*"[^>]*\sopen(?:="")?/);
    }
    usePetStoryStore.setState({ capabilityCheckedInSession: true });
    const html = renderToStaticMarkup(React.createElement(CanvasMediaNode, { project, shot: project.plan!.shots[0], kind: 'video', disabled: false }));
    // SSR 不执行只读资格查询；“当前检查且后端 ready 才启用”由 DOM 点击测试验证。
    expect(buttonMarkup(html, '生成视频')).toContain('disabled'); expect(generate).not.toHaveBeenCalled();
  });
  it('已保存制作数量也不能绕过本会话入口核对，检查按钮保持可用', (): void => {
    const html = prepareMarkup();
    expect(buttonMarkup(html, '查看本次实际制作数量')).toContain('disabled');
    expect(buttonMarkup(html, '确认素材，继续镜头制作')).toContain('disabled');
    expect(buttonMarkup(html, '检查当前可见入口（不提交）')).not.toContain('disabled');
    expect(html).toContain('新增生成前请先检查当前会话的免费入口；已发送任务可只读恢复');
    usePetStoryStore.setState({ capabilityCheckedInSession: true });
    const checked = prepareMarkup();
    expect(buttonMarkup(checked, '查看本次实际制作数量')).not.toContain('disabled');
    expect(buttonMarkup(checked, '确认素材，继续镜头制作')).not.toContain('disabled');
  });
  it('暂停制作的继续按钮同样需要当前会话检查，查看进度不会生成媒体', (): void => {
    project.production = { state: 'paused', phase: 'shots', planHash: 'TEST', approvedAt: now, capability, fallbacks: {}, shots: {}, steps: [], message: 'TEST暂停' };
    const render = (): string => renderToStaticMarkup(React.createElement(ProductionControls, { project, disabled: false, view: 'progress', showMaterials: false }));
    expect(buttonMarkup(render(), '显式继续原制作')).toContain('disabled');
    usePetStoryStore.setState({ capabilityCheckedInSession: true });
    expect(buttonMarkup(render(), '显式继续原制作')).not.toContain('disabled'); expect(generate).not.toHaveBeenCalled();
  });
});
