import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryChatJob, PetStoryPlan, PetStoryProject } from '@doubao-studio/contracts';
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
  it('修订成功只显示一个结果，失败父回复及来源都留在折叠诊断中', (): void => {
    const root = job('TEST-parent', { status: 'invalid', error: 'TEST父回复时长缺项', parsedResult: undefined });
    const repair = job('TEST-repair', { kind: 'repair', parentJobId: root.id });
    const p = project([root, repair]); usePetStoryStore.setState({ project: p }); useTaskStore.setState({ tasks: [] });
    render(<><PetStoryCurrentTasks project={p} hidePlanRequests /><PetStoryRuntime project={p} disabled={false} /></>);
    expect(screen.getAllByRole('article', { name: '方案审阅' })).toHaveLength(1);
    expect(screen.queryByText('待处理事项')).toBeNull();
    expect(screen.getAllByRole('button', { name: '确认并采用方案' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '在豆包中调整' })).toHaveLength(1);
    expect(screen.queryByText('剧本理解与动态分镜')).toBeNull();
    expect(screen.queryByText('具体缺项修订')).toBeNull();
    const card = screen.getByRole('article', { name: '方案审阅' });
    expect(card.querySelectorAll('.ant-btn-primary')).toHaveLength(1);
    expect(card.querySelector<HTMLDetailsElement>('.petstory-plan-full')?.open).toBe(false);
    expect(card.querySelector<HTMLDetailsElement>('.petstory-plan-diagnostics')?.open).toBe(false);
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
    expect(screen.getByText('有新候选')).toBeDefined(); expect(screen.getByText(/与当前方案不同/)).toBeDefined();
    fireEvent.click(screen.getByText('查看完整方案'));
    expect(within(document.querySelector('.petstory-plan-full')!).getByRole('heading', { name: '动态分镜 · 5 个镜头' })).toBeDefined();
    expect(p).toEqual(before); expect(adopt).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认并采用方案' }));
    await waitFor((): void => expect(screen.getByText('方案已采用')).toBeDefined());
    expect(adopt).toHaveBeenCalledExactlyOnceWith('TEST-new'); expect(confirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: '确认并采用方案' })).toBeNull();
    expect(usePetStoryStore.getState().project?.assets).toEqual(before.assets);
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
    expect(primary?.textContent).toBe('按具体缺项修订一次');
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
});
