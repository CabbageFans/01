/** 审查关注点只作为用户疑点进入审查，不直接变成正文。 */
import React from 'react';
import { Button, Input } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryProject } from '@doubao-studio/contracts';
import { PetStoryRuntime } from '../../src/components/PetStoryRuntime';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';

const initial = { petstory: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
let project: PetStoryProject;
let focus: string;
const review = vi.fn(async (): Promise<void> => undefined);
function tree(node: React.ReactNode): React.ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(tree);
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return [];
  return [node, ...tree(node.props.children)];
}
function view(): React.ReactElement[] { return tree(PetStoryRuntime({ project, disabled: false })); }
function reviewButton(): { disabled: boolean; onClick: () => void } {
  return view().find((entry): boolean => entry.type === Button && (entry.props as { children: string }).children === '审查当前方案与提示词')!.props as { disabled: boolean; onClick: () => void };
}
function focusInput(): { disabled: boolean; maxLength: number; onChange: (event: { target: { value: string } }) => void } {
  return view().find((entry): boolean => entry.type === Input.TextArea)!.props as ReturnType<typeof focusInput>;
}
beforeEach((): void => {
  focus = ''; review.mockClear();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation(<T,>(_subscribe: (onStoreChange: () => void) => () => void, getSnapshot: () => T): T => getSnapshot());
  vi.spyOn(React, 'useCallback').mockImplementation(((callback: unknown): unknown => callback) as typeof React.useCallback);
  vi.spyOn(React, 'useDebugValue').mockImplementation((): void => undefined);
  const setFocus: React.Dispatch<React.SetStateAction<string>> = (value): void => { focus = typeof value === 'function' ? value(focus) : value; };
  vi.spyOn(React, 'useState').mockImplementation(((): [string, typeof setFocus] => [focus, setFocus]) as typeof React.useState);
  project = { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, updatedAt: '2026-10-26T00:00:00.000Z', source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [], plan: { sourceSummary: 'TEST', adaptedStory: 'TEST', characters: [], props: [], scenes: [], shots: [] } };
  usePetStoryStore.setState({ project, busy: false, freeChatConfirmed: true, reviewContent: review }); useTaskStore.setState({ tasks: [] });
});
afterEach((): void => { usePetStoryStore.setState(initial.petstory); useTaskStore.setState(initial.tasks); vi.restoreAllMocks(); });

describe('用户可选内容审查关注点', (): void => {
  it('控件限制2000字，按钮只传trim后的疑点；空输入沿原全方案审查', (): void => {
    expect(focusInput().maxLength).toBe(2000);
    focusInput().onChange({ target: { value: '  TEST 需要核对的疑点\n ' } }); reviewButton().onClick();
    expect(review).toHaveBeenLastCalledWith({ reviewFocus: 'TEST 需要核对的疑点' });
    focusInput().onChange({ target: { value: ' \n ' } }); reviewButton().onClick(); expect(review).toHaveBeenLastCalledWith(undefined);
  });
  it('有原请求未收取或未核对免费Chat时，关注点与审查按钮同步禁用', (): void => {
    project.jobs.push({ id: 'TEST-pending', taskId: 'TEST-task', kind: 'review', status: 'bound', sourceUrl: '', inputHash: 'TEST' });
    expect(focusInput().disabled).toBe(true); expect(reviewButton().disabled).toBe(true);
    project.jobs = []; usePetStoryStore.setState({ freeChatConfirmed: false });
    expect(focusInput().disabled).toBe(true); expect(reviewButton().disabled).toBe(true); expect(review).not.toHaveBeenCalled();
  });
});
