import React, { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Image, Input, Modal, Space, Tag } from 'antd';
import { PictureOutlined, StopOutlined, UploadOutlined } from '@ant-design/icons';
import type { PetStoryAsset, PetStoryImageTarget, PetStoryProject } from '@doubao-studio/contracts';
import { petStoryResubmissionTask, usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { imageConversationTask, imageTargetKey, isPetStoryImageFlowBusy, petStoryImageProgress } from '../utils/petstoryImageFlow';
import { imageBelongsToTarget, pendingImageCandidates } from '../utils/petstoryImageCandidates';
import { resolveTaskConversationTarget } from '../utils/taskConversationLocator';
import { PetStoryResubmissionActions } from './PetStoryTaskRecovery';

export { imageBelongsToTarget } from '../utils/petstoryImageCandidates';
interface ReviewImageProps { projectId: string; asset: PetStoryAsset; name: string; onReadable?: (value: boolean) => void }
const ReviewImage: React.FC<ReviewImageProps> = ({ projectId, asset, name, onReadable }): React.ReactElement => {
  const [source, setSource] = useState(''); const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setSource(''); setError(''); onReadable?.(false);
    void window.electronAPI.petstory.readReference(projectId, asset.id).then((result): void => {
      if (!active) return;
      setSource(result.data || ''); setError(result.error || (!result.data ? '图片文件无法读取' : ''));
      onReadable?.(result.success && !!result.data);
    }).catch((): void => { if (active) { setError('图片读取失败，请检查原文件'); onReadable?.(false); } });
    return (): void => { active = false; };
  }, [projectId, asset.id, onReadable]);
  return source ? <Image src={source} alt={name} preview={false} /> : <div className="petstory-image-empty"><PictureOutlined /><span>{error || '正在读取图片…'}</span></div>;
};
interface PetStoryImageReviewProps {
  project: PetStoryProject; target: PetStoryImageTarget; title: string; currentAssetId?: string; currentNeedsReview?: boolean; previewAssetId?: string;
  disabled: boolean; generationDisabled?: boolean; generating?: boolean; identity?: string;
  externalError?: string; onRetry?: () => Promise<void>;
  onUpload: () => Promise<void>; onGenerate?: () => Promise<void>; onAdopt: (assetId: string) => Promise<void>;
  onModify?: (assetId: string, feedback: string) => Promise<void>;
  // 保持共享调用契约兼容；旧自由文字调整不再作为图片修改入口。
  onAdjust?: () => Promise<void>; onBatchSelection?: (assetId: string, checked: boolean) => void; batchSelectedId?: string;
}
function adoptionNote(reviewingCurrent: boolean, replacing: boolean, needsReview: boolean): string {
  if (reviewingCurrent && needsReview) return '请核对变化后的参考内容；确认继续使用后，才可作为后续制作依据。';
  if (reviewingCurrent) return '当前采用图片；查看不会改变素材。';
  return replacing ? '采用后替换当前图片；旧图和已有成果保留，后续制作使用新采用的图片。' : '确认采用后，图片才会进入正式节点。';
}
type ImageProgress = ReturnType<typeof petStoryImageProgress>;
function imageError(local: string, external: string | undefined, operation: string): string { return local || external || operation || ''; }
const StopImageButton: React.FC<{ stop: () => Promise<void>; stopping: boolean }> = ({ stop, stopping }): React.ReactElement => <Button size="small" danger icon={<StopOutlined />} loading={stopping} disabled={stopping} title="停止本工具的处理与等待，保留豆包对话和已有图片" onClick={(): void => { void stop(); }}>停止</Button>;
const ImageOperationStatus: React.FC<{ progress: ImageProgress; error: string; disabled: boolean; preparing?: boolean; retry?: () => Promise<void>; stop?: () => Promise<void>; stopping: boolean }> = ({ progress, error, disabled, preparing, retry, stop, stopping }): React.ReactElement | null => {
  const stopAction = stop && <StopImageButton stop={stop} stopping={stopping} />;
  if (error) return <div className="petstory-image-feedback-error" role="alert"><span>{error}</span>{retry && <Button size="small" disabled={disabled} onClick={(): void => { void retry(); }}>{progress.operation ? progress.task?.outputs.length ? '重新下载图片' : '继续本次任务' : '重试剩余原图'}</Button>}{stopAction}</div>;
  if (progress.resumable && !preparing) return <div className="petstory-image-progress" role="status"><span>{progress.message}</span>{retry && <Button size="small" disabled={disabled} onClick={(): void => { void retry(); }}>继续本次任务</Button>}{stopAction}</div>;
  if (!progress.operation && !preparing && !stop) return null;
  const complete = !!progress.candidateAssetId && !progress.busy && !preparing;
  const message = stopping ? '正在停止图片任务…' : preparing ? '正在准备图片…' : progress.message;
  return <div className="petstory-image-progress" role="status"><div className={`petstory-image-progress-track ${complete ? 'is-complete' : 'is-pending'}`} role="progressbar" aria-label="图片任务进度" aria-valuetext={message} aria-valuenow={complete ? 100 : undefined} aria-valuemin={0} aria-valuemax={100}><span /></div><span>{message}</span>{stopAction}</div>;
};
interface ImageActionsProps {
  current?: PetStoryAsset; currentNeedsReview: boolean; candidateCount: number; disabled: boolean; busy: boolean;
  generationDisabled?: boolean; show: (assetId?: string) => void; upload: () => Promise<void>; generate?: () => Promise<void>; openConversation?: () => void; conversationLabel?: string;
}
const ImageActions: React.FC<ImageActionsProps> = ({ current, currentNeedsReview, candidateCount, disabled, busy, generationDisabled, show, upload, generate, openConversation, conversationLabel }): React.ReactElement => <>
  {candidateCount > 0 && <div className="petstory-candidate-banner"><span>图片待确认{candidateCount > 1 ? ` · ${candidateCount} 张` : ''}</span></div>}
  <div className="canvas-media-actions">
    {current || candidateCount ? <Button aria-label={currentNeedsReview && !candidateCount ? '查看并复核' : '查看图片'} type="primary" size="small" onClick={(): void => show()}>{currentNeedsReview && !candidateCount ? '查看并复核' : '查看图片'}</Button>
      : generate && <Button aria-label="生成图片" size="small" type="primary" loading={busy} disabled={disabled || generationDisabled || busy} onClick={(): void => { void generate(); }}>生成图片</Button>}
    <Button size="small" aria-label={current || candidateCount ? '上传替代图片' : '上传图片'} icon={<UploadOutlined />} disabled={disabled || busy} onClick={(): void => { void upload(); }}>{current || candidateCount ? '上传替代图片' : '上传图片'}</Button>
  </div>
  {openConversation && <Button className="petstory-image-conversation" type="link" size="small" onClick={openConversation}>{conversationLabel || '查看豆包对话'}</Button>}
