/** 离线会话入口回归：IPC 和账号均为替身，只验证导航事件，不访问豆包或启动任务。 */
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, PetStoryChatJob, PetStoryPlan, PetStoryProduction, PetStoryProject, Task } from '@doubao-studio/contracts';
import { CanvasPromptEditor } from '../../src/components/PetStoryCanvasPrompt';
import { CanvasMediaNode } from '../../src/components/PetStoryCanvasMedia';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { useAccountStore } from '../../src/store/useAccountStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

const original = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState(), accounts: useAccountStore.getState() };
const now = '2026-11-08T00:00:00.000Z';
const account: Account = { id: 'TEST-conversation-account', name: 'TEST 原执行账号', platform: 'doubao', avatar: '', partition: 'TEST-only', status: 'idle', pinned: false, createdAt: now, updatedAt: now };
let project: PetStoryProject;
let chat: Task;
let video: Task;
let opened: Task[];
let locateRequests: Task[];
let selectAccount: ReturnType<typeof vi.fn<(id: string | null) => void>>;
let generate: ReturnType<typeof vi.fn<() => Promise<void>>>;
const dirtyChanged = (): void => undefined;
const captureConversation = (event: Event): void => {
  const detail = (event as CustomEvent<{ task: Task; locateSubmittedMedia?: boolean }>).detail;
  opened.push(detail.task); if (detail.locateSubmittedMedia) locateRequests.push(detail.task);
};

function makeTask(name: string, mode: 'chat' | 'video'): Task {
  return { id: `TEST-${name}-task`, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode,
    status: mode === 'chat' ? 'done' : 'paused', prompt: 'TEST 任务输入', outputs: [], result: null, createdAt: now, updatedAt: now,
    ...(mode === 'chat' ? { petstoryChat: { projectId: project.id, jobId: `TEST-${name}-job` } } : { petstory: { projectId: project.id, stepId: `TEST-${name}-step` } }),
    runtime: { runId: `TEST-${name}-run`, attempt: 1, stage: mode === 'chat' ? 'completed' : 'configuring', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      conversationUrl: `https://www.doubao.com/chat/TEST-${name}`, input: { mode, prompt: 'TEST 任务输入', attachments: [] } } };
}
function makeJob(task: Task): PetStoryChatJob {
  return { id: task.petstoryChat!.jobId, taskId: task.id, runId: task.runtime!.runId, kind: 'optimize', status: 'applied', resultStatus: 'adopted',
    shotId: project.plan!.shots[0].id, promptKind: 'video', requestId: 'TEST-chat-request', inputHash: 'TEST', sourceUrl: '',
    sourceStoryId: project.mobileStory!.id, parsedResult: { optimized: 'TEST 当前已采用视频正文' } };
}
function makeProduction(task: Task): PetStoryProduction {
  const entry = { state: 'supported' as const, reason: 'TEST 离线条件' };
  return { phase: 'shots', state: 'paused', planHash: 'TEST', approvedAt: now, fallbacks: {}, shots: {}, message: 'TEST 原视频准备已暂停',
    target: { shotId: project.plan!.shots[0].id, kind: 'video' }, capability: { accountId: project.accountId, checkedAt: now, durations: [5], image: entry,
      modes: { first_frame: entry, first_last_frame: entry, reference: entry } },
    steps: [{ id: task.petstory!.stepId, taskId: task.id, runId: task.runtime!.runId, kind: 'video', shotId: project.plan!.shots[0].id,
      status: 'bound', inputHash: 'TEST', attachmentAssetIds: [] }] };
}
function promptNode(): React.ReactElement {
  return <CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="video" disabled={false} generationBlocked={false} dirtyChanged={dirtyChanged} />;
}
function mediaNode(): React.ReactElement {
  return <CanvasMediaNode project={project} shot={project.plan!.shots[0]} kind="video" disabled={false} />;
}
function addSelectedVideo(task: Task): void {
  const shot = project.plan!.shots[0];
  project.assets.push({ id: 'TEST-selected-video', shotId: shot.id, kind: 'video', taskId: task.id, runId: task.runtime!.runId,
    relativePath: 'TEST-selected-video.mp4', generationFinal: shot.prompts.video.final });
  project.selectedVideos = { [shot.id]: 'TEST-selected-video' };
}
function expectNoProductionAction(): void {
  expect(generate).not.toHaveBeenCalled();
}
function submittedWithoutUrl(): void {
  video.runtime!.conversationUrl = undefined; video.runtime!.submittedAt = now; video.runtime!.stage = 'paused';
  video.runtime!.input.petstory = structuredClone(video.petstory);
  video.errorInfo = { code: 'submission_uncertain', message: 'TEST 发送结果待核对', recoverable: true, detectedAt: now };
}
function replaceOriginalVideo(): Task {
  submittedWithoutUrl();
  const replacement = makeTask('resubmitted-video', 'video'); replacement.runtime!.conversationUrl = undefined;
  replacement.resubmissionOf = { taskId: video.id, runId: video.runtime!.runId, submittedAt: now, authorizationId: 'TEST-resend-authorization', authorizedAt: now };
  video.resubmittedAs = [{ ...replacement.resubmissionOf, taskId: replacement.id }];
  const step = project.production!.steps[0]; step.taskId = replacement.id; step.runId = replacement.runtime!.runId;
  replacement.petstory!.stepId = step.id;
  step.resubmissionHistory = [{ ...replacement.resubmissionOf, inputHash: 'TEST', attachmentAssetIds: [] }];
  useTaskStore.setState({ tasks: [chat, video, replacement] }); return replacement;
}

