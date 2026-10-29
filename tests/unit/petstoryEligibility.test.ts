/** 原五镜头数据派生的离线技术状态；本文件的 TEST 来源不代表真实豆包产出。 */
import { describe, expect, it } from 'vitest';
import type { PetStoryPlan, PetStoryProject, PetStoryPrompt } from '@doubao-studio/contracts';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { seedOfflinePromptContracts } from '../fixtures/petstoryPromptContracts';
import { inspectPromptEligibility, promptDesignHash, promptWritingTarget, requirePromptEligibility } from '../../main/utils/petstoryEligibility';
import { compilePrompt, promptReferences } from '../../main/utils/petstoryPromptQuality';
import { buildPetStoryPromptExport } from '../../main/utils/petstoryExport';
import { storyHash } from '../../main/utils/petstoryMaterials';

function project(images = true): PetStoryProject {
  const p: PetStoryProject = { schemaVersion: 1, id: 'TEST-five', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-original-story', text: snapshot.mobileStory, importedAt: '2026-10-26T00:00:00.000Z' },
    plan: structuredClone(snapshot.plan) as PetStoryPlan, promptModel: 'seedance-2.0', assets: [], jobs: [], updatedAt: '2026-10-26T00:00:00.000Z' };
  // 资格测试的模拟视频正文只取原动作字段；旧快照的人物图号不冒充新视频首帧引用。
  for (const shot of p.plan!.shots) { shot.prompts.video.final = `TEST离线接口正文：${shot.action}`; shot.prompts.video.optimized = shot.prompts.video.final; }
  if (images) attachImages(p);
  p.storyApproval = { hash: storyHash(p), at: p.updatedAt };
  seedOfflinePromptContracts(p);
  return p;
}
function attachImages(p: PetStoryProject): void {
  for (const character of p.plan!.characters) {
    const id = `TEST-image-${character.id}`;
    character.referenceAssetId = id;
    p.assets.push({ id, kind: 'character', characterId: character.id, relativePath: `${id}.png`, imageReview: { state: 'adopted', target: { materialId: `character:${character.id}` }, basisHash: 'a'.repeat(64), adoptedAt: p.updatedAt, sha256: 'a'.repeat(64) }, validation: { decoded: true, sha256: 'a'.repeat(64), width: 64, height: 96, bytes: 100, checkedAt: '2026-10-26T00:00:00.000Z' } });
  }
}
function first(p: PetStoryProject): PetStoryPrompt { return p.plan!.shots[0].prompts.firstFrame; }
function target(p: PetStoryProject): { shotId: string; promptKind: 'firstFrame' } { return { shotId: p.plan!.shots[0].id, promptKind: 'firstFrame' }; }

