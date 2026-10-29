import React, { useEffect, useState } from 'react';
import { Button, Checkbox, Space, Typography } from 'antd';
import type { PetStoryProject } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useAccountStore } from '../store/useAccountStore';
import { revealBrowser } from '../utils/workspace';
import { useTaskStore } from '../store/useTaskStore';
import { canSelectAccount, findInteractiveAccountId } from '../utils/interactiveAccount';

export const petStoryModeNames = { auto: '自动选择', first_frame: '首帧', first_last_frame: '首尾帧', reference: '多参考' };
function entryState(state: string, free: string): string {
  if (state === 'implementation_gap') return '当前工具尚未适配';
  if (state === 'unsupported') return '当前入口不支持';
  if (state !== 'supported') return '等待检查';
  return ({ free: '免费可用', paid: '需要付费', exhausted: '免费额度不足', unknown: '免费权益待确认' })[free] || '免费权益待确认';
}

/** 在发起动作的位置核对原账号入口；复用现有检查事件，不发送创作内容。 */
export const PetStoryMediaEntryCheck: React.FC<{ project: PetStoryProject; kind: 'image' | 'video'; disabled?: boolean; compact?: boolean }> = ({ project, kind, disabled = false, compact = false }): React.ReactElement => {
  const state = usePetStoryStore();
  const account = useAccountStore((store) => store.accounts.find((item): boolean => item.id === project.accountId));
  const [freeConfirmed, setFreeConfirmed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [openMessage, setOpenMessage] = useState('');
  useEffect((): void => { setFreeConfirmed(false); setExpanded(false); setOpenMessage(''); }, [project.id, kind]);
  const capability = state.capabilityCheckedInSession ? state.capability : null;
  const mediaName = kind === 'image' ? '图片' : '视频';
  const showCheck = !compact || expanded;
  const inspect = async (): Promise<void> => {
    setChecking(true);
    try { await state.inspectCapability(freeConfirmed, kind); }
    finally { setChecking(false); }
  };
  const openBrowser = (): void => {
    if (!canSelectAccount(project.accountId, findInteractiveAccountId(useTaskStore.getState().accountAutomationState))) { setOpenMessage('另一个账号正在输入或发送，请等待它完成后再打开本账号。'); return; }
    setOpenMessage(''); useAccountStore.getState().selectAccount(project.accountId); revealBrowser();
  };
  return <div className="petstory-entry-check" aria-label={`${mediaName}入口检查`}>
    <Space direction="vertical" className="w-full" size="small">
      <Typography.Text strong>{mediaName}入口 · {account?.name || '项目绑定账号'}</Typography.Text>
      <Typography.Text type="secondary">{capability ? kind === 'image' ? entryState(capability.image.state, capability.image.free) : capability.videoConfig ? `${capability.videoConfig.model} · ${capability.videoConfig.aspectRatio}` : '视频规格等待核对' : `本次尚未检查${mediaName}入口`}</Typography.Text>
      {showCheck && <>
        <Checkbox checked={freeConfirmed} disabled={disabled || checking} onChange={(event): void => setFreeConfirmed(event.target.checked)}>本人已核对该账号当前{mediaName}入口和所选规格免费可用</Checkbox>
        <Space wrap><Button loading={checking} disabled={disabled || state.busy || project.production?.state === 'running'} onClick={(): void => { void inspect(); }}>检查豆包{mediaName}入口</Button><Button onClick={openBrowser}>打开绑定账号豆包</Button></Space>
        <Typography.Text type="secondary">检查不会生成内容。免费权益不明时暂停；勾选仅记录本人的核对结果。</Typography.Text>
      </>}
      {openMessage && <Typography.Text role="status" type="warning">{openMessage}</Typography.Text>}
      {compact && <Button size="small" onClick={(): void => setExpanded(!expanded)}>{expanded ? '收起入口检查' : capability ? `重新检查${mediaName}入口` : `检查${mediaName}入口`}</Button>}
      {showCheck && capability && <>
        <details className="petstory-secondary-tools"><summary>高级引用与检查详情</summary><Space direction="vertical" className="w-full">
          {kind === 'video' && Object.entries(capability.modes).map(([mode, entry]): React.ReactNode => <Typography.Text key={mode} type="secondary">{petStoryModeNames[mode as keyof typeof petStoryModeNames]}：{entryState(entry.state, entry.free)} · {entry.reason}</Typography.Text>)}
          <Checkbox checked={!!capability.allowPlainReferences} disabled={disabled || state.busy || project.production?.state === 'running'} onChange={(event): void => state.setPlainReferences(event.target.checked)}>此入口不支持 @ 素材引用时，同意逐图核对用途后提交</Checkbox>
          <Typography.Text type="secondary">检查时间：{new Date(capability.checkedAt).toLocaleString('zh-CN')}</Typography.Text>
        </Space></details>
      </>}
    </Space>
  </div>;
};
