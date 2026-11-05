import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryChatJob, PetStoryPlan, PetStoryProject, Task } from '@doubao-studio/contracts';
import { PetStoryPlanReview } from '../../src/components/PetStoryPlanReview';
import { PetStoryRuntime } from '../../src/components/PetStoryRuntime';
import { PetStoryCurrentTasks } from '../../src/components/PetStoryTaskRecovery';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { planDisplayText, selectPlanReview } from '../../src/utils/petstoryPlanReview';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = usePetStoryStore.getState(); const initialTasks = useTaskStore.getState();
function job(id: string, fields: Partial<PetStoryChatJob> = {}): PetStoryChatJob {
  return { id, taskId: `${id}-task`, kind: 'analysis', status: 'applied', resultStatus: 'candidate', requestId: `${id}-request`, inputHash: 'TEST', sourceUrl: '', sourceStoryId: 'TEST-story', parsedResult: { plan: structuredClone(snapshot.plan) as PetStoryPlan }, ...fields };
}
function project(jobs: PetStoryChatJob[]): PetStoryProject {
  return { schemaVersion: 1, id: 'TEST-project', revision: 1, studioProjectId: 'TEST-studio', accountId: 'TEST-account', source: { kind: 'script', url: '', status: 'pending' }, mobileStory: { id: 'TEST-story', text: 'TEST已保存原故事', importedAt: '2026-10-29T00:00:00Z' }, jobs, assets: [], updatedAt: '2026-10-29T00:00:00Z' };
}
afterEach((): void => { cleanup(); usePetStoryStore.setState(initial); useTaskStore.setState(initialTasks); });

