import type { Account, Task } from '../types';
import { isMaterialImageTask, usesIndependentImagePage } from './taskExecutionScope';
import { createWebviewResourceScope } from './webviewLifecycle';
import type { WebviewResourceScope } from './webviewLifecycle';
import { resolveTaskConversationTarget } from './taskConversationLocator';

interface MaterialImagePage {
  accountId: string;
  runId: string;
  webview: HTMLWebViewElement;
  ready: boolean;
  resources: WebviewResourceScope;
  failure?: MaterialImagePageFailure;
}

export interface MaterialImagePageFailure {
  taskId: string;
  accountId: string;
  runId: string;
  code: 'page_loading' | 'page_unrecognized';
  message: string;
}

const FIRST_DOCUMENT_TIMEOUT_MS = 15_000;

/** 图片页面属于具体任务运行，绝不借用账号的自由聊天页面或其他图片现场。 */
export class MaterialImagePages {
  private pages = new Map<string, MaterialImagePage>();

  /** 旧镜头已提交却缺定位时，账号页可能仍是唯一原现场，不能用新空页替换。 */
  uses(task: Task): boolean {
    return usesIndependentImagePage(task) && (isMaterialImageTask(task) || !!this.get(task)
      || !task.runtime?.submittedAt || resolveTaskConversationTarget(task).ok);
  }

  get(task: Task): HTMLWebViewElement | undefined {
    const page = this.pages.get(task.id);
    return page?.accountId === task.assignedAccountId && page.runId === (task.runtime?.runId || '') ? page.webview : undefined;
  }

  ready(task: Task): boolean {
    return !!this.get(task) && this.pages.get(task.id)?.ready === true;
  }

  failure(task: Task): MaterialImagePageFailure | undefined {
    return this.get(task) ? this.pages.get(task.id)?.failure : undefined;
  }

  owns(taskId: string, webview: HTMLWebViewElement): boolean {
    return this.pages.get(taskId)?.webview === webview;
  }

  contains(webview: HTMLWebViewElement): boolean {
    return [...this.pages.values()].some((page): boolean => page.webview === webview);
  }

  ensure(task: Task, account: Account, container: HTMLDivElement, onStateChange: () => void): HTMLWebViewElement {
    if (!this.uses(task) || task.assignedAccountId !== account.id || account.platform === 'dola') throw new Error('图片执行页面缺少原账号或独立操作绑定');
    const existing = this.get(task);
    if (existing) return existing;
    this.delete(task.id);
    const webview = document.createElement('webview') as HTMLWebViewElement;
    const resources = createWebviewResourceScope();
    const page: MaterialImagePage = { accountId: account.id, runId: task.runtime?.runId || '', webview, ready: false, resources };
    // 分区必须在首次导航前设置，沿用本人的账号登录；新页面只隔离对话和DOM。
    webview.setAttribute('partition', `persist:doubao_${account.partition}`);
    const original = resolveTaskConversationTarget(task);
    webview.setAttribute('src', original.ok ? original.url : 'https://www.doubao.com/chat/');
    webview.setAttribute('webpreferences', 'backgroundThrottling=no');
    webview.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;visibility:visible;opacity:1;pointer-events:none;z-index:0;';
    const awaitingDispatch = !task.runtime?.submittedAt;
    let firstDocumentLoaded = false;
    const fail = (code: MaterialImagePageFailure['code'], message: string): void => {
      if (!resources.active || this.pages.get(task.id) !== page || !awaitingDispatch || firstDocumentLoaded) return;
      page.ready = false;
      page.failure = { taskId: task.id, accountId: account.id, runId: page.runId, code, message };
      // 错误为本运行的终态；迟到的did-stop-loading不能重新授予页面执行权。
      resources.dispose();
      onStateChange();
    };
    const firstDocumentTimer = awaitingDispatch ? setTimeout((): void => {
      fail('page_loading', '独立豆包对话未能在15秒内完成首次文档加载，已在执行前暂停');
    }, FIRST_DOCUMENT_TIMEOUT_MS) : undefined;
    if (firstDocumentTimer !== undefined) resources.trackTimer(firstDocumentTimer);
    const loaded = (): void => {
      if (!resources.active || this.pages.get(task.id) !== page) return;
      resources.clearTimer(firstDocumentTimer);
      firstDocumentLoaded = true;
      page.ready = true;
      onStateChange();
    };
    resources.listen(webview, 'did-fail-load', (event: Event): void => {
      const failure = event as Event & { isMainFrame?: boolean; errorCode?: number };
      if (failure.isMainFrame !== true || failure.errorCode === -3) return;
      const code = typeof failure.errorCode === 'number' ? `（错误码${failure.errorCode}）` : '';
      fail('page_loading', `独立豆包对话首次文档加载失败${code}，已在执行前暂停`);
    });
    resources.listen(webview, 'render-process-gone', (): void => { fail('page_unrecognized', '独立豆包对话页面进程已退出，已保留原任务并暂停'); });
    resources.listen(webview, 'did-start-loading', (): void => { if (resources.active) page.ready = false; });
    resources.listen(webview, 'dom-ready', loaded);
    resources.listen(webview, 'did-finish-load', loaded);
    resources.listen(webview, 'did-stop-loading', loaded);
    this.pages.set(task.id, page);
    container.appendChild(webview);
    return webview;
  }

  /** 观察页保持视口交集以便平台挂载产物；只有当前交互页接收输入。 */
  activate(taskId: string | null): void {
    for (const [id, page] of this.pages) {
      page.webview.style.pointerEvents = id === taskId ? 'auto' : 'none';
      page.webview.style.zIndex = id === taskId ? '2' : '0';
    }
  }

  delete(taskId: string): void {
    const page = this.pages.get(taskId);
    if (!page) return;
    page.resources.dispose();
    page.webview.remove();
    this.pages.delete(taskId);
  }

  removeAccount(accountId: string): void {
    for (const [id, page] of this.pages) if (page.accountId === accountId) this.delete(id);
  }

  prune(tasks: readonly Task[], accountIds: ReadonlySet<string>, retainedTaskId: string | null): void {
    for (const [id, page] of this.pages) {
      const task = tasks.find((item): boolean => item.id === id);
      // 受理不明且未存定位时，页面可能是唯一原现场；失败/取消不能抹掉它。
      const needsOriginalPage = !!task?.runtime?.submittedAt && task.status !== 'done' && !resolveTaskConversationTarget(task).ok;
      if (!task || !accountIds.has(page.accountId) || task.runtime?.runId !== page.runId
        || id !== retainedTaskId && !needsOriginalPage && ['done', 'fail', 'cancelled'].includes(task.status)) this.delete(id);
    }
  }

  dispose(): void { for (const id of this.pages.keys()) this.delete(id); }
}
