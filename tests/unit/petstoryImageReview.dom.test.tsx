/** DOM 仅用明确的文件读取替身验证采用边界，不调用平台或写入真实项目。 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it.each([false, true])('已采用首帧忽略历史复核标记，预览不要求再次采用（外部标记=%s）', async (external): Promise<void> => {
    project.assets = [image('old', 'adopted')]; project.assets[0].needsReview = !external;
    const adopt = vi.fn(async (): Promise<void> => undefined);
    render(<PetStoryImageReview project={project} target={target} title="镜头 3 · 首帧" currentAssetId="old" currentNeedsReview={external} disabled={false} onUpload={async (): Promise<void> => undefined} onAdopt={adopt} />);
    expect(screen.queryByRole('button', { name: '查看并复核' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看图片' })); const dialog = screen.getByRole('dialog');
    await waitFor((): void => expect(within(dialog).getAllByRole('img', { name: '镜头 3 · 首帧 · 当前采用' }).length).toBeGreaterThan(0));
    expect(within(dialog).getByText('已采用')).toBeDefined();
    expect(within(dialog).queryByText('需要复核')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: '确认继续使用' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: '满意，采用图片' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /返\s*回/ })); expect(adopt).not.toHaveBeenCalled();
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

describe('图片预览重新生成', (): void => {
  it('底部重新生成直接发起完整生成，不传选中图或反馈，也不采用图片', async (): Promise<void> => {
    const generate = vi.fn(async (): Promise<void> => undefined);
    const modify = vi.fn(async (): Promise<void> => undefined); const adopt = vi.fn(async (): Promise<void> => undefined);
    render(<PetStoryImageReview project={project} target={target} title="镜头 3 · 首帧" currentAssetId="old" disabled={false} onGenerate={generate} onModify={modify} onUpload={async (): Promise<void> => undefined} onAdopt={adopt} />);
    fireEvent.click(screen.getByRole('button', { name: '查看图片' })); const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '选择候选图片 1' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '重新生成' }));
    await waitFor((): void => expect(generate).toHaveBeenCalledExactlyOnceWith());
    expect(modify).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '修改这张图片' })).toBeNull();
    expect(project.adoptedImages?.['TEST-shot'].firstFrameId).toBe('old'); expect(project.assets).toHaveLength(4);
  });

  it('重新生成完成后在原预览选中新候选，旧图和采用关系保留', async (): Promise<void> => {
    const generate = vi.fn(async (): Promise<void> => {
      usePetStoryStore.setState({ project: { ...project, revision: 2, assets: [...project.assets, image('regenerated')] }, error: '' });
    });
    const adopt = vi.fn(async (): Promise<void> => undefined);
    const Harness: React.FC = (): React.ReactElement => {
      const current = usePetStoryStore((state) => state.project) || project;
      return <PetStoryImageReview project={current} target={target} title="镜头 3 · 首帧" currentAssetId="old" disabled={false} onGenerate={generate} onUpload={async (): Promise<void> => undefined} onAdopt={adopt} />;
    };
    render(<Harness />); fireEvent.click(screen.getByRole('button', { name: '查看图片' }));
    const dialog = screen.getByRole('dialog'); fireEvent.click(within(dialog).getByRole('button', { name: '重新生成' }));
    await waitFor((): void => expect(within(dialog).getByRole('img', { name: '镜头 3 · 首帧 · 待确认图片' }).getAttribute('src')).toContain('regenerated'));
    expect(within(dialog).getByRole('button', { name: '选择候选图片 3' }).classList.contains('selected')).toBe(true);
    expect(screen.getAllByRole('dialog')).toHaveLength(1); expect(adopt).not.toHaveBeenCalled();
    expect(usePetStoryStore.getState().project?.assets).toHaveLength(5);
    expect(usePetStoryStore.getState().project?.adoptedImages?.['TEST-shot'].firstFrameId).toBe('old');
  });

  it('启动中禁用重复生成和修改，启动失败保留预览及旧图并显示原因', async (): Promise<void> => {
    let reject: (error: Error) => void = (): void => undefined;
    const pending = new Promise<void>((_resolve, fail): void => { reject = fail; });
    const generate = vi.fn(async (): Promise<void> => pending);
    render(<PetStoryImageReview project={project} target={target} title="镜头 3 · 首帧" currentAssetId="old" disabled={false} onGenerate={generate} onUpload={async (): Promise<void> => undefined} onAdopt={async (): Promise<void> => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '查看图片' })); const dialog = screen.getByRole('dialog');
    const regenerate = within(dialog).getByRole('button', { name: '重新生成' });
    fireEvent.click(regenerate); fireEvent.click(regenerate);
    expect(generate).toHaveBeenCalledOnce(); expect(regenerate.hasAttribute('disabled')).toBe(true);
    expect(within(dialog).getByRole('button', { name: '不满意，修改图片' }).hasAttribute('disabled')).toBe(true);
    await act(async (): Promise<void> => { reject(new Error('TEST 参考图上传失败')); await pending.catch((): void => undefined); });
    await waitFor((): void => expect(within(dialog).getByRole('alert').textContent).toContain('TEST 参考图上传失败'));
    expect(regenerate.hasAttribute('disabled')).toBe(false); expect(project.assets).toHaveLength(4);
    expect(project.adoptedImages?.['TEST-shot'].firstFrameId).toBe('old');
  });

  it('生成期间改看其他镜头，新结果到达不抢占其他镜头预览', async (): Promise<void> => {
    const otherTarget: PetStoryImageTarget = { shotId: 'TEST-other-shot', kind: 'firstFrame' };
    project.assets.push({ ...image('other-candidate'), shotId: otherTarget.shotId, imageReview: { state: 'candidate', target: otherTarget, basisHash: 'TEST' } });
    const generate = vi.fn(async (): Promise<void> => undefined);
    const Harness: React.FC = (): React.ReactElement => {
      const current = usePetStoryStore((state) => state.project) || project;
      return <><section aria-label="本镜"><PetStoryImageReview project={current} target={target} title="镜头 3 · 首帧" currentAssetId="old" disabled={false} onGenerate={generate} onUpload={async (): Promise<void> => undefined} onAdopt={async (): Promise<void> => undefined} /></section>
        <section aria-label="其他镜头"><PetStoryImageReview project={current} target={otherTarget} title="镜头 4 · 首帧" disabled={false} onUpload={async (): Promise<void> => undefined} onAdopt={async (): Promise<void> => undefined} /></section></>;
    };
    render(<Harness />);
    fireEvent.click(within(screen.getByRole('region', { name: '本镜' })).getByRole('button', { name: '查看图片' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '重新生成' }));
    await waitFor((): void => expect(generate).toHaveBeenCalledOnce());
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '暂不采用' }));
    fireEvent.click(within(screen.getByRole('region', { name: '其他镜头' })).getByRole('button', { name: '查看图片' }));
    act((): void => usePetStoryStore.setState({ project: { ...project, revision: 2, assets: [...project.assets, image('regenerated')] } }));
    await waitFor((): void => expect(within(screen.getByRole('region', { name: '本镜' })).getByText('图片待确认 · 3 张')).toBeDefined());
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const otherDialog = screen.getByRole('dialog', { name: '镜头 4 · 首帧 · 选择图片' });
    await waitFor((): void => expect(within(otherDialog).getByRole('img', { name: '镜头 4 · 首帧 · 待确认图片' }).getAttribute('src')).toContain('other-candidate'));
    expect(screen.queryByRole('dialog', { name: '镜头 3 · 首帧 · 选择图片' })).toBeNull();
  });

  it.each(['disabled', 'generationDisabled', 'resumable'] as const)('%s时不能用重新生成绕开原生成限制或未完成任务', (reason): void => {
    if (reason === 'resumable') project.imageOperations = [{ id: 'TEST-resume-original', requestId: 'TEST-original-request', target, mode: 'generate', stage: 'generating', basisHash: 'TEST', createdAt: now }];
    const generate = vi.fn(async (): Promise<void> => undefined);
    render(<PetStoryImageReview project={project} target={target} title="镜头 3 · 首帧" currentAssetId="old" disabled={reason === 'disabled'} generationDisabled={reason === 'generationDisabled'} onGenerate={generate} onUpload={async (): Promise<void> => undefined} onAdopt={async (): Promise<void> => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '查看图片' }));
    const regenerate = within(screen.getByRole('dialog')).getByRole('button', { name: '重新生成' });
    expect(regenerate.hasAttribute('disabled')).toBe(true); fireEvent.click(regenerate); expect(generate).not.toHaveBeenCalled();
  });

  it('所选旧候选不可读不妨碍重新生成，仍禁止采用和基于该图修改', async (): Promise<void> => {
    window.electronAPI.petstory.readReference = vi.fn(async (): Promise<{ success: false; error: string }> => ({ success: false, error: 'TEST 旧候选文件缺失' }));
    const generate = vi.fn(async (): Promise<void> => undefined);
    render(<PetStoryImageReview project={project} target={target} title="镜头 3 · 首帧" currentAssetId="old" disabled={false} onGenerate={generate} onUpload={async (): Promise<void> => undefined} onAdopt={async (): Promise<void> => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '查看图片' })); const dialog = screen.getByRole('dialog');
    await waitFor((): void => expect(within(dialog).getAllByText('TEST 旧候选文件缺失').length).toBeGreaterThan(0));
    expect(within(dialog).getByRole('button', { name: '满意，采用图片' }).hasAttribute('disabled')).toBe(true);
    expect(within(dialog).getByRole('button', { name: '不满意，修改图片' }).hasAttribute('disabled')).toBe(true);
    const regenerate = within(dialog).getByRole('button', { name: '重新生成' }); expect(regenerate.hasAttribute('disabled')).toBe(false);
    fireEvent.click(regenerate); await waitFor((): void => expect(generate).toHaveBeenCalledExactlyOnceWith());
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

describe('一次只启动一个图片流程', (): void => {
  function occupy(stage: 'pending' | 'preparing' | 'generating' | 'saving'): void {
    project.imageOperations = [{ id: 'TEST-other-operation', requestId: 'TEST-other-request', target: { materialId: 'prop:other' },
      mode: 'generate', stage: stage === 'pending' ? 'preparing' : stage, basisHash: 'TEST-basis', createdAt: now }];
    usePetStoryStore.setState({ project, pendingImageTargets: stage === 'pending' ? ['material:prop:other'] : [],
      activeImageOperationIds: stage === 'pending' ? [] : ['TEST-other-operation'] });
  }

  it.each(['pending', 'preparing', 'generating', 'saving'] as const)('%s期间其他图片的生成按钮禁用，释放后恢复', (stage): void => {
    project.assets = []; occupy(stage);
    const generate = vi.fn(async (): Promise<void> => undefined);
    render(<PetStoryImageReview project={project} target={target} title="待生成图片" disabled={false} onGenerate={generate} onUpload={async (): Promise<void> => undefined} onAdopt={async (): Promise<void> => undefined} />);
    const button = screen.getByRole('button', { name: '生成图片' });
    expect(button.hasAttribute('disabled')).toBe(true); fireEvent.click(button); expect(generate).not.toHaveBeenCalled();
    act((): void => { usePetStoryStore.setState({ activeImageOperationIds: [], pendingImageTargets: [] }); });
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it.each(['pending', 'preparing', 'generating', 'saving'] as const)('%s期间预览仍可读，重新生成和修改均禁用', async (stage): Promise<void> => {
    occupy(stage); const generate = vi.fn(async (): Promise<void> => undefined); const modify = vi.fn(async (): Promise<void> => undefined);
    render(<PetStoryImageReview project={project} target={target} title="候选图片" disabled={false} onGenerate={generate} onModify={modify} onUpload={async (): Promise<void> => undefined} onAdopt={async (): Promise<void> => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '查看图片' })); const dialog = screen.getByRole('dialog');
    await waitFor((): void => expect(within(dialog).getByRole('button', { name: '满意，采用图片' }).hasAttribute('disabled')).toBe(false));
    const regenerate = within(dialog).getByRole('button', { name: '重新生成' }); const change = within(dialog).getByRole('button', { name: '不满意，修改图片' });
    expect(regenerate.hasAttribute('disabled')).toBe(true); expect(change.hasAttribute('disabled')).toBe(true);
    fireEvent.click(regenerate); fireEvent.click(change); expect(generate).not.toHaveBeenCalled(); expect(modify).not.toHaveBeenCalled();
    act((): void => { usePetStoryStore.setState({ activeImageOperationIds: [], pendingImageTargets: [] }); });
    expect(regenerate.hasAttribute('disabled')).toBe(false); expect(change.hasAttribute('disabled')).toBe(false);
  });

  it('已填写的反馈遇到另一图片启动时锁住提交，解除后仍使用原选图和原反馈', async (): Promise<void> => {
    const modify = vi.fn(async (): Promise<void> => undefined);
    render(<PetStoryImageReview project={project} target={target} title="候选图片" disabled={false} onModify={modify} onUpload={async (): Promise<void> => undefined} onAdopt={async (): Promise<void> => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '查看图片' })); const preview = screen.getByRole('dialog');
    const change = within(preview).getByRole('button', { name: '不满意，修改图片' });
    await waitFor((): void => expect(change.hasAttribute('disabled')).toBe(false)); fireEvent.click(change);
    const dialog = screen.getByRole('dialog', { name: '修改这张图片' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '只调整光线' } });
    act((): void => { usePetStoryStore.setState({ pendingImageTargets: ['material:prop:other'] }); });
    const submit = within(dialog).getByRole('button', { name: '提交修改' });
    expect(submit.hasAttribute('disabled')).toBe(true); fireEvent.click(submit); expect(modify).not.toHaveBeenCalled();
    act((): void => { usePetStoryStore.setState({ pendingImageTargets: [] }); });
    expect(submit.hasAttribute('disabled')).toBe(false); fireEvent.click(submit);
    await waitFor((): void => expect(modify).toHaveBeenCalledExactlyOnceWith('candidate-b', '只调整光线'));
  });
});
