import React, { useEffect, useState } from 'react';
import { Button, Input, Modal } from 'antd';
import { CopyOutlined, ExpandOutlined } from '@ant-design/icons';
import type { PetStoryChatJob, PetStoryProject, PetStoryPrompt, PetStoryPromptKind, PetStoryShot, Task } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { canvasCopyText, canvasJobLabel, canvasPromptNames } from './petStoryCanvasShared';
import { isSavedReviewResult, readSavedPromptCandidate, reviewMatchesPrompt } from '../utils/petstoryCandidate';
import type { CanvasDirtyChanged } from './petStoryCanvasShared';
import { PetStoryChatRecoveryActions, PetStoryFormatCorrections } from './PetStoryTaskRecovery';
import { ReviewIssueSelection } from './PetStoryReviewIssues';
import { usePetStoryDraft, locatePetStoryDraft } from './PetStoryDrafts';

function candidateAdoption(job: PetStoryChatJob | undefined, adopt: (jobId: string) => Promise<void>): (() => Promise<void>) | undefined {
  if (!job?.requestId) return undefined;
  return async (): Promise<void> => adopt(job.id);
}
const ReadbackFacts: React.FC<{ task?: Task }> = ({ task }): React.ReactElement | null => {
  const review = task?.runtime?.chatReadbackReview;
  return review ? <details><summary>只读回读事实 · 归属待核对（未正式收取）</summary><p>{review.reason}</p>{review.candidates.map((candidate, index): React.ReactNode => <details key={index}><summary>可见候选 {index + 1} · 消息 {candidate.messageIndex}</summary><pre>{candidate.rawText}</pre></details>)}</details> : null;
};
const LateCandidate: React.FC<{ job: PetStoryChatJob }> = ({ job }): React.ReactElement | null => {
  const state = usePetStoryStore();
  return job.endedWaitingAt && job.parsedResult?.optimized ? <details><summary>{job.resultStatus === 'adopted' ? '迟到历史正文 · 已明确采用' : '迟到历史候选 · 尚未采用'}</summary><pre>{job.parsedResult.optimized}</pre><Button disabled={state.busy || job.resultStatus !== 'candidate'} onClick={(): void => { void state.adoptPromptCandidate(job.id); }}>核对后采用历史候选</Button></details> : null;
};
export const PromptProvenance: React.FC<{ job: PetStoryChatJob; task?: Task }> = ({ job, task }): React.ReactElement => {
  const pending = !job.endedWaitingAt && ['bound', 'captured'].includes(job.status);
  const capturedAt = task?.runtime?.chatResponse?.capturedAt;
  const label = job.endedWaitingAt ? '已结束等待 · 原平台任务状态独立' : pending ? canvasJobLabel(task?.status) : job.status === 'applied' ? '已保存回复来源' : '回复待核对';

  const project = usePetStoryStore((state) => state.project);
  return <><details className="canvas-provenance"><summary>回复来源与处理记录 · {label}{capturedAt && ` · ${new Date(capturedAt).toLocaleString('zh-CN')}`}</summary>
    {project && <PetStoryChatRecoveryActions project={project} job={job} task={task} />}<PetStoryFormatCorrections job={job} />
    <p>任务 {job.taskId}<br />运行 {job.runId || '待启动'}</p>
    {job.rulesVersion && <p>规则 {job.rulesVersion} · 请求 {job.requestId}<br />{job.ruleFiles?.join('\n')}</p>}
    {job.resultStatus === 'stale' && <p role="alert">过期候选：{job.staleReason || '当前事实已经变化，请按新状态重新生成。'}</p>}
    {job.error && <p role="alert">{job.error}</p>}
    <ReadbackFacts task={task} />
    {task?.prompt && <details><summary>查看本次实际发送请求</summary><pre>{task.prompt}</pre></details>}
    <LateCandidate job={job} />
    {job.rawText && <details><summary>查看豆包完整原回复</summary><pre>{job.rawText}</pre></details>}
  </details></>;
};

