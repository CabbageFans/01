import type { ElectronAPI } from '@doubao-studio/contracts';

interface Reservation {
  taskId: string;
  accountId: string;
  ownerId: string;
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

  async reserve(taskId: string, accountId: string, ownerId: string): Promise<{ ok: boolean; error?: string }> {
    const accountTask = this.accountTasks.get(accountId);
    if (accountTask && accountTask !== taskId) return { ok: false, error: '该账号已有执行中的任务' };
    const existing = this.reservations.get(taskId);
    if (existing) return existing.ownerId === ownerId ? { ok: true } : { ok: false, error: '任务已在运行' };

    this.reservations.set(taskId, { taskId, accountId, ownerId });
    this.accountTasks.set(accountId, taskId);
    const result = await getElectronAPI().tasks.acquireLock(taskId, ownerId);
    if (!result.success) {
      this.reservations.delete(taskId);
      if (this.accountTasks.get(accountId) === taskId) this.accountTasks.delete(accountId);
      return { ok: false, error: result.error || '任务锁定失败' };
    }
    const reservation = this.reservations.get(taskId);
    if (reservation) {
      reservation.heartbeat = setInterval(() => {
        void this.renew(reservation);
      }, LEASE_HEARTBEAT_MS);
    }
    return { ok: true };
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
    if (this.accountTasks.get(reservation.accountId) === reservation.taskId) {
      this.accountTasks.delete(reservation.accountId);
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
      && this.accountTasks.get(accountId) === taskId && !controller.signal.aborted;
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
    if (this.accountTasks.get(reservation.accountId) === taskId) this.accountTasks.delete(reservation.accountId);
    await getElectronAPI().tasks.releaseLock(taskId, reservation.ownerId);
  }
}

// 开发热更新也必须复用同一个执行租约宿主，不能因模块重载丢失仍在执行的控制器。
const engineHost = globalThis as typeof globalThis & { __doubaoAutomationEngine?: AutomationEngine };
export const automationEngine = engineHost.__doubaoAutomationEngine || (engineHost.__doubaoAutomationEngine = new AutomationEngine());
