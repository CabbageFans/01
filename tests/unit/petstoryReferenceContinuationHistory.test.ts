/** 两参考图授权审计的离线结构校验，不读取用户目录或发送媒体请求。 */
import { describe, expect, it } from 'vitest';
import type { PetStoryCompiledPrompt, PetStoryPlan, PetStoryProduction, PetStoryProject, PetStoryVideoReferenceContinuation } from '@doubao-studio/contracts';
import { referenceContinuationHash, validateReferenceContinuationHistory } from '../../main/utils/petstoryReferenceContinuation';
import { validateProject } from '../../main/utils/petstoryProject';
import snapshot from '../fixtures/storyboard-five-shots.json';

const now = '2026-10-31T10:00:00.000Z';
function fixture(): PetStoryProject {
  const plan = structuredClone(snapshot.plan) as PetStoryPlan;
  const shotId = plan.shots[0].id;
  const source: PetStoryCompiledPrompt = { kind: 'video', requestedMode: 'first_last_frame', resolvedMode: 'first_last_frame', rulesVersion: 'TEST-rules',
    text: 'TEST 首帧采用@图片1，尾帧采用@图片2。', final: 'TEST 首帧采用@图片1，尾帧采用@图片2。',
    references: [{ assetId: 'TEST-first', characterIds: [], order: 1, purpose: 'firstFrame', slot: 'first' }, { assetId: 'TEST-last', characterIds: [], order: 2, purpose: 'plannedEndImage', slot: 'last' }],
    segments: [{ text: 'TEST 首帧采用' }, { referenceOrder: 1, sourceText: '@图片1' }, { text: '，尾帧采用' }, { referenceOrder: 2, sourceText: '@图片2' }, { text: '。' }] };
  const record: PetStoryVideoReferenceContinuation = { authorizationId: 'TEST-reference-auth', authorizedAt: now, shotId, taskId: 'TEST-task', originalRunId: 'TEST-original-run',
    firstFrameId: 'TEST-first', lastFrameId: 'TEST-last', firstSha256: 'a'.repeat(64), lastSha256: 'b'.repeat(64), model: 'seedance-2.0-fast',
    finalHash: referenceContinuationHash(source.final), promptTaskHash: 'c'.repeat(64), sourceCompiledPrompt: source,
    sourceRuntime: { runId: 'TEST-original-run', attempt: 1, stage: 'paused', message: 'TEST 未发送', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now,
      input: { mode: 'video', prompt: source.text, attachments: ['TEST-first.png', 'TEST-last.png'], videoConfig: { model: 'seedance-2.0-fast', aspectRatio: '9:16', duration: '5s' }, petstory: { projectId: 'TEST-project', stepId: 'TEST-step' }, promptReadback: 'exact' } },
    sourceError: { code: 'petstory_controls_unconfirmed', message: 'TEST 当前无原生首尾槽', recoverable: true, detectedAt: now } };
  const production: PetStoryProduction = { state: 'paused', planHash: 'd'.repeat(64), approvedAt: now, capability: { accountId: 'TEST-account', image: { state: 'unknown', reason: '' },
    modes: { first_frame: { state: 'unknown', reason: '' }, first_last_frame: { state: 'unknown', reason: '' }, reference: { state: 'unknown', reason: '' } }, durations: [] },
    shots: Object.fromEntries(plan.shots.map((shot): [string, PetStoryProduction['shots'][string]] => [shot.id, { requestedMode: shot.requestedMode, resolvedMode: 'reference', reason: 'TEST' }])),
    fallbacks: { [shotId]: 'reference' }, message: 'TEST', referenceContinuations: { [shotId]: record }, steps: [{ id: 'TEST-step', kind: 'video', shotId, taskId: 'TEST-task', status: 'bound', inputHash: referenceContinuationHash(source.text),
      attachmentAssetIds: ['TEST-first', 'TEST-last'], compiledPrompt: { ...source, resolvedMode: 'reference', references: source.references.map((reference): typeof reference => ({ ...reference, slot: undefined })) } }] };
  return { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, source: { kind: 'script', url: '', status: 'pending' }, plan, jobs: [], updatedAt: now,
    assets: [{ id: 'TEST-first', kind: 'firstFrame', shotId, relativePath: `shots/${shotId}/TEST-first.png` }, { id: 'TEST-last', kind: 'plannedEndImage', shotId, relativePath: `shots/${shotId}/TEST-last.png` }], production };
}

describe('两参考图授权保留完整原运行审计', (): void => {
  it('当前记录校验后完整保留，历史不依赖当前选图、正文或实际模式', (): void => {
    const project = fixture(); expect(validateProject(project, true).production?.referenceContinuations).toEqual(project.production?.referenceContinuations);
    const original = structuredClone(project.production!);
    project.productionHistory = [original]; project.production = undefined; project.assets = [];
    project.plan!.shots[0].prompts.video.final = 'TEST 后续已采用的新正文';
    expect(validateProject(project, true).productionHistory?.[0].referenceContinuations).toEqual(original.referenceContinuations);
  });

  it.each(['shape', 'null-record', 'authorization', 'date', 'hash', 'final-hash', 'source-text', 'source-ref', 'segments', 'run', 'step', 'model', 'submitted', 'readback', 'source-error', 'duplicate-auth', 'binding'] as const)('拒绝损坏的%s审计，当前和历史均不静默丢弃记录', (change): void => {
    const project = fixture(); const production = project.production!;
    const record = production.referenceContinuations![project.plan!.shots[0].id];
    if (change === 'shape') production.referenceContinuations = [] as unknown as typeof production.referenceContinuations;
    if (change === 'null-record') production.referenceContinuations![record.shotId] = null as unknown as typeof record;
    if (change === 'authorization') record.authorizationId = '';
    if (change === 'date') record.authorizedAt = 'TEST invalid date';
    if (change === 'hash') record.firstSha256 = 'TEST invalid hash';
    if (change === 'final-hash') record.finalHash = 'e'.repeat(64);
    if (change === 'source-text') record.sourceCompiledPrompt.text += 'TEST changed';
    if (change === 'source-ref') record.sourceCompiledPrompt.references[1].slot = 'first';
    if (change === 'segments') record.sourceCompiledPrompt.segments = [{ referenceOrder: 3 }];
    if (change === 'run') record.sourceRuntime.runId = 'TEST-other-run';
    if (change === 'step') record.sourceRuntime.input.petstory!.stepId = 'TEST-other-step';
    if (change === 'model') record.sourceRuntime.input.videoConfig!.model = 'seedance-2.5';
    if (change === 'submitted') record.sourceRuntime.submittedAt = now;
    if (change === 'readback') record.sourceRuntime.chatReadback = {} as NonNullable<typeof record.sourceRuntime.chatReadback>;
    if (change === 'source-error') record.sourceError!.code = 'submission_uncertain';
    if (change === 'duplicate-auth') production.referenceContinuations!['TEST-another-shot'] = { ...structuredClone(record), shotId: 'TEST-another-shot' };
    if (change === 'binding') record.sourcePageBindings = [];
    expect((): void => validateReferenceContinuationHistory(project.id, production)).toThrow('两参考图授权历史');
    expect((): PetStoryProject => validateProject(project, true)).toThrow('两参考图授权历史');
    project.production = undefined; project.productionHistory = [production];
    expect((): PetStoryProject => validateProject(project, true)).toThrow('两参考图授权历史');
  });
});