const PromptCandidate: React.FC<{ prompt: PetStoryPrompt; disabled: boolean; latestApplied: boolean; expanded?: boolean; save: (value: string) => Promise<void>; adopt?: () => Promise<void> }> = ({ prompt, disabled, latestApplied, expanded, save, adopt }): React.ReactElement | null => {
  if (!prompt.optimized) return null;
  const adopted = prompt.optimized === prompt.final;
  const label = adopted ? latestApplied ? '查看已采用的豆包回复' : '查看已有采用正文' : '新提示词待确认 · 查看完整候选';
  return <details className="canvas-candidate" open={expanded || undefined}><summary>{label}</summary><pre>{prompt.optimized}</pre>
    {!adopted && <Button size="small" type="primary" disabled={disabled} onClick={(): void => { void (adopt ? adopt() : save(prompt.optimized)); }}>采用这条回复</Button>}
  </details>;
};

function promptSource(prompt: PetStoryPrompt, latestApplied: boolean): string {
  if (latestApplied && prompt.final === prompt.optimized) return '豆包 Chat · 当前采用';
  return prompt.edited ? '用户编辑 · 当前采用' : '已有保存内容';
}

const PromptReviewActions: React.FC<{ project: PetStoryProject; shot: PetStoryShot; kind: PetStoryPromptKind; disabled: boolean; generationBlocked: boolean; pending: boolean }> = ({ project, shot, kind, disabled, generationBlocked, pending }): React.ReactElement => {
  const state = usePetStoryStore();
  const review = [...project.jobs].reverse().find((item): boolean => isSavedReviewResult(item, project.jobs) && reviewMatchesPrompt(item, `${shot.id}:${kind}`, shot.prompts[kind]?.final) && item.parsedResult?.issues?.some((issue): boolean => (issue.targetId === shot.id || issue.targetId === `${shot.id}:${kind}`) && (!issue.promptKind || issue.promptKind === kind)) === true);
  const revised = !!review && project.jobs.some((item): boolean => item.kind === 'revise' && item.parentJobId === review.id && item.shotId === shot.id && item.promptKind === kind);
  const actionDisabled = disabled || generationBlocked || pending;
  const issues = review?.parsedResult?.issues?.filter((issue): boolean => (issue.targetId === shot.id || issue.targetId === `${shot.id}:${kind}`) && (!issue.promptKind || issue.promptKind === kind)) || [];
  return <><div className="canvas-prompt-actions"><Button size="small" disabled={actionDisabled} onClick={(): void => { void state.reviewContent({ shotId: shot.id, promptKind: kind }); }}>审查本项正文</Button></div>
    {review && <ReviewIssueSelection key={`${review.id}:${shot.id}:${kind}`} issues={issues} targetLabel={`镜头 ${shot.order} ${canvasPromptNames[kind]}`} disabled={actionDisabled} revised={revised} onRevise={async (selectedIssueIds: string[]): Promise<void> => state.reviseContent(review.id, { shotId: shot.id, promptKind: kind, selectedIssueIds })} />}</>;
};

const PromptStatusNotes: React.FC<{ prompt: PetStoryPrompt }> = ({ prompt }): React.ReactElement => <>
    {!prompt.final.trim() && <p className="canvas-hint">这个镜头还没有已采用的提示词，请先生成或在豆包中调整。</p>}
    {prompt.draft && <details><summary>分析附带的创作计划草稿 · 不可直接提交</summary><pre>{prompt.draft}</pre></details>}
    {!!prompt.final && !prompt.promptTask && <p className="canvas-hint">旧正文待适配，请按当前模型／模式通过豆包重新生成或修订。</p>}
    {prompt.edited && prompt.optimized !== prompt.final && <p className="canvas-hint">手改正文已保留；新候选尚未采用，下游使用当前正文。</p>}
    {prompt.needsReview && <p className="canvas-error">当前正文待复核，请查看本项审查问题或回复来源；核对后再采用或保存。</p>}
