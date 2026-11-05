import React from 'react';
import { Alert, Button, Input, Modal, Space, Spin } from 'antd';
import type { PetStoryChatJob, PetStoryPlan, PetStoryProject, PetStoryRuntimeTarget, Task } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { planRequestRoot, selectPlanReview } from '../utils/petstoryPlanReview';
import { canStartBoundChat } from '../utils/petstoryCandidate';
import { planFeedbackBlockingTask } from '../utils/petstoryPlanTaskConflict';
import { navigateWorkspace } from '../utils/workspace';
import { resolveTaskConversationTarget } from '../utils/taskConversationLocator';
import { PetStoryPlanPreview } from './PetStoryPlanPreview';
import { isPetStoryAutomaticPromptFailure, openPetStoryOriginalTask, petStoryJobStatus } from './PetStoryTaskRecovery';
import { useDraggableModal } from './useDraggableModal';

type PlanFeedback = NonNullable<PetStoryRuntimeTarget['planFeedback']>;
interface Props { project: PetStoryProject; baseJobId?: string; open: boolean; onClose: () => void }

function showTask(taskId: string): void {
  navigateWorkspace('tasks');
  window.dispatchEvent(new CustomEvent('show-workspace-task', { detail: { taskId } }));
}

const FeedbackBlocker: React.FC<{ project: PetStoryProject; onClose: () => void }> = ({ project, onClose }): React.ReactElement | null => {
  const state = usePetStoryStore();
  const tasks = useTaskStore((store) => store.tasks);
  const blocked = planFeedbackBlockingTask(project, tasks);
  if (blocked) return <Alert type="info" showIcon message="原账号当前有任务需要处理。你的修改要求会保留，处理后可以继续。" action={<Button onClick={(): void => {
    showTask(blocked.id);
    onClose();
  }}>查看占用任务</Button>} />;
  if (project.chatAdjustment?.status === 'active') return <Alert type="info" showIcon message="还有一段未结束的豆包调整。结束后即可提交本次修改。" action={<Button disabled={state.busy} onClick={(): void => { void state.endChatAdjustment(); }}>结束上一段调整</Button>} />;
  return null;
};

function candidatePlan(job: PetStoryChatJob | undefined): PetStoryPlan | undefined {
  return job?.status === 'applied' && job.resultStatus === 'candidate' ? job.parsedResult?.plan : undefined;
}
function adjustmentRecoveryLabel(canCorrect: boolean, readable: boolean, canContinue: boolean): string {
  if (canCorrect) return '继续修正方案';
  if (readable) return '读取调整结果';
  return canContinue ? '继续这次调整' : '检查这次调整结果';
}
/** 失败回复仅作历史；重新反馈使用当前采用方案，不能借此跳过仍未决的提交。 */
function canRestartPlanFeedback(project: PetStoryProject, job: PetStoryChatJob, tasks: Task[]): boolean {
  const task = tasks.find((item): boolean => item.id === job.taskId);
  if (!project.plan || !job.planFeedback || job.status !== 'invalid' || job.endedWaitingAt || task?.status !== 'done' || task.errorInfo
    || project.chatAdjustment?.status === 'active' || planFeedbackBlockingTask(project, tasks)) return false;
  const selection = selectPlanReview(project);
  return selection.job?.id === job.id && !selection.family.some((item): boolean => !item.endedWaitingAt && ['bound', 'captured'].includes(item.status));
}