</>;

interface ImagePreviewBodyProps {
  project: PetStoryProject; title: string; images: PetStoryAsset[]; candidates: PetStoryAsset[]; current?: PetStoryAsset; selected?: PetStoryAsset;
  reviewingCurrent: boolean; confirmingCurrent: boolean; identity?: string; locked: boolean; readable: boolean; batchSelectedId?: string;
  onBatchSelection?: (assetId: string, checked: boolean) => void; hasConversation: boolean;
  onReadable: (value: boolean) => void; select: (assetId: string) => void; upload: () => Promise<void>; openConversation: () => void;
}
const ImagePreviewBody: React.FC<ImagePreviewBodyProps> = ({ project, title, images, candidates, current, selected, reviewingCurrent, confirmingCurrent, identity, locked, readable, batchSelectedId, onBatchSelection, hasConversation, onReadable, select, upload, openConversation }): React.ReactElement => <div className="petstory-image-preview-layout"><div>
  {selected ? <div className="petstory-large-image"><ReviewImage projectId={project.id} asset={selected} name={`${title} · ${reviewingCurrent ? '当前采用' : candidates.some((asset): boolean => asset.id === selected.id) ? '待确认图片' : selected.imageReview?.state === 'adopted' ? '历史采用' : '历史备选'}`} onReadable={onReadable} /></div> : <p>当前没有可预览的图片。</p>}
  <div className="petstory-image-options">{images.map((asset): React.ReactNode => {
    const candidateIndex = candidates.findIndex((item): boolean => item.id === asset.id);
    const caption = asset.id === current?.id ? '当前采用' : candidateIndex >= 0 ? `候选 ${candidateIndex + 1}` : asset.imageReview?.state === 'adopted' ? '历史采用' : '历史备选';
    return <button type="button" key={asset.id} className={selected?.id === asset.id ? 'selected' : ''} aria-label={candidateIndex >= 0 ? `选择候选图片 ${candidateIndex + 1}` : `查看历史图片 ${images.indexOf(asset) + 1}`} onClick={(): void => select(asset.id)}><ReviewImage projectId={project.id} asset={asset} name={`${title} · ${caption}`} /><span>{caption}</span></button>;
  })}</div>
