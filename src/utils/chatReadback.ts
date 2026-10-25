/** 普通 Chat 只读取消息区；不把侧栏、编辑器或页面脚本当成回复。 */
export interface ChatPageSnapshot {
  messages: { role: 'user' | 'assistant'; text: string; rawText?: string; codeSpans?: number; attachmentOnly?: boolean; turnId?: string }[];
  editorPresent: boolean;
  editorText: string;
  generating: boolean;
}

/** 自包含函数，可序列化到隔离的 Webview 执行；正文仅用于内存比较，不写日志。 */
export function readChatPage(doc: Document): ChatPageSnapshot {
  const messages: ChatPageSnapshot['messages'] = [];
  // 只遍历当前消息正文；PRE 单独保留代码围栏，不混入复制按钮或整页文字。
  const rawContent = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent || '';
    const element = node as HTMLElement;
    const tag = element.tagName || '';
    if (['SCRIPT', 'STYLE', 'BUTTON'].includes(tag)) return '';
    if (tag === 'BR') return '\n';
    if (tag === 'PRE') {
      const code = element.querySelector('code');
      const language = code?.className?.match(/language-([\w-]+)/)?.[1] || '';
      return '\n```' + language + '\n' + (code?.textContent ?? element.textContent ?? '') + '\n```\n';
    }
    const value = node.childNodes?.length ? Array.from(node.childNodes).map(rawContent).join('') : node.textContent || '';
    return ['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'BLOCKQUOTE'].includes(tag) ? value + '\n' : value;
  };
  const messageNodes = Array.from(doc.querySelectorAll('[data-testid="send_message"], [data-testid="receive_message"]'));
  for (const node of messageNodes) {
    const content = node.querySelector('[data-testid="message_text_content"]');
    const turnId = node.closest?.('[data-testid="union_message"]')?.getAttribute('data-target-id') || undefined;
    const attachmentOnly = !content && node.getAttribute('data-testid') === 'send_message' && !!node.querySelector('img');
    // 普通 Chat 的同一 union_message 会把附件和正文分别渲染成 send_message。
    // 只合并有明确共同 turn、图片及唯一正文的附件块；未知／跨 turn 空消息仍保留并阻断。
    if (!content && node.getAttribute('data-testid') === 'send_message' && node.querySelector('img')) {
      const turn = node.closest?.('[data-testid="union_message"]');
      // 同一 turn 也可能拆成多个 union_message wrapper，以非空 data-target-id 关联。
      const turnId = turn?.getAttribute('data-target-id');
      const textPeers = turn ? messageNodes.filter((peer: Element): boolean => {
        const peerTurn = peer.closest?.('[data-testid="union_message"]');
        return peer.getAttribute('data-testid') === 'send_message' && !!peer.querySelector('[data-testid="message_text_content"]')
          && (turnId ? peerTurn?.getAttribute('data-target-id') === turnId : peerTurn === turn);
      }) : [];
      if (textPeers.length === 1) continue;
    }
    const codeSpans = content?.querySelectorAll?.('code')?.length || 0;
    messages.push({
      role: node.getAttribute('data-testid') === 'send_message' ? 'user' : 'assistant',
      rawText: content ? rawContent(content).trim() : '',
      text: (content?.textContent || '').normalize('NFKC').replace(/\s+/g, ' ').trim(),
      ...(codeSpans ? { codeSpans } : {}),
      ...(attachmentOnly ? { attachmentOnly: true } : {}),
      ...(turnId ? { turnId } : {}),
    });
  }
  const editor = Array.from(doc.querySelectorAll<HTMLElement>('textarea, [contenteditable="true"], [contenteditable=""]'))
    .find((element: HTMLElement): boolean => element.offsetParent !== null);
  const editorText = editor?.tagName === 'TEXTAREA' ? (editor as HTMLTextAreaElement).value : editor?.innerText;
  const generating = Array.from(doc.querySelectorAll<HTMLElement>(
    'button[aria-label*="停止"], button[aria-label*="stop"], [data-testid="chat_input_local_break_button"], [class*="stop-generat"]',
  )).some((element: HTMLElement): boolean => element.offsetParent !== null);
  return { messages, editorPresent: !!editor, editorText: editorText || '', generating };
}

