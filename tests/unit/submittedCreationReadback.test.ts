import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreationReadbackResult } from '../../src/utils/chatReadback';
import {
  SubmittedCreationReadbackContextError,
  SubmittedCreationReadbackTimeoutError,
  waitForSubmittedCreationReadback,
  type SubmittedCreationReadbackProgress,
  type SubmittedCreationReadbackSample,
} from '../../src/utils/submittedCreationReadback';

const originalUrl = 'https://www.doubao.com/chat/TEST-original';
const immediateWait = async (): Promise<void> => undefined;
const ensureCurrent = (): void => undefined;

function evidence(patch: Partial<CreationReadbackResult> = {}): CreationReadbackResult {
  return { generationStarted: false, inputCleared: true, messageCount: 0, promptPublished: false,
    replyText: '', replyRawText: '', generating: false, candidates: [], confirmationPublished: false, ...patch };
}

function sample(url: string = originalUrl, patch: Partial<CreationReadbackResult> = {}): SubmittedCreationReadbackSample {
  return { url, evidence: evidence(patch) };
}

afterEach((): void => { vi.useRealTimers(); });

describe('原次创作提交的有界只读确认', (): void => {
  it('等待临时路由、具体会话和原全文依次就绪，不把生成状态或图片代替全文身份', async (): Promise<void> => {
    const samples = [sample('https://www.doubao.com/chat/local_TEST', { promptPublished: true }),
      sample(originalUrl, { generationStarted: true, generating: true, reason: 'prompt_unmatched' }),
      sample(originalUrl + '?from=TEST', { promptPublished: true })];
    const read = vi.fn(async (): Promise<SubmittedCreationReadbackSample> => samples.shift()!);
    const progress: SubmittedCreationReadbackProgress[] = [];
    const result = await waitForSubmittedCreationReadback({ read, ensureCurrent, wait: immediateWait,
      onProgress: (value: SubmittedCreationReadbackProgress): void => { progress.push(value); } });
    expect(result.url).toBe(originalUrl);
    expect(result.evidence.promptPublished).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
    expect(progress.map((value: SubmittedCreationReadbackProgress): string => value.reason)).toEqual(['conversation_url_missing', 'prompt_unmatched']);
  });

  it('恢复允许保留用户草稿，首次发送仍等同一原消息的编辑器清空证据', async (): Promise<void> => {
    const notCleared = sample(originalUrl, { promptPublished: true, inputCleared: false });
    const recoveryRead = vi.fn(async (): Promise<SubmittedCreationReadbackSample> => notCleared);
    expect((await waitForSubmittedCreationReadback({ read: recoveryRead, ensureCurrent, wait: immediateWait })).evidence.inputCleared).toBe(false);
    const samples = [notCleared, sample(originalUrl, { promptPublished: true })];
    const sendingRead = vi.fn(async (): Promise<SubmittedCreationReadbackSample> => samples.shift()!);
    const progress = vi.fn();
    await waitForSubmittedCreationReadback({ read: sendingRead, ensureCurrent, wait: immediateWait, requireInputCleared: true, onProgress: progress });
    expect(sendingRead).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ reason: 'input_not_cleared' }));
  });

  it('已钉住具体会话后拒绝另一会话的完整消息，不把后来的结果绑定原运行', async (): Promise<void> => {
    const samples = [sample(), sample('https://www.doubao.com/chat/', { promptPublished: true }),
      sample('https://www.doubao.com/chat/TEST-other', { promptPublished: true })];
    const read = vi.fn(async (): Promise<SubmittedCreationReadbackSample> => samples.shift()!);
    await expect(waitForSubmittedCreationReadback({ read, ensureCurrent, wait: immediateWait }))
      .rejects.toMatchObject({ name: 'SubmittedCreationReadbackContextError', reason: 'conversation_changed' });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('证据明确指示身份变化时立即终止，而非等到下次重试', async (): Promise<void> => {
    const read = vi.fn(async (): Promise<SubmittedCreationReadbackSample> => sample(originalUrl, { reason: 'context_changed' }));
    await expect(waitForSubmittedCreationReadback({ read, ensureCurrent, wait: immediateWait })).rejects.toBeInstanceOf(SubmittedCreationReadbackContextError);
    expect(read).toHaveBeenCalledOnce();
  });

  it('读取过程中原运行变化后拒绝迟到的完整消息，保留原异常', async (): Promise<void> => {
    let current = true;
    const changed = new Error('TEST original run changed');
    const check = (): void => { if (!current) throw changed; };
    const read = vi.fn(async (): Promise<SubmittedCreationReadbackSample> => { current = false; return sample(originalUrl, { promptPublished: true }); });
    await expect(waitForSubmittedCreationReadback({ read, ensureCurrent: check, wait: immediateWait })).rejects.toBe(changed);
    expect(read).toHaveBeenCalledOnce();
  });

  it('保留读取失败和绑定冲突，不把异常吞掉后继续猜测', async (): Promise<void> => {
    const conflict = new Error('TEST binding conflict');
    const read = vi.fn(async (): Promise<SubmittedCreationReadbackSample> => { throw conflict; });
    await expect(waitForSubmittedCreationReadback({ read, ensureCurrent, wait: immediateWait })).rejects.toBe(conflict);
    expect(read).toHaveBeenCalledOnce();
  });

  it('默认60秒截止，并以脱敏最后原因结束唯一全文尚未出现的等待', async (): Promise<void> => {
    let clock = 0;
    const progress: SubmittedCreationReadbackProgress[] = [];
    const read = async (): Promise<SubmittedCreationReadbackSample> => sample(originalUrl, { reason: 'user_ambiguous', replyRawText: 'TEST private reply' });
    const pending = waitForSubmittedCreationReadback({ read, ensureCurrent, now: (): number => clock,
      wait: async (milliseconds: number): Promise<void> => { clock += milliseconds; },
      onProgress: (value: SubmittedCreationReadbackProgress): void => { progress.push(value); } });
    await expect(pending).rejects.toMatchObject({ name: 'SubmittedCreationReadbackTimeoutError', reason: 'user_ambiguous' });
    expect(clock).toBe(60_000);
    expect(JSON.stringify(progress)).not.toContain('private reply');
    expect(JSON.stringify(progress)).not.toContain(originalUrl);
  });

  it('DOM读取挂起也受宿主截止约束，超时后迟到结果不触发进度或再次读取', async (): Promise<void> => {
    vi.useFakeTimers();
    let release!: (value: SubmittedCreationReadbackSample) => void;
    const read = vi.fn((): Promise<SubmittedCreationReadbackSample> => new Promise((resolve: (value: SubmittedCreationReadbackSample) => void): void => { release = resolve; }));
    const progress = vi.fn();
    const pending = waitForSubmittedCreationReadback({ read, ensureCurrent, wait: immediateWait, timeoutMs: 1200, onProgress: progress });
    const rejected = expect(pending).rejects.toBeInstanceOf(SubmittedCreationReadbackTimeoutError);
    await vi.advanceTimersByTimeAsync(1200); await rejected;
    release(sample(originalUrl, { promptPublished: true })); await Promise.resolve();
    expect(read).toHaveBeenCalledOnce(); expect(progress).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('取消正在等待的DOM读取立即退出，迟到消息不改变结果且清理截止计时器', async (): Promise<void> => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let release!: (value: SubmittedCreationReadbackSample) => void;
    const read = vi.fn((): Promise<SubmittedCreationReadbackSample> => new Promise((resolve: (value: SubmittedCreationReadbackSample) => void): void => { release = resolve; }));
    const pending = waitForSubmittedCreationReadback({ read, ensureCurrent, wait: immediateWait, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    release(sample(originalUrl, { promptPublished: true })); await Promise.resolve();
    expect(read).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('取消已经发生时不再读取原页面', async (): Promise<void> => {
    const controller = new AbortController(); controller.abort();
    const read = vi.fn(async (): Promise<SubmittedCreationReadbackSample> => sample(originalUrl, { promptPublished: true }));
    await expect(waitForSubmittedCreationReadback({ read, ensureCurrent, wait: immediateWait, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });

  it('进度回调期间原运行变化后不再等待或读取', async (): Promise<void> => {
    let current = true;
    const read = vi.fn(async (): Promise<SubmittedCreationReadbackSample> => sample());
    const wait = vi.fn(immediateWait);
    await expect(waitForSubmittedCreationReadback({ read, wait,
      ensureCurrent: (): void => { if (!current) throw new Error('TEST stopped after progress'); },
      onProgress: (): void => { current = false; } })).rejects.toThrow('TEST stopped after progress');
    expect(read).toHaveBeenCalledOnce(); expect(wait).not.toHaveBeenCalled();
  });

  it('立即成功也释放宿主截止计时器', async (): Promise<void> => {
    vi.useFakeTimers();
    await waitForSubmittedCreationReadback({ read: async (): Promise<SubmittedCreationReadbackSample> => sample(originalUrl, { promptPublished: true }), ensureCurrent, wait: immediateWait });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['conversation_url_missing', '尚未取得具体原会话'],
    ['prompt_not_published', '原请求全文尚未读到'],
    ['user_ambiguous', '存在多个请求，无法唯一匹配原请求'],
    ['input_not_cleared', '原输入区尚未清空'],
  ] as const)('超时以中文说明%s，诊断原因仍单独保留', (reason, explanation): void => {
    const error = new SubmittedCreationReadbackTimeoutError(reason);
    expect(error.message).toContain(explanation);
    expect(error.message).not.toContain(reason);
    expect(error.reason).toBe(reason);
  });

  it.each(['conversation_changed', 'context_changed'] as const)('上下文变化%s不向用户显示实现代码', (reason): void => {
    const error = new SubmittedCreationReadbackContextError(reason);
    expect(error.message).toContain('未重新发送');
    expect(error.message).not.toContain(reason);
    expect(error.reason).toBe(reason);
  });
});
