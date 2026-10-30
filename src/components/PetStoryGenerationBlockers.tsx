import React from 'react';
import { Alert, Button, Space } from 'antd';
import type { PetStoryGenerationBlocker } from './usePetStoryGenerationEligibility';

export function generationBlockerAction(blocker: PetStoryGenerationBlocker): string {
  if (blocker.code === 'firstFrame' && blocker.promptKind === 'video') return '去制作前镜视频';
  return ({ story: '查看并确认方案', prompt: '查看本项提示词', materials: '查看并补齐素材', firstFrame: '去制作本镜首帧', lastFrame: '去制作本镜尾帧', capability: '重新读取制作条件', task: '处理当前任务', other: '重新核对条件' })[blocker.code];
}
/** 业务阻断与对应真实处理入口同处展示，技术日志不承载恢复操作。 */
export const PetStoryGenerationBlockers: React.FC<{ blockers: PetStoryGenerationBlocker[]; onResolve: (blocker: PetStoryGenerationBlocker) => void }> = ({ blockers, onResolve }): React.ReactElement | null => {
  if (!blockers.length) return null;
  return <Space direction="vertical" className="w-full" size="small">{blockers.map((blocker, index): React.ReactNode => <Alert key={`${blocker.code}:${index}`} type="warning" showIcon message={blocker.message} action={<Button size="small" onClick={(): void => onResolve(blocker)}>{generationBlockerAction(blocker)}</Button>} />)}</Space>;
};
