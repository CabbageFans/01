import { describe, expect, it } from 'vitest';
import type { DownloadJob, PetStoryProject, Task } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { TaskRepository } from '../../main/core/TaskRepository';
import { TaskEventStream } from '../../main/core/TaskEventStream';
import { normalizeTasks } from '../../main/utils/persistenceNormalization';
import { buildPetStoryDiagnostics } from '../../main/utils/petstoryDiagnostics';
import { buildVideoWorkflowDiagnostics, saveAdapterDiagnostic } from '../../main/utils/videoWorkflowDiagnostics';

const startedAt = '2026-11-10T00:00:00.000Z';
const privatePrompt = 'PRIVATE PROMPT never included in diagnostic exports';
function fixture(): { service: TaskService; repository: TaskRepository; project: PetStoryProject; download: DownloadJob } {
  const original: Task = { id: 'task', projectId: 'studio', petstory: { projectId: 'project', stepId: 'step' }, prompt: privatePrompt,
    assignedAccountId: 'account', status: 'executing', mode: 'video', result: null, outputs: [], createdAt: startedAt, updatedAt: startedAt,
    runtime: { runId: 'run', attempt: 1, stage: 'submitting', message: '', startedAt, stageStartedAt: startedAt, lastHeartbeatAt: startedAt,
      submittedAt: startedAt, conversationUrl: 'https://www.doubao.com/chat/PRIVATE-conversation',
      input: { prompt: privatePrompt, mode: 'video', attachments: ['/Users/private/secret-reference.png'] } } };
  let json = JSON.stringify([original]); let now = startedAt;
  const repository = new TaskRepository({ read: (): unknown => JSON.parse(json), write: (_file: string, tasks: Task[]): boolean => { json = JSON.stringify(tasks); return true; },
    normalize: normalizeTasks, defaultProjectId: (): string => 'studio', events: new TaskEventStream() });
  const service = new TaskService({ store: repository, defaultProjectId: (): string => 'studio', now: (): string => now });
  expect(service.updateRuntime({ taskId: 'task', expectedRunId: 'run', runtime: { stage: 'submitting' } }).success).toBe(true);
  now = '2026-11-10T00:00:05.000Z';
  expect(service.updateRuntime({ taskId: 'task', expectedRunId: 'run', status: 'generating', runtime: { stage: 'generating',
    submission: { schemaVersion: 1, operationId: 'operation', runId: 'run', state: 'accepted', updatedAt: now },
    executionDiagnostics: { videoObservation: { status: 'resolved', pollCount: 2, elapsedMs: 4000, observedAt: now, source: 'platform_download_info' } },
  } }).success).toBe(true);
  now = '2026-11-10T00:00:09.000Z';
  expect(service.updateStatus({ taskId: 'task', expectedRunId: 'run', status: 'done', outputs: ['https://fixture.invalid/video.mp4?token=PRIVATE-signature'] }).success).toBe(true);
  expect(service.updateRuntime({ taskId: 'task', expectedRunId: 'run', status: 'done', runtime: { stage: 'completed' } }).success).toBe(true);
  const completed = repository.read()[0]; const artifactId = completed.artifacts![0].id;
  // 本测试仅验证既有媒体检测元数据的诊断投影，不把夹具称为解码或播放实测。
  const project: PetStoryProject = { schemaVersion: 1, id: 'project', studioProjectId: 'studio', accountId: 'account', revision: 3,
    source: { kind: 'script', url: '', status: 'pending' }, jobs: [], updatedAt: now, assets: [{ id: 'asset', kind: 'video', relativePath: 'outputs/PRIVATE-file.mp4',
      shotId: 'shot', taskId: 'task', runId: 'run', artifactId, downloadJobId: 'download',
      validation: { decoded: true, sha256: 'a'.repeat(64), bytes: 1024, width: 1280, height: 720, durationSeconds: 5, checkedAt: now } }],
    production: { state: 'complete', planHash: 'plan', approvedAt: startedAt, capability: { accountId: 'account', checkedAt: startedAt,
      image: { state: 'unknown', reason: '' }, modes: { first_frame: { state: 'unknown', reason: '' }, first_last_frame: { state: 'unknown', reason: '' }, reference: { state: 'unknown', reason: '' } }, durations: [] },
      fallbacks: {}, shots: {}, message: '', steps: [{ id: 'step', kind: 'video', shotId: 'shot', taskId: 'task', runId: 'run', inputHash: 'b'.repeat(64), attachmentAssetIds: [], status: 'complete', assetId: 'asset' }] } };
  const download: DownloadJob = { id: 'download', taskId: 'task', runId: 'run', artifactId, inputVersion: 1, accountId: 'account', mode: 'video',
    url: completed.outputs[0], status: 'done', attempts: 1, saveDir: '/Users/private/exports', filePath: '/Users/private/exports/PRIVATE-file.mp4', bytes: 1024, createdAt: now, updatedAt: now };
  return { service, repository, project, download };
}

