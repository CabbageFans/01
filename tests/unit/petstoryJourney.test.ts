import { describe, expect, it } from 'vitest';
import type { PetStoryAsset, PetStoryCapability, PetStoryPlan, PetStoryProduction, PetStoryProject, PetStoryPromptKind, Task } from '@doubao-studio/contracts';
import { journeyAssetMatchesPrompt, journeyShotAsset, selectPetStoryJourney } from '../../src/utils/petstoryJourney';
import { petStoryJobStatus } from '../../src/components/PetStoryTaskRecovery';
import snapshot from '../fixtures/storyboard-five-shots.json';

const now = '2026-10-28T00:00:00.000Z';
function project(): PetStoryProject {
  return { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [], updatedAt: now,
    mobileStory: { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now }, plan: structuredClone(snapshot.plan) as PetStoryPlan };
}
function production(): PetStoryProduction {
  const entry = { state: 'unknown' as const, free: 'unknown' as const, reason: 'TEST 离线事实' };
  const capability: PetStoryCapability = { accountId: 'TEST-account', checkedAt: now, image: entry, modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [], freeEvidence: 'unknown' };
  return { state: 'complete', phase: 'materials', materialIds: ['TEST-one'], planHash: 'TEST-hash', approvedAt: now, capability, fallbacks: {}, shots: {}, steps: [], message: 'TEST 单项完成' };
}
function asset(p: PetStoryProject, shotIndex: number, kind: PetStoryPromptKind): PetStoryAsset {
  const shot = p.plan!.shots[shotIndex];
  return { id: `TEST-${shot.id}-${kind}`, kind: kind === 'lastFrame' ? 'plannedEndImage' : kind, shotId: shot.id, taskId: `TEST-task-${shot.id}-${kind}`, runId: 'TEST-run', relativePath: `assets/TEST-${shot.id}-${kind}`, generationFinal: shot.prompts[kind]?.final,
    validation: { decoded: true, sha256: 'TEST-digest', bytes: 100, width: 720, height: 1280, checkedAt: now } };
}
function adoptFrame(p: PetStoryProject, image: PetStoryAsset): void {
  if (image.kind === 'video' || !image.shotId) return;
  const kind = image.kind === 'firstFrame' ? 'firstFrame' : 'lastFrame';
  image.imageReview = { state: 'adopted', target: { shotId: image.shotId, kind }, basisHash: 'TEST-basis', adoptedAt: now, sha256: image.validation?.sha256 };
  p.adoptedImages = { ...p.adoptedImages, [image.shotId]: { ...p.adoptedImages?.[image.shotId], [kind === 'firstFrame' ? 'firstFrameId' : 'plannedEndImageId']: image.id } };
}
function confirmedMaterial(p: PetStoryProject): void {
  const character = p.plan!.characters[0]; character.referenceAssetId = 'TEST-material-image';
  const image: PetStoryAsset = { id: 'TEST-material-image', kind: 'character', materialId: 'character:TEST', relativePath: 'assets/TEST-material-image', validation: { decoded: true, sha256: 'TEST-digest', bytes: 100, width: 720, height: 1280, checkedAt: now } };
  p.assets.push(image);
  p.materials = [{ id: 'character:TEST', kind: 'character', entityId: character.id, name: character.name, designHash: 'TEST-design', selectedAssetId: image.id, approved: { assetId: image.id, sha256: image.validation!.sha256, at: now, identity: { assetId: image.id, description: character.description } }, prompt: structuredClone(p.plan!.shots[0].prompts.firstFrame) }];
  p.storyApproval = { hash: 'TEST-approved-fact', at: now };
}

