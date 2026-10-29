/** 离线机制验证：原五镜头输入派生夹具，模拟正文不作为业务验收输出。 */
import { describe, expect, it } from 'vitest';
import type { PetStoryCapability, PetStoryChatJob, PetStoryMaterial, PetStoryProject, PetStoryProduction, PetStoryShot } from '@doubao-studio/contracts';
import fixture from '../fixtures/drama-runtime-input.json';
import resources from '../../main/resources/drama/runtime.json';
import presets from '../../main/utils/petstoryPresets.json';
import { buildDramaRequest, dramaChatAssets } from '../../main/utils/petstoryRuntimeRequest';
import { storyHash, syncMaterials } from '../../main/utils/petstoryMaterials';
import { compileMaterialPrompt, compilePrompt } from '../../main/utils/petstoryPromptQuality';
import { validatePetStoryPlan } from '../../main/utils/petstoryValidation';
import { seedOfflinePromptContracts } from '../fixtures/petstoryPromptContracts';

function project(): PetStoryProject { return structuredClone(fixture) as PetStoryProject; }
function facts(prompt: string): Record<string, unknown> {
  const block = prompt.split('【当前事实与本次附件】\n')[1].split('\n\n【结果约定】')[0];
  const fenced = block.match(/^(`{3,})json\n([\s\S]*)\n\1$/);
  return JSON.parse(fenced?.[2] || block) as Record<string, unknown>;
}
function enriched(): PetStoryProject {
  const p = project();
  p.plan!.props = [{ id: 'branch', name: '细树枝', aliases: [], description: '源剧本细树枝', appearanceState: '静态', keyStates: 'TEST-PLOT-DO-NOT-USE-AS-VISIBLE-DESIGN', scale: '源剧本比例未指定', designOrigin: 'script' }];
  p.plan!.scenes = [{ id: 'road', name: '村道', location: '原剧本潮湿村道', time: '未指定', lighting: '待确认', layout: '原剧本路边与民居', view: '主场景', designOrigin: 'script' }];
  p.plan!.shots.forEach((shot: PetStoryShot): void => { shot.sceneId = 'road'; shot.propIds = ['branch']; shot.propStates = [{ propId: 'branch', holderId: shot.characterIds[0], state: 'TEST-process-only' }]; });
  p.materials = syncMaterials(p);
  return p;
}
/** 编译边界使用已收取采用的 Chat 数据夹具；不把本地摘要或 edited 标记冒充模型来源。 */
function adoptedMaterialReply(p: PetStoryProject, material: PetStoryMaterial, body: string): void {
  const jobId = 'TEST-adopted-' + material.id;
  p.jobs.push({ id: jobId, taskId: 'TEST-source-task-' + material.id, kind: 'materialPrompt', materialId: material.id,
    status: 'applied', resultStatus: 'adopted', inputHash: 'a'.repeat(64), sourceUrl: p.source.url, sourceStoryId: p.mobileStory?.id,
    rawText: JSON.stringify({ optimized: body }), parsedResult: { optimized: body } });
  material.prompt = { ...material.prompt, optimized: body, final: body, edited: false, sourceJobId: jobId, candidateJobId: jobId };
}
function withFrames(p: PetStoryProject): void {
  const validation = { decoded: true as const, sha256: 'TEST', bytes: 1, width: 10, height: 10, checkedAt: 'TEST' };
  p.assets.push({ id: 'TEST-first', kind: 'firstFrame', shotId: 'shot_2', relativePath: 'TEST/first.png', validation }, { id: 'TEST-last', kind: 'plannedEndImage', shotId: 'shot_2', relativePath: 'TEST/last.png', validation });
}
function production(model: NonNullable<PetStoryCapability['videoConfig']>['model']): PetStoryProduction {
  const cap: PetStoryCapability = { accountId: 'TEST-account', checkedAt: 'TEST', freeEvidence: 'unknown', durations: [], image: { state: 'unknown', free: 'unknown', reason: 'TEST' }, modes: { first_frame: { state: 'unknown', free: 'unknown', reason: 'TEST' }, first_last_frame: { state: 'unknown', free: 'unknown', reason: 'TEST' }, reference: { state: 'unknown', free: 'unknown', reason: 'TEST' } }, videoConfig: { model, duration: '6s', aspectRatio: '9:16' } };
  return { state: 'paused', planHash: 'TEST', approvedAt: 'TEST', capability: cap, fallbacks: {}, shots: {}, steps: [], message: 'TEST' };
}

describe('drama-skills 真实请求构造的离线边界', (): void => {
  it.each([false, true])('分析有旧plan=%s时都独立发送当前动态制作配置，来源原文和未确认旧设计不覆盖它', (hasPlan: boolean): void => {
    const p = project(); const identities = p.plan!.characters.map((item): string => item.description);
    p.promptProfile = { style: '', characters: { lulu: { identity: identities[0], appearance: '', aliases: ['A', '乐'], role: 'main' }, guest_role: { identity: identities[2], appearance: 'TEST用户配置的补充', aliases: ['C'], role: 'supporting' } } };
    if (!hasPlan) p.plan = undefined;
    else p.plan!.characters[0].description = 'TEST上次未确认的角色设计';
    p.assets = []; const before = structuredClone(p);
    const request = buildDramaRequest(p, { kind: 'analysis', requestId: 'TEST-cast-current' }); const data = facts(request.prompt);
    expect(data.productionCast).toMatchObject({ source: 'current_project_configuration', characters: p.promptProfile.characters, confirmedIdentities: [], actualIdentityImages: [] });
    expect(request.analysisCastBindings).toEqual({ lulu: { aliases: ['A', '乐'], role: 'main' }, guest_role: { aliases: ['C'], role: 'supporting' } });
    expect(data).not.toHaveProperty('characters'); expect(data.source).toMatchObject({ originalText: p.mobileStory!.text, originalPreserved: true });
    if (hasPlan) expect(data.currentPlanStatus).toMatchObject({ storyApproved: false, promptBodiesUsedAsIdentity: false });
    expect(request.prompt).toContain('由你在understanding及characters.aliases中明确落实来源人物');
    expect(request.prompt).toContain('来源人物的称谓与外观用于来源落实，不自动成为本项目制作演员的外观要求');
    expect(request.prompt).toContain('已保存的aliases是来源称谓到该演员的已知对应'); expect(request.prompt).toContain('未展示的前置动作只能标为推断，不写成已发生事实');
    expect(request.prompt).not.toContain('这是用户可编辑的默认主演配置；实际图片和明确文字优先'); expect(p).toEqual(before);
  });
  it('旧项目缺profile时投影当前plan全部角色原文，不注入默认物种或固定双主演', (): void => {
    const p = project(); delete p.promptProfile; p.assets = [];
    p.plan!.characters[0].description = 'TEST当前项目已保存的角色身份原文';
    const data = facts(buildDramaRequest(p, { kind: 'analysis', requestId: 'TEST-old-cast' }).prompt);
    expect(data.productionCast).toMatchObject({ source: 'saved_plan_characters', characters: p.plan!.characters });
    expect((data.productionCast as { characters: unknown[] }).characters).toHaveLength(p.plan!.characters.length);
  });
  it('无profile亦无plan才使用默认配置；显式空配置不暗中补默认角色', (): void => {
    const p = project(); delete p.promptProfile; p.plan = undefined; p.assets = [];
    expect(facts(buildDramaRequest(p, { kind: 'analysis', requestId: 'TEST-default-cast' }).prompt).productionCast).toMatchObject({ source: 'default_configuration', characters: presets.profile.characters });
    p.promptProfile = { style: '', characters: {} };
    expect(facts(buildDramaRequest(p, { kind: 'analysis', requestId: 'TEST-empty-config' }).prompt).productionCast).toMatchObject({ source: 'current_project_configuration', characters: {} });
  });
  it('analysis格式纠正仍携带当前制作配置与来源映射职责，不退回旧plan身份', (): void => {
    const p = project(); p.promptProfile = { style: '', characters: { custom_actor: { identity: p.plan!.characters[0].description, appearance: '' } } };
    const parent: PetStoryChatJob = { id: 'TEST-analysis-parent', taskId: 'TEST-original-task', kind: 'analysis', status: 'invalid', inputHash: 'a'.repeat(64), sourceUrl: p.source.url,
      requestId: 'TEST-original-request', requestText: 'TEST原分析请求', rawText: 'TEST结构错误原回复', validationIssues: ['TEST结构缺项'], analysisCastBindings: { custom_actor: { aliases: ['TEST父请求来源别名'], role: 'supporting' } } };
    const request = buildDramaRequest(p, { kind: 'repair', requestId: 'TEST-cast-repair', parentJob: parent });
    expect(request.stage).toBe('analysis+assets+storyboard'); expect(facts(request.prompt).productionCast).toMatchObject({ source: 'current_project_configuration', characters: p.promptProfile.characters });
    expect(request.prompt).toContain('【本次分析的来源人物与制作演员】'); expect(facts(request.prompt).parentResult).toMatchObject({ originalRequest: parent.requestText, originalReply: parent.rawText });
    expect(request.analysisCastBindings).toEqual(parent.analysisCastBindings);
    delete parent.analysisCastBindings;
    expect(buildDramaRequest(p, { kind: 'repair', requestId: 'TEST-legacy-cast-repair', parentJob: parent }).analysisCastBindings).toBeUndefined();
  });
  it.each(['missing', 'stale', 'approved'] as const)('完整分析及其纠正对%s剧本确认只保留获批故事，不携带旧推导答案', (approval): void => {
    const p = enriched(); p.assets = []; p.promptProfile = { style: '', characters: { current_actor: { identity: 'TEST当前选定演员资料', appearance: '' } } };
    Object.assign(p.plan!, { adaptedStory: 'TEST旧改编稿', sourceSummary: 'TEST旧方案摘要', understanding: 'TEST旧理解', sceneDesign: 'TEST旧空间设计' });
    p.plan!.characters[0].description = 'TEST旧未确认人物设计'; p.plan!.shots[0].action = 'TEST旧整组镜头答案';
    if (approval !== 'missing') p.storyApproval = { hash: approval === 'approved' ? storyHash(p) : 'a'.repeat(64), at: '2026-10-27T00:00:00.000Z' };
    const parent: PetStoryChatJob = { id: 'TEST-analysis-parent', taskId: 'TEST-analysis-original-task', kind: 'analysis', status: 'invalid', inputHash: 'a'.repeat(64), sourceUrl: p.source.url,
      requestText: 'TEST原请求保留\n{"old":"未确认旧内容"}', rawText: 'TEST原回复保留\n{"wrong":"待纠正内容"}', validationIssues: ['TEST缺少道具结构字段'] };
    const before = structuredClone(p);
    for (const kind of ['analysis', 'repair'] as const) {
      const request = buildDramaRequest(p, { kind, requestId: 'TEST-analysis-omits-' + kind, ...(kind === 'repair' ? { parentJob: parent } : {}) }); const data = facts(request.prompt);
      expect(data.source).toEqual({ originalText: p.mobileStory!.text, originalPreserved: true, ...(approval === 'approved' ? { adoptedStory: p.plan!.adaptedStory, storyApproved: true } : {}) });
      expect(data).not.toHaveProperty('currentPlan'); expect(data.currentPlanStatus).toMatchObject({ storyApproved: approval === 'approved', role: expect.stringContaining('已省略既有镜头与未确认设计') });
      expect(data.productionCast).toMatchObject({ characters: p.promptProfile.characters });
      for (const omitted of ['TEST旧方案摘要', 'TEST旧理解', 'TEST旧空间设计', 'TEST旧未确认人物设计', 'TEST旧整组镜头答案']) expect(request.prompt).not.toContain(omitted);
      if (approval !== 'approved') expect(request.prompt).not.toContain('TEST旧改编稿');
      if (kind === 'repair') {
        expect(data.parentResult).toMatchObject({ originalRequest: parent.requestText, originalReply: parent.rawText, rawForFormatRepairOnly: parent.rawText });
        expect(request.prompt).toContain('其原请求与原回复是待纠正材料，不是当前演员权威');
      }
    }
    expect(p).toEqual(before);
  });
  it.each(['assets', 'review', 'optimize', 'materialPrompt', 'revise'] as const)('%s及其纠正保留原有当前设计来源投影，完整分析精简不外溢', (kind): void => {
    const p = enriched(); const target = kind === 'materialPrompt' ? { materialId: 'prop:branch' }
      : kind === 'optimize' || kind === 'revise' ? { shotId: p.plan!.shots[0].id, promptKind: 'firstFrame' as const } : {};
    const expected = { originalText: p.mobileStory!.text, originalPreserved: true, adoptedStory: p.plan!.adaptedStory, sourceSummary: p.plan!.sourceSummary, understanding: p.plan!.understanding, sceneDesign: p.plan!.sceneDesign };
    const parent: PetStoryChatJob = { id: 'TEST-other-parent', taskId: 'TEST-other-task', kind, ...target, status: 'invalid', inputHash: 'a'.repeat(64), sourceUrl: p.source.url, rawText: 'TEST原回复' };
    for (const options of [{ kind, ...target }, { kind: 'repair' as const, ...target, parentJob: parent }]) {
      const data = facts(buildDramaRequest(p, { ...options, requestId: 'TEST-unchanged-' + kind }).prompt);
      expect(data.source).toEqual(JSON.parse(JSON.stringify(expected))); expect(data).not.toHaveProperty('productionCast');
      if (kind === 'assets' || kind === 'review') expect(data.currentPlan).toMatchObject({ characters: p.plan!.characters, props: p.plan!.props, scenes: p.plan!.scenes, shots: p.plan!.shots.map((shot): object => ({ id: shot.id, action: shot.action })) });
    }
  });
  it.each(['analysis', 'assets'] as const)('%s输出合同明确每个道具对应一条非空状态，静置道具不强塞持有人', (kind): void => {
    const request = buildDramaRequest(enriched(), { kind, requestId: 'TEST-prop-state-contract' });
    expect(request.prompt).toContain('propStates必须逐项且仅一次覆盖该镜propIds'); expect(request.prompt).toContain('state为非空的具体状态说明');
    expect(request.prompt).toContain('静置或无持有人时说明位置与状态并省略holderId'); expect(request.prompt).toContain('只有propIds为空时propStates才可为[]');
    expect(request.prompt).toContain('continuity不能替代此结构字段');
  });
  it('剧本确认不升级人物身份，当前配置以外的真实确认配角和实际看图仍独立约束', (): void => {
    const p = enriched(); p.promptProfile = { style: '', characters: { lulu: { identity: 'TEST当前可编辑演员配置', appearance: '' } } }; p.storyApproval = { hash: storyHash(p), at: '2026-10-27T00:00:00.000Z' };
    const material = p.materials!.find((item): boolean => item.id === 'character:friend')!; const asset = p.assets.find((item): boolean => item.id === material.selectedAssetId)!;
    asset.validation = { decoded: true, sha256: 'a'.repeat(64), bytes: 1, width: 64, height: 64, checkedAt: '2026-10-27T00:00:00.000Z' };
    material.approved = { assetId: asset.id, sha256: asset.validation.sha256, at: '2026-10-27T00:00:00.000Z', identity: { assetId: asset.id, description: 'TEST配角已确认身份原文' } };
    const data = facts(buildDramaRequest(p, { kind: 'analysis', requestId: 'TEST-confirmed-cast' }).prompt);
    expect(data.productionCast).toMatchObject({ characters: p.promptProfile.characters, confirmedIdentities: [{ id: 'friend', description: material.approved.identity!.description, assetId: asset.id, chatImage: expect.any(Number) }] });
    expect((data.productionCast as { actualIdentityImages: unknown[] }).actualIdentityImages).toHaveLength(3);
    expect(data.currentPlanStatus).toMatchObject({ storyApproved: true, identityApproval: expect.stringContaining('剧本确认不代表逐项人物身份') });
    delete material.approved;
    expect(facts(buildDramaRequest(p, { kind: 'analysis', requestId: 'TEST-story-not-identity' }).prompt).productionCast).toMatchObject({ confirmedIdentities: [] });
  });
  it.each(['selected', 'digest', 'identity-image', 'date'] as const)('失效%s确认不伪称当前身份批准，配置与实际附件仍可见', (change): void => {
    const p = enriched(); const material = p.materials!.find((item): boolean => item.id === 'character:lulu')!; const asset = p.assets.find((item): boolean => item.id === material.selectedAssetId)!;
    asset.validation = { decoded: true, sha256: 'a'.repeat(64), bytes: 1, width: 64, height: 64, checkedAt: '2026-10-27T00:00:00.000Z' };
    material.approved = { assetId: asset.id, sha256: asset.validation.sha256, at: '2026-10-27T00:00:00.000Z', identity: { assetId: asset.id, description: p.plan!.characters[0].description } };
    if (change === 'selected') material.selectedAssetId = 'TEST-different-selected';
    if (change === 'digest') asset.validation.sha256 = 'b'.repeat(64);
    if (change === 'identity-image') material.approved.identity!.assetId = 'TEST-other-image';
    if (change === 'date') material.approved.at = 'TEST-invalid-date';
    const data = facts(buildDramaRequest(p, { kind: 'analysis', requestId: 'TEST-expired-cast' }).prompt);
    expect(data.productionCast).toMatchObject({ confirmedIdentities: [] });
    expect((data.productionCast as { actualIdentityImages: unknown[] }).actualIdentityImages.length).toBeGreaterThan(0);
  });
  it('分析实际包含固定规则、原文和精确目标，而不是旧正文或路径', (): void => {
    const p = project(); const built = buildDramaRequest(p, { kind: 'analysis', requestId: 'TEST-analysis' });
    expect(built.expectedIds).toEqual(['plan']); expect(built.stage).toBe('analysis+assets+storyboard');
    expect(built.ruleFiles).toEqual([...new Set(['analysis', 'assets', 'storyboard'].flatMap((stage: string): string[] => resources.stages[stage as keyof typeof resources.stages].sources))]);
    const data = facts(built.prompt); expect(data.source).toEqual({ originalText: p.mobileStory!.text, originalPreserved: true });
    expect(built.prompt).not.toContain('TEST-old-body-not-fact'); expect(built.prompt).not.toMatch(/\/Users\//); expect(built.prompt.length).toBeLessThan(100_000);
    expect(built.assets.map((asset): string => asset.id)).toEqual(p.plan!.characters.map((character): string => character.referenceAssetId!));
  });
  it('首帧与尾帧状态各自隔离，视频保留动作过程和逐字台词', (): void => {
    const p = enriched(); const shot = p.plan!.shots[1]; shot.dialogue = [{ speakerId: 'lulu', text: 'TEST-逐字台词“引号”\n下一行', tone: 'TEST', pace: 'TEST' }];
    const build = (kind: 'firstFrame' | 'lastFrame' | 'video'): Record<string, unknown> => facts(buildDramaRequest(p, { kind: 'optimize', requestId: `TEST-${kind}`, shotId: shot.id, promptKind: kind }).prompt).shot as Record<string, unknown>;
    expect(build('firstFrame')).toMatchObject({ startState: shot.startState }); expect(build('firstFrame')).not.toHaveProperty('endState'); expect(build('firstFrame')).not.toHaveProperty('propStates');
    expect(build('lastFrame')).toMatchObject({ endState: shot.endState }); expect(build('lastFrame')).not.toHaveProperty('startState'); expect(build('lastFrame')).not.toHaveProperty('action');
    expect(build('video')).toMatchObject({ action: shot.action, dialogue: shot.dialogue, propStates: shot.propStates });
  });
  it('资产配方只加载本类型，设计不含剧情用途；上传也只选本项', (): void => {
    const p = enriched(); const material = p.materials!.find((m): boolean => m.id === 'prop:branch')!;
    const built = buildDramaRequest(p, { kind: 'materialPrompt', requestId: 'TEST-prop', materialId: material.id });
    expect(built.stage).toBe('imageProp'); expect(built.assets).toEqual([]); expect(facts(built.prompt).material).toMatchObject({ kind: 'prop', design: { description: p.plan!.props![0].description, appearanceState: '静态' } });
    expect(JSON.stringify(facts(built.prompt).material)).not.toContain('keyStates'); expect(built.ruleFiles).not.toContain('skills/short-drama-image-prompts/references/character-and-look.md');
    const char = p.materials!.find((m): boolean => m.kind === 'character')!;
    expect(dramaChatAssets(p, { kind: 'materialPrompt', requestId: 'TEST-char', materialId: char.id }).map((a): string => a.id)).toEqual([char.selectedAssetId]);
  });
  it('Chat 首尾图片实际独立编号并去重，不伪称已确认或媒体绑定', (): void => {
    const p = enriched(); withFrames(p);
    const built = buildDramaRequest(p, { kind: 'optimize', requestId: 'TEST-video', shotId: 'shot_2', promptKind: 'video' });
    expect(built.assets.slice(0, 2).map((a): string => a.id)).toEqual(['TEST-first', 'TEST-last']); expect(new Set(built.assets.map((a): string => a.id)).size).toBe(built.assets.length);
    const data = facts(built.prompt); expect(data.attachmentStatus).toMatchObject({ productionReady: false, hasActualImages: true, missingRequiredImage: true });
    expect((data.attachmentList as { chatImage: number; approved: boolean }[]).every((a, index): boolean => a.chatImage === index + 1 && !a.approved)).toBe(true);
  });
  it('正式所选首尾帧与Chat历史附件区分，未把历史图当本次编辑基图', (): void => {
    const p = enriched(); withFrames(p); p.production = production('seedance-2.0'); p.production.shots.shot_2 = { firstFrameId: 'TEST-first', plannedEndImageId: 'TEST-last', requestedMode: 'first_last_frame', resolvedMode: 'first_last_frame', reason: 'TEST明确选择' };
    for (const image of p.assets.filter((asset): boolean => ['TEST-first', 'TEST-last'].includes(asset.id))) image.imageReview = { state: 'adopted', target: { shotId: 'shot_2', kind: image.kind === 'firstFrame' ? 'firstFrame' : 'lastFrame' }, basisHash: 'TEST-explicit-reviewed', adoptedAt: '2026-10-29T00:00:00.000Z', sha256: image.validation?.sha256 };
    p.adoptedImages = { shot_2: { firstFrameId: 'TEST-first', plannedEndImageId: 'TEST-last' } };
    const data = facts(buildDramaRequest(p, { kind: 'optimize', requestId: 'TEST-selected-frames', shotId: 'shot_2', promptKind: 'video' }).prompt);
    expect(data.attachmentStatus).toMatchObject({ missingRequiredImage: false });
    expect(data.adoptedFrameText).toMatchObject({ firstFrame: { imageStatus: 'actual_selected_image_attached' } });
    expect((data.targetReferenceList as { assetId: string; status: string }[]).map((reference): string => reference.status)).toEqual(['available_unbound', 'available_unbound']);
  });
  it('缺首帧时是计划稿，不把角色图当已选择首帧', (): void => {
    const built = buildDramaRequest(enriched(), { kind: 'optimize', requestId: 'TEST-missing', shotId: 'shot_2', promptKind: 'lastFrame' });
    expect(facts(built.prompt).attachmentStatus).toMatchObject({ missingRequiredImage: true, productionReady: false });
  });
  it('模型未知仅一般规则，2.0与2.5的写法互斥', (): void => {
    const p = project(); const options = { kind: 'optimize' as const, requestId: 'TEST-model', shotId: 'shot_1', promptKind: 'video' as const };
    expect(buildDramaRequest(p, options).stage).toBe('video');
    p.production = production('seedance-2.0-fast'); expect(buildDramaRequest(p, options).stage).toBe('video+video20');
    p.production = production('seedance-2.5'); expect(buildDramaRequest(p, options).stage).toBe('video+video25');
  });
  it('目标Seedance标签来自媒体计划，独立于Chat图片顺序并允许缺图计划', (): void => {
    const p = enriched(); withFrames(p); p.promptCapability = production('seedance-2.0-fast').capability;
    const built = buildDramaRequest(p, { kind: 'optimize', requestId: 'TEST-target-labels', shotId: 'shot_2', promptKind: 'video' });
    expect(built.promptTask).toMatchObject({ dialect: 'seedance20', mode: 'first_last_frame' });
    expect(built.promptTask?.references.map((reference): string => reference.assetId)).toEqual(['pending:first', 'pending:last']);
    const data = facts(built.prompt);
    expect(data.targetGeneration).toMatchObject({ model: 'seedance-2.0-fast', mode: 'first_last_frame', bindingState: 'writing_plan_only_not_uploaded_or_bound' });
    expect(data.targetReferenceList).toMatchObject([{ targetLabel: '@图片1', slot: 'first', status: 'planned', bindingStatus: 'not_bound_for_this_generation' }, { targetLabel: '@图片2', slot: 'last', status: 'planned' }]);
    expect((data.attachmentList as object[]).slice(0, 2)).toMatchObject([{ chatImage: 1, version: 'TEST-first' }, { chatImage: 2, version: 'TEST-last' }]);
    expect(built.prompt).toContain('直接使用 targetLabel 的 @图片N');
    expect(built.prompt).toContain('{角色用中文说：“逐字台词”}');
    expect(built.prompt).toContain('@、图片和整数之间不得插入空格或换行');
    expect(built.prompt).toContain('包括环境底声、物件声与动作音效');
    expect(built.prompt).not.toContain('不输出固定图片N编号、裸@');
  });
  it('尾帧和视频带入真实采用首帧设计，首帧终态仅为防泄漏检查', (): void => {
    const p = enriched(); const shot = p.plan!.shots[1];
    shot.prompts.firstFrame.final = 'TEST-已采用首帧：一只前爪扶车把，另一只在身侧'; shot.prompts.firstFrame.sourceJobId = 'TEST-adopted';
    const end = facts(buildDramaRequest(p, { kind: 'optimize', requestId: 'TEST-end-state', shotId: shot.id, promptKind: 'lastFrame' }).prompt);
    expect(end.adoptedFrameText).toMatchObject({ firstFrame: { source: 'adopted_chat', promptText: shot.prompts.firstFrame.final, imageStatus: 'text_plan_only_no_image' } });
    expect(end.sharedShotState).toMatchObject({ startState: shot.startState, endState: shot.endState });
    const first = facts(buildDramaRequest(p, { kind: 'optimize', requestId: 'TEST-first-state', shotId: shot.id, promptKind: 'firstFrame' }).prompt);
    expect(first.sharedShotState).toMatchObject({ visibleAtThisFrame: { startState: shot.startState }, laterStateForAntiLeakCheckOnly: { endState: shot.endState } });
    expect(first).not.toHaveProperty('adoptedFrameText');
  });
  it('动态两镜首帧读取前镜已采用尾帧，继承持续状态而不提炼创作正文', (): void => {
    const p = enriched(); p.plan!.shots = p.plan!.shots.slice(1, 3);
    const [previous, current] = p.plan!.shots; previous.id = 'TEST-boundary-before'; previous.order = 1; current.id = 'TEST-boundary-now'; current.order = 2;
    current.previousShotId = previous.id; current.transition = 'continue';
    previous.prompts.lastFrame!.final = 'TEST-采用终点：双前爪仍握同一树枝'; previous.prompts.lastFrame!.sourceJobId = 'TEST-adopted-end'; previous.prompts.lastFrame!.optimized = 'TEST-未采用候选不得传入';
    const built = buildDramaRequest(p, { kind: 'optimize', requestId: 'TEST-boundary-two', shotId: current.id, promptKind: 'firstFrame' });
    const data = facts(built.prompt);
    expect(data.previousAdoptedBoundary).toMatchObject({ shotId: previous.id, relation: 'continue', boundarySource: 'explicit_previousShotId', promptKind: 'lastFrame', promptText: previous.prompts.lastFrame!.final, sourceJobId: 'TEST-adopted-end', needsReview: false, endState: previous.endState });
    expect(JSON.stringify(data.previousAdoptedBoundary)).not.toContain('TEST-未采用候选不得传入');
    expect(data.shot).not.toHaveProperty('endState');
    expect(built.prompt).toContain('不能将前镜动作或终态作为当前帧新要求');
  });
  it('动态三镜按当前排序带入前镜采用视频，cut仍保持续状态并显式标记待复核', (): void => {
    const p = enriched(); p.plan!.shots = p.plan!.shots.slice(0, 3);
    const [earlier, previous, current] = p.plan!.shots; earlier.id = 'TEST-alpha'; earlier.order = 4; previous.id = 'TEST-beta'; previous.order = 8; current.id = 'TEST-gamma'; current.order = 12;
    current.previousShotId = undefined; current.transition = 'cut';
    previous.prompts.video.final = 'TEST-用户采用的前镜视频终点上下文'; previous.prompts.video.edited = true; previous.prompts.video.needsReview = true;
    const data = facts(buildDramaRequest(p, { kind: 'optimize', requestId: 'TEST-boundary-three', shotId: current.id, promptKind: 'firstFrame' }).prompt);
    expect(data.previousAdoptedBoundary).toMatchObject({ shotId: previous.id, boundarySource: 'previous_in_current_order', relation: 'cut', promptKind: 'video', source: 'user_edited_final', promptText: previous.prompts.video.final, needsReview: true });
    expect((data.previousAdoptedBoundary as { policy: string }).policy).toContain('cut允许换机位和构图，也不能无解释重置持续状态');
    previous.prompts.video.edited = false;
    const noTrusted = facts(buildDramaRequest(p, { kind: 'optimize', requestId: 'TEST-boundary-untrusted', shotId: current.id, promptKind: 'firstFrame' }).prompt).previousAdoptedBoundary;
    expect(noTrusted).toMatchObject({ shotId: previous.id, bodyAvailable: false, source: 'no_trusted_adopted_body' });
    expect(noTrusted).not.toHaveProperty('promptText');
  });
  it('Seedream图片正文有独立目标计划，不机械套Seedance语法', (): void => {
    const built = buildDramaRequest(enriched(), { kind: 'optimize', requestId: 'TEST-image-dialect', shotId: 'shot_2', promptKind: 'firstFrame' });
    expect(built.promptTask?.dialect).toBe('seedream');
    const labels = facts(built.prompt).targetReferenceList as { targetLabel: string; status: string }[];
    expect(labels.length).toBeGreaterThan(0); expect(labels.every((reference): boolean => /^第\d+张参考图$/.test(reference.targetLabel))).toBe(true);
    expect(built.prompt).toContain('不要机械套用 Seedance 的 @图片N');
    expect(built.stage).toBe('firstFrame');
  });
  it('单次修订带入原请求、原回复与具体缺项，标签计划沿用原任务', (): void => {
    const p = enriched(); const parent: PetStoryChatJob = { id: 'TEST-parent-video', taskId: 'TEST-task', kind: 'optimize', status: 'invalid', shotId: 'shot_2', promptKind: 'video', inputHash: 'TEST', sourceUrl: '', requestText: 'TEST完整原请求', rawText: 'TEST完整原回复', validationIssues: ['TEST缺少@图片2'], promptTask: { dialect: 'seedance20', mode: 'first_last_frame', references: [{ assetId: 'pending:first', characterIds: [], purpose: 'firstFrame', order: 1 }, { assetId: 'pending:last', characterIds: [], purpose: 'plannedEndImage', order: 2 }] } };
    const built = buildDramaRequest(p, { kind: 'repair', requestId: 'TEST-repair-content', shotId: parent.shotId, promptKind: parent.promptKind, parentJob: parent });
    expect(built.promptTask).toEqual(parent.promptTask);
    expect(facts(built.prompt).parentResult).toMatchObject({ originalRequest: parent.requestText, originalReply: parent.rawText, validationIssues: parent.validationIssues });
    expect(built.prompt).toContain('重新返回该目标完整正文');
  });
  it('优化不注入错误旧正文，审查和定点修订保留原候选作为被检查数据', (): void => {
    const p = project(); const options = { requestId: 'TEST-review', shotId: 'shot_1', promptKind: 'video' as const };
    expect(buildDramaRequest(p, { ...options, kind: 'optimize' }).prompt).not.toContain('TEST-old-body-not-fact');
    const review = buildDramaRequest(p, { ...options, kind: 'review' }); expect(facts(review.prompt).actualCandidates).toMatchObject({ targetId: 'shot_1:video', final: 'TEST-old-body-not-fact' });
    expect(review.stage).toBe('review'); expect(review.expectedIds).toEqual(['shot_1:video']);
  });
  it('有限格式修正继承父目标和配方，完整原文无损进入待修数据', (): void => {
    const p = enriched(); const raw = JSON.stringify({ optimized: 'TEST-多段\n引号"长正文' }).slice(0, -1);
    const parent = { id: 'TEST-parent', taskId: 'TEST', kind: 'materialPrompt', status: 'invalid', materialId: 'prop:branch', rawText: raw, inputHash: 'TEST', sourceUrl: '' } satisfies PetStoryChatJob;
    const built = buildDramaRequest(p, { kind: 'repair', requestId: 'TEST-repair', materialId: parent.materialId, parentJob: parent });
    expect(built.stage).toBe('imageProp'); expect(built.expectedIds).toEqual(['prop:branch']); expect(facts(built.prompt).parentResult).toMatchObject({ rawForFormatRepairOnly: raw });
  });
  it('结构化事实与修订原文用足够长代码围栏无损展示，内容内围栏不能提前闭合', (): void => {
    const p = enriched();
    p.mobileStory!.text += '\nTEST-五个反引号：`````json\n{"正文":"原始中文、\\n、@图片1与<声音>"}\n`````';
    const parent: PetStoryChatJob = { id: 'TEST-fenced-parent', taskId: 'TEST-fenced-task', kind: 'optimize', status: 'invalid', shotId: 'shot_2', promptKind: 'video', inputHash: 'TEST', sourceUrl: '', requestText: 'TEST原请求：\n````````json\n{"nested":"双引号与\\反斜杠"}\n````````', rawText: 'TEST原回复：\n```json\n{"optimized":"原始正文\\n@图片1<声音>"}\n```', validationIssues: ['TEST具体缺项'] };
    const built = buildDramaRequest(p, { kind: 'repair', requestId: 'TEST-fenced-repair', shotId: parent.shotId, promptKind: parent.promptKind, parentJob: parent });
    const block = built.prompt.split('【当前事实与本次附件】\n')[1].split('\n\n【结果约定】')[0];
    expect(block.startsWith('`````````json\n')).toBe(true); expect(block.endsWith('\n`````````')).toBe(true);
    expect(facts(built.prompt).source).toMatchObject({ originalText: p.mobileStory!.text });
    expect(facts(built.prompt).parentResult).toMatchObject({ originalRequest: parent.requestText, originalReply: parent.rawText });
    expect(built.prompt).toContain('必须在单个合法的 json 代码块中完整返回 JSON 对象');
    expect(built.prompt).toContain('不以普通段落直接输出 JSON');
    expect(built.prompt).toContain('逐字核对targetReferenceList给出的连续标签');
  });
  it('不截断过长当前事实，不建立不完整请求', (): void => {
    const p = project(); p.mobileStory!.text = p.mobileStory!.text.repeat(100);
    expect((): unknown => buildDramaRequest(p, { kind: 'analysis', requestId: 'TEST-long' })).toThrow('未截断、未提交');
  });
  it('生产编译保留真实规则版本和唯一 final，过时设计阻止新生成但可计划预览', (): void => {
    const p = enriched(); const shot = p.plan!.shots[0]; shot.prompts.firstFrame.rulesVersion = resources.version;
    expect(compilePrompt(p, shot.id, 'firstFrame', undefined, true).rulesVersion).toBe(resources.version);
    const material = p.materials![0]; material.prompt.rulesVersion = resources.version; material.prompt.needsReview = true;
    adoptedMaterialReply(p, material, 'TEST已采用材料正文');
    seedOfflinePromptContracts(p, { materialId: material.id });
    expect((): unknown => compileMaterialPrompt(p, material.id)).toThrow('待复核'); expect(compileMaterialPrompt(p, material.id, true).rulesVersion).toBe(resources.version);
    shot.dialogue = [{ speakerId: 'lulu', text: 'TEST逐字原台词', tone: '', pace: '' }];
    p.promptModel = 'seedance-2.0'; seedOfflinePromptContracts(p, { shotId: shot.id, promptKind: 'video' });
    expect((): unknown => compilePrompt(p, shot.id, 'video', 'reference')).toThrow('遗漏已确认的原台词');
  });
  it('OS／VO保存真实说话者但不强迫入画、上传或冒充画内发声', (): void => {
    const p = project(); const shot = p.plan!.shots[0]; shot.characterIds = ['lulu'];
    shot.dialogue = [{ speakerId: 'friend', text: 'TEST-画外已有台词', tone: '', pace: '', delivery: 'voiceover' }];
    expect(validatePetStoryPlan(p.plan).shots[0].dialogue).toEqual(shot.dialogue);
    const built = buildDramaRequest(p, { kind: 'optimize', requestId: 'TEST-VO', shotId: shot.id, promptKind: 'video' });
    expect((facts(built.prompt).characters as { id: string }[]).map((c): string => c.id)).toEqual(['lulu', 'friend']);
    expect(built.assets.map((a): string | undefined => a.characterId)).toEqual(['lulu']);
    shot.dialogue[0].delivery = 'onscreen'; expect((): unknown => validatePetStoryPlan(p.plan)).toThrow('画内台词说话者必须出场');
  });
  it('普通素材重写读取当前选图，历史编辑基图只在本次显式编辑时使用', (): void => {
    const p = enriched(); const material = p.materials!.find((item): boolean => item.id === 'character:lulu')!;
    const oldId = material.selectedAssetId!;
    p.assets.push({ id: 'TEST-current-selected', kind: 'character', materialId: material.id, characterId: material.entityId, relativePath: 'TEST/current.png' });
    material.selectedAssetId = 'TEST-current-selected'; p.plan!.characters.find((character): boolean => character.id === material.entityId)!.referenceAssetId = material.selectedAssetId;
    material.prompt.editIntent = { baseAssetId: oldId, changes: 'TEST历史编辑变化', preserve: 'TEST历史保持', validity: 'TEST历史编辑范围' };
    const ordinary = buildDramaRequest(p, { kind: 'materialPrompt', requestId: 'TEST-current-material', materialId: material.id });
    expect(ordinary.assets.map((asset): string => asset.id)).toEqual(['TEST-current-selected']);
    expect(ordinary.promptTask?.references.map((reference): string => reference.assetId)).toEqual(['TEST-current-selected']);
    const explicit = buildDramaRequest(p, { kind: 'materialPrompt', requestId: 'TEST-explicit-old-base', materialId: material.id, editIntent: material.prompt.editIntent });
    expect(explicit.assets.map((asset): string => asset.id)).toEqual([oldId]);
    expect(explicit.promptTask?.references.map((reference): string => reference.assetId)).toEqual([oldId]);
    // 正常采用普通重写会清除旧编辑计划，后续编译与该请求的目标素材表一致。
    material.prompt.editIntent = undefined; material.prompt.promptTask = ordinary.promptTask;
    adoptedMaterialReply(p, material, 'TEST以第1张参考图为身份依据');
    expect(compileMaterialPrompt(p, material.id, true).references.map((reference): string => reference.assetId)).toEqual(['TEST-current-selected']);
  });
  it('场景编辑采用后的基图保持具体版本，编译不误换成父场景或漏传', (): void => {
    const p = enriched(); const material = p.materials!.find((m): boolean => m.kind === 'scene')!;
    p.assets.push({ id: 'TEST-base', kind: 'scene', materialId: material.id, relativePath: 'materials/TEST-base.png' }); material.selectedAssetId = 'TEST-base';
    material.prompt.editIntent = { baseAssetId: 'TEST-base', changes: 'TEST-只改指定位置', preserve: 'TEST-其余保持', validity: 'TEST-本镜候选' };
    adoptedMaterialReply(p, material, 'TEST以第1张参考图为基图，只编辑已确认区域。');
    const compiled = compileMaterialPrompt(p, material.id, true);
    expect(compiled.references).toEqual([{ assetId: 'TEST-base', materialId: material.id, entityId: material.entityId, purpose: 'scene', characterIds: [], order: 1 }]);
    material.prompt.editIntent.baseAssetId = 'TEST-missing'; expect((): unknown => compileMaterialPrompt(p, material.id, true)).toThrow('对应实际基图');
  });
});
