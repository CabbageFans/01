import React, { useEffect, useState } from 'react';
import { Button, ConfigProvider, Modal, Tag, theme } from 'antd';
import { AimOutlined, ExpandOutlined, FileTextOutlined, PictureOutlined, PlayCircleOutlined, VideoCameraOutlined, LoadingOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import type { PetStoryProject, PetStoryShot, PetStoryPromptKind, PetStoryChatJob, PetStoryPromptBatch } from '@doubao-studio/contracts';
import { petStoryPromptActionTargets, usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import type { PetStoryJourneyStage } from '../utils/petstoryJourney';
import { CanvasPromptEditor as PromptEditor } from './PetStoryCanvasPrompt';
import { CanvasMediaNode as MediaNode, CanvasReferenceStrip as ReferenceStrip } from './PetStoryCanvasMedia';
import { usePetStoryCanvasViewport } from './usePetStoryCanvasViewport';
import { isCanvasPlanLocked as lockedPlan, petStoryVideoRecoveryMessage } from './petStoryCanvasShared';
import '../styles/storyboard-canvas.css';

interface CanvasProps { view?: 'keyframes'|'videos'|'panorama'; activeShotId?: string; onNavigate?: (stage: PetStoryJourneyStage, shotId?: string, kind?: PetStoryPromptKind) => void; project: PetStoryProject; promptTargets?: PetStoryPromptBatch['targets']; materials: React.ReactNode; controls: React.ReactNode; legacyDirty: boolean; onDirtyChange: (dirty: boolean) => void }

type CanvasPromptTarget = { shotId: string; kind: PetStoryPromptKind };
const promptKindNames: Record<PetStoryPromptKind, string> = { firstFrame: '首帧提示词', lastFrame: '尾帧提示词', video: '视频提示词' };
function shotPromptTargets(project: PetStoryProject, targets: PetStoryPromptBatch['targets']): CanvasPromptTarget[] {
  const valid = targets.filter((target): target is CanvasPromptTarget => !target.materialId && !!target.shotId && !!target.kind
    && !!project.plan?.shots.find((shot): boolean => shot.id === target.shotId)?.prompts[target.kind]);
  return [...new Map(valid.map((target): [string, CanvasPromptTarget] => [`${target.shotId}:${target.kind}`, target])).values()];
}
function savedShotPromptBatch(project: PetStoryProject): PetStoryPromptBatch | undefined {
  const saved = project.promptBatch;
  if (!saved || saved.status === 'complete') return undefined;
  // scope尚未写入的旧镜头批次沿用原服务兼容条件，不能把基础素材批次混进画布。
  return saved.scope === 'shots' || saved.targets.length > 0 && saved.targets.every((target): boolean => !!target.shotId && !target.materialId) ? saved : undefined;
}
function targetHasOriginalWork(project: PetStoryProject, target: CanvasPromptTarget): boolean {
  return project.jobs.some((job): boolean => job.shotId === target.shotId && job.promptKind === target.kind && !job.materialId && !job.endedWaitingAt
    && (['bound', 'captured', 'invalid'].includes(job.status) || job.status === 'applied' && job.resultStatus === 'candidate' && !!job.parsedResult?.optimized?.trim()));
}
/** 按既有批次和父页面只读资格快照说明范围；这里不查询、不生成、不重写正文。 */
function canvasPromptTargets(project: PetStoryProject, inspected: PetStoryPromptBatch['targets'] | undefined): CanvasPromptTarget[] {
  const saved = savedShotPromptBatch(project);
  if (saved) {
    const targets = [...saved.targets]; const job = project.jobs.find((item): boolean => item.id === saved.jobId);
    if (job?.shotId && job.promptKind && !job.endedWaitingAt && ['bound', 'captured', 'invalid'].includes(job.status)) targets.push({ shotId: job.shotId, kind: job.promptKind });
    return shotPromptTargets(project, targets);
  }
  const proposed = inspected ?? (project.plan?.shots || []).flatMap((shot): CanvasPromptTarget[] => (['firstFrame', 'lastFrame', 'video'] as const)
    .filter((kind): boolean => !!shot.prompts[kind]).map((kind): CanvasPromptTarget => ({ shotId: shot.id, kind })));
  const missing = shotPromptTargets(project, proposed).filter((target): boolean => !project.plan?.shots.find((shot): boolean => shot.id === target.shotId)?.prompts[target.kind]?.final.trim() && !targetHasOriginalWork(project, target));
  return shotPromptTargets(project, petStoryPromptActionTargets({ ...project, promptBatch: undefined }, missing));
}

function isFeedbackJob(project: PetStoryProject, job: PetStoryChatJob): boolean {
  let current: PetStoryChatJob | undefined = job; const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.promptFeedback) return true;
    seen.add(current.id); const parentId: string | undefined = current.parentJobId;
    current = parentId ? project.jobs.find((item): boolean => item.id === parentId) : undefined;
  }
  return false;
}
function canvasProgress(project: PetStoryProject, batch: { status: string; completed: number; total: number }, pendingJobs: PetStoryChatJob[], candidateCount: number): { text: string; active: boolean } {
  if (batch.status === 'running') return { text: `已生成 ${batch.completed}/${batch.total}`, active: false };
  if (pendingJobs.some((job): boolean => isFeedbackJob(project, job))) return { text: '正在修改…', active: true };
  if (pendingJobs.length) return { text: '正在生成…', active: true };
  if (batch.status === 'complete' && candidateCount) return { text: '已生成，待确认', active: false };
  return { text: batch.status === 'paused' ? `已生成 ${batch.completed}/${batch.total} · 待继续` : '', active: false };
}