const AdjustmentProgress: React.FC<{ project: PetStoryProject; root: PetStoryChatJob; latest: PetStoryChatJob; onError: (error: string) => void; onStopped: () => void; onRestart: () => void }> = ({ project, root, latest, onError, onStopped, onRestart }): React.ReactElement => {
  const state = usePetStoryStore(); const taskState = useTaskStore();
  const task = taskState.tasks.find((item): boolean => item.id === latest.taskId);
  const repairing = state.promptRepairJobIds.includes(latest.id);
  const active = !latest.endedWaitingAt && ['bound', 'captured'].includes(latest.status);
  const running = active && !!task && ['executing', 'generating', 'manual_submission_observing'].includes(task.status);
  const readable = latest.status === 'captured' || !!task?.runtime?.chatResponse?.text;
  const accountBusy = taskState.activeTaskId === latest.taskId || !!taskState.accountBusy[project.accountId];
  const canContinue = !latest.endedWaitingAt && canStartBoundChat(project, latest, task, taskState.tasks, accountBusy);
  const canCorrect = !latest.endedWaitingAt && latest.resultStatus !== 'stale' && isPetStoryAutomaticPromptFailure(latest);
  const status = petStoryJobStatus(latest, task, repairing);
  const conversation = resolveTaskConversationTarget(task);
  const title = repairing || running && latest.kind === 'repair' ? '正在检查并整理新方案' : running ? '正在按你的要求调整方案' : status.title;
  const recover = async (): Promise<void> => {
    onError('');
    if (canCorrect) await state.correctOnce(latest.id);
    else if (readable) await state.collect(latest.id);
    else if (canContinue) await state.startBoundChat(latest.id);
    else if (task?.runtime?.submittedAt) await state.recoverChat(latest.id);
    else await taskState.loadTasks();
    const saved = usePetStoryStore.getState();
    if (saved.project?.id === project.id && saved.error) onError(saved.error);
  };
  const stopWaiting = async (): Promise<void> => {
    onError('');
    await state.endChatWaiting(latest.id);
    const saved = usePetStoryStore.getState();
    if (saved.project?.id !== project.id) return;
    if (saved.project.jobs.find((job): boolean => job.id === latest.id)?.endedWaitingAt) onStopped();
    else if (saved.error) onError(saved.error);
  };
  return <><p className="petstory-adjustment-note">本次修改：{root.planFeedback?.text}</p>
    <div className="petstory-plan-adjustment-status" role="status">{(running || repairing) && <Spin size="small" />} <strong>{title}</strong><p>{status.instruction}</p></div>
    {!running && !repairing && <Space wrap>
      {task && (conversation.ok ? <Button onClick={(): void => openPetStoryOriginalTask(task)}>打开这次调整会话</Button> : <Button onClick={(): void => showTask(task.id)}>查看这次调整任务</Button>)}
      <Button disabled={state.busy} onClick={(): void => { void recover(); }}>{adjustmentRecoveryLabel(canCorrect, readable, canContinue)}</Button>
      {!accountBusy && canRestartPlanFeedback(project, latest, taskState.tasks) && <Button disabled={state.busy} onClick={onRestart}>重新提出修改</Button>}
    </Space>}
    {active && <Button disabled={state.busy} onClick={(): void => { void stopWaiting(); }}>停止等待</Button>}
    {task && !conversation.ok && !running && <p className="petstory-adjustment-note">这次任务尚未保存可验证的会话位置，请在任务详情中核对原结果。</p>}
    {running && <p className="petstory-adjustment-note">你可以先返回方案，结果会自动显示在方案区。</p>}
  </>;
};

interface FooterProps { mode: 'editing' | 'running' | 'candidate'; busy: boolean; submitting: boolean; empty: boolean; onClose: () => void; onSubmit: () => Promise<void>; onAdopt: () => Promise<void>; onContinue: () => void }
const AdjustmentFooter: React.FC<FooterProps> = ({ mode, busy, submitting, empty, onClose, onSubmit, onAdopt, onContinue }): React.ReactElement => {
  if (mode === 'candidate') return <><Button disabled={busy} onClick={onClose}>暂不采用</Button><Button disabled={busy} onClick={onContinue}>继续调整</Button><Button aria-label="确认并采用新方案" type="primary" loading={busy} onClick={(): void => { void onAdopt(); }}>确认并采用新方案</Button></>;
  if (mode === 'running') return <Button disabled={submitting} onClick={onClose}>返回方案</Button>;
  return <><Button aria-label="取消" disabled={submitting} onClick={onClose}>取消</Button><Button aria-label="开始调整" aria-busy={submitting} type="primary" loading={submitting} disabled={empty || busy || submitting} onClick={(): void => { void onSubmit(); }}>开始调整</Button></>;
};

