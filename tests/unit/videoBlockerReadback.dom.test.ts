import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectVideoGenerationBlocker, refreshBlockerBaseline } from '../../src/utils/doubaoBridge';
import type { WebviewHandle } from '../../src/utils/doubaoBridge';

const originalUrl = 'https://www.doubao.com/chat/TEST-video';
const context = { baselineMessageCount: 0, conversationUrl: originalUrl };

function view(): WebviewHandle {
  return {
    executeJavaScript: async (code: string): Promise<unknown> => window.eval(code),
    getURL: (): string => originalUrl,
    loadURL: (): void => undefined,
  };
}

function render(body: string): void {
  document.body.innerHTML = body;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, bottom: 30, right: 300, width: 300, height: 30, toJSON: (): object => ({}) });
}

afterEach((): void => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('原视频运行的真实消息结构阻断回读', (): void => {
  it('失败卡片先于旧基线刷新也能立即识别', async (): Promise<void> => {
    render('<div data-testid="send_message"><div data-testid="message_text_content">TEST 本次视频</div></div><div data-testid="receive_message"><div data-testid="message_text_content">视频生成失败，请重试</div></div>');
    const webview = view();
    await refreshBlockerBaseline(webview);
    await expect(detectVideoGenerationBlocker(webview, context)).resolves.toBe('视频生成失败');
  });

  it('页面变短和重排后仍排除用户提示词、侧栏与历史失败', async (): Promise<void> => {
    render('<aside>权益不足，开通会员</aside><div data-testid="send_message"><div data-testid="message_text_content">TEST 历史请求</div></div><div data-testid="receive_message"><div role="alert">视频生成失败</div></div><div data-testid="send_message"><div data-testid="message_text_content">TEST 提示词包含生成失败、会员专享</div><div class="error">生成异常</div></div><div data-testid="receive_message"><div data-testid="message_text_content">正在生成视频</div></div>');
    (window as unknown as { __doubaoVideoBlockerBaselineLength: number }).__doubaoVideoBlockerBaselineLength = 99999;
    await expect(detectVideoGenerationBlocker(view(), { ...context, baselineMessageCount: 2 })).resolves.toBeNull();
  });

  it('读取本次助手卡片内的状态提示，并排除未解码用户附件块', async (): Promise<void> => {
    render('<div data-testid="send_message"><img src="data:image/png;base64,TEST"></div><div data-testid="send_message"><div data-testid="message_text_content">TEST 本次视频</div></div><div data-testid="receive_message"><div role="status">审核未通过</div></div>');
    await expect(detectVideoGenerationBlocker(view(), context)).resolves.toBe('审核未通过');
  });

  it('用户继续发送了其他请求后不把后续失败归为原运行', async (): Promise<void> => {
    render('<div data-testid="send_message"><div data-testid="message_text_content">TEST 原请求</div></div><div data-testid="receive_message">TEST 原回复</div><div data-testid="send_message"><div data-testid="message_text_content">TEST 其他请求</div></div><div data-testid="receive_message">视频生成失败</div>');
    await expect(detectVideoGenerationBlocker(view(), context)).resolves.toBeNull();
  });

  it('已记录参数确认时，只读取精确确认之后的本次助手失败', async (): Promise<void> => {
    render('<div data-testid="send_message"><div data-testid="message_text_content">TEST 原视频请求包含生成失败</div></div><div data-testid="receive_message">视频生成参数确认</div><div data-testid="send_message"><div data-testid="message_text_content">确认</div></div><div data-testid="receive_message"><div role="status">次数已用完</div></div>');
    await expect(detectVideoGenerationBlocker(view(), { ...context, allowGenerationConfirmation: true })).resolves.toBe('次数已用完');
    await expect(detectVideoGenerationBlocker(view(), context)).resolves.toBeNull();
    const followup = document.createElement('div'); followup.setAttribute('data-testid', 'send_message'); followup.innerHTML = '<div data-testid="message_text_content">TEST 另一请求</div>'; document.body.append(followup);
    await expect(detectVideoGenerationBlocker(view(), { ...context, allowGenerationConfirmation: true })).resolves.toBeNull();
  });

  it('离开原会话时不读取其他会话的失败', async (): Promise<void> => {
    const webview = view(); webview.getURL = (): string => 'https://www.doubao.com/chat/TEST-other';
    const execute = vi.spyOn(webview, 'executeJavaScript');
    await expect(detectVideoGenerationBlocker(webview, context)).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});
