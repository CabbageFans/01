/** 正式产品 IPC 导出边界；仅原生选择器与桌面依赖为离线替身，不发送平台任务。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { PetStoryProject, PetStoryResult } from '@doubao-studio/contracts';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { syncMaterials } from '../../main/utils/petstoryMaterials';

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
vi.mock('../../main/ipc/tasks', () => ({ createPetStoryTask: desktop.createTask, retryPetStoryTask: vi.fn(), resubmitPetStoryTask: vi.fn(), revisePetStoryHeldPrompt: vi.fn(), listTasksForLocalControl: desktop.list, downloadTaskOutputs: vi.fn(), listTaskDownloads: vi.fn(), bindPetStoryTask: vi.fn(), bindPetStoryPageInput: vi.fn(), setPetStoryConversationGuard: vi.fn() }));
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
