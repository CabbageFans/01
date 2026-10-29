import type { PetStoryAsset, PetStoryMaterial, PetStoryProduction, PetStoryProject, PetStoryPrompt, PetStoryPromptKind, PetStoryShot, Task } from '@doubao-studio/contracts';

export type PetStoryJourneyStage = 'script' | 'plan' | 'materials' | 'keyframes' | 'videos' | 'results';
export const petStoryJourneyStages: ReadonlyArray<{ key: PetStoryJourneyStage; label: string }> = [
  { key: 'script', label: '输入剧本' }, { key: 'plan', label: '确认方案' }, { key: 'materials', label: '准备基础素材' },
  { key: 'keyframes', label: '制作关键帧' }, { key: 'videos', label: '制作镜头视频' }, { key: 'results', label: '查看成果' },
];

export interface PetStoryJourneyShot {
  shot: PetStoryShot;
  firstFrame?: PetStoryAsset;
  lastFrame?: PetStoryAsset;
  video?: PetStoryAsset;
  requiresLastFrame: boolean;
  missing: string[];
}
export interface PetStoryJourneyCounts {
  shots: number;
  materials: { total: number; selected: number; confirmed: number; promptsSaved: number };
  prompts: { total: number; saved: number; candidates: number; needsReview: number };
  keyframes: { total: number; present: number; current: number; validated: number };
  videos: { total: number; present: number; current: number; validated: number };
  quality: { total: number; confirmed: number };
}
export interface PetStoryJourney {
  stage: PetStoryJourneyStage;
  reason: string;
  counts: PetStoryJourneyCounts;
  shots: PetStoryJourneyShot[];
}

function productions(project: PetStoryProject): PetStoryProduction[] {
  return [...(project.productionHistory || []), ...(project.production ? [project.production] : [])].reverse();
}

/** 仅查找实际绑定的本地文件；批次完成和文字候选都不是产物。 */
export function journeyShotAsset(project: PetStoryProject, shot: PetStoryShot, kind: PetStoryPromptKind): PetStoryAsset | undefined {
  const assetKind = kind === 'lastFrame' ? 'plannedEndImage' : kind;
  if (kind !== 'video') {
    const imageId = kind === 'firstFrame' ? project.adoptedImages?.[shot.id]?.firstFrameId : project.adoptedImages?.[shot.id]?.plannedEndImageId;
    return project.assets.find((asset): boolean => asset.id === imageId && asset.shotId === shot.id && asset.kind === assetKind && asset.imageReview?.state === 'adopted');
  }
  const media = productions(project).find((production): boolean => !!production.shots[shot.id])?.shots[shot.id];
  if (media?.videoId) return project.assets.find((asset): boolean => asset.id === media.videoId && asset.shotId === shot.id && asset.kind === 'video');
  return [...project.assets].reverse().find((asset): boolean => asset.shotId === shot.id && asset.kind === 'video');
}

/** 当前正文一致性只是成果显示事实；是否允许发送仍由主进程资格服务决定。 */
export function journeyAssetMatchesPrompt(asset: PetStoryAsset | undefined, prompt: PetStoryPrompt | undefined): boolean {
  if (!asset?.validation?.decoded || asset.needsReview) return false;
  // 上传图片的采用事实独立于模型提示词；缺少生成正文不代表图片未确认。
  if (asset.imageReview?.state === 'adopted' && !asset.taskId) return true;
  return !!prompt?.final.trim() && !prompt.needsReview && asset.generationFinal === prompt.final;
}

interface JourneyPrompt { prompt: PetStoryPrompt; materialId?: string; shotId?: string; promptKind?: PetStoryPromptKind }
function hasNewCandidate(project: PetStoryProject, { prompt, materialId, shotId, promptKind }: JourneyPrompt): boolean {
  return !!prompt.optimized.trim() && prompt.optimized !== prompt.final && project.jobs.some((job): boolean => job.status === 'applied' && job.resultStatus === 'candidate'
    && job.materialId === materialId && job.shotId === shotId && job.promptKind === promptKind && job.parsedResult?.optimized === prompt.optimized && (!prompt.candidateJobId || prompt.candidateJobId === job.id));
}

function requiresLastFrame(project: PetStoryProject, shot: PetStoryShot): boolean {
  // 已解析模式由原制作服务保存；未解析的自动模式保留方案已有尾帧目标，不自行解析平台能力。
  if (shot.requestedMode !== 'auto') return shot.requestedMode === 'first_last_frame';
  const resolved = productions(project).find((production): boolean => !!production.shots[shot.id])?.shots[shot.id]?.resolvedMode;
  return resolved === 'first_last_frame' || !resolved && !!shot.prompts.lastFrame;
}

function materialConfirmationMatches(project: PetStoryProject, material: PetStoryMaterial): boolean {
  const asset = project.assets.find((item): boolean => item.id === material.selectedAssetId && item.kind === material.kind);
  if (!asset?.validation?.decoded || !material.approved || material.approved.assetId !== asset.id || material.approved.sha256 !== asset.validation.sha256) return false;
  if (material.kind !== 'character') return true;
  const character = project.plan?.characters.find((item): boolean => item.id === material.entityId);
  return !!character && material.approved.identity?.assetId === asset.id && material.approved.identity.description === character.description
    && (!character.referenceAssetId || character.referenceAssetId === asset.id);
}

