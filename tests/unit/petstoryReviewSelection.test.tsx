/** 真实组件的默认勾选、用户选择与修订回调；仅离线渲染，不请求平台。 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, Checkbox } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryChatJob, PetStoryProject, PetStoryReviewIssue } from '@doubao-studio/contracts';
import { ReviewIssueSelection } from '../../src/components/PetStoryReviewIssues';
import { PetStoryMaterials } from '../../src/components/PetStoryMaterials';
import { PetStoryRuntime } from '../../src/components/PetStoryRuntime';
import { CanvasPromptEditor } from '../../src/components/PetStoryCanvasPrompt';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { currentReviewPrompt, reviewMatchesCurrentPrompts, reviewMatchesPrompt } from '../../src/utils/petstoryCandidate';

const initial = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-10-26T00:00:00.000Z';
function issue(id: string, targetId: string, severity: PetStoryReviewIssue['severity']): PetStoryReviewIssue {
  return { id, targetId, severity, evidence: `TEST证据${id}`, impact: `TEST影响${id}`, requestedChange: `TEST修订${id}` };
}
function tree(node: React.ReactNode): React.ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(tree);
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return [];
  return [node, ...tree(node.props.children)];
}
let project: PetStoryProject;
beforeEach((): void => {
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation(<T,>(_subscribe: (onStoreChange: () => void) => () => void, getSnapshot: () => T): T => getSnapshot());
  const prompt = { original: 'TEST', optimized: 'TEST', final: 'TEST', edited: false, rulesVersion: 'TEST' };
  project = {
    schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, updatedAt: now,
    source: { kind: 'script', url: '', status: 'review_required' }, assets: [],
    materials: [{ id: 'scene:location', entityId: 'location', kind: 'scene', name: 'TEST场景', designHash: 'TEST', prompt: structuredClone(prompt) }],
    plan: { sourceSummary: 'TEST', adaptedStory: 'TEST', characters: [], props: [], scenes: [], shots: [{ id: 'shot', order: 1, scene: 'TEST', action: 'TEST', startState: 'TEST', endState: 'TEST', characterIds: [], durationSeconds: 5, transition: 'cut', requestedMode: 'first_frame', prompts: { firstFrame: structuredClone(prompt), video: structuredClone(prompt) } }] },
    jobs: [{ id: 'TEST-review', kind: 'review', taskId: 'TEST-task', inputHash: 'TEST', sourceUrl: '', status: 'applied', requestId: 'TEST-request', resultStatus: 'candidate', reviewInputFinals: { 'scene:location': 'TEST', 'shot:firstFrame': 'TEST', 'shot:video': 'TEST' }, parsedResult: { issues: [issue('material-error', 'scene:location', 'error'), issue('material-suggestion', 'scene:location', 'suggestion'), issue('frame-suggestion', 'shot:firstFrame', 'suggestion'), issue('video-error', 'shot:video', 'error')] } }],
  };
  usePetStoryStore.setState({ project, busy: false, freeChatConfirmed: true }); useTaskStore.setState({ tasks: [] });
});
afterEach((): void => { usePetStoryStore.setState(initial.petstory); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });

describe('C12显式选择同一目标的修订问题', (): void => {
  it('素材、单镜和全局界面默认只勾错误，同目标建议保留但不默认发送', (): void => {
    const material = renderToStaticMarkup(<PetStoryMaterials project={project} disabled={false} />);
    expect(material).toContain('修订所选 1 项问题');
    const inputs = material.match(/<input\b[^>]*>/g) || [];
    expect(inputs.find((entry): boolean => entry.includes('material-error'))).toContain('checked');
    expect(inputs.find((entry): boolean => entry.includes('material-suggestion'))).not.toContain('checked');
    const frame = renderToStaticMarkup(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={(): void => undefined} />);
    expect(frame).toContain('修订所选 0 项问题'); expect(frame).not.toContain('TEST影响video-error');
    const runtime = renderToStaticMarkup(<PetStoryRuntime project={project} disabled={false} />);
    // 同一素材的错误和建议合并为一个选择组；首帧、视频分别修订。
    expect(runtime.match(/修订所选 1 项问题/g)).toHaveLength(2);
    expect(runtime.match(/修订所选 0 项问题/g)).toHaveLength(1);
    expect(runtime).not.toContain('按审查问题定点修订');
  });
  it('实际选择只传本组ID，空选择不发送；已修订保留用户明确发起新一轮入口', (): void => {
    const issues = [issue('error', 'scene:location', 'error'), issue('warning', 'scene:location', 'warning'), issue('suggestion', 'scene:location', 'suggestion')];
    let choices: Record<string, boolean> = { 'foreign-issue': true };
    const setChoices: React.Dispatch<React.SetStateAction<Record<string, boolean>>> = (action): void => { choices = typeof action === 'function' ? action(choices) : action; };
    vi.spyOn(React, 'useState').mockImplementation(((): [Record<string, boolean>, typeof setChoices] => [choices, setChoices]) as typeof React.useState);
    const revise = vi.fn(async (): Promise<void> => undefined);
    const draw = (revised = false): React.ReactElement[] => tree(ReviewIssueSelection({ issues, targetLabel: 'TEST同一目标', disabled: false, revised, onRevise: revise }));
    const click = (revised = false): void => { const button = draw(revised).find((entry): boolean => entry.type === Button)!; (button.props as { onClick: () => void }).onClick(); };
    const choose = (id: string, checked: boolean): void => { const checkbox = draw().find((entry): boolean => entry.type === Checkbox && (entry.props as { 'data-issue-id': string })['data-issue-id'] === id)!; (checkbox.props as { onChange: (event: { target: { checked: boolean } }) => void }).onChange({ target: { checked } }); };
    click(); expect(revise).toHaveBeenLastCalledWith(['error']);
    choose('suggestion', true); click(); expect(revise).toHaveBeenLastCalledWith(['error', 'suggestion']);
    choose('error', false); click(); expect(revise).toHaveBeenLastCalledWith(['suggestion']);
    choose('suggestion', false); const calls = revise.mock.calls.length; click(); expect(revise).toHaveBeenCalledTimes(calls);
    choose('warning', true);
    const nextRound = draw(true).find((entry): boolean => entry.type === Button)!;
    expect((nextRound.props as { children: string }).children).toBe('主动开始新一轮修订（保留上轮）');
    click(true); expect(revise).toHaveBeenCalledTimes(calls + 1); expect(revise).toHaveBeenLastCalledWith(['warning']);
  });
});

/** 仅离线快照与组件行为；TEST 正文不冒充真实豆包产出。 */
describe('审查逐目标送审正文快照', (): void => {
  it('全局快照逐项匹配；一项正文采用新稿只使这一项目的问题成为历史', (): void => {
    project.plan!.shots[0].prompts.video.final = 'TEST新采用视频';
    const review = project.jobs[0];
    expect(reviewMatchesPrompt(review, 'scene:location', project.materials![0].prompt.final)).toBe(true);
    expect(reviewMatchesPrompt(review, 'shot:video', project.plan!.shots[0].prompts.video.final)).toBe(false);
    const runtime = renderToStaticMarkup(<PetStoryRuntime project={project} disabled={false} />);
    expect(runtime).toContain('data-review-target="scene:location" data-review-current="true"');
    expect(runtime).toContain('data-review-target="shot:video" data-review-current="false"');
    expect(runtime).toContain('TEST证据video-error');
    expect(runtime).toContain('历史审查问题：当前正文已变化或缺少送审快照');
    const historicalVideo = runtime.split('data-review-target="shot:video"')[1];
    expect(historicalVideo.match(/<button\b[^>]*>/)?.[0]).toContain('disabled');
    const frame = renderToStaticMarkup(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="video" disabled={false} generationBlocked={false} dirtyChanged={(): void => undefined} />);
    expect(frame).not.toContain('TEST证据video-error');
    expect(frame).not.toContain('修订所选');
    expect(renderToStaticMarkup(<PetStoryMaterials project={project} disabled={false} />)).toContain('修订所选 1 项问题');
  });
  it('素材正文变化时卡片不再套用旧问题，实体ID问题仍按素材canonical ID比对', (): void => {
    project.jobs[0].parsedResult!.issues![0].targetId = 'location';
    expect(renderToStaticMarkup(<PetStoryMaterials project={project} disabled={false} />)).toContain('TEST证据material-error');
    project.materials![0].prompt.final = 'TEST新采用素材';
    const material = renderToStaticMarkup(<PetStoryMaterials project={project} disabled={false} />);
    expect(material).not.toContain('TEST证据material-error');
    expect(material).not.toContain('修订所选');
    const runtime = renderToStaticMarkup(<PetStoryRuntime project={project} disabled={false} />);
    expect(runtime).toContain('TEST证据material-error');
    expect(runtime).toContain('data-review-target="scene:location" data-review-current="false"');
  });
  it('旧全局无快照只保留历史，不能用undefined inputFinal绕过当前正文比对', (): void => {
    delete project.jobs[0].reviewInputFinals;
    const review = project.jobs[0];
    expect(reviewMatchesPrompt(review, 'shot:video', 'TEST')).toBe(false);
    expect(renderToStaticMarkup(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="video" disabled={false} generationBlocked={false} dirtyChanged={(): void => undefined} />)).not.toContain('修订所选');
    expect(renderToStaticMarkup(<PetStoryMaterials project={project} disabled={false} />)).not.toContain('修订所选');
    const runtime = renderToStaticMarkup(<PetStoryRuntime project={project} disabled={false} />);
    expect(runtime).toContain('TEST证据video-error');
    expect(runtime.match(/data-review-current="false"/g)).toHaveLength(3);
    expect((runtime.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []).filter((entry): boolean => entry.includes('修订所选')).every((entry): boolean => /<button\b[^>]*disabled/.test(entry))).toBe(true);
  });
  it.each([
    { target: { shotId: 'shot', promptKind: 'firstFrame' as const }, id: 'shot:firstFrame' },
    { target: { materialId: 'scene:location' }, id: 'scene:location' },
  ])('旧明确单项目标 $id 的 inputFinal仍可兼容，错目标或正文变化拒绝', ({ target, id }): void => {
    const review: PetStoryChatJob = { ...project.jobs[0], ...target, reviewInputFinals: undefined, inputFinal: 'TEST' };
    expect(reviewMatchesPrompt(review, id, 'TEST')).toBe(true);
    expect(reviewMatchesPrompt(review, id, 'TEST ')).toBe(false);
    expect(reviewMatchesPrompt(review, 'shot:video', 'TEST')).toBe(false);
    expect(reviewMatchesPrompt({ ...review, inputFinal: undefined }, id, 'TEST')).toBe(false);
  });
  it('新map缺键不回退单项inputFinal，不接受继承键、未定义目标、过期或非审查回复', (): void => {
    const review: PetStoryChatJob = { ...project.jobs[0], shotId: 'shot', promptKind: 'firstFrame', inputFinal: 'TEST', reviewInputFinals: { 'shot:video': 'TEST' } };
    expect(reviewMatchesPrompt(review, 'shot:firstFrame', 'TEST')).toBe(false);
    expect(reviewMatchesPrompt({ ...review, reviewInputFinals: Object.create({ 'shot:firstFrame': 'TEST' }) as Record<string, string> }, 'shot:firstFrame', 'TEST')).toBe(false);
    expect(reviewMatchesPrompt(project.jobs[0], 'shot:video', undefined)).toBe(false);
    expect(reviewMatchesPrompt({ ...project.jobs[0], resultStatus: 'stale' }, 'shot:video', 'TEST')).toBe(false);
    expect(reviewMatchesPrompt({ ...project.jobs[0], status: 'bound' }, 'shot:video', 'TEST')).toBe(false);
    expect(reviewMatchesPrompt({ ...project.jobs[0], kind: 'optimize' }, 'shot:video', 'TEST')).toBe(false);
  });
  it('空串也是实际送审正文，原样比较而不将缺键当空串', (): void => {
    const review = { ...project.jobs[0], reviewInputFinals: { 'shot:video': '' } };
    expect(reviewMatchesPrompt(review, 'shot:video', '')).toBe(true);
    expect(reviewMatchesPrompt(review, 'shot:firstFrame', '')).toBe(false);
  });
  it('未采用新候选不改变当前手改final的匹配，明确采用后旧问题才失效', (): void => {
    const prompt = project.plan!.shots[0].prompts.firstFrame;
    prompt.edited = true; prompt.optimized = 'TEST新候选';
    expect(currentReviewPrompt(project, 'shot:firstFrame')).toBe('TEST');
    expect(reviewMatchesPrompt(project.jobs[0], 'shot:firstFrame', currentReviewPrompt(project, 'shot:firstFrame'))).toBe(true);
    const before = renderToStaticMarkup(<CanvasPromptEditor project={project} shot={project.plan!.shots[0]} kind="firstFrame" disabled={false} generationBlocked={false} dirtyChanged={(): void => undefined} />);
    expect(before).toContain('TEST证据frame-suggestion');
    prompt.final = prompt.optimized;
    expect(reviewMatchesPrompt(project.jobs[0], 'shot:firstFrame', currentReviewPrompt(project, 'shot:firstFrame'))).toBe(false);
  });
  it('正式审查格式repair使用继承的原map；其快照不能证明更换后的正文', (): void => {
    const original = project.jobs[0]; original.status = 'invalid'; original.sourceStoryId = 'TEST-story';
    const repaired: PetStoryChatJob = { ...original, id: 'TEST-review-repair', kind: 'repair', status: 'applied', parentJobId: original.id, reviewInputFinals: structuredClone(original.reviewInputFinals) };
    project.jobs.push(repaired);
    expect(reviewMatchesCurrentPrompts(project, repaired)).toBe(true);
    project.plan!.shots[0].prompts.video.final = 'TEST新采用视频';
    expect(reviewMatchesPrompt(repaired, 'shot:video', currentReviewPrompt(project, 'shot:video'))).toBe(false);
    expect(reviewMatchesPrompt(repaired, 'scene:location', currentReviewPrompt(project, 'scene:location'))).toBe(true);
    expect(renderToStaticMarkup(<PetStoryRuntime project={project} disabled={false} />)).toContain('历史审查问题');
  });
  it.each(['missing', 'changed'] as const)('空issues仍保留当次结论，$type快照不表示当前正文通过', (type): void => {
    project.jobs[0].parsedResult = { issues: [] };
    if (type === 'missing') delete project.jobs[0].reviewInputFinals;
    else project.plan!.shots[0].prompts.video.final = 'TEST新采用视频';
    const runtime = renderToStaticMarkup(<PetStoryRuntime project={project} disabled={false} />);
    expect(runtime).toContain('本次豆包审查未提出内容问题');
    expect(runtime).toContain('不代表当前正文已通过，请重新审查');
  });
  it('当前正文仍完全匹配的空issues审查不误标成过期', (): void => {
    project.jobs[0].parsedResult = { issues: [] };
    const runtime = renderToStaticMarkup(<PetStoryRuntime project={project} disabled={false} />);
    expect(runtime).toContain('本次豆包审查未提出内容问题');
    expect(runtime).not.toContain('不代表当前正文已通过');
  });
});
