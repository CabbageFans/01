/** 上传与采用回读仅清理同项目同图片请求的旧提示，不影响其他目标或后来请求。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryImageOperation, PetStoryImageTarget, PetStoryProject, PetStoryResult, Task } from '@doubao-studio/contracts';
import { usePetStoryStore } from '../../src/store/usePetStoryStore';
import { useTaskStore } from '../../src/store/useTaskStore';
import { imageTargetKey } from '../../src/utils/petstoryImageFlow';

const original = usePetStoryStore.getState();
const originalTasks = useTaskStore.getState();
const now = '2026-11-06T00:00:00.000Z';
const material = { materialId: 'scene:TEST-a' };
const shot: PetStoryImageTarget = { shotId: 'TEST-shot', kind: 'firstFrame' };
const oldError = 'TEST 先前图片流程占用';
const otherKey = 'material:prop:TEST-other';
let project: PetStoryProject;
const approve = vi.fn<(id: string, revision: number, selections: { materialId: string; assetId: string }[]) => Promise<PetStoryResult>>();
const adopt = vi.fn<(id: string, revision: number, target: PetStoryImageTarget, assetId: string) => Promise<PetStoryResult>>();
const upload = vi.fn<() => Promise<PetStoryResult>>();

function operation(target: PetStoryImageTarget): PetStoryImageOperation {
  return { id: `TEST-operation-${imageTargetKey(target)}`, requestId: 'TEST-original-request', target, mode: 'generate', stage: 'complete',
    createdAt: now, basisHash: 'TEST', outputAssetId: target.materialId ? 'TEST-material-image' : 'TEST-shot-image' };
}
function adopted(targets: { target: PetStoryImageTarget; assetId: string }[]): PetStoryResult {
  const result = structuredClone(project); result.revision++;
  for (const { target, assetId } of targets) {
    if (target.materialId) result.materials!.find((item): boolean => item.id === target.materialId)!.selectedAssetId = assetId;
    else result.adoptedImages = { ...result.adoptedImages, [target.shotId!]: { firstFrameId: assetId } };
    const image = result.assets.find((item): boolean => item.id === assetId);
    if (image) image.imageReview = { state: 'adopted', target, basisHash: 'TEST', adoptedAt: now };
  }
  return { success: true, project: result };
}
function uploaded(target: PetStoryImageTarget): PetStoryResult {
  const result = structuredClone(project); result.revision++;
  result.assets.push({ id: 'TEST-new-upload', kind: target.materialId ? 'scene' : target.kind === 'lastFrame' ? 'plannedEndImage' : 'firstFrame',
    materialId: target.materialId, shotId: target.shotId, relativePath: 'TEST-upload.png', imageReview: { state: 'candidate', target, basisHash: 'TEST' },
    validation: { decoded: true, width: 64, height: 64, bytes: 1, sha256: 'TEST-new-file', checkedAt: now } });
  return { success: true, project: result };
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = (): void => { throw new Error('TEST 尚未建立异步回读'); };
  const promise = new Promise<T>((done: (value: T | PromiseLike<T>) => void): void => { resolve = done; });
  return { promise, resolve };
}

beforeEach((): void => {
  vi.resetAllMocks();
  project = { id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', schemaVersion: 1, revision: 1, updatedAt: now,
    source: { kind: 'script', url: '', status: 'review_required' }, jobs: [], imageOperations: [operation(material), operation(shot)],
    materials: [{ id: material.materialId, entityId: 'TEST-a', kind: 'scene', name: 'TEST场景', designHash: 'TEST', prompt: { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST' } }],
    assets: [{ id: 'TEST-material-image', materialId: material.materialId, kind: 'scene', relativePath: 'TEST-material.png' },
      { id: 'TEST-shot-image', shotId: shot.shotId, kind: 'firstFrame', relativePath: 'TEST-shot.png' }] };
  approve.mockImplementation(async (_id: string, _revision: number, selections: { materialId: string; assetId: string }[]): Promise<PetStoryResult> =>
    adopted(selections.map((selection): { target: PetStoryImageTarget; assetId: string } => ({ target: { materialId: selection.materialId }, assetId: selection.assetId }))));
  adopt.mockImplementation(async (_id: string, _revision: number, target: PetStoryImageTarget, assetId: string): Promise<PetStoryResult> => adopted([{ target, assetId }]));
  upload.mockImplementation(async (): Promise<PetStoryResult> => uploaded(material));
  vi.stubGlobal('window', { electronAPI: { petstory: { approveMaterials: approve, adoptImage: adopt, addMaterialImage: upload, addShotImage: upload } } });
  usePetStoryStore.setState({ ...original, project, busy: false, error: '', pendingImageTargets: [], activeImageOperationId: null, activeImageOperationIds: [],
    imageTargetErrors: { [imageTargetKey(material)]: oldError, [imageTargetKey(shot)]: oldError, [otherKey]: 'TEST 其他目标错误' } });
  useTaskStore.setState({ ...originalTasks, tasks: [] });
});
afterEach((): void => { usePetStoryStore.setState(original); useTaskStore.setState(originalTasks); vi.unstubAllGlobals(); });

describe('停止后上传的目标错误收束', (): void => {
  it.each(['material', 'shot'] as const)('%s确实保存新候选后仅清本目标旧错误，不采用或改写旧生成记录', async (kind: 'material' | 'shot'): Promise<void> => {
    const target = kind === 'material' ? material : shot; const operations = structuredClone(project.imageOperations);
    upload.mockResolvedValue(uploaded(target));
    if (kind === 'material') await usePetStoryStore.getState().addMaterialImage(material.materialId);
    else await usePetStoryStore.getState().uploadShotImage(shot.shotId!, 'firstFrame');
    const state = usePetStoryStore.getState();
    expect(state.imageTargetErrors[imageTargetKey(target)]).toBeUndefined(); expect(state.imageTargetErrors[otherKey]).toBe('TEST 其他目标错误');
    expect(state.project?.assets.at(-1)?.imageReview?.state).toBe('candidate'); expect(state.project?.imageOperations).toEqual(operations);
    expect(state.project?.materials![0].selectedAssetId).toBeUndefined(); expect(state.project?.adoptedImages).toBeUndefined();
    expect(approve).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'failed', 'wrong-target', 'undecoded'] as const)('上传%s不清本目标旧错误，不把成功标签当作新图证据', async (variant): Promise<void> => {
    const result: PetStoryResult = variant === 'failed' ? { success: false, error: 'TEST本次上传未保存' }
      : variant === 'cancelled' ? { success: true, project: structuredClone(project) } : uploaded(variant === 'wrong-target' ? shot : material);
    if (variant === 'undecoded') delete result.project!.assets.at(-1)!.validation;
    upload.mockResolvedValue(result); await usePetStoryStore.getState().addMaterialImage(material.materialId);
    expect(usePetStoryStore.getState().imageTargetErrors[imageTargetKey(material)]).toBe(oldError);
    if (variant === 'failed') expect(usePetStoryStore.getState().error).toBe('TEST本次上传未保存');
  });

  it.each(['operation', 'error', 'project'] as const)('上传等待期间%s变化，迟到成功不清新请求错误或切回旧项目', async (change): Promise<void> => {
    const gate = deferred<PetStoryResult>(); upload.mockReturnValue(gate.promise); const result = uploaded(material);
    const pending = usePetStoryStore.getState().addMaterialImage(material.materialId);
    await vi.waitFor((): void => { expect(upload).toHaveBeenCalledOnce(); });
    const latest = structuredClone(project); latest.revision += 2;
    if (change === 'operation') latest.imageOperations!.push({ ...operation(material), id: 'TEST-new-request', requestId: 'TEST-new-request-id', stage: 'preparing' });
    if (change === 'project') latest.id = 'TEST-new-project';
    const message = change === 'error' ? 'TEST后来同目标新错误' : oldError;
    usePetStoryStore.setState({ project: latest, imageTargetErrors: { ...usePetStoryStore.getState().imageTargetErrors, [imageTargetKey(material)]: message } });
    gate.resolve(result); await pending;
    expect(usePetStoryStore.getState().imageTargetErrors[imageTargetKey(material)]).toBe(message);
    expect(usePetStoryStore.getState().imageTargetErrors[otherKey]).toBe('TEST 其他目标错误');
    if (change === 'project') expect(usePetStoryStore.getState().project?.id).toBe('TEST-new-project');
  });
});

describe('图片采用成功后的目标错误收束', (): void => {
  it.each(['material', 'shot'] as const)('%s采用成功只清本目标旧错误，其他目标继续保留', async (kind: 'material' | 'shot'): Promise<void> => {
    const target = kind === 'material' ? material : shot;
    if (kind === 'material') await usePetStoryStore.getState().approveMaterials([{ materialId: material.materialId, assetId: 'TEST-material-image' }]);
    else await usePetStoryStore.getState().adoptShotImage(shot.shotId!, 'firstFrame', 'TEST-shot-image');
    expect(usePetStoryStore.getState().imageTargetErrors[imageTargetKey(target)]).toBeUndefined();
    expect(usePetStoryStore.getState().imageTargetErrors[otherKey]).toBe('TEST 其他目标错误');
    expect(usePetStoryStore.getState().imageTargetErrors[imageTargetKey(kind === 'material' ? shot : material)]).toBe(oldError);
  });

  it('本地上传候选没有图片operation时，成功采用仍清本目标旧占用错误', async (): Promise<void> => {
    project.imageOperations = [];
    await usePetStoryStore.getState().approveMaterials([{ materialId: material.materialId, assetId: 'TEST-material-image' }]);
    expect(usePetStoryStore.getState().imageTargetErrors[imageTargetKey(material)]).toBeUndefined();
    expect(usePetStoryStore.getState().imageTargetErrors[otherKey]).toBe('TEST 其他目标错误');
  });

  it('批量采用清所选目标旧错误，未选择目标仍保留', async (): Promise<void> => {
    project.materials!.push({ id: 'prop:TEST-other', entityId: 'TEST-other', kind: 'prop', name: 'TEST道具', designHash: 'TEST',
      prompt: { original: '', optimized: '', final: '', edited: false, rulesVersion: 'TEST' } });
    project.assets.push({ id: 'TEST-prop-image', materialId: 'prop:TEST-other', kind: 'prop', relativePath: 'TEST-prop.png' });
    await usePetStoryStore.getState().approveMaterials([{ materialId: material.materialId, assetId: 'TEST-material-image' }, { materialId: 'prop:TEST-other', assetId: 'TEST-prop-image' }]);
    expect(usePetStoryStore.getState().imageTargetErrors[imageTargetKey(material)]).toBeUndefined();
    expect(usePetStoryStore.getState().imageTargetErrors[otherKey]).toBeUndefined();
    expect(usePetStoryStore.getState().imageTargetErrors[imageTargetKey(shot)]).toBe(oldError);
  });

  it('采用失败保留目标错误和实际失败原因', async (): Promise<void> => {
    approve.mockResolvedValue({ success: false, error: 'TEST 原任务仍在引用图片' });
    await usePetStoryStore.getState().approveMaterials([{ materialId: material.materialId, assetId: 'TEST-material-image' }]);
    expect(usePetStoryStore.getState().imageTargetErrors[imageTargetKey(material)]).toBe(oldError);
    expect(usePetStoryStore.getState().error).toBe('TEST 原任务仍在引用图片');
  });

  it.each(['operation', 'error', 'pending', 'project'] as const)('采用等待期间%s变化时，迟到成功不能清后来请求错误', async (change: 'operation' | 'error' | 'pending' | 'project'): Promise<void> => {
    const gate = deferred<PetStoryResult>(); approve.mockReturnValue(gate.promise);
    const result = adopted([{ target: material, assetId: 'TEST-material-image' }]);
    const pending = usePetStoryStore.getState().approveMaterials([{ materialId: material.materialId, assetId: 'TEST-material-image' }]);
    await vi.waitFor((): void => { expect(approve).toHaveBeenCalledOnce(); });
    const latest = structuredClone(project); latest.revision += 2;
    let message = oldError;
    if (change === 'operation') latest.imageOperations!.push({ ...operation(material), id: 'TEST-new-operation', requestId: 'TEST-later-request', stage: 'preparing' });
    if (change === 'error') message = 'TEST 后来的同目标错误';
    if (change === 'project') latest.id = 'TEST-other-project';
    usePetStoryStore.setState({ project: latest, imageTargetErrors: { ...usePetStoryStore.getState().imageTargetErrors, [imageTargetKey(material)]: message },
      pendingImageTargets: change === 'pending' ? [imageTargetKey(material)] : [] });
    gate.resolve(result); await pending;
    expect(usePetStoryStore.getState().imageTargetErrors[imageTargetKey(material)]).toBe(message);
    expect(usePetStoryStore.getState().imageTargetErrors[otherKey]).toBe('TEST 其他目标错误');
    if (change === 'project') expect(usePetStoryStore.getState().project?.id).toBe('TEST-other-project');
  });

  it('采用返回其他项目的success不能覆盖当前项目或清目标错误', async (): Promise<void> => {
    const result = adopted([{ target: material, assetId: 'TEST-material-image' }]);
    result.project!.id = 'TEST-foreign-response-project';
    approve.mockResolvedValue(result);
    await usePetStoryStore.getState().approveMaterials([{ materialId: material.materialId, assetId: 'TEST-material-image' }]);
    expect(usePetStoryStore.getState().project?.id).toBe(project.id);
    expect(usePetStoryStore.getState().project?.revision).toBe(project.revision);
    expect(usePetStoryStore.getState().imageTargetErrors[imageTargetKey(material)]).toBe(oldError);
  });

  it('其他目标的新错误不妨碍清本目标已解决旧错误', async (): Promise<void> => {
    const gate = deferred<PetStoryResult>(); approve.mockReturnValue(gate.promise);
    const result = adopted([{ target: material, assetId: 'TEST-material-image' }]);
    const pending = usePetStoryStore.getState().approveMaterials([{ materialId: material.materialId, assetId: 'TEST-material-image' }]);
    await vi.waitFor((): void => { expect(approve).toHaveBeenCalledOnce(); });
    usePetStoryStore.setState({ imageTargetErrors: { ...usePetStoryStore.getState().imageTargetErrors, [otherKey]: 'TEST 另一目标的新错误' } });
    gate.resolve(result); await pending;
    expect(usePetStoryStore.getState().imageTargetErrors[imageTargetKey(material)]).toBeUndefined();
    expect(usePetStoryStore.getState().imageTargetErrors[otherKey]).toBe('TEST 另一目标的新错误');
  });

  it('后来请求被拒绝的新错误即使与原文案相同，迟到采用成功也不清除', async (): Promise<void> => {
    const busyError = '已有图片流程正在处理，请等待本次图片完成后再操作';
    usePetStoryStore.setState({ imageTargetErrors: { ...usePetStoryStore.getState().imageTargetErrors, [imageTargetKey(material)]: busyError } });
    const gate = deferred<PetStoryResult>(); approve.mockReturnValue(gate.promise);
    const result = adopted([{ target: material, assetId: 'TEST-material-image' }]);
    const pending = usePetStoryStore.getState().approveMaterials([{ materialId: material.materialId, assetId: 'TEST-material-image' }]);
    await vi.waitFor((): void => { expect(approve).toHaveBeenCalledOnce(); });
    const running: Task = { id: 'TEST-other-running', projectId: 'TEST-other-studio', assignedAccountId: 'TEST-other-account', mode: 'image',
      prompt: 'TEST', status: 'generating', outputs: [], result: null, createdAt: now, updatedAt: now };
    useTaskStore.setState({ tasks: [running] });
    await usePetStoryStore.getState().generateMaterialImage(material.materialId);
    expect(usePetStoryStore.getState().imageTargetErrors[imageTargetKey(material)]).toBe(busyError);
    gate.resolve(result); await pending;
    expect(usePetStoryStore.getState().imageTargetErrors[imageTargetKey(material)]).toBe(busyError);
  });

  it('success没有对应采用回读时，不清目标错误', async (): Promise<void> => {
    approve.mockResolvedValue({ success: true, project: structuredClone(project) });
    await usePetStoryStore.getState().approveMaterials([{ materialId: material.materialId, assetId: 'TEST-material-image' }]);
    expect(usePetStoryStore.getState().imageTargetErrors[imageTargetKey(material)]).toBe(oldError);
  });
});
