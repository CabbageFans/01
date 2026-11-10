import { message,notification } from 'antd';
import { automationEngine } from '../automation/AutomationEngine';
import { DoubaoVideoAdapter } from '../automation/DoubaoVideoAdapter';
import { AccountAvailabilityPauseError,chatReadbackReceipt,GenerationConfirmationPauseError,resumableRepairDraft,sleepWithAbort,SubmissionSafetyPauseError,taskChatReadbackContext,waitForWebviewReady } from '../automation/taskExecutionSupport';
import { useAccountStore } from '../store/useAccountStore';
import { acceptProductionSnapshot,usePetStoryStore } from '../store/usePetStoryStore';
import type { AutomationState } from '../store/useTaskStore';
import { useTaskStore } from '../store/useTaskStore';
import type { AccountAvailability,AccountAvailabilitySource,Task,TaskUpdateInput } from '../types';
import { createAcceptedObservationBinding } from '../utils/acceptedObservation';
import { availabilityBlocksAutomation } from '../utils/accountAvailability';
import { ChatAttachmentUploadError } from '../utils/chatAttachments';
import type { ChatReadbackResult } from '../utils/chatReadback';
import { diagnoseCreationReadback,inspectChatReadback,inspectCreationReadback } from '../utils/chatReadback';
import type { ConversationSyncResult } from '../utils/conversationSync';
import type { CurrentCreationConversationReadback } from '../utils/creationConversationIdentity';
import type { BackgroundPageSubmission,CreationModeEntryDiagnostic } from '../utils/doubaoBridge';
import {
bindPetStoryReferences,checkGeneratingDetailed,checkPetStoryPageGuard,clickAITab,
configureVideoOptions,confirmMaterialAuthorizationIfAllowed,detectVideoGenerationBlocker,dismissKnownDesktopDownloadPromotion,ensurePlainChatComposer,getChatPageSnapshot,getConversationText,getCreationReadbackSnapshot,
getCurrentCreationConversation,getGenerationStartTime,getResultUrl,getSubmissionEvidence,getSubmissionMessageCount,getVideoModelUiLabel,injectGenerationMonitor,injectPrompt,inspectGenerationConfirmation,inspectMaterialAuthorization,PetStoryControlError,preparePageSubmission,readAcceptedImageOutputs,readPetStoryComposer,resetVideoCaptureCache,startNewConversation,submitPromptOnce,switchMode,uploadPetStoryImages,uploadReferenceImages,verifyPetStoryReferenceBindings,verifyPetStoryUploads,verifyPromptReadyForSubmission,waitForChatReady,waitForPetStoryImageComposer,waitForPetStoryVideoComposer,waitForSubmissionControlsStable
} from '../utils/doubaoBridge';
import { HumanVerificationRequiredError,observeWithHumanVerification } from '../utils/humanVerification';
import { ImageArtifactObservationError } from '../utils/imageArtifactReadback';
import type { InitializationLease } from '../utils/initializationGate';
import { initializationGate } from '../utils/initializationGate';
import { decideMaterialAuthorizationProgress } from '../utils/materialAuthorization';
import { MaterialImagePages } from '../utils/materialImagePages';
import { mediaSubmissionReceiptFor } from '../utils/mediaSubmissionReceipt';
import { isBackgroundPetStoryTask } from '../utils/petstoryBackground';
import {
canAttemptSubmission,
classifySubmissionReadback,
evaluateTerminal,
updateStableStreak,
verifiedSubmissionConversationUrl,
waitForConfirmedSubmission,
type SubmissionReadback
} from '../utils/realSendStateMachine';
import type { SubmittedCreationReadbackSample } from '../utils/submittedCreationReadback';
import { SubmittedCreationReadbackContextError,SubmittedCreationReadbackTimeoutError,waitForSubmittedCreationReadback } from '../utils/submittedCreationReadback';
import {
isSameDoubaoConversation,
normalizeDoubaoConversationUrl,
resolveTaskConversationTarget,
waitForConcreteConversationUrl
} from '../utils/taskConversationLocator';
import { getTaskExecutionScope } from '../utils/taskExecutionScope';
import { classifyTaskError } from '../utils/taskRuntime';
import type { VideoArtifactObservationProgress } from '../utils/videoArtifactObservation';
import { evaluateVideoCapability,isRestrictionFailure } from '../utils/videoCapability';
import type { VideoControlReadinessResult,VideoPageReadinessStage } from '../utils/videoControlReadiness';
import { createVideoModeEntryCheckpoint,createVideoReadinessCheckpoint,VideoControlReadinessError } from '../utils/videoControlReadiness';
import { getVideoQuotaUsageUnits } from '../utils/videoQuota';
import {
forceWebviewLayoutRepaint
} from '../utils/webviewHydration';
import { dispatchSubmissionAttempt } from './SubmissionCoordinator';
import { VideoObservationPauseError } from './taskExecutionSupport';
import { beginVideoPageOperation } from './videoExecutionContext';


