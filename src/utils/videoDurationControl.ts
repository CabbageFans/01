export interface VideoDurationControlResult {
  position?: string;
  verified?: boolean;
  failureReason?: 'not_found' | 'ambiguous' | 'disabled' | 'changed' | 'menu_not_open' | 'value_not_applied';
}

/** 自包含 guest 操作：每次输入后跨宏任务回读真实滑条，避免 React 批处理吞掉连续步进。 */
export async function setVideoDurationFromPage(targetSeconds: number, deadlineAt: number): Promise<VideoDurationControlResult> {
  let position: string | undefined;
  try {
    if (!Number.isInteger(targetSeconds) || targetSeconds < 4 || targetSeconds > 15 || !Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) return {};
    const visible = (element: HTMLElement): boolean => {
      const bounds = element.getBoundingClientRect();
      if (!element.isConnected || bounds.width <= 0 || bounds.height <= 0
        || bounds.right <= 0 || bounds.bottom <= 0 || bounds.left >= window.innerWidth || bounds.top >= window.innerHeight) return false;
      for (let current: HTMLElement | null = element; current; current = current.parentElement) {
        const style = window.getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0'
          || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false;
      }
      return true;
    };
    const outsideContent = (element: HTMLElement): boolean => !element.closest('[data-testid="send_message"],[data-testid="receive_message"],textarea,[contenteditable="true"],[contenteditable=""],nav,[role="navigation"],aside,[role="tree"],a[href]');
    const setPopupControl = async (): Promise<VideoDurationControlResult> => {
      const normalize = (value: string): string => value.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
      const text = (element: HTMLElement): string => normalize(element.innerText || element.textContent || '');
      const ratio = (value: string): string | undefined => {
        const match = normalize(value).match(/^(自动|auto|\d{1,2}\s*:\s*\d{1,2})(?:\s*(?:竖屏|横屏|方形|宽屏|超宽屏|标准))?$/i);
        const label = match?.[1].replace(/\s/g, '').replace(/^自动$/, 'auto').toLowerCase();
        return label && ['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '21:9'].includes(label) ? label : undefined;
      };
      const innermost = (elements: HTMLElement[]): HTMLElement[] => [...new Set(elements)].filter((element): boolean => !elements.some((other): boolean => other !== element && element.contains(other)));
      const composerRoots = Array.from(document.querySelectorAll<HTMLElement>('#input-engine-container,.guidance-input-surface,[data-testid="guidance-input-surface"]')).filter(visible);
      const isParameterTrigger = (element: HTMLElement): boolean => {
        const match = text(element).match(/^(自动|auto|\d{1,2}\s*:\s*\d{1,2})\s*[·•∙|]\s*\d+\s*(?:s|秒)$/i);
        return !!match && !!ratio(match[1]) && visible(element) && outsideContent(element)
          && (!composerRoots.length || composerRoots.some((root): boolean => root.contains(element)));
      };
      const ratioOptions = (root: HTMLElement): boolean => {
        const labels = Array.from(root.querySelectorAll<HTMLElement>('[role="option"],[role="menuitem"],[role="menuitemradio"],[role="radio"],button,[role="button"],label,li,div,span,p'))
          .filter((element): boolean => visible(element) && outsideContent(element)).map((element): string | undefined => ratio(text(element))).filter((label): label is string => !!label);
        return new Set(labels).size >= 2;
      };
      const overlay = (element: HTMLElement): boolean => {
        if (element === document.body || element === document.documentElement || composerRoots.includes(element) || !visible(element) || !outsideContent(element)) return false;
        const style = window.getComputedStyle(element);
        return element.matches('[role="menu"],[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper],[data-state="open"][data-side]')
          || style.position === 'fixed' || style.position === 'absolute';
      };
      const popupRoots = (): HTMLElement[] => {
        const hasDuration = (root: HTMLElement): boolean => Array.from(root.querySelectorAll<HTMLElement>('input[type="range"],[role="slider"]'))
          .some((element): boolean => visible(element) && outsideContent(element));
        let triggers = innermost(Array.from(document.querySelectorAll<HTMLElement>('[data-creation-params-panel-id]')).filter(isParameterTrigger));
        if (!triggers.length) triggers = innermost(composerRoots.flatMap((root): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>('button,[role="button"],[aria-haspopup]')).filter(isParameterTrigger)));
        if (triggers.length > 1) return [];
        const associated = (root: HTMLElement): boolean => !triggers.some((trigger): boolean => root === trigger || root.contains(trigger))
          && triggers.every((trigger): boolean => {
            const bounds = root.getBoundingClientRect(); const anchor = trigger.getBoundingClientRect();
            return Math.max(0, bounds.left - anchor.right, anchor.left - bounds.right, bounds.top - anchor.bottom, anchor.top - bounds.bottom) <= 96;
          });
        const owned = triggers.flatMap((trigger): HTMLElement[] => `${trigger.getAttribute('aria-controls') || ''} ${trigger.getAttribute('aria-owns') || ''}`.trim().split(/\s+/)
          .flatMap((id): HTMLElement[] => {
            const root = id ? document.getElementById(id) : null;
            return root && root !== trigger && !root.contains(trigger) && root !== document.body && root !== document.documentElement && !composerRoots.includes(root) && visible(root) && outsideContent(root) ? [root] : [];
          }));
        const ownedWithDuration = owned.filter(hasDuration);
        if (ownedWithDuration.length) return innermost(ownedWithDuration);
        const roots = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"],[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper],[data-state="open"][data-side]'))
          .filter((root): boolean => overlay(root) && associated(root) && ratioOptions(root) && hasDuration(root));
        if (!roots.length) for (const control of Array.from(document.querySelectorAll<HTMLElement>('input[type="range"],[role="slider"]')).filter((element): boolean => visible(element) && outsideContent(element))) {
          for (let ancestor = control.parentElement, depth = 0; ancestor && depth < 8; ancestor = ancestor.parentElement, depth++) {
            if (overlay(ancestor) && associated(ancestor) && ratioOptions(ancestor)) { roots.push(ancestor); break; }
          }
        }
        return innermost(roots);
      };
      type DurationControl = { element: HTMLElement; native: boolean; min: number; max: number; value: number; step: number };
      let failureReason: NonNullable<VideoDurationControlResult['failureReason']> = 'not_found';
      const readControlRange = (element: HTMLElement): Omit<DurationControl, 'element'> | undefined => {
        const native = element instanceof HTMLInputElement && element.type === 'range';
        const minText = element.getAttribute(native ? 'min' : 'aria-valuemin');
        const maxText = element.getAttribute(native ? 'max' : 'aria-valuemax');
        const valueText = native ? (element as HTMLInputElement).value : element.getAttribute('aria-valuenow');
        const stepText = element.getAttribute('step') || element.getAttribute('aria-valuestep') || '1';
        const min = Number(minText); const max = Number(maxText); const value = Number(valueText); const step = Number(stepText);
        // 只接受平台明确声明的秒数或 4 秒起算偏移，拒绝从像素、类名或无语义节点猜范围。
        if (!minText?.trim() || !maxText?.trim() || !valueText?.trim() || ![min, max, value, step].every(Number.isFinite)
          || !((min === 0 && max === 11) || (min === 4 && max === 15)) || step !== 1 || !Number.isInteger(value) || value < min || value > max) {
          return undefined;
        }
        return { native, min, max, value, step };
      };
      const readPopup = (): DurationControl | undefined => {
        const roots = popupRoots();
        if (roots.length !== 1) { failureReason = roots.length ? 'ambiguous' : 'menu_not_open'; return undefined; }
        const elements = Array.from(roots[0].querySelectorAll<HTMLElement>('input[type="range"],[role="slider"]')).filter((element): boolean => visible(element) && outsideContent(element));
        if (elements.length !== 1) { failureReason = elements.length ? 'ambiguous' : 'not_found'; return undefined; }
        const element = elements[0]; const range = readControlRange(element);
        if (!range) { failureReason = 'not_found'; return undefined; }
        const bounds = element.getBoundingClientRect();
        position = `${Math.round(bounds.left + bounds.width / 2)},${Math.round(bounds.top + bounds.height / 2)}`;
        for (let node: HTMLElement | null = element; node; node = node.parentElement) {
          const disabled = node.getAttribute('data-disabled');
          if ((node as HTMLInputElement).disabled || node.getAttribute('aria-disabled') === 'true' || node.getAttribute('aria-readonly') === 'true'
            || disabled === '' || disabled === 'true') { failureReason = 'disabled'; return undefined; }
        }
        return { element, ...range };
      };
      const controlIdentity = (control: DurationControl): string => `${control.native}:${control.min}:${control.max}:${control.step}:` + ['id', 'aria-label', 'aria-labelledby', 'aria-controls']
        .map((attribute): string => control.element.getAttribute(attribute) || '').join('\u0000');
      const stopped = (): VideoDurationControlResult => ({ position, verified: false, failureReason });
      let control = readPopup();
      if (!control) return stopped();
      const expectedIdentity = controlIdentity(control); const targetValue = control.min === 0 ? targetSeconds - 4 : targetSeconds;
      const currentPopup = (): DurationControl | undefined => {
        if (Date.now() >= deadlineAt) { failureReason = 'value_not_applied'; return undefined; }
        const current = readPopup();
        if (current && controlIdentity(current) !== expectedIdentity) { failureReason = 'changed'; return undefined; }
        return current;
      };
      const waitPopupValue = async (expected: number): Promise<DurationControl | undefined> => {
        while (Date.now() < deadlineAt) {
          await new Promise<void>((resolve): void => { setTimeout(resolve, 25); });
          const current = currentPopup();
          if (!current) return undefined;
          if (current.value === expected) return current;
        }
        failureReason = 'value_not_applied'; return undefined;
      };
      control = currentPopup();
      if (!control) return stopped();
      if (control.value === targetValue) return { position, verified: true };
      if (control.native) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!setter) return { position, verified: false, failureReason: 'not_found' };
        setter.call(control.element, String(targetValue));
        control.element.dispatchEvent(new Event('input', { bubbles: true }));
        if (control.element.isConnected) control.element.dispatchEvent(new Event('change', { bubbles: true }));
        control = await waitPopupValue(targetValue);
      } else {
        const pressPopup = (element: HTMLElement, key: string): void => {
          element.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
          element.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }));
        };
        pressPopup(control.element, 'Home');
        control = await waitPopupValue(control.min);
        for (let expected = (control?.min ?? targetValue) + 1; control && expected <= targetValue; expected++) {
          control = currentPopup();
          if (!control) break;
          pressPopup(control.element, 'ArrowRight');
          control = await waitPopupValue(expected);
        }
      }
      return control?.value === targetValue ? { position, verified: true } : stopped();
    };
    // 新版创作栏存在时必须读取它拥有的参数弹层；页面其余滑条不能冒充视频时长。
    if (Array.from(document.querySelectorAll<HTMLElement>('#input-engine-container,.guidance-input-surface,[data-testid="guidance-input-surface"]')).some(visible)) return await setPopupControl();
    let standaloneFailure: NonNullable<VideoDurationControlResult['failureReason']> = 'not_found';
    const read = (): HTMLElement | undefined => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('[role="slider"][aria-valuemin="0"][aria-valuemax="11"]')).filter((element): boolean => visible(element) && outsideContent(element) && !(element instanceof HTMLInputElement && element.type === 'range'));
      if (candidates.length !== 1) { standaloneFailure = candidates.length ? 'ambiguous' : 'not_found'; return undefined; }
      const slider = candidates[0];
      const bounds = slider.getBoundingClientRect();
      position = `${Math.round(bounds.left + bounds.width / 2)},${Math.round(bounds.top + bounds.height / 2)}`;
      for (let current: HTMLElement | null = slider; current; current = current.parentElement) {
        const disabled = current.getAttribute('data-disabled');
        if ((current as HTMLInputElement).disabled || current.getAttribute('aria-disabled') === 'true' || current.getAttribute('aria-readonly') === 'true'
          || disabled === '' || disabled === 'true') { standaloneFailure = 'disabled'; return undefined; }
      }
      const value = slider.getAttribute('aria-valuenow');
      if (value === null || !/^\d+$/.test(value) || Number(value) > 11) return undefined;
      return slider;
    };
    const identity = (slider: HTMLElement): string => ['id', 'aria-label', 'aria-labelledby', 'aria-controls']
      .map((attribute): string => slider.getAttribute(attribute) || '').join('\u0000');
    let slider = read();
    if (!slider) return standaloneFailure === 'not_found' && !position ? await setPopupControl() : { position, verified: false, failureReason: standaloneFailure };
    const semanticIdentity = identity(slider);
    const current = (): HTMLElement | undefined => {
      if (Date.now() >= deadlineAt) { standaloneFailure = 'value_not_applied'; return undefined; }
      const candidate = read();
      if (candidate && identity(candidate) !== semanticIdentity) { standaloneFailure = 'changed'; return undefined; }
      return candidate;
    };
    const press = (element: HTMLElement, key: string): void => {
      // 事件只发给已定位的控件；不获取系统焦点，不触碰鼠标或原生键盘。
      element.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }));
    };
    const waitForValue = async (expected: number): Promise<HTMLElement | undefined> => {
      while (Date.now() < deadlineAt) {
        // 必须让出宏任务；同一脚本同步连发会让受控滑条反复使用同一旧值。
        await new Promise<void>((resolve): void => { setTimeout(resolve, 25); });
        const candidate = current();
        if (!candidate) return undefined;
        if (Number(candidate.getAttribute('aria-valuenow')) === expected) return candidate;
      }
      standaloneFailure = 'value_not_applied';
      return undefined;
    };
    slider = current();
    if (!slider) return { position, verified: false, failureReason: standaloneFailure };
    press(slider, 'Home');
    slider = await waitForValue(0);
    if (!slider) return { position, verified: false, failureReason: standaloneFailure };
    for (let expected = 1; expected <= targetSeconds - 4; expected++) {
      slider = current();
      if (!slider) return { position, verified: false, failureReason: standaloneFailure };
      press(slider, 'ArrowRight');
      slider = await waitForValue(expected);
      if (!slider) return { position, verified: false, failureReason: standaloneFailure };
    }
    return { position };
  } catch { return position ? { position } : {}; }
}
