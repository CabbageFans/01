/** 原故事素材页的离线点击回归：图片任务为明确替身，不属于平台生成验收。 */
import React from 'react';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryAsset, PetStoryPlan, PetStoryProject, Task } from '@doubao-studio/contracts';
import { PetStoryMaterials } from '../../src/components/PetStoryMaterials';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import originalStory from '../fixtures/storyboard-five-shots.json';

const original = { pet: usePetStoryStore.getState(), tasks: useTaskStore.getState() };
const now = '2026-10-30T03:00:00.000Z';
const materialId = 'prop:TEST-original-electric-bike';
let project: PetStoryProject;
function card(): HTMLElement {
  const value = document.getElementById(`material-${materialId}`);
  if (!value) throw new Error('TEST 缺少原故事电车素材卡');
  return value;
}
const LiveMaterials: React.FC = (): React.ReactElement | null => {
  const value = usePetStoryStore();
  return value.project ? <PetStoryMaterials project={value.project} disabled={value.busy} /> : null;
};
function candidate(id: string): PetStoryAsset {
  return { id, kind: 'prop', materialId, relativePath: `TEST/${id}.png`, imageReview: { state: 'candidate', target: { materialId }, basisHash: 'TEST' }, validation: { decoded: true, sha256: `TEST-${id}`, bytes: 1, width: 64, height: 64, checkedAt: now } };
}
beforeEach((): void => {
  project = { schemaVersion: 1, id: 'TEST-material-project', studioProjectId: 'TEST-material-studio', accountId: 'TEST-account', revision: 1,
    source: { kind: 'script', url: '', status: 'review_required' }, mobileStory: { id: 'TEST-story', text: originalStory.mobileStory, importedAt: now },
    plan: structuredClone(originalStory.plan) as PetStoryPlan, storyApproval: { hash: 'TEST-original-approval', at: now }, assets: [], jobs: [], updatedAt: now,
    materials: [{ id: materialId, entityId: 'TEST-original-electric-bike', kind: 'prop', name: '粉色电驴', designHash: 'TEST', prompt: { original: 'TEST 原故事既有道具摘要', optimized: '', final: '', edited: false, rulesVersion: 'TEST' } }] };
  useTaskStore.setState({ ...original.tasks, tasks: [] });
  usePetStoryStore.setState({ ...original.pet, project, busy: false, error: '', generateMaterialImage: vi.fn(async (): Promise<void> => undefined) });
  window.electronAPI = { petstory: { readReference: vi.fn(async (_projectId: string, assetId: string): Promise<{ success: true; data: string }> => ({ success: true, data: `data:image/png;base64,${assetId}` })) } } as unknown as typeof window.electronAPI;
});
afterEach((): void => { usePetStoryStore.setState(original.pet); useTaskStore.setState(original.tasks); vi.restoreAllMocks(); });

