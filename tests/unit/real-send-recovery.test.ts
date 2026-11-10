/**
 * DOUBAO-TASK-REAL-SEND-RECOVERY-01 专项测试（表驱动）。
 *
 * 覆盖（冻结验收包要求）：
 *  - startNewConversation 状态机：PAGE_NOT_READY / EDITOR_NOT_FOUND / EDITOR_NOT_FOCUSABLE /
 *    SESSION_NOT_EMPTY / READY；不猜测按钮（断言注入代码无任意 .click()）。
 *  - 提交回读分类：输入框清空不是成功证据；提示词进入会话区（promptPublished）才是。
 *  - 终态判定：历史消息/欢迎语/推荐内容不计为回复；无助手回复不得完成；
 *    基线后净增长 + 稳定终态（网络结束或连续稳定）才完成。
 *  - 发送纪律源码断言：每个 run 只允许一次点击；禁止 Enter、验证码及异常回退重发。
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  findSendButtonTarget,
  isExactPromptInComposer,
  normalizePromptForComposer,
  startNewConversation,
  submitPromptOnce,
  verifyPromptReadyForSubmission,
} from '../../src/utils/doubaoBridge';
import type { WebviewHandle, NativeMouseInputEvent } from '../../src/utils/doubaoBridge';
import {
  classifySubmissionReadback,
  canAttemptSubmission,
  computeTextGrowth,
  evaluateTerminal,
  matchesSubmissionConversation,
  requiresSubmissionReconciliation,
  updateStableStreak,
  TERMINAL_STABLE_THRESHOLD,
} from '../../src/utils/realSendStateMachine';
import type { SubmissionReadback, TerminalSample } from '../../src/utils/realSendStateMachine';
import { dispatchSubmissionAttempt } from '../../src/automation/SubmissionCoordinator';
import type { SubmissionDispatchSafety } from '../../src/utils/doubaoBridge';
import { createAcceptedObservationBinding } from '../../src/utils/acceptedObservation';
import { videoSubmissionHarness } from '../fixtures/videoSubmissionHarness';

// ==================== mock webview ====================

function createMockWebview(router: (code: string) => unknown): WebviewHandle & { calls: string[] } {
  const calls: string[] = [];
  const mock: WebviewHandle = {
    executeJavaScript: vi.fn(async (code: string): Promise<unknown> => {
      calls.push(code);
      return router(code);
    }),
    loadURL: vi.fn(),
    getURL: vi.fn(() => 'https://www.doubao.com/chat/'),
  };
  return { ...mock, calls };
}

/** waitForChatReady 的轮询代码特征。 */
function isReadyProbe(code: string): boolean {
  return code.includes("querySelectorAll('textarea')") && code.includes('contenteditable="true"');
}

/** startNewConversation 状态机代码特征（必须先于 ready 探针匹配）。 */
function isStateMachineProbe(code: string): boolean {
  return code.includes('var editor = null;');
}

function routeNewConversation(webview: WebviewHandle & { calls: string[] }, stateResult: unknown, ready = true): void {
  let timeOrigin = 1;
  (webview.loadURL as ReturnType<typeof vi.fn>).mockImplementation((url: string): void => {
    timeOrigin++;
    (webview.getURL as ReturnType<typeof vi.fn>).mockReturnValue(url);
  });
  const original = webview.executeJavaScript as ReturnType<typeof vi.fn>;
  original.mockImplementation(async (code: string): Promise<unknown> => {
    webview.calls.push(code);
    if (code.includes('timeOrigin: performance.timeOrigin')) return { href: webview.getURL(), timeOrigin, readyState: 'complete' };
    if (isStateMachineProbe(code)) return stateResult && typeof stateResult === 'object' ? { stabilityKey: 'OFFLINE-stable', ...stateResult } : stateResult;
    if (isReadyProbe(code)) return ready;
    return null;
  });
}

