import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { getChatPageSnapshot, inspectGenerationConfirmation, readStableChatAnswer, startNewConversation } from '../../src/utils/doubaoBridge';
import { vi } from 'vitest';
import { inspectChatReadback, inspectCreationReadback, type ChatPageSnapshot } from '../../src/utils/chatReadback';
import { evaluateTerminal, updateStableStreak } from '../../src/utils/realSendStateMachine';

const prompt = '请仅回复：测试标记';
const sent: ChatPageSnapshot['messages'][number] = { role: 'user', text: prompt };
const answer: ChatPageSnapshot['messages'][number] = { role: 'assistant', text: '测试标记' };
const page = (messages: ChatPageSnapshot['messages'], patch: Partial<ChatPageSnapshot> = {}): ChatPageSnapshot => ({
  messages, editorPresent: true, editorText: '', generating: false, ...patch,
});

describe('PetStory creation receipts', (): void => {
  it('associates an attachment block with the original turn while allowing its one recorded confirmation', (): void => {
    const config = { aspectRatio: '9:16', duration: '5s' };
    const original = { role: 'user' as const, text: `生成视频：${prompt}，9:16，5s`, turnId: 'TEST-original' };
    const attachment = { role: 'user' as const, text: '', attachmentOnly: true, turnId: 'TEST-original' };
    const confirmation = { role: 'user' as const, text: '确认', turnId: 'TEST-confirmation' };
    expect(inspectCreationReadback(page([attachment, original, answer, confirmation, answer]), prompt, 'video', 0, config, true)).toMatchObject({ promptPublished: true, confirmationPublished: true });
    for (const turnId of [undefined, 'TEST-other']) {
      expect(inspectCreationReadback(page([{ ...attachment, turnId }, original, answer, confirmation, answer]), prompt, 'video', 0, config, true).promptPublished).toBe(false);
    }
  });
  it('accepts one exact confirmation only in a previously recorded video confirmation phase', (): void => {
    const config = { aspectRatio: '9:16', duration: '5s' };
    const original = { role: 'user' as const, text: `生成视频：${prompt}，9:16，5s` };
    const confirmed = page([original, answer, { role: 'user', text: '确认' }, answer]);
    expect(inspectCreationReadback(confirmed, prompt, 'video', 0, config, true).promptPublished).toBe(true);
    expect(inspectCreationReadback(confirmed, prompt, 'video', 0, config).promptPublished).toBe(false);
    expect(inspectCreationReadback(page([original, answer, { role: 'user', text: '确认，改为10秒' }]), prompt, 'video', 0, config, true).promptPublished).toBe(false);
  });
  it('does not keep treating an old parameter confirmation as active after a later user reply or generation receipt', async (): Promise<void> => {
    const confirmation = { role: 'assistant' as const, text: '视频生成参数确认：Seedance 2.0 Fast，时长5秒，比例9:16' };
    for (const messages of [[sent, confirmation, { role: 'user' as const, text: '确认' }], [sent, confirmation, { role: 'user' as const, text: '确认' }, { role: 'assistant' as const, text: '正在生成视频' }]]) {
      const view = { executeJavaScript: async (): Promise<ChatPageSnapshot> => page(messages), getURL: (): string => '', loadURL: (): void => {} };
      expect((await inspectGenerationConfirmation(view)).state).toBe('absent');
    }
  });
  it('matches a video wrapper only with the original exact duration and ratio', (): void => {
    const config = { aspectRatio: '9:16', duration: '5s' };
    const snapshot = page([{ role: 'user', text: `生成视频：${prompt}，9:16，5s` }, answer]);
    expect(inspectCreationReadback(snapshot, prompt, 'video', 0, config).promptPublished).toBe(true);
    for (const cfg of [undefined, { ...config, duration: '10s' }, { ...config, aspectRatio: '16:9' }]) {
      expect(inspectCreationReadback(snapshot, prompt, 'video', 0, cfg).promptPublished).toBe(false);
    }
    const changed = page([{ role: 'user', text: `生成视频：${prompt}，另加角色，9:16，5s` }, answer]);
    expect(inspectCreationReadback(changed, prompt, 'video', 0, config).promptPublished).toBe(false);
  });
  it('accepts the observed image wrapper only around a unique, exact published prompt', (): void => {
    const snapshot = page([{ role: 'user', text: `生成图片：${prompt}` }, answer]);
    expect(inspectCreationReadback(snapshot, prompt, 'image', 0).promptPublished).toBe(true);
    expect(inspectChatReadback(snapshot, prompt, 0).promptPublished).toBe(false);
    expect(inspectCreationReadback(snapshot, prompt, 'video', 0).promptPublished).toBe(false);
  });
  it('rejects extra instructions, repeated turns, unsent text and unrelated creation prefixes', (): void => {
    for (const text of [`生成图片：${prompt}，另加角色`, `生成视频：${prompt}`, `前文生成图片：${prompt}`]) {
      expect(inspectCreationReadback(page([{ role: 'user', text }, answer]), prompt, 'image', 0).promptPublished).toBe(false);
    }
    const message = { role: 'user' as const, text: `生成图片：${prompt}` };
    expect(inspectCreationReadback(page([message, answer, message, answer]), prompt, 'image', 0).promptPublished).toBe(false);
    expect(inspectCreationReadback(page([], { editorText: prompt }), prompt, 'image', 0).promptPublished).toBe(false);
    expect(inspectCreationReadback(page([message, answer]), prompt, 'image', 2).promptPublished).toBe(false);
  });
});

