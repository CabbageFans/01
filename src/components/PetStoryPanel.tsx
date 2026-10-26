import React, { useEffect, useState, useRef } from 'react';
import { Alert, Button, Card, Checkbox, Collapse, Input, InputNumber, Select, Space, Tag, Typography, Tabs, ConfigProvider, Empty } from 'antd';
import type { PetStoryPlan, PetStoryShot, PetStoryPrompt, PetStoryPromptKind, PetStoryCharacter, PetStoryProject, PetStoryPromptProfile, PetStoryCompiledPrompt, PetStoryResolvedMode } from '@doubao-studio/contracts';
import { PetStoryPlanAssets } from './PetStoryPlanAssets';
import { PetStoryMaterials } from './PetStoryMaterials';
import { PetStoryCanvas } from './PetStoryCanvas';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { useProjectStore } from '../store/useProjectStore';
import { navigateWorkspace } from '../utils/workspace';
import { useAccountStore } from '../store/useAccountStore';
import { DEFAULT_PROMPT_PROFILE, chatAssets, mobileStoryPrompt } from '../utils/petstoryPrompts';

const { Text, Title } = Typography;
const { TextArea } = Input;
const promptLabels: Record<PetStoryPromptKind, string> = { firstFrame: '首帧', lastFrame: '尾帧', video: '视频' };
function planLocked(project: PetStoryProject | null): boolean { const production = project?.production; if (production?.target && production.state === 'complete' && production.steps.every((step): boolean => step.status === 'complete')) return false; return !!production && (production.phase !== 'materials' || production.state === 'running' || production.steps.some((step): boolean => step.status !== 'complete')); }
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
function canAnalyzeStory(project: PetStoryProject, freeConfirmed: boolean): boolean {
  return !!project.mobileStory && freeConfirmed && !project.jobs.some((job): boolean => job.kind === 'analysis' && job.sourceUrl === project.source.url && job.sourceStoryId === project.mobileStory?.id);
}
const PromptProfileEditor: React.FC<{ project: PetStoryProject; disabled: boolean; onDirtyChange: (value: boolean) => void; profile: PetStoryPromptProfile; setProfile: (value: PetStoryPromptProfile) => void }> = ({ project, disabled, onDirtyChange, profile, setProfile }): React.ReactElement => {
  const state = usePetStoryStore();
  const changed = JSON.stringify(profile) !== JSON.stringify(project.promptProfile || DEFAULT_PROMPT_PROFILE);
  useEffect((): void => { onDirtyChange(changed); }, [changed, onDirtyChange]);
  return <Collapse items={[{ key: 'profile', label: '噜噜／噜妹默认角色与共同风格（可编辑）', children: <Space direction="vertical" className="w-full">
    <Text type="secondary">可编辑的默认身份与视觉特点；实际参考和明确换装优先。当前剧情的动作、服装和环境在项目或镜头中填写。</Text>
    {(['lulu', 'lumei'] as const).map((id): React.ReactNode => <div className="w-full" key={id}><Text strong>{id === 'lulu' ? '噜噜' : '噜妹'}</Text>{(['identity', 'appearance'] as const).map((field): React.ReactNode => <TextArea key={field} disabled={disabled || state.busy} aria-label={`${id}${field}预设`} placeholder={field === 'identity' ? '身份锚点' : '仅未指定时的默认造型'} value={profile.characters[id]?.[field] || ''} autoSize={{ minRows: 2, maxRows: 5 }} onChange={(event): void => setProfile({ ...profile, characters: { ...profile.characters, [id]: { ...profile.characters[id], [field]: event.target.value } } })} />)}</div>)}
    {(['common', 'character', 'prop', 'scene'] as const).map((kind): React.ReactNode => <div className="w-full" key={kind}><Text>{({ common: '共同媒介／画面语言', character: '人物专用风格', prop: '道具专用风格', scene: '场景专用风格' })[kind]}</Text><TextArea disabled={disabled || state.busy} aria-label={`${kind}视觉风格`} value={profile.assetStyles?.[kind] || ''} autoSize={{ minRows: 2, maxRows: 4 }} onChange={(event): void => setProfile({ ...profile, assetStyles: { ...profile.assetStyles, [kind]: event.target.value } })} /></div>)}
    {profile.style && <Collapse items={[{ key: 'legacy-style', label: '旧共同风格（保留，需手动归入适用类别）', children: <pre className="prompt-readonly">{profile.style}</pre> }]} />}
    <Button disabled={disabled || state.busy || (!changed && !!project.promptProfile)} onClick={(): void => { void state.savePromptProfile(profile); }}>保存项目预设（不改写最终文本）</Button>
  </Space> }]} />;
};
const CompiledPromptDetails: React.FC<{ project: PetStoryProject; shot: PetStoryShot; kind: PetStoryPromptKind; dirty: boolean }> = ({ project, shot, kind, dirty }): React.ReactElement => {
  const state = usePetStoryStore();
  const tasks = useTaskStore((s) => s.tasks);
  const resolution = project.production?.shots[shot.id] || state.productionResolutions[shot.id];
  const mode: PetStoryResolvedMode | undefined = resolution?.resolvedMode || (shot.requestedMode === 'auto' ? undefined : shot.requestedMode);
  const [compiled, setCompiled] = useState<PetStoryCompiledPrompt>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; setCompiled(undefined); setError('');
    if (!dirty) void window.electronAPI.petstory.previewPrompt(project.id, shot.id, kind, mode).then((result): void => {
      if (!active) return;
      setCompiled(result.compiledPrompt); setError(result.error || '');
    }).catch((): void => { if (active) setError('提交预览读取失败'); });
    return (): void => { active = false; };
  }, [project.id, project.revision, shot.id, kind, mode, dirty]);
  const step = [...(project.production?.steps || [])].reverse().find((s): boolean => s.shotId === shot.id && s.kind === kind);
  const draft = [...(project.drafts || [])].reverse().find((d): boolean => d.shotId === shot.id && d.kind === kind);
  const snapshot = step?.compiledPrompt || draft?.compiledPrompt;
  const task = tasks.find((t): boolean => t.id === (step?.taskId || draft?.taskId));
  return <Collapse className="mt-2" items={[{ key: 'compiled', label: '提交全文与真实素材用途', children: <Space direction="vertical" className="w-full">
    <Text>本镜角色：{shot.characterIds.map((id): string => project.plan?.characters.find((c): boolean => c.id === id)?.name || id).join('、') || '无'}；请求 {shot.requestedMode} → {resolution ? `本次解析 ${resolution.resolvedMode}` : '尚未核对实际模式'}</Text>
    <Text type="secondary">final 是唯一动作正文，编译只加入参考用途与阶段约束。下方为计划预览；pending 不是实际页面编号。实际绑定与发送输入单独展示和导出。</Text>
    {dirty ? <Text>请先保存所有修改以更新提交预览。</Text> : error ? <Alert type="warning" message={error} /> : compiled && <><pre className="prompt-readonly">{compiled.references.map((r): string => `${r.order} · ${r.purpose} · ${r.characterIds.join('、')} · ${r.assetId}${r.slot ? ` · ${r.slot}槽` : ''}`).join('\n')}</pre><pre className="prompt-readonly">{compiled.text}</pre></>}
    {step?.pageBindings && <><Text strong>本次实际网页素材与引用回读</Text><pre className="prompt-readonly">{step.pageBindings.map((b): string => `${b.order} · ${b.assetId} → ${b.label} · ${b.slot} · ${b.reference}${b.nodeId ? ` · 原生节点 ${b.nodeId}` : ''} · 预览摘要 ${b.previewHash.slice(0, 12)}`).join('\n')}</pre></>}
    {(snapshot || task) && <><Text strong>{task?.runtime?.submittedAt ? '最近实际提交的运行输入' : '最近已保存任务输入（不表示已提交）'}</Text><pre className="prompt-readonly">{task?.runtime?.input.prompt || snapshot?.text || task?.prompt}</pre></>}
  </Space> }]} />;
};
const MobileStoryInput: React.FC<{ project: PetStoryProject; disabled: boolean; linkUnsaved: boolean; onDirtyChange: (dirty: boolean) => void }> = ({ project: p, disabled, linkUnsaved, onDirtyChange }): React.ReactElement => {
  const save = usePetStoryStore((state) => state.saveMobileStory);
  const [storyText, setStoryText] = useState(p.mobileStory?.text || '');
  const [copyState, setCopyState] = useState('');
  useEffect((): void => { setStoryText(p.mobileStory?.text || ''); setCopyState(''); }, [p.id, p.mobileStory?.text]);
  useEffect((): void => { onDirtyChange(storyText !== (p.mobileStory?.text || '')); }, [storyText, p.mobileStory?.text, onDirtyChange]);
  const phonePrompt = p.source.url ? mobileStoryPrompt(p) : '';
  const copyPhonePrompt = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(phonePrompt); setCopyState('已复制，请在手机豆包粘贴发送，再将故事情节复制回来。'); }
    catch { setCopyState('未能复制，请从下面的提示词框手动选择复制。'); }
  };
  return (
        <div className="mt-4 space-y-2">
          <Text strong>1. 在手机豆包取得故事情节</Text>
          <div><Text type="secondary">保存链接后，复制下方提示词到手机豆包发送。取得故事后请对照原视频核对，再复制回来。桌面端不再尝试读取抖音视频。</Text></div>
          <Button disabled={disabled || !phonePrompt || linkUnsaved} onClick={(): void => { void copyPhonePrompt(); }}>复制手机豆包提示词</Button>
          {copyState && <div role="status"><Text type="secondary">{copyState}</Text></div>}
          {phonePrompt && <TextArea aria-label="手机豆包提示词" readOnly value={phonePrompt} autoSize={{ minRows: 3, maxRows: 6 }} />}
          <div><Text strong>2. 粘贴剧本或手机豆包返回的故事情节</Text></div>
          <TextArea readOnly={disabled} aria-label="手机豆包故事原文" value={storyText} onChange={(e): void => setStoryText(e.target.value)} autoSize={{ minRows: 5, maxRows: 12 }} maxLength={50_000} showCount placeholder="可直接粘贴已核对剧本，也可粘贴手机豆包故事，包括开头、关键变化和结局；无需 JSON。" />
          <Button disabled={disabled || linkUnsaved || !storyText.trim() || storyText === p.mobileStory?.text} onClick={(): void => { void save(storyText); }}>保存故事情节</Button>
          {p.mobileStory && <Tag color="green">{p.source.kind === 'script' ? '剧本原文已保存' : '手机故事原文已保存'}</Tag>}
        </div>
  );
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
  return <Select className="w-72" aria-label={`${stepId}选中图片`} placeholder="选择原任务返回的另一有效图片" value={selected} disabled={state.busy}
    options={artifacts.map((a, index): { value: string; label: string } => ({ value: a.id, label: `原任务第 ${index + 1} 张${a.id === selected ? '（当前选中）' : ''}` }))}
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
  useEffect((): void => { setFreeConfirmed(false); }, [project.id]);
  return <Card size="small" title={view === 'prepare' ? '核对入口与制作计划' : '镜头制作进度'}>
    <Space direction="vertical" className="w-full">
      <Text type="secondary">在原账号检查一次可见创作入口，无上传、无提交。未识别槽位保留待确认；检查和本地数量均不是豆包官方剩余额度。</Text>
      <Checkbox checked={freeConfirmed} onChange={(event): void => setFreeConfirmed(event.target.checked)}>本人已核对原账号当前图片／视频入口及选定规格免费可用；收费或未知时不勾选</Checkbox>
      <Button disabled={disabled || (production?.state === 'running' && currentEntryChecked)} onClick={(): void => { void state.inspectCapability(freeConfirmed); }}>{currentEntryChecked ? '重新核对当前入口（暂停后）' : '检查当前可见入口（不提交）'}</Button>
      {capability && !state.capabilityCheckedInSession && <Alert type="info" message="已恢复保存的模型选择，仅用于文字创作；生成或继续制作前请先检查当前会话的免费入口。" />}
      {!capability && production?.capability && <Alert type="info" message={`已保存检查：${new Date(production.capability.checkedAt).toLocaleString('zh-CN')} · ${production.capability.freeEvidence === 'user_confirmed' ? '本人确认免费' : production.capability.freeEvidence === 'visible' ? '页面观察免费' : '免费状态未知'}。恢复前仍需核对当前入口。`} />}
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
          <Button type="primary" disabled={disabled || !currentEntryChecked} onClick={(): void => { void state.resumeProduction(); }}>显式继续原制作</Button>
          {production.state === 'paused' && pendingTask?.runtime?.submittedAt && !pendingTask.runtime.conversationUrl && <Button disabled={state.busy} onClick={(): void => {
            window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: pendingTask.id, useCurrentPage: true } }));
          }}>只读核对当前原制作会话</Button>}
        </>}
      </Space>
      {view === 'prepare' && showMaterials && <PetStoryMaterials project={project} disabled={disabled} />}
      {production && production.phase !== 'materials' && view === 'progress' && <>
        <Alert type={production.state === 'paused' ? 'warning' : production.state === 'complete' ? 'success' : 'info'} message={`${production.state === 'complete' ? '镜头素材已生成并完成下载校验' : `${production.state === 'paused' ? '制作已暂停' : '正在制作镜头素材'} · ${production.message}`}`} />
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
        <Collapse items={[{ key: 'steps', label: '当前步骤与素材绑定（首个有效产物按本次返回顺序选择）', children: production.steps.map((step): React.ReactNode => <div key={step.id}><Text>{step.characterId || step.shotId} / {step.kind} / {step.status} · {step.taskId || '创建意图已保存，待核对任务'} · {step.error}</Text><ProductionImageChoice project={project} stepId={step.id} /></div>) }]} />
      </>}
    </Space>
  </Card>;
};
export const PetStoryPanel: React.FC = () => {
  const state = usePetStoryStore();
  const tasks = useTaskStore((s) => s.tasks);
  const accounts = useAccountStore((s) => s.accounts);
  const p = state.project;
  const projects = useProjectStore((s) => s.projects);
  const [stage, setStage] = useState(0);
  const [selectedShotId, setSelectedShotId] = useState('');
  const stageProjectId = useRef('');
  useEffect((): void => { if (p && p.id !== stageProjectId.current) { stageProjectId.current = p.id; setStage(p.plan ? 4 : 0); } }, [p]);
  const [link, setLink] = useState('');
  const [plan, setPlan] = useState<PetStoryPlan | null>(null);
  const [dirty, setDirty] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const [canvasDirty, setCanvasDirty] = useState(false);
  const [profileDraft, setProfileDraft] = useState<PetStoryPromptProfile>(() => structuredClone(DEFAULT_PROMPT_PROFILE));
  const profileProjectId = useRef('');
  useEffect((): void => { if (!p) return; if (profileProjectId.current !== p.id || !profileDirty) { profileProjectId.current = p.id; setProfileDraft(structuredClone(p.promptProfile || DEFAULT_PROMPT_PROFILE)); } }, [p, profileDirty]);
  const [localProjectId, setLocalProjectId] = useState('');
  useEffect((): void => {
    if (!p) return;
    if (p.id !== localProjectId || !dirty) {
      setPlan(p.plan ? structuredClone(p.plan) : null);
      setLink(p.source.url);
      setLocalProjectId(p.id);
      setDirty(false);
    }
  }, [p, dirty, localProjectId]);
  const edit = (change: (value: PetStoryPlan) => void): void => {
    if (!plan || planLocked(p)) return;
    const next = structuredClone(plan);
    change(next);
    setPlan(next);
    setDirty(true);
  };
  const updateShot = (id: string, patch: Partial<PetStoryShot>): void => edit((value: PetStoryPlan): void => {
    value.shots = value.shots.map((s: PetStoryShot): PetStoryShot => s.id === id ? { ...s, ...patch } : s);
  });
  const updatePrompt = (id: string, kind: PetStoryPromptKind, final: string): void => edit((value: PetStoryPlan): void => {
    const prompt = value.shots.find((s: PetStoryShot): boolean => s.id === id)?.prompts[kind];
    if (!prompt) return;
    if (prompt.rulesVersion === 'manual') prompt.original = final;
    prompt.final = final;
    prompt.edited = true;
  });
  const addShot = (): void => edit((value: PetStoryPlan): void => {
    value.shots.push({ id: `shot-${crypto.randomUUID()}`, order: value.shots.length + 1, characterIds: [], scene: '', action: '', startState: '', endState: '', durationSeconds: NaN,
      transition: 'cut', requestedMode: 'auto', prompts: { firstFrame: blankPrompt(), video: blankPrompt() } });
  });
  const addCharacter = (): void => edit((value: PetStoryPlan): void => {
    value.characters.push({ id: `support-${crypto.randomUUID()}`, name: '', role: 'supporting', purpose: '', description: '' });
  });
  const disabled = state.busy || dirty || profileDirty || planLocked(p);
  const [storyDirty, setStoryDirty] = useState(false);
  const sourceDirty = !!p && (link !== p.source.url || storyDirty);
  const accountName = accounts.find((a): boolean => a.id === p?.accountId)?.name || '原账号缺失';
  const retryableJob = p?.jobs.find((job): boolean => !!p.mobileStory && job.sourceStoryId === p.mobileStory.id && job.status === 'bound' && job.sourceUrl === p.source.url && tasks.some((task): boolean =>
    task.id === job.taskId && ['fail', 'paused', 'cancelled', 'waiting_verification'].includes(task.status) && !!task.runtime && !task.runtime.submittedAt && !task.runtime.acceptanceObservation
    && ['video_prompt_not_ready', 'video_assets_not_ready', 'chat_assets_not_ready', 'page_unrecognized', 'page_loading', 'authentication_unconfirmed', 'cancelled'].includes(task.errorInfo?.code || '')));
  return <section className={`petstory-panel space-y-4 ${stage === 4 ? 'canvas-active' : ''}`} aria-label="萌宠短剧">

    <Space wrap>
      <Button onClick={(): void => { void state.createProject(); }} disabled={state.busy || dirty || profileDirty || canvasDirty}>新建项目目录</Button>
      <Button onClick={(): void => { void state.openProject(); }} disabled={state.busy || dirty || profileDirty || canvasDirty}>打开项目目录</Button>
      {p && <Button disabled={state.busy || dirty || profileDirty || sourceDirty || canvasDirty} onClick={(): void => { void state.exportPrompts(); }}>导出提示词与引用记录（不生成媒体）</Button>}
      {p && <><Tag>本地短剧 · {state.projectName || p.id.slice(0, 8)}</Tag><Tag>关联 Studio：{projects.find((project): boolean => project.id === p.studioProjectId)?.name || '原项目缺失'}</Tag><Tag>执行账号：{accountName}</Tag><Tag color={dirty || sourceDirty ? 'orange' : 'default'}>{dirty || sourceDirty ? '有未保存内容' : `已保存 · v${p.revision}`}</Tag></>}
    </Space>
    {state.error && <Alert type="error" showIcon message={state.error} />}
    {state.exportStatus && <Alert type="info" message={state.exportStatus} />}
    {!p && <Alert type="info" message="先在“账号与浏览器”选择本人豆包账号，再新建短剧目录；也可打开已有目录继续。当前仅制作逐镜素材。" />}
    {p && <>
      <nav className="petstory-stages" aria-label="短剧制作阶段"><button className={stage === 4 ? 'active' : ''} aria-current={stage === 4 ? 'step' : undefined} onClick={(): void => setStage(4)}><span>◫</span>分镜生产画布</button>{['故事输入', '角色与草稿分镜', '基础素材与制作准备', '制作进度与素材'].map((label: string, index: number): React.ReactNode => <button key={label} className={stage === index ? 'active' : ''} aria-current={stage === index ? 'step' : undefined} onClick={(): void => setStage(index)}><span>{index + 1}</span>{label}</button>)}</nav>
      <div className={stage === 4 ? 'stage-content' : 'page-hidden'}><PetStoryCanvas key={p.id} project={p} onDirtyChange={setCanvasDirty} legacyDirty={dirty || profileDirty || sourceDirty} materials={<><PetStoryMaterials project={p} disabled={disabled} generationBlocked={canvasDirty} />{plan && <Collapse items={[{ key: 'inventory', label: '在同页编辑人物、道具与场景档案', children: <><ConfigProvider componentDisabled={state.busy || planLocked(p) || p.jobs.some((j): boolean => j.status === 'bound' || j.status === 'captured')}><div className="canvas-character-fields">{plan.characters.map((c, index): React.ReactNode => <div key={c.id}><Text strong>{c.name}</Text><Input aria-label={`${c.id}画布角色名称`} value={c.name} onChange={(e): void => edit((v: PetStoryPlan): void => { v.characters[index].name = e.target.value; })} /><TextArea aria-label={`${c.id}画布角色档案`} value={c.description} onChange={(e): void => edit((v: PetStoryPlan): void => { v.characters[index].description = e.target.value; })} /></div>)}</div><PetStoryPlanAssets plan={plan} disabled={state.busy || planLocked(p) || p.jobs.some((j): boolean => j.status === 'bound' || j.status === 'captured')} edit={edit} /></ConfigProvider><Button type="primary" disabled={!dirty || state.busy || planLocked(p)} onClick={(): void => { void state.savePlan(plan).then((): void => { if (!usePetStoryStore.getState().error) setDirty(false); }); }}>保存资产档案修改</Button></> }]} />}<div className="canvas-legacy-references"><Text strong>已有角色档案与用户参考图</Text>{p.plan?.characters.map((character): React.ReactNode => <div key={character.id}><Text strong>{character.name}</Text><p>{character.description}</p>{character.referenceAssetId && <ReferenceImage projectId={p.id} assetId={character.referenceAssetId} name={character.name} />}<Button disabled={disabled} onClick={(): void => { void state.addReference(character.id); }}>选择 / 替换角色参考图</Button></div>)}</div><PromptProfileEditor project={p} profile={profileDraft} setProfile={setProfileDraft} disabled={state.busy || dirty || planLocked(p)} onDirtyChange={setProfileDirty} /></>} controls={<ProductionControls project={p} disabled={state.busy || dirty || profileDirty || sourceDirty || canvasDirty} view="prepare" showMaterials={false} />} /></div>
      {planLocked(p) && <Alert type="info" showIcon message="方案已进入制作，编辑已锁定；可查看方案、原任务与镜头素材。" />}
      <div className={stage === 0 ? 'stage-content space-y-4' : 'page-hidden'}>
      <Card size="small" title="来源与默认主演">
        <TextArea readOnly={planLocked(p)} aria-label="抖音分享文本或链接" value={link} onChange={(e): void => setLink(e.target.value)} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="可选：粘贴抖音来源链接；已有剧本可直接保存下方原文" />
        <Space className="mt-2" wrap>
          <Button onClick={(): void => { void state.saveSource(link); }} disabled={disabled}>保存链接</Button>
          {(['lulu', 'lumei'] as const).map((id): React.ReactNode => <Button key={id} disabled={disabled} onClick={(): void => { void state.addReference(id); }}>
            {id === 'lulu' ? '噜噜' : '噜妹'}参考图 {p.assets.some((a): boolean => (a.characterIds || [a.characterId]).includes(id)) ? '✓' : '待选择'}
          </Button>)}
        </Space>
        <Space className="mt-2" wrap>{(['lulu', 'lumei'] as const).map((id): React.ReactNode => <Select key={id} disabled={disabled} className="w-72" value={null} aria-label={`${id}复用同框身份图`} placeholder={`${id === 'lulu' ? '噜噜' : '噜妹'}：确认同框后复用已有图`} options={p.assets.filter((a): boolean => a.kind === 'character').map((a): { value: string; label: string } => ({ value: a.id, label: `已有图 · ${(a.characterIds || [a.characterId]).join('、')}` }))} onChange={(assetId: string): void => { void state.bindSharedReference(id, assetId); }} />)}</Space>
        <PromptProfileEditor project={p} profile={profileDraft} setProfile={setProfileDraft} disabled={state.busy || dirty || planLocked(p)} onDirtyChange={setProfileDirty} />
        <MobileStoryInput project={p} disabled={disabled} linkUnsaved={link !== p.source.url} onDirtyChange={setStoryDirty} />
        <div className="flex gap-3 mt-3">{p.assets.filter((a): boolean => a.kind === 'character' && (a.characterIds || [a.characterId]).some((id): boolean => id === 'lulu' || id === 'lumei')).map((a): React.ReactNode => <ReferenceImage key={a.id} projectId={p.id} assetId={a.id} name={(a.characterIds || [a.characterId]).map((id): string => id === 'lulu' ? '噜噜' : id === 'lumei' ? '噜妹' : id || '').join('、')} />)}</div>
        <div className="mt-3 space-y-2">
          <Checkbox disabled={planLocked(p)} checked={state.freeChatConfirmed} onChange={(e): void => state.setFreeChatConfirmed(e.target.checked)}>本人已确认项目原账号当前普通 Chat 免费可用</Checkbox>
          <Checkbox disabled={planLocked(p)} checked={state.autoRepair} onChange={(e): void => state.setAutoRepair(e.target.checked)}>回复缺项时允许最多追加一次完整修订对话</Checkbox>
          <div><Button type="primary" disabled={disabled || sourceDirty || !canAnalyzeStory(p, state.freeChatConfirmed)} onClick={(): void => { void state.analyze(); }}>根据已保存故事生成制作方案</Button></div>
          {retryableJob && <div><Alert className="mb-2" type="warning" showIcon message="原 Chat 任务在提交前停止。处理附件或页面问题后，可保留链接、角色图和原任务重试。" /><Button type="primary" disabled={disabled || !state.freeChatConfirmed} onClick={(): void => { void state.retryUnsubmitted(retryableJob.id); }}>重试原任务（尚未提交）</Button></div>}
        </div>
        <div className="mt-3"><Text type="secondary">桌面普通 Chat 仅处理你粘贴的故事与角色参考图。故事不足时请补充原文；工具不获取或分析链接视频。复制提示词、保存原文不会发送模型请求。</Text></div>
        {p.source.reason && <Alert className="mt-3" type={p.source.status === 'blocked' ? 'error' : 'warning'} message={p.source.reason} />}
        {p.contentBasis && <Collapse className="mt-3" items={[{ key: 'basis', label: '按粘贴原文整理的故事依据（待本人核对）', children: <Space direction="vertical"><Text>开头：{p.contentBasis.beginning}</Text><Text>变化：{p.contentBasis.middle}</Text><Text>结局：{p.contentBasis.ending}</Text></Space> }]} />}
      </Card>
      {p.jobs.length > 0 && <Collapse items={[{ key: 'jobs', label: '本次 Chat 原文、任务绑定与收取结果', children: <Space direction="vertical" className="w-full">
        {p.jobs.map((job): React.ReactNode => <Card size="small" key={job.id} title={`${job.kind} · ${job.status}`}>
          <Text type="secondary">任务 {job.taskId} · {tasks.find((t): boolean => t.id === job.taskId)?.status || '原任务缺失'}</Text>
          {job.runId && <div><Text type="secondary">运行 {job.runId}</Text></div>}
          {job.error && <Alert type="warning" message={job.error} />}
          {!job.sourceStoryId && <Tag>旧版链接直读记录，仅供核对</Tag>}
          <Space className="mt-2" wrap>
            {!!p.mobileStory && job.sourceStoryId === p.mobileStory.id && job.status === 'bound' && tasks.some((t): boolean => t.id === job.taskId && t.status === 'queued') && <Button disabled={disabled || sourceDirty || !state.freeChatConfirmed} onClick={(): void => { void state.startBoundChat(job.id); }}>启动原绑定 Chat 任务</Button>}
            <Button disabled={disabled || job.status === 'applied'} onClick={(): void => { void state.collect(job.id); }}>读取原任务已保存正文</Button>
            <Button disabled={disabled || job.status === 'applied' || !tasks.some((t): boolean => t.id === job.taskId && !!t.runtime?.submittedAt && ['paused', 'fail', 'cancelled', 'waiting_verification'].includes(t.status))} onClick={(): void => { window.dispatchEvent(new CustomEvent('reconcile-task-submission', { detail: { taskId: job.taskId, useCurrentPage: !tasks.find((t): boolean => t.id === job.taskId)?.runtime?.conversationUrl } })); }}>{tasks.find((t): boolean => t.id === job.taskId)?.runtime?.conversationUrl ? '原会话只读补取' : '核对当前 Chat 原回复'}</Button>
            {!!p.mobileStory && job.sourceStoryId === p.mobileStory.id && job.kind === 'analysis' && job.status === 'invalid' && p.source.status !== 'blocked' && !p.jobs.some((j): boolean => j.parentJobId === job.id) && <Button disabled={disabled || sourceDirty || !state.freeChatConfirmed} onClick={(): void => { void state.correctOnce(job.id); }}>纠正一次结构</Button>}
          </Space>
          {job.rawText && <pre className="mt-2 whitespace-pre-wrap break-words text-xs max-h-80 overflow-auto select-text">{job.rawText}</pre>}
        </Card>)}
      </Space> }]} />}
      </div>
      <div className={stage === 1 ? 'stage-content space-y-4' : 'page-hidden'}>
      {!plan && <Empty description="保存手机故事并生成制作方案后，在这里整理角色与分镜" />}
      {plan && <>
        <ConfigProvider componentDisabled={state.busy || planLocked(p)}>
        <Card size="small" title="故事与角色">
          <Text>原片梗概</Text><TextArea aria-label="原片梗概" value={plan.sourceSummary} onChange={(e): void => edit((v: PetStoryPlan): void => { v.sourceSummary = e.target.value; })} autoSize={{ minRows: 2, maxRows: 5 }} />
          <div className="mt-3"><Text>相似故事</Text><TextArea aria-label="相似故事" value={plan.adaptedStory} onChange={(e): void => edit((v: PetStoryPlan): void => { v.adaptedStory = e.target.value; })} autoSize={{ minRows: 2, maxRows: 5 }} /></div>
          <Collapse className="mt-4" items={[{ key: 'characters', label: `角色档案 · ${plan.characters.length} 位 · 默认主演与必要配角`, children: <div className="character-grid">{plan.characters.map((c: PetStoryCharacter, index: number): React.ReactNode => <div key={c.id} className="rounded border border-gray-700 p-2 space-y-2">
            <Space><Tag>{c.role === 'main' ? '默认主演' : '必要配角'}</Tag><Text code>{c.id}</Text></Space>
            <Input aria-label={`${c.id}名称`} value={c.name} disabled={state.busy || planLocked(p)} onChange={(e): void => edit((v: PetStoryPlan): void => { v.characters[index].name = e.target.value; })} />
            <Input aria-label={`${c.id}剧情作用`} placeholder="剧情作用" value={c.purpose} onChange={(e): void => edit((v: PetStoryPlan): void => { v.characters[index].purpose = e.target.value; })} />
            <Input aria-label={`${c.id}外观设定`} placeholder="外观与服装" value={c.description} onChange={(e): void => edit((v: PetStoryPlan): void => { v.characters[index].description = e.target.value; })} />
            {c.referenceAssetId && <ReferenceImage projectId={p.id} assetId={c.referenceAssetId} name={c.name} />}
            <Button disabled={disabled} onClick={(): void => { void state.addReference(c.id); }}>{c.referenceAssetId ? '替换项目参考图' : '选择项目参考图'}</Button>
            <Select className="w-full" disabled={disabled} value={null} placeholder="确认同框后复用已有身份图" options={p.assets.filter((a): boolean => a.kind === 'character').map((a): { value: string; label: string } => ({ value: a.id, label: `已有图 · ${(a.characterIds || [a.characterId]).join('、')}` }))} onChange={(assetId: string): void => { void state.bindSharedReference(c.id, assetId); }} />
            {<Button danger disabled={state.busy || planLocked(p)} onClick={(): void => edit((v: PetStoryPlan): void => { v.characters.splice(index, 1); })}>删除人物</Button>}
          </div>)}</div> }]} />
          <Button className="mt-3" onClick={addCharacter} disabled={state.busy || planLocked(p)}>添加必要配角</Button>
        </Card>
        <PetStoryPlanAssets plan={plan} disabled={state.busy || planLocked(p)} edit={edit} />
        </ConfigProvider>
        <Space wrap><Title level={5} className="!m-0">{plan.shots.length} 个镜头 · {plan.characters.length} 个角色</Title><Button onClick={addShot} disabled={state.busy || planLocked(p)}>增加镜头</Button><Button type="primary" disabled={!dirty || state.busy || planLocked(p)} onClick={(): void => { void state.savePlan(plan).then((): void => { if (!usePetStoryStore.getState().error) setDirty(false); }); }}>校验并保存所有修改</Button>{dirty && <Tag color="orange">有未保存修改</Tag>}</Space>
        <div className="shot-workspace"><nav className="shot-list" aria-label="镜头列表">{plan.shots.map((shot: PetStoryShot): React.ReactNode => <button key={shot.id} className={(plan.shots.find((item): boolean => item.id === selectedShotId)?.id || plan.shots[0]?.id) === shot.id ? 'active' : ''} onClick={(): void => setSelectedShotId(shot.id)}><span className="shot-number">{String(shot.order).padStart(2, '0')}</span><span><strong>{shot.scene || '待填写场景'}</strong><small>{shot.characterIds.map((id: string): string => plan.characters.find((character): boolean => character.id === id)?.name || id).join('、') || '未选角色'}</small><small>{shot.durationSeconds || '—'} 秒 · {shot.transition === 'cut' ? '切镜' : '连续动作'} · {shot.requestedMode}</small></span></button>)}</nav><div className="shot-detail">
        {plan.shots.map((shot: PetStoryShot, index: number): React.ReactNode => <Card className={(plan.shots.find((item): boolean => item.id === selectedShotId)?.id || plan.shots[0]?.id) === shot.id ? '' : 'page-hidden'} size="small" key={shot.id} title={`镜头 ${shot.order} · ${shot.id}`}>
          <Space wrap>
            <Button disabled={index === 0 || state.busy || planLocked(p)} onClick={(): void => edit((v: PetStoryPlan): void => { [v.shots[index - 1], v.shots[index]] = [v.shots[index], v.shots[index - 1]]; v.shots = renumber(v.shots); })}>上移</Button>
            <Button disabled={index === plan.shots.length - 1 || state.busy || planLocked(p)} onClick={(): void => edit((v: PetStoryPlan): void => { [v.shots[index + 1], v.shots[index]] = [v.shots[index], v.shots[index + 1]]; v.shots = renumber(v.shots); })}>下移</Button>
            <Button danger disabled={state.busy || planLocked(p)} onClick={(): void => edit((v: PetStoryPlan): void => { v.shots.splice(index, 1); v.shots = renumber(v.shots); })}>删除镜头</Button>
            <InputNumber disabled={planLocked(p) || state.busy} aria-label={`${shot.id}时长`} addonAfter="秒" status={!Number.isFinite(shot.durationSeconds) || shot.durationSeconds < 5 || shot.durationSeconds > 10 ? 'error' : undefined} placeholder="5～10" value={Number.isFinite(shot.durationSeconds) ? shot.durationSeconds : null} onChange={(value: number | null): void => updateShot(shot.id, { durationSeconds: value ?? NaN })} />
          </Space>
          <div className="mt-3 space-y-2">
            <Select disabled={planLocked(p) || state.busy} aria-label={`${shot.id}角色及参考顺序`} className="w-full" mode="multiple" value={shot.characterIds} options={plan.characters.map((c: PetStoryCharacter): { value: string; label: string } => ({ value: c.id, label: c.name || c.id }))} onChange={(value: string[]): void => updateShot(shot.id, { characterIds: value, appearanceOverrides: Object.fromEntries(Object.entries(shot.appearanceOverrides || {}).filter(([id]): boolean => value.includes(id))) })} placeholder="选择本镜角色；按此顺序绑定参考图" />
            <Text type="secondary">生成素材顺序：{chatAssets({ ...p, plan }, shot.id).map((a, i): string => `${i + 1}→${a.kind === 'scene' ? '场景' : (a.characterIds || [a.characterId]).filter((id): boolean => !!id && shot.characterIds.includes(id)).map((id): string => plan.characters.find((c): boolean => c.id === id)?.name || id || '').join('、')}`).join('，') || '参考图待选择'}</Text>
            {plan.scenes && <Select className="w-full" aria-label={`${shot.id}所属场景`} placeholder="选择本镜所属场景ID" disabled={state.busy || planLocked(p)} value={shot.sceneId} options={plan.scenes.map((s): { value: string; label: string } => ({ value: s.id, label: `${s.name} · ${s.location}` }))} onChange={(sceneId: string): void => updateShot(shot.id, { sceneId, propIds: shot.propIds || [] })} />}
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
            <Space wrap><Button disabled={disabled || !!plan.scenes} onClick={(): void => { void state.addSceneReference(shot.id); }}>添加本镜头场景参考图</Button>{shot.sceneReferenceAssetIds?.map((id): React.ReactNode => <ReferenceImage key={id} projectId={p.id} assetId={id} name="本镜场景" />)}</Space>
            <div className="prompt-workspace"><Text strong>提示词详情</Text><p className="muted-text">最终正文 final 加上实际模式与素材用途组成提交全文；可在下方回读。手改后重新优化只保存候选，接受后再保存。</p><Tabs items={(['firstFrame', 'lastFrame', 'video'] as const).filter((kind): boolean => !!shot.prompts[kind]).map((kind): { key: string; label: string; children: React.ReactNode } => {
              const prompt = shot.prompts[kind] as PetStoryPrompt;
              return { key: kind, label: promptLabels[kind], children: <><Space wrap><Tag>{prompt.rulesVersion === 'manual' ? '尚未优化' : prompt.rulesVersion}</Tag>{prompt.edited && <Tag color="purple">已手动编辑</Tag>}</Space><Tabs defaultActiveKey="final" type="card" size="small" items={[
                { key: 'original', label: '原始', children: <pre className="prompt-readonly">{prompt.original || '暂无原始文本'}</pre> },
                { key: 'optimized', label: '优化候选', children: <><pre className="prompt-readonly">{prompt.optimized || '尚未通过 Chat 优化'}</pre><Button disabled={planLocked(p) || state.busy || !prompt.optimized || prompt.final === prompt.optimized} onClick={(): void => updatePrompt(shot.id, kind, prompt.optimized)}>采用候选为最终正文（待保存）</Button><Text type="secondary"> 未采用时保留当前手改。</Text></> },
                { key: 'final', label: '最终正文', children: <TextArea readOnly={planLocked(p)} aria-label={`${shot.id}${kind}最终提示词`} value={prompt.final} onChange={(event): void => updatePrompt(shot.id, kind, event.target.value)} autoSize={{ minRows: 5, maxRows: 16 }} /> },
              ]} /><TooltipPrompt locked={planLocked(p)} dirty={dirty} confirmed={state.freeChatConfirmed}><Button disabled={disabled || !state.freeChatConfirmed} onClick={(): void => { void state.optimize(shot.id, kind); }}>仅重新优化此项</Button></TooltipPrompt><CompiledPromptDetails project={p} shot={shot} kind={kind} dirty={dirty || profileDirty} /></> };
            })} /></div>
            <Button disabled={disabled} onClick={(): void => { void state.draftFinal(shot.id); }}>检查首帧制作前置条件</Button>
          </div>
        </Card>)}
        </div></div>
      </>}
      </div>
      <div className={stage === 2 || stage === 3 ? 'stage-content space-y-4' : 'page-hidden'}>
        {stage === 3 && plan && !p.production && <Alert type="info" message="尚未开始制作。请先在制作准备中核对入口与数量，再明确授权生成素材。" action={<Button onClick={(): void => setStage(2)}>前往制作准备</Button>} />}
        {!plan ? <Empty description="先生成并保存制作方案" /> : <ProductionControls project={p} disabled={state.busy || dirty || profileDirty || sourceDirty} view={stage === 3 ? 'progress' : 'prepare'} />}
        {stage === 3 && p.assets.some((asset): boolean => asset.kind === 'character') && <Card size="small" title="角色参考素材"><div className="shot-media-strip">{p.assets.filter((asset): boolean => asset.kind === 'character').map((asset): React.ReactNode => <div key={asset.id}><Tag>{p.plan?.characters.find((character): boolean => character.id === asset.characterId)?.name || asset.characterId || '角色参考'}</Tag><ReferenceImage projectId={p.id} assetId={asset.id} name="角色参考" /></div>)}</div></Card>}
        <p className="muted-text">制作完成仅表示逐镜素材已生成及下载；完整短剧合成尚未实现。首帧／首尾帧原生能力以当前入口核对为准。</p>
      </div>
    </>}
  </section>;
};

const TooltipPrompt: React.FC<{ locked: boolean; dirty: boolean; confirmed: boolean; children: React.ReactNode }> = ({ locked, dirty, confirmed, children }): React.ReactElement => <div><span title={locked ? '制作中方案已锁定' : dirty ? '请先保存方案修改' : !confirmed ? '请先在故事输入确认原账号普通 Chat 免费' : '发起一次新的普通 Chat 优化请求'}>{children}</span></div>;
