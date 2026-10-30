/** 真实执行阶段读取控件：离线页面替身，不代表豆包实机生成。 */
import { expect, it, vi } from 'vitest';
import { checkPetStoryPageGuard, readPetStoryComposer } from '../../src/utils/doubaoBridge';
import type { PetStoryComposerSnapshot } from '../../src/utils/petstoryControls';
import type { PetStoryExecutionGuard } from '@doubao-studio/contracts';

it('图片任务在执行中回读当前控件，无免费记录且无需访问视频入口', async (): Promise<void> => {
  const snapshot: PetStoryComposerSnapshot = { present: true, generic: true, first: false, last: false, nativeLabel: false, firstLabel: false, model: '', duration: 0, aspectRatio: '', durations: [], count: 0, pending: false };
  const view = { getURL: (): string => 'https://www.doubao.com/chat/', loadURL: vi.fn(), executeJavaScript: vi.fn(async (): Promise<unknown> => snapshot) };
  const current = await readPetStoryComposer(view);
  const guard = {} as PetStoryExecutionGuard;
  expect((): void => checkPetStoryPageGuard(current, guard, false)).not.toThrow();
  expect(view.executeJavaScript).toHaveBeenCalledOnce(); expect(view.loadURL).not.toHaveBeenCalled();
  expect((): void => checkPetStoryPageGuard({ ...current, present: false }, guard, false)).toThrow('没有找到图片生成输入区');
});
