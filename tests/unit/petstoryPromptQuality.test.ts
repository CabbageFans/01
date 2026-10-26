/** 专项离线夹具；不代表豆包返回或生成质量验收。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import type { PetStoryProject, PetStoryPrompt, Task, TaskAddParams, TaskRunSnapshot, PetStoryPromptKind, PetStoryResolvedMode } from '@doubao-studio/contracts';
import { compilePrompt, defaultPromptProfile, orderedChatAssets, promptReferences } from '../../main/utils/petstoryPromptQuality';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { PetStoryChatService } from '../../main/utils/petstoryChat';
import { validatePetStoryPlan, parsePetStoryAnswer } from '../../main/utils/petstoryValidation';
import { characterContext, chatAssets, optimizationPrompt, analysisPrompt } from '../../src/utils/petstoryPrompts';
import { verifyPromptReadyForSubmission, type WebviewHandle } from '../../src/utils/doubaoBridge';
import examples from '../fixtures/petstory-prompt-quality.json';
import { TaskService } from '../../main/core/TaskService';

function prompt(value = '静态时刻，噜妹看碗。'): PetStoryPrompt { return { original: 'TEST原始', optimized: value, final: value, edited: false, rulesVersion: 'TEST旧规则' }; }
function fixture(): PetStoryProject {
  return { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 0,
    source: { kind: 'douyin', url: 'https://v.douyin.com/TEST/', status: 'review_required' }, jobs: [], updatedAt: new Date().toISOString(),
    mobileStory: { id: '00000000-0000-0000-0000-000000000000', text: 'TEST完整故事：在家得意，面馆犹豫，最后向同伴求助。', importedAt: new Date().toISOString() },
    promptProfile: defaultPromptProfile(), assets: [
      { id: 'b', kind: 'character', characterId: 'lumei', relativePath: 'characters/b.png' },
      { id: 'a', kind: 'character', characterId: 'lulu', relativePath: 'characters/a.png' },
      { id: 'c', kind: 'character', characterId: 'clerk', relativePath: 'characters/c.png' },
      { id: 'scene', kind: 'scene', shotId: 's1', relativePath: 'shots/s1/scene.png' },
      { id: 'first', kind: 'firstFrame', shotId: 's1', relativePath: 'shots/s1/first.png' },
      { id: 'last', kind: 'plannedEndImage', shotId: 's1', relativePath: 'shots/s1/last.png' },
    ], plan: { sourceSummary: 'TEST梗概', adaptedStory: 'TEST确认故事', characters: [
      { id: 'lulu', name: '噜噜', role: 'main', purpose: '关注同伴', description: '本项目蓝色外套', referenceAssetId: 'a' },
      { id: 'lumei', name: '噜妹', role: 'main', purpose: '求助', description: '粉色衣装', referenceAssetId: 'b' },
      { id: 'clerk', name: '牛店员', role: 'supporting', purpose: '送面', description: '牛形店员，白围裙', referenceAssetId: 'c' },
    ], shots: [{ id: 's1', order: 1, characterIds: ['lulu', 'lumei'], sceneReferenceAssetIds: ['scene'], scene: '木质面馆',
      appearanceOverrides: { lumei: '本场不披斗篷，保留粉帽与盘环芽饰' }, action: '噜妹停筷，抬眼向噜噜求助，噜噜侧头回应', startState: '噜妹低头看香菜，筷子停在碗边', endState: '噜妹望噜噜，噜噜关注她，筷子仍在噜妹爪中',
      durationSeconds: 5, transition: 'cut', requestedMode: 'first_last_frame', prompts: { firstFrame: prompt(), lastFrame: prompt('只改变两人头部视线到求助终态。'), video: prompt('噜妹先停筷，再抬眼向噜噜，噜噜侧头回应。') } }] } };
}
function attachMedia(p: PetStoryProject): void {
  p.production = { state: 'paused', planHash: 'a'.repeat(64), approvedAt: new Date().toISOString(), capability: {} as NonNullable<PetStoryProject['production']>['capability'],
    fallbacks: {}, steps: [], message: 'TEST', shots: { s1: { requestedMode: 'first_last_frame', resolvedMode: 'first_last_frame', reason: 'TEST', firstFrameId: 'first', plannedEndImageId: 'last' } } };
}

describe('角色上下文与实际用途', (): void => {
  it.each(examples)('报告离线对照 $label 可沿正式编译出口获得完整提交文本', (example): void => {
    const p = example.project as unknown as PetStoryProject;
    const compiled = compilePrompt(p, 'TEST-shot', example.kind as PetStoryPromptKind, example.resolvedMode as PetStoryResolvedMode | undefined);
    expect(compiled.text.endsWith(compiled.final)).toBe(true);
    expect(compiled.references.map((r): number => r.order)).toEqual(compiled.references.map((_r, index): number => index + 1));
    if (example.resolvedMode === 'first_last_frame') expect(compilePrompt(p, 'TEST-shot', 'lastFrame').references[0].assetId).toBe('TEST-first');
  });
  it.each([[['lulu']], [['lumei']], [['lulu', 'lumei']], [['lulu', 'clerk']]])('只注入本镜 %j 的档案，保留配角自己的身份', (ids: string[]): void => {
    const p = fixture(); p.plan!.shots[0].characterIds = ids;
    const input = characterContext(p, 's1');
    const data = JSON.parse(input.split('\n')[0].replace('角色与风格数据：', ''));
    expect(data.characters.map((c: { id: string }): string => c.id)).toEqual(ids);
    if (ids.includes('clerk')) expect(data.characters.find((c: { id: string }): boolean => c.id === 'clerk').identitySupplement).toBe('');
  });
  it('新草稿含分离的完整橘子与盘环嫩芽；既有换装和场景覆盖不退回默认', (): void => {
    const p = fixture();
    expect(p.promptProfile?.characters.lulu.appearance).toContain('完整小橘子');
    expect(p.promptProfile?.characters.lumei.appearance).toContain('盘／环状');
    const data = JSON.parse(characterContext(p, 's1').split('\n')[0].replace('角色与风格数据：', ''));
    expect(data.characters[0].confirmedProjectDescription).toBe('本项目蓝色外套');
    expect(data.characters[0].fallbackAppearanceOnlyWhenUnspecified).toBe('');
    expect(data.characters[1].confirmedShotAppearance).toContain('不披斗篷');
    p.plan!.shots[0].appearanceOverrides!.lumei = '本场浅黄色柑橘图案斗篷';
    expect(optimizationPrompt(p, 's1', 'firstFrame')).toContain('本场浅黄色柑橘图案斗篷');
  });
  it('Chat、首帧生成使用同一显式选择与上传次序，反转顺序同步引用', (): void => {
    const p = fixture();
    expect(chatAssets(p, 's1')).toEqual(orderedChatAssets(p, 's1'));
    expect(orderedChatAssets(p, 's1').map((a): string => a.id)).toEqual(['a', 'b', 'scene']);
    p.plan!.shots[0].prompts.firstFrame.final = '{{ref:lulu}}定义噜噜，{{ref:lumei}}定义噜妹。';
    const first = compilePrompt(p, 's1', 'firstFrame');
    p.plan!.shots[0].characterIds.reverse();
    const second = compilePrompt(p, 's1', 'firstFrame');
    expect(first.text).toContain('第 1 张图定义噜噜');
    expect(second.text).toContain('第 2 张图定义噜噜');
    expect(second.references.map((r): string => r.assetId)).toEqual(['b', 'a', 'scene']);
    p.plan!.shots[0].prompts.firstFrame.final = '图1：噜噜，图2：噜妹';
    expect((): unknown => compilePrompt(p, 's1', 'firstFrame')).toThrow('错绑');
  });
  it('同框身份图只上传一次，仍绑定两个角色；缺少实际图不得假称已提供', (): void => {
    const p = fixture(); p.assets[0].characterIds = ['lulu', 'lumei']; p.plan!.characters[0].referenceAssetId = 'b';
    const refs = promptReferences(p, p.plan!.shots[0], 'firstFrame');
    expect(refs[0].characterIds).toEqual(['lulu', 'lumei']);
    expect(refs.map((r): string => r.assetId)).toEqual(['b', 'scene']);
    p.assets = p.assets.filter((a): boolean => a.id !== 'b');
    expect((): unknown => compilePrompt(p, 's1', 'firstFrame')).toThrow('缺少');
  });
  it('四种用途与参考备选不同，视频不使用角色图号，计划尾图不当实际末帧', (): void => {
    const p = fixture(); attachMedia(p);
    expect(compilePrompt(p, 's1', 'firstFrame').text).toBe(p.plan!.shots[0].prompts.firstFrame.final);
    expect(compilePrompt(p, 's1', 'lastFrame').references.map((r): string => r.assetId)).toEqual(['first']);
    expect(compilePrompt(p, 's1', 'lastFrame').text).toBe(p.plan!.shots[0].prompts.lastFrame!.final);
    expect(compilePrompt(p, 's1', 'video', 'first_frame').references.map((r): string => r.assetId)).toEqual(['first']);
    const native = compilePrompt(p, 's1', 'video', 'first_last_frame');
    expect(native.references.map((r): string | undefined => r.slot)).toEqual(['first', 'last']);
    const reference = compilePrompt(p, 's1', 'video', 'reference');
    expect(reference.resolvedMode).toBe('reference');
    expect(reference.references.every((r): boolean => !r.slot)).toBe(true);
    expect(reference.references).toHaveLength(1);
    p.plan!.shots[0].prompts.video.final = '图1：噜噜';
    expect((): unknown => compilePrompt(p, 's1', 'video', 'reference')).toThrow('错绑');
    p.plan!.shots[0].prompts.video.final = '原生首尾帧连接';
    expect((): unknown => compilePrompt(p, 's1', 'video', 'reference')).toThrow('实际模式');
    p.production!.shots.s1.firstFrameId = 'last';
    expect((): unknown => compilePrompt(p, 's1', 'lastFrame')).toThrow('计划尾帧');
  });
  it('continue 描述实际末帧来源，不混用计划尾图', (): void => {
    const p = fixture(); attachMedia(p);
    p.assets.push({ id: 'actual', kind: 'actualEndFrame', shotId: 's1', relativePath: 'shots/s1/actual.png', sourceVideo: { assetId: 'previous-video', taskId: 'TEST', runId: 'TEST', sha256: 'a'.repeat(64), atSeconds: 4.9 } });
    p.production!.shots.s1.firstFrameId = 'actual';
    const text = compilePrompt(p, 's1', 'video', 'first_last_frame');
    expect(text.references[0].purpose).toBe('actualEndFrame');
    expect(text.text).toBe(p.plan!.shots[0].prompts.video.final);
    expect(text.references[1].assetId).toBe('last');
  });
  it('缺少 optimized 或截断 JSON 报错；正常短文本可用，不按长度放过错绑', (): void => {
    const p = fixture(); p.plan!.shots[0].prompts.firstFrame.final = '噜妹静坐。';
    expect(compilePrompt(p, 's1', 'firstFrame').text).toContain('噜妹静坐。');
    expect((): unknown => parsePetStoryAnswer('{"optimized":"被截断')).toThrow();
    const model = JSON.parse(JSON.stringify(p.plan)); delete model.shots[0].prompts.video.optimized;
    expect((): unknown => validatePetStoryPlan(model, true)).toThrow('optimized');
    p.plan!.shots[0].prompts.firstFrame.final = `${'很长但错绑。'.repeat(500)}图1：噜妹`;
    expect((): unknown => compilePrompt(p, 's1', 'firstFrame')).toThrow('错绑');
  });
});

let directory: string;
let projects: PetStoryProjects;
let project: PetStoryProject;
beforeEach(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-prompt-quality-'));
  projects = new PetStoryProjects();
  project = await projects.create(directory, 'TEST-studio', 'TEST-account');
  project = await projects.saveSource(project.id, project.revision, 'https://v.douyin.com/TEST/');
  project = await projects.saveMobileStory(project.id, project.revision, 'TEST完整故事原文');
  project.plan = fixture().plan;
  for (const c of project.plan!.characters) c.referenceAssetId = undefined;
  project.source.status = 'review_required'; project.plan!.shots[0].sceneReferenceAssetIds = [];
  project = await projects.write(project);
});
afterEach(async (): Promise<void> => { await fs.rm(directory, { recursive: true, force: true }); });

function chatHarness(): { chat: PetStoryChatService; core: TaskService; tasks: () => Task[] } {
  let stored: Task[] = []; let sequence = 0;
  const tasks = (): Task[] => structuredClone(stored);
  const core = new TaskService({ store: { read: tasks, replace: (value: Task[]): boolean => { stored = structuredClone(value); return true; } }, defaultProjectId: (): string => 'TEST-studio', id: (): string => `TEST-${++sequence}` });
  const chat = new PetStoryChatService(projects, { list: tasks, reviseHeldPrompt: (taskId: string, prompt: string): Task => { const result = core.reviseHeldPrompt(taskId, prompt); if (!result.success) throw new Error(result.error); return result.data; }, create: (input: TaskAddParams, accountId: string): Task => {
    const created = core.create(input); if (!created.success) throw new Error(created.error);
    const assigned = core.assign({ taskId: created.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error); return assigned.data;
  } });
  return { chat, core, tasks };
}
async function finish(h: ReturnType<typeof chatHarness>, task: Task, text: string, jobId: string): Promise<void> {
  const now = new Date().toISOString();
  const runtime: TaskRunSnapshot = { runId: 'TEST-run', attempt: 1, stage: 'completed', message: 'TEST', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
    input: { prompt: task.prompt, mode: task.mode, attachments: task.attachments || [] }, chatResponse: { text, capturedAt: now } };
  expect(h.core.updateRuntime({ taskId: task.id, status: 'done', runtime }).success).toBe(true);
  await h.chat.bindRun(project.id, jobId, runtime.runId);
}

describe('保存、候选和正式任务', (): void => {
  it.each(['before', 'during', 'context', 'unedited'])('重优化保护 %s，未手改且上下文不变才自动采用', async (when: string): Promise<void> => {
    const h = chatHarness();
    if (when === 'before') { const plan = structuredClone(project.plan!); plan.shots[0].prompts.video.final = '用户已确认原文'; project = await projects.savePlan(project.id, project.revision, plan); }
    const prepared = await h.chat.prepare(project.id, 'TEST只优化视频', 'optimize', undefined, 's1', 'video');
    const oldFinal = prepared.project!.plan!.shots[0].prompts.video.final;
    if (when === 'during' || when === 'context') {
      const p = await projects.read(project.id); const plan = structuredClone(p.plan!);
      if (when === 'during') plan.shots[0].prompts.video.final = '请求期间手改'; else plan.shots[0].endState = '用户确认的其他终态';
      project = await projects.savePlan(p.id, p.revision, plan);
    }
    await finish(h, h.tasks()[0], JSON.stringify({ optimized: 'TEST新候选' }), prepared.project!.jobs[0].id);
    const collected = await h.chat.collect(project.id, prepared.project!.jobs[0].id);
    const target = collected.project!.plan!.shots[0].prompts.video;
    expect(target.optimized).toBe('TEST新候选');
    expect(target.final).toBe(when === 'unedited' ? 'TEST新候选' : when === 'during' ? '请求期间手改' : oldFinal);
    const accepted = structuredClone(collected.project!.plan!); accepted.shots[0].prompts.video.final = target.optimized;
    const saved = await projects.savePlan(project.id, collected.project!.revision, accepted);
    const reopened = await new PetStoryProjects().open(directory);
    expect(reopened.plan!.shots[0].prompts.video.final).toBe('TEST新候选');
    expect(reopened.plan!.shots[0].prompts.video.original).toBe(saved.plan!.shots[0].prompts.video.original);
  });
  it('长中文、多段落、引号与分隔符保存重开、DTO、正式 hold 任务全文一致；普通 Studio 不注入预设', async (): Promise<void> => {
    const file = path.join(directory, 'TEST.png'); await fs.writeFile(file, 'TEST离线字节');
    for (const id of ['lulu', 'lumei']) project = await projects.addReference(project.id, id, file);
    project = await projects.bindSharedReference(project.id, project.revision, 'lulu', project.plan!.characters[1].referenceAssetId!);
    const text = `中文“不要改台词”\n\n${'多段落与前爪持物。\n'.repeat(600)}\n%%%%%%%%%%\n结尾不丢失。\n\n`;
    const edited = structuredClone(project.plan!); edited.shots[0].prompts.firstFrame.final = text;
    project = await projects.savePlan(project.id, project.revision, edited);
    const reopened = await new PetStoryProjects().open(directory);
    expect(reopened.plan!.shots[0].prompts.firstFrame.final).toBe(text);
    const compiled = compilePrompt(reopened, 's1', 'firstFrame');
    const h = chatHarness();
    await expect(h.chat.draft(project.id, 's1', 'firstFrame')).rejects.toThrow('确认实际基础图片');
    expect(h.tasks()).toHaveLength(0); expect(compiled.text.endsWith(text)).toBe(true);
    const generic = h.core.create({ prompts: ['普通Studio原文'], mode: 'image' });
    expect(generic.success && generic.data[0].prompt).toBe('普通Studio原文');
  });
  it('替换共享图的单人参考时，其余角色保留旧图；新门禁保留旧 hold 原文且执行后拒绝修改', async (): Promise<void> => {
    const file = path.join(directory, 'TEST.png'); await fs.writeFile(file, 'TEST离线字节');
    project = await projects.addReference(project.id, 'lulu', file);
    const shared = project.plan!.characters[0].referenceAssetId!;
    project = await projects.bindSharedReference(project.id, project.revision, 'lumei', shared);
    project = await projects.addReference(project.id, 'lulu', file);
    expect(orderedChatAssets(project, 's1').map((a): string => a.id)).toEqual([project.plan!.characters[0].referenceAssetId, shared]);
    const h = chatHarness(); const oldFinal = project.plan!.shots[0].prompts.firstFrame.final;
    const attachments = await projects.attachments({ ...project, assets: orderedChatAssets(project, 's1') });
    const created = h.core.create({ prompts: [oldFinal], attachments, mode: 'image', executionIntent: 'hold' });
    if (!created.success) throw new Error(created.error);
    h.core.assign({ taskId: created.data[0].id, accountId: project.accountId });
    project.drafts = [{ taskId: created.data[0].id, shotId: 's1', kind: 'firstFrame', final: oldFinal }];
    project = await projects.write(project);
    await expect(h.chat.draft(project.id, 's1', 'firstFrame')).rejects.toThrow('确认实际基础图片');
    expect(h.tasks()).toHaveLength(1); expect(h.tasks()[0].prompt).toBe(oldFinal);
    h.core.updateStatus({ taskId: created.data[0].id, status: 'done', outputs: [] });
    expect(h.core.reviseHeldPrompt(created.data[0].id, '不应修改').success).toBe(false);
  });
  it('旧项目打开不补写预设，显式保存预设不改已有 final，失败回复不回退', async (): Promise<void> => {
    delete project.promptProfile; project = await projects.write(project);
    const before = await fs.readFile(path.join(directory, 'project.json'), 'utf8');
    const reopened = await new PetStoryProjects().open(directory); expect(reopened.promptProfile).toBeUndefined();
    expect(await fs.readFile(path.join(directory, 'project.json'), 'utf8')).toBe(before);
    const saved = await projects.savePromptProfile(project.id, project.revision, defaultPromptProfile());
    expect(saved.plan).toEqual(project.plan);
    const h = chatHarness(); const prepared = await h.chat.prepare(project.id, 'TEST格式失败', 'optimize', undefined, 's1', 'video');
    await finish(h, h.tasks()[0], '{"optimized":"截断', prepared.project!.jobs[0].id);
    const result = await h.chat.collect(project.id, prepared.project!.jobs[0].id);
    expect(result.success).toBe(false); expect(result.project!.plan).toEqual(project.plan); expect(h.tasks()).toHaveLength(1);
  });
});

describe('发送前真实序列化回读脚本', (): void => {
  it('保留中文和段落，只允许换行规范化；丢段落、少字或改台词零通过', async (): Promise<void> => {
    const text = `噜妹：“我不吃香菜。”\n\n${'完整表演。'.repeat(1000)}\n结尾`;
    const verify = async (actual: string, strict: boolean, count: number = 1, hiddenDuplicate: boolean = false): Promise<boolean> => {
      const webview = { executeJavaScript: async (code: string): Promise<unknown> => vm.runInNewContext(code, { document: { querySelectorAll: (): object[] => Array.from({ length: count }, (_unused, index): object => ({ hidden: hiddenDuplicate && index > 0, offsetParent: {}, disabled: false, getAttribute: (): null => null,
        getBoundingClientRect: (): object => ({ width: 600, height: 200, top: 10 }), tagName: 'TEXTAREA', value: actual })) }, window: { innerHeight: 900, getComputedStyle: (e: { hidden: boolean }): object => ({ visibility: e.hidden ? 'hidden' : 'visible', display: 'block' }) } }),
        loadURL: (): void => {}, getURL: (): string => 'https://www.doubao.com/chat/' } as WebviewHandle;
      return verifyPromptReadyForSubmission(webview, text, strict);
    };
    expect(await verify(text, true)).toBe(true);
    expect(await verify(text, true, 2)).toBe(false);
    expect(await verify(text, true, 2, true)).toBe(true);
    expect(await verify(text + ' ', true)).toBe(false);
    expect(await verify(text.replace(/\n/g, '\r\n'), true)).toBe(true);
    expect(await verify(text.replace(/\n+/g, ' '), true)).toBe(false);
    expect(await verify(text.replace('不吃', '爱吃'), true)).toBe(false);
    expect(await verify(text.slice(0, -3), true)).toBe(false);
    expect(await verify(text.replace(/\n+/g, ' '), false)).toBe(true);
  });
  it('首次请求包含完整专用预设及必要规则，不伪称看过原视频', (): void => {
    const p = fixture(); p.plan = undefined; p.assets = [];
    const input = analysisPrompt(p);
    expect(input).toContain('完整小橘子'); expect(input).toContain('盘／环状'); expect(input).toContain('不声称看过原视频');
  });
});

describe('原生多段落输入的真实序列化探针', (): void => {
  it.each(['TEXTAREA', 'DIV'])('只写入可见 %s，隐藏副本不抢占；不用兼容路径折叠段落', async (tag: string): Promise<void> => {
    const { insertExactComposerText } = await import('../../src/utils/exactComposer');
    const value = '中文“台词”。\n\n第二段\n末段'; let selected = false; const commands: unknown[][] = [];
    const editor = { tagName: tag, offsetParent: {}, disabled: false, getAttribute: (): null => null, closest: (): null => null,
      getBoundingClientRect: (): object => ({ width: 500, height: 200, top: 20 }), focus: (): void => {}, select: (): void => { selected = true; }, hidden: false };
    const doc = { querySelectorAll: (): object[] => [{ ...editor, hidden: true }, editor],
      createRange: (): object => ({ selectNodeContents: (): void => { selected = true; } }),
      execCommand: (...args: unknown[]): boolean => { commands.push(args); return true; } };
    const view = { innerHeight: 900, getComputedStyle: (e: { hidden: boolean }): object => ({ display: 'block', visibility: e.hidden ? 'hidden' : 'visible' }),
      getSelection: (): object => ({ removeAllRanges: (): void => {}, addRange: (): void => {} }) };
    expect(vm.runInNewContext(`(${insertExactComposerText.toString()})(${JSON.stringify(value)})`, { document: doc, window: view })).toBe(true);
    expect(selected).toBe(true); expect(commands).toEqual([['insertText', false, value]]);
    doc.querySelectorAll = (): object[] => [editor, editor]; commands.length = 0;
    expect(vm.runInNewContext(`(${insertExactComposerText.toString()})(${JSON.stringify(value)})`, { document: doc, window: view })).toBe(false);
    expect(commands).toEqual([]);
  });
});

describe('富文本逻辑段落与布局空行', (): void => {
  it('按原生逐段 P 回读，保留真实空段，忽略 innerText 额外布局换行', async (): Promise<void> => {
    const { readExactComposerText } = await import('../../src/utils/exactComposer');
    const p = (text: string): object => ({ tagName: 'P', textContent: text, querySelector: (): null => null });
    const editor = { tagName: 'DIV', children: [p('中文“台词”'), p(''), p('第二段'), p('')], innerText: '中文“台词”\n\n\n\n第二段\n\n' };
    const result = vm.runInNewContext(`(${readExactComposerText.toString()})(editor)`, { editor });
    expect(result).toBe('中文“台词”\n\n第二段\n');
    editor.children.splice(1, 1);
    expect(vm.runInNewContext(`(${readExactComposerText.toString()})(editor)`, { editor })).not.toBe(result);
  });
});
