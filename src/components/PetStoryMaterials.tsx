import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Collapse, Image, Input, Select, Space, Tag, Typography } from 'antd';
import type { PetStoryMaterial, PetStoryProject } from '@doubao-studio/contracts';
import { isMaterialPromptBlocked, isSavedReviewResult, readSavedPromptCandidate, reviewMatchesPrompt } from '../utils/petstoryCandidate';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { PromptProvenance } from './PetStoryCanvasPrompt';
import { ReviewIssueSelection } from './PetStoryReviewIssues';

const labels = { character: '人物', prop: '道具', scene: '场景' };
function materialControlsLocked(project: PetStoryProject, disabled: boolean): boolean {
  const production = project.production;
  return disabled || production?.state === 'running' || !!production?.steps.some((step): boolean => step.status !== 'complete') || (!!production && production.phase !== 'materials' && production.state !== 'complete');
}
function materialMediaReady(project: PetStoryProject, state: Pick<ReturnType<typeof usePetStoryStore.getState>, 'capability' | 'capabilityCheckedInSession'>): boolean {
  return !!project.storyApproval && !!state.capability && state.capabilityCheckedInSession;
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
    <Typography.Text type="secondary">使用上方当前选中的具体图片，写清要改什么、保留什么及适用范围。豆包只生成候选正文；采用、图片生成和图片确认由你另行操作。改变身份或场景地理时应先修改并确认资产设计。</Typography.Text>
    <Select className="w-full" aria-label={`${material.id}编辑基准图片`} placeholder="先在上方选择或上传具体图片" value={baseAssetId || undefined} disabled={blocked || !base} options={base ? [{ value: base.id, label: `当前具体图片 · ${base.id.slice(0, 8)}` }] : []} onChange={(value: string): void => setBaseAssetId(value)} />
    <Input.TextArea aria-label={`${material.id}编辑变化`} placeholder="本次需要改变的对象、区域与目标状态" value={changes} disabled={blocked} autoSize={{ minRows: 2, maxRows: 6 }} onChange={(event): void => setChanges(event.target.value)} />
    <Input.TextArea aria-label={`${material.id}编辑保留项`} placeholder="明确保留的身份、未选区域、结构、构图或光线" value={preserve} disabled={blocked} autoSize={{ minRows: 2, maxRows: 6 }} onChange={(event): void => setPreserve(event.target.value)} />
    <Input.TextArea aria-label={`${material.id}编辑适用范围`} placeholder="此变体或编辑用于哪些镜头、场景或阶段" value={validity} disabled={blocked} autoSize={{ minRows: 2, maxRows: 4 }} onChange={(event): void => setValidity(event.target.value)} />
    <Button disabled={blocked || !base || baseAssetId !== material.selectedAssetId || !changes.trim() || !preserve.trim() || !validity.trim()} onClick={(): void => { void state.regenerateMaterialPrompt(material.id, { baseAssetId, changes, preserve, validity }); }}>豆包生成编辑计划候选（不生成图片）</Button>
    {material.prompt.editIntent && <details><summary>当前采用正文的编辑依据</summary><p>基准图片：{material.prompt.editIntent.baseAssetId}</p><p>变化：{material.prompt.editIntent.changes}</p><p>保留：{material.prompt.editIntent.preserve}</p><p>适用范围：{material.prompt.editIntent.validity}</p></details>}
  </Space> }]} />;
};
const MaterialCard: React.FC<{ project: PetStoryProject; material: PetStoryMaterial; disabled: boolean; generationBlocked: boolean; checked: boolean; check: (value: boolean) => void }> = ({ project, material: m, disabled, generationBlocked, checked, check }): React.ReactElement => {
  const state = usePetStoryStore(); const tasks = useTaskStore((store) => store.tasks); const [prompt, setPrompt] = useState(m.prompt.final); const [image, setImage] = useState(''); const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect((): void => { if (!editing) setPrompt(m.prompt.final); }, [m.prompt.final, editing]);
  const savePrompt = async (text: string): Promise<void> => { await state.saveMaterialPrompt(m.id, text); const current = usePetStoryStore.getState(); if (!current.error && current.project?.id === project.id && current.project.materials?.find((item): boolean => item.id === m.id)?.prompt.final === text) { setPrompt(text); setEditing(false); } };
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
  const approved = m.approved?.assetId === m.selectedAssetId && !!m.approved && (!character || (m.approved.identity?.description === character.description && m.approved.identity.assetId === m.selectedAssetId));
  const entity = character || project.plan?.props?.find((p): boolean => m.kind === 'prop' && p.id === m.entityId) || project.plan?.scenes?.find((s): boolean => m.kind === 'scene' && s.id === m.entityId);
  // 剧本确认只约束实际图片操作；文字候选仍可先生成、审查、编辑和采用。
  const mediaDisabled = disabled || !project.storyApproval;
  const images = project.assets.filter((a): boolean => a.kind === m.kind && (a.materialId === m.id || (m.kind === 'character' && (a.characterIds || [a.characterId]).includes(m.entityId))));
  const used = project.plan?.shots.filter((s): boolean => m.kind === 'character' ? s.characterIds.includes(m.entityId) : m.kind === 'prop' ? !!s.propIds?.includes(m.entityId) : s.sceneId === m.entityId).map((s): string => String(s.order)).join('、');
  return <Card size="small" data-material-id={m.id} data-dirty={editing && prompt !== m.prompt.final ? 'true' : 'false'} title={<Space><Tag>{labels[m.kind]}</Tag>{m.name}<Tag color={approved ? 'green' : 'orange'}>{approved ? '具体图片已接受' : '待查看接受'}</Tag></Space>}>
    <Space direction="vertical" className="w-full">
      <Typography.Text type="secondary">{m.id} · 涉及镜头 {used || '主场景派生依赖'}</Typography.Text>
      <Typography.Text type="secondary">设计来源：{entity?.designOrigin === 'script' ? '剧本明确' : '待确认设计'}；此项为审阅信息，不加入模型正文。</Typography.Text>
      {character && <Typography.Text>与图片一并确认的身份外观：{character.description}</Typography.Text>}
      {image ? <Image src={image} alt={`${m.name}当前实际图片`} width={180} style={{ maxHeight: 200, objectFit: 'contain' }} /> : <Typography.Text>{error || '尚无实际图片'}</Typography.Text>}
      {image && <Collapse className="w-full" items={[{ key: 'source', label: '这张图片的生成提示词', children: <pre className="prompt-readonly">{project.assets.find((a): boolean => a.id === m.selectedAssetId)?.generationPrompt || '用户提供／旧版图片，无本工具生成提示词记录。'}</pre> }]} />}
      <Checkbox checked={checked} disabled={mediaDisabled || !image || !m.selectedAssetId} onChange={(e): void => check(e.target.checked)}>{character ? '我已核对这张图片与身份外观文字一致，加入批量接受' : '我已查看这张具体图片，加入批量接受'}</Checkbox>
      <Space wrap>
        <Button disabled={mediaDisabled || !image || approved} onClick={(): void => { if (m.selectedAssetId) void state.approveMaterials([{ materialId: m.id, assetId: m.selectedAssetId }]); }}>接受当前图片</Button>
        <Button disabled={mediaDisabled} onClick={(): void => { void state.addMaterialImage(m.id); }}>上传图片替换</Button>
      </Space>
      <Select aria-label={`${m.id}选择已有图片`} className="w-full" placeholder="选择本资产的历史图片（需重新接受）" value={m.selectedAssetId} disabled={mediaDisabled} options={images.map((a, i): { value: string; label: string } => ({ value: a.id, label: `${i + 1} · ${a.taskId ? '已生成' : '用户提供'} · ${a.id.slice(0, 8)}` }))} onChange={(id: string): void => { void state.selectMaterialImage(m.id, id); }} />
      <Collapse className="w-full" defaultActiveKey={['prompt']} items={[{ key: 'prompt', label: '基础图提示词与设计来源', children: <Space direction="vertical" className="w-full"><Typography.Text type="secondary">{chatCandidate && m.prompt.final === m.prompt.optimized ? '已保存豆包 Chat · 当前采用' : m.prompt.edited ? '用户编辑 · 当前采用' : '已有档案整理正文 · 非本轮新回复'}</Typography.Text><Input.TextArea aria-label={`${m.id}基础图最终提示词`} disabled={disabled} autoSize={{ minRows: 5, maxRows: 14 }} value={prompt} onChange={(e): void => { setEditing(true); setPrompt(e.target.value); }} /><Space><Button disabled={disabled || prompt === m.prompt.final || !prompt.trim()} onClick={(): void => { void savePrompt(prompt); }}>保存修改后的提示词</Button>{editing && <Button onClick={(): void => { setPrompt(m.prompt.final); setEditing(false); }}>撤销未保存</Button>}</Space>{m.prompt.optimized && <><Typography.Text>{chatCandidate ? '已保存的豆包 Chat 候选' : '已有档案整理正文'}{m.prompt.optimized === m.prompt.final ? '（已采用）' : '（未采用）'}</Typography.Text><pre className="prompt-readonly">{m.prompt.optimized}</pre><Button disabled={disabled || prompt !== m.prompt.final || m.prompt.optimized === m.prompt.final || candidateJob?.resultStatus === 'stale'} onClick={(): void => { void adoptCandidate(); }}>采用此候选</Button></>}<Button disabled={disabled || generationBlocked || prompt !== m.prompt.final || !state.freeChatConfirmed || chatBlocked} onClick={(): void => { void state.regenerateMaterialPrompt(m.id); }}>豆包重新生成此素材提示词</Button><Space wrap><Button disabled={disabled || generationBlocked || prompt !== m.prompt.final || !state.freeChatConfirmed || chatBlocked} onClick={(): void => { void state.reviewContent({ materialId: m.id }); }}>{m.selectedAssetId ? '审查素材正文与当前图片' : '审查本项素材正文（暂无图片）'}</Button></Space>{review && <ReviewIssueSelection key={`${review.id}:${m.id}`} issues={review.parsedResult?.issues?.filter((issue): boolean => issue.targetId === m.id || issue.targetId === m.entityId) || []} targetLabel={`${m.name}素材正文`} disabled={disabled || generationBlocked || prompt !== m.prompt.final || !state.freeChatConfirmed || chatBlocked} revised={revised} onRevise={async (selectedIssueIds: string[]): Promise<void> => state.reviseContent(review.id, { materialId: m.id, selectedIssueIds })} />}{job && <PromptProvenance job={job} task={tasks.find((task): boolean => task.id === job.taskId)} />}<Button disabled={mediaDisabled || generationBlocked || prompt !== m.prompt.final || (!state.capability || !state.capabilityCheckedInSession)} onClick={(): void => { void state.generateMaterials([m.id]); }}>{m.selectedAssetId ? '按当前提示词重新生成图片（保留旧图）' : '生成此基础图'}</Button><Typography.Text type="secondary">生成结果仍待接受；未保存的提示词不会用于任务。</Typography.Text></Space> }]} />
      <Typography.Text type="secondary">{m.selectedAssetId ? `图片审查使用当前所选具体图片（${approved ? '已接受' : '未接受'}）；不会替你接受图片或生成媒体。` : '暂无实际图片，当前审查只能检查文字设计。'}</Typography.Text><MaterialEditPlan project={project} material={m} disabled={disabled || generationBlocked || prompt !== m.prompt.final} />
    </Space>
  </Card>;
};
export const PetStoryMaterials: React.FC<{ project: PetStoryProject; disabled: boolean; generationBlocked?: boolean }> = ({ project, disabled, generationBlocked = false }): React.ReactElement => {
  const state = usePetStoryStore(); const [checked, setChecked] = useState<Record<string, string>>({});
  useEffect((): void => setChecked({}), [project.id]);
  const locked = materialControlsLocked(project, disabled);
  const selections = Object.entries(checked).filter(([id, assetId]): boolean => project.materials?.some((m): boolean => m.id === id && m.selectedAssetId === assetId) || false).map(([materialId, assetId]): { materialId: string; assetId: string } => ({ materialId, assetId }));
  const missing = project.materials?.filter((m): boolean => !m.selectedAssetId).map((m): string => m.id) || [];
  return <Card size="small" title="基础素材先行 · 人物／道具／场景">
    <Space direction="vertical" className="w-full">
      <Alert type="info" message="先确认剧本与资产清单，再生成或上传基础图片。点击图片可放大查看；生成完成后需要接受具体图片，之后另行授权镜头制作。未指定外观均为待确认设计。" />
      {state.capability && !state.capabilityCheckedInSession && <Alert type="info" message="已恢复保存的模型选择，仅用于文字创作；生成图片或视频前请重新核对当前入口。" />}
      <Button type="primary" disabled={locked || !project.plan || !project.plan.props || !project.plan.scenes} onClick={(): void => { void state.confirmStory(); }}>{project.storyApproval ? '重新确认当前剧本与资产清单' : '确认剧本与资产清单（不生成媒体）'}</Button>
      {!project.plan?.scenes && <Alert type="warning" message="旧项目保留原成果；新的镜头生产需要补齐道具、场景与镜头关系，可在角色与分镜中填写。" />}
      <Space wrap><Button disabled={locked || generationBlocked || !project.plan || !state.freeChatConfirmed} onClick={(): void => { void state.extractAssets(); }}>豆包分析并补齐资产清单</Button><Button disabled={locked || generationBlocked || !project.materials?.length || !state.freeChatConfirmed || state.promptBatch.status === 'running'} onClick={(): void => { void state.regenerateAllMaterialPrompts(); }}>生成全部基础素材提示词 · {project.materials?.length || 0} 项</Button></Space>
      <Space wrap><Button disabled={locked || generationBlocked || !materialMediaReady(project, state) || !missing.length} onClick={(): void => { void state.generateMaterials(missing); }}>生成缺失基础图 · {missing.length} 项</Button><Button disabled={locked || !project.storyApproval || !selections.length} onClick={(): void => { void state.approveMaterials(selections); }}>批量接受已查看的 {selections.length} 张图片</Button></Space>
      {project.materials?.map((m): React.ReactNode => <MaterialCard key={m.id} project={project} material={m} disabled={locked} generationBlocked={generationBlocked} checked={checked[m.id] === m.selectedAssetId && !!m.selectedAssetId} check={(value: boolean): void => setChecked((old): Record<string, string> => { const next = { ...old }; if (value && m.selectedAssetId) next[m.id] = m.selectedAssetId; else delete next[m.id]; return next; })} />)}
      {!project.materials?.length && <Typography.Text type="secondary">保存分析结果后显示当前剧本需要的动态素材清单。</Typography.Text>}
    </Space>
  </Card>;
};
