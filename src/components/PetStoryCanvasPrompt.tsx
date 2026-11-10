import React, { useEffect, useState } from 'react';
import { Button, Input, Modal } from 'antd';
import { ExpandOutlined, LoadingOutlined } from '@ant-design/icons';
import type { PetStoryChatJob, PetStoryProject, PetStoryPrompt, PetStoryPromptKind, PetStoryShot, Task } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { canvasJobLabel, canvasPromptNames } from './petStoryCanvasShared';
import { canStartBoundChat, readSavedPromptCandidate } from '../utils/petstoryCandidate';
import type { CanvasDirtyChanged } from './petStoryCanvasShared';
import { isPetStoryAutomaticPromptFailure, PetStoryChatRecoveryActions, PetStoryFormatCorrections } from './PetStoryTaskRecovery';
import { useAccountStore } from '../store/useAccountStore';
import { canSelectAccount, findInteractiveAccountId } from '../utils/interactiveAccount';
import { resolveTaskConversationTarget } from '../utils/taskConversationLocator';
import { revealBrowser } from '../utils/workspace';
import { usePetStoryDraft } from './PetStoryDrafts';
import { PetStoryConversationButton } from './PetStoryConversationButton';

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

/** 只由可见的用户动作打开原任务会话；不启动任务、不占用输入框。 */
export function openCanvasPromptConversation(task: Task): void {
  const accountId = task.assignedAccountId;
  if (!accountId || !useAccountStore.getState().accounts.some((account): boolean => account.id === accountId)) return;
  if (!canSelectAccount(accountId, findInteractiveAccountId(useTaskStore.getState().accountAutomationState))) return;
  useAccountStore.getState().selectAccount(accountId); revealBrowser();
  if (resolveTaskConversationTarget(task).ok) window.dispatchEvent(new CustomEvent('open-task-conversation', { detail: { task } }));
}

function targetPromptJob(job: PetStoryChatJob, shotId: string, kind: PetStoryPromptKind): boolean {
  return job.shotId === shotId && job.promptKind === kind && ['optimize', 'revise', 'repair'].includes(job.kind);
}

function promptConversationTask(project: PetStoryProject, job: PetStoryChatJob | undefined, tasks: Task[]): Task | undefined {
  if (!job || job.materialId) return undefined;
  return tasks.find((item: Task): boolean => item.id === job.taskId && item.mode === 'chat'
    && item.projectId === project.studioProjectId && item.assignedAccountId === project.accountId
    && (!job.runId || item.runtime?.runId === job.runId)
    && (!item.petstoryChat || item.petstoryChat.projectId === project.id && item.petstoryChat.jobId === job.id));
}

function needsOriginalPromptReadback(job: PetStoryChatJob, task: Task | undefined): boolean {
  // 已收取的校验失败由后台修订，不能被原任务的暂停状态误当成结果未明。
  if (job.status === 'invalid' && job.rawText) return false;
  return !!task?.runtime?.submittedAt && ['fail', 'paused', 'cancelled', 'waiting_verification'].includes(task.status);
}
const InvalidPromptProgress: React.FC<{ job: PetStoryChatJob; task?: Task; repairing: boolean }> = ({ job, task, repairing }): React.ReactElement => {
  const repairable = isPetStoryAutomaticPromptFailure(job);
  const issues = [...new Set([...(job.validationDetails || []).map((issue): string => issue.message), ...(job.validationIssues || [])].filter((message): boolean => !!message.trim()))];
  if (!issues.length && job.error) issues.push(job.error);
  // 校验问题只投影后台状态；用户不承担模型回复的格式与内容契约修复。
  return <div role="status">
    {repairable || repairing ? <>
      <p className={repairing ? 'canvas-prompt-progress' : 'canvas-hint'}>{repairing && <LoadingOutlined spin />} {repairing ? '正在后台修订并校验…' : '提示词待后台修订'}</p>
      <p className="canvas-hint">校验通过后提供完整候选，确认使用后继续制作。</p>
      {!!issues.length && <details><summary>查看后台校验记录</summary><ul className="list-disc pl-4" aria-label="提示词校验问题">{issues.map((issue): React.ReactNode => <li key={issue}>{issue}</li>)}</ul></details>}
    </> : <>
      <div className="canvas-prompt-notice"><span>本次回复尚未通过校验</span>{task && <Button size="small" onClick={(): void => openCanvasPromptConversation(task)}>查看豆包对话</Button>}</div>
      {!!issues.length && <ul className="canvas-error list-disc pl-4" aria-label="提示词校验问题">{issues.map((issue): React.ReactNode => <li key={issue}>{issue}</li>)}</ul>}
    </>}
  </div>;
};

