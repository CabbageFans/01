import { createHash, randomUUID } from 'node:crypto';
import type { PetStoryChatAdjustment, PetStoryConversationReply, PetStoryAssetBindings, PetStoryCapability, PetStoryChatJob, PetStoryMaterialEditIntent, PetStoryPlan, PetStoryPrompt, PetStoryPromptKind, PetStoryProject, PetStoryResult, PetStoryReviewIssue, PetStoryRuntimeTarget, Task, TaskAddParams } from '@doubao-studio/contracts';
import { orderedChatAssets, promptContextHashInput, PROMPT_RULES_VERSION, assetCharacterIds } from './petstoryPromptQuality';
import { PetStoryProjects } from './petstoryProject';
import { archiveCompletedPetStoryProduction } from './petstoryProductionLifecycle';
import { parsePetStoryAnswer, record, validatePetStoryPlan, runtimePromptIssues, normalizeAnalysisCuts } from './petstoryValidation';
import { confirmedCharacterIdentity, materialAsset, syncMaterials } from './petstoryMaterials';
import { pendingChatConflicts } from './petstoryPending';
import { inspectPromptCandidate, inspectPromptEligibility, promptContractFactsCurrent, promptWritingTarget } from './petstoryEligibility';
import { buildDramaRequest, previousAdoptedBoundary } from './petstoryRuntimeRequest';
import { reviewedPromptFinal, reviewMatchesPrompt } from './petstoryReview';
import { analysisCastIssues } from './petstoryCast';
import { reconcileAdoptedImages } from './petstoryImageReview';
import { hasConversationGuard } from './accountConversationGuard';

