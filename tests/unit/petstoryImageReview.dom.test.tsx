/** DOM 仅用明确的文件读取替身验证采用边界，不调用平台或写入真实项目。 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryAsset, PetStoryImageTarget, PetStoryProject } from '@doubao-studio/contracts';
import { PetStoryImageReview, imageBelongsToTarget } from '../../src/components/PetStoryImageReview';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';

const original = usePetStoryStore.getState();
const now = '2026-10-29T00:00:00.000Z';
const target: PetStoryImageTarget = { shotId: 'TEST-shot', kind: 'firstFrame' };
function image(id: string, state: 'candidate' | 'adopted' = 'candidate'): PetStoryAsset {
  return { id, kind: 'firstFrame', shotId: target.shotId, relativePath: `TEST/${id}.png`, imageReview: { state, target, basisHash: 'TEST-basis' }, validation: { decoded: true, sha256: `TEST-${id}`, bytes: 1, width: 64, height: 64, checkedAt: now } };
}
let project: PetStoryProject;
beforeEach((): void => {
  project = { schemaVersion: 1, id: 'TEST-image-review', studioProjectId: 'TEST-project', accountId: 'TEST-account', revision: 1, source: { kind: 'script', url: '', status: 'review_required' }, assets: [image('old', 'adopted'), image('candidate-a'), image('candidate-b'), image('history', 'adopted')], adoptedImages: { 'TEST-shot': { firstFrameId: 'old' } }, jobs: [], updatedAt: now };
  usePetStoryStore.setState({ ...original, project, error: '', busy: false });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { petstory: { readReference: vi.fn(async (_projectId: string, assetId: string): Promise<{ success: boolean; data: string }> => ({ success: true, data: `data:image/png;base64,${assetId}` })) } } });
});
afterEach((): void => { usePetStoryStore.setState(original); vi.restoreAllMocks(); });

describe('图片候选预览与明确采用', (): void => {
  it('没有提示词时只突出生成提示词，入口尚未检查不会阻断文字准备', (): void => {
    project.assets = []; const prepare = vi.fn(async (): Promise<void> => undefined); const generate = vi.fn(async (): Promise<void> => undefined);
    render(<PetStoryImageReview project={project} target={target} title="镜头 3 · 首帧" disabled={false} generationDisabled promptReady={false} onPreparePrompt={prepare} onGenerate={generate} onUpload={async (): Promise<void> => undefined} onAdopt={async (): Promise<void> => undefined} />);
    const action = screen.getByRole('button', { name: '生成提示词' });
    expect(action.classList.contains('ant-btn-primary')).toBe(true); expect(action.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('button', { name: '生成图片' })).toBeNull(); expect(screen.getByRole('button', { name: '上传图片' })).toBeDefined();
    fireEvent.click(action); expect(prepare).toHaveBeenCalledOnce(); expect(generate).not.toHaveBeenCalled();
  });

  it('新候选到来时保留已采用缩略图，只突出查看并采用', (): void => {
    render(<PetStoryImageReview project={project} target={target} title="镜头 3 · 首帧" currentAssetId="old" disabled={false} onUpload={async (): Promise<void> => undefined} onAdopt={async (): Promise<void> => undefined} />);
    expect(screen.getByRole('button', { name: '查看镜头 3 · 首帧已采用图片' })).toBeDefined();
    expect(screen.queryByRole('button', { name: '查看图片' })).toBeNull();
    expect(screen.getAllByRole('button').filter((button): boolean => button.classList.contains('ant-btn-primary'))).toEqual([screen.getByRole('button', { name: '查看并采用' })]);
  });

  it.each([false, true])('当前旧图需复核时可预览并明确继续采用（外部确认失效=%s）', async (external): Promise<void> => {
    project.assets = [image('old', 'adopted')]; project.assets[0].needsReview = !external;
    const adopt = vi.fn(async (): Promise<void> => undefined);
    render(<PetStoryImageReview project={project} target={target} title="镜头 3 · 首帧" currentAssetId="old" currentNeedsReview={external} disabled={false} onUpload={async (): Promise<void> => undefined} onAdopt={adopt} />);
    fireEvent.click(screen.getByRole('button', { name: '查看并复核' })); const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('需要复核')).toBeDefined();
    const confirm = within(dialog).getByRole('button', { name: '确认继续使用' }); await waitFor((): void => expect(confirm.hasAttribute('disabled')).toBe(false));
    expect(adopt).not.toHaveBeenCalled(); fireEvent.click(confirm); await waitFor((): void => expect(adopt).toHaveBeenCalledExactlyOnceWith('old'));
  });

  it('预览、切换和关闭不写入，采用仅传入用户选中的那张', async (): Promise<void> => {
    const adopt = vi.fn(async (): Promise<void> => undefined);
    render(<PetStoryImageReview project={project} target={target} title="镜头 3 · 首帧" currentAssetId="old" disabled={false} onUpload={async (): Promise<void> => undefined} onAdopt={adopt} />);
    await waitFor((): void => expect(screen.getByRole('img', { name: '镜头 3 · 首帧 · 当前采用' }).getAttribute('src')).toContain('old'));
    fireEvent.click(screen.getByRole('button', { name: '查看并采用' }));
    const dialog = screen.getByRole('dialog', { name: '镜头 3 · 首帧 · 选择图片' });
    expect(within(dialog).getByText('镜头 3 · 首帧')).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: '选择候选图片 2' }));
    await waitFor((): void => expect(within(dialog).getByRole('button', { name: '采用这张' }).hasAttribute('disabled')).toBe(false));
    expect(adopt).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '暂不采用' }));
    expect(adopt).not.toHaveBeenCalled();
    expect(project.adoptedImages?.['TEST-shot'].firstFrameId).toBe('old');
    fireEvent.click(screen.getByRole('button', { name: '查看并采用' }));
    const reopened = screen.getByRole('dialog', { name: '镜头 3 · 首帧 · 选择图片' });
    fireEvent.click(within(reopened).getByRole('button', { name: '选择候选图片 2' }));
    await waitFor((): void => expect(within(reopened).getByRole('button', { name: '采用这张' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(within(reopened).getByRole('button', { name: '采用这张' }));
    await waitFor((): void => expect(adopt).toHaveBeenCalledExactlyOnceWith('candidate-b'));
  });

  it('图片不可读取时不允许采用，历史选择也必须先预览', async (): Promise<void> => {
    const read = vi.fn(async (): Promise<{ success: false; error: string }> => ({ success: false, error: 'TEST 文件缺失' }));
    window.electronAPI.petstory.readReference = read;
    const adopt = vi.fn(async (): Promise<void> => undefined);
    render(<PetStoryImageReview project={project} target={target} title="镜头 3 · 首帧" currentAssetId="old" disabled={false} onUpload={async (): Promise<void> => undefined} onAdopt={adopt} />);
    fireEvent.click(screen.getByRole('button', { name: '查看并采用' }));
    const dialog = screen.getByRole('dialog');
    await waitFor((): void => expect(within(dialog).getAllByText('TEST 文件缺失').length).toBeGreaterThan(0));
    const apply = within(dialog).getByRole('button', { name: '采用这张' });
    expect(apply.hasAttribute('disabled')).toBe(true); fireEvent.click(apply); expect(adopt).not.toHaveBeenCalled();
  });

  it('上传只新增当前对象候选并自动打开预览，不提前采用', async (): Promise<void> => {
    project.assets = []; project.adoptedImages = {}; usePetStoryStore.setState({ project });
    const adopt = vi.fn(async (): Promise<void> => undefined);
    const upload = vi.fn(async (): Promise<void> => { usePetStoryStore.setState({ project: { ...project, revision: 2, assets: [image('uploaded')] } }); });
    const Harness: React.FC = (): React.ReactElement => {
      const current = usePetStoryStore((state) => state.project);
      return <PetStoryImageReview project={current || project} target={target} title="镜头 3 · 首帧" disabled={false} onUpload={upload} onAdopt={adopt} />;
    };
    render(<Harness />); fireEvent.click(screen.getByRole('button', { name: '上传图片' }));
    await waitFor((): void => expect(screen.getByRole('dialog', { name: '镜头 3 · 首帧 · 选择图片' })).toBeDefined());
    expect(upload).toHaveBeenCalledOnce(); expect(adopt).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().project?.adoptedImages).toEqual({});
  });

  it('其他镜头或用途的候选不会进入当前选择区', (): void => {
    expect(imageBelongsToTarget(project, image('own'), target)).toBe(true);
    expect(imageBelongsToTarget(project, image('own'), { shotId: 'TEST-other', kind: 'firstFrame' })).toBe(false);
    expect(imageBelongsToTarget(project, image('own'), { shotId: target.shotId, kind: 'lastFrame' })).toBe(false);
  });
});
