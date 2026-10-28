import React from 'react';
import { Button, Empty, Tag } from 'antd';
import { ArrowRightOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { useProjectStore } from '../store/useProjectStore';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { useAccountStore } from '../store/useAccountStore';
import { ProjectSwitcher } from './ProjectSwitcher';
import { PetStoryOpenProject } from './PetStoryOpenProject';
import { PetStoryCreateProject } from './PetStoryCreateProject';
import { navigateWorkspace, needsTaskAttention, taskNextAction } from '../utils/workspace';
import { petStoryJourneyStages, selectPetStoryJourney } from '../utils/petstoryJourney';

export const WorkspaceOverview: React.FC = (): React.ReactElement => {
  const { projects, activeProjectId, selectProject } = useProjectStore();
  const pet = usePetStoryStore();
  const tasks = useTaskStore((state) => state.tasks);
  const accounts = useAccountStore((state) => state.accounts);
  const attention = tasks.filter((task): boolean => (task.projectId || 'default-project') === activeProjectId && needsTaskAttention(task));
  const accountAttention = accounts.filter((account): boolean => ['login_required', 'action_required', 'unavailable'].includes(account.health?.availability?.state || ''));
  const journey = pet.project ? selectPetStoryJourney(pet.project, tasks) : null;
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
      {pet.project && journey ? <div className="local-project-current"><h3>{pet.projectName || `当前短剧 · ${pet.project.id.slice(0, 8)}`}</h3><p>关联 Studio 项目：{projects.find((project): boolean => project.id === pet.project?.studioProjectId)?.name || '原项目缺失'}</p><p>执行账号：{accounts.find((account): boolean => account.id === pet.project?.accountId)?.name || '原账号缺失'}</p><div className="inline-meta"><Tag>{journey.counts.shots} 个镜头</Tag><Tag>基础图片确认 {journey.counts.materials.confirmed}/{journey.counts.materials.total}</Tag><Tag>当前关键帧 {journey.counts.keyframes.current}/{journey.counts.keyframes.total}</Tag><Tag>当前视频 {journey.counts.videos.current}/{journey.counts.videos.total}</Tag></div><p>推荐下一步：{petStoryJourneyStages.find((stage): boolean => stage.key === journey.stage)?.label}。{journey.reason}</p><p className="muted-text">视频文件校验记录 {journey.counts.videos.validated}/{journey.counts.videos.total} · 人工质量合格 {journey.counts.quality.confirmed}/{journey.counts.quality.total}</p><Button type="primary" onClick={(): void => navigateWorkspace('create', 'petstory')}>继续当前短剧 <ArrowRightOutlined /></Button></div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="打开本地目录，继续故事与镜头制作" />}
      <div className="local-project-actions"><PetStoryCreateProject onCreated={(): void => navigateWorkspace('create', 'petstory')} /><PetStoryOpenProject label="打开短剧目录" disabled={pet.busy} onOpened={(): void => navigateWorkspace('create', 'petstory')} /></div>
      <p className="muted-text">仅显示当前打开项目。逐镜素材、文件校验和人工质量分别记录；当前不提供整片合成。</p>
    </section>
    <section className="workspace-card attention-section">
      <div className="section-heading"><div><h2>待处理事项</h2><p>当前 Studio 项目任务与全局账号状态</p></div><Button type="text" onClick={(): void => navigateWorkspace('tasks')}>查看任务中心 <ArrowRightOutlined /></Button></div>
      {!attention.length && !accountAttention.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有需要人工处理的事项" /> : <div className="attention-list">{attention.map((task): React.ReactNode => <button key={task.id} onClick={(): void => { navigateWorkspace('tasks'); window.dispatchEvent(new CustomEvent('show-workspace-task', { detail: { taskId: task.id } })); }}><span className="attention-marker" /><span><strong>{taskNextAction(task)}</strong><small>{task.prompt.slice(0, 90)}</small></span><ArrowRightOutlined /></button>)}{accountAttention.map((account): React.ReactNode => <button key={account.id} onClick={(): void => navigateWorkspace('accounts')}><span className="attention-marker" /><span><strong>{account.name} · {account.health?.availability?.state === 'login_required' ? '去登录' : '处理验证或可用性'}</strong><small>在隔离浏览器内人工处理</small></span><ArrowRightOutlined /></button>)}</div>}
    </section>
  </div>;
};
