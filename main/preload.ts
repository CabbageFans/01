/**
 * main/preload.ts
 * 预加载脚本 - 在渲染进程加载前执行
 * 通过 contextBridge 安全地暴露 IPC 通信接口给渲染进程
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ElectronAPI, Account, AccountAvailability, AccountPlatform, Task, GenerationMode, TaskExecutionIntent } from '@doubao-studio/contracts';

// ==================== 暴露 API ====================

const electronAPI = {
  petstory: {
    prepareRuntime: (id: string, revision: number, kind: import('@doubao-studio/contracts').PetStoryChatJob['kind'], target?: import('@doubao-studio/contracts').PetStoryRuntimeTarget): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:prepareRuntime', { id, revision, kind, target }),
    adoptPlanCandidate: (id: string, revision: number, jobId: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:adoptPlanCandidate', { id, revision, jobId }),
    adoptAssetsCandidate: (id: string, revision: number, jobId: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:adoptAssetsCandidate', { id, revision, jobId }),
    adoptPromptCandidate: (id: string, revision: number, jobId: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:adoptPromptCandidate', { id, revision, jobId }),
    saveOriginalStory: (id: string, revision: number, text: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:saveOriginalStory', { id, revision, text }),
    linkExistingMedia: (id: string, revision: number, shotId: string, kind: import('@doubao-studio/contracts').PetStoryPromptKind, taskId: string, artifactId?: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:linkExistingMedia', { id, revision, shotId, kind, taskId, artifactId }),
    listExistingMediaCandidates: (id: string, shotId: string, kind: import('@doubao-studio/contracts').PetStoryPromptKind): Promise<{ success: boolean; candidates?: import('@doubao-studio/contracts').PetStoryMediaCandidate[]; error?: string }> => ipcRenderer.invoke('petstory:listExistingMediaCandidates', { id, shotId, kind }),
    saveShotPrompt: (id: string, revision: number, shotId: string, kind: import('@doubao-studio/contracts').PetStoryPromptKind, final: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:saveShotPrompt', { id, revision, shotId, kind, final }),
    generateShotMedia: (id: string, revision: number, shotId: string, kind: import('@doubao-studio/contracts').PetStoryPromptKind, capability: import('@doubao-studio/contracts').PetStoryCapability, fallbacks: Record<string, 'first_frame' | 'reference'>): Promise<import('@doubao-studio/contracts').PetStoryProductionResult> => ipcRenderer.invoke('petstory:generateShotMedia', { id, revision, shotId, kind, capability, fallbacks }),
    readMedia: (id: string, assetId: string): Promise<{ success: boolean; data?: string; mimeType?: string; error?: string }> => ipcRenderer.invoke('petstory:readMedia', { id, assetId }),
    exportPrompts: (id: string, revision: number): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:exportPrompts', { id, revision }),
    confirmStory: (id: string, revision: number): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:confirmStory', { id, revision }),
    saveMaterialPrompt: (id: string, revision: number, materialId: string, final: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:saveMaterialPrompt', { id, revision, materialId, final }),
    addMaterialImage: (id: string, revision: number, materialId: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:addMaterialImage', { id, revision, materialId }),
    selectMaterialImage: (id: string, revision: number, materialId: string, assetId: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:selectMaterialImage', { id, revision, materialId, assetId }),
    approveMaterials: (id: string, revision: number, selections: { materialId: string; assetId: string }[]): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:approveMaterials', { id, revision, selections }),
    generateMaterials: (id: string, revision: number, materialIds: string[], capability: import('@doubao-studio/contracts').PetStoryCapability): Promise<import('@doubao-studio/contracts').PetStoryProductionResult> => ipcRenderer.invoke('petstory:generateMaterials', { id, revision, materialIds, capability }),
    recordPageBindings: (id: string, taskId: string, runId: string, bindings: import('@doubao-studio/contracts').PetStoryPageBinding[]): Promise<import('@doubao-studio/contracts').PetStoryProductionResult> => ipcRenderer.invoke('petstory:recordPageBindings', { id, taskId, runId, bindings }),
    bindSharedReference: (id: string, revision: number, characterId: string, assetId: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:bindSharedReference', { id, revision, characterId, assetId }),
    previewPrompt: (id: string, shotId: string, kind: import('@doubao-studio/contracts').PetStoryPromptKind, resolvedMode?: import('@doubao-studio/contracts').PetStoryResolvedMode): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:previewPrompt', { id, shotId, kind, resolvedMode }),
    savePromptProfile: (id: string, revision: number, profile: import('@doubao-studio/contracts').PetStoryPromptProfile): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:savePromptProfile', { id, revision, profile }),

    selectProductionImage: (id: string, stepId: string, artifactId: string): Promise<import('@doubao-studio/contracts').PetStoryProductionResult> => ipcRenderer.invoke('petstory:selectProductionImage', { id, stepId, artifactId }),
    previewProduction: (id: string, capability: import('@doubao-studio/contracts').PetStoryCapability, fallbacks: Record<string, 'first_frame' | 'reference'>): Promise<import('@doubao-studio/contracts').PetStoryProductionResult> => ipcRenderer.invoke('petstory:previewProduction', { id, capability, fallbacks }),
    approveProduction: (id: string, revision: number, capability: import('@doubao-studio/contracts').PetStoryCapability, fallbacks: Record<string, 'first_frame' | 'reference'>): Promise<import('@doubao-studio/contracts').PetStoryProductionResult> => ipcRenderer.invoke('petstory:approveProduction', { id, revision, capability, fallbacks }),
    advanceProduction: (id: string): Promise<import('@doubao-studio/contracts').PetStoryProductionResult> => ipcRenderer.invoke('petstory:advanceProduction', { id }),
    pauseProduction: (id: string): Promise<import('@doubao-studio/contracts').PetStoryProductionResult> => ipcRenderer.invoke('petstory:pauseProduction', { id }),
    resumeProduction: (id: string, capability: import('@doubao-studio/contracts').PetStoryCapability): Promise<import('@doubao-studio/contracts').PetStoryProductionResult> => ipcRenderer.invoke('petstory:resumeProduction', { id, capability }),
    bindProductionRun: (id: string, taskId: string, runId: string): Promise<import('@doubao-studio/contracts').PetStoryProductionResult> => ipcRenderer.invoke('petstory:bindProductionRun', { id, taskId, runId }),
    guardProductionTask: (taskId: string): Promise<import('@doubao-studio/contracts').PetStoryProductionResult> => ipcRenderer.invoke('petstory:guardProductionTask', { taskId }),
    readReference: (id: string, assetId: string): Promise<{ success: boolean; data?: string; error?: string }> => ipcRenderer.invoke('petstory:readReference', { id, assetId }),
    create: (studioProjectId: string, accountId: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:create', { studioProjectId, accountId }),
    open: (path?: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:open', path === undefined ? {} : { path }),
    saveSource: (id: string, revision: number, text: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:saveSource', { id, revision, text }),
    saveMobileStory: (id: string, revision: number, text: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:saveMobileStory', { id, revision, text }),
    addSceneReference: (id: string, shotId: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:addSceneReference', { id, shotId }),
    addReference: (id: string, characterId: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:addReference', { id, characterId }),
    savePlan: (id: string, revision: number, plan: import('@doubao-studio/contracts').PetStoryPlan): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:savePlan', { id, revision, plan }),
    prepareChat: (id: string, prompt: string, kind: import('@doubao-studio/contracts').PetStoryChatJob['kind'], parentJobId?: string, shotId?: string, promptKind?: import('@doubao-studio/contracts').PetStoryPromptKind, materialId?: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:prepareChat', { id, prompt, kind, parentJobId, shotId, promptKind, materialId }),
    bindRun: (id: string, jobId: string, runId: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:bindRun', { id, jobId, runId }),
    retryUnsubmitted: (id: string, jobId: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:retryUnsubmitted', { id, jobId }),
    savePromptModel: (id: string, revision: number, model?: import('@doubao-studio/contracts').PetStoryProject['promptModel']): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:savePromptModel', { id, revision, model }),
    savePromptBatch: (id: string, revision: number, batch: import('@doubao-studio/contracts').PetStoryPromptBatch): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:savePromptBatch', { id, revision, batch }),
    endChatWaiting: (id: string, revision: number, jobId: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:endChatWaiting', { id, revision, jobId }),
    promptStageTargets: (id: string, revision: number): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:promptStageTargets', { id, revision }),
    collectChat: (id: string, jobId: string): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:collectChat', { id, jobId }),
    draftFinal: (id: string, shotId: string, kind: import('@doubao-studio/contracts').PetStoryPromptKind): Promise<import('@doubao-studio/contracts').PetStoryResult> => ipcRenderer.invoke('petstory:draftFinal', { id, shotId, kind }),
  },
  control: {
    onCommand: (handler: (command: {
      commandId: string;
      requestId: string;
      action: 'start' | 'pause' | 'cancel' | 'retry';
      projectId: string;
      batchId: string;
      taskId: string;
    }) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, command: Parameters<typeof handler>[0]) => handler(command);
      ipcRenderer.on('control:command', listener);
      return () => ipcRenderer.removeListener('control:command', listener);
    },
    ready: (): void => ipcRenderer.send('control:ready'),
    complete: (result: { commandId: string; ok: boolean; code: string; accepted?: boolean }): void => {
      ipcRenderer.send('control:result', result);
    },
  },
  projects: {
    list: (): Promise<any[]> => ipcRenderer.invoke('projects:list'),
    add: (name: string, description?: string, color?: string): Promise<any> => ipcRenderer.invoke('projects:add', { name, description, color }),
    update: (id: string, updates: Record<string, any>): Promise<any> => ipcRenderer.invoke('projects:update', { id, updates }),
    delete: (id: string): Promise<any> => ipcRenderer.invoke('projects:delete', { id }),
  },
  // ---- 账号管理 ----
  accounts: {
    list: (): Promise<Account[]> => ipcRenderer.invoke('accounts:list'),
    add: (name: string, platform?: AccountPlatform): Promise<{ success: boolean; account?: Account; error?: string }> =>
      ipcRenderer.invoke('accounts:add', { name, platform }),
    update: (id: string, name: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('accounts:update', { id, name }),
    delete: (id: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('accounts:delete', { id }),
    refresh: (id: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('accounts:refresh', { id }),
    setStatus: (id: string, status: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('accounts:setStatus', { id, status }),
    setPinned: (id: string, pinned: boolean): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('accounts:setPinned', { id, pinned }),
    updateSeedanceQuota: (id: string, action: 'consume' | 'exhausted', units?: number): Promise<{ success: boolean; account?: Account }> =>
      ipcRenderer.invoke('accounts:updateSeedanceQuota', { id, action, units }),
    updateHealth: (id: string, action: 'success' | 'failure' | 'verification' | 'login_expired' | 'clear', errorCode?: string): Promise<{ success: boolean; account?: Account }> =>
      ipcRenderer.invoke('accounts:updateHealth', { id, action, errorCode }),
    setAvailability: (id: string, availability: AccountAvailability): Promise<{ success: boolean; account?: Account }> =>
      ipcRenderer.invoke('accounts:setAvailability', { id, availability }),
    updateScheduling: (id: string, updates: Record<string, any>): Promise<any> => ipcRenderer.invoke('accounts:updateScheduling', { id, updates }),
    getPartition: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('accounts:getPartition', { id }),
  },

  // ---- 任务调度 ----
  tasks: {
    list: (): Promise<Task[]> => ipcRenderer.invoke('tasks:list'),
    add: (prompts: string[], mode?: GenerationMode, videoConfig?: any, attachments?: string[], audioAttachment?: string, projectId?: string, promptReadback?: Task['promptReadback']): Promise<{ success: boolean; tasks?: Task[]; error?: string }> =>
      ipcRenderer.invoke('tasks:add', { prompts, mode, videoConfig, attachments, audioAttachment, projectId, promptReadback }),
    assign: (taskId: string, accountId: string): Promise<{ success: boolean; task?: Task; error?: string }> =>
      ipcRenderer.invoke('tasks:assign', { taskId, accountId }),
    updateStatus: (
      taskId: string,
      status: string,
      result?: string,
      outputs?: string[]
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('tasks:updateStatus', { taskId, status, result, outputs }),
    updateRuntime: (taskId: string, patch: {
      executionIntent?: TaskExecutionIntent;
      status?: string;
      runtime?: Record<string, any>;
      errorInfo?: Record<string, any> | null;
      blockedByTaskIds?: string[];
      result?: string;
    }): Promise<{ success: boolean; task?: Task; error?: string }> =>
      ipcRenderer.invoke('tasks:updateRuntime', { taskId, ...patch }),
    setQualityVerdict: (taskId: string, status: 'accepted' | 'rejected', rejectionTags?: string[]): Promise<{ success: boolean; task?: Task; error?: string }> =>
      ipcRenderer.invoke('tasks:setQualityVerdict', { taskId, status, rejectionTags }),
    acquireLock: (taskId: string, ownerId: string): Promise<{ success: boolean; task?: Task; error?: string }> =>
      ipcRenderer.invoke('tasks:acquireLock', { taskId, ownerId }),
    renewLock: (taskId: string, ownerId: string): Promise<{ success: boolean; task?: Task; error?: string }> =>
      ipcRenderer.invoke('tasks:renewLock', { taskId, ownerId }),
    releaseLock: (taskId: string, ownerId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('tasks:releaseLock', { taskId, ownerId }),
    importCsv: (projectId?: string, filePath?: string): Promise<any> =>
      ipcRenderer.invoke('tasks:importCsv', { projectId, filePath }),
    getPathForDroppedFile: (file: unknown): string => webUtils.getPathForFile(file as File),
    update: (taskId: string, updates: {
      prompt: string;
      videoConfig?: any;
      attachments?: string[];
      audioAttachment?: string;
    }): Promise<{ success: boolean; task?: Task; error?: string }> =>
      ipcRenderer.invoke('tasks:update', { taskId, updates }),
    delete: (taskId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('tasks:delete', { taskId }),
    retry: (taskId: string): Promise<{ success: boolean; task?: Task; error?: string }> =>
      ipcRenderer.invoke('tasks:retry', { taskId }),
    batchPause: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tasks:batchPause'),
    getCompletedOutputs: (): Promise<Array<{ taskId: string; prompt: string; outputs: string[]; accountId: string | null; mode: GenerationMode }>> =>
      ipcRenderer.invoke('tasks:getCompletedOutputs'),
    selectImages: (): Promise<{ success: boolean; filePaths?: string[]; error?: string }> =>
      ipcRenderer.invoke('tasks:selectImages'),
    selectAudio: (): Promise<{ success: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke('tasks:selectAudio'),
    readFileAsBase64: (filePath: string): Promise<{ success: boolean; data?: string; error?: string }> =>
      ipcRenderer.invoke('tasks:readFileAsBase64', filePath),
    downloadOutputs: (
      outputs: Array<{ taskId: string; prompt: string; outputs: string[]; accountId: string | null; mode: GenerationMode }>,
      saveDir?: string
    ): Promise<{ success: boolean; count: number; failed: number; saveDir?: string; error?: string; jobIds?: string[] }> =>
      ipcRenderer.invoke('tasks:downloadOutputs', { outputs, saveDir }),
    downloadPublicShareMedia: (shareUrl: string, saveDir?: string): Promise<any> =>
      ipcRenderer.invoke('tasks:downloadPublicShareMedia', { shareUrl, saveDir }),
    listDownloads: (): Promise<any[]> => ipcRenderer.invoke('tasks:listDownloads'),
    exportDiagnostics: (): Promise<{ success: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke('tasks:exportDiagnostics'),
    validateArtifact: (taskId: string, artifactId: string): Promise<any> =>
      ipcRenderer.invoke('tasks:validateArtifact', { taskId, artifactId }),
    saveAdapterReport: (accountId: string, report: Record<string, any>): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('tasks:saveAdapterReport', { accountId, report }),
    selectAdapterRules: (): Promise<any> => ipcRenderer.invoke('tasks:selectAdapterRules'),
    selectSaveDir: (): Promise<{ success: boolean; dirPath?: string; error?: string }> =>
      ipcRenderer.invoke('tasks:selectSaveDir'),
  },

  // ---- 设置 ----
  settings: {
    get: (): Promise<Record<string, any>> => ipcRenderer.invoke('settings:get'),
    save: (settings: Record<string, any>): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('settings:save', settings),
  },
  logs: {
    list: (): Promise<any[]> => ipcRenderer.invoke('logs:list'),
    append: (entry: Record<string, any>): Promise<any> => ipcRenderer.invoke('logs:append', entry),
    clear: (): Promise<any> => ipcRenderer.invoke('logs:clear'),
  },

  // ---- 系统操作 ----
  system: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('system:getVersion'),
    checkIntegrity: (): Promise<any> => ipcRenderer.invoke('system:checkIntegrity'),
    exportBackup: (): Promise<any> => ipcRenderer.invoke('system:exportBackup'),
    restoreBackup: (): Promise<any> => ipcRenderer.invoke('system:restoreBackup'),
    exportProject: (projectId: string): Promise<any> => ipcRenderer.invoke('system:exportProject', projectId),
    checkUpdate: (): Promise<any> => ipcRenderer.invoke('system:checkUpdate'),
    minimize: (): void => ipcRenderer.send('window:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('window:toggleMaximize'),
    close: (): void => ipcRenderer.send('window:close'),
    prepareNativeInput: (): Promise<boolean> => ipcRenderer.invoke('window:prepareNativeInput'),
  },
} satisfies ElectronAPI;

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
