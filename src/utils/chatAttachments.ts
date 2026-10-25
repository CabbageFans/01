import type { UploadReadinessDiagnostic, UploadReadinessSnapshot } from './uploadReadiness';
import { classifyUploadReadinessFailure, getObservedUploadCount, nextStableUploadCount } from './uploadReadiness';

interface ChatImage { name: string; base64: string; mime: string }
type AttachmentFailure = 'editor_missing' | 'input_missing' | 'input_ambiguous' | 'multiple_unsupported' | 'file_read_failed' | 'page_unreadable' | 'injection_failed' | 'upload_failed' | 'readback_timeout';
interface ChatAttachmentSnapshot extends UploadReadinessSnapshot { error?: AttachmentFailure }
interface ChatAttachmentPageResult extends ChatAttachmentSnapshot { injected?: boolean }
const failureLabels: Record<AttachmentFailure, string> = {
  editor_missing: '当前普通 Chat 输入框缺失或不唯一', input_missing: '当前输入区没有可用的图片上传入口',
  input_ambiguous: '当前输入区的图片上传入口不唯一', multiple_unsupported: '当前上传入口不支持一次接收全部参考图',
  file_read_failed: '项目参考图读取不完整', page_unreadable: '无法读取当前附件状态', injection_failed: '参考图未能加入当前输入区',
  upload_failed: '页面报告附件上传失败', readback_timeout: '附件未在等待时间内全部上传就绪',
};
export class ChatAttachmentUploadError extends Error {
  readonly code = 'chat_assets_not_ready';
  constructor(readonly reason: AttachmentFailure, diagnostic?: UploadReadinessDiagnostic) {
    super(`chat_assets_not_ready: ${failureLabels[reason]}${diagnostic ? `（${diagnostic.observedCount}/${diagnostic.expectedCount}，${diagnostic.elapsedMs}ms/${diagnostic.attempts}次）` : ''}，已在提交前停止；可在萌宠短剧中重试未提交的原任务`);
    this.name = 'ChatAttachmentUploadError';
  }
}

/** 在 guest 中独立执行：只认当前编辑器的最小共同输入区，不扫描整页隐藏菜单。 */
function chatAttachmentPage(operation: 'inspect' | 'inject', files: ChatImage[]): ChatAttachmentPageResult {
  const empty: ChatAttachmentPageResult = { inputFileCount: 0, visibleAttachmentCount: 0, matchingFileNameCount: 0, pending: false };
  const visible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const editors = Array.from(document.querySelectorAll<HTMLElement>('textarea,[contenteditable="true"]')).filter(visible);
  if (editors.length !== 1) return { ...empty, error: 'editor_missing' };
  // 上传后编辑器内会出现另一个 file input，不能每轮以“最近 input”重新缩小观察范围。
  // 普通 Chat 的稳定 surface 同时包含附件栏和编辑区；与动态添加图按钮分开定位。
  const surface = editors[0].closest<HTMLElement>('.guidance-input-surface');
  let root = surface || editors[0].parentElement;
  let candidates: HTMLInputElement[] = [];
  // 上传 input 通常自身 hidden；可见性约束放在共同输入区，不能要求 input 可见。
  while (root && root !== document.body) {
    candidates = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter((input: HTMLInputElement): boolean => {
      if (input.disabled || !input.isConnected) return false;
      // SPA 会把隐藏的上传菜单搬进 surface。input 自身可隐藏，但其菜单祖先不可隐藏。
      for (let parent = input.parentElement; parent && parent !== root; parent = parent.parentElement) {
        const style = window.getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      const accept = input.accept.toLowerCase().split(',').map((token: string): string => token.trim());
      return !input.accept || files.every((file: ChatImage): boolean => accept.includes('image/*') || accept.includes(file.mime.toLowerCase()) || accept.includes(`.${file.name.split('.').pop()?.toLowerCase()}`));
    });
    if (candidates.length || surface) break;
    root = root.parentElement;
  }
  if (!root || root === document.body || !visible(root)) return { ...empty, error: 'input_missing' };
  if (operation === 'inject') {
    if (!candidates.length) return { ...empty, error: 'input_missing' };
    if (candidates.length !== 1) return { ...empty, error: 'input_ambiguous' };
    const input = candidates[0];
    if (files.length > 1 && !input.multiple) return { ...empty, error: 'multiple_unsupported' };
    try {
      const transfer = new DataTransfer();
      for (const file of files) {
        const binary = atob(file.base64);
        const bytes = Uint8Array.from(binary, (char: string): number => char.charCodeAt(0));
        transfer.items.add(new File([bytes], file.name, { type: file.mime }));
      }
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ...empty, injected: true };
    } catch { return { ...empty, error: 'injection_failed' }; }
  }
  // 实页每个附件卡含模糊占位和实际图两个 img；按 mdbox_image 卡片计数才能既不漏计也不双计。
  const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="mdbox_image"]')).filter(visible);
  const text = cards.map((card: HTMLElement): string => [card.innerText, ...Array.from(card.querySelectorAll<HTMLImageElement>('img')).map((image: HTMLImageElement): string => `${image.alt} ${image.title}`)].join(' ')).join(' ');
  const pending = Array.from(root.querySelectorAll('[aria-busy="true"],[class*="uploading"],[class*="progress"],[class*="loading"],[data-status="uploading"]')).some(visible);
  const failed = Array.from(root.querySelectorAll('[data-status="error"],[class*="upload-error"],[class*="uploadError"]')).some(visible);
  return { ...empty, visibleAttachmentCount: cards.length, matchingFileNameCount: files.filter((file: ChatImage): boolean => text.includes(file.name)).length,
    pending, error: failed ? 'upload_failed' : undefined };
}

