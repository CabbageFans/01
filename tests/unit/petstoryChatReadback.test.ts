import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PetStoryChatJob, PetStoryProject, Task } from '@doubao-studio/contracts';
import { completedChatRunForRecovery } from '../../main/utils/petstoryChatReadback';

function fixture(): { project: PetStoryProject; job: PetStoryChatJob; task: Task } {
  const now = '2026-11-05T01:00:00.000Z'; const prompt = 'TEST原请求完整输入';
  const job: PetStoryChatJob = { id: 'job', taskId: 'task', kind: 'analysis', status: 'bound', requestId: 'request', expectedIds: ['plan'], sourceStoryId: 'story', sourceUrl: '',
    requestText: prompt, inputHash: createHash('sha256').update(prompt).digest('hex') };
  const project: PetStoryProject = { schemaVersion: 1, id: 'project', studioProjectId: 'studio', accountId: 'account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'story', text: 'TEST剧本', importedAt: now }, jobs: [job], assets: [], drafts: [], updatedAt: now };
  const task: Task = { id: 'task', prompt, assignedAccountId: 'account', projectId: 'studio', mode: 'chat', status: 'done', executionIntent: 'armed', result: null, outputs: [], createdAt: now, updatedAt: now,
    runHistory: [{ runId: 'run', attempt: 1, startedAt: now, finishedAt: now, finalStage: 'completed', outcome: 'done' }],
    runtime: { runId: 'run', attempt: 1, stage: 'completed', message: 'TEST完成', submittedAt: now, startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { mode: 'chat', prompt, attachments: [] }, chatResponse: { text: '\n```json\n{"requestId":"request","targetIds":["plan"],"storyUsable":true}\n```\n', capturedAt: now },
      chatReadback: { runId: 'run', baselineMessageCount: 0, requestId: 'request', targetIds: ['plan'], association: 'recorded_turn', userTurnId: 'user', assistantTurnId: 'assistant', observedAt: now } } };
  return { project, job, task };
}

describe('只读恢复已完成Chat缺失的业务运行关联', (): void => {
  it('唯一完成台账、精确原输入、来源和响应信封匹配时返回原run，输入对象不变', (): void => {
    const input = fixture(); const before = structuredClone(input);
    expect(completedChatRunForRecovery(input.project, input.job, input.task)).toBe('run');
    expect(input).toEqual(before);
  });

  it.each(['different-job-run', 'same-job-run', 'not-done', 'account', 'project', 'task-id', 'source-story', 'missing-story', 'source-url', 'request-text', 'hash', 'input-prompt', 'attachments',
    'no-submit', 'no-readback', 'readback-run', 'readback-request', 'readback-targets', 'multiple-history', 'history-run', 'history-not-done', 'response-request', 'response-targets', 'unparseable', 'duplicate-job', 'prompt-readback', 'business-binding', 'chat-marker-project', 'chat-marker-job'] as const)('缺失或不符证据%s不恢复，不替换既有run', (change: string): void => {
    const { project, job, task } = fixture(); const runtime = task.runtime!;
    if (change === 'different-job-run') job.runId = 'different';
    if (change === 'same-job-run') job.runId = 'run';
    if (change === 'not-done') task.status = 'paused';
    if (change === 'account') task.assignedAccountId = 'other';
    if (change === 'project') task.projectId = 'other';
    if (change === 'task-id') job.taskId = 'other';
    if (change === 'source-story') job.sourceStoryId = 'other';
    if (change === 'missing-story') { project.mobileStory = undefined; job.sourceStoryId = undefined; }
    if (change === 'source-url') job.sourceUrl = 'other';
    if (change === 'request-text') job.requestText = 'other';
    if (change === 'hash') job.inputHash = 'other';
    if (change === 'input-prompt') runtime.input.prompt = 'other';
    if (change === 'attachments') runtime.input.attachments = ['other'];
    if (change === 'prompt-readback') runtime.input.promptReadback = 'exact';
    if (change === 'business-binding') runtime.input.petstory = { projectId: 'other', stepId: 'other' };
    if (change === 'chat-marker-project') task.petstoryChat = { projectId: 'other', jobId: job.id };
    if (change === 'chat-marker-job') task.petstoryChat = { projectId: project.id, jobId: 'other' };
    if (change === 'no-submit') runtime.submittedAt = undefined;
    if (change === 'no-readback') runtime.chatReadback = undefined;
    if (change === 'readback-run') runtime.chatReadback!.runId = 'other';
    if (change === 'readback-request') runtime.chatReadback!.requestId = 'other';
    if (change === 'readback-targets') runtime.chatReadback!.targetIds = ['other'];
    if (change === 'multiple-history') task.runHistory!.push({ ...task.runHistory![0], runId: 'old' });
    if (change === 'history-run') task.runHistory![0].runId = 'other';
    if (change === 'history-not-done') task.runHistory![0].outcome = 'failed';
    if (change === 'response-request') runtime.chatResponse!.text = '{"requestId":"other","targetIds":["plan"]}';
    if (change === 'response-targets') runtime.chatResponse!.text = '{"requestId":"request","targetIds":["other"]}';
    if (change === 'unparseable') runtime.chatResponse!.text = 'TEST不完整回复';
    if (change === 'duplicate-job') project.jobs.push({ ...job, id: 'duplicate' });
    expect(completedChatRunForRecovery(project, job, task)).toBeUndefined();
  });
});
