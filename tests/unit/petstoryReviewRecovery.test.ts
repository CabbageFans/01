/** 离线审查接线回归；占位正文和技术图片不代表真实豆包内容或视觉验收。 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryChatJob, PetStoryProject, PetStoryPrompt, PetStoryRuntimeTarget, Task, TaskAddParams, TaskRunSnapshot } from '@doubao-studio/contracts';
import { PetStoryProjects } from '../../main/utils/petstoryProject';
import { PetStoryChatService } from '../../main/utils/petstoryChat';
import { buildDramaRequest } from '../../main/utils/petstoryRuntimeRequest';
import { syncMaterials } from '../../main/utils/petstoryMaterials';
import { TaskService } from '../../main/core/TaskService';
import { isSavedReviewResult } from '../../src/utils/petstoryCandidate';
import { CanvasPromptEditor } from '../../src/components/PetStoryCanvasPrompt';
import { PetStoryMaterials } from '../../src/components/PetStoryMaterials';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';

const initial = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const prompt = (): PetStoryPrompt => ({ original: 'TEST正文', optimized: 'TEST正文', final: 'TEST正文', edited: false, rulesVersion: 'TEST' });
const now = '2026-10-25T01:00:00.000Z';
let directory: string; let projects: PetStoryProjects; let project: PetStoryProject; let chat: PetStoryChatService; let core: TaskService; let list: () => Task[];
beforeEach(async (): Promise<void> => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-review-recovery-'));
  projects = new PetStoryProjects(); project = await projects.create(directory, 'TEST-studio', 'TEST-account');
  project = await projects.saveMobileStory(project.id, project.revision, 'TEST 当前确认原文');
  project.plan = { sourceSummary: 'TEST来源', adaptedStory: 'TEST 当前确认原文', characters: [], props: [], scenes: [{ id: 'location', name: 'TEST地点', location: 'TEST地点', time: '待确认', lighting: '待确认', layout: 'TEST布局', view: 'TEST视角', designOrigin: 'proposed' }], shots: [{ id: 'shot-0', order: 1, characterIds: [], propIds: [], sceneId: 'location', scene: 'TEST地点', action: 'TEST动作', startState: 'TEST起点', endState: 'TEST终点', durationSeconds: 5, transition: 'cut', requestedMode: 'reference', prompts: { firstFrame: prompt(), video: prompt() } }] };
  project.materials = syncMaterials(project); project = await projects.write(project);
  let stored: Task[] = []; let sequence = 0;
  list = (): Task[] => structuredClone(stored);
  core = new TaskService({ store: { read: list, replace: (tasks: Task[]): boolean => { stored = structuredClone(tasks); return true; } }, defaultProjectId: (): string => 'TEST-studio', id: (): string => `TEST-task-${++sequence}` });
  const create = (input: TaskAddParams, accountId: string): Task => {
    const created = core.create(input); if (!created.success) throw new Error(created.error);
    const assigned = core.assign({ taskId: created.data[0].id, accountId }); if (!assigned.success) throw new Error(assigned.error); return assigned.data;
  };
  chat = new PetStoryChatService(projects, { list, create });
});
afterEach(async (): Promise<void> => { usePetStoryStore.setState(initial.petstory); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });
async function prepare(kind: PetStoryChatJob['kind'], target?: PetStoryRuntimeTarget): Promise<PetStoryChatJob> {
  project = await projects.read(project.id); project = (await chat.prepareRuntime(project.id, project.revision, kind, target)).project!; return project.jobs.at(-1)!;
}
async function finish(job: PetStoryChatJob, body: Record<string, unknown> | string): Promise<void> {
  const task = list().find((item): boolean => item.id === job.taskId)!;
  const text = typeof body === 'string' ? body : JSON.stringify({ requestId: job.requestId, targetIds: job.expectedIds, ...body });
  const runtime: TaskRunSnapshot = { runId: `TEST-run-${job.id}`, attempt: 1, stage: 'completed', message: 'TEST离线回读', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now, input: { prompt: task.prompt, mode: 'chat', attachments: task.attachments || [] }, chatResponse: { text, capturedAt: now } };
  const result = core.updateRuntime({ taskId: task.id, status: 'done', runtime }); if (!result.success) throw new Error(result.error);
  await chat.bindRun(project.id, job.id, runtime.runId); project = (await chat.collect(project.id, job.id)).project!;
}
function clientRender(): void {
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation(<T,>(_subscribe: (onStoreChange: () => void) => () => void, getSnapshot: () => T): T => getSnapshot());
  usePetStoryStore.setState({ project, busy: false, freeChatConfirmed: true }); useTaskStore.setState({ tasks: list() });
}

describe('素材实际图片与格式纠正后的内容审查', (): void => {
  it('素材审查实际上传当前所选图片，标注准确确认状态，不混入其他图片', async (): Promise<void> => {
    const textOnly = buildDramaRequest(project, { kind: 'review', requestId: 'TEST-text-review', materialId: 'scene:location' });
    expect(textOnly.assets).toEqual([]); expect(textOnly.prompt).toContain('没有图片时只审查文字，不得声称已看图');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    await fs.mkdir(path.join(directory, 'materials')); await fs.writeFile(path.join(directory, 'materials/TEST.png'), png);
    const sha256 = createHash('sha256').update(png).digest('hex');
    project.assets.push({ id: 'TEST-selected', materialId: 'scene:location', kind: 'scene', relativePath: 'materials/TEST.png', validation: { sha256, bytes: png.length, width: 1, height: 1, decoded: true, checkedAt: now } }, { id: 'TEST-unselected', materialId: 'scene:location', kind: 'scene', relativePath: 'materials/unused.png' });
    project.materials![0].selectedAssetId = 'TEST-selected'; project = await projects.write(project);
    for (const approved of [false, true]) {
      project.materials![0].approved = approved ? { assetId: 'TEST-selected', sha256, at: now } : undefined;
      const request = buildDramaRequest(project, { kind: 'review', requestId: 'TEST-review', materialId: 'scene:location' });
      const block = request.prompt.split('【当前事实与本次附件】\n')[1].split('\n\n【结果约定】')[0];
      const fenced = block.match(/^(`{3,})json\n([\s\S]*)\n\1$/);
      const facts = JSON.parse(fenced?.[2] || block) as { attachmentList: { version: string; logicalId: string; approved: boolean }[] };
      expect(request.assets.map((asset): string => asset.id)).toEqual(['TEST-selected']); expect(request.expectedIds).toEqual(['scene:location']);
      expect(facts.attachmentList).toMatchObject([{ version: 'TEST-selected', logicalId: 'scene:location', approved }]);
    }
    project = await projects.write(project); await prepare('review', { materialId: 'scene:location' });
    expect(list()[0].attachments).toEqual([await fs.realpath(path.join(directory, 'materials/TEST.png'))]);
  });
  it.each(['shot', 'material'] as const)('格式纠正后的 %s 问题可见并按实际回复ID局部修订一次', async (kind): Promise<void> => {
    const target: PetStoryRuntimeTarget = kind === 'shot' ? { shotId: 'shot-0', promptKind: 'firstFrame' } : { materialId: 'scene:location' };
    const targetId = kind === 'shot' ? 'shot-0:firstFrame' : 'scene:location';
    const original = await prepare('review', target); await finish(original, '{ TEST 部分审查回复'); expect(project.jobs.at(-1)!.status).toBe('invalid');
    const repaired = await prepare('repair', { parentJobId: original.id });
    await finish(repaired, { issues: [{ id: 'TEST-issue', targetId, evidence: 'TEST具体证据', impact: 'TEST制作影响', requestedChange: 'TEST局部目标', severity: 'warning' }] });
    const result = project.jobs.at(-1)!; expect(isSavedReviewResult(result, project.jobs)).toBe(true);
    clientRender();
    const html = kind === 'shot' ? renderToStaticMarkup(React.createElement(CanvasPromptEditor, { project, shot: project.plan!.shots[0], kind: 'firstFrame', disabled: false, generationBlocked: false, dirtyChanged: (): void => undefined })) : renderToStaticMarkup(React.createElement(PetStoryMaterials, { project, disabled: false }));
    expect(html).toContain('修订所选 0 项问题'); expect(html).toContain('TEST具体证据');
    const revision = await prepare('revise', { ...target, parentJobId: repaired.id, selectedIssueIds: ['TEST-issue'] }); await finish(revision, { optimized: 'TEST局部修订正文' });
    expect(project.jobs.at(-1)!.parentJobId).toBe(repaired.id);
    expect(project.jobs.at(-1)!.resultStatus).toBe('candidate');
    project = (await chat.adoptPromptCandidate(project.id, project.revision, revision.id)).project!;
    await expect(prepare('revise', { ...target, parentJobId: repaired.id })).rejects.toThrow('正文已经变化');
    await expect(prepare('revise', { ...target, parentJobId: original.id })).rejects.toThrow('具体目标问题');
  });
  it('其他创作阶段的格式纠正不能冒充审查作为局部修订依据', async (): Promise<void> => {
    const target = { shotId: 'shot-0', promptKind: 'firstFrame' as const };
    const original = await prepare('optimize', target); await finish(original, '{ TEST 部分创作回复');
    const repaired = await prepare('repair', { parentJobId: original.id }); await finish(repaired, { optimized: 'TEST结构正确的正文' });
    expect(isSavedReviewResult(project.jobs.at(-1)!, project.jobs)).toBe(false);
    await expect(prepare('revise', { ...target, parentJobId: repaired.id })).rejects.toThrow('具体目标问题');
  });
});
