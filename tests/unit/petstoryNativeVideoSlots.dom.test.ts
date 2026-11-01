/** 原生首尾槽的真实 DOM 离线回归；不访问豆包或发送媒体请求。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { petStoryComposerProbe } from '../../src/utils/petstoryControls';

function mount(html: string): void {
  document.body.innerHTML = html;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element): DOMRect {
    const hidden = this.closest('[hidden]');
    return { x: 40, y: 40, left: 40, top: 40, right: hidden ? 40 : 340, bottom: hidden ? 40 : 140, width: hidden ? 0 : 300, height: hidden ? 0 : 100, toJSON: (): object => ({}) };
  });
}

function decodedImage(selector: string, source: string, width: number, height: number): HTMLImageElement {
  const image = document.querySelector(selector) as HTMLImageElement;
  image.src = source;
  Object.defineProperties(image, { complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: width }, naturalHeight: { configurable: true, value: height } });
  return image;
}

afterEach((): void => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('当前视频输入区的原生首尾槽', (): void => {
  it('分别以真实标签绑定首尾上传 input，隐藏测量副本不参与判断', (): void => {
    mount(`<div class="guidance-input-surface" hidden><textarea></textarea><div aria-label="首帧"><input type="file" accept="image/*"></div><div aria-label="尾帧"><input type="file" accept="image/*"></div></div>
      <div class="guidance-input-surface"><textarea></textarea><div aria-label="首帧"><input type="file" accept="image/*"></div><div aria-label="尾帧"><input type="file" accept="image/*"></div></div>`);
    expect(petStoryComposerProbe()).toMatchObject({ present: true, first: true, last: true, generic: false });
  });

  it('普通参考图中即使存在两张图片和首尾说明也不冒充专用槽', (): void => {
    mount('<div class="guidance-input-surface"><textarea></textarea><button>首尾帧</button><div><input type="file" accept="image/*"><img alt="首帧参考"><img alt="尾帧参考"></div></div>');
    expect(petStoryComposerProbe()).toMatchObject({ present: true, first: false, last: false, generic: true });
  });

  it('现场 attachment-image-card 将缩略图与实图聚合为一个附件，双图仍保持普通参考模式', (): void => {
    mount('<div class="guidance-input-surface"><textarea></textarea><input type="file" accept=".jpg,.png,.jpeg,.webp,.apng,.mp4,.mov" multiple><div data-testid="attachment-image-card" data-kind="image"><img id="TEST-first-thumb"><img id="TEST-first-full"><button data-testid="attachment-delete-btn">删除</button></div><div data-testid="attachment-image-card" data-kind="image"><img id="TEST-last-thumb"><img id="TEST-last-full"><button data-testid="attachment-delete-btn">删除</button></div></div>');
    decodedImage('#TEST-first-thumb', 'blob:TEST-first-thumb', 64, 64);
    decodedImage('#TEST-first-full', 'blob:TEST-first-full', 1024, 1024);
    decodedImage('#TEST-last-thumb', 'blob:TEST-last-thumb', 64, 64);
    decodedImage('#TEST-last-full', 'blob:TEST-last-full', 1024, 1024);
    const before = petStoryComposerProbe({ slot: 'reference' });
    expect(before).toMatchObject({ present: true, generic: true, first: false, last: false, count: 2 });
    expect(before.previews).toHaveLength(2);
    expect(new Set(before.previews?.map((preview): string => preview.key)).size).toBe(2);
    decodedImage('#TEST-first-thumb', 'blob:TEST-replaced-thumb', 64, 64);
    expect(petStoryComposerProbe({ slot: 'reference' }).previews).toEqual(before.previews);
    const first = document.getElementById('TEST-first-full') as HTMLImageElement;
    const last = document.getElementById('TEST-last-full') as HTMLImageElement;
    [first.src, last.src] = [last.src, first.src];
    expect(petStoryComposerProbe({ slot: 'reference' }).previews?.map((preview): string => preview.key)).toEqual(before.previews?.map((preview): string => preview.key).reverse());
    first.closest('[data-testid="attachment-image-card"]')?.remove();
    expect(petStoryComposerProbe({ slot: 'reference' })).toMatchObject({ count: 1, generic: true, first: false, last: false });
  });

  it('回读现场新版复合参数按钮，排除其他输入区、弹层与隐藏测量控件', (): void => {
    mount('<div class="guidance-input-surface"><button data-creation-params-panel-id="TEST-other">16:9 · 10s</button><button data-input-engine-actionbar-control-key="video-model">模型 Seedance 2.5</button></div><div class="guidance-input-surface"><textarea></textarea><input type="file" accept="image/*"><button hidden data-creation-params-panel-id="TEST-measuring">1:1 · 4s</button><div role="menu"><button data-creation-params-panel-id="TEST-menu">4:3 · 6s</button><button data-input-engine-actionbar-control-key="video-model">模型 Seedance 2.0 Mini</button></div><button data-input-engine-actionbar-render-entry-key="video-generation-params-panel">９ ： １６ · ５ 秒</button><button data-input-engine-actionbar-control-key="video-model">模型 Seedance 2.0 Fast</button></div>');
    expect(petStoryComposerProbe()).toMatchObject({ aspectRatio: '9:16', duration: 5, model: 'Seedance 2.0 Fast' });
  });

  it('同一参数按钮的新旧嵌套标记只点击一次，两个独立参数按钮则不猜选', (): void => {
    mount('<div class="guidance-input-surface"><textarea></textarea><input type="file" accept="image/*"><div data-creation-params-panel-id="TEST-wrapper"><button id="TEST-params" data-input-engine-actionbar-render-entry-key="video-generation-params-panel">9:16 · 5s</button></div></div>');
    const clicked = vi.fn(); document.getElementById('TEST-params')?.addEventListener('click', clicked);
    expect(petStoryComposerProbe({ openDurations: true })).toMatchObject({ aspectRatio: '9:16', duration: 5 });
    expect(clicked).toHaveBeenCalledTimes(1);
    document.querySelector('.guidance-input-surface')?.insertAdjacentHTML('beforeend', '<button data-creation-params-panel-id="TEST-separate">16:9 · 10s</button>');
    expect(petStoryComposerProbe({ openDurations: true })).toMatchObject({ aspectRatio: '', duration: 0 });
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('现场卡片的可见 role=progressbar 未结束前保持pending，隐藏或移除后才放行', (): void => {
    mount('<div class="guidance-input-surface"><textarea></textarea><input type="file" accept="image/*"><div data-testid="attachment-image-card" data-kind="image"><img id="TEST-loaded"><div class="thumb-loading-mask"><div id="TEST-upload-progress" role="progressbar" aria-label="upload progress 68%"></div></div></div></div><div role="progressbar" aria-label="其他输入区上传进度"></div>');
    decodedImage('#TEST-loaded', 'blob:TEST-loaded', 1024, 1024);
    expect(petStoryComposerProbe()).toMatchObject({ count: 1, pending: true });
    document.getElementById('TEST-upload-progress')?.setAttribute('hidden', '');
    expect(petStoryComposerProbe()).toMatchObject({ count: 1, pending: false });
    document.getElementById('TEST-upload-progress')?.remove();
    expect(petStoryComposerProbe()).toMatchObject({ count: 1, pending: false });
  });

  it('两个独立首帧上传入口有歧义时保留未确认，不选择任意文件 input', (): void => {
    mount('<div class="guidance-input-surface"><textarea></textarea><div aria-label="首帧"><input type="file" accept="image/*"></div><div aria-label="首帧"><input type="file" accept="image/*"></div><div aria-label="尾帧"><input type="file" accept="image/*"></div></div>');
    expect(petStoryComposerProbe()).toMatchObject({ first: false, last: true, generic: false });
    expect(petStoryComposerProbe({ slot: 'first_frame', file: { name: 'TEST-first.png', base64: 'VEVTVA==', mime: 'image/png' } }).uploaded).toBe(false);
  });

  it('隐藏尾帧不能使当前单首帧模式被错误识别成双槽', (): void => {
    mount('<div class="guidance-input-surface"><textarea></textarea><div aria-label="首帧"><input type="file" accept="image/*"></div><div hidden aria-label="尾帧"><input type="file" accept="image/*"></div></div>');
    expect(petStoryComposerProbe()).toMatchObject({ first: true, last: false, generic: false });
  });

  it('上传分别写入本次明确指定的首槽和尾槽，不触碰另一槽文件', (): void => {
    mount('<div class="guidance-input-surface"><textarea></textarea><div aria-label="首帧"><input id="TEST-first" type="file" accept="image/*"></div><div aria-label="尾帧"><input id="TEST-last" type="file" accept="image/*"></div></div>');
    const first = document.getElementById('TEST-first') as HTMLInputElement;
    const last = document.getElementById('TEST-last') as HTMLInputElement;
    const changed: string[] = [];
    first.addEventListener('change', (): void => { changed.push(first.files?.[0]?.name || ''); });
    last.addEventListener('change', (): void => { changed.push(last.files?.[0]?.name || ''); });
    expect(petStoryComposerProbe({ slot: 'first_frame', file: { name: 'TEST-first.png', base64: 'VEVTVA==', mime: 'image/png' } })).toMatchObject({ uploaded: true, uploadedFile: { name: 'TEST-first.png', bytes: 4, mime: 'image/png' } });
    expect(first.files?.[0]?.name).toBe('TEST-first.png'); expect(last.files).toHaveLength(0);
    expect(petStoryComposerProbe({ slot: 'last_frame', file: { name: 'TEST-last.png', base64: 'VEVTVA==', mime: 'image/png' } })).toMatchObject({ uploaded: true, uploadedFile: { name: 'TEST-last.png', bytes: 4, mime: 'image/png' } });
    expect(first.files?.[0]?.name).toBe('TEST-first.png'); expect(last.files?.[0]?.name).toBe('TEST-last.png');
    expect(changed).toEqual(['TEST-first.png', 'TEST-last.png']);
  });
});
