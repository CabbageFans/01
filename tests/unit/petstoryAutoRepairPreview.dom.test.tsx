/** 原故事五镜头的离线 DOM 回归；服务为明确替身，不作为真实 Chat 或图片验收证据。 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryAdjustmentPreview, PetStoryChatJob, PetStoryPlan, PetStoryProject, Task } from '@doubao-studio/contracts';
import PetStoryChatAdjustmentPanel from '../../src/components/PetStoryChatAdjustmentPanel';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = { studio: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-10-30T01:00:00.000Z';
let project: PetStoryProject;
const applyReply = vi.fn<(replyKey: string) => Promise<PetStoryAdjustmentPreview | null>>();
const adoptReply = vi.fn<(replyKey: string) => Promise<void>>();
const adoptPlan = vi.fn<(jobId: string) => Promise<void>>();
const adoptPrompt = vi.fn<(jobId: string) => Promise<void>>();
const endAdjustment = vi.fn<() => Promise<void>>();

function setProject(value: PetStoryProject): void { project = value; usePetStoryStore.setState({ project }); }
function repairJob(status: PetStoryChatJob['status'], candidate = false): PetStoryChatJob {
  return { id: 'TEST-preview-repair', taskId: 'TEST-preview-repair-task', kind: 'repair', originKind: 'analysis', repairMode: 'automatic', status,
    parentJobId: 'TEST-preview-source', inputHash: 'TEST', sourceUrl: '', sourceStoryId: 'TEST-preview-story', requestId: 'TEST-preview-request',
    repairReplySource: { adjustmentId: 'TEST-preview-adjustment', replyKey: 'TEST-chosen' },
    ...(candidate ? { resultStatus: 'candidate', parsedResult: { plan: structuredClone(snapshot.plan) as PetStoryPlan } } : {}),
    ...(status === 'invalid' ? { error: 'TEST 内部字段的旧时长错误', rawText: JSON.stringify(snapshot.plan) } : {}) };
}
function installRepair(status: PetStoryChatJob['status'], candidate = false): PetStoryChatJob {
  const job = repairJob(status, candidate);
  setProject({ ...project, jobs: [...project.jobs.filter((item): boolean => item.kind !== 'repair'), job], chatAdjustment: { ...project.chatAdjustment!, repairJobId: job.id, selectedReplyKey: 'TEST-chosen' } });
  const task: Task = { id: job.taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: status === 'bound' ? 'generating' : 'done',
    prompt: 'TEST 原正式请求替身', result: null, outputs: [], createdAt: now, updatedAt: now,
    runtime: { runId: 'TEST-preview-run', attempt: 1, stage: 'generating', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
      input: { mode: 'chat', prompt: 'TEST 原正式请求替身', attachments: [] } } };
  useTaskStore.setState({ tasks: [task] }); return job;
}
async function previewDialog(): Promise<HTMLElement> {
  return waitFor((): HTMLElement => {
    const dialog = screen.getAllByRole('dialog').find((item): boolean => within(item).queryByText('确认应用这条回复') !== null);
    expect(dialog).toBeDefined(); return dialog!;
  });
}
function chooseReply(index: number): void {
  fireEvent.click(screen.getByRole('button', { name: /选择回复/ }));
  fireEvent.click(screen.getByRole('radio', { name: `豆包回复 ${index}` }));
}

beforeEach((): void => {
  vi.resetAllMocks();
  project = { id: 'TEST-preview-project', schemaVersion: 1, studioProjectId: 'TEST-preview-studio', accountId: 'TEST-preview-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-preview-story', text: snapshot.mobileStory, importedAt: now },
    plan: structuredClone(snapshot.plan) as PetStoryPlan,
    assets: [{ id: 'TEST-preserved-image', kind: 'character', characterId: 'lulu', relativePath: 'TEST/original.png' }],
    jobs: [{ id: 'TEST-preview-source', taskId: 'TEST-preview-source-task', kind: 'analysis', status: 'invalid', inputHash: 'TEST', sourceUrl: '', sourceStoryId: 'TEST-preview-story', error: 'TEST 原始错误不能在修订中宣布最终失败' }], updatedAt: now,
    chatAdjustment: { id: 'TEST-preview-adjustment', target: {}, sourceJobId: 'TEST-preview-source', conversationUrl: 'https://www.doubao.com/chat/TEST-preview-original', basisHash: 'TEST', startedAt: now, status: 'active', replies: [
      { key: 'TEST-chosen', text: JSON.stringify(snapshot.plan), precedingUserText: 'TEST 原故事本轮创作', capturedAt: now },
      { key: 'TEST-other', text: JSON.stringify(snapshot.plan), precedingUserText: 'TEST 原故事新一条回复', capturedAt: now },
    ] } };
  applyReply.mockResolvedValue({ target: {}, previousPlan: structuredClone(project.plan), plan: structuredClone(snapshot.plan) as PetStoryPlan });
  adoptReply.mockImplementation(async (replyKey: string): Promise<void> => {
    setProject({ ...project, chatAdjustment: { ...project.chatAdjustment!, status: 'adopted', adoptedReplyKey: replyKey } });
  });
  adoptPlan.mockImplementation(async (jobId: string): Promise<void> => {
    const next = structuredClone(project); const job = next.jobs.find((item): boolean => item.id === jobId)!;
    next.plan = structuredClone(job.parsedResult!.plan); job.resultStatus = 'adopted'; setProject(next);
  });
  adoptPrompt.mockImplementation(async (jobId: string): Promise<void> => {
    const next = structuredClone(project); next.jobs.find((item): boolean => item.id === jobId)!.resultStatus = 'adopted'; setProject(next);
  });
  endAdjustment.mockImplementation(async (): Promise<void> => { setProject({ ...project, chatAdjustment: { ...project.chatAdjustment!, status: 'ended' } }); });
  useTaskStore.setState({ ...initial.tasks, tasks: [] });
  usePetStoryStore.setState({ ...initial.studio, project, busy: false, error: '', chatReadbackError: '', applyChatReply: applyReply, adoptChatReply: adoptReply,
    adoptPlanCandidate: adoptPlan, adoptPromptCandidate: adoptPrompt, endChatAdjustment: endAdjustment });
});
afterEach((): void => { cleanup(); usePetStoryStore.setState(initial.studio); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });

describe('自动修订的原页面状态与具体来源', (): void => {
  it('修订前选中具体回复才应用；修订运行中不把父任务旧错误作为最终失败', async (): Promise<void> => {
    applyReply.mockImplementationOnce(async (): Promise<null> => { installRepair('bound'); return null; });
    const before = structuredClone(project); render(<PetStoryChatAdjustmentPanel />);
    fireEvent.click(screen.getByRole('button', { name: /选择回复/ }));
    expect(applyReply).not.toHaveBeenCalled(); expect(screen.getAllByRole('radio').every((radio): boolean => !(radio as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: '豆包回复 1' })); fireEvent.click(screen.getByRole('button', { name: '应用到当前创作' }));
    await waitFor((): void => expect(applyReply).toHaveBeenCalledExactlyOnceWith('TEST-chosen'));
    expect(screen.getAllByRole('status').some((status): boolean => status.textContent?.includes('正在请豆包修正内容') === true)).toBe(true);
    expect(screen.queryByText(before.jobs[0].error!)).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
    expect(adoptPlan).not.toHaveBeenCalled(); expect(adoptReply).not.toHaveBeenCalled(); expect(project.plan).toEqual(before.plan); expect(project.assets).toEqual(before.assets);
  });

  it('修订仍失败清楚提示继续调整，可回原会话并选新回复，保留采用方案与图片', async (): Promise<void> => {
    installRepair('invalid'); const before = structuredClone(project); const dispatched = vi.spyOn(window, 'dispatchEvent'); render(<PetStoryChatAdjustmentPanel />);
    expect(screen.getByRole('status').textContent).toContain('豆包还未修好，你可以继续调整');
    fireEvent.click(screen.getByRole('button', { name: '打开关联会话' }));
    expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({ type: 'petstory-open-adjustment' }));
    chooseReply(2); fireEvent.click(screen.getByRole('button', { name: '应用到当前创作' }));
    await previewDialog(); expect(applyReply).toHaveBeenCalledExactlyOnceWith('TEST-other');
    expect(adoptPlan).not.toHaveBeenCalled(); expect(adoptReply).not.toHaveBeenCalled(); expect(project.plan).toEqual(before.plan); expect(project.assets).toEqual(before.assets);
  });

  it('合格修订自动回完整五镜头预览，确认前不改变原方案、手改正文或已有图片', async (): Promise<void> => {
    installRepair('applied', true); const before = structuredClone(project); render(<PetStoryChatAdjustmentPanel />);
    const dialog = await previewDialog();
    for (const shot of snapshot.plan.shots) expect(within(dialog).getAllByRole('article', { name: `镜头 ${shot.order} 完整方案` })).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toContain('已修正，请确认完整内容');
    expect(within(dialog).getByRole('button', { name: '确认采用此回复' }).hasAttribute('disabled')).toBe(false);
    expect(adoptPlan).not.toHaveBeenCalled(); expect(adoptPrompt).not.toHaveBeenCalled(); expect(adoptReply).not.toHaveBeenCalled();
    expect(project.plan).toEqual(before.plan); expect(project.plan!.shots[0].prompts.firstFrame.edited).toBe(true); expect(project.assets).toEqual(before.assets);
  });

  it('用户确认修订方案时采用关联修订，并结束同次调整；已有图片不被自动替换', async (): Promise<void> => {
    const repair = installRepair('applied', true); const images = structuredClone(project.assets); render(<PetStoryChatAdjustmentPanel />);
    const dialog = await previewDialog(); fireEvent.click(within(dialog).getByRole('button', { name: '确认采用此回复' }));
    await waitFor((): void => expect(adoptPlan).toHaveBeenCalledExactlyOnceWith(repair.id));
    await waitFor((): void => expect(endAdjustment).toHaveBeenCalledTimes(1));
    expect(adoptReply).not.toHaveBeenCalled(); expect(adoptPrompt).not.toHaveBeenCalled(); expect(project.assets).toEqual(images);
  });

  it('取消修订预览后重新选择另一条有效回复，只采用新选定key，不能采用旧修订', async (): Promise<void> => {
    installRepair('applied', true); const images = structuredClone(project.assets); render(<PetStoryChatAdjustmentPanel />);
    const previous = await previewDialog(); fireEvent.click(within(previous).getByRole('button', { name: '重新选择' }));
    chooseReply(2); fireEvent.click(screen.getByRole('button', { name: '应用到当前创作' }));
    const current = await previewDialog(); expect(applyReply).toHaveBeenCalledExactlyOnceWith('TEST-other');
    fireEvent.click(within(current).getByRole('button', { name: '确认采用此回复' }));
    await waitFor((): void => expect(adoptReply).toHaveBeenCalledExactlyOnceWith('TEST-other'));
    expect(adoptPlan).not.toHaveBeenCalled(); expect(adoptPrompt).not.toHaveBeenCalled(); expect(endAdjustment).not.toHaveBeenCalled(); expect(project.assets).toEqual(images);
  });

  it('关闭合格修订预览后重新选原回复，可再次查看同一候选且不重发整理', async (): Promise<void> => {
    installRepair('applied', true); applyReply.mockResolvedValue(null); render(<PetStoryChatAdjustmentPanel />);
    const first = await previewDialog(); fireEvent.click(within(first).getByRole('button', { name: '重新选择' }));
    chooseReply(1); fireEvent.click(screen.getByRole('button', { name: '应用到当前创作' }));
    const reopened = await previewDialog(); expect(within(reopened).getAllByRole('article', { name: '镜头 5 完整方案' })).toHaveLength(2);
    expect(applyReply).not.toHaveBeenCalled(); expect(adoptPlan).not.toHaveBeenCalled(); expect(adoptReply).not.toHaveBeenCalled();
  });

  it('单项首帧修订返回对应完整正文预览，确认前保留手改final和图片', async (): Promise<void> => {
    const repair = installRepair('applied', true); const next = structuredClone(project); const current = snapshot.plan.shots[0].prompts.firstFrame;
    const job = next.jobs.find((item): boolean => item.id === repair.id)!; job.originKind = 'optimize'; job.shotId = 'shot_1'; job.promptKind = 'firstFrame'; job.parsedResult = { optimized: current.optimized };
    next.chatAdjustment!.target = { shotId: 'shot_1', promptKind: 'firstFrame' }; next.chatAdjustment!.previousText = current.final; setProject(next);
    const before = structuredClone(project); render(<PetStoryChatAdjustmentPanel />); const dialog = await previewDialog();
    expect(within(dialog).getByText('镜头 1 · 首帧提示词')).toBeDefined();
    expect(Array.from(dialog.querySelectorAll('pre'), (body): string | null => body.textContent)).toEqual([current.final, current.optimized]);
    expect(project.plan).toEqual(before.plan); expect(project.assets).toEqual(before.assets); expect(adoptPrompt).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认采用此回复' })); await waitFor((): void => expect(adoptPrompt).toHaveBeenCalledExactlyOnceWith(repair.id));
    expect(adoptPlan).not.toHaveBeenCalled(); expect(adoptReply).not.toHaveBeenCalled();
  });
});