export interface PetStoryTaskPort {
  setConversationGuard?: (taskId: string, projectId: string, adjustmentId: string, active: boolean) => void;
  list: () => Task[];
  create: (params: TaskAddParams, accountId: string) => Task;
  reviseHeldPrompt?: (taskId: string, prompt: string) => Task;
  retryUnsubmitted?: (taskId: string) => Task;
}
const hash = (prompt: string): string => createHash('sha256').update(prompt).digest('hex');
/** 正文结果不会改变事实版本；用户的剧本、镜头设计、图片选择会使旧请求过期。 */
function runtimeContextHash(p: PetStoryProject): string {
  const shots = p.plan?.shots.map(({ prompts: _prompts, ...shot }): object => shot);
  return hash(JSON.stringify({ story: p.mobileStory, plan: p.plan ? { ...p.plan, shots } : undefined,
    profile: p.promptProfile, promptModel: p.promptModel, promptCapability: p.promptCapability, materials: p.materials?.map((m): object => ({ id: m.id, designHash: m.designHash, selectedAssetId: m.selectedAssetId, approved: m.approved })),
    assets: p.assets.map((a): object => ({ id: a.id, kind: a.kind, shotId: a.shotId, validation: a.validation, sourceVideo: a.sourceVideo })) }));
}
/** 起终文字是尾帧／视频的共同设计输入，与当前目标正文分开锁定。 */
function frameContextHash(p: PetStoryProject, target: PetStoryRuntimeTarget): string | undefined {
  if (!target.shotId || !['lastFrame', 'video'].includes(target.promptKind || '')) return undefined;
  const shot = p.plan?.shots.find((item): boolean => item.id === target.shotId);
  if (!shot) return undefined;
  const snapshot = (prompt: PetStoryPrompt | undefined): object | undefined => prompt ? { final: prompt.final, edited: prompt.edited, sourceJobId: prompt.sourceJobId } : undefined;
  return hash(JSON.stringify({ firstFrame: snapshot(shot.prompts.firstFrame), ...(target.promptKind === 'video' ? { lastFrame: snapshot(shot.prompts.lastFrame) } : {}) }));
}
/** 与请求共用同一纯投影，空边界也入快照，避免发送后新采用前镜造成隐式上下文变化。 */
function previousBoundaryHash(p: PetStoryProject, target: PetStoryRuntimeTarget): string | undefined {
  const shot = p.plan?.shots.find((item): boolean => item.id === target.shotId);
  return shot && target.promptKind ? hash(JSON.stringify(previousAdoptedBoundary(p, shot) || null)) : undefined;
}
function boundaryStillCurrent(p: PetStoryProject, job: PetStoryChatJob): boolean {
  return job.previousBoundaryHash === undefined || job.previousBoundaryHash === previousBoundaryHash(p, job);
}
function targetId(target: PetStoryRuntimeTarget): string | undefined { return target.materialId || (target.shotId && target.promptKind ? `${target.shotId}:${target.promptKind}` : undefined); }
function issueMatchesTarget(issue: PetStoryReviewIssue, target: PetStoryRuntimeTarget): boolean {
  return issue.targetId === targetId(target) || issue.targetId === target.shotId && (!issue.promptKind || issue.promptKind === target.promptKind);
}
/** 一次格式纠正保留原审查职责，局部修订仍绑定实际保存问题的回复 ID。 */
function isReviewResult(p: PetStoryProject, job: PetStoryChatJob): boolean {
  if (job.kind === 'review') return true;
  if (job.kind !== 'repair') return false;
  const original = p.jobs.find((item): boolean => item.id === job.parentJobId);
  return original?.kind === 'review' && !!original.requestId && original.sourceStoryId === job.sourceStoryId;
}
/** 审查只产生问题，不产生替代正文；只有后续创作会废弃同目标旧创作候选。 */
function supersedesRuntimeJob(p: PetStoryProject, previous: PetStoryChatJob, next: PetStoryChatJob): boolean {
  if (!next.requestId || [...(previous.expectedIds || [])].sort().join('\n') !== [...(next.expectedIds || [])].sort().join('\n')) return false;
  return isReviewResult(p, previous) || !isReviewResult(p, next);
}
function hasSupersedingJob(p: PetStoryProject, job: PetStoryChatJob): boolean {
  return p.jobs.slice(p.jobs.indexOf(job) + 1).some((next): boolean => supersedesRuntimeJob(p, job, next));
}
function promptFor(p: PetStoryProject, target: PetStoryRuntimeTarget): PetStoryPrompt | undefined {
  return target.materialId ? p.materials?.find((m): boolean => m.id === target.materialId)?.prompt : p.plan?.shots.find((s): boolean => s.id === target.shotId)?.prompts[target.promptKind || 'video'];
}
/** 同一镜头的首尾／视频共享状态，按整个镜头互斥；基础素材按稳定素材 ID 互斥。 */
function explicitPromptScope(p: PetStoryProject, kind: PetStoryChatJob['kind'], target: PetStoryRuntimeTarget): string | undefined {
  if (!['optimize', 'materialPrompt', 'review', 'revise', 'repair'].includes(kind)) return undefined;
  if (target.materialId && !target.shotId && !target.promptKind && p.materials?.some((material): boolean => material.id === target.materialId)) return `material:${target.materialId}`;
  if (!target.materialId && target.shotId && target.promptKind && promptFor(p, target)) return `shot:${target.shotId}`;
  return undefined;
}
/** 只容许正式暂停的不确定原运行留待只读核对；该判断不会完成、解绑或重发它。 */
function pausedOriginalChat(p: PetStoryProject, job: PetStoryChatJob, task: Task | undefined): boolean {
  if (!task || job.status !== 'bound' || !job.requestId || !job.runId || job.rawText || task.status !== 'paused' || task.errorInfo?.code !== 'submission_uncertain') return false;
  if (task.mode !== 'chat' || task.projectId !== p.studioProjectId || task.assignedAccountId !== p.accountId || hash(task.prompt) !== job.inputHash) return false;
  const runtime = task.runtime;
  return !!runtime?.submittedAt && runtime.runId === job.runId && runtime.input.mode === 'chat' && runtime.input.prompt === task.prompt
    && JSON.stringify(runtime.input.attachments || []) === JSON.stringify(task.attachments || []) && !runtime.chatResponse?.text && !task.outputs?.length;
}
function checkedJobTask(p: PetStoryProject, job: PetStoryChatJob, tasks: Task[]): Task {
  const task = tasks.find((item): boolean => item.id === job.taskId);
  if (!task || task.projectId !== p.studioProjectId || task.assignedAccountId !== p.accountId || task.mode !== 'chat' || hash(task.prompt) !== job.inputHash) throw new Error('原任务或输入归属不符，已停止');
  return task;
}
function isWaitingJob(job: PetStoryChatJob | undefined): job is PetStoryChatJob { return !!job && !job.endedWaitingAt; }
function canRepair(p: PetStoryProject, job: PetStoryChatJob): boolean {
  return !job.endedWaitingAt && (job.kind === 'analysis' || !!job.requestId && !['repair', 'revise'].includes(job.kind)) && !!p.mobileStory && job.sourceStoryId === p.mobileStory.id && p.source.status !== 'blocked' && repairInputsStillCurrent(p, job) && !p.jobs.some((j): boolean => j.kind === 'repair' && j.parentJobId === job.id);
}
/** 新合同比较创作事实；旧合同和审查仍保留原快照防线。 */
function contextStillCurrent(p: PetStoryProject, job: PetStoryChatJob, allowMissing: boolean = false): boolean {
  if (job.promptTask?.designHash && !isReviewResult(p, job)) return promptContractFactsCurrent(p, job);
  return allowMissing && job.contextHash === undefined || job.contextHash === runtimeContextHash(p);
}
/** 结构坏回复也必须先核对原请求依赖；不能因解析尚未进入 freshness 检查就额外发送修订。 */
function repairInputsStillCurrent(p: PetStoryProject, job: PetStoryChatJob): boolean {
  if (!job.requestId) return true;
  if (hasSupersedingJob(p, job)) return false;
  if (!contextStillCurrent(p, job, true)) return false;
  if (job.inputFinal !== undefined && promptFor(p, job)?.final !== job.inputFinal) return false;
  if (job.frameContextHash !== undefined && job.frameContextHash !== frameContextHash(p, job)) return false;
  return boundaryStillCurrent(p, job);
}
/** 已指出的 error 在唯一一次修订后仍未解决，只锁住该项原正文，不改写其内容。 */
function markUnresolvedRevision(p: PetStoryProject, job: PetStoryChatJob): void {
  if (job.kind !== 'revise' || job.resultStatus === 'stale') return;
  const review = p.jobs.find((item): boolean => item.id === job.parentJobId);
  const selectedError = review?.parsedResult?.issues?.some((issue): boolean => issue.severity === 'error' && !!job.selectedIssueIds?.includes(issue.id) && issueMatchesTarget(issue, job));
  const target = promptFor(p, job);
  if (selectedError && target && !target.edited && target.final === job.inputFinal) target.needsReview = true;
}
function reviewTargets(p: PetStoryProject, job: PetStoryChatJob): PetStoryRuntimeTarget[] {
  if (targetId(job)) return [job];
  return [...(p.materials || []).map((material): PetStoryRuntimeTarget => ({ materialId: material.id })),
    ...(p.plan?.shots || []).flatMap((shot): PetStoryRuntimeTarget[] => (['firstFrame', 'lastFrame', 'video'] as const)
      .filter((kind): boolean => !!shot.prompts[kind]).map((kind): PetStoryRuntimeTarget => ({ shotId: shot.id, promptKind: kind })))];
}
/** 仅标记送审快照仍等于当前 final 的目标；其他问题完整保留为历史。 */
function markCurrentReviewError(p: PetStoryProject, job: PetStoryChatJob, issues: PetStoryReviewIssue[], current: boolean): void {
  if (!current) return;
  for (const selection of reviewTargets(p, job)) {
    const key = targetId(selection); const prompt = promptFor(p, selection);
    if (!key || !prompt || prompt.edited || prompt.optimized && prompt.optimized !== prompt.final || !reviewMatchesPrompt(job, key, prompt.final)) continue;
    if (issues.some((issue): boolean => issue.severity === 'error' && issueMatchesTarget(issue, selection))) prompt.needsReview = true;
  }
}
/** 只保存公开控件事实，不把 IPC 额外字段或其他账号能力带入创作上下文。 */
function promptCapability(value: PetStoryCapability, accountId: string): PetStoryCapability {
  if (value.accountId !== accountId || !Number.isFinite(Date.parse(value.checkedAt)) || !Array.isArray(value.durations)
    || value.durations.some((duration: number): boolean => !Number.isFinite(duration) || duration <= 0)
    || !['visible', 'user_confirmed', 'unknown'].includes(value.freeEvidence)) throw new Error('文字创作能力记录必须对应项目原账号及有效检查结果');
  const entry = (item: PetStoryCapability['image']): PetStoryCapability['image'] => {
    if (!item || !['supported', 'unsupported', 'unknown', 'implementation_gap'].includes(item.state)
      || !['free', 'paid', 'exhausted', 'unknown'].includes(item.free) || typeof item.reason !== 'string') throw new Error('文字创作能力记录的入口状态无效');
    return { state: item.state, free: item.free, reason: item.reason };
  };
  const video = value.videoConfig;
  if (video && (!['seedance-2.5', 'seedance-2.0', 'seedance-2.0-fast', 'seedance-2.0-mini'].includes(video.model)
    || !/^(?:[4-9]|1[0-5])s$/.test(video.duration) || !['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'].includes(video.aspectRatio))) throw new Error('文字创作的模型、画幅或时长选择无效');
  return { accountId, checkedAt: value.checkedAt, freeEvidence: value.freeEvidence, durations: [...value.durations],
    image: entry(value.image), modes: { first_frame: entry(value.modes?.first_frame), first_last_frame: entry(value.modes?.first_last_frame), reference: entry(value.modes?.reference) },
    ...(video ? { videoConfig: { model: video.model, duration: video.duration, aspectRatio: video.aspectRatio } } : {}),
    ...(value.allowPlainReferences === true ? { allowPlainReferences: true } : {}) };
}
export interface PetStoryMaterialBinding { characterId: string; assetId: string }
/** 只检查可确定的引用与模式，不把文字检查冒充人物／视频语义质检。 */
export function checkFinalBindings(
  plan: PetStoryPlan, shotId: string, kind: PetStoryPromptKind,
  bindings: PetStoryMaterialBinding[], mode: 'image' | 'first_frame' | 'first_last_frame' | 'reference',
  frames: { first: boolean; last: boolean } = { first: false, last: false },
): string[] {
  const shot = plan.shots.find((s): boolean => s.id === shotId);
  if (!shot) return ['镜头不存在'];
  const errors: string[] = [];
  const final = shot.prompts[kind]?.final;
  if (!final?.trim()) errors.push('最终提示词为空');
  if (/@(?:Image|Video|Audio)\b/i.test(final || '')) errors.push('未验证的平台专用引用语法，请改用实际顺序的中文映射');
  if (bindings.length !== shot.characterIds.length) errors.push('角色参考图数量不匹配');
  shot.characterIds.forEach((id: string, index: number): void => {
    const expected = plan.characters.find((c): boolean => c.id === id)?.referenceAssetId;
    const actual = bindings[index];
    if (!expected || actual?.characterId !== id || actual.assetId !== expected) errors.push(`${id}参考图缺失、顺序不符或错绑`);
  });
  if (kind === 'video') {
    if (mode === 'image') errors.push('视频提示词与图片模式冲突');
    if (shot.requestedMode !== 'auto' && shot.requestedMode !== mode) errors.push('实际模式与请求模式不匹配，不能静默降级');
    if (mode === 'first_frame' && !frames.first) errors.push('缺少实际首帧');
    if (mode === 'first_last_frame' && (!frames.first || !frames.last || !shot.prompts.lastFrame)) errors.push('原生首尾帧缺少实际首／尾帧或提示词');
  } else if (mode !== 'image') errors.push('单帧提示词与模式冲突');
  if (kind === 'lastFrame' && !frames.first) errors.push('尾帧编辑缺少首帧依据');
  return errors;
}

/** 生成草稿与未来制作接线共用这一出口，绝不读取 original/optimized 替代 final。 */
export function finalTaskInput(plan: PetStoryPlan, shotId: string, kind: PetStoryPromptKind, attachments: string[], projectId: string, videoConfig?: Task['videoConfig']): TaskAddParams {
  const checked = validatePetStoryPlan(plan);
  const shot = checked.shots.find((s): boolean => s.id === shotId);
  const final = shot?.prompts[kind]?.final;
  if (!shot || !final?.trim()) throw new Error('最终提示词为空或镜头不存在');
  if (kind === 'video' && !Number.isInteger(shot.durationSeconds)) throw new Error('当前 Studio 时长只能映射实际可选整秒，已暂停且不改值');
  if (kind === 'video' && (!videoConfig || videoConfig.duration !== `${shot.durationSeconds}s`)) throw new Error('需要当前入口已核实且与镜头相符的视频参数，不设置猜测的模型或时长');
  return { prompts: [final], promptReadback: 'exact', mode: kind === 'video' ? 'video' : 'image', executionIntent: 'hold', attachments,
    projectId, videoConfig: kind === 'video' ? videoConfig : undefined };
}
function assertChatAvailable(p: PetStoryProject): void {
  if (hasConversationGuard(p.accountId) || p.chatAdjustment?.status === 'active') throw new Error('请先采用豆包回复或结束当前调整');
}
export class PetStoryChatService {
  constructor(private readonly projects: PetStoryProjects, private readonly tasks: PetStoryTaskPort) {}