describe('ordinary Chat message-scoped readback', (): void => {
  it.each([{ width: 3, displayed: 3 }, { width: 9, displayed: 9 }, { width: 4, displayed: 3 }, { width: 9, displayed: 3 }])('matches the observed language-less PRE shell $width → $displayed while proving its inner body exactly', ({ width, displayed }: { width: number; displayed: number }): void => {
    const fence = '`'.repeat(width);
    const displayedFence = '`'.repeat(displayed);
    const code = JSON.stringify({ text: 'TEST原文\\n与\\"引号\\"', literal: 'red  car', order: 17 }, null, 2);
    const source = `规则完整。\n${fence}json\n${code}\n${fence}\n仅返回本目标。`;
    const echoedCode = `${displayedFence}json\n${code}\n\n${displayedFence}`;
    const renderedSource = '规则完整。\n```\n' + echoedCode + '\n```\n仅返回本目标。';
    const message = { role: 'user' as const, text: renderedSource, renderedSource, codeSpans: 1, fencedCode: [{ language: '', text: echoedCode }] };
    expect(inspectChatReadback(page([message, answer]), source, 0).promptPublished).toBe(true);
    for (const changed of [echoedCode.replace('17', '18'), echoedCode.replace('red  car', 'red car'), echoedCode.replace('\\n', 'n'), echoedCode.replace('json', 'text'), echoedCode + '\n追加要求']) {
      expect(inspectChatReadback(page([{ ...message, fencedCode: [{ language: '', text: changed }] }, answer]), source, 0).promptPublished).toBe(false);
    }
    expect(inspectChatReadback(page([{ ...message, renderedSource: renderedSource + '追加要求' }, answer]), source, 0).promptPublished).toBe(false);
  });
  it('maps dynamic code-fence shells only with PRE/CODE evidence and byte-preserved code content, never rewriting nested escapes', (): void => {
    const code = JSON.stringify({ request: 'TEST内嵌````````围栏', literal: 'red  car', nested: '{"quote":"\\"TEST\\"","line":"\\n"}' }, null, 2);
    const fence = '`'.repeat(9);
    const source = `规则完整。\n${fence}json\n${code}\n${fence}\n仅返回本目标。`;
    const renderedSource = `规则完整。\n\n\`\`\`json\n${code}\n\`\`\`\n仅返回本目标。`;
    const message = { role: 'user' as const, text: renderedSource, renderedSource, codeSpans: 1, fencedCode: [{ language: 'json', text: code + '\n' }] };
    expect(inspectChatReadback(page([message, answer]), source, 0).promptPublished).toBe(true);
    for (const changed of [code.replace('red  car', 'red car'), code.replace('\\n', 'n'), code.replace('TEST', 'OTHER'), code.replace('\n  ', '\n '), code.slice(0, -1), code + '\n\n']) {
      expect(inspectChatReadback(page([{ ...message, fencedCode: [{ language: 'json', text: changed }] }, answer]), source, 0).promptPublished).toBe(false);
    }
    for (const patch of [{ fencedCode: undefined }, { fencedCode: [{ language: 'text', text: code }] }, { fencedCode: [] }, { renderedSource: renderedSource + '追加要求' }]) {
      expect(inspectChatReadback(page([{ ...message, ...patch }, answer]), source, 0).promptPublished).toBe(false);
    }
  });
  it('matches observed Markdown consumption of escaped quotes only outside code, retaining literal escapes and the whole request', (): void => {
    const source = '1. 审查范围\n2. parentResult {"evidence":"候选正文:\\"TEST原文\\n完整内容\\";字段:17","literal":"red car\\t"}';
    const renderedSource = source.replace(/\\"/g, '"');
    const message = { role: 'user' as const, text: renderedSource, renderedSource };
    expect(inspectChatReadback(page([message, answer]), source, 0)).toMatchObject({ promptPublished: true, replyText: answer.text });
    for (const changed of [
      renderedSource.replace('17', '18'), renderedSource.replace('原文', '新文'), renderedSource.replace('red car', 'redcar'),
      renderedSource.replace('\\n', 'n'), renderedSource.replace('\\t', 't'), renderedSource.replace('正文:"', '正文:'),
      renderedSource.slice(0, -1), renderedSource + '追加指令',
    ]) expect(inspectChatReadback(page([{ ...message, text: changed, renderedSource: changed }, answer]), source, 0).promptPublished).toBe(false);
    for (const patch of [{ renderedSource: undefined }, { codeSpans: 1 }]) expect(inspectChatReadback(page([{ ...message, ...patch }, answer]), source, 0).promptPublished).toBe(false);
    const codeSource = '`TEST代码` ' + source;
    const codeRendered = '`TEST代码` ' + renderedSource;
    expect(inspectChatReadback(page([{ ...message, text: codeRendered, renderedSource: codeRendered }, answer]), codeSource, 0).promptPublished).toBe(false);
  });
  it('restores observed built-in array type spacing after a rendered inline code fence without changing schema or literal content', (): void => {
    const source = '1. 结构纠正\n2. 原结果 {"raw":"```json\\n{\\"test\\":17}\\n```"}\n3. 契约 [{aliases:string[],targetIds:string[],limit:17,label:"red car",literal:"string []"}]';
    const renderedSource = source.replace(/```/g, '`').replace(/:string\[\]/g, ':string []');
    const message = { role: 'user' as const, text: renderedSource, renderedSource, codeSpans: 1 };
    expect(inspectChatReadback(page([message, answer]), source, 0)).toMatchObject({ promptPublished: true, replyText: answer.text });
    for (const changed of [
      renderedSource.replace('test', 'other'), renderedSource.replace('limit:17', 'limit:18'),
      renderedSource.replace('red car', 'redcar'), renderedSource.replace(':string []', ':str ing []'),
      renderedSource.replace(':string []', ':number []'), renderedSource.replace(':string []', ':string [ ]'),
      renderedSource.replace('literal:"string []"', 'literal:"string[]"'), renderedSource.slice(0, -1), renderedSource + '追加要求',
    ]) expect(inspectChatReadback(page([{ ...message, text: changed, renderedSource: changed }, answer]), source, 0).promptPublished).toBe(false);
    for (const patch of [{ codeSpans: undefined }, { codeSpans: 2 }, { renderedSource: undefined }]) {
      expect(inspectChatReadback(page([{ ...message, ...patch }, answer]), source, 0).promptPublished).toBe(false);
    }
  });
  it('recovers paired triple delimiters rendered as inline CODE inside JSON while comparing the whole structured message', (): void => {
    const original = '1. 校验范围\n2. 数据 {"raw":"json\\n```json\\n{\\"body\\":\\"完整正文\\"}\\n```"}';
    const renderedSource = original.replace(/```/g, '`');
    const message = { role: 'user' as const, text: renderedSource, renderedSource, codeSpans: 1 };
    expect(inspectChatReadback(page([message, answer]), original, 0).promptPublished).toBe(true);
    for (const patch of [{ codeSpans: undefined }, { codeSpans: 2 }, { renderedSource: renderedSource.replace('完整正文', '短文') }, { renderedSource: renderedSource + '追加要求' }]) {
      expect(inspectChatReadback(page([{ ...message, ...patch }, answer]), original, 0).promptPublished).toBe(false);
    }
  });
  it('accepts observed slash typography only with rendered DOM evidence, preserving digits and word content', (): void => {
    const original = '1. 来源/ID/范围\n2. reuse / new_variant / unresolved\n3. red car，1/2';
    const renderedSource = '1. 来源/ ID /范围\n2. reuse/new_variant/unresolved\n3. red car，1/2';
    const message = { role: 'user' as const, text: renderedSource, renderedSource };
    const result = inspectChatReadback(page([message, answer]), original, 0);
    expect(result).toMatchObject({ promptPublished: true, replyText: answer.text });
    expect(inspectChatReadback(page([{ role: 'user', text: renderedSource }, answer]), original, 0).promptPublished).toBe(false);
    for (const wrong of [renderedSource.replace('1/2', '1 /2'), renderedSource.replace('new_variant', 'new_asset'), renderedSource.replace('red car', 'redcar'), renderedSource.slice(0, -1)]) {
      expect(inspectChatReadback(page([{ ...message, renderedSource: wrong, text: wrong }, answer]), original, 0).promptPublished).toBe(false);
    }
  });
  it('does not count a prompt still in the editor as submitted', (): void => {
    const result = inspectChatReadback(page([], { editorText: prompt }), prompt, 0);
    expect(result.promptPublished).toBe(false);
    expect(result.inputCleared).toBe(false);
    expect(result.replyText).toBe('');
  });

  it('recognizes normalized published text without mistaking a user echo for an answer', (): void => {
    const result = inspectChatReadback(page([{ ...sent, text: '请仅回复:测试标记' }]), prompt, 0);
    expect(result.promptPublished).toBe(true);
    expect(result.replyText).toBe('');
  });
  it('matches published CJK typography but retains English word spacing, punctuation and role IDs', (): void => {
    const original = '普通Chat读取。Seedream · TEST，characters(角色)，role=main。说 "red car"。';
    const rendered = '普通 Chat 读取。Seedream・TEST，characters (角色)，role =main。说 "red car"。';
    expect(inspectChatReadback(page([{ role: 'user', text: rendered }, answer]), original, 0).promptPublished).toBe(true);
    for (const wrong of [rendered.replace('red car', 'redcar'), rendered.replace('main', 'supporting'), rendered.replace('。', '!')]) {
      expect(inspectChatReadback(page([{ role: 'user', text: wrong }, answer]), original, 0).promptPublished).toBe(false);
    }
  });

  it('retains a fast answer already present at the first readback', (): void => {
    const result = inspectChatReadback(page([sent, answer]), prompt, 0);
    expect(result.replyText).toBe(answer.text);
    expect(evaluateTerminal({ baselineText: '', currentText: result.replyText, networkFinished: false, messageCountDelta: 2, stableStreak: 0 })).toBe('waiting');
    let stable = updateStableStreak('', result.replyText, 0);
    stable = updateStableStreak(result.replyText, result.replyText, stable);
    stable = updateStableStreak(result.replyText, result.replyText, stable);
    expect(evaluateTerminal({ baselineText: '', currentText: result.replyText, networkFinished: false, messageCountDelta: 2, stableStreak: stable })).toBe('completed');
  });

  it('matches rendered paired code fences only with actual code evidence, retaining all content and punctuation', (): void => {
    const original = 'TEST repair data "```json\\n{\\"id\\":1}\\n```"';
    const rendered = original.replace(/```/g, '');
    expect(inspectChatReadback(page([{ role: 'user', text: rendered, codeSpans: 1 }, answer]), original, 0).promptPublished).toBe(true);
    for (const message of [
      { role: 'user' as const, text: rendered },
      { role: 'user' as const, text: rendered, codeSpans: 2 },
      { role: 'user' as const, text: rendered.replace(':1', ':2'), codeSpans: 1 },
    ]) expect(inspectChatReadback(page([message, answer]), original, 0).promptPublished).toBe(false);
    expect(inspectChatReadback(page([{ role: 'user', text: rendered, codeSpans: 1 }, answer]), original.replace('```json', 'json'), 0).promptPublished).toBe(false);
  });

  it('excludes all messages preceding the pre-send baseline', (): void => {
    const result = inspectChatReadback(page([sent, answer]), prompt, 2);
    expect(result.promptPublished).toBe(false);
    expect(result.replyText).toBe('');
  });

  it('matches rendered rule headings only with corresponding DOM evidence and unchanged full text', (): void => {
    const original = '规则如下：\n# Seedream · TEST\n保持角色身份。\n## 当前镜头\n完整静态时刻。';
    const rendered = original.replace(/^#{1,6}[\t ]+/gm, '');
    expect(inspectChatReadback(page([{ role: 'user', text: rendered, headingCount: 2 }, answer]), original, 0).promptPublished).toBe(true);
    expect(inspectChatReadback(page([{ role: 'user', text: rendered.replace('：\nSeedream', '：Seedream'), rawText: rendered, headingCount: 2 }, answer]), original, 0).promptPublished).toBe(true);
    for (const message of [
      { role: 'user' as const, text: rendered },
      { role: 'user' as const, text: rendered, headingCount: 1 },
      { role: 'user' as const, text: rendered.replace('静态', '动态'), headingCount: 2 },
      { role: 'user' as const, text: rendered.slice(0, -3), headingCount: 2 },
    ]) expect(inspectChatReadback(page([message, answer]), original, 0).promptPublished).toBe(false);
  });

  it('rejects a different user prompt and a mixed conversation', (): void => {
    expect(inspectChatReadback(page([{ role: 'user', text: 'other' }, answer]), prompt, 0).replyText).toBe('');
    expect(inspectChatReadback(page([sent, answer, sent, answer]), prompt, 0).replyText).toBe('');
  });

  it('reconstructs actual list DOM for full published-text matching, retaining numbers and rejecting edits', async (): Promise<void> => {
    const source = '规则：\n1. 保持 A 和 B 的身份。\n2. 保留数值 17 与台词。';
    type TestNode = { nodeType?: number; tagName?: string; textContent?: string; childNodes?: TestNode[]; parentElement?: TestNode; children?: TestNode[]; getAttribute?: (name: string) => string | null };
    const list: TestNode = { tagName: 'OL', children: [], getAttribute: (): null => null };
    const items = ['保持 A 和 B 的身份。', '保留数值 17 与台词。'].map((text): TestNode => ({ tagName: 'LI', childNodes: [{ nodeType: 3, textContent: text }], parentElement: list }));
    list.children = items; list.childNodes = items;
    const content = { tagName: 'DIV', textContent: '规则：保持 A 和 B 的身份。保留数值 17 与台词。', childNodes: [{ tagName: 'P', childNodes: [{ nodeType: 3, textContent: '规则：' }] }, list], querySelectorAll: (selector: string): object[] => selector.startsWith('ol,') ? [list] : [] };
    const user = { getAttribute: (): string => 'send_message', querySelector: (): object => content };
    const document = { querySelectorAll: (selector: string): object[] => selector.startsWith('[data-testid="send_message"]') ? [user] : [] };
    const view = { executeJavaScript: async (code: string): Promise<ChatPageSnapshot> => runInNewContext(code, { document }) as ChatPageSnapshot, getURL: (): string => '', loadURL: (): void => {} };
    const snapshot = await getChatPageSnapshot(view);
    expect(snapshot.messages[0].renderedSource).toContain('2. 保留数值 17 与台词。');
    expect(inspectChatReadback(snapshot, source, 0).promptPublished).toBe(true);
    expect(inspectChatReadback(snapshot, source.replace('17', '18'), 0).promptPublished).toBe(false);
    expect(inspectChatReadback(snapshot, source.replace('2.', '3.'), 0).promptPublished).toBe(false);
  });

  it('matches DOM typography around numeric operators without erasing operands, operators or internal spaces', (): void => {
    const source = '需要7张人物图+2张场景图=9张图；保留编号12。';
    const rendered = '需要 7 张人物图 + 2 张场景图 = 9 张图；保留编号 12。';
    const dom = { role: 'user' as const, text: rendered, renderedSource: rendered };
    expect(inspectChatReadback(page([dom, answer]), source, 0).promptPublished).toBe(true);
    expect(inspectChatReadback(page([{ role: 'user', text: rendered }, answer]), source, 0).promptPublished).toBe(false);
    for (const changed of [rendered.replace('2 张', '3 张'), rendered.replace('+', '−'), rendered.replace('12', '1 2'), rendered.slice(0, -3)]) {
      expect(inspectChatReadback(page([{ ...dom, renderedSource: changed, text: changed }, answer]), source, 0).promptPublished).toBe(false);
    }
  });

  it('does not infer success from missing editor, ambiguous replies or a live generation', (): void => {
    expect(inspectChatReadback(page([sent, answer], { editorPresent: false }), prompt, 0).inputCleared).toBe(false);
    expect(inspectChatReadback(page([sent, answer, answer]), prompt, 0).replyText).toBe('');
    expect(inspectChatReadback(page([sent, answer], { generating: true }), prompt, 0).generating).toBe(true);
  });

  it('executes the actual serialized guest probe and excludes unrelated body content', async (): Promise<void> => {
    const messageNode = (role: string, text: string): object => ({
      getAttribute: (name: string): string | null => name === 'data-testid' ? role : null,
      querySelector: (): object => ({ textContent: text }),
    });
    const doc = {
      body: { innerText: 'sidebar history script prompt fake answer' },
      querySelectorAll: (selector: string): object[] => {
        if (selector.startsWith('[data-testid="send_message"]')) return [messageNode('send_message', prompt), messageNode('receive_message', answer.text)];
        if (selector.startsWith('textarea')) return [{ tagName: 'TEXTAREA', value: '', offsetParent: {} }];
        return [];
      },
    };
    const snapshot = await getChatPageSnapshot({
      executeJavaScript: async (code: string): Promise<ChatPageSnapshot> => runInNewContext(code, { document: doc }) as ChatPageSnapshot,
      getURL: (): string => '', loadURL: (): void => {},
    });
    expect(snapshot.messages).toEqual([{ ...sent, text: prompt.normalize('NFKC'), rawText: prompt }, { ...answer, rawText: answer.text }]);
    expect(snapshot.editorPresent).toBe(true);
    expect(snapshot.generating).toBe(false);
  });

  it.each([true, false])('groups attachment-only blocks only with the unique text from the same turn (%s)', async (sameTurn: boolean): Promise<void> => {
    const text = { textContent: prompt };
    const turn = { getAttribute: (): null => null };
    const photo = { getAttribute: (): string => 'send_message', querySelector: (selector: string): object | null => selector === 'img' ? {} : null,
      closest: (): object | null => sameTurn ? turn : null };
    const user = { getAttribute: (): string => 'send_message', querySelector: (): object => text, closest: (): object => turn };
    const reply = { getAttribute: (): string => 'receive_message', querySelector: (): object => ({ textContent: answer.text }) };
    const doc = { querySelectorAll: (selector: string): object[] => selector.startsWith('[data-testid="send_message"]') ? [photo, user, reply] : [] };
    const snapshot = await getChatPageSnapshot({ executeJavaScript: async (script: string): Promise<ChatPageSnapshot> => runInNewContext(script, { document: doc }) as ChatPageSnapshot,
      getURL: (): string => '', loadURL: (): void => {} });
    expect(snapshot.messages).toHaveLength(sameTurn ? 2 : 3);
    expect(inspectChatReadback(snapshot, prompt, 0).promptPublished).toBe(sameTurn);
    expect(inspectChatReadback(snapshot, prompt, 0).replyText).toBe(sameTurn ? answer.text : '');
  });
  it.each([true, false])('matches separate photo/text wrappers only by a shared nonempty turn ID (%s)', async (sameId: boolean): Promise<void> => {
    const photo = { getAttribute: (): string => 'send_message', querySelector: (selector: string): object | null => selector === 'img' ? {} : null,
      closest: (): object => ({ getAttribute: (): string => 'TEST-turn-1' }) };
    const user = { getAttribute: (): string => 'send_message', querySelector: (): object => ({ textContent: prompt }),
      closest: (): object => ({ getAttribute: (): string => sameId ? 'TEST-turn-1' : 'TEST-turn-2' }) };
    const reply = { getAttribute: (): string => 'receive_message', querySelector: (): object => ({ textContent: answer.text }) };
    const doc = { querySelectorAll: (selector: string): object[] => selector.startsWith('[data-testid="send_message"]') ? [photo, user, reply] : [] };
    const snapshot = await getChatPageSnapshot({ executeJavaScript: async (script: string): Promise<ChatPageSnapshot> => runInNewContext(script, { document: doc }) as ChatPageSnapshot,
      getURL: (): string => '', loadURL: (): void => {} });
    expect(inspectChatReadback(snapshot, prompt, 0).promptPublished).toBe(sameId);
    expect(inspectChatReadback(snapshot, prompt, 0).replyText).toBe(sameId ? answer.text : '');
  });

  it('retains paragraphs and fenced code from the actual message node without normalizing raw content', async (): Promise<void> => {
    const codeText = '{\n  "test": "Ａ  B"\n}';
    const textNode = (text: string): object => ({ nodeType: 3, textContent: text });
    const code = { tagName: 'CODE', className: 'language-json', textContent: codeText };
    const pre = { tagName: 'PRE', querySelector: (): object => code, textContent: codeText };
    const content = { tagName: 'DIV', textContent: '测试正文' + codeText,
      childNodes: [{ tagName: 'P', childNodes: [textNode('测试正文')] }, pre], querySelectorAll: (selector: string): object[] => selector === 'code' ? [code] : selector.includes('pre') ? [pre] : [] };
    const message = { getAttribute: (): string => 'receive_message', querySelector: (): object => content };
    const document = { querySelectorAll: (selector: string): object[] => selector.startsWith('[data-testid="send_message"]') ? [message] : [] };
    const snapshot = await getChatPageSnapshot({ executeJavaScript: async (script: string): Promise<ChatPageSnapshot> => runInNewContext(script, { document }) as ChatPageSnapshot,
      getURL: (): string => '', loadURL: (): void => {} });
    expect(snapshot.messages[0].rawText).toBe('测试正文\n\n```json\n' + codeText + '\n```');
    expect(snapshot.messages[0].fencedCode).toEqual([{ language: 'json', text: codeText }]);
    expect(snapshot.messages[0].text).toContain('A B');
  });

  it.each(['', 'TEST unsent draft'])('recovers only a stable original Chat answer without touching draft %s', async (draft: string): Promise<void> => {
    vi.useFakeTimers();
    try {
      const raw = '离线测试\n```json\n{}\n```';
      const loadURL = vi.fn();
      const executeJavaScript = vi.fn(async (): Promise<ChatPageSnapshot> => page([sent, { ...answer, rawText: raw }], { editorText: draft }));
      const result = readStableChatAnswer({ executeJavaScript, getURL: (): string => 'https://www.doubao.com/chat/TEST', loadURL }, prompt, 'https://www.doubao.com/chat/TEST');
      await vi.advanceTimersByTimeAsync(3000);
      expect(await result).toBe(raw);
      expect(loadURL).not.toHaveBeenCalled();
      expect(executeJavaScript.mock.calls).toHaveLength(4);
      await expect(readStableChatAnswer({ executeJavaScript, getURL: (): string => 'https://www.doubao.com/chat/OTHER', loadURL }, prompt, 'https://www.doubao.com/chat/TEST')).rejects.toThrow('离开原会话');
    } finally { vi.useRealTimers(); }
  });

  it('reuses only an explicitly verified empty Chat root without reloading slow resources', async (): Promise<void> => {
    const loadURL = vi.fn();
    const result = await startNewConversation({
      loadURL, getURL: (): string => 'https://www.doubao.com/chat/',
      executeJavaScript: async (code: string): Promise<unknown> => code.includes('timeOrigin: performance.timeOrigin') ? { href: 'https://www.doubao.com/chat/', timeOrigin: 1, readyState: 'complete' }
        : code.includes('var newConversationDocument') ? { ok: true, reason: 'READY', stabilityKey: 'OFFLINE-stable' } : code.includes('messages.push')
          ? page([]) : code.includes('plainChatComposerProbe') ? { ok: true } : code.includes('var editor = null') ? { ok: true, reason: 'READY' } : true,
    }, 1000, true);
    expect(result.ok).toBe(true);
    expect(loadURL).not.toHaveBeenCalled();
  });

  it.each([page([sent, answer]), page([], { editorText: 'unsent draft' })])('preserves existing root messages or a draft', async (snapshot: ChatPageSnapshot): Promise<void> => {
    const loadURL = vi.fn();
    const result = await startNewConversation({
      loadURL, getURL: (): string => 'https://www.doubao.com/chat/',
      executeJavaScript: async (code: string): Promise<unknown> => code.includes('timeOrigin: performance.timeOrigin') ? { href: 'https://www.doubao.com/chat/', timeOrigin: 1, readyState: 'complete' } : snapshot,
    }, 1000, true);
    expect(result).toEqual({ ok: false, reason: 'SESSION_NOT_EMPTY' });
    expect(loadURL).not.toHaveBeenCalled();
  });

  it('still navigates out of a concrete old conversation before any new input', async (): Promise<void> => {
    let url = 'https://www.doubao.com/chat/old-conversation'; let timeOrigin = 1;
    const loadURL = vi.fn((next: string): void => { url = next; timeOrigin++; });
    await startNewConversation({
      loadURL, getURL: (): string => url,
      executeJavaScript: async (code: string): Promise<unknown> => code.includes('timeOrigin: performance.timeOrigin') ? { href: url, timeOrigin, readyState: 'complete' }
        : code.includes('var editor = null') ? { ok: false, reason: 'EDITOR_NOT_FOUND' } : true,
    }, 1000, true);
    expect(loadURL).toHaveBeenCalledOnce();
    expect(loadURL).toHaveBeenCalledWith('https://www.doubao.com/chat/');
  });
});
