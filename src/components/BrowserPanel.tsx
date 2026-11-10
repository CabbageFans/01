import { createTaskRecoveryCoordinator } from '../automation/TaskRecoveryCoordinator';
import { stopTaskAutomation, type TaskStopCommand } from '../automation/taskStopCommand';
import { executeTaskAutomation } from '../automation/TaskExecutionCoordinator';
import { taskExecutionHostState } from '../automation/taskExecutionHostState';
import { AccountAvailabilityPauseError,formatResolutionMessage,hasAccountChatAdjustment } from '../automation/taskExecutionSupport';
import { matchesTaskRunCommand } from '../automation/taskDispatchGuards';
/**
 * src/components/BrowserPanel.tsx
 * 内嵌浏览器面板 — V4 正式版
 *
 * 架构：
 * - 每个账号独立 webview，CSS 显隐控制，切换不销毁
 * - 支持多账号并行自动化 + 同账号任务队列
 * - per-account 执行状态监听，自动路由任务到对应 webview
 */

import type { PetStoryConversationReply } from '@doubao-studio/contracts';
import { Button,Input,message,Modal,notification,Popover,Switch,Tooltip } from 'antd';
import React,{ useCallback,useEffect,useRef,useState } from 'react';
import { automationEngine } from '../automation/AutomationEngine';
import { runAdapterSelfCheck } from '../automation/doubaoAdapter';
import { useAccountStore } from '../store/useAccountStore';
import { usePetStoryStore } from '../store/usePetStoryStore';
import type { AutomationState } from '../store/useTaskStore';
import { useTaskStore } from '../store/useTaskStore';
import type { Account,AccountAvailability,AccountAvailabilitySource,Task } from '../types';
import { probeAccountAvailability } from '../utils/accountAvailability';
import type { ConversationSyncPageSnapshot,ConversationSyncResult } from '../utils/conversationSync';
import { conversationSyncPageSnapshotScript,syncTaskConversation } from '../utils/conversationSync';
import type { WebviewHandle } from '../utils/doubaoBridge';
import {
detectRobotVerification,dismissKnownDesktopDownloadPromotion,getChatPageSnapshot,getCurrentCreationConversation,manualResolveVideoArtifact
} from '../utils/doubaoBridge';
import { isExperimentalNoWatermarkEnabled,setExperimentalNoWatermarkEnabled } from '../utils/experimentalNoWatermark';
import { canSelectAccount,findInteractiveAccountId,getAccountAutomationScope,isAccountExecutionBusy } from '../utils/interactiveAccount';
import type { MaterialImagePageFailure } from '../utils/materialImagePages';
import { mediaSubmissionReceiptFor } from '../utils/mediaSubmissionReceipt';
import { isAccountAvailabilityBlock,PageAvailabilityCoordinator } from '../utils/pageAvailability';
import { readPetStoryConversationReplies } from '../utils/petstoryConversationReplies';
import type { TaskConversationTarget } from '../utils/taskConversationLocator';
import {
canLocateSubmittedMediaConversation,
isSameDoubaoConversation,
normalizeDoubaoConversationUrl,
openTaskConversation,
resolveTaskConversationTarget,
supportsDoubaoConversationLocator,
waitForConversationNavigator
} from '../utils/taskConversationLocator';
import { getTaskAccountIdForScope,getTaskExecutionScope,tasksExecutionConflict } from '../utils/taskExecutionScope';
import { classifyTaskError } from '../utils/taskRuntime';
import {
applyWebviewActivationStyle,
forceWebviewLayoutRepaint,
getWebviewHydrationAccountIds,
isWebviewDocumentReady,
} from '../utils/webviewHydration';
import type { WebviewResourceScope } from '../utils/webviewLifecycle';
import { createWebviewResourceScope } from '../utils/webviewLifecycle';
import { revealBrowser } from '../utils/workspace';

/** 页面仅提供轮次事实；账号、运行和完整任务输入必须来自正式任务记录。 */


/** 仅保护当前具体会话中的未终结原媒体提交，其他 Chat 保留被动同步。 */
function hasUnresolvedMediaConversation(tasks: readonly Task[], accountId: string, currentUrl: string): boolean {
  return tasks.some((task: Task): boolean => {
    if (task.assignedAccountId !== accountId || !['image', 'video'].includes(task.mode || '')
      || ['done', 'cancelled'].includes(task.status) || !task.runtime?.submittedAt) return false;
    const target = resolveTaskConversationTarget(task);
    return target.ok && isSameDoubaoConversation(target.url, currentUrl);
  });
}

/** 导航事件只能读取点击时的原运行，异步等待不允许换成同 taskId 的后续请求。 */
function sameTaskConversationRun(original: Task, current: Task | undefined): boolean {
  return !!original.runtime?.runId && !!current && current.id === original.id && current.projectId === original.projectId
    && current.mode === original.mode && current.assignedAccountId === original.assignedAccountId && current.prompt === original.prompt
    && current.runtime?.runId === original.runtime.runId && current.runtime.submittedAt === original.runtime.submittedAt
    && JSON.stringify(current.runtime.input) === JSON.stringify(original.runtime.input)
    && JSON.stringify(current.attachments || []) === JSON.stringify(original.attachments || [])
    && current.audioAttachment === original.audioAttachment && JSON.stringify(current.videoConfig) === JSON.stringify(original.videoConfig)
    && JSON.stringify(current.petstory) === JSON.stringify(original.petstory) && JSON.stringify(current.petstoryChat) === JSON.stringify(original.petstoryChat);
}

