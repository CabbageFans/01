/** 正式产品 IPC 导出边界；仅原生选择器与桌面依赖为离线替身，不发送平台任务。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { PetStoryProduction, PetStoryProject, PetStoryResult } from '@doubao-studio/contracts';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { syncMaterials } from '../../main/utils/petstoryMaterials';
import { mediaCommand } from '../../main/utils/petstoryMedia';
import { localMediaStreams } from '../../main/utils/LocalMediaProtocol';

const desktop = vi.hoisted(() => {
  type Handler = (event: unknown, args: object) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const owner = { isDestroyed: (): boolean => false };
  return { handlers, owner, picker: vi.fn(), reveal: vi.fn(), createTask: vi.fn(), list: vi.fn(() => []) };
});
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: (): typeof desktop.owner => desktop.owner },
  dialog: { showOpenDialog: desktop.picker }, shell: { showItemInFolder: desktop.reveal }, nativeImage: {},
  ipcMain: { handle: (channel: string, handler: (event: unknown, args: object) => Promise<unknown>): void => { desktop.handlers.set(channel, handler); }, removeHandler: (channel: string): void => { desktop.handlers.delete(channel); } },
}));
vi.mock('../../main/ipc/tasks', () => ({ createPetStoryTask: desktop.createTask, retryPetStoryTask: vi.fn(), resubmitPetStoryTask: vi.fn(), revisePetStoryHeldPrompt: vi.fn(), revisePetStoryVideoInput: vi.fn(), setPetStoryDiagnosticsProvider: vi.fn(), listTasksForLocalControl: desktop.list, downloadTaskOutputs: vi.fn(), cancelTaskDownloads: vi.fn(), updatePetStoryLocalMedia: vi.fn(), listTaskDownloads: vi.fn(), bindPetStoryTask: vi.fn(), bindPetStoryPageInput: vi.fn(), setPetStoryConversationGuard: vi.fn() }));
vi.mock('../../main/ipc/accounts', () => ({ listAccountsForLocalControl: vi.fn(() => []) }));
vi.mock('../../main/ipc/projects', () => ({ loadProjects: vi.fn(() => []) }));
import { registerPetStoryIPC } from '../../main/ipc/petstory';

let root: string; let source: string; let destination: string; let p: PetStoryProject; let projects: PetStoryProjects;
const frame = {};
const event = { sender: { mainFrame: frame }, senderFrame: frame } as IpcMainInvokeEvent;
async function invoke(channel: string, args: object = {}, from: IpcMainInvokeEvent = event): Promise<PetStoryResult> {
  const handler = desktop.handlers.get(`petstory:${channel}`);
  if (!handler) throw new Error('TEST missing product handler');
  return await handler(from, args) as PetStoryResult;
}
beforeEach(async (): Promise<void> => {
  vi.clearAllMocks(); desktop.handlers.clear(); registerPetStoryIPC();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-product-export-'));
  source = path.join(root, 'project'); destination = path.join(root, 'exports');
  await fs.mkdir(source); await fs.mkdir(destination);
  projects = new PetStoryProjects(); p = await projects.create(source, 'TEST-studio', 'TEST-account');
  const final = { original: '用户原文', optimized: '旧候选', final: '用户手改 final\n保留第二行。', edited: true, rulesVersion: 'TEST-old' };
  p.plan = { sourceSummary: 'TEST 空展厅', adaptedStory: 'TEST 展厅门缓慢开启。', characters: [], props: [], scenes: [{ id: 'hall', name: '展厅', location: 'TEST 展厅', time: '白天', lighting: '天窗光', layout: '入口对展墙', view: '平视', designOrigin: 'script' }],
    shots: [{ id: 'door', order: 1, characterIds: [], propIds: [], sceneId: 'hall', scene: 'TEST 展厅', action: '门开启', startState: '门关闭', endState: '门开启', durationSeconds: 5, transition: 'cut', requestedMode: 'first_frame', prompts: { firstFrame: structuredClone(final), video: structuredClone(final) } }] };
  p.materials = syncMaterials(p); p = await projects.write(p);
  desktop.picker.mockResolvedValueOnce({ canceled: false, filePaths: [source] });
  const opened = await invoke('open'); expect(opened.success).toBe(true);
});
afterEach(async (): Promise<void> => { await fs.rm(root, { recursive: true, force: true }); });

it('exports through the registered product handler and native directory selection, without mutating project/final or creating tasks', async (): Promise<void> => {
  const before = await fs.readFile(path.join(source, 'project.json'), 'utf8');
  desktop.picker.mockResolvedValueOnce({ canceled: false, filePaths: [destination] });
  const result = await invoke('exportPrompts', { id: p.id, revision: p.revision });
  expect(result.success).toBe(true);
  expect(desktop.picker.mock.calls[1][1]).toMatchObject({ defaultPath: await fs.realpath(source), properties: ['openDirectory'] });
  const output = path.join(destination, result.exportName || 'TEST missing output');
  const data = JSON.parse(await fs.readFile(path.join(output, 'prompts.json'), 'utf8')) as { prompts: { category: string; final: string; review: object; modelPrompt: string }[]; actualRuns: unknown[] };
  expect(data.prompts.map((entry): string => entry.category)).toEqual(['scene', 'firstFrame', 'video']);
  expect(data.prompts[1].final).toBe('用户手改 final\n保留第二行。');
  expect(data.prompts[1].modelPrompt).not.toContain('设计来源');
  expect(data.actualRuns).toEqual([]);
  expect(await fs.readdir(output)).toEqual(['model-prompts.txt', 'prompts.json', 'review.html']);
  expect(desktop.reveal).toHaveBeenCalledWith(path.join(output, 'review.html'));
  expect(await fs.readFile(path.join(source, 'project.json'), 'utf8')).toBe(before);
  expect(desktop.createTask).not.toHaveBeenCalled();
});
it('exports adopted provenance and readable unadopted candidate sections, keeping each current model input on saved final', async (): Promise<void> => {
  const shot = p.plan!.shots[0];
  shot.prompts.firstFrame = { ...shot.prompts.firstFrame, optimized: 'TEST未采用镜头候选\n完整第二段', candidateJobId: 'TEST-new-shot-candidate', sourceJobId: undefined };
  shot.prompts.video = { ...shot.prompts.video, final: 'TEST已采用视频正文', optimized: 'TEST已采用视频正文', edited: false, sourceJobId: 'TEST-adopted-video', candidateJobId: 'TEST-adopted-video' };
  p.materials![0].prompt = { ...p.materials![0].prompt, final: 'TEST用户保留基础素材正文', optimized: 'TEST未采用素材候选', edited: true, candidateJobId: 'TEST-new-material-candidate' };
  p = await projects.write(p); const before = await fs.readFile(path.join(source, 'project.json'), 'utf8');
  desktop.picker.mockResolvedValueOnce({ canceled: false, filePaths: [destination] }); const result = await invoke('exportPrompts', { id: p.id, revision: p.revision });
  expect(result.success).toBe(true); const output = path.join(destination, result.exportName!);
  const data = JSON.parse(await fs.readFile(path.join(output, 'prompts.json'), 'utf8')) as { prompts: { id: string; final: string; modelPrompt: string; review: { metadata: object } }[] };
  const frame = data.prompts.find((entry): boolean => entry.id === 'door:firstFrame')!;
  expect(frame.review.metadata).toMatchObject({ edited: true, sourceJobId: null, candidateJobId: 'TEST-new-shot-candidate', unadoptedCandidate: 'TEST未采用镜头候选\n完整第二段' });
  expect(frame.final).toBe(shot.prompts.firstFrame.final); expect(frame.modelPrompt).toContain(shot.prompts.firstFrame.final); expect(frame.modelPrompt).not.toContain('TEST未采用镜头候选');
  const material = data.prompts.find((entry): boolean => entry.id === 'scene:hall')!;
  expect(material.review.metadata).toMatchObject({ edited: true, sourceJobId: null, candidateJobId: 'TEST-new-material-candidate', unadoptedCandidate: 'TEST未采用素材候选' });
  expect(data.prompts.find((entry): boolean => entry.id === 'door:video')!.review.metadata).toMatchObject({ edited: false, sourceJobId: 'TEST-adopted-video', candidateJobId: 'TEST-adopted-video', unadoptedCandidate: null });
  const modelInputs = await fs.readFile(path.join(output, 'model-prompts.txt'), 'utf8');
  expect(modelInputs).toContain('TEST已采用视频正文'); expect(modelInputs).toContain('豆包新候选 · 未采用');
  expect(modelInputs).toContain('TEST未采用镜头候选\n完整第二段'); expect(modelInputs).toContain('TEST未采用素材候选');
  expect(modelInputs).toContain('用户手改保留'); expect(modelInputs).toContain('待修订 · 不可直接提交');
  expect(await fs.readFile(path.join(source, 'project.json'), 'utf8')).toBe(before); expect(desktop.createTask).not.toHaveBeenCalled();
});
it('rejects stale revisions before opening a directory picker', async (): Promise<void> => {
  const result = await invoke('exportPrompts', { id: p.id, revision: p.revision - 1 });
  expect(result).toMatchObject({ success: false, error: expect.stringContaining('项目已变化') });
  expect(desktop.picker).toHaveBeenCalledTimes(1);
  expect(await fs.readdir(destination)).toEqual([]);
});
it('rejects a project change during directory selection without exporting the old snapshot', async (): Promise<void> => {
  desktop.picker.mockImplementationOnce(async (): Promise<object> => {
    p = await projects.write(p);
    return { canceled: false, filePaths: [destination] };
  });
  expect(await invoke('exportPrompts', { id: p.id, revision: p.revision })).toMatchObject({ success: false, error: expect.stringContaining('选择目录期间项目已变化') });
  expect(await fs.readdir(destination)).toEqual([]);
  expect(desktop.reveal).not.toHaveBeenCalled();
});
it('keeps cancel and non-host frame calls free of writes or media tasks', async (): Promise<void> => {
  desktop.picker.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  expect(await invoke('exportPrompts', { id: p.id, revision: p.revision })).toMatchObject({ success: false, error: '已取消导出' });
  const foreign = { sender: event.sender, senderFrame: {} } as IpcMainInvokeEvent;
  expect(await invoke('exportPrompts', { id: p.id, revision: p.revision }, foreign)).toMatchObject({ success: false, error: '仅宿主窗口可访问项目' });
  expect(desktop.picker).toHaveBeenCalledTimes(2);
  expect(await fs.readdir(destination)).toEqual([]);
  expect(desktop.createTask).not.toHaveBeenCalled();
});

it('uploads one user-selected MP4 through the host picker without accepting caller file paths or creating platform tasks', async (): Promise<void> => {
  const file = path.join(root, 'TEST-user-video.mp4');
  await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=32x48:r=5:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file]);
  desktop.picker.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
  const result = await invoke('addShotVideo', { id: p.id, revision: p.revision, shotId: 'door', path: '/TEST-caller-path-is-ignored.mp4' });
  expect(result.success).toBe(true); const asset = result.project!.assets.at(-1)!;
  expect(asset).toMatchObject({ kind: 'video', shotId: 'door', origin: 'user_upload', validation: { decoded: true } });
  expect(result.project!.selectedVideos?.door).toBe(asset.id); expect(asset.taskId).toBeUndefined();
  expect(desktop.picker.mock.calls[1]).toEqual([desktop.owner, { title: '上传镜头视频（MP4，5～10 秒）', properties: ['openFile'], filters: [{ name: 'MP4 视频', extensions: ['mp4'] }] }]);
  expect(desktop.createTask).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain(file);
  const media = await invoke('readMedia', { id: p.id, assetId: asset.id }) as PetStoryResult & { data?: string; mimeType?: string };
  expect(media).toMatchObject({ success: true, mimeType: 'video/mp4' }); expect(media.data).toMatch(/^doubao-media:\/\/asset\/[a-f0-9]{64}$/);
  const response = await localMediaStreams.respond(new Request(media.data!, { headers: { range: 'bytes=0-63' } }));
  expect(response.status).toBe(206); expect(response.headers.get('content-type')).toBe('video/mp4');
  expect(Buffer.from(await response.arrayBuffer())).toEqual((await fs.readFile(file)).subarray(0, 64));
});

async function uploadFile(): Promise<string> {
  const file = path.join(root, 'TEST-concurrent-user-video.mp4');
  await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=32x48:r=5:d=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file]);
  return file;
}
function uploadProduction(): PetStoryProduction {
  const supported = { state: 'supported' as const, reason: 'TEST' };
  return { phase: 'shots', state: 'complete', planHash: '0'.repeat(64), approvedAt: new Date().toISOString(), steps: [], message: 'TEST已完成原制作', fallbacks: {},
    capability: { accountId: p.accountId, image: supported, modes: { first_frame: supported, first_last_frame: supported, reference: supported }, durations: [5] },
    shots: { door: { requestedMode: 'first_frame', resolvedMode: 'first_frame', reason: 'TEST' } } };
}

it('rebases only unrelated background material writes during the native picker without losing progress or creating tasks', async (): Promise<void> => {
  const file = await uploadFile(); const revision = p.revision; const shot = structuredClone(p.plan!.shots[0]);
  desktop.picker.mockImplementationOnce(async (): Promise<object> => {
    p.materials![0].prompt.optimized = 'TEST后台基础素材候选已回读'; p = await projects.write(p);
    return { canceled: false, filePaths: [file] };
  });
  const result = await invoke('addShotVideo', { id: p.id, revision, shotId: 'door' });
  expect(result.success).toBe(true); expect(result.project!.plan!.shots[0]).toEqual(shot);
  expect(result.project!.materials![0].prompt.optimized).toBe('TEST后台基础素材候选已回读');
  expect(result.project!.selectedVideos?.door).toBe(result.project!.assets.at(-1)!.id);
  expect(desktop.createTask).not.toHaveBeenCalled();
});

it('rejects an already stale upload revision before opening a native picker', async (): Promise<void> => {
  const before = await fs.readFile(path.join(source, 'project.json'), 'utf8');
  expect(await invoke('addShotVideo', { id: p.id, revision: p.revision - 1, shotId: 'door' })).toMatchObject({ success: false, error: expect.stringContaining('项目版本已变化') });
  expect(desktop.picker).toHaveBeenCalledTimes(1); expect(desktop.createTask).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(source, 'project.json'), 'utf8')).toBe(before);
});

it.each(['shot', 'deleted-shot', 'account', 'studio', 'video-lock'] as const)('rejects %s changes while selecting without overriding the new project state', async (change: 'shot' | 'deleted-shot' | 'account' | 'studio' | 'video-lock'): Promise<void> => {
  const file = await uploadFile(); const revision = p.revision;
  desktop.picker.mockImplementationOnce(async (): Promise<object> => {
    if (change === 'shot') p.plan!.shots[0].action = 'TEST用户已修改目标动作';
    if (change === 'deleted-shot') { p.plan = undefined; p.materials = undefined; }
    if (change === 'account') p.accountId = 'TEST-other-account';
    if (change === 'studio') p.studioProjectId = 'TEST-other-studio';
    if (change === 'video-lock') { p.production = uploadProduction(); p.production.state = 'paused'; p.production.target = { shotId: 'door', kind: 'video' }; }
    p = await projects.write(p); return { canceled: false, filePaths: [file] };
  });
  const result = await invoke('addShotVideo', { id: p.id, revision, shotId: 'door' });
  expect(result.success).toBe(false); expect(result.error).toContain(change === 'deleted-shot' ? '镜头不存在' : change === 'video-lock' ? '请先结束' : '已变化');
  expect((await projects.read(p.id)).revision).toBe(p.revision); expect((await projects.read(p.id)).assets).toEqual(p.assets);
  expect(desktop.createTask).not.toHaveBeenCalled();
});

it.each(['explicit', 'production', 'history', 'latest-asset'] as const)('rejects changed selected video from %s fallback during the picker', async (selection: 'explicit' | 'production' | 'history' | 'latest-asset'): Promise<void> => {
  const file = await uploadFile(); p = await projects.addShotVideo(p.id, p.revision, 'door', file); const first = p.assets.at(-1)!;
  p = await projects.addShotVideo(p.id, p.revision, 'door', file); const second = p.assets.at(-1)!;
  p.selectedVideos = selection === 'explicit' ? { door: first.id } : undefined;
  if (selection === 'production') { p.production = uploadProduction(); p.production.shots.door.videoId = first.id; }
  if (selection === 'history') { const history = uploadProduction(); history.shots.door.videoId = first.id; p.productionHistory = [history]; }
  p = await projects.write(p); const revision = p.revision;
  desktop.picker.mockImplementationOnce(async (): Promise<object> => {
    if (selection === 'explicit') p.selectedVideos = { door: second.id };
    if (selection === 'production') p.production!.shots.door.videoId = second.id;
    if (selection === 'history') p.productionHistory![0].shots.door.videoId = second.id;
    if (selection === 'latest-asset') p.assets = [second, first];
    p = await projects.write(p); return { canceled: false, filePaths: [file] };
  });
  const result = await invoke('addShotVideo', { id: p.id, revision, shotId: 'door' });
  expect(result).toMatchObject({ success: false, error: expect.stringContaining('当前视频已变化') });
  expect((await projects.read(p.id)).assets).toEqual(p.assets); expect((await projects.read(p.id)).selectedVideos).toEqual(p.selectedVideos);
  expect(desktop.createTask).not.toHaveBeenCalled();
});

it('cancel after unrelated progress keeps that progress and never creates an upload or platform task', async (): Promise<void> => {
  const revision = p.revision;
  desktop.picker.mockImplementationOnce(async (): Promise<object> => {
    p.materials![0].prompt.optimized = 'TEST后台进度保留'; p = await projects.write(p);
    return { canceled: true, filePaths: [] };
  });
  expect(await invoke('addShotVideo', { id: p.id, revision, shotId: 'door' })).toMatchObject({ success: false, error: '已取消' });
  const saved = await projects.read(p.id); expect(saved.revision).toBe(p.revision); expect(saved.materials![0].prompt.optimized).toBe('TEST后台进度保留');
  expect(saved.assets).toEqual([]); expect(saved.selectedVideos).toBeUndefined(); expect(desktop.createTask).not.toHaveBeenCalled();
});

it('cancelled upload and non-host calls preserve the project without starting any platform work', async (): Promise<void> => {
  const before = await fs.readFile(path.join(source, 'project.json'), 'utf8');
  desktop.picker.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  expect(await invoke('addShotVideo', { id: p.id, revision: p.revision, shotId: 'door' })).toMatchObject({ success: false, error: '已取消' });
  expect(await invoke('addShotVideo', { id: p.id, revision: p.revision, shotId: 'door' }, { sender: event.sender, senderFrame: {} } as IpcMainInvokeEvent)).toMatchObject({ success: false, error: '仅宿主窗口可访问项目' });
  expect(desktop.picker).toHaveBeenCalledTimes(2); expect(desktop.createTask).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(source, 'project.json'), 'utf8')).toBe(before);
});

it('opens the selected project.json through the same project reader without writes or task dispatch', async (): Promise<void> => {
  const before = await fs.readFile(path.join(source, 'project.json'), 'utf8');
  desktop.picker.mockResolvedValueOnce({ canceled: false, filePaths: [path.join(source, 'project.json')] });
  const result = await invoke('open');
  expect(result).toMatchObject({ success: true, displayName: 'project', project: { id: p.id } });
  expect(await fs.readFile(path.join(source, 'project.json'), 'utf8')).toBe(before);
  expect(desktop.createTask).not.toHaveBeenCalled();
});

it.each(['directory', 'file'] as const)('opens an explicitly entered absolute project %s through the normal host handler without native dialog or task dispatch', async (kind: 'directory' | 'file'): Promise<void> => {
  const before = await fs.readFile(path.join(source, 'project.json'), 'utf8');
  const entered = kind === 'directory' ? source : path.join(source, 'project.json');
  const result = await invoke('open', { path: entered });
  expect(result).toMatchObject({ success: true, project: { id: p.id, revision: p.revision }, displayName: path.basename(source) });
  expect(desktop.picker).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(path.join(source, 'project.json'), 'utf8')).toBe(before);
  expect(desktop.createTask).not.toHaveBeenCalled();
});

it('rejects relative, malformed, other JSON and non-host path opens without a picker or writes', async (): Promise<void> => {
  const before = await fs.readFile(path.join(source, 'project.json'), 'utf8');
  await fs.writeFile(path.join(source, 'other.json'), before);
  for (const supplied of ['', 'project.json', null, 123, path.join(source, 'project.json') + '\0']) {
    expect(await invoke('open', { path: supplied })).toMatchObject({ success: false, error: expect.stringContaining('绝对路径') });
  }
  expect(await invoke('open', { path: path.join(source, 'other.json') })).toMatchObject({ success: false, error: expect.stringContaining('不读取其他 JSON') });
  expect(await invoke('open', { path: source }, { sender: event.sender, senderFrame: {} } as IpcMainInvokeEvent)).toMatchObject({ success: false, error: '仅宿主窗口可访问项目' });
  expect(desktop.picker).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(path.join(source, 'project.json'), 'utf8')).toBe(before); expect(desktop.createTask).not.toHaveBeenCalled();
});
it('rejects a selected JSON file other than the canonical project manifest', async (): Promise<void> => {
  const file = path.join(source, 'tasks.json'); await fs.writeFile(file, '{}');
  desktop.picker.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
  expect(await invoke('open')).toMatchObject({ success: false, error: expect.stringContaining('不读取其他 JSON') });
  expect(desktop.createTask).not.toHaveBeenCalled();
});
it('reveals only opened project files and registered assets without returning paths, writing the project or dispatching tasks', async (): Promise<void> => {
  const assetId = 'TEST-result-asset'; const relativePath = 'shots/door/TEST-result.png';
  await fs.mkdir(path.join(source, 'shots', 'door'), { recursive: true });
  await fs.writeFile(path.join(source, relativePath), 'TEST registered local result');
  p.assets.push({ id: assetId, kind: 'scene', relativePath }); p = await projects.write(p);
  const before = await fs.readFile(path.join(source, 'project.json'), 'utf8');
  expect(await invoke('revealAsset', { id: p.id, assetId })).toEqual({ success: true });
  expect(desktop.reveal).toHaveBeenLastCalledWith(path.join(await fs.realpath(source), relativePath));
  expect(await invoke('revealProject', { id: p.id })).toEqual({ success: true });
  expect(desktop.reveal).toHaveBeenLastCalledWith(path.join(await fs.realpath(source), 'project.json'));
  expect(await invoke('revealAsset', { id: p.id, assetId: '../not-owned' })).toMatchObject({ success: false, error: expect.stringContaining('不属于当前项目') });
  expect(await invoke('revealAsset', { id: p.id, assetId }, { sender: event.sender, senderFrame: {} } as IpcMainInvokeEvent)).toMatchObject({ success: false, error: '仅宿主窗口可访问项目' });
  await fs.unlink(path.join(source, relativePath)); await fs.symlink(path.join(source, 'project.json'), path.join(source, relativePath));
  expect(await invoke('revealAsset', { id: p.id, assetId })).toMatchObject({ success: false, error: expect.stringContaining('禁止符号链接') });
  expect(await fs.readFile(path.join(source, 'project.json'), 'utf8')).toBe(before); expect(desktop.createTask).not.toHaveBeenCalled();
});
it('read-only generation inspection is host guarded and rejects stale project versions without task dispatch', async (): Promise<void> => {
  const args = { id: p.id, revision: p.revision, target: { shotId: 'door', promptKind: 'video' } };
  const before = await fs.readFile(path.join(source, 'project.json'), 'utf8');
  const response = await invoke('inspectGeneration', args) as import('@doubao-studio/contracts').PetStoryGenerationEligibilityResult;
  expect(response).toMatchObject({ success: true, eligibility: { ready: false, blockers: expect.arrayContaining([expect.objectContaining({ code: 'firstFrame', shotId: 'door' })]) } });
  expect(response.eligibility?.blockers.some((blocker): boolean => blocker.code === 'capability')).toBe(false);
  expect(await invoke('inspectGeneration', { ...args, revision: p.revision - 1 })).toMatchObject({ success: false, error: expect.stringContaining('项目已变化') });
  expect(await invoke('inspectGeneration', args, { sender: event.sender, senderFrame: {} } as IpcMainInvokeEvent)).toMatchObject({ success: false, error: '仅宿主窗口可访问项目' });
  expect(await fs.readFile(path.join(source, 'project.json'), 'utf8')).toBe(before); expect(desktop.createTask).not.toHaveBeenCalled();
});
