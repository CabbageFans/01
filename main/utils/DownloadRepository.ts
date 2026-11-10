import type { DownloadJob } from '@doubao-studio/contracts';

export interface DownloadRepositoryPort {
  read: () => DownloadJob[];
  write: (jobs: DownloadJob[]) => boolean;
}
/** 下载台账只在同步短事务内读改写。网络层永不持有可写的整表快照。 */
export class DownloadRepository {
  constructor(private readonly port: DownloadRepositoryPort) {}
  list(): DownloadJob[] { return this.port.read(); }
  put(job: DownloadJob): DownloadJob {
    const jobs = this.port.read();
    const index = jobs.findIndex((stored: DownloadJob): boolean => stored.id === job.id);
    if (index >= 0) jobs[index] = structuredClone(job);
    else jobs.push(structuredClone(job));
    if (!this.port.write(jobs)) throw new Error('DOWNLOAD_LEDGER_WRITE_FAILED');
    return structuredClone(job);
  }
  patch(id: string, update: Partial<DownloadJob>): DownloadJob {
    const jobs = this.port.read();
    const index = jobs.findIndex((stored: DownloadJob): boolean => stored.id === id);
    if (index < 0) throw new Error('DOWNLOAD_JOB_NOT_FOUND');
    jobs[index] = { ...jobs[index], ...update, id };
    if (!this.port.write(jobs)) throw new Error('DOWNLOAD_LEDGER_WRITE_FAILED');
    return structuredClone(jobs[index]);
  }
}
