import React, { useEffect, useState } from 'react';
import { Button, Image } from 'antd';
import { PictureOutlined, PlayCircleOutlined } from '@ant-design/icons';
import type { PetStoryAsset, PetStoryCompiledPrompt, PetStoryProductionStep, PetStoryProject, PetStoryPromptKind, PetStoryShot, Task } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { PetStoryExistingMediaPicker } from './PetStoryExistingMediaPicker';
import { canvasJobLabel } from './petStoryCanvasShared';

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
  return <details className="canvas-provenance" onToggle={(event): void => setOpen(event.currentTarget.open)}><summary>提交全文与实际素材用途</summary>
    {dirty ? <p>先保存修改，再查看提交预览。</p> : error ? <p>{error}</p> : <><pre>{preview?.text || '展开后读取当前计划预览'}</pre><pre>{preview?.references.map((reference): string => `${reference.order} · ${reference.purpose} · ${reference.characterIds.join('、') || '场景/关键帧'}${reference.slot ? ` · ${reference.slot} 槽` : ''}`).join('\n')}</pre></>}
    {step?.pageBindings && <pre>{step.pageBindings.map((binding): string => `${binding.order} · ${binding.label} · ${binding.slot} · ${binding.reference}`).join('\n')}</pre>}
    {task && <><strong>{task.runtime?.acceptanceObservation ? '最近已受理运行的正文' : '最近任务输入（未确认受理）'}</strong><pre>{task.runtime?.input.prompt || task.prompt}</pre><p>任务 {task.id}</p>{step?.compiledPrompt?.final !== shot.prompts[kind]?.final && <p>历史任务使用了当时保存的正文；当前正文已有变化。</p>}</>}
  </details>;
};

export const CanvasMediaPreview: React.FC<{ project: PetStoryProject; asset: PetStoryAsset; name: string }> = ({ project, asset, name }): React.ReactElement => {
  const [source, setSource] = useState(''); const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setSource(''); setError('');
    const read = asset.kind === 'video' ? window.electronAPI.petstory.readMedia(project.id, asset.id) : window.electronAPI.petstory.readReference(project.id, asset.id);
    void read.then((result): void => { if (active) { setSource(result.data || ''); setError(result.error || ''); } }).catch((): void => { if (active) setError('本地媒体读取失败'); });
    return (): void => { active = false; };
  }, [project.id, asset.id, asset.kind]);
  let content: React.ReactNode = <p>{error || '正在读取本地文件…'}</p>;
  if (source) content = asset.kind === 'video' ? <video src={source} controls playsInline preload="metadata" aria-label={name} /> : <Image src={source} alt={name} />;
  return <div className="canvas-media-preview">{content}</div>;
};

const mediaNames: Record<PetStoryPromptKind, string> = { firstFrame: '首帧图片', lastFrame: '尾帧图片', video: '镜头视频' };
function selectedMedia(project: PetStoryProject, shot: PetStoryShot, kind: PetStoryPromptKind): PetStoryAsset | undefined {
  const media = project.production?.shots[shot.id];
  const selectedId = kind === 'firstFrame' ? media?.firstFrameId : kind === 'lastFrame' ? media?.plannedEndImageId : media?.videoId;
  const assetKind = kind === 'lastFrame' ? 'plannedEndImage' : kind;
  return project.assets.find((asset): boolean => asset.id === selectedId)
    || [...project.assets].reverse().find((asset): boolean => asset.shotId === shot.id && asset.kind === assetKind && !!asset.taskId);
}
function assetCaption(asset: PetStoryAsset): string {
  const source = asset.origin === 'historical_task' ? '已有豆包产物 · 历史正文' : asset.taskId ? '已有豆包产物' : '用户提供图片'; const validation = asset.validation;
  if (!validation) return `${source} · 未记录文件校验`;
  const duration = validation.durationSeconds ? ` · ${validation.durationSeconds.toFixed(2)}秒` : '';
  return `${source} · ${validation.width} × ${validation.height}${duration}`;
}
const ExistingMedia: React.FC<{ project: PetStoryProject; shot: PetStoryShot; asset: PetStoryAsset; kind: PetStoryPromptKind }> = ({ project, shot, asset, kind }): React.ReactElement => <>
  <CanvasMediaPreview project={project} asset={asset} name={`镜头 ${shot.order} ${mediaNames[kind]}`} /><p className="canvas-media-caption">{assetCaption(asset)}</p>
  {asset.generationPrompt && <details className="canvas-provenance"><summary>这项产物实际使用的正文</summary><pre>{asset.generationPrompt}</pre>{asset.generationFinal ? asset.generationFinal !== shot.prompts[kind]?.final ? <p>历史产物正文与当前 final 不同；图片不会随文字修改而自动重生。</p> : <p>生成所用正文与当前保存 final 一致。</p> : <p>旧产物未记录独立 final，完整任务输入如上，当前一致性尚未确认。</p>}</details>}
