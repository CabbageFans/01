export const VIDEO_PAGE_READINESS_SCHEMA_VERSION = 1 as const;

export type VideoPageReadinessStage =
  | 'account'
  | 'new_conversation'
  | 'video_entry'
  | 'model'
  | 'aspect_ratio'
  | 'duration'
  | 'assets'
  | 'prompt'
  | 'submission_controls';

/** 兼容旧快照的阶段名；新写入只使用 VideoPageReadinessStage。 */
export type VideoControlReadinessStage = VideoPageReadinessStage
  | 'mode_entry'
  | 'model_control'
  | 'composite_control'
  | 'stable_readback'
  | 'final_readback';

export type VideoReadinessMissingControl =
  | 'account_page'
  | 'conversation_editor'
  | 'video_entry'
  | 'model_control'
  | 'aspect_ratio_control'
  | 'duration_control'
  | 'asset_upload'
  | 'prompt_editor'
  | 'send_control';

export interface VideoControlProbe {
  modelReady: boolean;
  /** 旧调用方兼容字段；未提供细分值时同时代表比例与时长。 */
  compositeReady?: boolean;
  aspectRatioReady?: boolean;
  durationReady?: boolean;
  pageVariant?: 'legacy' | 'composite-v2' | 'unknown';
}

export interface VideoControlReadinessResult {
  schemaVersion?: typeof VIDEO_PAGE_READINESS_SCHEMA_VERSION;
  ready: boolean;
  currentStage?: VideoPageReadinessStage;
  failureStage?: VideoControlReadinessStage;
  controlOperation?: 'mode_trigger' | 'mode_option' | 'mode_selection' | 'model_trigger' | 'parameters_trigger' | 'model_option' | 'ratio_option' | 'duration_slider' | 'readback';
  failureReason?: 'not_found' | 'ambiguous' | 'covered' | 'disabled' | 'changed' | 'menu_not_open' | 'value_not_applied' | 'page_unavailable';
  missingControl?: VideoReadinessMissingControl;
  pageStructureVersion?: string;
  attempts: number;
  elapsedMs: number;
  stableSamples?: number;
  recoveryAttempts?: number;
  modeEntryElapsedMs?: number;
  modelVisibleAtMs?: number;
  aspectRatioVisibleAtMs?: number;
  durationVisibleAtMs?: number;
  compositeVisibleAtMs?: number;
  stableAtMs?: number;
}

const FAILURE_CONTROL: Partial<Record<VideoControlReadinessStage, VideoReadinessMissingControl>> = {
  account: 'account_page', new_conversation: 'conversation_editor', video_entry: 'video_entry', mode_entry: 'video_entry',
  model: 'model_control', model_control: 'model_control', aspect_ratio: 'aspect_ratio_control', duration: 'duration_control',
  assets: 'asset_upload', prompt: 'prompt_editor', submission_controls: 'send_control', composite_control: 'aspect_ratio_control',
};

export const VIDEO_CONTROL_STAGE_LABELS: Readonly<Record<VideoControlReadinessStage, string>> = {
  account: '账号页面', new_conversation: '新会话输入区', video_entry: '视频生成入口',
  model: '视频模型', aspect_ratio: '画面比例', duration: '视频时长', assets: '素材上传', prompt: '提示词输入区',
  submission_controls: '提交控件', mode_entry: '视频生成入口', model_control: '视频模型',
  composite_control: '视频参数', stable_readback: '参数回读', final_readback: '提交前回读',
};

/** 只使用固定语义描述错误，不把页面文本或执行异常原文放进持久化诊断。 */
export const VIDEO_CONTROL_FAILURE_LABELS: Readonly<Record<NonNullable<VideoControlReadinessResult['failureReason']>, string>> = {
  not_found: '未找到对应选项', ambiguous: '存在多个目标，无法确认', covered: '目标被遮挡', disabled: '控件不可用',
  changed: '控件已变化', menu_not_open: '选项菜单未展开', value_not_applied: '设置后回读不一致', page_unavailable: '页面暂时无法读取',
};