  /** 正常补齐入口与投产共享资格判断；手改已有匹配候选时等待采用，不反复生成。 */
  /** 仅在用户确认后应用实际选中的完整回复；原任务只作为已发送规则上下文来源。 */
  applyConversationReply(p: PetStoryProject, adjustment: PetStoryChatAdjustment, reply: PetStoryConversationReply): void {
    const source = p.jobs.find((j): boolean => j.id === adjustment.sourceJobId);
    if (!source?.requestId || !source.requestText || !source.rulesVersion || !source.promptTask && (adjustment.target.materialId || adjustment.target.shotId)) throw new Error('原会话缺少本项创作依据，请先通过豆包生成本项提示词');
    const job: PetStoryChatJob = { ...structuredClone(source), id: randomUUID(), ...adjustment.target, inputFinal: adjustment.target.materialId ? p.materials?.find((m): boolean => m.id === adjustment.target.materialId)?.prompt.final : p.plan?.shots.find((s): boolean => s.id === adjustment.target.shotId)?.prompts[adjustment.target.promptKind || 'video']?.final,
      rawText: reply.text, status: 'applied', resultStatus: 'candidate', createdAt: new Date().toISOString(), endedWaitingAt: undefined,
      conversationReply: { adjustmentId: adjustment.id, conversationUrl: adjustment.conversationUrl, reply: structuredClone(reply) } };
    if (!adjustment.target.materialId && !adjustment.target.shotId) {
      let answer: Record<string, unknown>;
      try { answer = parsePetStoryAnswer(reply.text); } catch { throw new Error('这条回复还不能形成完整方案，请在豆包中将满意内容整理为完整分镜方案后再选择'); }
      this.applyStory(p, answer, true, job); job.parsedResult = { plan: structuredClone(p.plan), contentBasis: p.contentBasis }; job.resultStatus = 'adopted'; p.jobs.push(job); return;
    }
    let body = reply.text;
    try { const answer = parsePetStoryAnswer(reply.text); if (typeof answer.optimized === 'string') body = answer.optimized; } catch { /* 完整自然语言正文原样保留，不用程序补写。 */ }
    job.parsedResult = { optimized: body };
    const issues = runtimePromptIssues(p, job, body);
    if (issues.length) throw new Error(`这条回复还需在豆包中整理：${issues[0]}`);
    const checked = { ...p, jobs: [...p.jobs, job] };
    const qualification = inspectPromptCandidate(checked, job);
    if (!qualification.writingReady) throw new Error(`这条回复与当前制作依据不符，请在豆包中整理：${qualification.reasons[0]}`);
    if (body.length < 100 && /[？?]\s*$/.test(body)) throw new Error('这条回复包含追问，请在豆包中整理为完整提示词后再采用');
    const target = promptFor(p, adjustment.target);
    if (!target) throw new Error('调整对象已不存在');
    target.final = body; target.optimized = body; target.edited = false; target.needsReview = undefined; target.sourceJobId = job.id; target.candidateJobId = job.id;
    target.rulesVersion = source.rulesVersion; target.promptTask = structuredClone(source.promptTask); job.resultStatus = 'adopted'; p.jobs.push(job);
  }

  async promptStageTargets(id: string, revision: number): Promise<PetStoryResult> {
    const p = await this.projects.read(id);
    if (p.revision !== revision || !p.plan) throw new Error('项目已变化或尚无采用镜头设计');
    const pendingCandidateJobIds: string[] = [];
    const missing = (target: PetStoryRuntimeTarget): boolean => {
      const prompt = promptFor(p, target);
      if (!prompt) return true;
      const writingTarget = promptWritingTarget(p, target);
      const candidate = p.jobs.find((job): boolean => job.id === prompt.candidateJobId && job.status === 'applied' && job.resultStatus === 'candidate');
      if (candidate?.promptTask && candidate.parsedResult?.optimized) {
        const hypothetical = structuredClone(p);
        const adopted = hypothetical.jobs.find((job): boolean => job.id === candidate.id);
        if (adopted) adopted.resultStatus = 'adopted';
        const result = inspectPromptEligibility(hypothetical, { ...prompt, final: candidate.parsedResult.optimized, rulesVersion: candidate.rulesVersion || prompt.rulesVersion,
          edited: false, sourceJobId: candidate.id, promptTask: candidate.promptTask, editIntent: candidate.editIntent, needsReview: undefined }, writingTarget);
        if (result.writingReady) { pendingCandidateJobIds.push(candidate.id); return false; }
      }
      return !inspectPromptEligibility(p, prompt, writingTarget).writingReady;
    };
    const materials = (p.materials || []).filter((material): boolean => !material.approved && missing({ materialId: material.id }));
    const targets: NonNullable<PetStoryResult['promptTargets']> = materials.map((material): { materialId: string } => ({ materialId: material.id }));
    let previousBoundaryQueued = false;
    if (!materials.length) for (const shot of [...p.plan.shots].sort((a, b): number => a.order - b.order)) {
      let upstreamQueued = previousBoundaryQueued;
      let boundaryQueued = false;
      for (const kind of ['firstFrame', ...(shot.prompts.lastFrame || shot.requestedMode === 'first_last_frame' ? ['lastFrame' as const] : []), 'video'] as const) {
        // 新采用的帧会改变下游正文依赖；同一授权批次需一并补齐，不能沿用旧帧合同。
        if (upstreamQueued || missing({ shotId: shot.id, promptKind: kind })) {
          targets.push({ shotId: shot.id, kind }); upstreamQueued = true;
          if (kind === 'lastFrame' || kind === 'video') boundaryQueued = true;
        }
      }
      previousBoundaryQueued = boundaryQueued;
    }
    return { success: true, project: p, promptTargets: targets, pendingCandidateJobIds };
  }

