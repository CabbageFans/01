export type VideoParameterOperation = 'snapshot' | 'model_trigger' | 'parameters_trigger' | 'model_option' | 'ratio_option';
export type VideoParameterFailure = 'not_found' | 'ambiguous' | 'covered' | 'disabled' | 'changed' | 'menu_not_open' | 'value_not_applied' | 'page_unavailable';
export interface VideoParameterRequest { operation: VideoParameterOperation; expected?: string; activate?: boolean }
export interface VideoParameterSnapshot {
  modelReady: boolean;
  aspectRatioReady: boolean;
  durationReady: boolean;
  model?: string;
  ratio?: string;
  duration?: number;
  menuOpen: boolean;
  activated?: boolean;
  failureReason?: VideoParameterFailure;
}

/** 自包含 guest 探针：只定位当前创作栏及其可见弹层，不保存跨回合坐标或页面内容。 */
export function videoParameterControlFromPage(request: VideoParameterRequest): VideoParameterSnapshot {
  const normalize = (value: string): string => value.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  const text = (element: Element): string => normalize((element as HTMLElement).innerText || element.textContent || '');
  const ratios = ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '21:9'];
  const models = ['Seedance 2.5', 'Seedance 2.0', 'Seedance 2.0 Fast', 'Seedance 2.0 Mini'];
  const ratioLabel = (value: string): string | undefined => {
    const match = normalize(value).match(/^(自动|auto|\d{1,2}\s*:\s*\d{1,2})(?:\s*(?:竖屏|横屏|方形|宽屏|超宽屏|标准))?$/i);
    const ratio = match?.[1].replace(/\s/g, '').replace(/^自动$/i, 'auto').toLowerCase();
    return ratio && ratios.includes(ratio) ? ratio : undefined;
  };
  const compositeValue = (element: Element): { ratio: string; duration: number } | undefined => {
    const match = text(element).match(/^(自动|auto|\d{1,2}\s*:\s*\d{1,2})\s*[·•∙|]\s*(\d+)\s*(?:s|秒)$/i);
    const ratio = match && ratioLabel(match[1]);
    return ratio && match ? { ratio, duration: Number(match[2]) } : undefined;
  };
  const outsideContent = (element: Element): boolean => !element.closest('[data-testid="send_message"],[data-testid="receive_message"],textarea,[contenteditable="true"],[contenteditable=""],nav,[role="navigation"],aside,[role="tree"],a[href]');
  const visible = (element: Element): boolean => {
    const bounds = element.getBoundingClientRect();
    if (!element.isConnected || bounds.width < 4 || bounds.height < 4 || bounds.right <= 0 || bounds.bottom <= 0 || bounds.left >= window.innerWidth || bounds.top >= window.innerHeight) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0'
        || node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('inert')) return false;
    }
    return true;
  };
  const enabled = (element: Element): boolean => {
    for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
      const disabled = node.getAttribute('data-disabled');
      if ((node as HTMLButtonElement).disabled || node.getAttribute('aria-disabled') === 'true' || disabled === '' || disabled === 'true') return false;
    }
    return true;
  };
  const unique = (elements: Element[]): HTMLElement[] => [...new Set(elements)].filter((element): element is HTMLElement => element instanceof HTMLElement);
  const composerRoots = unique(Array.from(document.querySelectorAll('#input-engine-container,.guidance-input-surface,[data-testid="guidance-input-surface"]')).filter(visible));
  const inComposer = (element: Element): boolean => !composerRoots.length || composerRoots.some((root): boolean => root.contains(element));
  const controls = (selector: string): HTMLElement[] => unique(Array.from(document.querySelectorAll(selector)).filter((element): boolean => visible(element) && outsideContent(element) && inComposer(element)));
  const fallbackControls = (): HTMLElement[] => composerRoots.flatMap((root): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>('button,[role="button"],[aria-haspopup]')).filter((element): boolean => visible(element) && outsideContent(element)));
  let modelControls = controls('[data-input-engine-actionbar-control-key="video-model"]');
  if (!modelControls.length) modelControls = unique(fallbackControls().filter((element): boolean => /^模型\s*/.test(text(element)) && models.includes(text(element).replace(/^模型\s*/, ''))));
  let parameterControls = controls('[data-creation-params-panel-id]').filter((element): boolean => !!compositeValue(element));
  if (!parameterControls.length) parameterControls = unique(fallbackControls().filter((element): boolean => !!compositeValue(element)));
  // 同一触发器的包装属性可重复出现，只保留内层实际控件；两个独立控件则拒绝猜测。
  const innermost = (elements: HTMLElement[]): HTMLElement[] => elements.filter((element): boolean => !elements.some((other): boolean => other !== element && element.contains(other)));
  modelControls = innermost(modelControls); parameterControls = innermost(parameterControls);
  const model = modelControls.length === 1 ? modelControls[0] : undefined;
  const parameters = parameterControls.length === 1 ? parameterControls[0] : undefined;
  const composite = parameters && compositeValue(parameters);
  const snapshot: VideoParameterSnapshot = {
    modelReady: !!model && enabled(model), aspectRatioReady: !!parameters && enabled(parameters), durationReady: !!parameters && enabled(parameters),
    model: model ? text(model).replace(/^模型\s*/, '') : undefined, ratio: composite?.ratio, duration: composite?.duration, menuOpen: false,
  };
  if (request.operation === 'snapshot') return snapshot;
  const ratioOperation = request.operation === 'ratio_option' || request.operation === 'parameters_trigger';
  const trigger = ratioOperation ? parameters : model;
  const expected = ratioOperation ? ratioLabel(request.expected || '') : normalize(request.expected || '');
  const matches = (element: Element): boolean => ratioOperation ? !!expected && ratioLabel(text(element)) === expected : !!expected && text(element) === expected;
  const optionSelector = '[role="option"],[role="menuitem"],[role="menuitemradio"],[role="radio"],button,[role="button"],label,li,div,span,p';
  const labels = (root: Element): HTMLElement[] => unique([root, ...Array.from(root.querySelectorAll(optionSelector))].filter((element): boolean => visible(element) && outsideContent(element)));
  const overlay = (element: Element): boolean => {
    if (element === document.body || element === document.documentElement || element === trigger || !!trigger && element.contains(trigger)
      || !visible(element) || !outsideContent(element) || composerRoots.includes(element as HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    if (trigger) {
      const bounds = element.getBoundingClientRect(); const anchor = trigger.getBoundingClientRect();
      const gap = Math.max(0, bounds.left - anchor.right, anchor.left - bounds.right, bounds.top - anchor.bottom, anchor.top - bounds.bottom);
      if (gap > 96) return false;
    }
    return element.matches('[role="menu"],[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper],[data-state="open"][data-side]') || style.position === 'fixed' || style.position === 'absolute';
  };
  const sufficientOptions = (root: Element): boolean => {
    const values = labels(root).map((element): string | undefined => ratioOperation ? ratioLabel(text(element)) : models.includes(text(element)) ? text(element) : undefined).filter((value): value is string => !!value);
    return new Set(values).size >= 2;
  };
  const findMenuRoots = (): HTMLElement[] => {
    let roots: HTMLElement[] = [];
    if (trigger) {
      const ownedIds = `${trigger.getAttribute('aria-controls') || ''} ${trigger.getAttribute('aria-owns') || ''}`.trim().split(/\s+/);
      roots = unique(ownedIds.flatMap((id): Element[] => { const root = id ? document.getElementById(id) : null;
        return root && root !== trigger && !root.contains(trigger) && root !== document.body && root !== document.documentElement
          && !composerRoots.includes(root) && visible(root) && outsideContent(root) ? [root] : []; }));
    }
    if (!roots.length) {
      const semantic = Array.from(document.querySelectorAll('[role="menu"],[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper],[data-state="open"][data-side]')).filter((root): boolean => overlay(root) && sufficientOptions(root));
      roots = unique(semantic);
      // 无role的比例卡片只允许在真正浮层祖先内成组识别，不能从聊天正文或整页取最小叶节点。
      if (!roots.length) for (const label of Array.from(document.querySelectorAll(optionSelector)).filter((element): boolean => visible(element) && outsideContent(element) && (ratioOperation ? !!ratioLabel(text(element)) : models.includes(text(element))))) {
        for (let ancestor = label.parentElement, depth = 0; ancestor && depth < 8; ancestor = ancestor.parentElement, depth++) {
          if (overlay(ancestor) && sufficientOptions(ancestor)) { roots.push(ancestor); break; }
        }
      }
    }
    return innermost(unique(roots));
  };
  const roots = findMenuRoots();
  snapshot.menuOpen = roots.length === 1;
  let candidates: HTMLElement[];
  if (request.operation === 'model_trigger') candidates = modelControls;
  else if (request.operation === 'parameters_trigger') candidates = parameterControls;
  else {
    if (roots.length !== 1) return { ...snapshot, failureReason: roots.length ? 'ambiguous' : 'menu_not_open' };
    const root = roots[0];
    candidates = unique(labels(root).filter(matches).map((label): Element => {
      const semantic = label.closest('[role="option"],[role="menuitem"],[role="menuitemradio"],[role="radio"],button,[role="button"],label,li');
      if (semantic && root.contains(semantic) && visible(semantic)) return semantic;
      let target = label;
      while (target.parentElement && target.parentElement !== root && matches(target.parentElement)) target = target.parentElement;
      return target;
    }));
    candidates = innermost(candidates);
  }
  const activateCandidate = (targets: HTMLElement[]): VideoParameterSnapshot => {
    if (!targets.length) return { ...snapshot, failureReason: 'not_found' };
    if (targets.length !== 1) return { ...snapshot, failureReason: 'ambiguous' };
    const target = targets[0];
    if (!enabled(target)) return { ...snapshot, failureReason: 'disabled' };
    const bounds = target.getBoundingClientRect();
    const x = Math.round((Math.max(0, bounds.left) + Math.min(window.innerWidth - 1, bounds.right)) / 2);
    const y = Math.round((Math.max(0, bounds.top) + Math.min(window.innerHeight - 1, bounds.bottom)) / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit !== target && !target.contains(hit)) return { ...snapshot, failureReason: 'covered' };
    if (!request.activate) return snapshot;
    // 定位、命中和事件派发在同一页内调用完成，不使用缓存坐标或系统焦点；点击结果另行回读。
    const options: MouseEventInit = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1 };
    try { target.dispatchEvent(new PointerEvent('pointerdown', { ...options, pointerId: 1, pointerType: 'mouse', isPrimary: true })); } catch { /* 旧页面仍使用鼠标事件。 */ }
    if (target.isConnected) target.dispatchEvent(new MouseEvent('mousedown', options));
    const released = { ...options, buttons: 0 };
    if (target.isConnected) {
      try { target.dispatchEvent(new PointerEvent('pointerup', { ...released, pointerId: 1, pointerType: 'mouse', isPrimary: true })); } catch { /* 同上。 */ }
      target.dispatchEvent(new MouseEvent('mouseup', released));
      target.dispatchEvent(new MouseEvent('click', released));
    }
    return { ...snapshot, activated: true };
  };
  return activateCandidate(candidates);
}
