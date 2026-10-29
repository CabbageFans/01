import React, { useEffect, useState, useRef } from 'react';
import { Alert, Button, Card, Checkbox, Collapse, Input, InputNumber, Select, Space, Tag, Typography, ConfigProvider, Empty, message } from 'antd';
import type { PetStoryPlan, PetStoryShot, PetStoryPrompt, PetStoryCharacter, PetStoryProject, PetStoryPromptProfile } from '@doubao-studio/contracts';
import { PetStoryPlanPreview } from './PetStoryPlanPreview';
import { PetStoryPlanAssets } from './PetStoryPlanAssets';
import { PetStoryMaterials } from './PetStoryMaterials';
import { PetStoryCanvas } from './PetStoryCanvas';
import { isTaskConversationMissing } from '../utils/taskConversationLocator';
import { isCanvasPlanLocked } from './petStoryCanvasShared';
import { PetStoryOpenProject } from './PetStoryOpenProject';
import { usePetStoryStore, petStoryPromptActionTargets } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { useProjectStore } from '../store/useProjectStore';
import { navigateWorkspace } from '../utils/workspace';
import { useAccountStore } from '../store/useAccountStore';
import { DEFAULT_PROMPT_PROFILE as DEFAULT_PROMPT_PROFILE_DATA, chatAssets, mobileStoryPrompt } from '../utils/petstoryPrompts';
import { PetStoryRuntime, PetStoryCurrentTasks } from './PetStoryRuntime';
import { PetStoryResults } from './PetStoryResults';
import { selectPetStoryJourney } from '../utils/petstoryJourney';
import type { PetStoryJourneyStage } from '../utils/petstoryJourney';
import { PetStoryCreateProject } from './PetStoryCreateProject';
import { PetStoryDraftContext, usePetStoryDraft, usePetStoryDraftRegistry, locatePetStoryDraft } from './PetStoryDrafts';
import { mergePetStoryPlanDraft } from '../utils/petstoryPlanDraft';
import { petStoryReadOnlyProductionTask } from '../utils/petstoryRecovery';
import { revealBrowser } from '../utils/workspace';
import { canSelectAccount, findInteractiveAccountId } from '../utils/interactiveAccount';

