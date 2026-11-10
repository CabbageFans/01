import type { DownloadJob, Task, TaskArtifact } from '@doubao-studio/contracts';
/** 旧台账仅在原URL和原运行时间都明确时兼容，禁止相同URL借用另一run的下载。 */
export function downloadBelongsToArtifact(job: DownloadJob, task: Task, artifact: TaskArtifact, accountId: string): boolean {
  if (job.taskId !== task.id || job.accountId !== accountId || job.mode !== task.mode || job.status !== 'done'
    || artifact.runId !== task.runtime?.runId) return false;
  if (job.runId !== undefined && job.runId !== artifact.runId || job.artifactId !== undefined && job.artifactId !== artifact.id) return false;
  if (job.runId && job.artifactId) return true;
  const started = Date.parse(task.runtime?.startedAt || ''); const downloaded = Date.parse(job.createdAt);
  return job.url === artifact.url && Number.isFinite(started) && Number.isFinite(downloaded) && downloaded >= started;
}