  async prepareRuntime(id: string, revision: number, kind: PetStoryChatJob['kind'], target: PetStoryRuntimeTarget = {}): Promise<PetStoryResult> {
    let p = await this.projects.read(id);
    assertChatAvailable(p);
    if (p.revision !== revision) throw new Error('项目版本已变化，请刷新后生成');
    if (!p.mobileStory?.text.trim()) throw new Error('请先保存当前剧本原文');
    if (!['analysis', 'assets', 'optimize', 'materialPrompt', 'review', 'revise', 'repair'].includes(kind)) throw new Error('运行时创作阶段无效');
    archiveCompletedPetStoryProduction(p);
    if (p.production) throw new Error('原制作方案仍在使用中，请先处理原任务');
    const parent = target.parentJobId ? p.jobs.find((j): boolean => j.id === target.parentJobId) : undefined;
    this.validateRuntimeTarget(p, kind, target, parent);
    if (kind === 'repair') this.validateRuntimeRepair(p, parent);
    const effectiveTarget = this.effectiveRuntimeTarget(kind, target, parent);
    this.assertRuntimeChatAvailable(p, kind, effectiveTarget);
    if (effectiveTarget.editIntent) effectiveTarget.editIntent = this.materialEditIntent(p, effectiveTarget);
    if (effectiveTarget.capability) p.promptCapability = promptCapability(effectiveTarget.capability, p.accountId);
    else if (p.promptCapability) p.promptCapability = promptCapability(p.promptCapability, p.accountId);
    effectiveTarget.capability = p.promptCapability;
    const requestId = randomUUID();
    // 旧版任务未独立保存请求时，从正式 Task 输入取回；修订不凭模型记忆重建原任务。
    const parentInput = parent ? { ...parent, requestText: parent.requestText || this.tasks.list().find((task): boolean => task.id === parent.taskId)?.prompt } : undefined;
    const request = buildDramaRequest(p, { kind, requestId, ...effectiveTarget, parentJob: parentInput });
    if (!request.prompt.trim() || request.prompt.length > 250_000 || !request.expectedIds.length || new Set(request.expectedIds).size !== request.expectedIds.length) throw new Error('运行时请求正文或目标集合无效');
    const attachments = await this.projects.attachments({ ...p, assets: request.assets });
    if (this.tasks.list().some((t): boolean => t.projectId === p.studioProjectId && t.mode === 'chat' && hash(t.prompt) === hash(request.prompt) && !p.jobs.some((j): boolean => j.taskId === t.id))) throw new Error('相同输入已有未绑定任务，请核对原 hold 任务');
    const task = this.tasks.create({ prompts: [request.prompt], promptReadback: 'exact', mode: 'chat', executionIntent: 'hold', attachments, projectId: p.studioProjectId }, p.accountId);
    const selected = promptFor(p, effectiveTarget);
    const reviewRepair = kind === 'repair' && parent && isReviewResult(p, parent);
    const job: PetStoryChatJob = { id: randomUUID(), taskId: task.id, kind, status: 'bound', ...effectiveTarget,
      inputHash: hash(task.prompt), sourceUrl: p.source.url, sourceStoryId: p.mobileStory.id, requestId,
      stage: request.stage, rulesVersion: request.rulesVersion, ruleFiles: request.ruleFiles, expectedIds: request.expectedIds,
      createdAt: new Date().toISOString(), inputRevision: p.revision, contextHash: runtimeContextHash(p),
      inputEdited: reviewRepair ? parent.inputEdited : selected?.edited, inputFinal: reviewRepair ? parent.inputFinal : selected?.final, requestText: task.prompt, promptTask: request.promptTask,
      reviewInputFinals: request.reviewInputFinals,
      analysisCastBindings: request.analysisCastBindings,
      frameContextHash: frameContextHash(p, effectiveTarget), previousBoundaryHash: previousBoundaryHash(p, effectiveTarget) };
    p.jobs.push(job);
    if (p.promptBatch?.status === 'running') p.promptBatch.jobId = job.id;
    p = await this.projects.write(p);
    return { success: true, project: p, taskId: task.id, attachments };
  }

  private assertRuntimeChatAvailable(p: PetStoryProject, kind: PetStoryChatJob['kind'], target: PetStoryRuntimeTarget): void {
    const tasks = this.tasks.list();
    if (tasks.some((task): boolean => task.assignedAccountId === p.accountId && ['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'].includes(task.status))) throw new Error('原账号仍有活动任务，请先等待或处理原运行');
    const pending = pendingChatConflicts(p, target);
    if (!pending.length) return;
    const scope = explicitPromptScope(p, kind, target);
    const independentPaused = scope && pending.every((job): boolean => {
      const previousScope = explicitPromptScope(p, job.kind, job);
      return !!previousScope && previousScope !== scope && job.expectedIds?.length === 1 && job.expectedIds[0] === targetId(job)
        && pausedOriginalChat(p, job, tasks.find((task): boolean => task.id === job.taskId));
    });
    if (!independentPaused) throw new Error('已有待收取原任务；请读取原结果，不得重复创建同目标或全局任务');
  }

  private effectiveRuntimeTarget(kind: PetStoryChatJob['kind'], target: PetStoryRuntimeTarget, parent?: PetStoryChatJob): PetStoryRuntimeTarget {
    if (kind === 'repair' && parent) return { shotId: parent.shotId, promptKind: parent.promptKind, materialId: parent.materialId, parentJobId: parent.id,
      selectedIssueIds: parent.selectedIssueIds ? [...parent.selectedIssueIds] : undefined, reviewFocus: parent.reviewFocus, editIntent: parent.editIntent, capability: target.capability || parent.capability };
    const effective = { ...target };
    if (kind === 'revise' && parent) effective.selectedIssueIds = this.revisionIssueSelection(parent, target);
    if (kind === 'review') effective.reviewFocus = this.normalizedReviewFocus(target.reviewFocus);
    return effective;
  }

  private validateRuntimeTarget(p: PetStoryProject, kind: PetStoryChatJob['kind'], target: PetStoryRuntimeTarget, parent?: PetStoryChatJob): void {
    if (target.editIntent && kind !== 'materialPrompt') throw new Error('变体／局部编辑计划只能用于选中基础素材的文字创作');
    if (target.selectedIssueIds !== undefined && kind !== 'revise') throw new Error('问题选择只能用于本次明确的局部修订');
    if (target.reviewFocus !== undefined && kind !== 'review') throw new Error('核对疑点只能用于内容审查，不能作为创作或修订指令');
    if (kind === 'revise') {
      const key = targetId(target);
      if (!key || !parent || !isReviewResult(p, parent) || parent.status !== 'applied' || parent.resultStatus === 'stale' || parent.sourceStoryId !== p.mobileStory?.id
        || !parent.parsedResult?.issues?.some((issue): boolean => issueMatchesTarget(issue, target))) throw new Error('局部修订必须指向本故事审查中的具体目标问题');
      const reviewedFinal = reviewedPromptFinal(parent, key);
      if (reviewedFinal === undefined) throw new Error('原审查缺少本目标的逐项正文快照，仅保留历史；请重新审查当前采用正文');
      if (reviewedFinal !== promptFor(p, target)?.final) throw new Error('审查所对应正文已经变化，请先审查当前采用正文，再选择新一轮修订');
      if (parent.contextHash !== runtimeContextHash(p)) throw new Error('审查依赖的确认事实已经变化，请重新审查当前状态');
    }
    if ((kind === 'optimize' || kind === 'materialPrompt' || kind === 'revise') && !promptFor(p, target)) throw new Error('创作目标不存在');
  }

  private normalizedReviewFocus(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new Error('核对疑点必须为文本');
    const focus = value.trim();
    if (focus.length > 2000) throw new Error('核对疑点最多 2000 字符，请缩小核对范围');
    return focus || undefined;
  }

  private revisionIssueSelection(parent: PetStoryChatJob, target: PetStoryRuntimeTarget): string[] {
    const issues = (parent.parsedResult?.issues || []).filter((issue): boolean => issueMatchesTarget(issue, target));
    const requested = target.selectedIssueIds;
    if (requested === undefined) {
      const required = issues.filter((issue): boolean => issue.severity === 'error').map((issue): string => issue.id);
      if (!required.length) throw new Error('本目标没有必须修订的 error；如需采用内容建议，请明确选择要修订的问题');
      return required;
    }
    if (!Array.isArray(requested) || !requested.length || requested.some((id: unknown): boolean => typeof id !== 'string' || !id.trim()) || new Set(requested).size !== requested.length) throw new Error('请选择非空且不重复的审查问题 ID');
    if (requested.some((id): boolean => !issues.some((issue): boolean => issue.id === id))) throw new Error('所选问题不属于父审查的本次目标，不能扩大修订范围');
    return [...requested];
  }

  private materialEditIntent(p: PetStoryProject, target: PetStoryRuntimeTarget): PetStoryMaterialEditIntent {
    const intent = target.editIntent;
    if (!intent || !target.materialId || target.shotId || target.promptKind) throw new Error('请选择具体基础素材与待编辑图片');
    const base = materialAsset(p, target.materialId, false);
    if (intent.baseAssetId !== base.id) throw new Error('编辑基准图已变化，请重新选择当前具体图片');
    for (const field of ['changes', 'preserve', 'validity'] as const) if (typeof intent[field] !== 'string' || !intent[field].trim() || intent[field].length > 20_000) throw new Error('编辑计划必须写明变化、保留内容及适用范围');
    return { baseAssetId: base.id, changes: intent.changes, preserve: intent.preserve, validity: intent.validity };
  }

  private validateRuntimeRepair(p: PetStoryProject, parent?: PetStoryChatJob): void {
    if (parent?.kind === 'revise') throw new Error('本目标已使用一次内容修订；保留失败候选与原因，不再追加自动格式或内容修订');
    if (!parent?.requestId || parent.kind === 'repair' || parent.status !== 'invalid' || !parent.rawText || parent.sourceStoryId !== p.mobileStory?.id) throw new Error('仅允许对本次原回复的具体缺项修订一次');
    if (p.jobs.some((j): boolean => j.kind === 'repair' && j.parentJobId === parent.id)) throw new Error('自动修订已使用一次');
    if (!boundaryStillCurrent(p, parent)) throw new Error('前镜已采用边界发生变化，请基于当前共同状态重新生成，不能修订旧请求');
    if (!repairInputsStillCurrent(p, parent)) throw new Error('原请求依赖的剧本、镜头、已采用帧或正文已变化；保留原回复，请按当前状态重新生成，不能修订旧请求');
  }

