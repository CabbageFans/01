/** 图片页面归属与调度范围分开：关键帧可以独立页面，但继续占用原账号调度位置。 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@doubao-studio/contracts';
import { getTaskExecutionScope, isMaterialImageTask, usesIndependentImagePage } from '../../src/utils/taskExecutionScope';

function task(mode: 'chat' | 'image'): Task {
  const now = '2026-11-06T00:00:00.000Z';
  return { id: `TEST-frame-${mode}`, projectId: 'TEST-studio', assignedAccountId: 'TEST-account', mode, status: 'queued',
    prompt: 'TEST', outputs: [], result: null, createdAt: now, updatedAt: now,
    ...(mode === 'image' ? { petstory: { projectId: 'TEST-project', imageOperationId: 'TEST-operation', stepId: 'TEST-step' } }
      : { petstoryChat: { projectId: 'TEST-project', imageOperationId: 'TEST-operation', jobId: 'TEST-job' } }) };
}

describe('正式图片操作独立页面资格', (): void => {
  it.each(['chat', 'image'] as const)('关键帧%s有完整操作归属即可独立页面，调度范围仍为原账号', (mode: 'chat' | 'image'): void => {
    const frame = task(mode);
    expect(usesIndependentImagePage(frame)).toBe(true); expect(isMaterialImageTask(frame)).toBe(false);
    expect(getTaskExecutionScope(frame)).toBe(frame.assignedAccountId);
    const material = task(mode); Object.assign(mode === 'image' ? material.petstory! : material.petstoryChat!, { materialId: 'character:TEST-person' });
    expect(usesIndependentImagePage(material)).toBe(true); expect(isMaterialImageTask(material)).toBe(true);
    expect(getTaskExecutionScope(material)).toBe('image:TEST-account:TEST-project:character%3ATEST-person');
  });

  it.each(['chat', 'image'] as const)('缺失或畸形%s操作归属不借此创建独立页', (mode: 'chat' | 'image'): void => {
    for (const key of ['projectId', 'imageOperationId', mode === 'image' ? 'stepId' : 'jobId']) {
      for (const value of [undefined, '', ' TEST-id', 'TEST-id ', 'x'.repeat(201)]) {
        const incomplete = task(mode); Object.assign(mode === 'image' ? incomplete.petstory! : incomplete.petstoryChat!, { [key]: value });
        expect(usesIndependentImagePage(incomplete), `${mode}:${key}`).toBe(false);
        expect(getTaskExecutionScope(incomplete)).toBe(incomplete.assignedAccountId);
      }
    }
    expect(usesIndependentImagePage({ ...task(mode), assignedAccountId: null })).toBe(false);
  });

  it('普通文字、无正式图片操作的生图及视频继续使用原账号页面', (): void => {
    expect(usesIndependentImagePage({ ...task('chat'), petstoryChat: undefined })).toBe(false);
    expect(usesIndependentImagePage({ ...task('image'), petstory: undefined })).toBe(false);
    expect(usesIndependentImagePage({ ...task('image'), mode: 'video' })).toBe(false);
  });
});
