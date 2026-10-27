/** 离线媒体测试的专用 Chat 前置夹具；不代表豆包真实产出，也不用于用户项目迁移。 */
import type { PetStoryProject, PetStoryPrompt, PetStoryRuntimeTarget } from '@doubao-studio/contracts';
import { createHash } from 'node:crypto';
import { buildDramaRequest } from '../../main/utils/petstoryRuntimeRequest';

export function seedOfflinePromptContracts(p: PetStoryProject, only?: PetStoryRuntimeTarget): void {
  const targets: { target: PetStoryRuntimeTarget; prompt: PetStoryPrompt }[] = [
    ...(p.materials || []).map((material): { target: PetStoryRuntimeTarget; prompt: PetStoryPrompt } => ({ target: { materialId: material.id }, prompt: material.prompt })),
    ...(p.plan?.shots || []).flatMap((shot): { target: PetStoryRuntimeTarget; prompt: PetStoryPrompt }[] => (['firstFrame', 'lastFrame', 'video'] as const).flatMap((kind): { target: PetStoryRuntimeTarget; prompt: PetStoryPrompt }[] => shot.prompts[kind] ? [{ target: { shotId: shot.id, promptKind: kind }, prompt: shot.prompts[kind]! }] : [])),
  ];
  for (const { target, prompt } of targets) {
    if (!prompt.final || only && (only.materialId !== target.materialId || only.shotId !== target.shotId || only.promptKind !== target.promptKind)) continue;
    const request = buildDramaRequest(p, { ...target, kind: target.materialId ? 'materialPrompt' : 'optimize', requestId: 'TEST-offline-eligibility', editIntent: prompt.editIntent, capability: p.production?.capability || p.promptCapability });
    const id = `TEST-offline-source-${p.jobs.length}`;
    prompt.promptTask = request.promptTask;
    prompt.rulesVersion = request.rulesVersion;
    if (prompt.edited) prompt.basisJobId = id; else prompt.sourceJobId = id;
    p.jobs.push({ id, taskId: `${id}-task`, kind: target.materialId ? 'materialPrompt' : 'optimize', ...target, status: 'applied', resultStatus: 'adopted',
      inputHash: createHash('sha256').update(request.prompt).digest('hex'), requestId: 'TEST-offline-eligibility', requestText: request.prompt, sourceUrl: p.source.url, sourceStoryId: p.mobileStory?.id, rawText: JSON.stringify({ TEST: '离线模拟 Chat 结果', optimized: prompt.final }), parsedResult: { optimized: prompt.final },
      expectedIds: request.expectedIds, stage: request.stage, rulesVersion: request.rulesVersion, ruleFiles: request.ruleFiles, promptTask: structuredClone(request.promptTask) });
  }
}
