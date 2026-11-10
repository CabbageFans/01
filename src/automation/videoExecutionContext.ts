import type { WebviewHandle } from '../utils/doubaoBridge';

export interface VideoPageOperation {
  operationId: string;
  taskId: string;
  runId: string;
  signal: AbortSignal;
  deadlineAt: number;
}
interface PageContext extends VideoPageOperation { cancelled: boolean; cancel: () => void; boundPage?: WebviewHandle }
const operations = new WeakMap<WebviewHandle, PageContext>();

/** 宿主与 guest 只交换操作 ID/期限；AbortSignal 留在宿主。新操作不能认领旧操作的迟到写入。 */
export async function beginVideoPageOperation(webview: WebviewHandle, operation: VideoPageOperation): Promise<() => void> {
  if (operations.has(webview)) throw new Error('视频页面仍由原运行占用');
  const cancel = (): void => {
    context.cancelled = true;
    void webview.executeJavaScript(`(() => { const state = globalThis.__doubaoVideoOperation; if (state?.id === ${JSON.stringify(operation.operationId)}) state.cancelled = true; })()`).catch((): void => undefined);
  };
  const context: PageContext = { ...operation, cancelled: false, cancel };
  operations.set(webview, context);
  const navigation: EventListener = (event: Event): void => {
    const detail = event as Event & { isMainFrame?: boolean; isInPlace?: boolean };
    if (detail.isMainFrame !== false && detail.isInPlace !== true) cancel();
  };
  webview.addEventListener?.('did-start-navigation', navigation);
  operation.signal.addEventListener('abort', cancel, { once: true });
  try {
    if (operation.signal.aborted) throw new DOMException('视频操作已取消', 'AbortError');
    await webview.executeJavaScript(`globalThis.__doubaoVideoOperation = { id: ${JSON.stringify(operation.operationId)}, cancelled: false, documentId: performance.timeOrigin }; true`);
    if (operation.signal.aborted) { cancel(); throw new DOMException('视频操作已取消', 'AbortError'); }
    return (): void => {
      cancel(); operation.signal.removeEventListener('abort', cancel);
      webview.removeEventListener?.('did-start-navigation', navigation);
      if (operations.get(webview) === context) operations.delete(webview);
    };
  } catch (error: unknown) {
    cancel(); operation.signal.removeEventListener('abort', cancel); webview.removeEventListener?.('did-start-navigation', navigation); operations.delete(webview); throw error;
  }
}

/** 只在本次授权的显式导航完成后重新绑定文档，禁止将任意迟到脚本绑定到新文档。 */
export async function bindVideoOperationDocument(webview: WebviewHandle): Promise<void> {
  const context = operations.get(webview);
  if (!context) return;
  assertContext(context);
  await webview.executeJavaScript(`globalThis.__doubaoVideoOperation = { id: ${JSON.stringify(context.operationId)}, cancelled: false, documentId: performance.timeOrigin }; true`);
  assertContext(context);
}
function assertContext(context: PageContext): void {
  if (context.cancelled || context.signal.aborted || Date.now() >= context.deadlineAt) throw new DOMException('本次视频操作已停止', 'AbortError');
}

/** 长动作冻结原操作上下文。旧 await 恢复后仍读取 A，不能借用同页后来授予 B 的权限。 */
export function captureVideoPageOperation(webview: WebviewHandle): WebviewHandle {
  const context = operations.get(webview);
  if (!context) return webview;
  assertContext(context);
  if (!context.boundPage) {
    const bound = new Proxy<WebviewHandle>(webview, {
      get(target: WebviewHandle, property: string | symbol): unknown {
        const value: unknown = Reflect.get(target, property, target);
        // 原生 webview 的属性和方法仍绑定真实元素，只有操作身份属于本次快照。
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    context.boundPage = bound;
    operations.set(bound, context);
  }
  return context.boundPage;
}

/** 同步入口检查还不够：异步 guest 探针在每次激活/写入前也调用同一个 lexical assert。 */
export function wrapVideoPageScript(webview: WebviewHandle, code: string, timeoutMs: number): string {
  const context = operations.get(webview);
  if (!context) return code;
  assertContext(context);
  const deadline = Math.min(context.deadlineAt, Date.now() + timeoutMs);
  return `(() => { const __doubaoAssertOperation = () => {
    const state = globalThis.__doubaoVideoOperation;
    if (!state || state.id !== ${JSON.stringify(context.operationId)} || state.cancelled || state.documentId !== performance.timeOrigin || Date.now() >= ${deadline}) {
      throw new DOMException('视频运行或页面操作已失效', 'AbortError');
    }
  }; __doubaoAssertOperation(); return (${code.trim().replace(/;\s*$/, '')}); })()`;
}

export function cancelTimedOutVideoOperation(webview: WebviewHandle): void { operations.get(webview)?.cancel(); }