  private repairParent(p: PetStoryProject, parentJobId?: string): PetStoryChatJob {
    const parent = p.jobs.find((j): boolean => j.id === parentJobId);
    if (!parent || parent.kind !== 'analysis' || parent.status !== 'invalid' || !parent.rawText || parent.sourceUrl !== p.source.url || parent.sourceStoryId !== p.mobileStory?.id || p.source.status === 'blocked') throw new Error('仅允许对本次结构错误的分析进行一次格式纠正');
    if (p.jobs.some((j): boolean => j.parentJobId === parentJobId && j.kind === 'repair')) throw new Error('格式纠正已使用一次，不能再次请求');
    return parent;
  }

  async prepare(id: string, prompt: string, kind: PetStoryChatJob['kind'], parentJobId?: string, shotId?: string, promptKind?: PetStoryPromptKind, materialId?: string): Promise<PetStoryResult> {
    let p = await this.projects.read(id);
    assertChatAvailable(p);
    archiveCompletedPetStoryProduction(p);
    if (p.production) throw new Error('P4 已确认制作方案，暂不修改已授权的最终提示词');
    if (!prompt.trim() || prompt.length > 100_000) throw new Error('需要有效来源与合理长度的请求正文');
    if (!p.mobileStory?.text.trim()) throw new Error('请先复制手机豆包提示词，在手机端取得故事情节后粘贴并保存；桌面端不再读取抖音视频');
    if (!['analysis', 'repair', 'optimize', 'materialPrompt'].includes(kind)) throw new Error('Chat 请求类型无效');
    if (p.jobs.some((j): boolean => j.status === 'bound' || j.status === 'captured')) throw new Error('已有待收取原任务；请读取原结果，不得重复创建');
    const parent = kind === 'repair' ? this.repairParent(p, parentJobId) : undefined;
    if (kind === 'analysis' && p.jobs.some((j): boolean => j.kind === 'analysis' && j.sourceUrl === p.source.url && j.sourceStoryId === p.mobileStory?.id)) throw new Error('该故事已绑定分析任务，请收取原结果或使用一次纠正');
    const snapshot = this.promptSnapshot(p, kind, shotId, promptKind, materialId);
    const selectedAssets = orderedChatAssets(p, kind === 'optimize' ? shotId : undefined);
    const attachments = await this.projects.attachments({ ...p, assets: selectedAssets });
    if (this.tasks.list().some((t): boolean => t.projectId === p.studioProjectId && t.mode === 'chat' && hash(t.prompt) === hash(prompt) && !p.jobs.some((j): boolean => j.taskId === t.id))) {
      throw new Error('相同输入已有未绑定任务；请核对 Studio 中的原 hold 任务，不得重新创建或自动发送');
    }
    // 先建 hold 任务，再落盘绑定；写盘不确定时调用方不会拿到启动授权。
    const task = this.tasks.create({ prompts: [prompt], promptReadback: 'exact', mode: 'chat', executionIntent: 'hold', attachments, projectId: p.studioProjectId }, p.accountId);
    const job: PetStoryChatJob = { id: randomUUID(), taskId: task.id, kind, status: 'bound', parentJobId: parent?.id,
      shotId, promptKind, materialId, inputHash: hash(task.prompt), sourceUrl: p.source.url, sourceStoryId: p.mobileStory.id,
      ...snapshot };
    p.jobs.push(job);
    p = await this.projects.write(p);
    return { success: true, project: p, taskId: task.id, attachments };
  }

  private promptSnapshot(p: PetStoryProject, kind: PetStoryChatJob['kind'], shotId?: string, promptKind?: PetStoryPromptKind, materialId?: string): Pick<PetStoryChatJob, 'inputEdited' | 'inputFinal' | 'contextHash'> {
    if (kind === 'materialPrompt') {
      const material = p.materials?.find((m): boolean => m.id === materialId);
      if (!material) throw new Error('请选择本项目的基础素材');
      return { inputEdited: material.prompt.edited, inputFinal: material.prompt.final, contextHash: hash(JSON.stringify({ id: material.id, designHash: material.designHash })) };
    }
    if (kind !== 'optimize') return {};
    const target = p.plan?.shots.find((s): boolean => s.id === shotId);
    if (!target || !promptKind || !target.prompts[promptKind]) throw new Error('请选择现有镜头及提示词');
    const prompt = target.prompts[promptKind];
    return { inputEdited: prompt.edited, inputFinal: prompt.final, contextHash: hash(JSON.stringify(promptContextHashInput(p, shotId))) };
  }

  async bindRun(id: string, jobId: string, runId: string): Promise<PetStoryResult> {
    const p = await this.projects.read(id);
    const job = p.jobs.find((j): boolean => j.id === jobId);
    const task = this.tasks.list().find((t): boolean => t.id === job?.taskId);
    if (!p.mobileStory || job?.sourceStoryId !== p.mobileStory.id) throw new Error('旧版链接直读或故事已变化，不得启动原请求；请保存手机豆包故事');
    if (!isWaitingJob(job) || job.status !== 'bound' || !task || task.runtime?.runId !== runId || task.mode !== 'chat' || task.assignedAccountId !== p.accountId || task.projectId !== p.studioProjectId || hash(task.prompt) !== job.inputHash) throw new Error('原运行与任务绑定不符，未授权页面操作');
    if (job.runId && job.runId !== runId) throw new Error('本步骤已绑定其他运行，不得替换或重发');
    if (!task.runtime.submittedAt && job.requestId && !repairInputsStillCurrent(p, job)) throw new Error('原待发送文字请求的模型、事实或采用边界已经变化，请保留原任务并按当前状态重新生成；未发送');
    job.runId = runId;
    return { success: true, project: await this.projects.write(p) };
  }

  async endWaiting(id: string, revision: number, jobId: string): Promise<PetStoryResult> {
    const p = await this.projects.read(id);
    const job = p.jobs.find((item): boolean => item.id === jobId);
    if (p.revision !== revision || !job || !['bound', 'captured'].includes(job.status)) throw new Error('请选择当前未决原任务');
    job.endedWaitingAt ||= new Date().toISOString();
    if (p.promptBatch?.jobId === job.id) p.promptBatch.status = 'paused';
    return { success: true, project: await this.projects.write(p) };
  }

  async retryUnsubmitted(id: string, jobId: string): Promise<PetStoryResult> {
    let p = await this.projects.read(id);
    const job = p.jobs.find((j): boolean => j.id === jobId);
    const task = this.tasks.list().find((t): boolean => t.id === job?.taskId);
    if (!isWaitingJob(job) || !p.mobileStory || job.sourceStoryId !== p.mobileStory.id || job.status !== 'bound' || job.rawText || job.sourceUrl !== p.source.url || !task || task.mode !== 'chat'
      || task.projectId !== p.studioProjectId || task.assignedAccountId !== p.accountId || hash(task.prompt) !== job.inputHash
      || !task.runtime || (job.runId && task.runtime.runId !== job.runId) || task.runtime.input.prompt !== task.prompt
      || JSON.stringify(task.runtime.input.attachments) !== JSON.stringify(task.attachments || [])) throw new Error('原任务／运行归属不符，禁止重试');
    if (!['fail', 'paused', 'cancelled', 'waiting_verification'].includes(task.status) || !['video_prompt_not_ready', 'video_assets_not_ready', 'chat_assets_not_ready', 'page_unrecognized', 'page_loading', 'page_changed', 'authentication_unconfirmed', 'cancelled'].includes(task.errorInfo?.code || '')
      || task.runtime.submittedAt || task.runtime.acceptanceObservation || task.runtime.chatResponse || task.outputs?.length) throw new Error('仅附件或页面就绪阶段且明确未提交的原任务允许重试；已提交或不确定时只读核对');
    if (!this.tasks.retryUnsubmitted) throw new Error('原任务恢复入口不可用');
    // 旧失败运行保留在 TaskService 历史中。先持久化解除旧绑定，再将同一任务设为 hold；任一步失败均不分派。
    job.runId = undefined;
    p = await this.projects.write(p);
    const queued = this.tasks.retryUnsubmitted(task.id);
    if (queued.status !== 'queued' || queued.executionIntent !== 'hold') throw new Error('原任务未安全回到待执行状态，已停止');
    return { success: true, project: p, taskId: task.id };
  }