/** 日常节点仅呈现真实进度和一个直接恢复动作；原始记录仍由全局任务中心保存。 */
const CanvasPromptProgress: React.FC<{ project: PetStoryProject; job?: PetStoryChatJob; task?: Task; disabled: boolean }> = ({ project, job, task, disabled }): React.ReactElement | null => {
  const state = usePetStoryStore(); const taskState = useTaskStore();
  if (!job || job.endedWaitingAt || job.status === 'applied' || job.resultStatus === 'stale') return null;
  if (!task && job.status !== 'invalid') return <p className="canvas-hint" role="status">任务状态待更新</p>;
  const canStart = canStartBoundChat(project, job, task, taskState.tasks, taskState.activeTaskId === job.taskId || !!taskState.accountBusy[project.accountId]);
  const needsLogin = task?.status === 'waiting_verification' || task?.errorInfo?.code === 'authentication_unconfirmed';
  if (needsLogin) return <div className="canvas-prompt-notice" role="status"><span>需要登录豆包或完成验证</span>{task && <Button size="small" onClick={(): void => openCanvasPromptConversation(task)}>去处理</Button>}</div>;
  if (task && needsOriginalPromptReadback(job, task)) return <div className="canvas-prompt-notice" role="status"><span>本次结果尚未取得</span><Button size="small" onClick={(): void => openCanvasPromptConversation(task)}>查看豆包对话</Button></div>;
  if (canStart && job.kind === 'repair' && task?.status === 'queued') return <p className="canvas-hint" role="status">后台修订待启动</p>;
  if (canStart) return <div className="canvas-prompt-notice" role="status"><span>本项生成尚未完成</span><Button size="small" disabled={disabled || state.busy} onClick={(): void => { void state.resumeCanvasPrompt(job.id); }}>重试</Button></div>;
  if (job.status === 'invalid') return <InvalidPromptProgress job={job} task={task} repairing={state.promptRepairJobIds.includes(job.id)} />;
  if (task && ['fail', 'paused', 'cancelled'].includes(task.status)) return <div className="canvas-prompt-notice" role="status"><span>本项暂未完成</span><Button size="small" onClick={(): void => openCanvasPromptConversation(task)}>查看豆包对话</Button></div>;
  return <p className="canvas-prompt-progress" role="status"><LoadingOutlined spin /> {job.kind === 'repair' ? '正在后台修订并校验…' : job.status === 'captured' || task?.runtime?.chatResponse ? '正在保存结果…' : '正在生成…'}</p>;
};

