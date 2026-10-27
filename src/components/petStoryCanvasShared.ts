import type { PetStoryProject, PetStoryPromptKind } from '@doubao-studio/contracts';

export type CanvasDirtyChanged = (key: string, dirty: boolean) => void;
export const canvasPromptNames: Record<PetStoryPromptKind, string> = {
  firstFrame: '首帧生图提示词', lastFrame: '尾帧编辑提示词', video: '视频提示词 / 运镜',
};
export const isCanvasPlanLocked = (project: PetStoryProject): boolean => {
  const production = project.production;
  if (!production) return false;
  if (production.state === 'running' || production.steps.some((step): boolean => step.status !== 'complete')) return true;
  if (production.state === 'complete') return false;
  return production.phase !== 'materials';
};
export const canvasJobLabel = (status: string | undefined): string => ({
  queued: '排队中', executing: '处理中', generating: '生成中', done: '已收取', fail: '失败',
  paused: '已暂停', cancelled: '已取消', waiting_verification: '待人工处理',
})[status || ''] || '待回读';

export const canvasCopyText = async (text: string): Promise<void> => navigator.clipboard.writeText(text);