describe('同轮方案审阅与明确采用', (): void => {
  it('摘要中的已知内部标识显示对象名称，原方案与正文保持不变', (): void => {
    const value = structuredClone(snapshot.plan) as PetStoryPlan;
    const before = structuredClone(value); const character = value.characters[0]; const shot = value.shots[0];
    expect(planDisplayText(value, `${character.id}（主角）→ ${shot.id}`)).toBe(`${character.name}（主角）→ 镜头 ${shot.order}`);
    expect(value).toEqual(before);
  });
  it('修订成功只显示一个结果，不展示诊断入口且保留失败父回复', (): void => {
    const root = job('TEST-parent', { status: 'invalid', error: 'TEST父回复时长缺项', parsedResult: undefined });
    const repair = job('TEST-repair', { kind: 'repair', parentJobId: root.id });
    const p = project([root, repair]); usePetStoryStore.setState({ project: p }); useTaskStore.setState({ tasks: [] });
    render(<><PetStoryCurrentTasks project={p} hidePlanRequests /><PetStoryRuntime project={p} disabled={false} /></>);
    expect(screen.getAllByRole('article', { name: '方案审阅' })).toHaveLength(1);
    expect(screen.queryByText('待处理事项')).toBeNull();
    expect(screen.getAllByRole('button', { name: '确认并采用方案' })).toHaveLength(1);
    expect(screen.getByText('查看待采用方案')).toBeDefined();
    expect(screen.getAllByRole('button', { name: '在豆包中调整' })).toHaveLength(1);
    expect(screen.queryByText('剧本理解与动态分镜')).toBeNull();
    expect(screen.queryByText('具体缺项修订')).toBeNull();
    const card = screen.getByRole('article', { name: '方案审阅' });
    expect(card.querySelectorAll('.ant-btn-primary')).toHaveLength(1);
    expect(card.querySelector<HTMLDetailsElement>('.petstory-plan-full')?.open).toBe(false);
    expect(card.querySelector('.petstory-plan-diagnostics')).toBeNull();
    expect(screen.queryByText('生成记录／诊断详情')).toBeNull();
    expect(screen.queryByText('更多操作')).toBeNull();
    expect(selectPlanReview(p).job?.id).toBe(repair.id);
    expect(p.jobs[0].error).toBe('TEST父回复时长缺项');
  });
  it('采用前保留旧方案与成果，确认一次后成为已采用且不再显示采用按钮', async (): Promise<void> => {
    const p = project([job('TEST-new')]); p.plan = structuredClone(snapshot.plan) as PetStoryPlan;
    p.plan.understanding = 'TEST当前采用方案的理解'; p.storyApproval = { hash: 'TEST', at: p.updatedAt };
    p.assets = [{ id: 'TEST-existing', kind: 'video', shotId: p.plan.shots[0].id, relativePath: 'TEST-existing.mp4' }];
    const before = structuredClone(p);
    const adopt = vi.fn(async (id: string): Promise<void> => {
      const next = structuredClone(usePetStoryStore.getState().project!); const selected = next.jobs.find((entry): boolean => entry.id === id)!;
      next.plan = structuredClone(selected.parsedResult!.plan!); selected.resultStatus = 'adopted'; next.storyApproval = undefined;
      usePetStoryStore.setState({ project: next });
    });
    const confirm = vi.fn(async (): Promise<void> => { const next = structuredClone(usePetStoryStore.getState().project!); next.storyApproval = { hash: 'TEST-confirmed', at: next.updatedAt }; usePetStoryStore.setState({ project: next }); });
    usePetStoryStore.setState({ project: p, adoptPlanCandidate: adopt, confirmStory: confirm });
    const View: React.FC = (): React.ReactElement => { const current = usePetStoryStore((state) => state.project)!; return <PetStoryPlanReview project={current} disabled={false} />; };
    render(<View />);
    expect(screen.getByText('有新候选')).toBeDefined(); expect(screen.getByText(/修改后的方案尚未采用/)).toBeDefined();
    expect(screen.getByText('查看正在使用的方案')).toBeDefined();
    fireEvent.click(screen.getByText('查看修改后的方案（待采用）'));
    expect(within(document.querySelector('.petstory-plan-full')!).getByRole('heading', { name: '动态分镜 · 5 个镜头' })).toBeDefined();
    expect(p).toEqual(before); expect(adopt).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '采用修改后的方案' }));
    await waitFor((): void => expect(screen.getByText('方案已采用')).toBeDefined());
    expect(adopt).toHaveBeenCalledExactlyOnceWith('TEST-new'); expect(confirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '采用修改后的方案' })).toBeNull();
    expect(screen.queryByText('查看修改后的方案（待采用）')).toBeNull();
    expect(screen.getByText('查看正在使用的方案')).toBeDefined();
    expect(usePetStoryStore.getState().project?.assets).toEqual(before.assets);
  });
  it.each([
    '这个账号还有未完成或待核对的任务，请先处理原任务再自由调整',
    '这项内容还没有可定位的豆包会话，请先检查原会话，再打开调整',
  ])('历史错误不阻止未采用候选直接填写反馈：%s', async (error: string): Promise<void> => {
    const p = project([job('TEST-adjustment')]);
    const open = vi.fn(async (): Promise<void> => undefined);
    const revise = vi.fn(async (): Promise<string | undefined> => undefined);
    const adopt = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ project: p, error, busy: false, openChatAdjustment: open, revisePlan: revise, adoptPlanCandidate: adopt });
    render(<PetStoryPlanReview project={p} disabled={false} />);
    const card = screen.getByRole('article', { name: '方案审阅' });
    fireEvent.click(within(card).getByRole('button', { name: '在豆包中调整' }));
    const dialog = await screen.findByRole('dialog', { name: '调整方案' });
    expect(within(dialog).getByRole('textbox', { name: '方案修改要求' })).toBeDefined();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(dialog.textContent).not.toContain('请先采用');
    expect(open).not.toHaveBeenCalled(); expect(revise).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().project?.plan).toBeUndefined();
  });
  it('打开反馈弹窗不发送或占用任务，也不自动采用方案', async (): Promise<void> => {
    const p = project([job('TEST-opening')]);
    const open = vi.fn(async (): Promise<void> => undefined); const revise = vi.fn(async (): Promise<string | undefined> => undefined);
    const adopt = vi.fn(async (): Promise<void> => undefined); const confirm = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ project: p, error: '', busy: false, openChatAdjustment: open, revisePlan: revise, adoptPlanCandidate: adopt, confirmStory: confirm });
    useTaskStore.setState({ tasks: [], activeTaskId: null });
    render(<PetStoryPlanReview project={p} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: '在豆包中调整' }));
    const dialog = await screen.findByRole('dialog', { name: '调整方案' });
    expect(within(dialog).getByRole('button', { name: '开始调整' }).hasAttribute('disabled')).toBe(true);
    expect(usePetStoryStore.getState().busy).toBe(false); expect(useTaskStore.getState().tasks).toEqual([]);
    expect(open).not.toHaveBeenCalled(); expect(revise).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });
  it('新请求正在处理时不允许采用旧候选，过期故事回复只保留历史', async (): Promise<void> => {
    const old = job('TEST-old'); const next = job('TEST-pending', { status: 'bound', parsedResult: undefined });
    const p = project([old, next]); usePetStoryStore.setState({ project: p }); useTaskStore.setState({ tasks: [{ id: next.taskId, projectId: p.studioProjectId, assignedAccountId: p.accountId, mode: 'chat', status: 'generating', prompt: 'TEST-request', result: null, outputs: [], createdAt: p.updatedAt, updatedAt: p.updatedAt }] });
    render(<PetStoryPlanReview project={p} disabled={false} />);
    expect(screen.getByText('正在生成')).toBeDefined(); expect(screen.queryByRole('button', { name: '确认并采用方案' })).toBeNull();
    await act(async (): Promise<void> => undefined);
    const changedStory = { ...p, mobileStory: { ...p.mobileStory!, id: 'TEST-changed-story' } };
    expect(selectPlanReview(changedStory).job).toBeUndefined(); expect(selectPlanReview(changedStory).history).toHaveLength(2);
  });
  it('归属未核对的回复只显示异常和处理入口，不生成平行候选任务', (): void => {
    const p = project([job('TEST-invalid', { status: 'invalid', error: 'TEST镜头时长不符合要求' })]);
    usePetStoryStore.setState({ project: p }); useTaskStore.setState({ tasks: [] });
    render(<PetStoryPlanReview project={p} disabled={false} />);
    expect(screen.getByText('需要复核')).toBeDefined(); expect(within(screen.getByRole('status')).getByText('TEST镜头时长不符合要求')).toBeDefined();
    expect(screen.queryByRole('button', { name: '确认并采用方案' })).toBeNull();
    const primary = screen.getByRole('article', { name: '方案审阅' }).querySelector('.petstory-plan-attention > button.ant-btn-primary');
    expect(primary?.textContent).toBe('继续处理具体缺项');
  });
  it.each(['captured', 'bound'] as const)('重开%s回复没有丢失收取入口，旧式任务也可从审阅卡恢复', async (status): Promise<void> => {
    const p = project([job('TEST-recover', { requestId: undefined, status, parsedResult: undefined })]);
    const collect = vi.fn(async (): Promise<void> => undefined); const loadTasks = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ project: p, collect }); useTaskStore.setState({ tasks: [], loadTasks });
    render(<PetStoryPlanReview project={p} disabled={false} />);
    expect(screen.getByText(status === 'captured' ? '回复尚未核对' : '任务记录待载入')).toBeDefined();
    const primary = screen.getByRole('article', { name: '方案审阅' }).querySelector<HTMLButtonElement>('.petstory-plan-attention > button.ant-btn-primary');
    if (!primary) throw new Error('缺少回复恢复主操作');
    fireEvent.click(primary);
    await waitFor((): void => { if (status === 'captured') expect(collect).toHaveBeenCalledExactlyOnceWith('TEST-recover'); else expect(loadTasks).toHaveBeenCalledOnce(); });
    expect(screen.queryByRole('button', { name: '确认并采用方案' })).toBeNull();
  });

  it('方案修订已停下时显示真实缺项和明确继续入口，不冒充后台仍在处理', async (): Promise<void> => {
    const root = job('TEST-feedback-root', { status: 'invalid', planFeedback: { text: 'TEST 修改意见', requestId: 'TEST-feedback-request' } });
    const repair = job('TEST-feedback-repair', { kind: 'repair', parentJobId: root.id, status: 'invalid', parsedResult: undefined,
      planFeedback: root.planFeedback, rawText: 'TEST 已保存回复', error: 'TEST 第二镜动作安排超出时长',
      validationDetails: [{ code: 'duration', path: '$.plan.shots[1]', actualType: 'object', expected: 'TEST 动作时长匹配', repairable: true, message: 'TEST 第二镜动作安排超出时长' }] });
    const p = project([root, repair]); const correct = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ project: p, busy: false, error: '', promptRepairJobIds: [], correctOnce: correct });
    useTaskStore.setState({ tasks: [], activeTaskId: null, accountBusy: {} });
    render(<PetStoryPlanReview project={p} disabled={false} />);
    expect(screen.getByText(repair.error!)).toBeDefined();
    expect(screen.queryByText('工具正在后台检查并整理结果，完成后会显示完整的新方案。')).toBeNull();
    const primary = screen.getByRole('article', { name: '方案审阅' }).querySelector<HTMLButtonElement>('.petstory-plan-attention > button.ant-btn-primary');
    expect(primary?.textContent).toBe('继续修正方案'); fireEvent.click(primary!);
    await waitFor((): void => expect(correct).toHaveBeenCalledExactlyOnceWith(repair.id));
  });

  it('未发送的方案修订排队后保留继续原任务入口，不被后台标签永久隐藏', async (): Promise<void> => {
    const root = job('TEST-queued-root', { status: 'invalid', planFeedback: { text: 'TEST 修改意见', requestId: 'TEST-queued-request' } });
    const repair = job('TEST-queued-repair', { kind: 'repair', parentJobId: root.id, status: 'bound', parsedResult: undefined, planFeedback: root.planFeedback });
    const p = project([root, repair]); const start = vi.fn(async (): Promise<void> => undefined);
    const task: Task = { id: repair.taskId, projectId: p.studioProjectId, assignedAccountId: p.accountId, mode: 'chat', status: 'queued',
      prompt: 'TEST 未发送的修订', result: null, outputs: [], createdAt: p.updatedAt, updatedAt: p.updatedAt };
    usePetStoryStore.setState({ project: p, busy: false, error: '', promptRepairJobIds: [], startBoundChat: start });
    useTaskStore.setState({ tasks: [task], activeTaskId: null, accountBusy: {} });
    render(<PetStoryPlanReview project={p} disabled={false} />);
    const primary = screen.getByRole('article', { name: '方案审阅' }).querySelector<HTMLButtonElement>('.petstory-plan-attention > button.ant-btn-primary');
    expect(primary?.textContent).toBe('继续原文字任务（尚未发送）'); fireEvent.click(primary!);
    await waitFor((): void => expect(start).toHaveBeenCalledExactlyOnceWith(repair.id));
  });
});
