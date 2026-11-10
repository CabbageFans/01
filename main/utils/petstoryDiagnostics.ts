import type { PetStoryProduction, PetStoryProductionStep, PetStoryProject } from '@doubao-studio/contracts';

/** 现有诊断包共用的自由文本脱敏，不导出正文、凭据、内部URL或媒体绝对路径。 */
export function diagnosticText(value: string | undefined): string | undefined {
  return value?.replace(/https?:\/\/[^\s<>"']+/gi, '[地址已脱敏]')
    .replace(/\b(?:cookie|authorization)\s*[:=][^\r\n]*/gi, '[凭据已脱敏]')
    .replace(/(?:Bearer\s+|(?:[a-z_]*token)\s*[:=]\s*)[^\s,;]+/gi, '[凭据已脱敏]')
    .replace(/(?:[a-z]:[\\/]|\/(?:Users|home|private|var|tmp|Applications|Volumes|opt)\/)[^\n<>"']+/gi, '[文件路径已脱敏]')
    .slice(0, 4096);
}
function stepDiagnostic(step: PetStoryProductionStep): object {
  return { stepId: step.id, kind: step.kind, shotId: step.shotId, materialId: step.materialId, taskId: step.taskId, runId: step.runId, status: step.status,
    inputDigest: step.videoInputSnapshot?.digest || step.inputHash, inputVersion: step.videoInputSnapshot?.inputVersion,
    references: step.videoInputSnapshot?.references || step.attachmentAssetIds.map((assetId): object => ({ assetId })),
    error: diagnosticText(step.error), failure: step.failure ? { ...step.failure, message: diagnosticText(step.failure.message) } : undefined,
    mediaFailure: step.mediaFailure ? { ...step.mediaFailure, stderr: diagnosticText(step.mediaFailure.stderr) } : undefined,
    artifactRejections: step.rejectedArtifactIds, mediaRejectionHistory: step.mediaRejectionHistory?.map((item): object => ({ ...item, reason: diagnosticText(item.reason) })),
    resubmissions: step.resubmissionHistory?.map((item): object => ({ taskId: item.taskId, runId: item.runId, submittedAt: item.submittedAt, authorizationId: item.authorizationId })),
    pageBindings: step.pageBindings?.map((binding): object => ({ order: binding.order, assetId: binding.assetId, slot: binding.slot, reference: binding.reference, fileSha256: binding.fileSha256, previewHash: binding.previewHash })) };
}
function productionDiagnostic(production: PetStoryProduction, history: boolean): object {
  return { history, state: production.state, phase: production.phase, target: production.target, approvedAt: production.approvedAt, endedAt: production.endedAt,
    stopAfterCurrent: production.stopAfterCurrent, message: diagnosticText(production.message), steps: production.steps.map(stepDiagnostic) };
}
/** 项目和任务日志在原诊断导出中以ID关联；此投影没有文件路径或创作正文。 */
export function buildPetStoryDiagnostics(project: PetStoryProject): object {
  return { projectId: project.id, studioProjectId: project.studioProjectId, accountId: project.accountId, revision: project.revision,
    productions: [...(project.productionHistory || []).map((production): object => productionDiagnostic(production, true)),
      ...(project.production ? [productionDiagnostic(project.production, false)] : []), ...Object.values(project.imageProductions || {}).map((production): object => productionDiagnostic(production, false))],
    intents: project.taskIntents?.map((intent): object => ({ operationId: intent.operationId, kind: intent.kind, targetId: intent.targetId, taskId: intent.taskId, createdAt: intent.createdAt })),
    assets: project.assets.map((asset): object => ({ assetId: asset.id, kind: asset.kind, shotId: asset.shotId, taskId: asset.taskId, runId: asset.runId, artifactId: asset.artifactId, downloadJobId: asset.downloadJobId,
      validation: asset.validation, source: asset.sourceSnapshot ? { taskId: asset.sourceSnapshot.taskId, runId: asset.sourceSnapshot.runId, artifactId: asset.sourceSnapshot.artifactId, inputHash: asset.sourceSnapshot.inputHash, inputVersion: asset.sourceSnapshot.inputVersion, inputDigest: asset.sourceSnapshot.inputDigest, mode: asset.sourceSnapshot.mode, recordedAt: asset.sourceSnapshot.recordedAt } : undefined })),
    jobs: project.jobs.map((job): object => ({ jobId: job.id, taskId: job.taskId, runId: job.runId, shotId: job.shotId, materialId: job.materialId, kind: job.kind, status: job.status,
      createdAt: job.createdAt, endedWaitingAt: job.endedWaitingAt, error: diagnosticText(job.error) })) };
}