/** 发布页面会将成对反引号渲染成 code；只有实际 code 节点与围栏对数相符才容忍此版式差异。 */
function publishedPromptMatches(message: ChatPageSnapshot['messages'][number], prompt: string): boolean {
  const expected = normalizePublishedChatPrompt(prompt);
  const actual = normalizePublishedChatPrompt(message.text);
  if (expected === actual) return true;
  const fences = expected.match(/```/g) || [];
  return !!message.codeSpans && fences.length === message.codeSpans * 2 && !actual.includes('```')
    && expected.replace(/```/g, '') === actual;
}

/** 仅用于已发布消息的版式比较；发送前编辑器仍使用严格全文等值，不放宽写入校验。 */
export function normalizePublishedChatPrompt(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim()
    .replace(/\s*[·・]\s*/g, '·')
    .replace(/(?<=[\p{Script=Han}])\s+|\s+(?=[\p{Script=Han}])/gu, '')
    .replace(/\s+(?=[(=])/g, '');
}

/** 基线在发送前取得；即使回复在首次回读前完成，也不会被吞进基线。 */
export function inspectChatReadback(
  snapshot: ChatPageSnapshot,
  prompt: string,
  baselineMessageCount: number,
): { generationStarted: boolean; inputCleared: boolean; messageCount: number; promptPublished: boolean; replyText: string; replyRawText: string; generating: boolean } {
  const normalize = normalizePublishedChatPrompt;
  const fresh = snapshot.messages.slice(baselineMessageCount);
  const users = fresh.filter((item): boolean => item.role === 'user');
  // 多个用户消息、不同提示词或缺少消息结构时保守等待，不绑定别人的回复。
  const promptPublished = users.length === 1 && publishedPromptMatches(users[0], prompt);
  const userIndex = fresh.findIndex((item): boolean => item.role === 'user');
  const replies = promptPublished ? fresh.slice(userIndex + 1).filter((item): boolean => item.role === 'assistant') : [];
  return {
    generationStarted: promptPublished,
    inputCleared: snapshot.editorPresent && normalize(snapshot.editorText) === '',
    messageCount: snapshot.messages.length,
    promptPublished,
    replyRawText: replies.length === 1 ? (replies[0].rawText ?? replies[0].text) : '',
    replyText: replies.length === 1 ? replies[0].text : '',
    generating: snapshot.generating,
  };
}

/** 创作入口会封装已发布消息；只接受实测固定前缀及与原任务严格相等的视频参数后缀。 */
export function inspectCreationReadback(
  snapshot: ChatPageSnapshot,
  prompt: string,
  mode: 'image' | 'video',
  baselineMessageCount: number,
  videoConfig?: { aspectRatio: string; duration: string },
  confirmationRecorded: boolean = false,
): ReturnType<typeof inspectChatReadback> & { confirmationPublished: boolean } {
  const messages = snapshot.messages.map((message: ChatPageSnapshot['messages'][number]): ChatPageSnapshot['messages'][number] => {
    if (message.role !== 'user' || publishedPromptMatches(message, prompt) || (mode === 'video' && !videoConfig)) return message;
    const text = normalizePublishedChatPrompt(message.text);
    const prefix = mode === 'image' ? '生成图片:' : '生成视频:';
    const suffix = mode === 'video' && videoConfig ? `,${videoConfig.aspectRatio},${videoConfig.duration}` : '';
    if (!text.startsWith(prefix) || (suffix && !text.endsWith(suffix))) return message;
    const candidate = { ...message, text: text.slice(prefix.length, suffix ? -suffix.length : undefined) };
    return publishedPromptMatches(candidate, prompt) ? candidate : message;
  });
  // 已记录参数确认状态后，允许同一会话中唯一的一次精确“确认”回复；其他追加对话仍拒绝。
  type IndexedMessage = { message: ChatPageSnapshot['messages'][number]; index: number };
  const users = messages.map((message: ChatPageSnapshot['messages'][number], index: number): IndexedMessage => ({ message, index }))
    .filter((item: IndexedMessage): boolean => item.index >= baselineMessageCount && item.message.role === 'user');
  const textUsers = users.filter((item: IndexedMessage): boolean => !item.message.attachmentOnly);
  let confirmationPublished = false;
  if (mode === 'video' && confirmationRecorded && textUsers.length === 2 && publishedPromptMatches(textUsers[0].message, prompt)
    && normalizePublishedChatPrompt(textUsers[1].message.text) === '确认'
    && users.every((item: IndexedMessage): boolean => !item.message.attachmentOnly || (item.index < textUsers[0].index
      && !!item.message.turnId && item.message.turnId === textUsers[0].message.turnId))) {
    const remove = new Set(users.filter((item: IndexedMessage): boolean => item.message.attachmentOnly || item.index === textUsers[1].index).map((item: IndexedMessage): number => item.index));
    for (let index = messages.length - 1; index >= baselineMessageCount; index--) if (remove.has(index)) messages.splice(index, 1);
    confirmationPublished = true;
  }
  return { ...inspectChatReadback({ ...snapshot, messages }, prompt, baselineMessageCount), confirmationPublished };
}
