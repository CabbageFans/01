import { createHash } from 'node:crypto';
import type { PetStoryAsset, PetStoryChatJob, PetStoryMaterial, PetStoryPlan, PetStoryProject, PetStoryPrompt, PetStoryPromptReference, PetStoryShot } from '@doubao-studio/contracts';
import presets from './petstoryPresets.json';
import { effectivePromptProfile } from './petstoryPromptProfile';
import { isPetStoryImageAdopted } from './petstoryImageReview';

export function materialDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function storyHash(p: PetStoryProject): string { return materialDigest({ storyId: p.mobileStory?.id, story: p.plan?.adaptedStory }); }
export function isStoryApproved(p: PetStoryProject): boolean { return !!p.plan && !!p.storyApproval && p.storyApproval.hash === storyHash(p); }
/** 角色身份由用户采用的真实图片确定；旧 identity.description 仅作历史，不要求与剧本外观相等。 */
export function confirmedCharacterIdentity(p: PetStoryProject, characterId: string): { assetId: string } | undefined {
  const material = p.materials?.find((item): boolean => item.kind === 'character' && item.entityId === characterId);
  const approved = material?.approved;
  const asset = p.assets.find((item): boolean => item.id === material?.selectedAssetId && item.kind === 'character');
  if (!asset || !approved || approved.assetId !== asset.id || approved.sha256 !== asset.validation?.sha256
    || !asset.validation?.decoded || !(asset.characterIds || (asset.characterId ? [asset.characterId] : [])).includes(characterId)
    || !Number.isFinite(Date.parse(approved.at)) || !isPetStoryImageAdopted(p, asset)) return undefined;
  return { assetId: asset.id };
}
/** 正文合同只快照相关角色已采用图；无关角色和旧外观文字不改变本镜视觉版本。 */
export function characterVisualBasis(p: PetStoryProject, shotId: string): Record<string, string> {
  const ids = p.plan?.shots.find((shot): boolean => shot.id === shotId)?.characterIds || [];
  return Object.fromEntries(ids.slice().sort().flatMap((id): [string, string][] => {
    const identity = confirmedCharacterIdentity(p, id);
    const asset = identity ? p.assets.find((item): boolean => item.id === identity.assetId) : undefined;
    return asset?.validation ? [[`character:${id}`, `${asset.id}:${asset.validation.sha256}`]] : [];
  }));
}
/** 新视觉依据之后的明确基础图请求可以准备新候选；旧请求晚回仍只是历史。 */
export function materialRequestAfterVisualAdoption(p: PetStoryProject, job: PetStoryChatJob): boolean {
  const material = p.materials?.find((item): boolean => item.id === job.materialId);
  if (!material?.visualBasis || job.resultStatus === 'stale') return false;
  return !!job.createdAt && Date.parse(job.createdAt) >= Date.parse(material.visualBasis.adoptedAt);
}
export function requireStoryApproval(p: PetStoryProject): void {
  if (!isStoryApproved(p)) throw new Error('请先核对并确认当前剧本，再制作基础素材');
}
function makePrompt(text: string): PetStoryPrompt { return { original: text, optimized: '', final: '', edited: false, rulesVersion: presets.version }; }
/** 仅未取得正文的本地预览可以重建；旧保存正文、Chat 和手改均保留全文。 */
function isInitialLocalPrompt(p: PetStoryProject, material: PetStoryMaterial): boolean {
  const prompt = material.prompt;
  if (prompt.edited || prompt.sourceJobId || prompt.candidateJobId || prompt.optimized || prompt.final) return false;
  // 兼容尚无 sourceJobId 的旧版 Chat 记录，避免把有真实回复的正文误当模板。
  return !p.jobs.some((job): boolean => job.materialId === material.id && job.status === 'applied' && (!!job.rawText || !!job.parsedResult?.optimized));
}
/** 手改正文也保留专用创作依据；用户编辑不能绕过当前合同和来源核对。 */
export function materialPromptSourceFacts(p: PetStoryProject, materialId: string): PetStoryMaterial {
  const material = p.materials?.find((item): boolean => item.id === materialId);
  if (!material) throw new Error('基础素材不存在');
  const prompt = material.prompt;
  const identity = material.kind === 'character' ? confirmedCharacterIdentity(p, material.entityId) : undefined;
  const source = p.jobs.find((job): boolean => job.id === (prompt.sourceJobId || prompt.basisJobId));
  const currentImageSource = !!source?.createdAt && !!material.approved && Date.parse(source.createdAt) >= Date.parse(material.approved.at);
  if (prompt.supersededByAssetId || identity && !currentImageSource) throw new Error('角色形象已由采用图确定；重新生成基础图时请通过本次图片操作准备新正文');
  if (!prompt.final.trim()) throw new Error('基础素材尚无最终正文，请先通过豆包生成并采用素材提示词；本地设计摘要仅供预览');
  return material;
}
function syncMaterialPrompt(p: PetStoryProject, old: PetStoryMaterial | undefined, unchanged: boolean, text: string): PetStoryPrompt {
  if (!old) return makePrompt(text);
  if (old.prompt.supersededByAssetId) return old.prompt;
  if (unchanged) return old.prompt;
  if (isInitialLocalPrompt(p, old)) return makePrompt(text);
  return { ...old.prompt, needsReview: true };
}
/** 只有镜头实际需要的主体进入清单；地点派生图递归包含主场景。 */
export function requiredMaterialKeys(plan: PetStoryPlan, shotIds?: string[]): Set<string> {
  const keys = new Set<string>();
  if (shotIds?.some((id): boolean => !plan.shots.some((shot): boolean => shot.id === id))) throw new Error('素材确认目标镜头不存在');
  const addScene = (id: string): void => {
    if (keys.has(`scene:${id}`)) return;
    keys.add(`scene:${id}`);
    const parent = plan.scenes?.find((s): boolean => s.id === id)?.parentSceneId;
    if (parent) addScene(parent);
  };
  for (const shot of plan.shots.filter((item): boolean => !shotIds || shotIds.includes(item.id))) {
    for (const id of shot.characterIds) keys.add(`character:${id}`);
    for (const id of shot.propIds || []) keys.add(`prop:${id}`);
    if (shot.sceneId) addScene(shot.sceneId);
  }
  return keys;
}
/** 仅认可同一设计的旧原样默认风格摘要；保留原合同hash，退出默认回退不等于用户修改设计。 */
function onlyRetiredDefaultStyle(p: PetStoryProject, old: PetStoryMaterial | undefined, design: unknown, style: string): old is PetStoryMaterial {
  const saved = p.promptProfile?.assetStyles;
  if (!old || !saved) return false;
  const priorStyle = [saved.common, saved[old.kind]].filter(Boolean).join('\n');
  return priorStyle !== style && old.designHash === materialDigest({ design, style: priorStyle });
}
/** 分类型编译，不替剧本补造外观、人物关系或动作；未知项随设计来源显示。 */
export function syncMaterials(p: PetStoryProject): PetStoryMaterial[] {
  if (!p.plan) return [];
  const plan = p.plan;
  const required = requiredMaterialKeys(plan);
  const items: PetStoryMaterial[] = [];
  const add = (kind: PetStoryMaterial['kind'], entityId: string, name: string, design: unknown, body: string, selectedAssetId?: string): void => {
    const id = `${kind}:${entityId}`;
    if (!required.has(id)) return;
    const styles = effectivePromptProfile(p.promptProfile).assetStyles;
    const style = [styles?.common, styles?.[kind]].filter(Boolean).join('\n');
    const old = p.materials?.find((m): boolean => m.id === id);
    const designHash = onlyRetiredDefaultStyle(p, old, design, style) ? old.designHash : materialDigest({ design, style });
    const unchanged = old?.designHash === designHash;
    const identity = kind === 'character' ? confirmedCharacterIdentity(p, entityId) : undefined;
    const visualBasis = identity && old?.approved ? old.visualBasis || { assetId: identity.assetId, sha256: old.approved.sha256, adoptedAt: old.approved.at } : old?.visualBasis;
    const prompt = syncMaterialPrompt(p, old, unchanged, `${body}${style ? `\n视觉风格：${style}` : ''}`);
    // 采用图生效后，旧正文只保留历史。描述或旧预设变化不能撤销这次视觉选择。
    items.push({ id, kind, entityId, name, designHash,
      prompt: visualBasis ? { ...prompt, supersededByAssetId: visualBasis.assetId, needsReview: undefined } : prompt,
      selectedAssetId: old?.selectedAssetId || selectedAssetId, approved: unchanged || !!identity ? old?.approved : undefined,
      ...(visualBasis ? { visualBasis } : {}) });
  };
  for (const c of plan.characters) {
    // purpose／continuity 可含其他人物和整段剧情，不能当作当前人物的可视设计。
    add('character', c.id, c.name, { description: c.description }, `生成人物基础参考图，单幅完整角色。\n外观、体态、面部、服装和饰物：${c.description}\n采用中性放松站姿，只建立可复用身份；不复制身份参考的动作、背景或表情分格，不添加其他人物、台词或文字。`, c.referenceAssetId);
  }
  for (const prop of plan.props || []) add('prop', prop.id, prop.name, { description: prop.description, appearanceState: prop.appearanceState, scale: prop.scale },
    `生成道具基础参考图，仅展示${prop.name}本体。形状、颜色、材质和辨识细节：${prop.description}${prop.appearanceState ? `\n静态外观状态：${prop.appearanceState}` : ''}${prop.scale ? `\n尺寸与比例：${prop.scale}` : ''}\n清楚展示单个静物，不添加持有者、人物动作、台词或文字。`);
  for (const scene of plan.scenes || []) add('scene', scene.id, scene.name, scene,
    `生成场景基础参考图，地点：${scene.location}。时间：${scene.time}。光线：${scene.lighting}。\n空间布局、主要地标和相互关系：${scene.layout}。视角：${scene.view}。\n${scene.parentSceneId ? `从主场景 {{ref:scene:${scene.parentSceneId}}} 派生当前视角，保持地标、材质、空间和光线。` : '建立可复用的主场景。'}\n画面不包含人物，不把额外关键道具或人物烘焙进环境。`);
  return items;
}
function requireCandidateConfirmation(p: PetStoryProject, materialId: string): void {
  const material = p.materials?.find((item): boolean => item.id === materialId);
  if (material && p.assets.some((item): boolean => item.materialId === materialId && item.imageReview?.state === 'candidate')) throw new Error(`${material.name}的当前图片尚未确认`);
}
function requireMaterialImageApproval(p: PetStoryProject, material: PetStoryMaterial, asset: PetStoryAsset): void {
  if (!asset.validation || material.approved?.assetId !== asset.id || material.approved.sha256 !== asset.validation.sha256 || !isPetStoryImageAdopted(p, asset)) throw new Error(`${material.name}的当前图片尚未确认`);
}
export function materialAsset(p: PetStoryProject, materialId: string, requireApproved = true): NonNullable<PetStoryProject['assets'][number]> {
  const material = p.materials?.find((m): boolean => m.id === materialId);
  const asset = p.assets.find((a): boolean => a.id === material?.selectedAssetId);
  if (!asset && requireApproved) requireCandidateConfirmation(p, materialId);
  if (!material || !asset || asset.kind !== material.kind || (asset.materialId !== material.id && !(material.kind === 'character' && (asset.characterIds || [asset.characterId]).includes(material.entityId)))) throw new Error(`${material?.name || materialId}缺少对应实际基础图`);
  if (requireApproved) requireMaterialImageApproval(p, material, asset);
  const characterReference = material.kind === 'character' ? p.plan?.characters.find((c): boolean => c.id === material.entityId)?.referenceAssetId : undefined;
  if (characterReference && characterReference !== asset.id) throw new Error(`${material.name}的角色参考与所选基础图片不一致`);
  return asset;
}
function materialDependentShotIds(p: PetStoryProject, material: PetStoryMaterial | undefined): Set<string> {
  const affected = new Set(p.plan?.shots.filter((shot): boolean => material?.kind === 'character' ? shot.characterIds.includes(material.entityId)
    : material?.kind === 'prop' ? !!shot.propIds?.includes(material.entityId) : material?.kind === 'scene' && shot.sceneId === material.entityId).map((shot): string => shot.id));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const shot of p.plan?.shots || []) {
      const previous = shot.previousShotId || p.plan?.shots.filter((item): boolean => item.order < shot.order).sort((a, b): number => b.order - a.order)[0]?.id;
      if (shot.transition === 'continue' && previous && affected.has(previous) && !affected.has(shot.id)) { affected.add(shot.id); expanded = true; }
    }
  }
  return affected;
}
function invalidateShotVisuals(p: PetStoryProject, affected: Set<string>, characterReplacement: boolean): void {
  for (const asset of p.assets) if (asset.shotId && affected.has(asset.shotId)) {
    if (characterReplacement) asset.visualBasisStale = true;
    if (characterReplacement || ['video', 'actualEndFrame'].includes(asset.kind)) asset.needsReview = true;
  }
  if (!characterReplacement) return;
  for (const shot of p.plan?.shots || []) if (affected.has(shot.id)) for (const prompt of Object.values(shot.prompts)) {
    if (prompt && prompt.promptTask?.visualPolicy !== 'reference-first-v1') { prompt.needsReview = true; prompt.visualBasisStale = true; }
  }
}
/** 只沿实际素材与连续引用处理；历史文件和原采用事实保留，不自动重生成。 */
export function invalidateMaterialDependents(p: PetStoryProject, materialId: string): void {
  const material = p.materials?.find((item): boolean => item.id === materialId);
  invalidateShotVisuals(p, materialDependentShotIds(p, material), material?.kind === 'character');
  for (const scene of p.plan?.scenes || []) {
    if (`scene:${scene.parentSceneId}` !== materialId) continue;
    const child = p.materials?.find((m): boolean => m.id === `scene:${scene.id}`);
    if (child) child.approved = undefined;
    invalidateMaterialDependents(p, `scene:${scene.id}`);
  }
}
export function requireMaterialInventory(p: PetStoryProject): void {
  requireStoryApproval(p);
  if (!p.plan?.scenes || !p.plan.props || p.plan.shots.some((s): boolean => !s.sceneId || !s.propIds)) throw new Error('旧方案尚无完整人物／道具／场景清单，请补齐资产和镜头关系后确认');
  const expected = syncMaterials(p);
  if (expected.some((m): boolean => !p.materials?.some((old): boolean => old.id === m.id && old.designHash === m.designHash))) throw new Error('基础素材设计已变化，请重新确认剧本清单');
}
export function requireApprovedMaterials(p: PetStoryProject, shotIds?: string[]): void {
  requireMaterialInventory(p);
  const plan = p.plan; if (!plan) throw new Error('剧本不存在');
  for (const key of requiredMaterialKeys(plan, shotIds)) materialAsset(p, key);
}
function materialHashEntries(p: PetStoryProject, shotIds: string[] | undefined, legacy: boolean): object[] | undefined {
  const keys = shotIds && p.plan ? requiredMaterialKeys(p.plan, shotIds) : undefined;
  return p.materials?.filter((material): boolean => !keys || keys.has(material.id)).map((material): object => {
    if (!legacy && material.kind === 'character' && confirmedCharacterIdentity(p, material.entityId)) return {
      id: material.id, selected: material.selectedAssetId, approved: { assetId: material.approved?.assetId, sha256: material.approved?.sha256 },
    };
    return { id: material.id, designHash: material.designHash, selected: material.selectedAssetId, approved: material.approved };
  });
}
/** 当前人物素材只锁定实际采用图，旧造型描述和身份文本不再影响制作授权。 */
export function approvedMaterialHash(p: PetStoryProject, shotIds?: string[]): string { return materialDigest(materialHashEntries(p, shotIds, false)); }
/** 只精确核对旧运行的原摘要，不回写新hash伪造授权。 */
export function legacyApprovedMaterialHash(p: PetStoryProject, shotIds?: string[]): string { return materialDigest(materialHashEntries(p, shotIds, true)); }
export function shotMaterialReferences(p: PetStoryProject, shot: PetStoryShot, planned = false): PetStoryPromptReference[] {
  const keys = [...shot.characterIds.map((id): string => `character:${id}`), ...(shot.propIds || []).map((id): string => `prop:${id}`), ...(shot.sceneId ? [`scene:${shot.sceneId}`] : [])];
  const refs: PetStoryPromptReference[] = [];
  for (const key of keys) {
    const m = p.materials?.find((m): boolean => m.id === key);
    let asset: PetStoryProject['assets'][number] | undefined;
    try { asset = materialAsset(p, key); } catch (error: unknown) { if (!planned) throw error; }
    const assetId = asset?.id || `pending:${key}`;
    const previous = refs.find((r): boolean => r.assetId === assetId);
    const characterIds = key.startsWith('character:') ? [key.slice('character:'.length)] : [];
    if (previous) { previous.characterIds.push(...characterIds); continue; }
    refs.push({ assetId, materialId: key, entityId: m?.entityId || key.slice(key.indexOf(':') + 1), order: refs.length + 1, characterIds,
      purpose: key.startsWith('character:') ? 'identity' : key.startsWith('prop:') ? 'prop' : 'scene' });
  }
  return refs;
}
