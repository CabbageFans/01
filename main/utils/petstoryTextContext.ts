import { characterVisualBasis } from './petstoryMaterials';
import type { PetStoryChatJob, PetStoryProject, PetStoryPrompt } from '@doubao-studio/contracts';

function targetPrompt(project: PetStoryProject, job: PetStoryChatJob): PetStoryPrompt | undefined {
  return job.materialId ? project.materials?.find((item): boolean => item.id === job.materialId)?.prompt
    : project.plan?.shots.find((item): boolean => item.id === job.shotId)?.prompts[job.promptKind || 'video'];
}

/** 本批候选仅在临时文字快照中参与共同设计；绝不写回正式正文或媒体引用。 */
export function promptTextContext(project: PetStoryProject, job: Pick<PetStoryChatJob, 'textContextJobIds' | 'promptBatchId'>): PetStoryProject {
  if (!job.textContextJobIds?.length) return project;
  const snapshot = structuredClone(project);
  for (const id of job.textContextJobIds) {
    const source = snapshot.jobs.find((item): boolean => item.id === id);
    const prompt = source ? targetPrompt(snapshot, source) : undefined;
    // 换图后已失效的基础文字及其旧镜头候选只留在任务历史，不投影回当前有效正文。
    if (prompt?.supersededByAssetId || source?.shotId && JSON.stringify(source.promptTask?.characterVisualBasis || {}) !== JSON.stringify(characterVisualBasis(snapshot, source.shotId))) continue;
    if (!source || !job.promptBatchId || source.promptBatchId !== job.promptBatchId || source.status !== 'applied'
      || !['candidate', 'adopted'].includes(source.resultStatus || '') || source.endedWaitingAt
      || !source.parsedResult?.optimized || !prompt) throw new Error('本批前序候选来源已变化，请保留结果并重新核对本项');
    const body = source.parsedResult.optimized;
    // 用户随后保存的不同正文优先，不能借临时上下文隐藏这类冲突。
    if (prompt.final !== body && source.inputFinal !== undefined && prompt.final !== source.inputFinal) throw new Error('前序正文已由用户修改，请基于当前正文重新生成本项');
    prompt.final = body; prompt.sourceJobId = source.id; prompt.edited = false; prompt.needsReview = undefined; prompt.visualBasisStale = undefined;
    prompt.promptTask = source.promptTask ? structuredClone(source.promptTask) : undefined;
    prompt.rulesVersion = source.rulesVersion || prompt.rulesVersion;
    source.resultStatus = 'adopted';
  }
  return snapshot;
}