  async collect(id: string, jobId: string): Promise<PetStoryResult> {
    let p = await this.projects.read(id);
    let job = p.jobs.find((j): boolean => j.id === jobId);
    if (!job) throw new Error('任务未绑定到当前项目');
    if (job.status === 'applied') return { success: true, project: p };
    const task = checkedJobTask(p, job, this.tasks.list());
    if (!task.runtime?.submittedAt || !task.runtime.chatResponse?.text || task.runtime.input.prompt !== task.prompt) throw new Error('原任务尚无已保存的最终正文；保留原会话，不得重发');
    if (job.sourceUrl !== p.source.url || !job.runId || job.runId !== task.runtime.runId) throw new Error('来源或原运行 ID 发生变化，禁止混用回复');
    job.rawText = task.runtime.chatResponse.text;
    job.runId = task.runtime.runId;
    job.status = 'captured';
    // 原文先单独原子保存；解析失败也不会丢正文、伪造任务成功或自动重发。
    p = await this.projects.write(p);
    job = p.jobs.find((j): boolean => j.id === jobId);
    if (!job?.rawText) throw new Error('已保存原文回读缺失，停止且不重发');
    try {
      const answer = parsePetStoryAnswer(job.rawText);
      if (job.requestId && typeof answer.optimized === 'string') job.parsedResult = { optimized: answer.optimized };
      if (job.requestId) this.applyRuntime(p, job, answer);
      else if (job.endedWaitingAt) { job.parsedResult = typeof answer.optimized === 'string' ? { optimized: answer.optimized } : undefined; job.resultStatus = 'candidate'; }
      else if (!p.mobileStory || job.sourceStoryId !== p.mobileStory.id) throw new Error('旧版链接直读或其他故事的回复仅保留原文，请粘贴手机豆包故事后生成制作方案');
      else if (job.kind === 'materialPrompt') this.applyMaterialPrompt(p, job, answer);
      else if (job.kind === 'optimize') this.applyOptimization(p, job, answer);
      else { if (answer.storyUsable === false) p.source = { ...p.source, status: 'blocked', reason: typeof answer.reason === 'string' ? answer.reason : '故事内容不足，请补充剧情后重新分析' }; const candidate = structuredClone(p); this.applyStory(candidate, answer, true, job); job.parsedResult = { plan: candidate.plan, contentBasis: candidate.contentBasis }; job.resultStatus = 'candidate'; }
      job.status = 'applied';
      job.error = undefined;
      job.validationIssues = undefined;
      return { success: true, project: await this.projects.write(p) };
    } catch (error: unknown) {
      job.status = 'invalid';
      job.error = error instanceof Error ? error.message : '解析失败';
      job.validationIssues = job.validationIssues?.length ? job.validationIssues : [job.error];
      markUnresolvedRevision(p, job);
      const needsRepair = canRepair(p, job);
      return { success: false, project: await this.projects.write(p), error: job.error, needsRepair };
    }
  }

  private applyRuntime(p: PetStoryProject, job: PetStoryChatJob, answer: Record<string, unknown>): void {
    if (answer.requestId !== job.requestId || !Array.isArray(answer.targetIds) || answer.targetIds.some((v: unknown): boolean => typeof v !== 'string')
      || new Set(answer.targetIds).size !== answer.targetIds.length || [...answer.targetIds].sort().join('\n') !== [...(job.expectedIds || [])].sort().join('\n')) throw new Error('本次回复 requestId 或目标 ID 集合不符；不使用旧正文补齐');
    const parent = job.kind === 'repair' ? p.jobs.find((j): boolean => j.id === job.parentJobId) : undefined;
    const kind = parent?.kind || job.kind;
    const current = this.markRuntimeFreshness(p, job);
    if (kind === 'analysis') {
      if (current && answer.storyUsable === false) p.source = { ...p.source, status: 'blocked', reason: typeof answer.reason === 'string' ? answer.reason : '故事内容不足，请补充剧情后重新分析' };
      const candidateProject = structuredClone(p);
      this.applyStory(candidateProject, answer, false, job);
      job.parsedResult = { plan: candidateProject.plan, contentBasis: candidateProject.contentBasis };
      const issues = job.analysisCastBindings && candidateProject.plan ? analysisCastIssues(candidateProject.plan, job.analysisCastBindings) : [];
      if (issues.length) { job.validationIssues = issues; throw new Error(issues[0]); }
      // 分析结果先展示为方案候选，采用和制作确认由用户分别决定。
      return;
    }
    if (kind === 'assets') {
      const assets = this.readAssetBindings(p, answer);
      job.parsedResult = { assets };
      // 资产关系调整先保存为候选，不覆盖当前已采用方案。
      return;
    }
    if (kind === 'review') {
      job.parsedResult = { issues: this.readReviewIssues(p, job, answer.issues) };
      if (!job.endedWaitingAt) markCurrentReviewError(p, job, job.parsedResult.issues || [], current);
      return;
    }
    if (!['optimize', 'materialPrompt', 'revise'].includes(kind)) throw new Error('本次回复阶段无效');
    this.applyRuntimePrompt(p, job, answer);
  }

  private markRuntimeFreshness(p: PetStoryProject, job: PetStoryChatJob): boolean {
    const newer = hasSupersedingJob(p, job);
    const selected = promptFor(p, job);
    const editedDuringRequest = job.inputFinal !== undefined && selected?.final !== job.inputFinal;
    const frameChanged = job.frameContextHash !== undefined && job.frameContextHash !== frameContextHash(p, job);
    const previousChanged = !boundaryStillCurrent(p, job);
    const factsCurrent = contextStillCurrent(p, job);
    const current = !newer && !editedDuringRequest && !frameChanged && !previousChanged && job.sourceStoryId === p.mobileStory?.id && factsCurrent;
    job.resultStatus = current ? 'candidate' : 'stale';
    job.staleReason = current ? undefined : newer ? '同一目标已有更新请求；旧回复仅保留为过期候选' : editedDuringRequest ? '请求发出后用户已修改本项 final；旧回复仅保留为过期候选，不覆盖用户新版本' : frameChanged ? '请求发出后已采用首帧或尾帧正文发生变化；旧回复仅保留为过期候选，请按当前共同状态重新生成' : previousChanged ? '请求发出后前镜已采用边界发生变化；旧回复仅保留为过期候选，请按当前连续状态重新生成' : '请求发出后剧本、镜头设计或图片事实已变化；仅保留原始回复与候选，不覆盖当前正文';
    return current;
  }

  private applyRuntimePrompt(p: PetStoryProject, job: PetStoryChatJob, answer: Record<string, unknown>): void {
    if (typeof answer.optimized !== 'string' || !answer.optimized.trim()) throw new Error('本次回复缺少完整创作正文');
    // 候选先完整留存；校验失败不能丢弃模型正文，也不能覆盖当前 final。
    job.parsedResult = { optimized: answer.optimized };
    // 过期回复不再按已经变化的当前台词／素材判错，也不据此自动发起新创作。
    if (job.resultStatus === 'stale') return;
    const issues = runtimePromptIssues(p, job, answer.optimized);
    if (issues.length) { job.validationIssues = issues; throw new Error(issues.join('\n')); }
    const target = promptFor(p, job);
    if (!target) { job.resultStatus = 'stale'; job.staleReason = '目标已删除，仅保留候选'; }
    if (job.resultStatus === 'stale' || !target) return;
    if (job.endedWaitingAt) return;
    target.optimized = answer.optimized; target.candidateJobId = job.id;
    // 新正文仅更新候选；用户采用后才更换 final 和来源记录。
  }

