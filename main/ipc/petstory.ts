import { compilePrompt } from '../utils/petstoryPromptQuality';
import path from 'node:path';
import fs from 'node:fs/promises';
import { BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
import { buildPetStoryPromptExport, writePetStoryPromptExport } from '../utils/petstoryExport';
import type { IpcMainInvokeEvent } from 'electron';
import type { PetStoryChatJob, PetStoryPlan, PetStoryPromptKind, PetStoryResult } from '@doubao-studio/contracts';
import { PetStoryProjects } from '../utils/petstoryProject';
import { PetStoryChatService } from '../utils/petstoryChat';
import { PetStoryExistingMediaService } from '../utils/petstoryExistingMedia';
import { createPetStoryTask, retryPetStoryTask, revisePetStoryHeldPrompt, listTasksForLocalControl } from './tasks';
import { PetStoryProductionService } from '../utils/petstoryProduction';
import type { PetStoryCapability, PetStoryPromptProfile, PetStoryResolvedMode, PetStoryProductionResult } from '@doubao-studio/contracts';
import { downloadTaskOutputs, listTaskDownloads, bindPetStoryTask, bindPetStoryPageInput } from './tasks';
import { listAccountsForLocalControl } from './accounts';
import { loadProjects } from './projects';
import { replaceIpcHandlers } from './lifecycle';

const projects = new PetStoryProjects();
const chats = new PetStoryChatService(projects, { list: listTasksForLocalControl, create: createPetStoryTask, reviseHeldPrompt: revisePetStoryHeldPrompt, retryUnsubmitted: retryPetStoryTask });
const production = new PetStoryProductionService(projects, { list: listTasksForLocalControl, create: createPetStoryTask, adopt: bindPetStoryTask, bindPageInput: bindPetStoryPageInput, retryUnsubmitted: retryPetStoryTask, downloads: listTaskDownloads, download: downloadTaskOutputs });
const existingMedia = new PetStoryExistingMediaService(projects, { list: listTasksForLocalControl, downloads: listTaskDownloads });
const CHANNELS = ['petstory:saveOriginalStory', 'petstory:linkExistingMedia', 'petstory:listExistingMediaCandidates', 'petstory:saveShotPrompt', 'petstory:generateShotMedia', 'petstory:readMedia', 'petstory:exportPrompts', 'petstory:confirmStory', 'petstory:saveMaterialPrompt', 'petstory:addMaterialImage', 'petstory:selectMaterialImage', 'petstory:approveMaterials', 'petstory:generateMaterials', 'petstory:recordPageBindings', 'petstory:bindSharedReference', 'petstory:previewPrompt', 'petstory:savePromptProfile', 'petstory:selectProductionImage', 'petstory:addSceneReference', 'petstory:previewProduction', 'petstory:approveProduction', 'petstory:advanceProduction', 'petstory:pauseProduction', 'petstory:resumeProduction', 'petstory:bindProductionRun', 'petstory:guardProductionTask', 'petstory:create', 'petstory:open', 'petstory:saveSource', 'petstory:saveMobileStory', 'petstory:addReference', 'petstory:savePlan', 'petstory:prepareChat', 'petstory:collectChat', 'petstory:bindRun', 'petstory:retryUnsubmitted', 'petstory:readReference', 'petstory:draftFinal'] as const;
type Handler = (event: IpcMainInvokeEvent, params: Record<string, unknown>) => Promise<PetStoryResult & { data?: string }>;
const RUNTIME_CHANNELS = ['petstory:prepareRuntime', 'petstory:adoptPlanCandidate', 'petstory:adoptAssetsCandidate', 'petstory:adoptPromptCandidate'] as const;

/** 仅宿主顶层 frame 可调用；不接受任意目录、文件路径或 shell 参数。 */
function hostGuard(work: Handler): Handler {
  return async (event: IpcMainInvokeEvent, params: Record<string, unknown> = {}): Promise<PetStoryResult> => {
    if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) return { success: false, error: '仅宿主窗口可访问项目' };
    try { return await work(event, params); }
    catch (error: unknown) { return { success: false, error: error instanceof Error ? error.message : '项目操作失败' }; }
  };
}
/** 将原生选择器绑定到发起操作的窗口，避免 macOS 出现无归属的后台模态窗口。 */
function dialogOwner(event: IpcMainInvokeEvent): BrowserWindow {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed()) throw new Error('项目窗口已关闭，请重新打开窗口后操作');
  return owner;
}
export function registerPetStoryIPC(): () => void {
  const dispose = replaceIpcHandlers(ipcMain, [...CHANNELS, ...RUNTIME_CHANNELS]);
  ipcMain.handle('petstory:prepareRuntime', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), (): Promise<PetStoryResult> => chats.prepareRuntime(String(p.id), Number(p.revision), p.kind as PetStoryChatJob['kind'], p.target as import('@doubao-studio/contracts').PetStoryRuntimeTarget | undefined))));
  ipcMain.handle('petstory:adoptPlanCandidate', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), (): Promise<PetStoryResult> => chats.adoptPlanCandidate(String(p.id), Number(p.revision), String(p.jobId)))));
  ipcMain.handle('petstory:adoptAssetsCandidate', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), (): Promise<PetStoryResult> => chats.adoptAssetsCandidate(String(p.id), Number(p.revision), String(p.jobId)))));
  ipcMain.handle('petstory:adoptPromptCandidate', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), (): Promise<PetStoryResult> => chats.adoptPromptCandidate(String(p.id), Number(p.revision), String(p.jobId)))));
  ipcMain.handle('petstory:saveOriginalStory', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), async (): Promise<PetStoryResult> => ({ success: true, project: await projects.saveOriginalStory(String(p.id), Number(p.revision), String(p.text || '')) }))));
  ipcMain.handle('petstory:linkExistingMedia', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), (): Promise<PetStoryResult> => existingMedia.link(String(p.id), Number(p.revision), String(p.shotId), p.kind as PetStoryPromptKind, String(p.taskId), p.artifactId as string | undefined))));
  ipcMain.handle('petstory:listExistingMediaCandidates', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult & { candidates: import('@doubao-studio/contracts').PetStoryMediaCandidate[] }> => ({ success: true, candidates: await existingMedia.candidates(String(p.id), String(p.shotId), p.kind as PetStoryPromptKind) })));
  ipcMain.handle('petstory:saveShotPrompt', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), async (): Promise<PetStoryResult> => ({ success: true, project: await projects.saveShotPrompt(String(p.id), Number(p.revision), String(p.shotId), p.kind as PetStoryPromptKind, String(p.final || '')) }))));
  ipcMain.handle('petstory:generateShotMedia', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryProductionResult> => projects.serial(String(p.id), (): Promise<PetStoryProductionResult> => production.generateShotMedia(String(p.id), Number(p.revision), String(p.shotId), p.kind as PetStoryPromptKind, p.capability as PetStoryCapability, p.fallbacks as Record<string, 'first_frame' | 'reference'>))));
  ipcMain.handle('petstory:readMedia', hostGuard(async (_event: IpcMainInvokeEvent, args: Record<string, unknown>): Promise<PetStoryResult & { data?: string; mimeType?: string }> => {
    const p = await projects.read(String(args.id));
    const asset = p.assets.find((a): boolean => a.id === String(args.assetId) && a.kind === 'video');
    if (!asset) throw new Error('视频不属于当前项目');
    const file = await production.assetFile(p, asset.id, 'video');
    const info = await fs.stat(file);
    if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new Error('视频预览限制为 50 MiB，请从对应原任务查看或下载');
    return { success: true, mimeType: 'video/mp4', data: `data:video/mp4;base64,${(await fs.readFile(file)).toString('base64')}` };
  }));
  ipcMain.handle('petstory:exportPrompts', hostGuard(async (event: IpcMainInvokeEvent, args: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(args.id), async (): Promise<PetStoryResult> => {
    const p = await projects.read(String(args.id));
    if (p.revision !== args.revision) throw new Error('项目已变化，请保存或刷新后导出');
    const selected = await dialog.showOpenDialog(dialogOwner(event), { title: '导出提示词、引用计划与已有实际绑定', defaultPath: projects.directory(p.id), buttonLabel: '导出到此文件夹', properties: ['openDirectory'] });
    if (selected.canceled) return { success: false, error: '已取消导出' };
    const latest = await projects.read(p.id);
    if (latest.revision !== p.revision) throw new Error('选择目录期间项目已变化，请重新导出');
    const data = buildPetStoryPromptExport(latest, listTasksForLocalControl());
    const output = await writePetStoryPromptExport(selected.filePaths[0], data);
    shell.showItemInFolder(path.join(output, 'review.html'));
    return { success: true, exportName: path.basename(output) };
  })));
  ipcMain.handle('petstory:confirmStory', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), async (): Promise<PetStoryResult> => ({ success: true, project: await projects.confirmStory(String(p.id), Number(p.revision)) }))));
  ipcMain.handle('petstory:saveMaterialPrompt', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), async (): Promise<PetStoryResult> => ({ success: true, project: await projects.saveMaterialPrompt(String(p.id), Number(p.revision), String(p.materialId), String(p.final || '')) }))));
  ipcMain.handle('petstory:selectMaterialImage', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), async (): Promise<PetStoryResult> => ({ success: true, project: await projects.selectMaterialImage(String(p.id), Number(p.revision), String(p.materialId), String(p.assetId)) }))));
  ipcMain.handle('petstory:approveMaterials', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), async (): Promise<PetStoryResult> => ({ success: true, project: await projects.approveMaterials(String(p.id), Number(p.revision), p.selections as { materialId: string; assetId: string }[]) }))));
  ipcMain.handle('petstory:generateMaterials', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryProductionResult> => projects.serial(String(p.id), (): Promise<PetStoryProductionResult> => production.generateMaterials(String(p.id), Number(p.revision), p.materialIds as string[], p.capability as PetStoryCapability))));
  ipcMain.handle('petstory:recordPageBindings', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryProductionResult> => projects.serial(String(p.id), (): Promise<PetStoryProductionResult> => production.recordPageBindings(String(p.id), String(p.taskId), String(p.runId), p.bindings as import('@doubao-studio/contracts').PetStoryPageBinding[]))));
  ipcMain.handle('petstory:addMaterialImage', hostGuard(async (event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), async (): Promise<PetStoryResult> => {
    const selected = await dialog.showOpenDialog(dialogOwner(event), { title: '选择基础素材图片（替换后需重新接受）', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (selected.canceled) return { success: false, error: '已取消' };
    return { success: true, project: await projects.addMaterialImage(String(p.id), Number(p.revision), String(p.materialId), selected.filePaths[0]) };
  })));
  ipcMain.handle('petstory:bindSharedReference', hostGuard(async (_event: IpcMainInvokeEvent, args: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(args.id), async (): Promise<PetStoryResult> => ({
    success: true, project: await projects.bindSharedReference(String(args.id), Number(args.revision), String(args.characterId), String(args.assetId)),
  }))));
  ipcMain.handle('petstory:previewPrompt', hostGuard(async (_event: IpcMainInvokeEvent, args: Record<string, unknown>): Promise<PetStoryResult> => {
    const p = await projects.read(String(args.id));
    const shotId = String(args.shotId); const kind = args.kind as PetStoryPromptKind;
    const mode = p.production?.shots[shotId]?.resolvedMode || args.resolvedMode as PetStoryResolvedMode | undefined;
    return { success: true, compiledPrompt: compilePrompt(p, shotId, kind, mode, true) };
  }));
  ipcMain.handle('petstory:savePromptProfile', hostGuard(async (_event: IpcMainInvokeEvent, args: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(args.id), async (): Promise<PetStoryResult> => ({
    success: true, project: await projects.savePromptProfile(String(args.id), Number(args.revision), args.profile as PetStoryPromptProfile),
  }))));
  ipcMain.handle('petstory:selectProductionImage', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryProductionResult> => projects.serial(String(p.id), (): Promise<PetStoryProductionResult> => production.selectImage(String(p.id), String(p.stepId), String(p.artifactId)))));
  ipcMain.handle('petstory:guardProductionTask', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryProductionResult> => production.guard(String(p.taskId))));
  ipcMain.handle('petstory:previewProduction', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryProductionResult> => production.preview(String(p.id), p.capability as PetStoryCapability, p.fallbacks as Record<string, 'first_frame' | 'reference'>)));
  ipcMain.handle('petstory:approveProduction', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryProductionResult> => projects.serial(String(p.id), (): Promise<PetStoryProductionResult> => production.approve(String(p.id), Number(p.revision), p.capability as PetStoryCapability, p.fallbacks as Record<string, 'first_frame' | 'reference'>))));
  ipcMain.handle('petstory:advanceProduction', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryProductionResult> => projects.serial(String(p.id), (): Promise<PetStoryProductionResult> => production.advance(String(p.id)))));
  ipcMain.handle('petstory:pauseProduction', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryProductionResult> => projects.serial(String(p.id), (): Promise<PetStoryProductionResult> => production.pause(String(p.id)))));
  ipcMain.handle('petstory:resumeProduction', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryProductionResult> => projects.serial(String(p.id), (): Promise<PetStoryProductionResult> => production.resume(String(p.id), p.capability as PetStoryCapability))));
  ipcMain.handle('petstory:bindProductionRun', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryProductionResult> => projects.serial(String(p.id), (): Promise<PetStoryProductionResult> => production.bindRun(String(p.id), String(p.taskId), String(p.runId)))));
  ipcMain.handle('petstory:readReference', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult & { data?: string }> => {
    const image = nativeImage.createFromPath(await projects.referenceFile(String(p.id), String(p.assetId)));
    if (image.isEmpty()) throw new Error('项目参考图缺失或无法解码');
    return { success: true, data: image.resize({ width: Math.min(image.getSize().width, 1600) }).toDataURL() };
  }));
  ipcMain.handle('petstory:create', hostGuard(async (event: IpcMainInvokeEvent, params: Record<string, unknown>): Promise<PetStoryResult> => {
    const studioProjectId = String(params.studioProjectId || '');
    const accountId = String(params.accountId || '');
    if (!loadProjects().some((p): boolean => p.id === studioProjectId && !p.archived)) throw new Error('Studio 项目不存在或已归档');
    if (!listAccountsForLocalControl().some((a): boolean => a.id === accountId && a.platform !== 'dola')) throw new Error('请选择已有豆包账号');
    const selected = await dialog.showOpenDialog(dialogOwner(event), { title: '选择存放 PetStory project.json 的目录', properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled) return { success: false, error: '已取消' };
    return { success: true, displayName: path.basename(selected.filePaths[0]), project: await projects.create(selected.filePaths[0], studioProjectId, accountId) };
  }));
  ipcMain.handle('petstory:open', hostGuard(async (event: IpcMainInvokeEvent): Promise<PetStoryResult> => {
    const selected = await dialog.showOpenDialog(dialogOwner(event), { title: '选择包含 project.json 的 PetStory 目录', properties: ['openDirectory'] });
    if (selected.canceled) return { success: false, error: '已取消' };
    const project = await projects.open(selected.filePaths[0]);
    production.suspend(project.id);
    return { success: true, displayName: path.basename(selected.filePaths[0]), project };
  }));
  ipcMain.handle('petstory:saveSource', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), async (): Promise<PetStoryResult> => ({
    success: true, project: await projects.saveSource(String(p.id), Number(p.revision), String(p.text || '')),
  }))));
  ipcMain.handle('petstory:saveMobileStory', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), async (): Promise<PetStoryResult> => ({
    success: true, project: await projects.saveMobileStory(String(p.id), Number(p.revision), String(p.text || '')),
  }))));
  ipcMain.handle('petstory:savePlan', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), async (): Promise<PetStoryResult> => ({
    success: true, project: await projects.savePlan(String(p.id), Number(p.revision), p.plan as PetStoryPlan),
  }))));
  ipcMain.handle('petstory:addSceneReference', hostGuard(async (event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), async (): Promise<PetStoryResult> => {
    const selected = await dialog.showOpenDialog(dialogOwner(event), { title: '选择本镜头场景参考图', properties: ['openFile'], filters: [{ name: '场景参考图', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (selected.canceled) return { success: false, error: '已取消' };
    if (nativeImage.createFromPath(selected.filePaths[0]).isEmpty()) throw new Error('场景参考图无法解码');
    return { success: true, project: await projects.addSceneReference(String(p.id), String(p.shotId), selected.filePaths[0]) };
  })));
  ipcMain.handle('petstory:addReference', hostGuard(async (event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), async (): Promise<PetStoryResult> => {
    const selected = await dialog.showOpenDialog(dialogOwner(event), { title: '选择角色参考图', properties: ['openFile'], filters: [{ name: '角色参考图', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (selected.canceled) return { success: false, error: '已取消' };
    if (nativeImage.createFromPath(selected.filePaths[0]).isEmpty()) throw new Error('参考图无法解码');
    return { success: true, project: await projects.addReference(String(p.id), String(p.characterId), selected.filePaths[0]) };
  })));
  ipcMain.handle('petstory:prepareChat', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), (): Promise<PetStoryResult> => chats.prepare(
    String(p.id), String(p.prompt || ''), p.kind as PetStoryChatJob['kind'], p.parentJobId as string | undefined, p.shotId as string | undefined, p.promptKind as PetStoryPromptKind | undefined, p.materialId as string | undefined,
  ))));
  ipcMain.handle('petstory:bindRun', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), (): Promise<PetStoryResult> => chats.bindRun(String(p.id), String(p.jobId), String(p.runId)))));
  ipcMain.handle('petstory:retryUnsubmitted', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), (): Promise<PetStoryResult> => chats.retryUnsubmitted(String(p.id), String(p.jobId)))));
  ipcMain.handle('petstory:collectChat', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), (): Promise<PetStoryResult> => chats.collect(String(p.id), String(p.jobId)))));
  ipcMain.handle('petstory:draftFinal', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), (): Promise<PetStoryResult> => chats.draft(String(p.id), String(p.shotId), p.kind as PetStoryPromptKind))));
  return dispose;
}