export function chatAttachmentScript(operation: 'inspect' | 'inject', files: ChatImage[]): string {
  return `(${chatAttachmentPage.toString()})(${JSON.stringify(operation)},${JSON.stringify(files)})`;
}

/** 单次注入后只读等待；超时／失败绝不重注入、补图或跳过附件发送。 */
export async function uploadChatImages(
  view: { executeJavaScript: (code: string) => Promise<unknown> }, files: ChatImage[],
  options: { timeoutMs?: number; stableSamples?: number; onProgress?: (diagnostic: UploadReadinessDiagnostic) => void | Promise<void> },
): Promise<boolean> {
  const startedAt = Date.now();
  const execute = async (operation: 'inspect' | 'inject'): Promise<ChatAttachmentPageResult> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        view.executeJavaScript(chatAttachmentScript(operation, operation === 'inject' ? files : files.map((file: ChatImage): ChatImage => ({ ...file, base64: '' })))) as Promise<ChatAttachmentPageResult>,
        new Promise<never>((_resolve, reject): void => { timer = setTimeout((): void => reject(new ChatAttachmentUploadError('page_unreadable')), 5000); }),
      ]);
    } catch (error: unknown) { throw error instanceof ChatAttachmentUploadError ? error : new ChatAttachmentUploadError('page_unreadable'); }
    finally { if (timer) clearTimeout(timer); }
  };
  const baseline = await execute('inspect');
  if (baseline.error) throw new ChatAttachmentUploadError(baseline.error);
  // 新会话必须没有已有附件；避免把用户草稿或另一批附件算成本次上传。
  if (baseline.visibleAttachmentCount || baseline.matchingFileNameCount || baseline.pending) throw new ChatAttachmentUploadError('upload_failed');
  const injected = await execute('inject');
  if (!injected.injected || injected.error) throw new ChatAttachmentUploadError(injected.error || 'injection_failed');
  const timeoutMs = Math.max(30_000, Math.min(options.timeoutMs || 180_000, 300_000));
  const required = Math.max(3, options.stableSamples || 3);
  let stable = 0;
  let diagnostic: UploadReadinessDiagnostic = { attempts: 0, elapsedMs: 0, expectedCount: files.length, observedCount: 0, pending: true, stableSamples: 0, failure: 'pending' };
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise<void>((resolve): void => { setTimeout(resolve, 750); });
    const snapshot = await execute('inspect');
    if (snapshot.error) throw new ChatAttachmentUploadError(snapshot.error, diagnostic);
    stable = nextStableUploadCount(stable, snapshot, files.length, 0);
    diagnostic = { attempts: diagnostic.attempts + 1, elapsedMs: Date.now() - startedAt, expectedCount: files.length,
      observedCount: getObservedUploadCount(snapshot, 0), pending: snapshot.pending, stableSamples: stable,
      failure: stable >= required ? undefined : classifyUploadReadinessFailure(snapshot, files.length, 0) || 'unstable' };
    await options.onProgress?.(diagnostic);
    if (stable >= required) return true;
  }
  throw new ChatAttachmentUploadError('readback_timeout', diagnostic);
}
