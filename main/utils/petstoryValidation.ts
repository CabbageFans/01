import type { PetStoryPlan, PetStoryShot, PetStoryCharacter, PetStoryPrompt, PetStoryMode, PetStoryProp, PetStoryScene, PetStoryMaterialEditIntent, PetStoryPromptTaskContract, PetStoryPromptReference, PetStoryProject, PetStoryChatJob } from '@doubao-studio/contracts';

export { PROMPT_RULES_VERSION as PETSTORY_RULES_VERSION } from './petstoryPromptQuality';
import { compileReferencedText, PROMPT_RULES_VERSION as PETSTORY_RULES_VERSION } from './petstoryPromptQuality';
const MODES: PetStoryMode[] = ['auto', 'first_frame', 'first_last_frame', 'reference'];
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要 JSON 对象');
  return value as Record<string, unknown>;
}
export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field}不能为空`);
  return value;
}
export function id(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field}必须是字符串（例如 shot_1），不能使用数字或 null`);
  const result = text(value, field);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(result)) throw new Error(`${field}必须为稳定的字母数字 ID`);
  return result;
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${field}必须是非空数组`);
  return value;
}
function unique(ids: string[], field: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${field}有重复 ID`);
}
function uniqueEntities(entities: { id: string; name: string; aliases?: string[] }[]): void {
  const names = new Map<string, string>();
  for (const entity of entities) for (const label of [entity.name, ...(entity.aliases || [])]) {
    const key = label.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
    if (!key) continue;
    if (names.has(key) && names.get(key) !== entity.id) throw new Error('同名或别名资产重复，请复用同一实体ID或明确区分');
    names.set(key, entity.id);
  }
}
function characterArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('characters必须是数组');
  return value;
}
function prompt(value: unknown, field: string, model: boolean): PetStoryPrompt {
  const p = record(value);
  const original = text(p.original, `${field}.original`);
  const optimized = model ? text(p.optimized, `${field}.optimized`) : typeof p.optimized === 'string' ? p.optimized : ''; 
  return { original, optimized, final: model ? optimized : text(p.final, `${field}.final`),
    edited: !model && p.edited === true, rulesVersion: !model && typeof p.rulesVersion === 'string' ? p.rulesVersion : PETSTORY_RULES_VERSION,
    candidateJobId: !model && typeof p.candidateJobId === 'string' ? p.candidateJobId : undefined,
    sourceJobId: !model && typeof p.sourceJobId === 'string' ? p.sourceJobId : undefined, needsReview: !model && p.needsReview === true ? true : undefined,
    editIntent: !model && p.editIntent ? validateEditIntent(p.editIntent) : undefined,
    promptTask: !model && p.promptTask ? validatePromptTask(p.promptTask) : undefined };
}
/** 只校验已保存的任务事实，不从正文推断或补造素材用途。 */
export function validatePromptTask(value: unknown): PetStoryPromptTaskContract {
  const task = record(value);
  if (!['seedance20', 'seedance25', 'seedream', 'generic'].includes(String(task.dialect)) || !Array.isArray(task.references)
    || task.mode !== undefined && !['first_frame', 'first_last_frame', 'reference'].includes(String(task.mode))) throw new Error('正文的目标方言或引用计划无效');
  const references = task.references.map((value: unknown, index: number): PetStoryPromptReference => {
    const ref = record(value);
    if (ref.order !== index + 1 || !['identity', 'prop', 'scene', 'firstFrame', 'plannedEndImage', 'actualEndFrame'].includes(String(ref.purpose))
      || !Array.isArray(ref.characterIds) || ref.characterIds.some((id: unknown): boolean => typeof id !== 'string' || !id.trim())
      || ref.slot !== undefined && !['first', 'last'].includes(String(ref.slot))) throw new Error('正文的目标素材顺序或用途无效');
    return { assetId: text(ref.assetId, '目标素材身份'), order: index + 1, purpose: ref.purpose as PetStoryPromptReference['purpose'],
      characterIds: [...ref.characterIds] as string[], materialId: optionalText(ref.materialId, '目标素材ID'), entityId: optionalText(ref.entityId, '目标实体ID'), slot: ref.slot as PetStoryPromptReference['slot'] };
  });
  return { references, dialect: task.dialect as PetStoryPromptTaskContract['dialect'], mode: task.mode as PetStoryPromptTaskContract['mode'] };
}

