/** 原五镜头来源的离线未发送恢复权限测试，不发送平台请求。 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryChatJob, PetStoryPlan, PetStoryProject, Task } from '@doubao-studio/contracts';
import { canStartBoundChat } from '../../src/utils/petstoryCandidate';
import { PromptProvenance } from '../../src/components/PetStoryCanvasPrompt';
import { PetStoryPanel } from '../../src/components/PetStoryPanel';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

vi.mock('antd', async (importOriginal): Promise<object> => {
  const actual = await importOriginal<typeof import('antd')>();
  // 展开历史容器以审查真实 Panel 条件；按钮及其余组件仍使用原实现。
  return { ...actual,
    Collapse: ({ items }: { items?: { label?: React.ReactNode; children?: React.ReactNode }[] }): React.ReactElement => <div>{items?.map((item, index): React.ReactNode => <div key={index}>{item.label}{item.children}</div>)}</div> };
});

const initial = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-10-27T00:00:00.000Z';
const label = '处理阻断后继续原任务（未发送）';
let project: PetStoryProject; let job: PetStoryChatJob; let task: Task;
beforeEach((): void => {
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation(<T,>(_subscribe: (onStoreChange: () => void) => () => void, getSnapshot: () => T): T => getSnapshot());
  job = { id: 'TEST-job', taskId: 'TEST-task', kind: 'materialPrompt', materialId: 'prop:branch_short', status: 'bound', inputHash: 'TEST', sourceUrl: '', sourceStoryId: 'TEST-story', runId: 'TEST-original-run', requestId: 'TEST-request', requestText: 'TEST离线请求' };
  task = { id: job.taskId, projectId: 'TEST-studio', assignedAccountId: 'TEST-account', mode: 'chat', status: 'waiting_verification', prompt: 'TEST离线请求', outputs: [], result: null, createdAt: now, updatedAt: now,
    errorInfo: { code: 'page_unrecognized', message: 'TEST提交前页面阻断', recoverable: true, detectedAt: now },
    runtime: { runId: job.runId!, attempt: 1, stage: 'waiting_verification', message: 'TEST未发送', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { prompt: 'TEST离线请求', mode: 'chat', attachments: [] } } };
  project = { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, updatedAt: now,
    source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [job], mobileStory: { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now }, plan: structuredClone(snapshot.plan) as PetStoryPlan };
  usePetStoryStore.setState({ project, busy: false});
  useTaskStore.setState({ tasks: [task], activeTaskId: null, accountBusy: {} });
});
afterEach((): void => { usePetStoryStore.setState(initial.petstory); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });
function allowed(): boolean { return canStartBoundChat(project, job, task, [task]); }
function historyHtml(): string { return renderToStaticMarkup(<PetStoryPanel />); }

describe('原绑定文字任务明确未发送的继续入口', (): void => {
  it.each(['fail', 'paused', 'cancelled', 'waiting_verification'] as const)('%s且原运行/输入一致、无提交证据时允许恢复', (status: Task['status']): void => {
    task.status = status; if (status === 'cancelled') task.errorInfo!.code = 'cancelled'; expect(allowed()).toBe(true);
  });
  it('正式解除job.runId后同任务重入队持久化失败，精确原请求证据允许恢复但不伪绑旧run', (): void => {
    job.runId = undefined; task.status = 'fail'; task.errorInfo!.code = 'page_changed';
    expect(allowed()).toBe(true); expect(historyHtml()).toContain(label); expect(job.runId).toBeUndefined();
  });
  it.each(['request', 'legacy', 'submitted', 'ended', 'lock', 'runtime_input'] as const)('缺job.runId时%s证据不满足仍拒绝恢复', (change: string): void => {
    job.runId = undefined; task.status = 'fail'; task.errorInfo!.code = 'page_changed';
    if (change === 'request') job.requestText += 'TEST不匹配正文';
    if (change === 'legacy') job.requestId = undefined;
    if (change === 'submitted') task.runtime!.submittedAt = now;
    if (change === 'ended') job.endedWaitingAt = now;
    if (change === 'lock') task.lock = { ownerId: 'TEST-lease-record', acquiredAt: now, expiresAt: '2020-01-01T00:00:00.000Z' };
    if (change === 'runtime_input') task.runtime!.input.prompt += 'TEST不匹配原输入';
    expect(allowed()).toBe(false); expect(historyHtml()).not.toContain(label); expect(job.runId).toBeUndefined();
  });
  it('page_changed明确未提交且原运行匹配时可由正式原任务入口恢复，unknown仍不允许', (): void => {
    task.status = 'fail'; task.errorInfo!.code = 'page_changed'; expect(allowed()).toBe(true);
    expect(renderToStaticMarkup(<PromptProvenance job={job} task={task} />)).toContain(label);
    task.errorInfo!.code = 'unknown'; expect(allowed()).toBe(false);
  });
  it.each(['submitted', 'occupied'] as const)('page_changed仍受%s证据保护，不按错误码绕过发送门禁', (state: string): void => {
    task.status = 'fail'; task.errorInfo!.code = 'page_changed';
    if (state === 'submitted') task.runtime!.submittedAt = now;
    else useTaskStore.setState({ accountBusy: { [project.accountId]: true } });
    const occupied = !!useTaskStore.getState().accountBusy[project.accountId];
    expect(canStartBoundChat(project, job, task, [task], occupied)).toBe(false);
    expect(renderToStaticMarkup(<PromptProvenance job={job} task={task} />)).not.toContain(label);
  });
  it('初次queued保持入口；正式重入队后仍可在同一hold任务上初始化新run', (): void => {
    task.status = 'queued'; task.runtime = undefined; job.runId = undefined; expect(allowed()).toBe(true);
    task.runtime = { runId: 'TEST-stopped-old-run', attempt: 1, stage: 'queued', message: 'TEST正式hold重入队', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { prompt: task.prompt, mode: 'chat', attachments: [] } };
    task.executionIntent = 'hold'; expect(allowed()).toBe(true);
  });
  it.each(['submitted', 'acceptance', 'response', 'ended', 'run', 'task', 'account', 'project', 'story', 'mode', 'input', 'attachments', 'lease', 'unknown_error'] as const)('%s证据或归属不符不提供发送入口', (change: string): void => {
    if (change === 'submitted') task.runtime!.submittedAt = now;
    if (change === 'acceptance') task.runtime!.acceptanceObservation = { schemaVersion: 1, accountId: project.accountId, runId: job.runId!, conversationUrl: 'https://www.doubao.com/chat/TEST-offline', acceptedAt: now, evidence: { kind: 'prompt_published' }, cursor: { messageCount: 1, pollCount: 0 }, expectedArtifact: { kind: 'file', runId: job.runId! }, lease: { ownerId: 'TEST', acquiredAt: now, expiresAt: now, lastHeartbeatAt: now }, outcome: 'observing' };
    if (change === 'response') task.runtime!.chatResponse = { text: 'TEST离线回复证据', capturedAt: now };
    if (change === 'ended') job.endedWaitingAt = now;
    if (change === 'run') job.runId = 'TEST-other-run';
    if (change === 'task') job.taskId = 'TEST-other-task';
    if (change === 'account') task.assignedAccountId = 'TEST-other-account';
    if (change === 'project') task.projectId = 'TEST-other-studio';
    if (change === 'story') job.sourceStoryId = 'TEST-other-story';
    if (change === 'mode') task.mode = 'image';
    if (change === 'input') task.runtime!.input.prompt += 'TEST不同输入';
    if (change === 'attachments') task.runtime!.input.attachments = ['TEST-offline-unmatched'];
    if (change === 'lease') task.lock = { ownerId: 'TEST-active', acquiredAt: now, expiresAt: '2999-01-01T00:00:00.000Z' };
    if (change === 'unknown_error') task.errorInfo!.code = 'unknown';
    expect(allowed()).toBe(false);
    expect(renderToStaticMarkup(<PromptProvenance job={job} task={task} />)).not.toContain(label);
  });
  it.each(['executing', 'generating', 'waiting_generation_confirmation', 'manual_submission_observing'] as const)('当前%s运行不能重新发送', (status: Task['status']): void => {
    task.status = status; expect(allowed()).toBe(false);
  });
  it('同账号其他任务或执行租约占用、当前引擎占用都不放行；无关账号不阻断', (): void => {
    const other: Task = { ...task, id: 'TEST-other', status: 'generating' };
    expect(canStartBoundChat(project, job, task, [task, other])).toBe(false);
    other.assignedAccountId = 'TEST-other-account'; expect(canStartBoundChat(project, job, task, [task, other])).toBe(true);
    expect(canStartBoundChat(project, job, task, [task], true)).toBe(false);
  });
  it('画布与历史均显示同一可用恢复入口，单纯查看不调用startBoundChat', (): void => {
    const start = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ startBoundChat: start });
    expect(renderToStaticMarkup(<PromptProvenance job={job} task={task} />)).toContain(label);
    const html = historyHtml(); expect(html).toContain(label);
    const button = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((entry): boolean => entry.replace(/<[^>]*>/g, '') === label);
    expect(button).toBeDefined(); expect(button).not.toContain('disabled'); expect(start).not.toHaveBeenCalled();
  });
  it('已提交时历史与画布均不暴露恢复发送按钮', (): void => {
    task.runtime!.submittedAt = now;
    const html = historyHtml(); expect(html).not.toContain(label); expect(html).not.toContain('重试原任务（尚未提交）');
    expect(renderToStaticMarkup(<PromptProvenance job={job} task={task} />)).not.toContain(label);
  });
  it.each(['ended', 'occupied'] as const)('%s时旧版重试提示也受同一条件保护，不能绕过历史与画布条件', (state: string): void => {
    if (state === 'ended') job.endedWaitingAt = now;
    else useTaskStore.setState({ accountBusy: { [project.accountId]: true } });
    const html = historyHtml(); expect(html).not.toContain(label); expect(html).not.toContain('重试原任务（尚未提交）');
  });
});
