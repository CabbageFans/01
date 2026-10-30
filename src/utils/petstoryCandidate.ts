import type { PetStoryChatJob, PetStoryProject, Task } from '@doubao-studio/contracts';

function hasTaskExecutionLease(task: Task): boolean {
  if (!task.lock) return false;
  const expiresAt = Date.parse(task.lock.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt > Date.now();
}
function isOriginalBoundChat(project: PetStoryProject, job: PetStoryChatJob, task: Task): boolean {
  if (job.status !== 'bound' || job.endedWaitingAt || job.rawText) return false;
  if (task.id !== job.taskId || task.mode !== 'chat' || task.projectId !== project.studioProjectId || task.assignedAccountId !== project.accountId) return false;
  return job.sourceStoryId === project.mobileStory?.id && job.sourceUrl === project.source.url;
}
function isBoundOrRecoverableRun(job: PetStoryChatJob, task: Task): boolean {
  if (job.runId) return job.runId === task.runtime?.runId;
  if (task.status === 'queued') return true;
  // 正式重试可能已保存解除旧绑定，但同任务重入队落盘失败；不在UI伪绑旧run。
  return !!job.requestId && !!job.requestText && job.requestText === task.prompt && !task.lock;
}
function isUnsubmittedBoundRun(job: PetStoryChatJob, task: Task): boolean {
  const runtime = task.runtime;
  if (runtime?.submittedAt || runtime?.acceptanceObservation || runtime?.chatResponse || task.outputs?.length) return false;
  if (!runtime) return task.status === 'queued' && !job.runId;
  if (!isBoundOrRecoverableRun(job, task)) return false;
  return runtime.input.mode === 'chat' && runtime.input.prompt === task.prompt && JSON.stringify(runtime.input.attachments) === JSON.stringify(task.attachments || []);
}
function isBoundChatStartState(task: Task): boolean {
  if (hasTaskExecutionLease(task)) return false;
  if (task.status === 'queued') return true;
  return ['fail', 'paused', 'cancelled', 'waiting_verification'].includes(task.status)
    && ['video_prompt_not_ready', 'video_assets_not_ready', 'chat_assets_not_ready', 'page_unrecognized', 'page_loading', 'page_changed', 'authentication_unconfirmed', 'cancelled'].includes(task.errorInfo?.code || '');
}
/** 两处来源入口共用：只允许原任务明确未发送后继续；真正重入队和绑定新 run 仍由正式服务核对。 */
export function canStartBoundChat(project: PetStoryProject | null | undefined, job: PetStoryChatJob, task: Task | undefined, tasks: Task[], occupied = false): boolean {
  if (!project?.mobileStory || !task || occupied) return false;
  if (!isOriginalBoundChat(project, job, task) || !isUnsubmittedBoundRun(job, task) || !isBoundChatStartState(task)) return false;
  return !tasks.some((other): boolean => other.id !== task.id && other.assignedAccountId === project.accountId
    && (hasTaskExecutionLease(other) || ['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'].includes(other.status)));
}

/** 文字目标的只读投影，与主进程请求选择顺序一致，不代表媒体能力确认。 */
export function petStoryWritingModel(project: PetStoryProject): NonNullable<PetStoryProject['promptModel']> {
  const capability = project.promptCapability || project.production?.capability || [...(project.productionHistory || [])].reverse().find((item): boolean => !!item.capability)?.capability;
  return project.promptModel || capability?.videoConfig?.model || 'generic';
}

/** 素材卡只投影原素材／全局等待及真实账号占用；最终依赖和租约仍由主进程核对。 */
export function isMaterialPromptBlocked(project: PetStoryProject, materialId: string, tasks: Task[]): boolean {
  if (petStoryMaterialPromptBlock(project, materialId, tasks)) return true;
  if (tasks.some((task): boolean => task.assignedAccountId === project.accountId && ['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'].includes(task.status))) return true;
  return project.jobs.some((job): boolean => !job.endedWaitingAt && ['bound', 'captured'].includes(job.status)
    && (job.materialId === materialId || !job.materialId && !job.shotId));
}

export interface PetStoryMaterialPromptBlock {
  message: string;
  adjustmentProjectId?: string;
  adjustmentId?: string;
}
/** 对话保护独立于任务是否 done，其他项目在同一账号上的自由调整也必须显示在当前卡。 */
export function petStoryMaterialPromptBlock(project: PetStoryProject, _materialId: string, tasks: Task[]): PetStoryMaterialPromptBlock | undefined {
  const guard = tasks.find((task): boolean => task.assignedAccountId === project.accountId && task.runtime?.chatAdjustmentGuard?.active === true)?.runtime?.chatAdjustmentGuard;
  if (guard) return { message: '这个账号还有未结束的豆包调整，请先采用回复或结束调整，再生成提示词。', adjustmentProjectId: guard.projectId, adjustmentId: guard.adjustmentId };
  if (project.chatAdjustment?.status === 'active') return { message: '当前豆包调整尚未结束，请先采用回复或结束调整，再生成提示词。', adjustmentProjectId: project.id, adjustmentId: project.chatAdjustment.id };
  return undefined;
}

/** 格式纠正后的审查保留职责；界面与局部修订均使用实际保存 issues 的回复 ID。 */
export function isSavedReviewResult(job: PetStoryChatJob, jobs: PetStoryChatJob[]): boolean {
  if (job.status !== 'applied' || job.resultStatus === 'stale' || !job.parsedResult?.issues) return false;
  if (job.kind === 'review') return true;
  if (job.kind !== 'repair') return false;
  const original = jobs.find((item): boolean => item.id === job.parentJobId);
  return original?.kind === 'review' && !!original.requestId && original.sourceStoryId === job.sourceStoryId;
}

/** 审查只适用于当时真正送审的采用正文；旧全局审查缺快照时仅保留历史。 */
export function reviewMatchesPrompt(job: PetStoryChatJob, targetId: string, currentFinal: string | undefined): boolean {
  if (!['review', 'repair'].includes(job.kind) || job.status !== 'applied' || job.resultStatus === 'stale' || typeof currentFinal !== 'string') return false;
  const finals = job.reviewInputFinals;
  if (finals !== undefined) return !!finals && typeof finals === 'object' && !Array.isArray(finals)
    && Object.prototype.hasOwnProperty.call(finals, targetId) && typeof finals[targetId] === 'string' && finals[targetId] === currentFinal;
  const singleTarget = job.materialId || (job.shotId && job.promptKind ? `${job.shotId}:${job.promptKind}` : undefined);
  return singleTarget === targetId && job.inputFinal !== undefined && job.inputFinal === currentFinal;
}

/** 以正式目标 ID 读取当前 final；不把未采用 optimized 候选作为已确认正文。 */
export function currentReviewPrompt(project: PetStoryProject, targetId: string): string | undefined {
  const material = project.materials?.find((item): boolean => item.id === targetId);
  if (material) return material.prompt.final;
  for (const shot of project.plan?.shots || []) {
    for (const kind of ['firstFrame', 'lastFrame', 'video'] as const) {
      if (targetId === `${shot.id}:${kind}`) return shot.prompts[kind]?.final;
    }
  }
  return undefined;
}

/** 空问题也只是该次审查结论；缺少或过期快照不能表述为当前正文已通过。 */
export function reviewMatchesCurrentPrompts(project: PetStoryProject, job: PetStoryChatJob): boolean {
  const keys = job.reviewInputFinals ? Object.keys(job.reviewInputFinals) : [job.materialId || (job.shotId && job.promptKind ? `${job.shotId}:${job.promptKind}` : '')].filter(Boolean);
  return isSavedReviewResult(job, project.jobs) && !!keys.length && keys.every((key): boolean => reviewMatchesPrompt(job, key, currentReviewPrompt(project, key)));
}

/** 仅识别已持久化的 Chat JSON 候选，用于来源展示，不生成或改写创作正文。 */
export function readSavedPromptCandidate(rawText: string | undefined): string | undefined {
  if (!rawText) return undefined;
  try {
    const value: unknown = JSON.parse(rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (value && typeof value === 'object' && 'optimized' in value && typeof value.optimized === 'string') return value.optimized;
  } catch { /* 无法证明来源时显示已有内容，不猜测为豆包新回复。 */ }
  return undefined;
}