interface VideoModeEntryDiagnostic {
  ready: boolean;
  elapsedMs: number;
  attempts?: number;
  stableSamples?: number;
  controlOperation?: 'mode_trigger' | 'mode_option' | 'mode_selection';
  failureReason?: VideoControlReadinessResult['failureReason'];
  missingControl?: VideoReadinessMissingControl;
}

/** 模式选中与后续参数配置分段记录；只选中技能不能提前宣称视频已可提交。 */
export function createVideoModeEntryCheckpoint(diagnostic: VideoModeEntryDiagnostic | undefined, elapsedMs: number): VideoControlReadinessResult {
  const entered = diagnostic?.ready === true;
  const observedElapsedMs = Math.max(0, diagnostic?.elapsedMs ?? elapsedMs);
  return {
    schemaVersion: VIDEO_PAGE_READINESS_SCHEMA_VERSION, ready: false, currentStage: 'video_entry',
    failureStage: entered ? undefined : 'video_entry',
    // 旧诊断没有采样计数时明确记为未记录，不能捏造一次尝试或一次稳定回读。
    attempts: diagnostic?.attempts ?? 0, stableSamples: diagnostic?.stableSamples,
    elapsedMs: observedElapsedMs, modeEntryElapsedMs: observedElapsedMs,
    controlOperation: diagnostic?.controlOperation, failureReason: entered ? undefined : diagnostic?.failureReason,
    missingControl: entered ? undefined : diagnostic?.missingControl ?? 'video_entry',
  };
}

export class VideoControlReadinessError extends Error {
  readonly code: string;
  readonly diagnostic: VideoControlReadinessResult;

  constructor(stage: VideoControlReadinessStage, diagnostic: VideoControlReadinessResult) {
    const normalizedStage = stage === 'mode_entry' ? 'video_entry'
      : stage === 'model_control' ? 'model'
        : stage === 'composite_control' ? 'aspect_ratio'
          : stage;
    const codeByStage: Record<string, string> = {
      account: 'video_account_not_ready', new_conversation: 'video_new_conversation_not_ready',
      video_entry: 'video_mode_entry_not_ready', model: 'video_model_control_not_ready',
      aspect_ratio: 'video_aspect_ratio_control_not_ready', duration: 'video_duration_control_not_ready',
      assets: 'video_assets_not_ready', prompt: 'video_prompt_not_ready',
      submission_controls: 'video_submission_controls_not_ready',
      stable_readback: 'video_stable_readback_not_ready', final_readback: 'video_final_readback_not_ready',
    };
    const code = codeByStage[normalizedStage] ?? `video_${normalizedStage}_not_ready`;
    const detail = diagnostic.failureReason ? `：${VIDEO_CONTROL_FAILURE_LABELS[diagnostic.failureReason]}` : '未在有界等待内就绪';
    super(`${code}: ${VIDEO_CONTROL_STAGE_LABELS[normalizedStage]}${detail}（${diagnostic.elapsedMs}ms/${diagnostic.attempts}次），已在提交前停止`);
    this.name = 'VideoControlReadinessError';
    this.code = code;
    this.diagnostic = {
      schemaVersion: VIDEO_PAGE_READINESS_SCHEMA_VERSION, ...diagnostic, ready: false,
      failureStage: normalizedStage, currentStage: normalizedStage as VideoPageReadinessStage,
      missingControl: diagnostic.missingControl ?? FAILURE_CONTROL[stage],
    };
  }
}

/** 只编码能力位和适配器版本，不含 DOM 文本、账号、提示词、素材路径或会话数据。 */
export function buildVideoPageStructureVersion(probe: VideoControlProbe): string {
  const ratio = probe.aspectRatioReady ?? probe.compositeReady ?? false;
  const duration = probe.durationReady ?? probe.compositeReady ?? false;
  return `doubao-video-v2:${probe.pageVariant ?? 'unknown'}:m${Number(probe.modelReady)}r${Number(ratio)}d${Number(duration)}`;
}