describe('CSV 多语言提示词全文守卫', () => {
  const c01Prompt = `5秒、9:16竖屏 TikTok 商品视频开场。图1定义画面中唯一的一名成年女性数字人。

正面中近景、固定机位、自然室内光。她清楚自然地说英文：
“Need a better scratch spot for your indoor cat?”

说完后保持自然目光约0.5秒。绝对不生成BGM。`;

  it('只折叠无语义空白，英文台词、弯引号与标点必须逐字保留', () => {
    const composerText = c01Prompt.replace(/\n+/g, ' ').replace('自然室内光。', '自然室内光。\u200b');
    expect(normalizePromptForComposer(composerText)).toBe(normalizePromptForComposer(c01Prompt));
    expect(isExactPromptInComposer(c01Prompt, composerText)).toBe(true);

    const truncatedBeforeDialogue = composerText.split('“Need')[0];
    const missingEnglish = composerText.replace('Need a better scratch spot for your indoor cat?', '');
    expect(isExactPromptInComposer(c01Prompt, truncatedBeforeDialogue)).toBe(false);
    expect(isExactPromptInComposer(c01Prompt, missingEnglish)).toBe(false);
  });

  it('发送前只接受可见编辑器中的完整提示词，截断内容 fail-closed', async () => {
    const complete = createMockWebview(() => true);
    const truncated = createMockWebview(() => false);

    expect(await verifyPromptReadyForSubmission(complete, c01Prompt)).toBe(true);
    expect(await verifyPromptReadyForSubmission(truncated, c01Prompt)).toBe(false);
    expect(complete.calls[0]).toContain('Need a better scratch spot for your indoor cat?');
  });
});

describe('P0-1 startNewConversation 状态机', () => {
  it('输入框不可用（waitForChatReady 超时）→ PAGE_NOT_READY fail-closed', async () => {
    const webview = createMockWebview(() => false);
    routeNewConversation(webview, { ok: false, reason: 'EDITOR_NOT_FOUND' }, false);
    const result = await startNewConversation(webview, 300);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('PAGE_NOT_READY');
  });

  it('页面无编辑器 → EDITOR_NOT_FOUND', async () => {
    const webview = createMockWebview(() => null);
    routeNewConversation(webview, { ok: false, reason: 'EDITOR_NOT_FOUND' });
    const result = await startNewConversation(webview);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EDITOR_NOT_FOUND');
  });

  it('编辑器不可聚焦 → EDITOR_NOT_FOCUSABLE', async () => {
    const webview = createMockWebview(() => null);
    routeNewConversation(webview, { ok: false, reason: 'EDITOR_NOT_FOCUSABLE' });
    const result = await startNewConversation(webview);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EDITOR_NOT_FOCUSABLE');
  });

  it('页面含已有用户内容 → SESSION_NOT_EMPTY 拒绝继续', async () => {
    const webview = createMockWebview(() => null);
    routeNewConversation(webview, { ok: true, reason: 'SESSION_NOT_EMPTY', focusable: true });
    const result = await startNewConversation(webview);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('SESSION_NOT_EMPTY');
  });

  it('空会话 + 输入框可聚焦 → ok=true；导航到官方新会话入口', async () => {
    const webview = createMockWebview(() => null);
    routeNewConversation(webview, { ok: true, reason: 'READY', focusable: true });
    const result = await startNewConversation(webview);
    expect(result.ok).toBe(true);
    expect(webview.calls.some((c) => c.includes('editor.focus()'))).toBe(true);
  });

  it('不猜测按钮：注入代码不含任意 .click() 调用', async () => {
    const webview = createMockWebview(() => null);
    routeNewConversation(webview, { ok: true, reason: 'READY', focusable: true });
    await startNewConversation(webview);
    for (const code of webview.calls) {
      expect(code).not.toMatch(/\.click\(\)/);
    }
  });

  it('Dola 账号保持在 dola.com/chat，绝不跨平台跳到豆包', async () => {
    const webview = createMockWebview(() => null);
    (webview.getURL as ReturnType<typeof vi.fn>).mockReturnValue('https://www.dola.com/chat');
    routeNewConversation(webview, { ok: true, reason: 'READY', focusable: true });
    const result = await startNewConversation(webview);
    expect(result.ok).toBe(true);
    expect(webview.loadURL).toHaveBeenCalledWith('https://www.dola.com/chat');
    expect(webview.loadURL).not.toHaveBeenCalledWith(expect.stringContaining('doubao.com'));
  });

  it('无法确认平台域名时直接 fail-closed，不猜测豆包入口', async () => {
    const webview = createMockWebview(() => null);
    (webview.getURL as ReturnType<typeof vi.fn>).mockReturnValue('about:blank');
    const result = await startNewConversation(webview);
    expect(result).toEqual({ ok: false, reason: 'PLATFORM_UNRECOGNIZED' });
    expect(webview.loadURL).not.toHaveBeenCalled();
  });
});

