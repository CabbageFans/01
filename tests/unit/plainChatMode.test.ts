/** 正常 Chat 模式守卫的真实序列化脚本行为；不访问平台、不发送文字或媒体。 */
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { ensurePlainChatComposer, startNewConversation, type WebviewHandle } from '../../src/utils/doubaoBridge';

function fixture(initial: 'plain' | 'video' | 'image' | 'unknown' | 'orphan-controls', options: { attachment?: boolean; hiddenMeasurement?: boolean; exitStuck?: boolean } = {}): { view: WebviewHandle; actions: string[] } {
  let state = initial;
  const actions: string[] = [];
  class Element {
    parentElement: Element | null = null;
    readonly tagName: string;
    readonly innerText: string;
    readonly textContent: string;
    readonly value = '';
    readonly files: object[] = [];
    constructor(tag: string, text = '') { this.tagName = tag; this.innerText = text; this.textContent = text; }
    getBoundingClientRect(): { left: number; top: number; width: number; height: number } { return { left: 100, top: 500, width: 400, height: 90 }; }
    getAttribute(): null { return null; }
    hasAttribute(): boolean { return false; }
    closest(): null { return null; }
    querySelectorAll(selector: string): Element[] {
      if (selector.startsWith('textarea')) return [editor];
      if (selector.includes('skill_input_exit_button')) return state === 'plain' || state === 'orphan-controls' ? options.hiddenMeasurement ? [hiddenSkill] : [] : [skill];
      if (selector.includes('video-model') || selector.includes('mode-select-action-btn')) return state === 'video' || state === 'orphan-controls' ? [model] : [];
      if (selector.includes('mdbox_image')) return options.attachment ? [attachment] : [];
      return [];
    }
    dispatchEvent(event: { type: string }): boolean {
      if (event.type === 'click') {
        actions.push(this.innerText);
        if (this === skill && !options.exitStuck) { state = 'plain'; root = new Element('DIV'); editor.parentElement = root; }
      }
      return true;
    }
  }
  let root = new Element('DIV');
  const editor = new Element('TEXTAREA'); editor.parentElement = root;
  const skill = new Element('DIV', initial === 'video' ? '视频生成' : initial === 'image' ? '图像生成' : '未知创作技能'); skill.parentElement = root;
  const hiddenSkill = new Element('DIV', '视频生成'); hiddenSkill.parentElement = root;
  const model = new Element('BUTTON', '视频生成'); model.parentElement = root;
  const attachment = new Element('DIV'); attachment.parentElement = root;
  const document = { querySelector: (selector: string): Element | null => selector === '#input-engine-container' ? root : null };
  class InputEvent { constructor(readonly type: string) {} }
  const view: WebviewHandle = { getURL: (): string => 'https://www.doubao.com/chat/', loadURL: vi.fn(), executeJavaScript: async (code: string): Promise<unknown> => {
    if (code.includes('timeOrigin: performance.timeOrigin')) return { href: view.getURL(), timeOrigin: 1, readyState: 'complete' };
    if (code.includes('var newConversationDocument')) return { ok: true, reason: 'READY', stabilityKey: 'OFFLINE-stable' };
    if (code.includes('plainChatComposerProbe')) return runInNewContext(code, { document, window: { getComputedStyle: (element: Element): object => ({ display: 'block', visibility: element === hiddenSkill ? 'hidden' : 'visible' }) }, Date, setTimeout, PointerEvent: InputEvent, MouseEvent: InputEvent });
    if (code.includes('messages.push')) return { messages: [], editorPresent: true, editorText: '', generating: false };
    if (code.includes('var editor = null')) return { ok: true, reason: 'READY' };
    return true;
  } };
  return { view, actions };
}

describe('普通 Chat 独立于媒体技能', (): void => {
  it.each(['video', 'image'] as const)('复用空根页时只退出一次已选%s技能，回读重挂载的普通输入区', async (mode): Promise<void> => {
    const test = fixture(mode); const result = await startNewConversation(test.view, 1000, true);
    expect(result.ok).toBe(true); expect(test.actions).toEqual([mode === 'video' ? '视频生成' : '图像生成']); expect(test.view.loadURL).not.toHaveBeenCalled();
  });
  it('普通输入区忽略隐藏测量技能，不点发送或任何模式入口', async (): Promise<void> => {
    const test = fixture('plain', { hiddenMeasurement: true }); expect((await ensurePlainChatComposer(test.view, true)).ok).toBe(true); expect(test.actions).toEqual([]);
  });
  it.each(['video', 'image', 'unknown', 'orphan-controls'] as const)('上传或提交前只读检查发现%s时阻断，不改变模式或发送', async (mode): Promise<void> => {
    const test = fixture(mode); expect((await ensurePlainChatComposer(test.view)).ok).toBe(false); expect(test.actions).toEqual([]);
  });
  it('未知技能不自动退出，退出后仍未成为普通输入区也不能继续', async (): Promise<void> => {
    const unknown = fixture('unknown'); expect(await ensurePlainChatComposer(unknown.view, true)).toEqual({ ok: false, reason: 'CHAT_MODE_UNVERIFIED' }); expect(unknown.actions).toEqual([]);
    const stuck = fixture('video', { exitStuck: true }); expect((await ensurePlainChatComposer(stuck.view, true, 150)).ok).toBe(false); expect(stuck.actions).toEqual(['视频生成']);
  });
  it('空根页有上一任务附件时保留现场，既不退出技能也不重复上传', async (): Promise<void> => {
    const test = fixture('video', { attachment: true }); expect(await startNewConversation(test.view, 1000, true)).toEqual({ ok: false, reason: 'SESSION_NOT_EMPTY' }); expect(test.actions).toEqual([]); expect(test.view.loadURL).not.toHaveBeenCalled();
  });
});
