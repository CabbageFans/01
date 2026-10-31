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
  it('无图时只提供生成图片和上传，不暴露提示词生产入口', (): void => {
    project.assets = []; const generate = vi.fn(async (): Promise<void> => undefined);
    render(<PetStoryImageReview project={project} target={target} title="镜头 3 · 首帧" disabled={false} onGenerate={generate} onUpload={async (): Promise<void> => undefined} onAdopt={async (): Promise<void> => undefined} />);
    const action = screen.getByRole('button', { name: '生成图片' });
    expect(action.classList.contains('ant-btn-primary')).toBe(true); expect(action.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText(/生成提示词|采用提示词|更多操作/)).toBeNull(); expect(screen.getByRole('button', { name: '上传图片' })).toBeDefined();
    fireEvent.click(action); expect(generate).toHaveBeenCalledOnce();
  });

  it('新候选到来时保留已采用缩略图，只突出查看图片', (): void => {
    render(<PetStoryImageReview project={project} target={target} title="镜头 3 · 首帧" currentAssetId="old" disabled={false} onUpload={async (): Promise<void> => undefined} onAdopt={async (): Promise<void> => undefined} />);
    expect(screen.getByRole('button', { name: '查看镜头 3 · 首帧已采用图片' })).toBeDefined();
    expect(screen.getByText('图片待确认 · 2 张')).toBeDefined();
    expect(screen.getAllByRole('button').filter((button): boolean => button.classList.contains('ant-btn-primary'))).toEqual([screen.getByRole('button', { name: '查看图片' })]);
  });

  it('多图中明确采用一张后清除待确认横幅，默认查看采用图并保留历史备选可修改和重新采用', async (): Promise<void> => {
    const adopt = vi.fn(async (assetId: string): Promise<void> => {
      const next = structuredClone(usePetStoryStore.getState().project!); const selected = next.assets.find((asset): boolean => asset.id === assetId)!;
      selected.imageReview = { ...selected.imageReview!, state: 'adopted', adoptedAt: now, sha256: selected.validation!.sha256,
        resolvedCandidateIds: next.assets.filter((asset): boolean => asset.id !== assetId).map((asset): string => asset.id) };
      next.adoptedImages = { 'TEST-shot': { firstFrameId: assetId } }; next.revision++;
      usePetStoryStore.setState({ project: next, error: '' });
    });
    const modify = vi.fn(async (): Promise<void> => undefined);
    const Harness: React.FC = (): React.ReactElement => {
      const current = usePetStoryStore((state) => state.project) || project;
      return <PetStoryImageReview project={current} target={target} title="镜头 3 · 首帧" currentAssetId={current.adoptedImages?.['TEST-shot'].firstFrameId} disabled={false} onUpload={async (): Promise<void> => undefined} onAdopt={adopt} onModify={modify} />;
    };
    render(<Harness />); fireEvent.click(screen.getByRole('button', { name: '查看图片' }));
    let dialog = screen.getByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: '选择候选图片 1' }));
    const apply = within(dialog).getByRole('button', { name: '满意，采用图片' });
    await waitFor((): void => expect(apply.hasAttribute('disabled')).toBe(false)); fireEvent.click(apply);
    await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
    expect(adopt).toHaveBeenCalledExactlyOnceWith('candidate-a'); expect(screen.queryByText(/图片待确认/)).toBeNull();
    expect(usePetStoryStore.getState().project?.assets.find((asset): boolean => asset.id === 'candidate-b')?.imageReview?.state).toBe('candidate');
    fireEvent.click(screen.getByRole('button', { name: '查看图片' })); dialog = screen.getByRole('dialog');
    await waitFor((): void => expect(within(dialog).getAllByRole('img', { name: '镜头 3 · 首帧 · 当前采用' }).length).toBeGreaterThan(0));
    expect(within(dialog).queryByRole('button', { name: '满意，采用图片' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '查看历史图片 3' }));
    expect(within(dialog).getAllByText('历史备选').length).toBeGreaterThan(0);
    expect(within(dialog).getByRole('button', { name: '满意，采用图片' })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: '不满意，修改图片' })).toBeDefined();
  });

  it('旧项目明确采用后不再催确认，后续真实新增候选仍提醒并保留当前图', (): void => {
    project.assets[0].imageReview = { ...project.assets[0].imageReview!, adoptedAt: now, sha256: project.assets[0].validation!.sha256 };
    const props = { target, title: '镜头 3 · 首帧', currentAssetId: 'old', disabled: false, onUpload: async (): Promise<void> => undefined, onAdopt: async (): Promise<void> => undefined };
    const { rerender } = render(<PetStoryImageReview {...props} project={project} />);
    expect(screen.queryByText(/图片待确认/)).toBeNull();
    project = { ...project, revision: 2, assets: [...project.assets, { ...image('new-upload'), validation: { ...image('new-upload').validation!, checkedAt: '2026-10-30T00:00:00.000Z' } }] };
    rerender(<PetStoryImageReview {...props} project={project} />);
    expect(screen.getByText('图片待确认')).toBeDefined(); expect(screen.getByRole('button', { name: '查看镜头 3 · 首帧已采用图片' })).toBeDefined();
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
    fireEvent.click(screen.getByRole('button', { name: '查看图片' }));
    const dialog = screen.getByRole('dialog', { name: '镜头 3 · 首帧 · 选择图片' });
    expect(within(dialog).getByText('镜头 3 · 首帧')).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: '选择候选图片 2' }));
    await waitFor((): void => expect(within(dialog).getByRole('button', { name: '满意，采用图片' }).hasAttribute('disabled')).toBe(false));
    expect(adopt).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '暂不采用' }));
    expect(adopt).not.toHaveBeenCalled();
    expect(project.adoptedImages?.['TEST-shot'].firstFrameId).toBe('old');
    fireEvent.click(screen.getByRole('button', { name: '查看图片' }));
    const reopened = screen.getByRole('dialog', { name: '镜头 3 · 首帧 · 选择图片' });
    fireEvent.click(within(reopened).getByRole('button', { name: '选择候选图片 2' }));
    await waitFor((): void => expect(within(reopened).getByRole('button', { name: '满意，采用图片' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(within(reopened).getByRole('button', { name: '满意，采用图片' }));
    await waitFor((): void => expect(adopt).toHaveBeenCalledExactlyOnceWith('candidate-b'));
  });

  it('图片不可读取时不允许采用，历史选择也必须先预览', async (): Promise<void> => {
    const read = vi.fn(async (): Promise<{ success: false; error: string }> => ({ success: false, error: 'TEST 文件缺失' }));
    window.electronAPI.petstory.readReference = read;
    const adopt = vi.fn(async (): Promise<void> => undefined);
    render(<PetStoryImageReview project={project} target={target} title="镜头 3 · 首帧" currentAssetId="old" disabled={false} onUpload={async (): Promise<void> => undefined} onAdopt={adopt} />);
    fireEvent.click(screen.getByRole('button', { name: '查看图片' }));
    const dialog = screen.getByRole('dialog');
    await waitFor((): void => expect(within(dialog).getAllByText('TEST 文件缺失').length).toBeGreaterThan(0));
    const apply = within(dialog).getByRole('button', { name: '满意，采用图片' });
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

/** 选图反馈只验证交互绑定，图片输出在这些用例中是离线替身。 */
describe('直接对所选图片提出反馈', (): void => {
  it('未采用候选可修改，保留原话和选中的较早基图，不采用后再修改', async (): Promise<void> => {
    const modify = vi.fn(async (): Promise<void> => undefined); const adopt = vi.fn(async (): Promise<void> => undefined);
    render(<PetStoryImageReview project={project} target={target} title="镜头 3 · 首帧" currentAssetId="old" disabled={false} onModify={modify} onUpload={async (): Promise<void> => undefined} onAdopt={adopt} />);
    fireEvent.click(screen.getByRole('button', { name: '查看图片' }));
    const review = screen.getByRole('dialog'); fireEvent.click(within(review).getByRole('button', { name: '选择候选图片 1' }));
    const change = within(review).getByRole('button', { name: '不满意，修改图片' }); await waitFor((): void => expect(change.hasAttribute('disabled')).toBe(false)); fireEvent.click(change);
    const dialog = screen.getByRole('dialog', { name: '修改这张图片' });
    expect(within(dialog).getByText('镜头 3 · 首帧')).toBeDefined();
    const input = within(dialog).getByRole('textbox', { name: '图片修改意见' });
    const submit = within(dialog).getByRole('button', { name: '提交修改' }); expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(input, { target: { value: '  表情更自然，背景保持不变。  ' } }); fireEvent.click(submit);
    await waitFor((): void => expect(modify).toHaveBeenCalledExactlyOnceWith('candidate-a', '  表情更自然，背景保持不变。  '));
    expect(adopt).not.toHaveBeenCalled(); expect(project.adoptedImages?.['TEST-shot'].firstFrameId).toBe('old');
    expect(screen.queryByRole('textbox', { name: /提示词/ })).toBeNull(); expect(screen.queryByText(/复制|生成修改计划|手动应用/)).toBeNull();
  });
  it('取消和空意见都不提交，取消后保留当前选图', async (): Promise<void> => {
    const modify = vi.fn(async (): Promise<void> => undefined);
    render(<PetStoryImageReview project={project} target={target} title="镜头 3 · 首帧" currentAssetId="old" disabled={false} onModify={modify} onUpload={async (): Promise<void> => undefined} onAdopt={async (): Promise<void> => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '查看图片' })); const review = screen.getByRole('dialog');
    const change = within(review).getByRole('button', { name: '不满意，修改图片' }); await waitFor((): void => expect(change.hasAttribute('disabled')).toBe(false)); fireEvent.click(change);
    const dialog = screen.getByRole('dialog', { name: '修改这张图片' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: ' \n ' } }); fireEvent.click(within(dialog).getByRole('button', { name: '提交修改' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' })); expect(modify).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '镜头 3 · 首帧 · 选择图片' })).toBeDefined();
  });
  it('已采用图可修改但不要求反复采用，同一素材可选新图继续修改', async (): Promise<void> => {
    project.assets = [image('old', 'adopted')]; const modify = vi.fn(async (): Promise<void> => undefined);
    const props = { target, title: '镜头 3 · 首帧', currentAssetId: 'old', disabled: false, onModify: modify, onUpload: async (): Promise<void> => undefined, onAdopt: async (): Promise<void> => undefined };
    const { rerender } = render(<PetStoryImageReview {...props} project={project} />);
    fireEvent.click(screen.getByRole('button', { name: '查看图片' }));
    let review = screen.getByRole('dialog'); expect(within(review).queryByRole('button', { name: '满意，采用图片' })).toBeNull();
    let change = within(review).getByRole('button', { name: '不满意，修改图片' }); await waitFor((): void => expect(change.hasAttribute('disabled')).toBe(false)); fireEvent.click(change);
    let dialog = screen.getByRole('dialog', { name: '修改这张图片' }); fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '第一轮反馈' } }); fireEvent.click(within(dialog).getByRole('button', { name: '提交修改' }));
    await waitFor((): void => expect(modify).toHaveBeenCalledExactlyOnceWith('old', '第一轮反馈'));
    await waitFor((): void => expect(screen.queryByRole('dialog')).toBeNull());
    project = { ...project, revision: 2, assets: [...project.assets, image('round-one')] }; rerender(<PetStoryImageReview {...props} project={project} />);
    fireEvent.click(screen.getByRole('button', { name: '查看图片' })); review = screen.getByRole('dialog');
    change = within(review).getByRole('button', { name: '不满意，修改图片' }); await waitFor((): void => expect(change.hasAttribute('disabled')).toBe(false)); fireEvent.click(change);
    dialog = screen.getByRole('dialog', { name: '修改这张图片' }); fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '第二轮反馈' } }); fireEvent.click(within(dialog).getByRole('button', { name: '提交修改' }));
    await waitFor((): void => expect(modify).toHaveBeenLastCalledWith('round-one', '第二轮反馈')); expect(modify).toHaveBeenCalledTimes(2);
    expect(project.adoptedImages?.['TEST-shot'].firstFrameId).toBe('old');
  });
  it('本地上传图可直接作为基图，修改失败保留图片与反馈', async (): Promise<void> => {
    project.assets = [image('uploaded')]; project.adoptedImages = {};
    const modify = vi.fn(async (): Promise<void> => { throw new Error('TEST 平台暂未返回结果'); });
    render(<PetStoryImageReview project={project} target={target} title="上传素材" disabled={false} onModify={modify} onUpload={async (): Promise<void> => undefined} onAdopt={async (): Promise<void> => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '查看图片' })); const review = screen.getByRole('dialog');
    const change = within(review).getByRole('button', { name: '不满意，修改图片' }); await waitFor((): void => expect(change.hasAttribute('disabled')).toBe(false)); fireEvent.click(change);
    const dialog = screen.getByRole('dialog', { name: '修改这张图片' }); const input = within(dialog).getByRole('textbox');
    fireEvent.change(input, { target: { value: '只修改表情' } }); fireEvent.click(within(dialog).getByRole('button', { name: '提交修改' }));
    await waitFor((): void => expect(within(dialog).getByText('TEST 平台暂未返回结果')).toBeDefined());
    expect(modify).toHaveBeenCalledExactlyOnceWith('uploaded', '只修改表情'); expect((input as HTMLTextAreaElement).value).toBe('只修改表情');
    expect(project.assets).toHaveLength(1); expect(project.adoptedImages).toEqual({});
  });
});
