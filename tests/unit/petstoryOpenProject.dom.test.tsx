import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

function locationDialog(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: '按位置打开' }));
  return screen.getByRole('dialog', { name: '按位置打开项目' });
}
function enterLocation(dialog: HTMLElement, path: string): void {
  fireEvent.change(within(dialog).getByRole('textbox', { name: '项目位置' }), { target: { value: path } });
}
async function finishDialogClose(dialog: HTMLElement): Promise<void> {
  // happy-dom 不执行 CSS 动画，派发真实离场事件完成弹窗关闭。
  await waitFor((): void => expect(dialog.classList.contains('ant-zoom-leave-active')).toBe(true));
  fireEvent.animationEnd(dialog);
  await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
}

describe('项目文件选择器的可见备用入口', (): void => {
  it('保留普通文件选择器按钮和成功回调，不添加位置参数', async (): Promise<void> => {
    render(<PetStoryOpenProject onOpened={onOpened} />);
    fireEvent.click(screen.getByRole('button', { name: '打开项目' }));
    await waitFor((): void => expect(onOpened).toHaveBeenCalledOnce());
    expect(openProject).toHaveBeenCalledWith();
  });

  it('打开备用弹窗、输入空白或取消均不打开项目', (): void => {
    render(<PetStoryOpenProject onOpened={onOpened} />); const dialog = locationDialog();
    const input = within(dialog).getByRole('textbox', { name: '项目位置' });
    expect(within(dialog).getByRole('button', { name: '打开此项目' }).hasAttribute('disabled')).toBe(true);
    enterLocation(dialog, '   '); fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    expect(within(dialog).getByRole('button', { name: '打开此项目' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(openProject).not.toHaveBeenCalled(); expect(onOpened).not.toHaveBeenCalled();
  });

  it.each(['/TEST/短剧文件夹', '/TEST/短剧文件夹/project.json'])('指定位置%s沿原打开方法成功并关闭弹窗', async (path): Promise<void> => {
    render(<PetStoryOpenProject onOpened={onOpened} />); const dialog = locationDialog();
    enterLocation(dialog, `  ${path}  `); fireEvent.click(within(dialog).getByRole('button', { name: '打开此项目' }));
    await waitFor((): void => expect(onOpened).toHaveBeenCalledOnce());
    expect(openProject).toHaveBeenCalledExactlyOnceWith(path);
    await finishDialogClose(dialog);
  });

  it('失败原因就地显示并保留输入，修正后按回车可再次打开', async (): Promise<void> => {
    openProject.mockImplementationOnce(async (): Promise<void> => { usePetStoryStore.setState({ error: 'TEST 没有找到项目文件' }); });
    render(<PetStoryOpenProject onOpened={onOpened} />); const dialog = locationDialog();
    enterLocation(dialog, '/TEST/原位置'); fireEvent.click(within(dialog).getByRole('button', { name: '打开此项目' }));
    await waitFor((): void => expect(within(dialog).getByRole('alert').textContent).toContain('TEST 没有找到项目文件'));
    expect((within(dialog).getByRole('textbox', { name: '项目位置' }) as HTMLInputElement).value).toBe('/TEST/原位置'); expect(onOpened).not.toHaveBeenCalled();
    enterLocation(dialog, '/TEST/修正位置/project.json'); fireEvent.keyDown(within(dialog).getByRole('textbox', { name: '项目位置' }), { key: 'Enter', keyCode: 13 });
    await waitFor((): void => expect(onOpened).toHaveBeenCalledOnce());
    expect(openProject).toHaveBeenLastCalledWith('/TEST/修正位置/project.json');
  });

  it('打开过程抛错也保留位置和可关闭入口', async (): Promise<void> => {
    openProject.mockRejectedValueOnce(new Error('TEST 文件暂时无法读取'));
    render(<PetStoryOpenProject onOpened={onOpened} />); const dialog = locationDialog();
    enterLocation(dialog, '/TEST/保留位置'); fireEvent.click(within(dialog).getByRole('button', { name: '打开此项目' }));
    await waitFor((): void => expect(within(dialog).getByRole('alert').textContent).toContain('TEST 文件暂时无法读取'));
    expect((within(dialog).getByRole('textbox', { name: '项目位置' }) as HTMLInputElement).value).toBe('/TEST/保留位置');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await finishDialogClose(dialog); expect(onOpened).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'busy'] as const)('%s时普通和备用入口都遵守原操作禁用状态', (reason): void => {
    if (reason === 'busy') usePetStoryStore.setState({ busy: true });
    render(<PetStoryOpenProject disabled={reason === 'disabled'} onOpened={onOpened} />);
    expect(screen.getByRole('button', { name: '打开项目' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '按位置打开' }).hasAttribute('disabled')).toBe(true);
    expect(openProject).not.toHaveBeenCalled();
  });
});