interface PromptFacts {
  job?: PetStoryChatJob; task?: Task; candidateJob?: PetStoryChatJob; invalidJob?: PetStoryChatJob; sourceTask?: Task; conversationTask?: Task;
  candidate: string; displayed: string; pending: boolean; retainedCandidate: boolean;
}
/** 新创作请求发出后，旧结果仍可查看或作为明确修改基准，不能继续假装可直接采用。 */
function supersededPromptCandidate(project: PetStoryProject, candidate: PetStoryChatJob | undefined): boolean {
  if (!candidate) return false;
  return project.jobs.slice(project.jobs.indexOf(candidate) + 1).some((next): boolean => {
    if (!next.requestId || !targetPromptJob(next, candidate.shotId || '', candidate.promptKind || 'video')) return false;
    let root = next; const seen = new Set<string>();
    while (root.kind === 'repair' && root.parentJobId && !seen.has(root.id)) {
      seen.add(root.id); const parent = project.jobs.find((item): boolean => item.id === root.parentJobId);
      if (!parent) break; root = parent;
    }
    return root.kind !== 'review';
  });
}
function promptFacts(project: PetStoryProject, shot: PetStoryShot, kind: PetStoryPromptKind, prompt: PetStoryPrompt, tasks: Task[]): PromptFacts {
  const job = [...project.jobs].reverse().find((item): boolean => targetPromptJob(item, shot.id, kind));
  const task = tasks.find((item): boolean => item.id === job?.taskId);
  const candidateJob = [...project.jobs].reverse().find((item): boolean => targetPromptJob(item, shot.id, kind) && item.status === 'applied' && !item.endedWaitingAt
    && item.resultStatus === 'candidate' && (prompt.candidateJobId ? item.id === prompt.candidateJobId : !prompt.edited && (item.parsedResult?.optimized || readSavedPromptCandidate(item.rawText)) === prompt.optimized));
  const invalidJob = job?.status === 'invalid' && !job.endedWaitingAt && job.resultStatus !== 'stale' && job.parsedResult?.optimized?.trim() ? job : undefined;
  const visibleCandidate = invalidJob ? undefined : candidateJob;
  const candidate = visibleCandidate?.parsedResult?.optimized || (visibleCandidate ? prompt.optimized : '');
  const displayed = invalidJob?.parsedResult?.optimized || candidate || prompt.final;
  const sourceJobId = invalidJob?.id || visibleCandidate?.id || (prompt.edited ? prompt.basisJobId : prompt.sourceJobId);
  const sourceJob = project.jobs.find((item): boolean => item.id === sourceJobId && targetPromptJob(item, shot.id, kind));
  const sourceTask = tasks.find((item): boolean => item.id === sourceJob?.taskId);
  // 新入口跟随当前展示的正文；不能把后续失败请求当作已采用正文的来源。
  const conversationTask = promptConversationTask(project, displayed ? sourceJob : job, tasks);
  const pending = !!job && !!task && !job.endedWaitingAt && ['bound', 'captured'].includes(job.status) && !task?.errorInfo && !['fail', 'paused', 'cancelled', 'waiting_verification'].includes(task?.status || '');
  return { job, task, candidateJob: visibleCandidate, invalidJob, sourceTask, conversationTask, candidate, displayed, pending, retainedCandidate: supersededPromptCandidate(project, visibleCandidate) };
}
function promptDisplayLabel(prompt: PetStoryPrompt, candidate: string, invalid: boolean, retained: boolean): string {
  if (invalid) return '上次结果 · 校验未通过';
  if (retained) return '保留结果 · 已有后续请求';
  if (candidate) return '新结果 · 待确认';
  if (!prompt.final) return '尚未生成';
  return prompt.edited ? '当前使用 · 手改正文' : '当前使用';
}

function promptPreviewDescription(invalid: boolean, retained: boolean, candidate: string, final: string): string {
  if (invalid) return final ? '这是上次未通过校验的回复，当前使用正文保留。' : '这是上次未通过校验的回复，尚未用于制作。';
  if (retained) return '已有后续请求，此前结果保留供查看或再次提出修改。';
  return candidate ? '本次新结果，确认后用于后续制作。' : '当前使用的完整正文。';
}

interface PromptFeedbackSelection {
  projectId: string; shotId: string; promptKind: PetStoryPromptKind; body: string; baseJobId?: string;
}
interface PromptManualSelection extends PromptFeedbackSelection { expectedFinal: string }

