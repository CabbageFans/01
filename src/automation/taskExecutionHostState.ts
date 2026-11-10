import type { TaskUpdateInput } from '../types';
import { MaterialImagePages } from '../utils/materialImagePages';

interface ExecutionHostState {
  running: Set<string>;
  controllers: Map<string, AbortController>;
  restarts: Map<string, TaskUpdateInput>;
  cancellations: Map<string, 'paused' | 'cancelled'>;
  reconciling: Set<string>;
  reconciliationPromises: Map<string, Promise<void>>;
  reconciliationUsage: Set<string>;
  submittedMediaPages: Map<string, { accountId: string; runId: string; submittedAt: string; webview: HTMLWebViewElement; conversationUrl: string }>;
  pages: MaterialImagePages;
}
const host = globalThis as typeof globalThis & { __doubaoTaskExecutionHost?: ExecutionHostState };
/** React 只挂载/展示页面，执行权与任务页由稳定宿主持有。 */
export const taskExecutionHostState: ExecutionHostState = host.__doubaoTaskExecutionHost || (host.__doubaoTaskExecutionHost = {
  running: new Set(), controllers: new Map(), restarts: new Map(), cancellations: new Map(), pages: new MaterialImagePages(),
  reconciling: new Set(), reconciliationPromises: new Map(), reconciliationUsage: new Set(), submittedMediaPages: new Map(),
});
// 开发热更新也要迁移已有宿主，不能因为新增字段重建正在观察原请求的控制器。
taskExecutionHostState.reconciling ??= new Set();
taskExecutionHostState.reconciliationPromises ??= new Map();
taskExecutionHostState.reconciliationUsage ??= new Set();
taskExecutionHostState.submittedMediaPages ??= new Map();
