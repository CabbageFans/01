import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Collapse, Image, Input, Select, Space, Tag, Typography } from 'antd';
import type { PetStoryMaterial, PetStoryProject } from '@doubao-studio/contracts';
import { isMaterialPromptBlocked, isSavedReviewResult, readSavedPromptCandidate, reviewMatchesPrompt } from '../utils/petstoryCandidate';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { PromptProvenance } from './PetStoryCanvasPrompt';
import { ReviewIssueSelection } from './PetStoryReviewIssues';
import { PetStoryMediaEntryCheck } from './PetStoryMediaEntryCheck';
import { PetStoryGenerationBlockers } from './PetStoryGenerationBlockers';
import { usePetStoryGenerationEligibility } from './usePetStoryGenerationEligibility';
import type { PetStoryGenerationBlocker } from './usePetStoryGenerationEligibility';
import { locatePetStoryDraft, usePetStoryDraft } from './PetStoryDrafts';

const labels = { character: '人物', prop: '道具', scene: '场景' };
export type PetStoryMaterialNavigate = (target: 'plan' | 'keyframes', objectId?: string) => void;
function materialControlsLocked(project: PetStoryProject, disabled: boolean): boolean {
  const production = project.production;
  return disabled || production?.state === 'running' || !!production?.steps.some((step): boolean => step.status !== 'complete') || (!!production && production.phase !== 'materials' && production.state !== 'complete');
}
/** 仅投影已保存的选图及确认记录用于数量展示；生成资格由主进程只读核对。 */
export function isPetStoryMaterialImageApproved(project: PetStoryProject, material: PetStoryMaterial): boolean {
  const asset = project.assets.find((item): boolean => item.id === material.selectedAssetId);
  if (!asset?.validation || material.approved?.assetId !== asset.id || material.approved.sha256 !== asset.validation.sha256) return false;
  if (material.kind !== 'character') return true;
  const character = project.plan?.characters.find((item): boolean => item.id === material.entityId);
  return !!character && material.approved.identity?.assetId === asset.id && material.approved.identity.description === character.description;
}
/** 编辑意图沿原 Chat 候选链保存，确认图片或媒体生成仍是后续独立操作。 */
const MaterialEditPlan: React.FC<{ project: PetStoryProject; material: PetStoryMaterial; disabled: boolean }> = ({ project, material, disabled }): React.ReactElement => {
  const state = usePetStoryStore();
  const tasks = useTaskStore((store) => store.tasks);
  const [baseAssetId, setBaseAssetId] = useState(material.selectedAssetId || '');
  const [changes, setChanges] = useState(''); const [preserve, setPreserve] = useState(''); const [validity, setValidity] = useState('');
  useEffect((): void => { setBaseAssetId(material.selectedAssetId || ''); }, [material.selectedAssetId]);
  const base = project.assets.find((asset): boolean => asset.id === material.selectedAssetId);
  const blocked = disabled || isMaterialPromptBlocked(project, material.id, tasks) || !state.freeChatConfirmed;
  return <Collapse className="w-full" items={[{ key: 'edit-plan', label: '变体／局部编辑计划', forceRender: true, children: <Space direction="vertical" className="w-full">
    <Typography.Text type="secondary">使用当前选中的具体图片，写清要改什么、保留什么及适用范围。豆包只生成候选提示词；采用、图片生成和图片确认分别由你操作。</Typography.Text>
    <Select className="w-full" aria-label={`${material.id}编辑基准图片`} placeholder="先在上方选择或上传具体图片" value={baseAssetId || undefined} disabled={blocked || !base} options={base ? [{ value: base.id, label: '当前选中的图片' }] : []} onChange={(value: string): void => setBaseAssetId(value)} />
    <Input.TextArea aria-label={`${material.id}编辑变化`} placeholder="本次需要改变的对象、区域与目标状态" value={changes} disabled={blocked} autoSize={{ minRows: 2, maxRows: 6 }} onChange={(event): void => setChanges(event.target.value)} />
    <Input.TextArea aria-label={`${material.id}编辑保留项`} placeholder="明确保留的身份、未选区域、结构、构图或光线" value={preserve} disabled={blocked} autoSize={{ minRows: 2, maxRows: 6 }} onChange={(event): void => setPreserve(event.target.value)} />
    <Input.TextArea aria-label={`${material.id}编辑适用范围`} placeholder="此变体或编辑用于哪些镜头、场景或阶段" value={validity} disabled={blocked} autoSize={{ minRows: 2, maxRows: 4 }} onChange={(event): void => setValidity(event.target.value)} />
    <Button disabled={blocked || !base || baseAssetId !== material.selectedAssetId || !changes.trim() || !preserve.trim() || !validity.trim()} onClick={(): void => { void state.regenerateMaterialPrompt(material.id, { baseAssetId, changes, preserve, validity }); }}>豆包生成编辑计划候选（不生成图片）</Button>
    {material.prompt.editIntent && <details><summary>当前使用的编辑依据</summary><p>变化：{material.prompt.editIntent.changes}</p><p>保留：{material.prompt.editIntent.preserve}</p><p>适用范围：{material.prompt.editIntent.validity}</p><details><summary>诊断：基准图片记录</summary>{material.prompt.editIntent.baseAssetId}</details></details>}
  </Space> }]} />;
};
interface MaterialCardProps {
  project: PetStoryProject; material: PetStoryMaterial; disabled: boolean; generationBlocked: boolean; checked: boolean; check: (value: boolean) => void;
  onNavigate?: PetStoryMaterialNavigate; onReadiness: (id: string, revision: number, ready: boolean) => void;
}
const MaterialCard: React.FC<MaterialCardProps> = ({ project, material: m, disabled, generationBlocked, checked, check, onNavigate, onReadiness }): React.ReactElement => {
  const state = usePetStoryStore(); const tasks = useTaskStore((store) => store.tasks);
  const [prompt, setPrompt] = useState(m.prompt.final); const [image, setImage] = useState(''); const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [promptOpen, setPromptOpen] = useState(true);
  const readiness = usePetStoryGenerationEligibility(project, { materialId: m.id });
  const dirty = editing && prompt !== m.prompt.final;
  const fieldId = `material-prompt-${m.id}`;
  const savePrompt = async (text: string): Promise<void> => {
    await state.saveMaterialPrompt(m.id, text); const current = usePetStoryStore.getState();
    if (!current.error && current.project?.id === project.id && current.project.materials?.find((item): boolean => item.id === m.id)?.prompt.final === text) { setPrompt(text); setEditing(false); }
  };
  const discard = (): void => { setPrompt(m.prompt.final); setEditing(false); };
  usePetStoryDraft(`${project.id}:${m.id}:prompt`, `${labels[m.kind]}「${m.name}」的提示词`, dirty, { save: async (): Promise<void> => savePrompt(prompt), discard, locate: (): void => locatePetStoryDraft('materials', fieldId) });
  useEffect((): void => { if (!editing) setPrompt(m.prompt.final); }, [m.prompt.final, editing]);
  useEffect((): void => { onReadiness(m.id, project.revision, readiness.eligibility?.ready === true && !dirty); }, [m.id, project.revision, readiness.eligibility?.ready, dirty, onReadiness]);
  const job = [...project.jobs].reverse().find((j): boolean => j.materialId === m.id);
  const chatBlocked = isMaterialPromptBlocked(project, m.id, tasks);
  const candidateJob = [...project.jobs].reverse().find((j): boolean => j.materialId === m.id && j.status === 'applied' && (m.prompt.candidateJobId ? j.id === m.prompt.candidateJobId : readSavedPromptCandidate(j.rawText) === m.prompt.optimized));
  const chatCandidate = !!candidateJob;
  const adoptCandidate = async (): Promise<void> => { if (candidateJob?.requestId) await state.adoptPromptCandidate(candidateJob.id); else await savePrompt(m.prompt.optimized); };
  const review = [...project.jobs].reverse().find((item): boolean => isSavedReviewResult(item, project.jobs) && reviewMatchesPrompt(item, m.id, m.prompt.final) && item.parsedResult?.issues?.some((issue): boolean => issue.targetId === m.id || issue.targetId === m.entityId) === true);
  const revised = !!review && project.jobs.some((item): boolean => item.kind === 'revise' && item.parentJobId === review.id && item.materialId === m.id);
  useEffect(() => {
    let active = true; setImage(''); setError('');
    if (m.selectedAssetId) void window.electronAPI.petstory.readReference(project.id, m.selectedAssetId).then((r): void => { if (active) { setImage(r.data || ''); setError(r.error || ''); } }).catch((): void => { if (active) setError('图片读取失败，请重新选择'); });
    return (): void => { active = false; };
  }, [project.id, m.selectedAssetId]);
  const character = project.plan?.characters.find((c): boolean => m.kind === 'character' && c.id === m.entityId);
  const approved = isPetStoryMaterialImageApproved(project, m);
  const entity = character || project.plan?.props?.find((p): boolean => m.kind === 'prop' && p.id === m.entityId) || project.plan?.scenes?.find((s): boolean => m.kind === 'scene' && s.id === m.entityId);
  const mediaDisabled = disabled || !project.storyApproval;
  const currentEntryChecked = !!state.capability && state.capabilityCheckedInSession;
  const images = project.assets.filter((a): boolean => a.kind === m.kind && (a.materialId === m.id || (m.kind === 'character' && (a.characterIds || [a.characterId]).includes(m.entityId))));
  const used = project.plan?.shots.filter((s): boolean => m.kind === 'character' ? s.characterIds.includes(m.entityId) : m.kind === 'prop' ? !!s.propIds?.includes(m.entityId) : s.sceneId === m.entityId).map((s): string => String(s.order)).join('、');
  const resolveBlocker = (blocker: PetStoryGenerationBlocker): void => {
    if (blocker.code === 'story') {
      if (onNavigate) onNavigate('plan');
      else document.getElementById('petstory-material-story-confirm')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (blocker.code === 'capability') { document.getElementById('petstory-material-entry')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    if (blocker.code === 'task') { window.dispatchEvent(new CustomEvent('petstory-locate-task', { detail: { jobId: blocker.jobId } })); return; }
    if (blocker.code === 'materials' && blocker.materialId) { document.getElementById(`material-${blocker.materialId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    if (blocker.code === 'prompt') { setPromptOpen(true); requestAnimationFrame((): void => { document.getElementById(fieldId)?.focus(); document.getElementById(fieldId)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }); return; }
    readiness.refresh();
  };
  const textDisabled = disabled || generationBlocked || dirty || !state.freeChatConfirmed || chatBlocked;
  return <Card id={`material-${m.id}`} size="small" data-material-id={m.id} data-dirty={dirty ? 'true' : 'false'} title={<Space wrap><Tag>{labels[m.kind]}</Tag>{m.name}<Tag color={approved ? 'green' : m.selectedAssetId ? 'orange' : 'default'}>{approved ? '图片已确认' : m.selectedAssetId ? '图片待确认' : '缺少图片'}</Tag></Space>}>
    <Space direction="vertical" className="w-full">
      <Typography.Text type="secondary">用于镜头 {used || '主场景派生依赖'} · 设计来源：{entity?.designOrigin === 'script' ? '剧本明确' : '待确认设计'}</Typography.Text>
      {character && <Typography.Text>与图片一并确认的身份外观：{character.description}</Typography.Text>}
      {image ? <Image src={image} alt={`${m.name}当前实际图片`} width={180} style={{ maxHeight: 200, objectFit: 'contain' }} /> : <Typography.Text>{error || '尚无实际图片，可生成或上传已有图片'}</Typography.Text>}
      {image && <Collapse className="w-full" items={[{ key: 'source', label: '这张图片的生成提示词', children: <pre className="prompt-readonly">{project.assets.find((a): boolean => a.id === m.selectedAssetId)?.generationPrompt || '用户提供／旧版图片，无本工具生成提示词记录。'}</pre> }]} />}
      {image && !approved && <Checkbox checked={checked} disabled={mediaDisabled || !m.selectedAssetId} onChange={(e): void => check(e.target.checked)}>{character ? '已核对图片与身份外观一致，选入批量确认' : '已查看此图，选入批量确认'}</Checkbox>}
      <Space wrap>
        <Button disabled={mediaDisabled || !image || approved} onClick={(): void => { if (m.selectedAssetId) void state.approveMaterials([{ materialId: m.id, assetId: m.selectedAssetId }]); }}>{approved ? '当前图片已确认' : '查看后确认使用这张图片'}</Button>
        <Button disabled={mediaDisabled} onClick={(): void => { void state.addMaterialImage(m.id); }}>上传已有图片</Button>
        <Button type={m.selectedAssetId ? 'default' : 'primary'} loading={readiness.loading} disabled={mediaDisabled || generationBlocked || dirty || !currentEntryChecked || !readiness.eligibility?.ready} onClick={(): void => { void state.generateMaterials([m.id]); }}>{m.selectedAssetId ? '重新生成图片（保留旧图）' : '生成此基础图'}</Button>
      </Space>
      <PetStoryGenerationBlockers blockers={readiness.eligibility?.blockers || []} onResolve={resolveBlocker} />
      {readiness.error && <Alert type="warning" message={readiness.error} action={<Button onClick={readiness.refresh}>重新核对</Button>} />}
      {dirty && <Alert type="warning" message={`「${m.name}」提示词有未保存修改，请在下面保存或放弃。`} />}
      <Select aria-label={`${m.id}选择已有图片`} className="w-full" placeholder="选择本素材的历史图片（换图后需重新确认）" value={m.selectedAssetId} disabled={mediaDisabled} options={images.map((a, i): { value: string; label: string } => ({ value: a.id, label: `${i + 1} · ${a.taskId ? '豆包生成' : '用户提供'}${a.id === m.selectedAssetId ? ' · 当前选中' : ''}` }))} onChange={(id: string): void => { void state.selectMaterialImage(m.id, id); }} />
      <Collapse className="w-full" activeKey={promptOpen ? ['prompt'] : []} onChange={(keys): void => setPromptOpen(keys.includes('prompt'))} items={[{ key: 'prompt', label: '当前使用的基础图提示词', children: <Space direction="vertical" className="w-full">
        <Typography.Text type="secondary">{chatCandidate && m.prompt.final === m.prompt.optimized ? '豆包回复 · 当前使用' : m.prompt.edited ? '用户编辑 · 当前使用' : '已有保存正文'}{m.prompt.needsReview ? ' · 需要复核' : ''}</Typography.Text>
        <Input.TextArea id={fieldId} aria-label={`${m.id}基础图最终提示词`} disabled={disabled} autoSize={{ minRows: 5, maxRows: 14 }} value={prompt} onChange={(e): void => { setEditing(e.target.value !== m.prompt.final); setPrompt(e.target.value); }} />
        <Space wrap><Button disabled={disabled || !dirty || !prompt.trim()} onClick={(): void => { void savePrompt(prompt); }}>保存修改后的提示词</Button>{dirty && <Button onClick={discard}>放弃本次修改</Button>}</Space>
        {m.prompt.optimized && <><Typography.Text>{chatCandidate ? '豆包新候选' : '已有保存候选'}{m.prompt.optimized === m.prompt.final ? '（当前已采用）' : '（尚未采用）'}</Typography.Text><pre className="prompt-readonly">{m.prompt.optimized}</pre><Button disabled={disabled || dirty || m.prompt.optimized === m.prompt.final || candidateJob?.resultStatus === 'stale'} onClick={(): void => { void adoptCandidate(); }}>采用此候选</Button></>}
        {!state.freeChatConfirmed && <Typography.Text type="warning">开始文字创作前，请在当前阶段核对普通 Chat 免费可用。</Typography.Text>}
        <Space wrap><Button disabled={textDisabled} onClick={(): void => { void state.regenerateMaterialPrompt(m.id); }}>豆包重新生成此素材提示词</Button><Button disabled={textDisabled} onClick={(): void => { void state.reviewContent({ materialId: m.id }); }}>{m.selectedAssetId ? '审查素材正文与当前图片' : '审查本项素材正文（暂无图片）'}</Button></Space>
        {review && <ReviewIssueSelection key={`${review.id}:${m.id}`} issues={review.parsedResult?.issues?.filter((issue): boolean => issue.targetId === m.id || issue.targetId === m.entityId) || []} targetLabel={`${m.name}素材正文`} disabled={textDisabled} revised={revised} onRevise={async (selectedIssueIds: string[]): Promise<void> => state.reviseContent(review.id, { materialId: m.id, selectedIssueIds })} />}
        {job && <PromptProvenance job={job} task={tasks.find((task): boolean => task.id === job.taskId)} />}
        <Typography.Text type="secondary">生成后保留在此素材位置，图片需要你查看并确认。重新生成提示词不会生成图片。</Typography.Text>
      </Space> }]} />
      <MaterialEditPlan project={project} material={m} disabled={disabled || generationBlocked || dirty} />
      <details><summary>诊断：素材记录</summary>{m.id}</details>
    </Space>
  </Card>;
};
function materialSelections(project: PetStoryProject, checked: Record<string, string>): { materialId: string; assetId: string }[] {
  return Object.entries(checked).filter(([id, assetId]): boolean => project.materials?.some((m): boolean => m.id === id && m.selectedAssetId === assetId && !isPetStoryMaterialImageApproved(project, m)) === true).map(([materialId, assetId]): { materialId: string; assetId: string } => ({ materialId, assetId }));
}
function materialReadinessUnchanged(previous: { revision: number; ready: boolean } | undefined, revision: number, ready: boolean): boolean {
  return previous?.revision === revision && previous.ready === ready;
}

const MaterialsAdvancedControls: React.FC<{ project: PetStoryProject; locked: boolean; generationBlocked: boolean }> = ({ project, locked, generationBlocked }): React.ReactElement => {
  const state = usePetStoryStore(); const materials = project.materials || [];
  return <details><summary>高级：补齐清单／重新生成全部素材提示词</summary><Space direction="vertical" className="w-full"><Typography.Text type="secondary">补齐清单保留现有镜头和成果。重新生成全部仅请求 {materials.length} 项人物／道具／场景提示词，不含关键帧或视频；手改正文保留，新回复作为待采用候选，不会自动生图。</Typography.Text><Space wrap><Button disabled={locked || generationBlocked || !project.plan || !state.freeChatConfirmed} onClick={(): void => { void state.extractAssets(); }}>豆包分析并补齐资产清单</Button><Button disabled={locked || generationBlocked || !materials.length || !state.freeChatConfirmed || state.promptBatch.status === 'running'} onClick={(): void => { void state.regenerateAllMaterialPrompts(); }}>重新生成全部基础素材提示词 · {materials.length} 项</Button><Button disabled={locked || !project.plan?.props || !project.plan?.scenes} onClick={(): void => { void state.confirmStory(); }}>重新确认当前方案（不生成媒体）</Button></Space></Space></details>;
};

export const PetStoryMaterials: React.FC<{ project: PetStoryProject; disabled: boolean; generationBlocked?: boolean; onNavigate?: PetStoryMaterialNavigate; showStageActions?: boolean }> = ({ project, disabled, generationBlocked = false, onNavigate, showStageActions = true }): React.ReactElement => {
  const state = usePetStoryStore(); const [checked, setChecked] = useState<Record<string, string>>({});
  const [readiness, setReadiness] = useState<Record<string, { revision: number; ready: boolean }>>({});
  useEffect((): void => { setChecked({}); setReadiness({}); }, [project.id]);
  const onReadiness = useCallback((id: string, revision: number, ready: boolean): void => setReadiness((old): Record<string, { revision: number; ready: boolean }> => materialReadinessUnchanged(old[id], revision, ready) ? old : { ...old, [id]: { revision, ready } }), []);
  const locked = materialControlsLocked(project, disabled);
  const materials = project.materials || [];
  const selections = materialSelections(project, checked);
  const missing = materials.filter((m): boolean => !m.selectedAssetId).map((m): string => m.id);
  const confirmed = materials.filter((m): boolean => isPetStoryMaterialImageApproved(project, m)).length;
  const allConfirmed = materials.length > 0 && confirmed === materials.length;
  const missingReady = !!missing.length && missing.every((id): boolean => readiness[id]?.revision === project.revision && readiness[id].ready);
  return <Card size="small" title="准备基础素材 · 人物／道具／场景">
    <Space direction="vertical" className="w-full">
      <Alert type={allConfirmed ? 'success' : 'info'} showIcon message={`已确认 ${confirmed} / ${materials.length} 项 · 仍缺图片 ${missing.length} 项`} description="逐项查看提示词和图片。生成、选中与确认是三个独立动作；只有你确认的具体图片才用于镜头制作。" />
      {!project.storyApproval && <Alert type="warning" message="当前方案还未确认为制作依据，确认后可生成或上传基础图片。" action={onNavigate ? <Button onClick={(): void => onNavigate('plan')}>查看并确认方案</Button> : <Button id="petstory-material-story-confirm" disabled={locked || !project.plan?.props || !project.plan?.scenes} onClick={(): void => { void state.confirmStory(); }}>确认当前方案</Button>} />}
      <div id="petstory-material-entry" className="w-full"><PetStoryMediaEntryCheck project={project} kind="image" disabled={disabled} /></div>
      {showStageActions && <Space wrap><Button disabled={locked || generationBlocked || !missingReady} onClick={(): void => { void state.generateMaterials(missing); }}>生成缺失基础图 · {missing.length} 项</Button><Button disabled={locked || !project.storyApproval || !selections.length} onClick={(): void => { void state.approveMaterials(selections); }}>确认已逐张查看的 {selections.length} 张图片</Button></Space>}
      {!!missing.length && !missingReady && <Typography.Text type="secondary">缺图项目的具体前置条件和处理按钮在下方对应素材卡中。已有图片可以直接查看确认，无需重新生成。</Typography.Text>}
      {(['character', 'prop', 'scene'] as const).map((kind): React.ReactNode => {
        const items = materials.filter((m): boolean => m.kind === kind);
        const selected = items.filter((m): boolean => !!m.selectedAssetId).length;
        const approved = items.filter((m): boolean => isPetStoryMaterialImageApproved(project, m)).length;
        return <section key={kind} className="w-full" aria-label={`${labels[kind]}素材组`}><Typography.Title level={5}>{labels[kind]} · {items.length} 项</Typography.Title><Typography.Paragraph type="secondary">已选 {selected} · 已确认 {approved} · 仍缺图片 {items.length - selected} · 待确认 {selected - approved}</Typography.Paragraph><Space direction="vertical" className="w-full">{items.map((m): React.ReactNode => <MaterialCard key={m.id} project={project} material={m} disabled={locked} generationBlocked={generationBlocked} onNavigate={onNavigate} onReadiness={onReadiness} checked={checked[m.id] === m.selectedAssetId && !!m.selectedAssetId} check={(value: boolean): void => setChecked((old): Record<string, string> => { const next = { ...old }; if (value && m.selectedAssetId) next[m.id] = m.selectedAssetId; else delete next[m.id]; return next; })} />)}{!items.length && <Typography.Text type="secondary">当前方案无需此类基础素材。</Typography.Text>}</Space></section>;
      })}
      {!materials.length && <Typography.Text type="secondary">采用并确认分析方案后，显示这份剧本需要的动态素材清单。</Typography.Text>}
      {onNavigate && <Button type={allConfirmed ? 'primary' : 'default'} onClick={(): void => onNavigate('keyframes')}>{allConfirmed ? '基础素材已确认，进入关键帧制作' : '查看关键帧制作与缺项'}</Button>}
      <MaterialsAdvancedControls project={project} locked={locked} generationBlocked={generationBlocked} />
    </Space>
  </Card>;
};