const { Text, Title } = Typography;
const { TextArea } = Input;
// 保留受控 JSON 资源原值，只收窄 JSON 推断为 string 的角色职责类型。
const DEFAULT_PROMPT_PROFILE: PetStoryPromptProfile = DEFAULT_PROMPT_PROFILE_DATA as PetStoryPromptProfile;
function planLocked(project: PetStoryProject | null): boolean { return project ? isCanvasPlanLocked(project) : false; }
function blankPrompt(): PetStoryPrompt {
  return { original: '', optimized: '', final: '', edited: true, rulesVersion: 'manual' };
}
function renumber(shots: PetStoryShot[]): PetStoryShot[] {
  // 保留原连续引用；增删排序后若引用失效，保存时明确报错，不暗改故事或切镜。
  return shots.map((s: PetStoryShot, index: number): PetStoryShot => ({ ...s, order: index + 1 }));
}
const ReferenceImage: React.FC<{ projectId: string; assetId: string; name: string }> = ({ projectId, assetId, name }): React.ReactElement => {
  const [data, setData] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setData('');
    setError('');
    void window.electronAPI.petstory.readReference(projectId, assetId).then((result): void => {
      if (!active) return;
      if (result.success && result.data) setData(result.data);
      else setError(result.error || '参考图无法读取');
    }).catch((): void => { if (active) setError('参考图读取失败'); });
    return (): void => { active = false; };
  }, [projectId, assetId]);
  return data ? <img src={data} alt={`${name}项目参考图`} className="w-20 h-20 object-contain rounded bg-gray-950" /> : <Text type="secondary">{error || '读取参考图…'}</Text>;
};
export const PromptProfileEditor: React.FC<{ project: PetStoryProject; disabled: boolean; onDirtyChange: (value: boolean) => void; profile: PetStoryPromptProfile; setProfile: (value: PetStoryPromptProfile) => void }> = ({ project, disabled, onDirtyChange, profile, setProfile }): React.ReactElement => {
  const state = usePetStoryStore();
  const changed = JSON.stringify(profile) !== JSON.stringify(project.promptProfile || DEFAULT_PROMPT_PROFILE);
  const characterIds = [...new Set(['lulu', 'lumei', ...Object.keys(profile.characters)])];
  useEffect((): void => { onDirtyChange(changed); }, [changed, onDirtyChange]);
  return <Collapse items={[{ key: 'profile', label: '默认角色与共同风格（可编辑）', children: <Space direction="vertical" className="w-full">
    <Text type="secondary">可编辑的默认身份与视觉特点；实际参考和明确换装优先。当前剧情的动作、服装和环境在项目或镜头中填写。</Text>
    {characterIds.map((id: string): React.ReactNode => <div className="w-full" key={id}><Text strong>{id === 'lulu' ? '噜噜' : id === 'lumei' ? '噜妹' : project.plan?.characters.find((character): boolean => character.id === id)?.name || (id.startsWith('support-') ? '可选配角' : id)}</Text>
      <Space className="w-full" wrap><Select<string[]> className="w-72" mode="tags" aria-label={`${id}来源称谓别名`} placeholder="来源称谓／别名（可选）" disabled={disabled || state.busy} value={profile.characters[id]?.aliases || []} onChange={(aliases: string[]): void => setProfile({ ...profile, characters: { ...profile.characters, [id]: { ...(profile.characters[id] || { identity: '', appearance: '' }), aliases: aliases.length ? aliases : undefined } } })} />
        <Select<'main' | 'supporting' | undefined> className="w-44" allowClear aria-label={`${id}角色职责`} placeholder="主角／配角（未指定）" disabled={disabled || state.busy} value={profile.characters[id]?.role} options={[{ value: 'main', label: '主角' }, { value: 'supporting', label: '配角' }]} onChange={(role: 'main' | 'supporting' | undefined): void => setProfile({ ...profile, characters: { ...profile.characters, [id]: { ...(profile.characters[id] || { identity: '', appearance: '' }), role } } })} /></Space>
      {(['identity', 'appearance'] as const).map((field): React.ReactNode => <TextArea key={field} disabled={disabled || state.busy} aria-label={`${id}${field}预设`} placeholder={field === 'identity' ? '身份锚点' : '仅未指定时的默认造型'} value={profile.characters[id]?.[field] || ''} autoSize={{ minRows: 2, maxRows: 5 }} onChange={(event): void => setProfile({ ...profile, characters: { ...profile.characters, [id]: { ...(profile.characters[id] || { identity: '', appearance: '' }), [field]: event.target.value } } })} />)}</div>)}
    <Button disabled={disabled || state.busy} onClick={(): void => { const id = `support-${crypto.randomUUID()}`; setProfile({ ...profile, characters: { ...profile.characters, [id]: { identity: '', appearance: '', role: 'supporting' } } }); }}>添加可选配角预设</Button>
    {(['common', 'character', 'prop', 'scene'] as const).map((kind): React.ReactNode => <div className="w-full" key={kind}><Text>{({ common: '共同媒介／画面语言', character: '人物专用风格', prop: '道具专用风格', scene: '场景专用风格' })[kind]}</Text><TextArea disabled={disabled || state.busy} aria-label={`${kind}视觉风格`} value={profile.assetStyles?.[kind] || ''} autoSize={{ minRows: 2, maxRows: 4 }} onChange={(event): void => setProfile({ ...profile, assetStyles: { ...profile.assetStyles, [kind]: event.target.value } })} /></div>)}
    {profile.style && <Collapse items={[{ key: 'legacy-style', label: '旧共同风格（保留，需手动归入适用类别）', children: <pre className="prompt-readonly">{profile.style}</pre> }]} />}
    <Button disabled={disabled || state.busy || (!changed && !!project.promptProfile)} onClick={(): void => { void state.savePromptProfile(profile); }}>保存项目预设（不改写最终文本）</Button>
  </Space> }]} />;
};
const ProductionImageChoice: React.FC<{ project: PetStoryProject; stepId: string }> = ({ project, stepId }): React.ReactElement | null => {
  const state = usePetStoryStore();
  const tasks = useTaskStore((s) => s.tasks);
  const step = project.production?.steps.find((s): boolean => s.id === stepId);
  const task = tasks.find((t): boolean => t.id === step?.taskId && t.status === 'done');
  if (!step || step.kind === 'video' || project.production?.state !== 'paused' || !task) return null;
  const artifacts = task.artifacts?.filter((a): boolean => a.kind === 'image' && a.runId === step.runId && task.outputs.includes(a.url)) || [];
  if (artifacts.length < 2) return null;
  const selected = project.assets.find((a): boolean => a.id === step.assetId)?.artifactId;
  return <Select className="w-72" aria-label={`${stepId}选中图片`} placeholder="保存另一张原任务图片为候选" value={selected} disabled={state.busy}
    options={artifacts.map((a, index): { value: string; label: string } => ({ value: a.id, label: `原任务第 ${index + 1} 张${a.id === selected ? '（已保存候选）' : ''}` }))}
    onChange={(artifactId: string): void => { void state.selectProductionImage(stepId, artifactId); }} />;
};
export const ProductionControls: React.FC<{ project: PetStoryProject; disabled: boolean; view: 'prepare' | 'progress'; showMaterials?: boolean }> = ({ project, disabled, view, showMaterials = true }): React.ReactElement => {
  const state = usePetStoryStore();
  const [freeConfirmed, setFreeConfirmed] = useState(false);
  const counts = state.productionCounts;
  const capability = state.capability;
  const currentEntryChecked = !!capability && state.capabilityCheckedInSession;
  const production = project.production;
  const readyForShots = !production || (production.phase === 'materials' && production.state === 'complete');
  const materialsReady = !!project.storyApproval && !!project.materials?.length && project.materials.every((m): boolean => m.approved?.assetId === m.selectedAssetId && !!m.approved && (m.kind !== 'character' || (m.approved.identity?.assetId === m.selectedAssetId && m.approved.identity?.description === project.plan?.characters.find((c): boolean => c.id === m.entityId)?.description)));
  const pendingTaskId = production?.steps.find((step): boolean => step.status !== 'complete')?.taskId;
  const pendingTask = useTaskStore((s) => s.tasks.find((task): boolean => task.id === pendingTaskId));
  const productionTasks = useTaskStore((store) => store.tasks);
  const readOnlyRecovery = !!petStoryReadOnlyProductionTask(project, productionTasks);
  useEffect((): void => { setFreeConfirmed(false); }, [project.id]);
  return <Card size="small" title={view === 'prepare' ? '核对入口与制作计划' : '镜头制作进度'}>
    <Space direction="vertical" className="w-full">
      <Text type="secondary">在原账号检查一次可见创作入口，无上传、无提交。未识别槽位保留待确认；检查和本地数量均不是豆包官方剩余额度。</Text>
      <Checkbox checked={freeConfirmed} onChange={(event): void => setFreeConfirmed(event.target.checked)}>本人已核对原账号当前图片／视频入口及选定规格免费可用；收费或未知时不勾选</Checkbox>
      <Button disabled={disabled || (production?.state === 'running' && currentEntryChecked)} onClick={(): void => { void state.inspectCapability(freeConfirmed); }}>{currentEntryChecked ? '重新核对当前入口（暂停后）' : '检查当前可见入口（不提交）'}</Button>
      {capability && !state.capabilityCheckedInSession && <Alert type="info" message="已恢复保存的模型选择，仅用于文字创作；新增生成前请先检查当前会话的免费入口；已发送任务可只读恢复。" />}
      {!capability && production?.capability && <Alert type="info" message={`已保存检查：${new Date(production.capability.checkedAt).toLocaleString('zh-CN')} · ${production.capability.freeEvidence === 'user_confirmed' ? '本人确认免费' : production.capability.freeEvidence === 'visible' ? '页面观察免费' : '免费状态未知'}。新生成前仍需核对当前入口；只读收取不重复发送。`} />}
      {capability && <>
        <Checkbox checked={!!capability.allowPlainReferences} disabled={disabled || production?.state === 'running'} onChange={(e): void => state.setPlainReferences(e.target.checked)}>本人已核对当前入口不支持 @ 素材引用，同意按逐图回读的中文用途映射提交；支持 @ 的入口请勿勾选</Checkbox>
        <Text>免费来源：{capability.freeEvidence === 'user_confirmed' ? '本人确认' : capability.freeEvidence === 'visible' ? '页面观察' : '未知'}；图片：{capability.image.state} / {capability.image.free}；视频规格：{capability.videoConfig ? `${capability.videoConfig.model} · ${capability.videoConfig.aspectRatio}` : '待确认'}；已观察时长：{capability.durations.join(' / ') || '未知'} 秒</Text>
        {(['first_frame', 'first_last_frame', 'reference'] as const).map((mode): React.ReactNode => <Text key={mode}>{mode}：{capability.modes[mode].state} / {capability.modes[mode].free} · {capability.modes[mode].reason}</Text>)}
      </>}
      {view === 'prepare' && readyForShots && project.plan?.shots.map((shot): React.ReactNode => <Space key={shot.id} wrap><Text>{shot.order} · 请求 {shot.requestedMode} · {shot.durationSeconds} 秒</Text>{counts && state.productionResolutions[shot.id] && <Text>→ 本次实际 {state.productionResolutions[shot.id].resolvedMode} · {state.productionResolutions[shot.id].reason}</Text>}
        <Select aria-label={`${shot.id}批准备选`} className="w-64" value={state.fallbacks[shot.id] || 'none'} disabled={disabled} options={[{ value: 'none', label: '不允许降级（必须首尾帧时保留此项）' }, { value: 'first_frame', label: '入口不可用时批准改为首帧' }, { value: 'reference', label: '入口不可用时批准改为参考图' }]} onChange={(mode: string): void => state.setFallback(shot.id, mode === 'none' ? undefined : mode as 'first_frame' | 'reference')} />
      </Space>)}
      {view === 'prepare' && readyForShots && <Button disabled={disabled || !currentEntryChecked || !materialsReady} onClick={(): void => { void state.previewProduction(); }}>查看本次实际制作数量</Button>}
      {production?.phase === 'materials' && <Alert type={production.state === 'paused' ? 'warning' : 'info'} message={production.message} />}
      {counts && <Alert type="info" message={`${counts.shots} 个镜头，${counts.supporting} 个必要配角；计划新增角色图 ${counts.newCharacters}、首帧 ${counts.firstFrames}、尾帧 ${counts.lastFrames}；视频请求 ${counts.videos}。复用素材不重复计入新增。`} />}
      <Space wrap>
        {view === 'prepare' && readyForShots && <Button type="primary" disabled={disabled || !currentEntryChecked || !counts || !materialsReady} onClick={(): void => { void state.startProduction(); }}>确认素材，继续镜头制作</Button>}
        {production && production.state !== 'complete' && <>
          <Button disabled={state.busy} onClick={(): void => { void state.pauseProduction(); }}>暂停制作</Button>
          <Button type="primary" disabled={state.busy || !currentEntryChecked && !readOnlyRecovery} onClick={(): void => { void state.resumeProduction(); }}>{readOnlyRecovery && !currentEntryChecked ? '只读继续收取／下载原产物' : '显式继续原制作'}</Button>
          {production.state === 'paused' && pendingTask?.runtime?.submittedAt && isTaskConversationMissing(pendingTask) && <Button disabled={state.busy} onClick={(): void => {
            window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: pendingTask.id, useCurrentPage: true } }));
          }}>只读核对当前原制作会话</Button>}
        </>}
      </Space>
      {view === 'prepare' && showMaterials && <PetStoryMaterials project={project} disabled={disabled} />}
      {production && production.phase !== 'materials' && view === 'progress' && <>
        <Alert type={production.state === 'paused' ? 'warning' : production.state === 'complete' ? 'success' : 'info'} message={`${production.state === 'complete' ? '当前批次已完成下载校验；全项目进度以逐镜成果为准' : `${production.state === 'paused' ? '制作已暂停' : '正在制作镜头素材'} · ${production.message}`}`} />
        {project.plan?.shots.map((shot): React.ReactNode => {
          const media = production.shots[shot.id];
          const video = project.assets.find((a): boolean => a.id === media?.videoId);
          return <div key={shot.id} className="space-y-1 border-t border-gray-700 pt-2">
            <Text>{shot.order} · {shot.id} · 请求 {media?.requestedMode} → 实际 {media?.resolvedMode} · 请求 {shot.durationSeconds} 秒</Text>
            <div><Text type="secondary">{media?.reason}</Text></div>
            <div className="shot-media-strip">{([{ id: media?.firstFrameId, label: '首帧' }, { id: media?.plannedEndImageId, label: '计划尾帧' }, { id: media?.actualEndFrameId, label: '实际视频末帧' }]).map((item): React.ReactNode => <div key={item.label}><Tag>{item.label}</Tag>{item.id ? <ReferenceImage projectId={project.id} assetId={item.id} name={item.label} /> : <Text type="secondary">尚无素材</Text>}</div>)}</div>
            {media?.startFromPreviousEnd && <div><Text>连续起点：上一选中视频 {media.startFromPreviousEnd.assetId}，实际 {media.startFromPreviousEnd.atSeconds.toFixed(3)} 秒画面</Text></div>}
            {video && <div className="video-material"><Tag color={video.validation?.decoded ? 'green' : 'default'}>{video.validation?.decoded ? '视频文件校验通过' : '文件未检查'}</Tag><Text>{video.relativePath} · {video.validation?.durationSeconds} 秒 · {video.validation?.width}×{video.validation?.height}</Text><Button disabled={!video.taskId} onClick={(): void => { navigateWorkspace('tasks'); window.dispatchEvent(new CustomEvent('show-workspace-task', { detail: { taskId: video.taskId } })); }}>查看单镜头视频与产物</Button><Tag>人工质量以任务详情结论为准</Tag></div>}
          </div>;
        })}
        <Collapse items={[{ key: 'steps', label: '诊断：原任务产物与候选图片', children: production.steps.map((step): React.ReactNode => <div key={step.id}><Text>{step.characterId || step.shotId} / {step.kind} / {step.status} · {step.taskId || '创建意图已保存，待核对任务'} · {step.error}</Text><ProductionImageChoice project={project} stepId={step.id} /></div>) }]} />
      </>}
    </Space>
  </Card>;
};
const JOURNEY_STAGES: PetStoryJourneyStage[] = ['script', 'plan', 'materials', 'keyframes', 'videos', 'results'];
const STAGE_LABELS = ['输入剧本', '确认方案', '准备基础素材', '制作关键帧', '制作镜头视频', '查看成果'];