/** 只读确认当前媒体原消息并耐久保存；页面显示和导航在核验完成后由调用方处理。 */
async function locateSubmittedMediaConversation(task: Task, accountId: string, webview: WebviewHandle, assertCurrent: () => void): Promise<{
  target: TaskConversationTarget; providerIdentityMatches: boolean;
}> {
  let target = resolveTaskConversationTarget(task);
  if (!['image', 'video'].includes(task.mode || '') || !task.runtime?.submittedAt) return { target, providerIdentityMatches: false };
  // 已保存的原服务器收据不会因消息虚拟卸载失效；同一具体路由直接显示，不刷新重建。
  if (target.ok && task.runtime.mediaSubmissionReceipt && isSameDoubaoConversation(webview.getURL(), target.url)) {
    assertCurrent(); return { target, providerIdentityMatches: true };
  }
  const page = await getCurrentCreationConversation(webview, { ensureCurrent: assertCurrent });
  assertCurrent();
  const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === task.id);
  const receipt = mediaSubmissionReceiptFor(task, latest, accountId, page, new Date().toISOString());
  if (!target.ok) {
    if (!receipt) throw new Error('尚未从原账号当前页面核实这次已提交请求的服务器消息；未绑定其他对话，请先在原账号历史中打开原请求');
    const saved = await useTaskStore.getState().updateTaskRuntime(task.id, { expectedRunId: task.runtime.runId,
      runtime: { conversationUrl: receipt.conversationUrl, mediaSubmissionReceipt: receipt } });
    assertCurrent();
    const persisted = useTaskStore.getState().tasks.find((item): boolean => item.id === task.id);
    target = resolveTaskConversationTarget(persisted);
    if (!saved || !target.ok || persisted?.runtime?.mediaSubmissionReceipt?.userMessageId !== receipt.userMessageId) {
      throw new Error('原媒体会话定位保存未确认，未打开其他对话');
    }
  }
  const knownReceipt = receipt || latest?.runtime?.mediaSubmissionReceipt;
  return { target, providerIdentityMatches: target.ok && page.source === 'published_message' && page.snapshot.historyComplete === true
    && isSameDoubaoConversation(page.conversationUrl, target.url)
    && !!knownReceipt?.userMessageId && !!page.messageIds?.includes(knownReceipt.userMessageId) };
}

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



/** 将当前对话的结构化解析结果转换为用户可读消息。 */

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


/** 页面明确需要用户处理；任务进入等待处理态，禁止继续或自动重发。 */


/** 平台已收到提示词但要求用户确认参数；永久禁止自动回复确认或重发。 */




/** 只有本人继续的同一未发送修订，才可识别上次执行留下的完整请求草稿。 */