  private readAssetBindings(p: PetStoryProject, answer: Record<string, unknown>): PetStoryAssetBindings {
    if (!p.plan || !Array.isArray(answer.shotBindings)) throw new Error('补齐资产需要当前镜头及完整 shotBindings');
    const bindings = answer.shotBindings.map((v: unknown): Record<string, unknown> => record(v));
    const ids = bindings.map((b): unknown => b.shotId);
    if (new Set(ids).size !== ids.length || [...ids].sort().join('\n') !== p.plan.shots.map((s): string => s.id).sort().join('\n')) throw new Error('资产关系必须逐项对应原镜头 ID，不拆镜或丢镜');
    this.validateSelectedAssetEntities(p, answer);
    const candidate = { ...structuredClone(p.plan), characters: answer.characters, props: answer.props, scenes: answer.scenes,
      understanding: answer.understanding ?? p.plan.understanding, sceneDesign: answer.sceneDesign ?? p.plan.sceneDesign,
      shots: p.plan.shots.map((shot): object => {
        const b = bindings.find((b): boolean => b.shotId === shot.id);
        if (!b) throw new Error('资产关系缺少原镜头');
        if (!Array.isArray(b.characterIds) || shot.characterIds.some((id): boolean => !(b.characterIds as unknown[]).includes(id))) throw new Error('补齐资产不能删除或替换当前镜头出场角色；必要新角色可以追加');
        if (shot.propIds?.length && (!Array.isArray(b.propIds) || shot.propIds.some((id): boolean => !(b.propIds as unknown[]).includes(id)))) throw new Error('补齐资产不能删除或替换当前镜头已有道具；必要新道具可以追加');
        if (shot.sceneId && b.sceneId !== shot.sceneId) throw new Error('补齐资产不能静默更换当前镜头场景 ID');
        const extra: Record<string, unknown> = {};
        for (const key of ['sourceRefs', 'narrativePurpose', 'framing', 'blocking', 'performance', 'sound', 'timing', 'continuity'] as const) extra[key] = shot[key] || b[key];
        if (!shot.dialogue?.length && b.dialogue !== undefined) {
          if (!Array.isArray(b.dialogue)) throw new Error('补齐台词必须为数组');
          for (const line of b.dialogue) {
            const d = record(line);
            if (typeof d.text !== 'string' || !d.text.trim() || !p.mobileStory?.text.includes(d.text)) throw new Error('补齐台词必须逐字来自当前剧本原文');
          }
        }
        return { ...shot, ...extra, characterIds: b.characterIds, propIds: b.propIds, propStates: b.propStates, sceneId: b.sceneId, sceneView: shot.sceneView || b.sceneView,
          dialogue: shot.dialogue?.length ? shot.dialogue : b.dialogue ?? shot.dialogue };
      }) };
    const validated = validatePetStoryPlan(candidate);
    return { characters: validated.characters, props: validated.props || [], scenes: validated.scenes || [], understanding: validated.understanding, sceneDesign: validated.sceneDesign,
      shotBindings: validated.shots.map((s): PetStoryAssetBindings['shotBindings'][number] => ({ shotId: s.id, characterIds: s.characterIds, propIds: s.propIds || [], propStates: s.propStates || [], sceneId: s.sceneId || '', sceneView: s.sceneView,
        dialogue: s.dialogue, sourceRefs: s.sourceRefs, narrativePurpose: s.narrativePurpose, framing: s.framing, blocking: s.blocking, performance: s.performance, sound: s.sound, timing: s.timing, continuity: s.continuity })) };
  }

  private validateSelectedAssetEntities(p: PetStoryProject, answer: Record<string, unknown>): void {
    for (const material of p.materials || []) {
      if (!material.selectedAssetId && !material.approved) continue;
      const entities = answer[material.kind === 'character' ? 'characters' : material.kind === 'prop' ? 'props' : 'scenes'];
      if (!Array.isArray(entities) || !entities.some((entity: unknown): boolean => record(entity).id === material.entityId)) throw new Error('补齐资产不能删除或重命名已选图片或已确认素材的实体 ID');
    }
  }

  private readReviewIssues(p: PetStoryProject, job: PetStoryChatJob, value: unknown): PetStoryReviewIssue[] {
    if (!Array.isArray(value)) throw new Error('审查回复缺少 issues 数组');
    const seen = new Set<string>();
    return value.map((v: unknown): PetStoryReviewIssue => {
      const issue = record(v);
      if (typeof issue.id !== 'string' || !issue.id.trim() || seen.has(issue.id) || typeof issue.targetId !== 'string' || !['error', 'warning', 'suggestion'].includes(String(issue.severity))) throw new Error('审查问题 ID、目标或严重程度无效');
      const promptKind = issue.promptKind as PetStoryPromptKind | undefined;
      const concrete = p.materials?.some((m): boolean => m.id === issue.targetId) || p.plan?.shots.some((s): boolean => issue.targetId === s.id || (['firstFrame', 'lastFrame', 'video'] as const).some((kind): boolean => !!s.prompts[kind] && `${s.id}:${kind}` === issue.targetId));
      if (!concrete || promptKind && !['firstFrame', 'lastFrame', 'video'].includes(promptKind)) throw new Error('审查问题必须指向真实资产或镜头');
      const scope = job.expectedIds || [];
      const issueTarget = promptKind && p.plan?.shots.some((s): boolean => s.id === issue.targetId) ? `${issue.targetId}:${promptKind}` : issue.targetId;
      if (!scope.includes('project') && !scope.includes(issueTarget)) throw new Error('局部审查回复包含本次目标范围之外的问题，未采用');
      for (const field of ['evidence', 'impact', 'requestedChange']) if (typeof issue[field] !== 'string' || !(issue[field] as string).trim()) throw new Error('审查问题必须包含实际证据、影响和修订目标');
      seen.add(issue.id);
      return { id: issue.id, targetId: issue.targetId, promptKind, evidence: issue.evidence as string, impact: issue.impact as string, requestedChange: issue.requestedChange as string, severity: issue.severity as PetStoryReviewIssue['severity'] };
    });
  }

  private preserveIdentities(p: PetStoryProject, plan: PetStoryPlan): void {
    for (const character of plan.characters) {
      const accepted = confirmedCharacterIdentity(p, character.id);
      // 未确认旧设计不能替换本次 Chat 身份；真实选图只保留绑定，不自动升级为批准。
      if (accepted) character.description = accepted.description;
      const material = p.materials?.find((m): boolean => m.id === `character:${character.id}`);
      const selected = material?.approved?.assetId === material?.selectedAssetId ? material?.selectedAssetId : accepted?.assetId;
      character.referenceAssetId = p.assets.find((asset): boolean => asset.id === selected && asset.kind === 'character' && assetCharacterIds(asset).includes(character.id))?.id;
    }
  }

  private adoptPlan(p: PetStoryProject, job: PetStoryChatJob): void {
    const candidate = job.parsedResult?.plan;
    if (!candidate) throw new Error('该回复没有可采用的分镜候选');
    const plan = structuredClone(candidate); this.preserveIdentities(p, plan);
    for (const shot of plan.shots) for (const kind of ['firstFrame', 'lastFrame', 'video'] as const) {
      const prompt = shot.prompts[kind];
      if (prompt) { prompt.sourceJobId = undefined; prompt.candidateJobId = undefined; prompt.promptTask = undefined; }
    }
    p.plan = plan; p.contentBasis = job.parsedResult?.contentBasis; p.materials = syncMaterials(p); reconcileAdoptedImages(p); p.storyApproval = undefined;
    p.source = { ...p.source, status: 'review_required', reason: '本次豆包剧本理解与动态分镜已采用，请核对剧本、资产及具体图片；文字结果不代表媒体验收' };
    job.resultStatus = 'adopted';
  }

  private adoptAssets(p: PetStoryProject, job: PetStoryChatJob): void {
    const assets = job.parsedResult?.assets;
    if (!p.plan || !assets) throw new Error('该回复没有可采用的资产关系');
    const plan = structuredClone(p.plan);
    plan.characters = structuredClone(assets.characters); plan.props = structuredClone(assets.props); plan.scenes = structuredClone(assets.scenes);
    plan.understanding = assets.understanding || plan.understanding; plan.sceneDesign = assets.sceneDesign || plan.sceneDesign;
    plan.shots = plan.shots.map((shot): PetStoryPlan['shots'][number] => {
      const binding = assets.shotBindings.find((b): boolean => b.shotId === shot.id);
      if (!binding) throw new Error('资产候选已不能对应当前镜头');
      const { shotId: _shotId, ...fields } = binding;
      return { ...shot, ...fields, dialogue: shot.dialogue?.length ? shot.dialogue : fields.dialogue };
    });
    this.preserveIdentities(p, plan);
    p.plan = validatePetStoryPlan(plan); p.materials = syncMaterials(p); reconcileAdoptedImages(p); p.storyApproval = undefined; job.resultStatus = 'adopted';
  }

