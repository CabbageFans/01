/** 自包含 guest 操作：每次按键后跨宏任务回读真实滑条，避免 React 批处理吞掉连续步进。 */
export async function setVideoDurationFromPage(targetSeconds: number, deadlineAt: number): Promise<{ position?: string }> {
  let position: string | undefined;
  try {
    if (!Number.isInteger(targetSeconds) || targetSeconds < 4 || targetSeconds > 15 || !Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) return {};
    const visible = (element: HTMLElement): boolean => {
      const bounds = element.getBoundingClientRect();
      if (!element.isConnected || element.offsetParent === null || bounds.width <= 0 || bounds.height <= 0
        || bounds.right <= 0 || bounds.bottom <= 0 || bounds.left >= window.innerWidth || bounds.top >= window.innerHeight) return false;
      for (let current: HTMLElement | null = element; current; current = current.parentElement) {
        const style = window.getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false;
      }
      return true;
    };
    const read = (): HTMLElement | undefined => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('[role="slider"][aria-valuemin="0"][aria-valuemax="11"]')).filter(visible);
      if (candidates.length !== 1) return undefined;
      const slider = candidates[0];
      const bounds = slider.getBoundingClientRect();
      position = `${Math.round(bounds.left + bounds.width / 2)},${Math.round(bounds.top + bounds.height / 2)}`;
      for (let current: HTMLElement | null = slider; current; current = current.parentElement) {
        if ((current as HTMLInputElement).disabled || current.getAttribute('aria-disabled') === 'true' || current.getAttribute('data-disabled') === 'true') return undefined;
      }
      const value = slider.getAttribute('aria-valuenow');
      if (value === null || !/^\d+$/.test(value) || Number(value) > 11) return undefined;
      return slider;
    };
    const identity = (slider: HTMLElement): string => ['id', 'aria-label', 'aria-labelledby', 'aria-controls']
      .map((attribute): string => slider.getAttribute(attribute) || '').join('\u0000');
    let slider = read();
    if (!slider) return position ? { position } : {};
    const semanticIdentity = identity(slider);
    const current = (): HTMLElement | undefined => {
      if (Date.now() >= deadlineAt) return undefined;
      const candidate = read();
      return candidate && identity(candidate) === semanticIdentity ? candidate : undefined;
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
      return undefined;
    };
    slider = current();
    if (!slider) return { position };
    press(slider, 'Home');
    slider = await waitForValue(0);
    if (!slider) return { position };
    for (let expected = 1; expected <= targetSeconds - 4; expected++) {
      slider = current();
      if (!slider) return { position };
      press(slider, 'ArrowRight');
      slider = await waitForValue(expected);
      if (!slider) return { position };
    }
    return { position };
  } catch { return position ? { position } : {}; }
}