</>;

function mediaStatus(asset: PetStoryAsset | undefined, waiting: boolean, task: Task | undefined): string {
  if (asset?.validation) return '本地文件已校验';
  if (asset) return '已有文件 · 待校验';
  if (!waiting) return '未生成';
  return task?.status === 'done' ? '产物待下载 / 校验' : canvasJobLabel(task?.status);
}
export const CanvasMediaNode: React.FC<{ project: PetStoryProject; shot: PetStoryShot; kind: PetStoryPromptKind; disabled: boolean }> = ({ project, shot, kind, disabled }): React.ReactElement => {
  const state = usePetStoryStore(); const tasks = useTaskStore((store) => store.tasks); const [download, setDownload] = useState('');
  const asset = selectedMedia(project, shot, kind);
  const step = [...(project.production?.steps || [])].reverse().find((item): boolean => item.shotId === shot.id && item.kind === kind);
  const pendingTask = tasks.find((item): boolean => item.id === step?.taskId);
  const task = tasks.find((item): boolean => item.id === (asset?.taskId || step?.taskId));
  const waiting = !!step && step.status !== 'complete'; const video = kind === 'video'; const outputName = video ? '视频' : '图片';
  const buttonText = asset ? `重新生成${outputName}` : `生成${video ? '视频' : mediaNames[kind]}`;
  const currentEntryChecked = !!state.capability && state.capabilityCheckedInSession;
  const redownload = async (): Promise<void> => {
    if (!task) return; setDownload('正在重新下载原产物…');
    try {
      const result = await window.electronAPI.tasks.downloadOutputs([{ taskId: task.id, prompt: task.prompt, outputs: task.outputs, accountId: task.assignedAccountId || null, mode: task.mode }]);
      setDownload(result.success ? '原产物已重新下载' : '下载失败，请查看任务；未重新生成');
    } catch { setDownload('下载失败；未重新生成'); }
  };
  const openTask = (): void => { if (task) window.dispatchEvent(new CustomEvent('open-task-conversation', { detail: { task } })); };
  return <div className="canvas-media-node" data-media-kind={kind}><div className="canvas-field-label"><strong>{mediaNames[kind]}</strong><span className={`canvas-state ${asset?.validation ? 'ready' : ''}`}>{mediaStatus(asset, waiting, pendingTask)}</span></div>
    {asset ? <ExistingMedia project={project} shot={shot} asset={asset} kind={kind} /> : <div className="canvas-empty-media">{video ? <PlayCircleOutlined /> : <PictureOutlined />}<strong>{waiting ? '等待原任务产物' : `尚无${mediaNames[kind]}`}</strong><span>{video ? '生成后自动下载并在此播放' : '生成并下载后自动回填'}</span></div>}
    {waiting && asset && <p className="canvas-hint">新请求：{canvasJobLabel(pendingTask?.status)}；下方操作对应当前展示的历史产物。</p>}
    <div className="canvas-media-actions"><Button type="primary" size="small" icon={video ? <PlayCircleOutlined /> : <PictureOutlined />} disabled={disabled || waiting || !currentEntryChecked} onClick={(): void => { void state.generateShotMedia(shot.id, kind); }}>{buttonText}</Button>{task && <Button size="small" disabled={!task.outputs.length || download === '正在重新下载原产物…'} onClick={(): void => { void redownload(); }}>重新下载</Button>}</div>
    <PetStoryExistingMediaPicker project={project} shot={shot} kind={kind} disabled={disabled || waiting} />
    {!currentEntryChecked && <p className="canvas-hint">生成前在顶部“制作控制”重新核对当前会话的免费入口；已保存模型选择仅用于文字创作。</p>}{download && <p role="status">{download}</p>}
    {task && <button className="canvas-text-button" type="button" onClick={openTask}>打开对应原任务 · {canvasJobLabel(task.status)}</button>}{step?.error && <p className="canvas-error">{step.error}</p>}
  </div>;
};

