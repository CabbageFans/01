import { describe, expect, it } from 'vitest';
import type { PetStoryImageOperation, PetStoryProject, Task } from '@doubao-studio/contracts';
import { isPetStoryImageFlowBusy } from '../../src/utils/petstoryImageFlow';

const now = '2026-11-06T00:00:00.000Z';
function project(stage: PetStoryImageOperation['stage'] = 'generating'): PetStoryProject {
  return { schemaVersion: 1, id: 'TEST-project', studioProjectId: 'TEST-studio', accountId: 'TEST-account', revision: 1, updatedAt: now,
    source: { kind: 'script', url: '', status: 'pending' }, assets: [], jobs: [],
    imageOperations: [{ id: 'TEST-op', requestId: 'TEST-request', target: { materialId: 'character:TEST-a' }, mode: 'generate', stage, createdAt: now, basisHash: 'TEST', taskId: 'TEST-task' }] };
}
function task(status: Task['status'] = 'generating'): Task {
  return { id: 'TEST-task', projectId: 'TEST-studio', assignedAccountId: 'TEST-account', mode: 'image', status, executionIntent: 'armed', prompt: 'TEST', outputs: [], result: null,
    petstory: { projectId: 'TEST-project', stepId: 'TEST-step', imageOperationId: 'TEST-op', materialId: 'character:TEST-a' }, createdAt: now, updatedAt: now };
}

describe('唯一图片流程资格', (): void => {
  it('同步pending无需等待IPC或任务记录即可阻止快速跨卡点击', (): void => {
    expect(isPetStoryImageFlowBusy(project(), [], [], ['material:TEST-a'])).toBe(true);
  });
  it.each(['preparing', 'generating', 'saving'] as const)('已授权%s流程持续占用资格', (stage): void => {
    expect(isPetStoryImageFlowBusy(project(stage), [], ['TEST-op'], [])).toBe(true);
  });
  it('平台done尚未保存候选时仍占用，候选保存完成后释放', (): void => {
    const done = task('done'); done.outputs = ['https://TEST.invalid/image.png'];
    expect(isPetStoryImageFlowBusy(project('saving'), [done], ['TEST-op'], [])).toBe(true);
    expect(isPetStoryImageFlowBusy(project('complete'), [done], ['TEST-op'], [])).toBe(false);
  });
  it.each(['paused', 'fail', 'cancelled', 'waiting_verification'] as const)('已释放%s任务及历史stage不占资格，撤销授权前不提前启动下一项', (status): void => {
    expect(isPetStoryImageFlowBusy(project(), [task(status)], [], [])).toBe(false);
    expect(isPetStoryImageFlowBusy(project(), [task(status)], ['TEST-op'], [])).toBe(true);
  });
  it('没有授权的历史generating状态不占用，但另一个项目的真实图片仍占用', (): void => {
    expect(isPetStoryImageFlowBusy(project(), [], [], [])).toBe(false);
    const other = task(); other.projectId = 'TEST-other-studio'; other.petstory!.projectId = 'TEST-other-project';
    expect(isPetStoryImageFlowBusy(project(), [other], [], [])).toBe(true);
  });
  it('图片准备Chat占用同一资格，普通Chat不占用', (): void => {
    const chat = task(); chat.mode = 'chat'; chat.petstory = undefined;
    chat.petstoryChat = { projectId: 'TEST-project', jobId: 'TEST-job', imageOperationId: 'TEST-op', materialId: 'character:TEST-a' };
    expect(isPetStoryImageFlowBusy(project(), [chat], [], [])).toBe(true);
    chat.petstoryChat = undefined;
    expect(isPetStoryImageFlowBusy(project(), [chat], [], [])).toBe(false);
  });
  it('已提交同项可明确恢复，不能借此恢复另一项或重复在途点击', (): void => {
    const current = task();
    expect(isPetStoryImageFlowBusy(project(), [current], ['TEST-op'], [], 'TEST-op')).toBe(false);
    expect(isPetStoryImageFlowBusy(project(), [current], ['TEST-op'], [], 'TEST-other-op')).toBe(true);
    expect(isPetStoryImageFlowBusy(project(), [current], ['TEST-op'], ['material:TEST-a'], 'TEST-op')).toBe(true);
    current.petstory!.imageOperationId = undefined;
    expect(isPetStoryImageFlowBusy(project(), [current], ['TEST-op'], [], 'TEST-op')).toBe(false);
  });
});
