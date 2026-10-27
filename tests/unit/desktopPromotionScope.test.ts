/** 离线实际序列化 DOM 探针：不控制浏览器或发送平台请求。 */
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { dismissKnownDesktopDownloadPromotion } from '../../src/utils/doubaoBridge';

interface Node {
  tagName: string; innerText: string; textContent: string; offsetParent: object | null; parentElement: Node | null;
  position: string; message?: boolean; controls: Node[]; rect: { left: number; top: number; width: number; height: number; right: number; bottom: number };
  getAttribute(name: string): string | null; querySelectorAll(selector: string): Node[]; closest(selector: string): Node | null; contains(node: Node): boolean; getBoundingClientRect(): Node['rect'];
}
function node(tagName: string, text: string, width = 100, height = 30): Node {
  const result: Node = { tagName, innerText: text, textContent: text, offsetParent: {}, parentElement: null, position: 'static', controls: [], rect: { left: 300, top: 200, width, height, right: 300 + width, bottom: 200 + height },
    getAttribute: (): null => null, querySelectorAll: (): Node[] => result.controls, closest: (): Node | null => result.message ? result : null,
    contains: (child: Node): boolean => result === child || result.controls.includes(child), getBoundingClientRect: (): Node['rect'] => result.rect };
  return result;
}
function environment(modal: boolean, buttons = 1, message = false): { view: Parameters<typeof dismissKnownDesktopDownloadPromotion>[0]; events: unknown[] } {
  const body = node('BODY', '下载电脑版 其他内容 使用完整功能', 1200, 800);
  const root = node('DIV', modal ? '下载电脑版 使用完整功能 下次提醒我' : '下载电脑版', modal ? 400 : 200, modal ? 300 : 45); root.parentElement = body;
  if (modal) root.position = 'fixed';
  const title = node('SPAN', '下载电脑版'); title.parentElement = root; title.message = message;
  root.controls = Array.from({ length: buttons }, (): Node => node('BUTTON', '下次提醒我', 120, 40));
  let present = true; const events: unknown[] = [];
  const document = { querySelectorAll: (): Node[] => present ? [title] : [], elementFromPoint: (): Node | undefined => root.controls[0] };
  const window = { innerWidth: 1200, innerHeight: 800, getComputedStyle: (element: Node): object => ({ display: 'block', visibility: 'visible', position: element.position }) };
  const view = { getURL: (): string => 'https://www.doubao.com/chat/OFFLINE', loadURL: (): void => {},
    executeJavaScript: async (script: string): Promise<unknown> => vm.runInNewContext(script, { document, window }),
    sendInputEvent: (event: { type: string }): void => { events.push(event); if (event.type === 'mouseUp') present = false; } };
  return { view, events };
}

describe('F03 推广弹窗必须限于真实浮层（离线）', (): void => {
  it.each([false, true])('正文或页脚宣传词不能借整页其他文本拼成推广弹窗（消息=%s）', async (message: boolean): Promise<void> => {
    const { view, events } = environment(false, 1, message);
    expect(await dismissKnownDesktopDownloadPromotion(view)).toBe('none'); expect(events).toHaveLength(0);
  });
  it('真实紧凑浮层的唯一明确提醒按钮使用一次原生点击，并回读消失', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const { view, events } = environment(true); const result = dismissKnownDesktopDownloadPromotion(view);
      await vi.advanceTimersByTimeAsync(500);
      expect(await result).toBe('dismissed'); expect(events).toHaveLength(3);
    } finally { vi.useRealTimers(); }
  });
  it.each([0, 2])('真实浮层缺少唯一明确关闭控件时保持失败关闭且零点击（控件=%s）', async (buttons: number): Promise<void> => {
    const { view, events } = environment(true, buttons);
    expect(await dismissKnownDesktopDownloadPromotion(view)).toBe('failed'); expect(events).toHaveLength(0);
  });
});
