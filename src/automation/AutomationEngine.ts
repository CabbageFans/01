import type { ElectronAPI, Task } from '@doubao-studio/contracts';
import { executionScopesConflict, getTaskExecutionScope, isImageExecutionTask, IMAGE_EXECUTION_CONCURRENCY } from '../utils/taskExecutionScope';

interface Reservation {
  taskId: string;
  accountId: string;
  ownerId: string;
  scope: string;
  imageExecution: boolean;
  controller?: AbortController;
  heartbeat?: ReturnType<typeof setInterval>;
}

const LEASE_HEARTBEAT_MS = 30_000;

function getElectronAPI(): ElectronAPI {
  return (window as unknown as { electronAPI: ElectronAPI }).electronAPI;
}

export class AutomationEngine {
  private reservations = new Map<string, Reservation>();
  private accountTasks = new Map<string, string>();

  async reserve(taskId: string, accountId: string, ownerId: string, task?: Task): Promise<{ ok: boolean; error?: string }> {
    if (task && (task.id !== taskId || task.assignedAccountId !== accountId)) return { ok: false, error: '任务执行归属不一致' };
    const scope = task ? getTaskExecutionScope(task) : accountId;
    const imageExecution = !!task && isImageExecutionTask(task);
    if ([...this.accountTasks].some(([otherScope, otherTask]: [string, string]): boolean => otherTask !== taskId && executionScopesConflict(scope, otherScope))) {
      return { ok: false, error: '该账号已有执行中的任务' };
    }
    if (imageExecution && [...this.reservations.values()].filter((reservation: Reservation): boolean =>
      reservation.taskId !== taskId && reservation.imageExecution).length >= IMAGE_EXECUTION_CONCURRENCY) {
      return { ok: false, error: '已有图片任务正在处理，请等待完成或暂停后再开始' };
    }
    const existing = this.reservations.get(taskId);
    if (existing) return existing.ownerId === ownerId ? { ok: true } : { ok: false, error: '任务已在运行' };

    const reservation: Reservation = { taskId, accountId, ownerId, scope, imageExecution };
    this.reservations.set(taskId, reservation);
    this.accountTasks.set(scope, taskId);
    try {
      const result = await getElectronAPI().tasks.acquireLock(taskId, ownerId);
      if (!result.success) throw new Error(result.error || '任务锁定失败');
      // 取锁等待期间可能已停止并建立新运行，旧回执不能认领新占位或重复启用其心跳。
      if (this.reservations.get(taskId) !== reservation) return { ok: false, error: '任务执行预约已变化，未启动' };
      reservation.heartbeat = setInterval(() => {
        void this.renew(reservation);
      }, LEASE_HEARTBEAT_MS);
      return { ok: true };
    } catch (reason: unknown) {
      // IPC 抛错与明确失败都释放本次本地占位；迟到失败不能删掉后来运行。
      if (this.reservations.get(taskId) === reservation) {
        this.reservations.delete(taskId);
        if (this.accountTasks.get(scope) === taskId) this.accountTasks.delete(scope);
      }
      return { ok: false, error: reason instanceof Error ? reason.message : '任务锁定失败' };
    }
  }

  private async renew(reservation: Reservation): Promise<void> {
    let error = '未知错误';
    try {
      const result = await getElectronAPI().tasks.renewLock(reservation.taskId, reservation.ownerId);
      if (result.success) return;
      error = result.error || error;
    } catch (reason: unknown) {
      error = reason instanceof Error ? reason.message : String(reason);
    }
    if (this.reservations.get(reservation.taskId) !== reservation) return;
    reservation.controller?.abort();
    if (reservation.heartbeat) clearInterval(reservation.heartbeat);
    this.reservations.delete(reservation.taskId);
    if (this.accountTasks.get(reservation.scope) === reservation.taskId) {
      this.accountTasks.delete(reservation.scope);
    }
    console.error(`[AutomationEngine] 任务租约续租失败，已中止执行: ${error}`);
  }

  createController(taskId: string, accountId: string): AbortController {
    const reservation = this.reservations.get(taskId);
    if (!reservation || reservation.accountId !== accountId) {
      throw new Error('任务尚未获得执行锁');
    }
    if (reservation.controller) throw new Error('原任务控制器仍持有执行权，不能重复启动');
    reservation.controller = new AbortController();
    return reservation.controller;
  }

  abort(taskId: string): boolean {
    const reservation = this.reservations.get(taskId);
    if (!reservation?.controller) return false;
    reservation.controller.abort();
    return true;
  }

  isReserved(taskId: string): boolean {
    return this.reservations.has(taskId);
  }

  hasController(taskId: string): boolean {
    return !!this.reservations.get(taskId)?.controller;
  }

  ownsController(taskId: string, controller: AbortController): boolean {
    return this.reservations.get(taskId)?.controller === controller;
  }

  ownsAccountController(taskId: string, accountId: string, controller: AbortController): boolean {
    const reservation = this.reservations.get(taskId);
    return !!reservation && reservation.accountId === accountId && reservation.controller === controller
      && this.accountTasks.get(reservation.scope) === taskId && !controller.signal.aborted;
  }

  /** 外部提交前向正式任务域确认原账号租约；等待期间失去控制权也不能继续发送。 */
  async confirmSubmissionOwnership(taskId: string, accountId: string, controller: AbortController): Promise<boolean> {
    if (!this.ownsAccountController(taskId, accountId, controller)) return false;
    const reservation = this.reservations.get(taskId);
    if (!reservation) return false;
    await this.renew(reservation);
    return this.ownsAccountController(taskId, accountId, controller);
  }

  async release(taskId: string, controller?: AbortController): Promise<void> {
    const reservation = this.reservations.get(taskId);
    if (!reservation || controller && reservation.controller !== controller) {
      return;
    }
    if (reservation.heartbeat) clearInterval(reservation.heartbeat);
    this.reservations.delete(taskId);
    if (this.accountTasks.get(reservation.scope) === taskId) this.accountTasks.delete(reservation.scope);
    await getElectronAPI().tasks.releaseLock(taskId, reservation.ownerId);
  }
}

// 开发热更新也必须复用同一个执行租约宿主，不能因模块重载丢失仍在执行的控制器。
const engineHost = globalThis as typeof globalThis & { __doubaoAutomationEngine?: AutomationEngine };
export const automationEngine = engineHost.__doubaoAutomationEngine || (engineHost.__doubaoAutomationEngine = new AutomationEngine());
