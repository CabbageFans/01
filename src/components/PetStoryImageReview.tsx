import React, { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Image, Modal, Space, Tag } from 'antd';
import { MoreOutlined, PictureOutlined, UploadOutlined } from '@ant-design/icons';
import type { PetStoryAsset, PetStoryImageTarget, PetStoryProject } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';

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
  project: PetStoryProject; target: PetStoryImageTarget; title: string; currentAssetId?: string;
  disabled: boolean; generationDisabled?: boolean; generating?: boolean; identity?: string;
  onUpload: () => Promise<void>; onGenerate?: () => Promise<void>; onAdopt: (assetId: string) => Promise<void>;
  onAdjust?: () => Promise<void>; onBatchSelection?: (assetId: string, checked: boolean) => void; batchSelectedId?: string;
}

function adoptionNote(reviewingCurrent: boolean, replacing: boolean): string {
  if (reviewingCurrent) return '当前采用图片；查看不会改变素材。';
  return replacing ? '采用后替换当前图片；旧图和已有成果保留，相关镜头需要复核。' : '确认采用后，图片才会进入正式节点。';
}
function reviewOptions(history: boolean, current: PetStoryAsset | undefined, historical: PetStoryAsset[], candidates: PetStoryAsset[]): PetStoryAsset[] {
  if (!history) return candidates;
  return current ? [current, ...historical] : historical;
}

interface ImageActionsProps {
  title: string; current?: PetStoryAsset; candidateCount: number; historyCount: number;
  disabled: boolean; generationDisabled?: boolean; generating?: boolean;
  show: (assetId?: string, history?: boolean) => void; upload: () => Promise<void>;
  onGenerate?: () => Promise<void>; onAdjust?: () => Promise<void>;
}
const ImageActions: React.FC<ImageActionsProps> = ({ title, current, candidateCount, historyCount, disabled, generationDisabled, generating, show, upload, onGenerate, onAdjust }): React.ReactElement => <>
    {candidateCount > 0 && <div className="petstory-candidate-banner"><span>{candidateCount} 张图片待选择</span><Button size="small" type="primary" disabled={disabled} onClick={(): void => show()}>查看并采用</Button></div>}
    <div className="canvas-media-actions">
      {current ? <Button size="small" onClick={(): void => show(current.id, true)}>查看图片</Button> : !candidateCount && <>
        {onGenerate && <Button size="small" type="primary" loading={generating} disabled={disabled || generationDisabled} onClick={(): void => { void onGenerate(); }}>生成图片</Button>}
        <Button size="small" aria-label="上传图片" icon={<UploadOutlined />} disabled={disabled} onClick={(): void => { void upload(); }}>上传图片</Button>
      </>}
      {(current || candidateCount > 0 || historyCount > 0) && <details className="petstory-more"><summary aria-label={`${title}更多操作`}><MoreOutlined /></summary><div>
        <Button type="text" size="small" disabled={disabled} onClick={(): void => { void upload(); }}>上传替代图片</Button>
        {onGenerate && <Button type="text" size="small" disabled={disabled || generationDisabled} onClick={(): void => { void onGenerate(); }}>重新生成图片</Button>}
        {onAdjust && <Button type="text" size="small" disabled={disabled} onClick={(): void => { void onAdjust(); }}>在豆包中调整</Button>}
        <Button type="text" size="small" disabled={!current && !historyCount} onClick={(): void => show(undefined, true)}>历史版本</Button>
      </div></details>}
    </div>
</>;

