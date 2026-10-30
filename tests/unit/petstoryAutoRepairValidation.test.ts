/** 原用户五镜头的离线故障派生，不是本轮豆包真实新创作。 */
import { describe, expect, it } from 'vitest';
import type { PetStoryChatJob, PetStoryPlan, PetStoryProject, PetStoryMaterial } from '@doubao-studio/contracts';
import snapshot from '../fixtures/storyboard-five-shots.json';
import { collectPetStoryPlanIssues, formatPetStoryValidationIssue, PetStoryContentValidationError, planRepairPreservationIssues, validatePetStoryPlan } from '../../main/utils/petstoryValidation';
import { buildDramaRequest } from '../../main/utils/petstoryRuntimeRequest';
import { storyHash, syncMaterials } from '../../main/utils/petstoryMaterials';

function plan(): PetStoryPlan { return structuredClone(snapshot.plan) as PetStoryPlan; }
function project(): PetStoryProject {
  const p: PetStoryProject = { schemaVersion: 1, id: 'TEST-auto-repair', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-story', text: snapshot.mobileStory, importedAt: '2026-10-30T01:00:00.000Z' },
    plan: plan(), jobs: [], assets: [], drafts: [], updatedAt: '2026-10-30T01:00:00.000Z' };
  p.materials = syncMaterials(p); p.promptModel = 'seedance-2.0'; return p;
}
function parent(p: PetStoryProject, kind: PetStoryChatJob['kind'] = 'analysis'): PetStoryChatJob {
  return { id: 'TEST-original', taskId: 'TEST-task', kind, status: 'invalid', requestId: 'TEST-old-request', inputHash: 'TEST-hash', sourceUrl: '', sourceStoryId: p.mobileStory!.id,
    expectedIds: ['plan'], requestText: 'TEST原请求完整目标与必要约束', rawText: JSON.stringify(p.plan), validationDetails: [], validationIssues: [] };
}

