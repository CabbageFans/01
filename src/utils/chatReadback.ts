/** 普通 Chat 只读取消息区；不把侧栏、编辑器或页面脚本当成回复。 */
export interface ChatPageSnapshot {
  messages: { role: 'user' | 'assistant'; text: string; rawText?: string; renderedSource?: string; codeSpans?: number; fencedCode?: { language: string; text: string }[]; headingCount?: number; attachmentOnly?: boolean; turnId?: string }[];
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
  // 只按实际 DOM 恢复 Markdown 版式标记，不删除正文中的任意数字或标点。
  // textContent 不包含 OL 的序号，且会粘连相邻段落；这不是平台改写了已发送全文。
  const renderedSource = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent || '';
    const element = node as HTMLElement; const tag = element.tagName || '';
    if (['SCRIPT', 'STYLE', 'BUTTON'].includes(tag)) return '';
    if (tag === 'BR') return '\n';
    if (tag === 'PRE') return rawContent(node);
    const body = node.childNodes?.length ? Array.from(node.childNodes).map(renderedSource).join('') : node.textContent || '';
    if (/^H[1-6]$/.test(tag)) return '#'.repeat(Number(tag[1])) + ' ' + body + '\n';
    if (tag === 'LI') {
      const parent = element.parentElement;
      const prefix = parent?.tagName === 'OL' ? `${Number(parent.getAttribute('start') || '1') + Array.from(parent.children).indexOf(element)}. ` : '- ';
      return prefix + body.trim() + '\n';
    }
    if (tag === 'STRONG' || tag === 'B') return '**' + body + '**';
    if (tag === 'EM' || tag === 'I') return '*' + body + '*';
    if (tag === 'CODE') return '`' + body + '`';
    return ['P', 'DIV', 'OL', 'UL', 'BLOCKQUOTE'].includes(tag) ? body + '\n' : body;
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
    const fencedCode = Array.from(content?.querySelectorAll?.('pre') || []).flatMap((pre: Element): { language: string; text: string }[] => {
      const code = pre.querySelector('code');
      return code ? [{ language: code.className?.match(/language-([\w-]+)/)?.[1] || '', text: code.textContent || '' }] : [];
    });
    const headingCount = content?.querySelectorAll?.('h1,h2,h3,h4,h5,h6')?.length || 0;
    const formatted = !!content?.querySelectorAll?.('ol,ul,strong,em,pre,code,h1,h2,h3,h4,h5,h6')?.length;
    messages.push({
      role: node.getAttribute('data-testid') === 'send_message' ? 'user' : 'assistant',
      rawText: content ? rawContent(content).trim() : '',
      ...(formatted && content ? { renderedSource: renderedSource(content).trim() } : {}),
      text: (content?.textContent || '').normalize('NFKC').replace(/\s+/g, ' ').trim(),
      ...(codeSpans ? { codeSpans } : {}),
      ...(fencedCode.length ? { fencedCode } : {}),
      ...(headingCount ? { headingCount } : {}),
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

/** PRE/CODE 逐字证明代码正文后，仅把原请求的外层围栏长度映射到 DOM 恢复的三个反引号。 */
function provenFencedSource(prompt: string, blocks: NonNullable<ChatPageSnapshot['messages'][number]['fencedCode']>): string | undefined {
  let index = 0; let mismatch = false;
  const canonical = prompt.replace(/^(`{3,})([^\n`]*)\n([\s\S]*?)\n\1[\t ]*(?=\n|$)/gm, (whole: string, _fence: string, language: string, body: string): string => {
    const block = blocks[index++];
    const expected = body.replace(/\r\n/g, '\n');
    let actual = block?.text.replace(/\r\n/g, '\n');
    let actualLanguage = block?.language;
    // 实页有时以无 language 的 CODE 节点显示整个原始围栏，不能再把它当已解析的 JSON 代码块。
    // 页面也会把动态长围栏显示成三个反引号；只映射成对外壳，语言及其中正文仍须逐字核对。
    const echoed = !actualLanguage && actual?.match(/^(`{3,})([^\n`]*)\n([\s\S]*?)\n\1[\t ]*$/);
    if (echoed && echoed[2].trim() === language.trim()) { actual = echoed[3]; actualLanguage = echoed[2].trim(); }
    // Markdown 代码节点常包含关闭围栏前的一个终止换行；不改变代码中的任何空白或转义。
    if (!block || actualLanguage !== language.trim() || actual !== expected && actual !== expected + '\n') { mismatch = true; return whole; }
    return '```' + block.language + '\n' + block.text + '\n```';
  });
  return !mismatch && index === blocks.length ? canonical : undefined;
}

/** 仅有对应 DOM 证据时移除已渲染的 Markdown 标记；其余正文仍须全文相等。 */
function publishedPromptMatches(message: ChatPageSnapshot['messages'][number], prompt: string): boolean {
  // 页面中西文排版会在数字与算符两侧插入间距。仅在实际 DOM 已恢复版式时
  // 对齐数字—算符边界，保留所有数字、算符及数字内部空白；不做前缀或去空白匹配。
  const renderedTypographySpacing = (value: string): string => normalizePublishedChatPrompt(value)
    .replace(/(?<=[+−×÷=])\s+(?=\d)|(?<=\d)\s+(?=[+−×÷=])/gu, '')
    // 豆包实测会给“中文/ID/中文”和英文枚举的斜杠两侧加减排版空格。
    // 仅恢复有 Markdown DOM 证据的字母/汉字边界，不归一数字除法、词内空格或正文内容。
    .replace(/(?<=[\p{Script=Han}\p{Script=Latin}_])\s*\/\s*(?=[\p{Script=Han}\p{Script=Latin}_])/gu, '/')
    // 实际 Markdown DOM 还会把契约字段的 string[] 排版成 string []。
    // 仅对冒号后的内建数组类型恢复该间距；不改类型名、数组括号内部或引号内的字面文本。
    .replace(/(:\s*(?:string|number|boolean|unknown|never|object))\s+(?=\[\])/g, '$1');
  if (message.renderedSource !== undefined) {
    const fencedSource = message.fencedCode?.length ? provenFencedSource(prompt, message.fencedCode) : prompt;
    if (fencedSource === undefined) return false;
    const expectedSource = renderedTypographySpacing(fencedSource);
    const actualSource = renderedTypographySpacing(message.renderedSource);
    if (actualSource === expectedSource) return true;
    // 普通 Markdown 会消耗 JSON 证据字符串内的 \"；实际 DOM 原样保留双引号。
    // 仅在本消息没有代码节点或反引号时恢复这种已观察转义，不改 \n、双反斜杠或引号内容。
    if (!message.codeSpans && !expectedSource.includes('`') && actualSource === expectedSource.replace(/(?<!\\)\\"/g, '"')) return true;
    // JSON 字符串内的成对三反引号可能被页面渲染为单个行内 CODE 节点。
    // 只恢复实际 CODE 的一对定界符，仍比较其全部内容及完整外层消息。
    const pairs = expectedSource.match(/```/g) || [];
    if (message.codeSpans && pairs.length === message.codeSpans * 2) {
      const inline = actualSource.match(/(?<!`)`[^`]+`(?!`)/g) || [];
      if (inline.length === message.codeSpans && actualSource.replace(/(?<!`)`([^`]+)`(?!`)/g, '```$1```') === expectedSource) return true;
    }
  }
  let source = prompt;
  const headings = source.match(/^#{1,6}[\t ]+/gm) || [];
  const renderedHeadings = headings.length > 0 && message.headingCount === headings.length;
  if (renderedHeadings) source = source.replace(/^#{1,6}[\t ]+/gm, '');
  const expected = normalizePublishedChatPrompt(source);
  // textContent 会合并标题与前一段；rawText 保留实测 DOM 段落边界，避免误判相邻英文。
  const actual = normalizePublishedChatPrompt(renderedHeadings ? (message.rawText ?? message.text) : message.text);
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

/** 只输出长度／字符类别和排版标点码，不记录提示词、人物名或页面正文。 */
export function diagnoseChatReadback(snapshot: ChatPageSnapshot, prompt: string): object {
  const expected = normalizePublishedChatPrompt(prompt);
  const users = snapshot.messages.filter((m): boolean => m.role === 'user');
  const candidates = users.length === 1 ? [users[0].renderedSource, users[0].rawText, users[0].text].filter((s): s is string => s !== undefined).map(normalizePublishedChatPrompt) : [];
  const prefix = (value: string): number => { let i = 0; while (i < expected.length && expected[i] === value[i]) i++; return i; };
  const actual = candidates.sort((a, b): number => prefix(b) - prefix(a))[0] || '';
  const at = prefix(actual);
  const character = (value: string): object => ({ kind: !value ? 'end' : /\s/.test(value) ? 'space' : /[\p{P}\p{S}]/u.test(value) ? 'punctuation' : 'content', ...(/[\s\p{P}\p{S}]/u.test(value) ? { codePoint: value.codePointAt(0) } : {}) });
  const variants = users.length === 1 ? (['renderedSource', 'rawText', 'text'] as const).flatMap((key): object[] => {
    const value = users[0][key]; if (value === undefined) return [];
    const normalized = normalizePublishedChatPrompt(value);
    const offset = prefix(normalized);
    const withoutExtraSpaces = normalized.slice(0, offset) + normalized.slice(offset).replace(/\s+/g, '');
    return [{ key, length: normalized.length, prefix: offset, expected: character(expected[offset] || ''), observed: character(normalized[offset] || ''), tailMatchesAfterRemovingObservedWhitespace: withoutExtraSpaces === expected }];
  }) : [];
  return { users: users.length, messages: snapshot.messages.length, expectedLength: expected.length, observedLength: actual.length, samePrefixLength: at, expected: character(expected[at] || ''), observed: character(actual[at] || ''), renderedStructure: !!users[0]?.renderedSource, variants };
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