describe('六阶段与实际成果的只读导航投影', (): void => {
  it('从无剧本到已保存剧本的推荐变化，不创建方案或任务', (): void => {
    const p = project(); delete p.plan; delete p.mobileStory;
    expect(selectPetStoryJourney(p).stage).toBe('script');
    p.mobileStory = { id: 'TEST-story', text: snapshot.mobileStory, importedAt: now };
    expect(selectPetStoryJourney(p).stage).toBe('script');
    expect(p.jobs).toEqual([]); expect(p.assets).toEqual([]);
  });
  it('单个基础素材批次完成不代表整个项目的视频或关键帧完成', (): void => {
    const p = project(); confirmedMaterial(p); p.production = production();
    const before = structuredClone(p); const result = selectPetStoryJourney(p);
    expect(result.stage).toBe('keyframes'); expect(result.counts.shots).toBe(5);
    expect(result.counts.keyframes.current).toBe(0); expect(result.counts.videos.current).toBe(0);
    expect(result.counts.videos.total).toBe(5); expect(p).toEqual(before);
  });
  it('动态四镜头按现有目标计算，不写死五镜头或十三项', (): void => {
    const p = project(); p.plan!.shots = p.plan!.shots.slice(0, 4);
    const result = selectPetStoryJourney(p);
    expect(result.counts.shots).toBe(4); expect(result.counts.videos.total).toBe(4);
    expect(result.counts.prompts.total).toBe(p.plan!.shots.reduce((sum, shot): number => sum + Object.keys(shot.prompts).length, 0));
  });
  it('素材只有实际选图和匹配的确认摘要才计入确认', (): void => {
    const p = project(); confirmedMaterial(p);
    expect(selectPetStoryJourney(p).counts.materials).toMatchObject({ selected: 1, confirmed: 1 });
    p.materials![0].approved!.sha256 = 'TEST-obsolete-digest';
    expect(selectPetStoryJourney(p).counts.materials).toMatchObject({ selected: 1, confirmed: 0 });
    expect(selectPetStoryJourney(p).stage).toBe('materials');
  });
  it.each(['needsReview', 'candidate', 'digest', 'date'] as const)('素材%s仍保留旧图，但不能沿旧approved记录误计已确认', (state): void => {
    const p = project(); confirmedMaterial(p); const image = p.assets[0];
    if (state === 'needsReview') image.needsReview = true;
    else image.imageReview = { state: state === 'candidate' ? 'candidate' : 'adopted', target: { materialId: p.materials![0].id }, basisHash: 'TEST-basis', sha256: state === 'digest' ? 'TEST-changed' : image.validation!.sha256, adoptedAt: state === 'date' ? undefined : now };
    expect(selectPetStoryJourney(p).counts.materials).toMatchObject({ selected: 1, confirmed: 0 });
    expect(selectPetStoryJourney(p).stage).toBe('materials'); expect(p.assets[0].id).toBe('TEST-material-image');
  });
  it('已解码的旧正文视频独立显示文件校验，不当作当前视频完成', (): void => {
    const p = project(); p.assets.push({ ...asset(p, 0, 'video'), generationFinal: 'TEST-obsolete-body' });
    const counts = selectPetStoryJourney(p).counts;
    expect(counts.videos).toMatchObject({ present: 1, validated: 1, current: 0 });
  });
  it('待复核正文即使与原文件一致，也不误计当前成果', (): void => {
    const p = project(); p.assets.push(asset(p, 0, 'video')); p.plan!.shots[0].prompts.video.needsReview = true;
    expect(selectPetStoryJourney(p).counts.videos).toMatchObject({ present: 1, validated: 1, current: 0 });
  });
  it('手改正文保留与真实待采用候选分别计数，旧optimized不冒充新候选', (): void => {
    const p = project(); const prompt = p.plan!.shots[0].prompts.firstFrame;
    prompt.final = 'TEST 手改保留'; prompt.optimized = 'TEST 新候选'; prompt.edited = true;
    expect(selectPetStoryJourney(p).counts.prompts.candidates).toBe(0);
    p.jobs.push({ id: 'TEST-candidate', kind: 'optimize', shotId: p.plan!.shots[0].id, promptKind: 'firstFrame', taskId: 'TEST-chat', inputHash: 'TEST', sourceUrl: '', status: 'applied', resultStatus: 'candidate', parsedResult: { optimized: prompt.optimized } }); prompt.candidateJobId = 'TEST-candidate';
    expect(selectPetStoryJourney(p).counts.prompts.candidates).toBe(1); expect(prompt.final).toBe('TEST 手改保留');
    p.jobs[0].resultStatus = 'stale'; expect(selectPetStoryJourney(p).counts.prompts.candidates).toBe(0);
  });
  it('历史批次中选择的真实文件优先于无选择的后来文件', (): void => {
    const p = project(); const first = asset(p, 0, 'firstFrame'); const later = { ...first, id: 'TEST-later' }; p.assets.push(first, later);
    const history = production(); history.shots[p.plan!.shots[0].id] = { requestedMode: 'first_frame', resolvedMode: 'first_frame', reason: 'TEST', firstFrameId: first.id };
    p.productionHistory = [history]; p.production = production(); adoptFrame(p, first);
    expect(journeyShotAsset(p, p.plan!.shots[0], 'firstFrame')?.id).toBe(first.id);
  });
  it('没有人工采用记录时，不把历史选择或最新导入候选当正式首帧', (): void => {
    const p = project(); const shot = p.plan!.shots[0]; const older = asset(p, 0, 'firstFrame'); const latest = { ...older, id: 'TEST-latest-import', taskId: undefined }; p.assets.push(older, latest);
    const history = production(); history.shots[shot.id] = { requestedMode: 'first_frame', resolvedMode: 'first_frame', reason: 'TEST', firstFrameId: older.id }; p.productionHistory = [history];
    p.production = production(); p.production.shots[shot.id] = { requestedMode: 'first_frame', resolvedMode: 'first_frame', reason: 'TEST 最新镜头条目尚未选择首帧' };
    expect(journeyShotAsset(p, shot, 'firstFrame')).toBeUndefined();
    adoptFrame(p, older); expect(journeyShotAsset(p, shot, 'firstFrame')?.id).toBe(older.id);
  });
  it('最近镜头选择指向缺失文件时显示缺失，不擅自采用其他文件', (): void => {
    const p = project(); const shot = p.plan!.shots[0]; p.assets.push(asset(p, 0, 'firstFrame')); p.production = production();
    p.production.shots[shot.id] = { requestedMode: 'first_frame', resolvedMode: 'first_frame', reason: 'TEST', firstFrameId: 'TEST-missing-file' };
    expect(journeyShotAsset(p, shot, 'firstFrame')).toBeUndefined();
  });
  it('明确改为首尾帧后，历史首帧模式不隐藏当前尾帧需求', (): void => {
    const p = project(); const shot = p.plan!.shots[0]; shot.requestedMode = 'first_last_frame'; p.production = production();
    p.production.shots[shot.id] = { requestedMode: 'first_frame', resolvedMode: 'first_frame', reason: 'TEST 历史模式' };
    const projected = selectPetStoryJourney(p).shots[0]; expect(projected.requiresLastFrame).toBe(true); expect(projected.missing).toContain('缺尾帧');
    shot.requestedMode = 'auto'; expect(selectPetStoryJourney(p).shots[0].requiresLastFrame).toBe(false);
  });
  it('用户上传并采用的图片不依赖生成提示词，但待复核仍明确缺项', (): void => {
    const p = project(); const image = asset(p, 0, 'firstFrame'); delete image.taskId; delete image.runId; delete image.generationFinal;
    adoptFrame(p, image); p.assets.push(image);
    expect(journeyAssetMatchesPrompt(image, undefined)).toBe(true);
    image.needsReview = true; expect(journeyAssetMatchesPrompt(image, undefined)).toBe(false);
  });
  it('自由Chat具体回复图片明确采用后可作为当前图，仍保留真实会话来源而不伪造生成正文', (): void => {
    const p = project(); const image = asset(p, 0, 'firstFrame'); delete image.generationFinal; adoptFrame(p, image);
    image.imageReview!.sourceReply = { adjustmentId: 'TEST-adjustment', replyKey: 'TEST-reply', urlHash: 'TEST-url' }; p.assets.push(image);
    expect(image.taskId).toBeDefined(); expect(journeyAssetMatchesPrompt(image, undefined)).toBe(true);
    image.needsReview = true; expect(journeyAssetMatchesPrompt(image, undefined)).toBe(false);
  });
  it('所有当前文件已具备后才推荐查看成果，质量结论独立计算', (): void => {
    const p = project(); confirmedMaterial(p);
    for (let index = 0; index < p.plan!.shots.length; index++) for (const kind of ['firstFrame', 'lastFrame', 'video'] as const) if (p.plan!.shots[index].prompts[kind]) { const image = asset(p, index, kind); p.assets.push(image); adoptFrame(p, image); }
    expect(selectPetStoryJourney(p).stage).toBe('results');
    expect(selectPetStoryJourney(p).counts.quality.confirmed).toBe(0);
    const video = p.assets.find((item): boolean => item.kind === 'video')!;
    const task: Task = { id: video.taskId!, assignedAccountId: p.accountId, mode: 'video', prompt: '', status: 'done', outputs: [], result: null, createdAt: now, updatedAt: now, qualityVerdict: { status: 'accepted', decidedAt: now }, runtime: { runId: video.runId!, attempt: 1, stage: 'completed', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { mode: 'video', prompt: '', attachments: [] } } };
    expect(selectPetStoryJourney(p, [task]).counts.quality.confirmed).toBe(1);
    task.runtime!.runId = 'TEST-other-run'; expect(selectPetStoryJourney(p, [task]).counts.quality.confirmed).toBe(0);
  });
});

describe('当前任务显示发送事实', (): void => {
  it('已提交不确定只能解释为核对原会话，不表示尚未发送', (): void => {
    const job = { id: 'TEST-job', kind: 'analysis' as const, taskId: 'TEST-task', status: 'bound' as const, inputHash: 'TEST', sourceUrl: '' };
    const task: Task = { id: job.taskId, assignedAccountId: 'TEST-account', mode: 'chat', prompt: '', status: 'fail', outputs: [], result: null, createdAt: now, updatedAt: now, runtime: { runId: 'TEST-run', attempt: 1, stage: 'submitting', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, input: { mode: 'chat', prompt: '', attachments: [] }, submittedAt: now } };
    expect(petStoryJobStatus(job, task)).toMatchObject({ title: '发送结果需要核对' });
    expect(petStoryJobStatus({ ...job, endedWaitingAt: now }, task).instruction).toContain('平台任务并未取消');
    delete task.runtime!.submittedAt; expect(petStoryJobStatus(job, task).title).toBe('原任务尚未发送');
  });
});
