import { isSameDoubaoConversation } from './taskConversationLocator';
import { classifyGenerationConfirmationText } from './generationConfirmation';

/** 图卡只读诊断仅保留结构、类型与计数，不包含正文、身份或媒体地址。 */
export interface ImageArtifactDiagnostics {
  cardCount: number;
  renderedImageCount: number;
  modelFound: boolean;
  blockCounts: { normalized: number; v2: number; legacy: number };
  creationCount: number;
  matchedCreationCount: number;
  matchedCardCount: number;
  creations: {
    imagePresent: boolean;
    statusType: string;
    status?: number;
    finishedType: string;
    finished?: boolean;
    matchedCardCount: number;
    variants: {
      field: string;
      present: boolean;
      urlValid: boolean;
      widthType: string;
      heightType: string;
      widthPositive: boolean;
      heightPositive: boolean;
      matchedCardCount: number;
    }[];
  }[];
}

/** 普通 Chat 只读取消息区；不把侧栏、编辑器或页面脚本当成回复。 */
export interface ChatPageSnapshot {
  messages: { role: 'user' | 'assistant'; text: string; rawText?: string; renderedSource?: string; codeSpans?: number; fencedCode?: { language: string; text: string }[]; headingCount?: number; attachmentOnly?: boolean; hasAttachments?: boolean; turnId?: string; messageId?: string; replyId?: string; imageUrls?: string[]; imageArtifactUrls?: string[]; imageArtifactPending?: boolean; imageArtifactFailure?: string; imageArtifactDiagnostics?: ImageArtifactDiagnostics; videoReady?: boolean }[];
  editorPresent: boolean;
  editorText: string;
  generating: boolean;
  /** 当前会话 dataList 的每条消息均由已挂载 provider DTO 逐条读取，不表示服务器没有更早分页。 */
  historyComplete?: boolean;
  conversationId?: string;
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
  const attachmentIsGrouped = (node: Element): boolean => {
    if (node.querySelector('[data-testid="message_text_content"]') || node.getAttribute('data-testid') !== 'send_message' || !node.querySelector('img')) return false;
    const turn = node.closest?.('[data-testid="union_message"]');
    if (!turn) return false;
    const turnId = turn.getAttribute('data-target-id');
    const textPeers = messageNodes.filter((peer: Element): boolean => {
      const peerTurn = peer.closest?.('[data-testid="union_message"]');
      return peer.getAttribute('data-testid') === 'send_message' && !!peer.querySelector('[data-testid="message_text_content"]')
        && (turnId ? peerTurn?.getAttribute('data-target-id') === turnId : peerTurn === turn);
    });
    return textPeers.length === 1;
  };
  const hasGroupedAttachments = (node: Element): boolean => {
    if (node.getAttribute('data-testid') !== 'send_message') return false;
    if (node.querySelector('img')) return true;
    const turn = node.closest?.('[data-testid="union_message"]');
    const turnId = turn?.getAttribute('data-target-id');
    return !!turn && messageNodes.some((peer: Element): boolean => peer !== node && !!peer.querySelector('img') && attachmentIsGrouped(peer)
      && (turnId ? peer.closest?.('[data-testid="union_message"]')?.getAttribute('data-target-id') === turnId : peer.closest?.('[data-testid="union_message"]') === turn));
  };
  const codeEvidence = (content: Element | null): Partial<ChatPageSnapshot['messages'][number]> => {
    const codeSpans = content?.querySelectorAll?.('code')?.length || 0;
    const fencedCode = Array.from(content?.querySelectorAll?.('pre') || []).flatMap((pre: Element): { language: string; text: string }[] => {
      const code = pre.querySelector('code');
      return code ? [{ language: code.className?.match(/language-([\w-]+)/)?.[1] || '', text: code.textContent || '' }] : [];
    });
    const headingCount = content?.querySelectorAll?.('h1,h2,h3,h4,h5,h6')?.length || 0;
    return { ...(codeSpans ? { codeSpans } : {}), ...(fencedCode.length ? { fencedCode } : {}), ...(headingCount ? { headingCount } : {}) };
  };
  // 自包含：此函数随消息读取器一起序列化，不依赖宿主模块或整页全局媒体缓存。
  const readOriginalImageCards = (node: Element, suppliedModel?: Record<string, unknown>): Pick<ChatPageSnapshot['messages'][number], 'imageArtifactUrls' | 'imageArtifactPending' | 'imageArtifactFailure' | 'imageArtifactDiagnostics'> => {
    if (node.getAttribute('data-testid') !== 'receive_message') return {};
    const cards = Array.from(node.querySelectorAll('[data-testid="message_image_content"]'));
    type Value = Record<string, unknown>;
    const object = (value: unknown): Value | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : undefined;
    const modelForMessage = (): Value | undefined => {
      const keys = Object.getOwnPropertyNames(node).filter((key: string): boolean => key.startsWith('__reactFiber$'));
      if (keys.length !== 1) return undefined;
      let fiber = object((node as unknown as Value)[keys[0]]); let found: Value | undefined;
      for (let depth = 0; fiber && depth < 8; depth++, fiber = object(fiber.return)) {
        const props = object(fiber.memoizedProps); const value = object(props?.value);
        const model = object(value?.message) || object(props?.message);
        if (!model) continue;
        if (typeof model.message_id !== 'string' || typeof model.conversation_id !== 'string') return undefined;
        if (found && (found.message_id !== model.message_id || found.conversation_id !== model.conversation_id)) return undefined;
        found = model;
      }
      const declared = node.getAttribute('data-message-id') || node.getAttribute('data-msg-id');
      return found && (!declared || declared === found.message_id) ? found : undefined;
    };
    const model = suppliedModel || modelForMessage();
    const creationsIn = (blocks: unknown, normalized: boolean): Value[] => Array.isArray(blocks) ? blocks.flatMap((value: unknown): Value[] => {
      const block = object(value); if (!block || block.is_deleted) return [];
      const content = normalized ? object(block.content_obj) : object(object(block.content)?.creation_block);
      return Array.isArray(content?.creations) ? content.creations.flatMap((creation: unknown): Value[] => {
        const item = object(creation); return item ? [{ image: item.image, finished: block.is_finish }] : [];
      }) : [];
    }) : [];
    const normalized = creationsIn(model?.content_blocks, true);
    // v2 同时存在归一化 content_obj 与旧 creation_block；只读当前消息明确的字段。
    const normalizedV2 = creationsIn(model?.content_blocks_v2, true);
    const modern = normalized.length ? normalized : normalizedV2.length ? normalizedV2 : creationsIn(model?.content_blocks_v2, false);
    const creations = modern.length ? modern : creationsIn(model?.content_block, false);
    const remoteUrl = (value: unknown): value is string => {
      if (typeof value !== 'string' || !/^https:\/\//i.test(value)) return false;
      try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
    };
    const matchedVariantCards = (sources: string[]): number => cards.filter((card: Element): boolean => Array.from(card.querySelectorAll('img')).some((element: HTMLImageElement): boolean => !element.closest('video')
      && (sources.includes(element.currentSrc || element.src) || sources.includes(element.src)))).length;
    // 诊断只读取已知字段的存在、类型及比较结果；不输出任意 provider 值或媒体地址。
    const blockCount = (blocks: unknown): number => Array.isArray(blocks) ? blocks.length : 0;
    const diagnostics: NonNullable<ChatPageSnapshot['messages'][number]['imageArtifactDiagnostics']> = {
      cardCount: cards.length, renderedImageCount: cards.reduce((count: number, card: Element): number => count + card.querySelectorAll('img').length, 0), modelFound: !!model,
      blockCounts: { normalized: blockCount(model?.content_blocks), v2: blockCount(model?.content_blocks_v2), legacy: blockCount(model?.content_block) },
      creationCount: creations.length, matchedCreationCount: 0, matchedCardCount: 0,
      creations: creations.slice(0, 32).map((creation: Value): NonNullable<ChatPageSnapshot['messages'][number]['imageArtifactDiagnostics']>['creations'][number] => {
        const image = object(creation.image);
        return { imagePresent: !!image, statusType: typeof image?.status, ...(typeof image?.status === 'number' && Number.isFinite(image.status) ? { status: image.status } : {}),
          finishedType: typeof creation.finished, ...(typeof creation.finished === 'boolean' ? { finished: creation.finished } : {}), matchedCardCount: 0,
          variants: ['image_thumb', 'image_ori', 'image_preview', 'image_ori_raw', 'image_preview_resize'].map((field: string): NonNullable<ChatPageSnapshot['messages'][number]['imageArtifactDiagnostics']>['creations'][number]['variants'][number] => {
            const variant = image ? object(image[field]) : undefined; const variantUrl = variant?.url; const valid = remoteUrl(variantUrl);
            return { field, present: !!variant, urlValid: valid, widthType: typeof variant?.width, heightType: typeof variant?.height,
              widthPositive: typeof variant?.width === 'number' && Number.isFinite(variant.width) && variant.width > 0,
              heightPositive: typeof variant?.height === 'number' && Number.isFinite(variant.height) && variant.height > 0,
              matchedCardCount: valid ? matchedVariantCards([variantUrl]) : 0 };
          }) };
      }),
    };
    // 无卡时只记录真实 provider 的结构；普通 Chat 保持原快照契约。
    if (!cards.length) return model ? { imageArtifactDiagnostics: diagnostics } : {};
    const failureFor = (card: Element): string | undefined => (card.textContent || '').normalize('NFKC').trim()
      .match(/^(?:图片生成失败|生成图片失败|图片生成异常|图片生成出错|生成失败|图片生成次数已用完|图片生成额度不足|请求未通过内容审核)/)?.[0];
    let imageArtifactFailure: string | undefined; let imageArtifactPending = false;
    const matchedCards = new Set<Element>(); const urls: string[] = [];
    for (const [creationIndex, creation] of creations.entries()) {
      const image = object(creation.image); if (!image) continue;
      const variants = ['image_thumb', 'image_ori', 'image_preview', 'image_ori_raw', 'image_preview_resize'].flatMap((key: string): string[] => {
        const variant = object(image[key]); return remoteUrl(variant?.url) ? [variant.url] : [];
      });
      // 原图字段必须与本消息图片卡的某个真实渲染源精确关联；不按最大尺寸猜地址。
      const owned = cards.filter((card: Element): boolean => Array.from(card.querySelectorAll('img')).some((element: HTMLImageElement): boolean => !element.closest('video')
        && (variants.includes(element.currentSrc || element.src) || variants.includes(element.src))));
      if (owned.length) diagnostics.matchedCreationCount++;
      if (diagnostics.creations[creationIndex]) diagnostics.creations[creationIndex].matchedCardCount = owned.length;
      if (!owned.length) { imageArtifactPending = true; continue; }
      for (const card of owned) matchedCards.add(card);
      const original = ['image_ori', 'image_ori_raw'].map((key: string): Value | undefined => object(image[key])).find((variant: Value | undefined): variant is Value => !!variant && remoteUrl(variant.url)
        && typeof variant.width === 'number' && Number.isFinite(variant.width) && variant.width > 0
        && typeof variant.height === 'number' && Number.isFinite(variant.height) && variant.height > 0);
      if (!original || image.status !== 2 || creation.finished === false) { imageArtifactPending = true; continue; }
      // 已由平台显式给出的原图不依赖懒渲染、display:none 或缩略图解码完成。
      urls.push(original.url as string);
    }
    for (const card of cards) {
      const failure = failureFor(card); if (failure) imageArtifactFailure = failure;
      if (card.getAttribute('data-finished') === 'false' || !matchedCards.has(card) && !failure) imageArtifactPending = true;
    }
    diagnostics.matchedCardCount = matchedCards.size;
    return { imageArtifactDiagnostics: diagnostics, imageArtifactUrls: [...new Set(urls)], imageArtifactPending, ...(imageArtifactFailure ? { imageArtifactFailure } : {}) };
  };
  const readMessage = (node: Element): ChatPageSnapshot['messages'][number] | undefined => {
    const content = node.querySelector('[data-testid="message_text_content"]');
    const turnId = node.closest?.('[data-testid="union_message"]')?.getAttribute('data-target-id') || undefined;
    const messageId = node.getAttribute('data-message-id') || node.getAttribute('data-msg-id') || undefined;
    const attachmentOnly = !content && node.getAttribute('data-testid') === 'send_message' && !!node.querySelector('img');
    // 图片必须来自这条助手消息本身；不收集头像、视频封面、用户附件或整页最后一张图。
    const imageUrls = node.getAttribute('data-testid') === 'receive_message' ? [...new Set(Array.from(node.querySelectorAll('img')).flatMap((image): string[] => {
      const src = image.currentSrc || image.src;
      if (!/^https:\/\//i.test(src) || /(?:avatar|emoji|icon|logo|badge)/i.test(src) || image.closest('video') || image.naturalWidth < 100 || image.naturalHeight < 100) return [];
      return [src];
    }))] : [];
    const imageArtifacts = readOriginalImageCards(node);
    // 普通 Chat 的同一 union_message 会把附件和正文分别渲染成 send_message。
    // 只合并有明确共同 turn、图片及唯一正文的附件块；未知／跨 turn 空消息仍保留并阻断。
    if (attachmentIsGrouped(node)) return undefined;
    const formatted = !!content?.querySelectorAll?.('ol,ul,strong,em,pre,code,h1,h2,h3,h4,h5,h6')?.length;
    return {
      role: node.getAttribute('data-testid') === 'send_message' ? 'user' : 'assistant',
      rawText: content ? rawContent(content).trim() : '',
      ...(formatted && content ? { renderedSource: renderedSource(content).trim() } : {}),
      text: (content?.textContent || '').normalize('NFKC').replace(/\s+/g, ' ').trim(),
      ...codeEvidence(content),
      ...(attachmentOnly ? { attachmentOnly: true } : {}),
      ...(hasGroupedAttachments(node) ? { hasAttachments: true } : {}),
      ...(turnId ? { turnId } : {}),
      ...(messageId ? { messageId } : {}),
      ...(imageUrls.length ? { imageUrls } : {}),
      ...imageArtifacts,
      ...(node.getAttribute('data-testid') === 'receive_message' && node.querySelector('[class*="block-video"],video') ? { videoReady: true } : {}),
    };
  };
  for (const node of messageNodes) {
    const message = readMessage(node);
    if (message) messages.push(message);
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

/** 由正式任务提供身份；页面回显本身不能创建任务、运行或账号归属。 */
export interface ChatReadbackContext {
  taskId: string;
  runId: string;
  currentRunId: string;
  accountId: string;
  currentAccountId: string;
  conversationUrl: string;
  currentConversationUrl: string;
  userTurnId?: string;
  userMessageId?: string;
}

export interface ChatReadbackCandidate {
  messageIndex: number;
  rawText: string;
  turnId?: string;
  messageId?: string;
}

export interface ChatReadbackResult {
  generationStarted: boolean;
  inputCleared: boolean;
  messageCount: number;
  promptPublished: boolean;
  replyText: string;
  replyRawText: string;
  generating: boolean;
  association?: 'full_prompt' | 'recorded_turn' | 'request_envelope';
  userTurnId?: string;
  userMessageId?: string;
  assistantTurnId?: string;
  assistantMessageId?: string;
  reason?: 'context_changed' | 'user_ambiguous' | 'reply_ambiguous' | 'reply_identity_mismatch' | 'prompt_unmatched';
  /** 归属不明的可见回复单独保留，不冒充已收取／已采用。 */
  candidates: ChatReadbackCandidate[];
}

/** 仅解析当前 Studio 的明确任务声明；不从助手回显反推本次任务。 */
export function chatRequestIdentity(prompt: string): { requestId: string; targetIds: string[] } | undefined {
  const taskSection = prompt.split('【当前事实与本次附件】')[0];
  const matches = [...taskSection.matchAll(/【本次任务】\s*本次请求\s+([^\s；]+)\s*；\s*目标\s*ID\s*集合\s*(\[[^\n]*?\])\s*。/g)];
  if (matches.length !== 1) return undefined;
  try {
    const ids: unknown = JSON.parse(matches[0][2]);
    if (!Array.isArray(ids) || !ids.length || ids.some((id: unknown): boolean => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return undefined;
    return { requestId: matches[0][1], targetIds: ids as string[] };
  } catch { return undefined; }
}

function sameTargetIds(left: unknown, right: string[]): boolean {
  return Array.isArray(left) && left.every((id: unknown): boolean => typeof id === 'string') && new Set(left).size === left.length
    && [...left].sort().join('\n') === [...right].sort().join('\n');
}

function codeJson(text: string): unknown {
  const unwrapped = text.match(/^(`{3,})json\s*\n([\s\S]*?)\n\1\s*$/);
  try { return JSON.parse(unwrapped ? unwrapped[2] : text); } catch { return undefined; }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null || Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value: unknown, index: number): boolean => sameJsonValue(value, right[index]));
  const a = left as Record<string, unknown>; const b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key: string): boolean => Object.hasOwn(b, key) && sameJsonValue(a[key], b[key]));
}

/** 旧任务缺少已记录消息 ID 时，至少证明完整事实 JSON、任务声明及确定的首轮顺序。 */
function requestEnvelopeMatches(message: ChatPageSnapshot['messages'][number], prompt: string): boolean {
  if (!message.turnId && !message.messageId || !message.fencedCode?.length) return false;
  const expected = chatRequestIdentity(prompt);
  const identities = [message.rawText, message.renderedSource].filter((text): text is string => text !== undefined).map(chatRequestIdentity);
  if (!expected || !identities.some((identity): boolean => !!identity && identity.requestId === expected.requestId && sameTargetIds(identity.targetIds, expected.targetIds))) return false;
  const facts = prompt.match(/【当前事实与本次附件】\s*\n(`{3,})json\n([\s\S]*?)\n\1(?=\n|$)/);
  if (!facts) return false;
  const expectedFacts = codeJson(facts[2]);
  if (typeof expectedFacts !== 'object' || expectedFacts === null) return false;
  const observed = message.fencedCode.filter((block): boolean => block.language === 'json' || block.language === '')
    .map((block): unknown => codeJson(block.text));
  return observed.filter((value: unknown): boolean => value !== undefined && sameJsonValue(value, expectedFacts)).length === 1;
}

function trustedReadbackContext(context: ChatReadbackContext): boolean {
  return !!context.taskId && !!context.runId && context.runId === context.currentRunId && !!context.accountId && context.accountId === context.currentAccountId
    && isSameDoubaoConversation(context.conversationUrl, context.currentConversationUrl);
}

interface JsonDisplayMask { boundaries: Set<number>; whitespace: Set<number> }

/** 只定位正式结构数据，不能把普通台词或正文中的空格当成可删版式。 */
function structuredJsonSpan(source: string): { start: number; end: number } | undefined {
  const marker = '【当前事实与本次附件】'; const at = source.indexOf(marker);
  let start = at < 0 ? 0 : at + marker.length;
  let end = at < 0 ? source.length : source.lastIndexOf('\n\n【结果约定】');
  if (end < start) return undefined;
  while (/\s/.test(source[start] || '') && start < end) start++;
  while (/\s/.test(source[end - 1] || '') && end > start) end--;
  const fence = source.slice(start, end).match(/^(`{3,})json\s*\n([\s\S]*?)\n\1\s*$/);
  if (fence) { start += fence[0].indexOf('\n') + 1; end = start + fence[2].length; }
  try {
    const parsed: unknown = JSON.parse(source.slice(start, end));
    return typeof parsed === 'object' && parsed !== null ? { start, end } : undefined;
  } catch { return undefined; }
}

/** 在合法 JSON 的语法边界标记可变空白；字符串内逐字保留。 */
function jsonDisplayMask(source: string, depth: number = 0): JsonDisplayMask {
  const mask: JsonDisplayMask = { boundaries: new Set(), whitespace: new Set() };
  const span = structuredJsonSpan(source); if (!span || depth > 3) return mask;
  mask.boundaries.add(span.start); mask.boundaries.add(span.end);
  let latestKey = '';
  for (let index = span.start; index < span.end;) {
    const character = source[index];
    if (/\s/.test(character)) { mask.boundaries.add(index); mask.whitespace.add(index++); continue; }
    if (character !== '"') {
      if ('{}[],:'.includes(character)) { mask.boundaries.add(index); mask.boundaries.add(index + 1); }
      index++; continue;
    }
    const start = index++; const positions: { start: number; end: number }[] = [];
    while (index < span.end && source[index] !== '"') {
      const from = index; index += source[index] === '\\' ? source[index + 1] === 'u' ? 6 : 2 : 1;
      positions.push({ start: from, end: index });
    }
    const end = ++index; mask.boundaries.add(start); mask.boundaries.add(end);
    const value = JSON.parse(source.slice(start, end)) as string;
    let next = end; while (/\s/.test(source[next] || '') && next < span.end) next++;
    if (source[next] === ':') { latestKey = value; continue; }
    // 只递归宿主已经明确作为原请求／回复传入的 JSON 文本，不解释一般创作字符串。
    if (!['originalRequest', 'originalReply', 'rawForFormatRepairOnly'].includes(latestKey)) continue;
    const nested = jsonDisplayMask(value, depth + 1);
    for (const boundary of nested.boundaries) mask.boundaries.add(boundary < positions.length ? positions[boundary].start : end - 1);
    for (const whitespace of nested.whitespace) {
      const position = positions[whitespace]; if (!position) continue;
      // 转义的 \\n／\\t 仍逐字比较；仅允许其后的排版间距变化。
      for (let offset = position.start; offset < position.end; offset++) if (/\s/.test(source[offset])) mask.whitespace.add(offset);
      mask.boundaries.add(position.end);
    }
  }
  return mask;
}

/** 旧版未围栏事实：按可信原请求词法证明 JSON 语法空白，而非删除全部空白。 */
function legacyRenderedRequestMatches(message: ChatPageSnapshot['messages'][number], prompt: string): boolean {
  if (!message.renderedSource || message.codeSpans || !message.turnId && !message.messageId) return false;
  const identity = chatRequestIdentity(prompt); const observedIdentity = chatRequestIdentity(message.renderedSource);
  if (!identity || observedIdentity?.requestId !== identity.requestId || !sameTargetIds(observedIdentity.targetIds, identity.targetIds)) return false;
  const mask = jsonDisplayMask(prompt); if (!mask.boundaries.size || prompt.includes('\uE000')) return false;
  let expected = '';
  for (let index = 0; index <= prompt.length; index++) {
    if (mask.boundaries.has(index)) expected += '\uE000';
    if (index < prompt.length && !mask.whitespace.has(index)) expected += prompt[index];
  }
  // 一次标准 Markdown ASCII 标点转义消费；不处理 \\n、\\t 或任意正文内容。
  expected = expected.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1');
  const normalizeDisplay = (value: string): string => normalizePublishedChatPrompt(value)
    .replace(/(?<=[+−×÷=])\s+(?=\d)|(?<=\d)\s+(?=[+−×÷=])/gu, '')
    .replace(/(?<=[\p{Script=Han}\p{Script=Latin}_])\s*\/\s*(?=[\p{Script=Han}\p{Script=Latin}_])/gu, '/')
    .replace(/(:\s*(?:string|number|boolean|unknown|never|object))\s+(?=\[\])/g, '$1');
  const pattern = normalizeDisplay(expected).split(/\uE000+/).map((part: string): string => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  return new RegExp('^' + pattern + '$', 'u').test(normalizeDisplay(message.renderedSource));
}

function findOriginalChatUser(fresh: ChatPageSnapshot['messages'], prompt: string, baselineMessageCount: number, context?: ChatReadbackContext): {
  user?: ChatPageSnapshot['messages'][number]; association?: ChatReadbackResult['association']; reason?: ChatReadbackResult['reason'];
} {
  const users = fresh.filter((item): boolean => item.role === 'user');
  if (context && (context.userTurnId || context.userMessageId)) {
    const matches = users.filter((item): boolean => (!context.userTurnId || item.turnId === context.userTurnId)
      && (!context.userMessageId || item.messageId === context.userMessageId));
    return matches.length === 1 ? { user: matches[0], association: 'recorded_turn' } : { reason: 'user_ambiguous' };
  }
  if (users.length === 1 && publishedPromptMatches(users[0], prompt)) return { user: users[0], association: 'full_prompt' };
  if (context && baselineMessageCount === 0 && users.length === 1 && fresh[0] === users[0] && legacyRenderedRequestMatches(users[0], prompt)) return { user: users[0], association: 'full_prompt' };
  if (context && baselineMessageCount === 0 && users.length === 1 && fresh[0] === users[0] && requestEnvelopeMatches(users[0], prompt)) {
    // 旧版每次都创建空白普通 Chat；事实 JSON 来自真实 CODE，不能仅凭 requestId 放行。
    return { user: users[0], association: 'request_envelope' };
  }
  return { reason: users.length > 1 ? 'user_ambiguous' : 'prompt_unmatched' };
}

/** 基线在发送前取得；即使回复在首次回读前完成，也不会被吞进基线。 */
export function inspectChatReadback(
  snapshot: ChatPageSnapshot,
  prompt: string,
  baselineMessageCount: number,
  context?: ChatReadbackContext,
): ChatReadbackResult {
  const normalize = normalizePublishedChatPrompt;
  const fresh = snapshot.messages.slice(baselineMessageCount);
  const result: ChatReadbackResult = { generationStarted: false, inputCleared: snapshot.editorPresent && normalize(snapshot.editorText) === '', messageCount: snapshot.messages.length,
    promptPublished: false, replyRawText: '', replyText: '', generating: snapshot.generating,
    candidates: fresh.flatMap((item, index): ChatReadbackCandidate[] => item.role === 'assistant'
      ? [{ messageIndex: index + baselineMessageCount, rawText: item.rawText ?? item.text, ...(item.turnId ? { turnId: item.turnId } : {}), ...(item.messageId ? { messageId: item.messageId } : {}) }] : []) };
  if (context && !trustedReadbackContext(context)) return { ...result, reason: 'context_changed' };
  const { user, association, reason } = findOriginalChatUser(fresh, prompt, baselineMessageCount, context);
  if (!user) return { ...result, reason };
  const userIndex = fresh.indexOf(user);
  const nextUserIndex = fresh.findIndex((item, index): boolean => index > userIndex && item.role === 'user');
  const replies = fresh.slice(userIndex + 1, nextUserIndex === -1 ? undefined : nextUserIndex).filter((item): boolean => item.role === 'assistant');
  const candidates = replies.map((reply): ChatReadbackCandidate => ({ messageIndex: snapshot.messages.indexOf(reply), rawText: reply.rawText ?? reply.text,
    ...(reply.turnId ? { turnId: reply.turnId } : {}), ...(reply.messageId ? { messageId: reply.messageId } : {}) }));
  const identity = chatRequestIdentity(prompt);
  const reply = replies.length === 1 ? replies[0] : undefined;
  const raw = reply?.rawText ?? reply?.text ?? '';
  const parsed = codeJson(raw.trim());
  const replyEnvelope = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined;
  const replyMismatch = !!identity && !!replyEnvelope && (Object.hasOwn(replyEnvelope, 'requestId') || Object.hasOwn(replyEnvelope, 'targetIds'))
    && (replyEnvelope.requestId !== identity.requestId || !sameTargetIds(replyEnvelope.targetIds, identity.targetIds));
  // 已确定的原轮次回复即使不是合法 JSON 也保留；内容校验及采用由项目服务独立完成。
  return {
    ...result, generationStarted: true, promptPublished: true, association,
    userTurnId: user.turnId, userMessageId: user.messageId, candidates,
    ...(reply ? { assistantTurnId: reply.turnId, assistantMessageId: reply.messageId } : {}),
    ...(replies.length > 1 ? { reason: 'reply_ambiguous' as const } : replyMismatch ? { reason: 'reply_identity_mismatch' as const } : {}),
    replyRawText: reply && !replyMismatch ? raw : '', replyText: reply && !replyMismatch ? reply.text : '',
  };
}

export interface CreationReadbackResult extends ChatReadbackResult {
  confirmationPublished: boolean;
  /** 原消息在当前快照中的位置；仅用于本次只读定位，不能跨刷新持久化元素下标。 */
  originalMessageIndex?: number;
  /** 只属于原请求直接回复轮次的助手消息，不把后续聊天的回复冒充原产物。 */
  originalAssistantMessageIndices?: number[];
  followupUserMessageIndices?: number[];
  /** 原助手明确提出参数确认后的有界续接助手；仍须核实真实视频卡身份。 */
  generationContinuationMessageIndices?: number[];
}

/** 单个用户轮次内只沿已证明的消息父链前进；工具产物可以回复本轮助手，不能跨轮或猜测未知 ID。 */
function associatedAssistantIndices(messages: ChatPageSnapshot['messages'], start: number, end: number): number[] {
  const uniqueId = (id: string | undefined): id is string => !!id && messages.filter((message: ChatPageSnapshot['messages'][number]): boolean => message.messageId === id).length === 1;
  const anchors = new Set<string>(); const originId = messages[start].messageId;
  if (uniqueId(originId)) anchors.add(originId);
  const indices: number[] = [];
  for (let index = start + 1; index < end; index++) {
    const message = messages[index];
    if (message.role !== 'assistant' || message.replyId && !anchors.has(message.replyId)) continue;
    indices.push(index);
    if (uniqueId(message.messageId)) anchors.add(message.messageId);
  }
  return indices;
}

/** 只识别整个短句的原请求确认、状态询问和原样重试；不能凭生成关键词接纳新创作要求。 */
function continuesOriginalVideoRequest(value: string): boolean {
  const text = normalizePublishedChatPrompt(value).replace(/[。.!！?？]+$/u, '');
  if (!text || text.length > 100) return false;
  if (/^(?:确认|开始|开始生成|继续生成|按原要求开始生成)$/.test(text)) return true;
  if (/^(?:好|好的),?按(?:上面|原要求)(?:来|生成)$/.test(text)) return true;
  if (/^(?:(?:按原(?:请求|要求))?(?:重发|重试|再试|重新发)一次|按原(?:请求|要求)重新生成一次)$/.test(text)) return true;
  const status = [
    /^(?:视频)?(?:正在|在|还在|现在在|现在还在|目前在)生成(?:视频)?(?:吗|了吗)$/,
    /^(?:视频)?(?:正在|在|还在|现在在|现在还在|目前在)排队(?:中)?吗$/,
    /^开始生成(?:了)?吗$/,
    /^还要排多久(?:的)?队$/,
    /^(?:视频)?排队(?:还要|需要|要)?多久(?:了|啊|呢|吗)?$/,
    /^还(?:要|需要)等多久$/,
    /^视频(?:生成|做好|生成好|生成完|生成完成)了吗$/,
    /^视频(?:好了|生成好了|生成完了)吗$/,
    /^(?:为什么|怎么)(?:视频)?(?:生成好了|已经生成好了)(?:但|却)我?(?:看不到|没看到)$/,
  ];
  if (status.some((pattern: RegExp): boolean => pattern.test(text))) return true;
  // 只允许时钟表达说明等待时间；秒数、比例、模型、素材或额外创作句均不匹配。
  const clock = '(?:[01]?\\d|2[0-3])(?:点(?:[0-5]?\\d分?)?|:[0-5]\\d)';
  return new RegExp('^我?' + clock + '确认,现在已经' + clock + '了,还没给我视频,(?:这正常吗|正常吗|还要多久)$').test(text);
}

function generationContinuationIndices(messages: ChatPageSnapshot['messages'], originalReplies: number[], followups: number[], recorded: boolean): number[] {
  const terminal = (index: number): boolean => messages[index].role === 'assistant' && (messages[index].videoReady === true
    || /(?:^|[。！!？?\n])\s*(?:你的视频|视频)(?:已经|已)?(?:生成好了|生成完成|生成成功|完成生成)(?:[。！!，,]|$)/.test(messages[index].text));
  if (originalReplies.some(terminal)) return [];
  if (!recorded || !followups.length || !originalReplies.some((index: number): boolean => classifyGenerationConfirmationText(messages[index].text).state === 'present')) return [];
  const candidates: number[] = [];
  for (let turn = 0; turn < followups.length; turn++) {
    const start = followups[turn]; const end = followups[turn + 1] ?? messages.length;
    if (messages[start].hasAttachments || !continuesOriginalVideoRequest(messages[start].text)) break;
    const previous = turn === 0 ? originalReplies[0] : followups[turn - 1];
    if (messages.some((message: ChatPageSnapshot['messages'][number], index: number): boolean => index > previous && index < end && message.role === 'user' && !!(message.attachmentOnly || message.hasAttachments))) break;
    // 工具产物可以指回同轮已关联助手；整会话 union ID 或其它用户轮次不能成为父链依据。
    const associated = associatedAssistantIndices(messages, start, end);
    // 搜索等独立助手子链不进入本轮候选，也不使后续合法的原请求状态询问失去归属。
    // 合法状态询问中出现闲聊或搜索不会改变原请求归属；续接依据始终来自用户完整短句。
    candidates.push(...associated);
    if (associated.some(terminal)) break;
  }
  return candidates;
}

/** 已提交视频按原消息身份回读；后续手机/桌面聊天不改变原请求是否已发布这一事实。 */
function inspectOriginalVideoReadback(
  snapshot: ChatPageSnapshot,
  messages: ChatPageSnapshot['messages'],
  prompt: string,
  baselineMessageCount: number,
  confirmationRecorded: boolean,
  context: ChatReadbackContext,
): CreationReadbackResult {
  const initial = inspectChatReadback({ ...snapshot, messages }, prompt, baselineMessageCount, context);
  if (!trustedReadbackContext(context)) return { ...initial, confirmationPublished: false };
  // 现场 union_message 的 data-target-id 可能属于整会话，不能单独冒充原用户消息 ID。
  const recorded = !!context.userMessageId;
  const matches = messages.flatMap((message: ChatPageSnapshot['messages'][number], index: number): number[] => {
    if (index < baselineMessageCount || message.role !== 'user' || message.attachmentOnly) return [];
    const matched = recorded
      ? message.messageId === context.userMessageId
      : publishedPromptMatches(message, prompt);
    return matched ? [index] : [];
  });
  if (matches.length !== 1) return { ...initial, promptPublished: false, confirmationPublished: false,
    reason: recorded || matches.length > 1 ? 'user_ambiguous' : 'prompt_unmatched' };
  const originalMessageIndex = matches[0];
  const followupUserMessageIndices = messages.flatMap((message: ChatPageSnapshot['messages'][number], index: number): number[] => index > originalMessageIndex
    && message.role === 'user' && !message.attachmentOnly ? [index] : []);
  const end = followupUserMessageIndices[0] ?? messages.length;
  const originalAssistantMessageIndices = associatedAssistantIndices(messages, originalMessageIndex, end);
  // 只缩小原轮次回复的读取范围；不删除、改写或否定平台上的后续交互。
  const readback = inspectChatReadback({ ...snapshot, messages: messages.slice(originalMessageIndex, end) }, prompt, 0, { ...context, userTurnId: undefined });
  const confirmationPublished = confirmationRecorded && followupUserMessageIndices.length > 0
    && normalizePublishedChatPrompt(messages[followupUserMessageIndices[0]].text) === '确认';
  return { ...readback, messageCount: snapshot.messages.length, confirmationPublished, originalMessageIndex,
    originalAssistantMessageIndices, followupUserMessageIndices,
    generationContinuationMessageIndices: generationContinuationIndices(messages, originalAssistantMessageIndices, followupUserMessageIndices, confirmationRecorded),
    candidates: readback.candidates.map((candidate: ChatReadbackCandidate): ChatReadbackCandidate => ({ ...candidate, messageIndex: candidate.messageIndex + originalMessageIndex })) };
}

function creationReadbackMessages(
  snapshot: ChatPageSnapshot,
  prompt: string,
  mode: 'image' | 'video',
  videoConfig?: { aspectRatio: string; duration: string },
): ChatPageSnapshot['messages'] {
  return snapshot.messages.map((message: ChatPageSnapshot['messages'][number]): ChatPageSnapshot['messages'][number] => {
    if (message.role !== 'user' || publishedPromptMatches(message, prompt) || (mode === 'video' && !videoConfig)) return message;
    const text = normalizePublishedChatPrompt(message.text);
    const prefix = mode === 'image' ? '生成图片:' : '生成视频:';
    const parameters = mode === 'video' && videoConfig ? `,${videoConfig.aspectRatio},${videoConfig.duration}` : '';
    // 实页的视频创作回执可在原比例／时长后固定附加 720p；只接受这两种完整外壳。
    const suffix = parameters ? [parameters, `${parameters},720p`].find((value: string): boolean => text.endsWith(value)) : '';
    if (!text.startsWith(prefix) || suffix === undefined) return message;
    const candidate = { ...message, text: text.slice(prefix.length, suffix ? -suffix.length : undefined) };
    return publishedPromptMatches(candidate, prompt) ? candidate : message;
  });
}

/** 仅输出数量、长度与比较结果，避免把提示词、图片地址、会话地址或人物名写入日志。 */
export function diagnoseCreationReadback(snapshot: ChatPageSnapshot, prompt: string, mode: 'image' | 'video',
  videoConfig?: { aspectRatio: string; duration: string }, context?: ChatReadbackContext): object {
  const projected = creationReadbackMessages(snapshot, prompt, mode, videoConfig);
  const outcome = inspectCreationReadback(snapshot, prompt, mode, 0, videoConfig, false, context);
  return { ...diagnoseChatReadback({ ...snapshot, messages: projected }, prompt), reason: outcome.reason, promptPublished: outcome.promptPublished,
    historyComplete: snapshot.historyComplete === true, contextCurrent: context ? trustedReadbackContext(context) : undefined,
    inputs: snapshot.messages.map((message: ChatPageSnapshot['messages'][number], index: number): object => ({ role: message.role, attachmentOnly: !!message.attachmentOnly,
      textLength: message.text.length, rawLength: message.rawText?.length, formattedLength: message.renderedSource?.length,
      hasMessageId: !!message.messageId, hasTurnId: !!message.turnId, projectedLength: projected[index].text.length,
      fullPromptMatches: publishedPromptMatches(projected[index], prompt),
      ...(message.role === 'user' ? { comparison: diagnoseChatReadback({ ...snapshot, messages: [projected[index]] }, prompt) } : {}) })) };
}

/** 消息父链诊断只返回本次快照的顺序关系，不暴露消息 ID、会话地址、正文或图片地址。 */
export function diagnoseVideoMessageChain(snapshot: ChatPageSnapshot, prompt: string, videoConfig: { aspectRatio: string; duration: string } | undefined,
  confirmationRecorded: boolean, context: ChatReadbackContext): object {
  const readback = inspectCreationReadback(snapshot, prompt, 'video', 0, videoConfig, confirmationRecorded, context);
  return { promptPublished: readback.promptPublished, reason: readback.reason, historyComplete: snapshot.historyComplete === true, confirmationRecorded,
    originalMessageIndex: readback.originalMessageIndex, originalAssistantMessageIndices: readback.originalAssistantMessageIndices,
    followupUserMessageIndices: readback.followupUserMessageIndices, generationContinuationMessageIndices: readback.generationContinuationMessageIndices,
    messages: snapshot.messages.map((message: ChatPageSnapshot['messages'][number], index: number): object => ({ index, role: message.role,
      textLength: message.text.length, attachmentOnly: !!message.attachmentOnly, hasAttachments: !!message.hasAttachments, videoReady: !!message.videoReady, hasMessageId: !!message.messageId,
      messageIdUnique: !!message.messageId && snapshot.messages.filter((item: ChatPageSnapshot['messages'][number]): boolean => item.messageId === message.messageId).length === 1,
      hasReplyId: !!message.replyId, replyTargetIndices: message.replyId ? snapshot.messages.flatMap((item: ChatPageSnapshot['messages'][number], target: number): number[] => item.messageId === message.replyId ? [target] : []) : [],
      parameterConfirmation: message.role === 'assistant' && classifyGenerationConfirmationText(message.text).state === 'present' })) };
}

/** 创作入口会封装已发布消息；发送回执默认严格，已受理视频只读恢复可另传正式任务上下文。 */
export function inspectCreationReadback(
  snapshot: ChatPageSnapshot,
  prompt: string,
  mode: 'image' | 'video',
  baselineMessageCount: number,
  videoConfig?: { aspectRatio: string; duration: string },
  confirmationRecorded: boolean = false,
  context?: ChatReadbackContext,
): CreationReadbackResult {
  const messages = creationReadbackMessages(snapshot, prompt, mode, videoConfig);
  if (mode === 'video' && context) return inspectOriginalVideoReadback(snapshot, messages, prompt, baselineMessageCount, confirmationRecorded, context);
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

/**
 * 已提交图片的只读恢复：定位唯一原全文或已保存的服务器消息，不能要求整段历史只有一条用户消息。
 * 与发送前回执分开；所有后发用户消息（含空消息／新附件）均截止原回复区间，不推定续接。
 */
export function inspectSubmittedImageReadback(
  snapshot: ChatPageSnapshot,
  prompt: string,
  context: ChatReadbackContext,
): CreationReadbackResult {
  const initial = inspectCreationReadback(snapshot, prompt, 'image', 0);
  if (!trustedReadbackContext(context)) return { ...initial, promptPublished: false, confirmationPublished: false, reason: 'context_changed' };
  const messages = creationReadbackMessages(snapshot, prompt, 'image');
  const matches = messages.flatMap((message: ChatPageSnapshot['messages'][number], index: number): number[] => {
    if (message.role !== 'user' || message.attachmentOnly || context.userMessageId && message.messageId !== context.userMessageId) return [];
    return publishedPromptMatches(message, prompt) ? [index] : [];
  });
  if (matches.length !== 1) return { ...initial, promptPublished: false, confirmationPublished: false,
    reason: context.userMessageId || matches.length > 1 ? 'user_ambiguous' : 'prompt_unmatched' };
  const originalMessageIndex = matches[0]; const user = messages[originalMessageIndex];
  // 真实服务器 ID 必须在本快照唯一；共享 union turnId 不能代替消息身份。
  if (user.messageId && messages.filter((message: ChatPageSnapshot['messages'][number]): boolean => message.messageId === user.messageId).length !== 1) {
    return { ...initial, promptPublished: false, confirmationPublished: false, reason: 'user_ambiguous' };
  }
  const followupUserMessageIndices = messages.flatMap((message: ChatPageSnapshot['messages'][number], index: number): number[] =>
    index > originalMessageIndex && message.role === 'user' ? [index] : []);
  const originalAssistantMessageIndices = associatedAssistantIndices(messages, originalMessageIndex, followupUserMessageIndices[0] ?? messages.length);
  const selected = [originalMessageIndex, ...originalAssistantMessageIndices];
  const evidence = inspectChatReadback({ ...snapshot, messages: selected.map((index: number): ChatPageSnapshot['messages'][number] => messages[index]) }, prompt, 0,
    { ...context, userTurnId: undefined, userMessageId: user.messageId });
  return { ...evidence, confirmationPublished: false, messageCount: snapshot.messages.length, originalMessageIndex, originalAssistantMessageIndices,
    followupUserMessageIndices, generationContinuationMessageIndices: [],
    candidates: evidence.candidates.map((candidate: ChatReadbackCandidate): ChatReadbackCandidate => ({ ...candidate, messageIndex: selected[candidate.messageIndex] })) };
}
