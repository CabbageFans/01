import React from 'react';
import { Alert, Button, Input, Select, Space, Tag } from 'antd';
import type { PetStoryChatJob, PetStoryProject, PetStoryReviewIssue, PetStoryRuntimeTarget } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { PetStoryPlanReview } from './PetStoryPlanReview';
import { planRequestRoot } from '../utils/petstoryPlanReview';
import { PromptProvenance } from './PetStoryCanvasPrompt';
import { canvasPromptNames } from './petStoryCanvasShared';
import { ReviewIssueSelection } from './PetStoryReviewIssues';
import { currentReviewPrompt, isSavedReviewResult, petStoryWritingModel, reviewMatchesCurrentPrompts, reviewMatchesPrompt } from '../utils/petstoryCandidate';
export { PetStoryCurrentTasks } from './PetStoryTaskRecovery';

const stageNames: Record<PetStoryChatJob['kind'], string> = { analysis: '剧本理解与动态分镜', assets: '资产拆解与关联', optimize: '镜头正文创作', materialPrompt: '基础素材正文创作', review: '内容审查', revise: '局部修订', repair: '具体缺项修订' };
function isValidatedCandidate(job: PetStoryChatJob): boolean { return job.status === 'applied' && job.resultStatus === 'candidate'; }

/** 以稳定实体 ID 定位局部修订；未明确正文类型时由用户选择，不能擅自改全项目。 */
function issueTargets(project: PetStoryProject, issue: PetStoryReviewIssue): { label: string; target: PetStoryRuntimeTarget }[] {
  const material = project.materials?.find((item): boolean => item.id === issue.targetId || item.entityId === issue.targetId);
  if (material) return [{ label: `修订${material.name}正文`, target: { materialId: material.id } }];
  const shot = project.plan?.shots.find((item): boolean => issue.targetId === item.id || issue.targetId.startsWith(`${item.id}:`));
  if (!shot) return [];
  return (['firstFrame', 'lastFrame', 'video'] as const).filter((kind): boolean => !!shot.prompts[kind] && (!issue.promptKind || issue.promptKind === kind) && (issue.targetId === shot.id || issue.targetId === `${shot.id}:${kind}`)).map((kind): { label: string; target: PetStoryRuntimeTarget } => ({ label: `修订镜头${shot.order}${canvasPromptNames[kind]}`, target: { shotId: shot.id, promptKind: kind } }));
}

interface ReviewGroup { label: string; target?: PetStoryRuntimeTarget; issues: PetStoryReviewIssue[] }
function groupReviewIssues(project: PetStoryProject, issues: PetStoryReviewIssue[]): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const issue of issues) {
    const targets = issueTargets(project, issue);
    if (!targets.length) {
      const key = `unresolved:${issue.targetId}`;
      const group = groups.get(key) || { label: `${issue.targetId}（未关联可修订正文）`, issues: [] };
      group.issues.push(issue); groups.set(key, group);
    }
    for (const { label, target } of targets) {
      const key = target.materialId || `${target.shotId}:${target.promptKind}`;
      const group = groups.get(key) || { label, target, issues: [] };
      group.issues.push(issue); groups.set(key, group);
    }
  }
  return [...groups.values()];
}
const RuntimeReview: React.FC<{ project: PetStoryProject; job: PetStoryChatJob; disabled: boolean }> = ({ project, job, disabled }): React.ReactElement | null => {
  const state = usePetStoryStore();
  const issues = job.parsedResult?.issues;
  if (!issues) return null;
  if (!issues.length) return <><p className="canvas-hint">本次豆包审查未提出内容问题；图片与视频效果仍需查看实际媒体。</p>{!reviewMatchesCurrentPrompts(project, job) && <p className="canvas-hint">历史审查结论：当前正文已变化或缺少送审快照，不代表当前正文已通过，请重新审查。</p>}</>;
  return <div>{groupReviewIssues(project, issues).map(({ label, target, issues: targetIssues }): React.ReactNode => {
    const targetId = target?.materialId || (target?.shotId && target.promptKind ? `${target.shotId}:${target.promptKind}` : undefined);
    const current = !!targetId && isSavedReviewResult(job, project.jobs) && reviewMatchesPrompt(job, targetId, currentReviewPrompt(project, targetId));
    const revised = !!target && project.jobs.some((item): boolean => item.kind === 'revise' && item.parentJobId === job.id && item.shotId === target.shotId && item.promptKind === target.promptKind && item.materialId === target.materialId);
    return <div key={`${job.id}:${label}`} data-review-target={targetId} data-review-current={current ? 'true' : 'false'}>{!current && <p className="canvas-hint">历史审查问题：当前正文已变化或缺少送审快照，请重新审查当前正文。</p>}<ReviewIssueSelection issues={targetIssues} targetLabel={label} disabled={disabled || !target || !current} revised={revised} onRevise={async (selectedIssueIds: string[]): Promise<void> => { if (target && current) await state.reviseContent(job.id, { ...target, selectedIssueIds }); }} /></div>;
  })}</div>;
};

