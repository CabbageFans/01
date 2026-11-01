/** 从用户原故事项目派生的离线边界验证；彩色文件仅测采用与指纹，不代表豆包输出或视觉验收。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PetStoryPlan, PetStoryProject } from '@doubao-studio/contracts';
import snapshot from '../fixtures/storyboard-five-shots.json';
import legacyDefaults from '../../main/utils/petstoryLegacyDefaults.json';
import { legacyProductionPlanHash, productionPlanHash } from '../../main/utils/petstoryProduction';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { mediaCommand } from '../../main/utils/petstoryMedia';
import { approvedMaterialHash, legacyApprovedMaterialHash, characterVisualBasis, confirmedCharacterIdentity, materialAsset, materialDigest, requireMaterialInventory, requireMaterialPromptSource, syncMaterials } from '../../main/utils/petstoryMaterials';
import { compileImageFeedback, imageTargetBasis, selectedShotImageId } from '../../main/utils/petstoryImageReview';
import { inspectPromptEligibility, promptDesignHash } from '../../main/utils/petstoryEligibility';
import { boundaryStillCurrent } from '../../main/utils/petstoryChat';
import { seedOfflinePromptContracts } from '../fixtures/petstoryPromptContracts';

let root: string; let firstImage: string; let secondImage: string;
beforeAll(async (): Promise<void> => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-reference-adoption-'));
  firstImage = path.join(root, 'first.png'); secondImage = path.join(root, 'second.png');
  for (const [color, file] of [['red', firstImage], ['blue', secondImage]]) await mediaCommand('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=64x96`, '-frames:v', '1', '-y', file]);
});
afterAll(async (): Promise<void> => { await fs.rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<{ projects: PetStoryProjects; p: PetStoryProject; characterId: string; materialId: string }> {
  const projects = new PetStoryProjects(); const directory = await fs.mkdtemp(path.join(root, 'project-'));
  let p = await projects.create(directory, 'TEST-studio', 'TEST-account');
  p = await projects.saveOriginalStory(p.id, p.revision, snapshot.mobileStory);
  p.plan = structuredClone(snapshot.plan) as PetStoryPlan;
  // 仅补充旧夹具缺失的资产结构；地点直接取原镜头，剧情、台词与原角色不改写。
  p.plan.props = [];
  p.plan.scenes = [{ id: 'original-scene', name: p.plan.shots[0].scene, location: p.plan.shots[0].scene, time: '原镜头时间', lighting: '原镜头光线', layout: '原镜头空间', view: '原镜头视角', designOrigin: 'script' }];
  for (const shot of p.plan.shots) { shot.propIds = []; shot.sceneId = 'original-scene'; }
  p = await projects.write(p); p = await projects.confirmStory(p.id, p.revision);
  const characterId = p.plan!.characters[0].id;
  return { projects, p, characterId, materialId: `character:${characterId}` };
}
async function uploadAndAdopt(projects: PetStoryProjects, p: PetStoryProject, materialId: string, file: string): Promise<PetStoryProject> {
  p = await projects.addMaterialImage(p.id, p.revision, materialId, file);
  return projects.adoptImage(p.id, p.revision, { materialId }, p.assets.at(-1)!.id);
}

describe('角色采用图替代基础图文字', (): void => {
  it('没有基础图正文或来源任务，直接上传采用即就绪；重开、同步和旧描述变化不恢复文字或撤销图', async (): Promise<void> => {
    const f = await fixture(); let p = await uploadAndAdopt(f.projects, f.p, f.materialId, firstImage);
    const selected = materialAsset(p, f.materialId); const original = p.materials!.find((item): boolean => item.id === f.materialId)!;
    expect(original.prompt.final).toBe(''); expect(original.prompt.sourceJobId).toBeUndefined(); expect(p.jobs).toEqual([]);
    expect(original.visualBasis).toMatchObject({ assetId: selected.id, sha256: selected.validation!.sha256 });
    expect(original.approved?.identity).toEqual({ assetId: selected.id });
    expect(confirmedCharacterIdentity(p, f.characterId)).toEqual({ assetId: selected.id });
    p.plan!.characters[0].description = 'TEST 旧文字发生变化，不能覆盖采用图';
    p.materials = syncMaterials(p); p = await f.projects.write(p); p = await f.projects.open(f.projects.directory(p.id));
    const current = p.materials!.find((item): boolean => item.id === f.materialId)!;
    expect(current.prompt.final).toBe(''); expect(current.prompt.supersededByAssetId).toBe(selected.id);
    expect(materialAsset(p, f.materialId).id).toBe(selected.id); expect(p.jobs).toEqual([]);
    expect((): unknown => requireMaterialPromptSource(p, f.materialId)).toThrow('采用图');
  });
  it('仅上传预览不动当前依据；采用时旧正文、候选与来源保留历史且退出有效使用', async (): Promise<void> => {
    const f = await fixture(); let p = f.p;
    const old = p.materials!.find((item): boolean => item.id === f.materialId)!;
    old.prompt.final = 'TEST 旧真人黑衣马尾外观'; old.prompt.optimized = 'TEST 旧基础图候选'; old.prompt.sourceJobId = 'TEST-old-adopted';
    p.jobs.push({ id: 'TEST-old-adopted', taskId: 'TEST-old-task', inputHash: 'a'.repeat(64), kind: 'materialPrompt', status: 'applied', resultStatus: 'adopted', materialId: f.materialId, sourceUrl: '', rawText: 'TEST 原回复原样保存' },
      { id: 'TEST-late', taskId: 'TEST-late-task', inputHash: 'b'.repeat(64), kind: 'materialPrompt', status: 'bound', materialId: f.materialId, sourceUrl: '' });
    p = await f.projects.write(p); p = await f.projects.addMaterialImage(p.id, p.revision, f.materialId, firstImage);
    expect(p.materials!.find((item): boolean => item.id === f.materialId)?.prompt).toEqual(old.prompt);
    p = await f.projects.adoptImage(p.id, p.revision, { materialId: f.materialId }, p.assets.at(-1)!.id);
    const adopted = p.materials!.find((item): boolean => item.id === f.materialId)!;
    expect(adopted.prompt).toMatchObject({ final: old.prompt.final, optimized: old.prompt.optimized, sourceJobId: old.prompt.sourceJobId, supersededByAssetId: adopted.selectedAssetId });
    expect(p.jobs[0]).toMatchObject({ resultStatus: 'adopted', rawText: 'TEST 原回复原样保存' });
    expect(p.jobs[1]).toMatchObject({ status: 'bound', resultStatus: 'stale' });
    expect(adopted.approved?.identity?.description).toBeUndefined();
    const before = structuredClone(adopted); p = await f.projects.addMaterialImage(p.id, p.revision, f.materialId, secondImage);
    expect(p.materials!.find((item): boolean => item.id === f.materialId)).toEqual(before);
    expect(p.plan!.characters[0].referenceAssetId).toBe(adopted.selectedAssetId);
  });
  it('图片反馈以所选未采用候选和原意见为准，不发送旧人物设计或历史基础正文', async (): Promise<void> => {
    const f = await fixture(); const p = await f.projects.addMaterialImage(f.p.id, f.p.revision, f.materialId, firstImage);
    const base = p.assets.at(-1)!; const feedback = '保留当前形象，把手抬起并微笑。';
    const compiled = compileImageFeedback(p, { id: 'TEST-op', requestId: 'TEST-request', target: { materialId: f.materialId }, mode: 'modify', stage: 'generating', basisHash: imageTargetBasis(p, { materialId: f.materialId }), baseAssetId: base.id, baseSha256: base.validation!.sha256, feedback, createdAt: p.updatedAt });
    expect(compiled.final).toContain(feedback); expect(compiled.final).not.toContain(p.plan!.characters[0].description);
    expect(compiled.references).toMatchObject([{ assetId: base.id, purpose: 'identity', characterIds: [f.characterId] }]);
  });
  it('换图仅使出现该角色和实际连续后镜的旧帧退出新任务，文件及无关镜头保持', async (): Promise<void> => {
    const f = await fixture(); let p = await uploadAndAdopt(f.projects, f.p, f.materialId, firstImage);
    const affected = p.plan!.shots.find((shot): boolean => shot.characterIds.includes(f.characterId))!;
    const unrelated = p.plan!.shots.find((shot): boolean => !shot.characterIds.includes(f.characterId) && shot.transition === 'cut')!;
    const frames: Record<string, string> = {};
    for (const shot of [affected, unrelated]) {
      p = await f.projects.addShotImage(p.id, p.revision, shot.id, 'firstFrame', firstImage);
      const asset = p.assets.at(-1)!; p = await f.projects.adoptImage(p.id, p.revision, { shotId: shot.id, kind: 'firstFrame' }, asset.id); frames[shot.id] = asset.id;
    }
    p = await uploadAndAdopt(f.projects, p, f.materialId, secondImage);
    expect(selectedShotImageId(p, affected.id, 'firstFrame')).toBeUndefined();
    expect(selectedShotImageId(p, unrelated.id, 'firstFrame')).toBe(frames[unrelated.id]);
    const old = p.assets.find((asset): boolean => asset.id === frames[affected.id])!;
    expect(old).toMatchObject({ visualBasisStale: true, imageReview: { state: 'adopted' } });
    expect(await f.projects.referenceFile(p.id, old.id)).toBe(path.join(f.projects.directory(p.id), old.relativePath));
    await expect(f.projects.adoptImage(p.id, p.revision, { shotId: affected.id, kind: 'firstFrame' }, old.id)).rejects.toThrow('旧帧');
    p = await f.projects.open(f.projects.directory(p.id)); expect(selectedShotImageId(p, affected.id, 'firstFrame')).toBeUndefined();
  });
  it('采用图后镜头设计hash不读取旧外观；实际换图有新的指纹且旧视频合同不能绕过', async (): Promise<void> => {
    const f = await fixture(); let p = await uploadAndAdopt(f.projects, f.p, f.materialId, firstImage);
    const shot = p.plan!.shots.find((item): boolean => item.characterIds.includes(f.characterId))!;
    const target = { shotId: shot.id, promptKind: 'video' as const, mode: 'reference' as const, model: 'seedance-2.0' };
    shot.requestedMode = 'reference'; p.promptModel = 'seedance-2.0';
    const hash = promptDesignHash(p, target); const basis = characterVisualBasis(p, shot.id);
    p.plan!.characters[0].description = 'TEST 被替代的旧外观'; p.plan!.shots.find((item): boolean => item.id === shot.id)!.appearanceOverrides = { [f.characterId]: 'TEST 旧造型覆盖' };
    p.materials = syncMaterials(p); expect(promptDesignHash(p, target)).toBe(hash);
    seedOfflinePromptContracts(p, target, { completeVideoBody: true });
    const prompt = p.plan!.shots.find((item): boolean => item.id === shot.id)!.prompts.video;
    expect(prompt.promptTask?.characterVisualBasis).toEqual(basis);
    p = await f.projects.write(p); p = await uploadAndAdopt(f.projects, p, f.materialId, secondImage);
    expect(characterVisualBasis(p, shot.id)).not.toEqual(basis); expect(promptDesignHash(p, target)).not.toBe(hash);
    // 老规则正文没有视觉写作声明，即使 current 视频分支原先放行设计差异也必须正常修订。
    const oldPrompt = p.plan!.shots.find((item): boolean => item.id === shot.id)!.prompts.video;
    delete oldPrompt.promptTask!.visualPolicy;
    const check = inspectPromptEligibility(p, oldPrompt, target, 'current');
    expect(check.writingReady).toBe(false); expect(check.reasons.join('；')).toContain('角色图已更新');
  });
  it('新规则纯动作正文在素材职责不变时仅重绑引用，原任务与合同不改写；旧请求晚到仍过期', async (): Promise<void> => {
    const f = await fixture(); let p = await uploadAndAdopt(f.projects, f.p, f.materialId, firstImage);
    const shot = p.plan!.shots.find((item): boolean => item.characterIds.includes(f.characterId))!;
    shot.requestedMode = 'reference'; p.promptModel = 'seedance-2.0';
    shot.prompts.video.final = `TEST 离线纯表演正文：${shot.action}。眉头收紧，转头看向同伴，然后后退一步；固定机位轻推，动作结束后停稳。`;
    seedOfflinePromptContracts(p, { shotId: shot.id, promptKind: 'video' }, { completeVideoBody: true });
    const source = p.jobs.find((job): boolean => job.id === (shot.prompts.video.sourceJobId || shot.prompts.video.basisJobId))!;
    const originalSource = structuredClone(source); const originalBody = shot.prompts.video.final;
    p = await f.projects.write(p); p = await uploadAndAdopt(f.projects, p, f.materialId, secondImage);
    const current = p.plan!.shots.find((item): boolean => item.id === shot.id)!.prompts.video;
    const target = { shotId: shot.id, promptKind: 'video' as const, mode: 'reference' as const, model: 'seedance-2.0' };
    const result = inspectPromptEligibility(p, current, target, 'current');
    expect(result.writingReady, result.reasons.join('；')).toBe(true);
    expect(current.final).toBe(originalBody); expect(current.needsReview).toBeUndefined();
    expect(p.jobs.find((job): boolean => job.id === source.id)).toEqual(originalSource);
    // 同一原请求作为未采用候选晚到时仍不能跨真实换图自动采用。
    expect(inspectPromptEligibility(p, current, target, 'candidate').writingReady).toBe(false);
  });

  it('旧原样默认风格退出不取消图片或要求再次确认剧本，旧hash和任务历史原样保留', async (): Promise<void> => {
    const f = await fixture(); let p = f.p;
    p.promptProfile = { style: '', characters: {}, assetStyles: { common: legacyDefaults.commonStyle } };
    for (const material of p.materials!) {
      const character = p.plan!.characters.find((item): boolean => item.id === material.entityId);
      const design = material.kind === 'character' ? { description: character!.description } : p.plan!.scenes!.find((item): boolean => item.id === material.entityId);
      material.designHash = materialDigest({ design, style: legacyDefaults.commonStyle });
    }
    p = await f.projects.write(p);
    for (const material of p.materials!) p = await uploadAndAdopt(f.projects, p, material.id, firstImage);
    const prior = structuredClone(p.materials); const approval = structuredClone(p.storyApproval);
    expect((): void => requireMaterialInventory(p)).not.toThrow();
    p.materials = syncMaterials(p); p = await f.projects.write(p); p = await f.projects.open(f.projects.directory(p.id));
    expect(p.materials!.map((item): string => item.designHash)).toEqual(prior!.map((item): string => item.designHash));
    expect(p.materials!.map((item): unknown => item.approved)).toEqual(prior!.map((item): unknown => item.approved));
    expect(p.storyApproval).toEqual(approval); expect(p.jobs).toEqual([]);
    for (const material of p.materials!) expect(materialAsset(p, material.id).id).toBe(material.selectedAssetId);
  });

  it('换图前镜进入旧视觉复核时，无该角色的cut镜头首尾正文仍有效，真实终态或持物正文变化继续阻断', async (): Promise<void> => {
    const f = await fixture(); let p = f.p;
    for (const material of p.materials!) p = await uploadAndAdopt(f.projects, p, material.id, firstImage);
    seedOfflinePromptContracts(p, undefined, { completeVideoBody: true });
    const next = p.plan!.shots.find((shot): boolean => shot.transition === 'cut' && !shot.characterIds.includes(f.characterId))!;
    const previous = p.plan!.shots.filter((shot): boolean => shot.order < next.order).sort((a, b): number => b.order - a.order)[0];
    // 派生旧规则前镜，正文及原任务完整保留；本例只改变角色视觉依据。
    for (const prompt of Object.values(previous.prompts)) if (prompt) delete prompt.promptTask?.visualPolicy;
    p = await f.projects.write(p);
    const targets = (['firstFrame', 'lastFrame'] as const).map((kind): { shotId: string; promptKind: typeof kind } => ({ shotId: next.id, promptKind: kind }));
    for (const target of targets) { const ready = inspectPromptEligibility(p, p.plan!.shots.find((shot): boolean => shot.id === next.id)!.prompts[target.promptKind]!, target, 'current'); expect(ready.writingReady, ready.reasons.join('；')).toBe(true); }
    p = await uploadAndAdopt(f.projects, p, f.materialId, secondImage);
    const currentNext = p.plan!.shots.find((shot): boolean => shot.id === next.id)!;
    const currentPrevious = p.plan!.shots.find((shot): boolean => shot.id === previous.id)!;
    expect(currentPrevious.prompts.lastFrame?.visualBasisStale).toBe(true);
    for (const target of targets) {
      const prompt = currentNext.prompts[target.promptKind]!;
      const source = p.jobs.find((job): boolean => job.id === (prompt.sourceJobId || prompt.basisJobId))!;
      const qualification = inspectPromptEligibility(p, prompt, target, 'current');
      expect(qualification.writingReady, qualification.reasons.join('；')).toBe(true);
      expect(boundaryStillCurrent(p, source)).toBe(true);
    }
    const target = targets[0]; const prompt = currentNext.prompts.firstFrame;
    currentPrevious.endState += 'TEST真实持物归属已变化';
    expect(inspectPromptEligibility(p, prompt, target, 'current').writingReady).toBe(false);
    currentPrevious.endState = previous.endState;
    currentPrevious.prompts.lastFrame!.final += 'TEST实际采用终态正文发生变化';
    expect(inspectPromptEligibility(p, prompt, target, 'current').writingReady).toBe(false);
  });

  it('当前制作摘要只读取采用图与剧情；旧外观变化不影响同图授权，真实换图和剧情变化仍影响', async (): Promise<void> => {
    const f = await fixture(); let p = await uploadAndAdopt(f.projects, f.p, f.materialId, firstImage);
    const planHash = productionPlanHash(p.plan!); const materialsHash = approvedMaterialHash(p);
    const legacyPlan = legacyProductionPlanHash(p.plan!); const legacyMaterials = legacyApprovedMaterialHash(p);
    p.plan!.characters[0].description = 'TEST历史真人外观修改'; p.plan!.characters[0].continuity = 'TEST历史服饰设定修改';
    p.plan!.shots[0].appearanceOverrides = { [f.characterId]: 'TEST已被图片替代的外观覆盖' };
    p.materials = syncMaterials(p);
    const material = p.materials!.find((item): boolean => item.id === f.materialId)!;
    material.approved!.identity = { assetId: material.selectedAssetId!, description: 'TEST旧文字身份修改' };
    expect(productionPlanHash(p.plan!)).toBe(planHash); expect(approvedMaterialHash(p)).toBe(materialsHash);
    expect(legacyProductionPlanHash(p.plan!)).not.toBe(legacyPlan); expect(legacyApprovedMaterialHash(p)).not.toBe(legacyMaterials);
    p.plan!.characters[0].purpose += 'TEST剧情职责真实改变';
    expect(productionPlanHash(p.plan!)).not.toBe(planHash); p.plan!.characters[0].purpose = f.p.plan!.characters[0].purpose;
    p.plan!.shots[0].dialogue = [{ speakerId: f.characterId, text: 'TEST真实新台词', tone: 'TEST', pace: 'TEST' }];
    expect(productionPlanHash(p.plan!)).not.toBe(planHash); p.plan!.shots[0].dialogue = structuredClone(f.p.plan!.shots[0].dialogue);
    p = await f.projects.write(p); p = await uploadAndAdopt(f.projects, p, f.materialId, secondImage);
    expect(productionPlanHash(p.plan!)).not.toBe(planHash); expect(approvedMaterialHash(p)).not.toBe(materialsHash);
  });

});