describe('专用正文媒体资格与计划导出', (): void => {
  it('无合同旧稿可读可导出，但单节点和实际编译共享阻断', (): void => {
    const p = project(); const body = first(p).final; delete first(p).promptTask;
    expect(compilePrompt(p, target(p).shotId, 'firstFrame', undefined, true).final).toBe(body);
    expect((): void => requirePromptEligibility(p, first(p), target(p))).toThrow('缺少专用目标合同');
    expect((): unknown => compilePrompt(p, target(p).shotId, 'firstFrame')).toThrow('缺少专用目标合同');
    const entry = buildPetStoryPromptExport(p, []).prompts.find((item): boolean => item.id === `${target(p).shotId}:firstFrame`)!;
    expect(entry).toMatchObject({ final: body, review: { eligibility: 'needs_revision', submissionBlocked: true } });
  });
  it('来源完整的对应输入正常通过；分析来源、未采用候选与旧规则阶段不能冒充专用任务', (): void => {
    const p = project(); expect(inspectPromptEligibility(p, first(p), target(p)).state).toBe('submittable');
    expect(compilePrompt(p, target(p).shotId, 'firstFrame').final).toBe(first(p).final);
    const source = p.jobs.find((job): boolean => job.id === (first(p).sourceJobId || first(p).basisJobId))!;
    source.stage = 'analysis+assets+storyboard'; expect(inspectPromptEligibility(p, first(p), target(p)).state).toBe('needs_revision');
    source.stage = 'firstFrame'; source.resultStatus = 'candidate'; expect((): void => requirePromptEligibility(p, first(p), target(p))).toThrow('已采用的专用');
  });
  it.each(['missing', 'expired'] as const)('镜头正文和实际引用均正确但剧本确认%s，导出等待确认而不要求重写', (approval): void => {
    const p = project(); const body = first(p).final;
    p.storyApproval = approval === 'missing' ? undefined : { hash: '0'.repeat(64), at: p.updatedAt };
    const before = structuredClone(p); expect(inspectPromptEligibility(p, first(p), target(p))).toMatchObject({ state: 'adopted_unbound', writingReady: true });
    const entry = buildPetStoryPromptExport(p, []).prompts.find((item): boolean => item.id === `${target(p).shotId}:firstFrame`)!;
    expect(entry).toMatchObject({ final: body, review: { eligibility: 'adopted_unbound', submissionBlocked: true } });
    expect(entry.review.warnings.join('；')).toContain('当前剧本尚未确认或确认已过期'); expect(p).toEqual(before);
  });
  it('generic切已知模型和不同Seedance方言切换都要求专用Chat适配', (): void => {
    const p = project(); const shot = p.plan!.shots[0]; const body = shot.prompts.video;
    const source = p.jobs.find((job): boolean => job.id === (body.sourceJobId || body.basisJobId))!;
    body.promptTask!.dialect = 'generic'; source.promptTask = structuredClone(body.promptTask); source.stage = 'video';
    const t = { shotId: shot.id, promptKind: 'video' as const, mode: body.promptTask!.mode };
    expect(inspectPromptEligibility(p, body, t).reasons.join('；')).toContain('方言与本次目标模型不同');
    body.promptTask!.dialect = 'seedance20'; source.promptTask = structuredClone(body.promptTask); source.stage = 'video+video20';
    expect(inspectPromptEligibility(p, body, t).state).toBe('adopted_unbound');
    p.promptModel = 'seedance-2.5'; expect(inspectPromptEligibility(p, body, t).reasons.join('；')).toContain('方言与本次目标模型不同');
    expect(inspectPromptEligibility(p, body, { ...t, model: 'seedance-2.0' }).state).toBe('adopted_unbound');
  });
  it('有效generic计划只补齐一次文字阶段，确定已知模型或改变模式后才重新进入适配', (): void => {
    const p = project(); const shot = p.plan!.shots[0]; p.promptModel = 'generic';
    seedOfflinePromptContracts(p, { shotId: shot.id, promptKind: 'video' });
    const t = { shotId: shot.id, promptKind: 'video' as const, mode: shot.prompts.video.promptTask!.mode };
    expect(inspectPromptEligibility(p, shot.prompts.video, t)).toMatchObject({ state: 'creative_plan', writingReady: true });
    expect(inspectPromptEligibility(p, shot.prompts.video, { ...t, model: 'seedance-2.0' }).writingReady).toBe(false);
    expect(inspectPromptEligibility(p, shot.prompts.video, { ...t, mode: 'first_frame' }).writingReady).toBe(false);
    p.promptModel = 'seedance-2.0'; expect(inspectPromptEligibility(p, shot.prompts.video, t).writingReady).toBe(false);
  });
  it('已知模型但auto模式尚未解析的专用文字计划可完成；媒体仍阻断，明确模式后需Chat适配', (): void => {
    const p = project(); const shot = p.plan!.shots[0]; shot.requestedMode = 'auto';
    seedOfflinePromptContracts(p, { shotId: shot.id, promptKind: 'video' });
    const t = promptWritingTarget(p, { shotId: shot.id, promptKind: 'video' });
    expect(t).toMatchObject({ model: 'seedance-2.0', mode: undefined });
    expect(inspectPromptEligibility(p, shot.prompts.video, t)).toMatchObject({ state: 'creative_plan', writingReady: true });
    expect((): void => requirePromptEligibility(p, shot.prompts.video, t)).toThrow('目标视频模式');
    expect(inspectPromptEligibility(p, shot.prompts.video, { ...t, mode: 'first_frame' }).writingReady).toBe(false);
  });
  it('归档制作后历史模型意图在继续和导出相同，显式generic仍覆盖历史', (): void => {
    const p = project(); const shot = p.plan!.shots[0]; const target = { shotId: shot.id, promptKind: 'video' as const, mode: shot.prompts.video.promptTask!.mode };
    p.promptModel = undefined; p.promptCapability = undefined;
    const entry = { state: 'supported' as const, free: 'free' as const, reason: 'TEST历史能力记录' };
    p.productionHistory = [{ state: 'complete', planHash: 'TEST', approvedAt: p.updatedAt, fallbacks: {}, message: 'TEST', steps: [], shots: {},
      capability: { accountId: p.accountId, checkedAt: p.updatedAt, freeEvidence: 'user_confirmed', durations: [5], image: entry,
        modes: { first_frame: entry, first_last_frame: entry, reference: entry }, videoConfig: { model: 'seedance-2.0', duration: '5s', aspectRatio: '9:16' } } }];
    expect(inspectPromptEligibility(p, shot.prompts.video, target).state).toBe('adopted_unbound');
    expect(buildPetStoryPromptExport(p, []).prompts.find((item): boolean => item.id === `${shot.id}:video`)!.review.eligibility).toBe('adopted_unbound');
    p.promptModel = 'generic'; expect(inspectPromptEligibility(p, shot.prompts.video, target).writingReady).toBe(false);
  });
  it.each(['first_frame', 'first_last_frame', 'reference'] as const)('实际模式%s与原合同不同必须修订，不能互换首尾槽与普通多参考', (mode): void => {
    const p = project(); const shot = p.plan!.shots[0];
    const t = { shotId: shot.id, promptKind: 'video' as const, mode };
    const result = inspectPromptEligibility(p, shot.prompts.video, t);
    if (shot.prompts.video.promptTask!.mode === mode) expect(result.state).toBe('adopted_unbound');
    else expect(result.reasons.join('；')).toContain('目标视频模式与实际模式不同');
  });
  it('同人物只调上传次序以及计划引用落到真实图片不失效；设计与已采用边界改变则失效', (): void => {
    const p = project(false); const t = target(p); const hash = promptDesignHash(p, t); attachImages(p); p.plan!.shots[0].characterIds.reverse();
    expect(promptDesignHash(p, t)).toBe(hash);
    const refs = promptReferences(p, p.plan!.shots[0], 'firstFrame', undefined, true);
    expect(inspectPromptEligibility(p, first(p), { ...t, currentReferences: refs }).state).toBe('submittable');
    const next = p.plan!.shots[1]; const nextTarget = { shotId: next.id, promptKind: 'firstFrame' as const };
    const before = promptDesignHash(p, nextTarget); first(p).final = `${first(p).final}\nTEST 人工技术修改`; first(p).edited = true;
    expect(promptDesignHash(p, nextTarget)).toBe(before);
    p.plan!.shots[0].prompts.video.final += '\nTEST 前镜已采用边界修改'; p.plan!.shots[0].prompts.video.edited = true;
    expect(promptDesignHash(p, nextTarget)).not.toBe(before);
    expect(inspectPromptEligibility(p, next.prompts.firstFrame, nextTarget).state).toBe('needs_revision');
  });
  it('同一角色改选真实图片A到B会进入正常Chat适配，不能只在媒体提交时才发现旧引用', (): void => {
    const p = project(); const t = target(p); const original = p.assets[0]; const hash = promptDesignHash(p, t);
    p.assets.push({ ...original, id: 'TEST-replacement-image' }); p.plan!.characters[0].referenceAssetId = 'TEST-replacement-image';
    expect(promptDesignHash(p, t)).toBe(hash);
    const result = inspectPromptEligibility(p, first(p), t);
    expect(result).toMatchObject({ state: 'needs_revision', writingReady: false });
    expect(result.reasons.join('；')).toContain('素材或用途已变化');
    expect((): unknown => compilePrompt(p, t.shotId, 'firstFrame')).toThrow('素材或用途已变化');
  });
  it('手改有明确采用依据时保留使用，edited不豁免缺合同和事实变更', (): void => {
    const p = project(); const body = first(p); body.basisJobId = body.sourceJobId || body.basisJobId; body.sourceJobId = undefined; body.edited = true;
    expect(inspectPromptEligibility(p, body, target(p)).state).toBe('submittable');
    delete body.promptTask; expect(inspectPromptEligibility(p, body, target(p)).state).toBe('needs_revision');
    const empty = { ...body, final: '' }; expect(inspectPromptEligibility(p, empty, target(p)).state).toBe('creative_plan');
  });
  it.each(['missing_reference', 'xml_sound', 'missing_dialogue'] as const)('手改%s重新使用同一采用前内容检查，不能借edited通过', (variant): void => {
    const p = project(); const shot = p.plan!.shots[0]; const body = shot.prompts.video;
    // 只派生原故事文本的技术状态；此处不是新的豆包创作结果。
    if (variant === 'missing_dialogue') shot.dialogue = [{ speakerId: shot.characterIds[0], text: snapshot.mobileStory.slice(0, 8), tone: 'TEST', pace: 'TEST' }];
    seedOfflinePromptContracts(p, { shotId: shot.id, promptKind: 'video' });
    body.basisJobId = body.sourceJobId || body.basisJobId; body.sourceJobId = undefined; body.edited = true;
    const labels = body.promptTask!.references.map((ref): string => `@图片${ref.order}`).join(' ');
    body.final = `${variant === 'missing_reference' ? '' : labels}\n${variant === 'xml_sound' ? '<声音>TEST</声音>' : ''}\n全程无字幕、无对白文字叠加。`;
    expect((): unknown => compilePrompt(p, shot.id, 'video', body.promptTask!.mode)).toThrow(variant === 'missing_reference' ? '目标素材标签' : variant === 'xml_sound' ? 'XML' : '台词');
  });
});
