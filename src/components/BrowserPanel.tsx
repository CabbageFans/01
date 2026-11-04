/**
 * src/components/BrowserPanel.tsx
 * 内嵌浏览器面板 — V4 正式版
 *
 * 架构：
 * - 每个账号独立 webview，CSS 显隐控制，切换不销毁
 * - 支持多账号并行自动化 + 同账号任务队列
 * - per-account 执行状态监听，自动路由任务到对应 webview
 */

import { readAcceptedImageOutputs, bindPetStoryReferences, verifyPetStoryReferenceBindings, checkPetStoryPageGuard, readPetStoryComposer, waitForPetStoryImageComposer, waitForPetStoryVideoComposer, uploadPetStoryImages, verifyPetStoryUploads, PetStoryControlError } from '../utils/doubaoBridge';
import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Button, Input, message, Modal, notification, Popover, Switch, Tooltip } from 'antd';
import type { Account, AccountAvailability, AccountAvailabilitySource, Task, TaskUpdateInput } from '../types';
import { useAccountStore } from '../store/useAccountStore';
import { useTaskStore } from '../store/useTaskStore';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { isBackgroundPetStoryTask } from '../utils/petstoryBackground';
import type { BackgroundPageSubmission, CreationModeEntryDiagnostic, VideoArtifactReadbackDiagnostic } from '../utils/doubaoBridge';
import { readPetStoryConversationReplies } from '../utils/petstoryConversationReplies';
import type { PetStoryConversationReply } from '@doubao-studio/contracts';
import type { AutomationState } from '../store/useTaskStore';
import { classifyTaskError } from '../utils/taskRuntime';
import { evaluateVideoCapability, isRestrictionFailure } from '../utils/videoCapability';
import { canSelectAccount, findInteractiveAccountId } from '../utils/interactiveAccount';
import { automationEngine } from '../automation/AutomationEngine';
import { runAdapterSelfCheck } from '../automation/doubaoAdapter';
import {
  injectPrompt,
  verifyPromptReadyForSubmission,
  preparePageSubmission,
  submitPromptOnce,
  inspectMaterialAuthorization,
  confirmMaterialAuthorizationIfAllowed,
  inspectGenerationConfirmation,
  checkGeneratingDetailed,
  getResultUrl,
  switchMode,
  waitForChatReady,
  clickAITab,
  configureVideoOptions,
  uploadReferenceImages,
  uploadReferenceAudio,
  resetVideoCaptureCache,
  detectVideoGenerationBlocker,
  injectGenerationMonitor,
  getGenerationStartTime,
  getConversationText,
  getChatPageSnapshot,
  getCreationReadbackSnapshot,
  getCurrentCreationConversation,
  readStableChatAnswer,
  ChatReadbackRecoveryError,
  getSubmissionMessageCount,
  getSubmissionEvidence,
  startNewConversation,
  ensurePlainChatComposer,
  detectRobotVerification,
  resolveVideoArtifact,
  manualResolveVideoArtifact,
  waitForSubmissionControlsStable,
  dismissKnownDesktopDownloadPromotion,
} from '../utils/doubaoBridge';
import type { VideoArtifactResolution } from '../utils/videoArtifactResolver';
import { observeVideoArtifact } from '../utils/videoArtifactObservation';
import { conversationSyncPageSnapshotScript, syncTaskConversation } from '../utils/conversationSync';
import type { ConversationSyncPageSnapshot, ConversationSyncResult } from '../utils/conversationSync';
import type { VideoArtifactObservationProgress } from '../utils/videoArtifactObservation';
import {
  canAttemptSubmission,
  classifySubmissionReadback,
  evaluateTerminal,
  matchesSubmissionConversation,
  requiresSubmissionReconciliation,
  updateStableStreak,
  waitForConfirmedSubmission,
  verifiedSubmissionConversationUrl,
  type SubmissionReadback,
} from '../utils/realSendStateMachine';
import { chatRequestIdentity, diagnoseChatReadback, diagnoseCreationReadback, inspectChatReadback, inspectCreationReadback } from '../utils/chatReadback';
import type { ChatReadbackContext, ChatReadbackResult } from '../utils/chatReadback';
import { SubmittedCreationReadbackContextError, SubmittedCreationReadbackTimeoutError, waitForSubmittedCreationReadback } from '../utils/submittedCreationReadback';
import type { SubmittedCreationReadbackSample } from '../utils/submittedCreationReadback';
import type { CurrentCreationConversationReadback } from '../utils/creationConversationIdentity';
import { mediaSubmissionReceiptFor } from '../utils/mediaSubmissionReceipt';
import { createWebviewResourceScope } from '../utils/webviewLifecycle';
import type { WebviewResourceScope } from '../utils/webviewLifecycle';
import { getVideoQuotaUsageUnits } from '../utils/videoQuota';
import { availabilityBlocksAutomation, probeAccountAvailability } from '../utils/accountAvailability';
import { HumanVerificationRequiredError, observeWithHumanVerification } from '../utils/humanVerification';
import { isExperimentalNoWatermarkEnabled, setExperimentalNoWatermarkEnabled } from '../utils/experimentalNoWatermark';
import { decideMaterialAuthorizationProgress } from '../utils/materialAuthorization';
import type { GenerationConfirmationEvidence } from '../utils/generationConfirmation';
import { createAcceptedObservationBinding, renewObservationLease } from '../utils/acceptedObservation';
import { createVideoReadinessCheckpoint, VideoControlReadinessError } from '../utils/videoControlReadiness';
import { ChatAttachmentUploadError } from '../utils/chatAttachments';
import type { VideoControlReadinessResult, VideoPageReadinessStage } from '../utils/videoControlReadiness';
import { initializationGate } from '../utils/initializationGate';
import type { InitializationLease } from '../utils/initializationGate';
import {
  isSameDoubaoConversation,
  normalizeDoubaoConversationUrl,
  openTaskConversation,
  resolveTaskConversationTarget,
  supportsDoubaoConversationLocator,
  waitForConcreteConversationUrl,
  waitForConversationNavigator,
} from '../utils/taskConversationLocator';
import {
  applyWebviewActivationStyle,
  forceWebviewLayoutRepaint,
  getSupersededLoadingAccountIds,
  getWebviewHydrationAccountIds,
  isWebviewDocumentReady,
} from '../utils/webviewHydration';

/** 页面仅提供轮次事实；账号、运行和完整任务输入必须来自正式任务记录。 */
const taskChatReadbackContext = (task: Task, accountId: string, conversationUrl: string, currentUrl: string): ChatReadbackContext => ({
  taskId: task.id, runId: task.runtime?.runId || '', currentRunId: useTaskStore.getState().tasks.find((item): boolean => item.id === task.id)?.runtime?.runId || '',
  accountId: task.assignedAccountId || '', currentAccountId: accountId, conversationUrl, currentConversationUrl: currentUrl,
  ...(task.runtime?.chatReadback?.runId === task.runtime?.runId ? { userTurnId: task.runtime?.chatReadback?.userTurnId, userMessageId: task.runtime?.chatReadback?.userMessageId } : {}),
});

/** 跨端消息同步必须证明新文档已加载，且不丢弃用户当前输入或交互现场。 */
const conversationSynchronizations = new WeakMap<HTMLWebViewElement, Promise<ConversationSyncResult>>();
const synchronizeConversation = async (webview: HTMLWebViewElement, targetUrl: string, isCurrent: () => boolean,
  trigger: 'explicit' | 'visibility' = 'explicit', signal?: AbortSignal): Promise<ConversationSyncResult> => {
  const previous = conversationSynchronizations.get(webview);
  const operation = (async (): Promise<ConversationSyncResult> => {
    if (previous) await previous;
    return syncTaskConversation({ navigator: webview, targetUrl, isCurrent, trigger, signal,
      readPageSnapshot: (): Promise<ConversationSyncPageSnapshot> => webview.executeJavaScript(conversationSyncPageSnapshotScript()),
    });
  })();
  conversationSynchronizations.set(webview, operation);
  try { return await operation; }
  finally { if (conversationSynchronizations.get(webview) === operation) conversationSynchronizations.delete(webview); }
};

function conversationSyncMessage(result: ConversationSyncResult): string {
  if (result.ok) return '原会话已同步';
  const reasons: Partial<Record<typeof result.reason, string>> = {
    DRAFT_PRESENT: '豆包有未发送草稿，请发送或清除后再检查原结果', ATTACHMENTS_PRESENT: '豆包有未发送附件，请处理后再检查原结果',
    GENERATING: '豆包正在回复，本次保留现场；回复结束后再检查原结果', HUMAN_VERIFICATION: '请先完成原账号人工验证，再检查原结果',
    USER_INTERACTING: '豆包仍在交互中，本次保留现场；结束交互后再检查原结果', CONTEXT_CHANGED: '原任务、账号或会话已变化，请重新检查当前任务',
    PAGE_UNREADABLE: '暂时无法核对豆包输入区，已保留现场，请稍后重试', PAGE_NOT_READY: '豆包页面尚未就绪，请稍后重试',
  };
  return reasons[result.reason] || '原会话同步未完成，请稍后检查原结果';
}

const chatReadbackReceipt = (task: Task, evidence: ChatReadbackResult, baselineMessageCount: number): NonNullable<Task['runtime']>['chatReadback'] => {
  if (!task.runtime?.runId || !evidence.promptPublished || !evidence.association) return undefined;
  return { runId: task.runtime.runId, baselineMessageCount, ...chatRequestIdentity(task.prompt), association: evidence.association,
    userTurnId: evidence.userTurnId, userMessageId: evidence.userMessageId, assistantTurnId: evidence.assistantTurnId, assistantMessageId: evidence.assistantMessageId,
    observedAt: new Date().toISOString() };
};

/** 将当前对话的结构化解析结果转换为用户可读消息。 */
const formatResolutionMessage = (result: VideoArtifactResolution): string => {
  const sourceLabels: Record<string, string> = {
    platform_download_info: '创作空间下载信息',
    play_info: '播放信息接口',
    captured_response: '已拦截响应',
    conversation_scan: '对话页面扫描',
    page_fallback: '页面回退地址',
    experimental: '实验直取（未经官方授权）',
  };
  const statusLabels: Record<string, string> = {
    resolved: '已获取',
    unavailable: '不可用',
    expired: '已过期',
    unauthorized: '无权限或登录失效',
    retryable_error: '可重试错误',
    needs_manual_selection: '需要人工选择',
  };
  const sourceLabel = result.source ? sourceLabels[result.source] || result.source : '';
  const statusLabel = statusLabels[result.status] || result.status;
  return `${statusLabel}${sourceLabel ? `（来源：${sourceLabel}）` : ''}${result.reason ? `：${result.reason}` : ''}`;
};

interface BrowserPanelProps {
  accounts: Account[];
  activeAccount: Account | null;
  refreshKey: number;
  /** 仅用户主动打开辅助浏览器／账号页为 true，用于保护自由聊天输入。 */
  visible?: boolean;
}

function getAccountHome(account: Pick<Account, 'platform'>): string {
  return account.platform === 'dola' ? 'https://www.dola.com/chat' : 'https://www.doubao.com/chat/';
}

function getAccountHost(account: Pick<Account, 'platform'>): string {
  return account.platform === 'dola' ? 'dola.com' : 'doubao.com';
}

function getAccountSessionPartition(account: Pick<Account, 'platform' | 'partition'>): string {
  const platform = account.platform === 'dola' ? 'dola' : 'doubao';
  return `persist:${platform}_${account.partition}`;
}

/** 已经可能产生外部副作用，自动化必须暂停并禁止重试。 */
class SubmissionSafetyPauseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionSafetyPauseError';
  }
}

/** 页面明确需要用户处理；任务进入等待处理态，禁止继续或自动重发。 */
class AccountAvailabilityPauseError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AccountAvailabilityPauseError';
  }
}

/** 平台已收到提示词但要求用户确认参数；永久禁止自动回复确认或重发。 */
class GenerationConfirmationPauseError extends Error {
  constructor(readonly evidence: GenerationConfirmationEvidence) {
    super('平台正在等待视频生成参数确认；请在原豆包会话中人工确认，系统不会代答或重复发送');
    this.name = 'GenerationConfirmationPauseError';
  }
}

function hasAccountChatAdjustment(accountId: string | null | undefined): boolean {
  const current = usePetStoryStore.getState().project;
  return !!accountId && (current?.accountId === accountId && current.chatAdjustment?.status === 'active'
    || useTaskStore.getState().tasks.some((task): boolean => task.assignedAccountId === accountId && task.runtime?.chatAdjustmentGuard?.active === true));
}

/** 只有本人继续的同一未发送修订，才可识别上次执行留下的完整请求草稿。 */
function resumableRepairDraft(task: Task | undefined, prompt: string, selectedReplyRepair: boolean): string | undefined {
  const runtime = task?.runtime;
  if (!selectedReplyRepair || !task || !runtime || task.mode !== 'chat' || task.executionIntent !== 'armed' || task.promptReadback !== 'exact'
    || runtime.attempt < 2 || runtime.input.mode !== 'chat' || runtime.input.prompt !== task.prompt || task.prompt !== prompt
    || runtime.submittedAt || runtime.chatReadback || runtime.chatReadbackReview || runtime.chatResponse || runtime.acceptanceObservation || task.outputs?.length) return undefined;
  return task.prompt;
}