  private async candidateProject(id: string, revision: number, jobId: string): Promise<{ p: PetStoryProject; job: PetStoryChatJob }> {
    const p = await this.projects.read(id); const job = p.jobs.find((j): boolean => j.id === jobId);
    if (p.revision !== revision) throw new Error('项目版本已变化，请刷新后采用候选');
    if (!job?.requestId || job.status !== 'applied' || !job.parsedResult || job.resultStatus === 'stale' || job.sourceStoryId !== p.mobileStory?.id) throw new Error('候选缺失或已过期，请基于当前事实重新生成');
    const newer = hasSupersedingJob(p, job);
    if (newer) throw new Error('本目标已有更新请求，请查看最新候选，不采用旧版本');
    archiveCompletedPetStoryProduction(p);
    if (p.production) throw new Error('原制作仍在使用已确认输入，请先处理原任务');
    return { p, job };
  }

  async adoptPlanCandidate(id: string, revision: number, jobId: string): Promise<PetStoryResult> {
    const { p, job } = await this.candidateProject(id, revision, jobId);
    if (job.contextHash !== runtimeContextHash(p)) throw new Error('剧本或镜头已变化，分镜候选已过期');
    this.adoptPlan(p, job); return { success: true, project: await this.projects.write(p) };
  }

  async adoptAssetsCandidate(id: string, revision: number, jobId: string): Promise<PetStoryResult> {
    const { p, job } = await this.candidateProject(id, revision, jobId);
    if (job.contextHash !== runtimeContextHash(p)) throw new Error('剧本或镜头已变化，资产候选已过期');
    this.adoptAssets(p, job); return { success: true, project: await this.projects.write(p) };
  }

  async adoptPromptCandidate(id: string, revision: number, jobId: string): Promise<PetStoryResult> {
    const { p, job } = await this.candidateProject(id, revision, jobId);
    if (job.promptTask?.designHash) {
      const qualification = inspectPromptCandidate(p, job);
      if (!qualification.writingReady) throw new Error(`当前候选需按当前事实修订：${qualification.reasons.join('；')}`);
    } else if (job.contextHash !== runtimeContextHash(p)) throw new Error('当前事实已变化，请重新生成本项候选');
    if (job.frameContextHash !== undefined && job.frameContextHash !== frameContextHash(p, job)) throw new Error('已采用首帧或尾帧正文已变化，请按当前共同状态重新生成候选');
    if (!boundaryStillCurrent(p, job)) throw new Error('前镜已采用边界发生变化，请按当前连续状态重新生成候选');
    const target = promptFor(p, job); const body = job.parsedResult?.optimized;
    if (!target || !body?.trim()) throw new Error('该回复没有可采用的正文');
    target.final = body; target.optimized = body; target.edited = false; target.sourceJobId = job.id; target.candidateJobId = job.id;
    target.rulesVersion = job.rulesVersion || PROMPT_RULES_VERSION; target.needsReview = undefined; target.editIntent = job.editIntent ? structuredClone(job.editIntent) : undefined; job.resultStatus = 'adopted';
    target.promptTask = job.promptTask ? structuredClone(job.promptTask) : undefined;
    return { success: true, project: await this.projects.write(p) };
  }

  private applyMaterialPrompt(p: PetStoryProject, job: PetStoryChatJob, answer: Record<string, unknown>): void {
    if (typeof answer.optimized !== 'string' || !answer.optimized.trim()) throw new Error('缺少 optimized 文本');
    const material = p.materials?.find((m): boolean => m.id === job.materialId);
    if (!material) throw new Error('基础素材已删除，不覆盖其他内容');
    material.prompt.optimized = answer.optimized;
    const unchanged = job.contextHash === hash(JSON.stringify({ id: material.id, designHash: material.designHash }));
    material.prompt.candidateJobId = job.id; job.parsedResult = { optimized: answer.optimized }; job.resultStatus = unchanged ? 'candidate' : 'stale';
  }

  private applyOptimization(p: PetStoryProject, job: PetStoryChatJob, answer: Record<string, unknown>): void {
    if (typeof answer.optimized !== 'string' || !answer.optimized.trim()) throw new Error('缺少 optimized 文本');
    const target = p.plan?.shots.find((s): boolean => s.id === job.shotId)?.prompts[job.promptKind || 'video'];
    if (!target) throw new Error('镜头已删除，不覆盖其他内容');
    if (job.promptKind === 'video' && p.plan?.shots.find((s): boolean => s.id === job.shotId)?.dialogue?.some((d): boolean => !(answer.optimized as string).includes(d.text))) throw new Error('视频候选遗漏剧本已有台词，未覆盖 final，请通过产品重新优化');
    const unchanged = job.contextHash === hash(JSON.stringify(promptContextHashInput(p, job.shotId)));
    target.optimized = answer.optimized;
    target.rulesVersion = PROMPT_RULES_VERSION;
    target.candidateJobId = job.id; job.parsedResult = { optimized: answer.optimized }; job.resultStatus = unchanged ? 'candidate' : 'stale';
  }

  private applyStory(p: PetStoryProject, answer: Record<string, unknown>, preserveManual: boolean = true, job?: PetStoryChatJob): void {
    if (answer.storyUsable === false) {
      p.source = { ...p.source, status: 'blocked', reason: typeof answer.reason === 'string' ? answer.reason : '粘贴的故事情节不足以制作方案，请补充开头、变化与结局' };
      // 已有方案及手改 final 保留；不足的回复不能清空用户成果。
      throw new Error('故事内容不足：请补充手机豆包故事原文，未创建后续媒体任务');
    }
    if (answer.storyUsable !== true) throw new Error('缺少 storyUsable；需依据用户粘贴的故事，不能冒充桌面已读取视频');
    const basis = record(answer.contentBasis);
    for (const field of ['beginning', 'middle', 'ending']) {
      if (typeof basis[field] !== 'string' || !(basis[field] as string).trim()) throw new Error('缺少开头、中间变化或结局；不能把标题／封面算作完整分析');
    }
    const normalized = normalizeAnalysisCuts(answer);
    if (job) job.formatCorrections = normalized.corrections.length ? normalized.corrections : undefined;
    const plan = validatePetStoryPlan(normalized.answer, true);
    if (!plan.props || !plan.scenes) throw new Error('本次分析缺少动态道具／场景资产集合，请补齐结构，不允许跳过基础素材');
    this.preserveIdentities(p, plan);
    if (preserveManual) this.preserveManualPrompts(p, plan);
    p.plan = plan;
    p.materials = syncMaterials(p); reconcileAdoptedImages(p); p.storyApproval = undefined;
    p.contentBasis = basis as NonNullable<PetStoryProject['contentBasis']>;
    p.source = { ...p.source, status: 'review_required', reason: p.source.kind === 'script' ? '草稿基于用户提供的剧本，请核对剧情、资产及原有台词，再确认剧本与基础图片' : '制作方案基于用户粘贴的手机豆包故事；内容与原视频是否一致待本人核对，A1 尚未验收' };
  }

  private preserveManualPrompts(p: PetStoryProject, plan: PetStoryPlan): void {
    for (const previous of p.plan?.shots || []) {
      const manualKinds = (['firstFrame', 'lastFrame', 'video'] as const).filter((kind): boolean => !!previous.prompts[kind]?.edited);
      if (!manualKinds.length) continue;
      const incoming = plan.shots.find((s): boolean => s.id === previous.id);
      if (!incoming) throw new Error('回复无法对应已有手改镜头 ID，原方案与 final 已保留');
      for (const kind of manualKinds) {
        const manual = previous.prompts[kind];
        if (manual) incoming.prompts[kind] = structuredClone(manual);
      }
    }
  }


  async draft(id: string, shotId: string, kind: PetStoryPromptKind): Promise<PetStoryResult> {
    const p = await this.projects.read(id);
    if (kind !== 'firstFrame') throw new Error('尾帧与视频请使用原制作流程，按实际模式绑定素材');
    const step = p.production?.phase === 'shots' ? p.production.steps.find((s): boolean => s.shotId === shotId && s.kind === 'firstFrame' && !!s.taskId) : undefined;
    if (step) return { success: true, project: p, taskId: step.taskId, compiledPrompt: step.compiledPrompt };
    throw new Error('请先确认实际基础图片，再通过“确认素材，继续镜头制作”创建原链任务');
  }
}