/** 六步只读导航投影，不增加持久化阶段，不替代任何生产或正文资格判断。 */
export function selectPetStoryJourney(project: PetStoryProject, tasks: Task[] = []): PetStoryJourney {
  const materials = project.materials || [];
  const shots: PetStoryJourneyShot[] = (project.plan?.shots || []).map((shot): PetStoryJourneyShot => {
    const firstFrame = journeyShotAsset(project, shot, 'firstFrame');
    const lastFrame = journeyShotAsset(project, shot, 'lastFrame');
    const video = journeyShotAsset(project, shot, 'video');
    const tail = requiresLastFrame(project, shot);
    const missing: string[] = [];
    if (!journeyAssetMatchesPrompt(firstFrame, shot.prompts.firstFrame)) missing.push(firstFrame ? '首帧需核对当前正文或文件校验' : '缺首帧');
    if (tail && !journeyAssetMatchesPrompt(lastFrame, shot.prompts.lastFrame)) missing.push(lastFrame ? '尾帧需核对当前正文或文件校验' : '缺尾帧');
    if (!journeyAssetMatchesPrompt(video, shot.prompts.video)) missing.push(video ? '视频需核对当前正文或文件校验' : '缺视频');
    return { shot, firstFrame, lastFrame, video, requiresLastFrame: tail, missing };
  });
  const prompts: JourneyPrompt[] = [...materials.map((material): JourneyPrompt => ({ prompt: material.prompt, materialId: material.id })), ...shots.flatMap(({ shot }): JourneyPrompt[] => (['firstFrame', 'lastFrame', 'video'] as const).flatMap((kind): JourneyPrompt[] => { const prompt = shot.prompts[kind]; return prompt ? [{ prompt, shotId: shot.id, promptKind: kind }] : []; }))];
  const frames = shots.flatMap((item): { asset?: PetStoryAsset; prompt?: PetStoryPrompt }[] => [
    { asset: item.firstFrame, prompt: item.shot.prompts.firstFrame }, ...(item.requiresLastFrame ? [{ asset: item.lastFrame, prompt: item.shot.prompts.lastFrame }] : []),
  ]);
  const counts: PetStoryJourneyCounts = {
    shots: shots.length,
    materials: {
      total: materials.length,
      selected: materials.filter((material): boolean => project.assets.some((asset): boolean => asset.id === material.selectedAssetId && asset.kind === material.kind)).length,
      confirmed: materials.filter((material): boolean => materialConfirmationMatches(project, material)).length,
      promptsSaved: materials.filter((material): boolean => !!material.prompt.final.trim()).length,
    },
    prompts: { total: prompts.length, saved: prompts.filter(({ prompt }): boolean => !!prompt.final.trim()).length, candidates: prompts.filter((item): boolean => hasNewCandidate(project, item)).length, needsReview: prompts.filter(({ prompt }): boolean => !!prompt.needsReview).length },
    keyframes: { total: frames.length, present: frames.filter((item): boolean => !!item.asset).length, current: frames.filter((item): boolean => journeyAssetMatchesPrompt(item.asset, item.prompt)).length, validated: frames.filter((item): boolean => !!item.asset?.validation?.decoded).length },
    videos: { total: shots.length, present: shots.filter((item): boolean => !!item.video).length, current: shots.filter((item): boolean => journeyAssetMatchesPrompt(item.video, item.shot.prompts.video)).length, validated: shots.filter((item): boolean => !!item.video?.validation?.decoded).length },
    quality: { total: shots.length, confirmed: shots.filter((item): boolean => !!item.video && tasks.some((task): boolean => task.id === item.video?.taskId && task.runtime?.runId === item.video.runId && task.qualityVerdict?.status === 'accepted')).length },
  };
  let stage: PetStoryJourneyStage = 'results';
  let reason = '逐镜素材已具备当前正文和文件校验记录，请查看实际视频并完成质量确认。';
  if (!project.mobileStory?.text.trim()) { stage = 'script'; reason = '先输入并保存你的剧本，再明确开始分析。'; }
  else if (!project.plan?.shots.length) {
    const candidate = project.jobs.some((job): boolean => !job.endedWaitingAt && job.resultStatus === 'candidate' && !!job.parsedResult?.plan?.shots.length);
    stage = candidate ? 'plan' : 'script'; reason = candidate ? '分析方案已就绪，先查看理解与分镜结果，再采用并确认。' : '剧本已保存，下一步点击分析并生成方案。';
  }
  else if (!project.storyApproval) { stage = 'plan'; reason = '核对人物、道具、场景和动态分镜，确认本次制作依据。'; }
  else if (!materials.length || counts.materials.confirmed < counts.materials.total) { stage = 'materials'; reason = `基础图片已确认 ${counts.materials.confirmed}/${counts.materials.total}，先补齐并逐张确认。`; }
  else if (counts.keyframes.current < counts.keyframes.total) { stage = 'keyframes'; reason = `关键帧与当前正文一致且有文件校验记录 ${counts.keyframes.current}/${counts.keyframes.total}。`; }
  else if (counts.videos.current < counts.videos.total) { stage = 'videos'; reason = `镜头视频与当前正文一致且有文件校验记录 ${counts.videos.current}/${counts.videos.total}。`; }
  return { stage, reason, counts, shots };
}
