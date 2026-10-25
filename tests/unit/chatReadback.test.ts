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

  it('rejects a different user prompt and a mixed conversation', (): void => {
    expect(inspectChatReadback(page([{ role: 'user', text: 'other' }, answer]), prompt, 0).replyText).toBe('');
    expect(inspectChatReadback(page([sent, answer, sent, answer]), prompt, 0).replyText).toBe('');
  });

  it('does not infer success from missing editor, ambiguous replies or a live generation', (): void => {
    expect(inspectChatReadback(page([sent, answer], { editorPresent: false }), prompt, 0).inputCleared).toBe(false);
    expect(inspectChatReadback(page([sent, answer, answer]), prompt, 0).replyText).toBe('');
    expect(inspectChatReadback(page([sent, answer], { generating: true }), prompt, 0).generating).toBe(true);
  });

  it('executes the actual serialized guest probe and excludes unrelated body content', async (): Promise<void> => {
    const messageNode = (role: string, text: string): object => ({
      getAttribute: (): string => role,
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
    const content = { tagName: 'DIV', textContent: '测试正文' + codeText,
      childNodes: [{ tagName: 'P', childNodes: [textNode('测试正文')] }, { tagName: 'PRE', querySelector: (): object => code, textContent: codeText }] };
    const message = { getAttribute: (): string => 'receive_message', querySelector: (): object => content };
    const document = { querySelectorAll: (selector: string): object[] => selector.startsWith('[data-testid="send_message"]') ? [message] : [] };
    const snapshot = await getChatPageSnapshot({ executeJavaScript: async (script: string): Promise<ChatPageSnapshot> => runInNewContext(script, { document }) as ChatPageSnapshot,
      getURL: (): string => '', loadURL: (): void => {} });
    expect(snapshot.messages[0].rawText).toBe('测试正文\n\n```json\n' + codeText + '\n```');
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
      executeJavaScript: async (code: string): Promise<unknown> => code.includes('messages.push')
        ? page([]) : code.includes('var editor = null') ? { ok: true, reason: 'READY' } : true,
    }, 1000, true);
    expect(result.ok).toBe(true);
    expect(loadURL).not.toHaveBeenCalled();
  });

  it.each([page([sent, answer]), page([], { editorText: 'unsent draft' })])('preserves existing root messages or a draft', async (snapshot: ChatPageSnapshot): Promise<void> => {
    const loadURL = vi.fn();
    const result = await startNewConversation({
      loadURL, getURL: (): string => 'https://www.doubao.com/chat/',
      executeJavaScript: async (): Promise<ChatPageSnapshot> => snapshot,
    }, 1000, true);
    expect(result).toEqual({ ok: false, reason: 'SESSION_NOT_EMPTY' });
    expect(loadURL).not.toHaveBeenCalled();
  });

  it('still navigates out of a concrete old conversation before any new input', async (): Promise<void> => {
    const loadURL = vi.fn();
    await startNewConversation({
      loadURL, getURL: (): string => 'https://www.doubao.com/chat/old-conversation',
      executeJavaScript: async (code: string): Promise<unknown> => code.includes('var editor = null') ? { ok: false, reason: 'EDITOR_NOT_FOUND' } : true,
    }, 1000, true);
    expect(loadURL).toHaveBeenCalledOnce();
    expect(loadURL).toHaveBeenCalledWith('https://www.doubao.com/chat/');
  });
});
