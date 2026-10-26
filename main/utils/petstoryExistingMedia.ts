import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DownloadJob, PetStoryAsset, PetStoryMediaCandidate, PetStoryProject, PetStoryPromptKind, PetStoryResult, PetStoryProductionStep, Task } from '@doubao-studio/contracts';
import { PetStoryProjects, projectPath } from './petstoryProject';
import { identityAsset } from './petstoryPromptQuality';
import { parsePetStoryAnswer } from './petstoryValidation';
import { mediaDigest, validatePetStoryMedia } from './petstoryMedia';

interface ExistingMediaPort { list: () => Task[]; downloads: () => DownloadJob[] }
interface BodyMatch { final: string; jobId?: string }
const inputHash = (text: string): string => createHash('sha256').update(JSON.stringify(text)).digest('hex');
const imageKind = (kind: PetStoryPromptKind): PetStoryAsset['kind'] => kind === 'lastFrame' ? 'plannedEndImage' : kind;
const hasBody = (input: string, body: string): boolean => !!body.trim() && (input === body || input.endsWith(`\n${body}`));

/** 只承认可追溯的精确历史正文；不做相似度、镜号或文件名猜测。 */
function matchBody(p: PetStoryProject, task: Task, shotId: string, kind: PetStoryPromptKind): BodyMatch | undefined {
  const matches: { target: string; match: BodyMatch }[] = [];
  for (const shot of p.plan?.shots || []) {
    for (const promptKind of ['firstFrame', 'lastFrame', 'video'] as const) {
      if ((promptKind === 'video') !== (task.mode === 'video')) continue;
      const prompt = shot.prompts[promptKind]; if (!prompt) continue;
      const candidates: BodyMatch[] = [prompt.final, prompt.optimized, prompt.original].map((final: string): BodyMatch => ({ final }));
      for (const job of p.jobs.filter((j): boolean => j.kind === 'optimize' && j.status === 'applied' && j.shotId === shot.id && j.promptKind === promptKind && j.sourceStoryId === p.mobileStory?.id && !!j.rawText)) {
        try {
          const answer = parsePetStoryAnswer(job.rawText || '');
          if (typeof answer.optimized === 'string') candidates.unshift({ final: answer.optimized, jobId: job.id });
        } catch { /* 非可解析历史回复不能作为绑定证据。 */ }
      }
      for (const candidate of candidates) if (hasBody(task.prompt, candidate.final)) matches.push({ target: `${shot.id}:${promptKind}`, match: candidate });
    }
  }
  if (new Set(matches.map((m): string => m.target)).size !== 1 || matches[0]?.target !== `${shotId}:${kind}`) return undefined;
  return matches.sort((a, b): number => b.match.final.length - a.match.final.length || Number(!!b.match.jobId) - Number(!!a.match.jobId))[0]?.match;
}
function validTask(p: PetStoryProject, task: Task, kind: PetStoryPromptKind): boolean {
  return task.projectId === p.studioProjectId && task.assignedAccountId === p.accountId && task.mode === (kind === 'video' ? 'video' : 'image')
    && task.status === 'done' && !!task.runtime?.runId && !!task.runtime.submittedAt && task.runtime.input.prompt === task.prompt
    && JSON.stringify(task.runtime.input.attachments) === JSON.stringify(task.attachments || [])
    && JSON.stringify(task.runtime.input.videoConfig) === JSON.stringify(task.videoConfig)
    && (!task.petstory || task.petstory.projectId === p.id);
}
function validArtifacts(task: Task): NonNullable<Task['artifacts']> {
  return task.outputs.flatMap((url): NonNullable<Task['artifacts']> => (task.artifacts || []).filter((a): boolean => a.url === url && a.runId === task.runtime?.runId && a.kind === task.mode && !['invalid', 'expired'].includes(a.validation?.state || '')));
}
async function sameFileBytes(first: string, second: string): Promise<boolean> {
  const info = await fs.lstat(first); if (!info.isFile() || info.isSymbolicLink()) return false;
  const other = await fs.lstat(second); if (!other.isFile() || other.isSymbolicLink()) return false;
  return (await mediaDigest(first)).sha256 === (await mediaDigest(second)).sha256;
}