describe('基础素材只操作图片', (): void => {
  it('没有正文也一次点击生成图片，不渲染提示词、诊断、更多或局部编辑表单', async (): Promise<void> => {
    const generate = usePetStoryStore.getState().generateMaterialImage;
    render(<LiveMaterials />);
    expect(card().textContent).not.toMatch(/提示词|生成记录|诊断|更多操作|变体|局部编辑|最终正文|设计摘要/);
    expect(card().querySelector('textarea, summary, [aria-label*="更多"]')).toBeNull();
    fireEvent.click(within(card()).getByRole('button', { name: '生成图片' }));
    await waitFor((): void => expect(generate).toHaveBeenCalledExactlyOnceWith(materialId));
    expect(project.materials?.[0].prompt.final).toBe('');
  });
  it('方案未确认只返回方案，不建立图片任务', (): void => {
    delete project.storyApproval; usePetStoryStore.setState({ project }); render(<LiveMaterials />);
    expect(document.querySelector('[data-material-id]')).toBeNull();
    expect(within(document.body).getByRole('button', { name: '查看并确认方案' })).toBeDefined();
    expect(usePetStoryStore.getState().generateMaterialImage).not.toHaveBeenCalled();
  });
  it('请求准备期间就地显示忙碌并禁用重复点击，失败只显示在当前素材', async (): Promise<void> => {
    let finish: (() => void) | undefined;
    const generate = vi.fn((): Promise<void> => new Promise((resolve): void => { finish = resolve; }));
    const actor = project.plan!.characters[0];
    project.materials!.push({ id: `character:${actor.id}`, entityId: actor.id, kind: 'character', name: actor.name, designHash: 'TEST', prompt: { original: actor.description, optimized: '', final: '', edited: false, rulesVersion: 'TEST' } });
    usePetStoryStore.setState({ project, generateMaterialImage: generate }); render(<LiveMaterials />);
    const button = within(card()).getByRole('button', { name: '生成图片' }); fireEvent.click(button); fireEvent.click(button);
    expect(generate).toHaveBeenCalledOnce(); expect(button.hasAttribute('disabled')).toBe(true);
    await act(async (): Promise<void> => { usePetStoryStore.setState({ error: 'TEST 本次图片准备失败', imageTargetErrors: { [`material:${project.materials![0].id}`]: 'TEST 本次图片准备失败' } }); finish?.(); });
    await waitFor((): void => expect(within(card()).getByText('TEST 本次图片准备失败')).toBeDefined());
    const other = document.getElementById(`material-character:${actor.id}`); if (!other) throw new Error('TEST 缺少人物卡');
    expect(within(other).queryByText('TEST 本次图片准备失败')).toBeNull(); expect(button.hasAttribute('disabled')).toBe(false);
  });
  it('一张图片准备未返回时锁住其他素材，释放后才允许下一项', async (): Promise<void> => {
    const finishes: (() => void)[] = [];
    const generate = vi.fn<(materialId: string) => Promise<void>>((id): Promise<void> => {
      usePetStoryStore.setState({ pendingImageTargets: [`material:${id}`] });
      return new Promise<void>((resolve): void => { finishes.push(resolve); })
        .finally((): void => { usePetStoryStore.setState({ pendingImageTargets: [] }); });
    });
    const actor = project.plan!.characters[0];
    project.materials!.push({ id: `character:${actor.id}`, entityId: actor.id, kind: 'character', name: actor.name, designHash: 'TEST', prompt: { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST' } });
    usePetStoryStore.setState({ project, generateMaterialImage: generate }); render(<LiveMaterials />);
    const first = within(card()).getByRole('button', { name: '生成图片' });
    const other = document.getElementById(`material-character:${actor.id}`); if (!other) throw new Error('TEST 缺少人物卡');
    const second = within(other).getByRole('button', { name: '生成图片' });
    fireEvent.click(first); expect(first.hasAttribute('disabled')).toBe(true); expect(second.hasAttribute('disabled')).toBe(true);
    fireEvent.click(second); expect(generate).toHaveBeenCalledExactlyOnceWith(project.materials![0].id);
    await act(async (): Promise<void> => { finishes[0](); });
    expect(second.hasAttribute('disabled')).toBe(false); fireEvent.click(second);
    expect(generate.mock.calls.map(([id]): string => id)).toEqual([project.materials![0].id, `character:${actor.id}`]);
    expect(first.hasAttribute('disabled')).toBe(true); expect(usePetStoryStore.getState().busy).toBe(false);
    await act(async (): Promise<void> => { finishes[1](); });
  });
  it('当前账号自由调整时禁用图片发送，不擅自结束调整', (): void => {
    project.chatAdjustment = { id: 'TEST-adjustment', target: {}, sourceJobId: 'TEST-source', conversationUrl: 'https://www.doubao.com/chat/TEST', basisHash: 'TEST', startedAt: now, status: 'active', replies: [] };
    usePetStoryStore.setState({ project }); render(<LiveMaterials />);
    const button = within(card()).getByRole('button', { name: '生成图片' }); expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button); expect(usePetStoryStore.getState().generateMaterialImage).not.toHaveBeenCalled();
    expect(project.chatAdjustment.status).toBe('active');
  });
  it('当前素材生成后自动预览候选，关闭不采用；重渲染不再弹出', async (): Promise<void> => {
    const generate = vi.fn(async (): Promise<void> => { usePetStoryStore.setState({ project: { ...project, revision: 2, assets: [candidate('TEST-generated')] } }); });
    const approve = vi.fn(async (): Promise<void> => undefined);
    usePetStoryStore.setState({ generateMaterialImage: generate, approveMaterials: approve }); render(<LiveMaterials />);
    fireEvent.click(within(card()).getByRole('button', { name: '生成图片' }));
    const dialog = await within(document.body).findByRole('dialog', { name: '粉色电驴 · 道具参考图 · 选择图片' });
    expect(approve).not.toHaveBeenCalled(); expect(project.materials?.[0].selectedAssetId).toBeUndefined();
    fireEvent.click(within(dialog).getByRole('button', { name: '暂不采用' }));
    await waitFor((): void => expect(within(document.body).queryByRole('dialog')).toBeNull());
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: { ...usePetStoryStore.getState().project!, revision: 3 } }); });
    expect(within(document.body).queryByRole('dialog')).toBeNull(); expect(within(card()).getAllByText('图片待确认').length).toBeGreaterThan(0);
  });
  it('重开保存中的图片操作只显示继续入口，不重复生成或伪装正在执行', async (): Promise<void> => {
    project.imageOperations = [{ id: 'TEST-saved-operation', requestId: 'TEST-original-click', target: { materialId }, mode: 'generate', stage: 'generating', basisHash: 'TEST', createdAt: now }];
    const recover = vi.fn(async (): Promise<void> => undefined); const generate = usePetStoryStore.getState().generateMaterialImage;
    usePetStoryStore.setState({ project, activeImageOperationId: null, recoverImageOperation: recover }); render(<LiveMaterials />);
    expect(within(card()).getByText('图片任务已保存，可继续本次任务')).toBeDefined();
    expect(within(card()).queryByRole('progressbar')).toBeNull();
    expect(within(card()).getByRole('button', { name: '生成图片' }).hasAttribute('disabled')).toBe(true);
    expect(recover).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
    recover.mockImplementationOnce(async (): Promise<void> => { usePetStoryStore.setState({ error: 'TEST 原会话暂未就绪', imageTargetErrors: { [`material:${materialId}`]: 'TEST 原会话暂未就绪' } }); });
    fireEvent.click(within(card()).getByRole('button', { name: '继续本次任务' }));
    await waitFor((): void => expect(recover).toHaveBeenCalledExactlyOnceWith('TEST-saved-operation')); expect(generate).not.toHaveBeenCalled();
    expect(within(card()).getByText('TEST 原会话暂未就绪')).toBeDefined();
    expect(within(card()).getByRole('button', { name: '继续本次任务' })).toBeDefined();
  });
  it('已完成操作之后上传失败只保留上传重试，不错误继续旧生成任务', async (): Promise<void> => {
    project.assets = [candidate('TEST-complete')]; project.imageOperations = [{ id: 'TEST-complete-operation', requestId: 'TEST-original-click', target: { materialId }, mode: 'generate', stage: 'complete', outputAssetId: 'TEST-complete', basisHash: 'TEST', createdAt: now }];
    const recover = vi.fn(async (): Promise<void> => undefined); const upload = vi.fn(async (): Promise<void> => { throw new Error('TEST 新上传文件不可读取'); });
    usePetStoryStore.setState({ project, recoverImageOperation: recover, addMaterialImage: upload }); render(<LiveMaterials />);
    fireEvent.click(within(card()).getByRole('button', { name: '上传替代图片' }));
    await waitFor((): void => expect(within(card()).getByText('TEST 新上传文件不可读取')).toBeDefined());
    expect(within(card()).queryByRole('button', { name: '继续本次任务' })).toBeNull(); expect(recover).not.toHaveBeenCalled();
    expect(within(card()).getByRole('button', { name: '上传替代图片' }).hasAttribute('disabled')).toBe(false);
  });
  it('缺定位旧图片在素材卡明确引导打开原账号，保留继续和用户确认重发入口', async (): Promise<void> => {
    const task: Task = { id: 'TEST-original-image', projectId: project.studioProjectId, assignedAccountId: project.accountId, mode: 'image', status: 'paused', prompt: 'TEST 原图片', result: null,
      outputs: [], createdAt: now, updatedAt: now, runtime: { runId: 'TEST-original-run', attempt: 1, stage: 'paused', message: 'TEST 旧超时错误', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, submittedAt: now,
        input: { mode: 'image', prompt: 'TEST 原图片', attachments: [] } } };
    project.imageOperations = [{ id: 'TEST-missing-conversation', requestId: 'TEST-original-request', taskId: task.id, target: { materialId }, mode: 'generate', stage: 'failed', error: 'TEST 旧超时错误', basisHash: 'TEST', createdAt: now }];
    const entry = { state: 'unknown' as const, reason: '' };
    project.production = { state: 'paused', imageOperationId: project.imageOperations[0].id, approvedAt: now, planHash: 'TEST', capability: { accountId: project.accountId, image: entry,
      modes: { first_frame: entry, first_last_frame: entry, reference: entry }, durations: [] }, fallbacks: {}, shots: {}, message: 'TEST 待核对',
      steps: [{ id: 'TEST-step', taskId: task.id, runId: task.runtime!.runId, kind: 'prop', materialId, inputHash: 'TEST', attachmentAssetIds: [], status: 'bound' }] };
    const open = vi.fn(async (): Promise<void> => undefined); const recover = vi.fn(async (): Promise<void> => undefined); const resubmit = vi.fn(async (): Promise<void> => undefined);
    useTaskStore.setState({ tasks: [task] }); usePetStoryStore.setState({ project, openImageConversation: open, recoverImageOperation: recover, resubmitProduction: resubmit });
    render(<LiveMaterials />);
    expect(within(card()).getByText('原会话未定位，请在原账号历史中打开这次图片对话后继续。')).toBeDefined();
    expect(within(card()).queryByText('TEST 旧超时错误')).toBeNull();
    fireEvent.click(within(card()).getByRole('button', { name: '打开原账号豆包' })); await waitFor((): void => expect(open).toHaveBeenCalledExactlyOnceWith({ materialId }, undefined));
    fireEvent.click(within(card()).getByRole('button', { name: '继续本次任务' })); await waitFor((): void => expect(recover).toHaveBeenCalledExactlyOnceWith('TEST-missing-conversation'));
    expect(within(card()).getByRole('button', { name: '确认重发一次' })).toBeDefined(); expect(resubmit).not.toHaveBeenCalled();
    expect(within(card()).getByRole('button', { name: '生成图片' }).hasAttribute('disabled')).toBe(true);
  });
  it('切到其他位置后只保留待确认，不自动弹出结果', async (): Promise<void> => {
    let complete: (() => void) | undefined;
    usePetStoryStore.setState({ generateMaterialImage: vi.fn((): Promise<void> => new Promise((resolve): void => { complete = resolve; })) });
    const { container } = render(<div data-testid="stage"><LiveMaterials /></div>);
    fireEvent.click(within(card()).getByRole('button', { name: '生成图片' })); container.firstElementChild?.setAttribute('hidden', '');
    await act(async (): Promise<void> => { usePetStoryStore.setState({ project: { ...project, revision: 2, assets: [candidate('TEST-background')] } }); complete?.(); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    container.firstElementChild?.removeAttribute('hidden');
    expect(within(card()).getByRole('button', { name: '查看图片' })).toBeDefined();
  });
});
