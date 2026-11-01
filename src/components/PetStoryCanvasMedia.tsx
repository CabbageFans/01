import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Image, InputNumber, Select, Space } from 'antd';
import { PlayCircleOutlined } from '@ant-design/icons';
import type { Account, PetStoryAsset, PetStoryCompiledPrompt, PetStoryPlan, PetStoryProductionStep, PetStoryProject, PetStoryPromptKind, PetStoryShot, Task } from '@doubao-studio/contracts';
import { petStoryResubmissionTask, petStoryUnsubmittedVideoTask, usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { PetStoryImageReview } from './PetStoryImageReview';
import { pendingImageCandidates } from '../utils/petstoryImageCandidates';
import { canvasJobLabel, isCanvasPlanLocked, isPetStoryPromptPreparationMessage, petStoryVideoRecoveryMessage } from './petStoryCanvasShared';
import { usePetStoryGenerationEligibility } from './usePetStoryGenerationEligibility';
import type { PetStoryGenerationEligibility } from './usePetStoryGenerationEligibility';
import { locatePetStoryDraft, usePetStoryDraft } from './PetStoryDrafts';
import { mergePetStoryPlanDraft } from '../utils/petstoryPlanDraft';
import { journeyMaterialImageApproved, journeyShotAsset } from '../utils/petstoryJourney';
import { petStoryVideoReadOnlyRecovery } from '../utils/petstoryRecovery';
import type { PetStoryVideoReadOnlyRecovery } from '../utils/petstoryRecovery';
import { openPetStoryOriginalTask, PetStoryResubmissionActions } from './PetStoryTaskRecovery';
import { useAccountStore } from '../store/useAccountStore';
import { canSelectAccount, findInteractiveAccountId } from '../utils/interactiveAccount';
import { revealBrowser } from '../utils/workspace';

const petStoryModeNames = { auto: '自动选择', first_frame: '首帧', first_last_frame: '首尾帧', reference: '多参考' };

function productionSteps(project: PetStoryProject): PetStoryProductionStep[] {
  return [...(project.productionHistory || []).flatMap((production) => production.steps), ...(project.production?.steps || [])];
}
export const CanvasSubmissionDetails: React.FC<{ project: PetStoryProject; shot: PetStoryShot; kind: PetStoryPromptKind; dirty: boolean }> = ({ project, shot, kind, dirty }): React.ReactElement => {
  const tasks = useTaskStore((store) => store.tasks); const [preview, setPreview] = useState<PetStoryCompiledPrompt>(); const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const step = productionSteps(project).reverse().find((item): boolean => item.shotId === shot.id && item.kind === kind);
  const task = tasks.find((item): boolean => item.id === step?.taskId);
  useEffect(() => {
    let active = true; setPreview(undefined); setError('');
    if (open && !dirty) void window.electronAPI.petstory.previewPrompt(project.id, shot.id, kind).then((result): void => {
      if (active) { setPreview(result.compiledPrompt); setError(result.error || ''); }
    }).catch((): void => { if (active) setError('提交预览读取失败'); });
    return (): void => { active = false; };
  }, [open, dirty, project.id, project.revision, shot.id, kind]);
  return <details className="canvas-provenance" onToggle={(event): void => setOpen(event.currentTarget.open)}><summary>诊断：提交全文与素材记录</summary>
    {dirty ? <p>先保存修改，再查看提交预览。</p> : error ? <p>{error}</p> : <><pre>{preview?.text || '展开后读取当前计划预览'}</pre><pre>{preview?.references.map((reference): string => `${reference.order} · ${reference.purpose} · ${reference.characterIds.join('、') || '场景/关键帧'}${reference.slot ? ` · ${reference.slot} 槽` : ''}`).join('\n')}</pre></>}
    {step?.pageBindings && <pre>{step.pageBindings.map((binding): string => `${binding.order} · ${binding.label} · ${binding.slot} · ${binding.reference}`).join('\n')}</pre>}
    {task && <><strong>{task.runtime?.acceptanceObservation ? '最近已受理运行的正文' : '最近任务输入（未确认受理）'}</strong><pre>{task.runtime?.input.prompt || task.prompt}</pre><p>任务 {task.id}</p>{step?.compiledPrompt?.final !== shot.prompts[kind]?.final && <p>历史任务使用了当时保存的正文；当前正文已有变化。</p>}</>}
  </details>;
};

function videoMediaError(error: MediaError | null): string {
  switch (error?.code) {
    case 1: return '视频播放已中止，请再次点击播放。';
    case 2: return '视频文件读取失败，已生成的视频仍保留在项目中。';
    case 3: return '当前播放器无法解码这段视频，原视频仍保留在项目中。';
    case 4: return '视频格式不受当前播放器支持，或视频加载被阻止。';
    default: return '视频加载失败，已生成的视频仍保留在项目中。';
  }
}

function videoPlayError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError') return '播放未能开始，请点击视频播放器中的播放按钮。';
  if (name === 'NotSupportedError') return '当前播放器无法播放这段视频，原视频仍保留在项目中。';
  if (name === 'AbortError') return '视频播放已中止，请再次点击播放。';
  return '视频播放失败，已生成的视频仍保留在项目中。';
}

