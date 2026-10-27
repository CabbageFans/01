import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PetStoryCompiledPrompt, PetStoryPageBinding, PetStoryProject, PetStoryPrompt, PetStoryPromptKind, PetStoryResolvedMode, PetStoryMaterial, PetStoryShot, PetStoryProductionStep, Task } from '@doubao-studio/contracts';
import { compileMaterialPrompt, compilePrompt, PROMPT_RULES_VERSION } from './petstoryPromptQuality';
import { inspectPromptEligibility, type PromptEligibility } from './petstoryEligibility';
import { reviewMatchesPrompt } from './petstoryReview';

export interface PromptExportEntry {
  id: string;
  category: 'character' | 'prop' | 'scene' | PetStoryPromptKind;
  name: string;
  /** 原样保存用户 final；模型正文与审阅数据是不同字段。 */
  final: string;
  modelPrompt: string | null;
  referencePlan: PetStoryCompiledPrompt['references'];
  /** 原回复候选独立展示，绝不充当当前采用正文或实际任务输入。 */
  candidate?: { body: string; jobId: string | null; requestId?: string; resultStatus?: string; stage?: string; rulesVersion?: string; referencePlan: PetStoryCompiledPrompt['references']; warnings: string[] };
  review: { warnings: string[]; submissionBlocked?: boolean; eligibility: PromptEligibility['state']; requestedMode?: string; resolvedMode?: string; metadata: object };
}
export interface PromptExportRun {
  stepId: string;
  taskId?: string;
  runId?: string;
  status: 'bound_not_sent' | 'submission_uncertain' | 'submitted' | 'evidence_unavailable';
  bindings: PetStoryPageBinding[];
  sentModelPrompt: string | null;
  savedModelPrompt: string | null;
  submittedAt?: string;
  warnings: string[];
}
export interface PetStoryPromptExport {
  schemaVersion: 1;
  project: { id: string; revision: number };
  rulesVersion: string;
  exportedAt: string;
  review: { warnings: string[]; note: string; pendingChat?: { total: number; bound: number; captured: number } };
  prompts: PromptExportEntry[];
  actualRuns: PromptExportRun[];
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : '编译未就绪'; }
function preview(work: () => PetStoryCompiledPrompt): { compiled?: PetStoryCompiledPrompt; warnings: string[] } {
  try { return { compiled: work(), warnings: [] }; } catch (error: unknown) { return { warnings: [errorText(error)] }; }
}
type PromptExportTarget = { materialId?: string; shotId?: string; promptKind?: PetStoryPromptKind };
interface PromptFailedRevision { jobId: string; requestId?: string; reasons: string[]; candidatePreserved: boolean }
interface PromptReviewErrors { jobId: string; requestId?: string; issues: { id: string; evidence: string; requestedChange: string }[] }
function failedRevisionsFor(p: PetStoryProject, prompt: PetStoryPrompt, target: PromptExportTarget): PromptFailedRevision[] {
  return prompt.needsReview ? p.jobs.filter((job): boolean => job.kind === 'revise' && job.status === 'invalid' && job.resultStatus !== 'stale'
    && job.sourceStoryId === p.mobileStory?.id && job.inputFinal === prompt.final
    && (target.materialId ? job.materialId === target.materialId : job.shotId === target.shotId && job.promptKind === target.promptKind))
    .map((job): PromptFailedRevision => ({ jobId: job.id, requestId: job.requestId, reasons: job.validationIssues?.length ? job.validationIssues : job.error ? [job.error] : [], candidatePreserved: !!job.rawText })) : [];
}
function reviewErrorsFor(p: PetStoryProject, prompt: PetStoryPrompt, target: PromptExportTarget): PromptReviewErrors[] {
  if (!prompt.needsReview || prompt.edited || prompt.optimized && prompt.optimized !== prompt.final) return [];
  const key = target.materialId || (target.shotId && target.promptKind ? `${target.shotId}:${target.promptKind}` : undefined);
  return p.jobs.filter((job): boolean => {
    const review = job.kind === 'review' || job.kind === 'repair' && p.jobs.some((parent): boolean => parent.id === job.parentJobId && parent.kind === 'review');
    return review && job.status === 'applied' && job.resultStatus !== 'stale' && job.sourceStoryId === p.mobileStory?.id
      && !!key && reviewMatchesPrompt(job, key, prompt.final);
  }).flatMap((job): PromptReviewErrors[] => {
    const issues = (job.parsedResult?.issues || []).filter((issue): boolean => issue.severity === 'error' && (issue.targetId === key || issue.targetId === target.shotId && (!issue.promptKind || issue.promptKind === target.promptKind)))
      .map((issue): PromptReviewErrors['issues'][number] => ({ id: issue.id, evidence: issue.evidence, requestedChange: issue.requestedChange }));
    return issues.length ? [{ jobId: job.id, requestId: job.requestId, issues }] : [];
  });
}
/** 仅在审阅数据保留采用来源和未采用候选，不把候选编译成媒体正文。 */
function promptProvenance(p: PetStoryProject, prompt: PetStoryPrompt, target: PromptExportTarget): object {
  return { edited: prompt.edited, sourceJobId: prompt.sourceJobId || null, candidateJobId: prompt.candidateJobId || null, needsReview: !!prompt.needsReview, failedRevisions: failedRevisionsFor(p, prompt, target), reviewErrors: reviewErrorsFor(p, prompt, target),
    unadoptedCandidate: prompt.optimized && prompt.optimized !== prompt.final ? prompt.optimized : null };
}
function exportCandidate(p: PetStoryProject, prompt: PetStoryPrompt, target: PromptExportTarget): PromptExportEntry['candidate'] {
  const job = p.jobs.find((item): boolean => item.id === prompt.candidateJobId);
  const sameTarget = job && (target.materialId ? job.materialId === target.materialId : job.shotId === target.shotId && job.promptKind === target.promptKind);
  if (sameTarget && job.resultStatus !== 'adopted' && job.parsedResult?.optimized) return {
    body: job.parsedResult.optimized, jobId: job.id, requestId: job.requestId, resultStatus: job.resultStatus, stage: job.stage, rulesVersion: job.rulesVersion,
    referencePlan: structuredClone(job.promptTask?.references || []), warnings: [...(job.validationIssues || []), ...(job.staleReason ? [job.staleReason] : [])],
  };
  if (!job && prompt.optimized && prompt.optimized !== prompt.final) return { body: prompt.optimized, jobId: null, referencePlan: [], warnings: ['旧保存候选缺少专用来源和目标合同；保留供阅读，请通过正常 Chat 适配。'] };
  return undefined;
}
function reviewWarnings(p: PetStoryProject, prompt: PetStoryPrompt, target: PromptExportTarget): string[] {
  return prompt.needsReview ? ['当前采用正文待复核；以下仅为保留的计划预览，不可直接提交。', ...failedRevisionsFor(p, prompt, target).map((job): string => `修订 ${job.jobId} 未通过：${job.reasons.join('；') || '具体原因见原任务记录'}。失败候选未采用。`),
    ...reviewErrorsFor(p, prompt, target).map((job): string => `审查 ${job.jobId} 报告当前正文 error：${job.issues.map((issue): string => issue.evidence).join('；')}`)] : [];
}
function materialEntry(p: PetStoryProject, m: PetStoryMaterial): PromptExportEntry {
  const checked = preview((): PetStoryCompiledPrompt => compileMaterialPrompt(p, m.id, true));
  const entities = m.kind === 'character' ? p.plan?.characters : m.kind === 'prop' ? p.plan?.props : p.plan?.scenes;
  const entity = entities?.find((value): boolean => value.id === m.entityId);
  const warnings = [...checked.warnings, ...reviewWarnings(p, m.prompt, { materialId: m.id })];
  const eligibility = inspectPromptEligibility(p, m.prompt, { materialId: m.id, currentReferences: checked.compiled?.references });
  if (!checked.compiled && eligibility.state !== 'creative_plan') eligibility.state = 'needs_revision';
  warnings.push(...eligibility.reasons);
  if (!m.approved) warnings.push('具体图片尚未接受，不能用于镜头生产。');
  if (m.prompt.edited && m.prompt.rulesVersion !== PROMPT_RULES_VERSION) warnings.push('保留旧版手改 final，未自动改写。');
  return { id: m.id, category: m.kind, name: m.name, final: m.prompt.final, modelPrompt: checked.compiled?.text ?? null,
    candidate: exportCandidate(p, m.prompt, { materialId: m.id }),
    referencePlan: checked.compiled?.references || [], review: { warnings, eligibility: eligibility.state, submissionBlocked: eligibility.state !== 'submittable' || !checked.compiled, metadata: { designOrigin: entity?.designOrigin || 'proposed', entity, selectedAssetId: m.selectedAssetId, approved: m.approved || null, sourceRulesVersion: m.prompt.rulesVersion, ...promptProvenance(p, m.prompt, { materialId: m.id }) } } };
}
function shotEntry(p: PetStoryProject, shot: PetStoryShot, kind: PetStoryPromptKind): PromptExportEntry[] {
  const prompt = shot.prompts[kind];
  if (!prompt) return [];
  const mode: PetStoryResolvedMode | undefined = p.production?.shots[shot.id]?.resolvedMode || (shot.requestedMode === 'auto' ? undefined : shot.requestedMode);
  const checked = preview((): PetStoryCompiledPrompt => compilePrompt(p, shot.id, kind, kind === 'video' ? mode : undefined, true));
  const eligibility = inspectPromptEligibility(p, prompt, { shotId: shot.id, promptKind: kind, mode, currentReferences: checked.compiled?.references });
  if (!checked.compiled && eligibility.state !== 'creative_plan') eligibility.state = 'needs_revision';
  checked.warnings.push(...eligibility.reasons);
  checked.warnings.push(...reviewWarnings(p, prompt, { shotId: shot.id, promptKind: kind }));
  if (kind === 'video' && shot.dialogue?.some((d): boolean => !prompt.final.includes(d.text))) checked.warnings.push('当前 final 未包含全部剧本原台词，请在产品中核对／重新优化。');
  return [{ id: `${shot.id}:${kind}`, category: kind, name: `${shot.order} · ${kind}`, final: prompt.final, modelPrompt: checked.compiled?.text ?? null,
    candidate: exportCandidate(p, prompt, { shotId: shot.id, promptKind: kind }),
    referencePlan: checked.compiled?.references || [], review: { warnings: checked.warnings, eligibility: eligibility.state, submissionBlocked: eligibility.state !== 'submittable' || !checked.compiled, requestedMode: shot.requestedMode, resolvedMode: mode,
      metadata: { shotId: shot.id, order: shot.order, startState: shot.startState, endState: shot.endState, action: shot.action, expression: shot.expression, gaze: shot.gaze, interaction: shot.interaction, dialogue: shot.dialogue, propStates: shot.propStates, sceneId: shot.sceneId, sceneView: shot.sceneView, camera: shot.camera, durationSeconds: shot.durationSeconds, sourceRulesVersion: prompt.rulesVersion, ...promptProvenance(p, prompt, { shotId: shot.id, promptKind: kind }) } } }];
}
function matchingRunTask(p: PetStoryProject, step: PetStoryProductionStep, tasks: Task[]): Task | undefined {
  const filesMatch = !!step.pageBindings && step.pageBindings.length === step.attachmentAssetIds.length && step.pageBindings.every((b, i): boolean => b.assetId === step.attachmentAssetIds[i] && !!b.fileSha256 && p.assets.some((a): boolean => a.id === b.assetId && a.validation?.sha256 === b.fileSha256));
  if (!filesMatch || !step.taskId || !step.runId) return undefined;
  const task = tasks.find((t): boolean => t.id === step.taskId);
  if (!task || task.projectId !== p.studioProjectId || task.assignedAccountId !== p.accountId || task.petstory?.projectId !== p.id || task.petstory.stepId !== step.id) return undefined;
  if (task.runtime?.runId !== step.runId || task.runtime.input.prompt !== task.prompt || task.prompt !== step.compiledPrompt?.text || JSON.stringify(task.runtime.input.attachments || []) !== JSON.stringify(task.attachments || [])) return undefined;
  return task;
}
function actualRun(p: PetStoryProject, step: PetStoryProductionStep, tasks: Task[]): PromptExportRun {
  const task = matchingRunTask(p, step, tasks);
  const runtime = task?.runtime;
  const observation = runtime?.acceptanceObservation;
  const accepted = !!runtime?.submittedAt && observation?.accountId === p.accountId && observation.runId === step.runId && observation.conversationUrl === runtime.conversationUrl;
  const warnings: string[] = [];
  if (!task) warnings.push('当前任务运行无法与此步骤精确核对；不推定已经发送。');
  if (task && runtime?.submittedAt && !accepted) warnings.push('仅有提交意图，尚未取得平台受理证据；不标为实际发送完成。');
  if (!step.pageBindings) warnings.push('尚无实际网页绑定记录。');
  if (step.pageBindings?.some((b): boolean => !b.fileSha256)) warnings.push('旧绑定缺少文件摘要，保留原记录，不补造证据。');
  return { stepId: step.id, taskId: step.taskId, runId: step.runId,
    status: !task ? 'evidence_unavailable' : accepted ? 'submitted' : runtime?.submittedAt ? 'submission_uncertain' : 'bound_not_sent',
    bindings: structuredClone(step.pageBindings || []), sentModelPrompt: accepted ? runtime?.input.prompt ?? null : null,
    savedModelPrompt: task?.prompt ?? null, submittedAt: runtime?.submittedAt, warnings };
}
/** 与预览／生产同一编译出口，不调用 AI、不修改项目、不重写用户 final。 */
export function buildPetStoryPromptExport(p: PetStoryProject, tasks: Task[], exportedAt = new Date().toISOString()): PetStoryPromptExport {
  const warnings: string[] = [];
  // 与生产入口采用同一未收取状态口径；警示只属于导出元数据，不进入媒体正文。
  const bound = p.jobs.filter((job): boolean => job.status === 'bound' && !job.endedWaitingAt).length;
  const captured = p.jobs.filter((job): boolean => job.status === 'captured' && !job.endedWaitingAt).length;
  const pendingChat = bound + captured ? { total: bound + captured, bound, captured } : undefined;
  if (pendingChat) warnings.push(`原Chat未收取，不得重发。共 ${pendingChat.total} 项（绑定待收取 ${bound}，已捕获待处理 ${captured}）；相关目标及其依赖仍需收取或明确结束等待，无关目标按其资格继续。`);
  if (!p.materials) warnings.push('当前项目尚无已保存基础素材清单；请通过剧本分析／资产清单流程补齐，导出不会代为猜测。');
  if (p.promptProfile?.style && !p.promptProfile.assetStyles) warnings.push('旧共同风格尚未分类，保留在项目中，不自动套入人物、道具或场景。');
  const prompts = (p.materials || []).map((m): PromptExportEntry => materialEntry(p, m));
  for (const shot of p.plan?.shots || []) for (const kind of ['firstFrame', 'lastFrame', 'video'] as const) prompts.push(...shotEntry(p, shot, kind));
  const actualRuns: PromptExportRun[] = [];
  for (const production of [...(p.productionHistory || []), ...(p.production ? [p.production] : [])]) for (const step of production.steps) {
    actualRuns.push(actualRun(p, step, tasks));
    for (const history of step.pageBindingHistory || []) actualRuns.push({ stepId: step.id, taskId: step.taskId, runId: history.runId, status: 'evidence_unavailable', bindings: structuredClone(history.bindings), sentModelPrompt: null, savedModelPrompt: history.compiledPrompt.text, warnings: ['历史绑定快照；当前任务不证明该历史运行已发送。'] });
  }
  return { schemaVersion: 1, project: { id: p.id, revision: p.revision }, rulesVersion: PROMPT_RULES_VERSION, exportedAt,
    review: { warnings, note: '模型提示词、引用计划、审阅元数据、实际运行证据分开保存。计划编号不是页面节点。导出不授权或触发媒体生成。', ...(pendingChat ? { pendingChat } : {}) }, prompts, actualRuns };
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (c: string): string => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c)); }
function eligibilityLabel(state: PromptEligibility['state']): string { return ({ creative_plan: '创作计划', adopted_unbound: '已采用待绑定', submittable: '可提交', needs_revision: '待修订' })[state]; }
function candidateHtml(candidate: PromptExportEntry['candidate']): string {
  if (!candidate) return '';
  return `<section><h3>豆包新候选 · 未采用</h3><p>来源任务：${escapeHtml(candidate.jobId || '旧稿来源待适配')} · 请求：${escapeHtml(candidate.requestId || '未记录')} · 阶段：${escapeHtml(candidate.stage || '未记录')}</p><pre>${escapeHtml(candidate.body)}</pre><p>候选引用计划（与当前采用正文分别保存）：</p><pre>${escapeHtml(JSON.stringify(candidate.referencePlan, null, 2))}</pre>${candidate.warnings.length ? `<p role="alert">${escapeHtml(candidate.warnings.join('；'))}</p>` : ''}</section>`;
}
function candidateText(candidate: PromptExportEntry['candidate']): string {
  if (!candidate) return '';
  return `\n豆包新候选 · 未采用\n来源任务：${candidate.jobId || '旧稿来源待适配'}\n请求：${candidate.requestId || '未记录'}\n阶段：${candidate.stage || '未记录'}\n${candidate.body}\n候选引用计划：\n${JSON.stringify(candidate.referencePlan, null, 2)}\n${candidate.warnings.join('\n')}\n`;
}
function mappedPreviewHtml(entry: PromptExportEntry): string {
  return entry.modelPrompt && entry.modelPrompt !== entry.final ? `<details><summary>既有引用映射后的模型输入预览</summary><pre>${escapeHtml(entry.modelPrompt)}</pre></details>` : '';
}
function mappedPreviewText(entry: PromptExportEntry): string { return entry.modelPrompt && entry.modelPrompt !== entry.final ? `\n既有引用映射后的模型输入预览：\n${entry.modelPrompt}\n` : ''; }
export function renderPetStoryPromptExport(data: PetStoryPromptExport): { html: string; text: string } {
  const sections = data.prompts.map((entry): string => `<article><h2>${escapeHtml(entry.name)} · ${entry.category}</h2><p${entry.review.submissionBlocked ? ' role="alert"' : ''}><strong>${eligibilityLabel(entry.review.eligibility)}${entry.review.submissionBlocked ? ' · 不可直接提交' : ''}</strong></p><h3>当前保存正文${(entry.review.metadata as { edited?: boolean }).edited ? ' · 用户手改保留' : ''}</h3><pre>${escapeHtml(entry.final || '镜头已设计，正式正文待生成。')}</pre>${mappedPreviewHtml(entry)}${candidateHtml(entry.candidate)}<details><summary>引用计划与审阅元数据</summary><pre>${escapeHtml(JSON.stringify({ referencePlan: entry.referencePlan, review: entry.review, final: entry.final }, null, 2))}</pre></details></article>`).join('');
  const pendingAlert = data.review.pendingChat ? '原Chat未收取，不得重发；相关目标及其依赖仍待处理。' : '';
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>提示词与引用导出</title><style>body{max-width:1040px;margin:32px auto;padding:0 24px;background:#151720;color:#e6e8ef;font:16px/1.8 system-ui}article,details{border:1px solid #414456;border-radius:8px;padding:20px;margin:18px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit}h3{color:#bcacfa}summary{cursor:pointer}</style><h1>提示词与引用导出</h1><p>${escapeHtml(data.review.note)}</p>${pendingAlert ? `<p role="alert"><strong>${pendingAlert}</strong></p>` : ''}<pre>${escapeHtml(data.review.warnings.join('\n'))}</pre>${sections}<h2>实际运行与绑定记录 · ${data.actualRuns.length} 条</h2><pre>${escapeHtml(JSON.stringify(data.actualRuns, null, 2))}</pre></html>`;
  const text = (pendingAlert ? `[${pendingAlert}]\n${data.review.warnings.join('\n')}\n\n` : '') + data.prompts.map((entry): string => `${entry.id}\n[${eligibilityLabel(entry.review.eligibility)}${entry.review.submissionBlocked ? ' · 不可直接提交；以下仅为当前已保存正文的计划预览' : ''}]\n当前保存正文${(entry.review.metadata as { edited?: boolean }).edited ? ' · 用户手改保留' : ''}：\n${entry.final || '镜头已设计，正式正文待生成。'}\n${mappedPreviewText(entry)}引用计划：\n${JSON.stringify(entry.referencePlan, null, 2)}\n${entry.review.warnings.join('\n')}\n${candidateText(entry.candidate)}`).join('\n\n');
  return { html, text };
}
/** 新建独立目录，不覆盖项目、资产或先前导出；调用方已由产品原生选择器确定目的地。 */
export async function writePetStoryPromptExport(directory: string, data: PetStoryPromptExport): Promise<string> {
  const target = path.join(directory, `prompt-export-${data.exportedAt.replace(/[^0-9]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(target);
  const rendered = renderPetStoryPromptExport(data);
  await fs.writeFile(path.join(target, 'prompts.json'), JSON.stringify(data, null, 2), { flag: 'wx' });
  await fs.writeFile(path.join(target, 'model-prompts.txt'), rendered.text, { flag: 'wx' });
  await fs.writeFile(path.join(target, 'review.html'), rendered.html, { flag: 'wx' });
  return target;
}