export const PetStoryCanvas: React.FC<CanvasProps> = ({ project, promptTargets, legacyDirty, onDirtyChange, view: stageView = 'panorama', activeShotId, onNavigate }): React.ReactElement => {
  const state = usePetStoryStore(); const tasks = useTaskStore((store) => store.tasks);
  const generationError = petStoryVideoRecoveryMessage(state.error);
  const view = usePetStoryCanvasViewport(project.id);
  const { viewport, viewportRef, contentRef, zoom, onPointerDown, onPointerMove, onPointerEnd, focus: focusViewport } = view;
  const [dirtyFields, setDirtyFields] = useState<Record<string, boolean>>({});
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [activeShot, setActiveShot] = useState(project.plan?.shots[0]?.id || '');
  const dirtyChanged = React.useCallback((key: string, dirty: boolean): void => {
    setDirtyFields((old): Record<string, boolean> => {
      if (!!old[key] === dirty) return old;
      const next = { ...old }; if (dirty) next[key] = true; else delete next[key]; return next;
    });
  }, []);
  const ownDirty = Object.values(dirtyFields).some(Boolean);
  const dirty = legacyDirty || ownDirty;
  useEffect((): void => { onDirtyChange(ownDirty); }, [ownDirty, onDirtyChange]);
  const disabled = state.busy || lockedPlan(project) || legacyDirty;
  const targetDirty = (shotId: string, kind: PetStoryPromptKind): boolean => legacyDirty || !!dirtyFields[`${project.id}:${shotId}:${kind}`];
  const focus = (id: string): void => { setActiveShot(id); focusViewport(id); };
  useEffect(() => { if (!activeShotId) return; setActiveShot(activeShotId); const frame = requestAnimationFrame((): void => focusViewport(activeShotId)); return (): void => cancelAnimationFrame(frame); }, [activeShotId, focusViewport]);
  const pendingJobs = project.jobs.filter((job): boolean => !!job.shotId && !job.materialId && !job.endedWaitingAt && ['bound', 'captured'].includes(job.status) && tasks.some((task): boolean => task.id === job.taskId && task.mode === 'chat' && (!job.runId || job.runId === task.runtime?.runId) && ['executing', 'generating', 'manual_submission_observing'].includes(task.status)));
  const batch = state.promptBatch;
  const batchCandidates = (project.promptBatch?.candidateJobIds || []).filter((id): boolean => project.jobs.some((job): boolean => job.id === id && job.status === 'applied' && job.resultStatus === 'candidate'));
  const generating = batch.status === 'running';
  const generationTargets = canvasPromptTargets(project, promptTargets);
  const targetLabels = generationTargets.map((target): string => `镜头 ${project.plan?.shots.find((shot): boolean => shot.id === target.shotId)?.order} · ${promptKindNames[target.kind]}`);
  const generationScope = targetLabels.join('；');
  const hasSavedText = project.plan?.shots.some((shot): boolean => Object.values(shot.prompts).some((prompt): boolean => !!prompt?.final.trim()));
  const generationLabel = generating ? '正在生成提示词' : `${savedShotPromptBatch(project) || hasSavedText ? '补齐提示词' : '生成镜头提示词'}（${generationTargets.length}项）`;
  const progress = canvasProgress(project, batch, pendingJobs, batchCandidates.length);
  const manualReplacements = batchCandidates.flatMap((id): string[] => {
    const job = project.jobs.find((item): boolean => item.id === id);
    const shot = project.plan?.shots.find((item): boolean => item.id === job?.shotId);
    const prompt = job?.promptKind ? shot?.prompts[job.promptKind] : undefined;
    return prompt?.edited && !!prompt.final && prompt.final !== job?.parsedResult?.optimized ? [`镜头 ${shot?.order} · ${{ firstFrame: '首帧提示词', lastFrame: '尾帧提示词', video: '视频提示词' }[job?.promptKind || 'firstFrame']}`] : [];
  });
  const adoptBatch = (): void => {
    if (manualReplacements.length) setConfirmBatch(true);
    else void state.adoptPromptBatchCandidates();
  };
  const renderStory = (): React.ReactElement => <div className="canvas-story-column"><article className="canvas-node canvas-story"><header><FileTextOutlined /><strong>故事卡</strong></header><div className="canvas-node-body"><label>原始剧本</label><p className="canvas-story-summary whitespace-pre-wrap">{project.mobileStory?.text || '尚未输入剧本'}</p><Button onClick={(): void => onNavigate?.('script')}>查看／编辑原剧本</Button><label>当前采用故事</label><p className="canvas-story-summary whitespace-pre-wrap">{project.plan?.adaptedStory || '尚未采用方案，请先分析剧本并查看结果。'}</p><Button onClick={(): void => onNavigate?.('plan')}>查看并确认方案</Button></div></article><article className="canvas-node"><header><PictureOutlined /><strong>基础素材</strong></header><div className="canvas-node-body"><p>人物 {project.plan?.characters.length || 0} · 道具 {project.plan?.props?.length || 0} · 场景 {project.plan?.scenes?.length || 0}</p><Button onClick={(): void => onNavigate?.('materials')}>查看并准备基础素材</Button></div></article></div>;
  const renderShot = (shot: PetStoryShot): React.ReactElement => <div className={`canvas-shot-row ${activeShot === shot.id ? 'is-focused' : ''}`} key={shot.id} data-shot-id={shot.id} onFocus={(): void => setActiveShot(shot.id)}>
          <article className="canvas-node"><header><span className="canvas-shot-number">{String(shot.order).padStart(2, '0')}</span><strong>分镜 {shot.order}</strong><span className="canvas-duration">{shot.durationSeconds}s</span><button type="button" aria-label={`聚焦镜头${shot.order}`} onClick={(): void => focus(shot.id)}><AimOutlined /></button></header><div className="canvas-node-body"><div className="canvas-scene"><strong>{shot.scene}</strong><span>{shot.sceneView || '景别未填写'}</span></div><div className="canvas-cast">{shot.characterIds.map((id): React.ReactNode => <Tag key={id}>{project.plan?.characters.find((c): boolean => c.id === id)?.name || id}</Tag>)}{shot.propIds?.map((id): React.ReactNode => <Tag key={id} color="cyan">{project.plan?.props?.find((p): boolean => p.id === id)?.name || id}</Tag>)}</div><details className="canvas-shot-context"><summary>剧情、起止状态与原台词</summary>{shot.narrativePurpose && <p>镜头职责：{shot.narrativePurpose}</p>}{shot.sourceRefs?.length ? <p>来源落实：{shot.sourceRefs.join('、')}</p> : null}{shot.framing && <p>景别与机位：{shot.framing}</p>}{shot.blocking && <p>调度：{shot.blocking}</p>}{shot.continuity && <p>空间与状态连续性：{shot.continuity}</p>}<p>动作：{shot.action}</p>{shot.performance && <p>表演：{shot.performance}</p>}{shot.timing && <p>动作与对白时长：{shot.timing}</p>}{shot.sound && <p>声音：{shot.sound}</p>}<p>起点：{shot.startState}</p><p>终态：{shot.endState}</p>{shot.dialogue?.map((d, i): React.ReactNode => <p key={i}>{project.plan?.characters.find((c): boolean => c.id === d.speakerId)?.name || d.speakerId}：{d.text} · {d.tone} / {d.pace}</p>)}</details><PromptEditor project={project} shot={shot} kind="firstFrame" disabled={false} generationBlocked={targetDirty(shot.id,'firstFrame')} dirtyChanged={dirtyChanged} />{shot.prompts.lastFrame && <PromptEditor project={project} shot={shot} kind="lastFrame" disabled={false} generationBlocked={targetDirty(shot.id,'lastFrame')} dirtyChanged={dirtyChanged} />}</div></article>
          <article className="canvas-node"><header><PictureOutlined /><strong>关键帧图片</strong><span className="canvas-small-label"></span></header><div className="canvas-node-body"><MediaNode project={project} shot={shot} kind="firstFrame" disabled={state.busy || legacyDirty || targetDirty(shot.id,'firstFrame')} />{shot.prompts.lastFrame && <MediaNode project={project} shot={shot} kind="lastFrame" disabled={state.busy || legacyDirty || targetDirty(shot.id,'lastFrame')} />}<ReferenceStrip project={project} shot={shot} /></div></article>
          <article className="canvas-node"><header><VideoCameraOutlined /><strong>视频提示词 / 运镜</strong><span className="canvas-duration">{shot.durationSeconds}s</span></header><div className="canvas-node-body"><PromptEditor project={project} shot={shot} kind="video" disabled={false} generationBlocked={targetDirty(shot.id,'video')} dirtyChanged={dirtyChanged} /><p className="canvas-hint">{shot.camera || '运镜以最终正文为准'} · {shot.transition === 'continue' ? '延续上一镜' : '正常切镜'} · 请求 {shot.durationSeconds} 秒</p></div></article>
          <article className="canvas-node"><header><PlayCircleOutlined /><strong>镜头视频</strong><span className="canvas-small-label"></span></header><div className="canvas-node-body"><MediaNode project={project} shot={shot} kind="video" disabled={disabled || targetDirty(shot.id,'video')} /></div></article>
        </div>;
  const renderToolbar = (): React.ReactElement => <div className="canvas-toolbar">
    <div className="canvas-project-title"><strong title={state.projectName}>{state.projectName || '分镜画布'}</strong><span>{project.plan?.shots.length || 0} 个镜头</span></div>
    <div className="canvas-toolbar-actions">
      {(generating || generationTargets.length > 0) && <Button type="primary" title={generationScope ? `生成镜头文字：${generationScope}` : '当前镜头提示词批次正在生成'} loading={generating} disabled={state.busy || dirty || generating} onClick={(): void => { void state.generateCanvasPrompts(); }}>{generationLabel}</Button>}
      {generationTargets.length > 0 && <small className="canvas-small-label" title={generationScope}>提示词：{targetLabels.slice(0, 2).join('；')}{targetLabels.length > 2 ? `等 ${targetLabels.length} 项` : ''}</small>}
      {batch.status !== 'running' && batchCandidates.length > 0 && <Button disabled={state.busy || dirty} onClick={adoptBatch}>确认本次结果</Button>}
      <span className={`canvas-batch-progress ${generationError ? 'canvas-error' : ''}`} role={generationError ? 'alert' : 'status'} title={generationError || undefined}>{generationError ? generationError.slice(0, 72) : <>{progress.active && <LoadingOutlined spin />} {progress.text}</>}</span>
    </div>
    <div className="canvas-zoom"><button type="button" aria-label="缩小画布" onClick={(): void => zoom(1 / 1.2)}><ZoomOutOutlined /></button><button type="button" onClick={(): void => focus(activeShot)} title="恢复可读视角">{Math.round(viewport.scale * 100)}%</button><button type="button" aria-label="放大画布" onClick={(): void => zoom(1.2)}><ZoomInOutlined /></button><button type="button" onClick={(): void => focus(activeShot)} title="适应当前镜头"><ExpandOutlined /> 适应</button><button type="button" onClick={(): void => focus(activeShot)}><AimOutlined /> 定位镜头</button></div>
  </div>;
  return <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: '#087F72', colorText: '#202A35', colorBgContainer: '#fff', colorBorder: '#E3E8EB', borderRadius: 8, fontSize: 14 }, components: { Button: { colorPrimary: '#087F72', algorithm: true } } }}><div className={`storyboard-workspace canvas-stage-${stageView}`}>
    {renderToolbar()}
    {confirmBatch && <Modal title="确认替换手改正文" open onCancel={(): void => setConfirmBatch(false)} okText="确认使用本次结果" cancelText="取消" confirmLoading={state.busy} onOk={(): void => { void state.adoptPromptBatchCandidates().then((): void => { if (!usePetStoryStore.getState().error) setConfirmBatch(false); }); }}>
      <p>本次结果将替换以下手改正文，原版本保留：</p>{generationError && <p className="canvas-error" role="alert">{generationError}</p>}<ul>{manualReplacements.map((name): React.ReactNode => <li key={name}>{name}</li>)}</ul>
    </Modal>}
    <div className="canvas-viewport" ref={viewportRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onLostPointerCapture={onPointerEnd} style={{ backgroundSize: `${20 * viewport.scale}px ${20 * viewport.scale}px`, backgroundPosition: `${viewport.x}px ${viewport.y}px` }}>
      <div className="canvas-content" ref={contentRef} style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}>
        <div className="canvas-column-titles"><span>故事与基础素材</span><span>分镜 / 生图提示词</span><span>首帧 / 可选尾帧</span><span>视频提示词 / 运镜</span><span>镜头视频</span></div>
        {renderStory()}
        <div className="canvas-shot-rows">{project.plan?.shots.map(renderShot)}</div>
      </div><div className="canvas-navigation"><span>镜头</span>{project.plan?.shots.map((shot): React.ReactNode => <button type="button" key={shot.id} className={activeShot === shot.id ? 'active' : ''} onClick={(): void => focus(shot.id)}>{String(shot.order).padStart(2, '0')}</button>)}<span className="canvas-navigation-hint">拖动空白平移 · ⌘ / Ctrl + 滚轮缩放</span></div>
    </div>
  </div></ConfigProvider>;
};
