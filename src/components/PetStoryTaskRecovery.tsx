import React from 'react';
import { Alert, Button, Card, message, Space, Tag } from 'antd';
import type { PetStoryChatJob, PetStoryProject, Task } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { useAccountStore } from '../store/useAccountStore';
import { selectPlanReview } from '../utils/petstoryPlanReview';
import { canStartBoundChat } from '../utils/petstoryCandidate';
import { revealBrowser } from '../utils/workspace';
import { canvasPromptNames } from './petStoryCanvasShared';
import { canSelectAccount, findInteractiveAccountId } from '../utils/interactiveAccount';
import { resolveTaskConversationTarget } from '../utils/taskConversationLocator';

function jobRepairAncestors(project: PetStoryProject, job: PetStoryChatJob): PetStoryChatJob[] {
  const ancestors: PetStoryChatJob[] = []; const visited = new Set([job.id]);
  let current = job;
  while (current.kind === 'repair' && current.parentJobId) {
    const parent = project.jobs.find((item): boolean => item.id === current.parentJobId);
    if (!parent || visited.has(parent.id)) break;
    visited.add(parent.id); ancestors.push(parent); current = parent;
  }
  return ancestors;
}

function hasCutBindingIssue(job: PetStoryChatJob): boolean {
  return job.status === 'invalid' && ['analysis', 'repair'].includes(job.kind) && /^[a-zA-Z0-9_-]+切镜不应绑定上一镜头$/.test(job.error || '');
}

/** 结构整理可追溯，不把它显示为内容质量或媒体效果通过。 */
export const PetStoryFormatCorrections: React.FC<{ job: PetStoryChatJob }> = ({ job }): React.ReactElement | null => job.formatCorrections?.length
  ? <Alert className="mt-2" type="info" showIcon message="已整理分镜结构" description={<ul>{job.formatCorrections.map((item): React.ReactNode => <li key={item}>{item}</li>)}</ul>} /> : null;

export function petStoryJobTargetName(project: PetStoryProject, job: PetStoryChatJob): string {
  const material = project.materials?.find((item): boolean => item.id === job.materialId);
  if (material) return `${material.name} · 基础素材提示词`;
  const shot = project.plan?.shots.find((item): boolean => item.id === job.shotId);
  if (shot) return `镜头 ${shot.order}${job.promptKind ? ` · ${canvasPromptNames[job.promptKind]}` : ''}`;
  const kind = jobRepairAncestors(project, job).at(-1)?.kind || job.kind;
  return ({ analysis: '剧本理解与分镜方案', assets: '人物／道具／场景清单', review: '内容审查', revise: '内容修订', repair: '回复缺项修订', optimize: '镜头提示词', materialPrompt: '基础素材提示词' })[kind];
}

export function petStoryJobStatus(job: PetStoryChatJob, task?: Task): { title: string; instruction: string } {
  const repairAction = job.validationDetails?.some((issue): boolean => issue.code === 'duration') ? '正在请豆包修正镜头时长…' : '正在请豆包修正内容，请等待完整回复…';
  if (job.endedWaitingAt) return { title: '已结束等待', instruction: '平台任务并未取消，也未认定回复已收到或已采用；可只读检查原回复，其他独立目标仍可继续。' };
  if (hasCutBindingIssue(job)) return { title: '分镜结构待整理', instruction: '回复已明确采用正常切镜，但保留了多余的前镜头绑定。点击下方按钮，工具会读取已有回复并整理这项结构，保留原文、剧情和台词，再完整校验分镜方案。' };
  if (job.status === 'invalid') return job.kind === 'repair' ? { title: '仍需调整', instruction: '豆包还未修好，你可以继续调整。原回复与修订回复均已保留。' } : { title: '内容需要处理', instruction: '已保留原回复。查看具体问题后修订，或返回对应对象处理；不要重复发送原请求。' };
  if (job.status === 'applied') {
    if (job.resultStatus === 'stale') return { title: '历史回复待核对', instruction: '当前依据已变化，这条回复仅作历史记录；请查看对应对象的当前内容和制作条件。' };
    return { title: job.resultStatus === 'candidate' ? '新候选待选择' : '回复已保存', instruction: job.resultStatus === 'candidate' ? (job.kind === 'repair' ? '已修正，请确认完整内容。' : '请对比并采用需要的结果；收到候选不会覆盖你的手动修改。') : '当前回复已保存，可继续对应阶段。' };
  }
  if (task?.runtime?.chatResponse?.text || job.status === 'captured') return { title: '回复已收到，待保存', instruction: '读取原任务已保存的回复，完成核对后回填当前对象；无需重新发送。' };
  if (task?.runtime?.submittedAt) {
    if (['fail', 'paused', 'cancelled', 'waiting_verification'].includes(task.status)) return { title: '发送结果需要核对', instruction: '已有发送记录，不能重复发送。打开原豆包会话，检查原回复；找回后沿原任务保存。' };
    if (job.kind === 'repair') return { title: '正在修订', instruction: repairAction };
    return task.runtime.acceptanceObservation?.runId === task.runtime.runId
      ? { title: '平台已受理，正在等待回复', instruction: '工具正在观察原会话并读取回复，请等待。结束等待不会取消平台任务。' }
      : { title: '正在核对发送结果', instruction: '工具已保存发送意图并观察原会话，目前尚未确认平台受理；不能重复发送。' };
  }
  if (!task) return { title: '原任务记录待载入', instruction: '先刷新任务记录，再核对原请求。此处不会新建或重发任务。' };
  if (['executing', 'generating', 'manual_submission_observing'].includes(task.status)) return job.kind === 'repair' ? { title: '正在修订', instruction: repairAction } : { title: '正在处理', instruction: '正在准备这次豆包请求，请等待页面反馈。' };
  return { title: '原任务尚未发送', instruction: '先处理豆包登录、验证或页面阻断，再从这里继续原任务；它会复用原请求。' };
}

