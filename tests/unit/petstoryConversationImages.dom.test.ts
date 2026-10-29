/** 离线消息 DOM 证据：不访问豆包，不以本测试声称真实网页选择器验收。 */
import { afterEach, describe, expect, it } from 'vitest';
import { readChatPage } from '../../src/utils/chatReadback';

function picture(source: string, width: number = 800, height: number = 600): HTMLImageElement {
  const image = document.createElement('img'); image.src = source;
  Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } });
  return image;
}
afterEach((): void => { document.body.replaceChildren(); });

describe('具体助手回复图片的只读归属', (): void => {
  it('只读取对应助手消息已加载的内容图，排除页面其他图、用户附件和小图标', (): void => {
    const user = document.createElement('div'); user.dataset.testid = 'send_message';
    user.innerHTML = '<div data-testid="message_text_content">TEST 调整当前首帧</div>'; user.append(picture('https://p3.byteimg.com/TEST-upload.png'));
    const first = document.createElement('div'); first.dataset.testid = 'receive_message'; first.dataset.messageId = 'TEST-reply-one';
    first.append(picture('https://p3.byteimg.com/TEST-answer.png'), picture('https://p3.byteimg.com/avatar.png'), picture('https://p3.byteimg.com/TEST-small.png', 48, 48), picture('https://p3.byteimg.com/TEST-not-loaded.png', 0, 0), picture('http://p3.byteimg.com/TEST-http.png'));
    const second = document.createElement('div'); second.dataset.testid = 'receive_message'; second.dataset.messageId = 'TEST-reply-two'; second.append(picture('https://p3.byteimg.com/TEST-next.png'));
    document.body.append(picture('https://p3.byteimg.com/TEST-sidebar.png'), user, first, second);
    const snapshot = readChatPage(document);
    expect(snapshot.messages[0].imageUrls).toBeUndefined();
    expect(snapshot.messages[1]).toMatchObject({ role: 'assistant', messageId: 'TEST-reply-one', rawText: '', imageUrls: ['https://p3.byteimg.com/TEST-answer.png'] });
    expect(snapshot.messages[2]).toMatchObject({ role: 'assistant', messageId: 'TEST-reply-two', imageUrls: ['https://p3.byteimg.com/TEST-next.png'] });
  });
});
