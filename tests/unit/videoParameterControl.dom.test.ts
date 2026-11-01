import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureVideoOptions } from '../../src/utils/doubaoBridge';
import { videoParameterControlFromPage } from '../../src/utils/videoParameterControl';
import type { VideoControlReadinessResult } from '../../src/utils/videoControlReadiness';

interface Rect { left: number; top: number; width: number; height: number }
interface Fixture {
  composer: HTMLDivElement; trigger: HTMLButtonElement; model: HTMLButtonElement; menu: HTMLDivElement;
  ratio: HTMLButtonElement; range: HTMLInputElement; opens: () => number;
}

function geometry(element: HTMLElement, bounds: Rect = { left: 100, top: 100, width: 500, height: 500 }): void {
  element.getBoundingClientRect = (): DOMRect => ({ ...bounds, x: bounds.left, y: bounds.top,
    right: bounds.left + bounds.width, bottom: bounds.top + bounds.height, toJSON: (): object => ({}) });
}

/** 离线复刻当前参数浮层：真实 pointerdown 打开，click() 本身不会打开菜单。 */
function fixture(options: { closeAfterRatio?: boolean; min?: number; max?: number; ratioText?: string; ignoreRatio?: boolean } = {}): Fixture {
  const composer = document.createElement('div'); composer.id = 'input-engine-container'; geometry(composer, { left: 0, top: 610, width: 900, height: 100 });
  const model = document.createElement('button'); model.setAttribute('data-input-engine-actionbar-control-key', 'video-model'); model.textContent = '模型 Seedance 2.0'; geometry(model, { left: 80, top: 630, width: 180, height: 40 });
  const trigger = document.createElement('button'); trigger.setAttribute('data-creation-params-panel-id', 'TEST-params'); trigger.setAttribute('aria-controls', 'TEST-parameters'); geometry(trigger, { left: 300, top: 630, width: 180, height: 40 });
  composer.append(model, trigger); document.body.append(composer);
  const menu = document.createElement('div'); menu.id = 'TEST-parameters'; menu.setAttribute('role', 'menu'); menu.style.display = 'none'; menu.style.position = 'fixed'; geometry(menu, { left: 250, top: 230, width: 300, height: 380 });
  const auto = document.createElement('button'); auto.textContent = '自动'; geometry(auto, { left: 270, top: 250, width: 240, height: 40 });
  const ratio = document.createElement('button'); ratio.textContent = options.ratioText ?? '9:16'; geometry(ratio, { left: 270, top: 310, width: 240, height: 40 });
  const range = document.createElement('input'); range.type = 'range'; range.min = String(options.min ?? 4); range.max = String(options.max ?? 15); range.value = String((options.min ?? 4) === 0 ? 6 : 10); range.step = '1'; geometry(range, { left: 270, top: 400, width: 240, height: 40 });
  let opens = 0; let ratioValue = '自动';
  const render = (): void => { trigger.textContent = `${ratioValue} · ${Number(range.value) + (range.min === '0' ? 4 : 0)}s`; };
  trigger.addEventListener('pointerdown', (): void => { opens++; menu.style.display = menu.style.display === 'none' ? 'block' : 'none'; });
  ratio.addEventListener('pointerdown', (): void => {
    if (!options.ignoreRatio) ratioValue = '9:16'; render(); if (options.closeAfterRatio) menu.style.display = 'none';
  });
  range.addEventListener('input', render); menu.append(auto, ratio, range); document.body.append(menu); render();
  return { composer, trigger, model, menu, ratio, range, opens: (): number => opens };
}

