import { describe, expect, it, vi } from 'vitest';
import type { Task, TaskResubmitUncertainParams } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { requiresSubmissionReconciliation } from '../../src/utils/realSendStateMachine';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';

const startedAt = '2026-10-31T01:00:00.000Z';
const submittedAt = '2026-10-31T01:01:00.000Z';
const authorizedAt = '2026-10-31T02:00:00.000Z';
function original(id: string = 'TEST-source'): Task {
  const prompt = 'TEST 第一段。\n\nTEST 第二段。';
  return { id, prompt, assignedAccountId: 'TEST-account', mode: 'image', projectId: 'TEST-studio', source: 'workflow', batchId: 'TEST-batch',
    status: 'paused', executionIntent: 'armed', petstory: { projectId: 'TEST-story', stepId: 'TEST-step' }, promptReadback: 'exact',
    attachments: ['TEST-original-image.png'], dependsOnTaskIds: ['TEST-dependency'], dependencyPolicy: 'all_done', result: 'TEST 提交受理状态不明', outputs: [], artifacts: [],
    errorInfo: { code: 'submission_uncertain', message: 'TEST 原会话待核对', detectedAt: submittedAt, recoverable: true },
    runtime: { runId: `TEST-run-${id}`, attempt: 3, stage: 'paused', message: 'TEST 原意图保留', startedAt, stageStartedAt: submittedAt,
      lastHeartbeatAt: submittedAt, submittedAt, conversationUrl: 'https://www.doubao.com/chat/TEST-original',
      input: { prompt, mode: 'image', attachments: ['TEST-original-image.png'], promptReadback: 'exact', petstory: { projectId: 'TEST-story', stepId: 'TEST-step' } } },
    runHistory: [{ runId: `TEST-run-${id}`, attempt: 3, startedAt, finishedAt: submittedAt, outcome: 'paused' }], createdAt: startedAt, updatedAt: submittedAt };
}
function request(task: Task, authorizationId: string = 'TEST-authorization'): TaskResubmitUncertainParams {
  return { taskId: task.id, runId: task.runtime!.runId, submittedAt: task.runtime!.submittedAt!, authorizationId, acceptDuplicateRisk: true };
}
function fixture(initial: Task[]): { service: TaskService; stored: () => Task[]; replace: ReturnType<typeof vi.fn>; setStored: (tasks: Task[]) => void; ids: ReturnType<typeof vi.fn> } {
  let tasks = structuredClone(initial); let next = 0;
  const replace = vi.fn((value: Task[]): boolean => { tasks = structuredClone(value); return true; });
  const ids = vi.fn((): string => `TEST-replacement-${++next}`);
  const service = new TaskService({ store: { read: (): Task[] => structuredClone(tasks), replace }, defaultProjectId: (): string => 'TEST-default',
    id: ids, now: (): string => authorizedAt, nowMs: (): number => Date.parse(authorizedAt) });
  return { service, stored: (): Task[] => structuredClone(tasks), replace, setStored: (value: Task[]): void => { tasks = structuredClone(value); }, ids };
}