describe('P0-2 提交回读分类（输入框清空不是成功证据）', () => {
  const base: SubmissionReadback = {
    generationStarted: false,
    inputCleared: false,
    messageCount: 0,
    promptPublished: false,
  };

  it('表驱动：仅清空 / 仅生成信号 / 均无 → 不确认；生成+清空 或 发布+清空 → 确认', () => {
    const cases: Array<{ name: string; r: SubmissionReadback; expect: 'confirmed' | 'not-confirmed' }> = [
      { name: '输入框清空但无任何发布证据', r: { ...base, inputCleared: true }, expect: 'not-confirmed' },
      { name: '有生成信号但输入框未清空', r: { ...base, generationStarted: true }, expect: 'not-confirmed' },
      { name: '全无证据', r: { ...base }, expect: 'not-confirmed' },
      { name: '生成信号 + 输入框清空', r: { ...base, generationStarted: true, inputCleared: true }, expect: 'confirmed' },
      { name: '提示词已进入会话区 + 输入框清空（无网络信号）', r: { ...base, promptPublished: true, inputCleared: true }, expect: 'confirmed' },
    ];
    for (const c of cases) {
      expect(classifySubmissionReadback(c.r), c.name).toBe(c.expect);
    }
  });
});

describe('P0-2 单运行单次提交门禁', () => {
  it('表驱动：仅同一有效 run 且尚无 submittedAt 时允许提交', () => {
    const cases = [
      { name: '同一 run 未提交', expected: 'run-2', actual: 'run-2', submittedAt: undefined, allowed: true },
      { name: '同一 run 已提交', expected: 'run-2', actual: 'run-2', submittedAt: '2026-08-20T17:31:17.369Z', allowed: false },
      { name: '运行已被替换', expected: 'run-1', actual: 'run-2', submittedAt: undefined, allowed: false },
      { name: '运行快照缺失', expected: 'run-2', actual: undefined, submittedAt: undefined, allowed: false },
    ];
    for (const c of cases) {
      expect(canAttemptSubmission(c.expected, c.actual, c.submittedAt), c.name).toBe(c.allowed);
    }
  });
});

