/** 真实组件的默认勾选、用户选择与修订回调；仅离线渲染，不请求平台。 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button, Checkbox } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryProject, PetStoryReviewIssue } from '@doubao-studio/contracts';
import { ReviewIssueSelection } from '../../src/components/PetStoryReviewIssues';
import { PetStoryMaterials } from '../../src/components/PetStoryMaterials';
import { PetStoryRuntime } from '../../src/components/PetStoryRuntime';
import { CanvasPromptEditor } from '../../src/components/PetStoryCanvasPrompt';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';

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
    materials: [{ id: 'scene:location', entityId: 'location', kind: 'scene', name: 'TEST场景', designHash: 'TEST', prompt }],
    plan: { sourceSummary: 'TEST', adaptedStory: 'TEST', characters: [], props: [], scenes: [], shots: [{ id: 'shot', order: 1, scene: 'TEST', action: 'TEST', startState: 'TEST', endState: 'TEST', characterIds: [], durationSeconds: 5, transition: 'cut', requestedMode: 'first_frame', prompts: { firstFrame: prompt, video: prompt } }] },
    jobs: [{ id: 'TEST-review', kind: 'review', taskId: 'TEST-task', inputHash: 'TEST', sourceUrl: '', status: 'applied', requestId: 'TEST-request', resultStatus: 'candidate', parsedResult: { issues: [issue('material-error', 'scene:location', 'error'), issue('material-suggestion', 'scene:location', 'suggestion'), issue('frame-suggestion', 'shot:firstFrame', 'suggestion'), issue('video-error', 'shot:video', 'error')] } }],
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
  it('实际选择回调只传本组ID：建议需明确勾选，空选择和已修订均不发送', (): void => {
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
    choose('warning', true); click(true); expect(revise).toHaveBeenCalledTimes(calls);
  });
});
