declare const __doubaoAssertOperation: (() => void) | undefined;
import type { VideoControlReadinessResult } from './videoControlReadiness';

export interface CreationModeEntryDiagnostic {
  ready: boolean;
  elapsedMs: number;
  reason?: string;
  method?: string;
  attempts?: number;
  stableSamples?: number;
  controlOperation?: 'mode_trigger' | 'mode_option' | 'mode_selection';
  failureReason?: VideoControlReadinessResult['failureReason'];
  missingControl?: VideoControlReadinessResult['missingControl'];
}

/** 序列化后在页面执行；全部依赖局限于此函数，模式选择不读取模型／参数控件。 */
export async function selectCreationModeFromPage(mode: 'image' | 'video'): Promise<CreationModeEntryDiagnostic> {
  const targetLabel = mode === 'image' ? '图像生成' : '视频生成';
  const startedAt = Date.now();
  const deadline = startedAt + 15_000;
  let attempts = 0;
  let stableSamples = 0;
  let previousRoot: HTMLElement | undefined;
  let previousSelection: HTMLElement | undefined;
  let selectionRequested = false;
  let exitedPrevious = false;
  let menuRequested = false;
  let moreRequested = false;
  let menuOwner: HTMLElement | undefined;
  let menusBeforeAction = new Set<HTMLElement>();
  let method = 'already-selected-skill';
  let controlOperation: NonNullable<CreationModeEntryDiagnostic['controlOperation']> = 'mode_selection';
  let failureReason: NonNullable<CreationModeEntryDiagnostic['failureReason']> = 'not_found';
  let missingControl: NonNullable<CreationModeEntryDiagnostic['missingControl']> = 'video_entry';
  const menuSelector = '[role="menu"],[role="listbox"]';

  const visible = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || parent.getAttribute('aria-hidden') === 'true') return false;
    }
    return true;
  };
  const text = (element: HTMLElement): string => (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
  const currentRoots = (): HTMLElement[] => {
    const editors = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).filter(visible);
    // engine 只覆盖编辑器，技能栏和已选标记在兄弟分支；必须使用已观测的共同 surface。
    const roots = editors.map((editor: HTMLElement): Element | null => editor.closest('[data-testid="guidance-input-surface"],.guidance-input-surface'))
      .filter((root: Element | null): root is HTMLElement => !!root && visible(root));
    return [...new Set(roots)];
  };
  const selectedSkills = (root: HTMLElement): HTMLElement[] => Array.from(root.querySelectorAll('[data-testid="skill_input_exit_button"]'))
    .filter(visible).filter((element: HTMLElement): boolean => !element.parentElement?.closest('[data-testid="skill_input_exit_button"]'));
  const actionables = (root: ParentNode): HTMLElement[] => Array.from(root.querySelectorAll('button,[role="button"],[role="tab"],[role="option"],[role="menuitem"]')).filter(visible);
  const leafControls = (elements: HTMLElement[]): HTMLElement[] => elements.filter((element: HTMLElement): boolean =>
    !elements.some((other: HTMLElement): boolean => other !== element && element.contains(other)));
  const ownedMenus = (root: HTMLElement): HTMLElement[] => {
    const expanded = Array.from(root.querySelectorAll('[data-valid-btn="mode-select-action-btn"][aria-expanded="true"],[data-testid="skill_bar_button_more"][aria-expanded="true"]')).filter(visible);
    const owners = menuOwner && root.contains(menuOwner) ? [...new Set([...expanded, menuOwner])] : expanded;
    return Array.from(document.querySelectorAll(menuSelector)).filter(visible).filter((menu: HTMLElement): boolean =>
      owners.some((trigger: HTMLElement): boolean => {
        const controls = (trigger.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
        const labels = (menu.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
        const linked = !!menu.id && controls.includes(menu.id) || !!trigger.id && labels.includes(trigger.id);
        // 内嵌菜单必须由本次明确的模式动作新建；已有参数菜单不属于模式选择。
        return linked || trigger === menuOwner && root.contains(menu) && !menusBeforeAction.has(menu);
      }));
  };
  const recordMenuOwner = (trigger: HTMLElement): void => {
    menuOwner = trigger;
    menusBeforeAction = new Set(Array.from(document.querySelectorAll(menuSelector)).filter(visible));
  };
  const result = (ready: boolean): CreationModeEntryDiagnostic => ({
    ready, elapsedMs: Math.max(0, Date.now() - startedAt), attempts, stableSamples, controlOperation, method,
    ...(!ready ? { failureReason, missingControl,
      reason: failureReason === 'ambiguous' ? '当前输入区的模式归属存在歧义'
        : selectionRequested ? `${targetLabel}技能未连续稳定选中`
          : menuRequested ? `${targetLabel}模式菜单未提供唯一可用选项`
            : `${targetLabel}模式入口未在等待窗口内挂载` } : {}),
  });
  const activate = (element: HTMLElement): boolean => {
    if (typeof __doubaoAssertOperation === 'function') __doubaoAssertOperation();
    if (!visible(element)) { failureReason = 'changed'; return false; }
    if (element.matches(':disabled') || element.closest('[aria-disabled="true"]')) { failureReason = 'disabled'; return false; }
    const rect = element.getBoundingClientRect();
    const options: MouseEventInit = { bubbles: true, cancelable: true, view: window, button: 0,
      clientX: Math.round(rect.left + rect.width / 2), clientY: Math.round(rect.top + rect.height / 2) };
    element.dispatchEvent(new PointerEvent('pointerdown', { ...options, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    element.dispatchEvent(new MouseEvent('mousedown', options));
    element.dispatchEvent(new PointerEvent('pointerup', { ...options, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    element.dispatchEvent(new MouseEvent('mouseup', options));
    element.dispatchEvent(new MouseEvent('click', options));
    return true;
  };
  const requestTarget = (root: HTMLElement): boolean => {
    const controls = actionables(root).filter((element: HTMLElement): boolean => !element.closest(menuSelector)
      && !element.closest('[data-testid="skill_input_exit_button"]'));
    const entries = leafControls(controls.filter((element: HTMLElement): boolean => text(element) === targetLabel));
    if (entries.length > 1) { failureReason = 'ambiguous'; return false; }
    if (entries.length === 1) {
      const entry = entries[0];
      const menuTrigger = entry.closest('[data-valid-btn="mode-select-action-btn"]');
      controlOperation = menuTrigger ? 'mode_trigger' : 'mode_selection';
      if (menuTrigger instanceof HTMLElement) recordMenuOwner(menuTrigger);
      if (!activate(entry)) return false;
      menuRequested = !!menuTrigger; selectionRequested = !menuTrigger; method = menuTrigger ? 'mode-trigger-selected' : 'skill-entry-selected';
      return true;
    }
    if (moreRequested) { failureReason = 'not_found'; return true; }
    // 普通技能区与模式菜单各有明确触发器，缺目标时不尝试点击其他区域。
    const triggers = leafControls(controls.filter((element: HTMLElement): boolean =>
      element.matches('[data-valid-btn="mode-select-action-btn"],[data-testid="skill_bar_button_more"]')));
    if (triggers.length > 1) { failureReason = 'ambiguous'; return false; }
    if (triggers.length === 1) {
      controlOperation = 'mode_trigger';
      recordMenuOwner(triggers[0]);
      if (!activate(triggers[0])) return false;
      moreRequested = triggers[0].matches('[data-testid="skill_bar_button_more"]');
      menuRequested = !moreRequested;
      method = moreRequested ? 'skill-bar-expanded' : 'mode-menu-opened';
    } else failureReason = 'not_found';
    return true;
  };
  const nextSample = async (): Promise<void> => new Promise((resolve: () => void): void => {
    setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now())));
  });

  try {
    while (Date.now() <= deadline) {
      attempts++;
      const roots = currentRoots();
      if (roots.length > 1) { failureReason = 'ambiguous'; missingControl = 'conversation_editor'; return result(false); }
      const root = roots[0];
      if (!root) {
        stableSamples = 0; previousRoot = undefined; previousSelection = undefined;
        failureReason = 'page_unavailable'; missingControl = 'conversation_editor';
      } else {
        missingControl = 'video_entry';
        const skills = selectedSkills(root);
        if (skills.length > 1) { failureReason = 'ambiguous'; return result(false); }
        const selected = skills[0];
        if (selected && text(selected) === targetLabel) {
          stableSamples = previousRoot === root && previousSelection === selected ? stableSamples + 1 : 1;
          previousRoot = root; previousSelection = selected;
          if (stableSamples >= 2) return result(true);
        } else {
          stableSamples = 0; previousRoot = undefined; previousSelection = undefined;
          // 发出一次目标选择后只读取该选择的结果，绝不再点新挂载的模式触发器。
          if (selectionRequested) failureReason = 'value_not_applied';
          else if (selected) {
            controlOperation = 'mode_selection';
            if (!exitedPrevious) {
              if (!activate(selected)) return result(false);
              exitedPrevious = true;
            }
            failureReason = 'value_not_applied';
          } else {
            const menus = ownedMenus(root);
            if (menus.length > 1) { failureReason = 'ambiguous'; return result(false); }
            if (menus.length === 1) {
              controlOperation = 'mode_option'; menuRequested = true;
              const options = leafControls(actionables(menus[0]).filter((element: HTMLElement): boolean => text(element) === targetLabel));
              if (options.length > 1) { failureReason = 'ambiguous'; return result(false); }
              if (options.length === 1) {
                if (!activate(options[0])) return result(false);
                selectionRequested = true; method = 'mode-menu-selected';
              } else failureReason = 'not_found';
            } else if (menuRequested) failureReason = 'menu_not_open';
            else if (!requestTarget(root)) return result(false);
          }
        }
      }
      if (Date.now() >= deadline) break;
      await nextSample();
    }
    return result(false);
  } catch {
    failureReason = 'page_unavailable';
    return result(false);
  }
}
