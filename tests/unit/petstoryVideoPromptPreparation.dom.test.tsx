/** 离线验证后台正文准备与媒体节点反馈，不向豆包发送任何请求。 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryGenerationEligibilityResult, PetStoryPlan, PetStoryProject } from '@doubao-studio/contracts';
import { CanvasMediaNode } from '../../src/components/PetStoryCanvasMedia';
import { CanvasPromptEditor } from '../../src/components/PetStoryCanvasPrompt';
import { isPetStoryPromptPreparationMessage } from '../../src/components/petStoryCanvasShared';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

const initial = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const missing = '视频提示词 / 运镜尚未准备；开始本镜制作后将先在后台准备并校验，通过后请确认使用。';
const candidate = '视频提示词 / 运镜已有待采用候选，请先在对应提示词节点“确认使用”，再生成媒体。';
let project: PetStoryProject;
let blocker: string;

beforeEach((): void => {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan; plan.shots = plan.shots.slice(0, 1); plan.shots[0].prompts.video.final = '';
  project = { schemaVersion: 1, id: 'TEST-prompt-preparation', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, plan, assets: [], jobs: [], updatedAt: '2026-11-01T00:00:00.000Z' };
  blocker = missing;
  window.electronAPI = { petstory: {
    inspectGeneration: vi.fn(async (): Promise<PetStoryGenerationEligibilityResult> => ({ success: true, eligibility: { ready: !blocker, blockers: blocker ? [{ code: 'prompt', message: blocker }] : [] } })),
  } } as unknown as typeof window.electronAPI;
  usePetStoryStore.setState({ ...initial.pet, project, busy: false, error: '', promptRepairJobIds: [], generateShotMedia: vi.fn() });
  useTaskStore.setState({ ...initial.tasks, tasks: [], executingTasks: {}, activeTaskId: null });
});
afterEach((): void => { usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });

const Node: React.FC = (): React.ReactElement => {
  const current = usePetStoryStore((state) => state.project);
  return current?.plan ? <CanvasMediaNode project={current} shot={current.plan.shots[0]} kind="video" disabled={false} /> : <></>;
};
async function changePrompt(message: string, adopted: boolean = false): Promise<void> {
  blocker = message;
  await act(async (): Promise<void> => {
    const saved = structuredClone(usePetStoryStore.getState().project!); saved.revision++;
    if (adopted) saved.plan!.shots[0].prompts.video.final = 'TEST 已明确采用的合格正文';
    usePetStoryStore.setState({ project: saved });
  });
}

async function startWithError(message: string): Promise<void> {
  usePetStoryStore.setState({ generateShotMedia: vi.fn(async (): Promise<void> => { usePetStoryStore.setState({ error: message }); }) });
  render(<Node />);
  await screen.findByText(missing);
  fireEvent.click(screen.getByRole('button', { name: /生成视频$/ }));
  await screen.findByRole('alert');
}

describe('视频节点的后台提示词准备', (): void => {
  it.each(['firstFrame', 'lastFrame'] as const)('%s先独立生成并确认提示词，再由生成图片按钮出图', async (kind: 'firstFrame' | 'lastFrame'): Promise<void> => {
    const shot = project.plan!.shots[0]; shot.prompts[kind] ||= structuredClone(shot.prompts.firstFrame);
    shot.prompts[kind]!.final = ''; shot.prompts[kind]!.optimized = '';
    blocker = '请先点击“生成提示词”，确认使用后再生成图片。';
    const generate = vi.fn(async (): Promise<void> => undefined);
    const generatePrompt = vi.fn(async (): Promise<void> => {
      const saved = structuredClone(usePetStoryStore.getState().project!); saved.revision++;
      const prompt = saved.plan!.shots[0].prompts[kind]!;
      prompt.optimized = 'TEST 本次完整生图提示词'; prompt.candidateJobId = 'TEST-frame-candidate';
      saved.jobs.push({ id: prompt.candidateJobId, taskId: 'TEST-frame-chat', kind: 'optimize', shotId: shot.id, promptKind: kind,
        status: 'applied', resultStatus: 'candidate', inputHash: 'TEST', sourceUrl: '', parsedResult: { optimized: prompt.optimized } });
      usePetStoryStore.setState({ project: saved });
    });
    const adopt = vi.fn(async (): Promise<void> => {
      const saved = structuredClone(usePetStoryStore.getState().project!); saved.revision++;
      const prompt = saved.plan!.shots[0].prompts[kind]!; prompt.final = prompt.optimized;
      saved.jobs[0].resultStatus = 'adopted'; blocker = ''; usePetStoryStore.setState({ project: saved });
    });
    usePetStoryStore.setState({ project, generateShotMedia: generate, generateShotPrompt: generatePrompt, adoptPromptCandidate: adopt });
    const FrameNodes: React.FC = (): React.ReactElement => {
      const current = usePetStoryStore((state) => state.project);
      if (!current?.plan) return <></>;
      const currentShot = current.plan.shots[0];
      return <><CanvasPromptEditor project={current} shot={currentShot} kind={kind} disabled={false} generationBlocked={false} dirtyChanged={(): void => undefined} />
        <CanvasMediaNode project={current} shot={currentShot} kind={kind} disabled={false} /></>;
    };
    render(<FrameNodes />);
    const button = screen.getByRole('button', { name: '生成图片' });
    await screen.findByText(blocker); expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button); expect(generate).not.toHaveBeenCalled(); expect(generatePrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '生成提示词' }));
    await screen.findByRole('button', { name: '确认使用' });
    expect(generatePrompt).toHaveBeenCalledExactlyOnceWith(shot.id, kind);
    expect(button.hasAttribute('disabled')).toBe(true); expect(generate).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().project!.plan!.shots[0].prompts[kind]!.final).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '确认使用' }));
    await waitFor((): void => expect(button.hasAttribute('disabled')).toBe(false));
    expect(adopt).toHaveBeenCalledExactlyOnceWith('TEST-frame-candidate'); expect(generate).not.toHaveBeenCalled();
    fireEvent.click(button); expect(generate).toHaveBeenCalledExactlyOnceWith(shot.id, kind);
    expect(generatePrompt).toHaveBeenCalledOnce();
  });
  it('没有正式正文仍可启动本镜制作；后台修订进度由实际在途记录呈现，不增加修复按钮', async (): Promise<void> => {
    const generate = vi.fn(async (): Promise<void> => {
      const saved = structuredClone(project); saved.revision++;
      saved.jobs.push({ id: 'TEST-invalid-parent', taskId: 'TEST-chat', kind: 'optimize', shotId: saved.plan!.shots[0].id, promptKind: 'video', status: 'invalid', inputHash: 'TEST', sourceUrl: '', rawText: 'TEST 已收取原回复' });
      usePetStoryStore.setState({ project: saved, promptRepairJobIds: ['TEST-invalid-parent'], error: '' });
    });
    usePetStoryStore.setState({ generateShotMedia: generate }); render(<Node />);
    await screen.findByText(missing);
    expect(screen.queryByText('提示词后台准备中')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /生成视频$/ }));
    await screen.findByText('提示词后台准备中');
    expect(screen.getByText('视频提示词正在后台修订并校验，通过后请确认使用。').getAttribute('role')).toBe('status');
    expect(generate).toHaveBeenCalledExactlyOnceWith(project.plan!.shots[0].id, 'video');
    expect(screen.queryByRole('button', { name: '按原要求修复' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('合法候选返回后替换旧的缺提示词错误，明确候选尚需确认', async (): Promise<void> => {
    await startWithError('镜头或最终提示词不存在');
    await changePrompt(candidate);
    await waitFor((): void => expect(screen.queryByText('镜头或最终提示词不存在')).toBeNull());
    expect(screen.getByText('提示词待确认')).toBeDefined();
    expect(screen.getByText(candidate).getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(usePetStoryStore.getState().project!.plan!.shots[0].prompts.video.final).toBe('');
  });

  it('明确采用后清除旧本地准备错误，不保留误导的失败状态', async (): Promise<void> => {
    await startWithError('镜头或最终提示词不存在');
    await changePrompt('', true);
    await waitFor((): void => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByText(missing)).toBeNull();
  });

  it('正文候选更新不会清除实际平台错误', async (): Promise<void> => {
    const platformError = 'TEST 平台额度不足，请查看原账号';
    await startWithError(platformError);
    await changePrompt(candidate);
    await waitFor((): void => expect(screen.getByText(candidate)).toBeDefined());
    expect(screen.getByRole('alert').textContent).toBe(platformError);
  });

  it('原文字任务登录验证阻断以真实原因提示，不伪称后台仍在生成', async (): Promise<void> => {
    blocker = '视频提示词 / 运镜后台准备已暂停：请先完成原账号登录或人机验证。';
    render(<Node />);
    expect((await screen.findByRole('alert')).textContent).toBe(blocker);
    expect(screen.queryByText('提示词后台准备中')).toBeNull();
  });

  it.each(['TEST 平台额度不足', '视频提示词 / 运镜后台准备已暂停：登录失效', '视频提示词 / 运镜的原文字任务是否受理尚未确认，请检查原结果；不会自动重发。'])('不会将真实阻断 %s 识别成过时正文准备提示', (message: string): void => {
    expect(isPetStoryPromptPreparationMessage(message)).toBe(false);
  });
});
