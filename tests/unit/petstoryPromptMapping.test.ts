/** 编译仅负责既有引用的确定性映射；本文件不代表真实 Chat 创作验收。 */
import { describe, expect, it } from 'vitest';
import type { PetStoryCompiledPrompt, PetStoryPageBinding, PetStoryProject, PetStoryPrompt, PetStoryPromptReference } from '@doubao-studio/contracts';
import { compileMaterialPrompt, compilePrompt, compileReferencedText, promptReferences } from '../../main/utils/petstoryPromptQuality';
import { inspectPromptEligibility } from '../../main/utils/petstoryEligibility';
import { bindReferenceText } from '../../main/utils/petstoryReferenceText';

function prompt(final: string): PetStoryPrompt { return { original: final, optimized: final, final, edited: false, rulesVersion: 'TEST' }; }
function project(): PetStoryProject {
  return { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 0, jobs: [], updatedAt: '2026-10-26T00:00:00.000Z',
    source: { kind: 'script', url: '', status: 'review_required' }, assets: [
      { id: 'image-a', kind: 'character', characterId: 'actor-a', relativePath: 'a.png' },
      { id: 'image-b', kind: 'character', characterId: 'actor-b', relativePath: 'b.png' },
    ], plan: { sourceSummary: 'TEST', adaptedStory: 'TEST', characters: [
      { id: 'actor-a', name: '甲', role: 'main', purpose: 'TEST', description: 'TEST', referenceAssetId: 'image-a' },
      { id: 'actor-b', name: '乙', role: 'supporting', purpose: 'TEST', description: 'TEST', referenceAssetId: 'image-b' },
    ], shots: [{ id: 'shot', order: 1, characterIds: ['actor-a', 'actor-b'], scene: 'TEST', action: 'TEST', startState: 'TEST起点', endState: 'TEST终点', durationSeconds: 5, requestedMode: 'reference', transition: 'cut',
      prompts: { firstFrame: prompt('@图片1中的甲看向@图片2中的乙。'), lastFrame: prompt('以@图片1为编辑基图，甲抬眼，保留构图。'), video: prompt('从@图片1中的起点开始。') } }] } };
}
function binding(assetId: string, order: number, label: string, slot: PetStoryPageBinding['slot'] = 'reference'): PetStoryPageBinding {
  return { assetId, order, label, slot, previewHash: 'a'.repeat(64), reference: slot === 'reference' ? 'mention' : 'slot' };
}

