import type { PetStoryAsset, PetStoryChatJob, PetStoryImageOperation, PetStoryImageTarget, PetStoryProject, Task } from '@doubao-studio/contracts';
import { resolveTaskConversationTarget } from './taskConversationLocator';
import { imageBelongsToTarget, pendingImageCandidates } from './petstoryImageCandidates';
import { journeyMaterialImageApproved } from './petstoryJourney';

export function sameImageTarget(left: PetStoryImageTarget, right: PetStoryImageTarget): boolean {
  return left.materialId ? left.materialId === right.materialId : left.shotId === right.shotId && left.kind === right.kind;
}

/** 仅投影现有操作；读取卡片或重开项目不会创建请求。 */
export function imageOperationForTarget(project: PetStoryProject, target: PetStoryImageTarget): PetStoryImageOperation | undefined {
  return [...(project.imageOperations || [])].reverse().find((operation): boolean => sameImageTarget(operation.target, target));
}

function operationChatJob(project: PetStoryProject, operation: PetStoryImageOperation): PetStoryChatJob | undefined {
  let job = project.jobs.find((item): boolean => item.id === operation.chatJobId);
  const seen = new Set<string>();
  while (job && !seen.has(job.id)) {
    seen.add(job.id);
    const parentId = job.id;
    const repair = project.jobs.find((item): boolean => item.kind === 'repair' && item.parentJobId === parentId);
    if (!repair) break;
    job = repair;
  }
  return job;
}

/** 结构修订仍属于同一次图片操作，不能混入自由 Chat 或其他目标。 */
export function imageOperationForChatJob(project: PetStoryProject, jobId: string): PetStoryImageOperation | undefined {
  let job = project.jobs.find((item): boolean => item.id === jobId);
  const seen = new Set<string>();
  while (job && !seen.has(job.id)) {
    seen.add(job.id);
    const operation = project.imageOperations?.find((item): boolean => item.chatJobId === job?.id);
    if (operation) return operation;
    if (job.kind !== 'repair' || !job.parentJobId) return;
    const parentId = job.parentJobId;
    job = project.jobs.find((item): boolean => item.id === parentId);
  }
}

export function imageOperationTask(project: PetStoryProject, operation: PetStoryImageOperation, tasks: Task[]): Task | undefined {
  const job = operationChatJob(project, operation);
  const taskId = operation.stage === 'preparing' ? job?.taskId || operation.taskId : operation.taskId || job?.taskId;
  return tasks.find((task): boolean => task.id === taskId && task.projectId === project.studioProjectId && task.assignedAccountId === project.accountId);
}

export interface PetStoryImageProgress {
  operation?: PetStoryImageOperation;
  busy: boolean;
  stage: PetStoryImageOperation['stage'] | 'idle';
  message: string;
  error: string;
  task?: Task;
  candidateAssetId?: string;
  resumable: boolean;
}

function completedImageMessage(project: PetStoryProject, target: PetStoryImageTarget): string {
  const material = project.materials?.find((item): boolean => item.id === target.materialId);
  const shotImages = target.shotId ? project.adoptedImages?.[target.shotId] : undefined;
  const currentId = material?.selectedAssetId || (target.kind === 'firstFrame' ? shotImages?.firstFrameId : shotImages?.plannedEndImageId);
  const current = project.assets.find((asset): boolean => asset.id === currentId && imageBelongsToTarget(project, asset, target));
  if (!current || pendingImageCandidates(project, target, currentId).length) return '图片已生成，请查看';
  const review = current.imageReview;
  const adoptedAt = review?.adoptedAt || material?.approved?.at;
  const validTime = !!adoptedAt && Number.isFinite(Date.parse(adoptedAt));
  const fileValid = !!current.validation?.decoded && !!current.validation.sha256 && !current.needsReview;
  const approved = fileValid && (material ? journeyMaterialImageApproved(project, material)
    : review?.state === 'adopted' && review.sha256 === current.validation?.sha256);
  return approved && validTime ? '图片已采用' : '图片需要复核';
}

/** 百分比未知时只给真实阶段，不用计时器推算完成或替用户采用。 */
export function petStoryImageProgress(project: PetStoryProject, target: PetStoryImageTarget, tasks: Task[], activeOperationId?: string | null): PetStoryImageProgress {
  const operation = imageOperationForTarget(project, target);
  if (!operation) return { busy: false, stage: 'idle', message: '', error: '', resumable: false };
  const task = imageOperationTask(project, operation, tasks);
  const failedTask = task && ['fail', 'paused', 'cancelled', 'waiting_verification', 'waiting_generation_confirmation'].includes(task.status);
  const error = operation.error || (failedTask ? task.errorInfo?.message || task.runtime?.message || '任务已暂停，请处理后继续' : '');
  const available = operation.outputAssetId && project.assets.some((asset): boolean => asset.id === operation.outputAssetId && !!asset.validation?.decoded);
  const stage = operation.stage === 'complete' && !available ? 'saving' : operation.stage;
  const resumable = ['preparing', 'generating', 'saving'].includes(stage) && activeOperationId !== undefined && activeOperationId !== operation.id;
  const messages: Record<PetStoryImageOperation['stage'], string> = {
    preparing: '正在准备图片…', generating: operation.mode === 'modify' ? '正在按你的要求修改图片…' : '正在生成图片…',
    saving: '正在保存图片…', complete: stage === 'complete' ? completedImageMessage(project, target) : '图片已生成，请查看', failed: '本次图片处理未完成',
  };
  return { operation, busy: !error && !resumable && ['preparing', 'generating', 'saving'].includes(stage), stage,
    message: resumable ? '图片任务已保存，可继续本次任务' : messages[stage], error, task, candidateAssetId: available ? operation.outputAssetId : undefined, resumable };
}

function assetConversationTask(asset: PetStoryAsset | undefined, project: PetStoryProject, tasks: Task[]): Task | undefined {
  if (!asset?.taskId) return;
  const task = tasks.find((item): boolean => item.id === asset.taskId && item.projectId === project.studioProjectId && item.assignedAccountId === project.accountId);
  // 不把同任务后来的运行会话冒充旧候选的来源。
  if (!task || asset.runId && asset.runId !== task.runtime?.runId || !resolveTaskConversationTarget(task).ok) return;
  return task;
}

/** 选定图片只打开其真实生成任务；上传图不回退到无关文字会话。 */
export function imageConversationTask(project: PetStoryProject, target: PetStoryImageTarget, tasks: Task[], assetId?: string): Task | undefined {
  if (assetId) return assetConversationTask(project.assets.find((asset): boolean => asset.id === assetId && imageBelongsToTarget(project, asset, target)), project, tasks);
  const operation = imageOperationForTarget(project, target);
  if (operation && operation.stage !== 'complete') {
    const task = imageOperationTask(project, operation, tasks);
    return task && resolveTaskConversationTarget(task).ok ? task : undefined;
  }
  const images = project.assets.filter((asset): boolean => imageBelongsToTarget(project, asset, target));
  const material = target.materialId ? project.materials?.find((item): boolean => item.id === target.materialId) : undefined;
  const adopted = target.shotId ? project.adoptedImages?.[target.shotId] : undefined;
  const currentId = material?.selectedAssetId || (target.kind === 'firstFrame' ? adopted?.firstFrameId : adopted?.plannedEndImageId);
  const candidate = pendingImageCandidates(project, target, currentId).at(-1);
  const current = images.find((asset): boolean => asset.id === currentId) || images.at(-1);
  return assetConversationTask(candidate || current, project, tasks);
}
