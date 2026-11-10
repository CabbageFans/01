import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import type { Task } from '../types';
import type { ChatReadbackContext,ChatReadbackResult } from '../utils/chatReadback';
import { chatRequestIdentity } from '../utils/chatReadback';
import {
waitForChatReady
} from '../utils/doubaoBridge';
import type { GenerationConfirmationEvidence } from '../utils/generationConfirmation';
import {
resolveTaskConversationTarget
} from '../utils/taskConversationLocator';
import type { VideoArtifactResolution } from '../utils/videoArtifactResolver';

export const taskChatReadbackContext = (task: Task, accountId: string, conversationUrl: string, currentUrl: string): ChatReadbackContext => {
  const mediaReceipt = ['image', 'video'].includes(task.mode || '') ? task.runtime?.mediaSubmissionReceipt : undefined;
  const receiptMatches = !mediaReceipt || resolveTaskConversationTarget(task).ok && mediaReceipt.accountId === accountId;
  const identity = mediaReceipt && receiptMatches ? { userTurnId: mediaReceipt.userTurnId, userMessageId: mediaReceipt.userMessageId }
    : task.runtime?.chatReadback?.runId === task.runtime?.runId ? { userTurnId: task.runtime?.chatReadback?.userTurnId, userMessageId: task.runtime?.chatReadback?.userMessageId } : {};
  return { taskId: task.id, runId: task.runtime?.runId || '',
    currentRunId: receiptMatches ? useTaskStore.getState().tasks.find((item): boolean => item.id === task.id)?.runtime?.runId || '' : '',
    accountId: task.assignedAccountId || '', currentAccountId: accountId, conversationUrl, currentConversationUrl: currentUrl, ...identity };
};

export const chatReadbackReceipt = (task: Task, evidence: ChatReadbackResult, baselineMessageCount: number): NonNullable<Task['runtime']>['chatReadback'] => {
  if (!task.runtime?.runId || !evidence.promptPublished || !evidence.association) return undefined;
  return { runId: task.runtime.runId, baselineMessageCount, ...chatRequestIdentity(task.prompt), association: evidence.association,
    userTurnId: evidence.userTurnId, userMessageId: evidence.userMessageId, assistantTurnId: evidence.assistantTurnId, assistantMessageId: evidence.assistantMessageId,
    observedAt: new Date().toISOString() };
};

export class SubmissionSafetyPauseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionSafetyPauseError';
  }
}

export class AccountAvailabilityPauseError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AccountAvailabilityPauseError';
  }
}

export class GenerationConfirmationPauseError extends Error {
  constructor(readonly evidence: GenerationConfirmationEvidence) {
    super('平台正在等待视频生成参数确认；请在原豆包会话中人工确认，系统不会代答或重复发送');
    this.name = 'GenerationConfirmationPauseError';
  }
}

export function hasAccountChatAdjustment(accountId: string | null | undefined): boolean {
  const current = usePetStoryStore.getState().project;
  return !!accountId && (current?.accountId === accountId && current.chatAdjustment?.status === 'active'
    || useTaskStore.getState().tasks.some((task): boolean => task.assignedAccountId === accountId && task.runtime?.chatAdjustmentGuard?.active === true));
}

export function resumableRepairDraft(task: Task | undefined, prompt: string, selectedReplyRepair: boolean): string | undefined {
  const runtime = task?.runtime;
  if (!selectedReplyRepair || !task || !runtime || task.mode !== 'chat' || task.executionIntent !== 'armed' || task.promptReadback !== 'exact'
    || runtime.attempt < 2 || runtime.input.mode !== 'chat' || runtime.input.prompt !== task.prompt || task.prompt !== prompt
    || runtime.submittedAt || runtime.chatReadback || runtime.chatReadbackReview || runtime.chatResponse || runtime.acceptanceObservation || task.outputs?.length) return undefined;
  return task.prompt;
}

export function waitForWebviewReady(webview: HTMLWebViewElement, timeoutMs: number): Promise<void> {
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

export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
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

export const formatResolutionMessage = (result: VideoArtifactResolution): string => {
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
    generation_not_started: '平台未执行视频生成',
    expired: '已过期',
    unauthorized: '无权限或登录失效',
    retryable_error: '可重试错误',
    needs_manual_selection: '需要人工选择',
  };
  const sourceLabel = result.source ? sourceLabels[result.source] || result.source : '';
  const statusLabel = statusLabels[result.status] || result.status;
  return `${statusLabel}${sourceLabel ? `（来源：${sourceLabel}）` : ''}${result.reason ? `：${result.reason}` : ''}`;
};


/** 明确观察结果需要用户处理时停止本地轮询，保留原次受理和原产物身份。 */
export class VideoObservationPauseError extends SubmissionSafetyPauseError {
  constructor(readonly resolution: VideoArtifactResolution, readonly code: string = `video_${resolution.status}`) {
    super(formatResolutionMessage(resolution)); this.name = 'VideoObservationPauseError';
  }
}