describe('显式授权未知提交只建立关联 hold 任务', (): void => {
  it('复制原运行输入，保留原意图、会话、状态与历史，替代任务没有发送权限', (): void => {
    const source = original(); const state = fixture([source]); const result = state.service.resubmitUncertain(request(source));
    expect(result.success).toBe(true); if (!result.success) return;
    const savedSource = state.stored()[0]; const replacement = result.data;
    expect(savedSource).toEqual({ ...source, updatedAt: authorizedAt, resubmittedAs: [{ taskId: replacement.id, runId: source.runtime!.runId,
      submittedAt, authorizationId: 'TEST-authorization', authorizedAt }] });
    expect(replacement).toMatchObject({ prompt: source.runtime!.input.prompt, mode: 'image', assignedAccountId: source.assignedAccountId,
      projectId: source.projectId, petstory: source.petstory, promptReadback: 'exact', attachments: source.runtime!.input.attachments,
      executionIntent: 'hold', status: 'queued', result: null, outputs: [], artifacts: [], runHistory: [],
      resubmissionOf: { taskId: source.id, runId: source.runtime!.runId, submittedAt, authorizationId: 'TEST-authorization', authorizedAt } });
    expect(replacement.runtime).toBeUndefined(); expect(replacement.errorInfo).toBeUndefined(); expect(replacement.lock).toBeUndefined();
    expect(replacement.dependsOnTaskIds).toEqual(source.dependsOnTaskIds); expect(state.replace).toHaveBeenCalledOnce();
  });

  it('以不可变原输入为准，不复制后来编辑过的正文、附件或配置', (): void => {
    const source = original(); source.prompt = 'TEST 后改正文'; source.attachments = ['TEST-edited.png']; source.mode = 'video';
    source.runtime!.input = { ...source.runtime!.input, mode: 'video', videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' }, audioAttachment: 'TEST-source.wav' };
    source.videoConfig = { model: 'seedance-2.5', duration: '10s', aspectRatio: '16:9' };
    const state = fixture([source]); const result = state.service.resubmitUncertain(request(source)); expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ prompt: source.runtime!.input.prompt, attachments: source.runtime!.input.attachments,
      mode: source.runtime!.input.mode, videoConfig: source.runtime!.input.videoConfig, audioAttachment: source.runtime!.input.audioAttachment });
    expect(state.stored()[0].runtime).toEqual(source.runtime); expect(state.stored()[0].prompt).toBe(source.prompt);
  });

  it.each(['paused', 'fail', 'cancelled', 'waiting_verification', 'waiting_generation_confirmation'] as const)('%s 的未知提交可显式建立 hold，但不会继续旧运行', (status): void => {
    const source = original(); source.status = status; source.errorInfo!.code = 'unknown'; const state = fixture([source]);
    const result = state.service.resubmitUncertain(request(source)); expect(result.success).toBe(true);
    if (result.success) expect(result.data.executionIntent).toBe('hold');
    expect(state.stored()[0].status).toBe(status.startsWith('waiting_') ? 'paused' : status);
    expect(state.stored()[0].runtime).toEqual(source.runtime); expect(state.stored()[0].errorInfo).toEqual(source.errorInfo);
  });

  it('同一授权重复调用与服务重建都返回同一任务，原结果迟到也不新增', (): void => {
    const source = original(); const state = fixture([source]); const first = state.service.resubmitUncertain(request(source));
    expect(first.success).toBe(true); if (!first.success) return;
    const once = state.stored();
    expect(state.service.resubmitUncertain(request(source))).toEqual(first); expect(state.replace).toHaveBeenCalledOnce(); expect(state.ids).toHaveBeenCalledOnce();
    once[0].status = 'done'; once[0].outputs = ['https://example.test/TEST-late.png']; once[0].artifacts = [{ id: 'TEST-late', kind: 'image', source: 'page',
      url: once[0].outputs[0], runId: source.runtime!.runId, conversationUrl: source.runtime!.conversationUrl, discoveredAt: authorizedAt }];
    const restarted = fixture(once); expect(restarted.service.resubmitUncertain(request(source))).toEqual(first);
    expect(restarted.stored()[0].outputs).toEqual(once[0].outputs); expect(restarted.stored()[1].outputs).toEqual([]); expect(restarted.ids).not.toHaveBeenCalled();
  });

  it('同一原运行换授权 ID 仍返回同一替代任务，并记下第二个 ID 防跨任务复用', (): void => {
    const source = original(); const other = original('TEST-other'); const state = fixture([source, other]);
    const first = state.service.resubmitUncertain(request(source)); const second = state.service.resubmitUncertain(request(source, 'TEST-second-authorization'));
    expect(first.success && second.success && second.data.id).toBe(first.success && first.data.id); expect(state.ids).toHaveBeenCalledOnce();
    expect(state.stored()[0].resubmittedAs?.map((record): string => record.authorizationId)).toEqual(['TEST-authorization', 'TEST-second-authorization']);
    const before = state.stored(); expect(state.service.resubmitUncertain(request(other, 'TEST-second-authorization')).success).toBe(false); expect(state.stored()).toEqual(before);
  });

  it.each(['taskId', 'runId', 'submittedAt'] as const)('同一授权 ID 的 %s 不能改绑', (field): void => {
    const source = original(); const state = fixture([source]); state.service.resubmitUncertain(request(source)); const before = state.stored();
    expect(state.service.resubmitUncertain({ ...request(source), [field]: 'TEST-foreign' }).success).toBe(false); expect(state.stored()).toEqual(before);
  });

  it.each(['runId', 'submittedAt'] as const)('未授权过的 foreign %s 不能创建替代任务', (field): void => {
    const source = original(); const state = fixture([source]);
    expect(state.service.resubmitUncertain({ ...request(source), [field]: 'TEST-foreign' }).success).toBe(false);
    expect(state.stored()).toEqual([source]); expect(state.ids).not.toHaveBeenCalled();
  });

  it('不存在的原任务或缺失原提交意图不能使用显式重发入口', (): void => {
    const source = original(); const params = request(source); const missing = fixture([]); expect(missing.service.resubmitUncertain(params).success).toBe(false);
    delete source.runtime!.submittedAt; const state = fixture([source]); expect(state.service.resubmitUncertain(params).success).toBe(false); expect(state.stored()).toEqual([source]);
  });

  it.each(['executing', 'generating', 'manual_submission_observing', 'queued', 'done'] as const)('不从 %s 创建未知重发任务', (status): void => {
    const source = original(); source.status = status; const state = fixture([source]);
    expect(state.service.resubmitUncertain(request(source)).success).toBe(false); expect(state.stored()).toEqual([source]);
  });

  it.each(['reply', 'outputs', 'artifacts', 'accepted-observing', 'accepted-completed', 'manual-observing', 'manual-completed', 'live-lock', 'chat-guard'] as const)('已有 %s 证据不创建新的发送机会', (kind): void => {
    const source = original();
    if (kind === 'reply') source.runtime!.chatResponse = { text: 'TEST 已保存回复', capturedAt: submittedAt };
    if (kind === 'outputs') source.outputs = ['https://example.test/TEST-result.png'];
    if (kind === 'artifacts') source.artifacts = [{ id: 'TEST-artifact', url: 'https://example.test/TEST-result.png', kind: 'image', source: 'page', runId: source.runtime!.runId, discoveredAt: submittedAt }];
    if (kind.startsWith('accepted-')) source.runtime!.acceptanceObservation = { schemaVersion: 1, accountId: 'TEST-account', runId: source.runtime!.runId,
      conversationUrl: source.runtime!.conversationUrl!, acceptedAt: submittedAt, evidence: { kind: 'prompt_published' }, cursor: { messageCount: 1, pollCount: 0 },
      expectedArtifact: { kind: 'image', runId: source.runtime!.runId }, lease: { ownerId: 'TEST-observer', acquiredAt: submittedAt, lastHeartbeatAt: submittedAt, expiresAt: authorizedAt },
      outcome: kind === 'accepted-observing' ? 'observing' : 'completed' };
    if (kind.startsWith('manual-')) source.runtime!.manualObservation = { startedAt: submittedAt, expiresAt: authorizedAt, source: 'stored_conversation', outcome: kind === 'manual-observing' ? 'observing' : 'completed' };
    if (kind === 'live-lock') source.lock = { ownerId: 'TEST-live', acquiredAt: submittedAt, expiresAt: '2026-10-31T03:00:00.000Z' };
    if (kind === 'chat-guard') source.runtime!.chatAdjustmentGuard = { projectId: 'TEST-story', adjustmentId: 'TEST-adjustment', active: true };
    const state = fixture([source]); expect(state.service.resubmitUncertain(request(source)).success).toBe(false); expect(state.stored()).toEqual([source]);
  });

  it('手工核对仍不明的受理记录保留在原任务，不传给新任务', (): void => {
    const source = original(); source.runtime!.manualObservation = { startedAt: submittedAt, expiresAt: authorizedAt, source: 'stored_conversation', outcome: 'manual_review' };
    const state = fixture([source]); const result = state.service.resubmitUncertain(request(source)); expect(result.success).toBe(true);
    expect(state.stored()[0].runtime).toEqual(source.runtime); if (result.success) expect(result.data.runtime).toBeUndefined();
  });

  it.each([undefined, false])('缺少明确风险授权 %s 时不建立任务', (acceptDuplicateRisk): void => {
    const source = original(); const state = fixture([source]);
    expect(state.service.resubmitUncertain({ ...request(source), acceptDuplicateRisk } as TaskResubmitUncertainParams).success).toBe(false);
    expect(state.stored()).toEqual([source]); expect(state.replace).not.toHaveBeenCalled();
  });

  it('落盘失败时原任务与新任务同时保持原状；重试该授权不会重复已落盘任务', (): void => {
    const source = original(); const state = fixture([source]); state.replace.mockReturnValueOnce(false);
    expect(state.service.resubmitUncertain(request(source)).success).toBe(false); expect(state.stored()).toEqual([source]);
    const recovered = state.service.resubmitUncertain(request(source)); expect(recovered.success).toBe(true); expect(state.stored()).toHaveLength(2);
    expect(state.service.resubmitUncertain(request(source))).toEqual(recovered); expect(state.stored()).toHaveLength(2);
  });

  it('写盘已发生但返回异常时，同授权重试只恢复原关联结果', (): void => {
    const source = original(); const state = fixture([source]);
    state.replace.mockImplementationOnce((tasks: Task[]): boolean => { state.setStored(tasks); throw new Error('TEST write result uncertain'); });
    expect(state.service.resubmitUncertain(request(source)).success).toBe(false); const saved = state.stored(); expect(saved).toHaveLength(2);
    const recovered = state.service.resubmitUncertain(request(source)); expect(recovered.success && recovered.data.id).toBe(saved[1].id);
    expect(state.ids).toHaveBeenCalledOnce(); expect(state.stored()).toEqual(saved);
  });

  it('替代任务被删后原审计仍阻止重新创建，也不能拿新授权绕过', (): void => {
    const source = original(); const state = fixture([source]); state.service.resubmitUncertain(request(source)); state.setStored(state.stored().slice(0, 1));
    expect(state.service.resubmitUncertain(request(source)).success).toBe(false);
    expect(state.service.resubmitUncertain(request(source, 'TEST-another-authorization')).success).toBe(false); expect(state.stored()).toHaveLength(1); expect(state.ids).toHaveBeenCalledOnce();
  });

  it.each([
    { resubmittedAs: 'TEST-invalid-array' },
    { resubmittedAs: {} },
    { resubmittedAs: [null] },
    { resubmittedAs: [{ taskId: 'TEST-child', runId: 'TEST-run' }] },
    { resubmittedAs: [{ taskId: 'TEST-child', runId: 'TEST-run', submittedAt, authorizationId: 7, authorizedAt }] },
    { resubmissionOf: [] },
    { resubmissionOf: { taskId: 'TEST-other', runId: ' ', submittedAt, authorizationId: 'TEST-auth', authorizedAt } },
    { resubmissionOf: { taskId: 'TEST-other', runId: 'TEST-run', submittedAt, authorizationId: 'TEST-auth' } },
  ])('归一化保留不完整审计并在授权扫描前明确失败 %j', (metadata): void => {
    const source = original(); const corrupt = { ...original('TEST-unrelated'), ...metadata };
    const normalized = normalizeTasks([source, corrupt], 'TEST-studio', authorizedAt).data;
    for (const [key, value] of Object.entries(metadata)) expect((normalized[1] as unknown as Record<string, unknown>)[key]).toEqual(value);
    const state = fixture(normalized);
    expect(state.service.resubmitUncertain(request(source))).toEqual({ success: false, error: expect.stringContaining('不完整的重发审计') });
    expect(state.stored()).toEqual(normalized); expect(state.ids).not.toHaveBeenCalled(); expect(state.replace).not.toHaveBeenCalled();
  });

  it.each(['chat', 'image', 'video'] as const)('普通retry/edit/assign不能重置%s的未知错误提交', (mode): void => {
    const source = original(); source.mode = mode; source.runtime!.input.mode = mode; source.errorInfo!.code = 'unknown'; const state = fixture([source]);
    expect(requiresSubmissionReconciliation(source)).toBe(true); expect(state.service.retry(source.id).success).toBe(false);
    expect(state.service.update({ taskId: source.id, updates: { prompt: 'TEST 改文重发' } }).success).toBe(false);
    expect(state.service.assign({ taskId: source.id, accountId: 'TEST-other-account' }).success).toBe(false); expect(state.stored()).toEqual([source]);
  });
});
