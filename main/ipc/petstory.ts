import { BrowserWindow, dialog, ipcMain, nativeImage } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { PetStoryChatJob, PetStoryPlan, PetStoryPromptKind, PetStoryResult } from '@doubao-studio/contracts';
import { PetStoryProjects } from '../utils/petstoryProject';
import { PetStoryChatService } from '../utils/petstoryChat';
import { createPetStoryTask, retryPetStoryTask, listTasksForLocalControl } from './tasks';
import { PetStoryProductionService } from '../utils/petstoryProduction';
import type { PetStoryCapability, PetStoryProductionResult } from '@doubao-studio/contracts';
import { downloadTaskOutputs, listTaskDownloads, bindPetStoryTask } from './tasks';
import { listAccountsForLocalControl } from './accounts';
import { loadProjects } from './projects';
import { replaceIpcHandlers } from './lifecycle';

const projects = new PetStoryProjects();
const chats = new PetStoryChatService(projects, { list: listTasksForLocalControl, create: createPetStoryTask, retryUnsubmitted: retryPetStoryTask });
const production = new PetStoryProductionService(projects, { list: listTasksForLocalControl, create: createPetStoryTask, adopt: bindPetStoryTask, retryUnsubmitted: retryPetStoryTask, downloads: listTaskDownloads, download: downloadTaskOutputs });
const CHANNELS = ['petstory:selectProductionImage', 'petstory:addSceneReference', 'petstory:previewProduction', 'petstory:approveProduction', 'petstory:advanceProduction', 'petstory:pauseProduction', 'petstory:resumeProduction', 'petstory:bindProductionRun', 'petstory:guardProductionTask', 'petstory:create', 'petstory:open', 'petstory:saveSource', 'petstory:saveMobileStory', 'petstory:addReference', 'petstory:savePlan', 'petstory:prepareChat', 'petstory:collectChat', 'petstory:bindRun', 'petstory:retryUnsubmitted', 'petstory:readReference', 'petstory:draftFinal'] as const;
type Handler = (event: IpcMainInvokeEvent, params: Record<string, unknown>) => Promise<PetStoryResult & { data?: string }>;

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
  const dispose = replaceIpcHandlers(ipcMain, CHANNELS);
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
    return { success: true, data: image.resize({ width: 192 }).toDataURL() };
  }));
  ipcMain.handle('petstory:create', hostGuard(async (event: IpcMainInvokeEvent, params: Record<string, unknown>): Promise<PetStoryResult> => {
    const studioProjectId = String(params.studioProjectId || '');
    const accountId = String(params.accountId || '');
    if (!loadProjects().some((p): boolean => p.id === studioProjectId && !p.archived)) throw new Error('Studio 项目不存在或已归档');
    if (!listAccountsForLocalControl().some((a): boolean => a.id === accountId && a.platform !== 'dola')) throw new Error('请选择已有豆包账号');
    const selected = await dialog.showOpenDialog(dialogOwner(event), { title: '选择存放 PetStory project.json 的目录', properties: ['openDirectory', 'createDirectory'] });
    if (selected.canceled) return { success: false, error: '已取消' };
    return { success: true, project: await projects.create(selected.filePaths[0], studioProjectId, accountId) };
  }));
  ipcMain.handle('petstory:open', hostGuard(async (event: IpcMainInvokeEvent): Promise<PetStoryResult> => {
    const selected = await dialog.showOpenDialog(dialogOwner(event), { title: '选择包含 project.json 的 PetStory 目录', properties: ['openDirectory'] });
    if (selected.canceled) return { success: false, error: '已取消' };
    const project = await projects.open(selected.filePaths[0]);
    production.suspend(project.id);
    return { success: true, project };
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
    String(p.id), String(p.prompt || ''), p.kind as PetStoryChatJob['kind'], p.parentJobId as string | undefined, p.shotId as string | undefined, p.promptKind as PetStoryPromptKind | undefined,
  ))));
  ipcMain.handle('petstory:bindRun', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), (): Promise<PetStoryResult> => chats.bindRun(String(p.id), String(p.jobId), String(p.runId)))));
  ipcMain.handle('petstory:retryUnsubmitted', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), (): Promise<PetStoryResult> => chats.retryUnsubmitted(String(p.id), String(p.jobId)))));
  ipcMain.handle('petstory:collectChat', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), (): Promise<PetStoryResult> => chats.collect(String(p.id), String(p.jobId)))));
  ipcMain.handle('petstory:draftFinal', hostGuard(async (_event: IpcMainInvokeEvent, p: Record<string, unknown>): Promise<PetStoryResult> => projects.serial(String(p.id), (): Promise<PetStoryResult> => chats.draft(String(p.id), String(p.shotId), p.kind as PetStoryPromptKind))));
  return dispose;
}
