import React from 'react';
import { Button, Progress, Space, Tag } from 'antd';
import type { PetStoryChatJob, PetStoryPlan, PetStoryProject, Task } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { planDisplayText, selectPlanReview } from '../utils/petstoryPlanReview';
import { PetStoryPlanPreview } from './PetStoryPlanPreview';
import { PetStoryPlanAdjustment } from './PetStoryPlanAdjustment';
import { PetStoryChatRecoveryActions, petStoryJobStatus } from './PetStoryTaskRecovery';
import '../styles/petstory-plan-review.css';

function summary(plan: PetStoryPlan): string {
  const text = planDisplayText(plan, plan.understanding || plan.sourceSummary || plan.adaptedStory);
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}
function counts(plan: PetStoryPlan): string {
  return `${plan.shots.length} 个镜头 · ${plan.characters.length} 人物 / ${plan.props?.length || 0} 道具 / ${plan.scenes?.length || 0} 场景 · 共 ${plan.shots.reduce((total, shot): number => total + shot.durationSeconds, 0)} 秒`;
}
function changes(previous: PetStoryPlan | undefined, candidate: PetStoryPlan): string[] {
  if (!previous) return [];
  const result: string[] = [];
  if (previous.shots.length !== candidate.shots.length) result.push(`镜头 ${previous.shots.length} → ${candidate.shots.length} 个`);
  const cast = candidate.characters.map((item): string => item.name).join('、');
  if (previous.characters.map((item): string => item.name).join('、') !== cast) result.push(`人物调整为 ${cast}`);
  if (previous.adaptedStory !== candidate.adaptedStory) result.push('故事内容有更新，请展开核对');
  if (!result.length && JSON.stringify(previous) !== JSON.stringify(candidate)) result.push('镜头或素材安排有更新，请展开核对');
  return result.slice(0, 3);
}
interface ReviewState {
  job?: PetStoryChatJob; task?: Task; plan?: PetStoryPlan;
  pending: boolean; problem: boolean; candidate: boolean; newCandidate: boolean; adopted: boolean;
  title: string; status: string;
}
function reviewLabel(view: Omit<ReviewState, 'title' | 'status'>, uncertain: boolean): { title: string; status: string } {
  if (view.pending && !uncertain && view.job?.kind === 'repair') return { title: '正在请豆包修正分镜方案…', status: '正在修订' };
  if (view.pending && !uncertain) return { title: view.job?.planFeedback ? '正在按你的要求调整方案' : '分镜方案正在生成', status: '正在生成' };
  if (view.problem) return { title: '分镜方案需要复核', status: uncertain ? recoveryStatus(view.job, view.task) : '需要复核' };
  if (view.candidate) return view.job?.kind === 'repair' ? { title: '已修正，请确认分镜方案。', status: '候选待确认' } : view.newCandidate ? { title: '分镜方案已更新', status: '有新候选' } : { title: '分镜方案待确认', status: '候选待确认' };
  if (view.adopted) return { title: '方案已采用', status: '已采用' };
  return view.plan ? { title: '当前方案待确认', status: '待确认' } : { title: '等待分镜方案', status: '尚未开始' };
}
function recoveryStatus(job: PetStoryChatJob | undefined, task: Task | undefined): string {
  if (job?.status === 'captured' || task?.runtime?.chatResponse || task?.runtime?.submittedAt) return '回复尚未核对';
  return task ? '等待继续' : '任务记录待载入';
}
function reviewState(project: PetStoryProject, job: PetStoryChatJob | undefined, tasks: Task[]): ReviewState {
  const task = tasks.find((item): boolean => item.id === job?.taskId);
  const pending = !!job && !job.endedWaitingAt && ['bound', 'captured'].includes(job.status);
  const uncertain = pending && (job?.status === 'captured' || !task || !['executing', 'generating', 'manual_submission_observing'].includes(task.status));
  const candidate = !!job?.requestId && job.status === 'applied' && job.resultStatus === 'candidate' && !!job.parsedResult?.plan;
  const problem = !!job && (job.status === 'invalid' || job.resultStatus === 'stale' || uncertain);
  const newCandidate = candidate && !!project.plan && JSON.stringify(project.plan) !== JSON.stringify(job?.parsedResult?.plan);
  const plan = candidate ? job?.parsedResult?.plan : project.plan;
  const adopted = !candidate && !!project.plan && !!project.storyApproval;
  const view = { job, task, pending, candidate, problem, newCandidate, plan, adopted };
  return { ...view, ...reviewLabel(view, uncertain) };
}
const PlanRecovery: React.FC<{ project: PetStoryProject; view: ReviewState }> = ({ project, view }): React.ReactElement | null => {
  const repairPreparing = usePetStoryStore((state) => !!view.job && state.promptRepairJobIds.includes(view.job.id));
  if (view.pending && !view.problem) return <><Progress percent={view.task?.runtime?.submittedAt ? 65 : 20} showInfo={false} status="active" /><p role="status">{view.job ? petStoryJobStatus(view.job, view.task).instruction : '正在等待豆包回复。'}</p></>;
  if (!view.problem) return null;
  return <div className="petstory-plan-attention" role="status"><p>{view.job && (repairPreparing || view.job.kind === 'repair' && view.job.status === 'invalid') ? petStoryJobStatus(view.job, view.task, repairPreparing).instruction : view.job?.staleReason || view.job?.error || view.task?.errorInfo?.message || (view.job ? petStoryJobStatus(view.job, view.task).instruction : '原回复尚未确认归属，请先核对原会话。')}</p><p>受影响对象：本轮分镜方案。当前采用方案和已有成果保留。</p>{view.job && <PetStoryChatRecoveryActions project={project} job={view.job} task={view.task} compact />}</div>;
};
const PlanActions: React.FC<{ project: PetStoryProject; view: ReviewState; disabled: boolean; onMaterials?: () => void; onAdjust: () => void }> = ({ project, view, disabled, onMaterials, onAdjust }): React.ReactElement | null => {
  const state = usePetStoryStore();
  if (view.pending || view.problem) return null;
  const confirm = async (): Promise<void> => {
    if (view.candidate && view.job) {
      await state.adoptPlanCandidate(view.job.id);
      const current = usePetStoryStore.getState();
      if (current.error || current.project?.id !== project.id || current.project.jobs.find((item): boolean => item.id === view.job?.id)?.resultStatus !== 'adopted') return;
    }
    await usePetStoryStore.getState().confirmStory();
  };
  return <Space wrap className="petstory-plan-actions">
    {!view.adopted && <Button type="primary" disabled={disabled} loading={state.busy} onClick={(): void => { void confirm(); }}>确认并采用方案</Button>}
    {view.adopted && onMaterials && <Button type="primary" onClick={onMaterials}>准备基础素材</Button>}
    <Button disabled={disabled || state.busy} onClick={onAdjust}>在豆包中调整</Button>
  </Space>;
};
const PlanContents: React.FC<{ project: PetStoryProject; view: ReviewState; disabled: boolean; onMaterials?: () => void; onAdjust: () => void }> = ({ project, view, disabled, onMaterials, onAdjust }): React.ReactElement | null => {
  const plan = view.plan;
  if (!plan) return !view.pending && !view.problem ? <p>先在“输入剧本”中分析剧本，回复会保存在这里供你确认。</p> : null;
  const differences = view.newCandidate ? changes(project.plan, plan) : [];
  return <><p className="petstory-plan-counts">{counts(plan)}</p><p className="petstory-plan-summary">{summary(plan)}</p>
    {view.job?.parsedResult?.requiresConfirmation && <p className="petstory-plan-attention" role="status">需要你确认的变化：{view.job.parsedResult.changeReason}</p>}
    {view.newCandidate && <><p className="petstory-plan-attention">与当前方案不同。确认前继续保留当前方案和已有图片、视频。</p>{differences.length > 0 && <ul>{differences.map((change): React.ReactNode => <li key={change}>{change}</li>)}</ul>}</>}
    <PlanActions project={project} view={view} disabled={disabled} onMaterials={onMaterials} onAdjust={onAdjust} />
    <details className="petstory-plan-full"><summary>查看完整方案</summary><div className="petstory-plan-scroll"><PetStoryPlanPreview plan={plan} contentBasis={view.candidate ? view.job?.parsedResult?.contentBasis : project.contentBasis} /></div></details>
    {view.newCandidate && project.plan && <details className="petstory-plan-full"><summary>查看当前采用方案（继续保留）</summary><div className="petstory-plan-scroll"><PetStoryPlanPreview plan={project.plan} contentBasis={project.contentBasis} /></div></details>}
  </>;
};
export const PetStoryPlanReview: React.FC<{ project: PetStoryProject; disabled: boolean; onMaterials?: () => void }> = ({ project, disabled, onMaterials }): React.ReactElement => {
  const tasks = useTaskStore((store) => store.tasks);
  const { job } = selectPlanReview(project);
  const view = reviewState(project, job, tasks);
  const [adjustment, setAdjustment] = React.useState<{ baseJobId?: string } | null>(null);
  React.useEffect((): void => { setAdjustment(null); }, [project.id]);
  return <article className="petstory-plan-review" aria-label="方案审阅">
    <header><h3>{view.title}</h3><Tag color={view.problem ? 'orange' : view.adopted ? 'green' : 'default'}>{view.status}</Tag></header>
    <PlanRecovery project={project} view={view} />
    {view.job?.planFeedback && (view.pending || view.problem) && <Button className="petstory-plan-actions" onClick={(): void => setAdjustment({})}>查看调整进度</Button>}
    <PlanContents project={project} view={view} disabled={disabled} onMaterials={onMaterials} onAdjust={(): void => setAdjustment(view.candidate && view.job ? { baseJobId: view.job.id } : {})} />
    <PetStoryPlanAdjustment key={project.id} project={project} baseJobId={adjustment?.baseJobId} open={!!adjustment} onClose={(): void => setAdjustment(null)} />
  </article>;
};
