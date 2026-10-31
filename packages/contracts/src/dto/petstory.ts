import type { PetStoryChatAdjustment, PetStoryConversationReply, PetStoryAdjustmentResult, PetStoryAdjustmentPreviewResult } from './petstoryAdjustment';
import type { Task } from '../domain';
import type { TaskResubmitUncertainParams } from './tasks';

/** PetStory 桌面内部契约；路径和任务绑定只由主进程生成。 */
export type PetStoryMode = 'auto' | 'first_frame' | 'first_last_frame' | 'reference';
export type PetStoryPromptKind = 'firstFrame' | 'lastFrame' | 'video';
export interface PetStoryPromptProfile {
  style: string;
  /** 旧 style 保留供迁移，不跨资产套用。共同字段只描述媒介／画面语言。 */
  assetStyles?: Partial<Record<'common' | 'character' | 'prop' | 'scene', string>>;
  /** 可选别名与主配角是用户保存的演员事实；缺失时不从旧稿补造对应。 */
  characters: Record<string, { identity: string; appearance: string; aliases?: string[]; role?: 'main' | 'supporting' }>;
}
export interface PetStoryPromptReference {
  assetId: string;
  materialId?: string;
  entityId?: string;
  characterIds: string[];
  purpose: 'identity' | 'prop' | 'scene' | 'firstFrame' | 'plannedEndImage' | 'actualEndFrame';
  order: number;
  slot?: 'first' | 'last';
}
/** 单次 Chat 正文使用的目标生成引用表；与 Chat 看图附件编号分别保存。 */
export interface PetStoryPromptTaskContract {
  /** 当次确认设计与已采用边界；不包含上传顺序或计划文件解析结果。 */
  designHash?: string;
  references: PetStoryPromptReference[];
  dialect: 'seedance20' | 'seedance25' | 'seedream' | 'generic';
  mode?: PetStoryResolvedMode;
}
export interface PetStoryCompiledPrompt {
  text: string;
  final: string;
  rulesVersion: string;
  kind: PetStoryPromptKind | PetStoryMaterial['kind'];
  requestedMode: PetStoryMode;
  resolvedMode?: PetStoryResolvedMode;
  references: PetStoryPromptReference[];
  /** 只在这些结构化片段中解析引用，禁止全局替换 final 的普通数字。 */
  segments?: ({ text: string } | { referenceOrder: number; sourceText?: string })[];
}
export interface PetStoryPrompt {
  /** 分析附带的兼容草稿，不能代替专用Chat的final。 */
  draft?: string;
  /** 手改前真实采用来源，只证明来源基础，不跳过当前资格核对。 */
  basisJobId?: string;
  original: string;
  optimized: string;
  final: string;
  edited: boolean;
  rulesVersion: string;
  /** 当前候选与采用正文分别对应真实 Chat job；编辑正文时清除采用关系。 */
  candidateJobId?: string;
  sourceJobId?: string;
  needsReview?: boolean;
  /** 已采用的有界编辑计划，实际媒体仍须用户另行操作。 */
  editIntent?: PetStoryMaterialEditIntent;
  /** 采用该正文时一并保存，后续只允许对其中引用做确定性素材映射。 */
  promptTask?: PetStoryPromptTaskContract;
}
export interface PetStoryMaterialEditIntent {
  baseAssetId: string;
  changes: string;
  preserve: string;
  validity: string;
}
export interface PetStoryCharacter {
  id: string;
  name: string;
  role: 'main' | 'supporting';
  purpose: string;
  description: string;
  referenceAssetId?: string;
  designOrigin?: 'script' | 'proposed';
  continuity?: string;
  aliases?: string[];
}
export interface PetStoryProp {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  keyStates: string;
  scale: string;
  /** 当前基础图的静态可视状态；keyStates 的剧情动作／持有者不送入基础图。 */
  appearanceState?: string;
  designOrigin: 'script' | 'proposed';
}
export interface PetStoryScene {
  id: string;
  name: string;
  location: string;
  time: string;
  lighting: string;
  layout: string;
  parentSceneId?: string;
  view: string;
  designOrigin: 'script' | 'proposed';
}
export interface PetStoryMaterial {
  /** 逻辑 ID，区别于 assets 中每一版具体文件的 ID。 */
  id: string;
  kind: 'character' | 'prop' | 'scene';
  entityId: string;
  name: string;
  designHash: string;
  prompt: PetStoryPrompt;
  selectedAssetId?: string;
  approved?: { assetId: string; sha256: string; at: string; identity?: { description: string; assetId: string } };
}
export interface PetStoryPageBinding {
  assetId: string;
  order: number;
  slot: 'reference' | 'first_frame' | 'last_frame';
  /** 只保存不透明摘要，禁止存页面 URL、文件路径或图片内容。 */
  previewHash: string;
  label: string;
  reference: 'plain' | 'mention' | 'slot';
  nodeId?: string;
  fileSha256?: string;
  targetId?: string;
  occurrenceCount?: number;
  nodeIds?: string[];
}
export interface PetStoryShot {
  id: string;
  order: number;
  characterIds: string[];
  propIds?: string[];
  propStates?: { propId: string; holderId?: string; state: string }[];
  sceneId?: string;
  sceneView?: string;
  expression?: string;
  gaze?: string;
  interaction?: string;
  dialogue?: { speakerId: string; text: string; tone: string; pace: string; delivery?: 'onscreen' | 'offscreen' | 'voiceover' }[];
  camera?: string;
  sourceRefs?: string[];
  narrativePurpose?: string;
  framing?: string;
  blocking?: string;
  performance?: string;
  sound?: string;
  timing?: string;
  continuity?: string;
  sceneReferenceAssetIds?: string[];
  scene: string;
  /** 当前镜头明确造型，高于项目默认，不作为永久身份。 */
  appearanceOverrides?: Record<string, string>;
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
  props?: PetStoryProp[];
  scenes?: PetStoryScene[];
  shots: PetStoryShot[];
  understanding?: string;
  sceneDesign?: string;
}
export type PetStoryImageTarget = { materialId: string; shotId?: never; kind?: never }
  | { shotId: string; kind: 'firstFrame' | 'lastFrame'; materialId?: never };
