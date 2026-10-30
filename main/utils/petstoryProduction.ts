import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DownloadJob, PetStoryAsset, PetStoryCapability, PetStoryExecutionGuard, PetStoryPlan, PetStoryProductionCounts, PetStoryProductionResult, PetStoryProductionStep, PetStoryProject, Task, TaskAddParams, TaskDownloadOutputsParams, TaskDownloadOutputsResult, PetStoryCompiledPrompt, PetStoryPromptKind, PetStoryShot, PetStoryShotMedia } from '@doubao-studio/contracts';
import { PetStoryProjects, projectPath } from './petstoryProject';
import { compilePrompt, compileMaterialPrompt, checkPromptReferences, assetCharacterIds } from './petstoryPromptQuality';
import { bindReferenceText } from './petstoryReferenceText';
import { approvedMaterialHash, materialAsset, requireApprovedMaterials, requireMaterialInventory, requireMaterialPromptSource, requiredMaterialKeys } from './petstoryMaterials';
import type { PetStoryPageBinding, PetStoryRuntimeTarget, PetStoryGenerationBlocker, PetStoryGenerationEligibilityResult, PetStoryModeResolution } from '@doubao-studio/contracts';
import { finalTaskInput } from './petstoryChat';
import { validatePetStoryPlan } from './petstoryValidation';
import { resolvePetStoryMode } from './petstoryModes';
import { productionCapability } from './petstoryCapability';
import { extractActualEndFrame, mediaDigest, validatePetStoryMedia } from './petstoryMedia';
import { requirePromptEligibility, promptWritingTarget } from './petstoryEligibility';
import { pendingChatConflicts } from './petstoryPending';
import { imageTargetBasis, isPetStoryImageAdopted, selectedShotImageId } from './petstoryImageReview';

/** 页面绑定属于本次上传文件与当前编译片段，不接受导出文本作为绑定证据。 */
function validatePageBinding(p: PetStoryProject, step: PetStoryProductionStep, b: PetStoryPageBinding, index: number): void {
  const ref = step.compiledPrompt?.references[index];
  // 附件未在正文显式引用时不凭空补 @；仍核对该文件预览、素材目标和零节点证据。
  const noTextReference = !!step.compiledPrompt?.segments
    && !step.compiledPrompt.segments.some((segment): boolean => 'referenceOrder' in segment && segment.referenceOrder === b.order)
    && b.occurrenceCount === 0 && b.nodeIds?.length === 0;
      const slot = ref?.slot === 'first' ? 'first_frame' : ref?.slot === 'last' ? 'last_frame' : 'reference';
      if (!/^(?:@图片[0-9]+|第 [0-9]+ 张图)$/.test(b.label) || (b.nodeId !== undefined && !/^[a-zA-Z0-9_:.=-]{1,160}$/.test(b.nodeId)) || b.assetId !== step.attachmentAssetIds[index] || b.order !== index + 1 || b.slot !== slot || !/^[a-f0-9]{64}$/.test(b.previewHash)
        || !['plain', 'mention', 'slot'].includes(b.reference) || b.label.length > 40 || (b.reference === 'mention' && !b.nodeId && !noTextReference)) throw new Error('页面素材／槽位／引用节点映射不符');
  validateBindingEvidence(p, step, b, slot);

}

function validateBindingEvidence(p: PetStoryProject, step: PetStoryProductionStep, b: PetStoryPageBinding, slot: PetStoryPageBinding['slot']): void {
      const source = step.compiledPrompt;
      if (source?.segments) {
        const asset = p.assets.find((a): boolean => a.id === b.assetId);
        if (!asset?.validation || b.fileSha256 !== asset.validation.sha256 || !/^[a-f0-9]{64}$/.test(b.fileSha256)) throw new Error('本次真实上传文件摘要与确认素材不符');
        if ((slot === 'reference') === (b.reference === 'slot')) throw new Error('普通引用和首尾槽位不能互换');
        if (b.reference === 'mention' && (!b.targetId || !/^[a-zA-Z0-9_:.=-]{1,160}$/.test(b.targetId) || !b.nodeIds || b.nodeIds.some((id): boolean => !/^[a-zA-Z0-9_:.=-]{1,160}$/.test(id))
          || b.occurrenceCount !== source.segments.filter((s): boolean => 'referenceOrder' in s && s.referenceOrder === b.order).length || b.nodeIds.length !== b.occurrenceCount)) throw new Error('每次原生引用的节点／素材目标证据不全');
      }}

type GenerationAdd = (code: PetStoryGenerationBlocker['code'], message: string, location?: Partial<PetStoryRuntimeTarget>) => void;
type GenerationCheck = (code: PetStoryGenerationBlocker['code'], work: () => void | Promise<unknown>, location?: Partial<PetStoryRuntimeTarget>) => Promise<boolean>;

interface ProductionPort {
  bindPageInput?: (taskId: string, runId: string, prompt: string) => Task;
  list: () => Task[];
  create: (params: TaskAddParams, accountId: string) => Task;
  adopt: (taskId: string, binding: NonNullable<Task['petstory']>, compiledPrompt?: string) => Task;
  retryUnsubmitted: (taskId: string) => Task;
  downloads: () => DownloadJob[];
  download: (params: TaskDownloadOutputsParams) => Promise<TaskDownloadOutputsResult>;
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requireValue<T>(value: T | undefined, message = '原制作引用缺失'): T { if (value === undefined) throw new Error(message); return value; }
function safePreparationFailure(code: string): boolean {
  return ['cancelled', 'chat_assets_not_ready', 'page_unrecognized', 'page_loading', 'authentication_unconfirmed', 'petstory_controls_unconfirmed',
    'quota_exhausted', 'membership_required', 'login_required', 'verification', 'verification_required', 'verification_detected'].includes(code)
    || /^video_(?:[a-z_]+)_not_ready$/.test(code);
}
export function productionPlanHash(plan: PetStoryPlan): string {
  return hash({ ...plan, characters: plan.characters.map((c): object => ({ ...c, referenceAssetId: undefined })) });
}
export function productionCounts(p: PetStoryProject, capability: PetStoryCapability, fallbacks: Record<string, 'first_frame' | 'reference'>): PetStoryProductionCounts {
  const plan = validatePetStoryPlan(p.plan);
  const required = new Set(plan.shots.flatMap((s): string[] => s.characterIds));
  const supporting = plan.characters.filter((c): boolean => c.role === 'supporting' && required.has(c.id));
  const modes = plan.shots.map((s): string => resolvePetStoryMode(s, capability, fallbacks[s.id]).resolvedMode);
  return { shots: plan.shots.length, supporting: supporting.length, newCharacters: supporting.filter((c): boolean => !c.referenceAssetId).length,
    firstFrames: plan.shots.filter((s): boolean => (!!p.materials || s.transition === 'cut') && !p.production?.shots[s.id]?.firstFrameId).length,
    lastFrames: modes.filter((m, i): boolean => m === 'first_last_frame' && !p.production?.shots[plan.shots[i].id]?.plannedEndImageId).length,
    videos: plan.shots.filter((s): boolean => !p.production?.shots[s.id]?.videoId).length };
}
export function checkProductionReferences(final: string, p: PetStoryProject, assetIds: string[]): void {
  checkPromptReferences(final, p, assetIds.map((id, index) => {
    const a = requireValue(p.assets.find((asset): boolean => asset.id === id), '引用素材缺失');
    return { assetId: id, materialId: a.materialId || p.materials?.find((m): boolean => m.selectedAssetId === a.id)?.id, order: index + 1, characterIds: assetCharacterIds(a),
      purpose: a.kind === 'character' ? 'identity' : a.kind === 'video' ? 'scene' : a.kind };
  }));
}
function productionStepTarget(step?: Pick<PetStoryProductionStep, 'materialId' | 'shotId' | 'kind'>): PetStoryRuntimeTarget | undefined {
  if (!step) return undefined;
  return { materialId: step.materialId, shotId: step.shotId, promptKind: ['firstFrame', 'lastFrame', 'video'].includes(step.kind) ? step.kind as PetStoryPromptKind : undefined };
}
function productionResumeTarget(production: NonNullable<PetStoryProject['production']>, pending?: PetStoryProductionStep): PetStoryRuntimeTarget | undefined { return production.target || productionStepTarget(pending); }
function productionShotScope(production: NonNullable<PetStoryProject['production']>): string[] | undefined { return production.target ? [production.target.shotId] : undefined; }
function checkPlannedReferences(p: PetStoryProject, capability: PetStoryCapability, fallbacks: Record<string, 'first_frame' | 'reference'>): void {
  for (const shot of requireValue(p.plan).shots) {
    const mode = resolvePetStoryMode(shot, capability, fallbacks[shot.id]).resolvedMode;
    if (shot.transition === 'cut' || p.materials) { requirePromptEligibility(p, shot.prompts.firstFrame, { shotId: shot.id, promptKind: 'firstFrame' }); compilePrompt(p, shot.id, 'firstFrame', undefined, true); }
    if (mode === 'first_last_frame') { requirePromptEligibility(p, requireValue(shot.prompts.lastFrame, '本镜尾帧正文待生成'), { shotId: shot.id, promptKind: 'lastFrame' }); compilePrompt(p, shot.id, 'lastFrame', undefined, true); }
    requirePromptEligibility(p, shot.prompts.video, { shotId: shot.id, promptKind: 'video', mode, model: capability.videoConfig?.model });
    compilePrompt(p, shot.id, 'video', mode, true);
  }
}
/** 线性业务接力。只准备原 TaskService 的单个 hold 任务，发送仍由原队列和 BrowserPanel 完成。 */
export class PetStoryProductionService {
  private readonly authorized = new Set<string>();
  private readonly validated = new Map<string, string>();
  suspend(id: string): void { this.authorized.delete(id); }
  constructor(private readonly projects: PetStoryProjects, private readonly tasks: ProductionPort) {}

