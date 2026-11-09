/** 真实序列化探针配合异步 DOM 重建；不连接豆包、不上传、不提交。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PetStoryExecutionGuard } from '@doubao-studio/contracts';
import { readPetStoryComposer, waitForPetStoryVideoComposer } from '../../src/utils/doubaoBridge';
import type { WebviewHandle } from '../../src/utils/doubaoBridge';
import type { PetStoryComposerSnapshot } from '../../src/utils/petstoryControls';

function guard(mode: PetStoryExecutionGuard['mode'] = 'first_last_frame'): PetStoryExecutionGuard {
  const entry = { state: 'supported' as const, reason: 'TEST 离线入口' };
  return { mode, durationSeconds: 5, attachmentAssetIds: ['TEST-first', 'TEST-last'],
    capability: { accountId: 'TEST-account', checkedAt: '2026-10-31T00:00:00.000Z', image: entry, durations: [5],
      modes: { first_frame: entry, first_last_frame: entry, reference: entry }, videoConfig: { model: 'seedance-2.0', aspectRatio: '9:16', duration: '5s' } } };
}
function sized<T extends HTMLElement>(element: T): T {
  element.getBoundingClientRect = (): DOMRect => ({ x: 10, y: 10, left: 10, top: 10, right: 610, bottom: 210, width: 600, height: 200, toJSON: (): object => ({}) });
  return element;
}
function fixture(initialMode: 'reference' | 'first_frame' | 'first_last_frame' = 'first_last_frame'): {
  view: WebviewHandle & { executeJavaScript: ReturnType<typeof vi.fn>; loadURL: ReturnType<typeof vi.fn>; sendInputEvent: ReturnType<typeof vi.fn> };
  root: HTMLDivElement; parameters: HTMLButtonElement; nativeButton: HTMLButtonElement;
  nativeClick: ReturnType<typeof vi.fn>; referenceClick: ReturnType<typeof vi.fn>; skillClick: ReturnType<typeof vi.fn>; fileChange: ReturnType<typeof vi.fn>;
  renderMode: (mode: 'reference' | 'first_frame' | 'first_last_frame') => void;
  renderSkill: (skill: NonNullable<PetStoryComposerSnapshot['selectedSkill']>) => void;
} {
  const root = sized(document.createElement('div')); root.className = 'guidance-input-surface'; document.body.append(root);
  root.append(sized(document.createElement('textarea')));
  const parameters = sized(document.createElement('button')); parameters.setAttribute('data-creation-params-panel-id', 'TEST-params'); parameters.textContent = '9:16 · 5s'; root.append(parameters);
  const model = sized(document.createElement('button')); model.setAttribute('data-input-engine-actionbar-control-key', 'video-model'); model.textContent = '模型 Seedance 2.0'; root.append(model);
  const nativeButton = sized(document.createElement('button')); nativeButton.textContent = '首尾帧'; root.append(nativeButton);
  const referenceButton = sized(document.createElement('button')); referenceButton.textContent = '参考图'; root.append(referenceButton);
  const nativeClick = vi.fn(); const referenceClick = vi.fn(); const skillClick = vi.fn(); const fileChange = vi.fn();
  nativeButton.addEventListener('click', nativeClick); referenceButton.addEventListener('click', referenceClick);
  const renderSkill = (skill: NonNullable<PetStoryComposerSnapshot['selectedSkill']>): void => {
    root.querySelectorAll('[data-testid="skill_input_exit_button"]').forEach((element): void => element.remove());
    const labels = skill === 'none' ? [] : skill === 'ambiguous' ? ['视频生成', '图像生成'] : [skill === 'video' ? '视频生成' : '图像生成'];
    for (const label of labels) {
      const selected = sized(document.createElement('div')); selected.setAttribute('data-testid', 'skill_input_exit_button'); selected.textContent = label;
      selected.addEventListener('click', skillClick); root.append(selected);
    }
  };
  renderSkill('video');
  const holder = sized(document.createElement('div')); root.append(holder);
  const renderMode = (mode: 'reference' | 'first_frame' | 'first_last_frame'): void => {
    holder.replaceChildren();
    const labels = mode === 'reference' ? [''] : mode === 'first_frame' ? ['首帧'] : ['首帧', '尾帧'];
    for (const label of labels) {
      const wrapper = sized(document.createElement('div')); if (label) wrapper.setAttribute('aria-label', label);
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.style.display = 'none'; input.addEventListener('change', fileChange);
      wrapper.append(input); holder.append(wrapper);
    }
  };
  renderMode(initialMode);
  const view = { executeJavaScript: vi.fn(async (code: string): Promise<PetStoryComposerSnapshot> => window.eval(code) as PetStoryComposerSnapshot),
    loadURL: vi.fn(), getURL: (): string => 'https://www.doubao.com/chat/TEST-video-composer', sendInputEvent: vi.fn() };
  return { view, root, parameters, nativeButton, nativeClick, referenceClick, skillClick, fileChange, renderMode, renderSkill };
}

beforeEach((): void => { vi.useFakeTimers(); vi.setSystemTime('2026-10-31T00:00:00.000Z'); });
afterEach((): void => { document.body.replaceChildren(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('视频上传前真实控件稳定等待', (): void => {
  it.each(['none', 'image', 'ambiguous'] as const)('完整参数残留但已选技能为%s时等待拒绝，不点击模式或上传', async (skill): Promise<void> => {
    const test = fixture('reference'); test.renderSkill(skill);
    expect(await readPetStoryComposer(test.view)).toMatchObject({ selectedSkill: skill, generic: true, duration: 5, model: 'Seedance 2.0', aspectRatio: '9:16' });
    const rejected = expect(waitForPetStoryVideoComposer(test.view, guard(), new AbortController().signal, 1_000)).rejects.toThrow(/视频/);
    await vi.advanceTimersByTimeAsync(1_000); await rejected;
    expect(test.nativeClick).not.toHaveBeenCalled(); expect(test.referenceClick).not.toHaveBeenCalled(); expect(test.skillClick).not.toHaveBeenCalled();
    expect(test.fileChange).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each(['none', 'image', 'ambiguous'] as const)('原生槽位和参数都残留但技能为%s时仍拒绝放行', async (skill): Promise<void> => {
    const test = fixture(); test.renderSkill(skill);
    expect(await readPetStoryComposer(test.view)).toMatchObject({ selectedSkill: skill, first: true, last: true, duration: 5, model: 'Seedance 2.0', aspectRatio: '9:16' });
    const rejected = expect(waitForPetStoryVideoComposer(test.view, guard(), new AbortController().signal, 1_000)).rejects.toThrow(/视频/);
    await vi.advanceTimersByTimeAsync(1_000); await rejected;
    expect(test.nativeClick).not.toHaveBeenCalled(); expect(test.referenceClick).not.toHaveBeenCalled(); expect(test.skillClick).not.toHaveBeenCalled(); expect(test.fileChange).not.toHaveBeenCalled();
  });

  it('视频技能异步重建后重新连续稳定回读，不凭保留的参数提前放行', async (): Promise<void> => {
    const test = fixture(); const completed = vi.fn();
    setTimeout((): void => test.renderSkill('none'), 200);
    setTimeout((): void => test.renderSkill('video'), 600);
    const result = waitForPetStoryVideoComposer(test.view, guard(), new AbortController().signal, 2_000)
      .then((value: PetStoryComposerSnapshot): PetStoryComposerSnapshot => { completed(); return value; });
    await vi.advanceTimersByTimeAsync(750); expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject({ selectedSkill: 'video', first: true, last: true, duration: 5, aspectRatio: '9:16' });
    expect(test.nativeClick).not.toHaveBeenCalled(); expect(test.referenceClick).not.toHaveBeenCalled(); expect(test.skillClick).not.toHaveBeenCalled(); expect(test.fileChange).not.toHaveBeenCalled();
  });

  it('输入区早期缺失，模式点击后首尾槽延迟出现，等连续稳定后才放行', async (): Promise<void> => {
    const test = fixture('reference'); test.root.style.display = 'none';
    setTimeout((): void => { test.root.style.display = ''; }, 350);
    test.nativeButton.addEventListener('click', (): void => {
      setTimeout((): void => test.renderMode('first_frame'), 350);
      setTimeout((): void => test.renderMode('first_last_frame'), 800);
    });
    const completed = vi.fn();
    const result = waitForPetStoryVideoComposer(test.view, guard(), new AbortController().signal, 4_000).then((value: PetStoryComposerSnapshot): PetStoryComposerSnapshot => { completed(); return value; });
    await vi.advanceTimersByTimeAsync(500);
    expect(test.nativeClick).toHaveBeenCalledOnce(); expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000); expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject({ present: true, first: true, last: true, generic: false, duration: 5, aspectRatio: '9:16', model: 'Seedance 2.0' });
    expect(test.nativeClick).toHaveBeenCalledOnce(); expect(test.referenceClick).not.toHaveBeenCalled();
    expect(test.fileChange).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });

  it('已是请求模式时不再点击 toggle，仍需连续两次正确参数回读', async (): Promise<void> => {
    const test = fixture(); test.nativeButton.addEventListener('click', (): void => test.renderMode('reference'));
    const completed = vi.fn(); const result = waitForPetStoryVideoComposer(test.view, guard(), new AbortController().signal).then((value: PetStoryComposerSnapshot): PetStoryComposerSnapshot => { completed(); return value; });
    await vi.advanceTimersByTimeAsync(0); expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject({ first: true, last: true }); expect(test.nativeClick).not.toHaveBeenCalled(); expect(test.referenceClick).not.toHaveBeenCalled();
    expect(test.view.executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it('明确请求参考图且当前通用槽已就绪时只读通过，不触碰其他模式', async (): Promise<void> => {
    const test = fixture('reference');
    const result = waitForPetStoryVideoComposer(test.view, guard('reference'), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(250);
    expect(await result).toMatchObject({ generic: true, first: false, last: false });
    expect(test.nativeClick).not.toHaveBeenCalled(); expect(test.referenceClick).not.toHaveBeenCalled(); expect(test.fileChange).not.toHaveBeenCalled();
  });

  it('参数晚于槽位更新时继续只读等待，不把正确模式重新切走', async (): Promise<void> => {
    const test = fixture(); test.parameters.textContent = '自动 · 10s';
    setTimeout((): void => { test.parameters.textContent = '9:16 · 5s'; }, 650);
    const result = waitForPetStoryVideoComposer(test.view, guard(), new AbortController().signal, 2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ duration: 5, aspectRatio: '9:16' }); expect(test.nativeClick).not.toHaveBeenCalled();
  });

  it('模式按钮晚于输入区挂载时仍可切换，实际点击一次后停止重试', async (): Promise<void> => {
    const test = fixture('reference'); test.nativeButton.remove();
    test.nativeButton.addEventListener('click', (): void => test.renderMode('first_last_frame'));
    setTimeout((): void => { test.root.append(test.nativeButton); }, 600);
    const result = waitForPetStoryVideoComposer(test.view, guard(), new AbortController().signal, 2_000);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await result).toMatchObject({ first: true, last: true, generic: false });
    expect(test.nativeClick).toHaveBeenCalledOnce(); expect(test.referenceClick).not.toHaveBeenCalled(); expect(test.fileChange).not.toHaveBeenCalled();
  });

  it('模式按钮暂时禁用时不消耗切换机会，启用后只点击一次', async (): Promise<void> => {
    const test = fixture('reference'); test.nativeButton.disabled = true;
    test.nativeButton.addEventListener('click', (): void => test.renderMode('first_last_frame'));
    setTimeout((): void => { test.nativeButton.disabled = false; }, 600);
    const result = waitForPetStoryVideoComposer(test.view, guard(), new AbortController().signal, 2_000);
    await vi.advanceTimersByTimeAsync(500); expect(test.nativeClick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toMatchObject({ first: true, last: true }); expect(test.nativeClick).toHaveBeenCalledOnce(); expect(test.fileChange).not.toHaveBeenCalled();
  });

  it('入口始终只有通用参考图则到期拒绝，说明真实限制且不自动降级或上传', async (): Promise<void> => {
    const test = fixture('reference');
    const result = waitForPetStoryVideoComposer(test.view, guard(), new AbortController().signal, 1_000);
    const rejected = expect(result).rejects.toThrow('对应图片上传控件尚未就绪，本次尚未上传或提交');
    await vi.advanceTimersByTimeAsync(1_000); await rejected;
    expect(test.nativeClick).toHaveBeenCalledOnce(); expect(test.referenceClick).not.toHaveBeenCalled(); expect(test.fileChange).not.toHaveBeenCalled();
  });

  it('模式点击后回执丢失时不重复点击，避免把异步切换中的toggle切回', async (): Promise<void> => {
    const test = fixture('reference');
    test.view.executeJavaScript.mockImplementation(async (code: string): Promise<PetStoryComposerSnapshot> => {
      const snapshot = window.eval(code) as PetStoryComposerSnapshot;
      if (code.includes('"selectMode"')) throw new Error('TEST 点击后回执丢失');
      return snapshot;
    });
    const rejected = expect(waitForPetStoryVideoComposer(test.view, guard(), new AbortController().signal, 1_000)).rejects.toThrow('本次尚未上传或提交');
    await vi.advanceTimersByTimeAsync(1_000); await rejected;
    expect(test.nativeClick).toHaveBeenCalledOnce(); expect(test.fileChange).not.toHaveBeenCalled();
  });

  it('模式匹配但模型／时长／比例未匹配时保持拒绝', async (): Promise<void> => {
    const test = fixture(); test.parameters.textContent = '16:9 · 10s';
    const rejected = expect(waitForPetStoryVideoComposer(test.view, guard(), new AbortController().signal, 1_000)).rejects.toThrow('模型／时长／比例回读与计划不一致');
    await vi.advanceTimersByTimeAsync(1_000); await rejected;
    expect(test.nativeClick).not.toHaveBeenCalled(); expect(test.referenceClick).not.toHaveBeenCalled(); expect(test.fileChange).not.toHaveBeenCalled();
  });

  it('开始前取消时不读页面也不点击', async (): Promise<void> => {
    const test = fixture(); const controller = new AbortController(); controller.abort();
    await expect(waitForPetStoryVideoComposer(test.view, guard(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(test.view.executeJavaScript).not.toHaveBeenCalled(); expect(test.nativeClick).not.toHaveBeenCalled();
  });

  it('探针尚未返回时取消，立即停止且迟到的就绪结果不能放行', async (): Promise<void> => {
    const test = fixture(); const controller = new AbortController(); let release: ((snapshot: PetStoryComposerSnapshot) => void) | undefined;
    test.view.executeJavaScript.mockImplementationOnce((): Promise<PetStoryComposerSnapshot> => new Promise((resolve): void => { release = resolve; }));
    const completed = vi.fn(); const result = waitForPetStoryVideoComposer(test.view, guard(), controller.signal).then((): void => { completed(); });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    release?.({ present: true, selectedSkill: 'video', first: true, last: true, generic: false, nativeLabel: true, firstLabel: true, duration: 5, aspectRatio: '9:16', model: 'Seedance 2.0', durations: [5], count: 0, pending: false });
    await vi.advanceTimersByTimeAsync(1_000); expect(completed).not.toHaveBeenCalled(); expect(test.view.executeJavaScript).toHaveBeenCalledTimes(1);
  });

  it('网页探针不返回时受整个等待截止约束，不额外再等固定5秒', async (): Promise<void> => {
    const test = fixture(); test.view.executeJavaScript.mockImplementation((): Promise<PetStoryComposerSnapshot> => new Promise((): void => undefined));
    const rejected = expect(waitForPetStoryVideoComposer(test.view, guard(), new AbortController().signal, 1_000)).rejects.toThrow('尚未连续稳定就绪');
    await vi.advanceTimersByTimeAsync(1_000); await rejected;
    expect(test.view.executeJavaScript).toHaveBeenCalledTimes(1); expect(test.nativeClick).not.toHaveBeenCalled();
  });
});
