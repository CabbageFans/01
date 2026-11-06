import type { PetStoryProject, PetStoryPromptKind } from '@doubao-studio/contracts';

export type CanvasDirtyChanged = (key: string, dirty: boolean) => void;
export const canvasPromptNames: Record<PetStoryPromptKind, string> = {
  firstFrame: '首帧生图提示词', lastFrame: '尾帧编辑提示词', video: '视频提示词 / 运镜',
};
export const isCanvasPlanLocked = (project: PetStoryProject): boolean => {
  if (project.imageOperations?.some((operation): boolean => !['complete', 'failed'].includes(operation.stage))
    || Object.values(project.imageProductions || {}).some((run): boolean => run.state === 'running' || run.steps.some((step): boolean => step.status !== 'complete'))) return true;
  const production = project.production;
  if (!production) return false;
  if (production.state === 'running' || production.steps.some((step): boolean => step.status !== 'complete')) return true;
  if (production.state === 'complete') return false;
  return production.phase !== 'materials';
};
export const canvasJobLabel = (status: string | undefined): string => ({
  queued: '排队中', executing: '处理中', generating: '生成中', done: '已收取', fail: '失败',
  paused: '已暂停', cancelled: '已取消', waiting_verification: '待人工处理',
  manual_submission_observing: '正在检查原视频结果', waiting_generation_confirmation: '待确认视频参数',
})[status || ''] || '待回读';

/** 仅识别本地正文准备提示，便于新进度替换旧提示；平台拒绝、归属和登录错误必须保留。 */
export function isPetStoryPromptPreparationMessage(message: string): boolean {
  if (message === '镜头或最终提示词不存在') return true;
  const label = '(?:首帧生图提示词|尾帧编辑提示词|视频提示词 / 运镜)';
  return new RegExp(`^${label}(?:尚未通过校验[，；]|已有待采用候选[，；]|尚无当前使用的正文[，；]|尚未准备[，；]|正在后台准备并校验[，；]|文字任务等待继续[，；])`).test(message);
}

/** 旧项目保存的准备错误不能继续指向已撤销的改模式入口；只更新展示，保留原始审计。 */
export function petStoryVideoRecoveryMessage(message: string): string {
  const readiness = message.match(/^(video_[a-z_]+_not_ready):/);
  const readinessLabels: Record<string, string> = {
    video_account_not_ready: '账号页面', video_new_conversation_not_ready: '新会话输入区', video_mode_entry_not_ready: '视频生成入口',
    video_model_control_not_ready: '视频模型控件', video_aspect_ratio_control_not_ready: '画面比例控件', video_duration_control_not_ready: '视频时长控件',
    video_assets_not_ready: '视频素材上传', video_prompt_not_ready: '视频提示词输入区', video_submission_controls_not_ready: '视频提交控件',
    video_stable_readback_not_ready: '视频参数回读', video_final_readback_not_ready: '视频提交前回读',
  };
  if (readiness && readinessLabels[readiness[1]] && message.includes('已在提交前停止')) return `${readinessLabels[readiness[1]]}尚未准备好，本次尚未提交。已选图片已保留，请继续原视频任务。`;
  if (!message.includes('改用两张参考图继续') && !message.includes('可在本镜制作设置选择“多参考”')) return message;
  return '当前入口的首尾帧准备尚未完成，已选图片已保留；本次尚未上传或提交。请继续原视频任务，重新读取当前入口。';
}

export const canvasCopyText = async (text: string): Promise<void> => navigator.clipboard.writeText(text);
