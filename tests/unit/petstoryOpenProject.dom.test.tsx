import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryProject } from '@doubao-studio/contracts';
import { PetStoryOpenProject } from '../../src/components/PetStoryOpenProject';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';

const initial = usePetStoryStore.getState();
const opened: PetStoryProject = { schemaVersion: 1, id: 'TEST-opened', revision: 1, studioProjectId: 'TEST-studio', accountId: 'TEST-account',
  source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [], updatedAt: '2026-11-03T00:00:00.000Z' };
const openProject = vi.fn<(path?: string) => Promise<void>>(async (): Promise<void> => { usePetStoryStore.setState({ project: opened, error: '' }); });
const onOpened = vi.fn();
beforeEach((): void => {
  vi.clearAllMocks();
  usePetStoryStore.setState({ ...initial, project: null, error: '', busy: false, openProject });
});
afterEach((): void => { cleanup(); usePetStoryStore.setState(initial); });

describe('项目文件选择器', (): void => {
  it('保留普通文件选择器按钮和成功回调，不添加位置参数', async (): Promise<void> => {
    render(<PetStoryOpenProject onOpened={onOpened} />);
    fireEvent.click(screen.getByRole('button', { name: '打开项目' }));
    await waitFor((): void => expect(onOpened).toHaveBeenCalledOnce());
    expect(openProject).toHaveBeenCalledWith();
  });

  it.each(['disabled', 'busy'] as const)('%s时打开入口遵守原操作禁用状态', (reason): void => {
    if (reason === 'busy') usePetStoryStore.setState({ busy: true });
    render(<PetStoryOpenProject disabled={reason === 'disabled'} onOpened={onOpened} />);
    expect(screen.getByRole('button', { name: '打开项目' }).hasAttribute('disabled')).toBe(true);
    expect(openProject).not.toHaveBeenCalled();
  });
});
