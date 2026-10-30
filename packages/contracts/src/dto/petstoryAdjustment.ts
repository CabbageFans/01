import type { PetStoryRuntimeTarget, PetStoryResult, PetStoryPlan, PetStoryProject } from './petstory';

/** 具体可见回复的来源快照；key由完整正文、前一用户消息及平台消息标识生成。 */
export interface PetStoryConversationReply {
  key: string;
  text: string;
  precedingUserText: string;
  turnId?: string;
  messageId?: string;
  /** 当前具体助手回复中的可辨认图片；与正文一同参与来源核对。 */
  imageUrls?: string[];
  capturedAt: string;
}
export interface PetStoryChatAdjustment {
  id: string;
  target: PetStoryRuntimeTarget;
  sourceJobId: string;
  conversationUrl: string;
  basisHash: string;
  previousText?: string;
  startedAt: string;
  status: 'active' | 'adopted' | 'ended';
  replies: PetStoryConversationReply[];
  checkedAt?: string;
  adoptedReplyKey?: string;
  /** 应用明确选定回复时安排的单次修订；保持自由对话保护，只放行这一个任务。 */
  repairJobId?: string;
  selectedReplyKey?: string;
}
export interface PetStoryAdjustmentResult extends PetStoryResult {
  adjustment?: PetStoryChatAdjustment;
}

export interface PetStoryAdjustmentPreview {
  target: PetStoryRuntimeTarget;
  body?: string;
  previousBody?: string;
  plan?: PetStoryPlan;
  previousPlan?: PetStoryPlan;
  contentBasis?: PetStoryProject['contentBasis'];
  previousContentBasis?: PetStoryProject['contentBasis'];
}
export interface PetStoryAdjustmentPreviewResult extends PetStoryResult { preview?: PetStoryAdjustmentPreview }
