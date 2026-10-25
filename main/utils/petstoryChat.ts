import { createHash, randomUUID } from 'node:crypto';
import type { PetStoryChatJob, PetStoryAsset, PetStoryPlan, PetStoryPromptKind, PetStoryProject, PetStoryResult, Task, TaskAddParams } from '@doubao-studio/contracts';
import { PetStoryProjects } from './petstoryProject';
import { parsePetStoryAnswer, record, validatePetStoryPlan } from './petstoryValidation';

export interface PetStoryTaskPort {
  list: () => Task[];
  create: (params: TaskAddParams, accountId: string) => Task;
  retryUnsubmitted?: (taskId: string) => Task;
}
const hash = (prompt: string): string => createHash('sha256').update(prompt).digest('hex');
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
  return { prompts: [final], mode: kind === 'video' ? 'video' : 'image', executionIntent: 'hold', attachments,
    projectId, videoConfig: kind === 'video' ? videoConfig : undefined };
}
export class PetStoryChatService {
  constructor(private readonly projects: PetStoryProjects, private readonly tasks: PetStoryTaskPort) {}

  private repairParent(p: PetStoryProject, parentJobId?: string): PetStoryChatJob {
    const parent = p.jobs.find((j): boolean => j.id === parentJobId);
    if (!parent || parent.kind !== 'analysis' || parent.status !== 'invalid' || !parent.rawText || parent.sourceUrl !== p.source.url || parent.sourceStoryId !== p.mobileStory?.id || p.source.status === 'blocked') throw new Error('仅允许对本次结构错误的分析进行一次格式纠正');
    if (p.jobs.some((j): boolean => j.parentJobId === parentJobId && j.kind === 'repair')) throw new Error('格式纠正已使用一次，不能再次请求');
    return parent;
  }

  async prepare(id: string, prompt: string, kind: PetStoryChatJob['kind'], parentJobId?: string, shotId?: string, promptKind?: PetStoryPromptKind): Promise<PetStoryResult> {
    let p = await this.projects.read(id);
    if (p.production) throw new Error('P4 已确认制作方案，暂不修改已授权的最终提示词');
    if (!p.source.url || !prompt.trim() || prompt.length > 100_000) throw new Error('需要有效来源与合理长度的请求正文');
    if (!p.mobileStory?.text.trim()) throw new Error('请先复制手机豆包提示词，在手机端取得故事情节后粘贴并保存；桌面端不再读取抖音视频');
    if (!['analysis', 'repair', 'optimize'].includes(kind)) throw new Error('Chat 请求类型无效');
    if (p.jobs.some((j): boolean => j.status === 'bound' || j.status === 'captured')) throw new Error('已有待收取原任务；请读取原结果，不得重复创建');
    const parent = kind === 'repair' ? this.repairParent(p, parentJobId) : undefined;
    if (kind === 'analysis' && p.jobs.some((j): boolean => j.kind === 'analysis' && j.sourceUrl === p.source.url && j.sourceStoryId === p.mobileStory?.id)) throw new Error('该故事已绑定分析任务，请收取原结果或使用一次纠正');
    const target = p.plan?.shots.find((s): boolean => s.id === shotId);
    if (kind === 'optimize' && (!target || !promptKind || !target.prompts[promptKind])) throw new Error('请选择现有镜头及提示词');
    const selectedAssets = kind === 'optimize' && target ? p.assets.filter((a): boolean => a.kind === 'character' ? target.characterIds.includes(a.characterId || '') : a.kind === 'scene' && a.shotId === target.id) : p.assets;
    const attachments = await this.projects.attachments({ ...p, assets: selectedAssets });
    if (this.tasks.list().some((t): boolean => t.projectId === p.studioProjectId && t.mode === 'chat' && hash(t.prompt) === hash(prompt.trim()) && !p.jobs.some((j): boolean => j.taskId === t.id))) {
      throw new Error('相同输入已有未绑定任务；请核对 Studio 中的原 hold 任务，不得重新创建或自动发送');
    }
    // 先建 hold 任务，再落盘绑定；写盘不确定时调用方不会拿到启动授权。
    const task = this.tasks.create({ prompts: [prompt], mode: 'chat', executionIntent: 'hold', attachments, projectId: p.studioProjectId }, p.accountId);
    const job: PetStoryChatJob = { id: randomUUID(), taskId: task.id, kind, status: 'bound', parentJobId: parent?.id,
      shotId, promptKind, inputHash: hash(task.prompt), sourceUrl: p.source.url, sourceStoryId: p.mobileStory.id,
      inputFinal: promptKind ? target?.prompts[promptKind]?.final : undefined };
    p.jobs.push(job);
    p = await this.projects.write(p);
    return { success: true, project: p, taskId: task.id, attachments };
  }

