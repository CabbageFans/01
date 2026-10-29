/** 离线技术状态回归：原五镜夹具只用于事实投影；模拟回复不代表豆包创作结果。 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { PetStoryProject } from '@doubao-studio/contracts';
import original from '../fixtures/drama-runtime-input.json';
import { buildDramaRequest } from '../../main/utils/petstoryRuntimeRequest';
import { chatRequestIdentity, inspectChatReadback } from '../../src/utils/chatReadback';
import type { ChatPageSnapshot, ChatReadbackContext } from '../../src/utils/chatReadback';
import { ChatReadbackRecoveryError, getChatPageSnapshot, readStableChatAnswer } from '../../src/utils/doubaoBridge';

const requestId = 'OFFLINE-readback-request';
const project = structuredClone(original) as unknown as PetStoryProject;
const request = buildDramaRequest(project, { kind: 'optimize', requestId, shotId: project.plan!.shots[0].id, promptKind: 'firstFrame' });
const targetIds = request.expectedIds;
const factsMatch = request.prompt.match(/【当前事实与本次附件】\s*\n(`{3,})json\n([\s\S]*?)\n\1(?=\n|$)/)!;
const factsText = factsMatch[2];
const header = `【本次任务】\n本次请求 ${requestId}；目标 ID 集合 ${JSON.stringify(targetIds)}。`;
const context: ChatReadbackContext = { taskId: 'OFFLINE-task', runId: 'OFFLINE-run', currentRunId: 'OFFLINE-run', accountId: 'OFFLINE-account', currentAccountId: 'OFFLINE-account',
  conversationUrl: 'https://www.doubao.com/chat/OFFLINE', currentConversationUrl: 'https://www.doubao.com/chat/OFFLINE' };
const rawReply = '```json\n' + JSON.stringify({ requestId, targetIds, optimized: 'OFFLINE: 协议回复占位，不作为创作正文。' }, null, 2) + '\n```';
const user: ChatPageSnapshot['messages'][number] = { role: 'user', turnId: 'OFFLINE-original-turn', rawText: header + '\n网页已渲染的完整事实块\n' + factsText,
  text: header, fencedCode: [{ language: 'json', text: factsText }], codeSpans: 1 };
const assistant: ChatPageSnapshot['messages'][number] = { role: 'assistant', turnId: 'OFFLINE-answer-turn', rawText: rawReply, text: 'OFFLINE: normalized display' };
function page(messages: ChatPageSnapshot['messages']): ChatPageSnapshot { return { messages, editorPresent: true, editorText: 'OFFLINE 未发送草稿', generating: false }; }

describe('F03 原任务只读恢复（离线）', (): void => {
  it('uses the original account, session, run, definite first turn and full DOM JSON facts when long Markdown rendering differs', (): void => {
    expect(inspectChatReadback(page([user, assistant]), request.prompt, 0).promptPublished).toBe(false);
    const result = inspectChatReadback(page([user, assistant]), request.prompt, 0, context);
    expect(result).toMatchObject({ promptPublished: true, association: 'request_envelope', userTurnId: user.turnId, assistantTurnId: assistant.turnId, replyRawText: rawReply });
    expect(result.inputCleared).toBe(false);
    expect(rawReply).toBe(assistant.rawText);
  });

  it('does not confuse quoted parent requests in repair facts with the current request identity', (): void => {
    const quoted = JSON.stringify({ originalRequest: request.prompt, originalReply: rawReply });
    expect(chatRequestIdentity(request.prompt + '\n```json\n' + quoted + '\n```')).toEqual({ requestId, targetIds });
    expect(chatRequestIdentity(header + '\n' + header)).toBeUndefined();
  });

  it.each([
    { currentRunId: 'OFFLINE-new-run' }, { currentAccountId: 'OFFLINE-other-account' }, { currentConversationUrl: 'https://www.doubao.com/chat/OTHER' },
    { runId: '' }, { taskId: '' },
  ])('rejects changed task context while retaining visible facts for review: %j', (changed: Partial<ChatReadbackContext>): void => {
    const result = inspectChatReadback(page([user, assistant]), request.prompt, 0, { ...context, ...changed });
    expect(result).toMatchObject({ promptPublished: false, replyRawText: '', reason: 'context_changed' });
    expect(result.candidates[0].rawText).toBe(rawReply);
  });

  it('rejects header-only, assistant-only, altered facts and target sets despite matching request IDs', (): void => {
    const facts = JSON.parse(factsText) as Record<string, unknown>;
    const candidates: ChatPageSnapshot['messages'][number][] = [
      { ...user, fencedCode: undefined }, { ...user, turnId: undefined },
      { ...user, rawText: user.rawText!.replace(requestId, 'OFFLINE-other-request') },
      { ...user, rawText: user.rawText!.replace(JSON.stringify(targetIds), '["OFFLINE-other-target"]') },
      { ...user, fencedCode: [{ language: 'json', text: JSON.stringify({ ...facts, mobileStory: 'OFFLINE changed source fact' }) }] },
      { ...user, rawText: 'OFFLINE unrelated user' },
    ];
    for (const changed of candidates) expect(inspectChatReadback(page([changed, assistant]), request.prompt, 0, context).replyRawText).toBe('');
    expect(inspectChatReadback(page([assistant]), request.prompt, 0, context).promptPublished).toBe(false);
    expect(inspectChatReadback(page([{ ...assistant, role: 'user' }, user, assistant]), request.prompt, 0, context).replyRawText).toBe('');
  });

  it('uses persisted turn identity and adjacency after reopening with later conversations present', (): void => {
    const laterUser = { ...user, turnId: 'OFFLINE-later-user' }; const laterReply = { ...assistant, turnId: 'OFFLINE-later-reply', rawText: 'OFFLINE unrelated response' };
    const snapshot = page([user, assistant, laterUser, laterReply]);
    expect(inspectChatReadback(snapshot, request.prompt, 0, context).replyRawText).toBe('');
    expect(inspectChatReadback(snapshot, request.prompt, 0, { ...context, userTurnId: user.turnId })).toMatchObject({ association: 'recorded_turn', replyRawText: rawReply });
    expect(inspectChatReadback(page([user, assistant, user, laterReply]), request.prompt, 0, { ...context, userTurnId: user.turnId }).reason).toBe('user_ambiguous');
  });

  it('preserves malformed content separately from association and refuses ambiguous or explicitly mismatched replies', (): void => {
    const malformed = 'OFFLINE {invalid JSON，原回复不修改';
    expect(inspectChatReadback(page([user, { ...assistant, rawText: malformed }]), request.prompt, 0, context)).toMatchObject({ promptPublished: true, replyRawText: malformed });
    const ambiguous = inspectChatReadback(page([user, assistant, { ...assistant, turnId: 'OFFLINE-candidate-2' }]), request.prompt, 0, context);
    expect(ambiguous).toMatchObject({ reason: 'reply_ambiguous', replyRawText: '' }); expect(ambiguous.candidates).toHaveLength(2);
    for (const wrong of [{ requestId: 'OFFLINE-other', targetIds }, { requestId, targetIds: ['OFFLINE-other'] }]) {
      const mismatchedRaw = JSON.stringify(wrong);
      const result = inspectChatReadback(page([user, { ...assistant, rawText: mismatchedRaw }]), request.prompt, 0, context);
      expect(result).toMatchObject({ reason: 'reply_identity_mismatch', replyRawText: '' }); expect(result.candidates[0].rawText).toBe(mismatchedRaw);
    }
  });

  it('recovers pre-fence parent request JSON formatting while preserving nested strings, IDs, numeric values and literal escapes', (): void => {
    const marker = '【当前事实与本次附件】\n';
    const nestedOriginal = request.prompt.replace(factsMatch[0], marker + factsText);
    const compactJsonSpaces = (value: string): string => {
      let inside = false; let escaped = false; let result = '';
      for (const character of value) {
        if (inside) { result += character; if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') inside = false; }
        else { if (character === '"') inside = true; if (character !== ' ' && character !== '\t' || inside) result += character; }
      }
      return result;
    };
    const nestedCompact = request.prompt.replace(factsMatch[0], marker + compactJsonSpaces(factsText));
    const facts = JSON.parse(factsText) as Record<string, unknown>;
    const previous = { requestId, targetIds, literal: 'red car', count: 17, escape: 'line\\nvalue' };
    const parent = { originalRequest: nestedOriginal, originalReply: JSON.stringify(previous, null, 2) };
    const compactParent = { originalRequest: nestedCompact, originalReply: compactJsonSpaces(JSON.stringify(previous, null, 2)) };
    const source = request.prompt.replace(factsMatch[0], marker + JSON.stringify({ ...facts, parentResult: parent }, null, 2));
    const unescapeMarkdown = (value: string): string => value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1');
    const rendered = unescapeMarkdown(request.prompt.replace(factsMatch[0], marker + JSON.stringify({ ...facts, parentResult: compactParent }, null, 2)));
    const legacyUser = { role: 'user' as const, turnId: user.turnId, rawText: rendered, renderedSource: rendered, text: rendered };
    expect(inspectChatReadback(page([legacyUser, assistant]), source, 0, context)).toMatchObject({ association: 'full_prompt', promptPublished: true, replyRawText: rawReply });
    for (const [index, changed] of [rendered.replace('red car', 'redcar'), rendered.replace(/count(\\*)":17/, 'count$1":18'), rendered.replace(/count(\\*)":17/, 'count$1":1 7'), rendered.replace(/line(\\+)nvalue/, 'linenvalue'), rendered + 'OFFLINE extra instructions'].entries()) {
      expect(changed, `mutation ${index} changes display`).not.toBe(rendered);
      expect(inspectChatReadback(page([{ ...legacyUser, renderedSource: changed, rawText: changed, text: changed }, assistant]), source, 0, context).replyRawText, `mutation ${index}`).toBe('');
    }
    expect(inspectChatReadback(page([{ ...legacyUser, renderedSource: undefined }, assistant]), source, 0, context).replyRawText).toBe('');
    expect(inspectChatReadback(page([legacyUser, assistant]), source, 0).replyRawText).toBe('');
  });

  it('executes the serialized DOM probe and recovers language-less PRE JSON shells without rewriting raw replies', async (): Promise<void> => {
    const textNode = (textContent: string): object => ({ nodeType: 3, textContent });
    const code = { className: '', textContent: '```json\n' + factsText + '\n```' };
    const pre = { tagName: 'PRE', querySelector: (): object => code, textContent: code.textContent };
    const content = { tagName: 'DIV', textContent: header + factsText, childNodes: [textNode(header), pre], querySelectorAll: (selector: string): object[] => selector === 'code' ? [code] : selector === 'pre' || selector.startsWith('ol,') ? [pre] : [] };
    const sent = { getAttribute: (name: string): string | null => name === 'data-testid' ? 'send_message' : name === 'data-message-id' ? 'OFFLINE-user-id' : null,
      querySelector: (): object => content, closest: (): object => ({ getAttribute: (): string => user.turnId! }) };
    const received = { getAttribute: (name: string): string | null => name === 'data-testid' ? 'receive_message' : null,
      querySelector: (): object => ({ textContent: rawReply }), querySelectorAll: (): object[] => [] };
    const document = { querySelectorAll: (selector: string): object[] => selector.startsWith('[data-testid="send_message"]') ? [sent, received] : [] };
    const snapshot = await getChatPageSnapshot({ executeJavaScript: async (script: string): Promise<ChatPageSnapshot> => runInNewContext(script, { document }) as ChatPageSnapshot,
      getURL: (): string => context.conversationUrl, loadURL: (): void => {} });
    expect(snapshot.messages[0]).toMatchObject({ messageId: 'OFFLINE-user-id', turnId: user.turnId });
    expect(inspectChatReadback(snapshot, request.prompt, 0, context).replyRawText).toBe(rawReply);
  });

  it('only reads during stable recovery, persists the verified turn, and never navigates or sends', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const onCaptured = vi.fn(async (): Promise<void> => {}); const loadURL = vi.fn(); const sendInputEvent = vi.fn();
      const view = { executeJavaScript: vi.fn(async (): Promise<ChatPageSnapshot> => page([user, assistant])), getURL: (): string => context.conversationUrl, loadURL, sendInputEvent };
      const result = readStableChatAnswer(view, request.prompt, context.conversationUrl, 5000, { context, currentRunId: (): string => context.runId, onCaptured });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await result).toBe(rawReply); expect(onCaptured).toHaveBeenCalledWith(expect.objectContaining({ userTurnId: user.turnId, association: 'request_envelope' }));
      expect(loadURL).not.toHaveBeenCalled(); expect(sendInputEvent).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('returns ambiguity evidence on timeout without inventing capture or resending', async (): Promise<void> => {
    vi.useFakeTimers();
    try {
      const view = { executeJavaScript: async (): Promise<ChatPageSnapshot> => page([user, assistant, assistant]), getURL: (): string => context.conversationUrl, loadURL: vi.fn() };
      const result = readStableChatAnswer(view, request.prompt, context.conversationUrl, 1000, { context }).catch((error: unknown): unknown => error);
      await vi.advanceTimersByTimeAsync(1600); const error = await result;
      expect(error).toBeInstanceOf(ChatReadbackRecoveryError); expect((error as ChatReadbackRecoveryError).evidence?.candidates).toHaveLength(2);
      expect(view.loadURL).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