/** 端口不含 create/start/download：关联操作本身没有生成或补发能力。 */
export class PetStoryExistingMediaService {
  constructor(private readonly projects: PetStoryProjects, private readonly tasks: ExistingMediaPort) {}
  private download(task: Task, artifactId: string, p: PetStoryProject): DownloadJob | undefined {
    const artifact = validArtifacts(task).find((a): boolean => a.id === artifactId);
    return artifact ? this.tasks.downloads().find((d): boolean => d.taskId === task.id && d.accountId === p.accountId && d.mode === task.mode && d.url === artifact.url && d.status === 'done' && !!d.filePath) : undefined;
  }
  private async verifyLegacyInputs(p: PetStoryProject, task: Task, shotId: string, kind: PetStoryPromptKind, body: BodyMatch): Promise<boolean> {
    const shot = p.plan?.shots.find((s): boolean => s.id === shotId); if (!shot || kind === 'video') return false;
    if (kind === 'firstFrame') {
      const sources = shot.characterIds.flatMap((id: string): PetStoryAsset[] => { const asset = identityAsset(p, id); return asset ? [asset] : []; });
      const attachments = task.attachments || [];
      if (sources.length !== shot.characterIds.length || new Set(sources.map((a): string => a.id)).size !== sources.length || attachments.length !== sources.length) return false;
      const lines = sources.map((_asset: PetStoryAsset, index: number): string => {
        const name = p.plan?.characters.find((c): boolean => c.id === shot.characterIds[index])?.name || '';
        return `第 ${index + 1} 张：${name}身份与当前外观参考，不复制背景和姿势；明确换装以正文为准。`;
      });
      const expected = `生成一张静态首帧，呈现已确认的开始时刻，不拼贴多个动作阶段。\n${lines.join('\n')}\n\n${body.final}`;
      if (task.prompt !== expected) return false;
      for (let i = 0; i < sources.length; i++) if (!await sameFileBytes(attachments[i], await this.projects.referenceFile(p.id, sources[i].id))) return false;
      return true;
    }
    const expected = `编辑上传的首帧到已确认的终态；保持当前身份、服装、场景与画幅，允许姿态引起的合理衣褶和遮挡变化。\n第 1 张：本镜完整场景首帧，约束起始构图、姿态与道具。\n\n${body.final}`;
    if (task.prompt !== expected || task.attachments?.length !== 1) return false;
    for (const first of this.tasks.list().filter((t): boolean => validTask(p, t, 'firstFrame'))) {
      const firstBody = matchBody(p, first, shotId, 'firstFrame');
      if (!firstBody || !await this.verifyLegacyInputs(p, first, shotId, 'firstFrame', firstBody)) continue;
      for (const artifact of validArtifacts(first)) {
        const downloaded = this.download(first, artifact.id, p);
        if (downloaded?.filePath && await sameFileBytes(task.attachments[0], downloaded.filePath)) return true;
      }
    }
    return false;
  }
  private async verifyBinding(p: PetStoryProject, task: Task, shotId: string, kind: PetStoryPromptKind): Promise<BodyMatch | undefined> {
    if (!validTask(p, task, kind)) return undefined;
    const step = [p.production, ...(p.productionHistory || [])].flatMap((r): PetStoryProductionStep[] => r?.steps || []).find((s): boolean => s.taskId === task.id && s.shotId === shotId && s.kind === kind && s.runId === task.runtime?.runId && s.inputHash === inputHash(task.prompt) && s.compiledPrompt?.text === task.prompt);
    if (step?.compiledPrompt && task.petstory?.stepId === step.id) {
      if (step.attachmentAssetIds.length !== (task.attachments || []).length) return undefined;
      for (let i = 0; i < step.attachmentAssetIds.length; i++) if (!await sameFileBytes((task.attachments || [])[i], await this.projects.referenceFile(p.id, step.attachmentAssetIds[i]))) return undefined;
      return { final: step.compiledPrompt.final };
    }
    const body = matchBody(p, task, shotId, kind);
    return body && await this.verifyLegacyInputs(p, task, shotId, kind, body) ? body : undefined;
  }
  async candidates(id: string, shotId: string, kind: PetStoryPromptKind): Promise<PetStoryMediaCandidate[]> {
    const p = await this.projects.read(id);
    if (!p.plan?.shots.some((s): boolean => s.id === shotId && !!s.prompts[kind])) throw new Error('镜头或提示词用途不存在');
    const candidates: PetStoryMediaCandidate[] = [];
    for (const task of this.tasks.list()) {
      try {
        if (!await this.verifyBinding(p, task, shotId, kind)) continue;
        for (const artifact of validArtifacts(task)) if (this.download(task, artifact.id, p)) candidates.push({ taskId: task.id, artifactId: artifact.id, createdAt: task.createdAt });
      } catch { /* 缺失文件或旧绑定不作为可选项；不创建任何替代任务。 */ }
    }
    return candidates;
  }
  async link(id: string, revision: number, shotId: string, kind: PetStoryPromptKind, taskId: string, artifactId?: string): Promise<PetStoryResult> {
    const p = await this.projects.read(id);
    if (p.revision !== revision) throw new Error('项目版本已变化，请重新选择历史产物');
    if (p.production && p.production.state !== 'complete') throw new Error('原制作尚未结束，请先处理原任务');
    const task = this.tasks.list().find((t): boolean => t.id === taskId);
    const body = task ? await this.verifyBinding(p, task, shotId, kind) : undefined;
    if (!task || !body) throw new Error('原任务与本镜当前或历史正文、素材引用无法精确对应，未关联');
    const artifact = validArtifacts(task).find((a): boolean => !artifactId || a.id === artifactId);
    if (!artifact) throw new Error('请选择原运行仍有效的真实产物');
    const duplicate = p.assets.find((a): boolean => a.taskId === task.id && a.runId === task.runtime?.runId && a.artifactId === artifact.id);
    if (duplicate) {
      if (duplicate.shotId !== shotId || duplicate.kind !== imageKind(kind)) throw new Error('该产物已属于其他镜头或用途，不复用归属');
      return { success: true, project: p };
    }
    const downloaded = this.download(task, artifact.id, p);
    if (!downloaded?.filePath) throw new Error('原产物尚无完成的下载记录，请先重新下载原产物');
    const mediaKind = kind === 'video' ? 'video' : 'image';
    const fileInfo = await fs.lstat(downloaded.filePath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error('原下载文件缺失或路径无效');
    const validation = await validatePetStoryMedia(downloaded.filePath, mediaKind);
    const ext = mediaKind === 'video' ? '.mp4' : path.extname(downloaded.filePath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.mp4'].includes(ext)) throw new Error('原下载媒体扩展名无效');
    const assetId = randomUUID(); const relativePath = `shots/${shotId}/${assetId}${ext}`;
    const destination = await projectPath(this.projects.directory(id), relativePath); await fs.mkdir(path.dirname(destination), { recursive: true });
    await projectPath(this.projects.directory(id), relativePath); await fs.copyFile(downloaded.filePath, destination, 1);
    if ((await mediaDigest(destination)).sha256 !== validation.sha256) throw new Error('历史媒体复制后的摘要不一致，未关联');
    p.assets.push({ id: assetId, kind: imageKind(kind), shotId, relativePath, taskId: task.id, runId: task.runtime?.runId, artifactId: artifact.id, downloadJobId: downloaded.id, validation,
      origin: 'historical_task', generationPrompt: task.prompt, generationFinal: body.final, promptJobId: body.jobId });
    return { success: true, project: await this.projects.write(p) };
  }
}