  async bindRun(id: string, jobId: string, runId: string): Promise<PetStoryResult> {
    const p = await this.projects.read(id);
    const job = p.jobs.find((j): boolean => j.id === jobId);
    const task = this.tasks.list().find((t): boolean => t.id === job?.taskId);
    if (!p.mobileStory || job?.sourceStoryId !== p.mobileStory.id) throw new Error('旧版链接直读或故事已变化，不得启动原请求；请保存手机豆包故事');
    if (!job || job.status !== 'bound' || !task || task.runtime?.runId !== runId || task.mode !== 'chat' || task.assignedAccountId !== p.accountId || task.projectId !== p.studioProjectId || hash(task.prompt) !== job.inputHash) throw new Error('原运行与任务绑定不符，未授权页面操作');
    if (job.runId && job.runId !== runId) throw new Error('本步骤已绑定其他运行，不得替换或重发');
    job.runId = runId;
    return { success: true, project: await this.projects.write(p) };
  }

  async retryUnsubmitted(id: string, jobId: string): Promise<PetStoryResult> {
    let p = await this.projects.read(id);
    const job = p.jobs.find((j): boolean => j.id === jobId);
    const task = this.tasks.list().find((t): boolean => t.id === job?.taskId);
    if (!job || !p.mobileStory || job.sourceStoryId !== p.mobileStory.id || job.status !== 'bound' || job.rawText || job.sourceUrl !== p.source.url || !task || task.mode !== 'chat'
      || task.projectId !== p.studioProjectId || task.assignedAccountId !== p.accountId || hash(task.prompt) !== job.inputHash
      || !task.runtime || (job.runId && task.runtime.runId !== job.runId) || task.runtime.input.prompt !== task.prompt
      || JSON.stringify(task.runtime.input.attachments) !== JSON.stringify(task.attachments || [])) throw new Error('原任务／运行归属不符，禁止重试');
    if (!['fail', 'paused', 'cancelled', 'waiting_verification'].includes(task.status) || !['video_assets_not_ready', 'chat_assets_not_ready', 'page_unrecognized', 'page_loading', 'authentication_unconfirmed', 'cancelled'].includes(task.errorInfo?.code || '')
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
    const task = this.tasks.list().find((t): boolean => t.id === job?.taskId);
    if (!task || task.projectId !== p.studioProjectId || task.assignedAccountId !== p.accountId || task.mode !== 'chat' || hash(task.prompt) !== job.inputHash) throw new Error('原任务或输入归属不符，已停止');
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
      if (!p.mobileStory || job.sourceStoryId !== p.mobileStory.id) throw new Error('旧版链接直读或其他故事的回复仅保留原文，请粘贴手机豆包故事后生成制作方案');
      const answer = parsePetStoryAnswer(job.rawText);
      if (job.kind === 'optimize') this.applyOptimization(p, job, answer);
      else this.applyStory(p, answer);
      job.status = 'applied';
      job.error = undefined;
      return { success: true, project: await this.projects.write(p) };
    } catch (error: unknown) {
      job.status = 'invalid';
      job.error = error instanceof Error ? error.message : '解析失败';
      const needsRepair = job.kind === 'analysis' && !!p.mobileStory && job.sourceStoryId === p.mobileStory.id && p.source.status !== 'blocked' && !p.jobs.some((j): boolean => j.kind === 'repair' && j.parentJobId === job?.id);
      return { success: false, project: await this.projects.write(p), error: job.error, needsRepair };
    }
  }

