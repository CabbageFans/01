/** 真实项目磁盘、Core 授权与媒体校验；全部文件及请求均为 TEST 离线夹具。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DownloadJob, PetStoryCompiledPrompt, PetStoryPlan, PetStoryProductionStep, PetStoryProject, Task } from '@doubao-studio/contracts';
import { TaskService } from '../../main/core/TaskService';
import { PetStoryProjects, validateProject } from '../../main/utils/petstoryProject';
import { PetStoryExistingMediaService } from '../../main/utils/petstoryExistingMedia';
import { mediaCommand, validatePetStoryMedia } from '../../main/utils/petstoryMedia';
import snapshot from '../fixtures/storyboard-five-shots.json';

type History = NonNullable<PetStoryProductionStep['resubmissionHistory']>[number];
const now = '2026-10-31T02:00:00.000Z';
const submittedAt = '2026-10-31T01:00:00.000Z';
const hash = (text: string): string => createHash('sha256').update(JSON.stringify(text)).digest('hex');
let root: string; let picture: string; let otherPicture: string; let validation: Awaited<ReturnType<typeof validatePetStoryMedia>>;
let directory: string; let projects: PetStoryProjects; let project: PetStoryProject; let tasks: Task[]; let media: PetStoryExistingMediaService;
let sourceId: string; let artifactId: string; let assetFile: string;

beforeAll(async (): Promise<void> => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-resubmission-history-')); picture = path.join(root, 'TEST-blue.png'); otherPicture = path.join(root, 'TEST-red.png');
  for (const [color, file] of [['blue', picture], ['red', otherPicture]]) await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=64x96`, '-frames:v', '1', '-y', file]);
  validation = await validatePetStoryMedia(picture, 'image');
});
afterAll(async (): Promise<void> => { await fs.rm(root, { recursive: true, force: true }); });
beforeEach(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(root, 'TEST-project-')); projects = new PetStoryProjects();
  project = await projects.create(directory, 'TEST-studio', 'TEST-account'); project.plan = structuredClone(snapshot.plan) as PetStoryPlan;
  const shotId = project.plan.shots[0].id; const relativePath = `shots/${shotId}/TEST-reference.png`; assetFile = path.join(directory, relativePath);
  await fs.mkdir(path.dirname(assetFile), { recursive: true }); await fs.copyFile(picture, assetFile);
  project.assets = [{ id: 'TEST-reference', kind: 'scene', shotId, relativePath, validation }];
  const compiled: PetStoryCompiledPrompt = { text: 'TEST 旧请求：使用第 1 张图片，保留原构图。', final: 'TEST 原采用正文。', rulesVersion: 'TEST-rules', kind: 'firstFrame', requestedMode: 'auto',
    references: [{ assetId: 'TEST-reference', characterIds: [], purpose: 'scene', order: 1 }] };
  const source: Task = { id: 'TEST-original', projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'image', prompt: compiled.text,
    petstory: { projectId: project.id, stepId: 'TEST-step' }, promptReadback: 'exact', attachments: [assetFile], status: 'paused', executionIntent: 'armed', result: 'TEST 受理待核对', outputs: [], artifacts: [], createdAt: submittedAt, updatedAt: submittedAt,
    runtime: { runId: 'TEST-original-run', attempt: 1, stage: 'paused', message: 'TEST', startedAt: submittedAt, stageStartedAt: submittedAt, lastHeartbeatAt: submittedAt, submittedAt,
      input: { prompt: compiled.text, mode: 'image', attachments: [assetFile], petstory: { projectId: project.id, stepId: 'TEST-step' }, promptReadback: 'exact' } } };
  tasks = [source]; const core = new TaskService({ store: { read: (): Task[] => structuredClone(tasks), replace: (value: Task[]): boolean => { tasks = structuredClone(value); return true; } },
    defaultProjectId: (): string => project.studioProjectId, id: (): string => 'TEST-replacement', now: (): string => now });
  const request = { taskId: source.id, runId: source.runtime!.runId, submittedAt, authorizationId: 'TEST-resubmission-auth', acceptDuplicateRisk: true as const };
  const resubmitted = core.resubmitUncertain(request); if (!resubmitted.success) throw new Error(resubmitted.error);
  const adopted = core.bindPetStory(resubmitted.data.id, source.petstory!, 'TEST 新请求的独立正文。'); if (!adopted.success) throw new Error(adopted.error);
  const history: History = { ...request, authorizedAt: now, inputHash: hash(compiled.text), attachmentAssetIds: ['TEST-reference'], compiledPrompt: compiled,
    pageBindings: [{ assetId: 'TEST-reference', order: 1, slot: 'reference', label: '第 1 张图', previewHash: '1'.repeat(64), reference: 'plain', fileSha256: validation.sha256 }] };
  const supported = { state: 'supported' as const, reason: 'TEST' };
  project.production = { state: 'complete', planHash: 'a'.repeat(64), approvedAt: now,
    capability: { accountId: project.accountId, checkedAt: now, image: supported, durations: [], modes: { first_frame: supported, first_last_frame: supported, reference: supported } },
    fallbacks: {}, shots: Object.fromEntries(project.plan.shots.map((shot): [string, NonNullable<PetStoryProject['production']>['shots'][string]] => [shot.id, { requestedMode: shot.requestedMode, resolvedMode: 'reference', reason: 'TEST' }])),
    steps: [{ id: 'TEST-step', kind: 'firstFrame', shotId, taskId: adopted.data.id, runId: 'TEST-replacement-run', status: 'complete', inputHash: hash(adopted.data.prompt),
      attachmentAssetIds: ['TEST-reference'], compiledPrompt: { ...compiled, text: adopted.data.prompt }, resubmissionHistory: [history] }], message: 'TEST 新请求完成' };
  project = await projects.write(project);
  // 原运行在新任务建立后才收到产物；仍通过正式 Core 保存原任务的结果。
  core.updateStatus({ taskId: source.id, status: 'done', outputs: ['https://example.test/TEST-late-original.png'] }); sourceId = source.id;
  const original = tasks.find((task): boolean => task.id === sourceId)!; artifactId = original.artifacts![0].id;
  const job: DownloadJob = { id: 'TEST-original-download', taskId: source.id, accountId: project.accountId, mode: 'image', url: original.outputs[0], status: 'done', attempts: 1,
    saveDir: root, filePath: picture, createdAt: now, updatedAt: now };
  media = new PetStoryExistingMediaService(projects, { list: (): Task[] => structuredClone(tasks), downloads: (): DownloadJob[] => [job] });
});

describe('重发后迟到的原结果通过显式历史入口收取', (): void => {
  it('重开项目后精确找到旧任务产物，只在用户关联后保存为候选，不改当前步骤与正式指针', async (): Promise<void> => {
    projects = new PetStoryProjects(); project = await projects.open(directory);
    const before = structuredClone(project); const shotId = project.plan!.shots[0].id;
    expect(await media.candidates(project.id, shotId, 'firstFrame')).toEqual([{ taskId: sourceId, artifactId, createdAt: submittedAt }]);
    expect((await projects.read(project.id)).assets).toEqual(before.assets);
    const result = await media.link(project.id, project.revision, shotId, 'firstFrame', sourceId, artifactId);
    expect(result.success).toBe(true); const saved = result.project!; const imported = saved.assets.at(-1)!;
    expect(imported).toMatchObject({ taskId: sourceId, runId: 'TEST-original-run', artifactId, origin: 'historical_task', imageReview: { state: 'candidate' }, generationFinal: 'TEST 原采用正文。' });
    expect(saved.production).toEqual(before.production); expect(saved.adoptedImages).toEqual(before.adoptedImages); expect(saved.plan).toEqual(before.plan); expect(tasks).toHaveLength(2);
    expect((await media.link(project.id, saved.revision, shotId, 'firstFrame', sourceId, artifactId)).project!.assets).toHaveLength(saved.assets.length);
  });
  it('原记录归档到productionHistory后仍能核对，旧结果不借当前生产步骤归属', async (): Promise<void> => {
    project.productionHistory = [project.production!]; project.production = undefined; project = await projects.write(project);
    expect(await media.candidates(project.id, project.plan!.shots[0].id, 'firstFrame')).toHaveLength(1);
    expect(await media.candidates(project.id, project.plan!.shots[1].id, 'firstFrame')).toEqual([]);
  });
  it.each(['run', 'submittedAt', 'account', 'project', 'step', 'snapshot', 'artifact-run', 'authorization', 'attachment'] as const)('拒绝借用不符的 %s', async (change): Promise<void> => {
    const old = tasks.find((task): boolean => task.id === sourceId)!;
    if (change === 'run') old.runtime!.runId = 'TEST-other-run';
    if (change === 'submittedAt') old.runtime!.submittedAt = now;
    if (change === 'account') old.assignedAccountId = 'TEST-other-account';
    if (change === 'project') old.projectId = 'TEST-other-studio';
    if (change === 'step') { old.petstory!.stepId = 'TEST-other-step'; old.runtime!.input.petstory!.stepId = 'TEST-other-step'; }
    if (change === 'snapshot') old.runtime!.input.prompt += 'TEST 已变';
    if (change === 'artifact-run') old.artifacts![0].runId = 'TEST-other-run';
    if (change === 'authorization') old.resubmittedAs![0].authorizationId = 'TEST-other-authorization';
    if (change === 'attachment') { old.attachments = [otherPicture]; old.runtime!.input.attachments = [otherPicture]; }
    const before = await projects.read(project.id); const shotId = project.plan!.shots[0].id;
    expect(await media.candidates(project.id, shotId, 'firstFrame')).toEqual([]);
    await expect(media.link(project.id, project.revision, shotId, 'firstFrame', sourceId, artifactId)).rejects.toThrow();
    expect(await projects.read(project.id)).toEqual(before); expect(tasks).toHaveLength(2);
  });
  it('参考文件原地被替换时即使附件路径相同也不能借用旧绑定', async (): Promise<void> => {
    await fs.copyFile(otherPicture, assetFile);
    expect(await media.candidates(project.id, project.plan!.shots[0].id, 'firstFrame')).toEqual([]);
  });
  it('当前替代请求未完成时不允许历史关联操作混入在产步骤', async (): Promise<void> => {
    project.production!.state = 'paused'; project = await projects.write(project); const before = structuredClone(project);
    await expect(media.link(project.id, project.revision, project.plan!.shots[0].id, 'firstFrame', sourceId, artifactId)).rejects.toThrow('原制作尚未结束');
    expect(await projects.read(project.id)).toEqual(before);
  });
});

describe('重发历史形状校验保留原文件', (): void => {
  it.each(['not-array', 'null-record', 'missing-auth', 'bad-date', 'bad-hash', 'unknown-asset', 'compiled-text', 'page-bindings', 'self-reference', 'duplicate'] as const)('无效 %s 明确报错，不清洗或丢弃审计', async (change): Promise<void> => {
    const bad = structuredClone(project); const step = bad.production!.steps[0]; const history = step.resubmissionHistory![0];
    if (change === 'not-array') step.resubmissionHistory = {} as History[];
    if (change === 'null-record') step.resubmissionHistory = [null as unknown as History];
    if (change === 'missing-auth') delete (history as unknown as Record<string, unknown>).authorizationId;
    if (change === 'bad-date') history.authorizedAt = 'TEST-not-a-date';
    if (change === 'bad-hash') history.inputHash = 'TEST-invalid';
    if (change === 'unknown-asset') history.attachmentAssetIds = ['TEST-no-such-asset'];
    if (change === 'compiled-text') history.compiledPrompt!.text += 'TEST 改写';
    if (change === 'page-bindings') history.pageBindings = {} as NonNullable<History['pageBindings']>;
    if (change === 'self-reference') history.taskId = step.taskId!;
    if (change === 'duplicate') step.resubmissionHistory!.push(structuredClone(history));
    const before = await fs.readFile(path.join(directory, 'project.json'), 'utf8');
    expect((): PetStoryProject => validateProject(bad, true)).toThrow('重发历史记录');
    await expect(projects.write(bad)).rejects.toThrow('重发历史记录'); expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(before);
  });
  it('已归档的坏审计也阻断重开，损坏文件仍原样保留', async (): Promise<void> => {
    const bad = structuredClone(project); bad.productionHistory = [bad.production!]; bad.production = undefined;
    bad.productionHistory[0].steps[0].resubmissionHistory = 'TEST-corrupt' as unknown as History[];
    const text = JSON.stringify(bad); await fs.writeFile(path.join(directory, 'project.json'), text);
    await expect(new PetStoryProjects().open(directory)).rejects.toThrow('重发历史记录'); expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(text);
  });
});
