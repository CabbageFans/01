import type { Task } from '../domain';

/** PetStory 桌面内部契约；路径和任务绑定只由主进程生成。 */
export type PetStoryMode = 'auto' | 'first_frame' | 'first_last_frame' | 'reference';
export type PetStoryPromptKind = 'firstFrame' | 'lastFrame' | 'video';
export interface PetStoryPrompt {
  original: string;
  optimized: string;
  final: string;
  edited: boolean;
  rulesVersion: string;
}
export interface PetStoryCharacter {
  id: string;
  name: string;
  role: 'main' | 'supporting';
  purpose: string;
  description: string;
  referenceAssetId?: string;
}
export interface PetStoryShot {
  id: string;
  order: number;
  characterIds: string[];
  sceneReferenceAssetIds?: string[];
  scene: string;
  action: string;
  startState: string;
  endState: string;
  durationSeconds: number;
  transition: 'cut' | 'continue';
  previousShotId?: string;
  requestedMode: PetStoryMode;
  prompts: { firstFrame: PetStoryPrompt; lastFrame?: PetStoryPrompt; video: PetStoryPrompt };
}
export interface PetStoryPlan {
  sourceSummary: string;
  adaptedStory: string;
  characters: PetStoryCharacter[];
  shots: PetStoryShot[];
}
export interface PetStoryAsset {
  id: string;
  kind: 'character' | 'firstFrame' | 'plannedEndImage' | 'video' | 'actualEndFrame' | 'scene';
  relativePath: string;
  atSeconds?: number;
  characterId?: string;
  shotId?: string;
  taskId?: string;
  runId?: string;
  artifactId?: string;
  downloadJobId?: string;
  validation?: PetStoryMediaValidation;
  sourceVideo?: { assetId: string; taskId: string; runId: string; sha256: string; atSeconds: number };
}
export interface PetStoryMediaValidation {
  decoded: true;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  durationSeconds?: number;
  checkedAt: string;
}
export type PetStoryResolvedMode = Exclude<PetStoryMode, 'auto'>;
export type PetStoryFreeState = 'free' | 'paid' | 'exhausted' | 'unknown';
export interface PetStoryEntryCapability {
  state: 'supported' | 'unsupported' | 'unknown' | 'implementation_gap';
  free: PetStoryFreeState;
  reason: string;
}
/** 只存可见控件事实和本人核对结果，无 Cookie、内部 URL 或页面正文。 */
export interface PetStoryCapability {
  accountId: string;
  checkedAt: string;
  image: PetStoryEntryCapability;
  modes: Record<PetStoryResolvedMode, PetStoryEntryCapability>;
  videoConfig?: Task['videoConfig'];
  durations: number[];
  freeEvidence: 'visible' | 'user_confirmed' | 'unknown';
}
export interface PetStoryModeResolution {
  requestedMode: PetStoryMode;
  resolvedMode: PetStoryResolvedMode;
  reason: string;
}
export interface PetStoryTaskBinding {
  projectId: string;
  stepId: string;
}
export interface PetStoryProductionStep {
  id: string;
  kind: 'character' | 'firstFrame' | 'lastFrame' | 'video';
  characterId?: string;
  shotId?: string;
  taskId?: string;
  runId?: string;
  inputHash: string;
  attachmentAssetIds: string[];
  status: 'preparing' | 'bound' | 'complete';
  assetId?: string;
  rejectedArtifactIds?: string[];
  error?: string;
}
export interface PetStoryShotMedia extends PetStoryModeResolution {
  firstFrameId?: string;
  plannedEndImageId?: string;
  videoId?: string;
  actualEndFrameId?: string;
  startFromPreviousEnd?: PetStoryAsset['sourceVideo'];
}
export interface PetStoryProduction {
  state: 'running' | 'paused' | 'complete';
  planHash: string;
  approvedAt: string;
  capability: PetStoryCapability;
  fallbacks: Record<string, 'first_frame' | 'reference'>;
  shots: Record<string, PetStoryShotMedia>;
  steps: PetStoryProductionStep[];
  message: string;
}
export interface PetStoryProductionCounts {
  shots: number;
  supporting: number;
  newCharacters: number;
  firstFrames: number;
  lastFrames: number;
  videos: number;
}
export interface PetStoryExecutionGuard {
  capability: PetStoryCapability;
  mode?: PetStoryResolvedMode;
  durationSeconds?: number;
  attachmentAssetIds: string[];
}
export interface PetStoryProductionResult extends PetStoryResult {
  action?: 'start' | 'observe' | 'wait';
  guard?: PetStoryExecutionGuard;
  counts?: PetStoryProductionCounts;
  resolutions?: Record<string, PetStoryModeResolution>;
}