</div><aside><h3>图片用途</h3><p>{title}</p><Tag>{confirmingCurrent ? '需要复核' : reviewingCurrent ? '已采用' : candidates.some((asset): boolean => asset.id === selected?.id) ? '待确认' : selected?.imageReview?.state === 'adopted' ? '历史采用' : '历史备选'}</Tag>
  {selected && <p className="petstory-image-source">{selected.taskId ? '豆包图片' : '本地上传'}</p>}
  {identity && <p>人物外观：{identity}</p>}
  {current && !reviewingCurrent && <div className="petstory-current-comparison"><strong>当前采用图片</strong><ReviewImage projectId={project.id} asset={current} name={`${title} · 替换前`} /><p>新图片采用前，当前图片保持不变。</p></div>}
  {selected && !reviewingCurrent && onBatchSelection && <Checkbox disabled={locked || !readable} checked={batchSelectedId === selected.id} onChange={(event): void => onBatchSelection(selected.id, event.target.checked)}>已检查这张，选入批量采用</Checkbox>}
  <Space direction="vertical" className="mt-4"><Button type="link" disabled={locked} onClick={(): void => { void upload(); }}>上传替代图片</Button>{hasConversation && <Button type="link" onClick={openConversation}>查看豆包对话</Button>}</Space>
</aside></div>;
interface PreviewActionsProps {
  reviewingCurrent: boolean; confirmingCurrent: boolean; hasCurrent: boolean; hasSelected: boolean; locked: boolean; readable: boolean; saving: boolean;
  generationDisabled: boolean; modificationDisabled: boolean; generating: boolean; regenerate?: () => Promise<void>;
  close: () => void; modify: () => void; adopt: () => Promise<void>;
}
const PreviewActions: React.FC<PreviewActionsProps> = ({ reviewingCurrent, confirmingCurrent, hasCurrent, hasSelected, locked, readable, saving, generationDisabled, modificationDisabled, generating, regenerate, close, modify, adopt }): React.ReactElement => <>
  <span className="petstory-adoption-note">{adoptionNote(reviewingCurrent, hasCurrent, confirmingCurrent)}</span>
  <Button onClick={close}>{reviewingCurrent ? '返回' : '暂不采用'}</Button>
  {regenerate && <Button title="重新上传参考图和当前生图提示词，生成一组新图片" disabled={locked || generationDisabled} loading={generating} onClick={(): void => { void regenerate(); }}>重新生成</Button>}
  {hasSelected && <Button disabled={locked || modificationDisabled || !readable} onClick={modify}>不满意，修改图片</Button>}
  {(!reviewingCurrent || confirmingCurrent) && <Button type="primary" disabled={locked || !hasSelected || !readable} loading={saving} onClick={(): void => { void adopt(); }}>{confirmingCurrent ? '确认继续使用' : '满意，采用图片'}</Button>}
