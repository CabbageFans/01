import type { WebviewHandle, SubmissionDispatchResult, SubmissionDispatchSafety } from './doubaoBridge';
import type { PageSubmissionOperation, SendButtonTarget } from './submissionControls';
import { captureVideoPageOperation } from '../automation/videoExecutionContext';

export type NativeSubmissionProbe = (operation: PageSubmissionOperation, cleanup?: boolean) => Promise<SendButtonTarget>;

/** 等待IPC的ACK可以取消；已发送的mouseDown仍由finally释放，绝不补第二次按下。 */
async function waitNativeAck(value: void | Promise<void>, safety: SubmissionDispatchSafety): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined; let aborted: (() => void) | undefined;
  try {
    await Promise.race([Promise.resolve(value), new Promise<never>((_resolve, reject): void => {
      aborted = (): void => reject(new DOMException('原生点击已停止', 'AbortError'));
      safety.signal.addEventListener('abort', aborted, { once: true });
      timer = setTimeout((): void => reject(new Error('原生输入ACK未返回')), Math.max(1, Math.min(500, safety.deadlineAt - Date.now())));
      if (safety.signal.aborted) aborted();
    })]);
  } finally { if (timer) clearTimeout(timer); if (aborted) safety.signal.removeEventListener('abort', aborted); }
}

/** 媒体只使用当前唯一控件的实时DOM中心；没有原生能力时确定未派发，不降级合成click。 */
export async function dispatchNativeMediaSubmission(page: WebviewHandle, safety: SubmissionDispatchSafety, target: SendButtonTarget, probe: NativeSubmissionProbe): Promise<SubmissionDispatchResult> {
  if (typeof page.sendInputEvent !== 'function') return { kind: 'not_dispatched', reason: 'native_input_unavailable' };
  const sendNative = page.sendInputEvent.bind(page);
  let originalUrl = ''; let mouseDownSent = false; let mouseUpSent = false; let alreadyAttempted = false;
  const ensureCurrent = (): void => {
    captureVideoPageOperation(page);
    if (safety.signal.aborted || Date.now() >= safety.deadlineAt || !safety.isCurrent() || page.isConnected === false
      || page.getURL() !== originalUrl || page.isLoadingMainFrame?.()) throw new DOMException('原运行或文档已变化', 'AbortError');
  };
  const cleanup = (): void => {
    try { void probe({ cancelNativeKey: safety.dispatchKey }, true).catch((): void => {}); } catch { /* 页面关闭也必须继续释放已按下的原生左键。 */ }
  };
  try {
    originalUrl = page.getURL();
    ensureCurrent();
    const reservation = await probe({ reserveNative: true, expected: target, dispatchKey: safety.dispatchKey, deadlineAt: Math.min(safety.deadlineAt, Date.now() + 4500),
      expectedPrompt: safety.expectedPrompt, strictParagraphs: safety.strictParagraphs });
    alreadyAttempted = reservation.dispatchAttempted === true;
    ensureCurrent();
    if (!reservation.ok || !reservation.nativeReserved) return alreadyAttempted ? { kind: 'dispatch_unknown', reason: 'native_attempt_already_consumed' } : { kind: 'not_dispatched', reason: 'native_reservation_refused' };
    const ready = await probe({ validateNativeKey: safety.dispatchKey }); ensureCurrent();
    if (!ready.ok || !ready.nativeReserved || ready.documentId !== reservation.documentId || ready.position !== reservation.position) return { kind: 'not_dispatched', reason: 'native_target_changed' };
    const point = ready.position?.split(',').map(Number);
    if (!point || point.length !== 2 || !point.every(Number.isFinite)) return { kind: 'not_dispatched', reason: 'native_position_invalid' };
    ensureCurrent(); mouseDownSent = true;
    await waitNativeAck(sendNative({ type: 'mouseDown', x: point[0], y: point[1], button: 'left', clickCount: 1 }), safety); ensureCurrent();
    // 按下可能触发重绘、导航或取消，松开前仍检查同一元素与同一文档；变化时只在画布外释放。
    const held = await probe({ validateNativeKey: safety.dispatchKey }); ensureCurrent();
    if (!held.ok || !held.nativeReserved || held.documentId !== ready.documentId || held.position !== ready.position) throw new Error('原生按下后控件已变化');
    mouseUpSent = true;
    await waitNativeAck(sendNative({ type: 'mouseUp', x: point[0], y: point[1], button: 'left', clickCount: 1 }), safety); ensureCurrent();
    const ackDeadline = Math.min(safety.deadlineAt, Date.now() + 750);
    while (Date.now() < ackDeadline) {
      const receipt = await probe({ readReceiptKey: safety.dispatchKey }); ensureCurrent();
      if (receipt.nativeReceipt?.activated && receipt.nativeReceipt.trusted && !receipt.nativeReceipt.cancelled) return { kind: 'dispatch_attempted', activated: true };
      if (receipt.nativeReceipt?.cancelled) break;
      await new Promise<void>((resolve): void => { setTimeout(resolve, 25); }); ensureCurrent();
    }
    return { kind: 'dispatch_unknown', reason: 'native_activation_ack_missing' };
  } catch {
    return mouseDownSent || alreadyAttempted ? { kind: 'dispatch_unknown', reason: 'native_delivery_or_ack_unknown' } : { kind: 'not_dispatched', reason: 'native_preflight_stopped' };
  } finally {
    cleanup();
    if (mouseDownSent && !mouseUpSent) {
      // 只释放原webview的左键，画布外坐标不会激活后来出现的控件，不向别的应用派发输入。
      try { void Promise.resolve(sendNative({ type: 'mouseUp', x: -1, y: -1, button: 'left', clickCount: 1 })).catch((): void => {}); } catch { /* ACK未知仍保留原请求，禁止再次按下。 */ }
    }
  }
}