export interface TaskExecutionHost {
  runningRef: {current: Set<string>};
  abortControllersRef: {current: Map<string, AbortController>};
  pendingRestartTasksRef: {current: Map<string, TaskUpdateInput>};
  pendingCancellationStatusRef: {current: Map<string, 'paused' | 'cancelled'>};
  submittedImagePagesRef: {current: Map<string, { accountId: string; runId: string; submittedAt: string; webview: HTMLWebViewElement; conversationUrl: string }>};
  materialPagesRef: {current: MaterialImagePages};
  setInteractiveTaskPageId: (value: string | null | ((current: string | null) => string | null)) => void;
  ownsTaskWebview: (taskId: string, webview: HTMLWebViewElement) => boolean;
  assertNoHumanVerification: (accountId: string, webview: HTMLWebViewElement) => Promise<void>;
  pauseForHumanVerification: (accountId: string) => Promise<never>;
  performAvailabilityCheck: (accountId: string, webview: HTMLWebViewElement, source: AccountAvailabilitySource) => Promise<AccountAvailability>;
  conversationSynchronizations: WeakMap<HTMLWebViewElement, Promise<ConversationSyncResult>>;
}

export async function executeTaskAutomation(
    context: TaskExecutionHost,
    accountId: string,
    taskId: string,
    prompt: string,
    mode: string,
    webview: HTMLWebViewElement,
    videoConfig?: Task['videoConfig'],
    attachments?: string[],
    audioAttachment?: string
  ): Promise<void> {
    const { runningRef, abortControllersRef, pendingRestartTasksRef, pendingCancellationStatusRef, submittedImagePagesRef, materialPagesRef, setInteractiveTaskPageId, ownsTaskWebview, assertNoHumanVerification, pauseForHumanVerification, performAvailabilityCheck, conversationSynchronizations } = context;
    const { setAccountAutomationState: setExecutionState, updateTaskRuntime: sendRuntimeCommand, completeAutomation, pauseAutomation: sendPauseCommand, failAutomation: sendFailureCommand, updateTask, armTasks } =
      useTaskStore.getState();
    const initialTask = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
    const expectedRunId = initialTask?.runtime?.runId;
    const pauseAutomation = (id: string, account: string, text?: string, options?: Parameters<typeof sendPauseCommand>[3]): Promise<void> => {
      const current = useTaskStore.getState().tasks.find((item: Task): boolean => item.id === id);
      if (!expectedRunId || current?.runtime?.runId !== expectedRunId) return Promise.resolve();
      return sendPauseCommand(id, account, text, { ...options, status: options?.status || 'paused', expectedRunId });
    };
    const failAutomation = (id: string, account: string, text: string, info?: Parameters<typeof sendFailureCommand>[3]): Promise<void> =>
      sendFailureCommand(id, account, text, info, expectedRunId);
    // 长流程只消费开始时持久化的输入；UI 草稿不能改写正在执行的请求。
    if (initialTask?.runtime) {
      ({ prompt, mode, videoConfig, attachments, audioAttachment } = initialTask.runtime.input);
    }
    const updateTaskRuntime = async (id: string, params: Parameters<typeof sendRuntimeCommand>[1]): Promise<boolean> => {
      const saved = await sendRuntimeCommand(id, { ...params, expectedRunId });
      if (!saved) throw new AccountAvailabilityPauseError('运行进度保存失败，已停止本地执行；可继续原阶段', 'persistence_failed');
      return true;
    };
    const executionScope = initialTask ? getTaskExecutionScope(initialTask) : accountId;
    const independentPage = !!initialTask && materialPagesRef.current.uses(initialTask);
    const videoAdapter = mode === 'video' ? new DoubaoVideoAdapter(webview) : undefined;
    let releaseVideoOperation: (() => void) | undefined;
    const setAccountAutomationState = (id: string, state: AutomationState, text: string, stage?: NonNullable<Task['runtime']>['stage']): void => {
      const current = useTaskStore.getState().tasks.find((item: Task): boolean => item.id === taskId);
      if (!expectedRunId || current?.runtime?.runId !== expectedRunId || current.assignedAccountId !== accountId) return;
      setExecutionState(id, state, text, stage, taskId);
    };
    // 重挂载／热更新不能接管仍由旧控制器观察的运行，更不能重新创建会话。
    if (automationEngine.hasController(taskId)) { runningRef.current.delete(executionScope); return; }
    if (initialTask?.runtime?.submittedAt) {
      const recoveryMessage = '原运行已记录提交；仅恢复原会话回读，不重新准备、注入或发送';
      await pauseAutomation(taskId, accountId, recoveryMessage, { status: 'paused', code: 'submission_uncertain' });
      runningRef.current.delete(executionScope);
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
    const strictPrompt = mode === 'video' || !!petstoryTask || useTaskStore.getState().tasks.find((item) => item.id === taskId)?.promptReadback === 'exact';
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
    } catch (error: unknown) {
      const messageText = (error instanceof Error ? error.message : undefined) || '任务控制器初始化失败';
      await failAutomation(taskId, accountId, messageText, classifyTaskError(messageText));
      runningRef.current.delete(executionScope);
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
      // 独立页面仍共享系统输入焦点；图片准备与发送只能短暂单通道。
      if (independentPage) initializationLimit = 1;
      initializationLease = await initializationGate.acquire(taskId, { limit: initializationLimit, signal: controller.signal, exclusive: independentPage });
      useAccountStore.getState().selectAccount(accountId);
      if (independentPage) {
        setInteractiveTaskPageId(taskId);
        materialPagesRef.current.activate(taskId);
        await forceWebviewLayoutRepaint(webview);
      }
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
      // 新任务页的dom-ready只代表文档可读；必须先达到真实输入区就绪条件再判账号。
      if (independentPage && !await waitForChatReady(webview, 15000)) {
        throw new AccountAvailabilityPauseError('独立豆包对话的输入区未完成加载，已在发送前暂停', 'page_unrecognized');
      }
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
      if (selectedReplyRepair && !useTaskStore.getState().tasks.some((item): boolean => item.runtime?.chatAdjustmentGuard?.active === true && item.runtime.chatAdjustmentGuard.allowedTaskId === taskId)) throw new SubmissionSafetyPauseError('本次豆包调整已结束或移交已收回；修订未导航、未发送');
      const newConversationResult = await startNewConversation(webview, 20_000, mode === 'chat', selectedReplyRepair || backgroundTask, ownedRepairDraft, mode === 'image' || mode === 'video' ? mode : undefined);
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
      if (videoAdapter && expectedRunId) releaseVideoOperation = await videoAdapter.begin({ taskId, runId: expectedRunId, operationId: `${taskId}:${expectedRunId}:prepare`, signal: controller.signal, deadlineAt: Date.now() + 15 * 60_000 });
      else if (mode === 'image' && expectedRunId) releaseVideoOperation = await beginVideoPageOperation(webview, { taskId, runId: expectedRunId, operationId: `${taskId}:${expectedRunId}:prepare`, signal: controller.signal, deadlineAt: Date.now() + 15 * 60_000 });
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
            (signal: AbortSignal): Promise<import('../utils/doubaoBridge').PetStoryUploadReceipt[]> => videoAdapter ? videoAdapter.uploadReferences(fileDataList, petstoryGuard?.mode || 'reference', signal, petstoryGuard?.fileSha256s) : uploadPetStoryImages(webview, fileDataList, 'image', signal, petstoryGuard?.fileSha256s),
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
          const onModeDiagnostic = (diagnostic: CreationModeEntryDiagnostic): void => { modeDiagnostics.push(diagnostic); };
          const switched = await (videoAdapter ? videoAdapter.selectMode(onModeDiagnostic) : clickAITab(webview, mode, onModeDiagnostic));
          const modeDiagnostic = modeDiagnostics[modeDiagnostics.length - 1];
          modeEntryElapsedMs = Date.now() - modeEntryStartedAt;
          const modeCheckpoint = createVideoModeEntryCheckpoint(modeDiagnostic, modeEntryElapsedMs);
          if (mode === 'image' && modeDiagnostic) {
            void window.electronAPI.logs.append({ level: switched ? 'info' : 'warn', scope: 'automation', taskId, accountId,
              message: '图片模式回读 ' + JSON.stringify(modeDiagnostic) }).catch((): void => undefined);
          }
          if (!switched) {
            if (mode === 'video') {
              throw new VideoControlReadinessError('mode_entry', modeCheckpoint);
            }
            // 此时尚未上传或写入提交意图；使用可恢复的控件错误，不能归为未知提交失败。
            const reason = modeDiagnostic?.reason || '';
            const detail = /未连续稳定选中/.test(reason) ? '平台尚未确认已选中图像生成'
              : /未找到|等待窗口内挂载/.test(reason) ? '当前输入区未读到图像生成入口' : '当前图像生成控件无法确认';
            throw new PetStoryControlError(`${detail}，本次尚未发送`);
          }
          if (mode === 'video') await persistVideoReadiness('video_entry', modeCheckpoint);
        }

        // 视频模式：只使用页面可见控件配置，禁止请求改写绕过会员门槛。
        if (mode === 'video') {
          if (videoConfig) {
            setAccountAutomationState(accountId, 'injecting', '配置视频参数...', 'configuring');
            const configure = (): Promise<void> => (videoAdapter ? videoAdapter.configure.bind(videoAdapter) : (config: NonNullable<Task['videoConfig']>, options: Parameters<typeof configureVideoOptions>[2]): Promise<void> => configureVideoOptions(webview, config, options))(videoConfig, {
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
              const recovered = await videoAdapter?.selectMode();
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
              const uploaded = await videoAdapter?.uploadAudio({ name: fileName, base64, mime });
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
          || !automationEngine.ownsController(taskId, controller) || !ownsTaskWebview(taskId, webview)
          || (!['chat', 'image'].includes(mode) && !petstoryGuard && !strictPrompt)) return;
        const preserveMediaReceipt = async (): Promise<boolean> => {
          const currentPage = page || await getCurrentCreationConversation(webview, {
            signal: controller.signal, ensureCurrent: (): void => {
              const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
              if (!automationEngine.ownsAccountController(taskId, accountId, controller) || !ownsTaskWebview(taskId, webview)
                || latest?.runtime?.runId !== expectedRunId || latest.runtime.submittedAt !== original.runtime?.submittedAt
                || latest.assignedAccountId !== accountId || JSON.stringify(latest.runtime.input) !== JSON.stringify(original.runtime?.input)) {
                throw new SubmissionSafetyPauseError('原媒体运行、输入或执行权已变化，未保存其他结果');
              }
            },
          });
          const latest = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
          const receipt = mediaSubmissionReceiptFor(original, latest, accountId, currentPage, new Date().toISOString());
          if (receipt) {
            if (controller.signal.aborted || !automationEngine.ownsController(taskId, controller)) return false;
            const saved = await updateTaskRuntime(taskId, { runtime: { conversationUrl: receipt.conversationUrl, mediaSubmissionReceipt: receipt } });
            const persisted = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
            if (!saved || persisted?.runtime?.runId !== expectedRunId || persisted.runtime.mediaSubmissionReceipt?.userMessageId !== receipt.userMessageId
              || !isSameDoubaoConversation(persisted.runtime.conversationUrl, receipt.conversationUrl)) throw new SubmissionSafetyPauseError('原媒体消息定位保存未确认，保留提交且不重发');
            taskConversationUrl = receipt.conversationUrl;
            return true;
          }
          return false;
        };
        if (['image', 'video'].includes(mode) && !original.runtime.mediaSubmissionReceipt && await preserveMediaReceipt()) return;
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
          if (!['image', 'video'].includes(mode)) return;
          const current = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
          if (controller.signal.aborted || !['executing', 'waiting_verification'].includes(current?.status || '') || current?.assignedAccountId !== accountId || !current.runtime
            || current.runtime.runId !== expectedRunId || current.runtime.submittedAt !== submissionMarkedAt
            || current.runtime.input.prompt !== prompt || current.runtime.input.mode !== mode || current.prompt !== prompt
            || JSON.stringify(current.runtime.input.attachments || []) !== JSON.stringify(current.attachments || [])
            || JSON.stringify(current.runtime.input.videoConfig) !== JSON.stringify(current.videoConfig)
            || current.runtime.input.audioAttachment !== current.audioAttachment
            || JSON.stringify(current.runtime.input.petstory) !== JSON.stringify(current.petstory)
            || !automationEngine.ownsAccountController(taskId, accountId, controller) || !ownsTaskWebview(taskId, webview)) {
            throw new SubmissionSafetyPauseError('原媒体运行、输入或执行权已变化，停止回读且未重新发送');
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
          const page = await getCurrentCreationConversation(webview, { signal: controller.signal, ensureCurrent: assertOriginalMediaSubmission });
          assertOriginalMediaSubmission();
          const originalTask = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
          const currentUrl = page.conversationUrl || normalizeDoubaoConversationUrl(webview.getURL());
          const evidence = inspectCreationReadback(page.snapshot, prompt, mode, initialMsgCount, videoConfig, !!originalTask?.runtime?.generationConfirmation,
            mode === 'video' && originalTask && currentUrl ? taskChatReadbackContext(originalTask, accountId, currentUrl, currentUrl) : undefined);
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
        if (videoAdapter && videoConfig) {
          const snapshot = await videoAdapter.readComposer();
          const composer = snapshot.composer;
          if (!composer.present || composer.selectedSkill !== 'video' || composer.model !== getVideoModelUiLabel(videoConfig.model)
            || composer.duration !== Number.parseInt(videoConfig.duration, 10) || composer.aspectRatio !== videoConfig.aspectRatio
            || composer.pending || stage === 'submitting' && (!snapshot.submit.ok || !snapshot.nativeInputAvailable)) {
            throw new PetStoryControlError('当前视频输入区、参数、素材或最终控件尚未匹配本次输入，确定未发送，可继续准备');
          }
        }
        if (mode === 'image') {
          if (stage === 'submitting' && typeof webview.sendInputEvent !== 'function') throw new PetStoryControlError('当前宿主不支持可信控件点击，本次确定未发送，可继续原任务准备');
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
            submission: { schemaVersion: 1, operationId: `${taskId}:${expectedRunId}:${markedAt}`, runId: expectedRunId || '', state: 'intent_saved', updatedAt: markedAt },
          },
        });
        const persistedRuntime = useTaskStore.getState().tasks.find((item) => item.id === taskId)?.runtime;
        if (persistedRuntime?.runId !== expectedRunId || persistedRuntime?.submission?.updatedAt !== markedAt) {
          throw new Error('提交意图持久化失败；为避免重复发送，本次未执行页面提交');
        }
        return markedAt;
      };

      const persistSubmissionState = async (state: 'not_dispatched' | 'dispatch_unknown' | 'accepted', reason?: string): Promise<void> => {
        const timestamp = new Date().toISOString();
        const saved = await updateTaskRuntime(taskId, { expectedRunId,
          runtime: { ...(state === 'dispatch_unknown' ? { submittedAt: submissionMarkedAt } : {}),
            submission: { schemaVersion: 1, operationId: `${taskId}:${expectedRunId}:${submissionMarkedAt}`, runId: expectedRunId || '', state, updatedAt: timestamp, ...(reason ? { reason } : {}) } } });
        if (!saved) throw new SubmissionSafetyPauseError('提交阶段保存失败，已停止本地执行，请重新检查原请求');
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
          await persistSubmissionState('dispatch_unknown', 'material_authorization_may_submit');
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
        if (!preparation.ok) {
          // 取消会撤回后台准备权限；保留原控制器的取消事实，不能误报页面失稳。
          if (controller.signal.aborted) throw new DOMException('任务已取消', 'AbortError');
          throw new AccountAvailabilityPauseError('当前页面输入区或发送控件尚未稳定；未记录提交意图、未发送，可继续原任务重新核对', 'page_unrecognized');
        }
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
      // 所有模式仅激活一次真实发送控件；平台不受理时保留原意图，不换策略重发。
      if (!authorizationTriggeredSubmission) {
        const result = await dispatchSubmissionAttempt({ persist: persistSubmissionState,
          dispatch: (safety): Promise<import('../utils/doubaoBridge').SubmissionDispatchResult> => videoAdapter ? videoAdapter.dispatch(safety, backgroundInput) : submitPromptOnce(webview, safety, backgroundInput),
          safety: {
          signal: controller.signal,
          deadlineAt: Date.now() + 10_000,
          dispatchKey: `${taskId}:${expectedRunId}:${submissionMarkedAt}`,
          expectedPrompt: prompt,
          strictParagraphs: strictPrompt,
          activation: mode === 'image' || mode === 'video' ? 'native_media' : 'dom_compat',
          isCurrent: (): boolean => {
            const current = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
            return current?.assignedAccountId === accountId && current.status === 'executing'
              && current.runtime?.runId === expectedRunId && current.runtime?.submission?.operationId === `${taskId}:${expectedRunId}:${submissionMarkedAt}`
              && current.runtime.stage === 'submitting' && current.runtime.input.prompt === prompt && current.runtime.input.mode === mode
              && automationEngine.ownsAccountController(taskId, accountId, controller);
          },
          verifyLease: (): Promise<boolean> => automationEngine.confirmSubmissionOwnership(taskId, accountId, controller),
        } });
        if (result.kind === 'not_dispatched') {
          throw new AccountAvailabilityPauseError('本次确定未发送。页面控件或执行权已变化，可继续原任务重新准备', 'page_unrecognized');
        }
        // ACK 丢失与已激活都只观察原请求，永不在此补点。
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
          if (!automationEngine.ownsAccountController(taskId, accountId, controller) || !ownsTaskWebview(taskId, webview)
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
      await persistSubmissionState('accepted');
      const acceptedAt = new Date().toISOString();
      const acceptedTask = useTaskStore.getState().tasks.find((item) => item.id === taskId);
      const acceptedRunId = acceptedTask?.runtime?.runId;
      const acceptedTarget = ['image', 'video'].includes(mode) ? resolveTaskConversationTarget(acceptedTask) : undefined;
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
      if (independentPage) setInteractiveTaskPageId((current: string | null): string | null => current === taskId ? null : current);

      releaseVideoOperation?.(); releaseVideoOperation = undefined;
      const videoBlockerContext = { baselineMessageCount: initialMsgCount, conversationUrl };

      // 只有持久化与回读成功后才触发队列；all_accepted 依赖此时才可放行其他账号。
      setAccountAutomationState(accountId, 'generating', '等待豆包生成回复...', 'generating');
      await pause(3000);

      let generating = mode !== 'video';
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
            || current.runtime.submittedAt !== submissionMarkedAt || current.runtime.input.prompt !== prompt || !ownsTaskWebview(taskId, webview)) {
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
        const assertVideoRun = (): void => {
          const current = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
          if (controller.signal.aborted || !automationEngine.ownsAccountController(taskId, accountId, controller)
            || !current?.runtime || current.runtime.runId !== expectedRunId || current.assignedAccountId !== accountId || current.runtime.submittedAt !== submissionMarkedAt
            || !ownsTaskWebview(taskId, webview) || !isSameDoubaoConversation(webview.getURL(), conversationUrl)) throw new DOMException('原视频观察已停止', 'AbortError');
        };
        const observationStarted = Date.now();
        let observationPollCount = 0;
        const resolution = await new DoubaoVideoAdapter(webview).observe({
          signal: controller.signal, timeoutMs: generationWaitBudgetMs, ensureCurrent: assertVideoRun,
          context: { conversationUrl, runId: expectedRunId, sourcePrompt: prompt, videoConfig,
            readbackContext: taskChatReadbackContext(persistedTask as Task, accountId, conversationUrl, webview.getURL()) },
          onProgress: async ({ elapsedMs, pollCount, resolution: sample }: VideoArtifactObservationProgress): Promise<void> => {
            observationPollCount = pollCount;
            await checkHumanVerification();
            const blocker = await detectVideoGenerationBlocker(webview, videoBlockerContext);
            if (blocker) throw new VideoObservationPauseError({ status: 'unavailable', reason: `豆包已停止生成：${blocker}`, attempts: [] }, 'platform_rejected');
            assertVideoRun();
            const now = new Date().toISOString();
            const saved = await updateTaskRuntime(taskId, { expectedRunId, runtime: { lastHeartbeatAt: now,
              message: `正在观察原视频（${Math.floor(elapsedMs / 1000)}秒）`,
              executionDiagnostics: { ...useTaskStore.getState().tasks.find((item): boolean => item.id === taskId)?.runtime?.executionDiagnostics,
                videoObservation: { status: sample.status, reason: sample.reason, source: sample.source, elapsedMs, pollCount, observedAt: now } } } });
            if (!saved) throw new SubmissionSafetyPauseError('原视频观察进度保存失败，已停止且未重新发送');
            setAccountAutomationState(accountId, 'generating', `等待原视频产物（${Math.floor(elapsedMs / 1000)}秒）`, 'extracting_outputs');
          },
        });
        assertVideoRun();
        const observedAt = new Date().toISOString();
        await updateTaskRuntime(taskId, { expectedRunId, runtime: { executionDiagnostics: {
          ...useTaskStore.getState().tasks.find((item): boolean => item.id === taskId)?.runtime?.executionDiagnostics,
          videoObservation: { status: resolution.status, reason: resolution.reason, source: resolution.source,
            elapsedMs: Date.now() - observationStarted, pollCount: observationPollCount + 1, observedAt },
        } } });
        if (resolution.status !== 'resolved' || !resolution.url) throw new VideoObservationPauseError(resolution);
        imageUrls = [resolution.url];
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
      await completeAutomation(taskId, accountId, imageUrls[0] || '', imageUrls, expectedRunId);
      if (mode === 'video' && petstoryTask?.projectId) {
        try {
          const finalized = await window.electronAPI.petstory.advanceProduction(petstoryTask.projectId);
          if (!finalized.success) message.warning(finalized.error || '视频已生成，下载或入库尚未完成；可在原镜头继续原阶段');
          useTaskStore.getState().reconcileTasks(finalized.taskSnapshots || []);
          acceptProductionSnapshot(petstoryTask.projectId, finalized.project);
        } catch {
          message.warning('视频已生成，本地收取暂未完成；可在原镜头继续下载并保存，不需要重新生成');
        }
      }
      if (mode === 'image') submittedImagePagesRef.current.delete(taskId);
    } catch (caught: unknown) {
      let err = caught instanceof Error ? caught : new Error(String(caught));
      // 旧控制器的迟到异常不允许把新运行或已完成／已暂停的原运行再次改成失败。
      const failedTask = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
      if (!automationEngine.ownsController(taskId, controller) || failedTask?.runtime?.runId !== expectedRunId
        || ['done', 'paused', 'cancelled', 'fail'].includes(failedTask?.status || '')) return;
      // 页面验证可能与派发失败／回读失败同一轮出现，先保留真实原因与账号阻断。
      if (err?.name !== 'AbortError' && !pendingCancellationStatusRef.current.has(taskId)) {
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
      const failure = err;
      const cancelled = failure?.name === 'AbortError' || pendingCancellationStatusRef.current.has(taskId);
      const safetyPaused = failure instanceof SubmissionSafetyPauseError;
      const petstoryPaused = failure instanceof PetStoryControlError;
      const availabilityPaused = failure instanceof AccountAvailabilityPauseError;
      const confirmationPaused = failure instanceof GenerationConfirmationPauseError;
      const controlReadinessFailure = failure instanceof VideoControlReadinessError || failure instanceof ChatAttachmentUploadError;
      if (failure instanceof VideoControlReadinessError && mode === 'video') {
        try {
          await persistVideoReadiness(failure.diagnostic.currentStage || 'submission_controls', failure.diagnostic);
        } catch (persistError) {
          console.error(`[Automation:${accountId}] 视频就绪诊断持久化失败:`, persistError);
        }
      }
      const observationPaused = failure instanceof VideoObservationPauseError;
      const imageObservationPaused = failure instanceof ImageArtifactObservationError;
      if (observationPaused || imageObservationPaused) {
        const current = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
        await updateTaskRuntime(taskId, { expectedRunId, runtime: {
          ...(current?.runtime?.acceptanceObservation ? { acceptanceObservation: { ...current.runtime.acceptanceObservation, outcome: 'manual_review' } } : {}),
          ...(observationPaused ? { executionDiagnostics: { ...current?.runtime?.executionDiagnostics, videoObservation: {
            status: failure.code === 'platform_rejected' ? 'rejected' : failure.resolution.status, reason: failure.resolution.reason,
            source: failure.resolution.source, elapsedMs: current?.runtime?.executionDiagnostics?.videoObservation?.elapsedMs || 0,
            pollCount: current?.runtime?.executionDiagnostics?.videoObservation?.pollCount || 0, observedAt: new Date().toISOString(),
          } } } : {}),
        } });
      }
      const acceptedObservationActive = useTaskStore.getState().tasks.find((item) => item.id === taskId)
        ?.runtime?.acceptanceObservation?.outcome === 'observing';
      const currentSubmission = useTaskStore.getState().tasks.find((item: Task): boolean => item.id === taskId)?.runtime;
      const possibleDispatch = !!currentSubmission?.submittedAt || currentSubmission?.submission?.state === 'dispatch_unknown'
        || currentSubmission?.submission?.state === 'accepted' || acceptedObservationActive;
      const errorMessage = cancelled ? '用户已取消等待' : (failure.message || String(failure));
      const errorInfo = controlReadinessFailure
        ? { code: failure.code, message: errorMessage, recoverable: true, detectedAt: new Date().toISOString() }
        : classifyTaskError(errorMessage);
      // 限制类失败（会员/额度/真人脸/内容审核）不扣减 Seedance 额度，
      // 也不应继续等待视频产物。recordSeedanceUsage 仅在成功路径调用。
      if (mode === 'video' && isRestrictionFailure(errorInfo.code)) {
        console.warn(`[Automation:${accountId}] 检测到限制类失败(${errorInfo.code})，不扣减额度`);
      }
      const quotaExhausted = mode === 'video' && errorInfo.code === 'quota_exhausted';
      if (quotaExhausted) await useAccountStore.getState().markSeedanceExhausted(accountId);
      if (!cancelled && !safetyPaused && !petstoryPaused && !availabilityPaused && !confirmationPaused && !controlReadinessFailure && !imageObservationPaused && !acceptedObservationActive) {
        await useAccountStore.getState().recordAccountOutcome(accountId, 'failure', errorInfo.code);
      }
      console.error(`[Automation:${accountId}] ${cancelled || safetyPaused || petstoryPaused || availabilityPaused || confirmationPaused || observationPaused || imageObservationPaused ? '已暂停' : '失败'}:`, errorMessage);
      if (cancelled || safetyPaused || petstoryPaused || availabilityPaused || confirmationPaused || observationPaused || imageObservationPaused || acceptedObservationActive) {
        const requestedCancellationStatus = pendingCancellationStatusRef.current.get(taskId);
        await pauseAutomation(
          taskId,
          accountId,
          cancelled && requestedCancellationStatus === 'cancelled'
            ? '本地处理与等待已结束，平台原请求和已有成果保留'
            : cancelled ? '用户已暂停，可随时重新执行' : errorMessage,
          cancelled
            ? { status: requestedCancellationStatus || 'paused', code: requestedCancellationStatus === 'cancelled' ? 'local_waiting_ended' : 'cancelled', endObservation: true }
            : availabilityPaused && failure.code === 'human_verification'
            ? { status: 'waiting_verification', code: 'human_verification' }
            : observationPaused
            ? { status: 'paused', code: failure.code }
            : imageObservationPaused
            ? { status: 'paused', code: failure.reason === 'generation_not_started' ? 'image_generation_not_started' : 'image_observation_required' }
            : acceptedObservationActive
            ? { status: 'manual_submission_observing', code: 'manual_review_required' }
            : confirmationPaused
            ? {
                status: 'waiting_generation_confirmation',
                code: 'generation_confirmation_required',
                generationConfirmation: {
                  detectedAt: failure.evidence.detectedAt,
                  marker: failure.evidence.marker || 'confirm_before_generation',
                  model: failure.evidence.model,
                  duration: failure.evidence.duration,
                  aspectRatio: failure.evidence.aspectRatio,
                },
              }
            : availabilityPaused
            ? { status: failure.code === 'login_required' ? 'waiting_verification' : 'paused', code: failure.code }
            : petstoryPaused
              ? { status: 'paused', code: 'petstory_controls_unconfirmed' }
            : safetyPaused
              ? { status: 'paused', code: possibleDispatch ? 'submission_uncertain' : 'dispatch_not_ready' }
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
      releaseVideoOperation?.();
      initializationLease?.release();
      const ownsLocalController = abortControllersRef.current.get(taskId) === controller;
      if (independentPage && ownsLocalController) setInteractiveTaskPageId((current: string | null): string | null => current === taskId ? null : current);
      if (ownsLocalController) abortControllersRef.current.delete(taskId);
      // 续租失败会先撤销engine租约；仍须释放自己的本地路由占位，迟到旧run不碰新控制器。
      if (ownsLocalController) runningRef.current.delete(executionScope);
      if (automationEngine.ownsController(taskId, controller)) {
        notification.destroy(materialAuthorizationNotificationKey);
        pendingRestartTasksRef.current.delete(taskId);
        const stopped = useTaskStore.getState().tasks.find((item): boolean => item.id === taskId);
        if (!stopped || stopped.runtime?.runId !== expectedRunId || ['paused', 'cancelled', 'done'].includes(stopped.status)) pendingCancellationStatusRef.current.delete(taskId);
        runningRef.current.delete(executionScope);
      }
      await automationEngine.release(taskId, controller);
      setTimeout(() => useTaskStore.getState().processQueue(), 0);
    }
}