  private applyOptimization(p: PetStoryProject, job: PetStoryChatJob, answer: Record<string, unknown>): void {
    if (typeof answer.optimized !== 'string' || !answer.optimized.trim()) throw new Error('缺少 optimized 文本');
    const target = p.plan?.shots.find((s): boolean => s.id === job.shotId)?.prompts[job.promptKind || 'video'];
    if (!target) throw new Error('镜头已删除，不覆盖其他内容');
    target.optimized = answer.optimized;
    if (target.final === job.inputFinal) { target.final = answer.optimized; target.edited = false; }
  }

  private applyStory(p: PetStoryProject, answer: Record<string, unknown>): void {
    if (answer.storyUsable === false) {
      p.source = { ...p.source, status: 'blocked', reason: typeof answer.reason === 'string' ? answer.reason : '粘贴的故事情节不足以制作方案，请补充开头、变化与结局' };
      p.plan = undefined;
      throw new Error('故事内容不足：请补充手机豆包故事原文，未创建后续媒体任务');
    }
    if (answer.storyUsable !== true) throw new Error('缺少 storyUsable；需依据用户粘贴的故事，不能冒充桌面已读取视频');
    const basis = record(answer.contentBasis);
    for (const field of ['beginning', 'middle', 'ending']) {
      if (typeof basis[field] !== 'string' || !(basis[field] as string).trim()) throw new Error('缺少开头、中间变化或结局；不能把标题／封面算作完整分析');
    }
    const plan = validatePetStoryPlan(answer, true);
    for (const char of plan.characters) char.referenceAssetId = p.assets.find((a): boolean => a.characterId === char.id)?.id;
    p.plan = plan;
    p.contentBasis = basis as NonNullable<PetStoryProject['contentBasis']>;
    p.source = { ...p.source, status: 'review_required', reason: '制作方案基于用户粘贴的手机豆包故事；内容与原视频是否一致待本人核对，A1 尚未验收' };
  }


  async draft(id: string, shotId: string, kind: PetStoryPromptKind): Promise<PetStoryResult> {
    const p = await this.projects.read(id);
    if (!p.plan || p.source.status !== 'review_required') throw new Error('请先完成内容分析');
    // 保留 P3 的首帧 hold 草稿入口；尾帧与视频统一由 P4 制作流程绑定后创建。
    if (kind !== 'firstFrame') throw new Error('此草稿入口仅保存首帧；视频／尾帧请使用 P4 一次确认制作流程，按实际模式与素材绑定后创建');
    const plan = p.plan;
    const shot = plan.shots.find((s): boolean => s.id === shotId);
    if (!shot) throw new Error('镜头不存在');
    const assets = shot.characterIds.map((charId: string): PetStoryAsset => {
      const char = plan.characters.find((c): boolean => c.id === charId);
      const asset = p.assets.find((a): boolean => a.id === char?.referenceAssetId && a.characterId === charId);
      if (!asset) throw new Error(`${char?.name || charId}缺少或错绑参考图`);
      return asset;
    });
    const problems = checkFinalBindings(p.plan, shotId, kind, assets.map((a): PetStoryMaterialBinding => ({ characterId: a.characterId || '', assetId: a.id })), 'image');
    if (problems.length) throw new Error(problems.join('；'));
    const subset = { ...p, assets };
    const input = finalTaskInput(p.plan, shotId, kind, await this.projects.attachments(subset), p.studioProjectId);
    const final = input.prompts[0].trim();
    const tasks = this.tasks.list();
    const previous = p.drafts?.find((d): boolean => d.shotId === shotId && d.kind === kind && d.final === final && tasks.some((t): boolean => t.id === d.taskId && t.prompt === final && JSON.stringify(t.attachments || []) === JSON.stringify(input.attachments || [])));
    if (previous) return { success: true, project: p, taskId: previous.taskId };
    if (this.tasks.list().some((t): boolean => t.projectId === p.studioProjectId && t.mode === input.mode && t.prompt === final && !p.drafts?.some((d): boolean => d.taskId === t.id))) throw new Error('已有相同文本未绑定草稿，请核对原任务，不得重新创建');
    const task = this.tasks.create(input, p.accountId);
    if (task.prompt !== final || task.executionIntent !== 'hold') throw new Error('最终文本草稿回读不符，已停止');
    p.drafts = [...(p.drafts || []), { taskId: task.id, shotId, kind, final }];
    return { success: true, project: await this.projects.write(p), taskId: task.id };
  }
}
