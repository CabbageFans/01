/** 手动提示词正常控件回归；保存服务为明确替身，不计真实豆包生成验收。 */
import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { PetStoryPlan, PetStoryProject, PetStoryPromptKind } from '@doubao-studio/contracts';
import { CanvasPromptEditor } from '../../src/components/PetStoryCanvasPrompt';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { pendingPetStoryDrafts } from '../../src/utils/petstoryDraftPresence';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
let project: PetStoryProject;
const dirtyChanged = (): void => undefined;
const Harness: React.FC<{ kind?: PetStoryPromptKind }> = ({ kind = 'firstFrame' }): React.ReactElement | null => {
  const current = usePetStoryStore((state) => state.project);
  const [dirty, setDirty] = useState(false);
  const changed = React.useCallback((_key: string, next: boolean): void => setDirty(next), []);
  if (!current) return null;
  return <CanvasPromptEditor project={current} shot={current.plan!.shots[0]} kind={kind} disabled={false} generationBlocked={dirty} dirtyChanged={changed} />;
};
beforeEach((): void => {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  plan.shots = plan.shots.slice(0, 1);
  const prompt = { original: 'TEST 原文', optimized: 'TEST 历史优化', final: 'TEST 当前使用全文', edited: false, rulesVersion: 'TEST' };
  plan.shots[0].prompts = { firstFrame: { ...prompt }, lastFrame: { ...prompt }, video: { ...prompt } };
  project = { schemaVersion: 1, id: 'TEST-manual', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, updatedAt: '2026-10-31T00:00:00.000Z', source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [], plan };
  usePetStoryStore.setState({ ...initial.pet, project, busy: false, error: '' });
  useTaskStore.setState({ ...initial.tasks, tasks: [] });
});
afterEach((): void => { usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });

function openEditor(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: '手动修改' }));
  return screen.getByRole('dialog');
}
function mockSuccessfulSave(): MockInstance<ReturnType<typeof usePetStoryStore.getState>['saveShotPrompt']> {
  return vi.spyOn(usePetStoryStore.getState(), 'saveShotPrompt').mockImplementation(async (shotId: string, kind: PetStoryPromptKind, final: string): Promise<void> => {
    const saved = structuredClone(usePetStoryStore.getState().project!);
    saved.plan!.shots.find((shot): boolean => shot.id === shotId)!.prompts[kind]!.final = final;
    saved.plan!.shots[0].prompts[kind]!.edited = true;
    saved.plan!.shots[0].prompts[kind]!.candidateJobId = undefined;
    usePetStoryStore.setState({ project: saved, error: '' });
  });
}