export const PetStoryImageReview: React.FC<PetStoryImageReviewProps> = ({ project, target, title, currentAssetId, disabled, generationDisabled, generating, identity, onUpload, onGenerate, onAdopt, onAdjust, onBatchSelection, batchSelectedId }): React.ReactElement => {
  const [open, setOpen] = useState(false); const [history, setHistory] = useState(false);
  const [selectedId, setSelectedId] = useState<string>(); const [readable, setReadable] = useState(false); const [error, setError] = useState('');
  const state = usePetStoryStore();
  const images = project.assets.filter((asset): boolean => imageBelongsToTarget(project, asset, target));
  const current = images.find((asset): boolean => asset.id === currentAssetId);
  const candidates = images.filter((asset): boolean => asset.id !== currentAssetId && asset.imageReview?.state !== 'adopted');
  const historical = images.filter((asset): boolean => asset.id !== currentAssetId && asset.imageReview?.state === 'adopted');
  const visible = reviewOptions(history, current, historical, candidates);
  const selected = images.find((asset): boolean => asset.id === selectedId);
  const reviewingCurrent = !!selected && selected.id === currentAssetId;
  const show = (assetId?: string, showHistory = false): void => { setHistory(showHistory); setSelectedId(assetId || (showHistory ? current?.id || historical[0]?.id : candidates[0]?.id)); setError(''); setOpen(true); };
  const upload = async (): Promise<void> => {
    setError('');
    const previousIds = new Set(images.map((asset): string => asset.id));
    try { await onUpload(); } catch (failure: unknown) { setError(failure instanceof Error ? failure.message : '图片上传未完成，请重试'); return; }
    const latest = usePetStoryStore.getState();
    if (latest.error) { setError(latest.error); return; }
    const latestProject = latest.project;
    if (!latestProject || latestProject.id !== project.id) return;
    const uploaded = [...latestProject.assets].reverse().find((asset): boolean => !previousIds.has(asset.id) && imageBelongsToTarget(latestProject, asset, target));
    if (uploaded) show(uploaded.id);
  };
  const adopt = async (): Promise<void> => {
    if (!selected || !readable || disabled) return;
    setError('');
    try { await onAdopt(selected.id); } catch (failure: unknown) { setError(failure instanceof Error ? failure.message : '图片尚未采用，请重试'); return; }
    const latest = usePetStoryStore.getState();
    if (latest.error) setError(latest.error); else setOpen(false);
  };
  return <div className="petstory-image-review" data-image-target={title}>
    {current ? <button type="button" className="petstory-current-image" onClick={(): void => show(current.id, true)} aria-label={`查看${title}已采用图片`}><ReviewImage projectId={project.id} asset={current} name={`${title} · 当前采用`} /></button>
      : <div className="petstory-image-empty"><PictureOutlined /><span>尚未采用图片</span></div>}
    {current?.needsReview && <p className="canvas-error">参考内容已更新，请复核这张图片。</p>}
    <ImageActions title={title} current={current} candidateCount={candidates.length} historyCount={historical.length} disabled={disabled} generationDisabled={generationDisabled} generating={generating} show={show} upload={upload} onGenerate={onGenerate} onAdjust={onAdjust} />
    {error && !open && <Alert type="error" message={error} />}
    <Modal className="petstory-image-modal" title={history ? `${title} · 图片与历史` : `${title} · 选择图片`} open={open} width={1000} onCancel={(): void => setOpen(false)} footer={<>
      <span className="petstory-adoption-note">{adoptionNote(reviewingCurrent, !!current)}</span>
      <Button onClick={(): void => setOpen(false)}>{reviewingCurrent ? '返回' : '暂不采用'}</Button>
      {!reviewingCurrent && <Button type="primary" disabled={disabled || !selected || !readable} loading={state.busy} onClick={(): void => { void adopt(); }}>采用这张</Button>}
    </>}>
      {error && <Alert type="error" message={error} />}
      <div className="petstory-image-preview-layout"><div>
        {selected ? <div className="petstory-large-image"><ReviewImage projectId={project.id} asset={selected} name={`${title} · ${reviewingCurrent ? '当前采用' : '待确认图片'}`} onReadable={setReadable} /></div> : <p>当前没有可预览的图片。</p>}
        <div className="petstory-image-options">{visible.map((asset, index): React.ReactNode => <button type="button" key={asset.id} className={selectedId === asset.id ? 'selected' : ''} aria-label={`${history ? '查看历史图片' : '选择候选图片'} ${index + 1}`} onClick={(): void => { setSelectedId(asset.id); setError(''); }}><ReviewImage projectId={project.id} asset={asset} name={`${title} · ${index + 1}`} /><span>{asset.id === currentAssetId ? '当前采用' : history ? `历史图片 ${index + 1}` : `候选 ${index + 1}`}</span></button>)}</div>
      </div><aside><h3>图片用途</h3><p>{title}</p><Tag>{reviewingCurrent ? '已采用' : '待确认'}</Tag>
        {selected && <dl><dt>来源</dt><dd>{selected.taskId ? '豆包图片' : '本地上传'}</dd><dt>文件检查</dt><dd>{selected.validation?.decoded ? `${selected.validation.width} × ${selected.validation.height} · 文件校验通过` : '尚无文件校验记录'}</dd></dl>}
        {identity && <p>请同时核对人物外观：{identity}</p>}
        {current && !reviewingCurrent && <div className="petstory-current-comparison"><strong>当前采用图片</strong><ReviewImage projectId={project.id} asset={current} name={`${title} · 替换前`} /><p>新图片采用前，当前图片保持不变。</p></div>}
        {selected && !reviewingCurrent && onBatchSelection && <Checkbox disabled={disabled || !readable} checked={batchSelectedId === selected.id} onChange={(event): void => onBatchSelection(selected.id, event.target.checked)}>已检查这张，选入批量采用</Checkbox>}
        {!history && <Space direction="vertical" className="mt-4"><Button disabled={disabled} onClick={(): void => { void upload(); }}>上传替代图片</Button>{onAdjust && <Button disabled={disabled} onClick={(): void => { setOpen(false); void onAdjust(); }}>在豆包中调整</Button>}</Space>}
      </aside></div>
    </Modal>
  </div>;
};