/** 与画布共用项目和 Chat 任务，展示理解、空间方案及候选，不创建第二份状态。 */
export const PetStoryRuntime: React.FC<{ project: PetStoryProject; disabled: boolean; showPlanCandidates?: boolean }> = ({ project, disabled, showPlanCandidates = true }): React.ReactElement => {
  const state = usePetStoryStore(); const tasks = useTaskStore((store) => store.tasks);
  const [reviewFocus, setReviewFocus] = React.useState('');
  const trimmedReviewFocus = reviewFocus.trim();
  const pending = project.jobs.some((job): boolean => !job.endedWaitingAt && ['bound', 'captured'].includes(job.status));
  const generationDisabled = disabled || pending || !state.freeChatConfirmed;
  const jobs = project.jobs.filter((job): boolean => !!job.requestId && ['analysis', 'assets', 'review', 'revise', 'repair'].includes(job.kind) && !planRequestRoot(project, job) && (showPlanCandidates || !job.parsedResult?.assets));
  return <div className="canvas-runtime" aria-label="剧本理解与创作候选">
    <details className="petstory-secondary-tools"><summary>更多操作</summary><Space wrap><span>创作目标模型</span><Select aria-label="文字创作目标模型" value={petStoryWritingModel(project)} disabled={disabled || pending} style={{ width: 210 }} options={[
      { value: 'generic', label: '通用计划（模型未定）' }, { value: 'seedance-2.0-fast', label: 'Seedance 2.0 Fast' }, { value: 'seedance-2.0', label: 'Seedance 2.0' }, { value: 'seedance-2.0-mini', label: 'Seedance 2.0 Mini' }, { value: 'seedance-2.5', label: 'Seedance 2.5' },
    ]} onChange={(value: string): void => { void state.savePromptModel(value as PetStoryProject['promptModel']); }} /></Space>
    <p className="canvas-hint">请选择后续制作使用的模型；实际可用性仍需在豆包中核对。</p>
    <Space wrap><Button size="small" disabled={generationDisabled || !project.mobileStory} onClick={(): void => { void state.analyze(); }}>{project.plan ? '重新分析，生成新方案候选' : '分析剧本并生成方案'}</Button><Button size="small" disabled={generationDisabled || !project.plan} onClick={(): void => { void state.extractAssets(); }}>补齐人物／道具／场景</Button><Button size="small" disabled={generationDisabled || !project.plan} onClick={(): void => { void state.reviewContent(trimmedReviewFocus ? { reviewFocus: trimmedReviewFocus } : undefined); }}>审查当前方案与提示词</Button></Space>
    <Input.TextArea aria-label="内容审查关注点" placeholder="可选：希望重点核对的疑点" maxLength={2000} rows={2} value={reviewFocus} disabled={generationDisabled} onChange={(event): void => setReviewFocus(event.target.value)} />
    <p className="canvas-hint">只填写希望核对的疑点，豆包仍须以来源和实际正文判断；不会直接替换正文</p>
    <p className="canvas-hint">重新拆镜保存为候选。采用资产清单保留当前镜头；图片仍须逐张确认。</p>
    </details>
    {showPlanCandidates && <PetStoryPlanReview project={project} disabled={disabled} />}
    {jobs.length > 0 && <details className="canvas-runtime-results"><summary>其他候选与内容问题 · {jobs.length} 次</summary>{[...jobs].reverse().map((job): React.ReactNode => <article key={job.id} className="canvas-runtime-result"><strong>{stageNames[job.kind]}</strong><Tag>{job.resultStatus === 'adopted' ? '已采用' : job.resultStatus === 'stale' ? '过期候选' : job.status === 'applied' ? '已保存候选' : job.status === 'invalid' ? '待核对' : '等待原任务'}</Tag>
      {job.resultStatus === 'stale' && <Alert type="warning" message={job.staleReason || '当前内容已更新，请核对这条历史回复。'} />}
      {job.parsedResult?.assets && <><p>素材清单候选：{job.parsedResult.assets.characters.length} 人物 · {job.parsedResult.assets.props.length} 道具 · {job.parsedResult.assets.scenes.length} 场景</p><details><summary>查看素材与镜头关联</summary><p className="whitespace-pre-wrap">{job.parsedResult.assets.understanding}</p><p className="whitespace-pre-wrap">{job.parsedResult.assets.sceneDesign}</p><p>人物：{job.parsedResult.assets.characters.map((item): string => item.name).join('、')}</p><p>道具：{job.parsedResult.assets.props.map((item): string => item.name).join('、') || '无必要道具'}</p><p>场景：{job.parsedResult.assets.scenes.map((item): string => item.name).join('、')}</p>{job.parsedResult.assets.shotBindings.map((binding): React.ReactNode => <p key={binding.shotId}>镜头 {project.plan?.shots.find((shot): boolean => shot.id === binding.shotId)?.order || '待对应'} · {job.parsedResult?.assets?.scenes.find((scene): boolean => scene.id === binding.sceneId)?.name || '场景待对应'} · 人物 {binding.characterIds.map((id): string => job.parsedResult?.assets?.characters.find((character): boolean => character.id === id)?.name || '待对应人物').join('、')} · 道具 {binding.propIds.map((id): string => job.parsedResult?.assets?.props.find((prop): boolean => prop.id === id)?.name || '待对应道具').join('、') || '无'}</p>)}</details><Button size="small" disabled={disabled || !isValidatedCandidate(job)} onClick={(): void => { void state.adoptAssetsCandidate(job.id); }}>采用素材清单与关联（保留当前镜头）</Button></>}
      {job.kind === 'revise' && job.parsedResult?.optimized && <details open={job.resultStatus === 'candidate'}><summary>查看本次定点修订正文</summary><pre className="prompt-readonly">{job.parsedResult.optimized}</pre><Button size="small" disabled={disabled || !isValidatedCandidate(job)} onClick={(): void => { void state.adoptPromptCandidate(job.id); }}>采用本次修订</Button></details>}
      <RuntimeReview project={project} job={job} disabled={generationDisabled} /><PromptProvenance job={job} task={tasks.find((task): boolean => task.id === job.taskId)} />
    </article>)}</details>}
  </div>;
};
