import type { PetStoryAsset, PetStoryCompiledPrompt, PetStoryProject, PetStoryPrompt, PetStoryPromptKind, PetStoryPromptProfile, PetStoryPromptReference, PetStoryResolvedMode, PetStoryShot } from '@doubao-studio/contracts';
import presets from './petstoryPresets.json';
import { materialAsset, requireApprovedMaterials, requireMaterialPromptSource, shotMaterialReferences } from './petstoryMaterials';
import { renderReferenceSegments } from './petstoryReferenceText';
import { requirePromptEligibility } from './petstoryEligibility';

export const PROMPT_RULES_VERSION = presets.version;
export function defaultPromptProfile(): PetStoryPromptProfile { return structuredClone(presets.profile) as PetStoryPromptProfile; }
export function assetCharacterIds(asset: PetStoryAsset): string[] { return asset.characterIds || (asset.characterId ? [asset.characterId] : []); }
export function identityAsset(p: PetStoryProject, characterId: string): PetStoryAsset | undefined {
  const char = p.plan?.characters.find((c): boolean => c.id === characterId);
  return [...p.assets].reverse().find((a): boolean => a.kind === 'character' && assetCharacterIds(a).includes(characterId) && (!char?.referenceAssetId || a.id === char.referenceAssetId));
}
/** 使用角色显式选择，支持一张同框图约束多人；去重保留第一次出现的顺序。 */
export function orderedChatAssets(p: PetStoryProject, shotId?: string): PetStoryAsset[] {
  const shot = p.plan?.shots.find((s): boolean => s.id === shotId);
  if (shot && p.materials) {
    const keys = [...shot.characterIds.map((id): string => `character:${id}`), ...(shot.propIds || []).map((id): string => `prop:${id}`), ...(shot.sceneId ? [`scene:${shot.sceneId}`] : [])];
    const selected = keys.flatMap((key): PetStoryAsset[] => { const m = p.materials?.find((m): boolean => m.id === key); const a = p.assets.find((a): boolean => a.id === m?.selectedAssetId); return a ? [a] : []; });
    return [...new Map(selected.map((a): [string, PetStoryAsset] => [a.id, a])).values()];
  }
  const ids = shot?.characterIds || p.plan?.characters.map((c): string => c.id) || ['lulu', 'lumei'];
  const selected = ids.flatMap((id): PetStoryAsset[] => { const a = identityAsset(p, id); return a ? [a] : []; });
  if (shot) selected.push(...(shot.sceneReferenceAssetIds || []).flatMap((id): PetStoryAsset[] => p.assets.filter((a): boolean => a.id === id && a.kind === 'scene' && a.shotId === shot.id)));
  return [...new Map(selected.map((a): [string, PetStoryAsset] => [a.id, a])).values()];
}
export function promptContextHashInput(p: PetStoryProject, shotId?: string): object {
  const shot = p.plan?.shots.find((s): boolean => s.id === shotId);
  return { shot, props: p.plan?.props, scenes: p.plan?.scenes, materials: p.materials, characters: p.plan?.characters.filter((c): boolean => !shot || shot.characterIds.includes(c.id)), profile: p.promptProfile,
    assets: orderedChatAssets(p, shotId).map((a): object => ({ id: a.id, characters: assetCharacterIds(a), kind: a.kind })) };
}
function must<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value; }
export function promptReferences(p: PetStoryProject, shot: PetStoryShot, kind: PetStoryPromptKind, mode?: PetStoryResolvedMode, planned = false): PetStoryPromptReference[] {
  const refs: PetStoryPromptReference[] = [];
  const append = (assetId: string, purpose: PetStoryPromptReference['purpose'], characterIds: string[], slot?: 'first' | 'last'): void => {
    const previous = refs.find((r): boolean => r.assetId === assetId);
    if (previous) { previous.characterIds = [...new Set([...previous.characterIds, ...characterIds])]; return; }
    refs.push({ assetId, purpose, characterIds, slot, order: refs.length + 1 });
  };
  if (kind === 'firstFrame' && p.materials) {
    refs.push(...shotMaterialReferences(p, shot, planned));
    const actual = p.assets.find((a): boolean => a.id === p.production?.shots[shot.id]?.actualEndFrameId && a.kind === 'actualEndFrame' && !!a.sourceVideo);
    if (actual) refs.push({ assetId: actual.id, characterIds: shot.characterIds, order: refs.length + 1, purpose: 'actualEndFrame' });
    // 连续镜的实际末帧在制作后才落地；提前保留同用途计划引用，落地仅映射编号。
    else if (planned && shot.transition === 'continue') refs.push({ assetId: 'pending:previous-end', characterIds: shot.characterIds, order: refs.length + 1, purpose: 'actualEndFrame' });
  } else if (kind === 'firstFrame') {
    for (const id of shot.characterIds) {
      const a = identityAsset(p, id);
      if (!a && !planned) throw new Error(`${id}缺少或错绑身份参考图`);
      append(a?.id || `pending:${id}`, 'identity', [id]);
    }
    for (const id of shot.sceneReferenceAssetIds || []) {
      if (!p.assets.some((a): boolean => a.id === id && a.kind === 'scene' && a.shotId === shot.id)) throw new Error('场景参考图错绑');
      append(id, 'scene', []);
    }
  } else {
    appendFrameReferences(p, shot, kind, mode, planned, append);
    if (kind === 'video' && mode === 'reference' && p.materials) {
      for (const ref of shotMaterialReferences(p, shot, planned)) {
        if (refs.some((r): boolean => r.assetId === ref.assetId)) continue;
        refs.push({ ...ref, order: refs.length + 1 });
      }
    }
  }

  return refs;
}
function appendFrameReferences(p: PetStoryProject, shot: PetStoryShot, kind: PetStoryPromptKind, mode: PetStoryResolvedMode | undefined, planned: boolean,
  append: (id: string, purpose: PetStoryPromptReference['purpose'], ids: string[], slot?: 'first' | 'last') => void): void {
    const media = p.production?.shots[shot.id];
    const first = p.assets.find((a): boolean => a.id === media?.firstFrameId);
    if (!first && !planned) throw new Error('缺少本镜实际首帧');
    if (first && !['firstFrame', 'actualEndFrame'].includes(first.kind)) throw new Error('计划尾帧不能作为实际首帧');
    if (first?.kind === 'actualEndFrame' && !first.sourceVideo) throw new Error('实际末帧缺少源视频');
    append(first?.id || 'pending:first', first?.kind === 'actualEndFrame' ? 'actualEndFrame' : 'firstFrame', shot.characterIds, kind === 'video' && mode !== 'reference' ? 'first' : undefined);
    if (kind === 'video' && mode === 'first_last_frame') {
      const last = p.assets.find((a): boolean => a.id === media?.plannedEndImageId && a.kind === 'plannedEndImage' && a.shotId === shot.id);
      if (!last && !planned) throw new Error('缺少本镜计划尾帧');
      append(last?.id || 'pending:last', 'plannedEndImage', shot.characterIds, 'last');
    }
}

