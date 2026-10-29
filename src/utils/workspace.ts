import type { Task } from '../types';
import { requiresSubmissionReconciliation } from './realSendStateMachine';

export type WorkspacePage = 'overview' | 'create' | 'tasks' | 'assets' | 'accounts' | 'settings';
export const WORKSPACE_PAGES: ReadonlyArray<{ id: WorkspacePage; label: string; description: string }> = [
  { id: 'overview', label: '工作台总览', description: '继续你的短剧创作' },
  { id: 'create', label: '短剧创作', description: '从剧本到逐镜素材' },
  { id: 'tasks', label: '任务中心', description: '查看执行进度，处理需要你介入的任务' },
  { id: 'assets', label: '素材与下载', description: '查找产物，检查地址与下载结果' },
  { id: 'accounts', label: '账号与浏览器', description: '管理隔离账号，处理登录与平台确认' },
  { id: 'settings', label: '设置与诊断', description: '偏好、数据维护与运行诊断' },
];

/** 只解释既有任务事实，不创建新状态或改变重试规则。 */
export function taskNextAction(task: Task): string {
  if (requiresSubmissionReconciliation(task)) return task.status === 'waiting_generation_confirmation' ? '确认参数后只读回读' : '核对原会话';
  if (task.errorInfo?.code?.startsWith('dependency_')) return '查看前置任务';
  if (task.status === 'waiting_verification') return '处理登录或验证';
  if (task.status === 'manual_submission_observing') return '继续观察原任务';
  if (task.status === 'queued') return task.executionIntent === 'armed' ? '已授权，等待调度' : '待授权执行';
  if (task.status === 'done') return task.qualityVerdict ? '查看素材与质量结论' : '查看结果，人工质量未评';
  if (task.status === 'paused') return '查看暂停原因';
  if (task.status === 'fail') return '查看错误与重试条件';
  if (task.status === 'cancelled') return '已取消';
  return task.runtime?.message || '正在执行';
}

export function needsTaskAttention(task: Task): boolean {
  return ['paused', 'fail', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'].includes(task.status)
    || !!task.errorInfo?.code?.startsWith('dependency_');
}

export function navigateWorkspace(page: WorkspacePage, mode?: 'studio' | 'petstory'): void {
  window.dispatchEvent(new CustomEvent('navigate-workspace', { detail: { page, mode } }));
}

export function revealBrowser(): void {
  window.dispatchEvent(new CustomEvent('reveal-workspace-browser'));
}