/** 为 BrowserPanel 的九阶段检查点生成最小、脱敏且可持久化的诊断。 */
export function createVideoReadinessCheckpoint(
  stage: VideoPageReadinessStage,
  options: { elapsedMs?: number; attempts?: number; stableSamples?: number; recoveryAttempts?: number; pageStructureVersion?: string } = {},
): VideoControlReadinessResult {
  return {
    schemaVersion: VIDEO_PAGE_READINESS_SCHEMA_VERSION, ready: stage === 'submission_controls', currentStage: stage,
    attempts: options.attempts ?? 1, elapsedMs: Math.max(0, options.elapsedMs ?? 0), stableSamples: options.stableSamples ?? 1,
    recoveryAttempts: options.recoveryAttempts ?? 0, pageStructureVersion: options.pageStructureVersion,
  };
}

/** 有界指数退避；模型、比例与时长控件需连续稳定采样。 */
export async function waitForVideoControlReadiness(
  probe: () => VideoControlProbe | Promise<VideoControlProbe>,
  options: { timeoutMs?: number; stableSamples?: number; recoveryAttempts?: number; now?: () => number; wait?: (ms: number) => Promise<void> } = {},
): Promise<VideoControlReadinessResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const requiredStableSamples = options.stableSamples ?? 3;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  let attempts = 0;
  let stable = 0;
  let lastProbe: VideoControlProbe = { modelReady: false, compositeReady: false, pageVariant: 'unknown' };
  let modelVisibleAtMs: number | undefined;
  let aspectRatioVisibleAtMs: number | undefined;
  let durationVisibleAtMs: number | undefined;

  while (now() - startedAt <= timeoutMs) {
    attempts += 1;
    lastProbe = await probe();
    const elapsedMs = Math.max(0, now() - startedAt);
    const ratioReady = lastProbe.aspectRatioReady ?? lastProbe.compositeReady ?? false;
    const durationReady = lastProbe.durationReady ?? lastProbe.compositeReady ?? false;
    if (lastProbe.modelReady && modelVisibleAtMs === undefined) modelVisibleAtMs = elapsedMs;
    if (ratioReady && aspectRatioVisibleAtMs === undefined) aspectRatioVisibleAtMs = elapsedMs;
    if (durationReady && durationVisibleAtMs === undefined) durationVisibleAtMs = elapsedMs;
    stable = lastProbe.modelReady && ratioReady && durationReady ? stable + 1 : 0;
    if (stable >= requiredStableSamples) {
      return {
        schemaVersion: VIDEO_PAGE_READINESS_SCHEMA_VERSION, ready: true, currentStage: 'duration', attempts, elapsedMs,
        stableSamples: stable, recoveryAttempts: options.recoveryAttempts ?? 0, pageStructureVersion: buildVideoPageStructureVersion(lastProbe),
        modelVisibleAtMs, aspectRatioVisibleAtMs, durationVisibleAtMs,
        compositeVisibleAtMs: Math.max(aspectRatioVisibleAtMs ?? 0, durationVisibleAtMs ?? 0), stableAtMs: elapsedMs,
      };
    }
    const remaining = timeoutMs - elapsedMs;
    if (remaining <= 0) break;
    const delay = Math.min(2_000, 250 * (2 ** Math.min(attempts - 1, 3)), remaining);
    await wait(delay);
  }

  const elapsedMs = Math.max(0, now() - startedAt);
  const ratioReady = lastProbe.aspectRatioReady ?? lastProbe.compositeReady ?? false;
  const durationReady = lastProbe.durationReady ?? lastProbe.compositeReady ?? false;
  const failureStage: VideoPageReadinessStage = !lastProbe.modelReady ? 'model' : !ratioReady ? 'aspect_ratio' : !durationReady ? 'duration' : 'submission_controls';
  return {
    schemaVersion: VIDEO_PAGE_READINESS_SCHEMA_VERSION, ready: false, currentStage: failureStage, failureStage,
    missingControl: FAILURE_CONTROL[failureStage], pageStructureVersion: buildVideoPageStructureVersion(lastProbe), attempts, elapsedMs,
    stableSamples: stable, recoveryAttempts: options.recoveryAttempts ?? 0, modelVisibleAtMs, aspectRatioVisibleAtMs, durationVisibleAtMs,
    compositeVisibleAtMs: aspectRatioVisibleAtMs !== undefined && durationVisibleAtMs !== undefined ? Math.max(aspectRatioVisibleAtMs, durationVisibleAtMs) : undefined,
  };
}
