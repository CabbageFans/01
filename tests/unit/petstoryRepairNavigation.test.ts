/** 选定自由回复修订的导航前草稿保护；离线页面替身不发送豆包请求。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import type { Task } from '@doubao-studio/contracts';
import { startNewConversation, type WebviewHandle } from '../../src/utils/doubaoBridge';
import type { ChatPageSnapshot } from '../../src/utils/chatReadback';
import original from '../fixtures/storyboard-five-shots.json';

function fixture(root: boolean = false): { view: WebviewHandle; snapshot: ChatPageSnapshot; holdDocument: () => void; releaseDocument: () => void } {
  let url = root ? 'https://www.doubao.com/chat/' : 'https://www.doubao.com/chat/OFFLINE-selected-reply'; let timeOrigin = 1;
  let release = (): void => {}; let documentGate: Promise<void> | undefined;
  const snapshot: ChatPageSnapshot = { messages: [{ role: 'assistant', rawText: original.mobileStory, text: original.mobileStory }], editorPresent: true, editorText: '', generating: false };
  const view: WebviewHandle = {
    getURL: (): string => url,
    loadURL: vi.fn((next: string): void => { url = next; timeOrigin++; snapshot.messages = []; snapshot.editorText = ''; }),
    sendInputEvent: vi.fn(),
    executeJavaScript: vi.fn(async (code: string): Promise<unknown> => {
      if (code.includes('timeOrigin: performance.timeOrigin')) {
        if (documentGate) { await documentGate; documentGate = undefined; }
        return { href: url, timeOrigin, readyState: 'complete' };
      }
      if (code.includes('var newConversationDocument')) return { ok: true, reason: 'READY', stabilityKey: 'OFFLINE-stable-new-document' };
      if (code.includes('messages.push')) return structuredClone(snapshot);
      if (code.includes('plainChatComposerProbe')) return { ok: true };
      return true;
    }),
  };
  return { view, snapshot, holdDocument: (): void => { documentGate = new Promise<void>((resolve): void => { release = resolve; }); }, releaseDocument: (): void => release() };
}

/** 直接执行正式BrowserPanel的资格函数，不在测试中复制恢复判定。 */
function ownedDraftQualification(): (task: Task | undefined, prompt: string, selectedReplyRepair: boolean) => string | undefined {
  const source = ts.createSourceFile('BrowserPanel.tsx', fs.readFileSync(path.resolve('src/components/BrowserPanel.tsx'), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find((node): boolean => ts.isFunctionDeclaration(node) && node.name?.text === 'resumableRepairDraft');
  if (!declaration) throw new Error('OFFLINE正式修订草稿恢复函数不存在');
  return vm.runInNewContext(ts.transpileModule(declaration.getText(source) + '\nresumableRepairDraft;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText) as (task: Task | undefined, prompt: string, selectedReplyRepair: boolean) => string | undefined;
}
function continuedTask(): Task {
  const now = '2026-10-30T01:00:00.000Z';
  return { id: 'OFFLINE-original-repair-task', prompt: original.mobileStory, promptReadback: 'exact', mode: 'chat', executionIntent: 'armed', assignedAccountId: 'OFFLINE-account', status: 'executing', outputs: [], result: null, createdAt: now, updatedAt: now,
    runtime: { runId: 'OFFLINE-second-run', attempt: 2, stage: 'preparing_account', startedAt: now, stageStartedAt: now, lastHeartbeatAt: now, message: 'OFFLINE本人继续明确未发送的同一任务', input: { prompt: original.mobileStory, mode: 'chat', attachments: [] } } };
}

afterEach((): void => { vi.useRealTimers(); });

describe('选定自由回复的修订不会丢弃后来的人工输入', (): void => {
  it('应用时空输入，但初始化等待期间写入的原故事草稿在真正导航前阻断，原文保留', async (): Promise<void> => {
    const test = fixture(); test.holdDocument();
    const pending = startNewConversation(test.view, 2000, true, true);
    test.snapshot.editorText = original.mobileStory;
    test.releaseDocument();
    expect(await pending).toEqual({ ok: false, reason: 'USER_DRAFT_PRESENT' });
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
    expect(test.snapshot.editorText).toBe(original.mobileStory); expect(test.snapshot.messages).toHaveLength(1);
  });
  it.each([
    { editorPresent: true, editorText: '', generating: true, reason: 'GENERATION_IN_PROGRESS' },
    { editorPresent: false, editorText: '', generating: false, reason: 'EDITOR_NOT_FOUND' },
  ])('当前正在交流或编辑器不可核实时停在原页：$reason', async ({ editorPresent, editorText, generating, reason }): Promise<void> => {
    const test = fixture(); Object.assign(test.snapshot, { editorPresent, editorText, generating });
    expect(await startNewConversation(test.view, 2000, true, true)).toEqual({ ok: false, reason });
    expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });
  it('本人处理草稿后继续同一未发送修订才允许正常新会话导航；探针不发送输入', async (): Promise<void> => {
    vi.useFakeTimers(); const test = fixture(); test.snapshot.editorText = original.mobileStory;
    expect(await startNewConversation(test.view, 2000, true, true)).toEqual({ ok: false, reason: 'USER_DRAFT_PRESENT' });
    test.snapshot.editorText = '';
    const pending = startNewConversation(test.view, 2000, true, true);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ ok: true }); expect(test.view.loadURL).toHaveBeenCalledTimes(1);
    expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });
  it.each([false, true])('同一原任务自有exact请求草稿允许正常导航，根页=%s仍不在含稿原文档直接发送', async (root: boolean): Promise<void> => {
    vi.useFakeTimers(); const test = fixture(root); const task = continuedTask();
    const ownDraft = ownedDraftQualification()(task, task.prompt, true); expect(ownDraft).toBe(task.prompt);
    test.snapshot.editorText = task.prompt;
    const pending = startNewConversation(test.view, 2000, true, true, ownDraft);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ ok: true }); expect(test.view.loadURL).toHaveBeenCalledTimes(1); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });
  it.each(['改字', '追加字符', '前置空格', '末尾换行'])('任何用户对自有请求的%s仍是受保护草稿，不导航或发送', async (change: string): Promise<void> => {
    const test = fixture(); const task = continuedTask();
    const changed = change === '改字' ? task.prompt.replace('人物', '角色') : change === '追加字符' ? task.prompt + 'TEST用户新要求' : change === '前置空格' ? ' ' + task.prompt : task.prompt + '\n';
    test.snapshot.editorText = changed;
    expect(await startNewConversation(test.view, 2000, true, true, ownedDraftQualification()(task, task.prompt, true))).toEqual({ ok: false, reason: 'USER_DRAFT_PRESENT' });
    expect(test.snapshot.editorText).toBe(changed); expect(test.view.loadURL).not.toHaveBeenCalled(); expect(test.view.sendInputEvent).not.toHaveBeenCalled();
  });
  it('自有exact请求在豆包仍生成时也不放行', async (): Promise<void> => {
    const test = fixture(); test.snapshot.editorText = original.mobileStory; test.snapshot.generating = true;
    expect(await startNewConversation(test.view, 2000, true, true, original.mobileStory)).toEqual({ ok: false, reason: 'GENERATION_IN_PROGRESS' });
    expect(test.view.loadURL).not.toHaveBeenCalled();
  });
  it('首次运行、其他任务职责、非exact输入、未授权执行和任何提交／回复证据不能取得自有草稿资格', (): void => {
    const qualification = ownedDraftQualification();
    const mutations: ((task: Task) => void)[] = [
      (task: Task): void => { task.runtime!.attempt = 1; },
      (task: Task): void => { task.executionIntent = 'hold'; },
      (task: Task): void => { task.promptReadback = undefined; },
      (task: Task): void => { task.runtime!.input.prompt += 'TEST不同输入'; },
      (task: Task): void => { task.runtime!.submittedAt = task.createdAt; },
      (task: Task): void => { task.runtime!.chatResponse = { text: original.mobileStory, capturedAt: task.createdAt }; },
      (task: Task): void => { task.runtime!.chatReadback = {} as NonNullable<Task['runtime']>['chatReadback']; },
      (task: Task): void => { task.outputs = ['OFFLINE-output']; },
    ];
    for (const mutate of mutations) { const task = continuedTask(); mutate(task); expect(qualification(task, task.prompt, true)).toBeUndefined(); }
    const task = continuedTask(); expect(qualification(task, task.prompt, false)).toBeUndefined(); expect(qualification(task, task.prompt + 'TEST其它请求', true)).toBeUndefined();
  });
});
