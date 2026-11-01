import { createHash } from 'node:crypto';
import type { PetStoryAsset, PetStoryProduction, PetStoryProductionStep, PetStoryProject, PetStoryPrompt, PetStoryVideoReferenceContinuation } from '@doubao-studio/contracts';
import { characterVisualBasis } from './petstoryMaterials';
import { selectedShotImageId } from './petstoryImageReview';
import { renderReferenceSegments } from './petstoryReferenceText';

export function referenceContinuationHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function invalidContinuation(): never { throw new Error('两参考图授权历史不完整或绑定无效，原文件已保留，请核对原任务'); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value); }
function timestamp(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function fingerprint(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }

/** 明确重发只替换当前 taskId；原两图授权仍绑定同一步骤及其持久化原任务历史。 */
export function referenceContinuationStep(production: PetStoryProduction, shotId: string, record: PetStoryVideoReferenceContinuation): PetStoryProductionStep | undefined {
  return production.steps.find((step): boolean => step.kind === 'video' && step.shotId === shotId
    && (step.taskId === record.taskId || !!step.resubmissionHistory?.some((history): boolean => history.taskId === record.taskId)));
}

/** 历史只核对保存时自身证据，不要求历史选图、模型或正文仍等于当前项目。 */
export function validateReferenceContinuationHistory(projectId: string, production: PetStoryProduction): void {
  const values: unknown = production.referenceContinuations;
  if (values === undefined) return;
  if (!object(values) || !Array.isArray(production.steps)) invalidContinuation();
  const authorizations = new Set<string>();
  for (const [shotId, value] of Object.entries(values)) {
    if (!object(value)) invalidContinuation();
    const record = value as unknown as PetStoryVideoReferenceContinuation;
    validateContinuationIdentity(record, shotId);
    if (authorizations.has(record.authorizationId)) invalidContinuation();
    authorizations.add(record.authorizationId);
    const step = referenceContinuationStep(production, shotId, record);
    if (!step || JSON.stringify(step.attachmentAssetIds) !== JSON.stringify([record.firstFrameId, record.lastFrameId])) invalidContinuation();
    validateContinuationSource(record);
    validateContinuationRuntime(record, projectId, step.id);
  }
}
function validateContinuationIdentity(record: PetStoryVideoReferenceContinuation, shotId: string): void {
  if (!identifier(shotId) || record.shotId !== shotId || !identifier(record.taskId) || !identifier(record.originalRunId)
    || typeof record.authorizationId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(record.authorizationId) || !timestamp(record.authorizedAt)
    || !identifier(record.firstFrameId) || !identifier(record.lastFrameId) || record.firstFrameId === record.lastFrameId
    || !fingerprint(record.firstSha256) || !fingerprint(record.lastSha256) || !fingerprint(record.finalHash) || !fingerprint(record.promptTaskHash)
    || typeof record.model !== 'string' || !record.model.trim() || record.model.length > 100) invalidContinuation();
}
function validateContinuationRuntime(record: PetStoryVideoReferenceContinuation, projectId: string, stepId: string): void {
  const runtime = record.sourceRuntime;
  if (!object(runtime) || !object(runtime.input) || runtime.runId !== record.originalRunId || !Number.isSafeInteger(runtime.attempt) || runtime.attempt < 1
    || typeof runtime.stage !== 'string' || !runtime.stage || runtime.stage === 'completed' || !timestamp(runtime.startedAt)
    || !timestamp(runtime.stageStartedAt) || !timestamp(runtime.lastHeartbeatAt) || runtime.input.mode !== 'video'
    || runtime.input.prompt !== record.sourceCompiledPrompt.text || !Array.isArray(runtime.input.attachments) || runtime.input.attachments.length !== 2
    || runtime.input.attachments.some((file): boolean => typeof file !== 'string' || !file.trim())
    || !object(runtime.input.petstory) || runtime.input.petstory.projectId !== projectId || runtime.input.petstory.stepId !== stepId) invalidContinuation();
  validateContinuationRuntimeEvidence(record);
}
function validateContinuationRuntimeEvidence(record: PetStoryVideoReferenceContinuation): void {
  const runtime = record.sourceRuntime; const config = runtime.input.videoConfig; const error = record.sourceError;
  if (!object(config) || config.model !== record.model || typeof config.duration !== 'string' || !config.duration.trim()
    || typeof config.aspectRatio !== 'string' || !config.aspectRatio.trim() || runtime.submittedAt !== undefined || runtime.acceptanceObservation !== undefined
    || runtime.chatResponse !== undefined || runtime.chatReadback !== undefined || runtime.chatReadbackReview !== undefined
    || runtime.manualObservation !== undefined || runtime.chatAdjustmentGuard?.active) invalidContinuation();
  if (!object(error) || error.code !== 'petstory_controls_unconfirmed' || typeof error.message !== 'string' || !error.message.trim()
    || typeof error.recoverable !== 'boolean' || !timestamp(error.detectedAt)) invalidContinuation();
}
function validateContinuationSource(record: PetStoryVideoReferenceContinuation): void {
  const source = record.sourceCompiledPrompt;
  if (!object(source) || source.kind !== 'video' || source.resolvedMode !== 'first_last_frame'
    || typeof source.text !== 'string' || !source.text.trim() || typeof source.final !== 'string' || !source.final.trim()
    || record.finalHash !== referenceContinuationHash(source.final) || typeof source.rulesVersion !== 'string' || !source.rulesVersion
    || !Array.isArray(source.references) || source.references.length !== 2) invalidContinuation();
  const first = source.references[0]; const last = source.references[1];
  if (!object(first) || !object(last) || first.assetId !== record.firstFrameId || last.assetId !== record.lastFrameId || first.order !== 1 || last.order !== 2
    || first.slot !== 'first' || last.slot !== 'last' || !['firstFrame', 'actualEndFrame'].includes(first.purpose) || last.purpose !== 'plannedEndImage'
    || source.references.some((reference): boolean => !Array.isArray(reference.characterIds) || reference.characterIds.some((id): boolean => !identifier(id)))) invalidContinuation();
  validateContinuationBindings(record);
  if (source.segments !== undefined) {
    if (!Array.isArray(source.segments) || source.segments.some((segment): boolean => !object(segment)
      || ('text' in segment ? typeof segment.text !== 'string' || 'referenceOrder' in segment
        : !Number.isSafeInteger(segment.referenceOrder) || ![1, 2].includes(segment.referenceOrder) || segment.sourceText !== undefined && typeof segment.sourceText !== 'string'))
      || renderReferenceSegments(source.segments, record.sourcePageBindings) !== source.text) invalidContinuation();
  }
}
function validateContinuationBindings(record: PetStoryVideoReferenceContinuation): void {
  if (record.sourcePageBindings === undefined) return;
  if (!Array.isArray(record.sourcePageBindings) || record.sourcePageBindings.length !== 2
    || record.sourcePageBindings.some((binding, index): boolean => !object(binding) || binding.assetId !== record.sourceCompiledPrompt.references[index].assetId
      || binding.order !== index + 1 || binding.slot !== (index === 0 ? 'first_frame' : 'last_frame') || binding.reference !== 'slot'
      || typeof binding.label !== 'string' || !binding.label.trim() || binding.label.length > 40 || !fingerprint(binding.previewHash)
      || binding.fileSha256 !== (index === 0 ? record.firstSha256 : record.lastSha256))) invalidContinuation();
}
function continuationTargetMatches(p: PetStoryProject, production: PetStoryProduction, shotId: string, record: PetStoryVideoReferenceContinuation, prompt: PetStoryPrompt, step: PetStoryProductionStep): boolean {
  if (prompt.promptTask?.characterVisualBasis && JSON.stringify(prompt.promptTask.characterVisualBasis) !== JSON.stringify(characterVisualBasis(p, shotId))) return false;
  if (production.fallbacks[shotId] !== 'reference' || production.shots[shotId]?.resolvedMode !== 'reference'
    || record.shotId !== shotId || !record.authorizationId || !record.authorizedAt || !record.originalRunId
    || record.model !== production.capability.videoConfig?.model || prompt.promptTask?.mode !== 'first_last_frame'
    || record.finalHash !== referenceContinuationHash(prompt.final) || record.promptTaskHash !== referenceContinuationHash(prompt.promptTask)
    || record.firstFrameId !== selectedShotImageId(p, shotId, 'firstFrame') || record.lastFrameId !== selectedShotImageId(p, shotId, 'lastFrame')
    || JSON.stringify(step.attachmentAssetIds) !== JSON.stringify([record.firstFrameId, record.lastFrameId])) return false;
  return true;
}
function continuationFramesMatch(record: PetStoryVideoReferenceContinuation, final: string, first: PetStoryAsset | undefined, last: PetStoryAsset | undefined): boolean {
  const source = record.sourceCompiledPrompt;
  if (first?.visualBasisStale || last?.visualBasisStale || !first?.validation?.decoded || !last?.validation?.decoded || first.validation.sha256 !== record.firstSha256 || last.validation.sha256 !== record.lastSha256
    || source.kind !== 'video' || source.final !== final || source.resolvedMode !== 'first_last_frame' || source.references.length !== 2
    || source.references[0].assetId !== first.id || source.references[0].slot !== 'first' || !['firstFrame', 'actualEndFrame'].includes(source.references[0].purpose)
    || source.references[1].assetId !== last.id || source.references[1].slot !== 'last' || source.references[1].purpose !== 'plannedEndImage') return false;
  return true;
}
/** 仅当前制作中的具体授权兼容原生首尾合同；不改合同，也不扩展到候选或其他素材。 */
export function currentReferenceContinuation(p: PetStoryProject, shotId: string): PetStoryVideoReferenceContinuation | undefined {
  const production = p.production; const record = production?.referenceContinuations?.[shotId];
  const shot = p.plan?.shots.find((item): boolean => item.id === shotId); const prompt = shot?.prompts.video;
  const step = production && record ? referenceContinuationStep(production, shotId, record) : undefined;
  if (!record || !prompt || !step || !production || !continuationTargetMatches(p, production, shotId, record, prompt, step)) return undefined;
  const first = p.assets.find((asset): boolean => asset.id === record.firstFrameId); const last = p.assets.find((asset): boolean => asset.id === record.lastFrameId);
  return continuationFramesMatch(record, prompt.final, first, last) ? record : undefined;
}
