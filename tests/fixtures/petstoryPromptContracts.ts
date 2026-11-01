/** 离线媒体测试的专用 Chat 前置夹具；不代表豆包真实产出，也不用于用户项目迁移。 */
import type { PetStoryProject, PetStoryPrompt, PetStoryRuntimeTarget } from '@doubao-studio/contracts';
import { createHash } from 'node:crypto';
import { previousAdoptedBoundary } from '../../main/utils/petstoryBoundary';
import { buildDramaRequest } from '../../main/utils/petstoryRuntimeRequest';

interface OfflineContractOptions { completeVideoBody?: boolean; includeDialogue?: boolean }
export function seedOfflinePromptContracts(p: PetStoryProject, only?: PetStoryRuntimeTarget, options: OfflineContractOptions = {}): void {
  const targets: { target: PetStoryRuntimeTarget; prompt: PetStoryPrompt }[] = [
    ...(p.materials || []).map((material): { target: PetStoryRuntimeTarget; prompt: PetStoryPrompt } => ({ target: { materialId: material.id }, prompt: material.prompt })),
    ...(p.plan?.shots || []).flatMap((shot): { target: PetStoryRuntimeTarget; prompt: PetStoryPrompt }[] => (['firstFrame', 'lastFrame', 'video'] as const).flatMap((kind): { target: PetStoryRuntimeTarget; prompt: PetStoryPrompt }[] => shot.prompts[kind] ? [{ target: { shotId: shot.id, promptKind: kind }, prompt: shot.prompts[kind]! }] : [])),
  ];
  for (const { target, prompt } of targets) {
    if (!prompt.final || only && (only.materialId !== target.materialId || only.shotId !== target.shotId || only.promptKind !== target.promptKind)) continue;
    const request = buildDramaRequest(p, { ...target, kind: target.materialId ? 'materialPrompt' : 'optimize', requestId: 'TEST-offline-eligibility', editIntent: prompt.editIntent, capability: p.production?.capability || p.promptCapability });
    // 媒体链路的有效场景使用完整离线正文；负向契约用例默认保留故意缺项的原文。
    if (options.completeVideoBody && target.promptKind === 'video' && request.promptTask
      && ['seedance20', 'seedance25'].includes(request.promptTask.dialect)) {
      const missing = request.promptTask.references.filter((reference): boolean => !new RegExp(`@图片${reference.order}(?!\\d)`).test(prompt.final));
      if (missing.length) prompt.final += `\nTEST本次目标素材：${missing.map((reference): string => `@图片${reference.order}`).join('、')}。`;
      if (!/无字幕/.test(prompt.final)) prompt.final += '\n全程无字幕。';
      if (!/不叠加对白文字/.test(prompt.final)) prompt.final += '不叠加对白文字。';
      if (options.includeDialogue !== false) for (const line of p.plan?.shots.find((shot): boolean => shot.id === target.shotId)?.dialogue || []) {
        const speaker = p.plan?.characters.find((character): boolean => character.id === line.speakerId)?.name || line.speakerId;
        const sound = `{${speaker}用中文说：“${line.text}”}`;
        if (!prompt.final.includes(sound)) prompt.final += `\n${sound}`;
      }
      prompt.optimized = prompt.final;
    }
    const id = `TEST-offline-source-${p.jobs.length}`;
    prompt.promptTask = request.promptTask;
    prompt.rulesVersion = request.rulesVersion;
    if (prompt.edited) prompt.basisJobId = id; else prompt.sourceJobId = id;
    const shot = p.plan?.shots.find((item): boolean => item.id === target.shotId);
    const previousBoundaryHash = shot && target.promptKind ? createHash('sha256').update(JSON.stringify(previousAdoptedBoundary(p, shot) || null)).digest('hex') : undefined;
    p.jobs.push({ id, previousBoundaryHash, taskId: `${id}-task`, kind: target.materialId ? 'materialPrompt' : 'optimize', ...target, status: 'applied', resultStatus: 'adopted',
      inputHash: createHash('sha256').update(request.prompt).digest('hex'), requestId: 'TEST-offline-eligibility', requestText: request.prompt, sourceUrl: p.source.url, sourceStoryId: p.mobileStory?.id, rawText: JSON.stringify({ TEST: '离线模拟 Chat 结果', optimized: prompt.final }), parsedResult: { optimized: prompt.final },
      expectedIds: request.expectedIds, stage: request.stage, rulesVersion: request.rulesVersion, ruleFiles: request.ruleFiles, promptTask: structuredClone(request.promptTask) });
  }
}