describe('P0-2 已提交任务只读核对门禁', () => {
  it('表驱动：submittedAt + 新旧不确定错误必须核对；普通暂停仍可重试', () => {
    const submittedAt = '2026-08-24T11:41:00.458Z';
    const cases = [
      { name: '新错误码', task: { status: 'paused', runtime: { submittedAt }, errorInfo: { code: 'submission_uncertain' } }, expected: true },
      { name: '旧 cancelled 文案', task: { status: 'paused', runtime: { submittedAt }, errorInfo: { code: 'cancelled', message: '发送按钮不可用或点击结果不确定' } }, expected: true },
      { name: '已受理观察即使状态异常也禁止重发', task: { status: 'fail', runtime: { acceptanceObservation: { outcome: 'observing' } } }, expected: true },
      { name: '无提交记录的普通暂停', task: { status: 'paused', errorInfo: { code: 'cancelled', message: '用户暂停' } }, expected: false },
      { name: '已完成任务', task: { status: 'done', runtime: { submittedAt }, errorInfo: { code: 'submission_uncertain' } }, expected: false },
    ];
    for (const item of cases) expect(requiresSubmissionReconciliation(item.task), item.name).toBe(item.expected);
  });

  it('所有模式的已提交停止任务均须核对，不依赖后续异常文案', (): void => {
    for (const status of ['fail', 'paused', 'waiting_verification', 'cancelled']) {
      const task = { mode: 'chat', status, runtime: { submittedAt: '2026-10-26T14:22:59.581Z' }, errorInfo: { code: 'unknown', message: '下载电脑版推广弹窗未能安全关闭，已在提交前停止' } };
      expect(requiresSubmissionReconciliation(task)).toBe(true);
      expect(requiresSubmissionReconciliation({ ...task, runtime: {} })).toBe(false);
      expect(requiresSubmissionReconciliation({ ...task, mode: 'video' })).toBe(true);
      expect(requiresSubmissionReconciliation({ ...task, mode: 'image' })).toBe(true);
    }
    expect(requiresSubmissionReconciliation({ mode: 'image', status: 'queued', runtime: { submittedAt: '2026-10-26T14:22:59.581Z' } })).toBe(true);
    for (const status of ['executing', 'generating', 'done']) {
      expect(requiresSubmissionReconciliation({ mode: 'chat', status, runtime: { submittedAt: '2026-10-26T14:22:59.581Z' }, errorInfo: { code: 'unknown' } })).toBe(false);
    }
  });

  it('发送可用性检查和实际点击共用同一定位器，找不到时 fail-closed', async () => {
    const missing = createMockWebview(() => ({ ok: false }));
    expect(await findSendButtonTarget(missing)).toEqual({ ok: false });
    const found = createMockWebview(() => ({ ok: true, position: '100,200', method: 'composer-semantic' }));
    expect(await findSendButtonTarget(found)).toMatchObject({ ok: true, method: 'composer-semantic' });
  });

  it('折叠后的平台提示词必须同时匹配稳定前缀与提交/完成回执', () => {
    const prompt = '5秒、9:16竖屏 TikTok 商品视频开场。图1定义画面中唯一的一名成年女性数字人，严格保持人物一致。英文台词省略。';
    expect(matchesSubmissionConversation(
      prompt,
      '生成视频：5 秒、9:16 竖屏 TikTok 商品视频开场。图 1 定义画面中唯一的一名成年女性数字人。视频生成已提交。你的视频生成好了。',
    )).toBe(true);
    expect(matchesSubmissionConversation(prompt, '另一个任务。你的视频生成好了。')).toBe(false);
    expect(matchesSubmissionConversation(prompt, '5秒、9:16竖屏 TikTok 商品视频开场，但没有平台回执')).toBe(false);
  });
});

