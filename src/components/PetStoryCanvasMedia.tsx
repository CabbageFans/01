import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Image, InputNumber, Select, Space } from 'antd';
import { PlayCircleOutlined } from '@ant-design/icons';
import type { PetStoryAsset, PetStoryCompiledPrompt, PetStoryPlan, PetStoryProductionStep, PetStoryProject, PetStoryPromptKind, PetStoryShot, Task } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { imageBelongsToTarget, PetStoryImageReview } from './PetStoryImageReview';
import { PetStoryExistingMediaPicker } from './PetStoryExistingMediaPicker';
import { canvasJobLabel, isCanvasPlanLocked } from './petStoryCanvasShared';
import { PetStoryGenerationBlockers } from './PetStoryGenerationBlockers';
import { usePetStoryGenerationEligibility } from './usePetStoryGenerationEligibility';
import type { PetStoryGenerationBlocker, PetStoryGenerationEligibility } from './usePetStoryGenerationEligibility';
import { locatePetStoryDraft, usePetStoryDraft } from './PetStoryDrafts';
import { mergePetStoryPlanDraft } from '../utils/petstoryPlanDraft';
import { journeyMaterialImageApproved, journeyShotAsset } from '../utils/petstoryJourney';

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
  if (asset?.validation) return asset.needsReview ? '文件已校验 · 需要复核' : '文件校验通过';
  if (asset) return '已有文件 · 待校验';
  if (hasCandidate) return '图片待确认';
  if (!waiting) return '未生成';
  return task?.status === 'done' ? '产物待下载 / 校验' : canvasJobLabel(task?.status);
}
export type PetStoryMediaNavigate = (target: 'materials' | 'keyframes' | 'videoPrompt' | 'plan', objectId?: string, kind?: PetStoryPromptKind) => void;

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
    <p className="canvas-hint">执行时按当前入口解析模式。首尾帧使用平台独立首帧和尾帧槽；多参考中的两张图不代表原生首尾帧。</p>
    {message && <p role="status">{message}</p>}
  </Space></div>;
};

