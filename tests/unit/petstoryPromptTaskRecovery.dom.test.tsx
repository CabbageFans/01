/** 离线恢复入口与状态投影；不作为真实豆包发送或登录验收。 */
import React from 'react';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PetStoryChatJob, PetStoryProject, Task } from '@doubao-studio/contracts';
import { PetStoryChatRecoveryActions, PetStoryCurrentTasks, petStoryJobStatus } from '../../src/components/PetStoryTaskRecovery';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';

const initial = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-11-01T00:00:00.000Z';
let project: PetStoryProject;
let job: PetStoryChatJob;
let task: Task;
beforeEach((): void => {
  job = { id: 'TEST-invalid-prompt', taskId: 'TEST-original-task', kind: 'optimize', shotId: 'TEST-shot', promptKind: 'video', status: 'invalid',
    requestId: 'TEST-request', inputHash: 'TEST', sourceUrl: '', sourceStoryId: 'TEST-story', rawText: 'TEST 已保存原回复', error: 'TEST 台词格式不符合契约',
    validationDetails: [{ code: 'prompt_content', path: '$.optimized', actualType: 'string', expected: 'TEST 完整契约', repairable: true, message: 'TEST 台词格式不符合契约' }] };
  project = { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-story', text: 'TEST 剧本', importedAt: now }, jobs: [job], assets: [], updatedAt: now };
  task = { id: job.taskId, projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'chat', status: 'done', prompt: 'TEST 原请求', outputs: [], result: null, createdAt: now, updatedAt: now };
  usePetStoryStore.setState({ ...initial.pet, project, busy: false, error: '', promptRepairJobIds: [] });
  useTaskStore.setState({ ...initial.tasks, tasks: [task], activeTaskId: null, accountBusy: {} });
});
afterEach((): void => { usePetStoryStore.setState(initial.pet); useTaskStore.setState(initial.tasks); });

describe('提示词校验的后台修订与真实恢复边界', (): void => {
  it('已知提示词内容失败只显示后台待修订，原回复留在诊断，不出现手动接管入口', (): void => {
    const before = structuredClone(project);
    render(<PetStoryCurrentTasks project={project} />);
    expect(screen.getByText('提示词待后台修订')).toBeDefined();
    expect(screen.queryByRole('button', { name: '继续处理具体缺项' })).toBeNull();
    expect(screen.queryByRole('button', { name: '在豆包中调整' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重新保存回复' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: '打开执行账号豆包' })).toBeDefined();
    expect(project).toEqual(before);
  });

  it('原job真实准备下一轮时显示后台进度，准备结束后不能继续冒充正在运行', (): void => {
    render(<PetStoryCurrentTasks project={project} />);
    act((): void => usePetStoryStore.setState({ promptRepairJobIds: [job.id] }));
    expect(screen.getByText('正在后台修订')).toBeDefined();
    expect(screen.getByText('正在后台修订并校验，校验通过后提供完整候选供确认。')).toBeDefined();
    act((): void => usePetStoryStore.setState({ promptRepairJobIds: [] }));
    expect(screen.queryByText('正在后台修订')).toBeNull();
    expect(screen.getByText('提示词待后台修订')).toBeDefined();
  });

  it('登录验证优先于校验修订，不以准备标记掩盖真实账号阻断', (): void => {
    task.status = 'waiting_verification';
    useTaskStore.setState({ tasks: [task] }); usePetStoryStore.setState({ promptRepairJobIds: [job.id] });
    render(<PetStoryCurrentTasks project={project} />);
    expect(screen.getByText('需要登录或验证')).toBeDefined();
    expect(screen.getByText('请先在原执行账号完成豆包登录或验证，再继续原任务。')).toBeDefined();
    expect(screen.queryByText('正在后台修订')).toBeNull();
    expect(screen.getByRole('button', { name: '打开执行账号豆包' })).toBeDefined();
  });

  it.each(['repair_drift', 'unknown_ownership'] as const)('%s真实异常保留原因，不声称后台可以改写解决', (code): void => {
    job.validationDetails = [{ code, path: '$', actualType: 'object', expected: 'TEST 当前依据', repairable: false, message: 'TEST 当前依据或回复归属需要核对' }];
    job.error = 'TEST 当前依据或回复归属需要核对';
    render(<PetStoryCurrentTasks project={project} />);
    expect(screen.getByText('回复需要核对')).toBeDefined();
    expect(screen.getAllByText(job.error).length).toBeGreaterThan(0);
    expect(screen.queryByText('提示词待后台修订')).toBeNull();
    expect(screen.queryByRole('button', { name: '继续处理具体缺项' })).toBeNull();
    expect(screen.getByRole('button', { name: '打开执行账号豆包' })).toBeDefined();
  });

  it('不符合目标的校验问题不被误认成可后台修订的本项内容', (): void => {
    job.validationDetails![0].targetId = 'TEST-other-shot:video';
    expect(petStoryJobStatus(job, task).title).toBe('回复需要核对');
    delete job.validationDetails;
    expect(petStoryJobStatus(job, task).title).toBe('回复需要核对');
  });

  it('已提交修订任务暂停时保留原回复核对，不能把未知发送结果变成新修订', (): void => {
    job.kind = 'repair'; job.originKind = 'optimize'; job.status = 'bound'; job.rawText = undefined;
    task.status = 'paused'; task.runtime = { runId: 'TEST-run', attempt: 1, stage: 'paused', message: '', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      submittedAt: now, input: { mode: 'chat', prompt: task.prompt, attachments: [] } };
    useTaskStore.setState({ tasks: [task] });
    render(<PetStoryCurrentTasks project={project} />);
    expect(screen.getByText('发送结果需要核对')).toBeDefined();
    expect(screen.getByRole('button', { name: '检查原回复（不重复发送）' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '继续处理具体缺项' })).toBeNull();
  });

  it('已排队的后台修订不要求再点继续，也不冒充已在平台生成', (): void => {
    job.kind = 'repair'; job.originKind = 'optimize'; job.status = 'bound'; job.rawText = undefined; task.status = 'queued';
    useTaskStore.setState({ tasks: [task] });
    render(<PetStoryCurrentTasks project={project} />);
    expect(screen.getByText('后台修订待启动')).toBeDefined();
    expect(screen.queryByRole('button', { name: '继续原文字任务（尚未发送）' })).toBeNull();
  });

  it('历史分析或审查职责保留恢复动作，只有真实准备修订期间收起额外发送入口', (): void => {
    job.kind = 'review'; job.originKind = undefined;
    const view = render(<PetStoryChatRecoveryActions project={project} job={job} task={task} />);
    expect(screen.getByRole('button', { name: '继续处理具体缺项' })).toBeDefined();
    expect(screen.getByRole('button', { name: '在豆包中调整' })).toBeDefined();
    act((): void => usePetStoryStore.setState({ promptRepairJobIds: [job.id] }));
    expect(screen.queryByRole('button', { name: '继续处理具体缺项' })).toBeNull();
    expect(screen.queryByRole('button', { name: '在豆包中调整' })).toBeNull();
    view.unmount();
    render(<PetStoryCurrentTasks project={project} />);
    const section = screen.getByRole('region', { name: '内容审查当前任务' });
    expect(within(section).getByText('正在后台修订')).toBeDefined();
  });
});