export const CanvasMediaPreview: React.FC<{ project: PetStoryProject; asset: PetStoryAsset; name: string }> = ({ project, asset, name }): React.ReactElement => {
  const [source, setSource] = useState(''); const [error, setError] = useState('');
  const originalTask = useTaskStore((store) => store.tasks.find((task): boolean => task.id === asset.taskId && task.mode === 'video'
    && task.projectId === project.studioProjectId && task.assignedAccountId === project.accountId && !!asset.runId && task.runtime?.runId === asset.runId));
  const requestedDuration = Number.parseFloat(originalTask?.runtime?.input.videoConfig?.duration || originalTask?.videoConfig?.duration || '');
  const actualDuration = asset.validation?.durationSeconds;
  const durationReview = asset.kind === 'video' && Number.isFinite(requestedDuration) && actualDuration !== undefined
    && Math.abs(actualDuration - requestedDuration) > 0.75 ? `实际${actualDuration.toFixed(2)}秒，原请求${requestedDuration}秒，请复核。` : '';
  useEffect(() => {
    let active = true; setSource(''); setError('');
    const read = asset.kind === 'video' ? window.electronAPI.petstory.readMedia(project.id, asset.id) : window.electronAPI.petstory.readReference(project.id, asset.id);
    void read.then((result): void => { if (active) { setSource(result.data || ''); setError(result.error || ''); } }).catch((): void => { if (active) setError('本地媒体读取失败'); });
    return (): void => { active = false; };
  }, [project.id, asset.id, asset.kind]);
  let content: React.ReactNode = error ? <p role="alert">{error}</p> : <p>正在读取本地文件…</p>;
  if (source) content = asset.kind === 'video' ? <video src={source} controls playsInline preload="metadata" aria-label={name}
    onError={(event: React.SyntheticEvent<HTMLVideoElement>): void => setError(videoMediaError(event.currentTarget.error))}
    onLoadedData={(): void => setError('')} /> : <Image src={source} alt={name} />;
  return <><div className="canvas-media-preview">{content}</div>{durationReview && <p className="canvas-error" role="note">{durationReview}</p>}{source && error && <p className="canvas-error" role="alert">{error}</p>}</>;
};

const mediaNames: Record<PetStoryPromptKind, string> = { firstFrame: '首帧图片', lastFrame: '尾帧图片', video: '镜头视频' };
export function selectedPetStoryMedia(project: PetStoryProject, shot: PetStoryShot, kind: PetStoryPromptKind): PetStoryAsset | undefined {
  return journeyShotAsset(project, shot, kind);
}
function assetCaption(asset: PetStoryAsset): string {
  const source = asset.origin === 'historical_task' ? '已有豆包产物 · 历史正文' : asset.taskId ? '已有豆包产物' : '用户提供图片'; const validation = asset.validation;
  if (!validation) return `${source} · 未记录文件校验`;
  const duration = validation.durationSeconds ? ` · ${validation.durationSeconds.toFixed(2)}秒` : '';
  return `${source} · ${validation.width} × ${validation.height}${duration}`;
}
const ExistingMedia: React.FC<{ project: PetStoryProject; shot: PetStoryShot; asset: PetStoryAsset; kind: PetStoryPromptKind }> = ({ project, shot, asset, kind }): React.ReactElement => <>
  <CanvasMediaPreview project={project} asset={asset} name={`镜头 ${shot.order} ${mediaNames[kind]}`} /><p className="canvas-media-caption">{assetCaption(asset)}</p>
  {asset.generationPrompt && <details className="canvas-provenance"><summary>这项产物实际使用的正文</summary><pre>{asset.generationPrompt}</pre>{asset.generationFinal ? asset.generationFinal !== shot.prompts[kind]?.final ? <p>历史产物使用的提示词与当前正文不同；修改文字不会自动重新生成图片。</p> : <p>生成使用的提示词与当前保存正文一致。</p> : <p>旧产物未单独记录当时采用的提示词，当前一致性尚未确认。</p>}</details>}
</>;