beforeEach((): void => {
  vi.spyOn(document, 'elementFromPoint').mockImplementation((x: number, y: number): Element | null => {
    const matching = Array.from(document.querySelectorAll<HTMLElement>('*')).filter((element): boolean => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0 || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return false;
      for (let node: HTMLElement | null = element; node; node = node.parentElement) if (window.getComputedStyle(node).display === 'none') return false;
      return true;
    });
    return matching.at(-1) ?? null;
  });
});
afterEach((): void => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('参数浮层使用当前可见控件及完整指针事件', (): void => {
  it('发送 pointerdown 打开真实新菜单，再选比例并读回当前值', (): void => {
    const page = fixture(); page.trigger.click(); expect(page.opens()).toBe(0);
    expect(videoParameterControlFromPage({ operation: 'parameters_trigger', expected: '9:16', activate: true }).activated).toBe(true);
    expect(page.opens()).toBe(1);
    expect(videoParameterControlFromPage({ operation: 'ratio_option', expected: '9:16', activate: true })).toMatchObject({ menuOpen: true, activated: true });
    expect(videoParameterControlFromPage({ operation: 'snapshot' })).toMatchObject({ ratio: '9:16', duration: 10 });
  });

  it('NFKC 将全角比例、分隔符及秒数归一化', (): void => {
    const page = fixture({ ratioText: '９：１６ 竖屏' }); page.trigger.textContent = '９：１６ · １０ｓ'; page.menu.style.display = 'block';
    expect(videoParameterControlFromPage({ operation: 'snapshot' })).toMatchObject({ ratio: '9:16', duration: 10 });
    expect(videoParameterControlFromPage({ operation: 'ratio_option', expected: '9:16', activate: true }).activated).toBe(true);
  });

  it('隐藏重复菜单、历史聊天文字和其比例按钮不参与当前选项定位', (): void => {
    const page = fixture(); page.menu.style.display = 'block';
    const hidden = page.menu.cloneNode(true) as HTMLDivElement; hidden.id = 'TEST-hidden'; hidden.style.display = 'none'; document.body.append(hidden);
    for (const element of hidden.querySelectorAll<HTMLElement>('*')) geometry(element);
    const history = document.createElement('div'); history.setAttribute('data-testid', 'receive_message'); geometry(history, { left: 0, top: 0, width: 100, height: 100 }); const duplicate = document.createElement('button'); duplicate.textContent = '9:16'; geometry(duplicate, { left: 0, top: 0, width: 100, height: 100 }); history.append(duplicate); document.body.append(history);
    const click = vi.fn(); duplicate.addEventListener('pointerdown', click);
    expect(videoParameterControlFromPage({ operation: 'ratio_option', expected: '9:16', activate: true }).activated).toBe(true); expect(click).not.toHaveBeenCalled();
  });

  it('菜单未打开、可见重复、禁用、遮挡分别给出准确诊断且不派发事件', (): void => {
    const page = fixture(); const pointer = vi.fn(); page.ratio.addEventListener('pointerdown', pointer);
    expect(videoParameterControlFromPage({ operation: 'ratio_option', expected: '9:16', activate: true }).failureReason).toBe('menu_not_open');
    page.menu.style.display = 'block'; const duplicate = page.ratio.cloneNode(true) as HTMLButtonElement; geometry(duplicate, { left: 270, top: 460, width: 240, height: 40 }); page.menu.append(duplicate);
    expect(videoParameterControlFromPage({ operation: 'ratio_option', expected: '9:16', activate: true }).failureReason).toBe('ambiguous'); duplicate.remove();
    page.ratio.disabled = true; expect(videoParameterControlFromPage({ operation: 'ratio_option', expected: '9:16', activate: true }).failureReason).toBe('disabled'); page.ratio.disabled = false;
    vi.mocked(document.elementFromPoint).mockReturnValue(document.body); expect(videoParameterControlFromPage({ operation: 'ratio_option', expected: '9:16', activate: true }).failureReason).toBe('covered'); expect(pointer).not.toHaveBeenCalled();
  });

  it('两个独立参数入口拒绝猜测', (): void => {
    const page = fixture(); const duplicate = page.trigger.cloneNode(true) as HTMLButtonElement; geometry(duplicate, { left: 500, top: 630, width: 180, height: 40 }); page.composer.append(duplicate);
    expect(videoParameterControlFromPage({ operation: 'parameters_trigger', expected: '9:16', activate: true }).failureReason).toBe('ambiguous'); expect(page.opens()).toBe(0);
  });
});

describe('configureVideoOptions 当前页面序列化回归', (): void => {
  it.each([false, true])('比例菜单在选择后关闭=%s；时长设置成功且不重复toggle已打开菜单', async (closeAfterRatio: boolean): Promise<void> => {
    vi.useFakeTimers(); const page = fixture({ closeAfterRatio }); const reports: VideoControlReadinessResult[] = [];
    const executeJavaScript = vi.fn(async (code: string): Promise<unknown> => new Function(`return ${code}`)() as unknown);
    const result = configureVideoOptions({ executeJavaScript, getURL: (): string => '', loadURL: (): void => undefined }, { model: 'seedance-2.0', aspectRatio: '9:16', duration: '5s' }, { onReadiness: (report): void => { reports.push(report); } });
    await vi.advanceTimersByTimeAsync(12_000); await expect(result).resolves.toBeUndefined();
    expect(page.opens()).toBe(closeAfterRatio ? 2 : 1); expect(page.trigger.textContent).toBe('9:16 · 5s'); expect(reports.at(-1)?.ready).toBe(true);
  });

  it('比例未生效时停在明确回读错误，耗时和尝试次数来自真实过程', async (): Promise<void> => {
    vi.useFakeTimers(); const page = fixture({ ignoreRatio: true });
    const executeJavaScript = vi.fn(async (code: string): Promise<unknown> => new Function(`return ${code}`)() as unknown);
    const outcome = configureVideoOptions({ executeJavaScript, getURL: (): string => '', loadURL: (): void => undefined }, { model: 'seedance-2.0', aspectRatio: '9:16', duration: '5s' }).catch((error: unknown): unknown => error);
    await vi.advanceTimersByTimeAsync(15_000); const error = await outcome;
    expect(error).toMatchObject({ diagnostic: { failureStage: 'aspect_ratio', controlOperation: 'readback', failureReason: 'value_not_applied', elapsedMs: expect.any(Number), attempts: expect.any(Number) } });
    const diagnostic = (error as { diagnostic: VideoControlReadinessResult }).diagnostic; expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(10_000); expect(diagnostic.attempts).toBeGreaterThan(3); expect(page.range.value).toBe('10');
  });
});