/** 一次明确图片操作；文字准备、真实生成和候选下载沿同一授权恢复。 */
export interface PetStoryImageOperation {
  id: string;
  requestId: string;
  target: PetStoryImageTarget;
  mode: 'generate' | 'modify';
  stage: 'preparing' | 'generating' | 'saving' | 'complete' | 'failed';
  createdAt: string;
  basisHash: string;
  baseAssetId?: string;
  baseSha256?: string;
  feedback?: string;
  chatJobId?: string;
  taskId?: string;
  outputAssetId?: string;
  productionApprovedAt?: string;
  error?: string;
}
export interface PetStoryImageOperationRequest {
  requestId: string;
  target: PetStoryImageTarget;
  baseAssetId?: string;
  feedback?: string;
}
export interface PetStoryImageReview {
  state: 'candidate' | 'adopted';
  target: PetStoryImageTarget;
  /** 候选产生时的对象事实；改动目标后不得静默采用过期候选。 */
  basisHash: string;
  adoptedAt?: string;
  sha256?: string;
  /** 本次明确采用时已结束待选的同目标图片；仅保留历史备选，不代表采用这些图片。 */
  resolvedCandidateIds?: string[];
  sourceReply?: { adjustmentId: string; replyKey: string; urlHash: string };
}
export interface PetStoryAsset {
  id: string;
  kind: 'character' | 'prop' | 'firstFrame' | 'plannedEndImage' | 'video' | 'actualEndFrame' | 'scene';
  materialId?: string;
  generationPrompt?: string;
  /** 关联已有任务时保留历史正文，不能冒充当前 final 的新生成。 */
  generationFinal?: string;
  origin?: 'historical_task';
  promptJobId?: string;
  relativePath: string;
  atSeconds?: number;
  characterId?: string;
  /** 同框身份图可绑定多个角色，实际仅上传一次。 */
  characterIds?: string[];
  shotId?: string;
  taskId?: string;
  runId?: string;
  artifactId?: string;
  downloadJobId?: string;
  validation?: PetStoryMediaValidation;
  imageReview?: PetStoryImageReview;
  /** 输入素材已替换，旧文件保留，须人工复核或重新制作。 */
  needsReview?: boolean;
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
export interface PetStoryEntryCapability {
  state: 'supported' | 'unsupported' | 'unknown' | 'implementation_gap';
  reason: string;
}
/** 生成参数与执行时读取的公开控件事实，无 Cookie、内部 URL 或页面正文。 */
export interface PetStoryCapability {
  accountId: string;
  /** 仅实际读取页面时记录；生成任务不要求预先读取。 */
  checkedAt?: string;
  image: PetStoryEntryCapability;
  modes: Record<PetStoryResolvedMode, PetStoryEntryCapability>;
  videoConfig?: Task['videoConfig'];
  durations: number[];
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
  kind: 'character' | 'prop' | 'scene' | 'firstFrame' | 'lastFrame' | 'video';
  materialId?: string;
  characterId?: string;
  shotId?: string;
  taskId?: string;
  runId?: string;
  inputHash: string;
  attachmentAssetIds: string[];
  status: 'preparing' | 'bound' | 'complete';
  assetId?: string;
  rejectedArtifactIds?: string[];
  compiledPrompt?: PetStoryCompiledPrompt;
  pageBindings?: PetStoryPageBinding[];
  pageBindingHistory?: { runId?: string; compiledPrompt: PetStoryCompiledPrompt; bindings: PetStoryPageBinding[] }[];
  /** 明确重发时保留原任务与页面绑定，迟到结果仍归属原任务。 */
  resubmissionHistory?: { taskId: string; runId: string; submittedAt: string; authorizationId: string; authorizedAt: string; inputHash: string; attachmentAssetIds: string[]; compiledPrompt?: PetStoryCompiledPrompt; pageBindings?: PetStoryPageBinding[] }[];
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
  /** 图片操作的单次授权关联；不改变正式选图。 */
  imageOperationId?: string;
  phase?: 'materials' | 'shots';
  /** 画布单节点授权；完成这一项后停止，不补生成其他媒体。 */
  target?: { shotId: string; kind: PetStoryPromptKind };
  materialIds?: string[];
  materialHash?: string;
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
  references?: PetStoryPromptReference[];
  compiledPrompt?: PetStoryCompiledPrompt;
  fileSha256s?: string[];
}
export interface PetStoryProductionResult extends PetStoryResult {
  action?: 'start' | 'observe' | 'wait';
  guard?: PetStoryExecutionGuard;
  counts?: PetStoryProductionCounts;
  resolutions?: Record<string, PetStoryModeResolution>;
}
export interface PetStoryImageOperationResult extends PetStoryProductionResult {
  operationId?: string;
  chatJobId?: string;
}

export interface PetStoryReviewIssue {
  id: string;
  targetId: string;
  promptKind?: PetStoryPromptKind;
  evidence: string;
  impact: string;
  requestedChange: string;
  severity: 'error' | 'warning' | 'suggestion';
}
export interface PetStoryAssetBindings {
  characters: PetStoryCharacter[];
  props: PetStoryProp[];
  scenes: PetStoryScene[];
  shotBindings: { shotId: string; characterIds: string[]; propIds: string[]; propStates: NonNullable<PetStoryShot['propStates']>; sceneId: string; sceneView?: string; dialogue?: PetStoryShot['dialogue']; sourceRefs?: string[]; narrativePurpose?: string; framing?: string; blocking?: string; performance?: string; sound?: string; timing?: string; continuity?: string }[];
  understanding?: string;
  sceneDesign?: string;
}
export interface PetStoryRuntimeTarget {
  /** 自动修订只消耗原轮次一次；显式新轮次由用户操作授权。 */
  repairMode?: 'automatic' | 'explicit';
  shotId?: string;
  promptKind?: PetStoryPromptKind;
  materialId?: string;
  parentJobId?: string;
  /** 显式选择本次要修订的问题；缺省只处理该目标的 error。 */
  selectedIssueIds?: string[];
  /** 用户提出的待核对疑点，不是已认定事实或创作指令。 */
  reviewFocus?: string;
  editIntent?: PetStoryMaterialEditIntent;
  /** 创作文字的模型选择；媒体执行时读取真实控件。 */
  capability?: PetStoryCapability;
}
export interface PetStoryValidationIssue {
  code: string;
  path: string;
  targetId?: string;
  actual?: unknown;
  actualType: string;
  expected: string;
  repairable: boolean;
  message: string;
}
export interface PetStoryChatJob {
  /** 修订所依据的选定自由回复；原回复全文只保存在父快照，不冒充本任务回复。 */
  repairReplySource?: { adjustmentId: string; replyKey: string };
  /** repair 的创作职责，沿父链继承，不能把视频／尾帧修订当作分析。 */
  originKind?: 'analysis' | 'optimize' | 'materialPrompt' | 'assets' | 'review' | 'revise';
  repairMode?: 'automatic' | 'explicit';
  validationDetails?: PetStoryValidationIssue[];
  /** 明确选择的自由对话回复，任务ID仅指向提供规则上下文的原请求。 */
  conversationReply?: { adjustmentId: string; conversationUrl: string; reply: PetStoryConversationReply };
  /** 用户结束收候选等待；不表示平台取消或收取成功。 */
  endedWaitingAt?: string;
  id: string;
  kind: 'analysis' | 'repair' | 'optimize' | 'materialPrompt' | 'assets' | 'review' | 'revise';
  materialId?: string;
  taskId: string;
  runId?: string;
  parentJobId?: string;
  selectedIssueIds?: string[];
  reviewFocus?: string;
  shotId?: string;
  promptKind?: PetStoryPromptKind;
  editIntent?: PetStoryMaterialEditIntent;
  capability?: PetStoryCapability;
  inputFinal?: string;
  /** 审查实际送审的各目标 final；缺失的旧全局审查不能据当前正文补造快照。 */
  reviewInputFinals?: Record<string, string>;
  /** 本次分析实际配置的来源称谓与主配角快照；不从后来的配置补造旧合同。 */
  analysisCastBindings?: Record<string, Pick<PetStoryPromptProfile['characters'][string], 'aliases' | 'role'>>;
  inputHash: string;
  sourceUrl: string;
  /** 缺失表示旧版网页链接直读任务，仅允许保留及只读核对。 */
  sourceStoryId?: string;
  inputEdited?: boolean;
  contextHash?: string;
  /** 尾帧／视频依赖的已采用帧正文快照，不让期间改动的画布正文被旧回复覆盖。 */
  frameContextHash?: string;
  /** 本次请求实际携带的前镜已采用边界；旧 job 无此字段时不重新解释其历史快照。 */
  previousBoundaryHash?: string;
  status: 'bound' | 'captured' | 'invalid' | 'applied';
  rawText?: string;
  error?: string;
  requestId?: string;
  stage?: string;
  rulesVersion?: string;
  ruleFiles?: string[];
  expectedIds?: string[];
  createdAt?: string;
  inputRevision?: number;
  /** 与 task.prompt 同一份完整请求，用于一次修订的原任务回馈。 */
  requestText?: string;
  promptTask?: PetStoryPromptTaskContract;
  /** 具体可证明的格式、引用或原台词缺项；不代表创作质量评分。 */
  validationIssues?: string[];
  /** 接收分析回复时按明确切镜关系清理的冗余字段；原回复 rawText 保持原样。 */
  formatCorrections?: string[];
  /** 当前事实版本，与候选正文分开；旧请求只能保留为过期候选。 */
  resultStatus?: 'candidate' | 'adopted' | 'stale';
  staleReason?: string;
  parsedResult?: { plan?: PetStoryPlan; optimized?: string; issues?: PetStoryReviewIssue[]; assets?: PetStoryAssetBindings; contentBasis?: PetStoryProject['contentBasis']; requiresConfirmation?: boolean; changeReason?: string };
}
export interface PetStoryProject {
  imageOperations?: PetStoryImageOperation[];
  /** 同一项目内的对象级自由对话记录，不改变任务执行事实。 */
  chatAdjustment?: PetStoryChatAdjustment;
  chatAdjustmentHistory?: PetStoryChatAdjustment[];
  /** 文字创作目标，不证明网页槽位能力。 */
  promptModel?: NonNullable<Task['videoConfig']>['model'] | 'generic';
  promptBatch?: PetStoryPromptBatch;
  schemaVersion: 1;
  id: string;
  studioProjectId: string;
  accountId: string;
  revision: number;
  source: { kind: 'douyin' | 'script'; url: string; status: 'pending' | 'blocked' | 'review_required'; reason?: string };
  /** 用户从手机豆包复制回来的原文；不冒充桌面端读取了视频。 */
  mobileStory?: { id: string; text: string; importedAt: string };
  contentBasis?: { beginning: string; middle: string; ending: string };
  assets: PetStoryAsset[];
  /** 同一项目内经用户明确采用的镜头图片，独立于生成批次和候选文件。 */
  adoptedImages?: Record<string, { firstFrameId?: string; plannedEndImageId?: string }>;
  promptProfile?: PetStoryPromptProfile;
  /** 仅恢复文字方言选择；媒体生成仍须在当前会话核对。 */
  promptCapability?: PetStoryCapability;
  storyApproval?: { hash: string; at: string };
  materials?: PetStoryMaterial[];
  plan?: PetStoryPlan;
  jobs: PetStoryChatJob[];
  drafts?: { taskId: string; shotId: string; kind: PetStoryPromptKind; final: string; compiledPrompt?: PetStoryCompiledPrompt }[];
  production?: PetStoryProduction;
  productionHistory?: PetStoryProduction[];
  updatedAt: string;
}
export interface PetStoryResult {
  /** 本轮关联修订；已有任务恢复时返回同一记录，不重新创建。 */
  repairJobId?: string;
  repairSourceJobId?: string;
  pendingCandidateJobIds?: string[];
  promptTargets?: PetStoryPromptBatch['targets'];
  success: boolean;
  exportName?: string;
  /** 仅展示用户选中目录的末级名称，不保存路径或新增项目索引。 */
  displayName?: string;
  project?: PetStoryProject;
  error?: string;
  taskId?: string;
  attachments?: string[];
  needsRepair?: boolean;
  compiledPrompt?: PetStoryCompiledPrompt;
}

export interface PetStoryPromptBatch {
  targets: ({ shotId: string; kind: PetStoryPromptKind; materialId?: never } | { materialId: string; shotId?: never; kind?: never })[];
  total: number;
  completed: number;
  status: 'running' | 'complete' | 'paused';
  jobId?: string;
}
export interface PetStoryMediaCandidate { taskId: string; artifactId: string; createdAt: string }
/** 媒体操作的只读前置反馈；实际提交仍由同一主进程门禁复验。 */
export interface PetStoryGenerationBlocker {
  code: 'story' | 'prompt' | 'materials' | 'firstFrame' | 'lastFrame' | 'capability' | 'task' | 'other';
  message: string;
  materialId?: string;
  shotId?: string;
  promptKind?: PetStoryPromptKind;
  jobId?: string;
}
export interface PetStoryGenerationEligibility {
  ready: boolean;
  blockers: PetStoryGenerationBlocker[];
  resolvedMode?: PetStoryResolvedMode;
  modeReason?: string;
}
export interface PetStoryGenerationEligibilityResult extends PetStoryResult {
  eligibility?: PetStoryGenerationEligibility;
}
export interface PetStoryAPI {
  beginImageOperation: (projectId: string, revision: number, request: PetStoryImageOperationRequest, capability?: PetStoryCapability) => Promise<PetStoryImageOperationResult>;
  advanceImageOperation: (projectId: string, operationId: string) => Promise<PetStoryImageOperationResult>;
  resumeImageOperation: (projectId: string, operationId: string, capability?: PetStoryCapability) => Promise<PetStoryImageOperationResult>;
  previewAdjustmentReply: (projectId: string, revision: number, adjustmentId: string, replyKey: string) => Promise<PetStoryAdjustmentPreviewResult>;
  beginAdjustment: (projectId: string, revision: number, target: PetStoryRuntimeTarget) => Promise<PetStoryAdjustmentResult>;
  captureAdjustmentReplies: (projectId: string, adjustmentId: string, conversationUrl: string, replies: PetStoryConversationReply[]) => Promise<PetStoryAdjustmentResult>;
  importAdjustmentImages: (projectId: string, revision: number, adjustmentId: string, replyKey: string) => Promise<PetStoryAdjustmentResult>;
  adoptAdjustmentReply: (projectId: string, revision: number, adjustmentId: string, replyKey: string) => Promise<PetStoryAdjustmentResult>;
  endAdjustment: (projectId: string, revision: number, adjustmentId: string) => Promise<PetStoryAdjustmentResult>;
  addShotImage: (projectId: string, revision: number, shotId: string, kind: 'firstFrame' | 'lastFrame') => Promise<PetStoryResult>;
  adoptImage: (projectId: string, revision: number, target: PetStoryImageTarget, assetId: string) => Promise<PetStoryResult>;
  inspectGeneration: (projectId: string, revision: number, target: PetStoryRuntimeTarget, capability?: PetStoryCapability, fallbacks?: Record<string, 'first_frame' | 'reference'>) => Promise<PetStoryGenerationEligibilityResult>;
  revealAsset: (projectId: string, assetId: string) => Promise<PetStoryResult>;
  revealProject: (projectId: string) => Promise<PetStoryResult>;
  promptStageTargets: (projectId: string, revision: number) => Promise<PetStoryResult>;
  savePromptModel: (projectId: string, revision: number, model?: PetStoryProject['promptModel']) => Promise<PetStoryResult>;
  savePromptBatch: (projectId: string, revision: number, batch: PetStoryPromptBatch) => Promise<PetStoryResult>;
  endChatWaiting: (projectId: string, revision: number, jobId: string) => Promise<PetStoryResult>;
  prepareRuntime: (projectId: string, revision: number, kind: PetStoryChatJob['kind'], target?: PetStoryRuntimeTarget) => Promise<PetStoryResult>;
  adoptPlanCandidate: (projectId: string, revision: number, jobId: string) => Promise<PetStoryResult>;
  adoptAssetsCandidate: (projectId: string, revision: number, jobId: string) => Promise<PetStoryResult>;
  adoptPromptCandidate: (projectId: string, revision: number, jobId: string) => Promise<PetStoryResult>;
  listExistingMediaCandidates: (projectId: string, shotId: string, kind: PetStoryPromptKind) => Promise<{ success: boolean; candidates?: PetStoryMediaCandidate[]; error?: string }>;
  saveOriginalStory: (projectId: string, revision: number, text: string) => Promise<PetStoryResult>;
  linkExistingMedia: (projectId: string, revision: number, shotId: string, kind: PetStoryPromptKind, taskId: string, artifactId?: string) => Promise<PetStoryResult>;
  saveShotPrompt: (projectId: string, revision: number, shotId: string, kind: PetStoryPromptKind, final: string) => Promise<PetStoryResult>;
  generateShotMedia: (projectId: string, revision: number, shotId: string, kind: PetStoryPromptKind, capability?: PetStoryCapability, fallbacks?: Record<string, 'first_frame' | 'reference'>) => Promise<PetStoryProductionResult>;
  readMedia: (projectId: string, assetId: string) => Promise<{ success: boolean; data?: string; mimeType?: string; error?: string }>;
  exportPrompts: (projectId: string, revision: number) => Promise<PetStoryResult>;
  confirmStory: (projectId: string, revision: number) => Promise<PetStoryResult>;
  saveMaterialPrompt: (projectId: string, revision: number, materialId: string, final: string) => Promise<PetStoryResult>;
  addMaterialImage: (projectId: string, revision: number, materialId: string) => Promise<PetStoryResult>;
  selectMaterialImage: (projectId: string, revision: number, materialId: string, assetId: string) => Promise<PetStoryResult>;
  approveMaterials: (projectId: string, revision: number, selections: { materialId: string; assetId: string }[]) => Promise<PetStoryResult>;
  generateMaterials: (projectId: string, revision: number, materialIds: string[], capability?: PetStoryCapability) => Promise<PetStoryProductionResult>;
  recordPageBindings: (projectId: string, taskId: string, runId: string, bindings: PetStoryPageBinding[]) => Promise<PetStoryProductionResult>;
  bindSharedReference: (projectId: string, revision: number, characterId: string, assetId: string) => Promise<PetStoryResult>;
  previewPrompt: (projectId: string, shotId: string, kind: PetStoryPromptKind, resolvedMode?: PetStoryResolvedMode) => Promise<PetStoryResult>;
  savePromptProfile: (projectId: string, revision: number, profile: PetStoryPromptProfile) => Promise<PetStoryResult>;
  selectProductionImage: (projectId: string, stepId: string, artifactId: string) => Promise<PetStoryProductionResult>;
  previewProduction: (projectId: string, capability?: PetStoryCapability, fallbacks?: Record<string, 'first_frame' | 'reference'>) => Promise<PetStoryProductionResult>;
  approveProduction: (projectId: string, revision: number, capability?: PetStoryCapability, fallbacks?: Record<string, 'first_frame' | 'reference'>) => Promise<PetStoryProductionResult>;
  advanceProduction: (projectId: string) => Promise<PetStoryProductionResult>;
  pauseProduction: (projectId: string) => Promise<PetStoryProductionResult>;
  resumeProduction: (projectId: string, capability?: PetStoryCapability) => Promise<PetStoryProductionResult>;
  resubmitProduction: (projectId: string, revision: number, request: TaskResubmitUncertainParams, capability?: PetStoryCapability) => Promise<PetStoryProductionResult>;
  bindProductionRun: (projectId: string, taskId: string, runId: string) => Promise<PetStoryProductionResult>;
  guardProductionTask: (taskId: string) => Promise<PetStoryProductionResult>;