function accountAutomationDisplay(states: Record<string, AutomationState>, messages: Record<string, string>, accountId?: string): { state: AutomationState | undefined; text: string } {
  const scope = getAccountAutomationScope(states, accountId || '');
  return { state: states[scope || ''], text: messages[scope || ''] || '' };
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
  /** 首个文档出现后不再用不透明遮罩覆盖页面；导航就绪仍由 loadingMap 独立管理。 */
  const displayedAccountsRef = useRef<Set<string>>(new Set());
  const loadErrorsRef = useRef<Map<string, string>>(new Map());
  const runningRef = useRef(taskExecutionHostState.running);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const abortControllersRef = useRef(taskExecutionHostState.controllers);
  const pendingRestartTasksRef = useRef(taskExecutionHostState.restarts);
  const pendingCancellationStatusRef = useRef(taskExecutionHostState.cancellations);
  const manualVideoUsageRef = useRef<Set<string>>(new Set());
  const submissionReconcileRef = useRef(taskExecutionHostState.reconciling);
  const submissionReconcilePromisesRef = useRef(taskExecutionHostState.reconciliationPromises);
  // 未证明全文的地址只留在本次执行器内存中，供同一原运行只读交接，不充当受理凭据。
  const submittedImagePagesRef = useRef(taskExecutionHostState.submittedMediaPages);
  const passiveConversationSyncRef = useRef<Map<string, number>>(new Map());
  const submissionReconcileUsageRef = useRef(taskExecutionHostState.reconciliationUsage);
  const availabilityRequestHandledRef = useRef<Record<string, number>>({});
  const availabilityProbesRef = useRef(new PageAvailabilityCoordinator());
  /** 启动期一次只预热一个后台 Webview，完成后原分区页面常驻。 */
  const backgroundProbeRef = useRef<Set<string>>(new Set());
  const backgroundAuditedRef = useRef<Set<string>>(new Set());
  /** 当前预热完成后直接唤醒下一账号；定时轮询仅作为 Electron 漏事件兜底。 */
  const advanceBackgroundWarmupRef = useRef<() => void>(() => undefined);
  /** 每个账号的 webview 监听器与定时器作用域。 */
  const resourceScopesRef = useRef<Map<string, WebviewResourceScope>>(new Map());
  const materialPagesRef = useRef(taskExecutionHostState.pages);
  const [viewedTaskPageId, setViewedTaskPageId] = useState<string | null>(null);
  const [interactiveTaskPageId, setInteractiveTaskPageId] = useState<string | null>(null);
  const getTaskWebview = useCallback((task: Task): HTMLWebViewElement | undefined => materialPagesRef.current.uses(task)
    ? materialPagesRef.current.get(task) : registryRef.current.get(task.assignedAccountId || ''), []);
  const ownsTaskWebview = useCallback((taskId: string, webview: HTMLWebViewElement): boolean => {
    const current = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
    return !!current && getTaskWebview(current) === webview;
  }, [getTaskWebview]);
  const taskWebviewReady = useCallback((task: Task): boolean => materialPagesRef.current.uses(task)
    ? materialPagesRef.current.ready(task) : loadingMapRef.current.get(task.assignedAccountId || '') === false
      && !loadErrorsRef.current.has(task.assignedAccountId || ''), []);
  const ensureTaskWebview = useCallback((task: Task): HTMLWebViewElement | undefined => {
    if (!materialPagesRef.current.uses(task)) return getTaskWebview(task);
    const account = useAccountStore.getState().accounts.find((item): boolean => item.id === task.assignedAccountId);
    if (!account || !poolRef.current) return undefined;
    return materialPagesRef.current.ensure(task, account, poolRef.current, (): void => setWebviewEpoch((value: number): number => value + 1));
  }, [getTaskWebview]);
  const pauseFailedTaskPage = useCallback(async (task: Task, failure: MaterialImagePageFailure): Promise<void> => {
    const current = useTaskStore.getState().tasks.find((item: Task): boolean => item.id === task.id);
    if (!current || (current.runtime?.runId || '') !== failure.runId || current.assignedAccountId !== failure.accountId
      || current.status !== 'executing' || automationEngine.hasController(task.id)) return;
    const scope = getTaskExecutionScope(current);
    runningRef.current.add(scope);
    try {
      await useTaskStore.getState().pauseAutomation(task.id, failure.accountId, failure.message, { status: 'paused', code: failure.code });
    } catch { message.error('页面加载失败，任务暂停状态暂未保存；本次未进入输入或发送'); }
    finally {
      const latest = useTaskStore.getState().tasks.find((item: Task): boolean => item.id === task.id);
      if (!latest || (latest.runtime?.runId || '') === failure.runId) await automationEngine.release(task.id);
      if (!automationEngine.hasController(task.id)) runningRef.current.delete(scope);
      setTimeout((): void => { void useTaskStore.getState().processQueue(); }, 0);
    }
  }, []);

  const [activeLoading, setActiveLoading] = useState(false);
  const [loadText, setLoadText] = useState('加载豆包中...');
  const [loadError, setLoadError] = useState('');
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
    const coordinator = availabilityProbesRef.current;
    const existing = account.health?.availability;
    if (existing && isAccountAvailabilityBlock(existing)) coordinator.blockAccount(accountId, existing);
    const token = coordinator.begin(accountId, webview);
    const controlling = source === 'pre_task' || source === 'pre_submit';
    const isAccountPage = registryRef.current.get(accountId) === webview;
    const ownsPage = (): boolean => registryRef.current.get(accountId) === webview || materialPagesRef.current.contains(webview);
    accountState.setAvailabilityChecking(accountId, true);
    try {
      const availability = await probeAccountAvailability(webview, account.platform || 'doubao', source);
      const probe = coordinator.settle(token, availability, {
        isCurrent: ownsPage,
        allowAccountRecovery: isAccountPage && ['manual', 'navigation', 'startup'].includes(source),
      });
      if (probe.accountUpdate) {
        const saved = await useAccountStore.getState().setAccountAvailability(accountId, probe.accountUpdate);
        if (!saved && controlling) throw new AccountAvailabilityPauseError('本次页面检测结果未能保存，未继续输入或发送', 'page_changed');
      }
      const accountBlock = coordinator.currentAccountBlock(accountId);
      if (controlling && accountBlock) throw new AccountAvailabilityPauseError(accountBlock.message, accountBlock.reason);
      // 写盘也跨异步边界；原页面被删除／替换后不得继续控制或恢复任务。
      const currentProbe = (): boolean => probe.current && ownsPage() && coordinator.isCurrent(token);
      if (controlling && !currentProbe()) throw new AccountAvailabilityPauseError('本次页面或验证状态已变化，未继续输入或发送', 'page_changed');
      if (probe.accountUpdate?.state === 'ready' && currentProbe()) {
        await useTaskStore.getState().resumeAfterAccountVerification(accountId, availability.checkedAt);
        if (currentProbe()) setTimeout(() => useTaskStore.getState().processQueue(), 0);
      }
      if (source === 'manual') {
        if (availability.state === 'ready' && currentProbe()) message.success(`${account.name}：检测通过，可执行自动化`);
        else message.warning(`${account.name}：${availability.message}`);
      }
      // 任务判定只使用自己的页面事实，不能用同账号另一页面的缓存替代。
      return availability;
    } finally {
      coordinator.cancel(token);
      useAccountStore.getState().setAvailabilityChecking(accountId, coordinator.isChecking(accountId));
    }
  }, []);

  /** 验证只阻断所属账号；保留原 guest／会话供用户处理，不点击验证或刷新页面。 */
  const pauseForHumanVerification = useCallback(async (accountId: string): Promise<never> => {
    // 使此前已发起的 ready 探测失效，不能让它在验证出现后重新开放调度。
    const verification: AccountAvailability = { state: 'action_required', reason: 'human_verification',
      message: '需要在原账号页面完成人机验证，然后重新检测', checkedAt: new Date().toISOString(), source: 'pre_submit' };
    availabilityProbesRef.current.blockAccount(accountId, verification);
    const accountState = useAccountStore.getState();
    const current = accountState.accounts.find((item): boolean => item.id === accountId)?.health?.availability;
    if (current?.state !== 'action_required' || current.reason !== 'human_verification') {
      await accountState.setAccountAvailability(accountId, verification);
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

  const { state: activeAutoState, text: activeAutoMsg } = accountAutomationDisplay(accountAutoState, accountAutoMsg, activeAccount?.id);

  // ---- 组件卸载时清理所有 webview 资源与执行控制器 ----
  useEffect(() => {
    const resourceScopes = resourceScopesRef.current;
    const registry = registryRef.current;
    const loadingMap = loadingMapRef.current;
    const controllers = abortControllersRef.current;
    const runningAccounts = runningRef.current;
    const materialPages = materialPagesRef.current;
    return () => {
      materialPages.park();
      resourceScopes.forEach((scope) => scope.dispose());
      resourceScopes.clear();
      registry.forEach((webview) => webview.remove());
      registry.clear();
      loadingMap.clear();
      controllers.forEach((controller: AbortController, taskId: string): void => {
        const task = useTaskStore.getState().tasks.find((item: Task): boolean => item.id === taskId);
        if (task && materialPages.uses(task)) return;
        controller.abort(); controllers.delete(taskId);
        if (task) runningAccounts.delete(getTaskExecutionScope(task));
      });
      console.log('[BrowserPanel] 展示已卸载，独立任务由稳定宿主继续执行');
    };
  }, []);

  // React仅安装事件桥；恢复运行与共享观察Promise由稳定宿主和协调器持有。
  useEffect(() => {
    const { handleManualSubmission, handleSubmissionReconcileSafely } = createTaskRecoveryCoordinator({
      abortControllersRef, pendingCancellationStatusRef, submissionReconcileRef, submissionReconcilePromisesRef, submissionReconcileUsageRef,
      submittedImagePagesRef, materialPagesRef, visibleRef, getTaskWebview, ensureTaskWebview, taskWebviewReady,
      ownsTaskWebview, assertNoHumanVerification, performAvailabilityCheck, synchronizeConversation, conversationSyncMessage,
    });
    window.addEventListener('mark-manual-submission', handleManualSubmission);
    window.addEventListener('reconcile-task-submission', handleSubmissionReconcileSafely);
    return () => {
      window.removeEventListener('mark-manual-submission', handleManualSubmission);
      window.removeEventListener('reconcile-task-submission', handleSubmissionReconcileSafely);
    };
  }, [assertNoHumanVerification, performAvailabilityCheck, ensureTaskWebview, getTaskWebview, ownsTaskWebview, taskWebviewReady]);

  /** 幂等释放指定账号的 webview、监听器和定时器。 */
  const disposeAccountWebview = (accountId: string): void => {
    materialPagesRef.current.removeAccount(accountId);
    for (const [taskId, page] of submittedImagePagesRef.current) if (page.accountId === accountId) submittedImagePagesRef.current.delete(taskId);
    resourceScopesRef.current.get(accountId)?.dispose();
    resourceScopesRef.current.delete(accountId);
    const webview = registryRef.current.get(accountId);
    if (webview) {
      webview.remove();
      registryRef.current.delete(accountId);
    }
    loadingMapRef.current.delete(accountId);
    displayedAccountsRef.current.delete(accountId);
    loadErrorsRef.current.delete(accountId);
    backgroundProbeRef.current.delete(accountId);
    backgroundAuditedRef.current.delete(accountId);
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
    for (const scope of runningRef.current) if (getTaskAccountIdForScope(scope) === accountId) runningRef.current.delete(scope);
  };

  // ---- webview 池动态管理（账号增删同步） ----
  const accountsKey = accounts.map(a => a.id).join(',');
  useEffect(() => {
    const container = poolRef.current;
    if (!container) return;

    const accountIds = new Set(accounts.map(a => a.id));
    const protectedTasks = { ...executingTasks };
    // 重启恢复的只读观察没有派发槽，也必须保护账号宿主，不能因切页回收并中断原结果。
    for (const task of tasks) {
      if (task.assignedAccountId && ['executing', 'generating', 'manual_submission_observing', 'waiting_verification'].includes(task.status)) {
        protectedTasks[task.assignedAccountId] = task.id;
      }
    }

    // 清理已删除账号的 webview 和定时器
    registryRef.current.forEach((webview, accountId) => {
      if (!accountIds.has(accountId)) {
        disposeAccountWebview(accountId);
        console.log(`[BrowserPanel] 已移除账号 ${accountId} 的 webview`);
      }
    });

    // 优先挂载当前／任务账号，其余账号由下方单通道依次预热。
    // 已创建页面始终保留，任务更新和账号切换不能中断在途导航再重新加载。
    const hydrationIds = getWebviewHydrationAccountIds(
      accounts,
      activeAccount?.id || null,
      protectedTasks,
    );
    for (const accountId of hydrationIds) {
      const account = accounts.find((item) => item.id === accountId);
      if (account) createWebview(account, container);
    }

    // 确保当前活跃账号的加载状态同步
    if (activeAccount) {
      const isLoading = loadingMapRef.current.get(activeAccount.id);
      const error = loadErrorsRef.current.get(activeAccount.id) || '';
      setActiveLoading(!!isLoading && !displayedAccountsRef.current.has(activeAccount.id) && !error);
      setLoadError(error);
      if (!isLoading) setLoadText('');
      console.log(`[BrowserPanel] webview 池同步完成 (当前 ${registryRef.current.size} 个), activeAccount=${activeAccount.id}, isLoading=${isLoading}`);
    } else {
      setActiveLoading(false);
      setLoadError('');
      console.log(`[BrowserPanel] webview 池同步完成 (当前 ${registryRef.current.size} 个), 无活跃账号`);
    }
  }, [accountsKey, refreshKey, activeAccount?.id, executingTasks, tasks]);

  // ---- 创建单个 webview ----
  const createWebview = (account: Account, container: HTMLDivElement): void => {
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
    let navigationFailed = false;

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
      if (navigationFailed) return;
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

    const startLoadTimeout = (): void => {
      scope.clearTimer(timeoutId);
      timeoutId = setTimeout((): void => {
        if (!scope.active || !loadingMapRef.current.get(accId)) return;
        scope.clearTimer(pollInterval);
        const reason = '页面连接较慢，请检查网络后刷新重试';
        loadErrorsRef.current.set(accId, reason);
        setWebviewEpoch((value: number): number => value + 1);
        if (useAccountStore.getState().selectedAccountId === accId) {
          setActiveLoading(false);
          setLoadError(reason);
        }
      }, 15_000);
      scope.trackTimer(timeoutId);
    };

    // 文档可读就直接显示，不等待隐藏宿主可能暂停的 requestAnimationFrame。
    // 账号可用性和正式输入／提交前的控件回读仍独立执行。
    const markLoaded = (evt: string): void => {
      if (!scope.active || navigationFailed) return;
      if (!loadingMapRef.current.get(accId)) return; // 已标记完成，不重复处理
      loadingMapRef.current.set(accId, false);
      displayedAccountsRef.current.add(accId);
      loadErrorsRef.current.delete(accId);
      // 页面状态存在 ref 中；通知正式派发 effect 重新评估等待首屏的任务。
      setWebviewEpoch((value: number): number => value + 1);
      scope.clearTimer(pollInterval);
      scope.clearTimer(timeoutId);
      console.log(`[BrowserPanel] markLoaded: ${accId} via ${evt}`);
      const cur = useAccountStore.getState().selectedAccountId;
      if (accId === cur) {
        setActiveLoading(false);
        setLoadText('');
        setLoadError('');
        void forceWebviewLayoutRepaint(webview);
      }
      if (backgroundProbeRef.current.has(accId)) {
        scope.clearTimer(warmupReleaseTimer);
        // 只保留一个很短的稳定窗口，随后由完成事件直接串行启动下一账号。
        // 可用性复检继续在后台执行，不再阻塞整个账号池的预热。
        warmupReleaseTimer = setTimeout(finishBackgroundProbe, 250);
        scope.trackTimer(warmupReleaseTimer);
      }
    };

    scope.listen(webview, 'did-start-navigation', (rawEvent: Event): void => {
      if (!scope.active) return;
      const event = rawEvent as Event & { isMainFrame?: boolean; isInPlace?: boolean };
      // 子框架／SPA 地址变化不代表主文档丢失；不能反复遮盖已经可交互的页面。
      if (event.isMainFrame !== true || event.isInPlace) return;
      navigationFailed = false;
      loadErrorsRef.current.delete(accId);
      // 稳定窗口内再次导航说明页面尚未真正就绪，禁止提前并发下一账号。
      scope.clearTimer(warmupReleaseTimer);
      loadingMapRef.current.set(accId, true);
      startLoadTimeout();
      const cur = useAccountStore.getState().selectedAccountId;
      if (accId === cur) {
        setActiveLoading(!displayedAccountsRef.current.has(accId));
        setLoadText('页面加载中...');
        setLoadError('');
      }
    });

    scope.listen(webview, 'did-finish-load', () => { markLoaded('did-finish-load'); scheduleAvailabilityCheck('navigation'); });
    scope.listen(webview, 'did-stop-loading', () => { markLoaded('did-stop-loading'); scheduleAvailabilityCheck('navigation'); });
    // did-navigate 只代表主文档地址变化，豆包 SPA 此时可能仍是空壳；不能提前撤掉加载层。
    scope.listen(webview, 'did-navigate', () => undefined);
    scope.listen(webview, 'did-navigate-in-page', () => { scheduleAvailabilityCheck('navigation'); });
    scope.listen(webview, 'dom-ready', () => {
      markLoaded('dom-ready');
      scheduleAvailabilityCheck(account.health?.availability ? 'navigation' : 'startup');
    });
    scope.listen(webview, 'did-fail-load', (rawEvent) => {
      if (!scope.active) return;
      const event = rawEvent as Event & { errorCode?: number; isMainFrame?: boolean };
      // Chromium 导航替换会产生 ERR_ABORTED；子资源失败也不等于主页面不可用。
      if (event.errorCode === -3 || event.isMainFrame === false) return;
      navigationFailed = true;
      loadingMapRef.current.set(accId, false);
      scope.clearTimers();
      const reason = '页面加载失败，请检查网络后刷新重试';
      loadErrorsRef.current.set(accId, reason);
      setWebviewEpoch((value: number): number => value + 1);
      const cur = useAccountStore.getState().selectedAccountId;
      if (accId === cur) {
        setActiveLoading(false);
        setLoadText('');
        setLoadError(reason);
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
    pollInterval = setInterval(async (): Promise<void> => {
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
        // 下方有界定时器负责提示连接缓慢，正式加载事件仍可立即显示迟到文档。
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

    startLoadTimeout();
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
        !isAccountExecutionBusy(useTaskStore.getState().accountBusy, account.id),
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
      if (isAccountExecutionBusy(useTaskStore.getState().accountBusy, accountId)) return;
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
    if (!activeAccount) {
      setActiveLoading(false);
      setLoadError('');
    }
    registryRef.current.forEach((webview, accountId) => {
      const isActive = accountId === activeAccount?.id;
      if (isActive) backgroundProbeRef.current.delete(accountId);
      applyWebviewActivationStyle(webview.style, isActive);
      if (isActive) {
        const isLoading = loadingMapRef.current.get(accountId);
        const error = loadErrorsRef.current.get(accountId) || '';
        setActiveLoading(!!isLoading && !displayedAccountsRef.current.has(accountId) && !error);
        setLoadError(error);
        if (!isLoading) {
          setLoadText('');
          void forceWebviewLayoutRepaint(webview);
        } else {
          setLoadText('页面加载中...');
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
        ? [result.url]
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
    const handleCancelAutomation = (event: Event): void => {
      const detail = (event as CustomEvent<TaskStopCommand>).detail;
      if (!detail?.taskId) return;
      if (!matchesTaskRunCommand(useTaskStore.getState().tasks.find((task): boolean => task.id === detail.taskId), detail)) return;
      void stopTaskAutomation({ abortControllersRef, pendingRestartTasksRef, pendingCancellationStatusRef }, detail).then((saved: boolean): void => {
        if (saved) message.info(detail.restartTask ? '正在停止旧任务并重新排队...' : '本地等待已停止，平台原请求保留');
        else message.error(useTaskStore.getState().error || '本地执行已停止，暂停记录尚未保存，请重试保存');
      }).catch((): void => { message.error('本地执行已停止，暂停记录尚未保存，请重试保存'); });
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
      if (hasAccountChatAdjustment(detail.accountId) || state.tasks.some((other): boolean => other.id !== task.id && tasksExecutionConflict(other, task)
        && ['executing', 'generating', 'manual_submission_observing', 'waiting_verification', 'waiting_generation_confirmation'].includes(other.status))) throw new Error('原账号正在处理其他对话，请等待其结束');
      if (!canSelectAccount(detail.accountId, findInteractiveAccountId(state.accountAutomationState))) throw new Error('另一个账号正在提交，请稍后打开原账号');
      return task;
    };
    const revealImageAccount = (detail: ImageRecoveryPageDetail): void => {
      const task = originalImageAccount(detail);
      if (materialPagesRef.current.uses(task)) { ensureTaskWebview(task); setViewedTaskPageId(task.id); }
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
        const task = originalImageAccount(detail);
        const webview = await waitForConversationNavigator(() => getTaskWebview(task), {
          timeoutMs: 6000, isReady: (): boolean => taskWebviewReady(task),
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
  }, [ensureTaskWebview, getTaskWebview, taskWebviewReady]);

  useEffect(() => {
    const handleOpenConversation = async (event: Event): Promise<void> => {
      const detail = (event as CustomEvent<{ task: Task; locateSubmittedMedia?: boolean; isCurrentSource?: () => boolean }>).detail;
      const sourceIsCurrent = (): boolean => {
        try { return detail?.isCurrentSource ? detail.isCurrentSource() : true; }
        catch { return false; }
      };
      const task = detail?.task;
      const accountId = task?.assignedAccountId;
      const account = useAccountStore.getState().accounts.find((item) => item.id === accountId);
      let conversationTarget = resolveTaskConversationTarget(task);
      const locateSubmittedMedia = detail?.locateSubmittedMedia === true && canLocateSubmittedMediaConversation(task);
      if (!task || !accountId || !account || !sourceIsCurrent() || !supportsDoubaoConversationLocator(account.platform)
        || !sameTaskConversationRun(task, useTaskStore.getState().tasks.find((item): boolean => item.id === task.id))
        || !conversationTarget.ok && !locateSubmittedMedia) {
        message.warning('该任务没有可验证的原会话地址');
        return;
      }
      if (hasAccountChatAdjustment(accountId)) { message.info('请先采用当前回复或结束调整，再打开其他任务会话'); return; }
      if (!canSelectAccount(accountId, findInteractiveAccountId(useTaskStore.getState().accountAutomationState))) { message.info('另一个账号正在提交，请稍后打开原会话'); return; }
      useAccountStore.getState().selectAccount(accountId);
      ensureTaskWebview(task);
      const webview = await waitForConversationNavigator(
        () => getTaskWebview(task),
        { timeoutMs: 20_000, isReady: () => taskWebviewReady(task) },
      );
      if (!webview) {
        message.warning('账号页面未能及时就绪，未跳转到其它会话');
        return;
      }
      const currentContext = (): boolean => {
        const state = useTaskStore.getState();
        return sourceIsCurrent() && sameTaskConversationRun(task, state.tasks.find((item): boolean => item.id === task.id))
          && ownsTaskWebview(task.id, webview) && !hasAccountChatAdjustment(accountId)
          && canSelectAccount(accountId, findInteractiveAccountId(state.accountAutomationState))
          && !state.tasks.some((item): boolean => item.id !== task.id && tasksExecutionConflict(item, task)
            && ['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'].includes(item.status));
      };
      const assertCurrent = (): void => { if (!currentContext()) throw new Error('原任务、账号或执行现场已变化，请重新打开对应任务'); };
      const showOriginalPage = (): void => {
        assertCurrent();
        setViewedTaskPageId(materialPagesRef.current.uses(task) ? task.id : null);
        revealBrowser();
      };
      try {
        assertCurrent();
        const located = await locateSubmittedMediaConversation(task, accountId, webview, assertCurrent);
        conversationTarget = located.target;
        if (!conversationTarget.ok) throw new Error('该任务尚无可验证的原会话地址');
        if (located.providerIdentityMatches) {
          showOriginalPage(); message.success('已打开任务对应的原豆包对话'); return;
        }
        const accountBusy = useTaskStore.getState().tasks.some((item): boolean => tasksExecutionConflict(item, task)
          && ['executing', 'generating', 'manual_submission_observing'].includes(item.status));
        if (accountBusy || submissionReconcileRef.current.has(task.id)) {
          if (isSameDoubaoConversation(webview.getURL(), conversationTarget.url)) { showOriginalPage(); message.info('原会话正在观察中，已保留当前现场'); }
          else message.warning('原账号正在处理任务，请稍后打开原会话');
          return;
        }
        const navigation = await synchronizeConversation(webview, conversationTarget.url, currentContext);
        assertCurrent();
        if (navigation.ok) { showOriginalPage(); message.success('已同步并打开任务对应的原会话'); }
        else message.warning(conversationSyncMessage(navigation));
      } catch (error: unknown) {
        message.warning(error instanceof Error ? error.message : '原会话核对未完成，未打开其他对话');
      }
    };
    window.addEventListener('open-task-conversation', handleOpenConversation);
    return () => window.removeEventListener('open-task-conversation', handleOpenConversation);
  }, [ensureTaskWebview, getTaskWebview, ownsTaskWebview, taskWebviewReady]);

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
      if (!webview || !target || hasUnresolvedMediaConversation(useTaskStore.getState().tasks, accountId, target)) return;
      syncing = true;
      passiveConversationSyncRef.current.set(accountId, Date.now());
      try { await synchronizeConversation(webview, target, (): boolean => current() && registryRef.current.get(accountId) === webview
        && !hasUnresolvedMediaConversation(useTaskStore.getState().tasks, accountId, webview.getURL()), 'visibility', controller.signal); }
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
        const task = useTaskStore.getState().tasks.find((item: Task): boolean => item.assignedAccountId === activeAccount.id
          && ['executing', 'generating', 'waiting_verification', 'manual_submission_observing'].includes(item.status));
        const saved = await window.electronAPI.tasks.saveAdapterReport(activeAccount.id, report, task ? {
          taskId: task.id, runId: task.runtime?.runId, projectId: task.petstory?.projectId || task.projectId,
          shotId: task.runtime?.input.videoInputSnapshot?.shotId, stepId: task.petstory?.stepId,
        } : undefined);
        if (!saved.success) throw new Error(saved.error || '页面自检完成，但诊断记录未保存，请重试保存');
        window.dispatchEvent(new CustomEvent('adapter-self-check-result', { detail: { report } }));
      } catch (error: any) {
        window.dispatchEvent(new CustomEvent('adapter-self-check-result', { detail: { error: error.message || String(error) } }));
      }
    };
    window.addEventListener('adapter-self-check', handleAdapterSelfCheck);
    return () => window.removeEventListener('adapter-self-check', handleAdapterSelfCheck);
  }, [activeAccount]);

  // 正式图片操作及准备文字使用独立任务页面；素材和镜头仍遵守原调度范围。
  useEffect((): void => {
    for (const [scope, taskId] of Object.entries(executingTasks)) {
      if (!accountBusy[scope] || runningRef.current.has(scope)) continue;
      const task = tasks.find((item): boolean => item.id === taskId);
      const accountId = task?.assignedAccountId;
      if (!task || !accountId) continue;
      let webview: HTMLWebViewElement | undefined;
      try { webview = ensureTaskWebview(task); }
      catch (error: unknown) {
        runningRef.current.add(scope);
        const reason = error instanceof Error ? error.message : '图片执行页面未能创建';
        void useTaskStore.getState().failAutomation(taskId, accountId, reason, classifyTaskError(reason))
          .finally(async (): Promise<void> => { runningRef.current.delete(scope); await automationEngine.release(taskId); });
        continue;
      }
      const pageFailure = materialPagesRef.current.failure(task);
      if (pageFailure) { void pauseFailedTaskPage(task, pageFailure); continue; }
      const accountPageError = !materialPagesRef.current.uses(task) && loadErrorsRef.current.get(accountId);
      if (accountPageError) {
        // 未进入执行器的共享页任务也必须收束，不能永久占住 executing 和账号槽。
        void pauseFailedTaskPage(task, { taskId, accountId, runId: task.runtime?.runId || '',
          code: 'page_loading', message: accountPageError });
        continue;
      }
      if (!webview || !taskWebviewReady(task)) continue;
      runningRef.current.add(scope);
      void executeTaskAutomation({ runningRef, abortControllersRef, pendingRestartTasksRef, pendingCancellationStatusRef, submittedImagePagesRef, materialPagesRef, setInteractiveTaskPageId, ownsTaskWebview, assertNoHumanVerification, pauseForHumanVerification, performAvailabilityCheck, conversationSynchronizations }, accountId, taskId, task.prompt, task.mode || 'chat', webview, task.videoConfig, task.attachments, task.audioAttachment);
    }
  }, [accountBusy, executingTasks, tasks, webviewEpoch, ensureTaskWebview, taskWebviewReady, pauseFailedTaskPage]);

  // 页面不借用账号池；删除账号、改变运行身份或结束任务时仅释放自己的资源。
  useEffect((): void => {
    materialPagesRef.current.prune(tasks, new Set(accounts.map((account: Account): string => account.id)), viewedTaskPageId);
    const viewed = tasks.find((task: Task): boolean => task.id === viewedTaskPageId && task.assignedAccountId === activeAccount?.id);
    const foreground = interactiveTaskPageId || (visible && viewed ? viewed.id : null);
    materialPagesRef.current.activate(foreground);
    const presented = tasks.find((task: Task): boolean => task.id === foreground);
    if (presented && materialPagesRef.current.uses(presented)) {
      setActiveLoading(!materialPagesRef.current.ready(presented));
      // 当前展示的是独立任务页，不沿用账号自由聊天页的网络错误或刷新入口。
      setLoadError('');
      if (materialPagesRef.current.ready(presented)) setLoadText('');
    } else if (activeAccount) {
      const error = loadErrorsRef.current.get(activeAccount.id) || '';
      setLoadError(error);
      setActiveLoading(!!loadingMapRef.current.get(activeAccount.id) && !displayedAccountsRef.current.has(activeAccount.id) && !error);
    }
    registryRef.current.forEach((webview: HTMLWebViewElement, accountId: string): void => {
      applyWebviewActivationStyle(webview.style, !foreground && accountId === activeAccount?.id);
    });
  }, [tasks, accounts, viewedTaskPageId, interactiveTaskPageId, activeAccount, visible, webviewEpoch]);

  // 应用重启或页面重新挂载后，只沿已持久化的原会话恢复观察；不进入注入/发送流程。
  useEffect(() => {
    tasks.forEach((task) => {
      if (task.status !== 'manual_submission_observing' ||
        task.runtime?.acceptanceObservation?.outcome !== 'observing' ||
        !task.assignedAccountId ||
        pendingCancellationStatusRef.current.has(task.id) ||
        submissionReconcileRef.current.has(task.id)) return;
      try { ensureTaskWebview(task); } catch { return; }
      if (!getTaskWebview(task) || !taskWebviewReady(task)) return;
      window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: task.id, automatic: true } }));
    });
  }, [tasks, webviewEpoch, ensureTaskWebview, getTaskWebview, taskWebviewReady]);

  // ---- 自动化执行 ----

  // ---- 导航 ----
  const getActiveWebview = useCallback(() => {
    if (!activeAccount) return null;
    const pageTaskId = interactiveTaskPageId || viewedTaskPageId;
    const task = useTaskStore.getState().tasks.find((item): boolean => item.id === pageTaskId && item.assignedAccountId === activeAccount.id);
    return task && materialPagesRef.current.uses(task) ? getTaskWebview(task) || null : registryRef.current.get(activeAccount.id) || null;
  }, [activeAccount, viewedTaskPageId, interactiveTaskPageId, getTaskWebview]);

  const handleRefresh = useCallback(() => { getActiveWebview()?.reload(); }, [getActiveWebview]);
  const handleGoBack = useCallback(() => { const w = getActiveWebview(); if (w?.canGoBack()) w.goBack(); }, [getActiveWebview]);
  const handleGoForward = useCallback(() => { const w = getActiveWebview(); if (w?.canGoForward()) w.goForward(); }, [getActiveWebview]);
  const handleGoHome = useCallback(() => {
    if (!activeAccount) return;
    // 返回账号页只切换所展示的页面，绝不导航仍在观察的图片任务现场。
    if (viewedTaskPageId || interactiveTaskPageId) { setViewedTaskPageId(null); return; }
    getActiveWebview()?.loadURL(getAccountHome(activeAccount));
  }, [activeAccount, getActiveWebview, viewedTaskPageId, interactiveTaskPageId]);

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
            disabled={manualVideoExtracting || !activeAccount || !!(activeAccount && isAccountExecutionBusy(accountBusy, activeAccount.id))}
            style={{
              width: 30,
              height: 30,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: experimentalNoWatermark ? '#f59e0b' : '#6855c9',
              opacity: manualVideoExtracting || !activeAccount || !!(activeAccount && isAccountExecutionBusy(accountBusy, activeAccount.id)) ? 0.45 : 1,
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
        {activeAccount && activeLoading && (
          <div className="browser-loading-overlay">
            <div className="browser-loading-spinner" />
            <span>{loadText}</span>
          </div>
        )}

        {activeAccount && loadError && (
          <div className="browser-load-error" role="alert">
            <span>{loadError}</span>
            <Button size="small" onClick={handleRefresh} disabled={isAccountExecutionBusy(accountBusy, activeAccount.id)}>刷新页面</Button>
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





export default BrowserPanel;