</>;
interface ImageFeedbackDialogProps {
  projectId: string; title: string; base: PetStoryAsset; feedback: string; error: string; submitting: boolean; disabled: boolean;
  cancel: () => void; submit: () => Promise<void>; change: (feedback: string) => void; stop?: () => Promise<void>; stopping: boolean;
}
const ImageFeedbackDialog: React.FC<ImageFeedbackDialogProps> = ({ projectId, title, base, feedback, error, submitting, disabled, cancel, submit, change, stop, stopping }): React.ReactElement => <Modal className="petstory-image-feedback-modal" title="修改这张图片" open closable={false} width={640} onCancel={(): void => { if (!submitting) cancel(); }} footer={<>{stop && <StopImageButton stop={stop} stopping={stopping} />}<Button aria-label="取消" disabled={submitting} onClick={cancel}>取消</Button><Button type="primary" loading={submitting} disabled={disabled || !feedback.trim() || submitting} onClick={(): void => { void submit(); }}>提交修改</Button></>}>
  <div className="petstory-feedback-image"><ReviewImage projectId={projectId} asset={base} name={`${title} · 本次修改基图`} /></div><p>{title}</p>
  <label className="petstory-feedback-label" htmlFor={`image-feedback-${base.id}`}>告诉 AI 你希望怎么修改。</label>
  <Input.TextArea id={`image-feedback-${base.id}`} aria-label="图片修改意见" value={feedback} disabled={submitting} autoSize={{ minRows: 4, maxRows: 8 }} placeholder="例如：表情更自然一些，衣服和背景保持不变。" onChange={(event): void => change(event.target.value)} />
  {error && <p className="petstory-image-feedback-error" role="alert">{error}</p>}
</Modal>;
function currentReviewState(target: PetStoryImageTarget, current: PetStoryAsset | undefined, selected: PetStoryAsset | undefined, currentNeedsReview?: boolean): { reviewingCurrent: boolean; needsReview: boolean; confirmingCurrent: boolean } {
  const reviewingCurrent = !!selected && selected.id === current?.id;
  // 已明确采用的首尾帧持续用于后续制作；旧复核标记只在基础素材确认流程中生效。
  const needsReview = !!target.materialId && !!(currentNeedsReview || current?.needsReview);
  return { reviewingCurrent, needsReview, confirmingCurrent: reviewingCurrent && needsReview };
}

