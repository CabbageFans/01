import React, { useEffect, useState } from 'react';
import { petStoryTimingText } from '../utils/petstoryTiming';
import { ConfigProvider, Tag, theme } from 'antd';
import { AimOutlined, FileTextOutlined, PictureOutlined, PlayCircleOutlined, VideoCameraOutlined } from '@ant-design/icons';
import type { PetStoryProject, PetStoryShot, PetStoryPromptKind } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';
import type { PetStoryJourneyStage } from '../utils/petstoryJourney';
import { CanvasPromptEditor as PromptEditor } from './PetStoryCanvasPrompt';
import { CanvasMediaNode as MediaNode, CanvasReferenceStrip as ReferenceStrip } from './PetStoryCanvasMedia';
import { usePetStoryCanvasViewport } from './usePetStoryCanvasViewport';
import '../styles/storyboard-canvas.css';

interface CanvasProps { view?: 'keyframes'|'videos'|'panorama'; activeShotId?: string; onNavigate?: (stage: PetStoryJourneyStage, shotId?: string, kind?: PetStoryPromptKind) => void; project: PetStoryProject; materials: React.ReactNode; controls: React.ReactNode; legacyDirty: boolean; onDirtyChange: (dirty: boolean) => void }

export const PetStoryCanvas: React.FC<CanvasProps> = ({ project, legacyDirty, onDirtyChange, view: stageView = 'panorama', activeShotId }): React.ReactElement => {
  const state = usePetStoryStore();
  const view = usePetStoryCanvasViewport(project.id);
  const { viewport, viewportRef, contentRef, onPointerDown, onPointerMove, onPointerEnd, focus: focusViewport } = view;
  const [dirtyFields, setDirtyFields] = useState<Record<string, boolean>>({});
  const [activeShot, setActiveShot] = useState(project.plan?.shots[0]?.id || '');
  const dirtyChanged = React.useCallback((key: string, dirty: boolean): void => {
    setDirtyFields((old): Record<string, boolean> => {
      if (!!old[key] === dirty) return old;
      const next = { ...old }; if (dirty) next[key] = true; else delete next[key]; return next;
    });
  }, []);
  const ownDirty = Object.values(dirtyFields).some(Boolean);
  useEffect((): void => { onDirtyChange(ownDirty); }, [ownDirty, onDirtyChange]);
  // 视频启动只看当前操作与草稿；方案编辑保护不能用作执行占用，正式服务继续核验原任务。
  const videoStartDisabled = state.busy || legacyDirty;
  const targetDirty = (shotId: string, kind: PetStoryPromptKind): boolean => legacyDirty || !!dirtyFields[`${project.id}:${shotId}:${kind}`];
  const focus = (id: string): void => { setActiveShot(id); focusViewport(id); };
  useEffect(() => { if (!activeShotId) return; setActiveShot(activeShotId); const frame = requestAnimationFrame((): void => focusViewport(activeShotId)); return (): void => cancelAnimationFrame(frame); }, [activeShotId, focusViewport]);
  const renderStory = (): React.ReactElement => <div className="canvas-story-column">
    <article className="canvas-node canvas-story">
      <header><FileTextOutlined /><strong>故事卡</strong></header>
      <div className="canvas-node-body">
        <label>原始剧本</label><p className="canvas-story-summary whitespace-pre-wrap">{project.mobileStory?.text || '尚未输入剧本'}</p>
        <label>当前采用故事</label><p className="canvas-story-summary whitespace-pre-wrap">{project.plan?.adaptedStory || '尚未采用方案，请先分析剧本并查看结果。'}</p>
      </div>
    </article>
  </div>;
  const renderShot = (shot: PetStoryShot): React.ReactElement => <div className={`canvas-shot-row ${activeShot === shot.id ? 'is-focused' : ''}`} key={shot.id} data-shot-id={shot.id} onFocus={(): void => setActiveShot(shot.id)}>
          <article className="canvas-node"><header><span className="canvas-shot-number">{String(shot.order).padStart(2, '0')}</span><strong>分镜 {shot.order}</strong><span className="canvas-duration">{shot.durationSeconds}s</span><button type="button" aria-label={`聚焦镜头${shot.order}`} onClick={(): void => focus(shot.id)}><AimOutlined /></button></header><div className="canvas-node-body"><div className="canvas-scene"><strong>{shot.scene}</strong><span>{shot.sceneView || '景别未填写'}</span></div><div className="canvas-cast">{shot.characterIds.map((id): React.ReactNode => <Tag key={id}>{project.plan?.characters.find((c): boolean => c.id === id)?.name || id}</Tag>)}{shot.propIds?.map((id): React.ReactNode => <Tag key={id} color="cyan">{project.plan?.props?.find((p): boolean => p.id === id)?.name || id}</Tag>)}</div><details className="canvas-shot-context"><summary>剧情、起止状态与原台词</summary>{shot.narrativePurpose && <p>镜头职责：{shot.narrativePurpose}</p>}{shot.sourceRefs?.length ? <p>来源落实：{shot.sourceRefs.join('、')}</p> : null}{shot.framing && <p>景别与机位：{shot.framing}</p>}{shot.blocking && <p>调度：{shot.blocking}</p>}{shot.continuity && <p>空间与状态连续性：{shot.continuity}</p>}<p>动作：{shot.action}</p>{shot.performance && <p>表演：{shot.performance}</p>}{petStoryTimingText(shot) && <p>动作与对白时长：{petStoryTimingText(shot)}</p>}{shot.timingPlan && <p>时长依据：{shot.timingPlan.durationReason} · 切出：{shot.timingPlan.cutReason}</p>}{shot.sound && <p>声音：{shot.sound}</p>}<p>起点：{shot.startState}</p><p>终态：{shot.endState}</p>{shot.dialogue?.map((d, i): React.ReactNode => <p key={i}>{project.plan?.characters.find((c): boolean => c.id === d.speakerId)?.name || d.speakerId}：{d.text} · {d.tone} / {d.pace}</p>)}</details><PromptEditor project={project} shot={shot} kind="firstFrame" disabled={false} generationBlocked={targetDirty(shot.id,'firstFrame')} dirtyChanged={dirtyChanged} />{shot.prompts.lastFrame && <PromptEditor project={project} shot={shot} kind="lastFrame" disabled={false} generationBlocked={targetDirty(shot.id,'lastFrame')} dirtyChanged={dirtyChanged} />}</div></article>
          <article className="canvas-node"><header><PictureOutlined /><strong>关键帧图片</strong><span className="canvas-small-label"></span></header><div className="canvas-node-body"><MediaNode project={project} shot={shot} kind="firstFrame" disabled={state.busy || legacyDirty || targetDirty(shot.id,'firstFrame')} />{shot.prompts.lastFrame && <MediaNode project={project} shot={shot} kind="lastFrame" disabled={state.busy || legacyDirty || targetDirty(shot.id,'lastFrame')} />}<ReferenceStrip project={project} shot={shot} /></div></article>
          <article className="canvas-node"><header><VideoCameraOutlined /><strong>视频提示词 / 运镜</strong><span className="canvas-duration">{shot.durationSeconds}s</span></header><div className="canvas-node-body"><PromptEditor project={project} shot={shot} kind="video" disabled={false} generationBlocked={targetDirty(shot.id,'video')} dirtyChanged={dirtyChanged} /><p className="canvas-hint">{shot.camera || '运镜以最终正文为准'} · {shot.transition === 'continue' ? '延续上一镜' : '正常切镜'} · 请求 {shot.durationSeconds} 秒</p></div></article>
          <article className="canvas-node"><header><PlayCircleOutlined /><strong>镜头视频</strong><span className="canvas-small-label"></span></header><div className="canvas-node-body"><MediaNode project={project} shot={shot} kind="video" disabled={videoStartDisabled || targetDirty(shot.id,'video')} /></div></article>
        </div>;
  return <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm, token: { colorPrimary: '#087F72', colorText: '#202A35', colorBgContainer: '#fff', colorBorder: '#E3E8EB', borderRadius: 8, fontSize: 14 }, components: { Button: { colorPrimary: '#087F72', algorithm: true } } }}><div className={`storyboard-workspace canvas-stage-${stageView}`}>
    <div className="canvas-viewport" ref={viewportRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onLostPointerCapture={onPointerEnd} style={{ backgroundSize: `${20 * viewport.scale}px ${20 * viewport.scale}px`, backgroundPosition: `${viewport.x}px ${viewport.y}px` }}>
      <div className="canvas-content" ref={contentRef} style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}>
        <div className="canvas-column-titles"><span>故事</span><span>分镜 / 生图提示词</span><span>首帧 / 可选尾帧</span><span>视频提示词 / 运镜</span><span>镜头视频</span></div>
        {renderStory()}
        <div className="canvas-shot-rows">{project.plan?.shots.map(renderShot)}</div>
      </div><div className="canvas-navigation"><span>镜头</span>{project.plan?.shots.map((shot): React.ReactNode => <button type="button" key={shot.id} className={activeShot === shot.id ? 'active' : ''} onClick={(): void => focus(shot.id)}>{String(shot.order).padStart(2, '0')}</button>)}<span className="canvas-navigation-hint">拖动空白平移 · ⌘ / Ctrl + 滚轮缩放</span></div>
    </div>
  </div></ConfigProvider>;
};
