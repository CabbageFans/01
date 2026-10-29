import type { PetStoryConversationReply } from '@doubao-studio/contracts';
import type { ChatPageSnapshot } from './chatReadback';

/** 用正文和前一用户消息标识具体回复；不以最后一条或 DOM 顺序作为采用依据。 */
export async function readPetStoryConversationReplies(snapshot: ChatPageSnapshot): Promise<PetStoryConversationReply[]> {
  if (snapshot.generating) throw new Error('豆包正在回复，完成后会自动读取');
  const result: PetStoryConversationReply[] = [];
  let precedingUserText = '';
  for (const message of snapshot.messages) {
    const text = message.rawText ?? message.renderedSource;
    if (message.role === 'user') { precedingUserText = text?.trim() ? text : ''; continue; }
    if (!text?.trim() || !precedingUserText) continue;
    const identity = { text, precedingUserText, turnId: message.turnId || '', messageId: message.messageId || '' };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(identity)));
    const key = Array.from(new Uint8Array(digest), (byte): string => byte.toString(16).padStart(2, '0')).join('');
    result.push({ key, text, precedingUserText, turnId: message.turnId, messageId: message.messageId, capturedAt: new Date().toISOString() });
  }
  if (result.length > 100 || new Set(result.map((reply): string => reply.key)).size !== result.length) throw new Error('当前可见回复无法唯一识别，请在豆包中定位需要的回复');
  return result;
}
