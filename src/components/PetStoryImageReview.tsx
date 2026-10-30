import React, { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Image, Input, Modal, Space, Tag } from 'antd';
import { PictureOutlined, UploadOutlined } from '@ant-design/icons';
import type { PetStoryAsset, PetStoryImageTarget, PetStoryProject } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { imageConversationTask, petStoryImageProgress } from '../utils/petstoryImageFlow';

/** 预览只读取文件；选中候选、打开历史和关闭弹窗都不改变正式采用关系。 */
export function imageBelongsToTarget(project: PetStoryProject, asset: PetStoryAsset, target: PetStoryImageTarget): boolean {
  if (asset.kind === 'video' || asset.kind === 'actualEndFrame') return false;
  const reviewTarget = asset.imageReview?.target;
  if (reviewTarget) return target.materialId ? reviewTarget.materialId === target.materialId
    : reviewTarget.shotId === target.shotId && reviewTarget.kind === target.kind;
  if (target.materialId) {
    const material = project.materials?.find((item): boolean => item.id === target.materialId);
    return !!material && asset.kind === material.kind && (asset.materialId === material.id
      || (material.kind === 'character' && (asset.characterIds || [asset.characterId]).includes(material.entityId)));
  }
  return asset.shotId === target.shotId && asset.kind === (target.kind === 'firstFrame' ? 'firstFrame' : 'plannedEndImage');
}
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
  return replacing ? '采用后替换当前图片；旧图和已有成果保留，相关镜头需要复核。' : '确认采用后，图片才会进入正式节点。';
}
type ImageProgress = ReturnType<typeof petStoryImageProgress>;
function imageError(local: string, external: string | undefined, operation: string): string { return local || external || operation || ''; }
const ImageOperationStatus: React.FC<{ progress: ImageProgress; error: string; disabled: boolean; preparing?: boolean; retry?: () => Promise<void> }> = ({ progress, error, disabled, preparing, retry }): React.ReactElement | null => {
  if (error) return <div className="petstory-image-feedback-error" role="alert"><span>{error}</span>{retry && <Button size="small" disabled={disabled} onClick={(): void => { void retry(); }}>{progress.operation ? progress.task?.outputs.length ? '重新下载图片' : '继续本次任务' : '重试剩余原图'}</Button>}</div>;
  if (progress.resumable && !preparing) return <div className="petstory-image-progress" role="status"><span>{progress.message}</span>{retry && <Button size="small" disabled={disabled} onClick={(): void => { void retry(); }}>继续本次任务</Button>}</div>;
  if (!progress.operation && !preparing) return null;
  const complete = !!progress.candidateAssetId && !progress.busy && !preparing;
  const message = preparing ? '正在准备图片…' : progress.message;
  return <div className="petstory-image-progress" role="status"><div className={`petstory-image-progress-track ${complete ? 'is-complete' : 'is-pending'}`} role="progressbar" aria-label="图片任务进度" aria-valuetext={message} aria-valuenow={complete ? 100 : undefined} aria-valuemin={0} aria-valuemax={100}><span /></div><span>{message}</span></div>;
};
interface ImageActionsProps {
  current?: PetStoryAsset; currentNeedsReview: boolean; candidateCount: number; disabled: boolean; busy: boolean;
  generationDisabled?: boolean; show: (assetId?: string) => void; upload: () => Promise<void>; generate?: () => Promise<void>; openConversation?: () => void;
}
const ImageActions: React.FC<ImageActionsProps> = ({ current, currentNeedsReview, candidateCount, disabled, busy, generationDisabled, show, upload, generate, openConversation }): React.ReactElement => <>
  {candidateCount > 0 && <div className="petstory-candidate-banner"><span>图片待确认{candidateCount > 1 ? ` · ${candidateCount} 张` : ''}</span></div>}
  <div className="canvas-media-actions">
    {current || candidateCount ? <Button aria-label={currentNeedsReview && !candidateCount ? '查看并复核' : '查看图片'} type="primary" size="small" onClick={(): void => show()}>{currentNeedsReview && !candidateCount ? '查看并复核' : '查看图片'}</Button>
      : generate && <Button aria-label="生成图片" size="small" type="primary" loading={busy} disabled={disabled || generationDisabled || busy} onClick={(): void => { void generate(); }}>生成图片</Button>}
    <Button size="small" aria-label={current || candidateCount ? '上传替代图片' : '上传图片'} icon={<UploadOutlined />} disabled={disabled || busy} onClick={(): void => { void upload(); }}>{current || candidateCount ? '上传替代图片' : '上传图片'}</Button>
  </div>
  {openConversation && <Button className="petstory-image-conversation" type="link" size="small" onClick={openConversation}>查看豆包对话</Button>}
