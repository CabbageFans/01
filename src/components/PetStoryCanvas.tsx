import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, ConfigProvider, Tag, theme } from 'antd';
import { AimOutlined, ExpandOutlined, FileTextOutlined, PictureOutlined, PlayCircleOutlined, VideoCameraOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import type { PetStoryProject, PetStoryShot, PetStoryPromptKind } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import type { PetStoryJourneyStage } from '../utils/petstoryJourney';
import { CanvasPromptEditor as PromptEditor } from './PetStoryCanvasPrompt';
import { CanvasSubmissionDetails as SubmissionDetails, CanvasMediaNode as MediaNode, CanvasReferenceStrip as ReferenceStrip, canvasActualMode } from './PetStoryCanvasMedia';
import { usePetStoryCanvasViewport } from './usePetStoryCanvasViewport';
import { isCanvasPlanLocked as lockedPlan, canvasJobLabel as jobLabel } from './petStoryCanvasShared';
import '../styles/storyboard-canvas.css';

interface CanvasProps { view?: 'keyframes'|'videos'|'panorama'; activeShotId?: string; onNavigate?: (stage: PetStoryJourneyStage, shotId?: string, kind?: PetStoryPromptKind) => void; project: PetStoryProject; materials: React.ReactNode; controls: React.ReactNode; legacyDirty: boolean; onDirtyChange: (dirty: boolean) => void }

export const PetStoryCanvas: React.FC<CanvasProps> = ({ project, materials, controls, legacyDirty, onDirtyChange, view: stageView = 'panorama', activeShotId, onNavigate }): React.ReactElement => {
  const state = usePetStoryStore(); const tasks = useTaskStore((s) => s.tasks);
  const view = usePetStoryCanvasViewport(project.id);
  const { viewport, viewportRef, contentRef, zoom, fit, onPointerDown, onPointerMove, onPointerEnd } = view;
  const materialRef = useRef<HTMLDivElement>(null);
  const [materialDirty, setMaterialDirty] = useState(false);
  const [dirtyFields, setDirtyFields] = useState<Record<string, boolean>>({});
  const [activeShot, setActiveShot] = useState(project.plan?.shots[0]?.id || '');
  const materialOpen = false; const controlOpen = false;
  const dirtyChanged = React.useCallback((key: string, dirty: boolean): void => {
    setDirtyFields((old): Record<string, boolean> => {
      if (!!old[key] === dirty) return old;
      const next = { ...old }; if (dirty) next[key] = true; else delete next[key]; return next;
    });
  }, []);
  useEffect(() => {
    const host = materialRef.current; if (!host) return;
    const readDirty = (): void => setMaterialDirty(!!host.querySelector('[data-dirty="true"]'));
    readDirty(); const observer = new MutationObserver(readDirty);
    observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-dirty'] });
    return (): void => observer.disconnect();
  }, [project.id]);
  const ownDirty = materialDirty || Object.values(dirtyFields).some(Boolean);
  const dirty = legacyDirty || ownDirty;
  useEffect((): void => { onDirtyChange(ownDirty); }, [ownDirty, onDirtyChange]);
  const disabled = state.busy || lockedPlan(project) || legacyDirty;
  const targetDirty = (shotId: string, kind: PetStoryPromptKind): boolean => legacyDirty || !!dirtyFields[`${project.id}:${shotId}:${kind}`];
  const promptTotal = project.plan?.shots.reduce((sum, shot): number => sum + (shot.prompts.lastFrame ? 3 : 2), 0) || 0;
  const focus = (id: string): void => { setActiveShot(id); if (stageView === 'panorama') view.focus(id); else requestAnimationFrame((): void => { document.querySelector(`[data-shot-id="${id}"]`)?.scrollIntoView({block:'start',behavior:'smooth'}); }); };
  useEffect((): void => { if (activeShotId) setActiveShot(activeShotId); }, [activeShotId]);
  const mediaNavigate = (target: 'materials'|'keyframes'|'videoPrompt'|'plan', id?: string, kind?: PetStoryPromptKind): void => { onNavigate?.(target === 'videoPrompt' ? 'videos' : target, id, kind); if (target === 'keyframes' || target === 'videoPrompt') focus(id || activeShot); if (id && kind) requestAnimationFrame((): void => { document.getElementById(`shot-media-${id}-${kind}`)?.scrollIntoView({block:'center',behavior:'smooth'}); }); };
  const pendingJobs = project.jobs.filter((j): boolean => !j.endedWaitingAt && ['bound', 'captured'].includes(j.status));
  const renderStory = (): React.ReactElement => <div className="canvas-story-column"><article className="canvas-node canvas-story"><header><FileTextOutlined /><strong>故事卡</strong></header><div className="canvas-node-body"><label>原始剧本</label><p className="whitespace-pre-wrap">{project.mobileStory?.text || '尚未输入剧本'}</p><Button onClick={(): void => onNavigate?.('script')}>查看／编辑原剧本</Button><label>当前采用故事</label><p className="whitespace-pre-wrap">{project.plan?.adaptedStory || '尚未采用方案，请先分析剧本并查看结果。'}</p><Button onClick={(): void => onNavigate?.('plan')}>查看并确认方案</Button></div></article><article className="canvas-node"><header><PictureOutlined /><strong>基础素材</strong></header><div className="canvas-node-body"><p>人物 {project.plan?.characters.length || 0} · 道具 {project.plan?.props?.length || 0} · 场景 {project.plan?.scenes?.length || 0}</p><Button onClick={(): void => onNavigate?.('materials')}>查看并准备基础素材</Button></div></article></div>;
  const renderShot = (shot: PetStoryShot): React.ReactElement => <div className={`canvas-shot-row ${activeShot === shot.id ? 'is-focused' : ''}`} key={shot.id} data-shot-id={shot.id} onFocus={(): void => setActiveShot(shot.id)}>
          <article className="canvas-node"><header><span className="canvas-shot-number">{String(shot.order).padStart(2, '0')}</span><strong>分镜 {shot.order}</strong><span className="canvas-duration">{shot.durationSeconds}s</span><button type="button" aria-label={`聚焦镜头${shot.order}`} onClick={(): void => focus(shot.id)}><AimOutlined /></button></header><div className="canvas-node-body"><div className="canvas-scene"><strong>{shot.scene}</strong><span>{shot.sceneView || '景别未填写'}</span></div><div className="canvas-cast">{shot.characterIds.map((id): React.ReactNode => <Tag key={id}>{project.plan?.characters.find((c): boolean => c.id === id)?.name || id}</Tag>)}{shot.propIds?.map((id): React.ReactNode => <Tag key={id} color="cyan">{project.plan?.props?.find((p): boolean => p.id === id)?.name || id}</Tag>)}</div><details className="canvas-shot-context"><summary>剧情、起止状态与原台词</summary>{shot.narrativePurpose && <p>镜头职责：{shot.narrativePurpose}</p>}{shot.sourceRefs?.length ? <p>来源落实：{shot.sourceRefs.join('、')}</p> : null}{shot.framing && <p>景别与机位：{shot.framing}</p>}{shot.blocking && <p>调度：{shot.blocking}</p>}{shot.continuity && <p>空间与状态连续性：{shot.continuity}</p>}<p>动作：{shot.action}</p>{shot.performance && <p>表演：{shot.performance}</p>}{shot.timing && <p>动作与对白时长：{shot.timing}</p>}{shot.sound && <p>声音：{shot.sound}</p>}<p>起点：{shot.startState}</p><p>终态：{shot.endState}</p>{shot.dialogue?.map((d, i): React.ReactNode => <p key={i}>{project.plan?.characters.find((c): boolean => c.id === d.speakerId)?.name || d.speakerId}：{d.text} · {d.tone} / {d.pace}</p>)}</details><PromptEditor project={project} shot={shot} kind="firstFrame" disabled={state.busy || lockedPlan(project)} generationBlocked={targetDirty(shot.id,'firstFrame')} dirtyChanged={dirtyChanged} />{shot.prompts.lastFrame && <PromptEditor project={project} shot={shot} kind="lastFrame" disabled={state.busy || lockedPlan(project)} generationBlocked={targetDirty(shot.id,'lastFrame')} dirtyChanged={dirtyChanged} />}<SubmissionDetails project={project} shot={shot} kind="firstFrame" dirty={targetDirty(shot.id,'firstFrame')} /></div></article>
          <article className="canvas-node"><header><PictureOutlined /><strong>关键帧图片</strong><span className="canvas-small-label">独立生图</span></header><div className="canvas-node-body"><MediaNode project={project} shot={shot} kind="firstFrame" disabled={disabled || targetDirty(shot.id,'firstFrame')} onNavigate={mediaNavigate} />{shot.prompts.lastFrame && <MediaNode project={project} shot={shot} kind="lastFrame" disabled={disabled || targetDirty(shot.id,'lastFrame')} onNavigate={mediaNavigate} />}<ReferenceStrip project={project} shot={shot} onNavigate={mediaNavigate} /></div></article>
          <article className="canvas-node"><header><VideoCameraOutlined /><strong>视频提示词 / 运镜</strong><span className="canvas-duration">{shot.durationSeconds}s</span></header><div className="canvas-node-body"><div className="canvas-mode"><span>请求 <b>{{auto:"自动选择",first_frame:"首帧",first_last_frame:"首尾帧",reference:"多参考"}[shot.requestedMode]}</b></span><span>实际 <b>{canvasActualMode(project, shot, tasks)}</b></span></div><PromptEditor project={project} shot={shot} kind="video" disabled={state.busy || lockedPlan(project)} generationBlocked={targetDirty(shot.id,'video')} dirtyChanged={dirtyChanged} /><p className="canvas-hint">{shot.camera || '运镜以最终正文为准'} · {shot.transition === 'continue' ? '延续上一镜' : '正常切镜'} · 请求 {shot.durationSeconds} 秒</p><SubmissionDetails project={project} shot={shot} kind="video" dirty={targetDirty(shot.id,'video')} /></div></article>
          <article className="canvas-node"><header><PlayCircleOutlined /><strong>镜头视频</strong><span className="canvas-small-label">独立生成</span></header><div className="canvas-node-body"><MediaNode project={project} shot={shot} kind="video" disabled={disabled || targetDirty(shot.id,'video')} onNavigate={mediaNavigate} /><p className="canvas-hint">当前只交付逐镜素材，完整短剧合成尚未实现。</p></div></article>
        </div>;
  const renderToolbar = (): React.ReactElement => <div className="canvas-toolbar"><div className="canvas-project-title"><span className="canvas-project-mark"><FileTextOutlined /></span><div><strong>{state.projectName || '分镜生产画布'}</strong><small>{project.plan?.shots.length || 0} 个镜头 · {promptTotal} 项镜头提示词</small></div><Tag color={dirty ? 'orange' : 'cyan'}>{dirty ? '有未保存内容' : `已保存 v${project.revision}`}</Tag></div><div className="canvas-toolbar-actions"><Button onClick={(): void => onNavigate?.('materials')}>准备基础素材</Button><Button onClick={(): void => onNavigate?.('plan')}>查看方案</Button><details><summary>重新生成选项</summary><p>重新请求全部 {promptTotal} 项镜头提示词（首帧、必要尾帧和视频），不含基础素材。不生成媒体；保留手改正文，新回复可对比采用。</p><Button disabled={disabled || ownDirty || !state.freeChatConfirmed || !!pendingJobs.length} onClick={(): void => { void state.regenerateAllPrompts(); }}>重新生成全部镜头提示词（{promptTotal}项）</Button></details></div></div>;
  const renderStatusbar = (): React.ReactElement => <div className="canvas-statusbar"><span>文字生成不启动图片或视频</span>{state.promptBatch.status !== 'idle' && <span>本批 {state.promptBatch.completed} / {state.promptBatch.total} 项{state.promptBatch.status === 'running' ? <button type="button" className="canvas-text-button" onClick={state.stopPromptBatch}>停止后续文字请求</button> : state.promptBatch.status === 'complete' ? ' · 已保存' : ' · 已停止后续请求'}</span>}{pendingJobs.length > 0 && <span className="canvas-live-status">● 普通 Chat {jobLabel(tasks.find((t): boolean => t.id === pendingJobs[0].taskId)?.status)}</span>}<div className="canvas-zoom"><button type="button" aria-label="缩小画布" onClick={(): void => zoom(1 / 1.2)}><ZoomOutOutlined /></button><button type="button" onClick={view.reset}>{Math.round(viewport.scale * 100)}%</button><button type="button" aria-label="放大画布" onClick={(): void => zoom(1.2)}><ZoomInOutlined /></button><button type="button" onClick={fit} title="适应完整画布"><ExpandOutlined /> 适应</button><button type="button" onClick={(): void => focus(activeShot)}><AimOutlined /> 聚焦</button></div></div>;
  return <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: '#0caa9a', colorText: '#253545', colorBgContainer: '#fff', colorBorder: '#dce4e6', borderRadius: 9, fontSize: 13 }, components: { Button: { colorPrimary: '#0caa9a', algorithm: true } } }}><div className={`storyboard-workspace canvas-stage-${stageView}`}>
    <div className="canvas-sticky-head">{renderToolbar()}{renderStatusbar()}</div>
    <div className="canvas-inline-panel" aria-label="同页基础素材" ref={materialRef} style={{ display: materialOpen ? undefined : 'none' }}>{materials}</div><div className="canvas-inline-panel" aria-label="同页制作控制" style={{ display: controlOpen ? undefined : 'none' }}>{controls}</div>
    <div className="canvas-viewport" ref={viewportRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onLostPointerCapture={onPointerEnd} style={{ backgroundSize: `${20 * viewport.scale}px ${20 * viewport.scale}px`, backgroundPosition: `${viewport.x}px ${viewport.y}px` }}>
      <div className="canvas-content" ref={contentRef} style={stageView === 'panorama' ? { transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` } : undefined}>
        <div className="canvas-column-titles"><span>故事 / 创作依据</span><span>01 分镜及生图提示词</span><span>02 首帧 / 尾帧图片</span><span>03 视频提示词 / 运镜</span><span>04 镜头视频</span></div>
        {renderStory()}
        <div className="canvas-shot-rows">{project.plan?.shots.map(renderShot)}</div>
      </div><div className="canvas-navigation"><span>镜头</span>{project.plan?.shots.map((shot): React.ReactNode => <button type="button" key={shot.id} className={activeShot === shot.id ? 'active' : ''} onClick={(): void => focus(shot.id)}>{String(shot.order).padStart(2, '0')}</button>)}<span className="canvas-navigation-hint">拖动空白平移 · ⌘ / Ctrl + 滚轮缩放</span></div>
    </div>{dirty && <Alert type="warning" message="具体未保存对象见页面上方；请先保存该对象再生成它的内容。无关目标仍可继续，新的 Chat 回复不会覆盖草稿。" />}
  </div></ConfigProvider>;
};
