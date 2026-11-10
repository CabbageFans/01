/** 媒体原消息耐久定位：只验证离线台账，不访问真实账号或平台。 */
import { describe, expect, it } from 'vitest';
import type { Task, TaskRunSnapshot } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';
import { requiresSubmissionReconciliation } from '../../src/utils/realSendStateMachine';

const submittedAt = '2026-11-03T14:58:14.019Z';
const observedAt = '2026-11-03T14:58:16.019Z';
const url = 'https://www.doubao.com/chat/OFFLINE-private-conversation';
type Receipt = NonNullable<TaskRunSnapshot['mediaSubmissionReceipt']>;

function task(mode: Task['mode'] = 'image'): Task {
  return { id: 'OFFLINE-media', projectId: 'OFFLINE-project', assignedAccountId: 'OFFLINE-account', mode, prompt: 'OFFLINE完整原图片请求',
    status: 'paused', executionIntent: 'armed', result: null, outputs: [], createdAt: submittedAt, updatedAt: submittedAt,
    runtime: { runId: 'OFFLINE-run', attempt: 1, stage: 'paused', message: 'OFFLINE保留原提交', startedAt: submittedAt,
      stageStartedAt: submittedAt, lastHeartbeatAt: submittedAt, submittedAt, input: { mode, prompt: 'OFFLINE完整原图片请求', attachments: [] } } };
}

function receipt(patch: Partial<Receipt> = {}): Receipt {
  return { schemaVersion: 1, source: 'published_message', runId: 'OFFLINE-run', accountId: 'OFFLINE-account', submittedAt,
    conversationUrl: url, userMessageId: 'OFFLINE-private-message', userTurnId: 'OFFLINE-private-turn', observedAt, ...patch };
}

function fixture(initial: Task, drift?: (value: Task) => void): { service: TaskService; read: () => Task; writes: () => number } {
  let stored = normalizeTasks([initial], 'OFFLINE-project', observedAt).data;
  let count = 0;
  const store = {
    read: (): Task[] => structuredClone(stored),
    replace: (tasks: Task[]): boolean => {
      stored = normalizeTasks(JSON.parse(JSON.stringify(tasks)) as unknown, 'OFFLINE-project', observedAt).data;
      count++;
      drift?.(stored[0]);
      return true;
    },
  };
  return { service: new TaskService({ store, defaultProjectId: (): string => 'OFFLINE-project', now: (): string => observedAt }),
    read: (): Task => structuredClone(stored[0]), writes: (): number => count };
}