/** 对话框跟随正式任务的原请求和修订链；返回页面不会取消任务或重新发送。 */
export const PetStoryPlanAdjustment: React.FC<Props> = ({ project, baseJobId, open, onClose }): React.ReactElement => {
  const draggable = useDraggableModal(open);
  const state = usePetStoryStore();
  const current = state.project?.id === project.id ? state.project : project;
  const [text, setText] = React.useState('');
  const [sourceId, setSourceId] = React.useState<string>();
  const [rootId, setRootId] = React.useState<string>();
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState('');
  const request = React.useRef<PlanFeedback>();
  const draft = React.useRef<{ text: string; baseJobId?: string }>();
  const restartedJobId = React.useRef<string>();
  const input = React.useRef<React.ElementRef<typeof Input.TextArea>>(null);
  const wasOpen = React.useRef(false);
  React.useEffect((): void => {
    if (open && !wasOpen.current) {
      const selection = selectPlanReview(current);
      const root = selection.family[0];
      const latest = selection.job;
      // 重开未完成的调整只接回原任务；已完成时以当前看到的候选开始下一次反馈。
      const restarting = latest?.id === restartedJobId.current && !!latest && canRestartPlanFeedback(current, latest, useTaskStore.getState().tasks);
      const pending = !restarting && root?.planFeedback && latest && !latest.endedWaitingAt && ['bound', 'captured', 'invalid'].includes(latest.status);
      // 已落库的请求由任务链恢复；完成后再次反馈必须使用新授权，不能复用旧幂等键。
      const submittedRequest = request.current && current.jobs.some((job): boolean => job.kind === 'analysis' && job.planFeedback?.requestId === request.current?.requestId);
      const savedRequest = !submittedRequest && request.current?.baseJobId === baseJobId ? request.current : undefined;
      const savedDraft = !submittedRequest && draft.current?.baseJobId === baseJobId ? draft.current : undefined;
      setRootId(pending ? root.id : undefined);
      setSourceId(pending ? root.planFeedback?.baseJobId : baseJobId);
      setText(pending ? root.planFeedback?.text || '' : savedDraft?.text ?? savedRequest?.text ?? '');
      request.current = pending ? root.planFeedback : savedRequest;
      setError('');
      if (!pending) usePetStoryStore.setState({ error: '' });
    }
    wasOpen.current = open;
  }, [open, current, baseJobId]);
  React.useEffect((): void => { if (open && !rootId) input.current?.focus(); }, [open, rootId]);
  const root = current.jobs.find((job): boolean => job.id === rootId);
  const latest = root ? current.jobs.filter((job): boolean => planRequestRoot(current, job)?.id === root.id).at(-1) : undefined;
  const candidate = candidatePlan(latest);
  const visibleError = error || (root ? state.error : '');
  const submit = async (): Promise<void> => {
    if (!text.trim() || submitting || rootId) return;
    let feedback = request.current;
    // 同一次点击的重试复用授权ID；相同网络结果不确定时不会另建任务。
    if (!feedback || feedback.text !== text.trim() || feedback.baseJobId !== sourceId) feedback = { text: text.trim(), baseJobId: sourceId, requestId: crypto.randomUUID() };
    request.current = feedback;
    setSubmitting(true); setError('');
    try {
      const id = await state.revisePlan(feedback);
      const saved = usePetStoryStore.getState();
      if (saved.project?.id !== project.id) return;
      if (id) { setRootId(id); draft.current = undefined; restartedJobId.current = undefined; }
      if (saved.error) setError(saved.error);
      else if (!id) setError('调整尚未开始，修改要求已保留，请稍后再试。');
    } catch (failure: unknown) { setError(failure instanceof Error ? failure.message : '调整暂未开始，修改要求已保留。'); }
    finally { setSubmitting(false); }
  };
  const adopt = async (): Promise<void> => {
    if (!latest || !candidate) return;
    setError('');
    await state.adoptPlanCandidate(latest.id);
    let saved = usePetStoryStore.getState();
    if (saved.project?.id !== project.id || saved.error || saved.project.jobs.find((job): boolean => job.id === latest.id)?.resultStatus !== 'adopted') { setError(saved.error || '方案依据已变化，请重新查看当前方案。'); return; }
    await saved.confirmStory(); saved = usePetStoryStore.getState();
    if (saved.project?.id === project.id && !saved.error && saved.project.storyApproval) { request.current = undefined; draft.current = undefined; onClose(); }
    else setError(saved.error || '新方案已保存，请在方案区继续确认。');
  };
  const continueEditing = (): void => {
    if (!latest || !candidate) return;
    setSourceId(latest.id); setRootId(undefined); setText(''); setError(''); request.current = undefined; draft.current = { text: '', baseJobId: latest.id };
  };
  const restartEditing = (): void => {
    const saved = usePetStoryStore.getState(); const tasks = useTaskStore.getState();
    const project = saved.project; const job = project?.jobs.find((item): boolean => item.id === latest?.id);
    if (saved.busy || !project || project.id !== current.id || !job || tasks.accountBusy[project.accountId]
      || tasks.activeTaskId === job.taskId || !canRestartPlanFeedback(project, job, tasks.tasks)) return;
    restartedJobId.current = job.id; setSourceId(undefined); setRootId(undefined); setText(''); setError('');
    request.current = undefined; draft.current = { text: '' };
  };
  const close = (): void => { if (!submitting) onClose(); };
  return <Modal title={<div {...draggable.titleProps}>调整方案</div>} modalRender={draggable.modalRender} open={open} width={candidate ? 900 : 640} onCancel={close} afterOpenChange={(shown: boolean): void => { draggable.afterOpenChange(shown); if (shown && !rootId) input.current?.focus(); }} maskClosable={!submitting} footer={<AdjustmentFooter mode={candidate ? 'candidate' : latest ? 'running' : 'editing'} busy={state.busy} submitting={submitting} empty={!text.trim()} onClose={close} onSubmit={submit} onAdopt={adopt} onContinue={continueEditing} />}>
    {!rootId && <><p id="plan-adjustment-hint">写下希望修改的地方，工具会结合当前方案生成完整的新方案。</p>
      {!sourceId && current.plan && <p className="petstory-adjustment-note">本次修改以当前已采用方案为基础。</p>}
      <Input.TextArea ref={input} aria-label="方案修改要求" aria-describedby="plan-adjustment-hint" value={text} maxLength={8000} showCount rows={5} disabled={submitting} placeholder="例如：把第二个镜头的动作放慢一些，结尾保持原来的字幕，其他剧情不变。" onChange={(event): void => { setText(event.target.value); draft.current = { text: event.target.value, baseJobId: sourceId }; }} />
      <p className="petstory-adjustment-note">当前方案和已有图片、视频会保留，满意后再采用新方案。</p>
      <FeedbackBlocker project={current} onClose={close} /></>}
    {submitting && <div className="petstory-adjustment-note" role="status"><Spin size="small" /> 正在提交调整要求…</div>}
    {visibleError && <Alert className="petstory-plan-action-error" type="error" showIcon message={visibleError} />}
    {candidate && <><p role="status">新方案已准备好，请查看。满意后采用，也可以继续提出修改。</p><div className="petstory-plan-scroll"><PetStoryPlanPreview plan={candidate} contentBasis={latest?.parsedResult?.contentBasis} /></div></>}
    {root && latest && !candidate && <AdjustmentProgress project={current} root={root} latest={latest} onError={setError} onStopped={close} onRestart={restartEditing} />}
  </Modal>;
};