export function resolveMediaBlocker(blocker: PetStoryGenerationBlocker, shot: PetStoryShot, kind: PetStoryPromptKind, refresh: () => void, onNavigate?: PetStoryMediaNavigate): void {
    if (blocker.code === 'task') { window.dispatchEvent(new CustomEvent('petstory-locate-task', { detail: { jobId: blocker.jobId } })); return; }
    if (blocker.code === 'story' && onNavigate) { onNavigate('plan'); return; }
    if (blocker.code === 'materials' && onNavigate) { onNavigate('materials', blocker.materialId); return; }
    if (blocker.code === 'firstFrame' || blocker.code === 'lastFrame') {
      if (blocker.promptKind === 'video') {
        if (onNavigate) { onNavigate('videoPrompt', blocker.shotId || shot.id, 'video'); return; }
        document.getElementById(`shot-media-${blocker.shotId || shot.id}-video`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); return;
      }
      const targetKind = blocker.code === 'firstFrame' ? 'firstFrame' : 'lastFrame';
      if (onNavigate) { onNavigate('keyframes', blocker.shotId || shot.id, targetKind); return; }
      document.getElementById(`shot-media-${blocker.shotId || shot.id}-${targetKind}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); return;
    }
    if (blocker.code === 'prompt' && onNavigate) { onNavigate(kind === 'video' ? 'videoPrompt' : 'keyframes', shot.id, kind); return; }
    refresh();
  }

const CanvasVideoResolution: React.FC<{ shot: PetStoryShot; eligibility?: PetStoryGenerationEligibility }> = ({ shot, eligibility }): React.ReactElement => <div className="canvas-mode"><span>请求 <b>{petStoryModeNames[shot.requestedMode]}</b></span><span>执行模式 <b>{eligibility?.resolvedMode ? petStoryModeNames[eligibility.resolvedMode] : '执行时读取'}</b></span>{eligibility?.modeReason && <p>{eligibility.modeReason}</p>}</div>;

interface CanvasMediaFacts { asset?: PetStoryAsset; step?: PetStoryProductionStep; pendingTask?: Task; task?: Task; waiting: boolean; video: boolean; buttonText: string }
function mediaNodeFacts(project: PetStoryProject, shot: PetStoryShot, kind: PetStoryPromptKind, tasks: Task[]): CanvasMediaFacts {
  const asset = selectedPetStoryMedia(project, shot, kind);
  const step = [...(project.production?.steps || [])].reverse().find((item): boolean => item.shotId === shot.id && item.kind === kind);
  const pendingTask = tasks.find((item): boolean => item.id === step?.taskId);
  const task = tasks.find((item): boolean => item.id === (asset?.taskId || step?.taskId));
  const waiting = !!step && step.status !== 'complete'; const video = kind === 'video';
  const buttonText = asset ? `重新生成${video ? '视频' : '图片'}` : video ? '生成视频' : '生成图片';
  return { asset, step, pendingTask, task, waiting, video, buttonText };
}

export const CanvasMediaNode: React.FC<{ project: PetStoryProject; shot: PetStoryShot; kind: PetStoryPromptKind; disabled: boolean; onNavigate?: PetStoryMediaNavigate }> = ({ project, shot, kind, disabled, onNavigate }): React.ReactElement => {
  const state = usePetStoryStore(); const tasks = useTaskStore((store) => store.tasks); const [download, setDownload] = useState('');
  const [settingsDirty, setSettingsDirty] = useState(false);
  const readiness = usePetStoryGenerationEligibility(project, { shotId: shot.id, promptKind: kind });
  const { asset, step, pendingTask, task, waiting, video, buttonText } = mediaNodeFacts(project, shot, kind, tasks);
  const hasCandidate = !video && project.assets.some((item): boolean => item.id !== asset?.id && item.imageReview?.state !== 'adopted'
    && imageBelongsToTarget(project, item, { shotId: shot.id, kind: kind as 'firstFrame' | 'lastFrame' }));
  const generationNeeded = !asset && !hasCandidate && !waiting;
  const redownload = async (): Promise<void> => {
    if (!task) return; setDownload('正在重新下载原产物…');
    try {
      const result = await window.electronAPI.tasks.downloadOutputs([{ taskId: task.id, prompt: task.prompt, outputs: task.outputs, accountId: task.assignedAccountId || null, mode: task.mode }]);
      setDownload(result.success ? '原产物已重新下载' : '下载失败，请查看原任务；没有重新生成');
    } catch { setDownload('下载失败；没有重新生成'); }
  };
  const openTask = (): void => { if (task) window.dispatchEvent(new CustomEvent('open-task-conversation', { detail: { task } })); };
  const revealAsset = async (): Promise<void> => {
    if (!asset) return;
    try { const result = await window.electronAPI.petstory.revealAsset(project.id, asset.id); if (!result.success) setDownload(result.error || '暂时无法定位此文件'); }
    catch { setDownload('暂时无法定位此文件，请检查文件是否仍在原位置。'); }
  };

  return <div id={`shot-media-${shot.id}-${kind}`} tabIndex={-1} className="canvas-media-node" data-media-kind={kind}><div className="canvas-field-label"><strong>{mediaNames[kind]}</strong><span className={`canvas-state ${asset?.validation ? 'ready' : ''}`}>{mediaStatus(asset, waiting, pendingTask, hasCandidate)}</span></div>
    {video && <details className="petstory-secondary-tools"><summary>本镜制作设置</summary><CanvasVideoSettings project={project} shot={shot} onDirtyChange={setSettingsDirty} /></details>}
    {!video ? <PetStoryImageReview project={project} target={{ shotId: shot.id, kind: kind as 'firstFrame' | 'lastFrame' }} title={`镜头 ${shot.order} · ${kind === 'firstFrame' ? '首帧' : '尾帧'}`} currentAssetId={asset?.id}
      disabled={disabled} generationDisabled={waiting || !readiness.eligibility?.ready} generating={readiness.loading}
      onUpload={async (): Promise<void> => state.uploadShotImage(shot.id, kind as 'firstFrame' | 'lastFrame')}
      onGenerate={async (): Promise<void> => state.generateShotMedia(shot.id, kind)}
      onAdopt={async (assetId: string): Promise<void> => state.adoptShotImage(shot.id, kind as 'firstFrame' | 'lastFrame', assetId)}
      onAdjust={async (): Promise<void> => state.openChatAdjustment({ shotId: shot.id, promptKind: kind })} />
      : asset ? <ExistingMedia project={project} shot={shot} asset={asset} kind={kind} /> : <div className="canvas-empty-media"><PlayCircleOutlined /><strong>{waiting ? '等待原任务产物' : '尚无镜头视频'}</strong><span>生成后自动下载，再检查文件与画面。</span></div>}
    {waiting && asset && <p className="canvas-hint">新请求：{canvasJobLabel(pendingTask?.status)}；下方仍展示原有成果。</p>}
    {generationNeeded && <PetStoryGenerationBlockers blockers={(readiness.eligibility?.blockers || []).slice(0, 1)} onResolve={(blocker): void => resolveMediaBlocker(blocker, shot, kind, readiness.refresh, onNavigate)} />}
    {generationNeeded && readiness.error && <Alert type="warning" message={readiness.error} action={<Button size="small" onClick={readiness.refresh}>重新核对</Button>} />}
    {video && <CanvasVideoResolution shot={shot} eligibility={readiness.eligibility} />}
    {settingsDirty && <Alert type="warning" message="本镜视频设置有未保存修改，请先保存或放弃后再生成。" />}
    {!generationNeeded && <PetStoryGenerationBlockers blockers={readiness.eligibility?.blockers || []} onResolve={(blocker): void => resolveMediaBlocker(blocker, shot, kind, readiness.refresh, onNavigate)} />}
    {!generationNeeded && readiness.error && <Alert type="warning" message={readiness.error} action={<Button size="small" onClick={readiness.refresh}>重新核对</Button>} />}
    {video && <div className="canvas-media-actions">{!asset && <Button type="primary" size="small" loading={readiness.loading} icon={<PlayCircleOutlined />} disabled={disabled || waiting || settingsDirty || !readiness.eligibility?.ready} onClick={(): void => { void state.generateShotMedia(shot.id, kind); }}>{buttonText}</Button>}{asset && <Button size="small" onClick={(): void => { document.getElementById(`shot-media-${shot.id}-${kind}`)?.querySelector('video')?.focus(); }}>查看视频</Button>}</div>}
    <details className="petstory-secondary-tools"><summary>更多媒体操作</summary><div className="canvas-media-actions">
      {video && asset && <Button size="small" disabled={disabled || waiting || settingsDirty || !readiness.eligibility?.ready} onClick={(): void => { void state.generateShotMedia(shot.id, kind); }}>重新生成视频</Button>}
      {asset && <Button size="small" onClick={(): void => { void revealAsset(); }}>在文件夹中定位</Button>}
      {task && <Button size="small" disabled={!task.outputs.length || download === '正在重新下载原产物…'} onClick={(): void => { void redownload(); }}>重新下载</Button>}
    </div><PetStoryExistingMediaPicker project={project} shot={shot} kind={kind} disabled={disabled || waiting} /></details>
    {download && <p role="status">{download}</p>}
    {task && <button className="canvas-text-button" type="button" onClick={openTask}>打开对应豆包原会话 · {canvasJobLabel(task.status)}</button>}{step?.error && <p className="canvas-error">{step.error}</p>}
    <details className="canvas-provenance"><summary>诊断：模式与任务记录</summary><p>请求模式：{shot.requestedMode}；实际记录：{canvasActualMode(project, shot, tasks)}</p>{task && <p>任务：{task.id}</p>}</details>
  </div>;
};

function referenceName(project: PetStoryProject, asset: PetStoryAsset): string {
  if (asset.kind === 'scene') return '场景'; if (asset.kind === 'prop') return '道具';
  return (asset.characterIds || [asset.characterId]).map((id): string => project.plan?.characters.find((character): boolean => character.id === id)?.name || '').join('、');
}
function referenceApproved(project: PetStoryProject, asset: PetStoryAsset): boolean {
  return !!project.materials?.some((material): boolean => material.selectedAssetId === asset.id && journeyMaterialImageApproved(project, material));
}
export const CanvasReferenceStrip: React.FC<{ project: PetStoryProject; shot: PetStoryShot; onNavigate?: PetStoryMediaNavigate }> = ({ project, shot, onNavigate }): React.ReactElement => {
  const materialIds = new Set(project.materials?.filter((material): boolean => {
    if (material.kind === 'character') return shot.characterIds.includes(material.entityId);
    if (material.kind === 'prop') return !!shot.propIds?.includes(material.entityId);
    return shot.sceneId === material.entityId;
  }).map((material): string => material.selectedAssetId || ''));
  const references = project.assets.filter((asset): boolean => referenceApproved(project, asset) && (materialIds.has(asset.id) || !!shot.sceneReferenceAssetIds?.includes(asset.id)
    || (asset.kind === 'character' && shot.characterIds.some((id): boolean => project.plan?.characters.find((character): boolean => character.id === id)?.referenceAssetId === asset.id)))).sort((a, b): number => { const order = (asset: PetStoryAsset): number => { if (asset.kind !== 'character') return shot.characterIds.length + (asset.kind === 'prop' ? 1 : 2); return Math.min(...(asset.characterIds || [asset.characterId]).filter((id): id is string => !!id).map((id): number => { const index = shot.characterIds.indexOf(id); return index < 0 ? 999 : index; })); }; return order(a) - order(b); });
  const required = project.materials?.filter((material): boolean => material.kind === 'character' ? shot.characterIds.includes(material.entityId) : material.kind === 'prop' ? !!shot.propIds?.includes(material.entityId) : shot.sceneId === material.entityId) || [];
  const missing = required.filter((material): boolean => !project.assets.some((asset): boolean => asset.id === material.selectedAssetId && referenceApproved(project, asset)));
  return <div className="canvas-reference-strip"><strong>本镜素材 · 已采用 {references.length} · 缺图 {missing.length}</strong>{missing.map((material): React.ReactNode => <p key={material.id}>{material.name}：还没有已采用图片 {onNavigate && <Button size="small" onClick={(): void => onNavigate('materials', material.id)}>去补齐此素材</Button>}</p>)}{references.map((asset): React.ReactNode => <div key={asset.id}><CanvasMediaPreview project={project} asset={asset} name="选用的参考图片" /><span>{referenceName(project, asset)} · {referenceApproved(project, asset) ? '已确认' : '已有参考 · 待确认'}</span></div>)}{!references.length && <p>尚未选用确认素材</p>}</div>;
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