function referenceName(project: PetStoryProject, asset: PetStoryAsset): string {
  if (asset.kind === 'scene') return '场景'; if (asset.kind === 'prop') return '道具';
  return (asset.characterIds || [asset.characterId]).map((id): string => project.plan?.characters.find((character): boolean => character.id === id)?.name || '').join('、');
}
function referenceApproved(project: PetStoryProject, asset: PetStoryAsset): boolean {
  return !!project.materials?.some((material): boolean => material.approved?.assetId === asset.id && material.approved.sha256 === asset.validation?.sha256);
}
export const CanvasReferenceStrip: React.FC<{ project: PetStoryProject; shot: PetStoryShot }> = ({ project, shot }): React.ReactElement => {
  const materialIds = new Set(project.materials?.filter((material): boolean => {
    if (material.kind === 'character') return shot.characterIds.includes(material.entityId);
    if (material.kind === 'prop') return !!shot.propIds?.includes(material.entityId);
    return shot.sceneId === material.entityId;
  }).map((material): string => material.selectedAssetId || ''));
  const references = project.assets.filter((asset): boolean => materialIds.has(asset.id) || !!shot.sceneReferenceAssetIds?.includes(asset.id)
    || (asset.kind === 'character' && shot.characterIds.some((id): boolean => project.plan?.characters.find((character): boolean => character.id === id)?.referenceAssetId === asset.id))).sort((a, b): number => { const order = (asset: PetStoryAsset): number => { if (asset.kind !== 'character') return shot.characterIds.length + (asset.kind === 'prop' ? 1 : 2); return Math.min(...(asset.characterIds || [asset.characterId]).filter((id): id is string => !!id).map((id): number => { const index = shot.characterIds.indexOf(id); return index < 0 ? 999 : index; })); }; return order(a) - order(b); });
  return <div className="canvas-reference-strip"><strong>选用参考 · {references.length}</strong>{references.map((asset): React.ReactNode => <div key={asset.id}><CanvasMediaPreview project={project} asset={asset} name="选用的参考图片" /><span>{referenceName(project, asset)} · {referenceApproved(project, asset) ? '已确认' : '已有参考 · 待确认'}</span></div>)}{!references.length && <p>尚未选用确认素材</p>}</div>;
};

/** 解析后的计划模式不冒充当前网页实际已受理的模式。 */
export function canvasActualMode(project: PetStoryProject, shot: PetStoryShot, tasks: Task[]): string {
  const productions = [...(project.productionHistory || []), ...(project.production ? [project.production] : [])].reverse();
  const videoAsset = selectedMedia(project, shot, 'video');
  const selectedProduction = productions.find((item): boolean => !!videoAsset?.taskId && item.steps.some((step): boolean => step.taskId === videoAsset.taskId && step.runId === videoAsset.runId));
  const production = selectedProduction || productions.find((item): boolean => item.steps.some((step): boolean => step.shotId === shot.id && step.kind === 'video'));
  const step = production?.steps.find((item): boolean => item.shotId === shot.id && item.kind === 'video');
  if (!step || !production) return '待入口核对';
  const task = tasks.find((item): boolean => item.id === step.taskId); const runtime = task?.runtime;
  const mode = step.compiledPrompt?.resolvedMode || production.shots[shot.id]?.resolvedMode;
  if (!mode) return '待入口核对';
  const accepted = runtime?.runId === step.runId && runtime?.acceptanceObservation?.runId === step.runId;
  if (!accepted) return `计划 ${mode} · 待实际受理`;
  return step.pageBindings?.length ? mode : `${mode} · 历史记录，页面绑定未留存`;
}
