/** 离线界面门禁回归：恢复与新建均无需人工检查，仍等待正常业务资格。 */
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
  const entry = { state: 'supported' as const, reason: 'TEST 已保存检查' };
  capability = { accountId: 'TEST-account', checkedAt: now, durations: [5], image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' } };
  project = { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now }, plan: structuredClone(snapshot.plan) as PetStoryPlan, assets: [], jobs: [], updatedAt: now, storyApproval: { hash: 'TEST', at: now }, materials: [{ id: 'scene:location', entityId: 'location', kind: 'scene', name: 'TEST地点', designHash: 'TEST', selectedAssetId: 'TEST-image', approved: { assetId: 'TEST-image', sha256: 'TEST', at: now }, prompt: { original: 'TEST', optimized: 'TEST', final: 'TEST', edited: false, rulesVersion: 'TEST' } }] };
  usePetStoryStore.setState({ project, busy: false, capability, generateShotMedia: generate, productionCounts: { shots: 5, supporting: 1, newCharacters: 0, firstFrames: 5, lastFrames: 3, videos: 5 }, productionResolutions: {}, fallbacks: {} });
  useTaskStore.setState({ tasks: [] });
});
afterEach((): void => { usePetStoryStore.setState(initial.petstory); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });

describe('媒体生成无需人工入口检查', (): void => {
  it('画布等待只读业务资格时不发送；不存在检查区、声明和检查时间', (): void => {
    for (const kind of ['firstFrame', 'video'] as const) {
      const html = renderToStaticMarkup(React.createElement(CanvasMediaNode, { project, shot: project.plan!.shots[0], kind, disabled: false }));
      expect(buttonMarkup(html, kind === 'video' ? '生成视频' : '生成图片')).toContain('disabled');
      expect(html).not.toMatch(/入口检查|本人已|免费权益|检查时间|同意逐图/);
    }
    expect(generate).not.toHaveBeenCalled();
  });
  it('制作数量与启动只依赖实际方案和素材，不依赖检查记录', (): void => {
    usePetStoryStore.setState({ capability: null });
    const html = prepareMarkup();
    expect(buttonMarkup(html, '查看本次实际制作数量')).not.toContain('disabled');
    expect(buttonMarkup(html, '确认素材，继续镜头制作')).not.toContain('disabled');
    expect(html).not.toMatch(/检查当前|本人已|免费|检查时间/);
  });
  it('暂停制作可直接继续，查看进度本身不会生成媒体', (): void => {
    project.production = { state: 'paused', phase: 'shots', planHash: 'TEST', approvedAt: now, capability, fallbacks: {}, shots: {}, steps: [], message: 'TEST暂停' };
    usePetStoryStore.setState({ capability: null });
    const html = renderToStaticMarkup(React.createElement(ProductionControls, { project, disabled: false, view: 'progress', showMaterials: false }));
    expect(buttonMarkup(html, '继续原制作')).not.toContain('disabled'); expect(generate).not.toHaveBeenCalled();
  });
});