function mediaStatus(asset: PetStoryAsset | undefined, waiting: boolean, task: Task | undefined, hasCandidate: boolean): string {
  if (hasCandidate) return '图片待确认';
  if (asset?.validation) return asset.kind === 'video' && asset.needsReview ? '文件已校验 · 需要复核' : '文件校验通过';
  if (asset) return '已有文件 · 待校验';
  if (!waiting) return '未生成';
  return task?.status === 'done' ? '产物待下载 / 校验' : canvasJobLabel(task?.status);
}

/** 与高级镜头编辑共用原方案保存服务，只合并当前镜头的设置，不回写旧回复快照。 */
export const CanvasVideoSettings: React.FC<{ project: PetStoryProject; shot: PetStoryShot; onDirtyChange?: (dirty: boolean) => void }> = ({ project, shot, onDirtyChange }): React.ReactElement => {
  const state = usePetStoryStore();
  const [mode, setMode] = useState(shot.requestedMode);
  const [duration, setDuration] = useState(shot.durationSeconds);
  const [editing, setEditing] = useState(false);
  const base = useRef<PetStoryPlan>();
  const [message, setMessage] = useState('');
  const locked = state.busy || isCanvasPlanLocked(project);
  const baseShot = base.current?.shots.find((item): boolean => item.id === shot.id);
  const dirty = editing && (mode !== baseShot?.requestedMode || duration !== baseShot?.durationSeconds);
  const fieldId = `shot-video-settings-${shot.id}`;
  useEffect((): void => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => (): void => { onDirtyChange?.(false); }, [onDirtyChange]);
  useEffect((): void => { if (!editing) { setMode(shot.requestedMode); setDuration(shot.durationSeconds); } }, [shot.requestedMode, shot.durationSeconds, editing]);
  useEffect((): void => { if (editing && !dirty) { base.current = undefined; setEditing(false); } }, [editing, dirty]);
  const beginEdit = (): void => { if (!editing) base.current = project.plan ? structuredClone(project.plan) : undefined; setEditing(true); setMessage(''); };
  const discard = (): void => { setMode(shot.requestedMode); setDuration(shot.durationSeconds); base.current = undefined; setEditing(false); setMessage(''); };
  const save = async (): Promise<void> => {
    const latest = usePetStoryStore.getState().project;
    if (latest?.id !== project.id || !latest.plan || !base.current) return;
    const latestShot = latest.plan.shots.find((item): boolean => item.id === shot.id);
    if (!latestShot) { setMessage('本镜头已变化，请重新查看方案。'); return; }
    const draft = structuredClone(base.current);
    const draftShot = draft.shots.find((item): boolean => item.id === shot.id);
    if (!draftShot) { setMessage('本镜头已变化，请重新查看方案。'); return; }
    draftShot.requestedMode = mode; draftShot.durationSeconds = duration;
    let merged: PetStoryPlan;
    try { merged = mergePetStoryPlanDraft(base.current, draft, latest.plan); }
    catch (error: unknown) { setMessage(error instanceof Error ? error.message : '设置与新保存内容冲突，请保留草稿并重新核对。'); return; }
    const mergedShot = merged.shots.find((item): boolean => item.id === shot.id);
    if (mergedShot?.requestedMode === 'first_last_frame' && !mergedShot.prompts.lastFrame) mergedShot.prompts.lastFrame = { original: '', optimized: '', final: '', edited: false, rulesVersion: mergedShot.prompts.firstFrame.rulesVersion };
    await state.savePlan(merged);
    const current = usePetStoryStore.getState(); const saved = current.project?.plan?.shots.find((item): boolean => item.id === shot.id);
    if (!current.error && saved?.requestedMode === mergedShot?.requestedMode && saved?.durationSeconds === mergedShot?.durationSeconds) { base.current = undefined; setEditing(false); setMessage('视频设置已保存。若模式或时长改变，请核对本镜提示词是否需要重新适配。'); }
    else setMessage(current.error || '设置尚未保存，请重新核对。');
  };
  usePetStoryDraft(`${project.id}:${shot.id}:video-settings`, `镜头 ${shot.order} 的视频模式／时长`, dirty, { save, discard, locate: (): void => locatePetStoryDraft('videos', fieldId) });
  return <div id={fieldId} tabIndex={-1} className="canvas-video-settings"><strong>本镜视频设置</strong><Space direction="vertical" className="w-full" size="small">
    <label>请求模式<Select aria-label={`镜头${shot.order}视频请求模式`} className="w-full" disabled={locked} value={mode} options={(Object.keys(petStoryModeNames) as PetStoryShot['requestedMode'][]).map((value): { value: PetStoryShot['requestedMode']; label: string } => ({ value, label: petStoryModeNames[value] }))} onChange={(value: PetStoryShot['requestedMode']): void => { beginEdit(); setMode(value); }} /></label>
    <label>请求时长（秒）<InputNumber aria-label={`镜头${shot.order}视频时长`} min={5} max={10} precision={0} disabled={locked} value={duration} onChange={(value): void => { if (value !== null) { beginEdit(); setDuration(value); } }} /></label>
    <label>入口不支持请求模式时<Select aria-label={`镜头${shot.order}视频备选模式`} className="w-full" disabled={locked} value={state.fallbacks[shot.id] || 'none'} options={[{ value: 'none', label: '暂停，由我处理（不切换模式）' }, { value: 'first_frame', label: '本人允许改用首帧模式' }, { value: 'reference', label: '本人允许改用多参考模式' }]} onChange={(value: string): void => state.setFallback(shot.id, value === 'none' ? undefined : value as 'first_frame' | 'reference')} /></label>
    <p className="canvas-hint">备选模式授权立即用于下次生成；修改这里不会自动发送请求。</p>
    {dirty && <Space wrap><Button disabled={locked} onClick={(): void => { void save(); }}>保存视频设置</Button><Button onClick={discard}>放弃修改</Button></Space>}
    <p className="canvas-hint">执行时核对已选图片、模型、时长和比例；未完成准备时沿用原任务继续。</p>
    {message && <p role="status">{message}</p>}
  </Space></div>;
};

