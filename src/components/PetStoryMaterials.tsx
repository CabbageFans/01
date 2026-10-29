import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Checkbox, Collapse, Input, Select, Space, Tag, Typography } from 'antd';
import type { PetStoryMaterial, PetStoryProject } from '@doubao-studio/contracts';
import { isMaterialPromptBlocked, isSavedReviewResult, readSavedPromptCandidate, reviewMatchesPrompt } from '../utils/petstoryCandidate';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { PetStoryImageReview, imageBelongsToTarget } from './PetStoryImageReview';
import { PromptProvenance } from './PetStoryCanvasPrompt';
import { ReviewIssueSelection } from './PetStoryReviewIssues';
import { PetStoryMediaEntryCheck } from './PetStoryMediaEntryCheck';
import { generationBlockerAction } from './PetStoryGenerationBlockers';
import { usePetStoryGenerationEligibility } from './usePetStoryGenerationEligibility';
import type { PetStoryGenerationBlocker } from './usePetStoryGenerationEligibility';
import { locatePetStoryDraft, usePetStoryDraft } from './PetStoryDrafts';
import '../styles/petstory-materials.css';

const labels = { character: '人物', prop: '道具', scene: '场景' };
export type PetStoryMaterialNavigate = (target: 'plan' | 'keyframes', objectId?: string) => void;
/** 只展开设置，不运行检查、发送或生成；实际检查仍由用户点击。 */
function revealMaterialSettings(): void {
  const settings = document.getElementById('petstory-material-entry');
  if (settings instanceof HTMLDetailsElement) settings.open = true;
  settings?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function reviewMaterialPlan(onNavigate?: PetStoryMaterialNavigate): void {
  if (onNavigate) onNavigate('plan');
  else window.dispatchEvent(new CustomEvent('petstory-journey-focus', { detail: { target: 'plan' } }));
}
function materialCandidateCount(project: PetStoryProject, material: PetStoryMaterial): number {
  return project.assets.filter((asset): boolean => imageBelongsToTarget(project, asset, { materialId: material.id }) && asset.id !== material.selectedAssetId && asset.imageReview?.state !== 'adopted').length
    + (project.assets.some((asset): boolean => asset.id === material.selectedAssetId && imageBelongsToTarget(project, asset, { materialId: material.id }) && asset.imageReview?.state !== 'adopted') && !isPetStoryMaterialImageApproved(project, material) ? 1 : 0);
}
function materialControlsLocked(project: PetStoryProject, disabled: boolean): boolean {
  const production = project.production;
  return disabled || production?.state === 'running';
}
/** 仅投影已保存的选图及确认记录用于数量展示；生成资格由主进程只读核对。 */
export function isPetStoryMaterialImageApproved(project: PetStoryProject, material: PetStoryMaterial): boolean {
  const asset = project.assets.find((item): boolean => item.id === material.selectedAssetId);
  if (!asset?.validation?.decoded || asset.needsReview || asset.imageReview?.state === 'candidate' || material.approved?.assetId !== asset.id || material.approved.sha256 !== asset.validation.sha256) return false;
  if (asset.imageReview?.state === 'adopted' && (asset.imageReview.sha256 !== asset.validation.sha256 || !asset.imageReview.adoptedAt)) return false;
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
  project: PetStoryProject; material: PetStoryMaterial; disabled: boolean; generationBlocked: boolean; checkedAssetId?: string; check: (assetId: string, value: boolean) => void;
  onNavigate?: PetStoryMaterialNavigate; onReadiness: (id: string, revision: number, ready: boolean) => void;
}
const MaterialCard: React.FC<MaterialCardProps> = ({ project, material: m, disabled, generationBlocked, checkedAssetId, check, onNavigate, onReadiness }): React.ReactElement => {
  const state = usePetStoryStore(); const tasks = useTaskStore((store) => store.tasks);
  const [prompt, setPrompt] = useState(m.prompt.final);
  const [editing, setEditing] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const readiness = usePetStoryGenerationEligibility(project, { materialId: m.id });
  const dirty = editing && prompt !== m.prompt.final;
  const fieldId = `material-prompt-${m.id}`;
  const savePrompt = async (text: string): Promise<void> => {
    await state.saveMaterialPrompt(m.id, text); const current = usePetStoryStore.getState();
    if (!current.error && current.project?.id === project.id && current.project.materials?.find((item): boolean => item.id === m.id)?.prompt.final === text) { setPrompt(text); setEditing(false); }
  };
  const discard = (): void => { setPrompt(m.prompt.final); setEditing(false); };
  usePetStoryDraft(`${project.id}:${m.id}:prompt`, `${labels[m.kind]}「${m.name}」的提示词`, dirty, { save: async (): Promise<void> => savePrompt(prompt), discard, locate: (): void => { setPromptOpen(true); locatePetStoryDraft('materials', fieldId); } });
  useEffect((): void => { if (!editing) setPrompt(m.prompt.final); }, [m.prompt.final, editing]);
  useEffect((): void => { onReadiness(m.id, project.revision, readiness.eligibility?.ready === true && !dirty); }, [m.id, project.revision, readiness.eligibility?.ready, dirty, onReadiness]);
  const job = [...project.jobs].reverse().find((j): boolean => j.materialId === m.id);
  const chatBlocked = isMaterialPromptBlocked(project, m.id, tasks);
  const candidateJob = [...project.jobs].reverse().find((j): boolean => j.materialId === m.id && j.status === 'applied' && (m.prompt.candidateJobId ? j.id === m.prompt.candidateJobId : readSavedPromptCandidate(j.rawText) === m.prompt.optimized));
  const chatCandidate = !!candidateJob;
  // 旧优化正文可能早已采用后被用户手改；只有实际待采用回复才提升为下一步。
  const hasPromptCandidate = !!m.prompt.optimized.trim() && m.prompt.optimized !== m.prompt.final && !!candidateJob && candidateJob.resultStatus !== 'stale' && candidateJob.resultStatus !== 'adopted';
  const adoptCandidate = async (): Promise<void> => { if (candidateJob?.requestId) await state.adoptPromptCandidate(candidateJob.id); else await savePrompt(m.prompt.optimized); };
  const review = [...project.jobs].reverse().find((item): boolean => isSavedReviewResult(item, project.jobs) && reviewMatchesPrompt(item, m.id, m.prompt.final) && item.parsedResult?.issues?.some((issue): boolean => issue.targetId === m.id || issue.targetId === m.entityId) === true);
  const revised = !!review && project.jobs.some((item): boolean => item.kind === 'revise' && item.parentJobId === review.id && item.materialId === m.id);
  const character = project.plan?.characters.find((c): boolean => m.kind === 'character' && c.id === m.entityId);
  const approved = isPetStoryMaterialImageApproved(project, m);
  const candidateCount = materialCandidateCount(project, m);
  const selectedImage = project.assets.find((asset): boolean => asset.id === m.selectedAssetId && imageBelongsToTarget(project, asset, { materialId: m.id }));
  const currentImage = selectedImage && selectedImage.imageReview?.state !== 'candidate' && (approved || selectedImage.imageReview?.state === 'adopted' || m.approved?.assetId === selectedImage.id) ? selectedImage : undefined;
  const promptBlocker = readiness.eligibility?.blockers.find((blocker): boolean => blocker.code === 'prompt');
  const promptReady = !!m.prompt.final.trim() && !m.prompt.needsReview && !promptBlocker;
  const mediaDisabled = disabled || !project.storyApproval;
  const currentEntryChecked = !!state.capability && state.capabilityCheckedInSession;
  const used = project.plan?.shots.filter((s): boolean => m.kind === 'character' ? s.characterIds.includes(m.entityId) : m.kind === 'prop' ? !!s.propIds?.includes(m.entityId) : s.sceneId === m.entityId).map((s): string => String(s.order)).join('、');
  const resolveBlocker = (blocker: PetStoryGenerationBlocker): void => {
    if (blocker.code === 'story') {
      reviewMaterialPlan(onNavigate);
      return;
    }
    if (blocker.code === 'capability') { revealMaterialSettings(); return; }
    if (blocker.code === 'task') { window.dispatchEvent(new CustomEvent('petstory-locate-task', { detail: { jobId: blocker.jobId } })); return; }
    if (blocker.code === 'materials' && blocker.materialId) { document.getElementById(`material-${blocker.materialId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    if (blocker.code === 'prompt') { setPromptOpen(true); requestAnimationFrame((): void => { document.getElementById(fieldId)?.focus(); document.getElementById(fieldId)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }); return; }
    readiness.refresh();
  };
  const textDisabled = disabled || generationBlocked || dirty || !state.freeChatConfirmed || chatBlocked;
  // 待选择和已有图片可直接查看，不展示与当前操作无关的媒体入口阻断。
  const blocker = !candidateCount && !currentImage ? promptReady ? readiness.eligibility?.blockers[0] : hasPromptCandidate ? undefined : promptBlocker : undefined;
  const status = candidateCount ? currentImage ? '有新图片待确认' : '图片待确认' : currentImage && !approved ? '需要复核' : approved ? '已采用' : promptReady ? '待生成图片' : hasPromptCandidate ? '提示词待采用' : '提示词待准备';
  return <Card className="petstory-material-card" id={`material-${m.id}`} size="small" data-material-id={m.id} data-material-state={status} data-dirty={dirty ? 'true' : 'false'} title={<Space wrap><Tag>{labels[m.kind]}</Tag>{m.name}<Tag color={approved && !candidateCount ? 'green' : candidateCount || currentImage ? 'orange' : 'default'}>{status}</Tag></Space>}>
    <Space direction="vertical" className="w-full">
      <Typography.Text type="secondary">{used ? `用于镜头 ${used}` : '可复用基础素材'}</Typography.Text>
      <PetStoryImageReview project={project} target={{ materialId: m.id }} title={`${m.name} · ${labels[m.kind]}参考图`} currentAssetId={currentImage?.id} currentNeedsReview={!!currentImage && !approved} identity={character?.description}
        disabled={mediaDisabled} generationDisabled={generationBlocked || dirty || !currentEntryChecked || !readiness.eligibility?.ready} generating={readiness.loading}
        promptReady={promptReady} preparePromptLabel={hasPromptCandidate ? '查看并采用提示词' : '生成提示词'} preparePromptDisabled={hasPromptCandidate ? disabled || dirty : textDisabled} onPreparePrompt={async (): Promise<void> => { if (hasPromptCandidate) setPromptOpen(true); else await state.regenerateMaterialPrompt(m.id); }}
        onUpload={async (): Promise<void> => state.addMaterialImage(m.id)} onGenerate={async (): Promise<void> => state.generateMaterials([m.id])}
        onAdopt={async (assetId: string): Promise<void> => state.approveMaterials([{ materialId: m.id, assetId }])}
        onAdjust={async (): Promise<void> => state.openChatAdjustment({ materialId: m.id })} batchSelectedId={checkedAssetId} onBatchSelection={check} />
      {blocker && <div className="petstory-material-reason" role="status"><span>{blocker.message}</span><Button type="link" size="small" onClick={(): void => resolveBlocker(blocker)}>{generationBlockerAction(blocker)}</Button></div>}
      {!candidateCount && !currentImage && !promptReady && !hasPromptCandidate && !state.freeChatConfirmed && <div className="petstory-material-reason"><span>生成提示词前，请确认普通 Chat 免费可用。</span><Button type="link" size="small" onClick={revealMaterialSettings}>查看生成设置</Button></div>}
      {readiness.error && !candidateCount && !currentImage && <div className="petstory-material-reason" role="status"><span>{readiness.error}</span><Button type="link" size="small" onClick={readiness.refresh}>重新核对</Button></div>}
      {dirty && <Typography.Text type="warning">提示词有未保存修改，请保存或放弃。</Typography.Text>}
      <Collapse className="w-full" activeKey={promptOpen ? ['prompt'] : []} onChange={(keys): void => setPromptOpen(keys.includes('prompt'))} items={[{ key: 'prompt', label: '查看与编辑图片提示词', forceRender: true, children: <Space direction="vertical" className="w-full">
        <Typography.Text type="secondary">{chatCandidate && m.prompt.final === m.prompt.optimized ? '豆包回复 · 当前使用' : m.prompt.edited ? '用户编辑 · 当前使用' : '已有保存正文'}{m.prompt.needsReview ? ' · 需要复核' : ''}</Typography.Text>
        <Input.TextArea id={fieldId} aria-label={`${m.id}基础图最终提示词`} disabled={disabled} autoSize={{ minRows: 5, maxRows: 14 }} value={prompt} onChange={(e): void => { setEditing(e.target.value !== m.prompt.final); setPrompt(e.target.value); }} />
        <Space wrap><Button disabled={disabled || !dirty || !prompt.trim()} onClick={(): void => { void savePrompt(prompt); }}>保存修改</Button>{dirty && <Button onClick={discard}>放弃修改</Button>}</Space>
        {m.prompt.optimized && <><Typography.Text>{chatCandidate ? '豆包新候选' : '已有保存候选'}{m.prompt.optimized === m.prompt.final ? '（当前已采用）' : '（尚未采用）'}</Typography.Text><pre className="prompt-readonly">{m.prompt.optimized}</pre><Button disabled={disabled || dirty || m.prompt.optimized === m.prompt.final || candidateJob?.resultStatus === 'stale'} onClick={(): void => { void adoptCandidate(); }}>采用此候选</Button></>}
        {!state.freeChatConfirmed && <Typography.Text type="warning">开始文字创作前，请在当前阶段核对普通 Chat 免费可用。</Typography.Text>}
        <Space wrap><Button disabled={disabled || dirty} onClick={(): void => { void state.openChatAdjustment({ materialId: m.id }); }}>在豆包中调整</Button><details><summary>更多提示词操作</summary><Button disabled={textDisabled} onClick={(): void => { void state.regenerateMaterialPrompt(m.id); }}>重新生成提示词</Button><Button disabled={textDisabled} onClick={(): void => { void state.reviewContent({ materialId: m.id }); }}>{approved ? '检查正文与当前图片' : '检查正文'}</Button></details></Space>
        {review && <ReviewIssueSelection key={`${review.id}:${m.id}`} issues={review.parsedResult?.issues?.filter((issue): boolean => issue.targetId === m.id || issue.targetId === m.entityId) || []} targetLabel={`${m.name}素材正文`} disabled={textDisabled} revised={revised} onRevise={async (selectedIssueIds: string[]): Promise<void> => state.reviseContent(review.id, { materialId: m.id, selectedIssueIds })} />}
        {job && <PromptProvenance job={job} task={tasks.find((task): boolean => task.id === job.taskId)} />}
        <Typography.Text type="secondary">新图片会进入候选区，采用后才可引用。重新生成提示词不会生成图片。</Typography.Text>
      </Space> }]} />
      <details className="petstory-secondary-tools petstory-material-more"><summary>更多操作</summary><Space direction="vertical" className="w-full">
        <MaterialEditPlan project={project} material={m} disabled={disabled || generationBlocked || dirty} />
        <details><summary>生成记录／诊断详情</summary>{m.id}</details>
      </Space></details>
    </Space>
  </Card>;
};
function materialSelections(project: PetStoryProject, checked: Record<string, string>): { materialId: string; assetId: string }[] {
  return Object.entries(checked).filter(([id, assetId]): boolean => project.materials?.some((m): boolean => m.id === id && m.approved?.assetId !== assetId && project.assets.some((asset): boolean => asset.id === assetId && imageBelongsToTarget(project, asset, { materialId: id }))) === true).map(([materialId, assetId]): { materialId: string; assetId: string } => ({ materialId, assetId }));
}
function materialReadinessUnchanged(previous: { revision: number; ready: boolean } | undefined, revision: number, ready: boolean): boolean {
  return previous?.revision === revision && previous.ready === ready;
}

const MaterialsAdvancedControls: React.FC<{ project: PetStoryProject; locked: boolean; generationBlocked: boolean }> = ({ project, locked, generationBlocked }): React.ReactElement => {
  const state = usePetStoryStore(); const materials = project.materials || [];
  return <details><summary>补充素材清单与批量提示词</summary><Space direction="vertical" className="w-full"><Typography.Text type="secondary">补充清单保留现有镜头和成果。重新生成只准备 {materials.length} 项基础素材提示词，手改正文保留，新回复待你采用。</Typography.Text><Space wrap><Button disabled={locked || generationBlocked || !project.plan || !state.freeChatConfirmed} onClick={(): void => { void state.extractAssets(); }}>补充素材清单</Button><Button disabled={locked || generationBlocked || !materials.length || !state.freeChatConfirmed || state.promptBatch.status === 'running'} onClick={(): void => { void state.regenerateAllMaterialPrompts(); }}>重新生成全部素材提示词 · {materials.length} 项</Button></Space></Space></details>;
};

export const PetStoryMaterials: React.FC<{ project: PetStoryProject; disabled: boolean; generationBlocked?: boolean; onNavigate?: PetStoryMaterialNavigate; showStageActions?: boolean }> = ({ project, disabled, generationBlocked = false, onNavigate, showStageActions = true }): React.ReactElement => {
  const state = usePetStoryStore(); const [checked, setChecked] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('all');
  const [readiness, setReadiness] = useState<Record<string, { revision: number; ready: boolean }>>({});
  useEffect((): void => { setChecked({}); setReadiness({}); }, [project.id]);
  const onReadiness = useCallback((id: string, revision: number, ready: boolean): void => setReadiness((old): Record<string, { revision: number; ready: boolean }> => materialReadinessUnchanged(old[id], revision, ready) ? old : { ...old, [id]: { revision, ready } }), []);
  const locked = materialControlsLocked(project, disabled);
  const materials = project.materials || [];
  const selections = materialSelections(project, checked);
  const pending = materials.filter((material): boolean => materialCandidateCount(project, material) > 0).length;
  const missing = materials.filter((material): boolean => !isPetStoryMaterialImageApproved(project, material) && !materialCandidateCount(project, material)).map((material): string => material.id);
  const confirmed = materials.filter((m): boolean => isPetStoryMaterialImageApproved(project, m)).length;
  const allConfirmed = materials.length > 0 && confirmed === materials.length;
  const missingReady = !!missing.length && missing.every((id): boolean => readiness[id]?.revision === project.revision && readiness[id].ready);
  // 未确认的方案不投影为一套可执行素材；确认入口始终回到方案审阅。
  if (!project.storyApproval) return <Card className="petstory-materials-panel" size="small" title="准备基础素材">
    <div className="petstory-material-plan-required" role="status"><Typography.Text type="secondary">方案确认后，显示人物、道具和场景素材。</Typography.Text><Button id="petstory-material-story-confirm" type="primary" onClick={(): void => reviewMaterialPlan(onNavigate)}>查看并确认方案</Button></div>
  </Card>;
  return <Card className="petstory-materials-panel" size="small" title="准备基础素材 · 人物／道具／场景">
    <Space direction="vertical" className="w-full">
      <div className="petstory-material-summary"><Typography.Text type="secondary">已采用 {confirmed}/{materials.length} · 待确认 {pending} · 缺少 {missing.length}</Typography.Text><div className="petstory-material-settings-links">
        <details id="petstory-material-entry" className="petstory-secondary-tools"><summary>生成设置／入口检查</summary><Space direction="vertical" className="w-full">
          <Checkbox checked={state.freeChatConfirmed} disabled={locked} onChange={(event): void => state.setFreeChatConfirmed(event.target.checked)}>本人已确认当前账号普通 Chat 免费可用</Checkbox>
          <PetStoryMediaEntryCheck project={project} kind="image" disabled={disabled} />
        </Space></details>
        <details className="petstory-secondary-tools"><summary>更多操作</summary><Space direction="vertical" className="w-full">
          {showStageActions && <><Typography.Text type="secondary">批量准备只生成当前缺图项；批量采用只包含你已逐张检查并勾选的图片。</Typography.Text><Space wrap><Button disabled={locked || generationBlocked || !missingReady} onClick={(): void => { void state.generateMaterials(missing); }}>生成缺失基础图 · {missing.length} 项</Button><Button disabled={locked || !selections.length} onClick={(): void => { void state.approveMaterials(selections); }}>采用已选的 {selections.length} 张</Button></Space></>}
          <MaterialsAdvancedControls project={project} locked={locked} generationBlocked={generationBlocked} />
          {onNavigate && <Button onClick={(): void => onNavigate('keyframes')}>查看关键帧制作与缺项</Button>}
        </Space></details>
      </div></div>
      <div className="petstory-material-filters" role="group" aria-label="筛选基础素材">{[{ value: 'all', label: '全部' }, ...Object.entries(labels).map(([value, label]): { value: string; label: string } => ({ value, label }))].map((item): React.ReactNode => <Button key={item.value} type="text" aria-pressed={filter === item.value} onClick={(): void => setFilter(item.value)}>{item.label}</Button>)}</div>
      <div className="petstory-material-grid">{materials.filter((material): boolean => filter === 'all' || material.kind === filter).map((m): React.ReactNode => <MaterialCard key={m.id} project={project} material={m} disabled={locked} generationBlocked={generationBlocked} onNavigate={onNavigate} onReadiness={onReadiness} checkedAssetId={checked[m.id]} check={(assetId: string, value: boolean): void => setChecked((old): Record<string, string> => { const next = { ...old }; if (value) next[m.id] = assetId; else delete next[m.id]; return next; })} />)}</div>
      {!materials.length && <Typography.Text type="secondary">当前方案没有列出基础素材。可在更多操作中补充素材清单。</Typography.Text>}
      {allConfirmed && onNavigate && <Button onClick={(): void => onNavigate('keyframes')}>基础素材已采用，进入关键帧制作</Button>}
    </Space>
  </Card>;
};
