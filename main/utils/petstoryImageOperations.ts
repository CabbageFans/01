import { randomUUID } from 'node:crypto';
import type { PetStoryCapability, PetStoryChatJob, PetStoryImageOperation, PetStoryImageOperationRequest, PetStoryImageOperationResult, PetStoryProject, Task } from '@doubao-studio/contracts';
import { PetStoryProjects } from './petstoryProject';
import { PetStoryChatService } from './petstoryChat';
import { PetStoryProductionService } from './petstoryProduction';
import { requireMaterialInventory, requireMaterialPromptSource } from './petstoryMaterials';
import { imageTargetBasis, imageTargetMatches } from './petstoryImageReview';
import { mediaDigest, validatePetStoryMedia } from './petstoryMedia';
import { productionCapability } from './petstoryCapability';

function operationFor(p: PetStoryProject, id: string): PetStoryImageOperation {
  const operation = p.imageOperations?.find((item): boolean => item.id === id);
  if (!operation) throw new Error('本次图片操作不存在，请重新打开素材');
  return operation;
}
function sameTarget(a: PetStoryImageOperationRequest['target'], b: PetStoryImageOperationRequest['target']): boolean {
  return a.materialId ? a.materialId === b.materialId : a.shotId === b.shotId && a.kind === b.kind;
}
/** 只跟随本次根请求的修订，不会拾取同素材其他历史候选。 */
function operationJob(p: PetStoryProject, operation: PetStoryImageOperation): PetStoryChatJob | undefined {
  let job = p.jobs.find((item): boolean => item.id === operation.chatJobId);
  const seen = new Set<string>();
  while (job && !seen.has(job.id)) {
    seen.add(job.id);
    const child = p.jobs.find((item): boolean => item.kind === 'repair' && item.parentJobId === job?.id);
    if (!child) break;
    job = child;
  }
  return job;
}
function resultFor(p: PetStoryProject, operation: PetStoryImageOperation): PetStoryImageOperationResult {
  return { success: operation.stage !== 'failed', project: p, operationId: operation.id, error: operation.error,
    ...(operation.stage === 'preparing' ? { chatJobId: operationJob(p, operation)?.id } : {}) };
}
function materialTarget(operation: Pick<PetStoryImageOperation, 'target'>): string {
  if (!operation.target.materialId) throw new Error('请选择具体基础素材');
  return operation.target.materialId;
}
function requireProject(result: PetStoryImageOperationResult): PetStoryProject {
  if (!result.project) throw new Error('原图片任务未保存，请重新打开项目');
  return result.project;
}
function validateRequest(request: PetStoryImageOperationRequest): void {
  if (!request || typeof request.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(request.requestId)
    || !request.target || !!request.target.materialId === !!request.target.shotId) throw new Error('请选择具体素材后生成或修改图片');
}
function validateBeginProject(p: PetStoryProject, revision: number, request: PetStoryImageOperationRequest, replaceableProduction: boolean): boolean {
  if (p.revision !== revision) throw new Error('项目版本已变化，请刷新素材');
  requireMaterialInventory(p);
  if (p.chatAdjustment?.status === 'active') throw new Error('请先结束当前豆包调整，避免覆盖对话草稿');
  if (p.production && p.production.state !== 'complete' && !replaceableProduction) throw new Error('已有制作任务尚未结束，请先处理原任务');
  const modifying = request.baseAssetId !== undefined || request.feedback !== undefined;
  if (modifying && (typeof request.baseAssetId !== 'string' || typeof request.feedback !== 'string' || !request.feedback.trim() || request.feedback.length > 4000)) throw new Error('请填写你希望怎么修改这张图片');
  if (!modifying && !request.target.materialId) throw new Error('首次生成请使用对应图片节点的生成入口');
  return modifying;
}

/** 图片授权只覆盖一个目标；执行仍交给既有 Chat 和 Production 服务。 */
export class PetStoryImageOperationService {
  private readonly authorized = new Set<string>();
  constructor(private readonly projects: PetStoryProjects, private readonly chats: PetStoryChatService,
    private readonly production: PetStoryProductionService, private readonly tasks: () => Task[]) {}

