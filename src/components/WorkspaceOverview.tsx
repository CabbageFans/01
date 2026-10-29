import React, { useEffect, useState } from 'react';
import { Button, Empty, Tag } from 'antd';
import { ArrowRightOutlined, FileTextOutlined, PictureOutlined } from '@ant-design/icons';
import { useProjectStore } from '../store/useProjectStore';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { useAccountStore } from '../store/useAccountStore';
import { PetStoryOpenProject } from './PetStoryOpenProject';
import { PetStoryCreateProject } from './PetStoryCreateProject';
import { navigateWorkspace, needsTaskAttention, taskNextAction } from '../utils/workspace';
import { petStoryJourneyStages, selectPetStoryJourney } from '../utils/petstoryJourney';
import type { Task } from '../types';

/** 总览只展示当前真实打开的短剧；不虚构最近项目或已完成的制作结果。 */
export const WorkspaceOverview: React.FC = (): React.ReactElement => {
  const pet = usePetStoryStore();
  const tasks = useTaskStore((state) => state.tasks);
  const accounts = useAccountStore((state) => state.accounts);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const project = pet.project;
  const journey = project ? selectPetStoryJourney(project, tasks) : null;
  const attention = tasks.filter((task: Task): boolean => (task.projectId || 'default-project') === (project?.studioProjectId || activeProjectId) && needsTaskAttention(task));
  const accountAttention = accounts.filter((account): boolean => ['login_required', 'action_required', 'unavailable'].includes(account.health?.availability?.state || ''));
  const candidateMaterials = project?.materials?.filter((material): boolean => !material.approved && project.assets.some((asset): boolean => asset.materialId === material.id && asset.imageReview?.state === 'candidate')) || [];
  const [preview, setPreview] = useState('');
  const previewAssetId = project?.materials?.find((material): boolean => !!material.approved)?.approved?.assetId;
  const previewProjectId = project?.id;
  useEffect((): (() => void) => {
    let active = true; setPreview('');
    if (previewProjectId && previewAssetId) void window.electronAPI.petstory.readReference(previewProjectId, previewAssetId).then((result): void => { if (active && result.success && result.data) setPreview(result.data); }).catch((): void => undefined);
    return (): void => { active = false; };
  }, [previewProjectId, previewAssetId]);
  const continueProject = (): void => navigateWorkspace('create', 'petstory');
  return <div className="overview-grid">
    <section className="workspace-card current-story">
      <div className="section-heading"><h2>{project ? '继续创作' : '从剧本开始'}</h2>{journey && <Tag color="cyan">{petStoryJourneyStages.find((stage): boolean => stage.key === journey.stage)?.label}</Tag>}</div>
      {project && journey ? <div className="story-project-feature">
        <div className="story-project-preview">{preview ? <img src={preview} alt="当前短剧已采用的参考图" /> : <FileTextOutlined />}</div>
        <div className="story-project-copy"><h3>{pet.projectName || '当前短剧'}</h3><p>{journey.counts.shots} 个镜头 · {project.plan?.characters.length || 0} 位人物 · {project.plan?.scenes?.length || 0} 个场景</p><p className="muted-text">{journey.reason}</p><Button type="primary" onClick={continueProject}>继续创作 <ArrowRightOutlined /></Button></div>
      </div> : <div className="story-start-empty"><FileTextOutlined /><h3>把故事变成一组镜头</h3><p>输入剧本，确认方案，再逐步准备图片与镜头视频。</p></div>}
      <div className="story-project-footer"><div className="local-project-actions"><PetStoryCreateProject primary={!project} onCreated={continueProject} /><PetStoryOpenProject label="打开项目" disabled={pet.busy} onOpened={continueProject} /></div>{project && <span className="muted-text">执行账号：{accounts.find((account): boolean => account.id === project.accountId)?.name || '原账号不可用'}</span>}</div>
    </section>
    <section className="workspace-card attention-section">
      <div className="section-heading"><h2>待处理事项</h2><Button type="text" size="small" onClick={(): void => navigateWorkspace('tasks')}>全部任务 <ArrowRightOutlined /></Button></div>
      {!attention.length && !accountAttention.length && !candidateMaterials.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂时没有需要处理的事项" /> : <div className="attention-list">
        {candidateMaterials.map((material): React.ReactNode => <button key={material.id} onClick={continueProject}><PictureOutlined /><span><strong>{material.name}的图片待确认</strong><small>预览候选，选择满意的一张</small></span><ArrowRightOutlined /></button>)}
        {attention.slice(0, 5).map((task): React.ReactNode => <button key={task.id} onClick={(): void => { navigateWorkspace('tasks'); window.dispatchEvent(new CustomEvent('show-workspace-task', { detail: { taskId: task.id } })); }}><span className="attention-marker" /><span><strong>{taskNextAction(task)}</strong><small>{task.mode === 'chat' ? '文字请求' : task.mode === 'image' ? '图片任务' : task.mode === 'video' ? '镜头视频任务' : '创作任务'}</small></span><ArrowRightOutlined /></button>)}
        {accountAttention.map((account): React.ReactNode => <button key={account.id} onClick={(): void => navigateWorkspace('accounts')}><span className="attention-marker" /><span><strong>{account.name} · {account.health?.availability?.state === 'login_required' ? '需要登录' : '需要处理验证'}</strong><small>打开账号浏览器处理</small></span><ArrowRightOutlined /></button>)}
      </div>}
    </section>
    {project && journey && <section className="workspace-card project-progress-summary"><div className="section-heading"><h2>当前制作情况</h2><Button size="small" onClick={continueProject}>查看逐镜成果</Button></div><p className="muted-text">基础图片已采用 {journey.counts.materials.confirmed}/{journey.counts.materials.total} · 关键帧与当前正文对应 {journey.counts.keyframes.current}/{journey.counts.keyframes.total} · 镜头视频与当前正文对应 {journey.counts.videos.current}/{journey.counts.videos.total}</p><p className="muted-text">视频文件校验通过 {journey.counts.videos.validated}/{journey.counts.videos.total} · 人工质量合格 {journey.counts.quality.confirmed}/{journey.counts.quality.total}</p></section>}
  </div>;
};
