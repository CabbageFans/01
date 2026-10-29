import { createHash } from 'node:crypto';
import type { PetStoryAsset, PetStoryMaterial, PetStoryPlan, PetStoryProject, PetStoryPrompt, PetStoryPromptReference, PetStoryShot } from '@doubao-studio/contracts';
import presets from './petstoryPresets.json';
import { requirePromptEligibility } from './petstoryEligibility';
import { isPetStoryImageAdopted } from './petstoryImageReview';

export function materialDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function storyHash(p: PetStoryProject): string { return materialDigest({ storyId: p.mobileStory?.id, story: p.plan?.adaptedStory }); }
export function isStoryApproved(p: PetStoryProject): boolean { return !!p.plan && !!p.storyApproval && p.storyApproval.hash === storyHash(p); }
/** 身份批准绑定当前所选的真实图片；仅保存过设计文字或选过图都不等于批准身份。 */
export function confirmedCharacterIdentity(p: PetStoryProject, characterId: string): { assetId: string; description: string } | undefined {
  const material = p.materials?.find((item): boolean => item.kind === 'character' && item.entityId === characterId);
  const approved = material?.approved; const identity = approved?.identity;
  const asset = p.assets.find((item): boolean => item.id === material?.selectedAssetId && item.kind === 'character');
  if (!asset || !approved || !identity || approved.assetId !== asset.id || identity.assetId !== asset.id || approved.sha256 !== asset.validation?.sha256
    || !asset.validation?.decoded || !(asset.characterIds || (asset.characterId ? [asset.characterId] : [])).includes(characterId)
    || !Number.isFinite(Date.parse(approved.at)) || typeof identity.description !== 'string' || !identity.description.trim()) return undefined;
  return { assetId: identity.assetId, description: identity.description };
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
export function requireMaterialPromptSource(p: PetStoryProject, materialId: string): PetStoryMaterial {
  const material = p.materials?.find((item): boolean => item.id === materialId);
  if (!material) throw new Error('基础素材不存在');
  const prompt = material.prompt;
  if (!prompt.final.trim()) throw new Error('基础素材尚无最终正文，请先通过豆包生成并采用素材提示词；本地设计摘要仅供预览');
  requirePromptEligibility(p, prompt, { materialId });
  return material;
}
function syncMaterialPrompt(p: PetStoryProject, old: PetStoryMaterial | undefined, unchanged: boolean, text: string): PetStoryPrompt {
  if (!old) return makePrompt(text);
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
/** 分类型编译，不替剧本补造外观、人物关系或动作；未知项随设计来源显示。 */
export function syncMaterials(p: PetStoryProject): PetStoryMaterial[] {
  if (!p.plan) return [];
  const plan = p.plan;
  const required = requiredMaterialKeys(plan);
  const items: PetStoryMaterial[] = [];
  const add = (kind: PetStoryMaterial['kind'], entityId: string, name: string, design: unknown, body: string, selectedAssetId?: string): void => {
    const id = `${kind}:${entityId}`;
    if (!required.has(id)) return;
    const styles = (p.promptProfile || presets.profile).assetStyles;
    const style = [styles?.common, styles?.[kind]].filter(Boolean).join('\n');
    const designHash = materialDigest({ design, style });
    const old = p.materials?.find((m): boolean => m.id === id);
    const unchanged = old?.designHash === designHash;
    // 本地模板随设计更新；真实 Chat 和手改正文在设计变更后仅标为待复核。
    items.push({ id, kind, entityId, name, designHash, prompt: syncMaterialPrompt(p, old, unchanged, `${body}${style ? `\n视觉风格：${style}` : ''}`),
      selectedAssetId: old?.selectedAssetId || selectedAssetId, approved: unchanged ? old?.approved : undefined });
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
  if (material.kind === 'character' && (material.approved.identity?.assetId !== asset.id || material.approved.identity.description !== p.plan?.characters.find((c): boolean => c.id === material.entityId)?.description)) throw new Error(`${material.name}的身份文字与具体图片需一并重新确认`);
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
/** 主场景替换后派生图仍保留，但必须重新检查接受。 */
export function invalidateMaterialDependents(p: PetStoryProject, materialId: string): void {
  const material = p.materials?.find((item): boolean => item.id === materialId);
  const affected = new Set(p.plan?.shots.filter((shot): boolean => material?.kind === 'character' ? shot.characterIds.includes(material.entityId)
    : material?.kind === 'prop' ? !!shot.propIds?.includes(material.entityId) : material?.kind === 'scene' && shot.sceneId === material.entityId).map((shot): string => shot.id));
  for (const asset of p.assets) if (asset.shotId && affected.has(asset.shotId) && ['firstFrame', 'plannedEndImage', 'video', 'actualEndFrame'].includes(asset.kind)) asset.needsReview = true;
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
export function approvedMaterialHash(p: PetStoryProject, shotIds?: string[]): string {
  const keys = shotIds && p.plan ? requiredMaterialKeys(p.plan, shotIds) : undefined;
  return materialDigest(p.materials?.filter((material): boolean => !keys || keys.has(material.id)).map((m): object => ({ id: m.id, designHash: m.designHash, selected: m.selectedAssetId, approved: m.approved })));
}
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
