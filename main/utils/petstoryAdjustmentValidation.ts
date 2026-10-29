import type { PetStoryChatAdjustment, PetStoryProject, PetStoryConversationReply } from '@doubao-studio/contracts';
import { createHash } from 'node:crypto';

function validDate(value: unknown): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function validateAdjustment(p: PetStoryProject, a: PetStoryChatAdjustment): void {
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(a.id)
    || !p.jobs.some((j): boolean => j.id === a.sourceJobId) || typeof a.conversationUrl !== 'string'
    || !/^https:\/\/www\.doubao\.com\/chat\/(?!local_)[a-zA-Z0-9_-]{1,128}$/.test(a.conversationUrl)
    || typeof a.basisHash !== 'string' || !/^[a-f0-9]{64}$/.test(a.basisHash) || !validDate(a.startedAt)
    || !['active', 'adopted', 'ended'].includes(a.status) || !Array.isArray(a.replies) || a.replies.length > 100
    || a.previousText !== undefined && (typeof a.previousText !== 'string' || a.previousText.length > 500_000)
    || a.checkedAt !== undefined && !validDate(a.checkedAt)) throw new Error('豆包调整记录无效，原文件已保留');
  validateAdjustmentTarget(a);
  const keys = new Set<string>();
  for (const reply of a.replies) {
    validateReply(reply);
    const key = createHash('sha256').update(JSON.stringify({ text: reply.text, precedingUserText: reply.precedingUserText, turnId: reply.turnId || '', messageId: reply.messageId || '', ...(reply.imageUrls?.length ? { imageUrls: reply.imageUrls } : {}) })).digest('hex');
    if (reply.key !== key || keys.has(key)) throw new Error('豆包回复归属不明确，未覆盖当前内容');
    keys.add(key);
  }
  if (a.status === 'adopted' && (!a.adoptedReplyKey || !keys.has(a.adoptedReplyKey))) throw new Error('已采用回复缺少具体来源');
}
function validateAdjustmentTarget(a: PetStoryChatAdjustment): void {
  const target = a.target;
  if (!target || typeof target !== 'object' || Object.keys(target).some((key): boolean => !['materialId', 'shotId', 'promptKind'].includes(key))
    || target.materialId && (typeof target.materialId !== 'string' || !!target.shotId || !!target.promptKind)
    || target.shotId && (typeof target.shotId !== 'string' || !['firstFrame', 'lastFrame', 'video'].includes(target.promptKind || ''))
    || target.promptKind && !target.shotId) throw new Error('豆包调整目标无效');
}
function validateReply(reply: PetStoryConversationReply): void {
    if (!reply || typeof reply.text !== 'string' || !reply.text.trim() && !reply.imageUrls?.length || reply.text.length > 250_000 || typeof reply.precedingUserText !== 'string' || reply.precedingUserText.length > 250_000
      || reply.imageUrls !== undefined && (!Array.isArray(reply.imageUrls) || !reply.imageUrls.length || reply.imageUrls.length > 20 || new Set(reply.imageUrls).size !== reply.imageUrls.length
        || reply.imageUrls.some((url: unknown): boolean => typeof url !== 'string' || url.length > 8192 || !/^https:\/\//i.test(url)))
      || !validDate(reply.capturedAt) || reply.turnId !== undefined && (typeof reply.turnId !== 'string' || reply.turnId.length > 256)
      || reply.messageId !== undefined && (typeof reply.messageId !== 'string' || reply.messageId.length > 256)) throw new Error('豆包回复快照无效');
}
export function validatePetStoryAdjustments(p: PetStoryProject): void {
  if (p.chatAdjustment !== undefined) validateAdjustment(p, p.chatAdjustment);
  if (p.chatAdjustmentHistory !== undefined) {
    if (!Array.isArray(p.chatAdjustmentHistory)) throw new Error('豆包调整历史无效');
    p.chatAdjustmentHistory.forEach((a): void => validateAdjustment(p, a));
  }
  for (const job of p.jobs) if (job.conversationReply !== undefined) {
    const evidence = job.conversationReply;
    const adjustment = [p.chatAdjustment, ...(p.chatAdjustmentHistory || [])].find((a): boolean => a?.id === evidence.adjustmentId);
    if (!adjustment || evidence.conversationUrl !== adjustment.conversationUrl || job.rawText !== evidence.reply.text || !adjustment.replies.some((r): boolean => r.key === evidence.reply.key && r.text === evidence.reply.text)) throw new Error('采用正文缺少具体豆包回复来源');
  }
}
