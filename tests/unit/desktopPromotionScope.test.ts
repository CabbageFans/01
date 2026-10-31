/** 离线实际序列化 DOM 探针：不控制浏览器或发送平台请求。 */
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { dismissKnownDesktopDownloadPromotion } from '../../src/utils/doubaoBridge';

interface Node {
  tagName: string; innerText: string; textContent: string; offsetParent: object | null; parentElement: Node | null;
  position: string; message?: boolean; controls: Node[]; rect: { left: number; top: number; width: number; height: number; right: number; bottom: number };
  getAttribute(name: string): string | null; querySelectorAll(selector: string): Node[]; closest(selector: string): Node | null; contains(node: Node): boolean; getBoundingClientRect(): Node['rect'];
  matches(selector: string): boolean; click(): void;
}
function node(tagName: string, text: string, width = 100, height = 30): Node {
  const result: Node = { tagName, innerText: text, textContent: text, offsetParent: {}, parentElement: null, position: 'static', controls: [], rect: { left: 300, top: 200, width, height, right: 300 + width, bottom: 200 + height },
    getAttribute: (): null => null, querySelectorAll: (): Node[] => result.controls, closest: (): Node | null => result.message ? result : null,
    contains: (child: Node): boolean => result === child || result.controls.includes(child), getBoundingClientRect: (): Node['rect'] => result.rect,
    matches: (): boolean => tagName === 'BUTTON', click: (): void => undefined };
  return result;
}
function environment(modal: boolean, buttons = 1, message = false, stayOpen = false, activationDelay = 0): {
  view: Parameters<typeof dismissKnownDesktopDownloadPromotion>[0]; native: ReturnType<typeof vi.fn>; click: ReturnType<typeof vi.fn>; root: Node; location: { href: string }; beforeActivation?: () => void;
} {
  const body = node('BODY', '下载电脑版 其他内容 使用完整功能', 1200, 800);
  const root = node('DIV', modal ? '下载电脑版 使用完整功能 下次提醒我' : '下载电脑版', modal ? 400 : 200, modal ? 300 : 45); root.parentElement = body;
  if (modal) root.position = 'fixed';
  const title = node('SPAN', '下载电脑版'); title.parentElement = root; title.message = message;
  root.controls = Array.from({ length: buttons }, (): Node => node('BUTTON', '下次提醒我', 120, 40));
  let present = true; const native = vi.fn(); const click = vi.fn((): void => { if (!stayOpen) present = false; });
  for (const button of root.controls) { button.parentElement = root; button.click = click; }
  const document = { body, documentElement: body, hasFocus: (): boolean => false, querySelectorAll: (): Node[] => present ? [title] : [], elementFromPoint: (): Node | undefined => root.controls[0] };
  const window = { innerWidth: 1200, innerHeight: 800, getComputedStyle: (element: Node): object => ({ display: 'block', visibility: 'visible', position: element.position }) };
  const location = { href: 'https://www.doubao.com/chat/OFFLINE' }; const context = vm.createContext({ document, window, location, Date });
  let calls = 0;
  const result: ReturnType<typeof environment> = { root, native, click, location, view: {
    getURL: (): string => location.href, loadURL: (): void => undefined, sendInputEvent: native,
    executeJavaScript: async (script: string): Promise<unknown> => {
      calls++;
      if (calls === 2) {
        result.beforeActivation?.();
        if (activationDelay) await new Promise<void>((resolve): void => { setTimeout(resolve, activationDelay); });
      }
      return vm.runInContext(script, context);
    },
  } };
  return result;
}

describe('F03 推广弹窗必须限于真实浮层（离线）', (): void => {
  it.each([false, true])('正文或页脚宣传词不能借整页其他文本拼成推广弹窗（消息=%s）', async (message: boolean): Promise<void> => {
    const test = environment(false, 1, message);
    expect(await dismissKnownDesktopDownloadPromotion(test.view)).toBe('none'); expect(test.click).not.toHaveBeenCalled(); expect(test.native).not.toHaveBeenCalled();
  });
  it('窗口失焦时只对唯一提醒控件执行一次页内click，并回读消失', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const test = environment(true); const result = dismissKnownDesktopDownloadPromotion(test.view);
      await vi.advanceTimersByTimeAsync(500);
      expect(await result).toBe('dismissed'); expect(test.click).toHaveBeenCalledOnce(); expect(test.native).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it.each([0, 2])('真实浮层缺少唯一明确关闭控件时保持失败关闭且零点击（控件=%s）', async (buttons: number): Promise<void> => {
    const test = environment(true, buttons);
    expect(await dismissKnownDesktopDownloadPromotion(test.view)).toBe('failed'); expect(test.click).not.toHaveBeenCalled(); expect(test.native).not.toHaveBeenCalled();
  });
  it.each(['geometry', 'body', 'url'] as const)('激活前%s变化时重新白名单校验并拒绝点击', async (change): Promise<void> => {
    const test = environment(true);
    test.beforeActivation = (): void => {
      if (change === 'geometry') test.root.controls[0].rect.left += 20;
      if (change === 'body') test.root.innerText += ' 页面已变化';
      if (change === 'url') test.location.href += '-changed';
    };
    expect(await dismissKnownDesktopDownloadPromotion(test.view)).toBe('failed'); expect(test.click).not.toHaveBeenCalled(); expect(test.native).not.toHaveBeenCalled();
  });
  it('关闭回执不明时不补点，同一弹窗也不重复激活', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const test = environment(true, 1, false, true); const first = dismissKnownDesktopDownloadPromotion(test.view);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await first).toBe('failed'); expect(await dismissKnownDesktopDownloadPromotion(test.view)).toBe('failed');
      expect(test.click).toHaveBeenCalledOnce(); expect(test.native).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('超时排队的guest脚本迟到后不能点击', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const test = environment(true, 1, false, false, 6000); const pending = dismissKnownDesktopDownloadPromotion(test.view);
      await vi.advanceTimersByTimeAsync(5100); expect(await pending).toBe('failed');
      await vi.advanceTimersByTimeAsync(1000); expect(test.click).not.toHaveBeenCalled(); expect(test.native).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
