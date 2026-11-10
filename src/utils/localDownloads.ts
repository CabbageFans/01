import type { DownloadJob, GenerationMode, Task } from '../types';
export interface DownloadedOutputIdentity { taskId: string; runId?: string; artifactId?: string; url: string; accountId: string | null; mode: GenerationMode; startedAt?: string }
/** UI只定位台账身份；文件、目录和hash由主进程重新验证。 */
export function findLocalDownload(jobs: DownloadJob[], source: DownloadedOutputIdentity): DownloadJob | undefined {
  return [...jobs].reverse().find((job: DownloadJob): boolean => {
    if (job.status !== 'done' || !job.filePath || job.taskId !== source.taskId || job.accountId !== source.accountId || job.mode !== source.mode) return false;
    if (source.runId && job.runId && source.runId !== job.runId || source.artifactId && job.artifactId && source.artifactId !== job.artifactId) return false;
    if (source.runId && job.runId && source.artifactId && job.artifactId) return true;
    if (source.startedAt && !job.runId && Date.parse(job.createdAt) < Date.parse(source.startedAt)) return false;
    return job.url === source.url;
  });
}
/** 旧任务已清理的未知归属下载仍可查看；明确属于其他项目的记录不混入当前项目。 */
export function projectDownloadJobs(jobs: DownloadJob[], tasks: Task[], projectId: string): DownloadJob[] {
  return jobs.filter((job: DownloadJob): boolean => {
    const owner = job.projectId || tasks.find((task: Task): boolean => task.id === job.taskId)?.projectId;
    return !owner || owner === projectId;
  });
}
