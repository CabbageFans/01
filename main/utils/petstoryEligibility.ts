import { createHash } from 'node:crypto';
import type { PetStoryCapability, PetStoryChatJob, PetStoryProject, PetStoryPrompt, PetStoryPromptKind, PetStoryPromptReference, PetStoryPromptTaskContract, PetStoryResolvedMode, PetStoryRuntimeTarget } from '@doubao-studio/contracts';
import { runtimePromptIssues } from './petstoryValidation';
import { compileReferencedText, materialPromptReferences, plannedReferenceMap, promptReferences } from './petstoryPromptQuality';
import { isStoryApproved } from './petstoryMaterials';

export interface PromptEligibilityTarget {
  materialId?: string;
  shotId?: string;
  promptKind?: PetStoryPromptKind;
  mode?: PetStoryResolvedMode;
  /** 实际制作入口覆盖文字意图；不伪造已核对的网页能力。 */
  model?: string;
  currentReferences?: PetStoryPromptReference[];
}
export interface PromptEligibility {
  state: 'creative_plan' | 'adopted_unbound' | 'submittable' | 'needs_revision';
  reasons: string[];
  /** 仅用于补齐文字阶段；通用计划可写完，但仍没有已知模型媒体提交资格。 */
  writingReady: boolean;
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function targetId(target: PromptEligibilityTarget): string | undefined { return target.materialId || (target.shotId && target.promptKind ? `${target.shotId}:${target.promptKind}` : undefined); }
function adoptedText(prompt?: PetStoryPrompt): string | undefined { return prompt && (prompt.sourceJobId || prompt.edited) ? prompt.final : undefined; }

/** 只锁定创作事实及已采用边界；确认图片、计划占位落地和上传编号不改变创作事实。 */
export function promptDesignHash(p: PetStoryProject, target: PromptEligibilityTarget): string {
  const material = p.materials?.find((item): boolean => item.id === target.materialId);
  if (material) return digest({ story: p.mobileStory, adaptedStory: p.plan?.adaptedStory, material: { id: material.id, designHash: material.designHash } });
  const shot = p.plan?.shots.find((item): boolean => item.id === target.shotId);
  if (!shot) return digest({ target: targetId(target), missing: true });
  const { prompts: _prompts, characterIds, propIds, sceneReferenceAssetIds: _sceneReferenceAssetIds, ...design } = shot;
  const previous = p.plan?.shots.find((item): boolean => item.id === shot.previousShotId)
    || p.plan?.shots.filter((item): boolean => item.order < shot.order).sort((a, b): number => b.order - a.order)[0];
  const characters = p.plan?.characters.filter((item): boolean => characterIds.includes(item.id)).map(({ referenceAssetId: _referenceAssetId, ...item }): object => item).sort((a, b): number => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const profile = p.promptProfile ? { style: p.promptProfile.style, characters: Object.fromEntries(Object.entries(p.promptProfile.characters).filter(([id]): boolean => characterIds.includes(id))) } : undefined;
  const snapshot = { story: p.mobileStory, adaptedStory: p.plan?.adaptedStory, sceneDesign: p.plan?.sceneDesign, profile,
    shot: { ...design, characterIds: [...characterIds].sort(), propIds: propIds ? [...propIds].sort() : undefined }, characters,
    materials: p.materials?.filter((item): boolean => characterIds.includes(item.entityId) || (propIds || []).includes(item.entityId) || item.entityId === shot.sceneId).map((item): object => ({ id: item.id, designHash: item.designHash })).sort((a, b): number => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    props: p.plan?.props?.filter((item): boolean => (propIds || []).includes(item.id)), scenes: p.plan?.scenes?.filter((item): boolean => item.id === shot.sceneId),
    firstFrame: target.promptKind === 'lastFrame' || target.promptKind === 'video' ? adoptedText(shot.prompts.firstFrame) : undefined,
    lastFrame: target.promptKind === 'video' ? adoptedText(shot.prompts.lastFrame) : undefined,
    previousBoundary: previous ? { id: previous.id, endState: previous.endState, lastFrame: adoptedText(previous.prompts.lastFrame), video: adoptedText(previous.prompts.video) } : undefined };
  return digest(snapshot);
}
export function promptModelDialect(model?: string): PetStoryPromptTaskContract['dialect'] {
  return /seedance[\s_-]*2[._]5/i.test(model || '') ? 'seedance25' : /seedance[\s_-]*2[._]0/i.test(model || '') ? 'seedance20' : 'generic';
}
function creativeSource(p: PetStoryProject, prompt: PetStoryPrompt): PetStoryChatJob | undefined {
  const id = prompt.sourceJobId || (prompt.edited ? prompt.basisJobId : undefined);
  return p.jobs.find((job): boolean => job.id === id);
}
function requiredStage(p: PetStoryProject, target: PromptEligibilityTarget): string | undefined {
  const kind = p.materials?.find((item): boolean => item.id === target.materialId)?.kind;
  return kind === 'character' ? 'imageCharacter' : kind === 'prop' ? 'imageProp' : kind === 'scene' ? 'imageScene' : target.promptKind;
}
function validCreativeSource(p: PetStoryProject, prompt: PetStoryPrompt, target: PromptEligibilityTarget, source?: PetStoryChatJob): boolean {
  if (!source || !['optimize', 'materialPrompt', 'revise', 'repair'].includes(source.kind) || source.status !== 'applied' || source.resultStatus !== 'adopted') return false;
  if (!source.rawText || !source.parsedResult?.optimized || source.sourceStoryId !== p.mobileStory?.id) return false;
  if (prompt.rulesVersion !== source.rulesVersion) return false;
  if (!prompt.edited && source.parsedResult.optimized !== prompt.final) return false;
  if (source.expectedIds?.length !== 1 || source.expectedIds[0] !== targetId(target) || source.materialId !== target.materialId) return false;
  return !!target.materialId || source.shotId === target.shotId && source.promptKind === target.promptKind;
}
function validRuleContract(p: PetStoryProject, target: PromptEligibilityTarget, task?: PetStoryPromptTaskContract, source?: PetStoryChatJob): boolean {
  if (!source?.stage?.split('+').includes(requiredStage(p, target) || '') || !source.requestId || !source.requestText) return false;
  if (digestText(source.requestText) !== source.inputHash || !source.rulesVersion || !source.ruleFiles?.length || !source.promptTask) return false;
  return !!task && JSON.stringify(source.promptTask) === JSON.stringify(task);
}
function targetModel(p: PetStoryProject, target: PromptEligibilityTarget): string | undefined {
  return target.model || p.production?.capability?.videoConfig?.model || promptWritingTarget(p, target).model;
}
function modelTargetIssues(p: PetStoryProject, target: PromptEligibilityTarget, task: PetStoryPromptTaskContract, source?: PetStoryChatJob): string[] {
  if (target.promptKind !== 'video') return task.dialect === 'seedream' ? [] : ['图片正文尚未通过对应 Seedream 专用任务适配。'];
  const reasons: string[] = [];
  const model = targetModel(p, target);
  const dialect = promptModelDialect(model);
  if (!target.mode || task.mode !== target.mode) reasons.push('正文生成时的目标视频模式与实际模式不同，请通过 Chat 重新生成或修订。');
  if (dialect === 'generic') reasons.push('当前视频目标模型未知；通用正文仅为创作计划，确定实际模型后请通过豆包适配。');
  else if (task.dialect !== dialect) reasons.push('正文生成时的 Seedance 方言与本次目标模型不同，请按当前模型通过豆包重新生成或修订。');
  const dialectStage = dialect === 'seedance20' ? 'video20' : dialect === 'seedance25' ? 'video25' : undefined;
  if (dialectStage && !source?.stage?.split('+').includes(dialectStage)) reasons.push('本次目标模型的专用方言规则未用于原创作任务，请通过豆包适配。');
  return reasons;
}
function hasUnapprovedMaterials(p: PetStoryProject, target: PromptEligibilityTarget): boolean {
  const shot = p.plan?.shots.find((item): boolean => item.id === target.shotId);
  if (!shot || !p.materials) return false;
  const keys = [...shot.characterIds.map((id): string => `character:${id}`), ...(shot.propIds || []).map((id): string => `prop:${id}`), ...(shot.sceneId ? [`scene:${shot.sceneId}`] : [])];
  return keys.some((id): boolean => { const material = p.materials?.find((item): boolean => item.id === id); const asset = p.assets.find((item): boolean => item.id === material?.selectedAssetId); return !material?.approved || material.approved.assetId !== asset?.id || material.approved.sha256 !== asset?.validation?.sha256; });
}
function bindingEligibility(p: PetStoryProject, target: PromptEligibilityTarget, task?: PetStoryPromptTaskContract): PromptEligibility {
  const unbound = (target.currentReferences || task?.references)?.some((ref): boolean => ref.assetId.startsWith('pending:') || !p.assets.some((asset): boolean => asset.id === ref.assetId && !!asset.validation));
  const reasons: string[] = [];
  if (!isStoryApproved(p)) reasons.push('正文已采用，当前剧本尚未确认或确认已过期；请先核对并确认剧本，再提交媒体。');
  if (unbound || hasUnapprovedMaterials(p, target)) reasons.push('正文已采用，实际图片／素材确认或网页绑定待完成。');
  return { state: reasons.length ? 'adopted_unbound' : 'submittable', reasons, writingReady: true };
}
/** 手改复用采用前检查，避免导出、恢复与实际创建各自放过不同内容。 */
function editedContentIssues(p: PetStoryProject, prompt: PetStoryPrompt, source?: PetStoryChatJob): string[] {
  if (!prompt.edited || !source || source.parsedResult?.optimized === prompt.final) return [];
  return runtimePromptIssues(p, { ...source, promptTask: prompt.promptTask }, prompt.final);
}
/** 与请求选择一致的文字意图；显式generic始终覆盖此前页面或历史模型。 */
export function promptWritingTarget(p: PetStoryProject, target: PetStoryRuntimeTarget, suppliedCapability?: PetStoryCapability): PromptEligibilityTarget {
  const shot = p.plan?.shots.find((item): boolean => item.id === target.shotId);
  const capability = suppliedCapability || p.promptCapability || p.production?.capability || [...(p.productionHistory || [])].reverse().find((item): boolean => !!item.capability)?.capability;
  return { materialId: target.materialId, shotId: target.shotId, promptKind: target.promptKind,
    mode: shot?.requestedMode !== 'auto' ? shot?.requestedMode : p.production?.shots[target.shotId || '']?.resolvedMode,
    model: p.promptModel || capability?.videoConfig?.model || 'generic' };
}
function currentReferencePlan(p: PetStoryProject, prompt: PetStoryPrompt, target: PromptEligibilityTarget): PetStoryPromptReference[] {
  if (target.materialId) return materialPromptReferences(p, target.materialId, true, prompt);
  const shot = p.plan?.shots.find((item): boolean => item.id === target.shotId);
  if (!shot || !target.promptKind) throw new Error('当前正文目标不存在，请先恢复对应镜头。');
  return promptReferences(p, shot, target.promptKind, target.mode, true);
}
/** 复用只读计划编译核对当前素材，不把等到媒体提交时报错当作阶段已完成。 */
function currentReferenceValidation(p: PetStoryProject, prompt: PetStoryPrompt, target: PromptEligibilityTarget): { references?: PetStoryPromptReference[]; issues: string[] } {
  if (!prompt.promptTask) return { issues: [] };
  try {
    const references = currentReferencePlan(p, prompt, target);
    compileReferencedText(p, prompt.final, references, prompt.promptTask.references);
    return { references, issues: [] };
  } catch (error: unknown) { return { issues: [error instanceof Error ? error.message : '当前目标素材与正文引用计划无法对应，请通过豆包适配。'] }; }
}
function isPlanLimitation(reason: string): boolean { return reason.startsWith('当前视频目标模型未知') || reason.startsWith('正文生成时的目标视频模式'); }
function matchingWritingPlan(p: PetStoryProject, target: PromptEligibilityTarget, task: PetStoryPromptTaskContract | undefined, reasons: string[]): boolean {
  const model = targetModel(p, target);
  return target.promptKind === 'video' && !!task && task.mode === target.mode && task.dialect === promptModelDialect(model) && reasons.every(isPlanLimitation);
}
/** 收取时只核对输入事实；坏正文仍交内容校验处理，不能误标过期而跳过一次修订。 */
export function promptContractFactsCurrent(p: PetStoryProject, job: PetStoryChatJob): boolean {
  const task = job.promptTask; if (!task?.designHash) return false;
  const target = promptWritingTarget(p, job);
  const prompt = job.materialId ? p.materials?.find((item): boolean => item.id === job.materialId)?.prompt : p.plan?.shots.find((item): boolean => item.id === job.shotId)?.prompts[job.promptKind || 'video'];
  if (!prompt || task.designHash !== promptDesignHash(p, target)) return false;
  const modelIssues = modelTargetIssues(p, target, task, job);
  if (modelIssues.length && !matchingWritingPlan(p, target, task, modelIssues)) return false;
  try { plannedReferenceMap(task.references, currentReferencePlan(p, { ...prompt, editIntent: job.editIntent }, target)); return true; }
  catch { return false; }
}
/** 采用前在副本中检验同一原回复的当前资格，不改变源任务或用户final。 */
export function inspectPromptCandidate(p: PetStoryProject, job: PetStoryChatJob): PromptEligibility {
  const prompt = job.materialId ? p.materials?.find((item): boolean => item.id === job.materialId)?.prompt : p.plan?.shots.find((item): boolean => item.id === job.shotId)?.prompts[job.promptKind || 'video'];
  const body = job.parsedResult?.optimized;
  if (!prompt || !body) return { state: 'needs_revision', reasons: ['候选缺少对应目标或完整原回复正文。'], writingReady: false };
  const snapshot = { ...p, jobs: p.jobs.map((item): PetStoryChatJob => item.id === job.id ? { ...item, status: 'applied', resultStatus: 'adopted' } : item) };
  return inspectPromptEligibility(snapshot, { ...prompt, final: body, optimized: body, edited: false, sourceJobId: job.id, candidateJobId: job.id,
    rulesVersion: job.rulesVersion || prompt.rulesVersion, promptTask: job.promptTask, editIntent: job.editIntent, needsReview: undefined }, promptWritingTarget(p, job));
}
/** 可读计划和本次媒体资格分开；任何入口都不能靠 edited 或缺字段跳过合同。 */
export function inspectPromptEligibility(p: PetStoryProject, prompt: PetStoryPrompt, target: PromptEligibilityTarget): PromptEligibility {
  if (!prompt.final?.trim()) return { state: 'creative_plan', reasons: ['镜头已设计，正式正文待通过专用豆包 Chat 生成。'], writingReady: false };
  const reasons: string[] = [];
  const task = prompt.promptTask;
  const source = creativeSource(p, prompt);
  if (!task) reasons.push('保留正文缺少专用目标合同，请按当前模型／模式通过豆包重新生成或修订。');
  if (!validCreativeSource(p, prompt, target, source)) reasons.push('当前正文缺少本目标已采用的专用豆包 Chat 创作来源；旧分析稿和未采用候选不能投产。');
  if (!validRuleContract(p, target, task, source)) reasons.push('正文来源未核对本次专用规则阶段和目标合同，请通过豆包重新生成或修订。');
  if (task && (!task.designHash || task.designHash !== promptDesignHash(p, target))) reasons.push('剧本、镜头设计或已采用帧／前镜边界与正文创作时不一致，请通过豆包重新生成或修订。');
  if (prompt.needsReview) reasons.push('当前采用正文仍待复核；新候选尚未采用时下游继续读取旧正文。');
  if (task) reasons.push(...modelTargetIssues(p, target, task, source));
  reasons.push(...editedContentIssues(p, prompt, source));
  const references = currentReferenceValidation(p, prompt, target); reasons.push(...references.issues);
  if (!reasons.length) return bindingEligibility(p, { ...target, currentReferences: target.currentReferences || references.references }, task);
  const writingPlan = matchingWritingPlan(p, target, task, reasons);
  return { state: writingPlan ? 'creative_plan' : 'needs_revision', reasons, writingReady: writingPlan };
}
function digestText(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function requirePromptEligibility(p: PetStoryProject, prompt: PetStoryPrompt, target: PromptEligibilityTarget): void {
  const result = inspectPromptEligibility(p, prompt, target);
  if (result.state === 'creative_plan' || result.state === 'needs_revision') throw new Error(result.reasons.join('；'));
}
