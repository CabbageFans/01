/** 只由原 doubaoBridge 序列化到 guest。每次重新定位当前输入区，不保存跨会话元素编号。 */
export interface PetStoryComposerSnapshot {
  present: boolean;
  generic: boolean;
  first: boolean;
  last: boolean;
  nativeLabel: boolean;
  firstLabel: boolean;
  free: 'free' | 'paid' | 'exhausted' | 'unknown';
  model: string;
  duration: number;
  aspectRatio: string;
  durations: number[];
  count: number;
  pending: boolean;
  uploaded?: boolean;
}
export interface PetStoryComposerOperation {
  slot?: 'reference' | 'first_frame' | 'last_frame';
  file?: { name: string; base64: string; mime: string };
  openDurations?: boolean;
  selectMode?: 'first_frame' | 'first_last_frame' | 'reference';
}
export function petStoryComposerProbe(operation: PetStoryComposerOperation = {}): PetStoryComposerSnapshot {
  const visible = (el: Element | null): boolean => {
    if (!el) return false;
    for (let current: Element | null = el; current; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || current.getAttribute('aria-hidden') === 'true') return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const text = (el: Element): string => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const editor = Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).find(visible);
  let root = editor?.closest('[data-testid="guidance-input-surface"],.guidance-input-surface') || null;
  if (!root && editor) {
    let candidate: Element | null = editor.parentElement;
    for (let depth = 0; candidate && candidate !== document.body && depth < 7; depth++, candidate = candidate.parentElement) {
      if (candidate.querySelector('input[type="file"]')) { root = candidate; break; }
    }
  }
  const empty: PetStoryComposerSnapshot = { present: false, generic: false, first: false, last: false, nativeLabel: false, firstLabel: false, free: 'unknown', model: '', duration: 0, aspectRatio: '', durations: [], count: 0, pending: false };
  if (!root || !visible(root)) return empty;
  // file input 通常隐藏，只有带可见父容器且不在隐藏菜单中的 input 才可用于绑定。
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter((input): boolean => {
    if (!/image|\.png|\.jpg|\.webp|\*/i.test(input.accept || 'image/*')) return false;
    // file input 可以处于零高度包装层；判断祖先隐藏状态，不能用该层的几何尺寸证明不可用。
    for (let parent = input.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || parent.getAttribute('aria-hidden') === 'true') return false;
    }
    return !input.closest('[role="menu"],[role="dialog"],[aria-hidden="true"]');
  });
  const slotRoot = (label: RegExp): Element | undefined => {
    const containers: Element[] = [];
    for (const input of inputs) {
      let parent: Element | null = input.parentElement;
      for (let depth = 0; parent && root.contains(parent) && depth < 5; depth++, parent = parent.parentElement) {
        if (parent.querySelectorAll('input[type="file"]').length !== 1) break;
        const ownLabel = [parent.getAttribute('aria-label'), parent.getAttribute('data-slot'), text(parent)].filter(Boolean).join(' ');
        if (label.test(ownLabel) && visible(parent)) { containers.push(parent); break; }
      }
    }
    return containers.length === 1 ? containers[0] : undefined;
  };
  if (operation.selectMode) {
    const labels = operation.selectMode === 'first_last_frame' ? ['首尾帧'] : operation.selectMode === 'first_frame' ? ['首帧', '首帧生成'] : ['参考图', '参考图生成'];
    const controls = Array.from(root.querySelectorAll<HTMLElement>('button,[role="button"],[role="tab"],[role="radio"]')).filter((el): boolean => visible(el) && labels.includes(text(el)));
    if (controls.length === 1) controls[0].click();
  }
  const first = slotRoot(/(?:^|\s)(?:首帧|起始帧|first[_ -]?frame)(?:\s|$)/i);
  const last = slotRoot(/(?:^|\s)(?:尾帧|结束帧|last[_ -]?frame|end[_ -]?frame)(?:\s|$)/i);
  const generic = inputs.length === 1 && !first && !last;
  const target = operation.slot === 'first_frame' ? first : operation.slot === 'last_frame' ? last : generic ? root : undefined;
  const images = (container: Element): Element[] => [...new Set(Array.from(container.querySelectorAll<HTMLImageElement>('img')).filter((img): boolean => {
    const rect = img.getBoundingClientRect();
    return visible(img) && rect.width >= 40 && rect.height >= 40 && img.complete && img.naturalWidth > 32 && !/svg|icon|avatar/i.test(img.src);
  }).map((img): Element => img.closest('[data-testid="mdbox_image"],[data-testid="image-upload-item"],[data-testid="reference-image"]') || img))];
  const pending = (container: Element): boolean => Array.from(container.querySelectorAll('[aria-busy="true"],[data-status="uploading"],[class*="uploading"],[class*="progress"]')).some(visible);
  const readParameters = (): Pick<PetStoryComposerSnapshot, 'free' | 'model' | 'duration' | 'aspectRatio' | 'durations' | 'nativeLabel' | 'firstLabel'> => {
    const composite = Array.from(document.querySelectorAll('[data-creation-params-panel-id]')).find(visible);
  if (operation.openDurations && composite && visible(composite)) (composite as HTMLElement).click();
  const model = Array.from(document.querySelectorAll('[data-input-engine-actionbar-control-key="video-model"]')).find(visible);
  const compositeMatch = composite && visible(composite) ? text(composite).match(/^(自动|[0-9]+:[0-9]+)\s*·\s*([0-9]+)s$/) : null;
  const visibleText = Array.from(root.querySelectorAll('button,[role="button"],[role="tab"],label,span')).filter(visible).map(text).join(' ');
  const alerts = Array.from(document.querySelectorAll('[role="dialog"],[role="alert"],[class*="toast"],iframe')).filter(visible).map((el): string => `${text(el)} ${el.getAttribute('title') || ''}`).join(' ');
  const selectedPaid = Array.from(root.querySelectorAll('[aria-selected="true"],[aria-checked="true"],[data-state="checked"],[data-state="active"],[data-input-engine-actionbar-control-key="video-model"],[data-creation-params-panel-id]')).filter(visible).some((el): boolean => /会员专享|升级会员|开通会员|付费|购买|订阅/.test(text(el)));
  const free = /额度不足|积分不足|余额不足|次数已用完|今日次数用尽|免费次数不足|免费次数.*(?:0|零)/.test(`${visibleText} ${alerts}`) ? 'exhausted'
    : (selectedPaid || /升级会员|开通会员|会员专享|购买|订阅|付费/.test(alerts)) ? 'paid' : /(?:本次|当前|生成|剩余).*免费|免费生成/.test(visibleText) ? 'free' : 'unknown';
  const durationNodes = Array.from(document.querySelectorAll('[role="option"],[role="menuitem"],[data-state],button')).filter(visible);
  const durations = [...new Set([...(compositeMatch ? [Number(compositeMatch[2])] : []), ...durationNodes.flatMap((el): number[] => {
    const match = text(el).match(/^(\d+)\s*(?:s|秒)$/);
    return match && !/会员|付费/.test(text(el.parentElement || el)) && el.getAttribute('aria-disabled') !== 'true' ? [Number(match[1])] : [];
  })])];
    return { free, model: model && visible(model) ? text(model).replace(/^模型\s*/, '') : '', duration: compositeMatch ? Number(compositeMatch[2]) : 0, aspectRatio: compositeMatch?.[1] || '', durations, nativeLabel: /首尾帧/.test(visibleText), firstLabel: /首帧/.test(visibleText) };
  };
  let uploaded = false;
  if (operation.file && target) {
    const input = operation.slot === 'reference' ? inputs[0] : target.querySelector<HTMLInputElement>('input[type="file"]');
    if (input && !input.disabled) {
      const bytes = Uint8Array.from(atob(operation.file.base64), (value: string): number => value.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], operation.file.name, { type: operation.file.mime }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      uploaded = true;
    }
  }
  return { ...readParameters(), present: true, generic, first: !!first, last: !!last && first !== last,
    count: target ? images(target).length : images(root).length, pending: pending(target || root), uploaded };
}