</>;

interface ImagePreviewBodyProps {
  project: PetStoryProject; title: string; images: PetStoryAsset[]; candidates: PetStoryAsset[]; current?: PetStoryAsset; selected?: PetStoryAsset;
  reviewingCurrent: boolean; confirmingCurrent: boolean; identity?: string; locked: boolean; readable: boolean; batchSelectedId?: string;
  onBatchSelection?: (assetId: string, checked: boolean) => void; hasConversation: boolean;
  onReadable: (value: boolean) => void; select: (assetId: string) => void; upload: () => Promise<void>; openConversation: () => void;
}
const ImagePreviewBody: React.FC<ImagePreviewBodyProps> = ({ project, title, images, candidates, current, selected, reviewingCurrent, confirmingCurrent, identity, locked, readable, batchSelectedId, onBatchSelection, hasConversation, onReadable, select, upload, openConversation }): React.ReactElement => <div className="petstory-image-preview-layout"><div>
  {selected ? <div className="petstory-large-image"><ReviewImage projectId={project.id} asset={selected} name={`${title} · ${reviewingCurrent ? '当前采用' : '待确认图片'}`} onReadable={onReadable} /></div> : <p>当前没有可预览的图片。</p>}
  <div className="petstory-image-options">{images.map((asset): React.ReactNode => {
    const candidateIndex = candidates.findIndex((item): boolean => item.id === asset.id);
    return <button type="button" key={asset.id} className={selected?.id === asset.id ? 'selected' : ''} aria-label={candidateIndex >= 0 ? `选择候选图片 ${candidateIndex + 1}` : `查看历史图片 ${images.indexOf(asset) + 1}`} onClick={(): void => select(asset.id)}><ReviewImage projectId={project.id} asset={asset} name={`${title} · ${candidateIndex >= 0 ? `候选 ${candidateIndex + 1}` : '已采用版本'}`} /><span>{asset.id === current?.id ? '当前采用' : candidateIndex >= 0 ? `候选 ${candidateIndex + 1}` : '历史采用'}</span></button>;
  })}</div>
</div><aside><h3>图片用途</h3><p>{title}</p><Tag>{confirmingCurrent ? '需要复核' : reviewingCurrent ? '已采用' : '待确认'}</Tag>
  {selected && <p className="petstory-image-source">{selected.taskId ? '豆包图片' : '本地上传'}</p>}
  {identity && <p>人物外观：{identity}</p>}
  {current && !reviewingCurrent && <div className="petstory-current-comparison"><strong>当前采用图片</strong><ReviewImage projectId={project.id} asset={current} name={`${title} · 替换前`} /><p>新图片采用前，当前图片保持不变。</p></div>}
  {selected && !reviewingCurrent && onBatchSelection && <Checkbox disabled={locked || !readable} checked={batchSelectedId === selected.id} onChange={(event): void => onBatchSelection(selected.id, event.target.checked)}>已检查这张，选入批量采用</Checkbox>}
  <Space direction="vertical" className="mt-4"><Button type="link" disabled={locked} onClick={(): void => { void upload(); }}>上传替代图片</Button>{hasConversation && <Button type="link" onClick={openConversation}>查看豆包对话</Button>}</Space>
</aside></div>;
interface PreviewActionsProps {
  reviewingCurrent: boolean; confirmingCurrent: boolean; hasCurrent: boolean; hasSelected: boolean; locked: boolean; readable: boolean; saving: boolean;
  close: () => void; modify: () => void; adopt: () => Promise<void>;
}
const PreviewActions: React.FC<PreviewActionsProps> = ({ reviewingCurrent, confirmingCurrent, hasCurrent, hasSelected, locked, readable, saving, close, modify, adopt }): React.ReactElement => <>
  <span className="petstory-adoption-note">{adoptionNote(reviewingCurrent, hasCurrent, confirmingCurrent)}</span>
  <Button onClick={close}>{reviewingCurrent ? '返回' : '暂不采用'}</Button>
  {hasSelected && <Button disabled={locked || !readable} onClick={modify}>不满意，修改图片</Button>}
  {(!reviewingCurrent || confirmingCurrent) && <Button type="primary" disabled={locked || !hasSelected || !readable} loading={saving} onClick={(): void => { void adopt(); }}>{confirmingCurrent ? '确认继续使用' : '满意，采用图片'}</Button>}
