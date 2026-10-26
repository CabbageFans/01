import React, { useEffect, useState } from 'react';
import { Button, Input, Modal } from 'antd';
import { CopyOutlined, ExpandOutlined, ReloadOutlined } from '@ant-design/icons';
import type { PetStoryChatJob, PetStoryProject, PetStoryPrompt, PetStoryPromptKind, PetStoryShot, Task } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { canvasCopyText, canvasJobLabel, canvasPromptNames } from './petStoryCanvasShared';
import { isSavedReviewResult, readSavedPromptCandidate } from '../utils/petstoryCandidate';
import type { CanvasDirtyChanged } from './petStoryCanvasShared';
import { ReviewIssueSelection } from './PetStoryReviewIssues';

function canRepairRuntime(job: PetStoryChatJob, jobs: PetStoryChatJob[] | undefined): boolean {
  return job.status === 'invalid' && !['repair', 'revise'].includes(job.kind) && !!job.requestId && !jobs?.some((item): boolean => item.kind === 'repair' && item.parentJobId === job.id);
}
function hasApprovedMaterials(project: PetStoryProject): boolean {
  return !!project.storyApproval && !!project.materials?.length && project.materials.every((material): boolean => !!material.approved && material.approved.assetId === material.selectedAssetId);
}
function candidateAdoption(job: PetStoryChatJob | undefined, adopt: (jobId: string) => Promise<void>): (() => Promise<void>) | undefined {
  if (!job?.requestId) return undefined;
  return async (): Promise<void> => adopt(job.id);
}
export const PromptProvenance: React.FC<{ job: PetStoryChatJob; task?: Task }> = ({ job, task }): React.ReactElement => {
  const state = usePetStoryStore();
  const pending = ['bound', 'captured'].includes(job.status);
  const capturedAt = task?.runtime?.chatResponse?.capturedAt;
  const label = pending ? canvasJobLabel(task?.status) : job.status === 'applied' ? '已保存回复来源' : '回复待核对';
  const canReconcile = job.status === 'bound' && !!task?.runtime?.submittedAt && ['fail', 'paused', 'waiting_verification'].includes(task.status);
  const reconcile = (): void => {
    if (task) window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: task.id, useCurrentPage: !task.runtime?.conversationUrl } }));
  };
  return <details className="canvas-provenance"><summary>{label}{capturedAt && ` · ${new Date(capturedAt).toLocaleString('zh-CN')}`}</summary>
    <p>任务 {job.taskId}<br />运行 {job.runId || '待启动'}</p>
    {job.rulesVersion && <p>规则 {job.rulesVersion} · 请求 {job.requestId}<br />{job.ruleFiles?.join('\n')}</p>}
    {job.resultStatus === 'stale' && <p role="alert">过期候选：{job.staleReason || '当前事实已经变化，请按新状态重新生成。'}</p>}
    {job.error && <p role="alert">{job.error}</p>}
    {task?.prompt && <details><summary>查看本次实际发送请求</summary><pre>{task.prompt}</pre></details>}
    {job.rawText && <details><summary>查看豆包完整原回复</summary><pre>{job.rawText}</pre></details>}
    {job.status !== 'applied' && <Button size="small" disabled={state.busy} onClick={(): void => { void state.collect(job.id); }}>读取原任务已保存回复</Button>}
    {job.status === 'bound' && task?.status === 'queued' && <Button size="small" disabled={state.busy || !state.freeChatConfirmed} onClick={(): void => { void state.startBoundChat(job.id); }}>启动原绑定文字任务</Button>}
    {canRepairRuntime(job, state.project?.jobs) && <Button size="small" disabled={state.busy || !state.freeChatConfirmed} onClick={(): void => { void state.correctOnce(job.id); }}>按具体缺项修订一次</Button>}
    {canReconcile && <Button size="small" onClick={reconcile}>只读核对原 Chat 回复</Button>}
  </details>;
};