describe('P0-3 真实回复终态', () => {
  const baseline = '欢迎使用豆包 推荐：你可以问我任何问题 用户消息：Reply exactly: abc123';

  function sample(overrides: Partial<TerminalSample>): TerminalSample {
    return {
      baselineText: baseline,
      currentText: baseline,
      networkFinished: false,
      messageCountDelta: 0,
      stableStreak: 0,
      ...overrides,
    };
  }

  it('文本净增长计算：前缀增长 / 共同前缀截断', () => {
    expect(computeTextGrowth(baseline, baseline + ' 助手回复内容')).toBe(' 助手回复内容'.length);
    expect(computeTextGrowth('', 'abc')).toBe(3);
    expect(computeTextGrowth('abc', 'abc')).toBe(0);
  });

  it('历史消息/欢迎语/推荐内容已在基线内：无净增长 → 不得完成', () => {
    // current 与基线相同（新增的只有欢迎语和推荐，均已在基线内）
    expect(evaluateTerminal(sample({}))).toBe('waiting');
    // 网络明确结束但无新内容（空回复/异常）→ 仍不得完成
    expect(evaluateTerminal(sample({ networkFinished: true }))).toBe('waiting');
  });

  it('真实用户消息后无助手回复 → waiting（即使消息数增加）', () => {
    // 消息数增加（补充证据）但文本无增长 → 不能完成
    expect(evaluateTerminal(sample({ messageCountDelta: 1 }))).toBe('waiting');
  });

  it('基线后出现助手回复 + 网络明确结束 → completed', () => {
    expect(evaluateTerminal(sample({ currentText: baseline + ' 这是助手回复', networkFinished: true }))).toBe('completed');
  });

  it('基线后出现助手回复 + 连续稳定采样 → completed', () => {
    expect(evaluateTerminal(sample({
      currentText: baseline + ' 这是助手回复',
      stableStreak: TERMINAL_STABLE_THRESHOLD,
    }))).toBe('completed');
  });

  it('回复内容在变化（不稳定）→ waiting', () => {
    expect(evaluateTerminal(sample({ currentText: baseline + ' 回复进行中...', stableStreak: 1 }))).toBe('waiting');
  });

  it('stableStreak 更新：无变化递增，变化归零', () => {
    expect(updateStableStreak('a', 'a', 0)).toBe(1);
    expect(updateStableStreak('a', 'a', 2)).toBe(3);
    expect(updateStableStreak('a', 'b', 5)).toBe(0);
  });
});

