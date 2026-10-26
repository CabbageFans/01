/** 通用机制回归：正式收取与产品导出，不使用历史五镜头或人工校订稿。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryPlan, PetStoryProject, PetStoryPrompt, Task, TaskAddParams } from '@doubao-studio/contracts';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { PetStoryChatService } from '../../main/utils/petstoryChat';
import { TaskService } from '../../main/core/TaskService';
import { syncMaterials } from '../../main/utils/petstoryMaterials';
import { compileMaterialPrompt, compilePrompt } from '../../main/utils/petstoryPromptQuality';
import { bindReferenceText } from '../../main/utils/petstoryReferenceText';
import { buildPetStoryPromptExport, renderPetStoryPromptExport, writePetStoryPromptExport } from '../../main/utils/petstoryExport';
import { characterContext, promptStageContext } from '../../src/utils/petstoryPrompts';
import { createAcceptedObservationBinding } from '../../src/utils/acceptedObservation';
import { readStableChatAnswer } from '../../src/utils/doubaoBridge';

const prompt = (final: string, edited = false): PetStoryPrompt => ({ original: final, optimized: final, final, edited, rulesVersion: 'TEST-v4' });
function plan(kind: 'library' | 'greenhouse'): PetStoryPlan {
  const library = kind === 'library';
  return { sourceSummary: library ? '归还修好的地图册' : '空温室的水泵启动', adaptedStory: library ? '两名工作人员把修好的地图册从修复室送到借阅台。' : '空无一人的温室，水泵启动后灌溉管里开始有水流。',
    characters: library ? [{ id: 'lulu', name: '修复员', role: 'main', purpose: '把地图册交给借阅员，对方随后离开', description: '人类青年，深蓝围裙，圆框眼镜', continuity: '之后走向门口再交接，借阅员伸手接取', designOrigin: 'script' }, { id: 'reader', name: '借阅员', role: 'supporting', purpose: '接取地图册走向柜台', description: '人类中年，灰色工作服', designOrigin: 'script' }] : [],
    props: [{ id: 'object', name: library ? '地图册' : '灌溉水泵', aliases: library ? ['册子'] : ['泵'], description: library ? '深绿硬封皮，书脊有金色细线' : '银灰金属泵体，透明连接管', appearanceState: library ? '封皮完整，合拢' : '静止，管内无水', keyStates: library ? '修复员交给借阅员，借阅员抱着离开' : '电机启动并向管路送水', scale: library ? '宽约一只手掌' : '桌面装置大小', designOrigin: 'script' }],
    scenes: [{ id: 'room', name: library ? '修复室' : '温室', location: library ? '图书馆修复室' : '植物温室', time: '上午', lighting: '玻璃窗侧光', layout: '左侧入口，右侧工作区', view: '平视主视角', designOrigin: 'script' }, ...(library ? [{ id: 'desk', name: '借阅台', location: '图书馆一楼借阅台', time: '上午', lighting: '窗边光', layout: '柜台横向展开', view: '正面', designOrigin: 'script' as const }] : [])],
    shots: Array.from({ length: library ? 4 : 1 }, (_, i): PetStoryPlan['shots'][number] => ({ id: `beat-${i}`, order: i + 1, characterIds: library ? i === 3 ? ['reader'] : ['lulu', 'reader'] : [], propIds: ['object'], propStates: [{ propId: 'object', holderId: library ? i < 2 ? 'lulu' : 'reader' : undefined, state: library ? '交接后离开' : '由关闭转为启动' }], sceneId: library && i === 3 ? 'desk' : 'room', scene: library ? '修复室内' : '温室内', sceneView: i === 1 ? '同室反打' : '平视', startState: library ? '册子尚放在桌上，双方手还未接触' : '水泵静止，管内无水', endState: library ? '册子已被借阅员稳稳抱住' : '水流进入管内', action: library ? '拿起、交接后向门口离开' : '水泵启动并泵水', expression: '后半段微笑', gaze: '先看物体再看门口', interaction: '完成交接后离开', camera: '固定', dialogue: library && i === 0 ? [{ speakerId: 'lulu', text: '这本地图册修好了。', tone: '平静', pace: '清楚' }] : [], durationSeconds: 5, transition: i === 1 ? 'continue' : 'cut', previousShotId: i === 1 ? 'beat-0' : undefined, requestedMode: i === 2 ? 'first_last_frame' : i === 3 ? 'first_frame' : 'reference', prompts: {
      firstFrame: prompt(library ? '两人静立于桌旁，地图册合拢放在桌上。' : '静止水泵位于温室工作台，透明管内无水。'),
      lastFrame: prompt(library ? '只编辑到借阅员抱稳地图册的静态画面。' : '只编辑到管内可见水流的静态画面。'),
      video: prompt(library ? '从桌上拿起地图册，双方完成交接。' + (i === 0 ? '修复员平静清楚地说：“这本地图册修好了。”' : '') : '电机先转动，随后水流由泵进入透明管。') } })) };
}
let directory: string; let projects: PetStoryProjects; let project: PetStoryProject;
beforeEach(async (): Promise<void> => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-prompt-mechanism-')); projects = new PetStoryProjects(); project = await projects.create(directory, 'TEST-studio', 'TEST-account'); project = await projects.saveMobileStory(project.id, project.revision, plan('library').adaptedStory); });
afterEach(async (): Promise<void> => { vi.useRealTimers(); await fs.rm(directory, { recursive: true, force: true }); });
function setPlan(which: 'library' | 'greenhouse'): PetStoryProject { const p = structuredClone(project); p.plan = plan(which); p.materials = syncMaterials(p); return p; }

describe('分类与阶段投影', (): void => {
  it.each(['library', 'greenhouse'] as const)('%s 资产设计预览只采用本类可视字段，不作为最终正文', (which): void => {
    const p = setPlan(which); const byId = new Map(p.materials!.map((m): [string, string] => [m.id, m.prompt.original]));
    expect(p.materials!.every((m): boolean => m.prompt.final === '' && m.prompt.optimized === '')).toBe(true);
    expect(byId.get('prop:object')).not.toContain(p.plan!.props![0].keyStates);
    expect(byId.get('prop:object')).toContain(p.plan!.props![0].appearanceState);
    expect(byId.get('prop:object')).not.toContain(p.promptProfile!.assetStyles!.character);
    expect(byId.get('scene:room')).not.toContain(p.promptProfile!.assetStyles!.character);
    expect(p.materials!.every((m): boolean => !m.prompt.final.includes('设计来源：'))).toBe(true);
    if (which === 'library') { expect(byId.get('character:lulu')).toContain(p.plan!.characters[0].description); expect(byId.get('character:lulu')).not.toContain(p.plan!.characters[0].purpose); expect(byId.get('character:lulu')).not.toContain(p.plan!.characters[0].continuity); }
    const exported = buildPetStoryPromptExport(p, []); expect(exported.prompts.filter((e): boolean => ['character','prop','scene'].includes(e.category))).toHaveLength(p.materials!.length);
    expect(exported.prompts.filter((e): boolean => ['character','prop','scene'].includes(e.category)).every((entry): boolean => entry.modelPrompt === null)).toBe(true);
    expect(exported.prompts.find((e): boolean => e.id === 'prop:object')!.review.metadata).toMatchObject({ entity: { keyStates: p.plan!.props![0].keyStates } });
    expect(exported.actualRuns).toEqual([]);
  });
  it('旧共同风格不跨类套用，明确分类后只进入指定资产', (): void => {
    const p = setPlan('library'); p.promptProfile = { style: '眼睛有高光，衣服有褶皱', characters: {} };
    p.materials = syncMaterials(p); expect(p.materials.every((m): boolean => !m.prompt.original.includes(p.promptProfile!.style))).toBe(true);
    expect(buildPetStoryPromptExport(p, []).review.warnings).toHaveLength(1);
    p.promptProfile.assetStyles = { common: '水彩', prop: '可辨木纹' }; p.materials = syncMaterials(p);
    expect(p.materials.find((m): boolean => m.kind === 'scene')!.prompt.original).not.toContain('可辨木纹');
    expect(p.materials.find((m): boolean => m.kind === 'prop')!.prompt.original).toContain('可辨木纹');
  });
  it('静态阶段不接受旧过程字段，final 与完整编译不因旧动作变化而变化', (): void => {
    const p = setPlan('library'); const shot = p.plan!.shots[0];
    expect(promptStageContext(shot, 'firstFrame')).toEqual({ id: shot.id, characterIds: shot.characterIds, propIds: shot.propIds, sceneId: shot.sceneId, sceneView: shot.sceneView, camera: shot.camera, appearanceOverrides: undefined, startState: shot.startState });
    expect(promptStageContext(shot, 'lastFrame')).not.toHaveProperty('startState'); expect(promptStageContext(shot, 'lastFrame')).not.toHaveProperty('action');
    expect(promptStageContext(shot, 'video')).toMatchObject({ action: shot.action, dialogue: shot.dialogue, propStates: shot.propStates });
    for (const kind of ['firstFrame','lastFrame','video'] as const) {
      const before = compilePrompt(p, shot.id, kind, kind === 'video' ? 'reference' : undefined, true);
      shot.action = '旧动作：倒着走出房间'; shot.expression = '旧表演：已完成大笑'; shot.propStates![0].state = '旧道具归属过程';
      const after = compilePrompt(p, shot.id, kind, kind === 'video' ? 'reference' : undefined, true);
      expect(after).toEqual(before); expect(after.final).toBe(shot.prompts[kind]!.final);
    }
  });
  it('参考图与规范文字存在时不再添加默认物种／服装；用户 final 和素材保留', (): void => {
    const p = setPlan('library'); p.assets.push({ id:'portrait',kind:'character',characterId:'lulu',relativePath:'characters/portrait.png' }); p.plan!.characters[0].referenceAssetId='portrait';
    const context = JSON.parse(characterContext(p,'beat-0').split('\n')[0].replace('角色与风格数据：','')) as {characters:{id:string;identitySupplement:string;confirmedProjectDescription:string;fallbackAppearanceOnlyWhenUnspecified:string}[]};
    expect(context.characters[0]).toMatchObject({ id:'lulu',identitySupplement:'',confirmedProjectDescription:p.plan!.characters[0].description,fallbackAppearanceOnlyWhenUnspecified:'' });
    p.materials![0].prompt.final='用户手改多段\n保持眼镜。'; p.materials![0].prompt.edited=true;
    p.plan!.characters[0].purpose='其他人后续行为变化'; p.materials=syncMaterials(p);
    expect(p.materials[0].prompt.final).toBe('用户手改多段\n保持眼镜。'); expect(p.assets[0].id).toBe('portrait');
  });
});

describe('正式 Chat 与产品导出', (): void => {
  it('原Chat绑定未收取或已捕获未处理时导出全局暂停警示，保留不确定原任务且不改正文', async (): Promise<void> => {
    const p = setPlan('greenhouse'); const exportedAt = '2026-10-26T00:00:00.000Z';
    const before = buildPetStoryPromptExport(p, [], exportedAt);
    p.jobs.push({ id: 'TEST-bound-repair', taskId: 'TEST-paused-task', runId: 'TEST-original-run', kind: 'repair', parentJobId: 'TEST-original-job', shotId: 'beat-0', promptKind: 'video', status: 'bound', inputHash: 'a'.repeat(64), sourceUrl: '', requestText: 'TEST已发送完整文字请求' },
      { id: 'TEST-captured', taskId: 'TEST-captured-task', kind: 'optimize', shotId: 'beat-0', promptKind: 'firstFrame', status: 'captured', inputHash: 'b'.repeat(64), sourceUrl: '', rawText: 'TEST尚未解析的原回复' });
    const task: Task = { id: 'TEST-paused-task', status: 'paused', mode: 'chat', projectId: p.studioProjectId, assignedAccountId: p.accountId, prompt: 'TEST已发送完整文字请求', result: null, outputs: [], createdAt: exportedAt, updatedAt: exportedAt,
      errorInfo: { code: 'submission_uncertain', message: 'TEST提交后回读不确定', recoverable: true, detectedAt: exportedAt },
      runtime: { runId: 'TEST-original-run', attempt: 1, stage: 'submitting', message: 'TEST保留原运行', startedAt: exportedAt, stageStartedAt: exportedAt, lastHeartbeatAt: exportedAt, submittedAt: exportedAt, input: { mode: 'chat', prompt: 'TEST已发送完整文字请求', attachments: [] } } };
    const savedProject = structuredClone(p); const savedTask = structuredClone(task);
    const exported = buildPetStoryPromptExport(p, [task], exportedAt);
    expect(exported.review.pendingChat).toEqual({ total: 2, bound: 1, captured: 1 });
    expect(exported.review.warnings.join('\n')).toContain('原Chat未收取，媒体暂停，不得重发。');
    expect(exported.review.warnings.join('\n')).toContain('绑定待收取 1，已捕获待处理 1');
    expect(exported.prompts).toEqual(before.prompts); expect(exported.actualRuns).toEqual(before.actualRuns);
    const output = await writePetStoryPromptExport(directory, exported);
    const text = await fs.readFile(path.join(output, 'model-prompts.txt'), 'utf8'); const html = await fs.readFile(path.join(output, 'review.html'), 'utf8');
    expect(text.startsWith('[原Chat未收取，媒体暂停，不得重发。')).toBe(true);
    expect(html).toContain('<p role="alert"><strong>原Chat未收取，媒体暂停，不得重发。</strong></p>');
    expect(text).not.toContain('TEST尚未解析的原回复'); expect(p).toEqual(savedProject); expect(task).toEqual(savedTask);
  });
  it('无bound/captured原Chat时不增加导出字段或横幅，已处理任务不改变输出', (): void => {
    const p = setPlan('greenhouse'); const exportedAt = '2026-10-26T00:00:00.000Z';
    const before = buildPetStoryPromptExport(p, [], exportedAt);
    p.jobs.push({ id: 'TEST-processed', taskId: 'TEST-processed-task', kind: 'optimize', status: 'applied', inputHash: 'a'.repeat(64), sourceUrl: '' },
      { id: 'TEST-invalid', taskId: 'TEST-invalid-task', kind: 'optimize', status: 'invalid', inputHash: 'b'.repeat(64), sourceUrl: '', error: 'TEST候选保留原因' });
    const after = buildPetStoryPromptExport(p, [], exportedAt);
    expect(after).toEqual(before); expect(after.review).not.toHaveProperty('pendingChat');
    expect(renderPetStoryPromptExport(after)).toEqual(renderPetStoryPromptExport(before));
    expect(renderPetStoryPromptExport(after).text).not.toContain('原Chat未收取');
  });
  it.each(['shot', 'material'] as const)('待复核%s导出醒目标记、失败原因与原final，失败候选不混入可提交正文', async (kind: 'shot' | 'material'): Promise<void> => {
    const p = setPlan('greenhouse'); const shot = p.plan!.shots[0]; const material = p.materials!.find((item): boolean => item.id === 'prop:object')!;
    if (kind === 'material') { material.prompt.final = 'TEST模型已采用的基础图正文'; material.prompt.optimized = material.prompt.final; material.prompt.sourceJobId = 'TEST-adopted-material'; }
    const current = kind === 'shot' ? shot.prompts.video : material.prompt; const original = current.final; current.needsReview = true;
    const target = kind === 'shot' ? { shotId: shot.id, promptKind: 'video' as const } : { materialId: material.id };
    p.jobs.push({ id: 'TEST-failed-revision', taskId: 'TEST-revision-task', kind: 'revise', status: 'invalid', inputHash: 'a'.repeat(64), sourceUrl: '', sourceStoryId: p.mobileStory!.id,
      inputFinal: original, rawText: 'TEST失败完整候选', parsedResult: { optimized: 'TEST失败完整候选' }, validationIssues: ['TEST明确声音格式缺项'], error: 'TEST明确声音格式缺项', ...target });
    const targetId = kind === 'shot' ? `${shot.id}:video` : material.id;
    p.jobs.push({ id: 'TEST-current-review', taskId: 'TEST-review-task', kind: 'review', status: 'applied', inputHash: 'b'.repeat(64), sourceUrl: '', sourceStoryId: p.mobileStory!.id,
      inputFinal: original, expectedIds: [targetId], parsedResult: { issues: [{ id: 'TEST-sound-outside-angle', targetId, severity: 'error', evidence: 'TEST当前正文存在未包裹声音指令', impact: 'TEST约定缺项', requestedChange: 'TEST按实际方言核对' }] }, ...target });
    if (kind === 'material') p.jobs.push({ id: 'TEST-adopted-material', taskId: 'TEST-material-source-task', kind: 'materialPrompt', status: 'applied', materialId: material.id, inputHash: 'c'.repeat(64), sourceUrl: '', rawText: JSON.stringify({ optimized: original }), parsedResult: { optimized: original } });
    const exported = buildPetStoryPromptExport(p, []); const entry = exported.prompts.find((item): boolean => item.id === (kind === 'shot' ? `${shot.id}:video` : material.id))!;
    expect(entry.final).toBe(original); expect(entry.modelPrompt).toBe(original);
    expect(entry.review).toMatchObject({ submissionBlocked: true, metadata: { needsReview: true, failedRevisions: [{ jobId: 'TEST-failed-revision', reasons: ['TEST明确声音格式缺项'], candidatePreserved: true }] } });
    expect(entry.review.metadata).toMatchObject({ reviewErrors: [{ jobId: 'TEST-current-review', issues: [{ id: 'TEST-sound-outside-angle', evidence: 'TEST当前正文存在未包裹声音指令' }] }] });
    expect(entry.review.warnings.join('\n')).toContain('不可直接提交'); expect(entry.review.warnings.join('\n')).toContain('TEST明确声音格式缺项');
    expect(entry.review.warnings.join('\n')).toContain('TEST当前正文存在未包裹声音指令');
    const output = await writePetStoryPromptExport(directory, exported);
    const text = await fs.readFile(path.join(output, 'model-prompts.txt'), 'utf8'); const html = await fs.readFile(path.join(output, 'review.html'), 'utf8');
    expect(text).toContain('待复核 · 不可直接提交'); expect(text).toContain(original); expect(text).not.toContain('TEST失败完整候选'); expect(html).toContain('role="alert"');
    if (kind === 'shot') expect((): unknown => compilePrompt(p, shot.id, 'video', 'reference')).toThrow('复核');
    else expect((): unknown => compileMaterialPrompt(p, material.id)).toThrow('复核');
    expect(current.final).toBe(original); expect(p.jobs[0].parsedResult?.optimized).toBe('TEST失败完整候选');
  });
  it('原回复经稳定回读、TaskService 保存和项目收取；保护规范身份与手改 final，不产生媒体任务', async (): Promise<void> => {
    project = setPlan('library'); const savedFinal='用户亲自编辑的静态首帧。'; project.plan!.shots[0].prompts.firstFrame=prompt(savedFinal,true); project=await projects.write(project);
    let stored:Task[]=[]; let sequence=0; const list=():Task[]=>structuredClone(stored);
    const core=new TaskService({store:{read:list,replace:(items:Task[]):boolean=>{stored=structuredClone(items);return true;}},defaultProjectId:():string=>'TEST-studio',id:():string=>`TEST-chat-${++sequence}`});
    const create=(input:TaskAddParams,accountId:string):Task=>{const result=core.create(input);if(!result.success)throw new Error(result.error);const assigned=core.assign({taskId:result.data[0].id,accountId});if(!assigned.success)throw new Error(assigned.error);return assigned.data;};
    const chat=new PetStoryChatService(projects,{list,create}); const input='请按提供的剧本返回完整 JSON，不生成媒体。'; const prepared=await chat.prepare(project.id,input,'analysis'); const job=prepared.project!.jobs[0]; const task=list()[0]; const now=new Date().toISOString(); const runId='TEST-run';
    core.updateRuntime({taskId:task.id,status:'executing',runtime:{runId,attempt:1,stage:'submitting',message:'TEST',startedAt:now,stageStartedAt:now,lastHeartbeatAt:now,submittedAt:now,conversationUrl:'https://www.doubao.com/chat/TEST-only',input:{prompt:input,mode:'chat',attachments:[]}}});
    await chat.bindRun(project.id,job.id,runId);
    const answer=plan('library'); answer.characters[0].description='不应覆盖规范身份的模型猜测';
    const raw='```json\n'+JSON.stringify({...answer,storyUsable:true,contentBasis:{beginning:'桌上放册子',middle:'完成交接',ending:'送到借阅台'}})+'\n```';
    const view={getURL:():string=>'https://www.doubao.com/chat/TEST-only',loadURL:vi.fn(),sendInputEvent:vi.fn(),executeJavaScript:vi.fn(async():Promise<unknown>=>({messages:[{role:'user',text:input},{role:'assistant',text:raw,rawText:raw}],editorPresent:true,editorText:'',generating:false}))};
    vi.useFakeTimers(); const capture=readStableChatAnswer(view,input,view.getURL()); await vi.advanceTimersByTimeAsync(3000); const captured=await capture; vi.useRealTimers();
    expect(captured).toBe(raw); core.updateRuntime({taskId:task.id,runtime:{chatResponse:{text:captured,capturedAt:now}}}); core.updateStatus({taskId:task.id,status:'done',outputs:[]});
    const collected=await chat.collect(project.id,job.id); expect(collected.success,collected.error).toBe(true); const p=collected.project!;
    expect(p.jobs[0]).toMatchObject({status:'applied',rawText:raw,runId}); expect(p.plan!.characters[0].description).toBe(plan('library').characters[0].description); expect(p.plan!.shots[0].prompts.firstFrame.final).toBe(savedFinal);
    expect(list()).toHaveLength(1); expect(list()[0].mode).toBe('chat'); expect(view.sendInputEvent).not.toHaveBeenCalled();expect(view.loadURL).not.toHaveBeenCalled();
    const output=buildPetStoryPromptExport(p,list()); const location=await writePetStoryPromptExport(directory,output);const reopened=JSON.parse(await fs.readFile(path.join(location,'prompts.json'),'utf8')) as ReturnType<typeof buildPetStoryPromptExport>;
    expect(reopened).toEqual(output); expect(reopened.prompts.find((e):boolean=>e.id==='beat-0:firstFrame')!.final).toBe(savedFinal);expect(reopened.actualRuns).toEqual([]);
    expect(await fs.readFile(path.join(location,'model-prompts.txt'),'utf8')).not.toContain('设计来源：');expect((await projects.read(project.id)).revision).toBe(p.revision);
  });
  it('导出只读计划与已有实际记录，槽位和引用计划不能冒充已发送', (): void => {
    const p=setPlan('library');const compiled=compilePrompt(p,'beat-0','firstFrame',undefined,true);
    const bindings=compiled.references.map((ref,i):import('@doubao-studio/contracts').PetStoryPageBinding=>({assetId:ref.assetId,order:i+1,slot:'reference',previewHash:'a'.repeat(64),label:`@图片${compiled.references.length-i}`,reference:'mention',nodeId:`node-${i}`,fileSha256:'b'.repeat(64),targetId:`asset-${i}`}));
    const bound=bindReferenceText(compiled,bindings); const now=new Date().toISOString();
    p.assets=bindings.map((b):PetStoryProject['assets'][number]=>({id:b.assetId,kind:'character',relativePath:'characters/TEST.png',validation:{decoded:true,sha256:b.fileSha256!,bytes:4,width:64,height:64,checkedAt:now}}));
    p.production={state:'paused',phase:'shots',planHash:'a'.repeat(64),approvedAt:now,capability:{} as NonNullable<PetStoryProject['production']>['capability'],fallbacks:{},shots:{},message:'TEST',steps:[{id:'step',shotId:'beat-0',kind:'firstFrame',taskId:'task',runId:'run',inputHash:'a'.repeat(64),attachmentAssetIds:compiled.references.map((r):string=>r.assetId),status:'bound',compiledPrompt:bound,pageBindings:bindings}]};
    const task={id:'task',projectId:p.studioProjectId,assignedAccountId:p.accountId,petstory:{projectId:p.id,stepId:'step'},prompt:bound.text,runtime:{runId:'run',input:{prompt:bound.text}}} as Task;
    const prepared=buildPetStoryPromptExport(p,[task]);expect(prepared.actualRuns[0]).toMatchObject({status:'bound_not_sent',sentModelPrompt:null,bindings});
    task.runtime!.submittedAt=now;expect(buildPetStoryPromptExport(p,[task]).actualRuns[0]).toMatchObject({status:'submission_uncertain',sentModelPrompt:null});
    task.runtime!.conversationUrl='https://www.doubao.com/chat/TEST-bound'; task.runtime!.acceptanceObservation=createAcceptedObservationBinding({accountId:p.accountId,runId:'run',conversationUrl:task.runtime!.conversationUrl,acceptedAt:now,ownerId:'TEST-owner',mode:'image',evidence:{generationStarted:true,promptPublished:true,inputCleared:true,messageCount:2}});
    expect(buildPetStoryPromptExport(p,[task]).actualRuns[0]).toMatchObject({status:'submitted',sentModelPrompt:bound.text});
    task.runtime!.runId='foreign-run';expect(buildPetStoryPromptExport(p,[task]).actualRuns[0]).toMatchObject({status:'evidence_unavailable',sentModelPrompt:null});
    expect(p.plan!.shots[0].prompts.firstFrame.final).toBe(compiled.final);
  });
});
