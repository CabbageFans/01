import React from 'react';
import { Button, Empty, Tag } from 'antd';
import { ArrowRightOutlined, FolderOpenOutlined, PlusOutlined } from '@ant-design/icons';
import { useProjectStore } from '../store/useProjectStore';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { useAccountStore } from '../store/useAccountStore';
import { ProjectSwitcher } from './ProjectSwitcher';
import { navigateWorkspace, needsTaskAttention, taskNextAction } from '../utils/workspace';

export const WorkspaceOverview: React.FC = (): React.ReactElement => {
  const { projects, activeProjectId, selectProject } = useProjectStore();
  const pet = usePetStoryStore();
  const tasks = useTaskStore((state) => state.tasks);
  const accounts = useAccountStore((state) => state.accounts);
  const attention = tasks.filter((task): boolean => (task.projectId || 'default-project') === activeProjectId && needsTaskAttention(task));
  const accountAttention = accounts.filter((account): boolean => ['login_required', 'action_required', 'unavailable'].includes(account.health?.availability?.state || ''));
  const openPet = async (create: boolean): Promise<void> => {
    navigateWorkspace('create', 'petstory');
    if (create) await pet.createProject(); else await pet.openProject();
  };
  return <div className="overview-grid">
    <section className="workspace-card studio-projects">
      <div className="section-heading"><div><h2>Studio 项目</h2><p>管理通用创作、任务与批次</p></div><ProjectSwitcher variant="actions" /></div>
      <div className="project-list">{projects.filter((project): boolean => !project.archived).map((project): React.ReactNode => {
        const count = tasks.filter((task): boolean => (task.projectId || 'default-project') === project.id).length;
        return <button className={`project-row ${activeProjectId === project.id ? 'is-current' : ''}`} key={project.id} onClick={(): void => { selectProject(project.id); }}><span className="project-symbol"><FolderOpenOutlined /></span><span className="project-row-copy"><strong>{project.name}</strong><span>{project.description || '暂无项目说明'}</span></span><span className="project-count">{count} 项任务</span>{activeProjectId === project.id && <Tag color="purple">当前项目</Tag>}</button>;
      })}</div>
      <div className="section-footer"><span>切换 Studio 项目不会改绑已打开的本地短剧</span><Button type="link" onClick={(): void => navigateWorkspace('create', 'studio')}>进入通用创作 <ArrowRightOutlined /></Button></div>
    </section>
    <section className="workspace-card local-projects">
      <div className="section-heading"><div><h2>萌宠短剧</h2><p>本地目录 · 镜头素材制作</p></div><Tag>本地项目</Tag></div>
      {pet.project ? <div className="local-project-current"><h3>{pet.projectName || `当前短剧 · ${pet.project.id.slice(0, 8)}`}</h3><p>关联 Studio 项目：{projects.find((project): boolean => project.id === pet.project?.studioProjectId)?.name || '原项目缺失'}</p><p>执行账号：{accounts.find((account): boolean => account.id === pet.project?.accountId)?.name || '原账号缺失'}</p><div className="inline-meta"><Tag>{pet.project.plan?.shots.length || 0} 个镜头</Tag><Tag>{pet.project.production?.state === 'complete' ? '镜头素材已完成' : pet.project.production ? '查看制作进度' : pet.project.plan ? '方案已保存' : '待保存故事'}</Tag></div><Button type="primary" onClick={(): void => navigateWorkspace('create', 'petstory')}>继续当前短剧 <ArrowRightOutlined /></Button></div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="打开本地目录，继续故事与镜头制作" />}
      <div className="local-project-actions"><Button icon={<PlusOutlined />} disabled={pet.busy} onClick={(): void => { void openPet(true); }}>新建短剧目录</Button><Button icon={<FolderOpenOutlined />} disabled={pet.busy} onClick={(): void => { void openPet(false); }}>打开短剧目录</Button></div>
      <p className="muted-text">仅显示当前打开项目。制作结束表示镜头素材完成，尚不合成为完整短剧。</p>
    </section>
    <section className="workspace-card attention-section">
      <div className="section-heading"><div><h2>待处理事项</h2><p>当前 Studio 项目任务与全局账号状态</p></div><Button type="text" onClick={(): void => navigateWorkspace('tasks')}>查看任务中心 <ArrowRightOutlined /></Button></div>
      {!attention.length && !accountAttention.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有需要人工处理的事项" /> : <div className="attention-list">{attention.map((task): React.ReactNode => <button key={task.id} onClick={(): void => { navigateWorkspace('tasks'); window.dispatchEvent(new CustomEvent('show-workspace-task', { detail: { taskId: task.id } })); }}><span className="attention-marker" /><span><strong>{taskNextAction(task)}</strong><small>{task.prompt.slice(0, 90)}</small></span><ArrowRightOutlined /></button>)}{accountAttention.map((account): React.ReactNode => <button key={account.id} onClick={(): void => navigateWorkspace('accounts')}><span className="attention-marker" /><span><strong>{account.name} · {account.health?.availability?.state === 'login_required' ? '去登录' : '处理验证或可用性'}</strong><small>在隔离浏览器内人工处理</small></span><ArrowRightOutlined /></button>)}</div>}
    </section>
  </div>;
};