/** 修改弹窗绑定用户选中的具体图片；提交只创建候选，不改变正式采用关系。 */
export const PetStoryImageReview: React.FC<PetStoryImageReviewProps> = ({ project, target, title, currentAssetId, currentNeedsReview, previewAssetId, disabled, generationDisabled, generating, identity, externalError, onRetry, onUpload, onGenerate, onAdopt, onModify, onBatchSelection, batchSelectedId }): React.ReactElement => {
  const [open, setOpen] = useState(false); const [selectedId, setSelectedId] = useState<string>();
  const [readable, setReadable] = useState(false); const [error, setError] = useState(''); const [recoveryFailed, setRecoveryFailed] = useState(false);
  const [feedbackBaseId, setFeedbackBaseId] = useState<string>(); const [feedback, setFeedback] = useState('');
  const [feedbackError, setFeedbackError] = useState(''); const [submitting, setSubmitting] = useState(false); const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false); const [stopError, setStopError] = useState(''); const actionVersion = useRef({ value: 0 }).current;
  const root = useRef<HTMLDivElement>(null); const previewBody = useRef<HTMLDivElement>(null); const awaitingResult = useRef<Set<string> | null>(null);
  const state = usePetStoryStore(); const taskState = useTaskStore(); const tasks = taskState.tasks;
  const progress = petStoryImageProgress(project, target, tasks, state.activeImageOperationIds.length ? state.activeImageOperationIds : state.activeImageOperationId);
  const targetKey = imageTargetKey(target);
  const images = project.assets.filter((asset): boolean => imageBelongsToTarget(project, asset, target));
  const current = images.find((asset): boolean => asset.id === currentAssetId);
  const candidates = pendingImageCandidates(project, target, currentAssetId);
  const selected = images.find((asset): boolean => asset.id === selectedId);
  const feedbackBase = images.find((asset): boolean => asset.id === feedbackBaseId);
  const { reviewingCurrent, needsReview, confirmingCurrent } = currentReviewState(target, current, selected, currentNeedsReview);
  const processing = progress.busy || state.pendingImageTargets.includes(targetKey) || starting || submitting || stopping;
  const busy = processing || !!generating;
  const canStop = processing || !!stopError || !!progress.task && ['executing', 'generating', 'manual_submission_observing'].includes(progress.task.status);
  // 所有图片入口共用流程占用状态；预览、上传和采用继续按各自已有条件处理。
  const flowBusy = isPetStoryImageFlowBusy(project, tasks, state.activeImageOperationIds, state.pendingImageTargets);
  const recoveryBlocked = isPetStoryImageFlowBusy(project, tasks, state.activeImageOperationIds, state.pendingImageTargets, progress.operation?.id);
  const generationBlocked = !!generationDisabled || flowBusy || progress.resumable || progress.conversationMissing;
  const task = imageConversationTask(project, target, tasks);
  const selectedTask = selected ? imageConversationTask(project, target, tasks, selected.id) : undefined;
  const resubmissionTask = petStoryResubmissionTask(project, tasks, [...Object.values(taskState.executingTasks), ...(taskState.activeTaskId ? [taskState.activeTaskId] : [])], progress.task?.id);
  const currentResubmission = resubmissionTask?.id === progress.task?.id ? resubmissionTask : undefined;
  const visibleError = imageError(stopError || error, externalError || state.imageTargetErrors[targetKey], progress.error);
  // 新上传／其他运行的具体图片不继承旧生成任务错误；卡片仍保留原任务的继续入口。
  const previewOperationVisible = canStop || busy || !selected || !progress.operation || !!selected.taskId
    && selected.taskId === (progress.operation.taskId || progress.task?.id) && (!selected.runId || selected.runId === progress.task?.runtime?.runId);
  const previewError = imageError(stopError || error, externalError || state.imageTargetErrors[targetKey], previewOperationVisible ? progress.error : '');
  // 组件复用于其他项目／目标或卸载后，原异步动作不得写回当前预览。
  useEffect((): (() => void) => {
    actionVersion.value++; awaitingResult.current = null;
    setStarting(false); setSubmitting(false); setStopping(false); setStopError(''); setError(''); setFeedbackError(''); setFeedbackBaseId(undefined); setOpen(false);
    return (): void => { actionVersion.value++; awaitingResult.current = null; };
  }, [project.id, targetKey, actionVersion]);
  const isCurrentAction = (version: number): boolean => version === actionVersion.value && usePetStoryStore.getState().project?.id === project.id;
  const show = (assetId?: string): void => {
    const nextId = assetId || candidates.at(-1)?.id || current?.id || images.at(-1)?.id;
    if (nextId !== selectedId) setReadable(false);
    setSelectedId(nextId); setError(''); setRecoveryFailed(false); setOpen(true);
  };
  // 隐藏页面和其他弹窗均不被后台完成通知抢占；只消费本组件内明确启动的操作。
  useEffect((): void => {
    const previous = awaitingResult.current;
    if (!previous) return;
    const produced = images.find((asset): boolean => !previous.has(asset.id) && asset.validation?.decoded === true);
    if (!produced || feedbackBase && submitting) return;
    awaitingResult.current = null;
    const ownDialog = previewBody.current?.closest('[role="dialog"]');
    const otherDialog = [...document.querySelectorAll('[role="dialog"]')].some((dialog): boolean => dialog !== ownDialog);
    if (!root.current || root.current.closest('[hidden], .page-hidden') || document.hidden || otherDialog) return;
    setSelectedId(produced.id); setReadable(false); setError(''); setOpen(true);
  }, [images, feedbackBase, submitting]);
  useEffect((): void => { if (previewAssetId) { setSelectedId(previewAssetId); setReadable(false); setOpen(true); } }, [previewAssetId]);
  const generate = async (): Promise<void> => {
    if (!onGenerate || busy || disabled || generationBlocked) return;
    const version = ++actionVersion.value;
    setError(''); setStopError(''); setRecoveryFailed(false); setStarting(true); awaitingResult.current = new Set(images.map((asset): string => asset.id));
    try { await onGenerate(); if (!isCurrentAction(version)) return; const ownError = usePetStoryStore.getState().imageTargetErrors[targetKey]; if (ownError) { awaitingResult.current = null; setError(ownError); } }
    catch (failure: unknown) { if (isCurrentAction(version)) { awaitingResult.current = null; setError(failure instanceof Error ? failure.message : '图片任务未启动，请重试'); } }
    finally { if (isCurrentAction(version)) setStarting(false); }
  };
  /** 停止不受生成期间的输入禁用影响；迟到的启动／修改回调不能覆盖停止后的界面。 */
  const stop = async (): Promise<void> => {
    if (stopping || usePetStoryStore.getState().project?.id !== project.id) return;
    const version = ++actionVersion.value; awaitingResult.current = null;
    setStopping(true); setStarting(false); setSubmitting(false); setError(''); setFeedbackError(''); setStopError('');
    try { await usePetStoryStore.getState().stopImageOperation(target); if (isCurrentAction(version)) { setFeedbackBaseId(undefined); setOpen(false); } }
    catch (failure: unknown) { if (isCurrentAction(version)) setStopError(failure instanceof Error ? failure.message : '停止尚未确认，请再次停止本次任务'); }
    finally { if (isCurrentAction(version)) setStopping(false); }
  };
  const upload = async (): Promise<void> => {
    if (disabled || busy) return;
    setError(''); setRecoveryFailed(false); const previousIds = new Set(images.map((asset): string => asset.id));
    try { await onUpload(); } catch (failure: unknown) { setError(failure instanceof Error ? failure.message : '图片上传未完成，请重试'); return; }
    const latest = usePetStoryStore.getState();
    if (latest.error) { setError(latest.error); return; }
    const latestProject = latest.project;
    if (!latestProject || latestProject.id !== project.id) return;
    const uploaded = [...latestProject.assets].reverse().find((asset): boolean => !previousIds.has(asset.id) && imageBelongsToTarget(latestProject, asset, target));
    if (uploaded) show(uploaded.id);
  };
  const adopt = async (): Promise<void> => {
    if (!selected || !readable || disabled || busy || reviewingCurrent && !needsReview) return;
    setError(''); setRecoveryFailed(false);
    try { await onAdopt(selected.id); } catch (failure: unknown) { setError(failure instanceof Error ? failure.message : '图片尚未采用，请重试'); return; }
    const latest = usePetStoryStore.getState(); if (latest.error) setError(latest.error); else setOpen(false);
  };
  const beginFeedback = (): void => {
    if (!selected || !readable || disabled || busy || flowBusy) return;
    setFeedbackBaseId(selected.id); setFeedback(''); setFeedbackError(''); setOpen(false);
  };
  const submitFeedback = async (): Promise<void> => {
    if (!feedbackBase || !feedback.trim() || submitting || disabled || progress.busy || flowBusy) return;
    const version = ++actionVersion.value;
    setSubmitting(true); setFeedbackError(''); setStopError('');
    awaitingResult.current = new Set(images.map((asset): string => asset.id));
    try {
      if (onModify) await onModify(feedbackBase.id, feedback);
      else await state.modifyImage(target, feedbackBase.id, feedback);
      if (!isCurrentAction(version)) return;
      const latest = usePetStoryStore.getState();
      const ownError = latest.imageTargetErrors[targetKey];
      if (ownError) { setFeedbackError(ownError); return; }
      setFeedbackBaseId(undefined); setOpen(false);
    } catch (failure: unknown) { if (isCurrentAction(version)) setFeedbackError(failure instanceof Error ? failure.message : '修改任务未启动，请重试'); }
    finally { if (isCurrentAction(version)) setSubmitting(false); }
  };
  const openConversation = (assetId?: string): void => { void state.openImageConversation(target, assetId); };
  const operationId = progress.operation?.id;
  const operationIssueVisible = !externalError && (recoveryFailed || !error || error === progress.error) && (progress.resumable || !!progress.error);
  const recover = async (): Promise<void> => {
    if (!operationId || recoveryBlocked) return;
    const version = ++actionVersion.value;
    setError(''); setStopError(''); setRecoveryFailed(false);
    try { await state.recoverImageOperation(operationId); if (!isCurrentAction(version)) return; const ownError = usePetStoryStore.getState().imageTargetErrors[targetKey]; if (ownError) { setError(ownError); setRecoveryFailed(true); } }
    catch (failure: unknown) { if (isCurrentAction(version)) { setError(failure instanceof Error ? failure.message : '原图片任务未能继续，请重试'); setRecoveryFailed(true); } }
  };
  const retry = operationId && operationIssueVisible ? recover : externalError ? onRetry : undefined;
  return <div ref={root} className="petstory-image-review" data-image-target={title}>
    {current ? <button type="button" className="petstory-current-image" onClick={(): void => show(current.id)} aria-label={`查看${title}已采用图片`}><ReviewImage projectId={project.id} asset={current} name={`${title} · 当前采用`} /></button>
      : <div className="petstory-image-empty"><PictureOutlined /><span>尚未采用图片</span></div>}
    {current && needsReview && <p className="canvas-error">参考内容已更新，请复核这张图片。</p>}
    <ImageActions current={current} currentNeedsReview={needsReview} candidateCount={candidates.length} disabled={disabled} busy={busy} generationDisabled={generationBlocked} show={show} upload={upload} generate={onGenerate ? generate : undefined} openConversation={task ? (): void => openConversation() : undefined} conversationLabel={task && !resolveTaskConversationTarget(task).ok ? '打开原账号豆包' : undefined} />
    {!open && !feedbackBase && <ImageOperationStatus progress={progress} error={visibleError} preparing={starting} disabled={disabled || busy || recoveryBlocked} retry={retry} stop={canStop ? stop : undefined} stopping={stopping} />}
    {!feedbackBase && currentResubmission && <PetStoryResubmissionActions projectId={project.id} task={currentResubmission} disabled={disabled || busy || recoveryBlocked} />}
    {open && <Modal className="petstory-image-modal" title={`${title} · 选择图片`} open width={1000} onCancel={(): void => setOpen(false)} footer={<PreviewActions reviewingCurrent={reviewingCurrent} confirmingCurrent={confirmingCurrent} hasCurrent={!!current} hasSelected={!!selected} locked={disabled || busy} readable={readable} saving={state.busy} generationDisabled={generationBlocked} modificationDisabled={flowBusy} generating={busy} regenerate={onGenerate ? generate : undefined} close={(): void => setOpen(false)} modify={beginFeedback} adopt={adopt} />}>
      <div ref={previewBody}>
      {(previewOperationVisible || previewError) && <ImageOperationStatus progress={progress} error={previewError} preparing={starting} disabled={disabled || busy || recoveryBlocked} retry={previewOperationVisible ? retry : undefined} stop={canStop ? stop : undefined} stopping={stopping} />}
      <ImagePreviewBody project={project} title={title} images={images} candidates={candidates} current={current} selected={selected} reviewingCurrent={reviewingCurrent} confirmingCurrent={confirmingCurrent} identity={identity} locked={disabled || busy} readable={readable} batchSelectedId={batchSelectedId} onBatchSelection={onBatchSelection} hasConversation={!!selectedTask} onReadable={setReadable} select={(assetId: string): void => { if (selectedId !== assetId) setReadable(false); setSelectedId(assetId); setError(''); }} upload={upload} openConversation={(): void => openConversation(selected?.id)} />
      </div>
    </Modal>}
    {feedbackBase && <ImageFeedbackDialog projectId={project.id} title={title} base={feedbackBase} feedback={feedback} error={stopError || feedbackError} submitting={submitting} disabled={disabled || progress.busy || flowBusy || stopping || !!stopError} cancel={(): void => { setFeedbackBaseId(undefined); setOpen(true); }} submit={submitFeedback} change={setFeedback} stop={canStop ? stop : undefined} stopping={stopping} />}

  </div>;
};