describe('原正文与目标媒体素材映射', (): void => {
  it('原生 @图片N、换行、引号和普通括号完整保留；没有代码编写的素材说明或保持项', (): void => {
    const p = project(); const final = '@图片1中的甲看向@图片2中的乙。\n“原台词” {光线} {{画面标注}} <停顿>\n墙上挂着第 2 张画。';
    p.plan!.shots[0].prompts.firstFrame.final = final;
    const compiled = compilePrompt(p, 'shot', 'firstFrame', undefined, true);
    expect(compiled.text).toBe(final); expect(compiled.final).toBe(final);
    expect(compiled.segments!.filter((segment): boolean => 'referenceOrder' in segment)).toEqual([
      { referenceOrder: 1, sourceText: '@图片1' }, { referenceOrder: 2, sourceText: '@图片2' },
    ]);
  });
  it('Chat 附件顺序不参与解释：采用时的目标标签按稳定素材身份映射当前顺序与实际页面节点', (): void => {
    const p = project(); const shot = p.plan!.shots[0]; const final = shot.prompts.firstFrame.final;
    shot.prompts.firstFrame.promptTask = { references: promptReferences(p, shot, 'firstFrame', undefined, true), dialect: 'seedream' };
    shot.characterIds.reverse();
    const compiled = compilePrompt(p, 'shot', 'firstFrame', undefined, true);
    expect(compiled.final).toBe(final); expect(compiled.text).toBe('@图片2中的甲看向@图片1中的乙。');
    expect(compiled.references.map((ref): string => ref.assetId)).toEqual(['image-b', 'image-a']);
    const bound = bindReferenceText(compiled, [binding('image-b', 1, '@图片8'), binding('image-a', 2, '@图片3')]);
    expect(bound.text).toBe('@图片3中的甲看向@图片8中的乙。'); expect(bound.final).toBe(final);
  });
  it('每次既有引用都保留为片段，缺图、越界或已确认图被替换时失败关闭', (): void => {
    const p = project(); const shot = p.plan!.shots[0]; shot.prompts.firstFrame.final = '@图片1定义甲；@图片1仍定义甲。';
    const refs = promptReferences(p, shot, 'firstFrame', undefined, true);
    shot.prompts.firstFrame.promptTask = { references: refs, dialect: 'seedream' };
    expect(compilePrompt(p, 'shot', 'firstFrame', undefined, true).segments!.filter((segment): boolean => 'referenceOrder' in segment)).toHaveLength(2);
    shot.prompts.firstFrame.final = '@图片3中的甲。';
    expect((): unknown => compilePrompt(p, 'shot', 'firstFrame', undefined, true)).toThrow('没有对应实际上传');
    shot.prompts.firstFrame.final = '@图片0中的甲。';
    expect((): unknown => compilePrompt(p, 'shot', 'firstFrame', undefined, true)).toThrow('没有对应实际上传');
    shot.prompts.firstFrame.final = '@图片1中的甲。'; p.assets.push({ ...p.assets[0], id: 'replacement' }); p.plan!.characters[0].referenceAssetId = 'replacement';
    expect((): unknown => compilePrompt(p, 'shot', 'firstFrame', undefined, true)).toThrow('素材或用途已变化');
  });
  it('计划首帧仅按原用途落到真实首帧，专用槽位在网页绑定时解析，不补写编辑要求', (): void => {
    const p = project(); const shot = p.plan!.shots[0]; const final = shot.prompts.lastFrame!.final;
    shot.prompts.lastFrame!.promptTask = { references: promptReferences(p, shot, 'lastFrame', undefined, true), dialect: 'seedream' };
    p.assets.push({ id: 'actual-first', kind: 'firstFrame', shotId: 'shot', relativePath: 'first.png',
      validation: { decoded: true, sha256: 'a'.repeat(64), bytes: 10, width: 64, height: 96, checkedAt: p.updatedAt },
      imageReview: { state: 'adopted', target: { shotId: 'shot', kind: 'firstFrame' }, basisHash: 'a'.repeat(64), adoptedAt: p.updatedAt, sha256: 'a'.repeat(64) } });
    p.production = { state: 'paused', planHash: 'TEST', approvedAt: '2026-10-26T00:00:00.000Z', capability: {} as NonNullable<PetStoryProject['production']>['capability'], fallbacks: {}, steps: [], message: 'TEST', shots: { shot: { requestedMode: 'reference', resolvedMode: 'reference', reason: 'TEST', firstFrameId: 'actual-first' } } };
    const edited = compilePrompt(p, 'shot', 'lastFrame', undefined, true); expect(edited.text).toBe(final);
    const video = shot.prompts.video; video.promptTask = { references: promptReferences(p, shot, 'video', 'first_frame', true), dialect: 'seedance20', mode: 'first_frame' };
    const compiled = compilePrompt(p, 'shot', 'video', 'first_frame', true);
    expect(bindReferenceText(compiled, [binding('actual-first', 1, '@图片1', 'first_frame')]).text).toBe('从首帧画面中的起点开始。');
    expect((): unknown => compilePrompt(p, 'shot', 'video', 'reference')).toThrow('目标视频模式与实际模式不同');
  });
  it('计划引用的用途或身份不允许被编号映射改写', (): void => {
    const p = project(); const refs = promptReferences(p, p.plan!.shots[0], 'firstFrame');
    const changedPurpose: PetStoryPromptReference[] = [{ ...refs[0], purpose: 'scene' }, refs[1]];
    expect((): unknown => compileReferencedText(p, '@图片1中的甲。', refs, changedPurpose)).toThrow('素材或用途已变化');
    const changedIdentity: PetStoryPromptReference[] = [{ ...refs[0], characterIds: ['actor-b'] }, refs[1]];
    expect((): unknown => compileReferencedText(p, '@图片1中的甲。', refs, changedIdentity)).toThrow('素材或用途已变化');
  });
  it('旧稿计划仍可预览，方言不匹配或缺合同手改不能借计划导出取得提交资格', (): void => {
    const p = project(); const shot = p.plan!.shots[0]; const video = shot.prompts.video;
    video.promptTask = { references: promptReferences(p, shot, 'video', 'reference', true), dialect: 'seedance20', mode: 'reference' };
    p.production = { state: 'paused', planHash: 'TEST', approvedAt: '2026-10-26T00:00:00.000Z', capability: { videoConfig: { model: 'seedance-2.5', duration: '5s', aspectRatio: '9:16' } } as NonNullable<PetStoryProject['production']>['capability'], fallbacks: {}, steps: [], message: 'TEST', shots: {} };
    expect(inspectPromptEligibility(p, video, { shotId: 'shot', promptKind: 'video', mode: 'reference' }).reasons.join('；')).toContain('方言与本次目标模型不同');
    video.promptTask.dialect = 'seedance25'; expect(compilePrompt(p, 'shot', 'video', 'reference', true).text).toBe(video.final);
    delete video.promptTask; video.edited = true; expect(compilePrompt(p, 'shot', 'video', 'reference', true).text).toBe(video.final);
    expect((): unknown => compilePrompt(p, 'shot', 'video', 'reference')).toThrow('缺少专用目标合同');
  });
  it('基础素材编辑正文不再自动追加引用、保持项或创作说明', (): void => {
    const p = project(); const final = '以@图片1为基图，把外套改为绿色，保留其余外观和构图。';
    const body = prompt(final); body.edited = true; body.editIntent = { baseAssetId: 'image-a', changes: '外套变绿', preserve: '身份', validity: 'TEST' };
    p.materials = [{ id: 'character:actor-a', kind: 'character', entityId: 'actor-a', name: '甲', designHash: 'TEST', selectedAssetId: 'image-a', prompt: body }];
    const compiled = compileMaterialPrompt(p, 'character:actor-a', true); expect(compiled.text).toBe(final);
    body.final = '把外套改为绿色，保留其余外观和构图。';
    expect(compileMaterialPrompt(p, 'character:actor-a', true).text).toBe(body.final);
  });
  it('旧手改逻辑引用继续解析，普通画面数字不作为引用；旧编译记录也只映射已存在的引用', (): void => {
    const p = project(); const shot = p.plan!.shots[0]; shot.prompts.firstFrame.final = '{{ref:actor-a}}中的甲看向{{ref:actor-b}}中的乙；墙上第 2 张画不变。';
    expect(compilePrompt(p, 'shot', 'firstFrame', undefined, true).text).toBe('第 1 张图中的甲看向第 2 张图中的乙；墙上第 2 张画不变。');
    const old: PetStoryCompiledPrompt = { final: 'TEST', text: '@图片1中的甲；墙上第 2 张画不变。', references: promptReferences(p, shot, 'firstFrame'), requestedMode: 'auto', kind: 'firstFrame', rulesVersion: 'TEST' };
    expect(bindReferenceText(old, [binding('image-a', 1, '@图片3'), binding('image-b', 2, '@图片8')]).text).toBe('@图片3中的甲；墙上第 2 张画不变。');
  });
});