</>;
interface ImageFeedbackDialogProps {
  projectId: string; title: string; base: PetStoryAsset; feedback: string; error: string; submitting: boolean; disabled: boolean;
  cancel: () => void; submit: () => Promise<void>; change: (feedback: string) => void;
}
const ImageFeedbackDialog: React.FC<ImageFeedbackDialogProps> = ({ projectId, title, base, feedback, error, submitting, disabled, cancel, submit, change }): React.ReactElement => <Modal className="petstory-image-feedback-modal" title="修改这张图片" open closable={false} width={640} onCancel={(): void => { if (!submitting) cancel(); }} footer={<><Button aria-label="取消" disabled={submitting} onClick={cancel}>取消</Button><Button type="primary" loading={submitting} disabled={disabled || !feedback.trim() || submitting} onClick={(): void => { void submit(); }}>提交修改</Button></>}>
  <div className="petstory-feedback-image"><ReviewImage projectId={projectId} asset={base} name={`${title} · 本次修改基图`} /></div><p>{title}</p>
  <label className="petstory-feedback-label" htmlFor={`image-feedback-${base.id}`}>告诉 AI 你希望怎么修改。</label>
  <Input.TextArea id={`image-feedback-${base.id}`} aria-label="图片修改意见" value={feedback} disabled={submitting} autoSize={{ minRows: 4, maxRows: 8 }} placeholder="例如：表情更自然一些，衣服和背景保持不变。" onChange={(event): void => change(event.target.value)} />
  {error && <p className="petstory-image-feedback-error" role="alert">{error}</p>}
</Modal>;
function currentReviewState(current: PetStoryAsset | undefined, selected: PetStoryAsset | undefined, currentNeedsReview?: boolean): { reviewingCurrent: boolean; needsReview: boolean; confirmingCurrent: boolean } {
  const reviewingCurrent = !!selected && selected.id === current?.id;
  const needsReview = !!(currentNeedsReview || current?.needsReview);
  return { reviewingCurrent, needsReview, confirmingCurrent: reviewingCurrent && needsReview };
}