const BrowserPanel: React.FC<BrowserPanelProps> = ({
  accounts,
  activeAccount,
  refreshKey,
  visible = false,
}) => {
  const poolRef = useRef<HTMLDivElement>(null);
  const registryRef = useRef<Map<string, HTMLWebViewElement>>(new Map());
  const loadingMapRef = useRef<Map<string, boolean>>(new Map());
  const runningRef = useRef<Set<string>>(new Set());
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const pendingRestartTasksRef = useRef<Map<string, TaskUpdateInput>>(new Map());
  const pendingCancellationStatusRef = useRef<Map<string, 'paused' | 'cancelled'>>(new Map());
  const manualVideoUsageRef = useRef<Set<string>>(new Set());
  const submissionReconcileRef = useRef<Set<string>>(new Set());
  const submissionReconcilePromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  // 未证明全文的地址只留在本次执行器内存中，供同一原运行只读交接，不充当受理凭据。
  const submittedImagePagesRef = useRef<Map<string, { accountId: string; runId: string; submittedAt: string; webview: HTMLWebViewElement; conversationUrl: string }>>(new Map());
  const passiveConversationSyncRef = useRef<Map<string, number>>(new Map());
  const submissionReconcileUsageRef = useRef<Set<string>>(new Set());
  const availabilityRequestHandledRef = useRef<Record<string, number>>({});
  const availabilityProbeSequenceRef = useRef<Record<string, number>>({});
  /** 启动期后台巡检一次只保留一个临时 Webview，完成后立即释放。 */
  const backgroundProbeRef = useRef<Set<string>>(new Set());
  const backgroundAuditedRef = useRef<Set<string>>(new Set());
  /** 当前预热完成后直接唤醒下一账号；定时轮询仅作为 Electron 漏事件兜底。 */
  const advanceBackgroundWarmupRef = useRef<() => void>(() => undefined);
  /** 每个账号的 webview 监听器与定时器作用域。 */
  const resourceScopesRef = useRef<Map<string, WebviewResourceScope>>(new Map());

  const [activeLoading, setActiveLoading] = useState(true);
  const [loadText, setLoadText] = useState('加载豆包中...');
  /** webview 注册完成时递增，确保已预留的任务会在页面实例出现后重新路由。 */
  const [webviewEpoch, setWebviewEpoch] = useState(0);
  const [manualVideoExtracting, setManualVideoExtracting] = useState(false);
  const [publicShareDialogOpen, setPublicShareDialogOpen] = useState(false);
  const [publicShareUrl, setPublicShareUrl] = useState('');
  const [experimentalNoWatermark, setExperimentalNoWatermark] = useState<boolean>(() => isExperimentalNoWatermarkEnabled());

  /** 实验直取默认关闭；开启时明确提示平台条款与账号风控风险。 */
  const toggleExperimentalNoWatermark = (enabled: boolean): void => {
    if (!enabled) {
      setExperimentalNoWatermarkEnabled(false);
      setExperimentalNoWatermark(false);
      return;
    }
    Modal.confirm({
      title: '开启实验模式：直接提取源文件？',
      content:
        '该模式在豆包官方未开放无水印下载时，尝试从当前对话直接提取源文件。' +
        '可能违反平台条款或触发账号风控，结果也可能仍含水印或无法播放。' +
        '仅对手动提取生效，自动任务不受影响。确定开启？',
      okText: '知晓风险，开启',
      cancelText: '取消',
      onOk: () => {
        setExperimentalNoWatermarkEnabled(true);
        setExperimentalNoWatermark(true);
        message.warning('实验模式已开启，仅手动提取会使用实验通道');
      },
    });
  };

  const accountBusy = useTaskStore((s) => s.accountBusy);
  const accountAutoState = useTaskStore((s) => s.accountAutomationState);
  const accountAutoMsg = useTaskStore((s) => s.accountAutoMessage);
  const executingTasks = useTaskStore((s) => s.executingTasks);
  const tasks = useTaskStore((s) => s.tasks);
  const availabilityCheckRequests = useAccountStore((s) => s.availabilityCheckRequests);

  /** 真实读取指定账号当前页面并持久化可用性；不读取 Cookie 或页面内部身份数据。 */
  const performAvailabilityCheck = useCallback(async (
    accountId: string,
    webview: HTMLWebViewElement,
    source: AccountAvailabilitySource,
  ): Promise<AccountAvailability> => {
    const accountState = useAccountStore.getState();
    const account = accountState.accounts.find((item) => item.id === accountId);
    if (!account) {
      return {
        state: 'unavailable', reason: 'account_missing', message: '账号不存在',
        checkedAt: new Date().toISOString(), source,
      };
    }
    accountState.setAvailabilityChecking(accountId, true);
    const sequence = (availabilityProbeSequenceRef.current[accountId] || 0) + 1;
    availabilityProbeSequenceRef.current[accountId] = sequence;
    try {
      const availability = await probeAccountAvailability(webview, account.platform || 'doubao', source);
      // webview 被刷新/删除时丢弃旧实例的迟到结果。
      if (
        registryRef.current.get(accountId) !== webview ||
        availabilityProbeSequenceRef.current[accountId] !== sequence
      ) return useAccountStore.getState().accounts.find((item): boolean => item.id === accountId)?.health?.availability || {
        state: 'unknown', reason: 'probe_superseded', message: '账号状态已变化，请重新检测', checkedAt: new Date().toISOString(), source,
      };
      const saved = await useAccountStore.getState().setAccountAvailability(accountId, availability);
      if (!saved || availabilityProbeSequenceRef.current[accountId] !== sequence) return useAccountStore.getState().accounts.find((item): boolean => item.id === accountId)?.health?.availability || {
        state: 'unknown', reason: 'probe_not_saved', message: '账号状态尚未保存，请重新检测', checkedAt: new Date().toISOString(), source,
      };
      if (availability.state === 'ready') {
        await useTaskStore.getState().resumeAfterAccountVerification(accountId, availability.checkedAt);
        setTimeout(() => useTaskStore.getState().processQueue(), 0);
      }
      if (source === 'manual') {
        if (availability.state === 'ready') message.success(`${account.name}：检测通过，可执行自动化`);
        else message.warning(`${account.name}：${availability.message}`);
      }
      return availability;
    } finally {
      if (availabilityProbeSequenceRef.current[accountId] === sequence) {
        useAccountStore.getState().setAvailabilityChecking(accountId, false);
      }
    }
  }, []);

  /** 验证只阻断所属账号；保留原 guest／会话供用户处理，不点击验证或刷新页面。 */
  const pauseForHumanVerification = useCallback(async (accountId: string): Promise<never> => {
    // 使此前已发起的 ready 探测失效，不能让它在验证出现后重新开放调度。
    availabilityProbeSequenceRef.current[accountId] = (availabilityProbeSequenceRef.current[accountId] || 0) + 1;
    const accountState = useAccountStore.getState();
    const current = accountState.accounts.find((item): boolean => item.id === accountId)?.health?.availability;
    if (current?.state !== 'action_required' || current.reason !== 'human_verification') {
      await accountState.setAccountAvailability(accountId, {
        state: 'action_required', reason: 'human_verification',
        message: '需要在原账号页面完成人机验证，然后重新检测', checkedAt: new Date().toISOString(), source: 'pre_submit',
      });
    }
    useAccountStore.getState().selectAccount(accountId);
    throw new AccountAvailabilityPauseError('检测到人机验证，请在原账号页面完成人工验证并重新检测；原任务已暂停，系统不会自动重新提交', 'human_verification');
  }, []);

  const assertNoHumanVerification = useCallback(async (accountId: string, webview: HTMLWebViewElement): Promise<void> => {
    if (await detectRobotVerification(webview)) await pauseForHumanVerification(accountId);
  }, [pauseForHumanVerification]);

  /** 启动探测完成后合并提醒，避免多账号逐条弹窗轰炸用户。 */
  const availabilityAlertSignature = accounts
    .filter((account) => ['action_required', 'login_required', 'unavailable'].includes(account.health?.availability?.state || ''))
    .map((account) => `${account.id}:${account.health?.availability?.state}:${account.health?.availability?.reason}`)
    .sort()
    .join('|');
  useEffect(() => {
    const timer = setTimeout(() => {
      const blocked = useAccountStore.getState().accounts.filter((account) =>
        ['action_required', 'login_required', 'unavailable'].includes(account.health?.availability?.state || ''),
      );
      if (blocked.length === 0) {
        notification.destroy('account-availability-summary');
        return;
      }
      const preview = blocked.slice(0, 4).map((account) =>
        `${account.name}：${account.health?.availability?.message || '需要处理'}`,
      ).join('；');
      notification.warning({
        key: 'account-availability-summary',
        message: `${blocked.length} 个账号需要处理`,
        description: `${preview}${blocked.length > 4 ? `；另有 ${blocked.length - 4} 个` : ''}。点击左侧账号进入对应页面处理。`,
        duration: 0,
        placement: 'topRight',
      });
    }, 1200);
    return () => clearTimeout(timer);
  }, [availabilityAlertSignature]);

  const normalizeVideoUrls = (urls: string[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of urls) {
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (!trimmed || !/^https?:\/\//i.test(trimmed)) continue;
      const lower = trimmed.toLowerCase();
      const isImageOnly = /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(lower) || lower.includes('image') || lower.includes('poster');
      const isLikelyVideo =
        /\.(mp4|mov|m4v|webm|m3u8)(\?|#|$)/i.test(lower) ||
        lower.includes('video') ||
        lower.includes('vod') ||
        lower.includes('play') ||
        lower.includes('mime_type=video') ||
        lower.includes('lr=');
      if (isImageOnly && !isLikelyVideo) continue;
      if (!isLikelyVideo) continue;
      // 下载豆包明确返回的原始 URL；禁止通过改写查询参数伪装成无水印地址。
      const clean = trimmed;
      if (!seen.has(clean)) {
        seen.add(clean);
        result.push(clean);
      }
    }
    return result;
  };

  const extractVideoOutputs = async (webview: HTMLWebViewElement, conversationUrl?: string, signal?: AbortSignal, taskId?: string): Promise<string[]> => {
    const original = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
    const verifyOriginalConversation = (): void => {
      if (conversationUrl && !isSameDoubaoConversation(webview.getURL(), conversationUrl)) {
        throw new SubmissionSafetyPauseError('原视频会话已变化，已停止观察且未绑定其他会话产物；系统不会重发');
      }
      if (original && useTaskStore.getState().tasks.find((item): boolean => item.id === taskId)?.runtime?.runId !== original.runtime?.runId) throw new SubmissionSafetyPauseError('原视频运行已变化，停止绑定产物');
    };
    verifyOriginalConversation();
    // 使用结构化解析器，优先获取平台明确返回的原始媒体地址
    const result = await resolveVideoArtifact(webview, {
      conversationUrl: conversationUrl || webview.getURL(),
      timeoutMs: 12000,
      signal,
      ...(original?.runtime?.submittedAt && original.assignedAccountId && conversationUrl ? {
        sourcePrompt: original.runtime.input.prompt, readbackContext: taskChatReadbackContext(original, original.assignedAccountId, conversationUrl, webview.getURL()),
        videoConfig: original.videoConfig, generationConfirmationRecorded: !!original.runtime.generationConfirmation,
      } : {}),
    });
    verifyOriginalConversation();
    if (result.status === 'resolved' && result.url) {
      console.log(`[extractVideoOutputs] 解析成功，来源: ${result.source}, vid: ${result.vid || 'N/A'}`);
      return normalizeVideoUrls([result.url]);
    }
    console.warn(`[extractVideoOutputs] 解析失败: ${result.status} - ${result.reason}`);
    return [];
  };

  const activeAutoState: AutomationState | undefined = activeAccount
    ? accountAutoState[activeAccount.id]
    : undefined;
  const activeAutoMsg = activeAccount ? (accountAutoMsg[activeAccount.id] || '') : '';

  // ---- 组件卸载时清理所有 webview 资源与执行控制器 ----
  useEffect(() => {
    const resourceScopes = resourceScopesRef.current;
    const registry = registryRef.current;
    const loadingMap = loadingMapRef.current;
    const controllers = abortControllersRef.current;
    const runningAccounts = runningRef.current;
    return () => {
      resourceScopes.forEach((scope) => scope.dispose());
      resourceScopes.clear();
      registry.forEach((webview) => webview.remove());
      registry.clear();
      loadingMap.clear();
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
      runningAccounts.clear();
      console.log('[BrowserPanel] 组件卸载，已清理全部 webview 资源');
    };
  }, []);

  // 已可能提交的任务只能沿原会话只读核对产物，绝不重新注入或点击发送。
  useEffect(() => {
    const handleManualSubmission = async (event: Event): Promise<void> => {
      const detail = (event as CustomEvent<{ taskId: string; conversationUrl?: string; useCurrentPage?: boolean }>).detail;
      const task = useTaskStore.getState().tasks.find((item) => item.id === detail?.taskId);
      if (!task || task.status === 'done' || !task.assignedAccountId) {
        message.error('任务不存在、已完成或尚未绑定账号，不能进入人工提交观察');
        return;
      }
      const currentWebview = registryRef.current.get(task.assignedAccountId);
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
      await useTaskStore.getState().updateTaskRuntime(task.id, {
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

      if (useTaskStore.getState().tasks.some((other): boolean => other.id !== taskId && other.assignedAccountId === accountId && ['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'].includes(other.status))) {
        throw new Error('原账号还有其他活跃任务，暂不导航或补取');
      }
      if (isBackgroundPetStoryTask(usePetStoryStore.getState().project, taskId, task) && visibleRef.current
        && useAccountStore.getState().selectedAccountId !== accountId) {
        throw new Error('当前正在查看其他豆包对话，请收起后继续收取本次结果');
      }
      if (!canSelectAccount(accountId, findInteractiveAccountId(useTaskStore.getState().accountAutomationState))) throw new Error('另一个账号正在提交，请稍后检查原结果');
      submissionReconcileRef.current.add(taskId);
      useAccountStore.getState().selectAccount(accountId);
      const webview = await waitForConversationNavigator(
        () => registryRef.current.get(accountId),
        { timeoutMs: 20_000, isReady: () => loadingMapRef.current.get(accountId) === false,
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
          && current.assignedAccountId === accountId && registryRef.current.get(accountId) === webview
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
        const evidence = inspectCreationReadback(snapshot, task.prompt, 'image', 0);
        const diagnostic = JSON.stringify(diagnoseCreationReadback(snapshot, task.prompt, 'image'));
        if (diagnostic !== lastImageDiagnostic) {
          lastImageDiagnostic = diagnostic;
          void window.electronAPI.logs.append({ level: 'info', scope: 'automation', taskId, accountId,
            message: '原图片提交只读诊断 ' + diagnostic }).catch((): void => undefined);
        }
        return { url: concreteUrl || observedUrl, evidence };
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
          if (task.mode === 'image') {
            const located = await waitForSubmittedCreationReadback({
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
            if (!verifiedUrl) throw new Error('原图片任务输入或会话身份不符，未绑定其他结果');
            const saved = await useTaskStore.getState().updateTaskRuntime(taskId, { runtime: { conversationUrl: verifiedUrl, ...(receipt ? { mediaSubmissionReceipt: receipt } : {}) } });
            assertOriginalContext();
            conversationTarget = resolveTaskConversationTarget(useTaskStore.getState().tasks.find((item): boolean => item.id === taskId));
            if (!saved || !conversationTarget.ok) throw new Error('原图片会话地址保存未确认，未重新发送');
            imageIdentityVerified = true;
          } else {
            const currentUrl = normalizeDoubaoConversationUrl(webview.getURL());
            if (!currentUrl) throw new Error('当前页面尚无具体原会话，保持暂停且不重发');
            const snapshot = task.mode === 'video' ? await getCreationReadbackSnapshot(webview, {
              conversationUrl: currentUrl, signal: observationController?.signal,
              ensureCurrent: (): void => {
                const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
                if (latest?.assignedAccountId !== accountId || latest.runtime?.runId !== task.runtime?.runId || latest.runtime?.submittedAt !== task.runtime?.submittedAt) throw new Error('原视频运行已变化');
              },
            }) : await getChatPageSnapshot(webview);
            const evidence = task.mode === 'chat' ? inspectChatReadback(snapshot, task.prompt, 0)
              : inspectCreationReadback(snapshot, task.prompt, 'video', 0, task.videoConfig, !!task.runtime?.generationConfirmation,
                task.mode === 'video' ? taskChatReadbackContext(task, accountId, currentUrl, webview.getURL()) : undefined);
            const latest = useTaskStore.getState().tasks.find((item) => item.id === taskId);
            const verifiedUrl = verifiedSubmissionConversationUrl(task, latest, accountId, currentUrl, webview.getURL(), evidence);
            if (observationController?.signal.aborted || !verifiedUrl) {
              if (!evidence.promptPublished && task.mode === 'chat') console.warn('[ChatReadbackMismatch]', JSON.stringify(diagnoseChatReadback(snapshot, task.prompt)));
              if (task.mode === 'video') await window.electronAPI.logs.append({ level: 'warn', scope: 'automation', taskId, accountId,
                message: '创作只读定位诊断 ' + JSON.stringify({ readback: diagnoseCreationReadback(snapshot, task.prompt, task.mode, task.videoConfig,
                  task.mode === 'video' ? taskChatReadbackContext(task, accountId, currentUrl, webview.getURL()) : undefined),
                  verifiedUrl: !!verifiedUrl, inputSame: JSON.stringify(task.runtime?.input) === JSON.stringify(latest?.runtime?.input),
                  promptInputMatches: latest?.runtime?.input.prompt === latest?.prompt, attachmentsMatch: JSON.stringify(latest?.runtime?.input.attachments || []) === JSON.stringify(latest?.attachments || []),
                  configMatches: JSON.stringify(latest?.runtime?.input.videoConfig) === JSON.stringify(latest?.videoConfig),
                  bindingMatches: JSON.stringify(latest?.runtime?.input.petstory) === JSON.stringify(latest?.petstory), runMatches: latest?.runtime?.runId === task.runtime?.runId,
                  submittedMatches: latest?.runtime?.submittedAt === task.runtime?.submittedAt }) });
              submissionReconcileRef.current.delete(taskId);
              throw new Error('当前 Chat 不唯一匹配原任务或运行已变化；未绑定、未重发');
            }
            const saved = await useTaskStore.getState().updateTaskRuntime(taskId, { runtime: { conversationUrl: verifiedUrl } });
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
      await useTaskStore.getState().updateTaskRuntime(taskId, { runtime: { message: '正在核对原豆包会话结果，不会重新发送', lastHeartbeatAt: syncStartedAt } });
      if (task.mode === 'image' && task.runtime?.mediaSubmissionReceipt && !isSameDoubaoConversation(webview.getURL(), conversationTarget.url)) {
        const page = await getCurrentCreationConversation(webview, { signal: observationController?.signal, ensureCurrent: assertOriginalContext });
        assertOriginalContext();
        if (page.conversationUrl && isSameDoubaoConversation(page.conversationUrl, conversationTarget.url)) imageIdentityVerified = true;
      }
      // 图片正在生成时直接观察已定位的原页；刷新会打断现场并被 GENERATING 保护拒绝。
      if (task.mode !== 'image' || !imageIdentityVerified && !isSameDoubaoConversation(webview.getURL(), conversationTarget.url)) {
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
      useTaskStore.getState().setAccountAutomationState(accountId, 'generating', '正在核对平台结果（不会重新发送）...');
      try {
        await observeWithHumanVerification(async (observationSignal: AbortSignal): Promise<void> => {
        if (task.runtime?.acceptanceObservation?.outcome === 'observing') {
          const heartbeatAt = new Date().toISOString();
          const renewed = renewObservationLease(task.runtime.acceptanceObservation, heartbeatAt, 60_000);
          const renewedOk = await useTaskStore.getState().updateTaskRuntime(taskId, {
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
              if (!receipt || !await useTaskStore.getState().updateTaskRuntime(taskId, { runtime: { chatReadback: receipt } })) throw new Error('原消息轮次保存未确认');
            },
          });
          const verifiedReceipt = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId)?.runtime?.chatReadback;
          if (verifiedReceipt?.runId !== task.runtime.runId) throw new Error('原消息轮次身份变化；本次正文未绑定');
          const saved = await useTaskStore.getState().updateTaskRuntime(taskId, {
            runtime: { chatReadback: verifiedReceipt, chatResponse: { text: raw, capturedAt: new Date().toISOString() } },
          });
          if (!saved) throw new Error('正文保存未确认，保留原任务且不重发');
          await useTaskStore.getState().completeAutomation(taskId, accountId, '', []);
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
          if (!imageIdentityVerified && !task.runtime?.mediaSubmissionReceipt) await waitForSubmittedCreationReadback({
            signal: observationSignal, ensureCurrent: assertImageObservation,
            wait: (ms: number): Promise<void> => sleepWithAbort(ms, observationSignal),
            read: (): Promise<SubmittedCreationReadbackSample> => readOriginalImageEvidence(observationSignal),
          });
          assertImageObservation();
          const receipt = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId)?.runtime?.mediaSubmissionReceipt;
          const outputs = await readAcceptedImageOutputs(webview, conversationUrl, observationSignal, undefined, {
            prompt: task.runtime?.input.prompt || task.prompt, runId: task.runtime?.runId || '', userMessageId: receipt?.userMessageId, userTurnId: receipt?.userTurnId,
          }, { ensureCurrent: assertImageObservation });
          assertImageObservation();
          await useAccountStore.getState().recordAccountOutcome(accountId, 'success');
          assertImageObservation();
          await useTaskStore.getState().completeAutomation(taskId, accountId, outputs[0], outputs);
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
        let existingVideo = task.mode === 'video' ? await resolveVideoArtifact(webview, {
          conversationUrl, runId: task.runtime?.runId, timeoutMs: 8000, isManual: true, signal: observationSignal,
          sourcePrompt: task.runtime?.input.prompt || task.prompt, readbackContext: taskChatReadbackContext(task, accountId, conversationUrl, webview.getURL()),
          videoConfig: task.videoConfig, generationConfirmationRecorded: !!task.runtime?.generationConfirmation,
          onDiagnostic: recordVideoDiagnostic,
        }) : undefined;
        const confirmation = await inspectGenerationConfirmation(webview);
        if (existingVideo?.status !== 'resolved' && confirmation.state === 'present') {
          const waitingMessage = '平台仍在等待视频生成参数确认；请人工确认后再次执行只读回读，系统不会代答或重发';
          await useTaskStore.getState().updateTaskRuntime(taskId, {
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
            await useTaskStore.getState().updateTaskRuntime(taskId, {
              status: 'waiting_generation_confirmation',
              result: waitingMessage,
              errorInfo: { code: 'generation_confirmation_required', message: waitingMessage, recoverable: true, detectedAt: new Date().toISOString() },
              runtime: { stage: 'waiting_generation_confirmation', message: waitingMessage, lastHeartbeatAt: new Date().toISOString() },
            });
            message.warning(waitingMessage);
            return;
          }
          await useTaskStore.getState().updateTaskRuntime(taskId, {
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
            || registryRef.current.get(accountId) !== webview
            || !isSameDoubaoConversation(webview.getURL(), conversationUrl)) throw new Error('原视频运行、账号、输入或会话已变化，停止只读观察');
          if (observationSignal.aborted || requireActive && !['generating', 'manual_submission_observing'].includes(current.status)) throw new DOMException('原视频观察已暂停', 'AbortError');
        };
        assertOriginalVideoObservation(false);
        const observationStartedAt = new Date().toISOString();
        const observingSaved = await useTaskStore.getState().updateTaskRuntime(taskId, {
          status: 'manual_submission_observing', result: '正在持续观察原视频会话，不会重新发送', errorInfo: null,
          runtime: { stage: 'manual_submission_observing', message: '正在持续观察原视频会话，不会重新发送', lastHeartbeatAt: observationStartedAt },
        });
        if (!observingSaved) throw new Error('只读观察状态保存未确认，未重新发送');
        assertOriginalVideoObservation();
        let lastConversationSyncAt = Date.now();
        const resolution = await observeVideoArtifact({
          timeoutMs: task.status === 'waiting_generation_confirmation' || isManualObservation || task.runtime?.acceptanceObservation?.outcome === 'observing' ? 15 * 60_000 : 45_000,
          signal: observationSignal,
          ensureCurrent: assertOriginalVideoObservation,
          resolve: (timeoutMs: number, signal: AbortSignal): Promise<VideoArtifactResolution> => {
            if (existingVideo?.status === 'resolved') { const result = existingVideo; existingVideo = undefined; return Promise.resolve(result); }
            return resolveVideoArtifact(webview, {
              conversationUrl, runId: task.runtime?.runId, timeoutMs, isManual: true, signal,
              sourcePrompt: task.runtime?.input.prompt || task.prompt, readbackContext: taskChatReadbackContext(task, accountId, conversationUrl, webview.getURL()),
              videoConfig: task.videoConfig, generationConfirmationRecorded: !!task.runtime?.generationConfirmation,
              onDiagnostic: recordVideoDiagnostic,
            });
          },
          onProgress: async ({ elapsedMs }: VideoArtifactObservationProgress): Promise<void> => {
            // 手机端可能继续确认或追加消息；空闲时同步一次，不清理草稿或干预用户聊天。
            if (Date.now() - lastConversationSyncAt >= 30_000) {
              lastConversationSyncAt = Date.now();
              await synchronizeConversation(webview, conversationUrl, originalContextIsCurrent, 'visibility', observationSignal);
              assertOriginalVideoObservation();
            }
            const blocker = await detectVideoGenerationBlocker(webview, {
              conversationUrl, baselineMessageCount: 0, allowGenerationConfirmation: !!task.runtime?.generationConfirmation,
            });
            if (blocker) throw new Error(`豆包已停止生成：${blocker}`);
            const availability = await probeAccountAvailability(webview, account.platform || 'doubao', 'pre_task');
            if (['login_required', 'action_required', 'unavailable'].includes(availability.state)) throw new AccountAvailabilityPauseError(availability.message, availability.reason);
            assertOriginalVideoObservation();
            const current = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
            const heartbeatAt = new Date().toISOString();
            const saved = await useTaskStore.getState().updateTaskRuntime(taskId, {
              runtime: { lastHeartbeatAt: heartbeatAt, message: `正在观察原视频产物（${Math.floor(elapsedMs / 1000)} 秒），不会重新发送`,
                ...(current?.runtime?.acceptanceObservation?.outcome === 'observing'
                  ? { acceptanceObservation: renewObservationLease(current.runtime.acceptanceObservation, heartbeatAt, 60_000) } : {}),
              },
            });
            if (!saved) throw new Error('原视频观察心跳保存失败，已停止且未重新发送');
          },
        });
        const outputs = resolution.status === 'resolved' && resolution.url
          ? normalizeVideoUrls([resolution.url])
          : [];
        if (outputs.length === 0) {
          const pendingMessage = isManualObservation
            ? `人工提交观察已到达本轮上限，仍未读取到唯一匹配产物；请人工复核（${formatResolutionMessage(resolution)}）`
            : `平台已确认提交，暂未读取到产物；请稍后再次核对（${formatResolutionMessage(resolution)}）`;
          await useTaskStore.getState().updateTaskRuntime(taskId, {
            status: 'paused',
            result: pendingMessage,
            errorInfo: { code: isManualObservation ? 'manual_review_required' : 'submission_uncertain', message: pendingMessage, recoverable: true, detectedAt: new Date().toISOString() },
            runtime: {
              stage: 'paused', message: pendingMessage, lastHeartbeatAt: new Date().toISOString(),
              manualObservation: isManualObservation && task.runtime?.manualObservation ? {
                ...task.runtime.manualObservation, lastCheckedAt: new Date().toISOString(), outcome: 'manual_review',
              } : task.runtime?.manualObservation,
            },
          });
          message.warning(pendingMessage);
          return;
        }
        assertOriginalVideoObservation();
        if (!submissionReconcileUsageRef.current.has(taskId)) {
          submissionReconcileUsageRef.current.add(taskId);
          await useAccountStore.getState().recordSeedanceUsage(accountId, getVideoQuotaUsageUnits(task.videoConfig?.duration));
        }
        await useAccountStore.getState().recordAccountOutcome(accountId, 'success');
        assertOriginalVideoObservation();
        await useTaskStore.getState().completeAutomation(taskId, accountId, outputs[0], outputs);
        message.success('平台产物核对成功，任务台账已恢复完成；未重新发送');
        }, (): Promise<void> => assertNoHumanVerification(accountId, webview), observationController?.signal);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
        if (latest?.status === 'done') return;
        if (observationController?.signal.aborted && latest && ['paused', 'cancelled', 'waiting_verification'].includes(latest.status)) return;
        if (task.mode === 'image' && latest?.status !== task.status) return;
        if (latest?.runtime?.runId !== task.runtime?.runId) {
          message.warning('原运行身份已变化，本次只读结果未写入当前运行');
          return;
        }
        const isManualObservation = task?.status === 'manual_submission_observing';
        const verificationPaused = error instanceof AccountAvailabilityPauseError && error.code === 'human_verification';
        const pauseMessage = `核对未完成：${reason}；任务保持暂停，未重新发送`;
        await useTaskStore.getState().updateTaskRuntime(taskId, {
          status: verificationPaused ? 'waiting_verification' : 'paused',
          result: pauseMessage,
          errorInfo: { code: verificationPaused ? 'human_verification' : isManualObservation ? 'manual_review_required' : 'submission_uncertain', message: pauseMessage, recoverable: true, detectedAt: new Date().toISOString() },
          runtime: {
            stage: verificationPaused ? 'waiting_verification' : 'paused', message: pauseMessage, lastHeartbeatAt: new Date().toISOString(),
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
        if (ownsObservation && !useTaskStore.getState().tasks.some((other): boolean => other.id !== taskId && other.assignedAccountId === accountId
          && ['executing', 'generating', 'manual_submission_observing'].includes(other.status))) useTaskStore.getState().setAccountAutomationState(accountId, 'idle', '');
      }
    };
    /** 后台操作先保存只读观察意图；预检提前退出时收回没有观察器的等待状态。 */
    const runSubmissionReconcileSafely = async (event: Event): Promise<void> => {
      const detail = (event as CustomEvent<{ taskId?: string; accountId?: string; runId?: string; submittedAt?: string; verificationCheckedAt?: string }>).detail;
      const taskId = detail?.taskId;
      if (!taskId || submissionReconcileRef.current.has(taskId)) return;
      const initial = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
      if (detail.runId && (initial?.runtime?.runId !== detail.runId || initial.runtime.submittedAt !== detail.submittedAt || initial.assignedAccountId !== detail.accountId)) return;
      if (detail.verificationCheckedAt) {
        const ready = useAccountStore.getState().accounts.find((item): boolean => item.id === detail.accountId)?.health?.availability;
        if (ready?.state !== 'ready' || ready.checkedAt !== detail.verificationCheckedAt) return;
      }
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
      catch (error: unknown) { observationFailure = error instanceof Error ? error.message : '原任务结果暂时无法核对'; message.error(observationFailure); }
      finally {
        if (abortControllersRef.current.get(taskId) === controller) abortControllersRef.current.delete(taskId);
        // 新运行或已有观察器仍拥有任务时，不覆盖其状态；只收束本次没有启动的观察。
        if (guardedObservation && !abortControllersRef.current.has(taskId)) {
          submissionReconcileRef.current.delete(taskId);
          const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
          if (latest?.status === 'manual_submission_observing' && latest.runtime?.runId === initialRunId
            && latest.runtime?.submittedAt === initialSubmittedAt) {
            let verificationPaused = false;
            const accountId = latest.assignedAccountId; const webview = accountId ? registryRef.current.get(accountId) : undefined;
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
    window.addEventListener('mark-manual-submission', handleManualSubmission);
    window.addEventListener('reconcile-task-submission', handleSubmissionReconcileSafely);
    return () => {
      window.removeEventListener('mark-manual-submission', handleManualSubmission);
      window.removeEventListener('reconcile-task-submission', handleSubmissionReconcileSafely);
    };
  }, [assertNoHumanVerification, performAvailabilityCheck]);

  /** 幂等释放指定账号的 webview、监听器和定时器。 */
  const disposeAccountWebview = (accountId: string): void => {
    for (const [taskId, page] of submittedImagePagesRef.current) if (page.accountId === accountId) submittedImagePagesRef.current.delete(taskId);
    resourceScopesRef.current.get(accountId)?.dispose();
    resourceScopesRef.current.delete(accountId);
    const webview = registryRef.current.get(accountId);
    if (webview) {
      webview.remove();
      registryRef.current.delete(accountId);
    }
    loadingMapRef.current.delete(accountId);
    const state = useTaskStore.getState();
    const taskIds = new Set(
      state.tasks
        .filter((task) => task.assignedAccountId === accountId)
        .map((task) => task.id),
    );
    const executingTaskId = state.executingTasks[accountId];
    if (executingTaskId) taskIds.add(executingTaskId);
    for (const taskId of taskIds) {
      abortControllersRef.current.get(taskId)?.abort();
      abortControllersRef.current.delete(taskId);
    }
    runningRef.current.delete(accountId);
  };

  // ---- webview 池动态管理（账号增删同步） ----
  const accountsKey = accounts.map(a => a.id).join(',');
  useEffect(() => {
    const container = poolRef.current;
    if (!container) return;

    const accountIds = new Set(accounts.map(a => a.id));

    // 清理已删除账号的 webview 和定时器
    registryRef.current.forEach((webview, accountId) => {
      if (!accountIds.has(accountId)) {
        disposeAccountWebview(accountId);
        console.log(`[BrowserPanel] 已移除账号 ${accountId} 的 webview`);
      }
    });

    // 用户快速切换账号时，只保留最后选择的前台加载。没有执行任务的旧加载页
    // 立即释放，防止多个 Chromium 导航同时堆积并拖死 NetworkService。
    const loadingIds = new Set(
      [...loadingMapRef.current.entries()]
        .filter(([, loading]) => loading)
        .map(([accountId]) => accountId),
    );
    const supersededIds = getSupersededLoadingAccountIds(
      [...registryRef.current.keys()],
      loadingIds,
      activeAccount?.id || null,
      executingTasks,
    );
    for (const accountId of supersededIds) {
      backgroundProbeRef.current.delete(accountId);
      disposeAccountWebview(accountId);
    }

    // 启动时只挂载当前账号，避免十几个账号同时访问平台后留下黑屏。
    // 已经进入执行态的后台账号必须同时挂载；其余账号在用户切换时按需创建。
    const hydrationIds = getWebviewHydrationAccountIds(
      accounts,
      activeAccount?.id || null,
      executingTasks,
    );
    for (const accountId of hydrationIds) {
      const account = accounts.find((item) => item.id === accountId);
      if (account) createWebview(account, container);
    }

    // 确保当前活跃账号的加载状态同步
    if (activeAccount) {
      const isLoading = loadingMapRef.current.get(activeAccount.id);
      setActiveLoading(!!isLoading);
      if (!isLoading) setLoadText('');
      console.log(`[BrowserPanel] webview 池同步完成 (当前 ${registryRef.current.size} 个), activeAccount=${activeAccount.id}, isLoading=${isLoading}`);
    } else {
      console.log(`[BrowserPanel] webview 池同步完成 (当前 ${registryRef.current.size} 个), 无活跃账号`);
    }
  }, [accountsKey, refreshKey, activeAccount?.id, executingTasks]);

  // ---- 创建单个 webview ----
  const createWebview = (account: Account, container: HTMLDivElement) => {
    if (registryRef.current.has(account.id)) return;

    const accId = account.id;
    const scope = createWebviewResourceScope();
    resourceScopesRef.current.set(accId, scope);
    loadingMapRef.current.set(accId, true);

    const webview = document.createElement('webview') as HTMLWebViewElement;
    // partition 必须在首次导航前固定；先设置隔离分区，再设置地址。
    webview.setAttribute('partition', getAccountSessionPartition(account));
    webview.setAttribute('src', getAccountHome(account));
    webview.style.cssText = 'width:100%;height:100%;border:none;position:absolute;top:0;left:0;visibility:visible;';
    // 首次创建发生在 hydration effect 内；不要等待另一个 effect 才激活当前页，
    // 否则 guest 可能以透明状态启动并被 Chromium 延迟合成或加载。
    applyWebviewActivationStyle(
      webview.style,
      useAccountStore.getState().selectedAccountId === accId,
    );

    let pollInterval: ReturnType<typeof setInterval> | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let availabilityTimer: ReturnType<typeof setTimeout> | undefined;
    let availabilitySettleTimer: ReturnType<typeof setTimeout> | undefined;
    let availabilityFinalTimer: ReturnType<typeof setTimeout> | undefined;
    let warmupReleaseTimer: ReturnType<typeof setTimeout> | undefined;
    let activeLoadRecoveryAttempts = 0;

    const finishBackgroundProbe = (): void => {
      if (!backgroundProbeRef.current.has(accId)) return;
      backgroundProbeRef.current.delete(accId);
      backgroundAuditedRef.current.add(accId);
      queueMicrotask(() => advanceBackgroundWarmupRef.current());
    };

    const runAvailabilityCheck = async (source: AccountAvailabilitySource): Promise<void> => {
      const availability = await performAvailabilityCheck(accId, webview, source);
      if (availability.state === 'action_required' && availability.reason === 'human_verification') return;
      const dismissed = await dismissKnownDesktopDownloadPromotion(webview);
      if (dismissed === 'failed') {
        console.warn(`[BrowserPanel] ${accId} 下载电脑版推广弹窗未能安全关闭`);
      }
      if (dismissed === 'dismissed') await performAvailabilityCheck(accId, webview, source);
    };

    const scheduleAvailabilityCheck = (source: AccountAvailabilitySource, delayMs: number = 600): void => {
      scope.clearTimer(availabilityTimer);
      scope.clearTimer(availabilitySettleTimer);
      scope.clearTimer(availabilityFinalTimer);
      availabilityTimer = setTimeout(() => {
        if (!scope.active || registryRef.current.get(accId) !== webview) return;
        void runAvailabilityCheck(source);
      }, delayMs);
      scope.trackTimer(availabilityTimer);
      // 豆包 SPA 常在 dom-ready 后数秒才渲染“登录”/验证层。第二次稳定化检测
      // 防止把匿名页先出现的输入框误判为已登录。
      availabilitySettleTimer = setTimeout(() => {
        if (!scope.active || registryRef.current.get(accId) !== webview) return;
        void runAvailabilityCheck(source);
      }, Math.max(3500, delayMs + 3000));
      scope.trackTimer(availabilitySettleTimer);
      // 多账号同时打开时，隐藏 webview 的账号壳可能需要更长时间才稳定。
      availabilityFinalTimer = setTimeout(() => {
        if (!scope.active || registryRef.current.get(accId) !== webview) return;
        void runAvailabilityCheck(source).finally(finishBackgroundProbe);
      }, Math.max(15_000, delayMs + 12_000));
      scope.trackTimer(availabilityFinalTimer);
    };

    // 统一加载完成处理
    const markLoaded = (evt: string) => {
      if (!scope.active) return;
      if (!loadingMapRef.current.get(accId)) return; // 已标记完成，不重复处理
      loadingMapRef.current.set(accId, false);
      scope.clearTimer(pollInterval);
      scope.clearTimer(timeoutId);
      console.log(`[BrowserPanel] markLoaded: ${accId} via ${evt}`);
      const cur = useAccountStore.getState().selectedAccountId;
      if (accId === cur) {
        setLoadText('正在显示账号页面...');
        void forceWebviewLayoutRepaint(webview).finally(() => {
          if (!scope.active || useAccountStore.getState().selectedAccountId !== accId) return;
          if (loadingMapRef.current.get(accId)) return;
          setActiveLoading(false);
          setLoadText('');
        });
      }
      if (backgroundProbeRef.current.has(accId)) {
        scope.clearTimer(warmupReleaseTimer);
        // 只保留一个很短的稳定窗口，随后由完成事件直接串行启动下一账号。
        // 可用性复检继续在后台执行，不再阻塞整个账号池的预热。
        warmupReleaseTimer = setTimeout(finishBackgroundProbe, 250);
        scope.trackTimer(warmupReleaseTimer);
      }
    };

    scope.listen(webview, 'did-start-loading', () => {
      if (!scope.active) return;
      // 稳定窗口内再次导航说明页面尚未真正就绪，禁止提前并发下一账号。
      scope.clearTimer(warmupReleaseTimer);
      loadingMapRef.current.set(accId, true);
      const cur = useAccountStore.getState().selectedAccountId;
      if (accId === cur) {
        setActiveLoading(true);
        setLoadText('页面加载中...');
      }
    });

    scope.listen(webview, 'did-finish-load', () => { markLoaded('did-finish-load'); scheduleAvailabilityCheck('navigation'); });
    scope.listen(webview, 'did-stop-loading', () => { markLoaded('did-stop-loading'); scheduleAvailabilityCheck('navigation'); });
    // did-navigate 只代表主文档地址变化，豆包 SPA 此时可能仍是空壳；不能提前撤掉加载层。
    scope.listen(webview, 'did-navigate', () => undefined);
    scope.listen(webview, 'did-navigate-in-page', () => { scheduleAvailabilityCheck('navigation'); });
    scope.listen(webview, 'dom-ready', () => {
      activeLoadRecoveryAttempts = 0;
      markLoaded('dom-ready');
      scheduleAvailabilityCheck(account.health?.availability ? 'navigation' : 'startup');
    });
    scope.listen(webview, 'did-fail-load', (rawEvent) => {
      if (!scope.active) return;
      const event = rawEvent as Event & { errorCode?: number; isMainFrame?: boolean };
      // Chromium 导航替换会产生 ERR_ABORTED；子资源失败也不等于主页面不可用。
      if (event.errorCode === -3 || event.isMainFrame === false) return;
      loadingMapRef.current.set(accId, false);
      scope.clearTimers();
      const cur = useAccountStore.getState().selectedAccountId;
      if (accId === cur) {
        setActiveLoading(false);
        setLoadText('加载失败');
        if (activeLoadRecoveryAttempts < 1) {
          activeLoadRecoveryAttempts += 1;
          const recoveryTimer = setTimeout(() => {
            if (!scope.active || registryRef.current.get(accId) !== webview) return;
            if (useAccountStore.getState().selectedAccountId !== accId) return;
            loadingMapRef.current.set(accId, true);
            setActiveLoading(true);
            setLoadText('正在重新加载账号页面...');
            webview.reload();
          }, 1200);
          scope.trackTimer(recoveryTimer);
        }
      }
      void useAccountStore.getState().setAccountAvailability(accId, {
        state: 'unavailable',
        reason: 'network_error',
        message: '页面加载失败，请检查网络后重新检测',
        checkedAt: new Date().toISOString(),
        source: 'navigation',
      }).finally(finishBackgroundProbe);
    });

    container.appendChild(webview);
    registryRef.current.set(accId, webview);
    setWebviewEpoch((value) => value + 1);
    console.log(`[BrowserPanel] webview 已创建: ${accId}, inDOM=${container.contains(webview)}`);

    // 轮询兜底：每 2s 检查一次 webview 是否已加载内容
    // 解决 Electron webview 事件不触发的问题
    let pollRunning = false;
    pollInterval = setInterval(async () => {
      const wv = registryRef.current.get(accId);
      if (!wv || pollRunning) {
        if (!wv) scope.clearTimers();
        return;
      }
      pollRunning = true;
      try {
        const url = wv.getURL?.() || '';
        const isLoaded = loadingMapRef.current.get(accId);
        if (!isLoaded || !url.startsWith('http') || !url.includes(getAccountHost(account))) return;
        const title = (wv as HTMLWebViewElement & { getTitle?: () => string }).getTitle?.() || '';
        if (isWebviewDocumentReady(url, title, getAccountHost(account))) {
          console.log(`[BrowserPanel] 轮询检测到 webview 标题已就绪: ${accId}`);
          markLoaded('poll-title');
          scheduleAvailabilityCheck('navigation');
          return;
        }
        // 超时 race 不会取消 Electron 等待 did-stop-loading 的脚本请求。
        // 保持 pollRunning 到实际请求结束，慢页面只挂一个探测，避免每 2s 累积监听。
        // 下方 60s 定时器仍负责停止轮询和提示，正式加载事件仍可解除加载层。
        const hasDocument = await wv.executeJavaScript(
          'Boolean(document.body && document.body.childElementCount > 0 && document.readyState !== "loading")',
        );
        if (hasDocument) {
          console.log(`[BrowserPanel] 轮询检测到 webview 文档已就绪: ${accId}`);
          markLoaded('poll-document');
          scheduleAvailabilityCheck('navigation');
        }
      } catch {
        // guest 尚未允许执行脚本时继续等待正式加载事件。
      } finally {
        pollRunning = false;
      }
    }, 2000);
    scope.trackTimer(pollInterval);

    // 60s 后停止高频轮询，但保留不透明加载层；后续正式加载事件仍可解除。
    timeoutId = setTimeout(() => {
      scope.clearTimer(pollInterval);
      if (!scope.active) return;
      if (loadingMapRef.current.get(accId)) {
        console.warn(`[BrowserPanel] 60s 超时，账号页面仍未形成可用文档: ${accId}`);
        if (useAccountStore.getState().selectedAccountId === accId) {
          setActiveLoading(true);
          setLoadText('账号页面加载较慢，请稍候或点击刷新');
        }
      }
      scope.clearTimer(timeoutId);
      scope.clearTimer(pollInterval);
    }, 60000);
    scope.trackTimer(timeoutId);
  };

  // 启动后以单通道顺序巡检其余账号。每次只新增一个后台 Webview，完成
  // 稳定化检测后保持常驻；兼顾快速切换和避免 13 个页面同时抢占网络。
  useEffect(() => {
    let disposed = false;
    const startNextWarmup = (): void => {
      if (disposed) return;
      if (backgroundProbeRef.current.size > 0) return;
      if ([...loadingMapRef.current.values()].some(Boolean)) return;
      if (Object.values(useTaskStore.getState().accountBusy).some(Boolean)) return;
      const selectedId = useAccountStore.getState().selectedAccountId;
      const candidate = useAccountStore.getState().accounts.find((account) =>
        account.id !== selectedId &&
        !registryRef.current.has(account.id) &&
        !backgroundAuditedRef.current.has(account.id) &&
        !useTaskStore.getState().executingTasks[account.id],
      );
      const container = poolRef.current;
      if (!candidate || !container) return;
      backgroundProbeRef.current.add(candidate.id);
      createWebview(candidate, container);
    };

    advanceBackgroundWarmupRef.current = startNextWarmup;
    const initialTimer = setTimeout(startNextWarmup, 0);
    // Electron 偶发漏发 guest load 事件时仍能继续，不把正常路径降级成轮询等待。
    const fallbackInterval = setInterval(startNextWarmup, 1000);
    return () => {
      disposed = true;
      clearTimeout(initialTimer);
      clearInterval(fallbackInterval);
      if (advanceBackgroundWarmupRef.current === startNextWarmup) {
        advanceBackgroundWarmupRef.current = () => undefined;
      }
    };
  }, [accountsKey]);

  // 账号菜单中的“立即检测”请求由 BrowserPanel 使用该账号的隔离 webview 执行。
  useEffect(() => {
    for (const [accountId, requestId] of Object.entries(availabilityCheckRequests)) {
      if (!requestId || requestId <= (availabilityRequestHandledRef.current[accountId] || 0)) continue;
      const webview = registryRef.current.get(accountId);
      if (!webview) continue;
      availabilityRequestHandledRef.current[accountId] = requestId;
      void performAvailabilityCheck(accountId, webview, 'manual');
    }
  }, [availabilityCheckRequests, performAvailabilityCheck, webviewEpoch]);

  // 用户正在查看的页面可能在不导航的情况下弹出验证或完成登录。
  // 低频只读复检可及时更新提醒；任务执行期间由 pre_task/pre_submit 专用门禁接管。
  useEffect(() => {
    const accountId = activeAccount?.id;
    if (!accountId) return;
    const recheck = () => {
      if (useTaskStore.getState().accountBusy[accountId]) return;
      const webview = registryRef.current.get(accountId);
      if (webview) void performAvailabilityCheck(accountId, webview, 'navigation');
    };
    const initialTimer = setTimeout(recheck, 2000);
    const interval = setInterval(recheck, 30_000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [activeAccount?.id, performAvailabilityCheck, webviewEpoch]);

  // ---- 切换可见性 ----
  useEffect(() => {
    if (!activeAccount) return;
    registryRef.current.forEach((webview, accountId) => {
      const isActive = accountId === activeAccount.id;
      if (isActive) backgroundProbeRef.current.delete(accountId);
      applyWebviewActivationStyle(webview.style, isActive);
      if (isActive) {
        const isLoading = loadingMapRef.current.get(accountId);
        setActiveLoading(!!isLoading);
        if (!isLoading) {
          setActiveLoading(true);
          setLoadText('正在显示账号页面...');
          void forceWebviewLayoutRepaint(webview).finally(() => {
            if (useAccountStore.getState().selectedAccountId !== accountId) return;
            setActiveLoading(false);
            setLoadText('');
          });
        }
      }
    });
  }, [activeAccount?.id, webviewEpoch]);

  /** 从当前账号的可见对话手动提取视频；实验通道只在显式开关开启时参与。 */
  const handleExtractCurrentVideo = async (): Promise<void> => {
    if (!activeAccount) return;
    const accountId = activeAccount.id;
    const webview = registryRef.current.get(accountId);
    if (!webview) {
      message.error('当前账号页面尚未就绪');
      return;
    }
    if (accountBusy[accountId]) {
      message.warning('当前账号正在执行自动化任务，请等待完成或暂停任务后再提取');
      return;
    }

    setManualVideoExtracting(true);
    useTaskStore.getState().setAccountAutomationState(accountId, 'generating', '正在解析当前对话视频...');
    try {
      const result = await manualResolveVideoArtifact(webview, {
        conversationUrl: webview.getURL(),
        timeoutMs: 30_000,
        isManual: true,
        experimentalNoWatermark: isExperimentalNoWatermarkEnabled(),
      });
      const outputs = result.status === 'resolved' && result.url
        ? normalizeVideoUrls([result.url])
        : [];
      if (outputs.length === 0) {
        message.warning(`暂未提取到视频地址：${formatResolutionMessage(result)}`);
        useTaskStore.getState().setAccountAutomationState(accountId, 'idle', '');
        return;
      }

      const manualTaskId = `manual-${Date.now().toString(36)}`;
      const download = await window.electronAPI.tasks.downloadOutputs([{
        taskId: manualTaskId,
        prompt: '手动对话视频',
        outputs,
        accountId,
        mode: 'video',
      }]);
      if (!download.success) throw new Error(download.error || '视频地址已提取，但下载失败');

      const usageKey = `${accountId}:${result.vid || outputs[0]}`;
      if (!manualVideoUsageRef.current.has(usageKey)) {
        manualVideoUsageRef.current.add(usageKey);
        await useAccountStore.getState().recordSeedanceUsage(accountId, 1);
      }
      await useAccountStore.getState().recordAccountOutcome(accountId, 'success');
      useTaskStore.getState().setAccountAutomationState(accountId, 'completed', `视频已下载（来源：${result.source || 'unknown'}）`);
      message.success(`已下载 ${download.count} 个视频`);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error('[BrowserPanel] 手动视频提取失败：', error);
      message.error(`提取或下载失败：${reason}`);
      useTaskStore.getState().setAccountAutomationState(accountId, 'idle', '');
    } finally {
      setManualVideoExtracting(false);
    }
  };

  const handleDownloadPublicShareMedia = async (): Promise<void> => {
    const shareUrl = publicShareUrl.trim();
    if (!shareUrl) {
      message.warning('请先粘贴豆包公开分享链接');
      return;
    }
    setManualVideoExtracting(true);
    try {
      const settings = await window.electronAPI.settings.get();
      const download = await window.electronAPI.tasks.downloadPublicShareMedia(shareUrl, settings.downloadDir || undefined);
      if (!download.success) {
        message.error(`公开媒体下载失败：${download.error || '未找到可验证的视频流'}`);
        return;
      }
      setPublicShareDialogOpen(false);
      setPublicShareUrl('');
      const size = download.contentLength ? `，${Math.ceil(download.contentLength / 1024 / 1024)} MB` : '';
      message.success(`已下载页面公开媒体流（${download.sourceHost || '公开来源'}${size}）。该文件保留平台可能附带的水印。`);
    } catch (err: unknown) {
      message.error(`公开媒体下载失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setManualVideoExtracting(false);
    }
  };

  useEffect((): (() => void) => {
    let stopped = false;
    let reading = false;
    let previous = '';
    let observedAdjustment = '';
    const readReplies = async (verify = false): Promise<{ projectId: string; adjustmentId: string; url: string; replies: PetStoryConversationReply[] }> => {
      const p = usePetStoryStore.getState().project; const a = p?.chatAdjustment;
      if (!p || a?.status !== 'active') throw new Error('当前没有正在调整的创作');
      const webview = registryRef.current.get(p.accountId);
      if (!webview || loadingMapRef.current.get(p.accountId) !== false || !isSameDoubaoConversation(webview.getURL(), a.conversationUrl)) throw new Error('请打开这项创作关联的豆包会话，回复只从该会话读取');
      const url = webview.getURL();
      const snapshot = await getChatPageSnapshot(webview);
      if (verify && snapshot.editorText?.trim()) throw new Error('豆包输入框还有未发送草稿，请先发送或清空，再采用回复');
      const replies = await readPetStoryConversationReplies(snapshot);
      if (verify) {
        await new Promise<void>((resolve): void => { setTimeout(resolve, 600); });
        const checked = await getChatPageSnapshot(webview);
        if (checked.editorText?.trim()) throw new Error('豆包输入框还有未发送草稿，请先处理后再采用');
        const second = await readPetStoryConversationReplies(checked);
        if (JSON.stringify(second.map((r): string => r.key)) !== JSON.stringify(replies.map((r): string => r.key))) throw new Error('回复内容仍在变化，请等待回复完成');
      }
      const latest = usePetStoryStore.getState().project;
      if (latest?.chatAdjustment?.id !== a.id || latest.chatAdjustment.status !== 'active' || !isSameDoubaoConversation(webview.getURL(), url)) throw new Error('会话已变化，未采用回复');
      return { projectId: p.id, adjustmentId: a.id, url, replies };
    };
    const poll = async (): Promise<void> => {
      const state = usePetStoryStore.getState(); const a = state.project?.chatAdjustment;
      if (stopped || reading || state.busy || a?.status !== 'active') return;
      reading = true;
      try {
        if (observedAdjustment !== a.id) { observedAdjustment = a.id; previous = ''; }
        const result = await readReplies();
        const keys = JSON.stringify(result.replies.map((r): string => r.key));
        if (keys === previous && !stopped) await state.captureChatReplies(result.adjustmentId, result.url, result.replies);
        previous = keys;
      } catch (error: unknown) {
        previous = '';
        if (!stopped) usePetStoryStore.setState({ chatReadbackError: error instanceof Error ? error.message : '回复尚未读取完整' });
      } finally { reading = false; }
    };
    const open = async (): Promise<void> => {
      const p = usePetStoryStore.getState().project; const a = p?.chatAdjustment;
      if (!p || a?.status !== 'active') return;
      try {
        if (!canSelectAccount(p.accountId, findInteractiveAccountId(useTaskStore.getState().accountAutomationState))) throw new Error('另一个账号正在提交，请稍后返回当前调整');
        useAccountStore.getState().selectAccount(p.accountId);
        const webview = await waitForConversationNavigator((): HTMLWebViewElement | undefined => registryRef.current.get(p.accountId), { timeoutMs: 12000, isReady: (): boolean => loadingMapRef.current.get(p.accountId) === false });
        if (!webview || usePetStoryStore.getState().project?.chatAdjustment?.id !== a.id) throw new Error('账号页面未就绪，请稍后重新打开调整');
        if (!isSameDoubaoConversation(webview.getURL(), a.conversationUrl)) {
          const current = await getChatPageSnapshot(webview);
          if (current.editorText?.trim() || current.generating) throw new Error('豆包中有未发送草稿或正在回复，请先处理当前内容，再打开关联会话');
          const navigation = await openTaskConversation(webview, a.conversationUrl, { timeoutMs: 10000 });
          if (!navigation.ok) throw new Error('未能打开关联会话，请稍后重试');
        }
        usePetStoryStore.setState({ chatReadbackError: '' }); previous = ''; void poll();
      } catch (error: unknown) { usePetStoryStore.setState({ chatReadbackError: error instanceof Error ? error.message : '关联会话尚未打开' }); }
    };
    const verify = (event: Event): void => {
      const detail = (event as CustomEvent<{ adjustmentId: string; replyKey: string; resolve: () => void; reject: (error: Error) => void }>).detail;
      if (!detail) return;
      void readReplies(true).then(async (result): Promise<void> => {
        if (result.adjustmentId !== detail.adjustmentId || !result.replies.some((r): boolean => r.key === detail.replyKey)) throw new Error('选定回复已不在当前页面，请重新选择');
        const captured = await window.electronAPI.petstory.captureAdjustmentReplies(result.projectId, result.adjustmentId, result.url, result.replies);
        if (!captured.success || !captured.project) throw new Error(captured.error || '回复核对未保存');
        const latest = usePetStoryStore.getState().project;
        if (latest?.id === result.projectId && captured.project.revision >= latest.revision) usePetStoryStore.setState({ project: captured.project, chatReadbackError: '' });
        detail.resolve();
      }).catch((error: unknown): void => detail.reject(error instanceof Error ? error : new Error('回复核对失败')));
    };
    const openHandler = (): void => { void open(); };
    const interval = setInterval((): void => { void poll(); }, 1100);
    window.addEventListener('petstory-open-adjustment', openHandler);
    window.addEventListener('petstory-verify-adjustment-reply', verify);
    return (): void => { stopped = true; clearInterval(interval); window.removeEventListener('petstory-open-adjustment', openHandler); window.removeEventListener('petstory-verify-adjustment-reply', verify); };
  }, []);

  // ---- 立即终止自动化等待；可携带新提示词，在终止后重新排队 ----
  useEffect(() => {
    const handleCancelAutomation = (event: Event) => {
      const detail = (event as CustomEvent<{
        taskId: string;
        restartTask?: TaskUpdateInput;
        targetStatus?: 'paused' | 'cancelled';
      }>).detail;
      if (!detail?.taskId) return;
      if (detail.restartTask?.prompt?.trim()) {
        pendingRestartTasksRef.current.set(detail.taskId, {
          ...detail.restartTask,
          prompt: detail.restartTask.prompt.trim(),
        });
      }
      if (detail.targetStatus) pendingCancellationStatusRef.current.set(detail.taskId, detail.targetStatus);
      const controller = abortControllersRef.current.get(detail.taskId);
      if (automationEngine.abort(detail.taskId) || controller) {
        controller?.abort();
        message.info(detail.restartTask ? '正在停止旧任务并重新排队...' : '正在取消任务等待...');
      }
    };

    window.addEventListener('cancel-task-automation', handleCancelAutomation);
    return () => window.removeEventListener('cancel-task-automation', handleCancelAutomation);
  }, []);

  /** 缺定位的旧图片任务只打开原账号；显式继续先确认页面具备可核对会话。 */
  useEffect(() => {
    type ImageRecoveryPageDetail = { taskId: string; accountId: string; runId?: string; submittedAt?: string; onResult?: (result: { ready: boolean; message?: string }) => void };
    const originalImageAccount = (detail: ImageRecoveryPageDetail): Task => {
      const state = useTaskStore.getState();
      const task = state.tasks.find((item): boolean => item.id === detail.taskId);
      const account = useAccountStore.getState().accounts.find((item): boolean => item.id === detail.accountId);
      if (!task || task.mode !== 'image' || task.assignedAccountId !== detail.accountId || task.runtime?.runId !== detail.runId
        || task.runtime?.submittedAt !== detail.submittedAt || !account || !supportsDoubaoConversationLocator(account.platform)) throw new Error('原图片任务或账号已变化，请重新打开原任务');
      if (hasAccountChatAdjustment(detail.accountId) || state.tasks.some((other): boolean => other.id !== task.id && other.assignedAccountId === detail.accountId
        && ['executing', 'generating', 'manual_submission_observing', 'waiting_verification', 'waiting_generation_confirmation'].includes(other.status))) throw new Error('原账号正在处理其他对话，请等待其结束');
      if (!canSelectAccount(detail.accountId, findInteractiveAccountId(state.accountAutomationState))) throw new Error('另一个账号正在提交，请稍后打开原账号');
      return task;
    };
    const revealImageAccount = (detail: ImageRecoveryPageDetail): void => {
      originalImageAccount(detail);
      useAccountStore.getState().selectAccount(detail.accountId);
      window.dispatchEvent(new CustomEvent('reveal-workspace-browser'));
    };
    const handleOpenImageAccount = (event: Event): void => {
      const detail = (event as CustomEvent<ImageRecoveryPageDetail>).detail;
      try { if (detail) revealImageAccount(detail); }
      catch (error: unknown) { message.warning(error instanceof Error ? error.message : '原账号页面暂不可用'); }
    };
    const handleImageRecoveryPage = async (event: Event): Promise<void> => {
      const detail = (event as CustomEvent<ImageRecoveryPageDetail>).detail;
      if (!detail?.onResult) return;
      try {
        revealImageAccount(detail);
        const webview = await waitForConversationNavigator(() => registryRef.current.get(detail.accountId), {
          timeoutMs: 6000, isReady: (): boolean => loadingMapRef.current.get(detail.accountId) === false,
        });
        if (!webview) throw new Error('原账号页面仍在加载，请等页面就绪后继续');
        const page = await getCurrentCreationConversation(webview, { timeoutMs: 3000, ensureCurrent: (): void => { originalImageAccount(detail); } });
        originalImageAccount(detail);
        const route = normalizeDoubaoConversationUrl(webview.getURL());
        if (!route && !page.conversationUrl) throw new Error('原会话未定位，请在原账号历史中打开这次图片对话后继续');
        if (!page.snapshot.messages.length) throw new Error('当前对话正文尚未加载，请打开这次图片对话并等正文显示后继续');
        detail.onResult({ ready: true });
      } catch (error: unknown) { detail.onResult({ ready: false, message: error instanceof Error ? error.message : '原图片会话尚未定位，请打开原账号历史后继续' }); }
    };
    window.addEventListener('open-image-task-account', handleOpenImageAccount);
    window.addEventListener('inspect-image-task-recovery-page', handleImageRecoveryPage);
    return (): void => {
      window.removeEventListener('open-image-task-account', handleOpenImageAccount);
      window.removeEventListener('inspect-image-task-recovery-page', handleImageRecoveryPage);
    };
  }, []);

  useEffect(() => {
    const handleOpenConversation = async (event: Event) => {
      const task = (event as CustomEvent<{ task: Task }>).detail?.task;
      const accountId = task?.assignedAccountId;
      const account = useAccountStore.getState().accounts.find((item) => item.id === accountId);
      const conversationTarget = resolveTaskConversationTarget(task);
      if (!accountId || !account || !supportsDoubaoConversationLocator(account.platform) || !conversationTarget.ok) {
        message.warning('该任务没有可验证的原会话地址');
        return;
      }
      if (hasAccountChatAdjustment(accountId)) { message.info('请先采用当前回复或结束调整，再打开其他任务会话'); return; }
      if (!canSelectAccount(accountId, findInteractiveAccountId(useTaskStore.getState().accountAutomationState))) { message.info('另一个账号正在提交，请稍后打开原会话'); return; }
      useAccountStore.getState().selectAccount(accountId);
      const webview = await waitForConversationNavigator(
        () => registryRef.current.get(accountId),
        { timeoutMs: 20_000, isReady: () => loadingMapRef.current.get(accountId) === false },
      );
      if (!webview) {
        message.warning('账号页面未能及时就绪，未跳转到其它会话');
        return;
      }
      const taskState = useTaskStore.getState();
      const accountBusy = taskState.tasks.some((item): boolean => item.assignedAccountId === accountId
        && ['executing', 'generating', 'manual_submission_observing'].includes(item.status));
      if (accountBusy || submissionReconcileRef.current.has(task.id)) {
        if (isSameDoubaoConversation(webview.getURL(), conversationTarget.url)) message.info('原会话正在观察中，已保留当前现场');
        else message.warning('原账号正在处理任务，请稍后打开原会话');
        return;
      }
      const navigation = await synchronizeConversation(webview, conversationTarget.url, (): boolean => {
        const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === task.id);
        return latest?.runtime?.runId === task.runtime?.runId && latest?.assignedAccountId === accountId
          && registryRef.current.get(accountId) === webview && canSelectAccount(accountId, findInteractiveAccountId(useTaskStore.getState().accountAutomationState))
          && !useTaskStore.getState().tasks.some((item): boolean => item.assignedAccountId === accountId && ['executing', 'generating', 'manual_submission_observing'].includes(item.status));
      });
      if (navigation.ok) message.success('已同步并打开任务对应的原会话');
      else message.warning(conversationSyncMessage(navigation));
    };
    window.addEventListener('open-task-conversation', handleOpenConversation);
    return () => window.removeEventListener('open-task-conversation', handleOpenConversation);
  }, []);

  /** 常驻 Chat 在重新显示、聚焦或空闲时同步手机端消息；交互中的页面始终跳过。 */
  useEffect(() => {
    if (!visible || !activeAccount || !supportsDoubaoConversationLocator(activeAccount.platform)) return;
    const accountId = activeAccount.id;
    let stopped = false; let syncing = false;
    const controller = new AbortController();
    const current = (): boolean => !stopped && visibleRef.current && useAccountStore.getState().selectedAccountId === accountId
      && !hasAccountChatAdjustment(accountId)
      && !useTaskStore.getState().tasks.some((task): boolean => task.assignedAccountId === accountId
        && ['executing', 'generating', 'manual_submission_observing', 'waiting_verification'].includes(task.status))
      && !findInteractiveAccountId(useTaskStore.getState().accountAutomationState);
    const sync = async (): Promise<void> => {
      if (syncing || !current() || loadingMapRef.current.get(accountId)
        || Date.now() - (passiveConversationSyncRef.current.get(accountId) || 0) < 25_000) return;
      const webview = registryRef.current.get(accountId); const target = webview && normalizeDoubaoConversationUrl(webview.getURL());
      if (!webview || !target) return;
      syncing = true;
      passiveConversationSyncRef.current.set(accountId, Date.now());
      try { await synchronizeConversation(webview, target, (): boolean => current() && registryRef.current.get(accountId) === webview, 'visibility', controller.signal); }
      catch { /* 账号页面在退出或重建，下一次显示／聚焦时重新核对。 */ }
      finally { syncing = false; }
    };
    const onFocus = (): void => { void sync(); };
    void sync();
    window.addEventListener('focus', onFocus);
    const timer = setInterval(onFocus, 30_000);
    return (): void => { stopped = true; controller.abort(); clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [visible, activeAccount, webviewEpoch]);

  useEffect(() => {
    const handleAdapterSelfCheck = async () => {
      if (!activeAccount) {
        window.dispatchEvent(new CustomEvent('adapter-self-check-result', { detail: { error: '请先选择账号' } }));
        return;
      }
      const webview = registryRef.current.get(activeAccount.id);
      if (!webview) {
        window.dispatchEvent(new CustomEvent('adapter-self-check-result', { detail: { error: '账号页面尚未就绪' } }));
        return;
      }
      try {
        const report = await runAdapterSelfCheck(webview);
        await window.electronAPI.tasks.saveAdapterReport(activeAccount.id, report);
        window.dispatchEvent(new CustomEvent('adapter-self-check-result', { detail: { report } }));
      } catch (error: any) {
        window.dispatchEvent(new CustomEvent('adapter-self-check-result', { detail: { error: error.message || String(error) } }));
      }
    };
    window.addEventListener('adapter-self-check', handleAdapterSelfCheck);
    return () => window.removeEventListener('adapter-self-check', handleAdapterSelfCheck);
  }, [activeAccount]);

  // ---- V3 自动化：监听 per-account 执行状态 ----
  useEffect(() => {
    accounts.forEach((account) => {
      const accountId = account.id;
      const isBusy = accountBusy[accountId];
      const taskId = executingTasks[accountId];
      const webview = registryRef.current.get(accountId);
      if (!isBusy || !taskId || !webview) return;
      if (runningRef.current.has(accountId)) return;
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;
      // 用户打开的自由聊天优先。尚未发送的后台请求保留原任务，收起后从画布继续；
      // 已提交运行仍走只读观察，不因查看本任务会话而中止或重复发送。
      if (visibleRef.current && !task.runtime?.submittedAt && isBackgroundPetStoryTask(usePetStoryStore.getState().project, taskId, task)) {
        runningRef.current.add(accountId);
        void useTaskStore.getState().pauseAutomation(taskId, accountId, '豆包对话正在打开，请收起后继续生成；本次尚未发送', { status: 'paused', code: 'page_unrecognized' })
          .catch((): void => { message.error('暂停状态暂未保存，请稍后重试；本次未操作豆包输入'); })
          .finally(async (): Promise<void> => { await automationEngine.release(taskId); runningRef.current.delete(accountId); });
        return;
      }
      console.log(`[BrowserPanel] 路由任务 ${taskId} → ${accountId}`);
      // 调度器取得执行锁后，必须由这里激活对应账号；不能依赖用户先手动点开。
      useAccountStore.getState().selectAccount(accountId);
      runningRef.current.add(accountId);
      executeAutomation(accountId, taskId, task.prompt, task.mode || "chat", webview, task.videoConfig, task.attachments, task.audioAttachment);
    });
  }, [accountBusy, executingTasks, tasks, webviewEpoch]);

  // 应用重启或页面重新挂载后，只沿已持久化的原会话恢复观察；不进入注入/发送流程。
  useEffect(() => {
    tasks.forEach((task) => {
      if (task.status !== 'manual_submission_observing' ||
        task.runtime?.acceptanceObservation?.outcome !== 'observing' ||
        !task.assignedAccountId || !registryRef.current.has(task.assignedAccountId) ||
        submissionReconcileRef.current.has(task.id)) return;
      window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: task.id } }));
    });
  }, [tasks, webviewEpoch]);

  // ---- 自动化执行 ----
  const executeAutomation = async (
    accountId: string,
    taskId: string,
    prompt: string,
    mode: string,
    webview: HTMLWebViewElement,
    videoConfig?: Task['videoConfig'],
    attachments?: string[],
    audioAttachment?: string
  ) => {
    const { setAccountAutomationState, updateTaskRuntime, completeAutomation, pauseAutomation, failAutomation, updateTask, armTasks } =
      useTaskStore.getState();
    const initialTask = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
    const expectedRunId = initialTask?.runtime?.runId;
    // 重挂载／热更新不能接管仍由旧控制器观察的运行，更不能重新创建会话。
    if (automationEngine.hasController(taskId)) { runningRef.current.delete(accountId); return; }
    if (initialTask?.runtime?.submittedAt) {
      const recoveryMessage = '原运行已记录提交；仅恢复原会话回读，不重新准备、注入或发送';
      await pauseAutomation(taskId, accountId, recoveryMessage, { status: 'paused', code: 'submission_uncertain' });
      runningRef.current.delete(accountId);
      await automationEngine.release(taskId);
      const current = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
      if (current?.runtime?.runId === expectedRunId && current?.runtime?.submittedAt) window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId } }));
      return;
    }
    // 台账中的精确移交在切页后仍有效；已提交／已有控制器的运行先只读退出。
    // 仅选定自由回复的修订增加导航前的草稿保护。
    const selectedReplyRepair = mode === 'chat' && (useTaskStore.getState().tasks.some((item): boolean => item.runtime?.chatAdjustmentGuard?.active === true && item.runtime.chatAdjustmentGuard.allowedTaskId === taskId)
      || !!usePetStoryStore.getState().project?.jobs.some((job): boolean => job.taskId === taskId && !!job.repairReplySource));
    const backgroundTask = isBackgroundPetStoryTask(usePetStoryStore.getState().project, taskId, initialTask);
    const imageRuntime = initialTask?.runtime;
    const ownedImageDraft = backgroundTask && initialTask?.mode === 'image' && initialTask.executionIntent === 'armed'
      && initialTask.promptReadback === 'exact' && imageRuntime && imageRuntime.attempt >= 2
      && imageRuntime.input.prompt === prompt && imageRuntime.input.mode === mode && initialTask.prompt === prompt
      && !imageRuntime.submittedAt && !imageRuntime.acceptanceObservation && !initialTask.outputs.length ? prompt : undefined;
    const ownedRepairDraft = ownedImageDraft || resumableRepairDraft(initialTask, prompt, selectedReplyRepair || backgroundTask);
    const petstoryTask = useTaskStore.getState().tasks.find((item) => item.id === taskId)?.petstory;
    const strictPrompt = !!petstoryTask || useTaskStore.getState().tasks.find((item) => item.id === taskId)?.promptReadback === 'exact';
    let petstoryGuard: import('@doubao-studio/contracts').PetStoryExecutionGuard | undefined;
    let petstoryUploads: import('../utils/doubaoBridge').PetStoryUploadReceipt[] = [];
    let petstoryBindings: import('@doubao-studio/contracts').PetStoryPageBinding[] = [];
    const refreshPetStoryGuard = async (): Promise<void> => {
      if (!petstoryTask) return;
      const result = await window.electronAPI.petstory.guardProductionTask(taskId);
      if (!result.success || !result.guard) throw new PetStoryControlError(result.error || '原制作步骤绑定不可核实');
      petstoryGuard = result.guard;
    };
    let controller: AbortController;
    try {
      controller = automationEngine.createController(taskId, accountId);
    } catch (error: any) {
      const messageText = error?.message || '任务控制器初始化失败';
      await failAutomation(taskId, accountId, messageText, classifyTaskError(messageText));
      await automationEngine.release(taskId);
      return;
    }
    abortControllersRef.current.set(taskId, controller);
    const pause = (ms: number) => sleepWithAbort(ms, controller.signal);
    let preserveSubmittedConversation: ((evidence?: ChatReadbackResult, observedUrl?: string, page?: CurrentCreationConversationReadback) => Promise<void>) | undefined;
    const checkHumanVerification = async (): Promise<void> => {
      if (!controller.signal.aborted) {
        // 验证可能在发送后、受理回读完成前出现；先保留已能证明归属的原会话定位。
        await preserveSubmittedConversation?.().catch((): void => { /* 只读证据不足时保留缺定位，绝不猜测或重发。 */ });
        await assertNoHumanVerification(accountId, webview);
      }
    };
    let initializationLease: InitializationLease | undefined;
    let autoConfirmMaterialAuthorization = false;
    let initializationLimit = 1;
    let videoReadinessStartedAt = Date.now();
    let videoReadinessRecoveryAttempts = 0;
    const persistVideoReadiness = async (
      stage: VideoPageReadinessStage,
      diagnostic?: VideoControlReadinessResult,
    ): Promise<void> => {
      if (mode !== 'video') return;
      const current = useTaskStore.getState().tasks.find((item) => item.id === taskId)?.runtime?.controlReadiness;
      const checkpoint = diagnostic ?? createVideoReadinessCheckpoint(stage, {
        elapsedMs: Date.now() - videoReadinessStartedAt,
        recoveryAttempts: videoReadinessRecoveryAttempts,
      });
      await updateTaskRuntime(taskId, {
        runtime: {
          controlReadiness: {
            ...current,
            ...checkpoint,
            currentStage: stage,
            recoveryAttempts: videoReadinessRecoveryAttempts,
            pageStructureVersion: checkpoint.pageStructureVersion ?? current?.pageStructureVersion,
            failureStage: checkpoint.failureStage,
            missingControl: checkpoint.missingControl,
            controlOperation: checkpoint.controlOperation,
            failureReason: checkpoint.failureReason,
          },
          lastHeartbeatAt: new Date().toISOString(),
        },
      });
    };
    const clearKnownPromotion = async (): Promise<void> => {
      await checkHumanVerification();
      const result = await dismissKnownDesktopDownloadPromotion(webview);
      if (result === 'failed') {
        throw new Error('下载电脑版推广弹窗未能安全关闭，已在提交前停止');
      }
      if (result === 'dismissed') await pause(350);
    };
    const materialAuthorizationNotificationKey = `material-authorization-${taskId}`;
    try {
      // 空闲同步已开始的导航必须先结束，不能在新任务配置输入时替换文档。
      await conversationSynchronizations.get(webview);
      if (controller.signal.aborted) throw new DOMException('任务已取消', 'AbortError');
      await refreshPetStoryGuard();
      const settings = await window.electronAPI.settings.get();
      autoConfirmMaterialAuthorization = settings.autoConfirmMaterialAuthorization === true;
      initializationLimit = Math.max(1, Math.min(3, Number(settings.initializationConcurrency) || 1));
      initializationLease = await initializationGate.acquire(taskId, { limit: initializationLimit, signal: controller.signal });
      await updateTaskRuntime(taskId, {
        runtime: {
          executionDiagnostics: {
            initializationQueueWaitMs: initializationLease.waitedMs,
            initializationLimit,
          },
        },
      });
      console.log(`[Automation:${accountId}] 开始`);

      setAccountAutomationState(accountId, 'injecting', '正在检测账号可用性...', 'preparing_account');
      await clearKnownPromotion();
      const preTaskAvailability = await performAvailabilityCheck(accountId, webview, 'pre_task');
      if (availabilityBlocksAutomation(preTaskAvailability)) {
        if (mode === 'video') {
          await persistVideoReadiness('account', {
            ...createVideoReadinessCheckpoint('account'), ready: false, failureStage: 'account', missingControl: 'account_page',
          });
        }
        useAccountStore.getState().selectAccount(accountId);
        throw new AccountAvailabilityPauseError(preTaskAvailability.message, preTaskAvailability.reason);
      }
      videoReadinessStartedAt = Date.now();
      await persistVideoReadiness('account');

      // 执行前检查账号登录、验证与用户调度设置
      if (mode === 'video' && videoConfig) {
        const account = useAccountStore.getState().accounts.find((a) => a.id === accountId);
        if (account) {
          const capability = evaluateVideoCapability({
            model: videoConfig.model,
            duration: videoConfig.duration,
            aspectRatio: videoConfig.aspectRatio,
            health: account.health,
            scheduling: account.scheduling,
            accountStatus: account.status,
          });
          if (!capability.canSubmit) {
            // 本地已知阻塞条件，直接终止，不进入页面操作
            throw new Error(capability.userMessage);
          }
          if (capability.state === 'unknown') {
            // 有风险提示但允许提交，记录日志
            console.warn(`[Automation:${accountId}] 视频能力预检提示: ${capability.userMessage}`);
          }
        }
      }

      let taskConversationUrl: string | undefined;
      let modeEntryElapsedMs: number | undefined;
      let initialMsgCount = 0;
      let conversationTextAfterSubmit = '';
      setAccountAutomationState(accountId, 'injecting', '正在创建新对话...', 'new_conversation');
      await checkHumanVerification();
      if (backgroundTask && visibleRef.current) throw new AccountAvailabilityPauseError('豆包对话正在打开，请收起后继续生成；本次尚未发送', 'page_unrecognized');
      if (selectedReplyRepair && !useTaskStore.getState().tasks.some((item): boolean => item.runtime?.chatAdjustmentGuard?.active === true && item.runtime.chatAdjustmentGuard.allowedTaskId === taskId)) throw new SubmissionSafetyPauseError('本次豆包调整已结束或移交已收回；修订未导航、未发送');
      const newConversationResult = await startNewConversation(webview, 20_000, mode === 'chat', selectedReplyRepair || backgroundTask, ownedRepairDraft);
      if (!newConversationResult.ok) {
        if (backgroundTask) throw new AccountAvailabilityPauseError('豆包当前有未发送内容、正在回复或输入区尚未就绪，请处理后继续本次制作；本次未发送', 'page_unrecognized');
        if (selectedReplyRepair) throw new AccountAvailabilityPauseError(`修订已暂停，当前豆包输入尚未就绪（${newConversationResult.reason || 'PAGE_UNKNOWN'}）；请处理未发送草稿或等待回复结束后继续原修订，未发送`, 'page_unrecognized');
        const failedAvailability = await performAvailabilityCheck(accountId, webview, 'pre_task');
        if (failedAvailability.state !== 'ready') {
          useAccountStore.getState().selectAccount(accountId);
          throw new AccountAvailabilityPauseError(failedAvailability.message, failedAvailability.reason);
        }
        // reason 为脱敏状态码（如 PAGE_NOT_READY/EDITOR_NOT_FOUND/SESSION_NOT_EMPTY），不泄露页面细节。
        if (mode === 'video') {
          throw new VideoControlReadinessError('new_conversation', {
            ...createVideoReadinessCheckpoint('new_conversation'), ready: false, failureStage: 'new_conversation',
            missingControl: 'conversation_editor',
          });
        }
        throw new Error(`创建新对话失败（${newConversationResult.reason || 'PAGE_UNKNOWN'}）`);
      }
      await waitForWebviewReady(webview, 15000);
      await clearKnownPromotion();
      // 仅作为本次素材授权页面一致性校验使用；/chat/ 根页绝不写入任务定位字段。
      taskConversationUrl = webview.getURL();
      await persistVideoReadiness('new_conversation');
      const uploadTaskImages = async (): Promise<void> => {
      await checkHumanVerification();
      if (mode === 'chat' && !(await ensurePlainChatComposer(webview)).ok) throw new SubmissionSafetyPauseError('普通 Chat 输入区模式未确认，未上传或发送');
      // 有参考图片时上传
      if (attachments && attachments.length > 0) {
        setAccountAutomationState(accountId, 'injecting', '上传参考图片...', 'uploading_assets');
        // 读取文件为 base64
        const fileDataList: Array<{ name: string; base64: string; mime: string }> = [];
        for (const filePath of attachments) {
          try {
            const result = await window.electronAPI.tasks.readFileAsBase64(filePath);
            if (result.success && result.data) {
              const fileName = filePath.split(/[/\\]/).pop() || 'image.jpg';
              const mimeMatch = result.data.match(/^data:(image\/\w+);base64,/);
              const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
              const base64 = result.data.replace(/^data:image\/\w+;base64,/, '');
              fileDataList.push({ name: fileName, base64, mime });
            }
          } catch {
            console.warn('[BrowserPanel] 参考文件读取失败');
          }
        }
        if (fileDataList.length !== attachments.length) {
          if (mode === 'chat') throw new ChatAttachmentUploadError('file_read_failed');
          throw new VideoControlReadinessError('assets', {
            ...createVideoReadinessCheckpoint('assets'), ready: false, failureStage: 'assets', missingControl: 'asset_upload',
          });
        }
        if (petstoryGuard || (strictPrompt && mode === 'image')) {
          petstoryUploads = await observeWithHumanVerification(
            (signal: AbortSignal): Promise<import('../utils/doubaoBridge').PetStoryUploadReceipt[]> => uploadPetStoryImages(webview, fileDataList, mode === 'video' && petstoryGuard?.mode ? petstoryGuard.mode : 'image', signal, petstoryGuard?.fileSha256s),
            checkHumanVerification, controller.signal);
          return;
        }
        let lastUploadPersistAt = -Infinity;
        await checkHumanVerification();
        const uploaded = await uploadReferenceImages(webview, fileDataList, {
          chat: mode === 'chat',
          timeoutMs: 180_000,
          stableSamples: 3,
          onProgress: async (diagnostic) => {
            if (controller.signal.aborted) throw new DOMException('任务已取消', 'AbortError');
            await checkHumanVerification();
            if (diagnostic.elapsedMs - lastUploadPersistAt < 5000 && diagnostic.failure !== undefined) return;
            lastUploadPersistAt = diagnostic.elapsedMs;
            const existingDiagnostics = useTaskStore.getState().tasks.find((item) => item.id === taskId)?.runtime?.executionDiagnostics;
            await updateTaskRuntime(taskId, {
              runtime: { executionDiagnostics: { ...existingDiagnostics, upload: diagnostic } },
            });
          },
        });
        if (!uploaded) throw new VideoControlReadinessError('assets', {
          ...createVideoReadinessCheckpoint('assets'), ready: false, failureStage: 'assets', missingControl: 'asset_upload',
        });
      }
      };
      // 根据任务模式切换到对应页面
      if (mode && mode !== 'chat') {
        await checkHumanVerification();
        const modeLabel = mode === 'image' ? '图片' : mode === 'video' ? '视频' : mode === 'music' ? '音乐' : mode;
        setAccountAutomationState(accountId, 'injecting', '切换到' + modeLabel + '模式...', 'switching_mode');
        switchMode(webview, mode);
        await waitForWebviewReady(webview, 20000);
        await clearKnownPromotion();

        // image/video 模式：在 AI 创作页面点击 Tab 切换
        if (mode === 'image' || mode === 'video') {
          setAccountAutomationState(accountId, 'injecting', '点击' + modeLabel + 'Tab...', 'switching_mode');
          const modeEntryStartedAt = Date.now();
          await checkHumanVerification();
          const modeDiagnostics: CreationModeEntryDiagnostic[] = [];
          const switched = await clickAITab(webview, mode, (diagnostic: CreationModeEntryDiagnostic): void => { modeDiagnostics.push(diagnostic); });
          const modeDiagnostic = modeDiagnostics[modeDiagnostics.length - 1];
          modeEntryElapsedMs = Date.now() - modeEntryStartedAt;
          if (mode === 'image' && modeDiagnostic) {
            void window.electronAPI.logs.append({ level: switched ? 'info' : 'warn', scope: 'automation', taskId, accountId,
              message: '图片模式回读 ' + JSON.stringify(modeDiagnostic) }).catch((): void => undefined);
          }
          if (!switched) {
            if (mode === 'video') {
              throw new VideoControlReadinessError('mode_entry', {
                ready: false, failureStage: 'mode_entry', attempts: 1, elapsedMs: modeEntryElapsedMs,
              });
            }
            // 此时尚未上传或写入提交意图；使用可恢复的控件错误，不能归为未知提交失败。
            const reason = modeDiagnostic?.reason || '';
            const detail = /未连续稳定选中/.test(reason) ? '平台尚未确认已选中图像生成'
              : /未找到|等待窗口内挂载/.test(reason) ? '当前输入区未读到图像生成入口' : '当前图像生成控件无法确认';
            throw new PetStoryControlError(`${detail}，本次尚未发送`);
          }
          if (mode === 'video') await persistVideoReadiness('video_entry');
          await pause(1500); // 等待 Tab 切换动画
        }

        // 视频模式：只使用页面可见控件配置，禁止请求改写绕过会员门槛。
        if (mode === 'video') {
          if (videoConfig) {
            setAccountAutomationState(accountId, 'injecting', '配置视频参数...', 'configuring');
            const configure = () => configureVideoOptions(webview, videoConfig, {
              onReadiness: async (diagnostic) => persistVideoReadiness(diagnostic.currentStage || 'model', {
                ...diagnostic, modeEntryElapsedMs,
              }),
            });
            try {
              await configure();
            } catch (error: unknown) {
              if (!(error instanceof VideoControlReadinessError) || videoReadinessRecoveryAttempts >= 1) throw error;
              // 仅在尚未产生提交意图时允许一次页面重绘恢复；配置函数逐项回读，重复执行是幂等的。
              videoReadinessRecoveryAttempts += 1;
              await persistVideoReadiness(error.diagnostic.currentStage || 'model', {
                ...error.diagnostic, recoveryAttempts: videoReadinessRecoveryAttempts,
              });
              const recovered = await clickAITab(webview, 'video');
              if (!recovered) throw error;
              await pause(750);
              await configure();
            }
            await pause(500);
          }
        }

        if (petstoryGuard) {
          const composer = mode === 'video' ? await waitForPetStoryVideoComposer(webview, petstoryGuard, controller.signal)
            : mode === 'image' ? await waitForPetStoryImageComposer(webview, controller.signal) : await readPetStoryComposer(webview);
          checkPetStoryPageGuard(composer, petstoryGuard, mode === 'video');
        }
        await uploadTaskImages();
        // 有参考音频时上传（仅视频模式）
        if (mode === 'video' && audioAttachment) {
          setAccountAutomationState(accountId, 'injecting', '上传参考音频...', 'uploading_assets');
          try {
            const result = await window.electronAPI.tasks.readFileAsBase64(audioAttachment);
            if (result.success && result.data) {
              const fileName = audioAttachment.split(/[/\\]/).pop() || 'audio.mp3';
              const mimeMatch = result.data.match(/^data:(audio\/[\w.+-]+);base64,/);
              const mime = mimeMatch ? mimeMatch[1] : 'audio/mpeg';
              const base64 = result.data.replace(/^data:audio\/[\w.+-]+;base64,/, '');
              const uploaded = await uploadReferenceAudio(webview, { name: fileName, base64, mime });
              if (!uploaded) throw new VideoControlReadinessError('assets', {
                ...createVideoReadinessCheckpoint('assets'), ready: false, failureStage: 'assets', missingControl: 'asset_upload',
              });
            } else {
              throw new VideoControlReadinessError('assets', {
                ...createVideoReadinessCheckpoint('assets'), ready: false, failureStage: 'assets', missingControl: 'asset_upload',
              });
            }
          } catch (error: unknown) {
            if (error instanceof VideoControlReadinessError) throw error;
            const reason = error instanceof Error ? error.message : '参考音频处理失败';
            throw new VideoControlReadinessError('assets', {
              ...createVideoReadinessCheckpoint('assets'), ready: false, failureStage: 'assets', missingControl: 'asset_upload',
              elapsedMs: reason.includes('超时') ? 60_000 : 0,
            });
          }
        }
        if (mode === 'video') await persistVideoReadiness('assets');
      } else {
        await waitForWebviewReady(webview, 15000);
        await uploadTaskImages();
      }

      await clearKnownPromotion();
      const preSubmitAvailability = await performAvailabilityCheck(accountId, webview, 'pre_submit');
      if (preSubmitAvailability.state !== 'ready') {
        useAccountStore.getState().selectAccount(accountId);
        throw new AccountAvailabilityPauseError(preSubmitAvailability.message, preSubmitAvailability.reason);
      }

      // 注入生成状态网络监听器（后台 webview 也能准确检测生成完成）
      if (backgroundTask && visibleRef.current) throw new AccountAvailabilityPauseError('豆包对话正在打开，请收起后继续生成；本次尚未发送', 'page_unrecognized');
      await injectGenerationMonitor(webview);
      if (mode === 'video') {
        await resetVideoCaptureCache(webview);
      }

      setAccountAutomationState(accountId, 'injecting', '正在注入提示词...', 'injecting_prompt');
      await checkHumanVerification();
      let injected = false;
      try {
        if (petstoryTask && petstoryGuard?.references) {
          const source = petstoryGuard.compiledPrompt;
          if (!source || source.text !== prompt || !source.segments) throw new PetStoryControlError('结构化引用编译快照缺失或与任务不符，零提交');
          const bound = await bindPetStoryReferences(webview, source, petstoryUploads, controller.signal);
          if (!expectedRunId) throw new PetStoryControlError('本次运行缺失');
          const saved = await window.electronAPI.petstory.recordPageBindings(petstoryTask.projectId, taskId, expectedRunId, bound.bindings);
          if (!saved.success || !saved.compiledPrompt || saved.compiledPrompt.text !== bound.compiled.text) throw new PetStoryControlError(saved.error || '实际网页绑定保存不一致');
          prompt = saved.compiledPrompt.text; petstoryBindings = bound.bindings;
          await useTaskStore.getState().loadTasks();
          injected = true;
        } else injected = await Promise.race([
          injectPrompt(webview, prompt, 3, strictPrompt),
          new Promise<boolean>((_, rej) => setTimeout(() => rej(new Error('注入超时')), 60000)),
        ]);
      } catch (error: unknown) {
        if (error instanceof PetStoryControlError) throw error;
        throw new VideoControlReadinessError('prompt', {
          ...createVideoReadinessCheckpoint('prompt'), ready: false, failureStage: 'prompt', missingControl: 'prompt_editor', elapsedMs: 60_000,
        });
      }
      if (!injected) throw new VideoControlReadinessError('prompt', {
        ...createVideoReadinessCheckpoint('prompt'), ready: false, failureStage: 'prompt', missingControl: 'prompt_editor',
      });
      await pause(800);
      if (!await verifyPromptReadyForSubmission(webview, prompt, strictPrompt)) {
        throw new VideoControlReadinessError('prompt', {
          ...createVideoReadinessCheckpoint('prompt'), ready: false, failureStage: 'prompt', missingControl: 'prompt_editor',
        });
      }
      await persistVideoReadiness('prompt');

      // 素材确认可能在用户点击后直接继续发送。先取只读基线，确认后只回读，
      // 绝不能再点一次发送。
      const generationStartTimeBeforeSubmit = await getGenerationStartTime(webview);
      if (mode === 'chat' || mode === 'image' || petstoryGuard) {
        const beforeSubmit = await getChatPageSnapshot(webview);
        if (!beforeSubmit.editorPresent || beforeSubmit.messages.length !== 0) {
          throw new SubmissionSafetyPauseError('普通 Chat 新会话消息基线不为空或输入框缺失；未发送');
        }
        initialMsgCount = beforeSubmit.messages.length;
      } else {
        initialMsgCount = await getSubmissionMessageCount(webview);
      }
      let latestChatReadback: ChatReadbackResult | undefined;
      preserveSubmittedConversation = async (readback?: ChatReadbackResult, observedUrl?: string, page?: CurrentCreationConversationReadback): Promise<void> => {
        const original = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
        if (!original?.runtime?.submittedAt || original.runtime.runId !== expectedRunId
          || !automationEngine.ownsController(taskId, controller) || registryRef.current.get(accountId) !== webview
          || (!['chat', 'image'].includes(mode) && !petstoryGuard && !strictPrompt)) return;
        const preserveImageReceipt = async (): Promise<boolean> => {
          const currentPage = page || await getCurrentCreationConversation(webview, {
            signal: controller.signal, ensureCurrent: (): void => {
              if (!automationEngine.ownsController(taskId, controller)) throw new SubmissionSafetyPauseError('原图片执行权已变化，未保存其他结果');
            },
          });
          const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
          const receipt = mediaSubmissionReceiptFor(original, latest, accountId, currentPage, new Date().toISOString());
          if (receipt) {
            if (controller.signal.aborted || !automationEngine.ownsController(taskId, controller)) return false;
            const saved = await updateTaskRuntime(taskId, { runtime: { conversationUrl: receipt.conversationUrl, mediaSubmissionReceipt: receipt } });
            const persisted = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
            if (!saved || persisted?.runtime?.runId !== expectedRunId || persisted.runtime.mediaSubmissionReceipt?.userMessageId !== receipt.userMessageId
              || !isSameDoubaoConversation(persisted.runtime.conversationUrl, receipt.conversationUrl)) throw new SubmissionSafetyPauseError('原图片消息定位保存未确认，保留提交且不重发');
            taskConversationUrl = receipt.conversationUrl;
            return true;
          }
          return false;
        };
        if (mode === 'image' && !original.runtime.mediaSubmissionReceipt && await preserveImageReceipt()) return;
        if (normalizeDoubaoConversationUrl(original.runtime.conversationUrl)) return;
        const currentUrl = normalizeDoubaoConversationUrl(observedUrl || webview.getURL());
        if (!currentUrl) return;
        const evidence = readback || (mode === 'chat'
          ? inspectChatReadback(await getChatPageSnapshot(webview), prompt, initialMsgCount, taskChatReadbackContext(original, accountId, currentUrl, webview.getURL()))
          : inspectCreationReadback(await getChatPageSnapshot(webview), prompt, mode === 'image' ? 'image' : 'video', initialMsgCount, videoConfig));
        const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
        const verifiedUrl = verifiedSubmissionConversationUrl(original, latest, accountId, currentUrl, webview.getURL(), evidence);
        if (!verifiedUrl || controller.signal.aborted || !automationEngine.ownsController(taskId, controller)) return;
        const receipt = mode === 'chat' ? chatReadbackReceipt(original, evidence, initialMsgCount) : undefined;
        const saved = await updateTaskRuntime(taskId, { runtime: { conversationUrl: verifiedUrl, ...(receipt ? { chatReadback: receipt } : {}) } });
        const persisted = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
        if (!saved || persisted?.runtime?.runId !== expectedRunId || persisted.runtime.submittedAt !== original.runtime.submittedAt
          || !isSameDoubaoConversation(persisted.runtime.conversationUrl, verifiedUrl)) throw new SubmissionSafetyPauseError('原消息已发布，但具体会话保存未确认；保持原提交且不重发');
        taskConversationUrl = verifiedUrl;
      };
      let submittedImageUrl: string | null = null;
      const trackSubmittedImageUrl = (url: string): void => {
        if (mode !== 'image') return;
        const concreteUrl = normalizeDoubaoConversationUrl(url);
        if (concreteUrl && submittedImageUrl && !isSameDoubaoConversation(concreteUrl, submittedImageUrl)) {
          throw new SubmissionSafetyPauseError('原图片会话已变化，停止核对且未重新发送');
        }
        if (concreteUrl) {
          submittedImageUrl = concreteUrl;
          if (expectedRunId && submissionMarkedAt) submittedImagePagesRef.current.set(taskId, {
            accountId, runId: expectedRunId, submittedAt: submissionMarkedAt, webview, conversationUrl: concreteUrl,
          });
        }
      };
      const readSubmissionEvidence = async (): Promise<SubmissionReadback> => {
        const assertOriginalMediaSubmission = (): void => {
          if (mode !== 'image') return;
          const current = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
          if (controller.signal.aborted || current?.status !== 'executing' || current.assignedAccountId !== accountId || !current.runtime
            || current.runtime.runId !== expectedRunId || current.runtime.submittedAt !== submissionMarkedAt
            || current.runtime.input.prompt !== prompt || current.runtime.input.mode !== mode || current.prompt !== prompt
            || JSON.stringify(current.runtime.input.attachments || []) !== JSON.stringify(current.attachments || [])
            || !automationEngine.ownsAccountController(taskId, accountId, controller) || registryRef.current.get(accountId) !== webview) {
            throw new SubmissionSafetyPauseError('原图片运行、输入或执行权已变化，停止回读且未重新发送');
          }
        };
        assertOriginalMediaSubmission();
        const observedUrl = webview.getURL();
        trackSubmittedImageUrl(observedUrl);
        if (mode === 'chat') {
          const originalTask = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
          const currentUrl = normalizeDoubaoConversationUrl(webview.getURL());
          // 本次执行已在发送前核对空白基线、全文及附件，且账号由执行租约绑定。
          // 发送后即记录具体会话与消息轮次，不再要求长规则永远逐字渲染。
          const context = originalTask?.runtime?.submittedAt && originalTask.runtime.input.prompt === prompt && currentUrl
            ? taskChatReadbackContext(originalTask, accountId, normalizeDoubaoConversationUrl(originalTask.runtime.conversationUrl) || currentUrl, webview.getURL()) : undefined;
          latestChatReadback = inspectChatReadback(await getChatPageSnapshot(webview), prompt, initialMsgCount, context);
          await preserveSubmittedConversation?.(latestChatReadback, observedUrl);
          return latestChatReadback;
        }
        if (mode === 'image' || (petstoryGuard || strictPrompt) && mode === 'video') {
          const page = mode === 'image' ? await getCurrentCreationConversation(webview, { signal: controller.signal, ensureCurrent: assertOriginalMediaSubmission }) : undefined;
          assertOriginalMediaSubmission();
          const evidence = inspectCreationReadback(page?.snapshot || await getChatPageSnapshot(webview), prompt, mode, initialMsgCount, videoConfig);
          trackSubmittedImageUrl(webview.getURL());
          if (page?.conversationUrl) trackSubmittedImageUrl(page.conversationUrl);
          await preserveSubmittedConversation?.(evidence, observedUrl, page);
          assertOriginalMediaSubmission();
          return evidence;
        }
        return getSubmissionEvidence(webview, prompt, generationStartTimeBeforeSubmit, initialMsgCount);
      };
      let authorizationTriggeredSubmission = false;
      let submissionMarkedAt: string | undefined;

      const markSubmissionIntent = async (stage: 'submitting' | 'waiting_verification', messageText: string): Promise<string> => {
        if (mode === 'image') {
          const imageComposer = await readPetStoryComposer(webview);
          if (imageComposer.selectedSkill !== 'image') throw new PetStoryControlError('图像生成模式尚未稳定选中，本次未发送；请等待页面就绪后继续');
        }
        if (mode === 'chat' && !(await ensurePlainChatComposer(webview)).ok) throw new SubmissionSafetyPauseError('普通 Chat 输入区已切换或无法确认，未持久化提交意图，未发送');
        await refreshPetStoryGuard();
        if (petstoryGuard) {
          await verifyPetStoryUploads(webview, petstoryGuard, mode === 'video');
          if (petstoryGuard.references && petstoryBindings.length !== petstoryGuard.references.length) throw new PetStoryControlError('网页逐文件绑定未完成，零提交');
          await verifyPetStoryReferenceBindings(webview, petstoryBindings);
        } else if (mode === 'image') {
          const snapshot = await readPetStoryComposer(webview);
          if (!snapshot.present || !snapshot.generic || snapshot.pending || snapshot.count !== (attachments?.length || 0)) throw new PetStoryControlError('图片输入区或参考图回读不符，未提交');
        }
        // 此处尚未持久化提交意图，也未点击发送；保留为可恢复的输入检查失败。
        if (strictPrompt && !await verifyPromptReadyForSubmission(webview, prompt, true)) throw new PetStoryControlError('最终全文或段落回读不一致，未提交');
        const currentRuntime = useTaskStore.getState().tasks.find((item) => item.id === taskId)?.runtime;
        if (!canAttemptSubmission(expectedRunId, currentRuntime?.runId, currentRuntime?.submittedAt)) {
          throw new SubmissionSafetyPauseError('本次运行已存在发送记录或运行身份已变化；系统已停止，未再次发送');
        }
        const markedAt = new Date().toISOString();
        await updateTaskRuntime(taskId, {
          status: stage === 'waiting_verification' ? 'waiting_verification' : 'executing',
          runtime: {
            stage,
            message: messageText,
            stageStartedAt: markedAt,
            lastHeartbeatAt: markedAt,
            submittedAt: markedAt,
          },
        });
        const persistedRuntime = useTaskStore.getState().tasks.find((item) => item.id === taskId)?.runtime;
        if (persistedRuntime?.runId !== expectedRunId || persistedRuntime?.submittedAt !== markedAt) {
          throw new Error('提交意图持久化失败；为避免重复发送，本次未执行页面提交');
        }
        return markedAt;
      };

      // 参考素材首次用于某个账号时，新版页面会用“安全确认”遮挡发送按钮。
      // 自动化只识别、不代点。由于人工“确认”可能直接提交，必须先持久化提交意图，
      // 再等待用户操作并回读同一 run，避免任务失联或二次发送。
      if (mode === 'video' && attachments && attachments.length > 0) {
        const authorization = await inspectMaterialAuthorization(webview);
        if (authorization === 'blocked') {
          throw new AccountAvailabilityPauseError('素材安全确认未完成，请检查右侧页面；本次尚未提交', 'material_authorization_required');
        }
        if (authorization === 'present') {
          const waitingMessage = autoConfirmMaterialAuthorization
            ? '已识别素材授权白名单，准备单次确认并只读回查'
            : '等待你在右侧页面确认素材授权；确认后将自动继续跟踪，系统不会代点或重复发送';
          submissionMarkedAt = await markSubmissionIntent('waiting_verification', waitingMessage);
          setAccountAutomationState(accountId, 'injecting', waitingMessage, 'waiting_verification');
          useAccountStore.getState().selectAccount(accountId);
          const detectedAt = new Date().toISOString();
          const currentDiagnostics = useTaskStore.getState().tasks.find((item) => item.id === taskId)?.runtime?.executionDiagnostics;
          await updateTaskRuntime(taskId, {
            runtime: {
              executionDiagnostics: {
                ...currentDiagnostics,
                materialAuthorization: {
                  fingerprint: 'doubao-material-authorization-v1', detectedAt, outcome: 'detected',
                },
              },
            },
          });
          if (autoConfirmMaterialAuthorization) {
            const confirmationResult = await confirmMaterialAuthorizationIfAllowed(webview, {
              enabled: true,
              expectedConversationUrl: taskConversationUrl || '',
              assetsValidated: true,
            });
            const latestDiagnostics = useTaskStore.getState().tasks.find((item) => item.id === taskId)?.runtime?.executionDiagnostics;
            await updateTaskRuntime(taskId, {
              runtime: {
                executionDiagnostics: {
                  ...latestDiagnostics,
                  materialAuthorization: {
                    fingerprint: 'doubao-material-authorization-v1',
                    detectedAt: confirmationResult.detectedAt,
                    clickedAt: confirmationResult.clickedAt,
                    verifiedAt: confirmationResult.verifiedAt,
                    outcome: confirmationResult.status === 'confirmed' ? 'confirmed' : 'uncertain',
                  },
                },
              },
            });
            if (confirmationResult.status === 'not_allowed') {
              throw new AccountAvailabilityPauseError(`素材授权自动确认被安全门禁拒绝（${confirmationResult.reason}），请人工核对`, 'material_authorization_required');
            }
          } else {
            notification.warning({
              key: materialAuthorizationNotificationKey,
              message: '需要人工确认素材授权',
              description: '请核对素材权利后在豆包页面手动选择“确认”或“拒绝”。确认后任务会继续跟踪本次生成。',
              duration: 0,
            });
          }
          initializationLease?.release();
          initializationLease = undefined;

          const authorizationWaitStartedAt = Date.now();
          const authorizationTimeoutMs = 30 * 60 * 1000;
          while (true) {
            await pause(600);
            const evidence = await readSubmissionEvidence();
            if (classifySubmissionReadback(evidence) !== 'confirmed') await checkHumanVerification();
            const dialogState = await inspectMaterialAuthorization(webview);
            const progress = decideMaterialAuthorizationProgress({
              dialogState,
              submissionConfirmed: classifySubmissionReadback(evidence) === 'confirmed',
              elapsedMs: Date.now() - authorizationWaitStartedAt,
              timeoutMs: authorizationTimeoutMs,
            });
            if (progress === 'confirmed') {
              authorizationTriggeredSubmission = true;
              break;
            }
            if (progress === 'timeout') {
              throw new SubmissionSafetyPauseError('等待素材授权确认超时；提交意图已保留，系统不会自动重发');
            }
            if (progress === 'uncertain') {
              // 弹窗消失后给页面最多 6 秒产生权威提交回执；拒绝或异常关闭均不得补点发送。
              for (let attempt = 0; attempt < 12; attempt += 1) {
                await pause(500);
                const followup = await readSubmissionEvidence();
                if (classifySubmissionReadback(followup) === 'confirmed') {
                  authorizationTriggeredSubmission = true;
                  break;
                }
                await checkHumanVerification();
              }
              if (!authorizationTriggeredSubmission) {
                throw new SubmissionSafetyPauseError('素材授权弹窗已关闭，但未取得提交回执；请人工核对平台，系统不会自动重发');
              }
              break;
            }
          }
          notification.destroy(materialAuthorizationNotificationKey);
        }
      }

      if (!authorizationTriggeredSubmission && !await waitForSubmissionControlsStable(webview)) {
        throw new VideoControlReadinessError('submission_controls', {
          ...createVideoReadinessCheckpoint('submission_controls', {
            elapsedMs: Date.now() - videoReadinessStartedAt,
            attempts: 1,
            stableSamples: 0,
            recoveryAttempts: videoReadinessRecoveryAttempts,
          }),
          ready: false,
          failureStage: 'submission_controls',
          missingControl: 'send_control',
        });
      }
      await persistVideoReadiness('submission_controls');

      // 页内输入与发送控件的只读检查先于提交意图，不抢系统焦点或操作鼠标。
      const backgroundInput: BackgroundPageSubmission | undefined = backgroundTask ? {
        taskId,
        isCurrent: (): boolean => {
          const task = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
          return isBackgroundPetStoryTask(usePetStoryStore.getState().project, taskId, task)
            && task?.assignedAccountId === accountId && task.runtime?.runId === expectedRunId && task.status === 'executing'
            && automationEngine.ownsAccountController(taskId, accountId, controller);
        },
      } : undefined;
      if (!authorizationTriggeredSubmission) {
        const preparation = await preparePageSubmission(webview, undefined, backgroundInput);
        if (preparation.humanVerification) await pauseForHumanVerification(accountId);
        if (!preparation.ok) throw new AccountAvailabilityPauseError('当前页面输入区或发送控件尚未稳定；未记录提交意图、未发送，可继续原任务重新核对', 'page_unrecognized');
      }

      // P0：真实发送是不可重复副作用。先从当前任务快照核对 runId/submittedAt，
      // 再把本次提交意图持久化；写入失败或运行已变化时绝不点击页面。
      if (!submissionMarkedAt) {
        submissionMarkedAt = await markSubmissionIntent('submitting', '正在发送...');
      } else {
        await updateTaskRuntime(taskId, {
          status: 'executing',
          runtime: { stage: 'submitting', message: '素材授权已确认，正在回读本次提交...', lastHeartbeatAt: new Date().toISOString() },
        });
      }
      setAccountAutomationState(
        accountId,
        'submitting',
        authorizationTriggeredSubmission ? '素材授权已确认，正在回读本次提交...' : '正在发送...',
        'submitting',
      );
      // 必须和提交回读使用同一个 DOM 选择器；综合生成检测可能因为网络状态
      // 提前返回而没有消息计数，不能把旧会话消息误当成本次发送回执。
      let submitted = authorizationTriggeredSubmission;
      // 所有模式仅激活一次真实发送控件；平台不受理时保留原意图，不换策略重发。
      if (!authorizationTriggeredSubmission) {
        const dispatchController = new AbortController();
        const abortDispatch = (): void => dispatchController.abort();
        controller.signal.addEventListener('abort', abortDispatch, { once: true });
        if (controller.signal.aborted) abortDispatch();
        let dispatchTimeout: ReturnType<typeof setTimeout> | undefined;
        const dispatchDeadline = Date.now() + 10_000;
        try {
          submitted = await Promise.race([
            submitPromptOnce(webview, {
              signal: dispatchController.signal,
              deadlineAt: dispatchDeadline,
              dispatchKey: `${taskId}:${expectedRunId}:${submissionMarkedAt}`,
              expectedPrompt: prompt,
              strictParagraphs: strictPrompt,
              isCurrent: (): boolean => {
                const current = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
                return current?.assignedAccountId === accountId && current.status === 'executing'
                  && current.runtime?.runId === expectedRunId && current.runtime?.submittedAt === submissionMarkedAt
                  && current.runtime?.stage === 'submitting' && current.runtime?.input.prompt === prompt
                  && current.runtime?.input.mode === mode && automationEngine.ownsAccountController(taskId, accountId, controller);
              },
              verifyLease: (): Promise<boolean> => automationEngine.confirmSubmissionOwnership(taskId, accountId, controller),
            }, backgroundInput),
            new Promise<boolean>((_, reject): void => {
              dispatchTimeout = setTimeout((): void => { abortDispatch(); reject(new Error('提交超时')); }, 10_000);
            }),
          ]);
        } catch (error: unknown) {
          await checkHumanVerification();
          if (error instanceof HumanVerificationRequiredError) await pauseForHumanVerification(accountId);
          throw new SubmissionSafetyPauseError('发送动作结果不确定，请人工核对豆包会话；系统未自动重发');
        } finally {
          abortDispatch();
          if (dispatchTimeout) clearTimeout(dispatchTimeout);
          controller.signal.removeEventListener('abort', abortDispatch);
        }
      }
      if (!submitted) {
        await checkHumanVerification();
        throw new SubmissionSafetyPauseError('发送按钮不可用或点击结果不确定；系统已停止且未自动重发');
      }

      // 媒体消息与输入框可异步重绘，统一给原次发送 15 秒只读受理窗口。
      let confirmedEvidence = await waitForConfirmedSubmission({
        read: readSubmissionEvidence, wait: pause, onUnconfirmed: checkHumanVerification, signal: controller.signal,
      });
      if (!confirmedEvidence && mode === 'image') {
        // 页面消息与具体路由可能晚于首轮回执出现。保持原提交租约，只读补证，不退回发送。
        const original = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
        const originalInput = JSON.stringify(original?.runtime?.input);
        const assertOriginalImageSubmission = (): void => {
          const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
          if (controller.signal.aborted) throw new DOMException('图片提交核对已暂停', 'AbortError');
          if (!automationEngine.ownsAccountController(taskId, accountId, controller) || registryRef.current.get(accountId) !== webview
            || latest?.assignedAccountId !== accountId || latest.status !== 'executing' || !latest.runtime || latest.runtime.runId !== expectedRunId
            || latest.runtime.submittedAt !== submissionMarkedAt || JSON.stringify(latest.runtime.input) !== originalInput) {
            throw new SubmissionSafetyPauseError('原图片运行或输入已变化，停止核对且未重新发送');
          }
          trackSubmittedImageUrl(webview.getURL());
        };
        let lastDiagnostic = '';
        let recoveredImagePage: CurrentCreationConversationReadback | undefined;
        try {
          const located = await waitForSubmittedCreationReadback({
            signal: controller.signal, requireInputCleared: true, ensureCurrent: assertOriginalImageSubmission, wait: pause,
            read: async (): Promise<SubmittedCreationReadbackSample> => {
              await checkHumanVerification();
              assertOriginalImageSubmission();
              const observedUrl = webview.getURL();
              const page = await getCurrentCreationConversation(webview, { signal: controller.signal, ensureCurrent: assertOriginalImageSubmission });
              const concreteUrl = page.conversationUrl || normalizeDoubaoConversationUrl(observedUrl);
              if (concreteUrl) trackSubmittedImageUrl(concreteUrl);
              const snapshot = page.source === 'published_message' ? page.snapshot : concreteUrl ? await getCreationReadbackSnapshot(webview, {
                conversationUrl: concreteUrl, signal: controller.signal, ensureCurrent: assertOriginalImageSubmission, allowProviderConversation: true,
              }) : page.snapshot;
              recoveredImagePage = page.conversationId && page.conversationUrl && snapshot.historyComplete && snapshot.conversationId === page.conversationId
                ? { ...page, snapshot, source: 'published_message', messageIds: snapshot.messages.flatMap((item): string[] => item.messageId ? [item.messageId] : []) } : page;
              assertOriginalImageSubmission();
              const route = normalizeDoubaoConversationUrl(webview.getURL());
              if (concreteUrl && route && !isSameDoubaoConversation(concreteUrl, route)) throw new SubmissionSafetyPauseError('原图片会话已变化，未重新发送');
              const evidence = inspectCreationReadback(snapshot, prompt, 'image', initialMsgCount);
              const diagnostic = JSON.stringify(diagnoseCreationReadback(snapshot, prompt, 'image'));
              if (diagnostic !== lastDiagnostic) {
                lastDiagnostic = diagnostic;
                void window.electronAPI.logs.append({ level: 'info', scope: 'automation', taskId, accountId,
                  message: '图片发送受理只读诊断 ' + diagnostic }).catch((): void => undefined);
              }
              return { url: concreteUrl || observedUrl, evidence };
            },
          });
          assertOriginalImageSubmission();
          await preserveSubmittedConversation?.(located.evidence, located.url, recoveredImagePage);
          assertOriginalImageSubmission();
          confirmedEvidence = located.evidence;
        } catch (error: unknown) {
          if (error instanceof SubmittedCreationReadbackTimeoutError || error instanceof SubmittedCreationReadbackContextError) throw new SubmissionSafetyPauseError(error.message);
          throw error;
        }
      }
      const submissionConfirmed = !!confirmedEvidence;
      if (!submissionConfirmed) {
        await checkHumanVerification();
        if (latestChatReadback?.candidates.length) await updateTaskRuntime(taskId, { runtime: { chatReadbackReview: {
          runId: expectedRunId || '', checkedAt: new Date().toISOString(), reason: latestChatReadback.reason || 'submission_not_confirmed', candidates: latestChatReadback.candidates,
        } } });
        throw new SubmissionSafetyPauseError('发送状态不确定，请人工核对豆包会话；系统未自动重发');
      }
      // 原用户消息已全文匹配即保存具体会话，避免之后验证码／窗口退出丢失恢复定位。
      if (mode === 'chat') {
        const originalUrl = await waitForConcreteConversationUrl(webview, { timeoutMs: 15_000 });
        const originalTask = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
        const receipt = originalTask && latestChatReadback ? chatReadbackReceipt(originalTask, latestChatReadback, initialMsgCount) : undefined;
        if (!originalUrl || !receipt || !await updateTaskRuntime(taskId, { runtime: { conversationUrl: originalUrl, chatReadback: receipt } })) throw new SubmissionSafetyPauseError('原 Chat 会话定位或消息轮次保存失败；保留提交记录且不重发');
        taskConversationUrl = originalUrl;
      }
      const acceptedAt = new Date().toISOString();
      const acceptedTask = useTaskStore.getState().tasks.find((item) => item.id === taskId);
      const acceptedRunId = acceptedTask?.runtime?.runId;
      const acceptedTarget = mode === 'image' ? resolveTaskConversationTarget(acceptedTask) : undefined;
      const conversationUrl = acceptedTarget?.ok ? acceptedTarget.url : await waitForConcreteConversationUrl(webview, { timeoutMs: 15_000 });
      if (!confirmedEvidence || !acceptedRunId || !conversationUrl) {
        throw new SubmissionSafetyPauseError('平台已受理，但未取得具体原会话地址；已安全暂停且不会自动重发');
      }
      taskConversationUrl = conversationUrl;
      const generationStartedAt = await getGenerationStartTime(webview);
      const acceptanceObservation = createAcceptedObservationBinding({
        accountId,
        runId: acceptedRunId,
        conversationUrl,
        acceptedAt,
        ownerId: `renderer-${acceptedRunId}`,
        mode: mode as Task['mode'],
        evidence: confirmedEvidence,
        generationStartedAt,
        materialAuthorizationConfirmed: authorizationTriggeredSubmission,
      });
      const observationPersisted = await updateTaskRuntime(taskId, {
        status: 'generating',
        result: '平台已明确受理，正在观察原会话产物',
        errorInfo: null,
        runtime: {
          stage: 'generating',
          message: '平台已明确受理，正在观察原会话产物',
          stageStartedAt: acceptedAt,
          lastHeartbeatAt: acceptedAt,
          conversationUrl,
          acceptanceObservation,
        },
      });
      const persistedTask = useTaskStore.getState().tasks.find((item) => item.id === taskId);
      const persistedObservation = persistedTask?.runtime?.acceptanceObservation;
      const persistedTarget = resolveTaskConversationTarget(persistedTask);
      if (!observationPersisted || persistedObservation?.runId !== acceptedRunId ||
        persistedObservation.accountId !== accountId || persistedObservation.outcome !== 'observing' ||
        !persistedTarget.ok || !isSameDoubaoConversation(persistedTarget.url, conversationUrl)) {
        throw new SubmissionSafetyPauseError('平台已受理，但观察绑定写入或回读不一致；系统不会自动重发');
      }
      await checkHumanVerification();
      // 普通 Chat 使用发送前的消息基线和独立助手节点，保留快速回复。
      // 图片/视频的既有回读路径保持不变。
      if (mode !== 'chat') conversationTextAfterSubmit = await getConversationText(webview);
      initializationLease?.release();
      initializationLease = undefined;

      const videoBlockerContext = { baselineMessageCount: initialMsgCount, conversationUrl };

      // 只有持久化与回读成功后才触发队列；all_accepted 依赖此时才可放行其他账号。
      setAccountAutomationState(accountId, 'generating', '等待豆包生成回复...', 'generating');
      await pause(3000);

      let generating = true;
      let imageUrls: string[] = [];
      const generationWaitStartedAt = Date.now();
      const generationWaitBudgetMs = mode === 'video' ? 60 * 60 * 1000 : 10 * 60 * 1000;
      let unknownCount = 0;
      const maxUnknown = 10; // 连续 10 次无法确定（约 30 秒）触发兜底
      // Chat 只对本次用户消息之后的助手正文进行连续稳定采样。
      let stableStreak = 0;
      let lastConversationText = conversationTextAfterSubmit;
      let chatResponseText = '';

      if (mode === 'image') {
        const assertImageExecution = (): void => {
          const current = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
          if (controller.signal.aborted || !automationEngine.ownsAccountController(taskId, accountId, controller)
            || current?.status !== 'generating' || !current.runtime || current.runtime.runId !== expectedRunId || current.assignedAccountId !== accountId
            || current.runtime.submittedAt !== submissionMarkedAt || current.runtime.input.prompt !== prompt || registryRef.current.get(accountId) !== webview) {
            throw new DOMException('原图片运行已暂停或变化', 'AbortError');
          }
        };
        const receipt = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId)?.runtime?.mediaSubmissionReceipt;
        imageUrls = await observeWithHumanVerification(
          (signal: AbortSignal): Promise<string[]> => readAcceptedImageOutputs(webview, conversationUrl, signal, undefined, {
            prompt, runId: expectedRunId || '', userMessageId: receipt?.userMessageId, userTurnId: receipt?.userTurnId, allowUnidentifiedNewConversation: true,
          }, { ensureCurrent: assertImageExecution }), checkHumanVerification, controller.signal);
        assertImageExecution();
        // 早期受理时 provider 可能尚未完整挂载；原图稳定后再沿同一运行补存消息收据。
        await preserveSubmittedConversation?.();
        assertImageExecution();
        generating = false;
      }

      while (generating && Date.now() - generationWaitStartedAt < generationWaitBudgetMs) {
        await pause(3000);
        await checkHumanVerification();
        if (mode === 'video') {
          const confirmation = await inspectGenerationConfirmation(webview);
          if (confirmation.state === 'present') throw new GenerationConfirmationPauseError(confirmation);
        }
        try {
          const detail = mode === 'chat' ? undefined : await Promise.race([
            checkGeneratingDetailed(webview),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('检测超时')), 8000)),
          ]);

          if (mode === 'chat') {
            if (!taskConversationUrl || !isSameDoubaoConversation(webview.getURL(), taskConversationUrl)) {
              throw new SubmissionSafetyPauseError('观察页面已离开本次原会话；已停止且不会重发');
            }
            const currentTask = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
            if (!currentTask?.runtime || currentTask.runtime.runId !== expectedRunId || currentTask.runtime.input.prompt !== prompt) throw new SubmissionSafetyPauseError('原 Chat 运行或输入已变化；未收取，未重发');
            const readback = inspectChatReadback(await getChatPageSnapshot(webview), prompt, initialMsgCount,
              taskChatReadbackContext(currentTask, accountId, taskConversationUrl, webview.getURL()));
            latestChatReadback = readback;
            const replyText = readback.replyRawText;
            stableStreak = updateStableStreak(lastConversationText, replyText, stableStreak);
            lastConversationText = replyText;
            const decision = evaluateTerminal({
              baselineText: '',
              currentText: readback.promptPublished && readback.inputCleared && !readback.generating ? replyText : '',
              networkFinished: false,
              messageCountDelta: readback.messageCount - initialMsgCount,
              stableStreak,
            });
            if (decision === 'completed') {
              console.log(`[Automation:${accountId}] 真实回复终态确认：本次助手消息已稳定`);
              chatResponseText = replyText;
              generating = false;
            }
            unknownCount = 0;
          } else if (detail?.status === 'detected') {
            // 明确检测到结果（video/image 保留既有语义）
            generating = detail.generating;
            unknownCount = 0;
          } else {
            // 无法确定，使用消息数量兜底（video/image）
            unknownCount++;
            const currentMsgCount = detail?.messageCount || 0;
            // 如果消息数增加了（说明有新回复），且最新消息有产物或输入框可用，认为完成
            if (unknownCount >= maxUnknown && currentMsgCount > initialMsgCount) {
              console.log(`[Automation:${accountId}] 兜底检测：消息数从 ${initialMsgCount} → ${currentMsgCount}，认为生成完成`);
              generating = false;
            }
            if (unknownCount >= maxUnknown && !generating) {
              // 保持原消息计数路径的语义；无需额外读取。
            } else if (unknownCount >= maxUnknown) {
              const currentConversationText = await getConversationText(webview);
              if (conversationTextAfterSubmit && currentConversationText.length > conversationTextAfterSubmit.length && currentConversationText.startsWith(conversationTextAfterSubmit)) {
                console.log(`[Automation:${accountId}] 新版页面回读：会话内容已在提交后新增，认为生成完成`);
                generating = false;
              }
            }
          }
        } catch (error: unknown) {
          if (error instanceof SubmissionSafetyPauseError) throw error;
          unknownCount++;
          // JS 注入失败也计入 unknown
          if (unknownCount >= maxUnknown * 2) {
            console.warn(`[Automation:${accountId}] 连续 ${unknownCount} 次检测失败，继续等待`);
            unknownCount = maxUnknown; // 防止溢出
          }
        }
        if (mode === 'video') {
          imageUrls = await extractVideoOutputs(webview, taskConversationUrl, controller.signal, taskId);
          if (imageUrls.length > 0) {
            generating = false;
            break;
          }
          const blocker = await detectVideoGenerationBlocker(webview, videoBlockerContext);
          if (blocker) throw new Error(`豆包已停止生成：${blocker}`);
        }
        if (!generating) break;
        const elapsedSec = Math.round((Date.now() - generationWaitStartedAt) / 1000);
        setAccountAutomationState(accountId, 'generating', `等待回复... (${elapsedSec}s)`, 'generating');
      }
      if (generating) {
        if (latestChatReadback?.candidates.length) await updateTaskRuntime(taskId, { runtime: { chatReadbackReview: {
          runId: expectedRunId || '', checkedAt: new Date().toISOString(), reason: latestChatReadback.reason || 'reply_not_stable', candidates: latestChatReadback.candidates,
        } } });
        throw new Error('生成超时');
      }

      setAccountAutomationState(accountId, 'generating', '正在识别并绑定任务产物...', 'extracting_outputs');

      // 生成完成后获取产物
      if (mode === 'video') {
        // 视频生成耗时经常远超普通回复结束时间；以拿到视频地址为准。
        const maxVideoWaitMs = generationWaitBudgetMs;
        const pollIntervalMs = 10000;
        const startWait = generationWaitStartedAt;
        let pollCount = 0;
        let lastLogBucket = -1;

        while (imageUrls.length === 0 && Date.now() - startWait < maxVideoWaitMs) {
          await checkHumanVerification();
          pollCount++;

          imageUrls = await extractVideoOutputs(webview, taskConversationUrl, controller.signal, taskId);
          if (imageUrls.length > 0) {
            console.log(`[Automation:${accountId}] 获取视频地址成功: ${imageUrls.length} 个`);
            break;
          }

          const blocker = await detectVideoGenerationBlocker(webview, videoBlockerContext);
          if (blocker) {
            throw new Error(`豆包已停止生成：${blocker}`);
          }

          const elapsedSec = Math.round((Date.now() - startWait) / 1000);
          const maxSec = Math.round(maxVideoWaitMs / 1000);
          const logBucket = Math.floor(elapsedSec / 60);
          if (logBucket !== lastLogBucket || pollCount <= 3) {
            console.log(`[Automation:${accountId}] 视频产物尚未就绪，继续等待 (${elapsedSec}/${maxSec}s, 第 ${pollCount} 次)`);
            lastLogBucket = logBucket;
          }
          setAccountAutomationState(accountId, 'generating', `等待视频产物... (${Math.floor(elapsedSec / 60)}/${Math.floor(maxSec / 60)}分钟)`, 'extracting_outputs');
          await pause(pollIntervalMs);
        }

        if (imageUrls.length === 0) {
          throw new Error('视频产物等待超时，尚未获取到可下载地址');
        }
      } else if (mode !== 'chat' && imageUrls.length === 0) {
        // 图片等媒体模式：用 DOM 提取，最多重试 5 次
        for (let retry = 0; retry < 5; retry++) {
          const rawResult = await getResultUrl(webview);
          try {
            imageUrls = JSON.parse(rawResult);
          } catch {
            imageUrls = rawResult ? [rawResult] : [];
          }
          if (imageUrls.length > 0) break;
          console.log(`[Automation:${accountId}] 产物尚未加载，等待 2s 后重试 (${retry + 1}/5)`);
          await pause(2000);
        }
        if (mode === 'image' && imageUrls.length === 0) {
          throw new Error('图片生成已结束，但未识别到可用产物');
        }
      }
      console.log(`[Automation:${accountId}] 完成, 产物数量=${imageUrls.length}`);
      if (controller.signal.aborted) {
        throw new DOMException('任务已取消', 'AbortError');
      }
      if (mode === 'video') {
        const usageUnits = getVideoQuotaUsageUnits(videoConfig?.duration);
        await useAccountStore.getState().recordSeedanceUsage(accountId, usageUnits);
      }
      if (mode === 'chat') {
        if (!chatResponseText.trim()) throw new SubmissionSafetyPauseError('本次 Chat 最终正文为空；已停止且不会重发');
        const currentTask = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
        const receipt = currentTask && latestChatReadback ? chatReadbackReceipt(currentTask, latestChatReadback, initialMsgCount) : undefined;
        if (!receipt || receipt.runId !== expectedRunId) throw new SubmissionSafetyPauseError('Chat 原消息身份变化；正文未绑定，不会重发');
        const saved = await updateTaskRuntime(taskId, {
          runtime: { chatReadback: receipt, chatResponse: { text: chatResponseText, capturedAt: new Date().toISOString() } },
        });
        if (!saved) throw new SubmissionSafetyPauseError('Chat 已受理，但最终正文保存失败；请保留原会话，只读补取，不得重发');
      }
      await checkHumanVerification();
      await useAccountStore.getState().recordAccountOutcome(accountId, 'success');
      // 传入第一个 URL 作为 result（向后兼容），outputs 传完整数组
      await completeAutomation(taskId, accountId, imageUrls[0] || '', imageUrls);
      if (mode === 'image') submittedImagePagesRef.current.delete(taskId);
    } catch (caught: any) {
      let err = caught;
      // 旧控制器的迟到异常不允许把新运行或已完成／已暂停的原运行再次改成失败。
      const failedTask = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
      if (!automationEngine.ownsController(taskId, controller) || failedTask?.runtime?.runId !== expectedRunId
        || ['done', 'paused', 'cancelled', 'fail'].includes(failedTask?.status || '')) return;
      // 页面验证可能与派发失败／回读失败同一轮出现，先保留真实原因与账号阻断。
      if (err?.name !== 'AbortError') {
        try {
          await checkHumanVerification();
          if (err instanceof HumanVerificationRequiredError) await pauseForHumanVerification(accountId);
        }
        catch (verificationError: unknown) {
          if (verificationError instanceof AccountAvailabilityPauseError && verificationError.code === 'human_verification') err = verificationError;
        }
      }
      // 验证 DOM 回读可能跨过用户取消、重新运行或控制器移交；旧 catch 只保留账号阻断。
      const currentFailedTask = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
      if (!automationEngine.ownsController(taskId, controller) || currentFailedTask?.runtime?.runId !== expectedRunId
        || ['done', 'paused', 'cancelled', 'fail'].includes(currentFailedTask?.status || '')) return;
      const cancelled = err?.name === 'AbortError';
      const safetyPaused = err instanceof SubmissionSafetyPauseError;
      const petstoryPaused = err instanceof PetStoryControlError;
      const availabilityPaused = err instanceof AccountAvailabilityPauseError;
      const confirmationPaused = err instanceof GenerationConfirmationPauseError;
      const controlReadinessFailure = err instanceof VideoControlReadinessError || err instanceof ChatAttachmentUploadError;
      if (err instanceof VideoControlReadinessError && mode === 'video') {
        try {
          await persistVideoReadiness(err.diagnostic.currentStage || 'submission_controls', err.diagnostic);
        } catch (persistError) {
          console.error(`[Automation:${accountId}] 视频就绪诊断持久化失败:`, persistError);
        }
      }
      const acceptedObservationActive = useTaskStore.getState().tasks.find((item) => item.id === taskId)
        ?.runtime?.acceptanceObservation?.outcome === 'observing';
      const errorMessage = cancelled ? '用户已取消等待' : (err.message || String(err));
      const errorInfo = controlReadinessFailure
        ? { code: err.code, message: errorMessage, recoverable: true, detectedAt: new Date().toISOString() }
        : classifyTaskError(errorMessage);
      // 限制类失败（会员/额度/真人脸/内容审核）不扣减 Seedance 额度，
      // 也不应继续等待视频产物。recordSeedanceUsage 仅在成功路径调用。
      if (mode === 'video' && isRestrictionFailure(errorInfo.code)) {
        console.warn(`[Automation:${accountId}] 检测到限制类失败(${errorInfo.code})，不扣减额度`);
      }
      const quotaExhausted = mode === 'video' && errorInfo.code === 'quota_exhausted';
      if (quotaExhausted) await useAccountStore.getState().markSeedanceExhausted(accountId);
      if (!cancelled && !safetyPaused && !petstoryPaused && !availabilityPaused && !confirmationPaused && !controlReadinessFailure && !acceptedObservationActive) {
        await useAccountStore.getState().recordAccountOutcome(accountId, 'failure', errorInfo.code);
      }
      console.error(`[Automation:${accountId}] ${cancelled || safetyPaused || petstoryPaused || availabilityPaused || confirmationPaused ? '已暂停' : '失败'}:`, errorMessage);
      if (cancelled || safetyPaused || petstoryPaused || availabilityPaused || confirmationPaused || acceptedObservationActive) {
        const requestedCancellationStatus = pendingCancellationStatusRef.current.get(taskId);
        await pauseAutomation(
          taskId,
          accountId,
          cancelled && requestedCancellationStatus === 'cancelled'
            ? '任务已由本机控制面取消'
            : cancelled ? '用户已暂停，可随时重新执行' : errorMessage,
          availabilityPaused && err.code === 'human_verification'
            ? { status: 'waiting_verification', code: 'human_verification' }
            : acceptedObservationActive
            ? { status: 'manual_submission_observing', code: 'manual_review_required' }
            : confirmationPaused
            ? {
                status: 'waiting_generation_confirmation',
                code: 'generation_confirmation_required',
                generationConfirmation: {
                  detectedAt: err.evidence.detectedAt,
                  marker: err.evidence.marker || 'confirm_before_generation',
                  model: err.evidence.model,
                  duration: err.evidence.duration,
                  aspectRatio: err.evidence.aspectRatio,
                },
              }
            : availabilityPaused
            ? { status: 'waiting_verification', code: err.code }
            : petstoryPaused
              ? { status: 'paused', code: 'petstory_controls_unconfirmed' }
            : safetyPaused
              ? { status: 'paused', code: 'submission_uncertain' }
              : cancelled && requestedCancellationStatus === 'cancelled'
                ? { status: 'cancelled', code: 'cancelled' }
                : undefined,
        );
      } else {
        setAccountAutomationState(accountId, 'failed', errorMessage, 'failed');
        await failAutomation(taskId, accountId, errorMessage, errorInfo);

      }

      const restartTask = pendingRestartTasksRef.current.get(taskId);
      if (restartTask) {
        pendingRestartTasksRef.current.delete(taskId);
        const updated = await updateTask(taskId, restartTask);
        if (updated) {
          const armResult = await armTasks([taskId]);
          if (armResult.armed === 1 && armResult.failed === 0) {
            message.success('提示词已更新，任务已显式授权执行');
          } else {
            message.error(armResult.error || '提示词已更新，但执行授权写入失败；任务保持 hold');
          }
        }
      }
    } finally {
      initializationLease?.release();
      if (abortControllersRef.current.get(taskId) === controller) abortControllersRef.current.delete(taskId);
      if (automationEngine.ownsController(taskId, controller)) {
        notification.destroy(materialAuthorizationNotificationKey);
        pendingRestartTasksRef.current.delete(taskId);
        pendingCancellationStatusRef.current.delete(taskId);
        runningRef.current.delete(accountId);
      }
      await automationEngine.release(taskId, controller);
      setTimeout(() => useTaskStore.getState().processQueue(), 0);
    }
  };

  // ---- 导航 ----
  const getActiveWebview = useCallback(() => {
    if (!activeAccount) return null;
    return registryRef.current.get(activeAccount.id) || null;
  }, [activeAccount]);

  const handleRefresh = useCallback(() => { getActiveWebview()?.reload(); }, [getActiveWebview]);
  const handleGoBack = useCallback(() => { const w = getActiveWebview(); if (w?.canGoBack()) w.goBack(); }, [getActiveWebview]);
  const handleGoForward = useCallback(() => { const w = getActiveWebview(); if (w?.canGoForward()) w.goForward(); }, [getActiveWebview]);
  const handleGoHome = useCallback(() => {
    if (activeAccount) getActiveWebview()?.loadURL(getAccountHome(activeAccount));
  }, [activeAccount, getActiveWebview]);

  const showOverlay = activeAutoState && activeAutoState !== 'idle' && activeAutoState !== 'completed' && activeAutoState !== 'failed';

  return (
    <div className="browser-panel">
      <div className="browser-toolbar">
        <div className="browser-nav-buttons">
          <button onClick={handleGoBack} title="后退">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.5 3L5.5 8l5 5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button onClick={handleGoForward} title="前进">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M5.5 3l5 5-5 5" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button onClick={handleRefresh} title="刷新">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.5 8a5.5 5.5 0 00-10-2.5M2.5 8a5.5 5.5 0 0010 2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
              <path d="M2 3v3h3M14 13v-3h-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button onClick={handleGoHome} title={`回到${activeAccount?.platform === 'dola' ? ' Dola' : '豆包'}首页`}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 6l6-4.5L14 6v7.5a.5.5 0 01-.5.5h-3.5V9H6v5H2.5a.5.5 0 01-.5-.5V6z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <div className="browser-url-bar">
          <span className="browser-url-text">{activeAccount ? getAccountHost(activeAccount) : 'doubao.com'}</span>
        </div>
        <Tooltip title="粘贴豆包公开分享链接，下载该页面实际公开提供的视频流；不移除平台水印">
          <button
            onClick={() => setPublicShareDialogOpen(true)}
            title="解析公开分享链接"
            aria-label="解析公开分享链接"
            disabled={manualVideoExtracting}
            style={{
              width: 30,
              height: 30,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#6855c9',
              opacity: manualVideoExtracting ? 0.45 : 1,
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </Tooltip>
        <Tooltip title="从当前账号的可见对话提取视频；实验直取仅在右侧开关显式开启后参与">
          <button
            onClick={() => void handleExtractCurrentVideo()}
            title="提取当前对话视频"
            aria-label="提取当前对话视频"
            disabled={manualVideoExtracting || !activeAccount || !!(activeAccount && accountBusy[activeAccount.id])}
            style={{
              width: 30,
              height: 30,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: experimentalNoWatermark ? '#f59e0b' : '#6855c9',
              opacity: manualVideoExtracting || !activeAccount || !!(activeAccount && accountBusy[activeAccount.id]) ? 0.45 : 1,
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 6h16v12H4zM9 9l6 3-6 3V9z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
          </button>
        </Tooltip>
        <Popover trigger="click" placement="bottomRight" title="浏览器高级工具" content={<div className="browser-advanced"><label><Switch aria-label="实验直取" size="small" checked={experimentalNoWatermark} onChange={toggleExperimentalNoWatermark} /> 实验直取</label><p>默认关闭。仅影响手动提取，结果仍可能含水印；不代表正式平台能力已验收。</p></div>}>
          <Button size="small">高级</Button>
        </Popover>
      </div>

      <Modal
        open={publicShareDialogOpen}
        title="解析公开分享链接"
        okText="解析并下载公开流"
        cancelText="取消"
        confirmLoading={manualVideoExtracting}
        onOk={() => void handleDownloadPublicShareMedia()}
        onCancel={() => !manualVideoExtracting && setPublicShareDialogOpen(false)}
      >
        <p style={{ color: '#6b6d7c' }}>仅解析豆包公开分享页实际声明的媒体流，不使用账号 Cookie，不探测隐藏接口，也不会移除水印。</p>
        <Input
          value={publicShareUrl}
          onChange={(event) => setPublicShareUrl(event.target.value)}
          placeholder="粘贴 https://www.doubao.com/... 公开分享链接"
          autoFocus
        />
      </Modal>

      <div className="browser-viewport">
        {!activeAccount && (
          <div className="browser-panel-empty" style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
            <div className="browser-empty-content"><p>{accounts.length ? '请选择要查看的账号' : '尚无账号，请先添加本人豆包账号'}</p></div>
          </div>
        )}
        {activeLoading && (
          <div className="browser-loading-overlay">
            <div className="browser-loading-spinner" />
            <span>{loadText}</span>
          </div>
        )}

        {showOverlay && (
          <div className="automation-overlay">
            <div className="automation-indicator">
              <div className="automation-spinner" />
              <span>{activeAutoMsg}</span>
            </div>
          </div>
        )}

        {activeAutoState === 'completed' && (
          <div className="automation-toast completed">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="8" stroke="#238563" strokeWidth="2" />
              <path d="M5.5 9l2.5 2.5 4.5-5" stroke="#238563" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{activeAutoMsg}</span>
          </div>
        )}

        {activeAutoState === 'failed' && (
          <div className="automation-toast failed">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="8" stroke="#c44352" strokeWidth="2" />
              <path d="M6 6l6 6M12 6l-6 6" stroke="#c44352" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span>执行失败: {activeAutoMsg}</span>
          </div>
        )}

        <div
          ref={poolRef}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
};

function waitForWebviewReady(webview: HTMLWebViewElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const poll = async () => {
      if (Date.now() - startTime >= timeoutMs) {
        reject(new Error('页面就绪检测超时（' + timeoutMs + 'ms）'));
        return;
      }
      try {
        const ready = await waitForChatReady(webview, 3000);
        if (ready) resolve();
        else setTimeout(poll, 1000);
      } catch {
        setTimeout(poll, 1000);
      }
    };
    poll();
  });
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('任务已取消', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, ms);
    const handleAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('任务已取消', 'AbortError'));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

export default BrowserPanel;
