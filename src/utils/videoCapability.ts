/**
 * src/utils/videoCapability.ts
 * 视频能力预检纯函数 — 不依赖 DOM/React/Electron 运行时
 *
 * 职责：
 * 1. 在提交视频任务前，检查真实登录、验证与用户调度设置
 * 2. 具体模型、时长和比例由执行器配置并回读
 * 3. 本地额度估算或会员未知状态不参与启动判断
 *
 * 合规约束：
 * - 不得尝试绕过、伪造或规避会员/权益/风控校验
 * - 任何降级必须由用户明确确认
 */

import type {
  VideoModel,
  VideoDuration,
  VideoAspectRatio,
  Account,
  TaskErrorCode,
} from '../types';

// ==================== 类型定义 ====================

/** 能力预检结果状态 */
export type VideoCapabilityState = 'allowed' | 'blocked' | 'unknown';

/** 结构化原因码 */
export type VideoCapabilityIssueCode =
  | 'login_expired'
  | 'verification_required'
  | 'scheduling_paused'
  | 'cooldown_active'
  | 'account_error';

/** 能力预检问题项 */
export interface VideoCapabilityIssue {
  code: VideoCapabilityIssueCode;
  message: string;
  /** 是否阻止提交 */
  blocking: boolean;
}

/** 能力预检输入 */
export interface VideoCapabilityInput {
  /** 当前视频模型 */
  model: VideoModel;
  /** 视频时长 */
  duration: VideoDuration;
  /** 画面比例（当前未作为限制因素，保留用于未来扩展） */
  aspectRatio: VideoAspectRatio;
  /** 账号健康状态（来自 Account.health） */
  health?: Account['health'];
  /** 账号调度配置（来自 Account.scheduling） */
  scheduling?: Account['scheduling'];
  /** 账号状态（来自 Account.status） */
  accountStatus: Account['status'];
  /** 当前时间戳，默认 Date.now()，测试时可注入 */
  now?: number;
}

/** 建议配置（仅作为建议，不改变原始 videoConfig） */
export interface SuggestedVideoConfig {
  model: VideoModel;
  duration: VideoDuration;
  reason: string;
}

/** 能力预检结果 */
export interface VideoCapabilityResult {
  /** 预检状态 */
  state: VideoCapabilityState;
  /** 结构化问题列表 */
  issues: VideoCapabilityIssue[];
  /** 面向用户的中文提示 */
  userMessage: string;
  /** 是否允许提交自动化任务 */
  canSubmit: boolean;
  /** 可选的建议配置，不得自动替换原配置 */
  suggestion?: SuggestedVideoConfig;
}

// ==================== 核心逻辑 ====================

/**
 * 评估视频能力预检。
 *
 * 判断顺序（短路）：
 * 1. 账号状态异常 → blocked
 * 2. 登录失效 → blocked
 * 3. 等待验证 → blocked
 * 4. 调度暂停 → blocked
 * 5. 冷却中 → blocked
 * 6. 其他情况 → allowed；真实平台限制由执行时读取。
 */
export function evaluateVideoCapability(input: VideoCapabilityInput): VideoCapabilityResult {
  const now = input.now ?? Date.now();
  const issues: VideoCapabilityIssue[] = [];

  // ---- 1. 账号状态异常 ----
  if (input.accountStatus === 'error') {
    issues.push({
      code: 'account_error',
      message: '账号状态异常，请检查账号健康状态后重试',
      blocking: true,
    });
  }

  // ---- 2. 登录失效 ----
  if (input.health?.loginState === 'expired') {
    issues.push({
      code: 'login_expired',
      message: '账号登录已失效，请重新登录豆包账号',
      blocking: true,
    });
  }

  // ---- 3. 等待验证 ----
  if (input.health?.verificationRequired) {
    issues.push({
      code: 'verification_required',
      message: '账号需要完成人工验证后才能继续执行',
      blocking: true,
    });
  }

  // ---- 4. 调度暂停 ----
  if (input.scheduling?.enabled === false) {
    issues.push({
      code: 'scheduling_paused',
      message: '账号调度已暂停，请在账号管理中启用后重试',
      blocking: true,
    });
  }

  // ---- 5. 冷却中 ----
  const cooldownUntil = input.health?.cooldownUntil;
  if (cooldownUntil && new Date(cooldownUntil).getTime() > now) {
    const remaining = Math.ceil((new Date(cooldownUntil).getTime() - now) / 60000);
    issues.push({
      code: 'cooldown_active',
      message: `账号处于冷却中，约 ${remaining} 分钟后恢复`,
      blocking: true,
    });
  }

  // 手动冷却
  const manualCooldown = input.scheduling?.manualCooldownUntil;
  if (manualCooldown && new Date(manualCooldown).getTime() > now) {
    const remaining = Math.ceil((new Date(manualCooldown).getTime() - now) / 60000);
    issues.push({
      code: 'cooldown_active',
      message: `账号手动冷却中，约 ${remaining} 分钟后恢复`,
      blocking: true,
    });
  }

  // ---- 确定最终状态 ----
  const blockingIssues = issues.filter((i) => i.blocking);

  if (blockingIssues.length > 0) {
    // 有阻塞性问题
    const state: VideoCapabilityState = 'blocked';
    const userMessage = blockingIssues.map((i) => i.message).join('；');
    return {
      state,
      issues,
      userMessage,
      canSubmit: false,

    };
  }

  // 无阻塞、无风险
  return {
    state: 'allowed',
    issues,
    userMessage: '',
    canSubmit: true,
  };
}

/**
 * 根据当前配置生成建议配置。
 * 仅作为建议返回，不改变原始 videoConfig。
 */
export function suggestCompatibleVideoConfig(
  model: VideoModel,
  duration: VideoDuration,
): SuggestedVideoConfig | undefined {
  if (Number.parseInt(duration, 10) >= 11) {
    return {
      model,
      duration: '10s',
      reason: '可选择 10 秒；具体时长由执行器按实际页面配置',
    };
  }

  return undefined;
}

/**
 * 判断错误码是否属于"限制类失败"——即不应扣减额度、应立即终止轮询。
 *
 * 限制类失败包括：
 * - membership_required: 会员限制
 * - quota_exhausted: 额度耗尽
 * - face_restricted: 真人脸限制
 * - content_rejected: 内容审核拒绝
 *
 * 这些情况下任务未成功生成视频，不应扣减 Seedance 额度。
 */
export function isRestrictionFailure(errorCode: string): boolean {
  const restrictionCodes: TaskErrorCode[] = [
    'membership_required',
    'quota_exhausted',
    'face_restricted',
    'content_rejected',
  ];
  return restrictionCodes.includes(errorCode as TaskErrorCode);
}

/**
 * 判断错误码是否应立即终止视频产物轮询。
 *
 * 这些错误意味着继续等待不会有结果：
 * - membership_required: 会员限制，不会生成
 * - quota_exhausted: 额度耗尽，不会生成
 * - face_restricted: 真人脸限制，不会生成
 * - content_rejected: 内容审核拒绝，不会生成
 * - generation_failed: 平台明确生成失败
 */
export function shouldStopVideoPolling(errorCode: string): boolean {
  const stopCodes: TaskErrorCode[] = [
    'membership_required',
    'quota_exhausted',
    'face_restricted',
    'content_rejected',
    'generation_failed',
  ];
  return stopCodes.includes(errorCode as TaskErrorCode);
}
