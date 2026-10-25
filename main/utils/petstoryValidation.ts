import type { PetStoryPlan, PetStoryShot, PetStoryCharacter, PetStoryPrompt, PetStoryMode } from '@doubao-studio/contracts';

export const PETSTORY_RULES_VERSION = 'petstory-r11-v1';
const MODES: PetStoryMode[] = ['auto', 'first_frame', 'first_last_frame', 'reference'];
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要 JSON 对象');
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field}不能为空`);
  return value;
}
function id(value: unknown, field: string): string {
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
function prompt(value: unknown, field: string, model: boolean): PetStoryPrompt {
  const p = record(value);
  const original = text(p.original, `${field}.original`);
  const optimized = model ? text(p.optimized, `${field}.optimized`) : typeof p.optimized === 'string' ? p.optimized : ''; 
  return { original, optimized, final: model ? optimized : text(p.final, `${field}.final`),
    edited: !model && p.edited === true, rulesVersion: !model && p.rulesVersion === 'manual' ? 'manual' : PETSTORY_RULES_VERSION };
}
/** 模型只提供故事与逻辑引用；实际资产、任务 ID、路径及最终模式不接受模型赋值。 */
export function validatePetStoryPlan(value: unknown, model: boolean = false): PetStoryPlan {
  const p = record(value);
  const characters = array(p.characters, 'characters').map((value: unknown): PetStoryCharacter => {
    const c = record(value);
    if (!['main', 'supporting'].includes(String(c.role))) throw new Error('角色 role 无效');
    return { id: id(c.id, '角色 ID'), name: text(c.name, '角色名称'), role: c.role as PetStoryCharacter['role'],
      purpose: text(c.purpose, '剧情作用'), description: text(c.description, '角色外观'),
      referenceAssetId: !model && typeof c.referenceAssetId === 'string' ? c.referenceAssetId : undefined };
  });
  unique(characters.map((c: PetStoryCharacter): string => c.id), 'characters');
  for (const [charId, name] of [['lulu', '噜噜'], ['lumei', '噜妹']]) {
    if (!characters.some((c: PetStoryCharacter): boolean => c.id === charId && c.name === name && c.role === 'main')) {
      throw new Error(`固定主演 ${name}（${charId}）缺失或身份被更改`);
    }
  }
  if (characters.filter((c: PetStoryCharacter): boolean => c.role === 'main').length !== 2) throw new Error('其他必要角色应为 supporting');
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
    const lastFrame = prompts.lastFrame === undefined ? undefined : prompt(prompts.lastFrame, `${shotId}.lastFrame`, model);
    if (s.requestedMode === 'first_last_frame' && !lastFrame) throw new Error(`${shotId}首尾帧模式缺少尾帧提示词`);
    return { id: shotId, order: index + 1, characterIds: refs, sceneReferenceAssetIds: !model && Array.isArray(s.sceneReferenceAssetIds) ? s.sceneReferenceAssetIds.map((v: unknown): string => id(v, '场景素材引用')) : undefined, scene: text(s.scene, `${shotId}.scene`),
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
  });
  return { sourceSummary: text(p.sourceSummary, '原片梗概'), adaptedStory: text(p.adaptedStory, '相似故事'), characters, shots };
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
