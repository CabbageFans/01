import type { PetStoryChatAdjustment, PetStoryConversationReply, PetStoryAdjustmentResult, PetStoryAdjustmentPreviewResult } from './petstoryAdjustment';
import type { Task } from '../domain';
import type { TaskAddParams, TaskResubmitUncertainParams } from './tasks';

/** PetStory 桌面内部契约；路径和任务绑定只由主进程生成。 */
export type PetStoryMode = 'auto' | 'first_frame' | 'first_last_frame' | 'reference';
export type PetStoryPromptKind = 'firstFrame' | 'lastFrame' | 'video';
/** 手动确认以打开编辑器时的正文为基准；同项已变化时禁止覆盖。 */
export interface PetStoryPromptEditBasis {
  expectedFinal: string;
  baseJobId?: string;
}
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
  /** 新时间安排与镜长的快照；旧任务省略。 */
  timingPlanHash?: string;
  references: PetStoryPromptReference[];
  /** 当前角色采用图的指纹；只用于阻止旧形象任务回流，不包含旧造型文字。 */
  characterVisualBasis?: Record<string, string>;
  /** 正文由当前按图驱动规则创作，允许素材职责不变时只重绑实际图片。 */
  visualPolicy?: 'reference-first-v1';
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
  /** 此正文因角色视觉替换退出活跃使用，区别于真实审查错误。 */
  visualBasisStale?: boolean;
  /** 用户明确调整镜长后，历史正文需按当前时长重新适配；仅本地服务设置。 */
  timingStale?: boolean;
  /** 历史基础图正文已被采用图替代；正文与来源保留，但不得再作为有效写作输入。 */
  supersededByAssetId?: string;
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
  /** 与来源称谓分开的稳定中性制作标签，供动作、引用及说话者共用。 */
  productionLabel?: string;
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
  approved?: { assetId: string; sha256: string; at: string; identity?: { description?: string; assetId: string } };
  /** 用户明确采用的角色视觉依据，与剧情描述及基础图历史提示词分开。 */
  visualBasis?: { assetId: string; sha256: string; adoptedAt: string };
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
/** 文本估计的制作时间安排；有此字段时 timing 仅为兼容摘要。 */
export interface PetStoryTimingPlan {
  events: {
    id: string;
    kind: 'action' | 'dialogue' | 'reaction' | 'sound';
    description: string;
    startSeconds: number;
    endSeconds: number;
    /** 本镜 dialogue 数组的 0 起索引，每次发声恰对应一个事件。 */
    dialogueIndex?: number;
    /** 必须等待该事件完成；未填写允许真实可并行的事件重叠。 */
    afterEventId?: string;
  }[];
  estimatedRequiredSeconds: number;
  durationReason: string;
  cutReason: string;
}
export interface PetStoryDialogueSource {
  /** 原故事中的完整原句；不通过集合消除有意重复。 */
  text: string;
  /** 完整原句在原故事的第几次出现，从 1 开始。 */
  occurrence: number;
  /** Array.from(text) 的 0 起半开字符区间。 */
  start: number;
  end: number;
}
/** 自动模式的逐镜剧情判断；不是平台能力或已有任务的实际执行结果。 */
export interface PetStoryAutoModePlan {
  mode: PetStoryResolvedMode;
  reason: string;
  /** 旧方案的保守判断随起终状态重算，不冒充模型的逐镜剧情判断。 */
  source?: 'analysis' | 'legacy';
}
export interface PetStoryShot {
  id: string;
  order: number;
  /** 拆合前镜头ID，仅记录必要前身，不复用无关旧ID。 */
  predecessorShotIds?: string[];
  characterIds: string[];
  propIds?: string[];
  propStates?: { propId: string; holderId?: string; state: string }[];
  sceneId?: string;
  sceneView?: string;
  expression?: string;
  gaze?: string;
  interaction?: string;
  dialogue?: { speakerId: string; text: string; tone: string; pace: string; delivery?: 'onscreen' | 'offscreen' | 'voiceover'; source?: PetStoryDialogueSource }[];
  camera?: string;
  sourceRefs?: string[];
  narrativePurpose?: string;
  framing?: string;
  blocking?: string;
  performance?: string;
  sound?: string;
  timing?: string;
  timingPlan?: PetStoryTimingPlan;
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
  /** 旧项目可缺省；新分析为自动模式记录具体剧情依据。 */
  autoModePlan?: PetStoryAutoModePlan;
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
  /** 用户结束本地等待，历史任务与候选保留，不表示取消平台。 */
  endedAt?: string;
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
  /** 入库时冻结的本地来源。队列清理及远端链接过期不撤销本地资产。 */
  sourceSnapshot?: PetStoryMediaSourceSnapshot;
  imageReview?: PetStoryImageReview;
  /** 输入素材已替换，旧文件保留，须人工复核或重新制作。 */
  needsReview?: boolean;
  /** 实际角色图被替换；旧关键帧保留历史但不再代表当前形象。 */
  visualBasisStale?: boolean;
  sourceVideo?: { assetId: string; taskId: string; runId: string; sha256: string; atSeconds: number };
}
export interface PetStoryMediaSourceSnapshot {
  schemaVersion: 1;
  projectId: string;
  accountId: string;
  taskId: string;
  runId: string;
  artifactId: string;
  stepId?: string;
  shotId?: string;
  submittedAt?: string;
  inputHash?: string;
  videoInput?: VideoInputSnapshot;
  inputVersion?: number;
  inputDigest?: string;
  mode?: PetStoryResolvedMode;
  prompt?: string;
  videoConfig?: Task['videoConfig'];
  references: { assetId: string; sha256: string }[];
  recordedAt: string;
  /** 历史文件只有已保存来源；迁移不虚构平台受理证据。 */
  migrated?: true;
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
  /** 独立图片流水线；只有明确绑定的任务可使用图片并行执行槽。 */
  imageOperationId?: string;
  materialId?: string;
}
/** 本次执行唯一输入；页面引用只生成派发文本，不改变这份来源快照。 */
export interface VideoInputSnapshot {
  readonly schemaVersion: 1;
  readonly inputVersion: number;
  readonly projectId: string;
  readonly shotId: string;
  readonly stepId: string;
  readonly accountId: string;
  readonly sourceText: string;
  readonly dialogue: string;
  readonly prompt: string;
  readonly mode: PetStoryResolvedMode;
  readonly videoConfig: NonNullable<Task['videoConfig']>;
  readonly references: ReadonlyArray<{ readonly assetId: string; readonly order: number; readonly sha256: string; readonly purpose: PetStoryPromptReference['purpose']; readonly slot?: 'first' | 'last' }>;
  readonly digest: string;
}
/** 小型跨文件写入日志；intent 在创建 hold 任务前保存，按绑定可重入回填。 */
export interface PetStoryTaskIntent {
  operationId: string;
  kind: 'media' | 'chat';
  targetId: string;
  input: TaskAddParams;
  accountId: string;
  createdAt: string;
  taskId?: string;
  chatJob?: PetStoryChatJob;
}
export interface PetStoryProductionStep {
  videoInputSnapshot?: VideoInputSnapshot;
  failure?: { stage: 'download' | 'validation' | 'library'; code: string; message: string };
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
  mediaFailure?: { code: string; taskId: string; runId: string; artifactId: string; recordedAt: string; exitCode?: string | number; stderr?: string };
  /** 保留旧工具误拒事实，恢复后仅重新校验原文件。 */
  mediaRejectionHistory?: { artifactIds: string[]; reason: string; code: 'legacy_tool_failure' }[];
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
  /** 仅明确未提交的原视频可授权将既有首尾图改作两张普通参考图；源合同与旧运行完整留存。 */
  referenceContinuations?: Record<string, PetStoryVideoReferenceContinuation>;
  /** 图片操作的单次授权关联；不改变正式选图。 */
  imageOperationId?: string;
  phase?: 'materials' | 'shots';
  /** 画布单节点授权；完成这一项后停止，不补生成其他媒体。 */
  target?: { shotId: string; kind: PetStoryPromptKind };
  materialIds?: string[];
  materialHash?: string;
  state: 'running' | 'paused' | 'complete' | 'ended';
  endedAt?: string;
  /** 离开项目后完成当前已授权镜头，暂不调度下一镜。 */
  stopAfterCurrent?: boolean;
  planHash: string;
  approvedAt: string;
  capability: PetStoryCapability;
  fallbacks: Record<string, 'first_frame' | 'reference'>;
  shots: Record<string, PetStoryShotMedia>;
  steps: PetStoryProductionStep[];
  message: string;
}
export interface PetStoryVideoReferenceRequest {
  shotId: string; taskId: string; runId: string; inputHash: string;
  firstFrameId: string; lastFrameId: string; authorizationId: string; useExistingFrames: true;
}
export interface PetStoryVideoReferenceContinuation {
  authorizationId: string; authorizedAt: string; shotId: string; taskId: string; originalRunId: string;
  firstFrameId: string; lastFrameId: string; firstSha256: string; lastSha256: string;
  model: string; finalHash: string; promptTaskHash: string;
  sourceCompiledPrompt: PetStoryCompiledPrompt;
  sourcePageBindings?: PetStoryPageBinding[];
  sourceRuntime: NonNullable<Task['runtime']>;
  sourceError?: Task['errorInfo'];
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
  videoInputSnapshot?: VideoInputSnapshot;
  capability: PetStoryCapability;
  mode?: PetStoryResolvedMode;
  durationSeconds?: number;
  attachmentAssetIds: string[];
  references?: PetStoryPromptReference[];
  compiledPrompt?: PetStoryCompiledPrompt;
  fileSha256s?: string[];
}
export interface PetStoryProductionResult extends PetStoryResult {
  taskSnapshots?: Task[];
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
  shotBindings: { shotId: string; characterIds: string[]; propIds: string[]; propStates: NonNullable<PetStoryShot['propStates']>; sceneId: string; sceneView?: string; dialogue?: PetStoryShot['dialogue']; sourceRefs?: string[]; narrativePurpose?: string; framing?: string; blocking?: string; performance?: string; sound?: string; timing?: string; timingPlan?: PetStoryTimingPlan; continuity?: string }[];
  understanding?: string;
  sceneDesign?: string;
}
export interface PetStoryRuntimeTarget {
  /** 画布授权的后台文字任务，沿用原账号执行器。 */
  background?: 'canvas';
  promptBatchId?: string;
  /** 只供本轮文字创作的明确候选来源，不是采用或媒体输入。 */
  textContextJobIds?: string[];
  promptFeedback?: { text: string; baseJobId?: string; baseText?: string };
  /** 本次方案调整意图；requestId 标识同一次用户提交，不代表先采用来源方案。 */
  planFeedback?: { text: string; baseJobId?: string; requestId: string };
  /** 自动修订沿原授权持续检查进展；显式继续由用户授权，并重新观察停滞。 */
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
  /** 新分析请求的时间返回合同；旧已发送任务缺省，继续按原合同收取。 */
  planTimingVersion?: 'events-v1';
  background?: 'canvas';
  promptBatchId?: string;
  textContextJobIds?: string[];
  /** 用户主动反馈独立于每轮一次的自动格式修订预算。 */
  promptFeedback?: { text: string; baseJobId?: string; baseText?: string };
  /** 完整方案反馈职责，后台格式修订沿父链原样继承。 */
  planFeedback?: { text: string; baseJobId?: string; requestId: string };
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
  /** 显式采用前的完整正文版本，保留用户手改与原来源。 */
  replacedPrompt?: PetStoryPrompt;
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
  taskIntents?: PetStoryTaskIntent[];
  imageOperations?: PetStoryImageOperation[];
  /** 每次图片操作独立推进，正式批量／视频制作继续使用 production。 */
  imageProductions?: Record<string, PetStoryProduction>;
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
  /** 用户明确关联或本次生成取得的视频选择，独立于原制作步骤与历史快照。 */
  selectedVideos?: Record<string, string>;
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
  id?: string;
  scope?: 'shots';
  candidateJobIds?: string[];
  failedTargets?: { target: { shotId?: string; kind?: PetStoryPromptKind; materialId?: string }; jobId?: string; message: string }[];
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
  pauseImageOperation: (projectId: string, operationId: string) => Promise<PetStoryImageOperationResult>;
  endImageOperation: (projectId: string, operationId: string) => Promise<PetStoryImageOperationResult>;
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
  markCanvasChat: (projectId: string, revision: number, jobId: string) => Promise<PetStoryResult>;
  promptStageTargets: (projectId: string, revision: number, scope?: 'shots') => Promise<PetStoryResult>;
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
  saveShotPrompt: (projectId: string, revision: number, shotId: string, kind: PetStoryPromptKind, final: string, basis?: PetStoryPromptEditBasis) => Promise<PetStoryResult>;
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
  endProduction: (projectId: string) => Promise<PetStoryProductionResult>;
  detachProduction: (projectId: string) => Promise<PetStoryProductionResult>;
  resumeProduction: (projectId: string, capability?: PetStoryCapability) => Promise<PetStoryProductionResult>;
  resumeReferenceVideo: (projectId: string, revision: number, request: PetStoryVideoReferenceRequest) => Promise<PetStoryProductionResult>;
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
