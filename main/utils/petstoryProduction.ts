import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DownloadJob, PetStoryAsset, PetStoryCapability, PetStoryExecutionGuard, PetStoryPlan, PetStoryProductionCounts, PetStoryProductionResult, PetStoryProductionStep, PetStoryProject, Task, TaskAddParams, TaskDownloadOutputsParams, TaskDownloadOutputsResult } from '@doubao-studio/contracts';
import { PetStoryProjects, projectPath } from './petstoryProject';
import { finalTaskInput } from './petstoryChat';
import { validatePetStoryPlan } from './petstoryValidation';
import { resolvePetStoryMode } from './petstoryModes';
import { extractActualEndFrame, mediaDigest, validatePetStoryMedia } from './petstoryMedia';

interface ProductionPort {
  list: () => Task[];
  create: (params: TaskAddParams, accountId: string) => Task;
  adopt: (taskId: string, binding: NonNullable<Task['petstory']>) => Task;
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
    firstFrames: plan.shots.filter((s): boolean => s.transition === 'cut' && !p.production?.shots[s.id]?.firstFrameId).length,
    lastFrames: modes.filter((m, i): boolean => m === 'first_last_frame' && !p.production?.shots[plan.shots[i].id]?.plannedEndImageId).length,
    videos: plan.shots.filter((s): boolean => !p.production?.shots[s.id]?.videoId).length };
}
function referenceNumber(value: string): number {
  if (/^[0-9]+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let result = 0; let digit = 0;
  for (const token of value) {
    if (token in digits) digit = digits[token];
    else if (token in units) { result += (digit || 1) * units[token]; digit = 0; }
    else return NaN;
  }
  return result + digit;
}
/** 只检查编号和明确角色映射；不改写 P3 final，也不把文字检查当内容质检。 */
function checkReferenceSlots(final: string, characters: PetStoryPlan['characters'], slots: Array<string | undefined>): void {
  if (/(?:file:\/\/|\/(?:Users|home|tmp)\/|[A-Za-z]:\\)/.test(final)) throw new Error('最终提示词包含文件路径，不能把路径当作已上传素材');
  if (!final.trim() || /@(?:Image|Video|Audio)\b/i.test(final)) throw new Error('最终提示词为空或含未验证引用语法');
  const references = [...final.matchAll(/(?:第\s*([0-9零一二两三四五六七八九十百千]+)\s*张(?:参考)?图|(?:参考)?图\s*([0-9一二两三四五六七八九十百千]+))/g)];
  for (const reference of references) {
    const index = referenceNumber(reference[1] || reference[2]) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= slots.length) throw new Error('最终提示词中的图片编号没有对应实际上传；请在确认前使用 P3 修正最终文本');
    const following = final.slice((reference.index || 0) + reference[0].length).match(/^[\s：:=（(、]*(?:是|为|对应)?([^，。；;\n)）]{1,40})/u)?.[1] || '';
    const named = characters.find((c): boolean => following.startsWith(c.name) || following.startsWith(c.id));
    if (named && slots[index] !== named.id) throw new Error('最终提示词角色与实际图片顺序错绑；场景首帧不能冒充单独角色图');
  }
}
export function checkProductionReferences(final: string, p: PetStoryProject, assetIds: string[]): void {
  checkReferenceSlots(final, p.plan?.characters || [], assetIds.map((id): string | undefined => p.assets.find((a): boolean => a.id === id)?.characterId));
}
function checkPlannedReferences(p: PetStoryProject, capability: PetStoryCapability, fallbacks: Record<string, 'first_frame' | 'reference'>): void {
  const plan = requireValue(p.plan);
  for (const shot of plan.shots) {
    const mode = resolvePetStoryMode(shot, capability, fallbacks[shot.id]).resolvedMode;
    if (shot.transition === 'cut') checkReferenceSlots(shot.prompts.firstFrame.final, plan.characters, [...shot.characterIds, ...(shot.sceneReferenceAssetIds || []).map((): undefined => undefined)]);
    if (mode === 'first_last_frame') checkReferenceSlots(requireValue(shot.prompts.lastFrame).final, plan.characters, [undefined]);
    checkReferenceSlots(shot.prompts.video.final, plan.characters, mode === 'first_last_frame' ? [undefined, undefined] : [undefined]);
  }
}
/** 线性业务接力。只准备原 TaskService 的单个 hold 任务，发送仍由原队列和 BrowserPanel 完成。 */
export class PetStoryProductionService {
  private readonly authorized = new Set<string>();
  private readonly validated = new Map<string, string>();
  suspend(id: string): void { this.authorized.delete(id); }
  constructor(private readonly projects: PetStoryProjects, private readonly tasks: ProductionPort) {}