function runtimeReferenceIssues(project: PetStoryProject, job: PetStoryChatJob, body: string): string[] {
  const issues: string[] = [];
  const task = job.promptTask;
  if (task) {
    // 所有方言都在采用前走同一引用解析；Seedream 中文编号和逻辑 ID 也不能带错保存。
    try { compileReferencedText(project, body, task.references); }
    catch (error: unknown) { issues.push(error instanceof Error ? error.message : '正文引用无法按本次素材标签表解析'); }
    const found = [...body.matchAll(/@图片\s*(\d+)/g)].map((match): number => Number(match[1]));
    if (found.some((order): boolean => !Number.isInteger(order) || order < 1 || order > task.references.length)) issues.push('正文中的 @图片 编号超出本次目标生成素材标签表');
    if (/@图片(?!\s*[1-9]\d*)/.test(body)) issues.push('正文含无法按本次标签表解析的 @图片 引用');
    if (/@(?:视频|音频)\s*\d+/.test(body)) issues.push('正文引用了本次目标素材表没有提供的视频或音频标签');
    if (/@(?:Image|Video|Audio)\b/i.test(body)) issues.push('正文使用了本次标签表未约定的英文媒体引用，需沿用目标标签');
    if (task.dialect === 'seedance20' || task.dialect === 'seedance25') {
      if (job.promptKind === 'video' && /@(?:\s+图片\s*|图片\s+)\d/u.test(body)) issues.push('Seedance 目标标签内部含空白；请由模型按本次标签表完整返回紧凑的 @图片N，不使用空格或换行分隔');
      const missing = task.references.filter((ref): boolean => !found.includes(ref.order)).map((ref): string => `@图片${ref.order}`);
      if (missing.length) issues.push(`Seedance 正文未在相关位置使用本次目标素材标签：${missing.join('、')}`);
      if (job.promptKind === 'video' && !body.includes('全程无字幕、无对白文字叠加。')) issues.push('Seedance 正文缺少本次明确约定的字幕约束句：全程无字幕、无对白文字叠加。');
    }
  }
  return issues;
}
/** 仅检查可证明的返回契约缺项，不用字数或关键词数量判断创作质量。 */
export function runtimePromptIssues(project: PetStoryProject, job: PetStoryChatJob, body: string): string[] {
  const issues: string[] = [];
  if (!body.trim()) return ['本次回复缺少完整创作正文'];
  if (/(?:file:\/\/|\/(?:Users|home|tmp)\/|[A-Za-z]:\\)/.test(body)) issues.push('正文包含本机文件路径，不能将路径当作已上传素材');
  issues.push(...runtimeReferenceIssues(project, job, body));
  const shot = project.plan?.shots.find((item): boolean => item.id === job.shotId);
  if (job.promptKind !== 'video' || !shot) return issues;
  const dialect = job.promptTask?.dialect;
  const seedance = dialect === 'seedance20' || dialect === 'seedance25';
  if (seedance && /<声音(?:\s[^>]*)?>[\s\S]*?<\/声音\s*>|<\/声音\s*>/u.test(body)) issues.push('Seedance 声音指令使用了本次明令禁止的 XML 成对标签；每个实际声音内容应写在单一一对尖括号内，不使用 <声音>…</声音>');
  const blocks = body.match(/\{[^{}]*\}/g) || [];
  const spoken = blocks.flatMap((block): { name: string; language: string; text: string }[] => {
    const match = block.match(/^\{\s*([\s\S]*?)用([^{}]+?)说\s*[：:]\s*([\s\S]*?)\s*\}$/u);
    if (!match) return [];
    const utterance = match[3].trim();
    const quoted = /^“[\s\S]*”$|^"[\s\S]*"$|^「[\s\S]*」$|^『[\s\S]*』$/u.test(utterance);
    return [{ name: match[1].trim(), language: match[2].trim(), text: quoted ? utterance.slice(1, -1) : utterance }];
  });
  const checked = new Set<string>();
  const dialogues = shot.dialogue || [];
  for (const dialogue of dialogues) {
    if (!body.includes(dialogue.text)) { issues.push(`视频正文遗漏已确认原台词：${dialogue.text}`); continue; }
    if (!seedance) continue;
    const name = project.plan?.characters.find((character): boolean => character.id === dialogue.speakerId)?.name || dialogue.speakerId;
    const chinese = /\p{Script=Han}/u.test(dialogue.text);
    const key = JSON.stringify([dialogue.speakerId, dialogue.text]);
    if (checked.has(key)) continue;
    checked.add(key);
    const expected = dialogues.filter((line): boolean => line.speakerId === dialogue.speakerId && line.text === dialogue.text).length;
    const actual = spoken.filter((line): boolean => line.name === name && line.text === dialogue.text && (!chinese || line.language === '中文')).length;
    if (actual === 0) issues.push(`Seedance 台词未按花括号声音格式返回：${name}的原台词需整体置于 {角色用${chinese ? '中文' : '原语言'}说：“逐字台词”} 中`);
    else if (actual !== expected) issues.push(`Seedance 原台词发声次数与确认剧本不符：${name}的“${dialogue.text}”应发声${expected}次，实际${actual}次；每次只写一个对应声音块`);
  }
  return [...new Set(issues)];
}
export function validateEditIntent(value: unknown): PetStoryMaterialEditIntent {
  const intent = record(value);
  return { baseAssetId: text(intent.baseAssetId, '编辑基图'), changes: text(intent.changes, '修改内容'), preserve: text(intent.preserve, '编辑保留项'), validity: text(intent.validity, '变体适用范围') };
}
function appearances(value: unknown, ids: string[]): Record<string, string> {
  const result = record(value);
  for (const [id, setting] of Object.entries(result)) {
    if (!ids.includes(id) || typeof setting !== 'string') throw new Error('本镜造型必须对应出场角色与文本');
  }
  return result as Record<string, string>;
}
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field}必须为文本`);
  return value;
}
function directingFields(s: Record<string, unknown>): Pick<PetStoryShot, 'sourceRefs' | 'narrativePurpose' | 'framing' | 'blocking' | 'performance' | 'sound' | 'timing' | 'continuity'> {
  if (s.sourceRefs !== undefined && (!Array.isArray(s.sourceRefs) || s.sourceRefs.some((v: unknown): boolean => typeof v !== 'string'))) throw new Error('镜头来源必须为文本数组');
  return { sourceRefs: s.sourceRefs as string[] | undefined,
    narrativePurpose: optionalText(s.narrativePurpose, '镜头职责'), framing: optionalText(s.framing, '构图'), blocking: optionalText(s.blocking, '空间调度'),
    performance: optionalText(s.performance, '表演'), sound: optionalText(s.sound, '声音'), timing: optionalText(s.timing, '时长分配'), continuity: optionalText(s.continuity, '连续性') };
}
function ids(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field}必须为数组`);
  const result = value.map((v: unknown): string => id(v, field)); unique(result, field); return result;
}
function origin(value: unknown): 'script' | 'proposed' {
  if (!['script', 'proposed'].includes(String(value))) throw new Error('设计来源必须注明 script 或 proposed');
  return value as 'script' | 'proposed';
}
function props(value: unknown): PetStoryProp[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('props必须为数组');
  return value.map((value: unknown): PetStoryProp => {
    const p = record(value);
    if (!Array.isArray(p.aliases) || p.aliases.some((v: unknown): boolean => typeof v !== 'string')) throw new Error('道具 aliases 必须为文本数组');
    return { id: id(p.id, '道具ID'), name: text(p.name, '道具名称'), aliases: p.aliases as string[], description: text(p.description, '道具外观'),
      keyStates: text(p.keyStates, '道具状态'), scale: optionalText(p.scale, '道具比例') || '', appearanceState: optionalText(p.appearanceState, '道具静态外观状态'), designOrigin: origin(p.designOrigin) };
  });
}
function scenes(value: unknown): PetStoryScene[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('scenes必须为数组');
  return value.map((value: unknown): PetStoryScene => {
    const s = record(value);
    return { id: id(s.id, '场景ID'), name: text(s.name, '场景名称'), location: text(s.location, '地点'), time: text(s.time, '时间或未指定说明'),
      lighting: text(s.lighting, '光线或待确认说明'), layout: text(s.layout, '空间关系'), view: text(s.view, '场景视角'),
      parentSceneId: s.parentSceneId === undefined ? undefined : id(s.parentSceneId, '主场景ID'), designOrigin: origin(s.designOrigin) };
  });
}
function legacySceneReferences(s: Record<string, unknown>, model: boolean): string[] | undefined {
  return !model && Array.isArray(s.sceneReferenceAssetIds) ? s.sceneReferenceAssetIds.map((v: unknown): string => id(v, '场景素材引用')) : undefined;
}
function requireDialogueInCandidate(model: boolean, dialogue: PetStoryShot['dialogue'], video: unknown, shotId: string): void {
  if (model && dialogue?.some((d): boolean => !text(record(video).optimized, '视频候选').includes(d.text))) throw new Error(`${shotId}视频提示词遗漏剧本已有台词`);
}
/** 模型只提供故事与逻辑引用；实际资产、任务 ID、路径及最终模式不接受模型赋值。 */
export function validatePetStoryPlan(value: unknown, model: boolean = false): PetStoryPlan {
  const p = record(value);
  const characters = characterArray(p.characters).map((value: unknown): PetStoryCharacter => {
    const c = record(value);
    if (!['main', 'supporting'].includes(String(c.role))) throw new Error('角色 role 无效');
    return { id: id(c.id, '角色 ID'), name: text(c.name, '角色名称'), role: c.role as PetStoryCharacter['role'],
      purpose: text(c.purpose, '剧情作用'), description: text(c.description, '角色外观'),
      designOrigin: c.designOrigin === undefined ? undefined : origin(c.designOrigin), continuity: optionalText(c.continuity, '稳定特征'),
      aliases: c.aliases === undefined ? undefined : Array.isArray(c.aliases) && c.aliases.every((v: unknown): boolean => typeof v === 'string') ? c.aliases as string[] : (() : never => { throw new Error('角色别名无效'); })(),
      referenceAssetId: !model && typeof c.referenceAssetId === 'string' ? c.referenceAssetId : undefined };
  });
  unique(characters.map((c: PetStoryCharacter): string => c.id), 'characters');
  uniqueEntities(characters);
  const planProps = props(p.props); const planScenes = scenes(p.scenes);
  if ((planProps === undefined) !== (planScenes === undefined)) throw new Error('道具和场景集合必须一起提供');
  unique((planProps || []).map((p): string => p.id), 'props'); unique((planScenes || []).map((s): string => s.id), 'scenes');
  uniqueEntities(planProps || []);
  const places = (planScenes || []).filter((s): boolean => !s.parentSceneId).map((s): string => `${s.location.normalize('NFKC').replace(/\s+/g, '')}|${s.time}`);
  if (new Set(places).size !== places.length) throw new Error('同地点同时间的主场景重复；切镜复用ID，派生视角指向主图');
  const characterIds = new Set(characters.map((c: PetStoryCharacter): string => c.id));
  const shots = array(p.shots, 'shots').map((value: unknown, index: number): PetStoryShot => {
    const s = record(value);
    const shotId = id(s.id, '镜头 ID');
    if (s.order !== index + 1) throw new Error(`${shotId}顺序必须与列表一致（从 1 开始）`);
    if (!Array.isArray(s.characterIds)) throw new Error(`${shotId}.characterIds 必须是数组`);
    const refs = s.characterIds.map((v: unknown): string => id(v, '角色引用'));
    unique(refs, `${shotId}.characterIds`);
    if (refs.some((ref: string): boolean => !characterIds.has(ref))) throw new Error(`${shotId}引用未知角色`);
    const duration = s.durationSeconds;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 5 || duration > 10) {
      throw new Error(`${shotId}时长必须是 5～10 秒内的有限数值`);
    }
    if (!['cut', 'continue'].includes(String(s.transition))) throw new Error(`${shotId}切镜关系无效`);
    if (!MODES.includes(s.requestedMode as PetStoryMode)) throw new Error(`${shotId}模式无效`);
    const prompts = record(s.prompts);
    const propIds = s.propIds === undefined ? undefined : ids(s.propIds, `${shotId}.propIds`);
    const sceneId = s.sceneId === undefined ? undefined : id(s.sceneId, '场景引用');
    if (planScenes && (!sceneId || !planScenes.some((sc): boolean => sc.id === sceneId) || !propIds || propIds.some((id): boolean => !planProps?.some((prop): boolean => prop.id === id)))) throw new Error(`${shotId}场景或道具引用缺失／未知`);
    let propStates: PetStoryShot['propStates'];
    if (s.propStates !== undefined) {
      if (!Array.isArray(s.propStates)) throw new Error('道具持有状态必须为数组');
      propStates = s.propStates.map((value: unknown): NonNullable<PetStoryShot['propStates']>[number] => {
        const state = record(value); const propId = id(state.propId, '道具状态ID'); const holderId = state.holderId === undefined ? undefined : id(state.holderId, '持有人');
        if (!propIds?.includes(propId) || (holderId && !refs.includes(holderId))) throw new Error('道具状态必须属于本镜道具与出场人物');
        return { propId, holderId, state: text(state.state, '本镜道具状态') };
      });
      unique(propStates.map((p): string => p.propId), '道具状态');
    }
    if (planProps && propIds?.some((id): boolean => !propStates?.some((s): boolean => s.propId === id))) throw new Error(`${shotId}缺少道具状态／持有者说明`);
    let dialogue: PetStoryShot['dialogue'];
    if (s.dialogue !== undefined) {
      if (!Array.isArray(s.dialogue)) throw new Error('台词必须为数组');
      dialogue = s.dialogue.map((value: unknown): NonNullable<PetStoryShot['dialogue']>[number] => {
        const d = record(value); const speakerId = id(d.speakerId, '说话者');
        const delivery = d.delivery;
        if (delivery !== undefined && !['onscreen', 'offscreen', 'voiceover'].includes(String(delivery))) throw new Error('台词发声方式无效');
        if (!characterIds.has(speakerId) || (!refs.includes(speakerId) && (!delivery || delivery === 'onscreen'))) throw new Error('画内台词说话者必须出场；OS／VO必须对应已有角色');
        return { speakerId, text: text(d.text, '已有台词'), tone: optionalText(d.tone, '语气') || '', pace: optionalText(d.pace, '节奏') || '', delivery: delivery as 'onscreen' | 'offscreen' | 'voiceover' | undefined };
      });
    }
    const lastFrame = prompts.lastFrame === undefined ? undefined : prompt(prompts.lastFrame, `${shotId}.lastFrame`, model);
    if (s.requestedMode === 'first_last_frame' && !lastFrame) throw new Error(`${shotId}首尾帧模式缺少尾帧提示词`);
    requireDialogueInCandidate(model, dialogue, prompts.video, shotId);
    return { id: shotId, order: index + 1, characterIds: refs, sceneReferenceAssetIds: legacySceneReferences(s, model), scene: text(s.scene, `${shotId}.scene`),
      propIds, propStates, sceneId, sceneView: optionalText(s.sceneView, '视角'), dialogue,
      expression: optionalText(s.expression, '神态'), gaze: optionalText(s.gaze, '视线'), interaction: optionalText(s.interaction, '互动'), camera: optionalText(s.camera, '镜头方式'),
      ...directingFields(s),
      appearanceOverrides: s.appearanceOverrides === undefined ? undefined : appearances(s.appearanceOverrides, refs),
      action: text(s.action, `${shotId}.action`), startState: text(s.startState, `${shotId}.startState`),
      endState: text(s.endState, `${shotId}.endState`), durationSeconds: duration,
      transition: s.transition as PetStoryShot['transition'],
      previousShotId: s.previousShotId === undefined ? undefined : id(s.previousShotId, '前镜头引用'),
      requestedMode: s.requestedMode as PetStoryMode,
      prompts: { firstFrame: prompt(prompts.firstFrame, `${shotId}.firstFrame`, model), lastFrame,
        video: prompt(prompts.video, `${shotId}.video`, model) } };
  });
  unique(shots.map((s: PetStoryShot): string => s.id), 'shots');
  shots.forEach((s: PetStoryShot, i: number): void => {
    if (s.transition === 'continue' && (i === 0 || s.previousShotId !== shots[i - 1].id)) throw new Error(`${s.id}连续引用必须指向相邻上一镜头`);
    if (s.transition === 'cut' && s.previousShotId !== undefined) throw new Error(`${s.id}切镜不应绑定上一镜头`);
    if (s.transition === 'continue' && s.sceneId && s.sceneId !== shots[i - 1]?.sceneId) throw new Error('真实跨场景必须切镜，不能直接沿用前镜末帧');
  });
  for (const sc of planScenes || []) {
    const seen = new Set<string>([sc.id]); let current = sc;
    while (current.parentSceneId) {
      const parent = planScenes?.find((s): boolean => s.id === current.parentSceneId);
      if (!parent || seen.has(parent.id)) throw new Error('场景主图引用不存在或循环');
      if (parent.location !== sc.location) throw new Error('派生视角必须属于同一地点');
      seen.add(parent.id); current = parent;
    }
  }
  return { sourceSummary: text(p.sourceSummary, '原片梗概'), adaptedStory: text(p.adaptedStory, '相似故事'), characters, props: planProps, scenes: planScenes, shots,
    understanding: optionalText(p.understanding, '剧本理解与来源映射'), sceneDesign: optionalText(p.sceneDesign, '全场空间与调度') };
}
export function parsePetStoryAnswer(raw: string): Record<string, unknown> {
  // 页面代码块可能在围栏前额外带一个语言标签；只移除紧邻 json 围栏的该标签，原文另存不变。
  const value = raw.trim().replace(/^json[ \t]*\n\s*(?=```json(?:\s|$))/i, '');
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(value);
  return record(JSON.parse(fenced ? fenced[1] : value));
}
/** 只识别分享文本，不访问、下载或解析平台视频。 */
export function extractDouyinLink(value: string): string {
  const links = value.match(/https?:\/\/[^\s<>"，。！；）】]+/g) || [];
  const valid = links.flatMap((candidate: string): string[] => {
    try {
      const url = new URL(candidate.replace(/[)\].,;!]+$/, ''));
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return [];
      if (!['v.douyin.com', 'www.douyin.com', 'douyin.com'].includes(url.hostname)) return [];
      if (url.pathname === '/') return [];
      url.hash = '';
      return [url.toString()];
    } catch { return []; }
  });
  if (new Set(valid).size !== 1) throw new Error('请输入一条抖音视频分享链接；不接受本地原视频或其他站点');
  return valid[0];
}