function openOriginalTask(task: Task): void {
  const accountId = task.assignedAccountId;
  if (!accountId || !useAccountStore.getState().accounts.some((account): boolean => account.id === accountId)) { message.warning('原执行账号不存在，请先在账号与浏览器中处理。'); return; }
  const interactiveId = findInteractiveAccountId(useTaskStore.getState().accountAutomationState);
  if (!canSelectAccount(accountId, interactiveId)) { message.warning('其他账号正在配置或提交，请待提交结束后再打开原账号。'); return; }
  useAccountStore.getState().selectAccount(accountId);
  revealBrowser();
  // 没有原会话地址时只打开原账号，让用户从历史对话查找；不猜测或绑定当前页面。
  if (resolveTaskConversationTarget(task).ok) window.dispatchEvent(new CustomEvent('open-task-conversation', { detail: { task } }));
}

/** 与原恢复服务共用，读结果和结束等待不受无关编辑草稿阻断。 */
export const PetStoryChatRecoveryActions: React.FC<{ project: PetStoryProject; job: PetStoryChatJob; task?: Task; compact?: boolean }> = ({ project, job, task, compact = false }): React.ReactElement => {
  const state = usePetStoryStore();
  const taskState = useTaskStore();
  const pending = !job.endedWaitingAt && ['bound', 'captured'].includes(job.status);
  const canStart = canStartBoundChat(project, job, task, taskState.tasks, taskState.activeTaskId === job.taskId || !!taskState.accountBusy[project.accountId]);
  const canReconcile = job.status === 'bound' && !!task?.runtime?.submittedAt && ['fail', 'paused', 'cancelled', 'waiting_verification'].includes(task.status);
  const conversation = resolveTaskConversationTarget(task);
  const localFormatFix = hasCutBindingIssue(job);
  const canRepair = !localFormatFix && !job.endedWaitingAt && job.resultStatus !== 'stale' && job.status === 'invalid' && !!job.requestId && !project.jobs.some((item): boolean => item.kind === 'repair' && item.parentJobId === job.id);
  const canAdjust = job.status === 'invalid' && !project.jobs.some((item): boolean => item.parentJobId === job.id && item.kind === 'repair')
    && (project.chatAdjustment?.status !== 'active' || project.chatAdjustment.repairJobId === job.id);
  const adjust = (): void => {
    if (project.chatAdjustment?.status === 'active') { revealBrowser(); window.dispatchEvent(new CustomEvent('petstory-open-adjustment')); return; }
    void state.openChatAdjustment({ parentJobId: job.id, ...(job.materialId ? { materialId: job.materialId } : {}), ...(job.shotId ? { shotId: job.shotId, promptKind: job.promptKind } : {}) });
  };
  const controls = <><Space wrap className="mt-2" aria-label={`${petStoryJobTargetName(project, job)}处理操作`}>
    {task && <Button size="small" onClick={(): void => openOriginalTask(task)}>{conversation.ok ? '打开对应豆包会话' : '打开执行账号豆包'}</Button>}
    {job.status !== 'applied' && <Button size="small" type={localFormatFix ? 'primary' : 'default'} disabled={state.busy || !task?.runtime?.chatResponse?.text && job.status !== 'captured'} onClick={(): void => { void state.collect(job.id); }}>{localFormatFix ? '读取原回复并整理分镜结构' : '重新保存回复'}</Button>}
    {canReconcile && <Button size="small" disabled={state.busy} onClick={(): void => { void state.recoverChat(job.id); }}>检查原回复（不重复发送）</Button>}
    {canStart && <Button size="small" type="primary" disabled={state.busy} onClick={(): void => { void state.startBoundChat(job.id); }}>{task?.status === 'queued' ? '继续原文字任务（尚未发送）' : '处理阻断后继续原任务（未发送）'}</Button>}
    {canRepair && <Button size="small" disabled={state.busy} onClick={(): void => { void state.correctOnce(job.id); }}>按具体缺项修订一次</Button>}
    {canAdjust && <Button size="small" onClick={adjust}>在豆包中调整</Button>}
    {pending && <Button size="small" disabled={state.busy} onClick={(): void => { void state.endChatWaiting(job.id); }}>结束本次等待</Button>}
    {!task && <Button size="small" disabled={state.busy} onClick={(): void => { void taskState.loadTasks(); }}>刷新任务记录</Button>}
  </Space>{canReconcile && !conversation.ok && conversation.reason === 'CONVERSATION_URL_MISSING' && <p className="mt-2 text-amber-600" role="status">原任务未保存可直接打开的会话地址。请在右侧该账号的历史对话中找到原请求，再点击“检查原回复”；只有唯一匹配才会保存，不会重复发送。</p>}</>;
  if (!compact) return controls;
  let label = conversation.ok ? '核对原回复' : '打开执行账号豆包';
  let action = (): void => { if (task) openOriginalTask(task); };
  if (canAdjust && job.kind === 'repair') {
    label = '在豆包中调整'; action = adjust;
  } else if (localFormatFix || job.status === 'captured' || job.status === 'bound' && task?.runtime?.chatResponse?.text) {
    label = localFormatFix ? '读取原回复并整理分镜结构' : '重新保存回复';
    action = (): void => { void state.collect(job.id); };
  } else if (canReconcile) {
    label = '检查原回复（不重复发送）'; action = (): void => { void state.recoverChat(job.id); };
  } else if (canStart) {
    label = '继续原文字任务（尚未发送）'; action = (): void => { void state.startBoundChat(job.id); };
  } else if (canRepair) {
    label = '按具体缺项修订一次'; action = (): void => { void state.correctOnce(job.id); };
  } else if (!task) {
    label = '刷新任务记录'; action = (): void => { void taskState.loadTasks(); };
  }
  return <><Button type="primary" disabled={state.busy} onClick={action}>{label}</Button>
    <details className="petstory-secondary-tools"><summary>其他处理方式</summary>{controls}</details></>;

};