  async preview(id: string, capability: PetStoryCapability, fallbacks: Record<string, 'first_frame' | 'reference'>): Promise<PetStoryProductionResult> {
    const p = await this.projects.read(id);
    this.checkCapability(p, capability);
    checkPlannedReferences(p, capability, fallbacks);
    return { success: true, project: p, counts: productionCounts(p, capability, fallbacks), resolutions: Object.fromEntries(requireValue(p.plan).shots.map((shot): [string, ReturnType<typeof resolvePetStoryMode>] => [shot.id, resolvePetStoryMode(shot, capability, fallbacks[shot.id])])) };
  }
  private checkCapability(p: PetStoryProject, c: PetStoryCapability): void {
    if (!c || c.accountId !== p.accountId || !Number.isFinite(Date.parse(c.checkedAt)) || !c.modes || !Array.isArray(c.durations)
      || !['visible', 'user_confirmed', 'unknown'].includes(c.freeEvidence)) throw new Error('当前原账号的入口核对结果缺失');
    if (Date.now() - Date.parse(c.checkedAt) > 30 * 60_000 || Date.parse(c.checkedAt) > Date.now() + 60_000) throw new Error('入口核对已过期，请本人重新核对当前免费入口后继续');
    if (c.freeEvidence === 'unknown') throw new Error('免费权益未知，零提交；本地计划数量不是官方剩余额度');
  }
  async approve(id: string, revision: number, capability: PetStoryCapability, fallbacks: Record<string, 'first_frame' | 'reference'>): Promise<PetStoryProductionResult> {
    let p = await this.projects.read(id);
    if (p.revision !== revision) throw new Error('项目版本已变化，请重新确认制作计划');
    if (p.production) throw new Error('制作计划已确认，请继续原制作，不重复创建');
    if (!p.plan || !p.mobileStory || p.source.status !== 'review_required') throw new Error('请先保存有效的 P2/P3 制作方案');
    this.checkCapability(p, capability);
    const counts = productionCounts(p, capability, fallbacks);
    checkPlannedReferences(p, capability, fallbacks);
    if ((counts.newCharacters + counts.firstFrames + counts.lastFrames) > 0 && (capability.image.state !== 'supported' || capability.image.free !== 'free')) throw new Error('本计划需要新增图片，但当前图片免费入口未知或不足');
    for (const char of p.plan.characters.filter((c): boolean => c.role === 'main')) {
      if (!char.referenceAssetId) throw new Error(`${char.name}必须使用本人确认的参考图`);
      await this.assetFile(p, char.referenceAssetId, 'image');
    }
    const usedCharacters = new Set(p.plan.shots.flatMap((s): string[] => s.characterIds));
    for (const char of p.plan.characters.filter((c): boolean => usedCharacters.has(c.id) && !!c.referenceAssetId)) await this.assetFile(p, requireValue(char.referenceAssetId), 'image');
    for (const shot of p.plan.shots) for (const assetId of shot.sceneReferenceAssetIds || []) await this.assetFile(p, assetId, 'image');
    p.production = { state: 'running', planHash: productionPlanHash(p.plan), approvedAt: new Date().toISOString(), capability, fallbacks,
      shots: Object.fromEntries(p.plan.shots.map((s): [string, ReturnType<typeof resolvePetStoryMode>] => [s.id, resolvePetStoryMode(s, capability, fallbacks[s.id])])), steps: [], message: '计划已确认，准备顺序制作' };
    p = await this.projects.write(p);
    this.authorized.add(id);
    return { success: true, project: p, counts };
  }
  async pause(id: string, message = '用户已暂停；点击继续后沿用原任务'): Promise<PetStoryProductionResult> {
    this.authorized.delete(id);
    const p = await this.projects.read(id);
    if (!p.production) throw new Error('尚未确认制作方案');
    p.production.state = 'paused'; p.production.message = message;
    return { success: true, project: await this.projects.write(p), taskId: p.production.steps.find((s): boolean => s.status !== 'complete')?.taskId };
  }
  async resume(id: string, capability: PetStoryCapability): Promise<PetStoryProductionResult> {
    const p = await this.projects.read(id);
    if (!p.production || !p.plan || productionPlanHash(p.plan) !== p.production.planHash) throw new Error('原制作计划不存在或已经改变');
    const pending = p.production.steps.find((s): boolean => s.status !== 'complete');
    const pendingTask = pending?.taskId ? this.originalTask(p, pending) : undefined;
    const readOnly = pendingTask?.status === 'done' || !!pendingTask?.runtime?.submittedAt;
    if (!readOnly) {
      this.checkCapability(p, capability);
      // 刷新安全回读不改变已批准的模式；已受理／下载步骤不因免费未知受阻。
      for (const shot of p.plan.shots) {
        const selected = p.production.shots[shot.id];
        if (!selected.videoId && resolvePetStoryMode(shot, capability, p.production.fallbacks[shot.id]).resolvedMode !== selected.resolvedMode) throw new Error(`${shot.id}当前入口与原批准模式不同，请处理原入口，不能静默换模式`);
      }
    } else if (capability?.accountId !== p.accountId) throw new Error('原账号不符，禁止切换账号');
    if (pending?.taskId) {
      const task = this.originalTask(p, pending);
      if (!task.runtime?.submittedAt && !['queued', 'executing', 'generating', 'done'].includes(task.status)) {
        if (!safePreparationFailure(task.errorInfo?.code || '')
          || task.runtime?.acceptanceObservation || task.outputs.length) throw new Error('原任务未确认可安全恢复，仅保留原任务核对，不重发');
        pending.runId = undefined;
        const held = await this.projects.write(p);
        this.tasks.retryUnsubmitted(task.id);
        return this.resume(held.id, capability);
      }
    }
    p.production.capability = capability; p.production.state = 'running'; p.production.message = '继续原任务与素材，未授权重复发送';
    const saved = await this.projects.write(p);
    this.authorized.add(id);
    return { success: true, project: saved };
  }
  private checked(p: PetStoryProject): NonNullable<PetStoryProject['production']> {
    if (!p.production || !p.plan || p.production.planHash !== productionPlanHash(p.plan)) throw new Error('制作计划与原确认不一致');
    return p.production;
  }
  async assetFile(p: PetStoryProject, id: string, kind: 'image' | 'video'): Promise<string> {
    const asset = p.assets.find((a): boolean => a.id === id);
    if (!asset || (kind === 'video' ? asset.kind !== 'video' : asset.kind === 'video')) throw new Error('素材未登记或类别不符');
    if (kind === 'video') {
      const step = p.production?.steps.find((s): boolean => s.kind === 'video' && s.assetId === asset.id && s.status === 'complete');
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
    this.checkCapability(p, production.capability);
    await this.validateStepInputs(p, step, task);
    const shot = p.plan?.shots.find((s): boolean => s.id === step.shotId);
    const guard: PetStoryExecutionGuard = { capability: production.capability, mode: shot ? production.shots[shot.id].resolvedMode : undefined,
      durationSeconds: shot?.durationSeconds, attachmentAssetIds: step.attachmentAssetIds };
    return { success: true, guard };
  }
  private async validateStepInputs(p: PetStoryProject, step: PetStoryProductionStep, task: Task): Promise<void> {
    const production = this.checked(p);
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
    if (step.kind === 'video' && (!shot || task.videoConfig?.duration !== `${shot.durationSeconds}s` || !production.capability.durations.includes(shot.durationSeconds))) throw new Error('视频时长不符，零提交');
    if (step.kind === 'video' && shot && resolvePetStoryMode(shot, production.capability, production.fallbacks[shot.id]).resolvedMode !== production.shots[shot.id].resolvedMode) throw new Error('视频免费入口与已批准模式不符，零提交');
    if (step.kind !== 'video' && (production.capability.image.state !== 'supported' || production.capability.image.free !== 'free')) throw new Error('图片免费入口未知或不足，保留进度');
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
      const required = new Set(plan.shots.flatMap((s): string[] => s.characterIds));
      for (const char of plan.characters.filter((c): boolean => required.has(c.id))) {
        if (char.referenceAssetId) { await this.assetFile(p, char.referenceAssetId, 'image'); continue; }
        if (char.role === 'main') throw new Error(`${char.name}缺少本人确认的参考图`);
        // 配角的确定性单帧提示词来自已批准的角色描述，不另起模型或优化器。
        const prompt = `生成一张单幅角色参考图。角色：${char.name}。剧情作用：${char.purpose}。外观与服装：${char.description}。清晰展示完整角色，不要拼贴、多格或文字；跨镜头保持此身份。`;
        return await this.prepareStep(p, { kind: 'character', characterId: char.id }, { prompts: [prompt], mode: 'image', projectId: p.studioProjectId, executionIntent: 'hold', attachments: [] }, []);
      }
      for (const shot of plan.shots) {
        const media = production.shots[shot.id];
        if (media.videoId) { await this.assetFile(p, media.videoId, 'video'); continue; }
        if (!media.firstFrameId && shot.transition === 'continue') {
          const previous = production.shots[requireValue(shot.previousShotId)];
          const video = p.assets.find((a): boolean => a.id === previous?.videoId && a.kind === 'video' && a.shotId === shot.previousShotId);
          if (!video?.taskId || !video.runId) throw new Error('上一镜头尚无实际选中视频，不能使用计划尾帧');
          const source = await this.assetFile(p, video.id, 'video');
          const frameId = randomUUID();
          const relativePath = `shots/${shot.id}/${frameId}.png`;
          const extracted = await extractActualEndFrame(source, await projectPath(this.projects.directory(id), relativePath));
          const sourceVideo = { assetId: video.id, taskId: video.taskId, runId: video.runId, sha256: requireValue(video.validation).sha256, atSeconds: extracted.atSeconds };
          p.assets.push({ id: frameId, kind: 'actualEndFrame', shotId: shot.id, relativePath, validation: extracted.validation, sourceVideo });
          media.actualEndFrameId = frameId; media.firstFrameId = frameId; media.startFromPreviousEnd = sourceVideo;
          p = await this.projects.write(p);
          return { success: true, project: p, action: 'wait' };
        }
        const characterAssets = shot.characterIds.map((charId): string => {
          const assetId = plan.characters.find((c): boolean => c.id === charId)?.referenceAssetId;
          if (!assetId || !p.assets.some((a): boolean => a.id === assetId && a.characterId === charId)) throw new Error(`${charId}参考图错绑`);
          return assetId;
        });
        const kind: 'firstFrame' | 'lastFrame' | 'video' = !media.firstFrameId ? 'firstFrame' : media.resolvedMode === 'first_last_frame' && !media.plannedEndImageId ? 'lastFrame' : 'video';
        const assetIds = kind === 'firstFrame' ? [...characterAssets, ...(shot.sceneReferenceAssetIds || [])] : kind === 'lastFrame' ? [requireValue(media.firstFrameId)] : media.resolvedMode === 'first_last_frame' ? [requireValue(media.firstFrameId), requireValue(media.plannedEndImageId)] : [requireValue(media.firstFrameId)];
        const attachments = await Promise.all(assetIds.map((assetId): Promise<string> => this.assetFile(p, assetId, 'image')));
        if (kind === 'video' && media.resolvedMode === 'first_last_frame') {
          const first = requireValue(requireValue(p.assets.find((a): boolean => a.id === media.firstFrameId)).validation);
          const last = requireValue(requireValue(p.assets.find((a): boolean => a.id === media.plannedEndImageId)).validation);
          if (first.width * last.height !== last.width * first.height) throw new Error('首尾帧宽高比不同，停止视频制作');
        }
        const config = kind === 'video' ? { ...requireValue(production.capability.videoConfig), duration: `${shot.durationSeconds}s` as NonNullable<Task['videoConfig']>['duration'] } : undefined;
        const input = finalTaskInput(plan, shot.id, kind, attachments, p.studioProjectId, config);
        return await this.prepareStep(p, { kind, shotId: shot.id }, input, assetIds);
      }
      production.state = 'complete'; production.message = 'P4 全部镜头真实素材已下载并校验；等待用户决定 P5';
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
  private async prepareStep(p: PetStoryProject, target: Pick<PetStoryProductionStep, 'kind' | 'shotId' | 'characterId'>, input: TaskAddParams, assetIds: string[]): Promise<PetStoryProductionResult> {
    const production = this.checked(p);
    this.checkCapability(p, production.capability);
    if (target.kind !== 'video' && (production.capability.image.state !== 'supported' || production.capability.image.free !== 'free')) throw new Error('图片免费入口未确认或额度不足');
    if (target.kind === 'video') {
      const shot = requireValue(p.plan?.shots.find((s): boolean => s.id === target.shotId));
      if (resolvePetStoryMode(shot, production.capability, production.fallbacks[shot.id]).resolvedMode !== production.shots[shot.id].resolvedMode) throw new Error('当前免费入口与原批准模式不同，零提交');
    }
    const final = input.prompts[0].trim();
    if (!final || /@(?:Image|Video|Audio)\b/i.test(final)) throw new Error('最终提示词为空或含未验证引用语法');
    checkProductionReferences(final, p, assetIds);
    const step: PetStoryProductionStep = { ...target, id: randomUUID(), inputHash: hash(final), attachmentAssetIds: assetIds, status: 'preparing' };
    production.steps.push(step); production.message = `${target.characterId || target.shotId} · ${target.kind}`;
    // 创建前先登记意图；两文件写入间退出时宁可停下核对，不自动多建一次。
    p = await this.projects.write(p);
    const binding = { projectId: p.id, stepId: step.id };
    const draft = target.kind === 'firstFrame' ? p.drafts?.find((d): boolean => d.shotId === target.shotId && d.kind === 'firstFrame' && d.final === final) : undefined;
    const old = draft ? this.tasks.list().find((t): boolean => t.id === draft.taskId) : undefined;
    let task: Task;
    if (old && old.projectId === p.studioProjectId && old.assignedAccountId === p.accountId && old.prompt === final && JSON.stringify(old.attachments || []) === JSON.stringify(input.attachments || [])) task = this.tasks.adopt(old.id, binding);
    else task = this.tasks.create({ ...input, petstory: binding, executionIntent: 'hold' }, p.accountId);
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
  private async collectMedia(p: PetStoryProject, step: PetStoryProductionStep, task: Task): Promise<void> {
    if (!step.runId || task.runtime?.runId !== step.runId || !task.runtime.submittedAt) throw new Error('生成结果缺少原运行与单次提交记录');
    const kind = step.kind === 'video' ? 'video' : 'image';
    const artifacts = task.outputs.flatMap((url): NonNullable<Task['artifacts']> => (task.artifacts || []).filter((a): boolean => a.url === url && a.runId === step.runId && a.kind === kind && !['invalid', 'expired'].includes(a.validation?.state || '') && !step.rejectedArtifactIds?.includes(a.id)));
    if (!artifacts.length) throw new Error('没有属于原运行的可用真实产物，done 或缩略图不算媒体');
    // 固定选择规则：按本次 outputs 顺序，选择第一个下载且可解码的有效产物。
    for (const artifact of artifacts) {
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
        continue; // 仅在本次同一输出列表内按顺序找有效文件，不发起新生成。
      }
      const assetId = randomUUID();
      const ext = kind === 'video' ? '.mp4' : path.extname(job.filePath).toLowerCase();
      if (!['.mp4', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('下载图片扩展名异常，未绑定');
      const relativePath = step.kind === 'character' ? `characters/${assetId}${ext}` : `shots/${step.shotId}/${assetId}${ext}`;
      const destination = await projectPath(this.projects.directory(p.id), relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await projectPath(this.projects.directory(p.id), relativePath);
      await fs.copyFile(job.filePath, destination, 1);
      if ((await mediaDigest(destination)).sha256 !== validation.sha256) throw new Error('下载复制后的素材校验不一致');
      const asset: PetStoryAsset = { id: assetId, kind: step.kind === 'lastFrame' ? 'plannedEndImage' : step.kind, relativePath,
        shotId: step.shotId, characterId: step.characterId, taskId: task.id, runId: step.runId, artifactId: artifact.id, downloadJobId: job.id, validation };
      p.assets.push(asset); step.assetId = assetId; step.status = 'complete'; step.error = undefined;
      if (step.kind === 'character') requireValue(requireValue(p.plan).characters.find((c): boolean => c.id === step.characterId)).referenceAssetId = assetId;
      else {
        const media = this.checked(p).shots[requireValue(step.shotId)];
        if (step.kind === 'firstFrame') media.firstFrameId = assetId;
        else if (step.kind === 'lastFrame') media.plannedEndImageId = assetId;
        else media.videoId = assetId;
      }
      return;
    }
    await this.projects.write(p);
    throw new Error(step.error || '本次返回的产物均未通过文件校验；保留原任务，不重新生成');
  }
}