describe('P0-2/P0-3 发送、恢复与完成纪律', () => {
  it('正文写入仅限页内编辑器事件，不依赖系统键盘或把换行变成发送', () => {
    const bridgeSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'utils', 'doubaoBridge.ts'), 'utf8');
    const inputStart = bridgeSource.indexOf('async function injectCharByChar');
    const inputEnd = bridgeSource.indexOf('\nexport ', inputStart + 1);
    const inputBody = bridgeSource.slice(inputStart, inputEnd > 0 ? inputEnd : undefined);
    expect(inputStart).toBeGreaterThan(0);
    expect(inputBody).not.toContain('sendInputEvent');
    expect(inputBody).not.toMatch(/keyCode: 'Enter'|submitPrompt|button\.click\(/);
  });
  it('激活ACK丢失后沿原运行恢复并完成，不给原任务第二次发送权限', async (): Promise<void> => {
    const fixture = videoSubmissionHarness(); const original = fixture.current();
    expect(original.runtime?.submittedAt).toBeUndefined();
    const dispatch = vi.fn(async (safety: SubmissionDispatchSafety): Promise<{ kind: 'dispatch_unknown'; reason: string }> => {
      await safety.beforeDispatch?.();
      expect(fixture.current().runtime?.submission?.state).toBe('dispatch_unknown');
      return { kind: 'dispatch_unknown', reason: 'activation_ack_missing' };
    });
    await dispatchSubmissionAttempt({ ...fixture, dispatch });
    const submittedAt = fixture.current().runtime!.submittedAt;
    expect(fixture.service.recoverInterruptedTasks().success).toBe(true);
    expect(fixture.service.retry(original.id).success).toBe(false);
    expect(fixture.service.updateRuntime({ taskId: original.id, expectedRunId: original.runtime!.runId,
      status: 'manual_submission_observing', runtime: { stage: 'manual_submission_observing' } }).success).toBe(true);
    await fixture.persist('accepted');
    expect(fixture.service.updateStatus({ taskId: original.id, expectedRunId: original.runtime!.runId, status: 'done', outputs: ['https://fixture.invalid/original.mp4'] }).success).toBe(true);
    expect(fixture.current()).toMatchObject({ status: 'done', runtime: { runId: original.runtime!.runId, attempt: 1, submittedAt } });
    expect(fixture.current().artifacts?.[0].runId).toBe(original.runtime!.runId);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('素材授权等待能在同一次尝试中保存受理并进入生成，不回到最终发送', async (): Promise<void> => {
    const fixture = videoSubmissionHarness(); const original = fixture.current();
    expect(fixture.service.updateRuntime({ taskId: original.id, expectedRunId: original.runtime!.runId,
      status: 'waiting_verification', runtime: { stage: 'waiting_verification' } }).success).toBe(true);
    await fixture.persist('dispatch_unknown', 'material_authorization_may_submit');
    const evidence: SubmissionReadback = { inputCleared: true, promptPublished: true, generationStarted: true, messageCount: 1 };
    expect(classifySubmissionReadback(evidence)).toBe('confirmed');
    const current = fixture.current();
    const binding = createAcceptedObservationBinding({ accountId: current.assignedAccountId!, runId: current.runtime!.runId,
      conversationUrl: 'https://www.doubao.com/chat/fixture-original', acceptedAt: current.runtime!.submittedAt!, ownerId: 'fixture-observer',
      mode: 'video', evidence, materialAuthorizationConfirmed: true });
    await fixture.persist('accepted');
    expect(fixture.service.updateRuntime({ taskId: current.id, expectedRunId: current.runtime!.runId, status: 'generating',
      runtime: { stage: 'generating', conversationUrl: binding.conversationUrl, acceptanceObservation: binding } }).success).toBe(true);
    expect(fixture.current()).toMatchObject({ status: 'generating', runtime: { runId: original.runtime!.runId, attempt: 1,
      submission: { operationId: 'fixture-operation', state: 'accepted' }, acceptanceObservation: { evidence: { kind: 'material_authorization_confirmed' } } } });
  });

  it('媒体只向已核实目标原生单击，Chat页内兼容，均不聚焦、不发键盘或回退重发', async (): Promise<void> => {
    // 探针/原生IPC为边界替身；真实DOM归属与可信事件由nativeMediaDispatch及Electron fixture另验。
    vi.useFakeTimers();
    try {
      for (const mode of ['image', 'video', 'chat'] as const) {
        const fixture = videoSubmissionHarness(mode); const focus = vi.fn(); const events: NativeMouseInputEvent[] = [];
        const verifyLease = vi.fn(async (): Promise<boolean> => true); let domActivations = 0; let locate = true;
        const target = { ok: true, method: 'exact-id', geometry: '100,200,40,40,800,600', position: '120,220', inputHash: 'fixture-exact-input', documentId: 1 };
        const view: WebviewHandle = { focus, getURL: (): string => 'https://www.doubao.com/chat/fixture-original', loadURL: vi.fn(),
          sendInputEvent: (event: NativeMouseInputEvent): void => { events.push(event); },
          executeJavaScript: async (code: string): Promise<unknown> => {
            if (!locate) return { ok: false };
            if (code.includes('"reserveNative":true') || code.includes('"validateNativeKey":')) return { ...target, nativeReserved: true };
            if (code.includes('"readReceiptKey":')) return { ...target, nativeReceipt: { mouseDown: true, activated: true, trusted: true, cancelled: false, documentId: 1 } };
            if (code.includes('"dispatchKey":')) { domActivations++; return { ...target, dispatched: true, dispatchAttempted: true }; }
            return target;
          },
        };
        const safety: SubmissionDispatchSafety = { ...fixture.safety, verifyLease, activation: mode === 'chat' ? 'dom_compat' : 'native_media' };
        const pending = dispatchSubmissionAttempt({ ...fixture, safety, dispatch: (guard): ReturnType<typeof submitPromptOnce> => submitPromptOnce(view, guard) });
        await vi.advanceTimersByTimeAsync(500); expect(await pending).toMatchObject({ kind: 'dispatch_attempted' });
        expect(verifyLease).toHaveBeenCalledOnce(); expect(focus).not.toHaveBeenCalled(); expect(view.loadURL).not.toHaveBeenCalled();
        expect(domActivations).toBe(mode === 'chat' ? 1 : 0);
        expect(events).toEqual(mode === 'chat' ? [] : [
          { type: 'mouseDown', x: 120, y: 220, button: 'left', clickCount: 1 }, { type: 'mouseUp', x: 120, y: 220, button: 'left', clickCount: 1 },
        ]);
        // 控件丢失仍fail-closed，不因媒体原生路径而换成Enter、DOM或其它入口。
        locate = false; const unavailable = submitPromptOnce(view, safety); await vi.advanceTimersByTimeAsync(500);
        expect(await unavailable).toMatchObject({ kind: 'not_dispatched' }); expect(domActivations).toBe(mode === 'chat' ? 1 : 0); expect(events).toHaveLength(mode === 'chat' ? 0 : 2);
      }
    } finally { vi.useRealTimers(); }
  });

  it('只读核对路径不包含提交调用，普通 retry/edit-rerun 对不确定任务隐藏', () => {
    const recoverySource = readFileSync(resolve(__dirname, '..', '..', 'src', 'automation', 'TaskRecoveryCoordinator.ts'), 'utf8');
    const reconcileBody = recoverySource.slice(
      recoverySource.indexOf('const handleSubmissionReconcile'),
      recoverySource.indexOf('return { handleManualSubmission, handleSubmissionReconcileSafely }'),
    );
    expect(reconcileBody).toContain('resolveVideoArtifact');
    expect(reconcileBody).not.toContain('manualResolveVideoArtifact');
    expect(reconcileBody).not.toContain('submitPrompt');
    expect(reconcileBody).not.toContain('injectPrompt');
    expect(recoverySource).toContain("code: 'submission_uncertain'");

    const consoleSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'components', 'TaskConsole.tsx'), 'utf8');
    const detailSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'components', 'TaskDetailModal.tsx'), 'utf8');
    expect(consoleSource).toContain('核对平台结果（不重新发送）');
    expect(detailSource).toContain('核对平台结果（不重新发送）');
  });

  it('会员升级跨源 iframe 在提交前被识别为 membership_required', () => {
    const bridgeSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'utils', 'doubaoBridge.ts'), 'utf8');
    expect(bridgeSource).toContain("document.querySelectorAll('iframe')");
    expect(bridgeSource).toContain('订阅|会员|升级|subscribe|membership|upgrade');
    expect(bridgeSource).toContain("throw new Error('membership_required: 视频参数需要会员操作，已停止提交')");
  });

  it('比例已匹配时不重复选择，当前参数菜单已打开时不再次toggle', () => {
    const bridgeSource = readFileSync(resolve(__dirname, '..', '..', 'src', 'utils', 'doubaoBridge.ts'), 'utf8');
    expect(bridgeSource).toContain("if ((await probe()).ratio !== targetRatio)");
    expect(bridgeSource).toContain('if (current.menuOpen) return;');
    expect(bridgeSource).toContain("await openMenu('duration', targetRatio)");
  });

  it('文字终态需要真实新增的稳定回复，未保存原回复时服务端拒绝完成', async (): Promise<void> => {
    const fixture = videoSubmissionHarness('chat');
    expect(evaluateTerminal({ baselineText: '', currentText: '', networkFinished: true, messageCountDelta: 1, stableStreak: 9 })).toBe('waiting');
    expect(fixture.service.updateStatus({ taskId: 'fixture-task', expectedRunId: 'fixture-run', status: 'done', outputs: [] }).success).toBe(false);
    expect(fixture.current().status).toBe('executing');
    await fixture.persist('dispatch_unknown');
    const response = '真实助手新增且稳定的逐字回复';
    expect(evaluateTerminal({ baselineText: '', currentText: response, networkFinished: false, messageCountDelta: 2, stableStreak: TERMINAL_STABLE_THRESHOLD })).toBe('completed');
    expect(fixture.service.updateRuntime({ taskId: 'fixture-task', expectedRunId: 'fixture-run', runtime: { chatResponse: { text: response, capturedAt: new Date().toISOString() } } }).success).toBe(true);
    expect(fixture.service.updateStatus({ taskId: 'fixture-task', expectedRunId: 'fixture-run', status: 'done', outputs: [] }).success).toBe(true);
    expect(fixture.current().runtime?.chatResponse?.text).toBe(response);
  });
});
