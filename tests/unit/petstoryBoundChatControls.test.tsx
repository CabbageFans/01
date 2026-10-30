/** 原五镜头来源的离线未发送恢复权限测试，不发送平台请求。 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryChatJob, PetStoryPlan, PetStoryProject, PetStoryPromptProfile, Task } from '@doubao-studio/contracts';
import { canStartBoundChat } from '../../src/utils/petstoryCandidate';
import { PromptProvenance } from '../../src/components/PetStoryCanvasPrompt';
import { PetStoryPanel, PromptProfileEditor } from '../../src/components/PetStoryPanel';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import snapshot from '../fixtures/storyboard-five-shots.json';

const profileSelects = vi.hoisted(() => new Map<string, React.ComponentProps<typeof import('antd').Select>>());
vi.mock('antd', async (importOriginal): Promise<object> => {
  const actual = await importOriginal<typeof import('antd')>();
  // 展开历史容器以审查真实 Panel 条件；按钮及其余组件仍使用原实现。
  return { ...actual,
    Select: (props: React.ComponentProps<typeof actual.Select>): React.ReactElement => { if (props['aria-label']) profileSelects.set(props['aria-label'], props); return React.createElement(actual.Select, props); },
    Collapse: ({ items }: { items?: { label?: React.ReactNode; children?: React.ReactNode }[] }): React.ReactElement => <div>{items?.map((item, index): React.ReactNode => <div key={index}>{item.label}{item.children}</div>)}</div> };
});

const initial = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-10-27T00:00:00.000Z';
const label = '处理阻断后继续原任务（未发送）';
let project: PetStoryProject; let job: PetStoryChatJob; let task: Task;
beforeEach((): void => {
  profileSelects.clear();
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

describe('已保存动态角色资料的正常编辑投影', (): void => {
  it('默认两键去重，已存配角按当前方案名称呈现，无匹配角色保留ID与字段，查看不改资料或发送', (): void => {
    const profile: PetStoryPromptProfile = { style: 'TEST已存共同风格', characters: {
      lulu: { identity: 'TEST已存噜噜身份', appearance: 'TEST已存噜噜造型' },
      lumei: { identity: 'TEST已存噜妹身份', appearance: 'TEST已存噜妹造型' },
      friend: { identity: 'TEST已存配角身份', appearance: 'TEST已存配角造型' },
      supporting_saved: { identity: 'TEST无当前方案映射身份', appearance: 'TEST无当前方案映射造型' }}, assetStyles: { common: 'TEST已存共同风格' } };
    project.promptProfile = profile;
    project.plan!.characters = [...project.plan!.characters.filter((character): boolean => character.id !== 'friend'), { ...project.plan!.characters[0], id: 'friend', name: 'TEST当前方案配角名称' }];
    const before = structuredClone(project.promptProfile); const change = vi.fn(); const save = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ project, savePromptProfile: save });
    const html = renderToStaticMarkup(<PromptProfileEditor project={project} profile={profile} setProfile={change} disabled={false} onDirtyChange={(): void => undefined} />);
    expect(html).toContain('默认角色与共同风格（可编辑）'); expect(html).toContain('TEST当前方案配角名称');
    expect(html).toContain('aria-label="friendidentity预设"'); expect(html).toContain('TEST已存配角身份'); expect(html).toContain('TEST已存配角造型');
    expect(html).toContain('supporting_saved'); expect(html).toContain('TEST无当前方案映射身份');
    expect(html.match(/aria-label="luluidentity预设"/g)).toHaveLength(1); expect(html.match(/aria-label="lumeiidentity预设"/g)).toHaveLength(1);
    expect(html).toContain('噜噜'); expect(html).toContain('噜妹'); expect(project.promptProfile).toEqual(before);
    expect(change).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(useTaskStore.getState().tasks).toEqual([task]);
  });
  it('任意已配置演员的别名顺序与主配角职责原样显示，控件修改沿profile草稿保存且可清空旧可选字段', (): void => {
    const id = 'TEST-dynamic-performer';
    let profile: PetStoryPromptProfile = { style: 'TEST共同风格', characters: {
      [id]: { identity: 'TEST演员既有身份', appearance: 'TEST演员既有造型', aliases: ['来源称谓乙', ' 原始别名 '], role: 'supporting' }} };
    project.promptProfile = structuredClone(profile); const savedBefore = structuredClone(project.promptProfile);
    const save = vi.fn(async (): Promise<void> => undefined); usePetStoryStore.setState({ project, savePromptProfile: save });
    const render = (): string => renderToStaticMarkup(<PromptProfileEditor project={project} profile={profile} setProfile={(value: PetStoryPromptProfile): void => { profile = value; }} disabled={false} onDirtyChange={(): void => undefined} />);
    const html = render(); expect(html).toContain('来源称谓乙'); expect(html).toContain('原始别名'); expect(html).toContain('配角');
    expect(profileSelects.get(`${id}来源称谓别名`)).toMatchObject({ mode: 'tags', value: ['来源称谓乙', ' 原始别名 '] });
    expect(profileSelects.get(`${id}角色职责`)).toMatchObject({ allowClear: true, value: 'supporting' });
    expect(profileSelects.get('lulu来源称谓别名')?.value).toEqual([]); expect(profileSelects.get('lulu角色职责')?.value).toBeUndefined();
    const aliases = [' 原始别名 ', '来源称谓乙', '新来源称谓'];
    profileSelects.get(`${id}来源称谓别名`)!.onChange!(aliases, []); render();
    profileSelects.get(`${id}角色职责`)!.onChange!('main'); render();
    expect(profile.characters[id]).toEqual({ ...savedBefore.characters[id], aliases, role: 'main' });
    expect(Object.keys(profile.characters)).toEqual([id]); // 查看默认两主控件不擅自添加演员或分派别名。
    profileSelects.get(`${id}来源称谓别名`)!.onChange!([], []); render();
    profileSelects.get(`${id}角色职责`)!.onChange!(undefined); render();
    expect(profile.characters[id]).toMatchObject({ identity: 'TEST演员既有身份', appearance: 'TEST演员既有造型' });
    expect(profile.characters[id].aliases).toBeUndefined(); expect(profile.characters[id].role).toBeUndefined();
    // 旧配置未存默认两主时，仅用户真的编辑的条目获得空结构，不编造身份或自动分派主配角。
    profileSelects.get('lulu来源称谓别名')!.onChange!(['TEST用户明确填写称谓'], []); render();
    expect(profile.characters.lulu).toEqual({ identity: '', appearance: '', aliases: ['TEST用户明确填写称谓'] });
    expect(profile.characters.lumei).toBeUndefined();
    expect(project.promptProfile).toEqual(savedBefore); expect(save).not.toHaveBeenCalled(); expect(useTaskStore.getState().tasks).toEqual([task]);
  });
});

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