describe('画布手动修改提示词', (): void => {
  it.each(['firstFrame', 'lastFrame', 'video'] as const)('%s点击确定才保存完整手改正文，不触发生成或自然语言修订', async (kind: PetStoryPromptKind): Promise<void> => {
    const save = mockSuccessfulSave();
    const revise = vi.fn(); const generate = vi.fn();
    usePetStoryStore.setState({ revisePrompt: revise, generateShotMedia: generate });
    render(<Harness kind={kind} />);
    const dialog = openEditor();
    const text = '  TEST 用户手改，保留普通数字 9:16 与第2张参考\n第二段完整内容。\n';
    fireEvent.change(within(dialog).getByRole('textbox', { name: '提示词正文' }), { target: { value: text } });
    expect(save).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().project!.plan!.shots[0].prompts[kind]!.final).toBe('TEST 当前使用全文');
    expect(pendingPetStoryDrafts(project.id)).toHaveLength(1);
    const confirm = within(dialog).getByRole('button', { name: /确\s*定/ }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
    expect(save).toHaveBeenCalledExactlyOnceWith(project.plan!.shots[0].id, kind, text, { expectedFinal: 'TEST 当前使用全文' });
    expect(screen.getByText('当前使用 · 手改正文')).toBeDefined();
    expect(screen.getByLabelText(/当前正文/).textContent).toBe(text);
    expect(pendingPetStoryDrafts(project.id)).toEqual([]);
    expect(revise).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });

  it('取消放弃草稿，空白正文不能确认', async (): Promise<void> => {
    const save = mockSuccessfulSave(); render(<Harness />);
    const dialog = openEditor();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '提示词正文' }), { target: { value: ' \n ' } });
    expect((within(dialog).getByRole('button', { name: /确\s*定/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: /取\s*消/ }));
    await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
    expect(save).not.toHaveBeenCalled(); expect(project.plan!.shots[0].prompts.firstFrame.final).toBe('TEST 当前使用全文');
    expect(pendingPetStoryDrafts(project.id)).toEqual([]);
  });

  it('直接编辑可用候选时快照其全文和job，新的后台回填不覆盖草稿', async (): Promise<void> => {
    const prompt = project.plan!.shots[0].prompts.firstFrame;
    prompt.optimized = 'TEST 本次待确认候选'; prompt.candidateJobId = 'TEST-selected';
    project.jobs = [{ id: 'TEST-selected', kind: 'optimize', taskId: 'TEST-chat', shotId: project.plan!.shots[0].id, promptKind: 'firstFrame', status: 'applied', resultStatus: 'candidate', inputHash: 'TEST', sourceUrl: '', parsedResult: { optimized: prompt.optimized } }];
    const save = mockSuccessfulSave(); render(<Harness />);
    const dialog = openEditor(); const input = within(dialog).getByRole('textbox', { name: '提示词正文' }) as HTMLTextAreaElement;
    expect(input.value).toBe(prompt.optimized);
    fireEvent.change(input, { target: { value: 'TEST 以选定候选为基准的手改' } });
    act((): void => {
      const next = structuredClone(project); next.revision++;
      next.plan!.shots[0].prompts.firstFrame.optimized = 'TEST 后台另一新候选';
      usePetStoryStore.setState({ project: next });
    });
    expect(input.value).toBe('TEST 以选定候选为基准的手改');
    fireEvent.click(within(dialog).getByRole('button', { name: /确\s*定/ }));
    await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
    expect(save).toHaveBeenCalledExactlyOnceWith(project.plan!.shots[0].id, 'firstFrame', input.value, { expectedFinal: prompt.final, baseJobId: 'TEST-selected' });
    expect(screen.getByLabelText(/当前正文/).textContent).toBe('TEST 以选定候选为基准的手改');
    expect(screen.queryByRole('button', { name: '确认使用' })).toBeNull();
  });

  it('保存失败保留草稿并显示原因，重试成功才关闭', async (): Promise<void> => {
    const save = vi.fn(async (): Promise<void> => { usePetStoryStore.setState({ error: 'TEST 磁盘写入失败' }); });
    usePetStoryStore.setState({ saveShotPrompt: save }); render(<Harness />);
    const dialog = openEditor(); const input = within(dialog).getByRole('textbox', { name: '提示词正文' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'TEST 保留的手改草稿' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /确\s*定/ }));
    await waitFor((): void => expect(within(dialog).getByRole('alert').textContent).toBe('TEST 磁盘写入失败'));
    expect(input.value).toBe('TEST 保留的手改草稿');
    expect(pendingPetStoryDrafts(project.id)).toHaveLength(1);
    const retry = mockSuccessfulSave();
    fireEvent.click(within(dialog).getByRole('button', { name: /确\s*定/ }));
    await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
    expect(retry).toHaveBeenCalledOnce();
  });

  it('同项正式正文已被修改时拒绝覆盖，当前输入留在编辑框', async (): Promise<void> => {
    const save = mockSuccessfulSave(); render(<Harness />);
    const dialog = openEditor(); const input = within(dialog).getByRole('textbox', { name: '提示词正文' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'TEST 我未保存的正文' } });
    act((): void => {
      const next = structuredClone(project); next.plan!.shots[0].prompts.firstFrame.final = 'TEST 另一处已保存的新正文'; next.revision++;
      usePetStoryStore.setState({ project: next });
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /确\s*定/ }));
    await waitFor((): void => expect(within(dialog).getByRole('alert').textContent).toContain('当前正文已变化'));
    expect(save).not.toHaveBeenCalled(); expect(input.value).toBe('TEST 我未保存的正文');
    expect(usePetStoryStore.getState().project!.plan!.shots[0].prompts.firstFrame.final).toBe('TEST 另一处已保存的新正文');
  });

  it('从全文进入手改只保留一个弹窗，浏览全文本身不保存', (): void => {
    const save = mockSuccessfulSave(); render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '放大镜头1首帧生图提示词' }));
    const preview = screen.getByRole('dialog');
    fireEvent.click(within(preview).getByRole('button', { name: '手动修改' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(screen.getByRole('dialog')).getByRole('textbox', { name: '提示词正文' })).toBeDefined();
    expect(save).not.toHaveBeenCalled();
  });

  it('手改后的当前正文不被没有candidateJobId的旧optimized候选遮住', (): void => {
    const prompt = project.plan!.shots[0].prompts.firstFrame; prompt.edited = true;
    project.jobs = [{ id: 'TEST-old-candidate', kind: 'optimize', taskId: 'TEST-chat', shotId: project.plan!.shots[0].id, promptKind: 'firstFrame', status: 'applied', resultStatus: 'candidate', inputHash: 'TEST', sourceUrl: '', parsedResult: { optimized: prompt.optimized } }];
    render(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />);
    expect(screen.getByLabelText(/当前正文/).textContent).toBe(prompt.final);
    expect(screen.queryByRole('button', { name: '确认使用' })).toBeNull();
  });

  it('手改确认后旧待修订回复仅留历史，不再遮挡正文或显示当前失败提示', (): void => {
    const prompt = project.plan!.shots[0].prompts.firstFrame; prompt.edited = true;
    project.jobs = [{ id: 'TEST-old-invalid', kind: 'optimize', taskId: 'TEST-chat', shotId: project.plan!.shots[0].id, promptKind: 'firstFrame', status: 'invalid', resultStatus: 'stale', inputHash: 'TEST', sourceUrl: '', parsedResult: { optimized: 'TEST 旧的不合格回复' } }];
    const { container } = render(<Harness />);
    expect(screen.getByLabelText(/当前正文/).textContent).toBe(prompt.final);
    expect(container.querySelector('.canvas-error')).toBeNull();
    expect(container.textContent).not.toContain('本项内容需要调整');
    expect(project.jobs[0].parsedResult?.optimized).toBe('TEST 旧的不合格回复');
  });
});