describe('原五镜头的完整内容问题与最小修订范围', (): void => {
  it('合格回复无问题且不修改任何原值', (): void => {
    const original = plan(); const saved = structuredClone(original);
    expect(collectPetStoryPlanIssues(original)).toEqual([]); expect(validatePetStoryPlan(original).shots).toHaveLength(5); expect(original).toEqual(saved);
  });
  it.each([4, 11, '7', null, undefined, NaN, Infinity, 7.5])('准确保留异常时长值和类型 %s，禁止截断或容错转数字', (value: unknown): void => {
    const original = plan(); const input = { ...original, shots: original.shots.map((shot, index): object => index === 0 ? { ...shot, durationSeconds: value } : shot) };
    const details = collectPetStoryPlanIssues(input); const duration = details.find((issue): boolean => issue.path === '$.shots[0].durationSeconds');
    expect(duration).toMatchObject({ code: 'duration', actual: value, repairable: true, expected: expect.stringContaining('整秒') });
    expect(duration?.actualType).toBe(value === null ? 'null' : typeof value);
    expect((): PetStoryPlan => validatePetStoryPlan(input)).toThrow(PetStoryContentValidationError);
    expect((input.shots[0] as { durationSeconds: unknown }).durationSeconds).toBe(value);
    expect(formatPetStoryValidationIssue(duration!)).toContain('$.shots[0].durationSeconds');
  });
  it('历史小数可原值只读，新生成与保存仍严格拒绝；历史越界及字符串不被放行', (): void => {
    const original = plan(); original.shots[0].durationSeconds = 7.5;
    expect(validatePetStoryPlan(original, false, true).shots[0].durationSeconds).toBe(7.5);
    expect((): PetStoryPlan => validatePetStoryPlan(original)).toThrow('整秒');
    for (const value of [3, '7', null]) {
      const input = { ...original, shots: original.shots.map((shot, index): object => index === 0 ? { ...shot, durationSeconds: value } : shot) };
      expect((): PetStoryPlan => validatePetStoryPlan(input, false, true)).toThrow('5～10');
    }
  });
  it('一次给出多镜时长、缺字段、未知引用和字段类型问题', (): void => {
    const original = plan();
    const input = { ...original, shots: original.shots.map((shot, index): object => index === 0 ? { ...shot, durationSeconds: '7', action: undefined, characterIds: ['TEST-unknown'] } : index === 1 ? { ...shot, durationSeconds: null, camera: {} } : shot) };
    const issues = collectPetStoryPlanIssues(input);
    expect(issues.map((issue): string => issue.path)).toEqual(expect.arrayContaining(['$.shots[0].durationSeconds', '$.shots[0].action', '$.shots[0].characterIds[0]', '$.shots[1].durationSeconds', '$.shots[1].camera']));
    expect((): PetStoryPlan => validatePetStoryPlan(input)).toThrow('未知角色');
  });
  it('允许合法时长及该镜节奏修订，拒绝无关剧情、人物、镜头顺序和台词漂移', (): void => {
    const original = plan(); original.shots[0].dialogue = [{ speakerId: 'lumei', text: '乐，你尝尝……', tone: '', pace: '' }]; const invalid = { ...structuredClone(original), shots: original.shots.map((shot, index): object => index === 0 ? { ...shot, durationSeconds: 4 } : shot) };
    const issues = collectPetStoryPlanIssues(invalid);
    const revised = structuredClone(original); revised.shots[0].durationSeconds = 8; revised.shots[0].timing = 'TEST仅时长相关节奏说明';
    expect(planRepairPreservationIssues(invalid, revised, issues)).toEqual([]);
    revised.characters[0].description += 'TEST无关更改'; revised.shots[1].action += 'TEST无关更改'; revised.shots.reverse();
    const changes = planRepairPreservationIssues(invalid, revised, issues);
    expect(changes.join('\n')).toContain('characters[0].description'); expect(changes.join('\n')).toContain('.action'); expect(changes.join('\n')).toContain('.id');
    const dialogue = structuredClone(original); dialogue.shots[0].dialogue = [{ speakerId: 'lulu', text: 'TEST意外替换原台词', tone: '', pace: '' }];
    expect(planRepairPreservationIssues(invalid, dialogue, issues).join('\n')).toContain('.dialogue');
  });
  it('无损可选字段补空与明确cut冗余绑定清理不误判为剧情漂移', (): void => {
    const original = plan(); original.shots[0].dialogue = [{ speakerId: 'lumei', text: '乐，你尝尝……', tone: '', pace: '' }];
    original.shots[1].transition = 'cut'; delete original.shots[1].previousShotId;
    const raw: Record<string, unknown> = structuredClone(original) as unknown as Record<string, unknown>;
    const shots = raw.shots as Record<string, unknown>[];
    (shots[0].dialogue as Record<string, unknown>[])[0] = { speakerId: 'lumei', text: '乐，你尝尝……' };
    shots[1].transition = 'cut'; shots[1].previousShotId = original.shots[0].id;
    expect(planRepairPreservationIssues(raw, original, [])).toEqual([]);
    const changed = structuredClone(original); changed.shots[2].action += 'TEST无关更改';
    expect(planRepairPreservationIssues(raw, changed, [{ code: 'structure', path: '$', actualType: 'object', expected: '有效结构', message: 'TEST其它结构错误', repairable: true }]).join('\n')).toContain('.action');
  });
});