describe('现有任务诊断包的视频链路投影', (): void => {
  it('按同一project/shot/step/task/run关联阶段、提交、观察、下载、资产、适配报告和原日志', (): void => {
    const test = fixture(); const diagnostic = test.service.buildTaskDiagnostics(); if (!diagnostic.success) throw new Error(diagnostic.error);
    const bundle = buildVideoWorkflowDiagnostics({ build: { appVersion: 'TEST', platform: 'offline' }, exportedAt: '2026-11-10T00:00:10.000Z',
      tasks: test.repository.read(), taskDiagnostics: diagnostic.data, projects: [buildPetStoryDiagnostics(test.project)], downloads: [test.download],
      accounts: [{ id: 'account' }], adapterReports: [{ taskId: 'task', runId: 'run', accountId: 'account', score: 90, items: [] }],
      logs: [{ id: 'log', taskId: 'task', runId: 'run', level: 'info', scope: 'automation', message: '任务完成', createdAt: startedAt }] });
    expect(bundle.runs).toMatchObject([{ projectId: 'project', shotId: 'shot', stepId: 'step', taskId: 'task', runId: 'run', stage: 'completed',
      submission: { state: 'accepted' }, observation: { status: 'resolved', pollCount: 2 }, downloadJobIds: ['download'], assetIds: ['asset'], logIds: ['log'], adapterReportIndexes: [0],
      phaseHistory: [{ stage: 'submitting', elapsedMs: 5000 }, { stage: 'generating', elapsedMs: 4000 }, { stage: 'completed', elapsedMs: 1000 }] }]);
  });

  it('导出移除正文、内部URL、素材路径和凭据，但保留媒体hash与故障分类', (): void => {
    const test = fixture(); const diagnostic = test.service.buildTaskDiagnostics(); if (!diagnostic.success) throw new Error(diagnostic.error);
    const bundle = buildVideoWorkflowDiagnostics({ build: { appVersion: 'TEST', platform: 'offline' }, exportedAt: startedAt,
      tasks: test.repository.read(), taskDiagnostics: diagnostic.data, projects: [buildPetStoryDiagnostics(test.project)], downloads: [test.download], accounts: [],
      adapterReports: [{ accountId: 'account', pageUrl: 'https://www.doubao.com/chat/PRIVATE-url', cookie: 'PRIVATE-cookie', token: 'PRIVATE-token',
        items: [{ key: 'composer', label: '输入区', ok: false, detail: privatePrompt + ' https://fixture.invalid/PRIVATE-address' }] }],
      logs: [{ id: 'failure', taskId: 'task', runId: 'run', scope: 'tool_missing', message: privatePrompt + '\nAuthorization: Bearer PRIVATE-auth\nCookie: session=PRIVATE-cookie\n/Users/private/secret.mp4' }] });
    const serialized = JSON.stringify(bundle);
    for (const secret of [privatePrompt, 'PRIVATE-conversation', 'PRIVATE-signature', 'PRIVATE-cookie', 'PRIVATE-token', 'PRIVATE-auth', 'PRIVATE-url', 'PRIVATE-address', '/Users/private', 'PRIVATE-file.mp4']) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('tool_missing'); expect(serialized).toContain('a'.repeat(64));
  });

  it('任务已清理时仍可凭项目来源关联本地资产，明确标记taskMissing', (): void => {
    const test = fixture();
    const bundle = buildVideoWorkflowDiagnostics({ build: { appVersion: 'TEST', platform: 'offline' }, exportedAt: startedAt, tasks: [], taskDiagnostics: [],
      projects: [buildPetStoryDiagnostics(test.project)], downloads: [test.download], adapterReports: [], logs: [], accounts: [] });
    expect(bundle.runs).toMatchObject([{ taskId: 'task', runId: 'run', taskMissing: true, assetIds: ['asset'], downloadJobIds: ['download'] }]);
  });

  it('适配报告保存失败不得返回成功，未知正文与页面凭据不保存', (): void => {
    let stored: Record<string, unknown>[] = [];
    const report = { adapterVersion: 'TEST', pageUrl: 'https://www.doubao.com/chat/private', cookie: 'PRIVATE-cookie', text: privatePrompt, items: [] };
    const storage = { read: (): unknown => stored, write: (value: Record<string, unknown>[]): boolean => { stored = value; return false; }, now: (): string => startedAt };
    expect(saveAdapterDiagnostic(report, { accountId: 'account', taskId: 'task', runId: 'run' }, storage)).toMatchObject({ success: false, error: expect.stringContaining('写入失败') });
    expect(JSON.stringify(stored)).not.toContain('PRIVATE'); expect(JSON.stringify(stored)).not.toContain('doubao.com');
    storage.write = (value: Record<string, unknown>[]): boolean => { stored = value; return true; };
    expect(saveAdapterDiagnostic(report, { accountId: 'account', taskId: 'task', runId: 'run' }, storage).success).toBe(true);
    expect(stored[0]).toMatchObject({ accountId: 'account', taskId: 'task', runId: 'run' });
  });
});