function currentJobs(project: PetStoryProject): PetStoryChatJob[] {
  const latestTargets = new Set<string>();
  return [...project.jobs].reverse().filter((job): boolean => {
    // repair 是原目标的后续回复；不能另开一个全局“repair”分组，让已修好的父任务永久报错。
    const ancestors = jobRepairAncestors(project, job); const root = ancestors.at(-1) || job;
    const key = job.materialId || root.materialId || `${job.shotId || root.shotId || 'project'}:${job.promptKind || root.promptKind || root.kind}`;
    const latest = !latestTargets.has(key); latestTargets.add(key);
    return !job.endedWaitingAt && (['bound', 'captured'].includes(job.status) || latest && job.status === 'invalid');
  });
}

const PetStoryProductionRecovery: React.FC<{ project: PetStoryProject }> = ({ project }): React.ReactElement | null => {
  const state = usePetStoryStore(); const tasks = useTaskStore((store) => store.tasks);
  const production = project.production;
  if (!production || production.state === 'complete') return null;
  const step = production.steps.find((item): boolean => item.status !== 'complete');
  const task = tasks.find((item): boolean => item.id === step?.taskId);
  const material = project.materials?.find((item): boolean => item.id === step?.materialId);
  const shot = project.plan?.shots.find((item): boolean => item.id === step?.shotId);
  const awaitingImage = !!step && step.kind !== 'video' && project.assets.some((asset): boolean => asset.imageReview?.state === 'candidate' && (step?.materialId ? asset.imageReview.target.materialId === step.materialId : asset.imageReview.target.shotId === step?.shotId));
  const inspectImages = (): void => { const stage = step?.materialId ? 'materials' : 'keyframes'; const id = step?.materialId ? `material-${step.materialId}` : `shot-media-${step?.shotId}-${step?.kind}`; window.dispatchEvent(new CustomEvent('petstory-locate-draft', { detail: { stage, id, objectId: step?.shotId } })); requestAnimationFrame((): void => document.getElementById(id)?.scrollIntoView({ block: 'center', behavior: 'smooth' })); };
  return <section className="py-3" aria-label="当前媒体制作任务">
      <strong>{material?.name || (shot ? `镜头 ${shot.order}` : '当前素材制作')}</strong> <Tag color={production.state === 'paused' ? 'orange' : 'blue'}>{production.state === 'paused' ? '制作已暂停' : '正在制作'}</Tag>
      <p className="my-2">{production.message}</p>{step?.error && <Alert type="warning" message={step.error} />}
      <Space wrap>{awaitingImage && <Button size="small" type="primary" onClick={inspectImages}>查看待确认图片</Button>}{task && <Button size="small" onClick={(): void => openOriginalTask(task)}>打开对应豆包会话</Button>}{production.state === 'running' ? <Button size="small" disabled={state.busy} onClick={(): void => { void state.pauseProduction(); }}>暂停后续制作</Button> : <>
        <Button size="small" disabled={state.busy} onClick={(): void => { void state.resumeProduction(); }}>继续原制作任务</Button>
        {task?.runtime?.submittedAt && <Button size="small" disabled={state.busy} onClick={(): void => { window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: task.id } })); revealBrowser(); }}>检查原制作结果（不重复发送）</Button>}
      </>}</Space>
    </section>;
};

