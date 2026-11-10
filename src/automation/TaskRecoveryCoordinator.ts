import { message } from 'antd';
import { automationEngine } from './AutomationEngine';
import { DoubaoVideoAdapter } from './DoubaoVideoAdapter';
import { AccountAvailabilityPauseError, VideoObservationPauseError, chatReadbackReceipt, hasAccountChatAdjustment, sleepWithAbort, taskChatReadbackContext, waitForWebviewReady } from './taskExecutionSupport';
import { useAccountStore } from '../store/useAccountStore';
import { acceptProductionSnapshot, usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import type { AccountAvailability, AccountAvailabilitySource, Task } from '../types';
import { renewObservationLease } from '../utils/acceptedObservation';
import { probeAccountAvailability } from '../utils/accountAvailability';
import type { ChatReadbackContext, ChatReadbackResult } from '../utils/chatReadback';
import { diagnoseChatReadback, diagnoseCreationReadback, inspectChatReadback, inspectCreationReadback, inspectSubmittedImageReadback } from '../utils/chatReadback';
import type { ConversationSyncResult } from '../utils/conversationSync';
import type { CurrentCreationConversationReadback } from '../utils/creationConversationIdentity';
import type { VideoArtifactReadbackDiagnostic } from '../utils/doubaoBridge';
import { ChatReadbackRecoveryError, detectVideoGenerationBlocker, getChatPageSnapshot, getConversationText, getCreationReadbackSnapshot, getCurrentCreationConversation, getGenerationStartTime, inspectGenerationConfirmation, readAcceptedImageOutputs, readStableChatAnswer, resolveVideoArtifact } from '../utils/doubaoBridge';
import { observeWithHumanVerification } from '../utils/humanVerification';
import type { ImageArtifactObservationProgress } from '../utils/imageArtifactReadback';
import { canSelectAccount, findInteractiveAccountId } from '../utils/interactiveAccount';
import type { MaterialImagePages } from '../utils/materialImagePages';
import { mediaSubmissionReceiptFor } from '../utils/mediaSubmissionReceipt';
import { isBackgroundPetStoryTask } from '../utils/petstoryBackground';
import { matchesSubmissionConversation, requiresSubmissionReconciliation, verifiedSubmissionConversationUrl } from '../utils/realSendStateMachine';
import type { SubmittedCreationReadbackSample } from '../utils/submittedCreationReadback';
import { waitForSubmittedCreationReadback } from '../utils/submittedCreationReadback';
import { isSameDoubaoConversation, normalizeDoubaoConversationUrl, resolveTaskConversationTarget, supportsDoubaoConversationLocator, waitForConversationNavigator } from '../utils/taskConversationLocator';
import { getTaskExecutionScope, tasksExecutionConflict } from '../utils/taskExecutionScope';
import type { VideoArtifactObservationProgress } from '../utils/videoArtifactObservation';
import { getVideoQuotaUsageUnits } from '../utils/videoQuota';

/** 恢复只消费宿主持有的原运行/页面/Promise，不拥有第二份任务状态。 */
export interface TaskRecoveryHost {
  abortControllersRef: { current: Map<string, AbortController> };
  pendingCancellationStatusRef: { current: Map<string, 'paused' | 'cancelled'> };
  submissionReconcileRef: { current: Set<string> };
  submissionReconcilePromisesRef: { current: Map<string, Promise<void>> };
  submissionReconcileUsageRef: { current: Set<string> };
  submittedImagePagesRef: { current: Map<string, { accountId: string; runId: string; submittedAt: string; webview: HTMLWebViewElement; conversationUrl: string }> };
  materialPagesRef: { current: MaterialImagePages };
  visibleRef: { current: boolean };
  getTaskWebview: (task: Task) => HTMLWebViewElement | undefined;
  ensureTaskWebview: (task: Task) => HTMLWebViewElement | undefined;
  taskWebviewReady: (task: Task) => boolean;
  ownsTaskWebview: (taskId: string, webview: HTMLWebViewElement) => boolean;
  assertNoHumanVerification: (accountId: string, webview: HTMLWebViewElement) => Promise<void>;
  performAvailabilityCheck: (accountId: string, webview: HTMLWebViewElement, source: AccountAvailabilitySource) => Promise<AccountAvailability>;
  synchronizeConversation: (webview: HTMLWebViewElement, targetUrl: string, isCurrent: () => boolean, trigger?: 'explicit' | 'visibility', signal?: AbortSignal) => Promise<ConversationSyncResult>;
  conversationSyncMessage: (result: ConversationSyncResult) => string;
}

export interface TaskRecoveryCoordinator {
  handleManualSubmission: (event: Event) => Promise<void>;
  handleSubmissionReconcileSafely: (event: Event) => Promise<void>;
}

/** 新建、暂停和重启沿正式适配器观察原请求；UI只安装事件桥，绝不重新派发。 */
export function createTaskRecoveryCoordinator(host: TaskRecoveryHost): TaskRecoveryCoordinator {
  const { abortControllersRef, pendingCancellationStatusRef, submissionReconcileRef, submissionReconcilePromisesRef, submissionReconcileUsageRef,
    submittedImagePagesRef, materialPagesRef, visibleRef, getTaskWebview, ensureTaskWebview, taskWebviewReady,
    ownsTaskWebview, assertNoHumanVerification, performAvailabilityCheck, synchronizeConversation, conversationSyncMessage } = host;
  const handleManualSubmission = async (event: Event): Promise<void> => {
    const detail = (event as CustomEvent<{ taskId: string; conversationUrl?: string; useCurrentPage?: boolean }>).detail;
    const task = useTaskStore.getState().tasks.find((item) => item.id === detail?.taskId);
    if (!task || task.status === 'done' || !task.assignedAccountId) {
      message.error('任务不存在、已完成或尚未绑定账号，不能进入人工提交观察');
      return;
    }
    const currentWebview = getTaskWebview(task);
    const suppliedUrl = detail.conversationUrl?.trim();
    const userConfirmedCurrentUrl = detail.useCurrentPage ? currentWebview?.getURL() : undefined;
    const conversationUrl = normalizeDoubaoConversationUrl(
      suppliedUrl || userConfirmedCurrentUrl || task.runtime?.conversationUrl,
    );
    if (!conversationUrl) {
      message.error('缺少可验证的豆包具体会话 URL；任务保持原状态，未猜测当前页面');
      return;
    }
    const account = useAccountStore.getState().accounts.find((item) => item.id === task.assignedAccountId);
    if (!account || (account.platform || 'doubao') !== 'doubao') {
      message.error('当前只支持已验证的豆包会话；Dola 尚未完成真实验收');
      return;
    }
    const now = new Date();
    const startedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
    const manualRunId = `manual-${task.id}-${now.getTime()}`;
    const observationMessage = '用户声明已手动提交；正在只读观察原会话，系统不会注入、发送或新建对话';
    const saved = await useTaskStore.getState().updateTaskRuntime(task.id, {
      status: 'manual_submission_observing',
      result: observationMessage,
      errorInfo: { code: 'manual_review_required', message: observationMessage, recoverable: true, detectedAt: startedAt },
      runtime: {
        runId: manualRunId,
        attempt: (task.runtime?.attempt || 0) + 1,
        stage: 'manual_submission_observing',
        message: observationMessage,
        startedAt,
        stageStartedAt: startedAt,
        lastHeartbeatAt: startedAt,
        submittedAt: startedAt,
        conversationUrl,
        manualObservation: {
          startedAt,
          expiresAt,
          source: suppliedUrl || userConfirmedCurrentUrl ? 'user_confirmed_url' : 'stored_conversation',
          outcome: 'observing',
        },
        input: {
          prompt: task.prompt,
          mode: task.mode,
          videoConfig: task.videoConfig,
          attachments: [...(task.attachments || [])],
          audioAttachment: task.audioAttachment,
        },
      },
    });
    if (!saved) {
      message.error(useTaskStore.getState().error || '人工提交观察状态写入失败；任务保持原状态，未读取或绑定产物');
      return;
    }
    if (useTaskStore.getState().tasks.find((item) => item.id === task.id)?.status !== 'manual_submission_observing') {
      message.error('人工提交观察状态写入失败；任务保持原状态，未读取或绑定产物');
      return;
    }
    window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: task.id } }));
  };

  const handleSubmissionReconcile = async (event: Event): Promise<void> => {
    const detail = (event as CustomEvent<{ taskId: string; useCurrentPage?: boolean; automatic?: boolean; accountId?: string; runId?: string; submittedAt?: string; verificationCheckedAt?: string }>).detail;
    const taskId = detail?.taskId;
    if (!taskId || submissionReconcileRef.current.has(taskId)) return;
    const task = useTaskStore.getState().tasks.find((item) => item.id === taskId);
    if (detail.runId && (task?.runtime?.runId !== detail.runId || task.runtime.submittedAt !== detail.submittedAt || task.assignedAccountId !== detail.accountId)) return;
    if (detail.verificationCheckedAt) {
      const ready = useAccountStore.getState().accounts.find((item): boolean => item.id === detail.accountId)?.health?.availability;
      if (ready?.state !== 'ready' || ready.checkedAt !== detail.verificationCheckedAt) return;
    }
    const observationController = abortControllersRef.current.get(taskId);
    if (observationController?.signal.aborted) throw new DOMException('原结果检查已暂停', 'AbortError');
    if (!requiresSubmissionReconciliation(task)) {
      message.warning('该任务没有需要核对的提交记录');
      return;
    }
    if (task?.mode === 'chat' && ['executing', 'generating'].includes(task.status)) {
      message.warning('原 Chat 仍在观察中，请暂停后再补取');
      return;
    }
    const accountId = task?.assignedAccountId;
    if (hasAccountChatAdjustment(accountId)) throw new Error('请先采用当前回复或结束调整，再打开其他任务会话');
    const account = useAccountStore.getState().accounts.find((item) => item.id === accountId);
    let conversationTarget = resolveTaskConversationTarget(task);
    const confirmCurrentSubmission = (task?.mode === 'chat' || task?.mode === 'image' || (!!task?.petstory && task.mode === 'video'))
      && !!task.runtime?.submittedAt && detail.useCurrentPage === true
      && !conversationTarget.ok && conversationTarget.reason === 'CONVERSATION_URL_MISSING';
    if (!task || !accountId || !account || !supportsDoubaoConversationLocator(account.platform) || (!conversationTarget.ok && !confirmCurrentSubmission)) {
      throw new Error('缺少原账号页面或原对话地址，已保持暂停且未重新发送');
    }

    if (useTaskStore.getState().tasks.some((other): boolean => other.id !== taskId && tasksExecutionConflict(other, task) && ['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'].includes(other.status))) {
      throw new Error('原账号还有其他活跃任务，暂不导航或补取');
    }
    if (!materialPagesRef.current.uses(task) && isBackgroundPetStoryTask(usePetStoryStore.getState().project, taskId, task) && visibleRef.current
      && useAccountStore.getState().selectedAccountId !== accountId) {
      throw new Error('当前正在查看其他豆包对话，请收起后继续收取本次结果');
    }
    if (!canSelectAccount(accountId, findInteractiveAccountId(useTaskStore.getState().accountAutomationState))) throw new Error('另一个账号正在提交，请稍后检查原结果');
    submissionReconcileRef.current.add(taskId);
    useAccountStore.getState().selectAccount(accountId);
    ensureTaskWebview(task);
    const webview = await waitForConversationNavigator(
      () => getTaskWebview(task),
      { timeoutMs: 20_000, isReady: () => taskWebviewReady(task),
        wait: (ms: number): Promise<void> => observationController ? sleepWithAbort(ms, observationController.signal) : new Promise((resolve): void => { setTimeout(resolve, ms); }) },
    );
    if (!webview) {
      submissionReconcileRef.current.delete(taskId);
      throw new Error('账号页面未能在限定时间内就绪；未刷新、未重新发送');
    }
    const submittedPage = submittedImagePagesRef.current.get(taskId);
    const currentRoute = normalizeDoubaoConversationUrl(webview.getURL());
    if (confirmCurrentSubmission && task.mode === 'image' && detail.automatic
      && (!submittedPage || submittedPage.accountId !== accountId || submittedPage.runId !== task.runtime?.runId
        || submittedPage.submittedAt !== task.runtime?.submittedAt || submittedPage.webview !== webview
        || currentRoute && !isSameDoubaoConversation(submittedPage.conversationUrl, currentRoute))) {
      throw new Error('尚未确认当前页面属于原图片运行，请查看原豆包对话后继续；未重新发送');
    }
    const originalContextIsCurrent = (): boolean => {
      const current = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
      if (!current?.runtime || !task.runtime) return false;
      return current.runtime.runId === task.runtime.runId && current.runtime.submittedAt === task.runtime.submittedAt
        && JSON.stringify(current.runtime.input) === JSON.stringify(task.runtime.input)
        && current.prompt === task.prompt && current.mode === task.mode
        && JSON.stringify(current.attachments || []) === JSON.stringify(task.attachments || [])
        && JSON.stringify(current.petstory) === JSON.stringify(task.petstory)
        && current.audioAttachment === task.audioAttachment && JSON.stringify(current.videoConfig) === JSON.stringify(task.videoConfig)
        && current.assignedAccountId === accountId && ownsTaskWebview(taskId, webview)
        && !observationController?.signal.aborted && current.status !== 'cancelled' && current.status !== 'done'
        && (task.mode !== 'image' || current.status === task.status)
        && canSelectAccount(accountId, findInteractiveAccountId(useTaskStore.getState().accountAutomationState));
    };
    const assertOriginalContext = (): void => {
      if (!originalContextIsCurrent()) throw new DOMException('原结果检查已暂停或运行已变化', 'AbortError');
    };
    let lastImageDiagnostic = '';
    let pinnedImageUrl = conversationTarget.ok ? conversationTarget.url : detail.automatic ? submittedPage?.conversationUrl || null : currentRoute;
    let lastImagePage: CurrentCreationConversationReadback | undefined;
    const readOriginalImageEvidence = async (signal?: AbortSignal): Promise<SubmittedCreationReadbackSample> => {
      await assertNoHumanVerification(accountId, webview);
      assertOriginalContext();
      const observedUrl = webview.getURL();
      const page = await getCurrentCreationConversation(webview, { signal, ensureCurrent: assertOriginalContext });
      lastImagePage = page;
      const concreteUrl = page.conversationUrl || normalizeDoubaoConversationUrl(observedUrl);
      if (concreteUrl && pinnedImageUrl && !isSameDoubaoConversation(concreteUrl, pinnedImageUrl)) throw new Error('原图片会话已变化，未绑定其他会话');
      if (concreteUrl) pinnedImageUrl = concreteUrl;
      const snapshot = page.source === 'published_message' ? page.snapshot : concreteUrl ? await getCreationReadbackSnapshot(webview, {
        conversationUrl: concreteUrl, signal, ensureCurrent: assertOriginalContext, allowProviderConversation: true,
      }) : page.snapshot;
      if (page.conversationId && page.conversationUrl && snapshot.historyComplete && snapshot.conversationId === page.conversationId) {
        lastImagePage = { ...page, snapshot, source: 'published_message', messageIds: snapshot.messages.flatMap((item): string[] => item.messageId ? [item.messageId] : []) };
      }
      assertOriginalContext();
      const route = normalizeDoubaoConversationUrl(webview.getURL());
      if (concreteUrl && route && !isSameDoubaoConversation(concreteUrl, route)) throw new Error('原图片会话已变化，未绑定其他会话');
      // 恢复按原全文与消息身份定位，不要求整个会话只有一条用户消息。
      const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
      const receipt = latest?.runtime?.mediaSubmissionReceipt;
      const context: ChatReadbackContext = {
        taskId, runId: task.runtime?.runId || '', currentRunId: latest?.runtime?.runId || '',
        accountId, currentAccountId: latest?.assignedAccountId || '',
        conversationUrl: pinnedImageUrl || '', currentConversationUrl: concreteUrl || '',
        userMessageId: receipt?.userMessageId, userTurnId: receipt?.userTurnId,
      };
      const evidence = task.mode === 'video'
        ? inspectCreationReadback(snapshot, task.runtime?.input.prompt || task.prompt, 'video', 0, task.videoConfig, !!task.runtime?.generationConfirmation, context)
        : concreteUrl && pinnedImageUrl ? inspectSubmittedImageReadback(snapshot, task.runtime?.input.prompt || task.prompt, context)
        : inspectCreationReadback(snapshot, task.runtime?.input.prompt || task.prompt, 'image', 0);
      const diagnostic = JSON.stringify({ ...diagnoseCreationReadback(snapshot, task.prompt, task.mode === 'video' ? 'video' : 'image', task.videoConfig),
        promptPublished: evidence.promptPublished, reason: evidence.reason,
        originalMessageIndex: evidence.originalMessageIndex, originalAssistantMessageIndices: evidence.originalAssistantMessageIndices });
      if (diagnostic !== lastImageDiagnostic) {
        lastImageDiagnostic = diagnostic;
        void window.electronAPI.logs.append({ level: 'info', scope: 'automation', taskId, accountId,
          message: '原图片提交只读诊断 ' + diagnostic }).catch((): void => undefined);
      }
      return { url: concreteUrl || observedUrl, evidence, historyComplete: snapshot.historyComplete };
    };
    let imageIdentityVerified = false;
    assertOriginalContext();
    try {
      // 验证未解除时不导航／刷新原会话，避免打断用户正在处理的验证现场。
      await assertNoHumanVerification(accountId, webview);
      const currentAccount = useAccountStore.getState().accounts.find((item): boolean => item.id === accountId);
      if (currentAccount?.health?.verificationRequired || currentAccount?.health?.availability?.reason === 'human_verification') {
        const availability = await performAvailabilityCheck(accountId, webview, 'manual');
        if (availability.state !== 'ready') throw new AccountAvailabilityPauseError('原账号尚未重新检测通过，请完成人工验证后再次检测；未刷新、未重新发送', 'human_verification');
      }
    } catch (error: unknown) {
      submissionReconcileRef.current.delete(taskId);
      if (error instanceof AccountAvailabilityPauseError) {
        const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
        if (!observationController?.signal.aborted && latest?.status !== 'cancelled' && latest?.runtime?.runId === task.runtime?.runId && latest?.runtime?.submittedAt === task.runtime?.submittedAt) await useTaskStore.getState().pauseAutomation(taskId, accountId, error.message, { status: 'waiting_verification', code: error.code });
        message.warning(error.message);
      }
      throw error;
    }
    try {
      // 缺少定位时持续核对同一原页面；只在唯一全文及原运行均证明后保存，不导航或重发。
      if (confirmCurrentSubmission) {
        if (task.mode === 'image' || task.mode === 'video') {
          const located = await waitForSubmittedCreationReadback({
            stopOnStableAmbiguity: true,
            signal: observationController?.signal, ensureCurrent: assertOriginalContext,
            wait: (ms: number): Promise<void> => observationController ? sleepWithAbort(ms, observationController.signal)
              : new Promise((resolve): void => { setTimeout(resolve, ms); }),
            read: (): Promise<SubmittedCreationReadbackSample> => readOriginalImageEvidence(observationController?.signal),
          });
          assertOriginalContext();
          const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
          const receipt = lastImagePage ? mediaSubmissionReceiptFor(task, latest, accountId, lastImagePage, new Date().toISOString()) : undefined;
          const verifiedUrl = receipt?.conversationUrl || verifiedSubmissionConversationUrl(task, latest,
            accountId, located.url, webview.getURL(), located.evidence);
          if (!verifiedUrl) throw new Error('原媒体任务输入或会话身份不符，未绑定其他结果');
          const saved = await useTaskStore.getState().updateTaskRuntime(taskId, { expectedRunId: task.runtime?.runId,
            runtime: { conversationUrl: verifiedUrl, ...(receipt ? { mediaSubmissionReceipt: receipt } : {}) } });
          assertOriginalContext();
          conversationTarget = resolveTaskConversationTarget(useTaskStore.getState().tasks.find((item): boolean => item.id === taskId));
          if (!saved || !conversationTarget.ok) throw new Error('原媒体会话地址保存未确认，未重新发送');
          imageIdentityVerified = true;
        } else {
          const currentUrl = normalizeDoubaoConversationUrl(webview.getURL());
          if (!currentUrl) throw new Error('当前页面尚无具体原会话，保持暂停且不重发');
          const snapshot = await getChatPageSnapshot(webview);
          const evidence = inspectChatReadback(snapshot, task.prompt, 0);
          const latest = useTaskStore.getState().tasks.find((item) => item.id === taskId);
          const verifiedUrl = verifiedSubmissionConversationUrl(task, latest, accountId, currentUrl, webview.getURL(), evidence);
          if (observationController?.signal.aborted || !verifiedUrl) {
            if (!evidence.promptPublished && task.mode === 'chat') console.warn('[ChatReadbackMismatch]', JSON.stringify(diagnoseChatReadback(snapshot, task.prompt)));
            submissionReconcileRef.current.delete(taskId);
            throw new Error('当前 Chat 不唯一匹配原任务或运行已变化；未绑定、未重发');
          }
          const saved = await useTaskStore.getState().updateTaskRuntime(taskId, { expectedRunId: task.runtime?.runId, runtime: { conversationUrl: verifiedUrl } });
          conversationTarget = resolveTaskConversationTarget(useTaskStore.getState().tasks.find((item) => item.id === taskId));
          if (!saved || !conversationTarget.ok) {
            submissionReconcileRef.current.delete(taskId);
            throw new Error('原会话地址保存未确认，未重发');
          }
        }
      }
    } catch (error: unknown) {
      submissionReconcileRef.current.delete(taskId);
      throw error;
    }
    if (!conversationTarget.ok) { submissionReconcileRef.current.delete(taskId); throw new Error('原会话定位未确认，未重新发送'); }
    assertOriginalContext();
    const syncStartedAt = new Date().toISOString();
    await useTaskStore.getState().updateTaskRuntime(taskId, { expectedRunId: task.runtime?.runId, runtime: { message: '正在核对原豆包会话结果，不会重新发送', lastHeartbeatAt: syncStartedAt } });
    if (['image', 'video'].includes(task.mode || '') && task.runtime?.mediaSubmissionReceipt && !isSameDoubaoConversation(webview.getURL(), conversationTarget.url)) {
      const page = await getCurrentCreationConversation(webview, { signal: observationController?.signal, ensureCurrent: assertOriginalContext });
      assertOriginalContext();
      if (page.conversationUrl && isSameDoubaoConversation(page.conversationUrl, conversationTarget.url)) imageIdentityVerified = true;
    }
    // 已核实媒体服务器消息时原位观察，不能因地址栏尚未更新而刷新生成现场。
    if (!['image', 'video'].includes(task.mode || '') || !imageIdentityVerified && !isSameDoubaoConversation(webview.getURL(), conversationTarget.url)) {
      const navigation = await synchronizeConversation(webview, conversationTarget.url, originalContextIsCurrent, 'explicit', observationController?.signal);
      if (!navigation.ok) {
        submissionReconcileRef.current.delete(taskId);
        throw new Error(conversationSyncMessage(navigation));
      }
    }
    try {
      await observeWithHumanVerification((): Promise<void> => waitForWebviewReady(webview, 20_000),
        (): Promise<void> => assertNoHumanVerification(accountId, webview), observationController?.signal);
    } catch (error: unknown) {
      submissionReconcileRef.current.delete(taskId);
      if (error instanceof AccountAvailabilityPauseError && error.code === 'human_verification') {
        const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
        if (!observationController?.signal.aborted && latest?.status !== 'cancelled' && latest?.runtime?.runId === task.runtime?.runId && latest?.runtime?.submittedAt === task.runtime?.submittedAt) await useTaskStore.getState().pauseAutomation(taskId, accountId, error.message, { status: 'waiting_verification', code: error.code });
        message.warning(error.message);
        return;
      }
      throw error;
    }

    const isManualObservation = task.status === 'manual_submission_observing';
    if (!originalContextIsCurrent()) throw new DOMException('原结果检查已暂停或运行已变化', 'AbortError');
    // 只读观察保留原Task状态；不能把manual_submission_observing改成新生成运行。
    const observationScope = getTaskExecutionScope(task);
    useTaskStore.setState((state): Partial<ReturnType<typeof useTaskStore.getState>> => ({
      accountAutomationState: { ...state.accountAutomationState, [observationScope]: 'generating' },
      accountAutoMessage: { ...state.accountAutoMessage, [observationScope]: '正在核对平台结果（不会重新发送）...' },
    }));
    try {
      await observeWithHumanVerification(async (observationSignal: AbortSignal): Promise<void> => {
      if (task.runtime?.acceptanceObservation?.outcome === 'observing') {
        const heartbeatAt = new Date().toISOString();
        const renewed = renewObservationLease(task.runtime.acceptanceObservation, heartbeatAt, 60_000);
        const renewedOk = await useTaskStore.getState().updateTaskRuntime(taskId, { expectedRunId: task.runtime?.runId,
          runtime: { acceptanceObservation: renewed, lastHeartbeatAt: heartbeatAt },
        });
        if (!renewedOk) throw new Error('观察租约续期失败');
      }
      // Chat恢复始终走独立消息正文通道，不使用整页文本或视频产物扫描。
      if (task.mode === 'chat') {
        if (!task.runtime?.runId || !task.runtime.submittedAt || task.runtime.input.prompt !== task.prompt || task.runtime.input.mode !== 'chat') {
          throw new Error('原运行或输入快照不符；保留记录，未重新发送');
        }
        const raw = await readStableChatAnswer(webview, task.prompt, conversationTarget.url, 15_000, {
          context: taskChatReadbackContext(task, accountId, conversationTarget.url, webview.getURL()),
          currentRunId: (): string | undefined => useTaskStore.getState().tasks.find((item): boolean => item.id === taskId)?.runtime?.runId,
          signal: observationSignal,
          onCaptured: async (evidence: ChatReadbackResult): Promise<void> => {
            const receipt = chatReadbackReceipt(task, evidence, task.runtime?.chatReadback?.baselineMessageCount || 0);
            if (!receipt || !await useTaskStore.getState().updateTaskRuntime(taskId, { expectedRunId: task.runtime?.runId, runtime: { chatReadback: receipt } })) throw new Error('原消息轮次保存未确认');
          },
        });
        const verifiedReceipt = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId)?.runtime?.chatReadback;
        if (verifiedReceipt?.runId !== task.runtime.runId) throw new Error('原消息轮次身份变化；本次正文未绑定');
        const saved = await useTaskStore.getState().updateTaskRuntime(taskId, { expectedRunId: task.runtime?.runId,
          runtime: { chatReadback: verifiedReceipt, chatResponse: { text: raw, capturedAt: new Date().toISOString() } },
        });
        if (!saved) throw new Error('正文保存未确认，保留原任务且不重发');
        await useTaskStore.getState().completeAutomation(taskId, accountId, '', [], task.runtime?.runId);
        message.success('原会话完整正文已补取；可在萌宠短剧中收取结果，未重新发送');
        return;
      }
      // 导航预检完成后只读取原会话；不注入、不点击发送、不创建新对话。
      const conversationUrl = conversationTarget.url;
      if (task.mode === 'image') {
        const assertImageObservation = (): void => {
          assertOriginalContext();
          if (observationSignal.aborted) throw new DOMException('原图片观察已暂停', 'AbortError');
          const route = normalizeDoubaoConversationUrl(webview.getURL());
          if (route && !isSameDoubaoConversation(route, conversationUrl)) throw new Error('原图片会话已变化，未绑定其他产物');
        };
        // 耐久收据已经绑定原服务器消息；后续聊天不应再次要求整段会话只有一条用户消息。
        if (!imageIdentityVerified && !task.runtime?.mediaSubmissionReceipt) {
          await waitForSubmittedCreationReadback({
            stopOnStableAmbiguity: true,
            signal: observationSignal, ensureCurrent: assertImageObservation,
            wait: (ms: number): Promise<void> => sleepWithAbort(ms, observationSignal),
            read: (): Promise<SubmittedCreationReadbackSample> => readOriginalImageEvidence(observationSignal),
          });
          assertImageObservation();
          const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
          const receipt = lastImagePage ? mediaSubmissionReceiptFor(task, latest, accountId, lastImagePage, new Date().toISOString()) : undefined;
          // 已有会话地址的旧任务也补存原消息身份，后续恢复直接沿该消息取图。
          if (receipt && !await useTaskStore.getState().updateTaskRuntime(taskId, { expectedRunId: task.runtime?.runId, runtime: { mediaSubmissionReceipt: receipt } })) throw new Error('原图片消息身份保存未确认，未绑定产物');
          assertImageObservation();
        }
        assertImageObservation();
        const receipt = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId)?.runtime?.mediaSubmissionReceipt;
        let lastArtifactDiagnostic = '';
        const outputs = await readAcceptedImageOutputs(webview, conversationUrl, observationSignal, undefined, {
          prompt: task.runtime?.input.prompt || task.prompt, runId: task.runtime?.runId || '', userMessageId: receipt?.userMessageId, userTurnId: receipt?.userTurnId,
        }, { ensureCurrent: assertImageObservation, stopOnStableAmbiguity: true,
          onProgress: async (progress: ImageArtifactObservationProgress): Promise<void> => {
            const diagnostic = JSON.stringify({ reason: progress.reason, outputCount: progress.outputCount, imageEvidence: progress.imageEvidence, messageChain: progress.messageChain });
            if (diagnostic === lastArtifactDiagnostic) return;
            lastArtifactDiagnostic = diagnostic;
            await window.electronAPI.logs.append({ level: 'info', scope: 'automation', taskId, accountId, message: '原图片产物只读诊断 ' + diagnostic }).catch((): void => undefined);
          },
        });
        assertImageObservation();
        await useAccountStore.getState().recordAccountOutcome(accountId, 'success');
        assertImageObservation();
        await useTaskStore.getState().completeAutomation(taskId, accountId, outputs[0], outputs, task.runtime?.runId);
        submittedImagePagesRef.current.delete(taskId);
        message.success('原图片会话产物已只读恢复，未重新生成');
        return;
      }
      const lastVideoDiagnostics = new Map<string, string>();
      const recordVideoDiagnostic = (diagnostic: VideoArtifactReadbackDiagnostic): void => {
        const serialized = JSON.stringify(diagnostic);
        if (serialized === lastVideoDiagnostics.get(diagnostic.stage)) return;
        lastVideoDiagnostics.set(diagnostic.stage, serialized);
        // 只保存本轮消息顺序和卡片计数，避免长期观察失败时丢失具体原因。
        void window.electronAPI.logs.append({ level: 'info', scope: 'automation', taskId, accountId,
          message: '原视频产物只读诊断 ' + serialized }).catch((): void => undefined);
      };
      let conversationMatched = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        if (isSameDoubaoConversation(webview.getURL(), conversationUrl)) {
          const matched = (task.petstory || task.promptReadback === 'exact') && task.mode === 'video'
            ? inspectCreationReadback(await getCreationReadbackSnapshot(webview, {
              conversationUrl, signal: observationSignal, ensureCurrent: (): void => { if (!originalContextIsCurrent()) throw new Error('原视频运行已变化，停止读取历史'); },
            }), task.prompt, task.mode, 0, task.videoConfig, !!task.runtime?.generationConfirmation,
              taskChatReadbackContext(task, accountId, conversationUrl, webview.getURL())).promptPublished
            : matchesSubmissionConversation(task.prompt, await getConversationText(webview));
          if (matched) {
            conversationMatched = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!conversationMatched) {
        throw new Error('尚未从同步后的原会话读到原请求身份，暂不绑定其他视频，请稍后检查原结果');
      }
      // 已有真实成片优先于历史“待确认”文字；这次读取只用原请求关联的卡片。
      const existingVideo = task.mode === 'video' ? await resolveVideoArtifact(webview, {
        conversationUrl, runId: task.runtime?.runId, timeoutMs: 8000, isManual: true, signal: observationSignal,
        sourcePrompt: task.runtime?.input.prompt || task.prompt, readbackContext: taskChatReadbackContext(task, accountId, conversationUrl, webview.getURL()),
        videoConfig: task.videoConfig, generationConfirmationRecorded: !!task.runtime?.generationConfirmation,
        onDiagnostic: recordVideoDiagnostic,
      }) : undefined;
      const confirmation = await inspectGenerationConfirmation(webview);
      if (existingVideo?.status !== 'resolved' && confirmation.state === 'present') {
        const waitingMessage = '平台仍在等待视频生成参数确认；请人工确认后再次执行只读回读，系统不会代答或重发';
        await useTaskStore.getState().updateTaskRuntime(taskId, { expectedRunId: task.runtime?.runId,
          status: 'waiting_generation_confirmation',
          result: waitingMessage,
          errorInfo: { code: 'generation_confirmation_required', message: waitingMessage, recoverable: true, detectedAt: confirmation.detectedAt },
          runtime: {
            stage: 'waiting_generation_confirmation',
            message: waitingMessage,
            lastHeartbeatAt: new Date().toISOString(),
            generationConfirmation: {
              detectedAt: confirmation.detectedAt,
              marker: confirmation.marker || 'confirm_before_generation',
              model: confirmation.model,
              duration: confirmation.duration,
              aspectRatio: confirmation.aspectRatio,
            },
          },
        });
        message.warning(waitingMessage);
        return;
      }
      if (existingVideo?.status !== 'resolved' && task.status === 'waiting_generation_confirmation') {
        const latestConversationText = await getConversationText(webview);
        const generationStartedAt = await getGenerationStartTime(webview);
        const confirmedOriginal = task.petstory && inspectCreationReadback(await getChatPageSnapshot(webview), task.prompt, 'video', 0, task.videoConfig, !!task.runtime?.generationConfirmation,
          taskChatReadbackContext(task, accountId, conversationUrl, webview.getURL())).confirmationPublished;
        const hasConfirmationReceipt = /视频生成已提交|正在生成|生成中|你的视频生成好了/.test(latestConversationText) || generationStartedAt > 0 || confirmedOriginal;
        if (!hasConfirmationReceipt) {
          const waitingMessage = '确认页已不可见，但尚未取得生成回执；任务继续等待，不会自动重发';
          await useTaskStore.getState().updateTaskRuntime(taskId, { expectedRunId: task.runtime?.runId,
            status: 'waiting_generation_confirmation',
            result: waitingMessage,
            errorInfo: { code: 'generation_confirmation_required', message: waitingMessage, recoverable: true, detectedAt: new Date().toISOString() },
            runtime: { stage: 'waiting_generation_confirmation', message: waitingMessage, lastHeartbeatAt: new Date().toISOString() },
          });
          message.warning(waitingMessage);
          return;
        }
        await useTaskStore.getState().updateTaskRuntime(taskId, { expectedRunId: task.runtime?.runId,
          status: 'generating',
          result: '已确认生成，正在只读等待原会话产物',
          runtime: { stage: 'generating', message: '已确认生成，正在只读等待原会话产物', lastHeartbeatAt: new Date().toISOString() },
        });
      }
      // 任务台账只要求绑定平台真实可播放产物；无水印授权属于手动下载能力，
      // 不能把 without_watermark=false 误判为“视频没有生成”。
      const assertOriginalVideoObservation = (requireActive: boolean = true): void => {
        const current = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
        if (!task.runtime?.runId || !task.runtime.submittedAt || current?.assignedAccountId !== accountId
          || current.runtime?.runId !== task.runtime.runId || current.runtime.submittedAt !== task.runtime.submittedAt
          || current.runtime.input.mode !== 'video' || current.runtime.input.prompt !== task.runtime.input.prompt || current.status === 'done'
          || !ownsTaskWebview(taskId, webview)
          || !isSameDoubaoConversation(webview.getURL(), conversationUrl)) throw new Error('原视频运行、账号、输入或会话已变化，停止只读观察');
        if (observationSignal.aborted || requireActive && !['generating', 'manual_submission_observing'].includes(current.status)) throw new DOMException('原视频观察已暂停', 'AbortError');
      };
      assertOriginalVideoObservation(false);
      const observationStartedAt = new Date().toISOString();
      const observingSaved = await useTaskStore.getState().updateTaskRuntime(taskId, { expectedRunId: task.runtime?.runId,
        status: 'manual_submission_observing', result: '正在持续观察原视频会话，不会重新发送', errorInfo: null,
        runtime: { stage: 'manual_submission_observing', message: '正在持续观察原视频会话，不会重新发送', lastHeartbeatAt: observationStartedAt },
      });
      if (!observingSaved) throw new Error('只读观察状态保存未确认，未重新发送');
      assertOriginalVideoObservation();
      let lastConversationSyncAt = Date.now();
      const resolution = await new DoubaoVideoAdapter(webview).observe({
        timeoutMs: task.status === 'waiting_generation_confirmation' || isManualObservation || task.runtime?.acceptanceObservation?.outcome === 'observing' ? 15 * 60_000 : 45_000,
        signal: observationSignal,
        ensureCurrent: assertOriginalVideoObservation,
        initialResolution: existingVideo,
        context: {
            conversationUrl, runId: task.runtime?.runId, isManual: true,
            sourcePrompt: task.runtime?.input.prompt || task.prompt, readbackContext: taskChatReadbackContext(task, accountId, conversationUrl, webview.getURL()),
            videoConfig: task.videoConfig, generationConfirmationRecorded: !!task.runtime?.generationConfirmation,
            onDiagnostic: recordVideoDiagnostic,
        },
        onProgress: async ({ elapsedMs, pollCount, resolution: sample }: VideoArtifactObservationProgress): Promise<void> => {
          // 手机端可能继续确认或追加消息；空闲时同步一次，不清理草稿或干预用户聊天。
          if (Date.now() - lastConversationSyncAt >= 30_000) {
            lastConversationSyncAt = Date.now();
            await synchronizeConversation(webview, conversationUrl, originalContextIsCurrent, 'visibility', observationSignal);
            assertOriginalVideoObservation();
          }
          const blocker = await detectVideoGenerationBlocker(webview, {
            conversationUrl, baselineMessageCount: 0, allowGenerationConfirmation: !!task.runtime?.generationConfirmation,
          });
          if (blocker) throw new VideoObservationPauseError({ status: 'unavailable', reason: `豆包已停止生成：${blocker}`, attempts: [] }, 'platform_rejected');
          const availability = await probeAccountAvailability(webview, account.platform || 'doubao', 'pre_task');
          if (['login_required', 'action_required', 'unavailable'].includes(availability.state)) throw new AccountAvailabilityPauseError(availability.message, availability.reason);
          assertOriginalVideoObservation();
          const current = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
          const heartbeatAt = new Date().toISOString();
          const saved = await useTaskStore.getState().updateTaskRuntime(taskId, { expectedRunId: task.runtime?.runId,
            runtime: { lastHeartbeatAt: heartbeatAt, message: `正在观察原视频产物（${Math.floor(elapsedMs / 1000)} 秒），不会重新发送`,
              executionDiagnostics: { ...current?.runtime?.executionDiagnostics, videoObservation: { status: sample.status, reason: sample.reason,
                source: sample.source, elapsedMs, pollCount, observedAt: heartbeatAt } },
              ...(current?.runtime?.acceptanceObservation?.outcome === 'observing'
                ? { acceptanceObservation: renewObservationLease(current.runtime.acceptanceObservation, heartbeatAt, 60_000) } : {}),
            },
          });
          if (!saved) throw new Error('原视频观察心跳保存失败，已停止且未重新发送');
        },
      });
      if (resolution.status !== 'resolved' || !resolution.url) throw new VideoObservationPauseError(resolution);
      const outputs = [resolution.url];
      assertOriginalVideoObservation();
      if (!submissionReconcileUsageRef.current.has(taskId)) {
        submissionReconcileUsageRef.current.add(taskId);
        await useAccountStore.getState().recordSeedanceUsage(accountId, getVideoQuotaUsageUnits(task.videoConfig?.duration));
      }
      await useAccountStore.getState().recordAccountOutcome(accountId, 'success');
      assertOriginalVideoObservation();
      await useTaskStore.getState().completeAutomation(taskId, accountId, outputs[0], outputs, task.runtime?.runId);
      if (task.petstory?.projectId) {
        try {
          const finalized = await window.electronAPI.petstory.advanceProduction(task.petstory.projectId);
          useTaskStore.getState().reconcileTasks(finalized.taskSnapshots || []);
          acceptProductionSnapshot(task.petstory.projectId, finalized.project);
          if (!finalized.success) message.warning(finalized.error || '原视频已找到，下载或入库尚未完成；可继续收取原视频');
        } catch {
          message.warning('原视频已找到，本地收取暂未完成；请在原镜头继续下载并保存，不需要重新生成');
        }
      }
      message.success('平台产物核对成功，任务台账已恢复完成；未重新发送');
      }, (): Promise<void> => assertNoHumanVerification(accountId, webview), observationController?.signal);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
      if (latest?.status === 'done' || latest?.status === 'cancelled') return;
      if (observationController?.signal.aborted || error instanceof Error && error.name === 'AbortError') {
        if (latest?.runtime?.runId === task.runtime?.runId) await useTaskStore.getState().pauseAutomation(taskId, accountId, '用户已停止原结果观察；平台请求和已有成果保留',
          { expectedRunId: task.runtime?.runId, status: pendingCancellationStatusRef.current.get(taskId) || 'paused', code: 'cancelled', endObservation: true });
        return;
      }
      if (task.mode === 'image' && latest?.status !== task.status) return;
      if (latest?.runtime?.runId !== task.runtime?.runId) {
        message.warning('原运行身份已变化，本次只读结果未写入当前运行');
        return;
      }
      const isManualObservation = task?.status === 'manual_submission_observing';
      const verificationPaused = error instanceof AccountAvailabilityPauseError && error.code === 'human_verification';
      const videoPaused = error instanceof VideoObservationPauseError;
      const pauseMessage = `核对未完成：${reason}；任务保持暂停，未重新发送`;
      await useTaskStore.getState().updateTaskRuntime(taskId, { expectedRunId: task.runtime?.runId,
        status: verificationPaused ? 'waiting_verification' : 'paused',
        result: pauseMessage,
        errorInfo: { code: verificationPaused ? 'human_verification' : videoPaused ? error.code : isManualObservation ? 'manual_review_required' : 'submission_uncertain', message: pauseMessage, recoverable: true, detectedAt: new Date().toISOString() },
        runtime: {
          stage: verificationPaused ? 'waiting_verification' : 'paused', message: pauseMessage, lastHeartbeatAt: new Date().toISOString(),
          ...(videoPaused ? { executionDiagnostics: { ...latest?.runtime?.executionDiagnostics, videoObservation: {
            status: error.code === 'platform_rejected' ? 'rejected' : error.resolution.status, reason: error.resolution.reason, source: error.resolution.source,
            elapsedMs: latest?.runtime?.executionDiagnostics?.videoObservation?.elapsedMs || 0,
            pollCount: latest?.runtime?.executionDiagnostics?.videoObservation?.pollCount || 0, observedAt: new Date().toISOString(),
          } }, ...(latest?.runtime?.acceptanceObservation ? { acceptanceObservation: { ...latest.runtime.acceptanceObservation, outcome: 'manual_review' } } : {}) } : {}),
          ...(error instanceof ChatReadbackRecoveryError && error.evidence ? { chatReadbackReview: {
            runId: task.runtime?.runId || '', checkedAt: new Date().toISOString(), reason: error.evidence.reason || 'reply_not_stable', candidates: error.evidence.candidates,
          } } : {}),
          manualObservation: !verificationPaused && isManualObservation && task.runtime?.manualObservation ? {
            ...task.runtime.manualObservation, lastCheckedAt: new Date().toISOString(), outcome: 'manual_review',
          } : task.runtime?.manualObservation,
        },
      });
      if (verificationPaused) message.warning(pauseMessage);
      else message.error(pauseMessage);
    } finally {
      const ownsObservation = abortControllersRef.current.get(taskId) === observationController;
      if (ownsObservation) {
        abortControllersRef.current.delete(taskId);
      }
      submissionReconcileRef.current.delete(taskId);
      if (ownsObservation && !useTaskStore.getState().tasks.some((other): boolean => other.id !== taskId && tasksExecutionConflict(other, task)
        && ['executing', 'generating', 'manual_submission_observing'].includes(other.status))) useTaskStore.getState().setAccountAutomationState(accountId, 'idle', '', undefined, taskId);
    }
  };
  /** 后台操作先保存只读观察意图；预检提前退出时收回没有观察器的等待状态。 */
  const runSubmissionReconcileSafely = async (event: Event): Promise<void> => {
    const detail = (event as CustomEvent<{ taskId?: string; accountId?: string; runId?: string; submittedAt?: string; verificationCheckedAt?: string; automatic?: boolean }>).detail;
    const taskId = detail?.taskId;
    if (!taskId || submissionReconcileRef.current.has(taskId)) return;
    const initial = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
    if (detail.runId && (initial?.runtime?.runId !== detail.runId || initial.runtime.submittedAt !== detail.submittedAt || initial.assignedAccountId !== detail.accountId)) return;
    if (detail.verificationCheckedAt) {
      const ready = useAccountStore.getState().accounts.find((item): boolean => item.id === detail.accountId)?.health?.availability;
      if (ready?.state !== 'ready' || ready.checkedAt !== detail.verificationCheckedAt) return;
    }
    if (detail.automatic && pendingCancellationStatusRef.current.has(taskId)) return;
    pendingCancellationStatusRef.current.delete(taskId);
    const initialRunId = initial?.runtime?.runId; const initialSubmittedAt = initial?.runtime?.submittedAt;
    const guardedObservation = initial?.status === 'manual_submission_observing'
      && !!initial.runtime?.runId && !!initial.runtime.submittedAt
      && (!!initial.petstory || isBackgroundPetStoryTask(usePetStoryStore.getState().project, taskId, initial));
    const controller = new AbortController();
    abortControllersRef.current.set(taskId, controller);
    let observationFailure = '';
    try {
      // 原执行器正在写盘／释放时，沿同一次恢复等待交接，不能留下无人观察的假等待。
      const handoffDeadline = Date.now() + 10_000;
      while (automationEngine.hasController(taskId)) {
        if (Date.now() >= handoffDeadline) throw new Error('原任务执行器尚未释放，本次只读核对已停止；未重新发送');
        await sleepWithAbort(100, controller.signal);
        const current = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
        if (current?.runtime?.runId !== initialRunId || current?.runtime?.submittedAt !== initialSubmittedAt
          || current?.assignedAccountId !== initial?.assignedAccountId || current?.status !== initial?.status) {
          throw new DOMException('原结果检查已暂停或运行已变化', 'AbortError');
        }
      }
      if (controller.signal.aborted) throw new DOMException('原结果检查已暂停', 'AbortError');
      await handleSubmissionReconcile(event);
    }
    catch (error: unknown) {
      observationFailure = error instanceof Error ? error.message : '原任务结果暂时无法核对';
      const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
      if (controller.signal.aborted && latest && latest.runtime?.runId === initialRunId && latest.assignedAccountId && !['done', 'cancelled'].includes(latest.status)) {
        await useTaskStore.getState().pauseAutomation(taskId, latest.assignedAccountId, '用户已停止原结果观察；平台请求和已有成果保留',
          { expectedRunId: initialRunId, status: pendingCancellationStatusRef.current.get(taskId) || 'paused', code: 'cancelled', endObservation: true });
      } else message.error(observationFailure);
    }
    finally {
      if (abortControllersRef.current.get(taskId) === controller) abortControllersRef.current.delete(taskId);
      // 新运行或已有观察器仍拥有任务时，不覆盖其状态；只收束本次没有启动的观察。
      if (guardedObservation && !abortControllersRef.current.has(taskId) && !pendingCancellationStatusRef.current.has(taskId)) {
        submissionReconcileRef.current.delete(taskId);
        const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
        if (latest?.status === 'manual_submission_observing' && latest.runtime?.runId === initialRunId
          && latest.runtime?.submittedAt === initialSubmittedAt) {
          let verificationPaused = false;
          const accountId = latest.assignedAccountId; const webview = accountId ? getTaskWebview(latest) : undefined;
          if (accountId && webview) {
            try { await assertNoHumanVerification(accountId, webview); }
            catch (error: unknown) {
              if (error instanceof AccountAvailabilityPauseError && error.code === 'human_verification') {
                const current = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
                if (current?.status === 'manual_submission_observing' && current.runtime?.runId === initialRunId && current.runtime?.submittedAt === initialSubmittedAt) await useTaskStore.getState().pauseAutomation(taskId, accountId, error.message, { status: 'waiting_verification', code: error.code });
                verificationPaused = true;
              }
            }
          }
          const unsettled = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
          if (!verificationPaused && unsettled?.status === 'manual_submission_observing' && unsettled.runtime?.runId === initialRunId && unsettled.runtime?.submittedAt === initialSubmittedAt) {
            const reason = observationFailure || '原任务提交尚未核对，请查看豆包对话后继续；未重新发送';
            try {
              const saved = await useTaskStore.getState().updateTaskRuntime(taskId, { status: 'paused',
                errorInfo: { code: 'submission_uncertain', message: reason, recoverable: true, detectedAt: new Date().toISOString() },
                runtime: { stage: 'paused', message: reason, lastHeartbeatAt: new Date().toISOString() } });
              if (!saved) message.error('图片核对暂停状态未保存，请稍后重试');
            } catch { message.error('图片核对暂停状态未保存，请稍后重试'); }
          }
        }
      }
    }
  };
  /** 同一原任务共享真实观察生命周期；停止并释放控制器后再通知制作调度。 */
  const handleSubmissionReconcileSafely = async (event: Event): Promise<void> => {
    const detail = (event as CustomEvent<{ taskId?: string; onSettled?: () => void | Promise<void> }>).detail;
    if (!detail?.taskId) return;
    const taskId = detail.taskId;
    let observation = submissionReconcilePromisesRef.current.get(taskId);
    if (!observation) {
      observation = runSubmissionReconcileSafely(event);
      submissionReconcilePromisesRef.current.set(taskId, observation);
    }
    try { await observation; }
    catch { message.error('原任务结果暂时无法核对；未重新发送'); }
    finally {
      if (submissionReconcilePromisesRef.current.get(taskId) === observation) submissionReconcilePromisesRef.current.delete(taskId);
      await detail.onSettled?.();
    }
  };
  return { handleManualSubmission, handleSubmissionReconcileSafely };
}