export interface PetStoryChatJob {
  id: string;
  kind: 'analysis' | 'repair' | 'optimize';
  taskId: string;
  runId?: string;
  parentJobId?: string;
  shotId?: string;
  promptKind?: PetStoryPromptKind;
  inputFinal?: string;
  inputHash: string;
  sourceUrl: string;
  /** 缺失表示旧版网页链接直读任务，仅允许保留及只读核对。 */
  sourceStoryId?: string;
  status: 'bound' | 'captured' | 'invalid' | 'applied';
  rawText?: string;
  error?: string;
}
export interface PetStoryProject {
  schemaVersion: 1;
  id: string;
  studioProjectId: string;
  accountId: string;
  revision: number;
  source: { kind: 'douyin'; url: string; status: 'pending' | 'blocked' | 'review_required'; reason?: string };
  /** 用户从手机豆包复制回来的原文；不冒充桌面端读取了视频。 */
  mobileStory?: { id: string; text: string; importedAt: string };
  contentBasis?: { beginning: string; middle: string; ending: string };
  assets: PetStoryAsset[];
  plan?: PetStoryPlan;
  jobs: PetStoryChatJob[];
  drafts?: { taskId: string; shotId: string; kind: PetStoryPromptKind; final: string }[];
  production?: PetStoryProduction;
  updatedAt: string;
}
export interface PetStoryResult {
  success: boolean;
  project?: PetStoryProject;
  error?: string;
  taskId?: string;
  attachments?: string[];
  needsRepair?: boolean;
}
export interface PetStoryAPI {
  selectProductionImage: (projectId: string, stepId: string, artifactId: string) => Promise<PetStoryProductionResult>;
  previewProduction: (projectId: string, capability: PetStoryCapability, fallbacks: Record<string, 'first_frame' | 'reference'>) => Promise<PetStoryProductionResult>;
  approveProduction: (projectId: string, revision: number, capability: PetStoryCapability, fallbacks: Record<string, 'first_frame' | 'reference'>) => Promise<PetStoryProductionResult>;
  advanceProduction: (projectId: string) => Promise<PetStoryProductionResult>;
  pauseProduction: (projectId: string) => Promise<PetStoryProductionResult>;
  resumeProduction: (projectId: string, capability: PetStoryCapability) => Promise<PetStoryProductionResult>;
  bindProductionRun: (projectId: string, taskId: string, runId: string) => Promise<PetStoryProductionResult>;
  guardProductionTask: (taskId: string) => Promise<PetStoryProductionResult>;

  readReference: (projectId: string, assetId: string) => Promise<{ success: boolean; data?: string; error?: string }>;
  create: (studioProjectId: string, accountId: string) => Promise<PetStoryResult>;
  open: () => Promise<PetStoryResult>;
  saveSource: (projectId: string, revision: number, text: string) => Promise<PetStoryResult>;
  saveMobileStory: (projectId: string, revision: number, text: string) => Promise<PetStoryResult>;
  addSceneReference: (projectId: string, shotId: string) => Promise<PetStoryResult>;
  addReference: (projectId: string, characterId: string) => Promise<PetStoryResult>;
  savePlan: (projectId: string, revision: number, plan: PetStoryPlan) => Promise<PetStoryResult>;
  prepareChat: (projectId: string, prompt: string, kind: PetStoryChatJob['kind'], parentJobId?: string, shotId?: string, promptKind?: PetStoryPromptKind) => Promise<PetStoryResult>;
  draftFinal: (projectId: string, shotId: string, kind: PetStoryPromptKind) => Promise<PetStoryResult>;
  bindRun: (projectId: string, jobId: string, runId: string) => Promise<PetStoryResult>;
  retryUnsubmitted: (projectId: string, jobId: string) => Promise<PetStoryResult>;
  collectChat: (projectId: string, jobId: string) => Promise<PetStoryResult>;
}