const PromptCandidate: React.FC<{ prompt: PetStoryPrompt; disabled: boolean; latestApplied: boolean; save: (value: string) => Promise<void>; adopt?: () => Promise<void> }> = ({ prompt, disabled, latestApplied, save, adopt }): React.ReactElement | null => {
  if (!prompt.optimized) return null;
  const adopted = prompt.optimized === prompt.final;
  const label = adopted ? latestApplied ? '查看已采用的豆包回复' : '查看已有采用正文' : latestApplied ? '已保存的豆包候选 · 未采用' : '已有保存候选 · 未采用';
  return <details className="canvas-candidate" open={!adopted || undefined}><summary>{label}</summary><pre>{prompt.optimized}</pre>
    <Button size="small" disabled={disabled || adopted} onClick={(): void => { void (adopt ? adopt() : save(prompt.optimized)); }}>采用这条回复</Button>
  </details>;
};

function promptSource(prompt: PetStoryPrompt, latestApplied: boolean): string {
  if (latestApplied && prompt.final === prompt.optimized) return '豆包 Chat · 当前采用';
  return prompt.edited ? '用户编辑 · 当前采用' : '已有保存内容';
}

const PromptReviewActions: React.FC<{ project: PetStoryProject; shot: PetStoryShot; kind: PetStoryPromptKind; disabled: boolean; generationBlocked: boolean; pending: boolean }> = ({ project, shot, kind, disabled, generationBlocked, pending }): React.ReactElement => {
  const state = usePetStoryStore();
  const review = [...project.jobs].reverse().find((item): boolean => isSavedReviewResult(item, project.jobs) && item.parsedResult?.issues?.some((issue): boolean => (issue.targetId === shot.id || issue.targetId === `${shot.id}:${kind}`) && (!issue.promptKind || issue.promptKind === kind)) === true);
  const revised = !!review && project.jobs.some((item): boolean => item.kind === 'revise' && item.parentJobId === review.id && item.shotId === shot.id && item.promptKind === kind);
  const actionDisabled = disabled || generationBlocked || pending || !state.freeChatConfirmed;
  const issues = review?.parsedResult?.issues?.filter((issue): boolean => (issue.targetId === shot.id || issue.targetId === `${shot.id}:${kind}`) && (!issue.promptKind || issue.promptKind === kind)) || [];
  return <><div className="canvas-prompt-actions"><Button size="small" disabled={actionDisabled} onClick={(): void => { void state.reviewContent({ shotId: shot.id, promptKind: kind }); }}>审查本项正文</Button></div>
    {review && <ReviewIssueSelection key={`${review.id}:${shot.id}:${kind}`} issues={issues} targetLabel={`镜头 ${shot.order} ${canvasPromptNames[kind]}`} disabled={actionDisabled} revised={revised} onRevise={async (selectedIssueIds: string[]): Promise<void> => state.reviseContent(review.id, { shotId: shot.id, promptKind: kind, selectedIssueIds })} />}</>;
};