</>;

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
  const fieldId = `prompt-${shot.id}-${kind}`;
  usePetStoryDraft(key, `镜头 ${shot.order} · ${canvasPromptNames[kind]}`, dirty, {
    save: async (): Promise<void> => { await save(text); },
    discard: (): void => { setText(savedFinal); setEditing(false); },
    locate: (): void => locatePetStoryDraft(kind === 'video' ? 'videos' : 'keyframes', fieldId),
  });
  if (!prompt) return null;
  const job = [...project.jobs].reverse().find((item): boolean => item.shotId === shot.id && item.promptKind === kind);
  const task = tasks.find((item): boolean => item.id === job?.taskId);
  const pending = !!job && !job.endedWaitingAt && ['bound', 'captured'].includes(job.status);
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
  const editor = <Input.TextArea id={fieldId} className="canvas-prompt-input" aria-label={`镜头${shot.order}${canvasPromptNames[kind]}最终正文`} value={text} readOnly={disabled}
    onChange={(event): void => { setEditing(event.target.value !== savedFinal); setText(event.target.value); }} rows={expanded ? 14 : 6} />;
  const copy = (): void => { void canvasCopyText(text).then((): void => setCopyStatus('已复制')).catch((): void => setCopyStatus('请选中文字复制')); };
  const candidateDisabled = disabled || dirty || candidateJob?.resultStatus === 'stale';
  const adopt = candidateAdoption(candidateJob, state.adoptPromptCandidate);
  const saveDisabled = disabled || !dirty || !text.trim();
  return <div className="canvas-prompt" data-prompt-kind={kind}>
    <div className="canvas-field-label"><strong>{canvasPromptNames[kind]}</strong><button type="button" aria-label={`放大镜头${shot.order}${canvasPromptNames[kind]}`} onClick={(): void => setExpanded(true)}><ExpandOutlined /> 全文</button></div>
    <div className="canvas-source"><span className={prompt.edited ? 'source-manual' : ''}>{promptSource(prompt, latestApplied)}</span><span>{text.length} 字</span></div>
    <PromptStatusNotes prompt={prompt} />
    {!expanded && editor}
    {dirty && <div className="canvas-prompt-actions"><Button size="small" type="primary" disabled={saveDisabled} onClick={(): void => { void save(text); }}>保存修改</Button>
      {dirty && <button type="button" onClick={(): void => { setText(prompt.final); setEditing(false); }}>放弃修改</button>}
    </div>}
    <PromptCandidate prompt={prompt} disabled={candidateDisabled} latestApplied={latestApplied} save={save} adopt={adopt} />
    <Button size="small" className="canvas-chat-button" disabled={disabled} onClick={(): void => { void state.openChatAdjustment({ shotId: shot.id, promptKind: kind }); }}>在豆包中调整</Button>
    <details className="petstory-secondary-tools"><summary>更多提示词操作</summary><Button size="small" disabled={!text} onClick={copy} icon={<CopyOutlined />}>{copyStatus || '复制'}</Button><Button size="small" disabled={disabled || generationBlocked || pending} onClick={(): void => { void state.optimize(shot.id, kind); }}>{pending ? `豆包 ${canvasJobLabel(task?.status)}` : '重新生成提示词'}</Button>
      <PromptReviewActions project={project} shot={shot} kind={kind} disabled={disabled} generationBlocked={generationBlocked} pending={pending} />
    </details>
    {(job || candidateJob) && <details className="canvas-provenance"><summary>生成记录／诊断详情</summary>{job && <PromptProvenance job={job} task={task} />}{candidateJob && candidateJob.id !== job?.id && <PromptProvenance job={candidateJob} task={tasks.find((item): boolean => item.id === candidateJob.taskId)} />}</details>}
    <Modal className="canvas-prompt-modal" title={`镜头 ${shot.order} · ${canvasPromptNames[kind]} · 完整编辑`} open={expanded} onCancel={(): void => setExpanded(false)} width={760}
      footer={<><Button onClick={(): void => setExpanded(false)}>返回画布</Button><Button type="primary" disabled={saveDisabled} onClick={(): void => { void save(text); }}>保存修改</Button></>}>
      <p className="canvas-modal-source">{promptSource(prompt, latestApplied)} · 当前已保存 {prompt.final.length} 字。保存后用于后续实际任务。</p>{editor}
      <PromptCandidate prompt={prompt} disabled={candidateDisabled} latestApplied={latestApplied} expanded save={save} adopt={adopt} />
    </Modal>
  </div>;
};