/** 手改只保存本项正式正文；弹窗草稿不参与生成，后台回填不能替换正在编辑的内容。 */
const ManualPromptModal: React.FC<{
  selection: PromptManualSelection; title: string; disabled: boolean; dirtyChanged: CanvasDirtyChanged; onClose: () => void;
}> = ({ selection, title, disabled, dirtyChanged, onClose }): React.ReactElement => {
  const [body, setBody] = useState(selection.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const key = `${selection.projectId}:${selection.shotId}:${selection.promptKind}`;
  const dirty = body !== selection.body;
  useEffect((): void => { dirtyChanged(key, dirty); }, [key, dirty, dirtyChanged]);
  useEffect(() => (): void => dirtyChanged(key, false), [key, dirtyChanged]);
  const save = async (): Promise<void> => {
    if (saving || disabled || !body.trim()) return;
    const current = usePetStoryStore.getState();
    const prompt = current.project?.plan?.shots.find((shot): boolean => shot.id === selection.shotId)?.prompts[selection.promptKind];
    if (current.project?.id !== selection.projectId || !prompt || prompt.final !== selection.expectedFinal) {
      setError('当前正文已变化，手改内容已保留，请取消后重新选择要修改的正文。'); return;
    }
    setSaving(true); setError('');
    try {
      await current.saveShotPrompt(selection.shotId, selection.promptKind, body, { expectedFinal: selection.expectedFinal, ...(selection.baseJobId ? { baseJobId: selection.baseJobId } : {}) });
      const saved = usePetStoryStore.getState();
      const final = saved.project?.id === selection.projectId ? saved.project.plan?.shots.find((shot): boolean => shot.id === selection.shotId)?.prompts[selection.promptKind]?.final : undefined;
      if (saved.error || final !== body) setError(saved.error || '提示词尚未保存，手改内容已保留，请重试。');
      else onClose();
    } catch (cause: unknown) { setError(cause instanceof Error ? cause.message : '提示词保存失败，手改内容已保留，请重试。'); }
    finally { setSaving(false); }
  };
  usePetStoryDraft(key, `${title} · 手动修改`, dirty, { save, discard: onClose, locate: (): void => { document.getElementById(`manual-${selection.shotId}-${selection.promptKind}`)?.focus(); } });
  return <Modal closable={false} className="canvas-prompt-modal" title={`手动修改${title}`} open width={800} onCancel={(): void => { if (!saving) onClose(); }}
    okText="确定" cancelText="取消" confirmLoading={saving} onOk={(): void => { void save(); }} okButtonProps={{ disabled: disabled || !body.trim() }} cancelButtonProps={{ disabled: saving }} maskClosable={!saving} keyboard={!saving}>
    <p className="canvas-modal-source">点击“确定”保存，后续生成图片或视频使用这份提示词。</p>
    <label className="canvas-feedback-label" htmlFor={`manual-${selection.shotId}-${selection.promptKind}`}>提示词正文</label>
    <Input.TextArea id={`manual-${selection.shotId}-${selection.promptKind}`} className="canvas-prompt-input" autoFocus value={body} maxLength={100_000} disabled={saving}
      onChange={(event: React.ChangeEvent<HTMLTextAreaElement>): void => setBody(event.target.value)} />
    {error && <p className="canvas-error" role="alert">{error}</p>}
  </Modal>;
};

function feedbackSelectionError(selection: PromptFeedbackSelection, project: PetStoryProject | null): string {
  if (!project || project.id !== selection.projectId) return '当前项目已变化，请保留修改意见并重新选择正文。';
  const prompt = project.plan?.shots.find((item): boolean => item.id === selection.shotId)?.prompts[selection.promptKind];
  if (!prompt) return '当前镜头已变化，请保留修改意见并重新选择正文。';
  const body = selection.baseJobId ? project.jobs.find((item): boolean => item.id === selection.baseJobId)?.parsedResult?.optimized : prompt.final;
  return body === selection.body ? '' : '选定正文已变化，修改意见已保留，请取消后重新选择要修改的正文。';
}

/** 正文默认只读；支持明确保存手改正文，也可通过修改要求取得完整新候选。 */
export const CanvasPromptEditor: React.FC<{
  project: PetStoryProject; shot: PetStoryShot; kind: PetStoryPromptKind; disabled: boolean;
  generationBlocked: boolean; dirtyChanged: CanvasDirtyChanged;
}> = ({ project, shot, kind, disabled, generationBlocked, dirtyChanged }): React.ReactElement | null => {
  const state = usePetStoryStore(); const tasks = useTaskStore((store) => store.tasks);
  const [expanded, setExpanded] = useState(false);
  const [manualSelection, setManualSelection] = useState<PromptManualSelection | null>(null);
  const [feedbackSelection, setFeedbackSelection] = useState<PromptFeedbackSelection | null>(null);
  const [feedbackError, setFeedbackError] = useState('');
  const [feedback, setFeedback] = useState(''); const [submitting, setSubmitting] = useState(false);
  const prompt = shot.prompts[kind];
  if (!prompt) return null;
  const { job, task, candidateJob, invalidJob, sourceTask, conversationTask, candidate, displayed, pending, retainedCandidate } = promptFacts(project, shot, kind, prompt, tasks);
  const repairing = !!job && state.promptRepairJobIds.includes(job.id);
  const actionDisabled = disabled || generationBlocked || pending || repairing || submitting;
  const title = `镜头 ${shot.order} · ${canvasPromptNames[kind]}`;
  const feedbackBaseJob = invalidJob || candidateJob;
  const manualCandidate = !invalidJob && !retainedCandidate ? candidateJob : undefined;
  const manualBody = manualCandidate ? candidate : prompt.final;
  const openManual = (): void => {
    setExpanded(false);
    setManualSelection({ projectId: project.id, shotId: shot.id, promptKind: kind, body: manualBody, expectedFinal: prompt.final, ...(manualCandidate ? { baseJobId: manualCandidate.id } : {}) });
  };
  const openFeedback = (): void => {
    setExpanded(false); setFeedbackError('');
    setFeedbackSelection({ projectId: project.id, shotId: shot.id, promptKind: kind, body: displayed, ...(feedbackBaseJob ? { baseJobId: feedbackBaseJob.id } : {}) });
  };
  const adopt = async (): Promise<void> => { if (candidateJob) await state.adoptPromptCandidate(candidateJob.id); };
  const submit = async (): Promise<void> => {
    if (!feedbackSelection || !feedback.trim() || actionDisabled || state.busy) return;
    const error = feedbackSelectionError(feedbackSelection, usePetStoryStore.getState().project);
    if (error) { setFeedbackError(error); return; }
    setFeedbackError(''); setSubmitting(true);
    try {
      await state.revisePrompt({ shotId: feedbackSelection.shotId, promptKind: feedbackSelection.promptKind, feedback: feedback.trim(), ...(feedbackSelection.baseJobId ? { baseJobId: feedbackSelection.baseJobId } : {}) });
      const submissionError = usePetStoryStore.getState().error;
      if (submissionError) setFeedbackError(submissionError);
      else { setFeedbackSelection(null); setFeedback(''); setFeedbackError(''); }
    } finally { setSubmitting(false); }
  };
  const actions = <div className="canvas-prompt-actions">
    {candidateJob && !retainedCandidate && <Button size="small" type="primary" disabled={actionDisabled || state.busy} onClick={(): void => { void adopt(); }}>确认使用</Button>}
    <Button size="small" disabled={actionDisabled || !manualBody} onClick={openManual}>{manualBody && manualBody !== displayed ? '手动修改当前正文' : '手动修改'}</Button>
    <Button size="small" disabled={actionDisabled || !displayed} onClick={openFeedback}>修改要求</Button>
    {kind === 'video' && <PetStoryConversationButton projectId={project.id} task={conversationTask} unavailableHint="当前提示词尚无可定位的原豆包任务" />}
  </div>;
  return <div className="canvas-prompt" id={`prompt-${shot.id}-${kind}`} data-prompt-kind={kind} data-candidate={candidateJob ? 'true' : undefined}>
    <div className="canvas-field-label"><strong>{canvasPromptNames[kind]}</strong><button type="button" disabled={!displayed} aria-label={`放大镜头${shot.order}${canvasPromptNames[kind]}`} onClick={(): void => setExpanded(true)}><ExpandOutlined /> 全文</button></div>
    <div className="canvas-source"><span>{promptDisplayLabel(prompt, candidate, !!invalidJob, retainedCandidate)}</span>{displayed && <span>{displayed.length} 字</span>}</div>
    {displayed ? <pre tabIndex={0} aria-label={`${title}${invalidJob ? '校验未通过全文' : candidate ? '候选全文' : '当前正文'}`} className={`canvas-prompt-readonly ${candidate ? 'is-candidate' : ''}`}>{displayed}</pre> : <p className="canvas-hint">{job && !job.endedWaitingAt && job.resultStatus !== 'stale' ? '本镜提示词尚未准备完成。' : `点击本镜${kind === 'video' ? '生成视频' : '生成图片'}时会准备所需提示词。`}</p>}
    {candidate && prompt.final && !retainedCandidate && <p className="canvas-hint">{prompt.edited ? '确认后将替换当前手改正文，原版本保留。' : '确认前继续使用原正文，已有图片和视频保留。'}</p>}
    <CanvasPromptProgress project={project} job={job} task={task} disabled={disabled || generationBlocked} />
    {actions}
    {expanded && <Modal className="canvas-prompt-modal" title={title} open onCancel={(): void => setExpanded(false)} width={800}
      footer={<Button onClick={(): void => setExpanded(false)}>返回画布</Button>}>
      <p className="canvas-modal-source">{promptPreviewDescription(!!invalidJob, retainedCandidate, candidate, prompt.final)}</p>
      <pre className="canvas-modal-text">{displayed}</pre>{actions}
      {displayed !== prompt.final && prompt.final && <details className="canvas-current-text"><summary>查看当前使用的正文</summary><pre className="canvas-modal-text">{prompt.final}</pre></details>}
      {sourceTask && <button type="button" className="canvas-text-button" onClick={(): void => { setExpanded(false); openCanvasPromptConversation(sourceTask); }}>查看这次豆包对话</button>}
    </Modal>}
    {manualSelection && <ManualPromptModal selection={manualSelection} title={title} disabled={disabled || pending || repairing || submitting || state.busy} dirtyChanged={dirtyChanged} onClose={(): void => setManualSelection(null)} />}
    {feedbackSelection && <Modal closable={false} className="canvas-prompt-modal canvas-feedback-modal" title={`修改${title}`} open onCancel={(): void => { if (!submitting) setFeedbackSelection(null); }} width={700}
      okText="提交修改" cancelText="取消" onOk={(): void => { void submit(); }} confirmLoading={submitting} okButtonProps={{ disabled: !feedback.trim() || actionDisabled || state.busy }} cancelButtonProps={{ disabled: submitting }}>
      <details className="canvas-current-text"><summary>查看本次选定正文</summary><pre className="canvas-modal-text">{feedbackSelection.body}</pre></details>
      <label className="canvas-feedback-label" htmlFor={`feedback-${shot.id}-${kind}`}>请说明希望调整哪里</label>
      <Input.TextArea id={`feedback-${shot.id}-${kind}`} autoFocus value={feedback} onChange={(event: React.ChangeEvent<HTMLTextAreaElement>): void => setFeedback(event.target.value)} placeholder="请说明希望调整哪里" rows={5} maxLength={5000} disabled={submitting} />
      {feedbackError && <p className="canvas-error" role="alert">{feedbackError}</p>}
    </Modal>}
  </div>;
};