/** 草稿留在对应字段；服务只原子保存该项，其他卡片的未保存输入不会被整份快照覆盖。 */
export const CanvasPromptEditor: React.FC<{
  project: PetStoryProject; shot: PetStoryShot; kind: PetStoryPromptKind; disabled: boolean;
  generationBlocked: boolean; dirtyChanged: CanvasDirtyChanged;
}> = ({ project, shot, kind, disabled, generationBlocked, dirtyChanged }): React.ReactElement | null => {
  const state = usePetStoryStore(); const tasks = useTaskStore((store) => store.tasks);
  const prompt = shot.prompts[kind]; const savedFinal = prompt?.final || '';
  const [text, setText] = useState(savedFinal); const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false); const [copyStatus, setCopyStatus] = useState('');
  const key = `${project.id}:${shot.id}:${kind}`;
  const dirty = editing && text !== savedFinal;
  useEffect((): void => { if (!editing) setText(savedFinal); }, [savedFinal, editing]);
  useEffect((): void => dirtyChanged(key, dirty), [key, dirty, dirtyChanged]);
  useEffect(() => (): void => dirtyChanged(key, false), [key, dirtyChanged]);
  if (!prompt) return null;
  const job = [...project.jobs].reverse().find((item): boolean => item.shotId === shot.id && item.promptKind === kind);
  const task = tasks.find((item): boolean => item.id === job?.taskId);
  const pending = !!job && ['bound', 'captured'].includes(job.status);
  const candidateJob = [...project.jobs].reverse().find((item): boolean => item.shotId === shot.id && item.promptKind === kind && item.status === 'applied' && (prompt.candidateJobId ? item.id === prompt.candidateJobId : readSavedPromptCandidate(item.rawText) === prompt.optimized));
  const latestApplied = !!candidateJob;
  const save = async (value: string): Promise<void> => {
    await state.saveShotPrompt(shot.id, kind, value);
    const current = usePetStoryStore.getState();
    // busy 时 store 可拒绝重复操作，必须读回目标正文才清除草稿。
    if (!current.error && current.project?.id === project.id && current.project.plan?.shots.find((item): boolean => item.id === shot.id)?.prompts[kind]?.final === value) {
      setText(value); setEditing(false);
    }
  };
  const editor = <Input.TextArea className="canvas-prompt-input" aria-label={`镜头${shot.order}${canvasPromptNames[kind]}最终正文`} value={text} readOnly={disabled}
    onChange={(event): void => { setEditing(event.target.value !== savedFinal); setText(event.target.value); }} rows={expanded ? 22 : kind === 'video' ? 15 : 7} />;
  const copy = (): void => { void canvasCopyText(text).then((): void => setCopyStatus('已复制')).catch((): void => setCopyStatus('请选中文字复制')); };
  const candidateDisabled = disabled || dirty || candidateJob?.resultStatus === 'stale';
  const adopt = candidateAdoption(candidateJob, state.adoptPromptCandidate);
  const saveDisabled = disabled || !dirty || !text.trim();
  return <div className="canvas-prompt" data-prompt-kind={kind}>
    <div className="canvas-field-label"><strong>{canvasPromptNames[kind]}</strong><button type="button" aria-label={`放大镜头${shot.order}${canvasPromptNames[kind]}`} onClick={(): void => setExpanded(true)}><ExpandOutlined /> 全文</button></div>
    <div className="canvas-source"><span className={prompt.edited ? 'source-manual' : ''}>{promptSource(prompt, latestApplied)}</span><span>{text.length} 字</span></div>
    {!hasApprovedMaterials(project) && <p className="canvas-hint">文字计划稿 · 基础图片尚未全部确认，实际引用与制作条件待核对。</p>}
    {prompt.needsReview && <p className="canvas-error">当前正文待复核，请查看本项审查问题或回复来源；核对后再采用或保存。</p>}
    {!expanded && editor}
    <div className="canvas-prompt-actions"><Button size="small" disabled={!text} onClick={copy} icon={<CopyOutlined />}>{copyStatus || '复制'}</Button>
      <Button size="small" type={dirty ? 'primary' : 'default'} disabled={saveDisabled} onClick={(): void => { void save(text); }}>保存正文</Button>
      {dirty && <button type="button" onClick={(): void => { setText(prompt.final); setEditing(false); }}>撤销未保存</button>}
    </div>
    <PromptCandidate prompt={prompt} disabled={candidateDisabled} latestApplied={latestApplied} save={save} adopt={adopt} />
    <Button size="small" className="canvas-chat-button" icon={<ReloadOutlined />} disabled={disabled || generationBlocked || pending || !state.freeChatConfirmed}
      onClick={(): void => { void state.optimize(shot.id, kind); }}>{pending ? `普通 Chat · ${canvasJobLabel(task?.status)}` : '豆包重新生成本项提示词'}</Button>
    <PromptReviewActions project={project} shot={shot} kind={kind} disabled={disabled} generationBlocked={generationBlocked} pending={pending} />
    {job && <PromptProvenance job={job} task={task} />}{candidateJob && candidateJob.id !== job?.id && <PromptProvenance job={candidateJob} task={tasks.find((item): boolean => item.id === candidateJob.taskId)} />}
    <Modal className="canvas-prompt-modal" title={`镜头 ${shot.order} · ${canvasPromptNames[kind]} · 完整编辑`} open={expanded} onCancel={(): void => setExpanded(false)} width={880}
      footer={<><Button onClick={(): void => setExpanded(false)}>返回画布</Button><Button type="primary" disabled={saveDisabled} onClick={(): void => { void save(text); }}>保存正文</Button></>}>
      <p className="canvas-modal-source">{promptSource(prompt, latestApplied)} · 当前保存正文 {prompt.final.length} 字。保存后用于后续实际任务。</p>{editor}
      <PromptCandidate prompt={prompt} disabled={candidateDisabled} latestApplied={latestApplied} save={save} adopt={adopt} />
    </Modal>
  </div>;
};