describe('修订请求完整上下文与原创作职责', (): void => {
  it('原文、多项具体问题、新合同和原五镜头原台词同时进入实际待发送prompt', (): void => {
    const p = project(); p.plan!.shots[0].dialogue = [{ speakerId: 'lumei', text: '乐，你尝尝……', tone: '', pace: '' }]; const original = parent(p);
    const broken = { ...p.plan!, shots: p.plan!.shots.map((shot, index): object => ({ ...shot, ...(index < 2 ? { durationSeconds: index ? '6' : 3 } : {}) })) };
    original.rawText = JSON.stringify(broken); original.validationDetails = collectPetStoryPlanIssues(broken); original.validationIssues = original.validationDetails.map(formatPetStoryValidationIssue); p.jobs.push(original);
    const request = buildDramaRequest(p, { kind: 'repair', requestId: 'TEST-new-request', parentJob: original });
    expect(request.stage).toBe('analysis+assets+storyboard'); expect(request.expectedIds).toEqual(['plan']); expect(request.assets).toEqual([]);
    expect(request.prompt).toContain('TEST-new-request'); expect(request.prompt).toContain('TEST原请求完整目标与必要约束');
    expect(request.prompt).toContain('$.shots[0].durationSeconds'); expect(request.prompt).toContain('$.shots[1].durationSeconds');
    expect(request.prompt).toContain('"actual": 3'); expect(request.prompt).toContain('"actual": "6"'); expect(request.prompt).toContain('"actualType": "string"');
    expect(request.prompt).toContain('不统一改5秒'); expect(request.prompt).toContain('原回复'); expect(request.prompt).toContain('完整方案');
    expect(request.prompt).toContain('requiresConfirmation:boolean、changeReason:string'); expect(request.prompt).toContain('必须拆镜或改变用户锁定内容时');
    expect(request.prompt).toContain(p.plan!.shots[0].dialogue![0].text);
  });
  it.each(['firstFrame', 'lastFrame', 'video'] as const)('修订及用户再开修订继续使用%s职责与目标', (kind): void => {
    const p = project(); const original = parent(p, 'optimize'); const shot = p.plan!.shots[0];
    original.shotId = shot.id; original.promptKind = kind; original.expectedIds = [`${shot.id}:${kind}`];
    original.promptTask = { dialect: kind === 'video' ? 'seedance20' : 'seedream', references: [], ...(kind === 'video' ? { mode: 'reference' as const } : {}) };
    const previous: PetStoryChatJob = { ...original, id: 'TEST-previous-repair', kind: 'repair', parentJobId: original.id, originKind: 'optimize' };
    p.jobs.push(original, previous);
    const request = buildDramaRequest(p, { kind: 'repair', requestId: 'TEST-next-explicit-round', parentJob: previous, shotId: shot.id, promptKind: kind });
    expect(request.expectedIds).toEqual([`${shot.id}:${kind}`]); expect(request.stage.split('+')[0]).toBe(kind);
    expect(request.prompt).toContain('optimized:string'); expect(request.prompt).not.toContain('【适用方法 analysis】');
    expect(request.prompt).not.toContain('requiresConfirmation:boolean');
    if (kind === 'video') { expect(request.stage).toContain('video20'); expect(request.prompt).toContain('Seedance 2.0'); }
    if (kind === 'lastFrame') expect(request.prompt).toContain('尾帧编辑');
  });
  it.each([false, true])('分析修订带当前方案原台词并明确区分确认状态%s；普通分析仍省略旧派生方案', (approved: boolean): void => {
    const p = project(); p.plan!.shots[0].dialogue = [{ speakerId: 'lumei', text: '乐，你尝尝……', tone: '', pace: '' }];
    if (approved) p.storyApproval = { hash: storyHash(p), at: '2026-10-30T01:00:00.000Z' };
    const original = parent(p); p.jobs.push(original);
    const normal = buildDramaRequest(p, { kind: 'analysis', requestId: 'TEST-analysis' });
    expect(normal.prompt).not.toContain('"currentPlan":');
    const request = buildDramaRequest(p, { kind: 'repair', requestId: 'TEST-analysis-repair', parentJob: original });
    expect(request.prompt).toContain('"currentPlan":'); expect(request.prompt).toContain(approved ? 'confirmed_current_plan' : 'saved_unconfirmed_not_locked');
    expect(request.prompt).toContain('"speakerId": "lumei"'); expect(request.prompt).toContain('乐，你尝尝……');
  });
  it('人物、道具、场景的修订保持各自基础素材规则，不套故事分析合同', (): void => {
    const p = project();
    // 同一原故事的已知道具／场景，仅补现有素材结构供职责映射测试。
    const targets: PetStoryMaterial[] = [p.materials!.find((material): boolean => material.kind === 'character')!,
      { id: 'prop:branch_short', entityId: 'branch_short', kind: 'prop', name: '短枝', designHash: 'a'.repeat(64), prompt: structuredClone(p.plan!.shots[0].prompts.firstFrame) },
      { id: 'scene:road', entityId: 'road', kind: 'scene', name: '村道', designHash: 'b'.repeat(64), prompt: structuredClone(p.plan!.shots[0].prompts.firstFrame) }];
    p.materials = targets;
    for (const [index, material] of targets.entries()) {
      const original = parent(p, 'materialPrompt'); original.id += index; original.materialId = material.id; original.expectedIds = [material.id]; p.jobs.push(original);
      const request = buildDramaRequest(p, { kind: 'repair', requestId: `TEST-material-${index}`, materialId: material.id, parentJob: original });
      expect(request.expectedIds).toEqual([material.id]); expect(request.stage).toBe(index === 0 ? 'imageCharacter' : index === 1 ? 'imageProp' : 'imageScene');
      expect(request.prompt).toContain('optimized:string'); expect(request.prompt).not.toContain('【适用方法 analysis】');
    }
  });
});
