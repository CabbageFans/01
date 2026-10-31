import React, { useEffect, useState } from 'react';
import { Button, Card, Space, Tag, Typography } from 'antd';
import type { PetStoryMaterial, PetStoryProject } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../store/usePetStoryStore';
import { useTaskStore } from '../store/useTaskStore';
import { petStoryMaterialPromptBlock } from '../utils/petstoryCandidate';
import { petStoryImageProgress } from '../utils/petstoryImageFlow';
import { PetStoryImageReview } from './PetStoryImageReview';
import { imageBelongsToTarget, pendingImageCandidates } from '../utils/petstoryImageCandidates';
import { journeyMaterialImageApproved } from '../utils/petstoryJourney';
import '../styles/petstory-materials.css';

const labels = { character: '人物', prop: '道具', scene: '场景' };
export type PetStoryMaterialNavigate = (target: 'plan' | 'keyframes', objectId?: string) => void;
function reviewMaterialPlan(onNavigate?: PetStoryMaterialNavigate): void {
  if (onNavigate) onNavigate('plan');
  else window.dispatchEvent(new CustomEvent('petstory-journey-focus', { detail: { target: 'plan' } }));
}
function materialCandidateCount(project: PetStoryProject, material: PetStoryMaterial): number {
  return pendingImageCandidates(project, { materialId: material.id }).length;
}
/** 仅投影已保存的选图及确认记录用于数量展示；采用仍经过正式服务。 */
export function isPetStoryMaterialImageApproved(project: PetStoryProject, material: PetStoryMaterial): boolean {
  return journeyMaterialImageApproved(project, material);
}
function materialImageStatus(progress: ReturnType<typeof petStoryImageProgress>, candidates: number, hasCurrent: boolean, approved: boolean): string {
  if (progress.resumable) return '待继续';
  if (progress.busy) return progress.message.includes('修改') ? '正在修改' : '正在生成';
  if (candidates) return '图片待确认';
  if (hasCurrent && !approved) return '需要复核';
  return approved ? '已采用' : '尚无图片';
}
interface MaterialCardProps { project: PetStoryProject; material: PetStoryMaterial; disabled: boolean; generationBlocked: boolean }
const MaterialCard: React.FC<MaterialCardProps> = ({ project, material, disabled, generationBlocked }): React.ReactElement => {
  const state = usePetStoryStore();
  const tasks = useTaskStore((store) => store.tasks);
  const target = { materialId: material.id };
  const progress = petStoryImageProgress(project, target, tasks, state.activeImageOperationId);
  const block = petStoryMaterialPromptBlock(project, material.id, tasks);
  const approved = isPetStoryMaterialImageApproved(project, material);
  const candidateCount = materialCandidateCount(project, material);
  const selected = project.assets.find((asset): boolean => asset.id === material.selectedAssetId && imageBelongsToTarget(project, asset, target));
  const current = selected && selected.imageReview?.state !== 'candidate' && (approved || selected.imageReview?.state === 'adopted' || material.approved?.assetId === selected.id) ? selected : undefined;
  const character = project.plan?.characters.find((item): boolean => material.kind === 'character' && item.id === material.entityId);
  const used = project.plan?.shots.filter((shot): boolean => material.kind === 'character' ? shot.characterIds.includes(material.entityId) : material.kind === 'prop' ? !!shot.propIds?.includes(material.entityId) : shot.sceneId === material.entityId).map((shot): string => String(shot.order)).join('、');
  const status = materialImageStatus(progress, candidateCount, !!current, approved);
  return <Card className="petstory-material-card" id={`material-${material.id}`} size="small" data-material-id={material.id} data-material-state={status} title={<Space wrap><Tag>{labels[material.kind]}</Tag>{material.name}<Tag color={approved && !candidateCount ? 'green' : candidateCount || current ? 'orange' : 'default'}>{status}</Tag></Space>}>
    <Typography.Paragraph className="petstory-material-purpose" type="secondary">{used ? `用于镜头 ${used}` : '可复用基础素材'}</Typography.Paragraph>
    <PetStoryImageReview project={project} target={target} title={`${material.name} · ${labels[material.kind]}参考图`} currentAssetId={current?.id} currentNeedsReview={!!current && !approved} identity={character?.description}
      disabled={disabled || !project.storyApproval} generationDisabled={generationBlocked || !!block || progress.busy || progress.resumable} generating={progress.busy}
      onUpload={async (): Promise<void> => state.addMaterialImage(material.id)}
      onGenerate={async (): Promise<void> => state.generateMaterialImage(material.id)}
      onAdopt={async (assetId: string): Promise<void> => state.approveMaterials([{ materialId: material.id, assetId }])} />
    {block && !progress.error && <p className="petstory-material-reason" role="status">{block.message}</p>}
  </Card>;
};

interface PetStoryMaterialsProps { project: PetStoryProject; disabled: boolean; generationBlocked?: boolean; showStageActions?: boolean; onNavigate?: PetStoryMaterialNavigate }
/** 素材页只呈现图片、进度和采用决定；文字准备由图片操作内部接续。 */
export const PetStoryMaterials: React.FC<PetStoryMaterialsProps> = ({ project, disabled, generationBlocked = false, onNavigate }): React.ReactElement => {
  const [filter, setFilter] = useState('all');
  useEffect((): void => { setFilter('all'); }, [project.id]);
  const materials = project.materials || [];
  const confirmed = materials.filter((material): boolean => isPetStoryMaterialImageApproved(project, material)).length;
  const pending = materials.filter((material): boolean => materialCandidateCount(project, material) > 0).length;
  const missing = materials.filter((material): boolean => !isPetStoryMaterialImageApproved(project, material) && !materialCandidateCount(project, material)).length;
  if (!project.storyApproval) return <Card className="petstory-materials-panel" size="small" title="准备基础素材"><div className="petstory-material-plan-required" role="status"><Typography.Text type="secondary">方案确认后，显示人物、道具和场景素材。</Typography.Text><Button id="petstory-material-story-confirm" type="primary" onClick={(): void => reviewMaterialPlan(onNavigate)}>查看并确认方案</Button></div></Card>;
  return <Card className="petstory-materials-panel" size="small" title="准备基础素材 · 人物／道具／场景"><Space direction="vertical" className="w-full">
    <div className="petstory-material-summary"><Typography.Text type="secondary">已采用 {confirmed}/{materials.length} · 待确认 {pending} · 缺少 {missing}</Typography.Text></div>
    <div className="petstory-material-filters" role="group" aria-label="筛选基础素材">{[{ value: 'all', label: '全部' }, ...Object.entries(labels).map(([value, label]): { value: string; label: string } => ({ value, label }))].map((item): React.ReactNode => <Button key={item.value} type="text" aria-pressed={filter === item.value} onClick={(): void => setFilter(item.value)}>{item.label}</Button>)}</div>
    <div className="petstory-material-grid">{materials.filter((material): boolean => filter === 'all' || material.kind === filter).map((material): React.ReactNode => <MaterialCard key={material.id} project={project} material={material} disabled={disabled} generationBlocked={generationBlocked} />)}</div>
    {!materials.length && <Typography.Text type="secondary">当前方案没有列出基础素材，请查看方案。</Typography.Text>}
    {materials.length > 0 && confirmed === materials.length && onNavigate && <Button onClick={(): void => onNavigate('keyframes')}>基础素材已采用，进入关键帧制作</Button>}
  </Space></Card>;
};