  suspend(projectId: string): void {
    for (const id of [...this.authorized]) if (id.startsWith(`${projectId}:`)) this.authorized.delete(id);
  }
  private authorize(projectId: string, operationId: string): void { this.authorized.add(`${projectId}:${operationId}`); }
  private async failed(projectId: string, operationId: string, error: unknown): Promise<PetStoryImageOperationResult> {
    const p = await this.projects.read(projectId); const operation = operationFor(p, operationId);
    operation.stage = 'failed'; operation.error = error instanceof Error ? error.message : '本次图片操作未完成';
    this.authorized.delete(`${projectId}:${operationId}`);
    return resultFor(await this.projects.write(p), operation);
  }
  /** 用户再次提交仅可取代确定未发送的已停止操作；下载失败或提交不明仍只恢复原任务。 */
  private canReplaceFailedProduction(p: PetStoryProject): boolean {
    const production = p.production;
    if (!production?.imageOperationId || production.state !== 'paused'
      || !p.imageOperations?.some((item): boolean => item.id === production.imageOperationId && item.stage === 'failed')) return false;
    return production.steps.every((step): boolean => {
      const task = this.tasks().find((item): boolean => item.id === step.taskId);
      return !!task && task.projectId === p.studioProjectId && task.assignedAccountId === p.accountId
        && task.petstory?.projectId === p.id && task.petstory.stepId === step.id && task.mode === 'image'
        && ['paused', 'fail', 'cancelled', 'waiting_verification'].includes(task.status) && !task.runtime?.submittedAt
        && !task.runtime?.acceptanceObservation && !task.runtime?.chatResponse && !task.outputs?.length;
    });
  }
  async begin(id: string, revision: number, request: PetStoryImageOperationRequest, capability?: PetStoryCapability): Promise<PetStoryImageOperationResult> {
    let p = await this.projects.read(id);
    validateRequest(request);
    const prior = p.imageOperations?.find((item): boolean => item.requestId === request.requestId);
    if (prior) {
      if (!sameTarget(prior.target, request.target) || prior.baseAssetId !== request.baseAssetId || prior.feedback !== request.feedback) throw new Error('同一次图片请求的内容已变化，请刷新后重新操作');
      return resultFor(p, prior);
    }
    const active = p.imageOperations?.find((item): boolean => !['complete', 'failed'].includes(item.stage));
    if (active) return { ...resultFor(p, active), success: false, error: '已有图片任务正在进行，请先查看或继续原任务' };
    const replaceableProduction = this.canReplaceFailedProduction(p);
    const modifying = validateBeginProject(p, revision, request, replaceableProduction);
    if (replaceableProduction && p.production) {
      p.productionHistory = [...(p.productionHistory || []), p.production]; p.production = undefined;
    }
    const feedback = request.feedback;
    const operation: PetStoryImageOperation = { id: randomUUID(), requestId: request.requestId, target: structuredClone(request.target),
      mode: modifying ? 'modify' : 'generate', stage: 'preparing', createdAt: new Date().toISOString(),
      basisHash: imageTargetBasis(p, request.target), ...(modifying ? { baseAssetId: request.baseAssetId, feedback } : {}) };
    if (modifying) await this.validateBase(p, operation);
    // 先落盘本次授权与精确基图；创建结果不明时不自动补建请求。
    p.imageOperations = [...(p.imageOperations || []), operation];
    p = await this.projects.write(p); this.authorize(p.id, operation.id);
    try {
      if (modifying) return await this.startProduction(p, operation, capability);
      const materialId = materialTarget(operation);
      let usable = false;
      try { requireMaterialPromptSource(p, materialId); usable = true; } catch { /* 正文准备是本次图片操作内部步骤。 */ }
      if (usable) return await this.startProduction(p, operation, capability);
      // 不适用的旧手改也不清空；prepareRuntime 将原 final/inputEdited 保存在本次请求快照。
      const prepared = await this.chats.prepareRuntime(p.id, p.revision, 'materialPrompt', { materialId, capability: productionCapability(p, capability) }, operation.id);
      if (!prepared.success || !prepared.project || !prepared.taskId) throw new Error(prepared.error || '图片准备未完成，请继续原任务');
      p = prepared.project;
      const job = p.jobs.find((item): boolean => item.taskId === prepared.taskId && item.materialId === materialId && item.kind === 'materialPrompt');
      if (!job) throw new Error('图片准备的原任务未保存，未继续发送');
      if (operationFor(p, operation.id).chatJobId !== job.id) throw new Error('图片准备关联未与原任务一并保存');
      return { ...prepared, operationId: operation.id, chatJobId: job.id };
    } catch (error: unknown) { return this.failed(p.id, operation.id, error); }
  }
  private async validateBase(p: PetStoryProject, operation: PetStoryImageOperation): Promise<void> {
    const base = p.assets.find((asset): boolean => asset.id === operation.baseAssetId);
    if (!base || !imageTargetMatches(base, operation.target) || base.imageReview && !sameTarget(base.imageReview.target, operation.target)) throw new Error('所选基图不属于当前素材，请重新选择图片');
    const file = await this.projects.referenceFile(p.id, base.id);
    const digest = await mediaDigest(file);
    if (base.validation && base.validation.sha256 !== digest.sha256) throw new Error('所选图片文件已变化，请重新上传后修改');
    base.validation = await validatePetStoryMedia(file, 'image'); operation.baseSha256 = base.validation.sha256;
  }
  private async startProduction(p: PetStoryProject, operation: PetStoryImageOperation, capability?: PetStoryCapability): Promise<PetStoryImageOperationResult> {
    const started = operation.mode === 'modify'
      ? await this.production.generateImageFeedback(p.id, p.revision, operation.id, capability)
      : await this.production.generateMaterials(p.id, p.revision, [materialTarget(operation)], capability, operation.id);
    if (!started.success || !started.project?.production) throw new Error(started.error || '本次图片任务未保存');
    p = started.project;
    const saved = operationFor(p, operation.id);
    saved.stage = 'generating'; saved.error = undefined; saved.basisHash = imageTargetBasis(p, saved.target);
    saved.productionApprovedAt = started.project.production?.approvedAt;
    return { ...started, project: await this.projects.write(p), operationId: saved.id };
  }
  async advance(id: string, operationId: string): Promise<PetStoryImageOperationResult> {
    const p = await this.projects.read(id); const operation = operationFor(p, operationId);
    if (['complete', 'failed'].includes(operation.stage) || !this.authorized.has(`${id}:${operationId}`)) return resultFor(p, operation);
    try {
      if (operation.stage === 'preparing') return await this.advancePreparation(p, operation);
      return await this.advanceProduction(p, operation);
    } catch (error: unknown) { return this.failed(id, operationId, error); }
  }
  private async advancePreparation(p: PetStoryProject, operation: PetStoryImageOperation): Promise<PetStoryImageOperationResult> {
    const id = p.id; const operationId = operation.id;
    const job = operationJob(p, operation);
    if (!job) throw new Error('图片准备任务创建结果不明，请核对原任务；不会自动重发');
    if (job.materialId !== operation.target.materialId || job.endedWaitingAt || job.resultStatus === 'stale') throw new Error(job.staleReason || '本次图片准备已停止，请处理原任务');
    const task = this.tasks().find((item): boolean => item.id === job.taskId);
    if (job.status === 'bound' && task && ['paused', 'fail', 'cancelled', 'waiting_verification'].includes(task.status)) throw new Error(task.errorInfo?.message || '图片准备已暂停，请处理原任务后继续');
    if (job.status === 'invalid') {
      const repairable = job.kind !== 'repair' && !!job.validationDetails?.length && job.validationDetails.every((issue): boolean => issue.repairable);
      if (repairable) return { ...resultFor(p, operation), success: false, error: job.error, chatJobId: job.id, needsRepair: true, repairSourceJobId: job.id };
      throw new Error(job.error || '图片准备未完成，请继续原任务');
    }
    if (job.status === 'bound' || job.status === 'captured') return { ...resultFor(p, operation), chatJobId: job.id };
    if (job.status !== 'applied' || !['candidate', 'adopted'].includes(job.resultStatus || '')) throw new Error(job.error || '本次图片准备尚未取得有效内容');
    if (job.resultStatus === 'candidate') {
      const adopted = await this.chats.adoptPromptCandidate(id, p.revision, job.id);
      if (!adopted.success) {
        if (adopted.needsRepair) return { ...adopted, operationId, chatJobId: job.id };
        throw new Error(adopted.error || '图片准备未通过当前素材核对');
      }
      p = requireProject(adopted); operation = operationFor(p, operationId);
    }
    return await this.startProduction(p, operation);
  }
  private async advanceProduction(p: PetStoryProject, operation: PetStoryImageOperation): Promise<PetStoryImageOperationResult> {
    const id = p.id; const operationId = operation.id;
    if (p.production?.imageOperationId !== operationId) throw new Error('本次图片制作与原授权不符，未创建新任务');
    const advanced = await this.production.advance(id);
    p = advanced.project || await this.projects.read(id); operation = operationFor(p, operationId);
    const step = p.production?.steps[0];
    const task = this.tasks().find((item): boolean => item.id === step?.taskId);
    const stage = step?.assetId && p.assets.some((asset): boolean => asset.id === step.assetId && !!asset.validation?.decoded)
      && p.production?.state === 'complete' ? 'complete' : task?.status === 'done' ? 'saving' : 'generating';
    if (!advanced.success || p.production?.state === 'paused') throw new Error(advanced.error || p.production?.message || '本次图片任务已暂停');
    if (stage !== operation.stage || operation.taskId !== step?.taskId || operation.outputAssetId !== (stage === 'complete' ? step?.assetId : undefined)) {
      operation.stage = stage; operation.taskId = step?.taskId; operation.outputAssetId = stage === 'complete' ? step?.assetId : undefined;
      p = await this.projects.write(p);
    }
    if (stage === 'complete') this.authorized.delete(`${id}:${operationId}`);
    return { ...advanced, project: p, operationId };
  }
  async resume(id: string, operationId: string, capability?: PetStoryCapability): Promise<PetStoryImageOperationResult> {
    let p = await this.projects.read(id); const operation = operationFor(p, operationId);
    if (operation.stage === 'complete') return resultFor(p, operation);
    if (p.chatAdjustment?.status === 'active') throw new Error('请先结束当前豆包调整，避免覆盖对话草稿');
    if (operation.mode === 'modify' && p.production?.imageOperationId !== operationId) return this.resumeUncreatedModification(p, operation, capability);
    operation.error = undefined;
    if (p.production?.imageOperationId === operationId) {
      const resumed = await this.production.resume(id, capability);
      if (!resumed.success || !resumed.project) return { ...resumed, operationId };
      p = resumed.project; operationFor(p, operationId).stage = 'generating'; operationFor(p, operationId).error = undefined;
    } else {
      const job = operationJob(p, operation);
      if (!job || job.endedWaitingAt) throw new Error('原图片准备任务未确定，不能自动重新发送');
      const task = this.tasks().find((item): boolean => item.id === job.taskId);
      if (task && ['paused', 'fail', 'cancelled', 'waiting_verification'].includes(task.status) && !task.runtime?.submittedAt && !task.runtime?.chatResponse) {
        const retried = await this.chats.retryUnsubmitted(id, job.id);
        if (!retried.success || !retried.project) return { ...retried, operationId, chatJobId: job.id };
        p = retried.project;
      }
      operationFor(p, operationId).stage = 'preparing'; operationFor(p, operationId).error = undefined;
    }
    p = await this.projects.write(p); this.authorize(id, operationId);
    return resultFor(p, operationFor(p, operationId));
  }
  private async resumeUncreatedModification(p: PetStoryProject, operation: PetStoryImageOperation, capability?: PetStoryCapability): Promise<PetStoryImageOperationResult> {
    const runs = [p.production, ...(p.productionHistory || [])].filter((run): run is NonNullable<typeof run> => !!run);
    const knownSteps = runs.flatMap((run): typeof run.steps => run.steps);
    const orphan = this.tasks().some((task): boolean => task.petstory?.projectId === p.id
      && !knownSteps.some((step): boolean => step.id === task.petstory?.stepId && step.taskId === task.id));
    if (operation.taskId || runs.some((run): boolean => run.imageOperationId === operation.id) || orphan
      || p.imageOperations?.some((item): boolean => item.id !== operation.id && !['complete', 'failed'].includes(item.stage))) throw new Error('原修改任务已有记录或创建结果不明，请核对原任务，不重新发送');
    // 该生产入口只登记计划，尚未创建 Task；无计划／无孤立任务才能接续同一修改授权。
    if (operation.basisHash !== imageTargetBasis(p, operation.target)) throw new Error('素材事实已变化，请按当前素材重新提交修改意见');
    try {
      const result = await this.startProduction(p, operation, capability);
      this.authorize(p.id, operation.id);
      return result;
    } catch (error: unknown) { return this.failed(p.id, operation.id, error); }
  }
}