  readReference: (projectId: string, assetId: string) => Promise<{ success: boolean; data?: string; error?: string }>;
  create: (studioProjectId: string, accountId: string) => Promise<PetStoryResult>;
  open: (path?: string) => Promise<PetStoryResult>;
  saveSource: (projectId: string, revision: number, text: string) => Promise<PetStoryResult>;
  saveMobileStory: (projectId: string, revision: number, text: string) => Promise<PetStoryResult>;
  addSceneReference: (projectId: string, shotId: string) => Promise<PetStoryResult>;
  addReference: (projectId: string, characterId: string) => Promise<PetStoryResult>;
  savePlan: (projectId: string, revision: number, plan: PetStoryPlan) => Promise<PetStoryResult>;
  prepareChat: (projectId: string, prompt: string, kind: PetStoryChatJob['kind'], parentJobId?: string, shotId?: string, promptKind?: PetStoryPromptKind, materialId?: string) => Promise<PetStoryResult>;
  draftFinal: (projectId: string, shotId: string, kind: PetStoryPromptKind) => Promise<PetStoryResult>;
  bindRun: (projectId: string, jobId: string, runId: string) => Promise<PetStoryResult>;
  retryUnsubmitted: (projectId: string, jobId: string) => Promise<PetStoryResult>;
  collectChat: (projectId: string, jobId: string) => Promise<PetStoryResult>;
}
