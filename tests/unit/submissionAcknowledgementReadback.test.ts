import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchSubmissionAttempt } from '../../src/automation/SubmissionCoordinator';
import { inspectCreationReadback } from '../../src/utils/chatReadback';
import { waitForConfirmedSubmission } from '../../src/utils/realSendStateMachine';
import { videoSubmissionHarness } from '../fixtures/videoSubmissionHarness';

/** 正式协调器、正式原消息判定与真实任务服务的组合恢复，不复制页面分支。 */
afterEach((): void => { vi.useRealTimers(); });
describe('激活ACK不等于平台受理', (): void => {
  it.each(['image', 'video'] as const)('%s ACK丢失但原消息已发布时只观察一次，保存同一run受理', async (mode): Promise<void> => {
    vi.useFakeTimers(); const fixture = videoSubmissionHarness(mode); let activations = 0;
    await dispatchSubmissionAttempt({ ...fixture, dispatch: async (safety) => { await safety.beforeDispatch?.(); activations++; return { kind: 'dispatch_unknown', reason: 'ack_lost' }; } });
    const read = vi.fn(async () => inspectCreationReadback({ editorPresent: true, editorText: '', generating: true, messages: [
      { role: 'user', text: 'fixture prompt', messageId: 'original-user' }, { role: 'assistant', text: '处理中', messageId: 'original-assistant' },
    ] }, 'fixture prompt', mode, 0));
    const evidence = await waitForConfirmedSubmission({ read, wait: async (): Promise<void> => undefined, onUnconfirmed: async (): Promise<void> => undefined, signal: fixture.controller.signal });
    expect(evidence?.promptPublished).toBe(true); await fixture.persist('accepted');
    expect(fixture.current().runtime?.submission).toMatchObject({ state: 'accepted', runId: 'fixture-run', operationId: 'fixture-operation' });
    expect(activations).toBe(1); expect(read).toHaveBeenCalledOnce(); expect(fixture.service.retry('fixture-task').success).toBe(false);
  });
  it('仅输入清空而无原消息证据时不能写成平台已受理', async (): Promise<void> => {
    const read = inspectCreationReadback({ editorPresent: true, editorText: '', generating: false, messages: [] }, 'fixture prompt', 'video', 0);
    expect(read.promptPublished).toBe(false);
  });
  it('素材授权等待和验证恢复保留原run，不新建发送尝试', async (): Promise<void> => {
    const fixture = videoSubmissionHarness(); await fixture.persist('dispatch_unknown');
    const runtime = fixture.current().runtime;
    expect(fixture.service.updateRuntime({ taskId: 'fixture-task', expectedRunId: 'fixture-run', status: 'waiting_verification', runtime: { stage: 'waiting_verification' } }).success).toBe(true);
    expect(fixture.current().runtime?.runId).toBe(runtime?.runId);
    expect(fixture.service.retry('fixture-task').success).toBe(false);
    expect(fixture.current().runtime?.submission?.operationId).toBe('fixture-operation');
  });
});