function referenceNumber(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let result = 0; let digit = 0;
  for (const token of value) { if (token in digits) digit = digits[token]; else if (token in units) { result += (digit || 1) * units[token]; digit = 0; } else return NaN; }
  return result + digit;
}
/** 只阻断可证明的错绑；不靠关键词数量或字数推断质量。 */
export function checkPromptReferences(final: string, p: PetStoryProject, refs: PetStoryPromptReference[]): void {
  if (!final.trim()) throw new Error('最终提示词为空');
  if (/(?:file:\/\/|\/(?:Users|home|tmp)\/|[A-Za-z]:\\)/.test(final)) throw new Error('最终提示词包含文件路径，不能当作已上传素材');
  if (/@(?:Image|Video|Audio)\b/i.test(final)) throw new Error('未验证的平台专用引用语法');
  const matches = final.matchAll(/(?:第\s*([0-9零一二两三四五六七八九十百千]+)\s*张(?:参考)?图|(?:参考)?图\s*([0-9一二两三四五六七八九十百千]+)|@图片\s*(\d+))/g);
  for (const match of matches) {
    const ref = refs.find((item): boolean => item.order === referenceNumber(match[1] || match[2] || match[3]));
    if (!ref) throw new Error('最终提示词图片编号没有对应实际上传');
    const after = final.slice((match.index || 0) + match[0].length).match(/^[\s：:=（(、]*(?:是|为|对应)?([^，。；;\n)）]{1,60})/u)?.[1] || '';
    const named = p.plan?.characters.find((c): boolean => after === c.name || after === c.id || after.startsWith(`${c.name}身份`) || after.startsWith(`${c.name}的身份`));
    if (named && (ref.purpose !== 'identity' || !ref.characterIds.includes(named.id))) throw new Error('角色与实际图片顺序错绑；场景首帧不能冒充单独角色图');
    const material = p.materials?.find((m): boolean => after === m.name || after === m.id);
    if (material && ref.materialId !== material.id && !(material.kind === 'character' && ref.characterIds.includes(material.entityId))) throw new Error('逻辑资产名称与实际图片用途错绑，请使用逻辑引用');
    if (/^(?:本镜)?(?:计划)?尾帧/.test(after) && ref.purpose !== 'plannedEndImage') throw new Error('尾帧引用与实际上传顺序不符');
    if (/^(?:本镜)?首帧/.test(after) && !['firstFrame', 'actualEndFrame'].includes(ref.purpose)) throw new Error('首帧引用与实际上传顺序不符');
  }
}
/** 新请求的编号属于当次媒体输入计划；不能把它误当作 Chat 附件或当前数组下标。 */
export function plannedReferenceMap(source: PetStoryPromptReference[], current: PetStoryPromptReference[]): Map<number, PetStoryPromptReference> {
  const result = new Map<number, PetStoryPromptReference>();
  for (const ref of source) {
    if (!Number.isSafeInteger(ref.order) || ref.order < 1 || ref.order > source.length || result.has(ref.order)) throw new Error('正文来源的素材标签表编号无效，请重新生成');
    const planned = ref.assetId.startsWith('pending:');
    const found = current.find((item): boolean => {
      if (!planned && item.assetId !== ref.assetId) return false;
      const samePurpose = item.purpose === ref.purpose || (planned && ref.assetId === 'pending:first' && ref.purpose === 'firstFrame' && item.purpose === 'actualEndFrame');
      return samePurpose && item.slot === ref.slot && item.materialId === ref.materialId && item.entityId === ref.entityId
        && [...item.characterIds].sort().join('\0') === [...ref.characterIds].sort().join('\0');
    });
    if (!found) throw new Error(`正文引用 ${ref.order} 的素材或用途已变化，请通过 Chat 重新生成或修订`);
    result.set(ref.order, found);
  }
  if (new Set([...result.values()].map((ref): string => ref.assetId)).size !== current.length) throw new Error('正文来源与当前目标素材清单不同，请通过 Chat 重新生成或修订');
  return result;
}
/** 引用片段与普通正文分离，平台绑定仅替换这些片段；final 原文另存不改。 */
export function compileReferencedText(p: PetStoryProject, final: string, refs: PetStoryPromptReference[], sourceRefs?: PetStoryPromptReference[]): Pick<PetStoryCompiledPrompt, 'text' | 'segments'> {
  const source = sourceRefs || refs;
  const mapped = sourceRefs ? plannedReferenceMap(source, refs) : new Map(refs.map((ref): [number, PetStoryPromptReference] => [ref.order, ref]));
  checkPromptReferences(final, p, source);
  const segments: NonNullable<PetStoryCompiledPrompt['segments']> = []; let cursor = 0;
  for (const match of final.matchAll(/\{\{ref:([^}]+)\}\}|第\s*(\d+)\s*张(?:参考)?图|@图片\s*(\d+)/g)) {
    segments.push({ text: final.slice(cursor, match.index) });
    const key = match[1];
    const ref = key ? refs.find((r): boolean => key === 'first' ? ['firstFrame', 'actualEndFrame'].includes(r.purpose) : key === 'last' ? r.purpose === 'plannedEndImage' : r.assetId === key || r.materialId === key || r.entityId === key || (r.purpose === 'identity' && r.characterIds.includes(key))) : mapped.get(Number(match[2] || match[3]));
    if (!ref) throw new Error(`逻辑引用 ${key || match[2] || match[3]} 没有对应素材`);
    segments.push({ referenceOrder: ref.order, ...(key ? {} : { sourceText: match[0] }) }); cursor = (match.index || 0) + match[0].length;
  }
  segments.push({ text: final.slice(cursor) });
  const body = renderReferenceSegments(segments);
  if (/\{\{ref:/.test(body)) throw new Error('存在未解析的提示词引用');
  checkPromptReferences(body, p, refs);
  return { text: body, segments };
}
function validateVideoPromptTarget(p: PetStoryProject, prompt: PetStoryPrompt, mode: PetStoryResolvedMode | undefined): void {
  if (!mode) throw new Error('视频实际模式尚未解析，不能编译提交');
  if (mode !== 'first_last_frame' && /(?:原生首尾帧|首尾帧专用槽|尾帧作为目标结尾|以首帧作为开头、尾帧)/.test(prompt.final)) throw new Error('最终文本仍声明原生首尾帧，与实际模式不符，请重新优化或修正 final');
  if (!prompt.promptTask) throw new Error('正文缺少专用目标合同，请按当前模型／模式通过豆包重新生成或修订');
  if (prompt.promptTask.mode !== mode) throw new Error('正文生成时的目标视频模式与实际模式不同，请通过 Chat 重新生成或修订');
  const model = p.production?.capability?.videoConfig?.model || p.promptCapability?.videoConfig?.model || '';
  const dialect = /seedance[\s_-]*2[._]5/i.test(model) ? 'seedance25' : /seedance[\s_-]*2[._]0/i.test(model) ? 'seedance20' : undefined;
  if (dialect && prompt.promptTask.dialect !== dialect) throw new Error('正文生成时的 Seedance 方言与本次目标模型不同，请通过 Chat 重新生成或修订');
}
export function compilePrompt(p: PetStoryProject, shotId: string, kind: PetStoryPromptKind, mode?: PetStoryResolvedMode, planned = false): PetStoryCompiledPrompt {
  const shot = must(p.plan?.shots.find((s): boolean => s.id === shotId), '镜头不存在');
  const prompt = must(shot.prompts[kind], '提示词不存在');
  const final = prompt.final;
  if (!planned) requirePromptEligibility(p, prompt, { shotId, promptKind: kind, mode });
  if (!planned && prompt.needsReview) throw new Error('本项正文的来源或设计已变化，请重新生成或显式复核采用后制作');
  if (!planned && kind === 'video' && shot.dialogue?.some((line): boolean => !final.includes(line.text))) throw new Error('当前最终视频正文遗漏已确认的原台词，请查看本次候选或保存修正后再制作');
  if (!planned && p.materials) requireApprovedMaterials(p, [shotId]);
  const refs = promptReferences(p, shot, kind, mode, planned);
  if (kind === 'video' && !planned) validateVideoPromptTarget(p, prompt, mode);
  // 正文由 Chat 或用户撰写。编译仅解析已存在的引用，绝不补写目的、保持项或素材说明。
  const compiled = compileReferencedText(p, final, refs, prompt.promptTask?.references);
  return { ...compiled, final, kind, requestedMode: shot.requestedMode, resolvedMode: kind === 'video' ? mode : undefined,
    rulesVersion: prompt.rulesVersion, references: refs };
}

/** 基础图预览、导出与正式生产共用，元数据不混入正文。 */
export function materialPromptReferences(p: PetStoryProject, materialId: string, planned = false, promptOverride?: PetStoryPrompt): PetStoryPromptReference[] {
  const material = must(p.materials?.find((item): boolean => item.id === materialId), '基础素材不存在');
  const references: PetStoryPromptReference[] = [];
  const edit = (promptOverride || material.prompt).editIntent;
  if (edit) {
    const source = p.assets.find((asset): boolean => asset.id === edit.baseAssetId && asset.kind === material.kind);
    if (!source || (source.materialId !== material.id && !(material.kind === 'character' && assetCharacterIds(source).includes(material.entityId)))) throw new Error('已采用编辑正文缺少对应实际基图，请重新选择本资产图片后生成编辑计划');
    references.push({ assetId: source.id, materialId: material.id, entityId: material.entityId, purpose: material.kind === 'character' ? 'identity' : material.kind, characterIds: material.kind === 'character' ? [material.entityId] : [], order: 1 });
  } else if (material.kind !== 'scene' && material.selectedAssetId) {
    const source = materialAsset(p, material.id, false);
    references.push({ assetId: source.id, materialId: material.id, entityId: material.entityId, purpose: material.kind === 'character' ? 'identity' : 'prop', characterIds: material.kind === 'character' ? [material.entityId] : [], order: 1 });
  }
  const parentId = material.kind === 'scene' ? p.plan?.scenes?.find((s): boolean => s.id === material.entityId)?.parentSceneId : undefined;
  if (parentId && !edit) {
    let asset: PetStoryAsset | undefined;
    try { asset = materialAsset(p, `scene:${parentId}`); } catch (error: unknown) { if (!planned) throw error; }
    references.push({ assetId: asset?.id || `pending:scene:${parentId}`, materialId: `scene:${parentId}`, entityId: parentId, purpose: 'scene', characterIds: [], order: 1 });
  }
  return references;
}
/** 基础图预览、导出与正式生产共用，元数据不混入正文。 */
export function compileMaterialPrompt(p: PetStoryProject, materialId: string, planned = false): PetStoryCompiledPrompt {
  const material = planned ? must(p.materials?.find((item): boolean => item.id === materialId), '基础素材不存在') : requireMaterialPromptSource(p, materialId);
  if (!planned && material.prompt.needsReview) throw new Error('基础素材设计已变化，请重新生成或显式复核采用正文后制作');
  const references = materialPromptReferences(p, materialId, planned);
  return { ...compileReferencedText(p, material.prompt.final, references, material.prompt.promptTask?.references), final: material.prompt.final, kind: material.kind, requestedMode: 'auto', rulesVersion: material.prompt.rulesVersion, references };
}