export const PetStoryPanel: React.FC = (): React.ReactElement => {
  const registry = usePetStoryDraftRegistry();
  return <PetStoryDraftContext.Provider value={registry.value}><PetStoryJourneyContent drafts={registry.drafts} /></PetStoryDraftContext.Provider>;
};
const PetStoryJourneyContent: React.FC<{ drafts: import('./PetStoryDrafts').PetStoryDraft[] }> = ({ drafts }): React.ReactElement => {
  const state = usePetStoryStore(); const p = state.project;
  const accounts = useAccountStore((store) => store.accounts); const browsingId = useAccountStore((store) => store.selectedAccountId);
  const projects = useProjectStore((store) => store.projects);
  const [stage, setStage] = useState(0); const stageProjectId = useRef('');
  const [selectedShotId, setSelectedShotId] = useState(''); const [notice, setNotice] = useState('');
  const [link, setLink] = useState(''); const [sourceText, setSourceText] = useState(''); const [inputMode, setInputMode] = useState<'script' | 'link'>('script');
  const [plan, setPlan] = useState<PetStoryPlan | null>(null); const planBase = useRef<PetStoryPlan | null>(null);
  const [dirty, setDirty] = useState(false); const [profileDirty, setProfileDirty] = useState(false); const [, setCanvasDirty] = useState(false);
  const [profileDraft, setProfileDraft] = useState<PetStoryPromptProfile>(() => structuredClone(DEFAULT_PROMPT_PROFILE));
  const [sourceEditing, setSourceEditing] = useState(false); const [linkEditing, setLinkEditing] = useState(false);
  const [promptTargets, setPromptTargets] = useState<NonNullable<import('@doubao-studio/contracts').PetStoryResult['promptTargets']>>([]);
  const [targetError, setTargetError] = useState(''); const [candidates, setCandidates] = useState<string[]>([]);
  const analysisBefore = useRef<string>();
  const journey = p ? selectPetStoryJourney(p) : undefined;
  const navigate = (next: PetStoryJourneyStage, objectId?: string, kind?: import('@doubao-studio/contracts').PetStoryPromptKind): void => { setStage(JOURNEY_STAGES.indexOf(next)); if (!objectId) return; if (next !== 'materials') setSelectedShotId(objectId); requestAnimationFrame((): void => { const id = next === 'materials' ? `material-${objectId}` : kind ? `shot-media-${objectId}-${kind}` : ''; if (id) document.getElementById(id)?.scrollIntoView({block:'center',behavior:'smooth'}); }); };
  useEffect((): void => {
    if (!p) return;
    if (stageProjectId.current !== p.id) {
      stageProjectId.current = p.id; setStage(JOURNEY_STAGES.indexOf(selectPetStoryJourney(p).stage)); setSourceEditing(false); setLinkEditing(false); setDirty(false); setProfileDirty(false); setCanvasDirty(false); setNotice('');
      setSourceText(p.mobileStory?.text || ''); setLink(p.source.url); setPlan(p.plan ? structuredClone(p.plan) : null); planBase.current = p.plan ? structuredClone(p.plan) : null; setProfileDraft(structuredClone(p.promptProfile || DEFAULT_PROMPT_PROFILE));
    } else {
      if (!sourceEditing) setSourceText(p.mobileStory?.text || ''); if (!linkEditing) setLink(p.source.url);
      if (!dirty) { setPlan(p.plan ? structuredClone(p.plan) : null); planBase.current = p.plan ? structuredClone(p.plan) : null; }
      if (!profileDirty) setProfileDraft(structuredClone(p.promptProfile || DEFAULT_PROMPT_PROFILE));
    }
  }, [p, sourceEditing, linkEditing, dirty, profileDirty]);
  useEffect(() => {
    const locate = (event: Event): void => { const detail = (event as CustomEvent<{stage: string; id: string; objectId?: string}>).detail; if (detail.objectId) setSelectedShotId(detail.objectId); const index = JOURNEY_STAGES.indexOf(detail.stage as PetStoryJourneyStage); if (index >= 0) setStage(index); else if (detail.stage === 'advanced') setStage(7); };
    const task = (): void => { document.querySelector('.petstory-current-tasks')?.scrollIntoView({block:'center',behavior:'smooth'}); };
    window.addEventListener('petstory-locate-draft', locate); window.addEventListener('petstory-locate-task', task); return (): void => { window.removeEventListener('petstory-locate-draft', locate); window.removeEventListener('petstory-locate-task',task); };
  }, []);
  useEffect(() => {
    let active = true; setPromptTargets([]); setCandidates([]); setTargetError('');
    if (p?.plan) void window.electronAPI.petstory.promptStageTargets(p.id, p.revision).then((result): void => { if (!active) return; if (result.success) { setPromptTargets(result.promptTargets || []); setCandidates(result.pendingCandidateJobIds || []); } else setTargetError(result.error || '当前文字目标尚未核对'); }).catch((): void => { if (active) setTargetError('当前文字目标读取失败，请重新打开项目后核对'); });
    return (): void => { active = false; };
  }, [p?.id, p?.revision, p?.plan]);
  useEffect((): void => {
    if (!p || !analysisBefore.current) return;
    const ids = new Set([analysisBefore.current]);
    for (const item of p.jobs) if (item.parentJobId && ids.has(item.parentJobId)) ids.add(item.id);
    const result = [...p.jobs].reverse().find((item): boolean => ids.has(item.id) && item.status === 'applied' && !!item.parsedResult?.plan);
    if (!result) return;
    analysisBefore.current = undefined;
    setNotice('方案已就绪：请查看理解与角色对应，再确认制作依据。');
    if (!drafts.length && stage === 0) setStage(1);
  }, [p, drafts.length, stage]);
  const sourceDirty = !!p && sourceText !== (p.mobileStory?.text || '');
  const linkDirty = !!p && link !== p.source.url;
  const saveStory = async (): Promise<void> => { if (!p) return; await state.saveOriginalStory(sourceText); const current = usePetStoryStore.getState(); if (!current.error && current.project?.mobileStory?.text === sourceText) { setSourceEditing(false); setNotice('剧本原文已保存。'); } };
  const saveProfile = async (): Promise<void> => { await state.savePromptProfile(profileDraft); if (!usePetStoryStore.getState().error) setProfileDirty(false); };
  const savePlanDraft = async (): Promise<void> => {
    const latest = usePetStoryStore.getState().project;
    if (!plan || !planBase.current || !latest?.plan) return;
    try { await state.savePlan(mergePetStoryPlanDraft(planBase.current, plan, latest.plan)); if (!usePetStoryStore.getState().error) setDirty(false); }
    catch (error: unknown) { setNotice(error instanceof Error ? error.message : '保存方案失败，草稿已保留'); }
  };
  usePetStoryDraft(`${p?.id}:script`, '原剧本 · 输入剧本', sourceDirty, { save: saveStory, discard: (): void => { setSourceText(p?.mobileStory?.text || ''); setSourceEditing(false); }, locate: (): void => locatePetStoryDraft('script','petstory-script') });
  usePetStoryDraft(`${p?.id}:link`, '可选抖音链接 · 输入剧本', linkDirty, { save: async (): Promise<void> => { await state.saveSource(link); if (!usePetStoryStore.getState().error) setLinkEditing(false); }, discard: (): void => { setLink(p?.source.url || ''); setLinkEditing(false); }, locate: (): void => { setInputMode('link'); locatePetStoryDraft('script','petstory-link'); } });
  usePetStoryDraft(`${p?.id}:profile`, '制作演员与共同风格 · 输入剧本', profileDirty, { save: saveProfile, discard: (): void => { setProfileDraft(structuredClone(p?.promptProfile || DEFAULT_PROMPT_PROFILE)); setProfileDirty(false); }, locate: (): void => locatePetStoryDraft('script','petstory-profile') });
  usePetStoryDraft(`${p?.id}:plan`, '故事、角色与镜头设定 · 高级编辑', dirty, { save: savePlanDraft, discard: (): void => { setPlan(p?.plan ? structuredClone(p.plan) : null); setDirty(false); }, locate: (): void => locatePetStoryDraft('advanced','petstory-advanced') });
  const edit = (change: (value: PetStoryPlan) => void): void => { if (!plan || planLocked(p)) return; const next = structuredClone(plan); change(next); setPlan(next); setDirty(true); };
  const updateShot = (id: string, patch: Partial<PetStoryShot>): void => edit((value: PetStoryPlan): void => { value.shots = value.shots.map((shot): PetStoryShot => shot.id === id ? {...shot,...patch} : shot); });
  const addShot = (): void => edit((value: PetStoryPlan): void => { value.shots.push({id:`shot-${crypto.randomUUID()}`,order:value.shots.length+1,characterIds:[],scene:'',action:'',startState:'',endState:'',durationSeconds:5,transition:'cut',requestedMode:'auto',prompts:{firstFrame:blankPrompt(),video:blankPrompt()}}); });
  const addCharacter = (): void => edit((value: PetStoryPlan): void => { value.characters.push({id:`support-${crypto.randomUUID()}`,name:'',role:'supporting',purpose:'',description:''}); });
  const disabled = state.busy || dirty || profileDirty || planLocked(p);
  const pending = !!p?.jobs.some((job): boolean => !job.endedWaitingAt && ['bound','captured'].includes(job.status));
  const accountName = accounts.find((account): boolean => account.id === p?.accountId)?.name || '原执行账号缺失';
  const analyze = async (): Promise<void> => {
    if (!p) return;
    if (sourceDirty) { await saveStory(); if (usePetStoryStore.getState().error || usePetStoryStore.getState().project?.mobileStory?.text !== sourceText) return; }
    if (profileDirty) { await saveProfile(); if (usePetStoryStore.getState().error) return; }
    const beforeIds = new Set(usePetStoryStore.getState().project?.jobs.map((job): string => job.id));
    await state.analyze(); const current = usePetStoryStore.getState();
    const job = current.project?.id === p.id ? current.project.jobs.find((item): boolean => !beforeIds.has(item.id) && item.kind === 'analysis') : undefined;
    if (!job) return;
    analysisBefore.current = job.id;
    const ids = new Set([job.id]); for (const item of current.project?.jobs || []) if (item.parentJobId && ids.has(item.parentJobId)) ids.add(item.id);
    if (current.project?.jobs.some((item): boolean => ids.has(item.id) && item.status === 'applied' && !!item.parsedResult?.plan)) { setStage(1); setNotice('方案已就绪，请查看并确认。'); analysisBefore.current = undefined; }
  };
  const confirm = async (): Promise<void> => { await state.confirmStory(); if (!usePetStoryStore.getState().error && usePetStoryStore.getState().project?.storyApproval) { setNotice('方案已确认。请准备并逐张确认基础素材；尚未生成媒体。'); setStage(2); } };
  const actionTargets = p ? petStoryPromptActionTargets(p, promptTargets) : [];
  const resumingBatch = !!p?.promptBatch && p.promptBatch.status !== 'complete' && p.promptBatch.targets.length > 0;
  const materialTargets = actionTargets.filter((target): boolean => !!target.materialId);
  const frameTargets = actionTargets.filter((target): boolean => !target.materialId && target.kind !== 'video');
  const videoTargets = actionTargets.filter((target): boolean => target.kind === 'video');
  const scopeText = [materialTargets.length && `基础素材${materialTargets.length}项`, frameTargets.length && `关键帧${frameTargets.length}项`, videoTargets.length && `视频${videoTargets.length}项`].filter(Boolean).join('、');
  const runsText = stage >= 2 && stage <= 4 && (resumingBatch || (stage === 2 ? materialTargets.length > 0 : actionTargets.length > 0));
  // 返回素材只是导航，不能要求先授权发送，也不能丢弃其他位置保留的草稿。
  const returningToMaterials = runsText && stage > 2 && materialTargets.length > 0 && !resumingBatch;
  const mainText = stage === 0 ? '分析剧本' : stage === 1 ? '确认方案并准备素材' : runsText ? (returningToMaterials ? '去补充素材提示词' : resumingBatch ? '继续提示词制作' : '生成缺失提示词') : stage === 2 ? '查看关键帧画布' : stage === 3 ? '制作镜头视频' : '查看成果';
  const runMain = async (): Promise<void> => {
    if (stage === 0) { await analyze(); return; } if (stage === 1) { await confirm(); return; }
    if (runsText) { if (returningToMaterials) { setStage(2); return; } await state.continuePromptStage(); return; }
    setStage(stage === 2 ? 3 : stage === 3 ? 4 : 5);
  };
  const mainBlocked = state.busy || (stage === 0 ? !sourceText.trim() || !state.freeChatConfirmed || pending || planLocked(p) : stage === 1 ? !p?.plan || dirty || sourceDirty || profileDirty : runsText && !returningToMaterials ? drafts.length > 0 || !state.freeChatConfirmed || state.promptBatch.status === 'running' : false);
  const stageReason = stage === 0 ? !sourceText.trim() ? '请先粘贴完整剧本。' : pending ? '正在处理原文字任务，请在下方查看进度或恢复原回复。' : !state.freeChatConfirmed ? '请确认绑定账号普通 Chat 免费可用，再开始分析。' : '分析前会保存剧本，再向豆包发送本次请求。' : stage === 1 ? !p?.plan ? '分析结果尚未采用。请查看下方本次结果，采用后再确认。' : '核对故事理解、角色对应、资产和动态镜头；确认不会自动生成图片或视频。' : stage >= 2 && stage <= 4 ? targetError || (returningToMaterials ? '基础素材文字尚有缺项，请先进入素材准备补齐。' : runsText && !state.freeChatConfirmed ? '请先勾选下方普通 Chat 免费可用确认，再发起文字创作。' : candidates.length ? `有 ${candidates.length} 条新候选待选择；保留当前手改正文，采用与确认分开。` : runsText ? `还缺少${scopeText}提示词。生成后请查看并采用满意的回复。` : '生成或上传图片后，先查看，再采用。') : '逐镜检查图片、视频、下载与质量。';
  const openBound = (): void => { if (p && accounts.some((account): boolean => account.id === p.accountId)) { const interactiveId = findInteractiveAccountId(useTaskStore.getState().accountAutomationState); if (!canSelectAccount(p.accountId, interactiveId)) { message.warning(`任务正在 ${accounts.find((account): boolean => account.id === interactiveId)?.name || '当前账号'} 配置或提交，进入生成阶段后即可切换`); return; } useAccountStore.getState().selectAccount(p.accountId); revealBrowser(); } };
  return <section className="petstory-panel space-y-4" aria-label="短剧创作">
    {!p && <Space wrap><PetStoryCreateProject primary disabled={drafts.length > 0} /><PetStoryOpenProject disabled={state.busy || drafts.length > 0} /></Space>}
    {state.error && <Alert type="error" showIcon message={state.error} />}{state.exportStatus && <Alert type="info" message={state.exportStatus} />}
    {!p && <Card title="从剧本开始制作"><p>新建短剧项目，在弹窗中选择执行账号、关联项目和保存目录，然后粘贴完整剧本。已有项目可直接打开继续。</p></Card>}
    {p && <>
      <div className="petstory-project-heading"><div><h2>{state.projectName || '当前短剧'}</h2><p>{accountName} · {projects.find((project): boolean => project.id === p.studioProjectId)?.name || '请核对关联项目'}</p></div><div className="petstory-project-tools"><span>{drafts.length ? '有未保存修改' : '已保存'}</span><details className="petstory-more"><summary aria-label="项目更多操作">更多</summary><div>
        <PetStoryCreateProject disabled={drafts.length > 0} /><PetStoryOpenProject disabled={state.busy || drafts.length > 0} />
        <Button type="text" onClick={(): void => setStage(6)}>画布全景</Button><Button type="text" onClick={(): void => setStage(7)}>编辑故事与镜头</Button>
        <Button type="text" disabled={state.busy || drafts.length > 0} onClick={(): void => { void state.exportPrompts(); }}>导出提示词与素材清单</Button>
        <Button type="text" onClick={openBound}>查看账号浏览器</Button><span>当前浏览：{accounts.find((account): boolean => account.id === browsingId)?.name || '未选择'}</span>
      </div></details></div></div>
      <div className="journey-sticky" aria-label="当前步骤与推荐操作">
        <nav className="petstory-stages" aria-label="短剧制作阶段">{STAGE_LABELS.map((label: string,index: number): React.ReactNode => <button key={label} className={stage === index ? 'active' : ''} aria-current={stage === index ? 'step' : undefined} onClick={(): void => setStage(index)}><span>{index+1}</span>{label}</button>)}</nav>
        <div className="journey-recommendation"><div><strong>当前：{STAGE_LABELS[stage] || (stage === 6 ? '画布全景' : '高级编辑')}</strong><p>{stageReason}</p><small>已确认基础图 {journey?.counts.materials.confirmed}/{journey?.counts.materials.total} · 正文匹配关键帧 {journey?.counts.keyframes.current}/{journey?.counts.keyframes.total} · 正文匹配视频 {journey?.counts.videos.current}/{journey?.counts.videos.total}</small></div>{stage < 5 && <Button type="primary" disabled={mainBlocked} loading={state.busy} onClick={(): void => { void runMain(); }}>{mainText}</Button>}</div>
        {stage >=2 && stage <=4 && <details className="petstory-secondary-tools"><summary>提示词制作设置</summary><Space wrap><Checkbox checked={state.freeChatConfirmed} onChange={(event): void => state.setFreeChatConfirmed(event.target.checked)}>已确认执行账号普通 Chat 免费可用（仅文字）</Checkbox>{materialTargets.length >0 && stage >2 && <Button onClick={(): void => setStage(2)}>去补齐基础素材文字</Button>}<span>生成范围：{scopeText || '当前提示词已具备'}。图片与视频另行制作。</span></Space></details>}
        {drafts.length >0 && <Alert type="warning" message="以下对象有未保存修改；草稿随页面保留" description={<Space direction="vertical">{drafts.map((draft): React.ReactNode => <Space wrap key={draft.id}><strong>{draft.label}</strong><Button size="small" disabled={state.busy} onClick={(): void => { void draft.actions.current.save(); }}>保存并继续</Button><Button size="small" onClick={(): void => draft.actions.current.locate()}>查看修改</Button><Button size="small" disabled={state.busy} onClick={(): void => draft.actions.current.discard()}>放弃修改</Button></Space>)}</Space>} />}
      </div>
      {notice && <Alert type="info" message={notice} action={notice.includes('方案已就绪') ? <Button onClick={(): void => setStage(1)}>查看方案结果</Button> : undefined} />}
      <PetStoryCurrentTasks project={p} onContinue={(): void => { void state.continuePromptStage(); }} />
      <div hidden={stage !== 0} className={stage === 0 ? 'stage-content space-y-4':'page-hidden'}>
        <Card title="完整剧本"><Button type="text" size="small" onClick={(): void => setInputMode(inputMode === 'link' ? 'script' : 'link')}>{inputMode === 'link' ? '返回剧本输入' : '从抖音链接辅助提取'}</Button>
          {inputMode === 'link' && <div className="space-y-2 mt-3"><p>保存来源链接，复制提示词到手机豆包提取故事，再粘贴到下方原文框。桌面不读取链接视频。</p><TextArea id="petstory-link" aria-label="抖音分享文本或链接" value={link} onChange={(event): void => { setLinkEditing(true);setLink(event.target.value); }} /><Button disabled={state.busy || !linkDirty} onClick={(): void => { void state.saveSource(link).then((): void => {if (!usePetStoryStore.getState().error) setLinkEditing(false);}); }}>保存链接</Button><Button disabled={!p.source.url} onClick={(): void => { void navigator.clipboard.writeText(mobileStoryPrompt(p)).then((): void => setNotice('手机提取提示词已复制，取得故事后粘贴下方。')); }}>复制手机豆包提示词</Button></div>}
          <div className="mt-3"><label htmlFor="petstory-script">完整剧本原文</label><TextArea id="petstory-script" aria-label="完整剧本原文" value={sourceText} readOnly={state.busy || planLocked(p)} autoSize={{minRows:12,maxRows:20}} showCount maxLength={50000} placeholder="直接粘贴完整剧本。" onChange={(event): void => {setSourceEditing(true);setSourceText(event.target.value);}} /></div>
          <p className="mt-3">制作演员：{Object.entries(profileDraft.characters).map(([id,character]): string => `${id === 'lulu' ? '噜噜' : id === 'lumei' ? '噜妹' : p.plan?.characters.find((item): boolean => item.id===id)?.name || (id.startsWith('support-') ? '可选配角' : id)}（${character.role === 'supporting' ? '可选配角' : '主演'}）`).join('、')}。未指定配角由剧情决定；可在下方展开编辑。</p>
          <div id="petstory-profile"><PromptProfileEditor project={p} profile={profileDraft} setProfile={setProfileDraft} disabled={state.busy || planLocked(p)} onDirtyChange={setProfileDirty} /></div>
          <Space wrap className="mt-3"><Checkbox checked={state.freeChatConfirmed} onChange={(event): void => state.setFreeChatConfirmed(event.target.checked)}>本人已确认执行账号普通 Chat 免费可用</Checkbox><Checkbox checked={state.autoRepair} onChange={(event): void => state.setAutoRepair(event.target.checked)}>回复缺项时允许最多一次自动修订</Checkbox><Button disabled={state.busy || !sourceDirty || !sourceText.trim()} onClick={(): void => { void saveStory(); }}>保存剧本</Button></Space>
          <p>点击“分析剧本”后，将由工作室向豆包发送本次分析请求。</p>
        </Card>
      </div>
      <div hidden={stage !== 1} className={stage === 1 ? 'stage-content space-y-4':'page-hidden'}>
        {p.plan && <Card title="当前采用方案" extra={<Space><Tag>{p.storyApproval ? '已确认为制作依据' : '待确认'}</Tag><Button onClick={(): void => { void state.openChatAdjustment({}); }}>在豆包中调整</Button><Button onClick={(): void => setStage(7)}>编辑方案</Button></Space>}><p>{p.plan.understanding || p.plan.sourceSummary}</p><p>{p.plan.adaptedStory}</p><p>人物 {p.plan.characters.length} · 道具 {p.plan.props?.length || 0} · 场景 {p.plan.scenes?.length || 0} · 镜头 {p.plan.shots.length}</p><div className="journey-character-map">{p.plan.characters.map((character): React.ReactNode => <p key={character.id}><strong>{character.aliases?.join('、') || character.name} → {character.name}</strong> · {character.role==='main'?'主演':'配角'}<br/>{character.description}</p>)}</div>{p.plan.shots.map((shot): React.ReactNode => <p key={shot.id}><strong>镜头 {shot.order} · {shot.durationSeconds} 秒</strong> {shot.action}<br/>{shot.startState} → {shot.endState}</p>)}{p.storyApproval && <Tag>方案已确认，修改后需要重新确认</Tag>}<details className="petstory-secondary-tools"><summary>查看完整方案与提示词</summary><PetStoryPlanPreview plan={p.plan} contentBasis={p.contentBasis} /></details></Card>}
        <PetStoryRuntime project={p} disabled={state.busy || dirty || profileDirty || sourceDirty || planLocked(p)} />
      </div>
      <div id="petstory-materials" hidden={stage !== 2} className={stage === 2 ? 'stage-content':'page-hidden'}><PetStoryMaterials project={p} disabled={state.busy || dirty || profileDirty} generationBlocked={sourceDirty} onNavigate={(target,objectId): void => navigate(target==='plan'?'plan':'keyframes',objectId)} /></div>
      <div hidden={![3,4,6].includes(stage)} className={[3,4,6].includes(stage)?'stage-content':'page-hidden'}><PetStoryCanvas key={p.id} project={p} legacyDirty={dirty || profileDirty || sourceDirty} onDirtyChange={setCanvasDirty} materials={null} controls={null} view={stage===3?'keyframes':stage===4?'videos':'panorama'} activeShotId={selectedShotId} onNavigate={navigate} /></div>
      {stage === 5 && <PetStoryResults project={p} onNavigate={navigate} />}
      <div id="petstory-advanced" tabIndex={-1} className={stage === 7 ? 'stage-content space-y-4' : 'page-hidden'}>
      {!plan && <Empty description="保存手机故事并生成制作方案后，在这里整理角色与分镜" />}
      {plan && <>
        <ConfigProvider componentDisabled={state.busy || planLocked(p)}>
        <Card size="small" title="故事与角色">
          <Text>原片梗概</Text><TextArea aria-label="原片梗概" value={plan.sourceSummary} onChange={(e): void => edit((v: PetStoryPlan): void => { v.sourceSummary = e.target.value; })} autoSize={{ minRows: 2, maxRows: 5 }} />
          <div className="mt-3"><Text>相似故事</Text><TextArea aria-label="相似故事" value={plan.adaptedStory} onChange={(e): void => edit((v: PetStoryPlan): void => { v.adaptedStory = e.target.value; })} autoSize={{ minRows: 2, maxRows: 5 }} /></div>
          <Collapse className="mt-4" items={[{ key: 'characters', label: `角色档案 · ${plan.characters.length} 位 · 默认主演与必要配角`, children: <div className="character-grid">{plan.characters.map((c: PetStoryCharacter, index: number): React.ReactNode => <div key={c.id} className="rounded border border-gray-700 p-2 space-y-2">
            <Space><Tag>{c.role === 'main' ? '默认主演' : '必要配角'}</Tag></Space>
            <Input aria-label={`${c.id}名称`} value={c.name} disabled={state.busy || planLocked(p)} onChange={(e): void => edit((v: PetStoryPlan): void => { v.characters[index].name = e.target.value; })} />
            <Input aria-label={`${c.id}剧情作用`} placeholder="剧情作用" value={c.purpose} onChange={(e): void => edit((v: PetStoryPlan): void => { v.characters[index].purpose = e.target.value; })} />
            <Input aria-label={`${c.id}外观设定`} placeholder="外观与服装" value={c.description} onChange={(e): void => edit((v: PetStoryPlan): void => { v.characters[index].description = e.target.value; })} />
            {c.referenceAssetId && <ReferenceImage projectId={p.id} assetId={c.referenceAssetId} name={c.name} />}
            <Button disabled={disabled} onClick={(): void => { setStage(2); requestAnimationFrame((): void => document.getElementById(`material-character:${c.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })); }}>查看与准备人物图片</Button>
            <Select className="w-full" disabled={disabled} value={null} placeholder="确认同框后复用已有身份图" options={p.assets.filter((a): boolean => a.kind === 'character').map((a): { value: string; label: string } => ({ value: a.id, label: `已有图 · ${(a.characterIds || [a.characterId]).join('、')}` }))} onChange={(assetId: string): void => { void state.bindSharedReference(c.id, assetId).then((): void => { if (!usePetStoryStore.getState().error) setStage(2); }); }} />
            {<Button danger disabled={state.busy || planLocked(p)} onClick={(): void => edit((v: PetStoryPlan): void => { v.characters.splice(index, 1); })}>删除人物</Button>}
          </div>)}</div> }]} />
          <Button className="mt-3" onClick={addCharacter} disabled={state.busy || planLocked(p)}>添加必要配角</Button>
        </Card>
        <PetStoryPlanAssets plan={plan} disabled={state.busy || planLocked(p)} edit={edit} />
        </ConfigProvider>
        <Space wrap><Title level={5} className="!m-0">{plan.shots.length} 个镜头 · {plan.characters.length} 个角色</Title><Button onClick={addShot} disabled={state.busy || planLocked(p)}>增加镜头</Button><Button type="primary" disabled={!dirty || state.busy || planLocked(p)} onClick={(): void => { void savePlanDraft(); }}>校验并保存所有修改</Button>{dirty && <Tag color="orange">有未保存修改</Tag>}</Space>
        <div className="shot-workspace"><nav className="shot-list" aria-label="镜头列表">{plan.shots.map((shot: PetStoryShot): React.ReactNode => <button key={shot.id} className={(plan.shots.find((item): boolean => item.id === selectedShotId)?.id || plan.shots[0]?.id) === shot.id ? 'active' : ''} onClick={(): void => setSelectedShotId(shot.id)}><span className="shot-number">{String(shot.order).padStart(2, '0')}</span><span><strong>{shot.scene || '待填写场景'}</strong><small>{shot.characterIds.map((id: string): string => plan.characters.find((character): boolean => character.id === id)?.name || id).join('、') || '未选角色'}</small><small>{shot.durationSeconds || '—'} 秒 · {shot.transition === 'cut' ? '切镜' : '连续动作'} · {shot.requestedMode}</small></span></button>)}</nav><div className="shot-detail">
        {plan.shots.map((shot: PetStoryShot, index: number): React.ReactNode => <Card className={(plan.shots.find((item): boolean => item.id === selectedShotId)?.id || plan.shots[0]?.id) === shot.id ? '' : 'page-hidden'} size="small" key={shot.id} title={`镜头 ${shot.order}`}>
          <Space wrap>
            <Button disabled={index === 0 || state.busy || planLocked(p)} onClick={(): void => edit((v: PetStoryPlan): void => { [v.shots[index - 1], v.shots[index]] = [v.shots[index], v.shots[index - 1]]; v.shots = renumber(v.shots); })}>上移</Button>
            <Button disabled={index === plan.shots.length - 1 || state.busy || planLocked(p)} onClick={(): void => edit((v: PetStoryPlan): void => { [v.shots[index + 1], v.shots[index]] = [v.shots[index], v.shots[index + 1]]; v.shots = renumber(v.shots); })}>下移</Button>
            <Button danger disabled={state.busy || planLocked(p)} onClick={(): void => edit((v: PetStoryPlan): void => { v.shots.splice(index, 1); v.shots = renumber(v.shots); })}>删除镜头</Button>
            <InputNumber disabled={planLocked(p) || state.busy} aria-label={`${shot.id}时长`} addonAfter="秒" status={!Number.isFinite(shot.durationSeconds) || shot.durationSeconds < 5 || shot.durationSeconds > 10 ? 'error' : undefined} placeholder="5～10" value={Number.isFinite(shot.durationSeconds) ? shot.durationSeconds : null} onChange={(value: number | null): void => updateShot(shot.id, { durationSeconds: value ?? NaN })} />
          </Space>
          <div className="mt-3 space-y-2">
            <Select disabled={planLocked(p) || state.busy} aria-label={`${shot.id}角色及参考顺序`} className="w-full" mode="multiple" value={shot.characterIds} options={plan.characters.map((c: PetStoryCharacter): { value: string; label: string } => ({ value: c.id, label: c.name || c.id }))} onChange={(value: string[]): void => updateShot(shot.id, { characterIds: value, appearanceOverrides: Object.fromEntries(Object.entries(shot.appearanceOverrides || {}).filter(([id]): boolean => value.includes(id))) })} placeholder="选择本镜角色；按此顺序绑定参考图" />
            <Text type="secondary">生成素材顺序：{chatAssets({ ...p, plan }, shot.id).map((a, i): string => `${i + 1}→${a.kind === 'scene' ? '场景' : (a.characterIds || [a.characterId]).filter((id): boolean => !!id && shot.characterIds.includes(id)).map((id): string => plan.characters.find((c): boolean => c.id === id)?.name || id || '').join('、')}`).join('，') || '参考图待选择'}</Text>
            {plan.scenes && <Select className="w-full" aria-label={`${shot.id}所属场景`} placeholder="选择本镜所属场景" disabled={state.busy || planLocked(p)} value={shot.sceneId} options={plan.scenes.map((s): { value: string; label: string } => ({ value: s.id, label: `${s.name} · ${s.location}` }))} onChange={(sceneId: string): void => updateShot(shot.id, { sceneId, propIds: shot.propIds || [] })} />}
            {plan.props && <Select className="w-full" mode="multiple" aria-label={`${shot.id}关键道具`} placeholder="本镜关键道具" disabled={state.busy || planLocked(p)} value={shot.propIds || []} options={plan.props.map((p): { value: string; label: string } => ({ value: p.id, label: p.name }))} onChange={(propIds: string[]): void => updateShot(shot.id, { propIds, propStates: propIds.map((propId): NonNullable<PetStoryShot['propStates']>[number] => shot.propStates?.find((s): boolean => s.propId === propId) || { propId, state: '' }) })} />}
            {shot.propStates?.map((prop, propIndex): React.ReactNode => <Space className="w-full" key={prop.propId}><Text>{plan.props?.find((p): boolean => p.id === prop.propId)?.name || prop.propId}</Text><Select allowClear disabled={state.busy || planLocked(p)} placeholder="持有／使用者（无则留空）" value={prop.holderId} options={shot.characterIds.map((id): { value: string; label: string } => ({ value: id, label: plan.characters.find((c): boolean => c.id === id)?.name || id }))} onChange={(holderId?: string): void => updateShot(shot.id, { propStates: shot.propStates?.map((s, i): typeof prop => i === propIndex ? { ...s, holderId } : s) })} /><Input disabled={state.busy || planLocked(p)} placeholder="本镜道具状态、使用与交接" value={prop.state} onChange={(e): void => updateShot(shot.id, { propStates: shot.propStates?.map((s, i): typeof prop => i === propIndex ? { ...s, state: e.target.value } : s) })} /></Space>)}
            {(['sceneView', 'expression', 'gaze', 'interaction', 'camera'] as const).map((key): React.ReactNode => <Input key={key} disabled={state.busy || planLocked(p)} aria-label={`${shot.id}${key}`} addonBefore={{ sceneView: '视角', expression: '神态变化', gaze: '视线目标', interaction: '互动', camera: '镜头方式' }[key]} value={shot[key] || ''} onChange={(e): void => updateShot(shot.id, { [key]: e.target.value })} />)}
            {shot.dialogue?.map((d, i): React.ReactNode => <Space key={i} wrap><Select disabled={state.busy || planLocked(p)} aria-label={`${shot.id}台词${i}说话者`} value={d.speakerId} options={shot.characterIds.map((id): { value: string; label: string } => ({ value: id, label: plan.characters.find((c): boolean => c.id === id)?.name || id }))} onChange={(speakerId: string): void => updateShot(shot.id, { dialogue: shot.dialogue?.map((v, index): typeof d => index === i ? { ...v, speakerId } : v) })} />{(['text', 'tone', 'pace'] as const).map((key): React.ReactNode => <Input key={key} disabled={state.busy || planLocked(p)} addonBefore={{ text: '剧本已有台词', tone: '语气', pace: '节奏' }[key]} value={d[key]} onChange={(e): void => updateShot(shot.id, { dialogue: shot.dialogue?.map((v, index): typeof d => index === i ? { ...v, [key]: e.target.value } : v) })} />)}<Button danger disabled={state.busy || planLocked(p)} onClick={(): void => updateShot(shot.id, { dialogue: shot.dialogue?.filter((_v, index): boolean => index !== i) })}>删除此句</Button></Space>)}
            <Button disabled={state.busy || planLocked(p) || !shot.characterIds.length} onClick={(): void => updateShot(shot.id, { dialogue: [...(shot.dialogue || []), { speakerId: shot.characterIds[0], text: '', tone: '', pace: '' }] })}>补入剧本已有台词</Button>
            {(['scene', 'action', 'startState', 'endState'] as const).map((field): React.ReactNode => <Input disabled={planLocked(p) || state.busy} key={field} aria-label={`${shot.id}${field}`} addonBefore={{ scene: '场景', action: '主要动作', startState: '开始状态', endState: '结束状态' }[field]} value={shot[field]} onChange={(e): void => updateShot(shot.id, { [field]: e.target.value })} />)}
            {shot.characterIds.map((id): React.ReactNode => <Input key={id} disabled={planLocked(p) || state.busy} aria-label={`${shot.id}${id}本场造型`} addonBefore={`${plan.characters.find((c): boolean => c.id === id)?.name || id}本场造型`} placeholder="仅填写本场明确的衣装／装饰变更；空白沿用项目与参考" value={shot.appearanceOverrides?.[id] || ''} onChange={(event): void => updateShot(shot.id, { appearanceOverrides: { ...shot.appearanceOverrides, [id]: event.target.value } })} />)}
            <Space wrap>
              <Select disabled={planLocked(p) || state.busy} aria-label={`${shot.id}关系`} value={shot.transition} options={[{ value: 'cut', label: '正常切镜' }, { value: 'continue', label: '连续动作' }]} onChange={(value: 'cut' | 'continue'): void => updateShot(shot.id, { transition: value, previousShotId: value === 'continue' ? plan.shots[index - 1]?.id : undefined })} />
              <Select disabled={planLocked(p) || state.busy} aria-label={`${shot.id}请求模式`} value={shot.requestedMode} options={[{ value: 'auto', label: '自动选择' }, { value: 'first_frame', label: '首帧' }, { value: 'first_last_frame', label: '首尾帧（待能力确认）' }, { value: 'reference', label: '参考图' }]} onChange={(value: PetStoryShot['requestedMode']): void => updateShot(shot.id, { requestedMode: value, prompts: { ...shot.prompts, lastFrame: value === 'first_last_frame' ? shot.prompts.lastFrame || blankPrompt() : shot.prompts.lastFrame } })} />
            </Space>
            <Space wrap><Button disabled={disabled} onClick={(): void => setStage(2)}>查看与准备场景图片</Button>{shot.sceneReferenceAssetIds?.map((id): React.ReactNode => <ReferenceImage key={id} projectId={p.id} assetId={id} name="本镜场景" />)}</Space>
            <Button disabled={disabled} onClick={(): void => { void state.draftFinal(shot.id); }}>检查首帧制作前置条件</Button>
          </div>
        </Card>)}
        </div></div>
      </>}
      </div>
      <div hidden={stage !== 7} className={stage === 7 ? 'stage-content':'page-hidden'}><Collapse items={[{key:'production',label:'高级批量制作、模式备选及原批次恢复',children:<ProductionControls project={p} disabled={state.busy || drafts.length>0} view="prepare" showMaterials={false} />},{key:'progress',label:'原批次素材、多图选择与连续镜头记录',children:<ProductionControls project={p} disabled={state.busy || drafts.length>0} view="progress" showMaterials={false} />}]} /></div>
    </>}
  </section>;
};