  /** 只读复用正式生产校验；不写项目、不创建任务，也不提取连续镜头末帧。 */
  async inspectGeneration(id: string, revision: number, target: PetStoryRuntimeTarget, capability?: PetStoryCapability, fallbacks: Record<string, 'first_frame' | 'reference'> = {}): Promise<PetStoryGenerationEligibilityResult> {
    const p = await this.projects.read(id);
    if (p.revision !== revision) throw new Error('项目已变化，请刷新当前操作的前置条件');
    if (!target || !!target.materialId === !!target.shotId || target.shotId && !['firstFrame', 'lastFrame', 'video'].includes(target.promptKind || '')) throw new Error('请选择当前项目的具体素材或镜头节点');
    const blockers: PetStoryGenerationBlocker[] = [];
    const add = (code: PetStoryGenerationBlocker['code'], message: string, location: Partial<PetStoryRuntimeTarget> = target): void => {
      if (!blockers.some((item): boolean => item.code === code && item.message === message)) blockers.push({ code, message, materialId: location.materialId, shotId: location.shotId, promptKind: location.promptKind });
    };
    const check = async (code: PetStoryGenerationBlocker['code'], work: () => void | Promise<unknown>, location?: Partial<PetStoryRuntimeTarget>): Promise<boolean> => {
      try { await work(); return true; }
      catch (error: unknown) { add(code, error instanceof Error ? error.message : '当前条件无法确认', location); return false; }
    };
    const pending = pendingChatConflicts(p, target);
    for (const job of pending) blockers.push({ code: 'task', message: '本目标或其依赖仍在等待原豆包回复，请检查原回复或明确结束等待；不会重复发送。', jobId: job.id, materialId: job.materialId, shotId: job.shotId, promptKind: job.promptKind });
    if (p.production && p.production.state !== 'complete') add('task', '已有制作任务尚未结束，请先查看并处理当前任务。');
    capability = productionCapability(p, capability);
    await check('story', (): void => requireMaterialInventory(p));
    const resolution = target.materialId
      ? await this.inspectMaterialGeneration(p, target.materialId, check)
      : await this.inspectShotGeneration(p, target, capability, fallbacks, check, add);
    if ((await this.projects.read(id)).revision !== p.revision) throw new Error('检查期间项目已变化，请刷新当前操作的前置条件');
    return { success: true, eligibility: { ready: !blockers.length, blockers, resolvedMode: resolution?.resolvedMode, modeReason: resolution?.reason } };
  }
  private async inspectMaterialGeneration(p: PetStoryProject, materialId: string, check: GenerationCheck): Promise<undefined> {
    if (!p.materials?.some((item): boolean => item.id === materialId)) throw new Error('基础素材不属于当前项目');
    const validPrompt = await check('prompt', (): void => { requireMaterialPromptSource(p, materialId); });
    if (validPrompt) await check('materials', async (): Promise<void> => {
      const compiled = this.compileMaterial(p, materialId);
      await Promise.all(compiled.references.map((ref): Promise<string> => this.assetFile(p, ref.assetId, 'image')));
    });
    return undefined;
  }
  private async inspectShotGeneration(p: PetStoryProject, target: PetStoryRuntimeTarget, capability: PetStoryCapability | undefined, fallbacks: Record<string, 'first_frame' | 'reference'>, check: GenerationCheck, add: GenerationAdd): Promise<PetStoryModeResolution | undefined> {
    let resolution: PetStoryModeResolution | undefined;
    const shot = p.plan?.shots.find((item): boolean => item.id === target.shotId);
    if (!shot) throw new Error('镜头节点不属于当前方案');
    const kind = requireValue(target.promptKind, '请选择镜头节点');
    const prompt = shot.prompts[kind];
    const approved = await check('materials', (): Promise<void> => this.checkApprovedFiles(p, [shot.id]));
    if (!approved && p.plan) {
      for (const key of requiredMaterialKeys(p.plan, [shot.id])) await check('materials', (): void => { materialAsset(p, key); }, { materialId: key });
    }
    const media = this.shotMedia(p)[shot.id];
    if (kind !== 'firstFrame' && !media.firstFrameId) add('firstFrame', '请先制作并完成本镜首帧。', { shotId: shot.id, promptKind: 'firstFrame' });
    if (kind === 'video' && capability) {
      await check('capability', (): void => { resolution = resolvePetStoryMode(shot, capability, fallbacks[shot.id]); });
      if (resolution?.resolvedMode === 'first_last_frame' && !media.plannedEndImageId) add('lastFrame', '本镜使用首尾帧模式，请先制作本镜尾帧。', { shotId: shot.id, promptKind: 'lastFrame' });
    }
    const mode = kind === 'video' ? resolution?.resolvedMode || promptWritingTarget(p, target).mode : undefined;
    const promptValid = await check('prompt', (): void => {
      if (!prompt?.final.trim()) throw new Error('本节点尚无当前使用的提示词，请先生成并采用。');
      requirePromptEligibility(p, prompt, { shotId: shot.id, promptKind: kind, mode, model: capability?.videoConfig?.model });
    });
    const needsActualEnd = kind === 'firstFrame' && shot.transition === 'continue' && !media.actualEndFrameId && prompt?.promptTask?.references.some((ref): boolean => ref.purpose === 'actualEndFrame');
    if (needsActualEnd) {
      // 实际提取只在用户授权生成后发生；查询仅验证正式提取将读取的前镜真实视频。
      const previous = this.shotMedia(p)[shot.previousShotId || ''];
      await check('firstFrame', async (): Promise<void> => { await this.assetFile(p, requireValue(previous?.videoId, '连续镜头需要前镜实际视频，请先完成前镜视频。'), 'video'); }, { shotId: shot.previousShotId, promptKind: 'video' });
    } else if (promptValid && approved && (kind !== 'video' || resolution)) await check('prompt', async (): Promise<void> => {
      const snapshot = this.generationSnapshot(p, capability, fallbacks);
      const compiled = compilePrompt(snapshot, shot.id, kind, mode);
      await Promise.all(compiled.references.map((ref): Promise<string> => this.assetFile(snapshot, ref.assetId, 'image')));
    });
    return resolution;
  }
  /** 仅供只读编译；使用本次入口与同一媒体投影，不沿用历史模型，也不写入授权。 */
  private generationSnapshot(p: PetStoryProject, capability: PetStoryCapability | undefined, fallbacks: Record<string, 'first_frame' | 'reference'>): PetStoryProject {
    const snapshot = structuredClone(p);
    const shots = this.shotMedia(p);
    if (capability) snapshot.production = { phase: 'shots', state: 'running', planHash: productionPlanHash(requireValue(p.plan)), approvedAt: p.updatedAt, capability, fallbacks, shots, steps: [], message: '只读生成条件检查' };
    else if (snapshot.production) snapshot.production.shots = shots;
    return snapshot;
  }
  /** 读取当前与历史所选媒体的规则与正式单节点创建保持一致。 */
  private shotMedia(p: PetStoryProject): Record<string, PetStoryShotMedia> {
    return Object.fromEntries((p.plan?.shots || []).map((shot): [string, PetStoryShotMedia] => {
      const prior = [p.production, ...(p.productionHistory || []).slice().reverse()].find((run): boolean => !!run?.shots[shot.id])?.shots[shot.id];
      const latest = (kind: PetStoryAsset['kind']): string | undefined => [...p.assets].reverse().find((asset): boolean => asset.shotId === shot.id && asset.kind === kind)?.id;
      return [shot.id, { requestedMode: shot.requestedMode, resolvedMode: prior?.resolvedMode || (shot.requestedMode === 'auto' ? 'reference' : shot.requestedMode), reason: prior?.reason || '仅图片节点授权，视频实际模式尚未确认', firstFrameId: selectedShotImageId(p, shot.id, 'firstFrame'), plannedEndImageId: selectedShotImageId(p, shot.id, 'lastFrame'), videoId: prior?.videoId || latest('video'), actualEndFrameId: prior?.actualEndFrameId, startFromPreviousEnd: prior?.startFromPreviousEnd }];
    }));
  }
  async preview(id: string, capability: PetStoryCapability | undefined = undefined, fallbacks: Record<string, 'first_frame' | 'reference'> = {}): Promise<PetStoryProductionResult> {
    const p = await this.projects.read(id);
    capability = productionCapability(p, capability);
    this.validateRequestContext(p, capability);
    checkPlannedReferences(p, capability, fallbacks);
    return { success: true, project: p, counts: productionCounts(p, capability, fallbacks), resolutions: Object.fromEntries(requireValue(p.plan).shots.map((shot): [string, ReturnType<typeof resolvePetStoryMode>] => [shot.id, resolvePetStoryMode(shot, capability, fallbacks[shot.id])])) };
  }
  private validateRequestContext(p: PetStoryProject, c: PetStoryCapability, target?: PetStoryRuntimeTarget): void {
    if (pendingChatConflicts(p, target).length) throw new Error('本目标或其依赖仍有未收取的普通 Chat 原任务；请只读收取或明确结束等待，不自动重发');
    if (c.accountId !== p.accountId) throw new Error('生成参数与项目原账号不符');
  }
  async approve(id: string, revision: number, capability: PetStoryCapability | undefined = undefined, fallbacks: Record<string, 'first_frame' | 'reference'> = {}): Promise<PetStoryProductionResult> {
    let p = await this.projects.read(id);
    capability = productionCapability(p, capability);
    if (p.revision !== revision) throw new Error('项目版本已变化，请重新确认制作计划');
    if (p.production?.phase === 'materials' && p.production.state === 'complete') { p.productionHistory = [...(p.productionHistory || []), p.production]; p.production = undefined; }
    if (p.production) throw new Error('制作计划已确认，请继续原制作，不重复创建');
    if (!p.plan || !p.mobileStory || p.source.status !== 'review_required') throw new Error('请先保存有效的 P2/P3 制作方案');
    this.validateRequestContext(p, capability);
    await this.checkApprovedFiles(p);
    const counts = productionCounts(p, capability, fallbacks);
    checkPlannedReferences(p, capability, fallbacks);
    for (const char of p.plan.characters.filter((c): boolean => c.role === 'main' && (p.plan?.shots || []).some((s): boolean => s.characterIds.includes(c.id)))) {
      if (!char.referenceAssetId) throw new Error(`${char.name}必须使用本人确认的参考图`);
      await this.assetFile(p, char.referenceAssetId, 'image');
    }
    const usedCharacters = new Set(p.plan.shots.flatMap((s): string[] => s.characterIds));
    for (const char of p.plan.characters.filter((c): boolean => usedCharacters.has(c.id) && !!c.referenceAssetId)) await this.assetFile(p, requireValue(char.referenceAssetId), 'image');
    for (const shot of p.plan.shots) for (const assetId of shot.sceneReferenceAssetIds || []) await this.assetFile(p, assetId, 'image');
    p.production = { phase: 'shots', materialHash: approvedMaterialHash(p), state: 'running', planHash: productionPlanHash(p.plan), approvedAt: new Date().toISOString(), capability, fallbacks,
      shots: Object.fromEntries(p.plan.shots.map((s): [string, ReturnType<typeof resolvePetStoryMode>] => [s.id, resolvePetStoryMode(s, capability, fallbacks[s.id])])), steps: [], message: '计划已确认，准备顺序制作' };
    p = await this.projects.write(p);
    this.authorized.add(id);
    return { success: true, project: p, counts };
  }
  /** 每次只授权点击的媒体节点；缺少前置素材直接停止，不暗中补生成。 */
  async generateShotMedia(id: string, revision: number, shotId: string, kind: PetStoryPromptKind, capability: PetStoryCapability | undefined = undefined, fallbacks: Record<string, 'first_frame' | 'reference'> = {}): Promise<PetStoryProductionResult> {
    let p = await this.projects.read(id);
    capability = productionCapability(p, capability);
    if (p.revision !== revision) throw new Error('项目版本已变化，请重新查看节点');
    if (!['firstFrame', 'lastFrame', 'video'].includes(kind)) throw new Error('媒体节点类型无效');
    const shot = p.plan?.shots.find((s): boolean => s.id === shotId);
    if (!shot || !shot.prompts[kind]?.final.trim()) throw new Error('镜头或最终提示词不存在');
    if (p.production && p.production.state !== 'complete') throw new Error('请先处理原制作任务，不重复创建节点任务');
    this.validateRequestContext(p, capability, { shotId, promptKind: kind });
    await this.checkApprovedFiles(p, [shotId]);
    // 图片节点不要求先确认尚未使用的视频入口；这里的模式仅留作未授权占位。
    const shots = this.shotMedia(p);
    const media = shots[shotId];
    if (kind === 'firstFrame' && shot.transition === 'continue' && !media.actualEndFrameId && shot.prompts.firstFrame.promptTask?.references.some((ref): boolean => ref.purpose === 'actualEndFrame')) {
      requirePromptEligibility(p, shot.prompts.firstFrame, { shotId, promptKind: kind });
      await this.prepareContinuationFrame(p, shot, shots);
    }
    if (kind !== 'firstFrame' && !media.firstFrameId) throw new Error('请先明确点击生成并完成本镜首帧；本操作不会自动生成图片');
    if (kind === 'video') {
      Object.assign(media, resolvePetStoryMode(shot, capability, fallbacks[shot.id]));
      if (media.resolvedMode === 'first_last_frame' && !media.plannedEndImageId) throw new Error('原生首尾帧视频需要实际首帧和尾帧；请先分别生成图片');
    }
    if (p.production) p.productionHistory = [...(p.productionHistory || []), p.production];
    p.production = { phase: 'shots', target: { shotId, kind }, materialHash: approvedMaterialHash(p, [shotId]), state: 'running', planHash: productionPlanHash(requireValue(p.plan)), approvedAt: new Date().toISOString(), capability, fallbacks, shots, steps: [], message: `仅授权 ${shot.order} 镜 ${kind}，完成后停止` };
    // 用原编译器核对本项前置与 final，在任何任务创建前失败即停止。
    const compiled = compilePrompt(p, shotId, kind, kind === 'video' ? media.resolvedMode : undefined);
    await Promise.all(compiled.references.map((r): Promise<string> => this.assetFile(p, r.assetId, 'image')));
    p = await this.projects.write(p); this.authorized.add(id);
    return { success: true, project: p };
  }
  async pause(id: string, message = '用户已暂停；点击继续后沿用原任务'): Promise<PetStoryProductionResult> {
    this.authorized.delete(id);
    const p = await this.projects.read(id);
    if (!p.production) throw new Error('尚未确认制作方案');
    p.production.state = 'paused'; p.production.message = message;
    return { success: true, project: await this.projects.write(p), taskId: p.production.steps.find((s): boolean => s.status !== 'complete')?.taskId };
  }
  async resume(id: string, capability?: PetStoryCapability): Promise<PetStoryProductionResult> {
    const p = await this.projects.read(id);
    capability = productionCapability(p, capability);
    if (!p.production || !p.plan || productionPlanHash(p.plan) !== p.production.planHash) throw new Error('原制作计划不存在或已经改变');
    const pending = p.production.steps.find((s): boolean => s.status !== 'complete');
    const pendingTask = pending?.taskId ? this.originalTask(p, pending) : undefined;
    const readOnly = pendingTask?.status === 'done' || !!pendingTask?.runtime?.submittedAt;
    if (!readOnly) {
      this.validateRequestContext(p, capability, productionResumeTarget(p.production, pending));
      // 继续原批次保留已选模式；真实控件支持在该任务执行时回读，不从未知状态重新推测。
    } else if (capability?.accountId !== p.accountId) throw new Error('原账号不符，禁止切换账号');
    if (pending?.taskId) {
      const task = this.originalTask(p, pending);
      if (!task.runtime?.submittedAt && !['queued', 'executing', 'generating', 'done'].includes(task.status)) {
        if (!safePreparationFailure(task.errorInfo?.code || '')
          || task.runtime?.acceptanceObservation || task.outputs.length) throw new Error('原任务未确认可安全恢复，仅保留原任务核对，不重发');
        const source = this.resetPageBindingForRetry(p, pending);
        pending.runId = undefined;
        const held = await this.projects.write(p);
        this.tasks.retryUnsubmitted(task.id);
        this.resetTaskPageInput(task, source);
        return this.resume(held.id, capability);
      }
    }
    p.production.capability = capability; p.production.state = 'running'; p.production.message = '继续原任务与素材，未授权重复发送';
    const saved = await this.projects.write(p);
    this.authorized.add(id);
    return { success: true, project: saved };
  }
  private resetPageBindingForRetry(p: PetStoryProject, pending: PetStoryProductionStep): PetStoryCompiledPrompt | undefined {
    if (!pending.pageBindings) return undefined;
    const source = pending.materialId ? this.compileMaterial(p, pending.materialId)
      : compilePrompt(p, requireValue(pending.shotId), pending.kind as 'firstFrame' | 'lastFrame' | 'video', pending.kind === 'video' ? this.checked(p).shots[requireValue(pending.shotId)].resolvedMode : undefined);
    if (pending.compiledPrompt) pending.pageBindingHistory = [...(pending.pageBindingHistory || []), { runId: pending.runId, compiledPrompt: pending.compiledPrompt, bindings: pending.pageBindings }];
    pending.pageBindings = undefined; pending.compiledPrompt = source; pending.inputHash = hash(source.text);
    return source;
  }
  private resetTaskPageInput(task: Task, source?: PetStoryCompiledPrompt): void {
    if (!source) return;
    if (!this.tasks.bindPageInput || !task.runtime) throw new Error('原任务引用重置入口不可用');
    this.tasks.bindPageInput(task.id, task.runtime.runId, source.text);
  }
  private checked(p: PetStoryProject): NonNullable<PetStoryProject['production']> {
    if (!p.production || !p.plan || p.production.planHash !== productionPlanHash(p.plan)) throw new Error('制作计划与原确认不一致');
    const currentHash = approvedMaterialHash(p, productionShotScope(p.production));
    // 旧单节点批次保存过全清单摘要；仅在旧摘要本身仍完全匹配时沿用，绝不伪造迁移。
    const matchesLegacyTarget = !!p.production.target && p.production.materialHash === approvedMaterialHash(p);
    if (p.production.phase === 'shots' && p.production.materialHash !== currentHash && !matchesLegacyTarget) throw new Error('基础素材确认绑定已变化，保留原成果，不能沿用旧制作授权');
    return p.production;
  }
  private async checkApprovedFiles(p: PetStoryProject, shotIds?: string[]): Promise<void> {
    requireApprovedMaterials(p, shotIds);
    const keys = requiredMaterialKeys(requireValue(p.plan), shotIds);
    for (const material of (p.materials || []).filter((item): boolean => keys.has(item.id))) {
      const asset = materialAsset(p, material.id);
      await this.assetFile(p, asset.id, 'image');
      if (asset.validation?.sha256 !== material.approved?.sha256) throw new Error('确认图片内容已变化，未授权镜头生成');
    }
  }
  /** 单节点与整批共用真实视频末帧提取；计划尾帧永不替代实际前镜结果。 */
  private async prepareContinuationFrame(p: PetStoryProject, shot: PetStoryShot, shots: Record<string, PetStoryShotMedia>): Promise<void> {
    const media = requireValue(shots[shot.id]);
    const previous = shots[requireValue(shot.previousShotId)];
    const video = p.assets.find((asset): boolean => asset.id === previous?.videoId && asset.kind === 'video' && asset.shotId === shot.previousShotId);
    if (!video?.taskId || !video.runId) throw new Error('本镜连续首帧依赖前镜实际视频／末帧；请先完成或选择前镜实际视频，再制作本镜，不能使用计划尾帧');
    if (video.needsReview) throw new Error('前镜素材已替换，请先复核前镜视频，再制作连续镜头');
    const source = await this.assetFile(p, video.id, 'video');
    const frameId = randomUUID();
    const relativePath = `shots/${shot.id}/${frameId}.png`;
    const extracted = await extractActualEndFrame(source, await projectPath(this.projects.directory(p.id), relativePath));
    const sourceVideo = { assetId: video.id, taskId: video.taskId, runId: video.runId, sha256: requireValue(video.validation).sha256, atSeconds: extracted.atSeconds };
    p.assets.push({ id: frameId, kind: 'actualEndFrame', shotId: shot.id, relativePath, validation: extracted.validation, sourceVideo });
    media.actualEndFrameId = frameId; media.startFromPreviousEnd = sourceVideo;
    if (!p.materials) media.firstFrameId = frameId;
  }
  async generateMaterials(id: string, revision: number, materialIds: string[], capability?: PetStoryCapability): Promise<PetStoryProductionResult> {
    const p = await this.projects.read(id);
    capability = productionCapability(p, capability);
    if (revision !== p.revision) throw new Error('项目版本变化，请重新查看素材');
    requireMaterialInventory(p);
    for (const materialId of materialIds) this.validateRequestContext(p, capability, { materialId });
    if (!Array.isArray(materialIds) || !materialIds.length || new Set(materialIds).size !== materialIds.length || materialIds.some((id): boolean => !p.materials?.some((m): boolean => m.id === id))) throw new Error('请选择本项目的基础素材');
    for (const materialId of materialIds) requireMaterialPromptSource(p, materialId);
    if (p.production) {
      if (p.production.state !== 'complete') throw new Error('请先继续原制作或处理未结束任务，不能重复生成');
      p.productionHistory = [...(p.productionHistory || []), p.production];
    }
    const ordered: string[] = [];
    const append = (id: string): void => {
      if (ordered.includes(id)) return;
      const parent = p.plan?.scenes?.find((s): boolean => `scene:${s.id}` === id)?.parentSceneId;
      if (parent && materialIds.includes(`scene:${parent}`)) append(`scene:${parent}`);
      ordered.push(id);
    };
    materialIds.forEach(append);
    p.production = { phase: 'materials', materialIds: ordered, state: 'running', planHash: productionPlanHash(requireValue(p.plan)), approvedAt: new Date().toISOString(), capability, fallbacks: {}, shots: {}, steps: [], message: '基础图已单独授权，下载后仍需用户接受图片' };
    const saved = await this.projects.write(p); this.authorized.add(id);
    return { success: true, project: saved };
  }
  private compileMaterial(p: PetStoryProject, materialId: string): PetStoryCompiledPrompt {
    return compileMaterialPrompt(p, materialId);
  }
  async recordPageBindings(id: string, taskId: string, runId: string, bindings: PetStoryPageBinding[]): Promise<PetStoryProductionResult> {
    const p = await this.projects.read(id); const production = this.checked(p);
    const step = production.steps.find((s): boolean => s.taskId === taskId && s.runId === runId && s.status === 'bound');
    if (!step || !Array.isArray(bindings) || bindings.length !== step.attachmentAssetIds.length) throw new Error('页面引用清单与本次运行不符');
    if (new Set(bindings.map((b): string => `${b.slot}:${b.previewHash}`)).size !== bindings.length || new Set(bindings.map((b): string => `${b.slot}:${b.label}`)).size !== bindings.length) throw new Error('多个文件指向同一页面素材或编号，禁止错绑');
    const targets = bindings.flatMap((b): string[] => b.slot === 'reference' && b.targetId ? [b.targetId] : []);
    if (new Set(targets).size !== targets.length) throw new Error('不同文件不能引用同一平台素材目标');
    const task = this.originalTask(p, step);
    if (task.runtime?.submittedAt) throw new Error('已提交的网页绑定快照不可改写');
    bindings.forEach((binding, index): void => validatePageBinding(p, step, binding, index));
    if (step.pageBindings) throw new Error('本次网页绑定已经固定，不能重复改写');
    const source = requireValue(step.compiledPrompt, '原编译输入缺失');
    const compiled = bindReferenceText(source, bindings);
    if (!this.tasks.bindPageInput) throw new Error('原任务实际引用保存入口不可用');
    step.pageBindings = bindings; step.compiledPrompt = compiled; step.inputHash = hash(compiled.text);
    const saved = await this.projects.write(p);
    const bound = this.tasks.bindPageInput(taskId, runId, compiled.text);
    if (bound.prompt !== compiled.text || bound.runtime?.input.prompt !== compiled.text) throw new Error('网页引用保存回读不一致，零提交');
    return { success: true, project: saved, compiledPrompt: compiled };
  }
  async assetFile(p: PetStoryProject, id: string, kind: 'image' | 'video'): Promise<string> {
    const asset = p.assets.find((a): boolean => a.id === id);
    if (!asset || (kind === 'video' ? asset.kind !== 'video' : asset.kind === 'video')) throw new Error('素材未登记或类别不符');
    if (kind === 'image' && !isPetStoryImageAdopted(p, asset)) throw new Error('这张图片尚未采用或需要复核，请先预览确认');
    if (kind === 'video') {
      const step = [p.production, ...(p.productionHistory || [])].flatMap((r): PetStoryProductionStep[] => r?.steps || []).find((s): boolean => s.kind === 'video' && s.assetId === asset.id && s.status === 'complete');
      const task = step ? this.originalTask(p, step) : undefined;
      const artifact = task?.artifacts?.find((a): boolean => a.id === asset.artifactId && a.runId === asset.runId && a.kind === 'video');
      if (!task || task.status !== 'done' || !artifact || !task.outputs.includes(artifact.url) || ['expired', 'invalid'].includes(artifact.validation?.state || '')) throw new Error('选中视频的原任务或产物已过期、未选中或归属无效');
    }
    const file = await projectPath(this.projects.directory(p.id), asset.relativePath);
    const digest = await mediaDigest(file);
    if (asset.validation && digest.sha256 !== asset.validation.sha256) throw new Error('已选素材文件发生变化，保留进度并停止接力');
    if (this.validated.get(`${file}:${kind}`) !== digest.sha256) {
      asset.validation = await validatePetStoryMedia(file, kind);
      this.validated.set(`${file}:${kind}`, digest.sha256);
    }
    const validation = requireValue(asset.validation);
    if (kind === 'video' && (!validation.durationSeconds || validation.durationSeconds < 5 || validation.durationSeconds > 10)) throw new Error('实际视频时长异常，阻断下游');
    return file;
  }
  private originalTask(p: PetStoryProject, step: PetStoryProductionStep): Task {
    const task = this.tasks.list().find((t): boolean => t.id === step.taskId);
    if (!task || task.projectId !== p.studioProjectId || task.assignedAccountId !== p.accountId || hash(task.prompt) !== step.inputHash
      || task.petstory?.projectId !== p.id || task.petstory.stepId !== step.id || task.mode !== (step.kind === 'video' ? 'video' : 'image')) throw new Error('原任务／账号／项目／输入归属不符，停止且不重建');
    if (task.runtime && (task.runtime.input.prompt !== task.prompt || JSON.stringify(task.runtime.input.attachments) !== JSON.stringify(task.attachments || []) || JSON.stringify(task.runtime.input.videoConfig) !== JSON.stringify(task.videoConfig))) throw new Error('原运行输入快照与任务不符，禁止混用产物');
    if (step.runId && task.runtime?.runId !== step.runId) throw new Error('原运行已变化，不混用不同运行素材');
    return task;
  }
  async guard(taskId: string, requireRun = true): Promise<PetStoryProductionResult> {
    const task = this.tasks.list().find((t): boolean => t.id === taskId);
    if (!task?.petstory) return { success: true };
    const p = await this.projects.read(task.petstory.projectId);
    const production = this.checked(p);
    const step = production.steps.find((s): boolean => s.id === task.petstory?.stepId && s.taskId === taskId && s.status === 'bound');
    if (!step || production.state !== 'running' || !this.authorized.has(p.id)) throw new Error('制作已暂停、重开尚未显式继续或原步骤无效，未授权提交');
    if (requireRun && (!step.runId || task.runtime?.runId !== step.runId)) throw new Error('原制作运行尚未绑定，禁止直接从 Studio 绕过制作授权');
    this.originalTask(p, step);
    this.validateRequestContext(p, production.capability, productionStepTarget(step));
    await this.validateStepInputs(p, step, task);
    const shot = p.plan?.shots.find((s): boolean => s.id === step.shotId);
    const guard: PetStoryExecutionGuard = { capability: production.capability, mode: shot ? production.shots[shot.id].resolvedMode : undefined,
      durationSeconds: shot?.durationSeconds, attachmentAssetIds: step.attachmentAssetIds, references: step.compiledPrompt?.references, compiledPrompt: step.compiledPrompt, fileSha256s: step.attachmentAssetIds.map((id): string => requireValue(p.assets.find((a): boolean => a.id === id)?.validation?.sha256)) };
    return { success: true, guard };
  }
  private async validateStepInputs(p: PetStoryProject, step: PetStoryProductionStep, task: Task): Promise<void> {
    const production = this.checked(p);
    if (production.phase !== 'materials') await this.checkApprovedFiles(p, productionShotScope(production));
    else requireMaterialInventory(p);
    this.validateCompiledStep(p, step, task);
    const files = await Promise.all(step.attachmentAssetIds.map((id): Promise<string> => this.assetFile(p, id, 'image')));
    if (JSON.stringify(files) !== JSON.stringify(task.attachments || [])) throw new Error('实际上传顺序与批准素材绑定不一致');
    if (task.runtime && (task.runtime.input.prompt !== task.prompt || JSON.stringify(task.runtime.input.attachments) !== JSON.stringify(files)
      || JSON.stringify(task.runtime.input.videoConfig) !== JSON.stringify(task.videoConfig))) throw new Error('本次持久化运行输入不符');
    if (step.shotId) {
      const source = production.shots[step.shotId]?.startFromPreviousEnd;
      const shotPlan = p.plan?.shots.find((s): boolean => s.id === step.shotId);
      if (source && (production.shots[shotPlan?.previousShotId || '']?.videoId !== source.assetId
        || !p.assets.some((a): boolean => a.id === source.assetId && a.validation?.sha256 === source.sha256 && a.taskId === source.taskId && a.runId === source.runId))) throw new Error('连续镜头的源视频选择已过时，停止接力');
      if (source) await this.assetFile(p, source.assetId, 'video');
    }
    const shot = p.plan?.shots.find((s): boolean => s.id === step.shotId);
    if (step.kind === 'video' && (!shot || task.videoConfig?.duration !== `${shot.durationSeconds}s`)) throw new Error('视频时长不符，零提交');
  }
  private validateCompiledStep(p: PetStoryProject, step: PetStoryProductionStep, task: Task): void {
    const production = this.checked(p);
    if (step.materialId) {
      const source = this.compileMaterial(p, step.materialId);
      const compiled = step.pageBindings ? bindReferenceText(source, step.pageBindings) : source;
      if (JSON.stringify(compiled) !== JSON.stringify(step.compiledPrompt) || compiled.text !== task.prompt) throw new Error('基础图提示词或场景引用已变化');
    }
    if (step.compiledPrompt && step.shotId && ['firstFrame', 'lastFrame', 'video'].includes(step.kind)) {
      const source = compilePrompt(p, step.shotId, step.kind as 'firstFrame' | 'lastFrame' | 'video', step.kind === 'video' ? production.shots[step.shotId].resolvedMode : undefined);
      const compiled = step.pageBindings ? bindReferenceText(source, step.pageBindings) : source;
      if (compiled.text !== task.prompt || JSON.stringify(compiled) !== JSON.stringify(step.compiledPrompt)
        || JSON.stringify(compiled.references.map((r): string => r.assetId)) !== JSON.stringify(step.attachmentAssetIds)) throw new Error('最终编译文本／实际模式／素材快照已变化，零提交');
    }
  }
  async bindRun(id: string, taskId: string, runId: string): Promise<PetStoryProductionResult> {
    const p = await this.projects.read(id);
    const production = this.checked(p);
    const step = production.steps.find((s): boolean => s.taskId === taskId && s.status === 'bound');
    if (!step || production.state !== 'running') throw new Error('步骤未绑定或制作已暂停');
    const task = this.originalTask(p, step);
    if (task.runtime?.runId !== runId || (step.runId && step.runId !== runId)) throw new Error('本次运行绑定不符');
    await this.guard(taskId, false);
    step.runId = runId;
    return { success: true, project: await this.projects.write(p) };
  }
  async advance(id: string): Promise<PetStoryProductionResult> {
    let p = await this.projects.read(id);
    const production = this.checked(p);
    if (production.state !== 'running' || !this.authorized.has(id)) return { success: true, project: p };
    try {
      const pending = production.steps.find((s): boolean => s.status !== 'complete');
      if (pending) return await this.advancePending(p, pending);
      const plan = requireValue(p.plan);
      for (const shot of plan.shots) {
        const media = production.shots[shot.id];
        if (media) { media.firstFrameId = selectedShotImageId(p, shot.id, 'firstFrame'); media.plannedEndImageId = selectedShotImageId(p, shot.id, 'lastFrame'); }
      }
      if (production.phase === 'materials') return await this.advanceMaterials(p);
      await this.checkApprovedFiles(p, productionShotScope(production));
      if (production.target) return await this.advanceTarget(p, production.target);
      for (const shot of plan.shots) {
        const media = production.shots[shot.id];
        if (media.videoId) { await this.assetFile(p, media.videoId, 'video'); continue; }
        if (!media.firstFrameId && !media.actualEndFrameId && shot.transition === 'continue') {
          await this.prepareContinuationFrame(p, shot, production.shots);
          p = await this.projects.write(p);
          return { success: true, project: p, action: 'wait' };
        }
        const kind: 'firstFrame' | 'lastFrame' | 'video' = !media.firstFrameId ? 'firstFrame' : media.resolvedMode === 'first_last_frame' && !media.plannedEndImageId ? 'lastFrame' : 'video';
        const compiled = compilePrompt(p, shot.id, kind, kind === 'video' ? media.resolvedMode : undefined);
        const assetIds = compiled.references.map((r): string => r.assetId);
        const attachments = await Promise.all(assetIds.map((assetId): Promise<string> => this.assetFile(p, assetId, 'image')));
        if (kind === 'video' && media.resolvedMode === 'first_last_frame') {
          const first = requireValue(requireValue(p.assets.find((a): boolean => a.id === media.firstFrameId)).validation);
          const last = requireValue(requireValue(p.assets.find((a): boolean => a.id === media.plannedEndImageId)).validation);
          if (first.width * last.height !== last.width * first.height) throw new Error('首尾帧宽高比不同，停止视频制作');
        }
        const config = kind === 'video' ? { ...requireValue(production.capability.videoConfig), duration: `${shot.durationSeconds}s` as NonNullable<Task['videoConfig']>['duration'] } : undefined;
        const input = finalTaskInput(plan, shot.id, kind, attachments, p.studioProjectId, config);
        input.prompts = [compiled.text];
        return await this.prepareStep(p, { kind, shotId: shot.id }, input, assetIds, compiled);
      }
      production.state = 'complete'; production.message = '逐镜素材已下载并校验，请查看实际画面并确认质量';
      return { success: true, project: await this.projects.write(p) };
    } catch (error: unknown) {
      // 下载／验证失败只停止业务推进，保留原任务和所有产物；不进入生成重试。
      const current = await this.projects.read(id);
      const message = error instanceof Error ? error.message : '制作步骤失败';
      this.authorized.delete(id);
      if (current.production) { current.production.state = 'paused'; current.production.message = message; }
      return { success: false, error: message, project: await this.projects.write(current) };
    }
  }
  private async advanceMaterials(p: PetStoryProject): Promise<PetStoryProductionResult> {
    const production = this.checked(p);
    for (const materialId of production.materialIds || []) {
      if (production.steps.some((s): boolean => s.materialId === materialId && s.status === 'complete')) continue;
      const m = requireValue(p.materials?.find((m): boolean => m.id === materialId));
      const compiled = this.compileMaterial(p, materialId);
      const assetIds = compiled.references.map((r): string => r.assetId);
      const files = await Promise.all(assetIds.map((id): Promise<string> => this.assetFile(p, id, 'image')));
      return this.prepareStep(p, { kind: m.kind, materialId, characterId: m.kind === 'character' ? m.entityId : undefined }, { prompts: [compiled.text], mode: 'image', projectId: p.studioProjectId, executionIntent: 'hold', attachments: files }, assetIds, compiled);
    }
    production.state = 'complete'; production.message = '基础图已下载，请查看实际图片并接受；镜头尚未授权';
    return { success: true, project: await this.projects.write(p) };
  }
  private async advanceTarget(p: PetStoryProject, target: NonNullable<PetStoryProject['production']>['target']): Promise<PetStoryProductionResult> {
    const production = this.checked(p); const plan = requireValue(p.plan);
    const { shotId, kind } = requireValue(target);
    if (production.steps.some((s): boolean => s.shotId === shotId && s.kind === kind && s.status === 'complete')) {
      production.state = 'complete'; production.message = '本节点真实产物已下载并校验；未启动其他媒体节点'; this.authorized.delete(p.id);
      return { success: true, project: await this.projects.write(p) };
    }
    const shot = requireValue(plan.shots.find((s): boolean => s.id === shotId));
    const media = production.shots[shotId];
    const compiled = compilePrompt(p, shotId, kind, kind === 'video' ? media.resolvedMode : undefined);
    const assetIds = compiled.references.map((r): string => r.assetId);
    const attachments = await Promise.all(assetIds.map((assetId): Promise<string> => this.assetFile(p, assetId, 'image')));
    if (kind === 'video' && media.resolvedMode === 'first_last_frame') {
      const first = requireValue(p.assets.find((a): boolean => a.id === media.firstFrameId)?.validation);
      const last = requireValue(p.assets.find((a): boolean => a.id === media.plannedEndImageId)?.validation);
      if (first.width * last.height !== last.width * first.height) throw new Error('首尾帧宽高比不同，停止视频制作');
    }
    const config = kind === 'video' ? { ...requireValue(production.capability.videoConfig), duration: `${shot.durationSeconds}s` as NonNullable<Task['videoConfig']>['duration'] } : undefined;
    const input = finalTaskInput(plan, shotId, kind, attachments, p.studioProjectId, config);
    input.prompts = [compiled.text];
    return this.prepareStep(p, { kind, shotId }, input, assetIds, compiled);
  }
  private async advancePending(p: PetStoryProject, pending: PetStoryProductionStep): Promise<PetStoryProductionResult> {
        if (!pending.taskId) throw new Error('上次创建或写盘结果不确定；请核对原 hold 任务，禁止自动重建');
        const task = this.originalTask(p, pending);
        if (task.status === 'done') {
          await this.collectMedia(p, pending, task);
          p = await this.projects.write(p);
          return { success: true, project: p, action: 'wait' };
        }
        if (task.runtime?.submittedAt) {
          const observation = task.runtime.acceptanceObservation;
          if (!observation || observation.runId !== pending.runId || observation.accountId !== p.accountId || observation.expectedArtifact.runId !== pending.runId || !task.runtime.conversationUrl || observation.conversationUrl !== task.runtime.conversationUrl || observation.outcome === 'manual_review') throw new Error('提交受理状态不明，只读核对原会话，禁止重发');
          return { success: true, project: p, taskId: task.id, action: ['executing', 'generating', 'manual_submission_observing'].includes(task.status) ? 'wait' : 'observe' };
        }
        if (['executing', 'generating'].includes(task.status)) return { success: true, project: p, action: 'wait' };
        if (task.status !== 'queued') throw new Error(task.errorInfo?.message || '原任务已停止，请处理后显式继续');
        if (pending.runId) throw new Error('原任务已有运行记录，禁止重新发送');
        await this.guard(task.id, false);
        return { success: true, project: p, taskId: task.id, action: 'start' };
  }
  private async prepareStep(p: PetStoryProject, target: Pick<PetStoryProductionStep, 'kind' | 'shotId' | 'characterId' | 'materialId'>, input: TaskAddParams, assetIds: string[], compiledPrompt?: PetStoryCompiledPrompt): Promise<PetStoryProductionResult> {
    const production = this.checked(p);
    this.validateRequestContext(p, production.capability, productionStepTarget(target));
    const final = input.prompts[0];
    if (!final || /@(?:Image|Video|Audio)\b/i.test(final)) throw new Error('最终提示词为空或含未验证引用语法');
    checkProductionReferences(final, p, assetIds);
    const step: PetStoryProductionStep = { ...target, id: randomUUID(), inputHash: hash(final), attachmentAssetIds: assetIds, compiledPrompt, status: 'preparing' };
    production.steps.push(step); production.message = `${target.characterId || target.shotId} · ${target.kind}`;
    // 创建前先登记意图；两文件写入间退出时宁可停下核对，不自动多建一次。
    p = await this.projects.write(p);
    const binding = { projectId: p.id, stepId: step.id };
    const draft = target.kind === 'firstFrame' ? p.drafts?.find((d): boolean => d.shotId === target.shotId && d.kind === 'firstFrame' && (d.final === final || d.final === compiledPrompt?.final.trim())) : undefined;
    const old = draft ? this.tasks.list().find((t): boolean => t.id === draft.taskId) : undefined;
    let task: Task;
    if (old && old.projectId === p.studioProjectId && old.assignedAccountId === p.accountId && (old.prompt === final || old.prompt === compiledPrompt?.final.trim()) && JSON.stringify(old.attachments || []) === JSON.stringify(input.attachments || [])) task = this.tasks.adopt(old.id, binding, final);
    else task = this.tasks.create({ ...input, petstory: binding, promptReadback: 'exact', executionIntent: 'hold' }, p.accountId);
    if (task.prompt !== final || task.executionIntent !== 'hold' || task.status !== 'queued') throw new Error('hold 任务写入回读不符，禁止授权');
    const savedStep = requireValue(this.checked(p).steps.find((s): boolean => s.id === step.id));
    savedStep.taskId = task.id; savedStep.status = 'bound';
    p = await this.projects.write(p);
    return { success: true, project: p, taskId: task.id, action: 'start' };
  }
  /** 仅在暂停且下游尚未使用该图时替换，旧文件保留；已经影响视频的重做属于 P5。 */
  async selectImage(id: string, stepId: string, artifactId: string): Promise<PetStoryProductionResult> {
    const p = await this.projects.read(id);
    const production = this.checked(p);
    const step = production.steps.find((s): boolean => s.id === stepId && s.kind !== 'video');
    if (production.state !== 'paused' || !step?.taskId) throw new Error('请先暂停，再选择原图片任务的有效产物');
    if (step.assetId && production.steps.some((s): boolean => s.id !== step.id && s.attachmentAssetIds.includes(step.assetId || ''))) throw new Error('下游已经使用此图，保留原素材；有关视频局部重做属于 P5');
    const task = this.originalTask(p, step);
    const artifact = task.artifacts?.find((a): boolean => a.id === artifactId && a.runId === step.runId && a.kind === 'image' && task.outputs.includes(a.url));
    if (task.status !== 'done' || !artifact || ['expired', 'invalid'].includes(artifact.validation?.state || '')) throw new Error('请选择原运行的有效图片产物');
    if (p.assets.some((a): boolean => a.id === step.assetId && a.artifactId === artifactId)) return { success: true, project: p };
    // 原文件不删除；只有下载／校验及原子保存均成功，才更新选中指针。
    await this.collectMedia(p, step, { ...task, outputs: [artifact.url] });
    return { success: true, project: await this.projects.write(p) };
  }
  private async importMediaArtifact(p: PetStoryProject, step: PetStoryProductionStep, task: Task, artifact: NonNullable<Task['artifacts']>[number]): Promise<PetStoryAsset | undefined> {
    const kind = step.kind === 'video' ? 'video' : 'image';
      let job = this.tasks.downloads().find((j): boolean => j.taskId === task.id && j.accountId === p.accountId && j.mode === task.mode && j.url === artifact.url && j.status === 'done');
      if (!job) {
        const result = await this.tasks.download({ outputs: [{ taskId: task.id, prompt: task.prompt, outputs: [artifact.url], accountId: p.accountId, mode: task.mode }] });
        if (!result.success || result.failed) throw new Error('下载失败，继续时只重试原产物下载，不重新生成');
        job = this.tasks.downloads().find((j): boolean => !!result.jobIds?.includes(j.id) && j.taskId === task.id && j.accountId === p.accountId && j.url === artifact.url && j.status === 'done' && j.mode === task.mode);
      }
      if (!job?.filePath) throw new Error('下载作业与原任务产物归属不符，未登记素材');
      let validation;
      try { validation = await validatePetStoryMedia(job.filePath, kind); }
      catch (error: unknown) {
        step.rejectedArtifactIds = [...(step.rejectedArtifactIds || []), artifact.id];
        step.error = error instanceof Error ? error.message : '产物校验失败';
        return undefined; // 损坏产物不能采用，也不发起新生成。
      }
      const assetId = randomUUID();
      const ext = kind === 'video' ? '.mp4' : path.extname(job.filePath).toLowerCase();
      if (!['.mp4', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('下载图片扩展名异常，未绑定');
      const relativePath = step.materialId ? `materials/${assetId}${ext}` : step.kind === 'character' ? `characters/${assetId}${ext}` : `shots/${step.shotId}/${assetId}${ext}`;
      const destination = await projectPath(this.projects.directory(p.id), relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await projectPath(this.projects.directory(p.id), relativePath);
      await fs.copyFile(job.filePath, destination, 1);
      if ((await mediaDigest(destination)).sha256 !== validation.sha256) throw new Error('下载复制后的素材校验不一致');
      const asset: PetStoryAsset = { id: assetId, kind: step.kind === 'lastFrame' ? 'plannedEndImage' : step.kind, relativePath,
        materialId: step.materialId, generationPrompt: task.prompt, generationFinal: step.compiledPrompt?.final, shotId: step.shotId, characterId: step.characterId, taskId: task.id, runId: step.runId, artifactId: artifact.id, downloadJobId: job.id, validation };
      if (kind === 'image') {
        const target = step.materialId ? { materialId: step.materialId } : step.kind === 'character' ? { materialId: `character:${requireValue(step.characterId)}` }
          : { shotId: requireValue(step.shotId), kind: step.kind as 'firstFrame' | 'lastFrame' };
        asset.imageReview = { state: 'candidate', target, basisHash: imageTargetBasis(p, target) };
      }
      return asset;
  }
  private async collectMedia(p: PetStoryProject, step: PetStoryProductionStep, task: Task): Promise<void> {
    if (!step.runId || task.runtime?.runId !== step.runId || !task.runtime.submittedAt) throw new Error('生成结果缺少原运行与单次提交记录');
    const kind = step.kind === 'video' ? 'video' : 'image';
    const artifacts = task.outputs.flatMap((url): NonNullable<Task['artifacts']> => (task.artifacts || []).filter((a): boolean => a.url === url && a.runId === step.runId && a.kind === kind && !['invalid', 'expired'].includes(a.validation?.state || '') && !step.rejectedArtifactIds?.includes(a.id)));
    if (!artifacts.length) throw new Error('没有属于原运行的可用真实产物，done 或缩略图不算媒体');
    // 同一运行的所有有效图片均保存为候选；下载和文件校验不代表用户采用。
    let firstAssetId: string | undefined;
    for (const artifact of artifacts) {
      const duplicate = p.assets.find((asset): boolean => asset.taskId === task.id && asset.runId === step.runId && asset.artifactId === artifact.id);
      if (duplicate) { firstAssetId ||= duplicate.id; continue; }
      let asset: PetStoryAsset | undefined;
      try { asset = await this.importMediaArtifact(p, step, task, artifact); }
      catch (error: unknown) {
        if (!firstAssetId) throw error;
        step.error = error instanceof Error ? error.message : '部分候选下载失败';
        // 同一任务后续候选失败时，先保住已取得候选，再暂停原步骤；恢复只重下缺项。
        await this.projects.write(p);
        throw error;
      }
      if (!asset) continue;
      p.assets.push(asset); firstAssetId ||= asset.id;
      if (kind === 'video') { this.checked(p).shots[requireValue(step.shotId)].videoId = asset.id; break; }
    }
    if (firstAssetId) {
      step.assetId = firstAssetId; step.status = 'complete'; step.error = undefined;
      if (kind === 'image' && this.checked(p).phase !== 'materials') {
        const production = this.checked(p);
        production.state = production.target ? 'complete' : 'paused';
        production.message = '图片已下载，请预览并采用满意的一张';
        this.authorized.delete(p.id);
      }
      return;
    }
    await this.projects.write(p);
    throw new Error(step.error || '本次返回的产物均未通过文件校验；保留原任务，不重新生成');
  }
}
