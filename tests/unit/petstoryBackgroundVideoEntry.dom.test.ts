/** 正式后台/窄布局入口的真实 DOM 回归；执行序列化脚本，不访问平台、不发送。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickAITab } from '../../src/utils/doubaoBridge';
import type { WebviewHandle } from '../../src/utils/doubaoBridge';

function sized<T extends HTMLElement>(element: T, left = 120, top = 100, width = 92, height = 32): T {
  element.getBoundingClientRect = (): DOMRect => ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: (): object => ({}) });
  return element;
}

function fixture(): {
  root: HTMLDivElement; editor: HTMLDivElement;
  view: WebviewHandle & { executeJavaScript: ReturnType<typeof vi.fn>; loadURL: ReturnType<typeof vi.fn>; sendInputEvent: ReturnType<typeof vi.fn> };
  addSkill: () => HTMLElement; addControls: (root?: HTMLElement) => void; addEntry: () => HTMLButtonElement;
} {
  // querySelector 首个命中属于隐藏测量区，当前编辑器指向后面真正的输入区。
  const hidden = sized(document.createElement('div')); hidden.id = 'input-engine-container'; hidden.style.display = 'none';
  hidden.append(sized(document.createElement('textarea'))); document.body.append(hidden);
  const root = sized(document.createElement('div'), 0, 50, 390, 300); root.id = 'input-engine-container'; root.className = 'guidance-input-surface'; document.body.append(root);
  const editor = sized(document.createElement('div'), 10, 100, 360, 150); editor.setAttribute('contenteditable', 'true'); root.append(editor);
  const addControls = (target: HTMLElement = root): void => {
    const model = sized(document.createElement('button')); model.setAttribute('data-input-engine-actionbar-control-key', 'video-model'); model.textContent = '模型 Seedance 2.0 Fast';
    const parameters = sized(document.createElement('button')); parameters.setAttribute('data-input-engine-actionbar-render-entry-key', 'video-generation-params-panel'); parameters.textContent = '9:16 · 5s'; target.append(model, parameters);
  };
  addControls(hidden);
  const addSkill = (): HTMLElement => {
    const skill = sized(document.createElement('div')); skill.setAttribute('data-testid', 'skill_input_exit_button'); skill.textContent = '\n 视频生成\t  ';
    Object.defineProperty(skill, 'innerText', { configurable: true, get: (): string => '' }); root.append(skill); return skill;
  };
  const addEntry = (): HTMLButtonElement => {
    const entry = sized(document.createElement('button'), 120, 160); entry.textContent = '\t 视频生成\n ';
    // 后台入口可为 fixed 控件，offsetParent=null 不代表 display/visibility 隐藏。
    Object.defineProperty(entry, 'offsetParent', { configurable: true, get: (): null => null }); root.append(entry); return entry;
  };
  const view = { executeJavaScript: vi.fn(async (code: string): Promise<unknown> => window.eval(code)),
    getURL: (): string => 'https://www.doubao.com/chat/', loadURL: vi.fn(), sendInputEvent: vi.fn() };
  return { root, editor, view, addSkill, addControls, addEntry };
}

async function settled(work: Promise<boolean>): Promise<boolean> {
  let outcome: { value: boolean } | { error: unknown } | undefined;
  void work.then((value: boolean): void => { outcome = { value }; }, (error: unknown): void => { outcome = { error }; });
  for (let sample = 0; sample < 180 && !outcome; sample++) await vi.advanceTimersByTimeAsync(250);
  if (!outcome) throw new Error('TEST mode entry did not settle within its deadline');
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

beforeEach((): void => { vi.useFakeTimers(); });
afterEach((): void => { document.body.replaceChildren(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('后台输入区的视频入口归属与稳定等待', (): void => {
  it('已选视频技能识别新版参数标记与空 innerText 后备文本，不退出目标技能', async (): Promise<void> => {
    const test = fixture(); const skill = test.addSkill(); const clicked = vi.fn(); skill.addEventListener('click', clicked); test.addControls();
    expect(await settled(clickAITab(test.view, 'video'))).toBe(true);
    expect(clicked).not.toHaveBeenCalled();
    const code = test.view.executeJavaScript.mock.calls[0][0] as string;
    expect(code).toContain('replace(/\\s+/g'); expect(code).not.toContain('replace(/\\\\s+/g');
    expect(test.view.sendInputEvent).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled();
  });

  it('contenteditable 上半区入口位于编辑器内部高度且 offsetParent=null 时仍按真实输入区选择', async (): Promise<void> => {
    const test = fixture(); const entry = test.addEntry(); const clicked = vi.fn();
    entry.addEventListener('click', (): void => { clicked(); entry.remove(); test.addSkill(); test.addControls(); });
    const sidebar = sized(document.createElement('button'), 10, 160); sidebar.textContent = '视频生成'; const sidebarClick = vi.fn(); sidebar.addEventListener('click', sidebarClick); document.body.prepend(sidebar);
    expect(await settled(clickAITab(test.view, 'video'))).toBe(true);
    expect(clicked).toHaveBeenCalledOnce(); expect(sidebarClick).not.toHaveBeenCalled();
  });

  it('视频入口晚于编辑器四秒挂载时继续等待，目标技能参数晚挂载时不重复点击', async (): Promise<void> => {
    const test = fixture(); const clicked = vi.fn();
    setTimeout((): void => {
      const entry = test.addEntry(); entry.addEventListener('click', (): void => {
        clicked(); entry.remove(); const skill = test.addSkill(); skill.addEventListener('click', clicked);
        setTimeout((): void => test.addControls(), 2500);
      });
    }, 4000);
    expect(await settled(clickAITab(test.view, 'video'))).toBe(true);
    expect(clicked).toHaveBeenCalledOnce();
  });

  it('更多按钮晚挂载时只展开一次，然后选择本输入区的视频入口', async (): Promise<void> => {
    const test = fixture(); const moreClick = vi.fn(); const videoClick = vi.fn();
    setTimeout((): void => {
      const more = sized(document.createElement('button')); more.textContent = '更多'; test.root.append(more);
      more.addEventListener('click', (): void => {
        moreClick(); const entry = test.addEntry(); entry.addEventListener('click', (): void => { videoClick(); entry.remove(); test.addSkill(); test.addControls(); });
      });
    }, 3000);
    expect(await settled(clickAITab(test.view, 'video'))).toBe(true);
    expect(moreClick).toHaveBeenCalledOnce(); expect(videoClick).toHaveBeenCalledOnce();
  });

  it('等待期间页面恢复已选视频技能时只读等待真实参数，不把退出按钮再次点击', async (): Promise<void> => {
    const test = fixture(); const exited = vi.fn();
    setTimeout((): void => { const skill = test.addSkill(); skill.addEventListener('click', exited); }, 3000);
    setTimeout((): void => test.addControls(), 4500);
    expect(await settled(clickAITab(test.view, 'video'))).toBe(true); expect(exited).not.toHaveBeenCalled();
  });

  it('初击已打开模式菜单时直接选择现有精确选项，避免再次 toggle 关闭菜单', async (): Promise<void> => {
    const test = fixture(); const trigger = test.addEntry(); trigger.setAttribute('data-valid-btn', 'mode-select-action-btn');
    const triggerClick = vi.fn(); const optionClick = vi.fn();
    trigger.addEventListener('click', (): void => {
      triggerClick();
      const existing = test.root.querySelector('[role="menu"]'); if (existing) { existing.remove(); return; }
      const menu = sized(document.createElement('div')); menu.setAttribute('role', 'menu');
      const option = sized(document.createElement('button')); option.setAttribute('role', 'menuitem'); option.textContent = '视频生成'; menu.append(option); test.root.append(menu);
      option.addEventListener('click', (): void => { optionClick(); menu.remove(); test.addSkill(); test.addControls(); });
    });
    expect(await settled(clickAITab(test.view, 'video'))).toBe(true);
    expect(triggerClick).toHaveBeenCalledOnce(); expect(optionClick).toHaveBeenCalledOnce();
  });

  it('隐藏测量区或其他区域的视频参数不提供当前输入区的成功证据', async (): Promise<void> => {
    const test = fixture(); const unrelated = sized(document.createElement('div')); document.body.append(unrelated); test.addControls(unrelated);
    expect(await settled(clickAITab(test.view, 'video'))).toBe(false);
    expect(test.view.sendInputEvent).not.toHaveBeenCalled(); expect(test.view.loadURL).not.toHaveBeenCalled();
  });
});