const CanvasVideoResolution: React.FC<{ project: PetStoryProject; shot: PetStoryShot; eligibility?: PetStoryGenerationEligibility }> = ({ project, shot, eligibility }): React.ReactElement => {
  const authorized = project.production?.referenceContinuations?.[shot.id] ? project.production.shots[shot.id] : undefined;
  const mode = authorized?.resolvedMode || eligibility?.resolvedMode; const reason = authorized?.reason || eligibility?.modeReason;
  return <div className="canvas-mode"><span>请求 <b>{petStoryModeNames[shot.requestedMode]}</b></span><span>执行模式 <b>{mode ? petStoryModeNames[mode] : '执行时读取'}</b></span>{reason && <p>{reason}</p>}</div>;
};

interface CanvasMediaFacts { asset?: PetStoryAsset; step?: PetStoryProductionStep; pendingTask?: Task; waiting: boolean; video: boolean; buttonText: string }
type VideoRecoveryAction = PetStoryVideoReadOnlyRecovery['action'] | 'open_verification';
interface SubmittedVideoRecoverySnapshot { taskId: string; runId: string; submittedAt: string | undefined; accountId: string | null }

function sameSubmittedVideoRecovery(task: Task | undefined, snapshot: SubmittedVideoRecoverySnapshot): task is Task {
  return !!task && task.id === snapshot.taskId && task.runtime?.runId === snapshot.runId && task.runtime.submittedAt === snapshot.submittedAt && task.assignedAccountId === snapshot.accountId;
}
function videoRecoveryAccountReady(account: Account): boolean {
  return account.health?.availability?.state === 'ready' && !account.health.verificationRequired && account.health.loginState !== 'expired';
}
function videoRecoveryObservationStarted(project: PetStoryProject, task: Task, taskState: ReturnType<typeof useTaskStore.getState>): boolean {
  return task.status === 'waiting_verification' || ['manual_submission_observing', 'executing', 'generating', 'done'].includes(task.status)
    || Object.values(taskState.executingTasks).includes(task.id) || taskState.activeTaskId === task.id || project.production?.state === 'running';
}

/** 先订阅再请求真实页面检测，既不沿用旧 ready，也不把点击本身当验证已经通过。 */
async function checkVideoRecoveryAccount(accountId: string): Promise<Account | undefined> {
  const requestedAt = Date.now();
  const previousCheckedAt = useAccountStore.getState().accounts.find((account: Account): boolean => account.id === accountId)?.health?.availability?.checkedAt;
  return new Promise((resolve: (account: Account | undefined) => void): void => {
    let unsubscribe: () => void = (): void => undefined;
    const timer = setTimeout((): void => finish(undefined), 20_000);
    const finish = (account: Account | undefined): void => { unsubscribe(); clearTimeout(timer); resolve(account); };
    const inspect = (): void => {
      const store = useAccountStore.getState();
      const account = store.accounts.find((item: Account): boolean => item.id === accountId);
      const availability = account?.health?.availability;
      if (availability && availability.checkedAt !== previousCheckedAt && Date.parse(availability.checkedAt) >= requestedAt && !store.availabilityChecking[accountId]) finish(account);
    };
    unsubscribe = useAccountStore.subscribe(inspect);
    useAccountStore.getState().requestAvailabilityCheck(accountId);
    inspect();
  });
}

