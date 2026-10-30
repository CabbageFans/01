/** 离线 DOM 点击回归：平台与持久化是明确替身，不属于真实豆包或 Electron 验收。 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryCapability, PetStoryChatJob, PetStoryGenerationEligibilityResult, PetStoryPlan, PetStoryProject, Task } from '@doubao-studio/contracts';
import { PetStoryPanel } from '../../src/components/PetStoryPanel';
import { PetStoryChatRecoveryActions, PetStoryCurrentTasks } from '../../src/components/PetStoryTaskRecovery';
import { CanvasMediaNode } from '../../src/components/PetStoryCanvasMedia';
import { PetStoryRuntime } from '../../src/components/PetStoryRuntime';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import { useProjectStore } from '../../src/store/useProjectStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { pendingPetStoryDrafts } from '../../src/utils/petstoryDraftPresence';

const originals = { pet: usePetStoryStore.getState(), accounts: useAccountStore.getState(), projects: useProjectStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-10-28T00:00:00.000Z';
const account: Account = { id: 'TEST-account', name: 'TEST 豆包账号', platform: 'doubao', avatar: '', partition: 'TEST-not-a-real-session', status: 'idle', pinned: false, createdAt: now, updatedAt: now };
let p: PetStoryProject;
function storedPlan(shotCount: number = 1): PetStoryPlan {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  plan.shots = plan.shots.slice(0, shotCount); // 同一用户故事的动态目标子集，只减少离线 DOM 渲染量。
  plan.characters.forEach((character): void => { delete character.referenceAssetId; });
  return plan;
}
function updateProject(change: (project: PetStoryProject) => void): void {
  const current = structuredClone(usePetStoryStore.getState().project || p); change(current); current.revision++;
  usePetStoryStore.setState({ project: current, error: '' });
}
function readyToAnalyze(): void {
  fireEvent.change(screen.getByRole('textbox', { name: '完整剧本原文' }), { target: { value: snapshot.mobileStory } });
}
function pausedMediaTask(state: 'done' | 'submitted' | 'unsubmitted'): Task {
  const entry = { state: 'supported' as const, reason: 'TEST 旧会话检查' };
  const capability: PetStoryCapability = { accountId: account.id, checkedAt: now, durations: [5], image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry } };
  p.plan = storedPlan();
  p.production = { phase: 'shots', state: 'paused', planHash: 'TEST', approvedAt: now, capability, fallbacks: {}, shots: {}, steps: [{ id: 'TEST-step', shotId: p.plan.shots[0].id, kind: 'firstFrame', taskId: 'TEST-media-task', status: 'bound', inputHash: 'TEST', attachmentAssetIds: [] }], message: 'TEST 原制作已暂停' };
  return { id: 'TEST-media-task', projectId: p.studioProjectId, assignedAccountId: account.id, mode: 'image', status: state === 'done' ? 'done' : 'paused', prompt: 'TEST 原制作请求', result: null, outputs: [], createdAt: now, updatedAt: now,
    ...(state === 'submitted' ? { runtime: { runId: 'TEST-media-run', attempt: 1, stage: 'generating', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, input: { mode: 'image', prompt: 'TEST 原制作请求', attachments: [] } } } : {})};
}
function readyMediaJourney(shotCount: number, materialCount: number): void {
  p.mobileStory = { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now }; p.plan = storedPlan(shotCount); p.storyApproval = { hash: 'TEST', at: now };
  p.materials = p.plan.characters.slice(0, materialCount).map((character): NonNullable<PetStoryProject['materials']>[number] => ({ id: `character:${character.id}`, kind: 'character', entityId: character.id, name: character.name, designHash: 'TEST', prompt: structuredClone(p.plan!.shots[0].prompts.firstFrame) }));
  const entry = { state: 'supported' as const, reason: 'TEST 本次检查' };
  const capability: PetStoryCapability = { accountId: p.accountId, checkedAt: now, durations: [5], image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' } };
  window.electronAPI.petstory.inspectGeneration = vi.fn(async (): Promise<PetStoryGenerationEligibilityResult> => ({ success: true, eligibility: { ready: true, blockers: [] } }));
  usePetStoryStore.setState({ project: p, capability});
}
beforeEach((): void => {
  p = { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: account.id, revision: 1, source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [], updatedAt: now };
  window.electronAPI = { petstory: {
    promptStageTargets: vi.fn(async (): Promise<{ success: true; promptTargets: [] }> => ({ success: true, promptTargets: [] })),
    inspectGeneration: vi.fn(async (): Promise<{ success: true; eligibility: { ready: false; blockers: [] } }> => ({ success: true, eligibility: { ready: false, blockers: [] } })),
    readReference: vi.fn(async (): Promise<{ success: false; error: string }> => ({ success: false, error: 'TEST 离线无图片' }))} } as unknown as typeof window.electronAPI;
  useAccountStore.setState({ ...originals.accounts, accounts: [account], selectedAccountId: account.id, error: null });
  useProjectStore.setState({ ...originals.projects, activeProjectId: p.studioProjectId, projects: [{ id: p.studioProjectId, name: 'TEST 关联项目', description: '', color: '#fff', archived: false, createdAt: now, updatedAt: now }] });
  useTaskStore.setState({ ...originals.tasks, tasks: [], activeTaskId: null, accountBusy: {} });
  usePetStoryStore.setState({ ...originals.pet, project: p, projectName: 'TEST 离线短剧', busy: false, error: '', capability: null, fallbacks: {}, promptBatch: { status: 'idle', total: 0, completed: 0 },
    saveOriginalStory: vi.fn(async (text: string): Promise<void> => updateProject((project): void => { project.mobileStory = { id: 'TEST-story', text, importedAt: now }; })),
    saveSource: vi.fn(async (): Promise<void> => undefined),
    analyze: vi.fn(async (): Promise<void> => undefined),
    confirmStory: vi.fn(async (): Promise<void> => updateProject((project): void => { project.storyApproval = { hash: 'TEST-offline-confirmation', at: now }; }))});
});
afterEach((): void => {
  usePetStoryStore.setState(originals.pet); useAccountStore.setState(originals.accounts); useProjectStore.setState(originals.projects); useTaskStore.setState(originals.tasks); vi.restoreAllMocks();
});

describe('正常可见的六阶段与直接剧本入口', (): void => {
  it.each(['applied', 'invalid'] as const)('完整方案候选为%s时仅合格候选可采用，坏回复仍可在豆包中调整', (status: 'applied' | 'invalid'): void => {
    p.jobs = [{ id: 'TEST-status-candidate', taskId: 'TEST-status-task', kind: 'analysis', status, resultStatus: 'candidate', requestId: 'TEST-request', inputHash: 'TEST', sourceUrl: '', parsedResult: { plan: storedPlan() } }];
    const adopt = vi.fn(async (): Promise<void> => undefined); const adjust = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ project: p, adoptPlanCandidate: adopt, openChatAdjustment: adjust });
    render(<PetStoryRuntime project={p} disabled={false} />);
    if (status === 'applied') {
      const adoptButton = screen.getByRole('button', { name: '确认并采用方案' });
      expect(adoptButton.hasAttribute('disabled')).toBe(false);
      fireEvent.click(adoptButton); fireEvent.click(screen.getByRole('button', { name: '在豆包中调整' }));
      expect(adopt).toHaveBeenCalledWith('TEST-status-candidate'); expect(adjust).toHaveBeenCalledWith({ parentJobId: 'TEST-status-candidate' });
    } else {
      expect(screen.queryByRole('button', { name: '确认并采用方案' })).toBeNull();
      const adjustment = screen.getAllByRole('button', { name: '在豆包中调整' })[0];
      expect(screen.getByText('分镜方案需要复核')).toBeDefined();
      expect(adopt).not.toHaveBeenCalled(); expect(adjust).not.toHaveBeenCalled();
      fireEvent.click(adjustment); expect(adjust).toHaveBeenCalledWith({ parentJobId: 'TEST-status-candidate' });
    }
  });
  it('默认显示原文框和六步导航，可选链接与演员高级字段保持折叠，不在打开时发送', async (): Promise<void> => {
    const analyze = usePetStoryStore.getState().analyze; render(<PetStoryPanel />);
    expect(screen.getByRole('textbox', { name: '完整剧本原文' })).toBeDefined();
    expect(screen.queryByRole('textbox', { name: '抖音分享文本或链接' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'luluidentity预设' })).toBeNull();
    expect(within(screen.getByRole('navigation', { name: '短剧制作阶段' })).getAllByRole('button')).toHaveLength(6);
    expect(screen.getByRole('button', { name: '分析剧本' }).hasAttribute('disabled')).toBe(true);
    await act(async (): Promise<void> => undefined); expect(analyze).not.toHaveBeenCalled();
  });
  it.each(['制作关键帧', '制作镜头视频'])('%s沿用完整四列画布、故事栏和缩放，不因浏览阶段生成', async (stageName: string): Promise<void> => {
    readyMediaJourney(1, 1);
    const generate = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ generateShotMedia: generate }); render(<PetStoryPanel />);
    fireEvent.click(within(screen.getByRole('navigation', { name: '短剧制作阶段' })).getByRole('button', { name: new RegExp(stageName) }));
    const canvas = document.querySelector<HTMLElement>('.storyboard-workspace');
    expect(canvas?.querySelector('.canvas-story-column')).not.toBeNull();
    expect(canvas?.querySelector('.canvas-shot-row')?.children.length).toBe(4);
    expect(canvas?.querySelector<HTMLElement>('.canvas-content')?.style.transform).toMatch(/translate.*scale/);
    expect(screen.getByRole('button', { name: '缩小画布' })).toBeDefined();
    expect(screen.getByRole('button', { name: '放大画布' })).toBeDefined();
    await act(async (): Promise<void> => undefined); expect(generate).not.toHaveBeenCalled();
  });
  it('批量制作暂停等待图片采用时，方案锁不阻断候选预览与采用', async (): Promise<void> => {
    readyMediaJourney(1, 1); pausedMediaTask('done');
    const shot = p.plan!.shots[0]; p.production!.steps[0].status = 'complete';
    p.assets = [{ id: 'TEST-awaiting-image', kind: 'firstFrame', shotId: shot.id, relativePath: 'TEST/candidate.png', imageReview: { state: 'candidate', target: { shotId: shot.id, kind: 'firstFrame' }, basisHash: 'TEST' } }];
    window.electronAPI.petstory.readReference = vi.fn(async (): Promise<{ success: true; data: string }> => ({ success: true, data: 'data:image/png;base64,TEST' }));
    const adopt = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ project: p, adoptShotImage: adopt });
    render(<PetStoryPanel />); fireEvent.click(within(screen.getByRole('navigation', { name: '短剧制作阶段' })).getByRole('button', { name: /制作关键帧/ }));
    const preview = screen.getByRole('button', { name: '查看图片' }); expect(preview.hasAttribute('disabled')).toBe(false); fireEvent.click(preview);
    const dialog = screen.getByRole('dialog', { name: `镜头 ${shot.order} · 首帧 · 选择图片` });
    await waitFor((): void => expect(within(dialog).getByRole('button', { name: '满意，采用图片' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(within(dialog).getByRole('button', { name: '满意，采用图片' }));
    await waitFor((): void => expect(adopt).toHaveBeenCalledWith(shot.id, 'firstFrame', 'TEST-awaiting-image'));
  });
  it('保存失败时保留用户原文和失败原因，不调用分析', async (): Promise<void> => {
    const save = vi.fn(async (): Promise<void> => { usePetStoryStore.setState({ error: 'TEST 磁盘保存失败' }); });
    usePetStoryStore.setState({ saveOriginalStory: save }); const analyze = usePetStoryStore.getState().analyze;
    render(<PetStoryPanel />); readyToAnalyze();
    fireEvent.click(screen.getByRole('button', { name: '分析剧本' }));
    await waitFor((): void => expect(save).toHaveBeenCalledOnce());
    expect(analyze).not.toHaveBeenCalled(); expect(screen.getByText('TEST 磁盘保存失败')).toBeDefined();
    expect((screen.getByRole('textbox', { name: '完整剧本原文' }) as HTMLTextAreaElement).value).toBe(snapshot.mobileStory);
  });
  it('分析结果通过服务替身返回后自然显示方案，用户另行确认后进入素材阶段', async (): Promise<void> => {
    const analyze = vi.fn(async (): Promise<void> => updateProject((project): void => {
      project.plan = storedPlan(); project.jobs.push({ id: 'TEST-analysis', taskId: 'TEST-analysis-task', kind: 'analysis', status: 'applied', resultStatus: 'adopted', requestId: 'TEST-request', inputHash: 'TEST', sourceUrl: '', parsedResult: { plan: structuredClone(project.plan) } });
    }));
    usePetStoryStore.setState({ analyze }); const confirm = usePetStoryStore.getState().confirmStory;
    render(<PetStoryPanel />); readyToAnalyze();
    fireEvent.click(screen.getByRole('button', { name: '分析剧本' }));
    await waitFor((): void => expect(screen.getByText('当前：确认方案')).toBeDefined());
    expect(analyze).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByText('当前方案待确认')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '确认并采用方案' }));
    await waitFor((): void => expect(screen.getByText('方案已采用')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: '准备基础素材' }));
    await waitFor((): void => expect(screen.getByText('当前：准备基础素材')).toBeDefined());
    expect(confirm).toHaveBeenCalledOnce(); expect(usePetStoryStore.getState().project?.assets).toEqual([]);
  });
  it('首次分析只展示候选，明确确认并采用后才形成制作依据', async (): Promise<void> => {
    const analyze = vi.fn(async (): Promise<void> => updateProject((project): void => {
      project.jobs.push({ id: 'TEST-first-candidate', taskId: 'TEST-first-task', kind: 'analysis', status: 'applied', resultStatus: 'candidate', requestId: 'TEST-first-request', inputHash: 'TEST', sourceUrl: '', parsedResult: { plan: storedPlan() } });
    }));
    const adopt = vi.fn(async (jobId: string): Promise<void> => updateProject((project): void => {
      const job = project.jobs.find((item): boolean => item.id === jobId);
      if (job?.parsedResult?.plan) { project.plan = structuredClone(job.parsedResult.plan); job.resultStatus = 'adopted'; }
    }));
    usePetStoryStore.setState({ analyze, adoptPlanCandidate: adopt }); render(<PetStoryPanel />); readyToAnalyze();
    fireEvent.click(screen.getByRole('button', { name: '分析剧本' }));
    await waitFor((): void => expect(screen.getByText('当前：确认方案')).toBeDefined());
    expect(usePetStoryStore.getState().project?.plan).toBeUndefined();
    expect(usePetStoryStore.getState().confirmStory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认并采用方案' }));
    await waitFor((): void => expect(adopt).toHaveBeenCalledWith('TEST-first-candidate'));
    await waitFor((): void => expect(screen.getByText('方案已采用')).toBeDefined());
    expect(usePetStoryStore.getState().project?.assets).toEqual([]);
  });
  it('本次重新分析失败时不把历史已采用方案误报为本次成功', async (): Promise<void> => {
    p.mobileStory = { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now }; p.plan = storedPlan();
    p.jobs = [{ id: 'TEST-history-analysis', taskId: 'TEST-history-task', kind: 'analysis', status: 'applied', resultStatus: 'adopted', requestId: 'TEST-history-request', inputHash: 'TEST-history', sourceUrl: '', parsedResult: { plan: storedPlan() } }];
    const analyze = vi.fn(async (): Promise<void> => { usePetStoryStore.setState({ error: 'TEST 本次分析未能创建任务' }); });
    usePetStoryStore.setState({ project: p, analyze }); render(<PetStoryPanel />);
    fireEvent.click(within(screen.getByRole('navigation', { name: '短剧制作阶段' })).getByRole('button', { name: /输入剧本/ }));
    readyToAnalyze(); fireEvent.click(screen.getByRole('button', { name: '分析剧本' }));
    await waitFor((): void => expect(screen.getByText('TEST 本次分析未能创建任务')).toBeDefined());
    expect(screen.getByText('当前：输入剧本')).toBeDefined(); expect(screen.queryByText(/^方案已就绪/)).toBeNull();
    expect(analyze).toHaveBeenCalledOnce(); expect(usePetStoryStore.getState().project?.jobs).toHaveLength(1);
  });
  it('原分析仍未决时显示真实等待原因并禁用重复分析，收取入口保持可达', async (): Promise<void> => {
    p.mobileStory = { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now };
    p.jobs = [{ id: 'TEST-live-analysis', taskId: 'TEST-live-task', kind: 'analysis', status: 'bound', requestId: 'TEST-live-request', inputHash: 'TEST', sourceUrl: '' }];
    const analyze = usePetStoryStore.getState().analyze; usePetStoryStore.setState({ project: p}); render(<PetStoryPanel />);
    const button = screen.getByRole('button', { name: '分析剧本' }); expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('正在处理原文字任务，请在下方查看进度或恢复原回复。')).toBeDefined();
    expect(screen.getByText('待处理事项')).toBeDefined();
    fireEvent.click(button); await act(async (): Promise<void> => undefined); expect(analyze).not.toHaveBeenCalled();
  });
  it.each(['制作关键帧', '制作镜头视频'])('%s阶段发现基础素材文字缺项时，主按钮直接返回补齐位置且不误发镜头请求', async (stageName: string): Promise<void> => {
    p.mobileStory = { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now }; p.plan = storedPlan(); p.storyApproval = { hash: 'TEST', at: now };
    window.electronAPI.petstory.promptStageTargets = vi.fn(async (): Promise<import('@doubao-studio/contracts').PetStoryResult> => ({ success: true, promptTargets: [{ materialId: 'TEST-missing-material' }] }));
    const continueStage = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ project: p, continuePromptStage: continueStage }); render(<PetStoryPanel />);
    fireEvent.click(within(screen.getByRole('navigation', { name: '短剧制作阶段' })).getByRole('button', { name: new RegExp(stageName) }));
    const button = await screen.findByRole('button', { name: '去补充素材提示词' });
    expect(screen.getByText('基础素材文字尚有缺项，请先进入素材准备补齐。')).toBeDefined(); fireEvent.click(button);
    expect(screen.getByText('当前：准备基础素材')).toBeDefined(); expect(continueStage).not.toHaveBeenCalled();
    expect(document.querySelector('details[aria-label="批量提示词操作"]')).toBeNull();
    expect(screen.queryByRole('button', { name: '生成缺失提示词' })).toBeNull();
    expect(continueStage).not.toHaveBeenCalled();
  });
  it.each(['制作关键帧', '制作镜头视频'])('%s返回素材直接操作图片，保留已有手改正文', async (stageName: string): Promise<void> => {
    readyMediaJourney(1, 1); const material = p.materials![0]; material.prompt.edited = true;
    window.electronAPI.petstory.promptStageTargets = vi.fn(async (): Promise<import('@doubao-studio/contracts').PetStoryResult> => ({ success: true, promptTargets: [{ materialId: material.id }] }));
    const generate = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ generateMaterialImage: generate }); render(<PetStoryPanel />);
    const navigation = screen.getByRole('navigation', { name: '短剧制作阶段' }); fireEvent.click(within(navigation).getByRole('button', { name: new RegExp(stageName) }));
    const returnButton = await screen.findByRole('button', { name: '去补充素材提示词' }); fireEvent.click(returnButton);
    expect(screen.getByText('当前：准备基础素材')).toBeDefined();
    const materialCard = document.getElementById(`material-${material.id}`); if (!materialCard) throw new Error('实际素材卡缺失');
    expect(within(materialCard).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(materialCard).getByRole('button', { name: '生成图片' }));
    await waitFor((): void => expect(generate).toHaveBeenCalledExactlyOnceWith(material.id));
    expect(p.materials![0].prompt.final).toBe(material.prompt.final); expect(p.materials![0].prompt.edited).toBe(true);
  });
  it('新分析缺项后沿同一分析的修订子任务收到方案，自动交接到方案确认', async (): Promise<void> => {
    const root: PetStoryChatJob = { id: 'TEST-new-analysis', taskId: 'TEST-new-task', kind: 'analysis', status: 'invalid', requestId: 'TEST-new-request', inputHash: 'TEST-new', sourceUrl: '', error: 'TEST 回复缺少方案字段' };
    const analyze = vi.fn(async (): Promise<void> => updateProject((project): void => { project.jobs.push(root); }));
    usePetStoryStore.setState({ analyze }); render(<PetStoryPanel />); readyToAnalyze();
    fireEvent.click(screen.getByRole('button', { name: '分析剧本' }));
    await waitFor((): void => expect(screen.getAllByText('TEST 回复缺少方案字段').length).toBeGreaterThan(0));
    expect(screen.getByText('当前：输入剧本')).toBeDefined(); expect(screen.queryByText(/^方案已就绪/)).toBeNull();
    // 离线模拟原服务后来保存的 repair 回复；不是 Electron 流程验收或人工编写真实模型回复。
    await act(async (): Promise<void> => updateProject((project): void => {
      project.plan = storedPlan(); project.jobs.push({ ...root, id: 'TEST-repair', taskId: 'TEST-repair-task', kind: 'repair', parentJobId: root.id, status: 'applied', resultStatus: 'adopted', error: undefined, parsedResult: { plan: storedPlan() } });
    }));
    await waitFor((): void => expect(screen.getByText('当前：确认方案')).toBeDefined());
    expect(screen.getByText(/^方案已就绪/)).toBeDefined();
    expect(usePetStoryStore.getState().confirmStory).not.toHaveBeenCalled();
  });
  it('分析服务返回前修订子任务已保存时，同样交接到本次方案而非停在输入页', async (): Promise<void> => {
    const analyze = vi.fn(async (): Promise<void> => updateProject((project): void => {
      const root: PetStoryChatJob = { id: 'TEST-new-analysis', taskId: 'TEST-new-task', kind: 'analysis', status: 'invalid', requestId: 'TEST-new-request', inputHash: 'TEST-new', sourceUrl: '' };
      project.plan = storedPlan(); project.jobs.push(root, { ...root, id: 'TEST-repair', taskId: 'TEST-repair-task', kind: 'repair', parentJobId: root.id, status: 'applied', resultStatus: 'adopted', parsedResult: { plan: storedPlan() } });
    }));
    usePetStoryStore.setState({ analyze }); render(<PetStoryPanel />); readyToAnalyze();
    fireEvent.click(screen.getByRole('button', { name: '分析剧本' }));
    await waitFor((): void => expect(screen.getByText('当前：确认方案')).toBeDefined());
    expect(screen.getByText(/^方案已就绪/)).toBeDefined(); expect(analyze).toHaveBeenCalledOnce();
    expect(usePetStoryStore.getState().confirmStory).not.toHaveBeenCalled();
  });
  it('其他目标等待记录保留，素材页不暴露文字批量操作或自动接续它', async (): Promise<void> => {
    readyMediaJourney(1, 1); const before = { id: 'TEST-other-job', taskId: 'TEST-other-task', kind: 'optimize' as const, shotId: 'TEST-other-shot', promptKind: 'video' as const, status: 'bound' as const, requestId: 'TEST-other-request', inputHash: 'TEST-other', sourceUrl: '' }; p.jobs = [before];
    const continueStage = vi.fn(async (): Promise<void> => undefined); const generate = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ project: p, continuePromptStage: continueStage, generateMaterialImage: generate }); render(<PetStoryPanel />);
    expect(document.querySelector('details[aria-label="批量提示词操作"]')).toBeNull();
    const card = document.getElementById(`material-${p.materials![0].id}`); if (!card) throw new Error('素材卡缺失');
    fireEvent.click(within(card).getByRole('button', { name: '生成图片' }));
    await waitFor((): void => expect(generate).toHaveBeenCalledExactlyOnceWith(p.materials![0].id));
    expect(continueStage).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().project?.jobs[0]).toEqual(before);
  });
  it('重开保留旧素材文字批次，查看素材不自动继续或恢复旧批量入口', async (): Promise<void> => {
    readyMediaJourney(1, 1); p.promptBatch = { status: 'paused', total: 3, completed: 1, targets: [{ materialId: 'TEST-material-one' }, { materialId: 'TEST-material-two' }] };
    const continueStage = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ project: p, continuePromptStage: continueStage }); render(<PetStoryPanel />);
    await act(async (): Promise<void> => undefined);
    expect(screen.queryByRole('button', { name: '继续提示词制作' })).toBeNull(); expect(document.querySelector('details[aria-label="批量提示词操作"]')).toBeNull();
    expect(continueStage).not.toHaveBeenCalled(); expect(usePetStoryStore.getState().project?.promptBatch).toEqual(p.promptBatch);
  });
  it('已有未采用方案候选先采用再确认；查看候选不会自动采用或确认', async (): Promise<void> => {
    const candidate: PetStoryChatJob = { id: 'TEST-analysis', taskId: 'TEST-analysis-task', kind: 'analysis', status: 'applied', resultStatus: 'candidate', requestId: 'TEST-request', inputHash: 'TEST', sourceUrl: '', parsedResult: { plan: storedPlan() } };
    p.mobileStory = { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now }; p.jobs = [candidate];
    const adopt = vi.fn(async (): Promise<void> => updateProject((project): void => { project.plan = structuredClone(candidate.parsedResult!.plan); project.jobs[0].resultStatus = 'adopted'; }));
    usePetStoryStore.setState({ project: p, adoptPlanCandidate: adopt }); const confirm = usePetStoryStore.getState().confirmStory;
    render(<PetStoryPanel />);
    await waitFor((): void => expect(screen.getByRole('button', { name: '确认并采用方案' })).toBeDefined());
    const adoptButton = screen.getByRole('button', { name: '确认并采用方案' });
    const candidateArticle = adoptButton.closest('article')!;
    const previewSummary = within(candidateArticle).getByText('查看完整方案');
    const fullPreview = previewSummary.closest('details')!;
    expect(fullPreview.open).toBe(false);
    expect(adoptButton.classList.contains('ant-btn-primary')).toBe(true);
    expect(adoptButton.compareDocumentPosition(fullPreview) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(within(candidateArticle).getAllByRole('button', { name: '确认并采用方案' })).toHaveLength(1);
    expect(within(candidateArticle).getAllByRole('button', { name: '在豆包中调整' })).toHaveLength(1);
    expect(within(candidateArticle).getByText(/个镜头 · .*人物 \/ .*道具/).closest('details')).toBeNull();
    expect(candidateArticle.querySelector('.petstory-plan-diagnostics')?.hasAttribute('open')).toBe(false);
    fireEvent.click(previewSummary); // 展开完整字段仍只是查看，不触发采用或确认。
    expect(screen.getByRole('button', { name: '确认并采用方案' }).hasAttribute('disabled')).toBe(false);
    expect(adopt).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认并采用方案' }));
    await waitFor((): void => expect(screen.getByText('方案已采用')).toBeDefined());
    expect(adopt).toHaveBeenCalledOnce(); expect(confirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '确认并采用方案' })).toBeNull();
  });
  it('可选链接草稿不会阻止返回直接剧本模式保存并分析', async (): Promise<void> => {
    const analyze = usePetStoryStore.getState().analyze; const saveLink = usePetStoryStore.getState().saveSource;
    render(<PetStoryPanel />);
    fireEvent.click(screen.getByText('从抖音链接辅助提取', { exact: true }));
    fireEvent.change(screen.getByRole('textbox', { name: '抖音分享文本或链接' }), { target: { value: 'TEST 可选未保存分享文本' } });
    fireEvent.click(screen.getByRole('button', { name: '返回剧本输入' }));
    readyToAnalyze(); fireEvent.click(screen.getByRole('button', { name: '分析剧本' }));
    await waitFor((): void => expect(analyze).toHaveBeenCalledOnce()); expect(saveLink).not.toHaveBeenCalled();
  });
  it('跨页草稿显示具体对象，查看修改返回原输入，放弃后解除提示', async (): Promise<void> => {
    render(<PetStoryPanel />);
    fireEvent.change(screen.getByRole('textbox', { name: '完整剧本原文' }), { target: { value: snapshot.mobileStory } });
    fireEvent.click(within(screen.getByRole('navigation', { name: '短剧制作阶段' })).getByRole('button', { name: /确认方案/ }));
    expect(screen.getByText('原剧本 · 输入剧本')).toBeDefined(); expect(screen.queryByRole('textbox', { name: '完整剧本原文' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看修改' }));
    expect((screen.getByRole('textbox', { name: '完整剧本原文' }) as HTMLTextAreaElement).value).toBe(snapshot.mobileStory);
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }));
    await waitFor((): void => expect(screen.queryByText('原剧本 · 输入剧本')).toBeNull());
    expect((screen.getByRole('textbox', { name: '完整剧本原文' }) as HTMLTextAreaElement).value).toBe('');
  });
  it('剧本、链接、人物偏好和方案草稿都带项目归属，外部采用门可完整读取', async (): Promise<void> => {
    p.plan = storedPlan(); p.mobileStory = { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now };
    usePetStoryStore.setState({ project: p }); const view = render(<PetStoryPanel />);
    const navigation = screen.getByRole('navigation', { name: '短剧制作阶段' }); fireEvent.click(within(navigation).getByRole('button', { name: /输入剧本/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '完整剧本原文' }), { target: { value: 'TEST未保存剧本' } });
    fireEvent.click(screen.getByRole('button', { name: '从抖音链接辅助提取' }));
    fireEvent.change(screen.getByRole('textbox', { name: '抖音分享文本或链接' }), { target: { value: 'TEST未保存链接' } });
    fireEvent.click(screen.getByText('默认角色与共同风格（可编辑）'));
    fireEvent.change(screen.getByRole('textbox', { name: 'luluidentity预设' }), { target: { value: 'TEST未保存人物身份' } });
    fireEvent.click(within(navigation).getByRole('button', { name: /确认方案/ }));
    fireEvent.click(screen.getByText('生成记录／诊断详情'));
    fireEvent.click(within(screen.getByRole('article', { name: '方案审阅' })).getByRole('button', { name: '编辑故事与镜头' }));
    fireEvent.change(screen.getByRole('textbox', { name: '原片梗概' }), { target: { value: 'TEST未保存方案' } });
    await waitFor((): void => expect(pendingPetStoryDrafts(p.id)).toEqual(expect.arrayContaining(['原剧本 · 输入剧本', '可选抖音链接 · 输入剧本', '制作演员与共同风格 · 输入剧本', '故事、角色与镜头设定 · 高级编辑'])));
    expect(pendingPetStoryDrafts(`${p.id}-other`)).toEqual([]);
    view.unmount(); expect(pendingPetStoryDrafts(p.id)).toEqual([]);
  });
  it('跨页草稿可直接保存，保存成功解除对象提示且不调用分析', async (): Promise<void> => {
    const analyze = usePetStoryStore.getState().analyze; const save = usePetStoryStore.getState().saveOriginalStory;
    render(<PetStoryPanel />);
    fireEvent.change(screen.getByRole('textbox', { name: '完整剧本原文' }), { target: { value: snapshot.mobileStory } });
    fireEvent.click(within(screen.getByRole('navigation', { name: '短剧制作阶段' })).getByRole('button', { name: /确认方案/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存并继续' }));
    await waitFor((): void => expect(screen.queryByText('原剧本 · 输入剧本')).toBeNull());
    expect(save).toHaveBeenCalledWith(snapshot.mobileStory); expect(analyze).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('navigation', { name: '短剧制作阶段' })).getByRole('button', { name: /输入剧本/ }));
    expect((screen.getByRole('textbox', { name: '完整剧本原文' }) as HTMLTextAreaElement).value).toBe(snapshot.mobileStory);
  });
  it('重开有成果方案只显示已有结果与真实缺项，不因六步导航或画布查看调用生成', async (): Promise<void> => {
    p.mobileStory = { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now }; p.plan = storedPlan();
    usePetStoryStore.setState({ project: p });
    const analyze = usePetStoryStore.getState().analyze; const confirm = usePetStoryStore.getState().confirmStory;
    const generate = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ generateShotMedia: generate });
    render(<PetStoryPanel />);
    await waitFor((): void => expect(screen.getByText('当前：确认方案')).toBeDefined());
    fireEvent.click(within(screen.getByRole('navigation', { name: '短剧制作阶段' })).getByRole('button', { name: /查看成果/ }));
    expect(screen.getByText('逐镜素材成果')).toBeDefined();
    expect(screen.getByRole('button', { name: '去制作本镜首帧' })).toBeDefined();
    expect(analyze).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });
  it('素材无需正文检查或中间文字入口，一次点击图片操作接管准备', async (): Promise<void> => {
    p.mobileStory = { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now }; p.plan = storedPlan(); p.storyApproval = { hash: 'TEST', at: now };
    const character = p.plan.characters[0];
    p.materials = [{ id: `character:${character.id}`, kind: 'character', entityId: character.id, name: character.name, designHash: 'TEST', prompt: { original: character.description, final: '', optimized: '', edited: false, rulesVersion: 'TEST' } }];
    const generate = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ project: p, generateMaterialImage: generate }); render(<PetStoryPanel />);
    await waitFor((): void => expect(screen.getByText('当前：准备基础素材')).toBeDefined());
    const card = document.getElementById(`material-${p.materials[0].id}`); if (!card) throw new Error('当前素材卡缺失');
    expect(card.textContent).not.toMatch(/提示词|诊断|更多操作|入口检查/); expect(within(card).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: '生成图片' })); await waitFor((): void => expect(generate).toHaveBeenCalledExactlyOnceWith(p.materials![0].id));
  });

  it('未确认方案进入素材阶段只呈一个确认入口，返回方案不调用采用或生成', async (): Promise<void> => {
    readyMediaJourney(1, 1); delete p.storyApproval;
    const generate = vi.fn(async (): Promise<void> => undefined);
    const prepare = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ project: p, generateMaterials: generate, regenerateMaterialPrompt: prepare });
    const confirm = usePetStoryStore.getState().confirmStory;
    render(<PetStoryPanel />);
    fireEvent.click(within(screen.getByRole('navigation', { name: '短剧制作阶段' })).getByRole('button', { name: /准备基础素材/ }));
    const materials = document.querySelector<HTMLElement>('.petstory-materials-panel'); if (!materials) throw new Error('素材阶段缺失');
    expect(within(materials).getAllByRole('button')).toHaveLength(1);
    const review = within(materials).getByRole('button', { name: '查看并确认方案' });
    expect(review.classList.contains('ant-btn-primary')).toBe(true);
    expect(within(materials).queryByText('生成设置／入口检查')).toBeNull();
    expect(document.querySelector('details[aria-label="批量提示词操作"]')).toBeNull();
    fireEvent.click(review);
    expect(screen.getByText('当前：确认方案')).toBeDefined();
    expect(confirm).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });
  it('素材缺正文时直接生成图片，上传仍可用且无需媒体入口检查', async (): Promise<void> => {
    readyMediaJourney(1, 1); const material = p.materials![0]; material.prompt = { original: 'TEST设计摘要', final: '', optimized: '', edited: false, rulesVersion: 'TEST' };
    const generate = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ project: p, capability: null, generateMaterialImage: generate }); render(<PetStoryPanel />);
    const card = document.getElementById(`material-${material.id}`); if (!card) throw new Error('素材卡缺失');
    const action = within(card).getByRole('button', { name: '生成图片' }); expect(action.classList.contains('ant-btn-primary')).toBe(true); expect(action.hasAttribute('disabled')).toBe(false);
    expect(within(card).queryByRole('button', { name: '生成提示词' })).toBeNull(); expect(within(card).getByRole('button', { name: '上传图片' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(action); await waitFor((): void => expect(generate).toHaveBeenCalledExactlyOnceWith(material.id)); expect(usePetStoryStore.getState().project?.assets).toEqual([]);
  });

});

describe('默认可见的任务恢复与新建账号处理', (): void => {
  it('结束等待的原任务未保存会话地址时明确引导找回历史对话，仍沿原恢复处理器只读检查', async (): Promise<void> => {
    const job: PetStoryChatJob = { id: 'TEST-ended-job', taskId: 'TEST-ended-task', kind: 'analysis', status: 'bound', requestId: 'TEST-request', inputHash: 'TEST', sourceUrl: '', runId: 'TEST-original-run', endedWaitingAt: now }; p.jobs = [job];
    const task: Task = { id: job.taskId, projectId: p.studioProjectId, assignedAccountId: p.accountId, mode: 'chat', status: 'paused', prompt: 'TEST 原请求', result: null, outputs: [], createdAt: now, updatedAt: now, runtime: { runId: job.runId!, attempt: 1, stage: 'submitting', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, input: { mode: 'chat', prompt: 'TEST 原请求', attachments: [] } } };
    const recover = vi.fn(async (): Promise<void> => undefined); const before = structuredClone({ project: p, task });
    const other = { ...account, id: 'TEST-other-browser', name: 'TEST 其他浏览账号', partition: 'TEST-other-partition' };
    const select = vi.fn((id: string | null): void => useAccountStore.setState({ selectedAccountId: id }));
    const dispatch = vi.spyOn(window, 'dispatchEvent'); useAccountStore.setState({ accounts: [account, other], selectedAccountId: other.id, selectAccount: select });
    usePetStoryStore.setState({ project: p, recoverChat: recover }); useTaskStore.setState({ tasks: [task], accountAutomationState: {} }); render(<PetStoryChatRecoveryActions project={p} job={job} task={task} />);
    expect(screen.getByRole('button', { name: '打开执行账号豆包' })).toBeDefined(); expect(screen.queryByRole('button', { name: '打开对应豆包会话' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('原任务未保存可直接打开的会话地址。请在右侧该账号的历史对话中找到原请求，再点击“检查原回复”；只有唯一匹配才会保存，不会重复发送。');
    fireEvent.click(screen.getByRole('button', { name: '打开执行账号豆包' }));
    expect(select).toHaveBeenCalledWith(task.assignedAccountId); expect(useAccountStore.getState().selectedAccountId).toBe(task.assignedAccountId);
    expect(dispatch.mock.calls.some(([event]): boolean => event.type === 'reveal-workspace-browser')).toBe(true);
    expect(dispatch.mock.calls.some(([event]): boolean => event.type === 'open-task-conversation')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '检查原回复（不重复发送）' })); await waitFor((): void => expect(recover).toHaveBeenCalledWith(job.id));
    expect(usePetStoryStore.getState().project).toEqual(before.project); expect(useTaskStore.getState().tasks).toEqual([before.task]);
    expect(screen.queryByRole('button', { name: '继续原文字任务（尚未发送）' })).toBeNull();
  });
  it('无会话地址时打开执行账号仍遵守另一账号的提交租约，不切换账号或派发导航', async (): Promise<void> => {
    const job: PetStoryChatJob = { id: 'TEST-ended-job', taskId: 'TEST-ended-task', kind: 'analysis', status: 'bound', inputHash: 'TEST', sourceUrl: '', endedWaitingAt: now }; p.jobs = [job];
    const task: Task = { id: job.taskId, projectId: p.studioProjectId, assignedAccountId: p.accountId, mode: 'chat', status: 'paused', prompt: 'TEST 原请求', result: null, outputs: [], createdAt: now, updatedAt: now };
    const other = { ...account, id: 'TEST-submitting-account', name: 'TEST 正在提交账号', partition: 'TEST-submitting-partition' };
    const select = vi.fn((id: string | null): void => useAccountStore.setState({ selectedAccountId: id })); const dispatch = vi.spyOn(window, 'dispatchEvent');
    const before = structuredClone({ project: p, task }); useAccountStore.setState({ accounts: [account, other], selectedAccountId: other.id, selectAccount: select });
    usePetStoryStore.setState({ project: p }); useTaskStore.setState({ tasks: [task], accountAutomationState: { [other.id]: 'submitting' } }); render(<PetStoryChatRecoveryActions project={p} job={job} task={task} />);
    fireEvent.click(screen.getByRole('button', { name: '打开执行账号豆包' })); await act(async (): Promise<void> => undefined);
    expect(select).not.toHaveBeenCalled(); expect(useAccountStore.getState().selectedAccountId).toBe(other.id);
    expect(dispatch.mock.calls.some(([event]): boolean => ['reveal-workspace-browser', 'open-task-conversation'].includes(event.type))).toBe(false);
    expect(useTaskStore.getState().accountAutomationState).toEqual({ [other.id]: 'submitting' });
    expect(usePetStoryStore.getState().project).toEqual(before.project); expect(useTaskStore.getState().tasks).toEqual([before.task]);
  });
  it('回复尚未保存时收取按钮保持禁用，原任务保存回复后才允许收取同一任务', async (): Promise<void> => {
    const job: PetStoryChatJob = { id: 'TEST-waiting-job', taskId: 'TEST-waiting-task', kind: 'analysis', status: 'bound', requestId: 'TEST-request', inputHash: 'TEST', sourceUrl: '' }; p.jobs = [job];
    const task: Task = { id: job.taskId, projectId: p.studioProjectId, assignedAccountId: p.accountId, mode: 'chat', status: 'generating', prompt: 'TEST 原请求', result: null, outputs: [], createdAt: now, updatedAt: now, runtime: { runId: 'TEST-run', attempt: 1, stage: 'generating', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, input: { mode: 'chat', prompt: 'TEST 原请求', attachments: [] } } };
    const collect = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ project: p, collect }); useTaskStore.setState({ tasks: [task] }); render(<PetStoryCurrentTasks project={p} />);
    const button = screen.getByRole('button', { name: '重新保存回复' }); expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button); expect(collect).not.toHaveBeenCalled();
    await act(async (): Promise<void> => { useTaskStore.setState({ tasks: [{ ...task, runtime: { ...task.runtime!, chatResponse: { text: 'TEST 离线已保存回复', capturedAt: now } } }] }); });
    expect(button.hasAttribute('disabled')).toBe(false); fireEvent.click(button);
    await waitFor((): void => expect(collect).toHaveBeenCalledWith(job.id)); expect(useTaskStore.getState().tasks).toHaveLength(1);
  });
  it('已捕获的原回复可直接沿原任务收取，不要求另造一次 chatResponse', async (): Promise<void> => {
    const job: PetStoryChatJob = { id: 'TEST-captured-job', taskId: 'TEST-captured-task', kind: 'analysis', status: 'captured', requestId: 'TEST-request', inputHash: 'TEST', sourceUrl: '', rawText: 'TEST 离线原捕获回复' }; p.jobs = [job];
    const collect = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ project: p, collect }); render(<PetStoryCurrentTasks project={p} />);
    const button = screen.getByRole('button', { name: '重新保存回复' }); expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button); await waitFor((): void => expect(collect).toHaveBeenCalledWith(job.id)); expect(p.jobs).toEqual([job]);
  });
  it('切镜引用冲突在修订用完后仍有就地整理入口，点击只收取原回复且不要求免费发送确认', async (): Promise<void> => {
    const root: PetStoryChatJob = { id: 'TEST-analysis', taskId: 'TEST-root-task', kind: 'analysis', status: 'invalid', requestId: 'TEST-root-request', inputHash: 'TEST', sourceUrl: '', error: 'TEST 原分析错误', rawText: 'TEST 原回复' };
    const repair: PetStoryChatJob = { ...root, id: 'TEST-repair', taskId: 'TEST-repair-task', kind: 'repair', parentJobId: root.id, error: 's2切镜不应绑定上一镜头', rawText: 'TEST 已保存分镜回复' };
    p.jobs = [root, repair];
    const task: Task = { id: repair.taskId, projectId: p.studioProjectId, assignedAccountId: p.accountId, mode: 'chat', status: 'done', prompt: 'TEST 原修订请求', result: null, outputs: [], createdAt: now, updatedAt: now,
      runtime: { runId: 'TEST-run', attempt: 1, stage: 'completed', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, input: { mode: 'chat', prompt: 'TEST 原修订请求', attachments: [] }, chatResponse: { text: repair.rawText!, capturedAt: now } } };
    const collect = vi.fn(async (): Promise<void> => updateProject((project): void => {
      const job = project.jobs.find((item): boolean => item.id === repair.id)!;
      job.status = 'applied'; job.error = undefined; job.resultStatus = 'candidate';
      job.formatCorrections = ['镜头 2：保留正常切镜，移除了多余的前镜头绑定。'];
    }));
    const correctOnce = vi.fn(async (): Promise<void> => undefined);
    const startBoundChat = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ project: p, collect, correctOnce, startBoundChat});
    useTaskStore.setState({ tasks: [task] });
    const { rerender } = render(<PetStoryCurrentTasks project={p} />);
    expect(screen.getByText('分镜结构待整理')).toBeDefined();
    expect(screen.queryByRole('button', { name: '按具体缺项修订一次' })).toBeNull();
    const button = screen.getByRole('button', { name: '读取原回复并整理分镜结构' });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(collect).not.toHaveBeenCalled(); fireEvent.click(button);
    await waitFor((): void => expect(collect).toHaveBeenCalledExactlyOnceWith(repair.id));
    rerender(<PetStoryCurrentTasks project={usePetStoryStore.getState().project!} />);
    expect(usePetStoryStore.getState().project?.jobs.at(-1)?.formatCorrections).toEqual(['镜头 2：保留正常切镜，移除了多余的前镜头绑定。']);
    expect(screen.queryByText('待处理事项')).toBeNull();
    expect(screen.queryByText('分镜结构待整理')).toBeNull();
    expect(correctOnce).not.toHaveBeenCalled(); expect(startBoundChat).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().analyze).not.toHaveBeenCalled();
    expect(useTaskStore.getState().tasks).toEqual([task]);
    expect(usePetStoryStore.getState().project?.jobs.at(-1)?.rawText).toBe(repair.rawText);
  });
  it.each(['analysis', 'assets', 'review'] as const)('全局%s的修订回复已保存后不再把原缺项列为当前阻断，失败原文保留在诊断', (kind): void => {
    const root: PetStoryChatJob = { id: 'TEST-invalid-parent', taskId: 'TEST-parent-task', kind, status: 'invalid', requestId: 'TEST-parent-request', inputHash: 'TEST', sourceUrl: '', error: 'TEST 原回复已由修订处理', rawText: 'TEST 已保存的原始失败回复' };
    const repair: PetStoryChatJob = { ...root, id: 'TEST-valid-repair', taskId: 'TEST-repair-task', kind: 'repair', parentJobId: root.id, status: 'applied', resultStatus: 'adopted', error: undefined, rawText: 'TEST 已保存的修订回复' };
    p.jobs = [root, repair]; const before = structuredClone(p); usePetStoryStore.setState({ project: p });
    render(<PetStoryCurrentTasks project={p} />);
    expect(screen.queryByText('待处理事项')).toBeNull(); expect(screen.queryByText('内容需要处理')).toBeNull();
    expect(screen.queryByRole('button', { name: '按具体缺项修订一次' })).toBeNull();
    expect(p.jobs[0].rawText).toBe('TEST 已保存的原始失败回复');
    expect(p.jobs[1].rawText).toBe('TEST 已保存的修订回复');
    expect(p).toEqual(before);
  });
  it.each(['done', 'submitted'] as const)('原媒体任务%s时直接沿原制作继续，不需要检查本会话入口', async (status): Promise<void> => {
    const task = pausedMediaTask(status); const resume = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ project: p, capability: null, resumeProduction: resume }); useTaskStore.setState({ tasks: [task] });
    render(<PetStoryCurrentTasks project={p} />);
    const button = screen.getByRole('button', { name: '继续原制作任务' }); expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('button', { name: '检查当前豆包入口' })).toBeNull();
    fireEvent.click(button); await waitFor((): void => expect(resume).toHaveBeenCalledOnce());
    expect(useTaskStore.getState().tasks).toEqual([task]);
  });
  it('原媒体任务尚未发送时可直接继续，执行器负责实际页面准备', (): void => {
    const task = pausedMediaTask('unsubmitted'); usePetStoryStore.setState({ project: p, capability: null}); useTaskStore.setState({ tasks: [task] });
    render(<PetStoryCurrentTasks project={p} />);
    expect(screen.getByRole('button', { name: '继续原制作任务' }).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('button', { name: '检查当前豆包入口' })).toBeNull();
    expect(screen.queryByRole('button', { name: '只读继续收取／下载原产物' })).toBeNull();
  });
  it('明确未发送的原任务无需免费勾选即可继续，仍使用同一个原任务', async (): Promise<void> => {
    p.mobileStory = { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now };
    const job: PetStoryChatJob = { id: 'TEST-job', taskId: 'TEST-task', kind: 'analysis', status: 'bound', inputHash: 'TEST', sourceUrl: '', sourceStoryId: p.mobileStory.id, requestId: 'TEST-request', requestText: 'TEST 离线原请求' }; p.jobs = [job];
    const task: Task = { id: job.taskId, projectId: p.studioProjectId, assignedAccountId: account.id, mode: 'chat', prompt: job.requestText!, status: 'queued', executionIntent: 'hold', outputs: [], result: null, createdAt: now, updatedAt: now };
    const start = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ project: p, startBoundChat: start }); useTaskStore.setState({ tasks: [task] });
    render(<PetStoryCurrentTasks project={p} />);
    const continueButton = screen.getByRole('button', { name: '继续原文字任务（尚未发送）' });
    expect(start).not.toHaveBeenCalled();
    expect(screen.queryByRole('checkbox', { name: /免费可用/ })).toBeNull();
    expect(continueButton.hasAttribute('disabled')).toBe(false);
    fireEvent.click(continueButton); await waitFor((): void => expect(start).toHaveBeenCalledWith(job.id));
    expect(useTaskStore.getState().tasks).toHaveLength(1); expect(useTaskStore.getState().tasks[0].id).toBe(task.id);
  });
  it('原请求不确定时无需展开诊断便可检查原回复和结束等待，点击只调用原任务恢复服务', async (): Promise<void> => {
    const job: PetStoryChatJob = { id: 'TEST-job', taskId: 'TEST-task', kind: 'analysis', status: 'bound', inputHash: 'TEST', sourceUrl: '', runId: 'TEST-run' };
    p.jobs = [job];
    const task: Task = { id: job.taskId, assignedAccountId: account.id, mode: 'chat', prompt: 'TEST 离线原请求', status: 'fail', outputs: [], result: null, createdAt: now, updatedAt: now, runtime: { runId: job.runId!, attempt: 1, stage: 'submitting', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, input: { mode: 'chat', prompt: 'TEST 离线原请求', attachments: [] } } };
    const recover = vi.fn(async (): Promise<void> => undefined); const end = vi.fn(async (): Promise<void> => updateProject((project): void => { project.jobs[0].endedWaitingAt = now; }));
    usePetStoryStore.setState({ project: p, recoverChat: recover, endChatWaiting: end }); useTaskStore.setState({ tasks: [task] });
    const { rerender } = render(<PetStoryCurrentTasks project={p} />);
    expect(document.querySelector('details')?.open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '检查原回复（不重复发送）' }));
    await waitFor((): void => expect(recover).toHaveBeenCalledWith(job.id));
    fireEvent.click(screen.getByRole('button', { name: '结束本次等待' }));
    await waitFor((): void => expect(end).toHaveBeenCalledWith(job.id));
    rerender(<PetStoryCurrentTasks project={usePetStoryStore.getState().project!} />);
    expect(screen.getByText(/平台任务未被取消/)).toBeDefined(); expect(screen.queryByRole('button', { name: '继续原文字任务（尚未发送）' })).toBeNull();
  });
  it('新建弹窗未选账号有直接添加入口，添加后可选择保存目录创建，不要求先去另一页', async (): Promise<void> => {
    usePetStoryStore.setState({ project: null }); useAccountStore.setState({ accounts: [], selectedAccountId: null });
    const added = { ...account, id: 'TEST-added-account', name: 'TEST 新账号' };
    const add = vi.fn(async (): Promise<boolean> => { useAccountStore.setState({ accounts: [added] }); return true; });
    const create = vi.fn(async (): Promise<void> => undefined);
    useAccountStore.setState({ addAccount: add }); usePetStoryStore.setState({ createProject: create });
    render(<PetStoryPanel />); fireEvent.click(screen.getByRole('button', { name: '新建短剧项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建短剧项目' });
    expect(within(dialog).getByText(/还没有选择可用的豆包执行账号/)).toBeDefined();
    expect(within(dialog).getByRole('button', { name: '选择保存目录并创建' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox', { name: '添加豆包账号名称' }), { target: { value: added.name } });
    fireEvent.click(within(dialog).getByRole('button', { name: '添加账号' }));
    await waitFor((): void => expect(within(dialog).getByRole('button', { name: '选择保存目录并创建' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(within(dialog).getByRole('button', { name: '选择保存目录并创建' }));
    await waitFor((): void => expect(create).toHaveBeenCalledWith({ accountId: added.id, studioProjectId: p.studioProjectId }));
    expect(add).toHaveBeenCalledWith(added.name, 'doubao');
  });
});

describe('媒体直接开始与真实制作条件', (): void => {
  it('镜头提示词草稿只锁本目标，其他镜头及素材可制作，切页返回仍保留原草稿', async (): Promise<void> => {
    readyMediaJourney(2, 1); const [first, second] = p.plan!.shots; const material = p.materials![0];
    const generateShot = vi.fn(async (): Promise<void> => undefined); const generateMaterials = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ generateShotMedia: generateShot, generateMaterialImage: generateMaterials }); render(<PetStoryPanel />);
    const navigation = screen.getByRole('navigation', { name: '短剧制作阶段' }); fireEvent.click(within(navigation).getByRole('button', { name: /制作关键帧/ }));
    const firstRow = document.querySelector(`[data-shot-id="${first.id}"]`); const secondRow = document.querySelector(`[data-shot-id="${second.id}"]`); if (!firstRow || !secondRow) throw new Error('实际镜头卡缺失');
    const firstNode = firstRow.querySelector<HTMLElement>('[data-media-kind=firstFrame]'); const secondNode = secondRow.querySelector<HTMLElement>('[data-media-kind=firstFrame]'); if (!firstNode || !secondNode) throw new Error('首帧节点缺失');
    const firstButton = within(firstNode).getByRole('button', { name: /生成图片$/ }); const secondButton = within(secondNode).getByRole('button', { name: /生成图片$/ });
    await waitFor((): void => expect(firstButton.hasAttribute('disabled')).toBe(false)); await waitFor((): void => expect(secondButton.hasAttribute('disabled')).toBe(false));
    const draft = `${first.prompts.firstFrame.final}\nTEST 未保存修改`;
    fireEvent.change(within(firstRow as HTMLElement).getByRole('textbox', { name: `镜头${first.order}首帧生图提示词最终正文` }), { target: { value: draft } });
    await waitFor((): void => expect(firstButton.hasAttribute('disabled')).toBe(true)); expect(secondButton.hasAttribute('disabled')).toBe(false);
    fireEvent.click(secondButton); await waitFor((): void => expect(generateShot).toHaveBeenCalledWith(second.id, 'firstFrame'));
    fireEvent.click(within(navigation).getByRole('button', { name: /准备基础素材/ }));
    const materialCard = document.getElementById(`material-${material.id}`); if (!materialCard) throw new Error('实际素材卡缺失');
    const materialButton = within(materialCard).getByRole('button', { name: /生成图片$/ }); expect(materialButton.hasAttribute('disabled')).toBe(false); fireEvent.click(materialButton);
    await waitFor((): void => expect(generateMaterials).toHaveBeenCalledWith(material.id));
    fireEvent.click(within(navigation).getByRole('button', { name: /制作关键帧/ }));
    expect((screen.getByRole('textbox', { name: `镜头${first.order}首帧生图提示词最终正文` }) as HTMLTextAreaElement).value).toBe(draft);
    expect(p.plan!.shots[0].prompts.firstFrame.final).toBe(first.prompts.firstFrame.final);
  });
  it('素材页移除文字编辑与批量按钮，所选图片操作不扩展至其他素材', async (): Promise<void> => {
    readyMediaJourney(1, 2); const [first, second] = p.materials!;
    const generate = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ generateMaterialImage: generate }); render(<PetStoryPanel />);
    const firstCard = document.getElementById(`material-${first.id}`); const secondCard = document.getElementById(`material-${second.id}`); if (!firstCard || !secondCard) throw new Error('实际素材卡缺失');
    expect(within(firstCard).queryByRole('textbox')).toBeNull(); expect(screen.queryByRole('button', { name: /生成缺失基础图/ })).toBeNull();
    const secondButton = within(secondCard).getByRole('button', { name: '生成图片' }); fireEvent.click(secondButton);
    await waitFor((): void => expect(generate).toHaveBeenCalledExactlyOnceWith(second.id));
    expect(p.materials![0].prompt.final).toBe(first.prompt.final);
  });
  it.each(['candidate', 'adopted'] as const)('首帧%s时保留查看或复核和图片选片权，没有入口检查区', async (state): Promise<void> => {
    p.plan = storedPlan(); p.storyApproval = { hash: 'TEST', at: now }; const shot = p.plan.shots[0];
    p.assets = [{ id: 'TEST-frame', kind: 'firstFrame', shotId: shot.id, relativePath: 'TEST-frame.png', needsReview: state === 'adopted', imageReview: { state, target: { shotId: shot.id, kind: 'firstFrame' }, basisHash: 'TEST', adoptedAt: state === 'adopted' ? now : undefined } }];
    if (state === 'adopted') p.adoptedImages = { [shot.id]: { firstFrameId: p.assets[0].id } };
    window.electronAPI.petstory.inspectGeneration = vi.fn(async (): Promise<PetStoryGenerationEligibilityResult> => ({ success: true, eligibility: { ready: true, blockers: [] } }));
    usePetStoryStore.setState({ project: p, capability: null });
    render(<CanvasMediaNode project={p} shot={shot} kind="firstFrame" disabled={false} />);
    expect(screen.getByRole('button', { name: state === 'candidate' ? '查看图片' : '查看并复核' })).toBeDefined();
    expect(screen.queryByText('生成设置／入口检查')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /免费|同意/ })).toBeNull();
  });
  it.each(['firstFrame', 'lastFrame', 'video'] as const)('%s没有能力检查记录也能生成；真实正文条件仍需满足', async (kind): Promise<void> => {
    p.plan = storedPlan(); p.storyApproval = { hash: 'TEST', at: now };
    const shot = p.plan.shots[0]; let backendReady = false;
    const inspectGeneration = vi.fn(async (): Promise<PetStoryGenerationEligibilityResult> => ({ success: true, eligibility: !backendReady ? { ready: false, blockers: [{ code: 'prompt', message: 'TEST 后台要求先核对当前正文' }] } : { ready: true, blockers: [] } }));
    window.electronAPI.petstory.inspectGeneration = inspectGeneration;
    const generate = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ project: p, capability: null, generateShotMedia: generate });
    const { rerender } = render(<CanvasMediaNode project={p} shot={shot} kind={kind} disabled={false} />);
    const button = screen.getByRole('button', { name: kind === 'video' ? /生成视频$/ : /生成图片$/ });
    await screen.findByText('TEST 后台要求先核对当前正文');
    expect(button.hasAttribute('disabled')).toBe(true); expect(generate).not.toHaveBeenCalled();
    expect(screen.queryByText('生成设置／入口检查')).toBeNull();
    backendReady = true;
    await act(async (): Promise<void> => {
      p = { ...p, revision: p.revision + 1 }; usePetStoryStore.setState({ project: p });
      rerender(<CanvasMediaNode project={p} shot={shot} kind={kind} disabled={false} />);
    });
    await waitFor((): void => expect(button.hasAttribute('disabled')).toBe(false));
    fireEvent.click(button); await waitFor((): void => expect(generate).toHaveBeenCalledWith(shot.id, kind));
    expect(p.assets).toEqual([]);
  });
});
