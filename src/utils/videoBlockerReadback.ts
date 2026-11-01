export interface VideoBlockerReadbackContext {
  baselineMessageCount: number;
  conversationUrl: string;
  allowGenerationConfirmation?: boolean;
}

export interface VideoBlockerPageSnapshot {
  layerTexts: string[];
  assistantTexts: string[];
}

/** 仅读取本次唯一用户消息之后的助手卡片；页面字符长度、历史消息和用户提示词不参与判定。 */
export function readVideoBlockerPage(doc: Document, baselineMessageCount: number, selectors: readonly string[], allowGenerationConfirmation = false): VideoBlockerPageSnapshot {
  const empty: VideoBlockerPageSnapshot = { layerTexts: [], assistantTexts: [] };
  const visible = (node: Element): boolean => {
    const rect = node.getBoundingClientRect();
    const style = doc.defaultView?.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden';
  };
  const messages = Array.from(doc.querySelectorAll('[data-testid="send_message"], [data-testid="receive_message"]'));
  const fresh = messages.slice(Math.max(0, baselineMessageCount));
  // 附件块可能独立渲染为 send_message，只有正文节点代表用户的新一轮输入。
  const users = fresh.filter((node: Element): boolean => node.getAttribute('data-testid') === 'send_message'
    && !!node.querySelector('[data-testid="message_text_content"]'));
  const confirmed = allowGenerationConfirmation && users.length === 2
    && (users[1].querySelector('[data-testid="message_text_content"]')?.textContent || '').normalize('NFKC').trim() === '确认';
  if (users.length !== 1 && !confirmed) return empty;
  const afterUser = messages.slice(messages.indexOf(users[confirmed ? 1 : 0]) + 1);
  const assistantTexts = afterUser.filter((node: Element): boolean => node.getAttribute('data-testid') === 'receive_message' && visible(node))
    .map((node: Element): string => (node as HTMLElement).innerText || node.textContent || '');
  const layerTexts = [...new Set(selectors.flatMap((selector: string): Element[] => Array.from(doc.querySelectorAll(selector))))]
    .filter((node: Element): boolean => !node.closest('[data-testid="send_message"], [data-testid="receive_message"]') && visible(node))
    .map((node: Element): string => (node as HTMLElement).innerText || node.textContent || '');
  return { layerTexts, assistantTexts };
}