/** 确认操作紧邻节点状态；原会话确认与原结果回读各自明确，不让用户到卡片底部寻找。 */
const CanvasVideoRecovery: React.FC<{ recovery: PetStoryVideoReadOnlyRecovery; busy: boolean; starting: boolean; onAction: (action: VideoRecoveryAction) => void; resubmissionAction?: React.ReactNode }> = ({ recovery, busy, starting, onAction, resubmissionAction }): React.ReactElement => {
  const confirmation = recovery.task.runtime?.generationConfirmation;
  const parameters = [confirmation?.model, confirmation?.duration, confirmation?.aspectRatio].filter(Boolean).join(' · ');
  const needsConfirmation = recovery.action === 'confirm_parameters';
  const needsVerification = recovery.action === 'verify_account';
  return <section className="canvas-video-recovery" aria-label={needsConfirmation ? '视频参数确认' : needsVerification ? '原账号验证恢复' : '原视频结果检查'}>
    {needsConfirmation && parameters && <strong className="canvas-video-parameters">{parameters}</strong>}
    <p role="status">{needsConfirmation ? '在豆包原会话回复“确认”。确认后回到这里，点击“我已确认，检查结果”。' : recovery.reason}</p>
    <div className="canvas-media-actions">
      {needsConfirmation && <Button type="primary" size="small" disabled={busy || starting} onClick={(): void => onAction('confirm_parameters')}>去豆包确认参数</Button>}
      {needsVerification && <Button size="small" disabled={busy || starting} onClick={(): void => onAction('open_verification')}>去豆包处理验证</Button>}
      <Button type={needsConfirmation ? 'default' : 'primary'} size="small" loading={starting} disabled={busy || starting} onClick={(): void => onAction(needsVerification ? 'verify_account' : 'check_result')}>{needsConfirmation ? '我已确认，检查结果' : recovery.label}</Button>
      {resubmissionAction}
    </div>
  </section>;
};

function mediaNodeFacts(project: PetStoryProject, shot: PetStoryShot, kind: PetStoryPromptKind, tasks: Task[]): CanvasMediaFacts {
  const asset = selectedPetStoryMedia(project, shot, kind);
  const step = [...(project.production?.steps || [])].reverse().find((item): boolean => item.shotId === shot.id && item.kind === kind);
  const pendingTask = tasks.find((item): boolean => item.id === step?.taskId);
  const waiting = !!step && step.status !== 'complete'; const video = kind === 'video';
  const buttonText = asset ? `重新生成${video ? '视频' : '图片'}` : video ? '生成视频' : '生成图片';
  return { asset, step, pendingTask, waiting, video, buttonText };
}

