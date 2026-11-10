import type { DownloadJob, Task } from '@doubao-studio/contracts';
import { diagnosticText } from './petstoryDiagnostics';

type JsonRecord = Record<string, unknown>;
export interface WorkflowDiagnosticInput {
  build: { appVersion: string; platform: string; electronVersion?: string; nodeVersion?: string };
  exportedAt: string;
  tasks: Task[];
  taskDiagnostics: Task[];
  projects: object[];
  downloads: DownloadJob[];
  adapterReports: unknown;
  logs: unknown;
  accounts: object[];
}
function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
function records(value: unknown): JsonRecord[] { return Array.isArray(value) ? value.map(record) : []; }
const contentKeys = new Set(['prompt', 'sourceText', 'dialogue', 'rawText', 'text', 'original', 'optimized', 'final', 'generationPrompt', 'generationFinal']);
const locationKeys = new Set(['url', 'conversationUrl', 'pageUrl', 'filePath', 'saveDir', 'relativePath', 'directory']);

/** 复用现有诊断文本规则，并以本机原输入语料移除错误和日志中可能嵌入的正文。 */
export function redactWorkflowDiagnostic(value: unknown, secrets: readonly string[] = [], key = ''): unknown {
  if (/^(?:cookie|token|accessToken|refreshToken|session|authorization|bearer)$/i.test(key)) return undefined;
  if (typeof value === 'string') {
    if (contentKeys.has(key) || locationKeys.has(key)) return '[已脱敏]';
    let result = value;
    for (const secret of secrets) if (secret.length > 3) result = result.split(secret).join('[正文已脱敏]');
    return diagnosticText(result);
  }
  if (Array.isArray(value)) return value.map((item: unknown): unknown => redactWorkflowDiagnostic(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(record(value))
    .map(([field, item]: [string, unknown]): [string, unknown] => [field, redactWorkflowDiagnostic(item, secrets, field)])
    .filter((entry: [string, unknown]): boolean => entry[1] !== undefined));
  return value;
}

function inputSecrets(tasks: Task[]): string[] {
  return tasks.flatMap((task: Task): Array<string | undefined> => [task.prompt, task.runtime?.input.prompt, task.runtime?.chatResponse?.text,
    task.videoInputSnapshot?.sourceText, task.videoInputSnapshot?.dialogue, task.videoInputSnapshot?.prompt,
    task.runtime?.input.videoInputSnapshot?.sourceText, task.runtime?.input.videoInputSnapshot?.dialogue, task.runtime?.input.videoInputSnapshot?.prompt])
    .filter((value: string | undefined): value is string => typeof value === 'string' && value.length > 3).sort((left: string, right: string): number => right.length - left.length);
}

/** 适配诊断仅接受正式只读探针字段；未知页面正文、凭据和URL永不进入导出。 */
export function adapterDiagnostic(report: unknown): JsonRecord {
  const data = record(report);
  return { accountId: data.accountId, taskId: data.taskId, runId: data.runId, projectId: data.projectId, shotId: data.shotId, stepId: data.stepId,
    adapterVersion: data.adapterVersion, checkedAt: data.checkedAt, savedAt: data.savedAt, score: data.score,
    items: records(data.items).map((item: JsonRecord): object => ({ key: item.key, label: item.label, ok: item.ok, detail: item.detail })) };
}

export function saveAdapterDiagnostic(
  report: unknown,
  identity: { accountId: string; taskId?: string; runId?: string; projectId?: string; shotId?: string; stepId?: string },
  storage: { read: () => unknown; write: (reports: JsonRecord[]) => boolean; now: () => string },
): { success: boolean; error?: string } {
  try {
    const saved = redactWorkflowDiagnostic(adapterDiagnostic({ ...record(report), ...identity, savedAt: storage.now() })) as JsonRecord;
    const previous = records(storage.read()).map((previousReport: JsonRecord): JsonRecord => redactWorkflowDiagnostic(adapterDiagnostic(previousReport)) as JsonRecord);
    if (!storage.write([...previous, saved].slice(-50))) return { success: false, error: '页面适配诊断写入失败，请重试保存' };
    return { success: true };
  } catch { return { success: false, error: '页面适配诊断保存失败，请检查数据目录' }; }
}

function projectSteps(project: JsonRecord): JsonRecord[] {
  return records(project.productions).flatMap((production: JsonRecord): JsonRecord[] => records(production.steps)
    .map((step: JsonRecord): JsonRecord => ({ ...step, productionState: production.state, history: production.history })));
}

function runEntries(tasks: Task[], projects: JsonRecord[]): JsonRecord[] {
  const entries = new Map<string, JsonRecord>();
  const add = (entry: JsonRecord): void => {
    const key = [entry.projectId, entry.shotId, entry.stepId, entry.taskId, entry.runId].join(':');
    entries.set(key, { ...entries.get(key), ...entry });
  };
  for (const project of projects) {
    for (const step of projectSteps(project)) add({ projectId: project.projectId, shotId: step.shotId, stepId: step.stepId, taskId: step.taskId, runId: step.runId,
      productionState: step.productionState, stepStatus: step.status, inputVersion: step.inputVersion, inputDigest: step.inputDigest,
      failure: step.failure, mediaFailure: step.mediaFailure, history: step.history });
  }
  for (const task of tasks) {
    const runId = task.runtime?.runId;
    if (!runId || [...entries.values()].some((entry: JsonRecord): boolean => entry.taskId === task.id && entry.runId === runId)) continue;
    add({ projectId: task.petstory?.projectId || task.projectId, stepId: task.petstory?.stepId, shotId: task.runtime?.input.videoInputSnapshot?.shotId,
      taskId: task.id, runId, inputVersion: task.runtime?.input.videoInputSnapshot?.inputVersion, inputDigest: task.runtime?.input.videoInputSnapshot?.digest });
  }
  for (const project of projects) {
    for (const asset of records(project.assets)) {
      const source = record(asset.source); const taskId = asset.taskId || source.taskId; const runId = asset.runId || source.runId;
      if (!taskId || !runId || [...entries.values()].some((entry: JsonRecord): boolean => entry.taskId === taskId && entry.runId === runId)) continue;
      add({ projectId: project.projectId, shotId: asset.shotId, taskId, runId, inputDigest: source.inputHash });
    }
  }
  return [...entries.values()];
}

/** 原 tasks:exportDiagnostics 的关联投影；不维护日志，也不改变任何任务或项目。 */
export function buildVideoWorkflowDiagnostics(input: WorkflowDiagnosticInput): JsonRecord {
  const secrets = inputSecrets(input.tasks);
  const projects = input.projects.map(record);
  const reports = records(input.adapterReports).map(adapterDiagnostic);
  const logs = records(input.logs).map((log: JsonRecord): JsonRecord => ({ id: log.id, level: log.level, scope: log.scope, message: log.message,
    taskId: log.taskId, runId: log.runId, projectId: log.projectId, shotId: log.shotId, stepId: log.stepId, accountId: log.accountId, createdAt: log.createdAt }));
  const runs = runEntries(input.tasks, projects).map((entry: JsonRecord): JsonRecord => {
    const task = input.tasks.find((candidate: Task): boolean => candidate.id === entry.taskId);
    const runtime = task && task.runtime?.runId === entry.runId ? task.runtime : undefined;
    const project = projects.find((candidate: JsonRecord): boolean => candidate.projectId === entry.projectId);
    return { ...entry, taskMissing: !task, taskRevision: task?.revision, status: runtime ? task?.status : undefined, stage: runtime?.stage,
      inputSummary: runtime ? { mode: runtime.input.mode, promptLength: runtime.input.prompt.length, videoConfig: runtime.input.videoConfig,
        attachmentCount: runtime.input.attachments.length, inputVersion: runtime.input.videoInputSnapshot?.inputVersion,
        inputDigest: runtime.input.videoInputSnapshot?.digest, references: runtime.input.videoInputSnapshot?.references } : undefined,
      submission: runtime?.submission, phaseHistory: runtime?.phaseHistory?.map((phase): object => ({ ...phase,
        elapsedMs: Math.max(0, Date.parse(phase.leftAt || input.exportedAt) - Date.parse(phase.enteredAt)) })),
      observation: runtime?.executionDiagnostics?.videoObservation, error: runtime ? task?.errorInfo : undefined,
      localMedia: runtime?.localMedia,
      downloadJobIds: input.downloads.filter((job: DownloadJob): boolean => job.taskId === entry.taskId && job.runId === entry.runId).map((job: DownloadJob): string => job.id),
      assetIds: records(project?.assets).filter((asset: JsonRecord): boolean => (asset.taskId || record(asset.source).taskId) === entry.taskId
        && (asset.runId || record(asset.source).runId) === entry.runId).map((asset: JsonRecord): unknown => asset.assetId),
      logIds: logs.filter((log: JsonRecord): boolean => log.taskId === entry.taskId && log.runId === entry.runId).map((log: JsonRecord): unknown => log.id),
      legacyLogIds: logs.filter((log: JsonRecord): boolean => log.taskId === entry.taskId && !log.runId).map((log: JsonRecord): unknown => log.id),
      adapterReportIndexes: reports.flatMap((report: JsonRecord, index: number): number[] => report.taskId === entry.taskId && report.runId === entry.runId ? [index] : []),
    };
  });
  const downloads = input.downloads.map((job: DownloadJob): object => ({ jobId: job.id, taskId: job.taskId, runId: job.runId, artifactId: job.artifactId,
    inputVersion: job.inputVersion, status: job.status, attempts: job.attempts, bytes: job.bytes, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt }));
  return redactWorkflowDiagnostic({ schemaVersion: 2, exportedAt: input.exportedAt, build: input.build, appVersion: input.build.appVersion,
    platform: input.build.platform, taskCount: input.tasks.length, accountCount: input.accounts.length, tasks: input.taskDiagnostics,
    accounts: input.accounts, projects, downloads, adapterReports: reports, logs, runs }, secrets) as JsonRecord;
}