/** 修改弹窗绑定用户选中的具体图片；提交只创建候选，不改变正式采用关系。 */
export const PetStoryImageReview: React.FC<PetStoryImageReviewProps> = ({ project, target, title, currentAssetId, currentNeedsReview, previewAssetId, disabled, generationDisabled, generating, identity, externalError, onRetry, onUpload, onGenerate, onAdopt, onModify, onBatchSelection, batchSelectedId }): React.ReactElement => {
  const [open, setOpen] = useState(false); const [selectedId, setSelectedId] = useState<string>();
  const [readable, setReadable] = useState(false); const [error, setError] = useState(''); const [recoveryFailed, setRecoveryFailed] = useState(false);
  const [feedbackBaseId, setFeedbackBaseId] = useState<string>(); const [feedback, setFeedback] = useState('');
  const [feedbackError, setFeedbackError] = useState(''); const [submitting, setSubmitting] = useState(false); const [starting, setStarting] = useState(false);
  const root = useRef<HTMLDivElement>(null); const awaitingResult = useRef<Set<string> | null>(null);
  const state = usePetStoryStore(); const tasks = useTaskStore((store) => store.tasks);
  const progress = petStoryImageProgress(project, target, tasks, state.activeImageOperationId);
  const images = project.assets.filter((asset): boolean => imageBelongsToTarget(project, asset, target));
  const current = images.find((asset): boolean => asset.id === currentAssetId);
  const candidates = images.filter((asset): boolean => asset.id !== currentAssetId && asset.imageReview?.state !== 'adopted');
  const selected = images.find((asset): boolean => asset.id === selectedId);
  const feedbackBase = images.find((asset): boolean => asset.id === feedbackBaseId);
  const { reviewingCurrent, needsReview, confirmingCurrent } = currentReviewState(current, selected, currentNeedsReview);
  const busy = progress.busy || !!generating || starting || submitting;
  const task = imageConversationTask(project, target, tasks);
  const selectedTask = selected ? imageConversationTask(project, target, tasks, selected.id) : undefined;
  const visibleError = imageError(error, externalError, progress.error);
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
    if (!root.current || root.current.closest('[hidden], .page-hidden') || document.hidden || document.querySelector('[role="dialog"]')) return;
    setSelectedId(produced.id); setReadable(false); setError(''); setOpen(true);
  }, [images, feedbackBase, submitting]);
  useEffect((): void => { if (previewAssetId) { setSelectedId(previewAssetId); setReadable(false); setOpen(true); } }, [previewAssetId]);
  const generate = async (): Promise<void> => {
    if (!onGenerate || busy || disabled || generationDisabled) return;
    setError(''); setRecoveryFailed(false); setStarting(true); awaitingResult.current = new Set(images.map((asset): string => asset.id));
    try { await onGenerate(); const latest = usePetStoryStore.getState(); if (latest.error) setError(latest.error); }
    catch (failure: unknown) { setError(failure instanceof Error ? failure.message : '图片任务未启动，请重试'); }
    finally { setStarting(false); }
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
    if (!selected || !readable || disabled || busy) return;
    setFeedbackBaseId(selected.id); setFeedback(''); setFeedbackError(''); setOpen(false);
  };
  const submitFeedback = async (): Promise<void> => {
    if (!feedbackBase || !feedback.trim() || submitting || disabled || progress.busy) return;
    setSubmitting(true); setFeedbackError('');
    awaitingResult.current = new Set(images.map((asset): string => asset.id));
    try {
      if (onModify) await onModify(feedbackBase.id, feedback);
      else await state.modifyImage(target, feedbackBase.id, feedback);
      const latest = usePetStoryStore.getState();
      if (latest.error) { setFeedbackError(latest.error); return; }
      setFeedbackBaseId(undefined); setOpen(false);
    } catch (failure: unknown) { setFeedbackError(failure instanceof Error ? failure.message : '修改任务未启动，请重试'); }
    finally { setSubmitting(false); }
  };
  const openConversation = (assetId?: string): void => { void state.openImageConversation(target, assetId); };
  const operationId = progress.operation?.id;
  const operationIssueVisible = !externalError && (recoveryFailed || !error || error === progress.error) && (progress.resumable || !!progress.error);
  const recover = async (): Promise<void> => {
    if (!operationId) return;
    setError(''); setRecoveryFailed(false);
    try { await state.recoverImageOperation(operationId); const latest = usePetStoryStore.getState(); if (latest.error) { setError(latest.error); setRecoveryFailed(true); } }
    catch (failure: unknown) { setError(failure instanceof Error ? failure.message : '原图片任务未能继续，请重试'); setRecoveryFailed(true); }
  };
  const retry = operationId && operationIssueVisible ? recover : externalError ? onRetry : undefined;
  return <div ref={root} className="petstory-image-review" data-image-target={title}>
    {current ? <button type="button" className="petstory-current-image" onClick={(): void => show(current.id)} aria-label={`查看${title}已采用图片`}><ReviewImage projectId={project.id} asset={current} name={`${title} · 当前采用`} /></button>
      : <div className="petstory-image-empty"><PictureOutlined /><span>尚未采用图片</span></div>}
    {current && needsReview && <p className="canvas-error">参考内容已更新，请复核这张图片。</p>}
    <ImageActions current={current} currentNeedsReview={needsReview} candidateCount={candidates.length} disabled={disabled} busy={busy} generationDisabled={generationDisabled || progress.resumable} show={show} upload={upload} generate={onGenerate ? generate : undefined} openConversation={task ? (): void => openConversation() : undefined} />
    {!open && !feedbackBase && <ImageOperationStatus progress={progress} error={visibleError} preparing={starting} disabled={disabled || busy} retry={retry} />}
    {open && <Modal className="petstory-image-modal" title={`${title} · 选择图片`} open width={1000} onCancel={(): void => setOpen(false)} footer={<PreviewActions reviewingCurrent={reviewingCurrent} confirmingCurrent={confirmingCurrent} hasCurrent={!!current} hasSelected={!!selected} locked={disabled || busy} readable={readable} saving={state.busy} close={(): void => setOpen(false)} modify={beginFeedback} adopt={adopt} />}>
      <ImageOperationStatus progress={progress} error={visibleError} preparing={starting} disabled={disabled || busy} retry={retry} />
      <ImagePreviewBody project={project} title={title} images={images} candidates={candidates} current={current} selected={selected} reviewingCurrent={reviewingCurrent} confirmingCurrent={confirmingCurrent} identity={identity} locked={disabled || busy} readable={readable} batchSelectedId={batchSelectedId} onBatchSelection={onBatchSelection} hasConversation={!!selectedTask} onReadable={setReadable} select={(assetId: string): void => { if (selectedId !== assetId) setReadable(false); setSelectedId(assetId); setError(''); }} upload={upload} openConversation={(): void => openConversation(selected?.id)} />
    </Modal>}
    {feedbackBase && <ImageFeedbackDialog projectId={project.id} title={title} base={feedbackBase} feedback={feedback} error={feedbackError} submitting={submitting} disabled={disabled || progress.busy} cancel={(): void => { setFeedbackBaseId(undefined); setOpen(true); }} submit={submitFeedback} change={setFeedback} />}

  </div>;
};