export const CanvasMediaNode: React.FC<{ project: PetStoryProject; shot: PetStoryShot; kind: PetStoryPromptKind; disabled: boolean }> = ({ project, shot, kind, disabled }): React.ReactElement => {
  const state = usePetStoryStore(); const taskState = useTaskStore(); const tasks = taskState.tasks;
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [starting, setStarting] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const readiness = usePetStoryGenerationEligibility(project, { shotId: shot.id, promptKind: kind });
  const { asset, step, pendingTask, waiting, video, buttonText } = mediaNodeFacts(project, shot, kind, tasks);
  const recoverableTask = video ? petStoryUnsubmittedVideoTask(project, shot.id, tasks, [...Object.values(taskState.executingTasks), ...(taskState.activeTaskId ? [taskState.activeTaskId] : [])]) : undefined;
  const readOnlyRecovery = video ? petStoryVideoReadOnlyRecovery(project, shot.id, tasks, [...Object.values(taskState.executingTasks), ...(taskState.activeTaskId ? [taskState.activeTaskId] : [])]) : undefined;
  const recoverySnapshot = readOnlyRecovery?.task.runtime ? { taskId: readOnlyRecovery.task.id, runId: readOnlyRecovery.task.runtime.runId, submittedAt: readOnlyRecovery.task.runtime.submittedAt, accountId: readOnlyRecovery.task.assignedAccountId } : undefined;
  // 正式只读核对仍然受理不明时，接回已有的单次风险确认出口；其他暂停只保留检查操作。
  const resubmissionTask = readOnlyRecovery?.action === 'check_result' && readOnlyRecovery.task.errorInfo?.code === 'submission_uncertain'
    ? petStoryResubmissionTask(project, tasks, [...Object.values(taskState.executingTasks), ...(taskState.activeTaskId ? [taskState.activeTaskId] : [])]) : undefined;
  const nodeResubmissionTask = recoverySnapshot && sameSubmittedVideoRecovery(resubmissionTask, recoverySnapshot) ? resubmissionTask : undefined;
  const hasCandidate = !video && pendingImageCandidates(project, { shotId: shot.id, kind: kind as 'firstFrame' | 'lastFrame' }, asset?.id).length > 0;
  const promptBlocker = !shot.prompts[kind]?.final.trim() ? readiness.eligibility?.blockers.find((item): boolean => item.code === 'prompt')?.message : undefined;
  const repairingPrompt = !!state.promptRepairJobIds?.some((id): boolean => project.jobs.some((job): boolean => job.id === id && job.shotId === shot.id && job.promptKind === kind));
  const promptPreparing = repairingPrompt || !!promptBlocker?.includes('正在后台准备并校验');
  const promptNotice = repairingPrompt ? '视频提示词正在后台修订并校验，通过后请确认使用。' : promptBlocker;
  useEffect((): void => { setGenerationError(''); }, [project.id, shot.id, kind]);
  useEffect((): void => {
    // 后台修订、候选返回或明确采用后，只淘汰旧的本地正文准备错误，保留实际平台失败。
    if (promptNotice || shot.prompts[kind]?.final.trim()) setGenerationError((message): string => isPetStoryPromptPreparationMessage(message) ? '' : message);
  }, [promptNotice, shot.prompts, kind]);
  const generateVideo = async (): Promise<void> => {
    if (disabled || waiting || settingsDirty || starting) return;
    setGenerationError(''); setStarting(true);
    try {
      // 只读预检可能因版本刷新失败或正文／素材待核对而未就绪；点击后由正式服务核验，直接呈现真实原因。
      await state.generateShotMedia(shot.id, kind);
      setGenerationError(usePetStoryStore.getState().error);
    } catch (error: unknown) { setGenerationError(error instanceof Error ? error.message : '视频任务未启动，请重试。'); }
    finally { setStarting(false); }
  };
  const continueVideo = async (): Promise<void> => {
    if (!recoverableTask?.runtime || state.busy || settingsDirty || starting) return;
    setGenerationError(''); setStarting(true);
    try {
      // 原制作会锁住新建入口；提交前恢复单独交给正式服务核验并沿用原 taskId。
      await state.resumeUnsubmittedVideo(shot.id, recoverableTask.id, recoverableTask.runtime.runId);
      setGenerationError(usePetStoryStore.getState().error);
    } catch (error: unknown) { setGenerationError(error instanceof Error ? error.message : '原视频任务尚未恢复，请查看当前任务。'); }
    finally { setStarting(false); }
  };
  const recoverSubmittedVideo = async (action: VideoRecoveryAction): Promise<void> => {
    if (!readOnlyRecovery || !recoverySnapshot || state.busy || starting) return;
    const current = usePetStoryStore.getState().project; const currentTasks = useTaskStore.getState();
    const recovery = current?.id === project.id ? petStoryVideoReadOnlyRecovery(current, shot.id, currentTasks.tasks, [...Object.values(currentTasks.executingTasks), ...(currentTasks.activeTaskId ? [currentTasks.activeTaskId] : [])]) : undefined;
    if (!recovery || !sameSubmittedVideoRecovery(recovery.task, recoverySnapshot) || recovery.action !== readOnlyRecovery.action) { setGenerationError('原视频任务状态已变化，请重新查看当前任务。'); return; }
    const accountId = recovery.task.assignedAccountId;
    const account = useAccountStore.getState().accounts.find((item: Account): boolean => item.id === accountId);
    if (!accountId || !account || account.platform === 'dola') { setGenerationError('原执行账号已不存在或不支持此恢复，请重新核对任务。'); return; }
    setGenerationError('');
    if (action === 'confirm_parameters') { openPetStoryOriginalTask(recovery.task); return; }
    if (action === 'open_verification') {
      if (!canSelectAccount(accountId, findInteractiveAccountId(currentTasks.accountAutomationState))) { setGenerationError('其他账号正在提交，请待提交结束后再处理原账号验证。'); return; }
      useAccountStore.getState().selectAccount(accountId); revealBrowser(); return;
    }
    setStarting(true);
    try {
      if (readOnlyRecovery.action !== 'confirm_parameters') {
        const checked = await checkVideoRecoveryAccount(accountId);
        if (!checked) { setGenerationError('原账号状态检测尚未完成，请在原账号处理后再继续；原请求未重复发送。'); return; }
        if (!videoRecoveryAccountReady(checked)) {
          setGenerationError(checked.health?.availability?.message || '原账号仍需要登录或验证，请处理后再继续。'); return;
        }
        const latest = usePetStoryStore.getState().project; const taskState = useTaskStore.getState();
        const latestTask = taskState.tasks.find((item: Task): boolean => item.id === recoverySnapshot.taskId);
        if (latest?.id !== project.id || !sameSubmittedVideoRecovery(latestTask, recoverySnapshot)) { setGenerationError('原视频任务状态已变化，请重新查看当前任务。'); return; }
        // fresh ready 会从账号检测链恢复原任务；观察已经启动时只展示进度，不再发起第二次恢复。
        if (videoRecoveryObservationStarted(latest, latestTask, taskState)) return;
      }
      await state.resumeProduction(); setGenerationError(usePetStoryStore.getState().error);
    }
    catch (error: unknown) { setGenerationError(error instanceof Error ? error.message : '原视频结果尚未读取，请稍后检查。'); }
    finally { setStarting(false); }
  };
  const playVideo = async (): Promise<void> => {
    setGenerationError('');
    const player = document.getElementById(`shot-media-${shot.id}-${kind}`)?.querySelector('video');
    if (!player) { setGenerationError('视频正在读取，请稍后再点击播放。'); return; }
    player.focus();
    try { await player.play(); }
    catch (error: unknown) { setGenerationError(videoPlayError(error)); }
  };

  return <div id={`shot-media-${shot.id}-${kind}`} tabIndex={-1} className="canvas-media-node" data-media-kind={kind}><div className="canvas-field-label"><strong>{mediaNames[kind]}</strong><span className={`canvas-state ${asset?.validation ? 'ready' : ''}`}>{readOnlyRecovery?.status || (recoverableTask ? '生成前准备未完成' : !asset && promptPreparing ? '提示词后台准备中' : !asset && promptNotice?.includes('已有待采用候选') ? '提示词待确认' : mediaStatus(asset, waiting, pendingTask, hasCandidate))}</span></div>
    {readOnlyRecovery && <CanvasVideoRecovery recovery={readOnlyRecovery} busy={state.busy} starting={starting} onAction={(action: VideoRecoveryAction): void => { void recoverSubmittedVideo(action); }}
      resubmissionAction={nodeResubmissionTask && <PetStoryResubmissionActions projectId={project.id} task={nodeResubmissionTask} disabled={starting} />} />}
    {video && pendingTask?.status === 'manual_submission_observing' && <p className="canvas-hint" role="status">{pendingTask.runtime?.message || '正在同步原会话并检查视频结果，请稍候。'}</p>}
    {video && <details className="petstory-secondary-tools"><summary>本镜制作设置</summary><CanvasVideoSettings project={project} shot={shot} onDirtyChange={setSettingsDirty} /></details>}
    {!video ? <PetStoryImageReview project={project} target={{ shotId: shot.id, kind: kind as 'firstFrame' | 'lastFrame' }} title={`镜头 ${shot.order} · ${kind === 'firstFrame' ? '首帧' : '尾帧'}`} currentAssetId={asset?.id}
      disabled={disabled} generationDisabled={waiting || !readiness.eligibility?.ready} generating={readiness.loading}
      onUpload={async (): Promise<void> => state.uploadShotImage(shot.id, kind as 'firstFrame' | 'lastFrame')}
      onGenerate={async (): Promise<void> => state.generateShotMedia(shot.id, kind)}
      onAdopt={async (assetId: string): Promise<void> => state.adoptShotImage(shot.id, kind as 'firstFrame' | 'lastFrame', assetId)}
      onAdjust={async (): Promise<void> => state.openChatAdjustment({ shotId: shot.id, promptKind: kind })} />
      : asset ? <ExistingMedia project={project} shot={shot} asset={asset} kind={kind} /> : !readOnlyRecovery && <div className="canvas-empty-media"><PlayCircleOutlined /><strong>{recoverableTask ? '生成前准备未完成，尚未发送' : waiting ? '等待原任务产物' : '尚无镜头视频'}</strong></div>}
    {waiting && asset && <p className="canvas-hint">{recoverableTask ? '新请求尚未发送；仍保留原有成果。' : `新请求：${canvasJobLabel(pendingTask?.status)}；下方仍展示原有成果。`}</p>}
    {video && <CanvasVideoResolution project={project} shot={shot} eligibility={readiness.eligibility} />}
    {video && !asset && !recoverableTask && !readOnlyRecovery && promptNotice && <p className={promptPreparing || isPetStoryPromptPreparationMessage(promptNotice) ? 'canvas-hint' : 'canvas-error'} role={promptPreparing || isPetStoryPromptPreparationMessage(promptNotice) ? 'status' : 'alert'}>{promptNotice}</p>}
    {settingsDirty && <Alert type="warning" message="本镜视频设置有未保存修改，请先保存或放弃后再生成。" />}
    {video && !readOnlyRecovery && <div className="canvas-media-actions">{recoverableTask ? <Button type="primary" size="small" loading={starting} icon={<PlayCircleOutlined />} disabled={state.busy || settingsDirty || starting} onClick={(): void => { void continueVideo(); }}>继续生成视频</Button> : !asset && <Button type="primary" size="small" loading={starting} icon={<PlayCircleOutlined />} disabled={disabled || waiting || settingsDirty || starting} onClick={(): void => { void generateVideo(); }}>{buttonText}</Button>}{asset && <Button size="small" onClick={(): void => { void playVideo(); }}>查看视频</Button>}</div>}
    {recoverableTask && <p className="canvas-hint">生成前准备已停止，点击后沿用原任务继续，不会重新生成首尾帧。</p>}
    {video && generationError && <p className="canvas-error" role="alert">{petStoryVideoRecoveryMessage(generationError)}</p>}
    {step?.error && <p className="canvas-error">{petStoryVideoRecoveryMessage(step.error)}</p>}
  </div>;
};

