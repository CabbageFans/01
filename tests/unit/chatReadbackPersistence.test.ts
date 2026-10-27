/** 离线任务台账验证：不访问账号、平台或用户任务文件。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Task, TaskRunSnapshot } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { TaskRepository } from '../../main/core/TaskRepository';
import { TaskEventStream } from '../../main/core/TaskEventStream';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';

const temporaryDirectories: string[] = [];
afterEach((): void => { for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function originalTask(): Task {
  const runtime: TaskRunSnapshot = { runId: 'OFFLINE-original-run', attempt: 1, stage: 'paused', message: 'OFFLINE只读等待', startedAt: '2026-10-26T00:00:00.000Z', stageStartedAt: '2026-10-26T00:00:00.000Z', lastHeartbeatAt: '2026-10-26T00:00:00.000Z',
    submittedAt: '2026-10-26T00:00:01.000Z', conversationUrl: 'https://www.doubao.com/chat/OFFLINE-private', input: { prompt: 'OFFLINE private input', mode: 'chat', attachments: [] } };
  return { id: 'OFFLINE-task', prompt: runtime.input.prompt, assignedAccountId: 'OFFLINE-account', status: 'paused', mode: 'chat', result: null, outputs: [], runtime, createdAt: runtime.startedAt, updatedAt: runtime.startedAt };
}
function receipt(): NonNullable<TaskRunSnapshot['chatReadback']> {
  return { runId: 'OFFLINE-original-run', baselineMessageCount: 0, requestId: 'OFFLINE-request', targetIds: ['OFFLINE-target'], userTurnId: 'OFFLINE-user-turn', assistantTurnId: 'OFFLINE-assistant-turn', association: 'request_envelope', observedAt: '2026-10-26T00:00:03.000Z' };
}
function repository(file: string): TaskRepository {
  return new TaskRepository({ read: (): unknown => JSON.parse(fs.readFileSync(file, 'utf8')) as unknown,
    write: (_filename: string, tasks: Task[]): boolean => { fs.writeFileSync(file, JSON.stringify(tasks)); return true; },
    normalize: normalizeTasks, defaultProjectId: (): string => 'OFFLINE-project', events: new TaskEventStream() });
}

describe('F03 消息轮次与原回复落盘（离线）', (): void => {
  it('restores receipt and ambiguous raw evidence through a fresh service, keeps submittedAt, and excludes private raw evidence from diagnostics', (): void => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'OFFLINE-chat-readback-')); temporaryDirectories.push(directory);
    const file = path.join(directory, 'tasks.json'); fs.writeFileSync(file, JSON.stringify([originalTask()]));
    const store = repository(file);
    const service = new TaskService({ store, defaultProjectId: (): string => 'OFFLINE-project' });
    const review: NonNullable<TaskRunSnapshot['chatReadbackReview']> = { runId: receipt().runId, checkedAt: receipt().observedAt, reason: 'reply_ambiguous', candidates: [
      { messageIndex: 1, rawText: 'OFFLINE PRIVATE RAW CANDIDATE A\n' + 'Ａ  B\\n'.repeat(20_000), turnId: 'OFFLINE-a' }, { messageIndex: 2, rawText: 'OFFLINE PRIVATE RAW CANDIDATE B', turnId: 'OFFLINE-b' },
    ] };
    expect(service.updateRuntime({ taskId: originalTask().id, runtime: { chatReadback: receipt(), chatReadbackReview: review } }).success).toBe(true);
    const reopenedStore = repository(file);
    const reopened = new TaskService({ store: reopenedStore, defaultProjectId: (): string => 'OFFLINE-project' });
    const restored = reopenedStore.read()[0];
    expect(restored.runtime).toMatchObject({ submittedAt: originalTask().runtime!.submittedAt, chatReadback: receipt(), chatReadbackReview: review });
    expect(restored.runtime?.chatResponse).toBeUndefined(); expect(restored.status).toBe('paused');
    const diagnostic = JSON.stringify(reopened.buildTaskDiagnostics());
    expect(diagnostic).not.toContain('PRIVATE RAW'); expect(diagnostic).not.toContain('OFFLINE-private'); expect(diagnostic).not.toContain('OFFLINE private input');
    const response = 'OFFLINE PRIVATE RAW RESPONSE\n```json\n{"incomplete":true,"literal":"Ａ  B\\\\n"}\n```';
    expect(reopened.updateRuntime({ taskId: restored.id, status: 'done', runtime: { stage: 'completed', chatReadback: receipt(), chatResponse: { text: response, capturedAt: receipt().observedAt } } }).success).toBe(true);
    const completed = repository(file).read()[0];
    expect(completed).toMatchObject({ status: 'done', runtime: { submittedAt: originalTask().runtime!.submittedAt, chatReadback: receipt(), chatReadbackReview: review, chatResponse: { text: response } } });
    expect(JSON.stringify(new TaskService({ store: repository(file), defaultProjectId: (): string => 'OFFLINE-project' }).buildTaskDiagnostics())).not.toContain('PRIVATE RAW');
  });

  it('合法可选消息 ID 和手动 Chat 无请求合同的逐字凭据都可经过真实归一化', (): void => {
    const incoming = originalTask();
    incoming.runtime!.chatReadback = { ...receipt(), userMessageId: 'OFFLINE.user:message=1', assistantMessageId: 'x'.repeat(256) };
    const normalized = normalizeTasks([incoming], 'OFFLINE-project').data[0];
    expect(normalized.runtime?.chatReadback).toEqual(incoming.runtime!.chatReadback);
    incoming.runtime!.chatReadback = { runId: receipt().runId, baselineMessageCount: 0, association: 'full_prompt', observedAt: receipt().observedAt };
    expect(normalizeTasks([incoming], 'OFFLINE-project').data[0].runtime?.chatReadback).toMatchObject(incoming.runtime!.chatReadback);
  });

  it('非法轮次身份／合同／时间不被修剪、补造或升级为有效凭据，原正文和提交记录保留', (): void => {
    const changes: Record<string, unknown>[] = [
      { runId: 'OFFLINE-other-run' }, { observedAt: 'invalid' }, { baselineMessageCount: -1 }, { baselineMessageCount: 0.5 },
      { association: 'unverified' }, { userTurnId: 'two ids' }, { userMessageId: 'x'.repeat(257) }, { assistantTurnId: 12 },
      { requestId: undefined }, { targetIds: ['OFFLINE-target', 'OFFLINE-target'] }, { targetIds: [12] },
      { association: 'recorded_turn', userTurnId: undefined, userMessageId: undefined },
    ];
    for (const change of changes) {
      const incoming = originalTask(); incoming.runtime!.chatReadback = { ...receipt(), ...change } as TaskRunSnapshot['chatReadback'];
      incoming.runtime!.chatResponse = { text: 'OFFLINE 原回复完整保留', capturedAt: receipt().observedAt };
      const normalized = normalizeTasks([incoming], 'OFFLINE-project').data[0];
      expect(normalized.runtime?.chatReadback).toBeUndefined(); expect(normalized.runtime?.submittedAt).toBe(incoming.runtime!.submittedAt);
      expect(normalized.runtime?.chatResponse).toEqual(incoming.runtime!.chatResponse);
    }
  });

  it('归一化仅保留白名单元数据，不把未知字段当正文或凭据，歧义原文不截断', (): void => {
    const incoming = originalTask();
    const rawText = 'OFFLINE 待核对原文\n' + '字'.repeat(120_000);
    incoming.runtime!.chatReadback = { ...receipt(), cookie: 'OFFLINE-unknown-secret' } as TaskRunSnapshot['chatReadback'];
    incoming.runtime!.chatReadbackReview = { runId: receipt().runId, checkedAt: receipt().observedAt, reason: 'reply_identity_mismatch', token: 'OFFLINE-unknown-secret',
      candidates: [{ messageIndex: 1, rawText, turnId: 'OFFLINE-original', messageId: 'OFFLINE-reply', secret: 'OFFLINE-unknown-secret' }] } as unknown as TaskRunSnapshot['chatReadbackReview'];
    const normalized = normalizeTasks([incoming], 'OFFLINE-project').data[0];
    expect(normalized.runtime?.chatReadbackReview?.candidates[0].rawText).toBe(rawText);
    expect(JSON.stringify(normalized.runtime)).not.toContain('OFFLINE-unknown-secret');
    expect(normalized.runtime?.chatResponse).toBeUndefined();
  });

  it('refuses old run evidence and never converts an unsent task into a recovered submission', (): void => {
    for (const changed of ['different-run', 'unsent'] as const) {
      const task = originalTask(); if (changed === 'unsent') delete task.runtime!.submittedAt;
      let stored = [task];
      const store = { read: (): Task[] => structuredClone(stored), replace: (tasks: Task[]): boolean => { stored = structuredClone(tasks); return true; } };
      const service = new TaskService({ store, defaultProjectId: (): string => 'OFFLINE-project' });
      const before = JSON.stringify(stored);
      expect(service.updateRuntime({ taskId: task.id, runtime: { chatReadback: { ...receipt(), runId: changed === 'different-run' ? 'OFFLINE-other-run' : receipt().runId } } }).success).toBe(false);
      expect(JSON.stringify(stored)).toBe(before);
    }
  });

  it('reports failed receipt readback instead of claiming the original turn has been saved', (): void => {
    let stored = [originalTask()];
    const service = new TaskService({ store: { read: (): Task[] => structuredClone(stored), replace: (tasks: Task[]): boolean => { stored = structuredClone(tasks); delete stored[0].runtime!.chatReadback; return true; } }, defaultProjectId: (): string => 'OFFLINE-project' });
    const result = service.updateRuntime({ taskId: stored[0].id, runtime: { chatReadback: receipt() } });
    expect(result.success).toBe(false); if (!result.success) expect(result.error).toContain('回读不一致');
    expect(stored[0].runtime?.submittedAt).toBe(originalTask().runtime?.submittedAt); expect(stored[0].runtime?.chatResponse).toBeUndefined();
  });
});