describe('媒体原消息耐久收据', (): void => {
  it.each(['image', 'video'] as const)('%s原消息定位跨服务重开保留，不要求地址栏URL或产物先就绪', (mode): void => {
    const original = task(mode); const test = fixture(original);
    const saved = test.service.updateRuntime({ taskId: original.id, expectedRunId: original.runtime!.runId, runtime: { mediaSubmissionReceipt: receipt() } });
    expect(saved.success).toBe(true);
    const restored = fixture(test.read()).read();
    expect(restored.runtime?.mediaSubmissionReceipt).toEqual(receipt());
    expect(restored.runtime?.conversationUrl).toBeUndefined();
    expect(restored.runtime?.submittedAt).toBe(submittedAt); expect(restored.runtime?.input).toEqual(original.runtime?.input);
    expect(restored.status).toBe('paused'); expect(restored.outputs).toEqual([]);
  });

  it.each(['message', 'turn'] as const)('允许只保留实际取得的%s身份，不补造另一种ID', (kind): void => {
    const incoming = task();
    incoming.runtime!.mediaSubmissionReceipt = receipt(kind === 'message' ? { userTurnId: undefined } : { userMessageId: undefined });
    const normalized = normalizeTasks([incoming], 'OFFLINE-project', observedAt).data[0];
    expect(normalized.runtime?.mediaSubmissionReceipt).toEqual(incoming.runtime?.mediaSubmissionReceipt);
  });

  it.each([
    { runId: 'OFFLINE-other-run' }, { accountId: 'OFFLINE-other-account' }, { submittedAt: observedAt },
    { observedAt: 'invalid' }, { observedAt: '2026-11-03T14:58:13.019Z' }, { source: 'network_started' },
    { userMessageId: undefined, userTurnId: undefined }, { userMessageId: 'two ids' }, { userTurnId: 'x'.repeat(257) },
    { conversationUrl: 'https://www.doubao.com/chat/' }, { conversationUrl: 'https://www.doubao.com/chat/local_OFFLINE' },
    { conversationUrl: 'https://evil.invalid/chat/OFFLINE' }, { conversationUrl: url + '?from=list' },
  ])('错误原消息身份不写入且历史归一化不升级：%j', (patch: object): void => {
    const original = task(); const invalid = { ...receipt(), ...patch } as Receipt; const test = fixture(original);
    expect(test.service.updateRuntime({ taskId: original.id, expectedRunId: original.runtime!.runId, status: 'generating', runtime: { mediaSubmissionReceipt: invalid } }).success).toBe(false);
    expect(test.writes()).toBe(0); expect(test.read().status).toBe('paused');
    original.runtime!.mediaSubmissionReceipt = invalid;
    const normalized = normalizeTasks([original], 'OFFLINE-project', observedAt).data[0];
    expect(normalized.runtime?.mediaSubmissionReceipt).toBeUndefined(); expect(normalized.runtime?.submittedAt).toBe(submittedAt);
    expect(normalized.runtime?.input).toEqual(task().runtime?.input);
  });

  it.each(['chat', 'music'] as const)('%s任务不能保存媒体原消息收据', (mode): void => {
    const original = task(mode); const test = fixture(original);
    expect(test.service.updateRuntime({ taskId: original.id, expectedRunId: original.runtime!.runId, runtime: { mediaSubmissionReceipt: receipt() } }).success).toBe(false);
    expect(test.writes()).toBe(0);
    original.runtime!.mediaSubmissionReceipt = receipt();
    expect(normalizeTasks([original], 'OFFLINE-project', observedAt).data[0].runtime?.mediaSubmissionReceipt).toBeUndefined();
  });

  it('尚未记录原提交时，不能把补造submittedAt和收据一次性写入', (): void => {
    const original = task(); original.runtime!.submittedAt = undefined; const test = fixture(original);
    expect(test.service.updateRuntime({ taskId: original.id, expectedRunId: original.runtime!.runId, runtime: { submittedAt, mediaSubmissionReceipt: receipt() } }).success).toBe(false);
    expect(test.writes()).toBe(0);
  });

  it.each(['task-input', 'runtime-input', 'url', 'binding'] as const)('原%s冲突时不覆盖历史定位', (change): void => {
    const original = task();
    if (change === 'task-input') original.prompt += 'OFFLINE改稿';
    if (change === 'url') original.runtime!.conversationUrl = url + '-other';
    if (change === 'binding') original.runtime!.acceptanceObservation = {
      schemaVersion: 1, accountId: 'OFFLINE-account', runId: 'OFFLINE-run', conversationUrl: url + '-other', acceptedAt: observedAt,
      evidence: { kind: 'prompt_published' }, cursor: { messageCount: 1, pollCount: 0 }, expectedArtifact: { kind: 'image', runId: 'OFFLINE-run' },
      lease: { ownerId: 'OFFLINE-owner', acquiredAt: observedAt, expiresAt: observedAt, lastHeartbeatAt: observedAt }, outcome: 'observing',
    };
    const test = fixture(original);
    expect(test.service.updateRuntime({ taskId: original.id, expectedRunId: original.runtime!.runId, runtime: { mediaSubmissionReceipt: receipt(),
      ...(change === 'runtime-input' ? { input: { ...original.runtime!.input, prompt: 'OFFLINE改写运行快照' } } : {}) } }).success).toBe(false);
    expect(test.writes()).toBe(0);
  });

  it('同run后续patch不能让已保存收据失配；新run不能覆盖原提交', (): void => {
    const original = task(); original.runtime!.mediaSubmissionReceipt = receipt(); const test = fixture(original);
    expect(test.service.updateRuntime({ taskId: original.id, expectedRunId: original.runtime!.runId, runtime: { submittedAt: observedAt } }).success).toBe(false);
    expect(test.service.updateRuntime({ taskId: original.id, expectedRunId: original.runtime!.runId, runtime: { mediaSubmissionReceipt: undefined } }).success).toBe(false);
    expect(test.service.updateRuntime({ taskId: original.id, expectedRunId: original.runtime!.runId, runtime: { mediaSubmissionReceipt: receipt({ userMessageId: 'OFFLINE-later-message' }) } }).success).toBe(false);
    expect(test.writes()).toBe(0);
    expect(test.service.updateRuntime({ taskId: original.id, expectedRunId: original.runtime!.runId, runtime: { runId: 'OFFLINE-new-run', attempt: 2, stage: 'preparing_account',
      message: 'OFFLINE新运行', startedAt: observedAt, stageStartedAt: observedAt, lastHeartbeatAt: observedAt, input: original.runtime!.input } }).success).toBe(false);
    expect(test.read().runtime?.mediaSubmissionReceipt).toEqual(receipt()); expect(test.read().runtime?.submittedAt).toBe(submittedAt);
  });

  it('新run不能显式携带旧收据，写后收据身份漂移返回权威失败', (): void => {
    const original = task(); const test = fixture(original);
    expect(test.service.updateRuntime({ taskId: original.id, expectedRunId: original.runtime!.runId, runtime: { runId: 'OFFLINE-new-run', mediaSubmissionReceipt: receipt() } }).success).toBe(false);
    expect(test.writes()).toBe(0);
    const drifting = fixture(original, (value: Task): void => { value.runtime!.mediaSubmissionReceipt!.userMessageId = 'OFFLINE-other-message'; });
    const saved = drifting.service.updateRuntime({ taskId: original.id, expectedRunId: original.runtime!.runId, runtime: { mediaSubmissionReceipt: receipt() } });
    expect(saved).toMatchObject({ success: false, error: '媒体原消息证据写入后回读不一致，禁止重新发送',
      task: { runtime: { mediaSubmissionReceipt: { userMessageId: 'OFFLINE-other-message' } } } });
  });

  it('归一化白名单移除未知正文/凭据；诊断仅保留脱敏定位和消息ID计数', (): void => {
    const original = task(); original.runtime!.conversationUrl = url;
    original.runtime!.mediaSubmissionReceipt = { ...receipt(), cookie: 'OFFLINE-private-cookie', text: 'OFFLINE-private-raw-text' } as Receipt;
    const test = fixture(original); expect(test.read().runtime?.mediaSubmissionReceipt).toEqual(receipt());
    const diagnostic = test.service.buildTaskDiagnostics();
    expect(diagnostic.success && diagnostic.data[0].runtime?.mediaSubmissionReceipt).toMatchObject({
      conversationUrl: '[已脱敏]', messageIdentityCount: 2, source: 'published_message',
    });
    const serialized = JSON.stringify(diagnostic);
    for (const secret of [url, 'OFFLINE-private-message', 'OFFLINE-private-turn', 'OFFLINE-private-cookie', 'OFFLINE-private-raw-text']) expect(serialized).not.toContain(secret);
  });

  it('只有耐久定位而没有受理观察的重启任务收束暂停，保留收据供原结果只读恢复', (): void => {
    const original = task(); original.status = 'manual_submission_observing'; original.runtime!.stage = 'manual_submission_observing';
    original.runtime!.mediaSubmissionReceipt = receipt(); original.lock = { ownerId: 'OFFLINE-old-owner', acquiredAt: submittedAt, expiresAt: observedAt };
    const test = fixture(original);
    expect(test.service.recoverInterruptedTasks()).toEqual({ success: true, data: { recoveredTasks: 1, clearedLocks: 1 } });
    expect(test.read()).toMatchObject({ status: 'paused', errorInfo: { code: 'submission_uncertain' }, runtime: { runId: 'OFFLINE-run', submittedAt,
      mediaSubmissionReceipt: receipt(), input: original.runtime!.input } });
    expect(test.service.retry(original.id).success).toBe(false);
    expect(test.service.updateRuntime({ taskId: original.id, expectedRunId: original.runtime!.runId, status: 'manual_submission_observing', runtime: { stage: 'manual_submission_observing',
      conversationUrl: receipt().conversationUrl, mediaSubmissionReceipt: receipt() } }).success).toBe(true);
    expect(test.read().runtime?.mediaSubmissionReceipt).toEqual(receipt());
  });

  it('重启收束的提交不明错误在渲染进程仍保持只读核对入口，即使旧提交快照缺失', (): void => {
    const original = task(); original.runtime!.submittedAt = undefined; original.status = 'manual_submission_observing';
    const test = fixture(original); test.service.recoverInterruptedTasks();
    expect(requiresSubmissionReconciliation(test.read())).toBe(true);
    expect(test.service.retry(original.id).success).toBe(false);
  });

  it('精确旧发送前文案且没有任何提交证据时，Core与Renderer均允许显式接续原准备任务', (): void => {
    const original = task(); original.runtime!.submittedAt = undefined;
    original.errorInfo = { code: 'submission_uncertain', message: '最终全文或段落回读不一致，未提交', recoverable: true, detectedAt: observedAt };
    const test = fixture(original);
    expect(requiresSubmissionReconciliation(test.read())).toBe(false);
    expect(test.service.retry(original.id, 'hold').success).toBe(true);
    expect(test.read()).toMatchObject({ id: original.id, status: 'queued', executionIntent: 'hold' });
    expect(test.read().runtime?.submittedAt).toBeUndefined();
  });

  it.each(['最终全文或段落回读不一致，未提交；请重试', '最终全文或段落回读不一致，未提交 ', ' 最终全文或段落回读不一致，未提交',
    '程序重启，原结果检查已中断，请继续只读核对原会话；未重新发送', 'TEST 未知提交不明错误'])('近似或未知文案仍保护原运行：%s', (message): void => {
    const original = task(); original.runtime!.submittedAt = undefined;
    original.errorInfo = { code: 'submission_uncertain', message, recoverable: true, detectedAt: observedAt };
    const test = fixture(original);
    expect(requiresSubmissionReconciliation(test.read())).toBe(true); expect(test.service.retry(original.id, 'hold').success).toBe(false);
    expect(test.writes()).toBe(0); expect(test.read().status).toBe('paused');
  });

  it.each(['submittedAt', 'acceptanceObservation', 'mediaSubmissionReceipt', 'chatResponse', 'chatReadback', 'chatReadbackReview',
    'manualObservation', 'outputs', 'artifacts'] as const)('精确旧发送前文案也不能覆盖已有%s事实，Core与Renderer一致拒绝', (evidence): void => {
    const original = task(); original.runtime!.submittedAt = undefined;
    original.errorInfo = { code: 'submission_uncertain', message: '最终全文或段落回读不一致，未提交', recoverable: true, detectedAt: observedAt };
    if (evidence === 'outputs') original.outputs = ['https://media.example/TEST-existing.png'];
    else if (evidence === 'artifacts') original.artifacts = [{ id: 'TEST-existing', kind: 'image', source: 'page', url: 'https://media.example/TEST-existing.png', runId: original.runtime!.runId, discoveredAt: observedAt }];
    else Object.assign(original.runtime!, { [evidence]: evidence === 'submittedAt' ? submittedAt : {} });
    let saved = structuredClone(original); let writes = 0;
    const service = new TaskService({ defaultProjectId: (): string => 'OFFLINE-project', store: {
      read: (): Task[] => [structuredClone(saved)], replace: (values: Task[]): boolean => { saved = structuredClone(values[0]); writes++; return true; },
    } });
    expect(requiresSubmissionReconciliation(original)).toBe(true); expect(service.retry(original.id, 'hold').success).toBe(false);
    expect(writes).toBe(0); expect(saved).toEqual(original);
  });
});