function referenceName(project: PetStoryProject, asset: PetStoryAsset): string {
  if (asset.kind === 'scene') return '场景'; if (asset.kind === 'prop') return '道具';
  return (asset.characterIds || [asset.characterId]).map((id): string => project.plan?.characters.find((character): boolean => character.id === id)?.name || '').join('、');
}
function referenceApproved(project: PetStoryProject, asset: PetStoryAsset): boolean {
  return !!project.materials?.some((material): boolean => material.selectedAssetId === asset.id && journeyMaterialImageApproved(project, material));
}
export const CanvasReferenceStrip: React.FC<{ project: PetStoryProject; shot: PetStoryShot }> = ({ project, shot }): React.ReactElement | null => {
  const materialIds = new Set(project.materials?.filter((material): boolean => {
    if (material.kind === 'character') return shot.characterIds.includes(material.entityId);
    if (material.kind === 'prop') return !!shot.propIds?.includes(material.entityId);
    return shot.sceneId === material.entityId;
  }).map((material): string => material.selectedAssetId || ''));
  const references = project.assets.filter((asset): boolean => referenceApproved(project, asset) && (materialIds.has(asset.id) || !!shot.sceneReferenceAssetIds?.includes(asset.id)
    || (asset.kind === 'character' && shot.characterIds.some((id): boolean => project.plan?.characters.find((character): boolean => character.id === id)?.referenceAssetId === asset.id)))).sort((a, b): number => { const order = (asset: PetStoryAsset): number => { if (asset.kind !== 'character') return shot.characterIds.length + (asset.kind === 'prop' ? 1 : 2); return Math.min(...(asset.characterIds || [asset.characterId]).filter((id): id is string => !!id).map((id): number => { const index = shot.characterIds.indexOf(id); return index < 0 ? 999 : index; })); }; return order(a) - order(b); });
  if (!references.length) return null;
  return <div className="canvas-reference-strip"><strong>本镜素材</strong>{references.map((asset): React.ReactNode => <div key={asset.id}><CanvasMediaPreview project={project} asset={asset} name="选用的参考图片" /><span>{referenceName(project, asset)} · 已确认</span></div>)}</div>;
};

