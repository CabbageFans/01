/** 停止入口的离线交互验收；不发送豆包请求，不修改真实项目。 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryImageOperation, PetStoryImageTarget, PetStoryProject } from '@doubao-studio/contracts';
import { PetStoryImageReview } from '../../src/components/PetStoryImageReview';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';

const original = { story: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const target: PetStoryImageTarget = { materialId: 'TEST-prop' };
const now = '2026-11-06T00:00:00.000Z';
let project: PetStoryProject;
const stop = vi.fn<(target: PetStoryImageTarget) => Promise<void>>();
const generate = vi.fn<() => Promise<void>>();
const modify = vi.fn<(assetId: string, feedback: string) => Promise<void>>();
const adopt = vi.fn<(assetId: string) => Promise<void>>();
const upload = vi.fn<() => Promise<void>>();
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve = (): void => undefined; let reject: (error: Error) => void = (): void => undefined;
  const promise = new Promise<void>((done, fail): void => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function operation(stage: PetStoryImageOperation['stage']): PetStoryImageOperation {
  return { id: 'TEST-image-operation', requestId: 'TEST-request', target, mode: 'generate', stage, basisHash: 'TEST', createdAt: now };
}
function image(): void {
  project.assets = [{ id: 'TEST-image', materialId: target.materialId, kind: 'prop', relativePath: 'TEST/image.png', imageReview: { state: 'candidate', target, basisHash: 'TEST' }, validation: { decoded: true, bytes: 1, width: 64, height: 64, sha256: 'TEST', checkedAt: now } }];
}
const Review: React.FC<{ disabled?: boolean; other?: boolean; generating?: boolean }> = ({ disabled = false, other = false, generating }): React.ReactElement => {
  const current = usePetStoryStore((state) => state.project)!;
  return <PetStoryImageReview project={current} target={other ? { materialId: 'TEST-other' } : target} title="长棍 · 道具参考图" disabled={disabled} generating={generating} onGenerate={generate} onModify={modify} onAdopt={adopt} onUpload={upload} />;
};
beforeEach((): void => {
  vi.resetAllMocks(); stop.mockResolvedValue(undefined); generate.mockResolvedValue(undefined); modify.mockResolvedValue(undefined); upload.mockResolvedValue(undefined);
  project = { schemaVersion: 1, id: 'TEST-stop-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, source: { kind: 'script', url: '', status: 'review_required' }, assets: [], jobs: [], updatedAt: now };
  usePetStoryStore.setState({ ...original.story, project, error: '', imageTargetErrors: {}, activeImageOperationId: null, activeImageOperationIds: [], pendingImageTargets: [], stopImageOperation: stop });
  useTaskStore.setState({ ...original.tasks, tasks: [] });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { petstory: { readReference: vi.fn(async (): Promise<{ success: boolean; data: string }> => ({ success: true, data: 'data:image/png;base64,TEST' })) } } });
});
afterEach((): void => { cleanup(); usePetStoryStore.setState(original.story); useTaskStore.setState(original.tasks); vi.restoreAllMocks(); });

describe('图片任务停止入口', (): void => {
  it('停止持久化后可上传新候选并自动预览，旧停止错误不覆盖本图采用，卡片保留原任务继续入口', async (): Promise<void> => {
    const stoppedMessage = '本次图片任务已暂停，请继续原任务';
    project.materials = [{ id: target.materialId!, entityId: 'TEST-prop', kind: 'prop', name: 'TEST道具', designHash: 'TEST',
      prompt: { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST' } }];
    project.imageOperations = [operation('generating')]; usePetStoryStore.setState({ project, activeImageOperationIds: ['TEST-image-operation'], busy: false });
    const persisted = deferred();
    stop.mockImplementation(async (): Promise<void> => {
      await persisted.promise; project = structuredClone(project); project.revision++; project.imageOperations![0].stage = 'failed'; project.imageOperations![0].error = stoppedMessage;
      usePetStoryStore.setState({ project, activeImageOperationIds: [], activeImageOperationId: null, error: 'TEST停止前旧错误',
        imageTargetErrors: { [`material:${target.materialId}`]: stoppedMessage, 'material:TEST-other': 'TEST其他图片错误' } });
    });
    window.electronAPI.petstory.addMaterialImage = vi.fn(async (): Promise<{ success: boolean; project: PetStoryProject }> => {
      project = structuredClone(usePetStoryStore.getState().project!); project.revision++; image(); return { success: true, project };
    });
    window.electronAPI.petstory.approveMaterials = vi.fn(async (): Promise<{ success: boolean; project: PetStoryProject }> => {
      project = structuredClone(usePetStoryStore.getState().project!); project.revision++; project.materials![0].selectedAssetId = 'TEST-image';
      project.assets[0].imageReview = { ...project.assets[0].imageReview!, state: 'adopted', adoptedAt: now }; return { success: true, project };
    });
    upload.mockImplementation((): Promise<void> => original.story.addMaterialImage(target.materialId!));
    adopt.mockImplementation((assetId: string): Promise<void> => original.story.approveMaterials([{ materialId: target.materialId!, assetId }]));
    render(<Review />); fireEvent.click(screen.getByRole('button', { name: /停\s*止/ }));
    expect(screen.getByRole('button', { name: '上传图片' }).hasAttribute('disabled')).toBe(true);
    await act(async (): Promise<void> => { persisted.resolve(); await persisted.promise; });
    const action = screen.getByRole('button', { name: '上传图片' });
    await waitFor((): void => { expect(action.hasAttribute('disabled')).toBe(false); expect(action.classList.contains('ant-btn-loading')).toBe(false); });
    fireEvent.click(action);
    await waitFor((): void => expect(screen.getByRole('dialog')).toBeDefined());
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText(stoppedMessage)).toBeNull();
    expect(usePetStoryStore.getState().imageTargetErrors[`material:${target.materialId}`]).toBeUndefined();
    expect(usePetStoryStore.getState().imageTargetErrors['material:TEST-other']).toBe('TEST其他图片错误');
    const apply = within(dialog).getByRole('button', { name: '满意，采用图片' });
    await waitFor((): void => { expect(apply.hasAttribute('disabled')).toBe(false); expect(apply.classList.contains('ant-btn-loading')).toBe(false); });
    fireEvent.click(apply); await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
    expect(adopt).toHaveBeenCalledExactlyOnceWith('TEST-image'); expect(upload).toHaveBeenCalledOnce(); expect(generate).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().project?.imageOperations![0]).toMatchObject({ stage: 'failed', error: stoppedMessage });
    expect(screen.getByRole('button', { name: '继续本次任务' })).toBeDefined();
  });

  it('仅入口资格读取中没有实际图片流程时不显示停止', (): void => {
    render(<Review generating />);
    expect(screen.getByRole('button', { name: '生成图片' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: /停\s*止/ })).toBeNull(); expect(stop).not.toHaveBeenCalled();
  });
  it.each(['preparing', 'generating', 'saving'] as const)('%s阶段生成被禁用仍可停止，等待落盘期间不能重复点击', async (stage): Promise<void> => {
    project.imageOperations = [operation(stage)];
    usePetStoryStore.setState({ project, activeImageOperationIds: ['TEST-image-operation'] });
    const pending = deferred(); stop.mockReturnValue(pending.promise);
    render(<Review disabled />);
    expect(screen.getByRole('button', { name: '生成图片' }).hasAttribute('disabled')).toBe(true);
    const action = screen.getByRole('button', { name: /停\s*止/ });
    expect(action.hasAttribute('disabled')).toBe(false); fireEvent.click(action); fireEvent.click(action);
    expect(stop).toHaveBeenCalledExactlyOnceWith(target); expect(action.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('正在停止图片任务');
    await act(async (): Promise<void> => { pending.resolve(); await pending.promise; });
    expect(generate).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled();
  });

  it('开始请求尚未返回即可停止，迟到的失败不会覆盖停止后的结果', async (): Promise<void> => {
    const pending = deferred(); generate.mockReturnValue(pending.promise); render(<Review />);
    fireEvent.click(screen.getByRole('button', { name: '生成图片' }));
    fireEvent.click(screen.getByRole('button', { name: /停\s*止/ }));
    await waitFor((): void => expect(screen.queryByRole('button', { name: /停\s*止/ })).toBeNull());
    await act(async (): Promise<void> => { pending.reject(new Error('TEST 迟到的启动失败')); await pending.promise.catch((): void => undefined); });
    expect(screen.queryByText('TEST 迟到的启动失败')).toBeNull();
    expect(stop).toHaveBeenCalledExactlyOnceWith(target); expect(generate).toHaveBeenCalledOnce();
  });

  it('预览中的重新生成仅显示一个停止入口，停止后关闭预览', async (): Promise<void> => {
    image(); usePetStoryStore.setState({ project }); const pending = deferred(); generate.mockReturnValue(pending.promise);
    render(<Review />); fireEvent.click(screen.getByRole('button', { name: '查看图片' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '重新生成' }));
    expect(screen.getAllByRole('button', { name: /停\s*止/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /停\s*止/ }));
    await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async (): Promise<void> => { pending.resolve(); await pending.promise; });
    expect(adopt).not.toHaveBeenCalled(); expect(project.assets).toHaveLength(1);
  });

  it('修改提交等待时能停止，迟到的修改完成不重开弹窗或采用图片', async (): Promise<void> => {
    image(); usePetStoryStore.setState({ project }); const pending = deferred(); modify.mockReturnValue(pending.promise);
    render(<Review />); fireEvent.click(screen.getByRole('button', { name: '查看图片' }));
    const change = within(screen.getByRole('dialog')).getByRole('button', { name: '不满意，修改图片' });
    await waitFor((): void => expect(change.hasAttribute('disabled')).toBe(false)); fireEvent.click(change);
    const dialog = screen.getByRole('dialog', { name: '修改这张图片' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '图片修改意见' }), { target: { value: '保留木纹，缩短一点' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '提交修改' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /停\s*止/ }));
    await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async (): Promise<void> => { pending.resolve(); await pending.promise; });
    expect(modify).toHaveBeenCalledExactlyOnceWith('TEST-image', '保留木纹，缩短一点'); expect(adopt).not.toHaveBeenCalled();
  });

  it.each(['failed', 'complete'] as const)('历史%s操作及其他素材不显示停止', (stage): void => {
    project.imageOperations = [operation(stage)]; usePetStoryStore.setState({ project });
    if (stage === 'complete') { image(); project.imageOperations[0].outputAssetId = 'TEST-image'; }
    const { unmount } = render(<Review />); expect(screen.queryByRole('button', { name: /停\s*止/ })).toBeNull(); unmount();
    project.imageOperations[0].stage = 'generating'; usePetStoryStore.setState({ activeImageOperationIds: ['TEST-image-operation'] });
    render(<Review other />); expect(screen.queryByRole('button', { name: /停\s*止/ })).toBeNull();
  });

  it('停止失败显示真实原因并保留重试停止入口', async (): Promise<void> => {
    project.imageOperations = [operation('generating')]; usePetStoryStore.setState({ project, activeImageOperationIds: ['TEST-image-operation'] });
    stop.mockRejectedValueOnce(new Error('TEST 暂停尚未落盘')); render(<Review />);
    fireEvent.click(screen.getByRole('button', { name: /停\s*止/ }));
    await waitFor((): void => expect(screen.getByRole('alert').textContent).toContain('TEST 暂停尚未落盘'));
    const action = screen.getByRole('button', { name: /停\s*止/ });
    await waitFor((): void => { expect(action.hasAttribute('disabled')).toBe(false); expect(action.classList.contains('ant-btn-loading')).toBe(false); });
    fireEvent.click(action); await waitFor((): void => expect(stop).toHaveBeenCalledTimes(2));
  });

  it('修改弹窗内停止失败可见且能重试，保留意见和选图', async (): Promise<void> => {
    image(); usePetStoryStore.setState({ project }); const pending = deferred(); modify.mockReturnValue(pending.promise);
    stop.mockRejectedValueOnce(new Error('TEST 停止写盘失败'));
    render(<Review />); fireEvent.click(screen.getByRole('button', { name: '查看图片' }));
    const change = within(screen.getByRole('dialog')).getByRole('button', { name: '不满意，修改图片' });
    await waitFor((): void => expect(change.hasAttribute('disabled')).toBe(false)); fireEvent.click(change);
    const dialog = screen.getByRole('dialog', { name: '修改这张图片' });
    const input = within(dialog).getByRole('textbox', { name: '图片修改意见' });
    fireEvent.change(input, { target: { value: '保留木纹' } }); fireEvent.click(within(dialog).getByRole('button', { name: '提交修改' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /停\s*止/ }));
    await waitFor((): void => expect(within(dialog).getByRole('alert').textContent).toContain('TEST 停止写盘失败'));
    expect((input as HTMLTextAreaElement).value).toBe('保留木纹');
    expect(within(dialog).getByRole('button', { name: /提交修改/ }).hasAttribute('disabled')).toBe(true);
    const retry = within(dialog).getByRole('button', { name: /停\s*止/ });
    // AntD在prop更新后还会通过effect解除内部loading；按用户能再次点击的状态重试。
    await waitFor((): void => { expect(retry.hasAttribute('disabled')).toBe(false); expect(retry.classList.contains('ant-btn-loading')).toBe(false); });
    fireEvent.click(retry);
    await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async (): Promise<void> => { pending.resolve(); await pending.promise; });
    expect(stop).toHaveBeenCalledTimes(2); expect(modify).toHaveBeenCalledOnce(); expect(adopt).not.toHaveBeenCalled();
  });

  it.each(['generate', 'stop'] as const)('切换项目后%s迟到回调不覆盖新项目预览', async (action): Promise<void> => {
    const pending = deferred(); generate.mockReturnValue(action === 'generate' ? pending.promise : new Promise<void>((): void => undefined));
    if (action === 'stop') stop.mockReturnValue(pending.promise);
    render(<Review />); fireEvent.click(screen.getByRole('button', { name: '生成图片' }));
    if (action === 'stop') fireEvent.click(screen.getByRole('button', { name: /停\s*止/ }));
    image(); const next = { ...project, id: 'TEST-new-project' };
    act((): void => usePetStoryStore.setState({ project: next }));
    fireEvent.click(screen.getByRole('button', { name: '查看图片' }));
    await act(async (): Promise<void> => { if (action === 'generate') pending.reject(new Error('TEST 旧项目失败')); else pending.resolve(); await pending.promise.catch((): void => undefined); });
    expect(screen.getByRole('dialog')).toBeDefined(); expect(screen.queryByText('TEST 旧项目失败')).toBeNull();
    expect(usePetStoryStore.getState().project?.id).toBe('TEST-new-project');
  });
});
