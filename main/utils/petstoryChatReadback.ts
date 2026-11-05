import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PetStoryChatJob, PetStoryProject, Task, TaskRunSnapshot } from '@doubao-studio/contracts';
import { parsePetStoryAnswer } from './petstoryValidation';

function sameIds(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && new Set(value).size === value.length && value.every((id: unknown): boolean => typeof id === 'string' && expected.includes(id));
}

/** 新任务精确使用持久业务归属；旧任务不从提示词猜测所属项目。 */
export function taskChatOwnershipMatches(project: PetStoryProject, job: PetStoryChatJob, task: Task): boolean {
  if (task.petstoryChat === undefined) return true;
  if (task.petstoryChat?.projectId !== project.id) return false;
  let current: PetStoryChatJob | undefined = job;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.taskId !== task.id) return false;
    if (task.petstoryChat.jobId === current.id) return true;
    seen.add(current.id);
    const selected = current.conversationReply;
    if (!selected) return false;
    const adjustment = [project.chatAdjustment, ...(project.chatAdjustmentHistory || [])].find((item): boolean => item?.id === selected.adjustmentId);
    if (!adjustment || adjustment.conversationUrl !== selected.conversationUrl || ![adjustment.selectedReplyKey, adjustment.adoptedReplyKey].includes(selected.reply.key)
      || !adjustment.replies.some((reply): boolean => isDeepStrictEqual(reply, selected.reply)) || current.rawText !== selected.reply.text) return false;
    const source = project.jobs.find((item): boolean => item.id === adjustment.sourceJobId);
    if (!source || source.id === current.id || source.inputHash !== current.inputHash || source.sourceStoryId !== current.sourceStoryId || source.sourceUrl !== current.sourceUrl
      || source.requestText !== current.requestText || source.runId !== task.runtime?.runId || current.status === 'invalid' && current.parentJobId !== source.id) return false;
    current = source;
  }
  return false;
}

function currentRequestMatches(project: PetStoryProject, job: PetStoryChatJob, task: Task): boolean {
  return !(job.runId || job.status !== 'bound' || job.endedWaitingAt || !job.requestId || !job.expectedIds?.length || new Set(job.expectedIds).size !== job.expectedIds.length
    || !project.mobileStory?.id || !job.sourceStoryId || job.sourceStoryId !== project.mobileStory.id || job.sourceUrl !== project.source.url || job.taskId !== task.id
    || project.jobs.filter((item): boolean => item.taskId === task.id && !item.conversationReply).length !== 1
    || !taskChatOwnershipMatches(project, job, task) || task.mode !== 'chat' || task.status !== 'done' || task.errorInfo || task.assignedAccountId !== project.accountId || task.projectId !== project.studioProjectId
    || job.requestText !== task.prompt || createHash('sha256').update(task.prompt).digest('hex') !== job.inputHash);
}
function completedRunEvidence(task: Task, runtime: TaskRunSnapshot): boolean {
  const history = task.runHistory;
  return !!runtime.runId && runtime.stage === 'completed' && !!runtime.submittedAt && runtime.input.mode === 'chat' && runtime.input.prompt === task.prompt
    && isDeepStrictEqual(runtime.input.attachments || [], task.attachments || []) && runtime.input.audioAttachment === task.audioAttachment && isDeepStrictEqual(runtime.input.videoConfig, task.videoConfig)
    && runtime.input.promptReadback === task.promptReadback && isDeepStrictEqual(runtime.input.petstory, task.petstory)
    && history?.length === 1 && history[0].runId === runtime.runId && history[0].attempt === runtime.attempt && history[0].outcome === 'done' && history[0].finalStage === 'completed';
}
function responseEvidenceMatches(job: PetStoryChatJob, runtime: TaskRunSnapshot): boolean {
  const readback = runtime.chatReadback;
  if (!readback || !job.expectedIds || readback.runId !== runtime.runId || !['full_prompt', 'recorded_turn', 'request_envelope'].includes(readback.association)) return false;
  if (readback.requestId !== undefined && readback.requestId !== job.requestId || readback.targetIds !== undefined && !sameIds(readback.targetIds, job.expectedIds)) return false;
  return readback.association !== 'request_envelope' || readback.requestId === job.requestId && sameIds(readback.targetIds, job.expectedIds);
}

/** 只恢复缺失关联，不替换已关联run；必须有唯一完成台账、精确原输入及已保存的响应归属证据。 */
export function completedChatRunForRecovery(project: PetStoryProject, job: PetStoryChatJob, task: Task): string | undefined {
  const runtime = task.runtime;
  if (!runtime?.chatResponse?.text || !job.expectedIds || !currentRequestMatches(project, job, task) || !completedRunEvidence(task, runtime) || !responseEvidenceMatches(job, runtime)) return undefined;
  try {
    const answer = parsePetStoryAnswer(runtime.chatResponse.text);
    return answer.requestId === job.requestId && sameIds(answer.targetIds, job.expectedIds) ? runtime.runId : undefined;
  } catch { return undefined; }
}