/** 解析后的计划模式不冒充当前网页实际已受理的模式。 */
export function canvasActualMode(project: PetStoryProject, shot: PetStoryShot, tasks: Task[]): string {
  const productions = [...(project.productionHistory || []), ...(project.production ? [project.production] : [])].reverse();
  const videoAsset = selectedPetStoryMedia(project, shot, 'video');
  const selectedProduction = productions.find((item): boolean => !!videoAsset?.taskId && item.steps.some((step): boolean => step.taskId === videoAsset.taskId && step.runId === videoAsset.runId));
  const production = selectedProduction || productions.find((item): boolean => item.steps.some((step): boolean => step.shotId === shot.id && step.kind === 'video'));
  const step = production?.steps.find((item): boolean => item.shotId === shot.id && item.kind === 'video');
  if (!step || !production) return '尚未执行';
  const task = tasks.find((item): boolean => item.id === step.taskId); const runtime = task?.runtime;
  const mode = step.compiledPrompt?.resolvedMode || production.shots[shot.id]?.resolvedMode;
  if (!mode) return '尚未执行';
  const accepted = runtime?.runId === step.runId && runtime?.acceptanceObservation?.runId === step.runId;
  if (!accepted) return `计划 ${petStoryModeNames[mode]} · 待实际受理`;
  return step.pageBindings?.length ? petStoryModeNames[mode] : `${petStoryModeNames[mode]} · 历史记录，页面绑定未留存`;
}
