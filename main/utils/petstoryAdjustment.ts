import { createHash, randomUUID } from 'node:crypto';
import type { DownloadJob, PetStoryImageTarget, PetStoryChatAdjustment, PetStoryChatJob, PetStoryConversationReply, PetStoryProject, PetStoryRuntimeTarget, PetStoryAdjustmentResult, PetStoryAdjustmentPreviewResult, Task, TaskDownloadOutputsParams, TaskDownloadOutputsResult } from '@doubao-studio/contracts';
import type { PetStoryProjects } from './petstoryProject';
import type { PetStoryChatService, PetStoryTaskPort } from './petstoryChat';
import { archiveCompletedPetStoryProduction } from './petstoryProductionLifecycle';
import { claimConversationGuard, releaseConversationGuard } from './accountConversationGuard';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export function conversationReplyKey(reply: Pick<PetStoryConversationReply, 'text' | 'precedingUserText' | 'turnId' | 'messageId' | 'imageUrls'>): string {
  return digest(JSON.stringify({ text: reply.text, precedingUserText: reply.precedingUserText, turnId: reply.turnId || '', messageId: reply.messageId || '', ...(reply.imageUrls?.length ? { imageUrls: reply.imageUrls } : {}) }));
}
export function validConversationImages(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && new Set(value).size === value.length
    && value.every((url: unknown): boolean => typeof url === 'string' && url.length <= 8192 && /^https:\/\//i.test(url));
}
interface AdjustmentMediaPort { downloads: () => DownloadJob[]; download: (params: TaskDownloadOutputsParams) => Promise<TaskDownloadOutputsResult> }
function requireDoubaoImageSource(value: string): void {
  const parsed = new URL(value);
  const allowed = ['doubao.com', 'byteimg.com', 'bytecdn.cn', 'ibytedtos.com', 'bytedance.com', 'bytedance.net', 'volces.com'];
  if (parsed.username || parsed.password || parsed.port && parsed.port !== '443'
    || !allowed.some((host): boolean => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) throw new Error('这张图片不是可核对的豆包图片来源；请保存后在当前对象上传');
}
export function adjustmentConversationUrl(value: string | undefined): string | undefined {
  const match = value?.match(/^https:\/\/www\.doubao\.com\/chat\/([a-zA-Z0-9_-]{1,128})\/?(?:[?#].*)?$/);
  return match && !match[1].startsWith('local_') ? `https://www.doubao.com/chat/${match[1]}` : undefined;
}
export function adjustmentTarget(p: PetStoryProject, target: PetStoryRuntimeTarget): PetStoryRuntimeTarget {
  if (target.materialId && !target.shotId && !target.promptKind && p.materials?.some((m): boolean => m.id === target.materialId)) return { materialId: target.materialId };
  const kind = target.promptKind;
  if (!target.materialId && target.shotId && kind && p.plan?.shots.some((s): boolean => s.id === target.shotId && !!s.prompts[kind])) return { shotId: target.shotId, promptKind: target.promptKind };
  if (!target.materialId && !target.shotId && !target.promptKind && (p.plan || p.jobs.some((job): boolean => (!target.parentJobId || job.id === target.parentJobId) && isPlanConversationJob(job) && job.status === 'applied' && job.resultStatus === 'candidate'))) return {};
  throw new Error('请从具体方案、素材提示词或镜头提示词打开豆包调整');
}
export function adjustmentText(p: PetStoryProject, target: PetStoryRuntimeTarget): string {
  return target.materialId ? p.materials?.find((m): boolean => m.id === target.materialId)?.prompt.final || ''
    : target.shotId && target.promptKind ? p.plan?.shots.find((s): boolean => s.id === target.shotId)?.prompts[target.promptKind]?.final || ''
      : JSON.stringify(p.plan || null);
}
export function adjustmentBasis(p: PetStoryProject, target: PetStoryRuntimeTarget): string {
  return digest(JSON.stringify({ story: p.mobileStory, plan: p.plan ? { ...p.plan, shots: p.plan.shots.map(({ prompts: _prompts, ...shot }): object => shot) } : null,
    profile: p.promptProfile, model: p.promptModel, frames: p.adoptedImages, materials: p.materials?.map((m): object => ({ id: m.id, designHash: m.designHash, selectedAssetId: m.selectedAssetId, approved: m.approved })), text: adjustmentText(p, target) }));
}
function taskConversation(task: Task): string | undefined {
  const direct = adjustmentConversationUrl(task.runtime?.conversationUrl);
  const binding = task.runtime?.acceptanceObservation;
  if (binding && (binding.runId !== task.runtime?.runId || adjustmentConversationUrl(binding.conversationUrl) !== direct)) return undefined;
  if (direct) return direct;
  const urls = [...new Set((task.artifacts || []).filter((a): boolean => a.runId === task.runtime?.runId).map((a): string | undefined => adjustmentConversationUrl(a.conversationUrl)).filter((v): v is string => !!v))];
  return urls.length === 1 ? urls[0] : undefined;
}
/** 一次纠正后的完整方案仍属于其真实回复，不能退回未通过的原分析会话。 */
function isPlanConversationJob(job: PetStoryChatJob): boolean {
  return !!job.parsedResult?.plan && (job.kind === 'analysis' || job.kind === 'repair');
}
/** 自由聊天复用已有规则会话；不创建平台请求，也不把最后一条回复当作默认答案。 */
export class PetStoryAdjustmentService {
  private readonly observations = new Map<string, { keys: string; at: number }>();
  constructor(private readonly projects: PetStoryProjects, private readonly tasks: PetStoryTaskPort, private readonly chats: PetStoryChatService, private readonly media?: AdjustmentMediaPort) {}

  async begin(id: string, revision: number, supplied: PetStoryRuntimeTarget): Promise<PetStoryAdjustmentResult> {
    const p = await this.projects.read(id);
    if (p.revision !== revision) throw new Error('项目内容已更新，请刷新后打开调整');
    const target = adjustmentTarget(p, supplied);
    if (p.chatAdjustment?.status === 'active') {
      if (JSON.stringify(p.chatAdjustment.target) !== JSON.stringify(target)) throw new Error('请先采用当前对话的回复，或明确结束当前调整，再调整其他对象');
      if (supplied.parentJobId && supplied.parentJobId !== p.chatAdjustment.sourceJobId) throw new Error('当前正在调整另一版候选，请先结束当前调整，再打开这版候选');
      this.persistGuard(p, p.chatAdjustment, true);
      claimConversationGuard(p.accountId, p.id, p.chatAdjustment.id);
      return { success: true, project: p, adjustment: p.chatAdjustment };
    }
    const tasks = this.tasks.list();
    if (tasks.some((t): boolean => t.assignedAccountId === p.accountId && (['executing', 'generating', 'waiting_verification', 'waiting_generation_confirmation', 'manual_submission_observing'].includes(t.status)
      || !!t.lock && Date.parse(t.lock.expiresAt) > Date.now() || t.status === 'paused' && t.errorInfo?.code === 'submission_uncertain'))) throw new Error('这个账号还有未完成或待核对的任务，请先处理原任务再自由调整');
    if (p.production?.state === 'running' || p.production?.steps.some((step): boolean => step.status !== 'complete')) throw new Error('请先收取或处理当前制作任务，再调整创作内容');
    const preferredId = supplied.parentJobId || (target.materialId ? p.materials?.find((material): boolean => material.id === target.materialId)?.prompt.sourceJobId : target.shotId ? p.plan?.shots.find((shot): boolean => shot.id === target.shotId)?.prompts[target.promptKind || 'video']?.sourceJobId : [...p.jobs].reverse().find((job): boolean => isPlanConversationJob(job) && job.status === 'applied' && job.resultStatus === 'adopted')?.id);
    const source = [...p.jobs].reverse().find((j): boolean => (!preferredId || j.id === preferredId) && !!j.rawText && !!j.requestText && j.status === 'applied'
      && (target.materialId ? j.materialId === target.materialId : target.shotId ? j.shotId === target.shotId && j.promptKind === target.promptKind : isPlanConversationJob(j))
      && tasks.some((t): boolean => t.id === j.taskId && t.assignedAccountId === p.accountId && !!j.runId && t.runtime?.runId === j.runId && t.prompt === j.requestText && j.sourceStoryId === p.mobileStory?.id && !!taskConversation(t)));
    if (!source) throw new Error('这项内容还没有可定位的豆包会话。请先生成本项提示词或检查原会话，再打开调整');
    const task = tasks.find((t): boolean => t.id === source.taskId);
    const conversationUrl = task && taskConversation(task);
    if (!conversationUrl) throw new Error('原会话归属已变化，请核对后重新打开调整');
    archiveCompletedPetStoryProduction(p);
    if (p.chatAdjustment) p.chatAdjustmentHistory = [...(p.chatAdjustmentHistory || []), p.chatAdjustment];
    const adjustment: PetStoryChatAdjustment = { id: randomUUID(), target, sourceJobId: source.id, conversationUrl,
      basisHash: adjustmentBasis(p, target), previousText: adjustmentText(p, target), startedAt: new Date().toISOString(), status: 'active', replies: [] };
    this.persistGuard(p, adjustment, true);
    p.chatAdjustment = adjustment;
    try { claimConversationGuard(p.accountId, p.id, adjustment.id); return { success: true, project: await this.projects.write(p), adjustment }; }
    catch (error: unknown) { this.persistGuard(p, adjustment, false); releaseConversationGuard(p.accountId, adjustment.id); throw error; }
  }

  async capture(id: string, adjustmentId: string, url: string, replies: PetStoryConversationReply[]): Promise<PetStoryAdjustmentResult> {
    const p = await this.projects.read(id); const a = this.active(p, adjustmentId);
    if (adjustmentConversationUrl(url) !== a.conversationUrl) throw new Error('当前网页不是本次调整的关联会话，未采用任何回复');
    if (!Array.isArray(replies) || replies.length > 100) throw new Error('请选择当前会话可辨认的助手回复');
    const now = new Date().toISOString();
    const checked = replies.map((r): PetStoryConversationReply => {
      if (!r || typeof r.text !== 'string' || !r.text.trim() && !r.imageUrls?.length || r.text.length > 250_000 || typeof r.precedingUserText !== 'string' || r.precedingUserText.length > 250_000
        || r.imageUrls !== undefined && !validConversationImages(r.imageUrls)
        || r.turnId !== undefined && (typeof r.turnId !== 'string' || r.turnId.length > 256) || r.messageId !== undefined && (typeof r.messageId !== 'string' || r.messageId.length > 256)) throw new Error('读取的回复缺少稳定正文或上下文');
      const key = conversationReplyKey(r);
      if (r.key !== key) throw new Error('回复内容在读取期间发生变化，请等待回复完成');
      return { key, text: r.text, precedingUserText: r.precedingUserText, turnId: r.turnId, messageId: r.messageId, ...(r.imageUrls?.length ? { imageUrls: r.imageUrls } : {}), capturedAt: a.replies.find((old): boolean => old.key === key)?.capturedAt || now };
    });
    if (new Set(checked.map((r): string => r.key)).size !== checked.length) throw new Error('网页中的回复不能唯一识别，请在豆包中定位具体回复');
    const keys = JSON.stringify(checked.map((r): string => r.key));
    this.observations.set(a.id, { keys, at: Date.now() });
    if (JSON.stringify(a.replies.map((r): string => r.key)) === keys) return { success: true, project: p, adjustment: a };
    a.replies = checked; a.checkedAt = now;
    return { success: true, project: await this.projects.write(p), adjustment: a };
  }

  /** 只收取选定回复中的图片并保存候选；沿原账号下载器，不创建生成任务或改变正式采用图。 */
  async importImages(id: string, revision: number, adjustmentId: string, replyKey: string): Promise<PetStoryAdjustmentResult> {
    let p = await this.projects.read(id); const a = this.active(p, adjustmentId);
    if (p.revision !== revision || a.basisHash !== adjustmentBasis(p, a.target)) throw new Error('当前对象或采用素材已变化，请重新核对后收取图片');
    const observed = this.observations.get(a.id);
    if (!observed || Date.now() - observed.at > 8000 || observed.keys !== JSON.stringify(a.replies.map((r): string => r.key))) throw new Error('请先在关联会话核对这条具体图片回复');
    const reply = a.replies.find((r): boolean => r.key === replyKey);
    if (!reply?.imageUrls?.length || !this.media) throw new Error('这条回复没有可收取图片；可从豆包保存后在目标位置上传');
    const target = this.imageTarget(a.target);
    const source = p.jobs.find((job): boolean => job.id === a.sourceJobId);
    if (!source) throw new Error('原会话任务记录缺失，未收取图片');
    try { for (const url of reply.imageUrls) {
      requireDoubaoImageSource(url);
      const urlHash = digest(url);
      if (p.assets.some((asset): boolean => asset.imageReview?.sourceReply?.adjustmentId === a.id && asset.imageReview.sourceReply.replyKey === replyKey && asset.imageReview.sourceReply.urlHash === urlHash)) continue;
      let job = this.media.downloads().find((item): boolean => item.taskId === source.taskId && item.accountId === p.accountId && item.mode === 'image' && item.url === url && item.status === 'done');
      if (!job) {
        const result = await this.media.download({ outputs: [{ taskId: source.taskId, prompt: source.requestText || '', accountId: p.accountId, mode: 'image', outputs: [url] }] });
        if (!result.success || result.failed) throw new Error('这张回复图片下载失败；已收取候选保留，再试只下载原图');
        job = this.media.downloads().find((item): boolean => !!result.jobIds?.includes(item.id) && item.taskId === source.taskId && item.accountId === p.accountId && item.mode === 'image' && item.url === url && item.status === 'done');
      }
      if (!job?.filePath) throw new Error('这张图片缺少归属正确的下载记录，未保存到目标');
      const imageSource = { taskId: source.taskId, runId: source.runId, downloadJobId: job.id, sourceReply: { adjustmentId: a.id, replyKey, urlHash } };
      if (target.materialId) p = await this.projects.addMaterialImage(p.id, p.revision, target.materialId, job.filePath, imageSource);
      else if (target.shotId && target.kind) p = await this.projects.addShotImage(p.id, p.revision, target.shotId, target.kind, job.filePath, imageSource);
      else throw new Error('图片缺少唯一目标，未保存');
    } } catch (error: unknown) { return { success: false, project: await this.projects.read(id), error: error instanceof Error ? error.message : '回复图片尚未全部收取' }; }
    return { success: true, project: p, adjustment: p.chatAdjustment };
  }

  private imageTarget(target: PetStoryRuntimeTarget): PetStoryImageTarget {
    if (target.materialId) return { materialId: target.materialId };
    if (target.shotId && (target.promptKind === 'firstFrame' || target.promptKind === 'lastFrame')) return { shotId: target.shotId, kind: target.promptKind };
    throw new Error('当前调整没有图片用途，请从具体基础素材、首帧或尾帧打开后再选择图片');
  }

  async preview(id: string, revision: number, adjustmentId: string, replyKey: string): Promise<PetStoryAdjustmentPreviewResult> {
    const p = await this.projects.read(id); const a = this.active(p, adjustmentId);
    if (p.revision !== revision || a.basisHash !== adjustmentBasis(p, a.target)) throw new Error('当前内容或素材已更新，请重新核对后调整');
    const reply = a.replies.find((r): boolean => r.key === replyKey);
    if (!reply) throw new Error('请重新选择一条具体回复');
    const candidate = structuredClone(p);
    this.chats.applyConversationReply(candidate, a, reply);
    const planTarget = !a.target.materialId && !a.target.shotId;
    return { success: true, preview: { target: a.target, ...(planTarget ? { previousPlan: p.plan, plan: candidate.plan, previousContentBasis: p.contentBasis, contentBasis: candidate.contentBasis } : { previousBody: adjustmentText(p, a.target), body: adjustmentText(candidate, a.target) }) } };
  }

  async adopt(id: string, revision: number, adjustmentId: string, replyKey: string): Promise<PetStoryAdjustmentResult> {
    const p = await this.projects.read(id);
    if (p.chatAdjustment?.id === adjustmentId && p.chatAdjustment.status === 'adopted' && p.chatAdjustment.adoptedReplyKey === replyKey) { this.restore(p); return { success: true, project: p, adjustment: p.chatAdjustment }; }
    const a = this.active(p, adjustmentId);
    if (p.revision !== revision || a.basisHash !== adjustmentBasis(p, a.target)) throw new Error('当前内容或素材已更新，请重新核对选定回复，不覆盖新版本');
    const observed = this.observations.get(a.id);
    if (!observed || Date.now() - observed.at > 8000 || observed.keys !== JSON.stringify(a.replies.map((r): string => r.key))) throw new Error('关联会话尚未完成本次核对，请等待回复读取稳定');
    const reply = a.replies.find((r): boolean => r.key === replyKey);
    if (!reply) throw new Error('请重新选择一条具体回复');
    if (p.production?.state === 'running' || p.production?.steps.some((step): boolean => step.status !== 'complete')) throw new Error('当前制作尚未收取完成，请先处理原任务，再采用回复');
    this.chats.applyConversationReply(p, a, reply);
    a.status = 'adopted'; a.adoptedReplyKey = reply.key;
    const project = await this.projects.write(p);
    this.persistGuard(p, a, false); releaseConversationGuard(p.accountId, a.id); this.observations.delete(a.id);
    return { success: true, project, adjustment: project.chatAdjustment };
  }

  async end(id: string, revision: number, adjustmentId: string): Promise<PetStoryAdjustmentResult> {
    const p = await this.projects.read(id);
    if (p.chatAdjustment?.id === adjustmentId && p.chatAdjustment.status !== 'active') { this.restore(p); return { success: true, project: p, adjustment: p.chatAdjustment }; }
    const a = this.active(p, adjustmentId);
    if (p.revision !== revision) throw new Error('项目已更新，请刷新后结束调整');
    a.status = 'ended'; const project = await this.projects.write(p);
    this.persistGuard(p, a, false); releaseConversationGuard(p.accountId, a.id); this.observations.delete(a.id);
    return { success: true, project, adjustment: a };
  }
  /** 启动后沿原任务台账恢复写入保护；已结束记录只释放同一身份的遗留锁。 */
  restore(p: PetStoryProject): void {
    const a = p.chatAdjustment;
    // 项目写入失败留下的同项目任务锁可在重新打开真实文件后精确收束。
    for (const task of this.tasks.list()) {
      const guard = task.runtime?.chatAdjustmentGuard;
      if (guard?.active && guard.projectId === p.id && (a?.status !== 'active' || guard.adjustmentId !== a.id)) {
        this.tasks.setConversationGuard?.(task.id, p.id, guard.adjustmentId, false);
        releaseConversationGuard(p.accountId, guard.adjustmentId);
      }
    }
    if (!a) return;
    if (a.status === 'active') { this.persistGuard(p, a, true); claimConversationGuard(p.accountId, p.id, a.id); }
    else releaseConversationGuard(p.accountId, a.id);
  }

  private persistGuard(p: PetStoryProject, a: PetStoryChatAdjustment, active: boolean): void {
    const source = p.jobs.find((job): boolean => job.id === a.sourceJobId);
    if (!source) throw new Error('豆包调整的原任务记录缺失，保护状态保持不变');
    this.tasks.setConversationGuard?.(source.taskId, p.id, a.id, active);
  }
  private active(p: PetStoryProject, id: string): PetStoryChatAdjustment {
    if (!p.chatAdjustment || p.chatAdjustment.id !== id || p.chatAdjustment.status !== 'active') throw new Error('这次调整已结束或不属于当前项目');
    claimConversationGuard(p.accountId, p.id, id); return p.chatAdjustment;
  }
}