/** 始终位于画布缩放之外；恢复入口直接可见，任务标识和原始记录留在诊断内。 */
export const PetStoryCurrentTasks: React.FC<{ project: PetStoryProject; onContinue?: () => void; hidePlanRequests?: boolean }> = ({ project, onContinue, hidePlanRequests = false }): React.ReactElement => {
  const tasks = useTaskStore((store) => store.tasks);
  const mergedPlanIds = new Set(hidePlanRequests ? selectPlanReview(project).family.map((job): string => job.id) : []);
  const jobs = currentJobs(project).filter((job): boolean => !mergedPlanIds.has(job.id));
  const ended = project.jobs.filter((job): boolean => !!job.endedWaitingAt).length;
  const production = project.production;
  if (!jobs.length && (!production || production.state === 'complete') && !ended) return <></>;
  if (!jobs.length && (!production || production.state === 'complete')) return <details className="petstory-secondary-tools"><summary>历史等待记录 · {ended} 条</summary><p>已结束等待的请求仍保留原记录；平台任务未被取消，迟到回复不会自动采用。</p>{onContinue && <Button size="small" onClick={onContinue}>继续其他可制作项</Button>}</details>;
  return <Card size="small" className="petstory-current-tasks" title="待处理事项">
    {!jobs.length && (!production || production.state === 'complete') && <p role="status">当前没有正在等待的任务。请按当前阶段的推荐操作继续。</p>}
    {jobs.map((job): React.ReactNode => {
      const original = tasks.find((item): boolean => item.id === job.taskId);
      const status = petStoryJobStatus(job, original);
      return <section key={job.id} className="border-b border-white/10 py-3 first:pt-0" aria-label={`${petStoryJobTargetName(project, job)}当前任务`}>
        <strong>{petStoryJobTargetName(project, job)}</strong> <Tag color={job.status === 'invalid' ? 'orange' : 'blue'}>{status.title}</Tag>
        <p className="my-2">{status.instruction}</p>{job.error && job.kind !== 'repair' && <Alert type="warning" message={hasCutBindingIssue(job) ? '正常切镜中残留了前镜头绑定，可直接整理已保存的回复。' : job.error} showIcon />}
        <PetStoryChatRecoveryActions project={project} job={job} task={original} />
        <PetStoryFormatCorrections job={job} />
        <details className="mt-2"><summary>诊断详情与原始记录</summary><p>任务：{job.taskId}<br />运行：{job.runId || '尚未启动'}</p>{job.error && <p>{job.error}</p>}{job.rulesVersion && <p>规则：{job.rulesVersion}</p>}{job.rawText && <pre className="prompt-readonly">{job.rawText}</pre>}{jobRepairAncestors(project, job).map((parent): React.ReactNode => <details key={parent.id}><summary>本次修订的原回复记录</summary><p>原任务：{parent.taskId}</p><p>{parent.error}</p>{parent.rawText && <pre className="prompt-readonly">{parent.rawText}</pre>}</details>)}{original?.runtime?.chatReadbackReview && <><p>{original.runtime.chatReadbackReview.reason}</p><pre className="prompt-readonly">{JSON.stringify(original.runtime.chatReadbackReview.candidates, null, 2)}</pre></>}</details>
      </section>;
    })}
    <PetStoryProductionRecovery project={project} />
    {ended > 0 && <p className="mt-3 text-gray-400">已保留 {ended} 条结束等待记录；平台任务未被取消，迟到回复仍需核对采用。{onContinue && <Button type="link" size="small" onClick={onContinue}>继续其他可制作项</Button>}</p>}
  </Card>;
};
