export interface HumanVerificationEvidence {
  visibleLayerText?: string;
  iframeSources?: string[];
}

export class HumanVerificationRequiredError extends Error {
  readonly code = 'human_verification';
  constructor() { super('当前页面需要人工完成人机验证；未继续激活页面控件'); this.name = 'HumanVerificationRequiredError'; }
}

/** 只消费当前可见验证层；正文中的讨论、提示词或历史回复不是验证证据。 */
export function hasHumanVerificationEvidence(evidence: HumanVerificationEvidence): boolean {
  const sources = (evidence.iframeSources || []).join('\n').toLowerCase();
  const text = (evidence.visibleLayerText || '').toLowerCase();
  return ['captcha', 'verify', 'challenge', 'secsdk'].some((part: string): boolean => sources.includes(part))
    || ['请完成验证', '安全验证', '机器人验证', '拖动滑块', '点击进行验证', '验证后继续', '人机验证', 'verify to continue', 'security verification']
      .some((phrase: string): boolean => text.includes(phrase));
}

/** 自包含只读 DOM 探针，供账号可用性与发送／观察阶段共用。 */
export function readHumanVerificationEvidence(doc: Document, win: Window): HumanVerificationEvidence {
  const visible = (element: Element): boolean => {
    const bounds = element.getBoundingClientRect();
    if (bounds.width < 20 || bounds.height < 20 || bounds.right <= 0 || bounds.bottom <= 0 || bounds.left >= win.innerWidth || bounds.top >= win.innerHeight) return false;
    if (element.closest('[data-testid="send_message"],[data-testid="receive_message"],textarea,[contenteditable="true"],[contenteditable=""]')) return false;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = win.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number.parseFloat(style.opacity || '1') === 0
        || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert')) return false;
    }
    return true;
  };
  const layers = Array.from(doc.querySelectorAll('[role="dialog"],[role="alert"],[class*="captcha"],[class*="verify"],[class*="Verify"]')).filter(visible);
  const frames = Array.from(doc.querySelectorAll<HTMLIFrameElement>('iframe')).filter(visible);
  return {
    visibleLayerText: layers.map((element): string => String((element as HTMLElement).innerText || element.textContent || '').slice(0, 1000)).join('\n'),
    iframeSources: frames.map((frame): string => String(frame.src || '').slice(0, 1000)),
  };
}

function verificationWait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('任务已取消', 'AbortError'));
  return new Promise<void>((resolve, reject): void => {
    const aborted = (): void => { clearTimeout(timer); reject(new DOMException('任务已取消', 'AbortError')); };
    const timer = setTimeout((): void => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/** 只读长观察同时检查验证；验证出现即停止观察，绝不导航、点击或重发。 */
export async function observeWithHumanVerification<T>(
  observe: (signal: AbortSignal) => Promise<T>,
  check: () => Promise<void>,
  signal?: AbortSignal,
  intervalMs: number = 1000,
): Promise<T> {
  const controller = new AbortController();
  const aborted = (): void => controller.abort();
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    if (controller.signal.aborted) throw new DOMException('任务已取消', 'AbortError');
    await check();
    const watch = async (): Promise<never> => {
      while (!controller.signal.aborted) {
        await verificationWait(intervalMs, controller.signal);
        await check();
      }
      throw new DOMException('任务已取消', 'AbortError');
    };
    try {
      const value = await Promise.race([observe(controller.signal), watch()]);
      await check();
      return value;
    } catch (error: unknown) {
      if (!signal?.aborted) await check();
      throw error;
    }
  } finally {
    controller.abort();
    signal?.removeEventListener('abort', aborted);
  }
}