beforeEach((): void => {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  plan.shots = plan.shots.slice(0, 1); plan.characters = []; plan.props = []; plan.scenes = [];
  const shot = plan.shots[0]; shot.characterIds = []; shot.propIds = []; shot.requestedMode = 'auto';
  shot.autoModePlan = { mode: 'first_frame', reason: 'TEST 持续动作无需固定终态' }; delete shot.prompts.lastFrame;
  shot.prompts.video = { original: 'TEST 当前已采用视频正文', optimized: 'TEST 当前已采用视频正文', final: 'TEST 当前已采用视频正文', edited: false, rulesVersion: 'TEST' };
  project = { schemaVersion: 1, id: 'TEST-conversation-project', studioProjectId: 'TEST-studio', accountId: account.id, revision: 1, updatedAt: now,
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-story', text: 'TEST 剧本', importedAt: now }, plan, assets: [], jobs: [] };
  chat = makeTask('source-chat', 'chat'); video = makeTask('current-video', 'video');
  project.jobs = [makeJob(chat)]; shot.prompts.video.sourceJobId = project.jobs[0].id; project.production = makeProduction(video);
  opened = []; locateRequests = []; window.addEventListener('open-task-conversation', captureConversation);
  selectAccount = vi.fn((id: string | null): void => { useAccountStore.setState({ selectedAccountId: id }); });
  generate = vi.fn(async (): Promise<void> => undefined);
  useAccountStore.setState({ ...original.accounts, accounts: [account], selectedAccountId: null, selectAccount });
  useTaskStore.setState({ ...original.tasks, tasks: [chat, video], activeTaskId: null, executingTasks: {}, accountBusy: {}, accountAutomationState: {} });
  usePetStoryStore.setState({ ...original.pet, project, busy: false, error: '', promptRepairJobIds: [],
    generateShotMedia: generate, resumeUnsubmittedVideo: generate, resumeCanvasPrompt: generate, revisePrompt: generate });
  window.electronAPI = { petstory: {
    inspectGeneration: vi.fn(async (): Promise<object> => ({ success: true, eligibility: { ready: true, blockers: [] } })),
    readMedia: vi.fn(async (): Promise<object> => ({ success: false, error: 'TEST 离线媒体替身' })),
    readReference: vi.fn(async (): Promise<object> => ({ success: false, error: 'TEST 离线图片替身' })),
  } } as unknown as typeof window.electronAPI;
});
afterEach((): void => {
  window.removeEventListener('open-task-conversation', captureConversation);
  usePetStoryStore.setState(original.pet); useTaskStore.setState(original.tasks); useAccountStore.setState(original.accounts); vi.restoreAllMocks();
});

describe('画布视频正文和视频产物的直接会话入口', (): void => {
  it('两处按钮分别打开文字来源和视频原任务，选择原账号且不启动或恢复任务', (): void => {
    render(<><section aria-label="TEST 视频正文">{promptNode()}</section><section aria-label="TEST 视频制作">{mediaNode()}</section></>);
    const promptButton = within(screen.getByRole('region', { name: 'TEST 视频正文' })).getByRole('button', { name: '进入豆包对话' });
    const videoButton = within(screen.getByRole('region', { name: 'TEST 视频制作' })).getByRole('button', { name: '进入豆包对话' });
    expect(promptButton.hasAttribute('disabled')).toBe(false); expect(videoButton.hasAttribute('disabled')).toBe(false);
    fireEvent.click(promptButton); fireEvent.click(videoButton);
    expect(opened.map((task: Task): string => task.id)).toEqual([chat.id, video.id]);
    expect(selectAccount).toHaveBeenCalledWith(project.accountId); expectNoProductionAction();
  });

  it('原视频已提交但缺URL时请求正式只读定位，不先显示账号当前页或启动任务', (): void => {
    submittedWithoutUrl(); const before = structuredClone(video);
    const reveal = vi.fn(); window.addEventListener('reveal-workspace-browser', reveal);
    try {
      render(mediaNode()); const button = screen.getByRole('button', { name: '进入豆包对话' });
      expect(button.hasAttribute('disabled')).toBe(false); fireEvent.click(button);
      expect(locateRequests.map((task: Task): string => task.id)).toEqual([video.id]);
      expect(selectAccount).not.toHaveBeenCalled(); expect(reveal).not.toHaveBeenCalled(); expectNoProductionAction();
      expect(video).toEqual(before);
    } finally { window.removeEventListener('reveal-workspace-browser', reveal); }
  });

  it.each(['prompt', 'attachments', 'videoConfig', 'petstory', 'submittedAt'] as const)('已提交视频%s与原运行输入不符时禁用定位', (field): void => {
    submittedWithoutUrl();
    if (field === 'prompt') video.prompt += ' TEST 后改';
    if (field === 'attachments') video.attachments = ['TEST-changed.png'];
    if (field === 'videoConfig') video.videoConfig = { model: 'seedance-2.0', duration: '8s', aspectRatio: '16:9' };
    if (field === 'petstory') video.runtime!.input.petstory = { ...video.petstory!, stepId: 'TEST-other-step' };
    if (field === 'submittedAt') video.runtime!.submittedAt = 'TEST-invalid-date';
    render(mediaNode()); const button = screen.getByRole('button', { name: '进入豆包对话' });
    expect(button.hasAttribute('disabled')).toBe(true); fireEvent.click(button);
    expect(opened).toEqual([]); expect(selectAccount).not.toHaveBeenCalled(); expectNoProductionAction();
  });

  it.each(['run', 'submittedAt', 'input', 'mode'] as const)('缺URL定位点击前%s改变时拒绝迟到按钮', (field): void => {
    submittedWithoutUrl(); render(mediaNode()); const button = screen.getByRole('button', { name: '进入豆包对话' });
    expect(button.hasAttribute('disabled')).toBe(false); const changed = structuredClone(video);
    if (field === 'run') changed.runtime!.runId = 'TEST-other-run';
    if (field === 'submittedAt') changed.runtime!.submittedAt = '2026-11-08T00:01:00.000Z';
    if (field === 'input') changed.runtime!.input.prompt += ' TEST changed';
    if (field === 'mode') changed.mode = 'image';
    act((): void => { useTaskStore.setState({ tasks: [chat, changed] }); fireEvent.click(button); });
    expect(opened).toEqual([]); expect(selectAccount).not.toHaveBeenCalled(); expectNoProductionAction();
  });

  it.each([false, true])('原请求已有具体URL=%s时移除额外入口，未发送的重发请求不会冒用原对话', (knownUrl: boolean): void => {
    const replacement = replaceOriginalVideo();
    if (knownUrl) video.runtime!.conversationUrl = 'https://www.doubao.com/chat/TEST-before-resend';
    const before = structuredClone({ tasks: [video, replacement], history: project.production!.steps[0].resubmissionHistory });
    render(mediaNode());
    const current = screen.getByRole('button', { name: '进入豆包对话' });
    expect(current.hasAttribute('disabled')).toBe(true); expect(current.getAttribute('title')).toContain('本次重发请求尚未发送');
    expect(screen.queryByRole('button', { name: '原请求豆包对话' })).toBeNull();
    expect(screen.queryByText('本次重发请求尚未发送；原请求对话单独保留。')).toBeNull();
    fireEvent.click(current);
    expect(opened).toEqual([]); expect(locateRequests).toEqual([]); expect(selectAccount).not.toHaveBeenCalled(); expectNoProductionAction();
    expect({ tasks: [video, replacement], history: project.production!.steps[0].resubmissionHistory }).toEqual(before);
  });

  it('重发来源关联变化后仍不提供额外入口，不打开原会话或启动制作', (): void => {
    const replacement = replaceOriginalVideo(); const view = render(mediaNode());
    const changed = structuredClone(replacement); changed.resubmissionOf!.authorizationId = 'TEST-later-authorization';
    act((): void => { useTaskStore.setState({ tasks: [chat, video, changed] }); });
    view.rerender(mediaNode());
    expect(screen.queryByRole('button', { name: '原请求豆包对话' })).toBeNull();
    const current = screen.getByRole('button', { name: '进入豆包对话' }); expect(current.hasAttribute('disabled')).toBe(true);
    fireEvent.click(current); expect(opened).toEqual([]); expect(locateRequests).toEqual([]); expect(selectAccount).not.toHaveBeenCalled(); expectNoProductionAction();
  });

  it('后续文字请求失败时仍打开当前正文的已采用来源', (): void => {
    const later = makeTask('later-failed-chat', 'chat'); later.status = 'fail';
    const failed = makeJob(later); failed.status = 'bound'; failed.resultStatus = undefined; failed.parsedResult = undefined;
    project.jobs.push(failed); useTaskStore.setState({ tasks: [chat, video, later] });
    render(promptNode()); fireEvent.click(screen.getByRole('button', { name: '进入豆包对话' }));
    expect(opened.map((task: Task): string => task.id)).toEqual([chat.id]); expectNoProductionAction();
  });

  it.each(['basis', 'candidate'] as const)('%s正文打开当前展示内容的具体来源', (source: 'basis' | 'candidate'): void => {
    const prompt = project.plan!.shots[0].prompts.video;
    const sourceTask = makeTask(`selected-${source}`, 'chat'); const sourceJob = makeJob(sourceTask);
    project.jobs.push(sourceJob);
    if (source === 'basis') { prompt.edited = true; prompt.basisJobId = sourceJob.id; prompt.sourceJobId = undefined; prompt.final = 'TEST 手动修改正文'; }
    else { sourceJob.resultStatus = 'candidate'; sourceJob.parsedResult = { optimized: 'TEST 当前候选正文' }; prompt.optimized = sourceJob.parsedResult.optimized!; prompt.candidateJobId = sourceJob.id; }
    useTaskStore.setState({ tasks: [chat, video, sourceTask] });
    render(promptNode()); fireEvent.click(screen.getByRole('button', { name: '进入豆包对话' }));
    expect(opened.map((task: Task): string => task.id)).toEqual([sourceTask.id]); expectNoProductionAction();
  });

  it('没有已显示正文时进入当前文字任务，尚无来源时保留禁用按钮', (): void => {
    const prompt = project.plan!.shots[0].prompts.video; prompt.final = ''; prompt.optimized = ''; prompt.sourceJobId = undefined;
    project.jobs[0].status = 'bound'; project.jobs[0].resultStatus = undefined; project.jobs[0].parsedResult = undefined;
    const view = render(promptNode()); fireEvent.click(screen.getByRole('button', { name: '进入豆包对话' }));
    expect(opened.map((task: Task): string => task.id)).toEqual([chat.id]);
    project = { ...project, jobs: [] }; usePetStoryStore.setState({ project }); view.rerender(promptNode());
    const missing = screen.getByRole('button', { name: '进入豆包对话' });
    expect(missing.hasAttribute('disabled')).toBe(true); expect(missing.getAttribute('title')).toBeTruthy();
    fireEvent.click(missing); expect(opened).toHaveLength(1); expectNoProductionAction();
  });

  it('新视频正在准备时优先打开该任务，保留旧视频不会串到旧产物对话', (): void => {
    const oldVideo = makeTask('old-video', 'video'); oldVideo.status = 'done'; addSelectedVideo(oldVideo);
    const oldProduction = makeProduction(oldVideo); oldProduction.state = 'complete'; oldProduction.steps[0].status = 'complete';
    project.productionHistory = [oldProduction]; useTaskStore.setState({ tasks: [chat, video, oldVideo] });
    render(mediaNode()); fireEvent.click(screen.getByRole('button', { name: '进入豆包对话' }));
    expect(opened.map((task: Task): string => task.id)).toEqual([video.id]); expectNoProductionAction();
  });

  it('没有未完成视频任务时，打开当前选定历史视频的来源而非较新的已完成步骤', (): void => {
    const oldVideo = makeTask('selected-old-video', 'video'); oldVideo.status = 'done'; addSelectedVideo(oldVideo);
    const oldProduction = makeProduction(oldVideo); oldProduction.state = 'complete'; oldProduction.steps[0].status = 'complete';
    project.productionHistory = [oldProduction]; project.production!.state = 'complete'; project.production!.steps[0].status = 'complete';
    video.status = 'done'; useTaskStore.setState({ tasks: [chat, video, oldVideo] });
    render(mediaNode()); fireEvent.click(screen.getByRole('button', { name: '进入豆包对话' }));
    expect(opened.map((task: Task): string => task.id)).toEqual([oldVideo.id]); expectNoProductionAction();
  });

  it.each(['account', 'project', 'run', 'step', 'missing_url', 'ambiguous_url'] as const)('视频来源%s不符或没有唯一对话时不跳转', (mismatch: 'account' | 'project' | 'run' | 'step' | 'missing_url' | 'ambiguous_url'): void => {
    if (mismatch === 'account') video.assignedAccountId = 'TEST-another-account';
    if (mismatch === 'project') video.projectId = 'TEST-another-studio';
    if (mismatch === 'run') video.runtime!.runId = 'TEST-newer-run';
    if (mismatch === 'step') video.petstory!.stepId = 'TEST-unrelated-step';
    if (mismatch === 'missing_url' || mismatch === 'ambiguous_url') delete video.runtime!.conversationUrl;
    if (mismatch === 'ambiguous_url') video.artifacts = ['A', 'B'].map((suffix: string): NonNullable<Task['artifacts']>[number] => ({ id: `TEST-artifact-${suffix}`, kind: 'video', source: 'page',
      url: `https://example.invalid/TEST-${suffix}.mp4`, runId: video.runtime!.runId, conversationUrl: `https://www.doubao.com/chat/TEST-${suffix}`, discoveredAt: now }));
    useTaskStore.setState({ tasks: [chat, video] }); render(mediaNode());
    const button = screen.getByRole('button', { name: '进入豆包对话' });
    expect(button.hasAttribute('disabled')).toBe(true); expect(button.getAttribute('title')).toBeTruthy();
    fireEvent.click(button); expect(opened).toEqual([]); expect(selectAccount).not.toHaveBeenCalled(); expectNoProductionAction();
  });

  it.each(['run', 'step'] as const)('点击时任务%s已变化不会沿旧按钮跳转', (changedField: 'run' | 'step'): void => {
    render(mediaNode()); const button = screen.getByRole('button', { name: '进入豆包对话' });
    const changed = structuredClone(video);
    if (changedField === 'run') changed.runtime!.runId = 'TEST-replaced-run';
    else changed.petstory!.stepId = 'TEST-replaced-step';
    act((): void => { useTaskStore.setState({ tasks: [chat, changed] }); fireEvent.click(button); });
    expect(opened).toEqual([]); expectNoProductionAction();
  });
});
