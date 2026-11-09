import React from 'react';
import { Button, message } from 'antd';
import type { Task } from '@doubao-studio/contracts';
import { useAccountStore } from '../store/useAccountStore';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { canLocateSubmittedMediaConversation, resolveTaskConversationTarget, supportsDoubaoConversationLocator } from '../utils/taskConversationLocator';
import { openPetStoryOriginalTask } from './PetStoryTaskRecovery';

interface ConversationButtonProps { projectId: string; task?: Task; unavailableHint?: string; label?: string; sourceIsCurrent?: () => boolean }

function conversationRequestIdentity(task: Task): string {
  return JSON.stringify([task.mode, task.projectId, task.assignedAccountId, task.petstory, task.petstoryChat,
    task.runtime?.runId, task.runtime?.submittedAt, task.runtime?.input, task.prompt, task.attachments || [], task.audioAttachment, task.videoConfig]);
}

/** 只导航到对应原运行；缺少具体地址时不把账号首页或最近对话当作原对话。 */
export const PetStoryConversationButton: React.FC<ConversationButtonProps> = ({ projectId, task, unavailableHint, label = '进入豆包对话', sourceIsCurrent }): React.ReactElement => {
  const { accounts } = useAccountStore();
  const account = accounts.find((item: (typeof accounts)[number]): boolean => item.id === task?.assignedAccountId);
  const target = resolveTaskConversationTarget(task);
  const canLocate = canLocateSubmittedMediaConversation(task);
  const unavailable = !task ? unavailableHint || '本项尚未创建对应的豆包任务'
    : !account ? '原执行账号不存在，请先在账号与浏览器中处理'
    : !supportsDoubaoConversationLocator(account.platform) ? '当前账号不支持豆包对话定位'
    : !target.ok && !canLocate ? target.reason === 'CONVERSATION_URL_MISSING'
      ? task.resubmissionOf && !task.runtime?.submittedAt ? '本次重发请求尚未发送，暂无对应豆包对话' : '本次任务尚未保存可直接打开的豆包对话地址'
      : '本次任务的对话归属尚未核对，暂不能直接进入'
    : '';
  const isCurrentSource = (): boolean => usePetStoryStore.getState().project?.id === projectId && sourceIsCurrent?.() !== false;
  const open = (): void => {
    if (!task || unavailable) return;
    const current = useTaskStore.getState().tasks.find((item: Task): boolean => item.id === task.id);
    const currentTarget = resolveTaskConversationTarget(current);
    // 页面刷新与点击之间若原运行或归属改变，旧按钮不能打开同 taskId 的后续运行。
    if (!isCurrentSource() || !current
      || conversationRequestIdentity(current) !== conversationRequestIdentity(task)
      || (target.ok ? !currentTarget.ok || currentTarget.url !== target.url : !canLocateSubmittedMediaConversation(current))) {
      message.warning('对应任务或对话已变化，请重新查看当前节点。'); return;
    }
    // 已提交但缺定位时交给正式页面读取器核验服务器原消息；不能先展示账号当前页当作原Chat。
    if (!currentTarget.ok) { window.dispatchEvent(new CustomEvent('open-task-conversation', { detail: { task: current, locateSubmittedMedia: true, isCurrentSource } })); return; }
    openPetStoryOriginalTask(current, { isCurrentSource });
  };
  return <Button size="small" disabled={!!unavailable} title={unavailable || '进入本项任务对应的豆包对话'} onClick={open}>{label}</Button>;
};
