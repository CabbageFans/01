import type { SubmissionDispatchResult, SubmissionDispatchSafety } from '../utils/doubaoBridge';

export interface SubmissionAttemptOptions {
  safety: SubmissionDispatchSafety;
  dispatch: (safety: SubmissionDispatchSafety) => Promise<SubmissionDispatchResult>;
  persist: (state: 'dispatch_unknown' | 'not_dispatched', reason?: string) => Promise<void>;
}

/** 权限、意图和单次派发只有一个协调入口；确定未派发与ACK丢失的恢复责任不同。 */
export async function dispatchSubmissionAttempt(options: SubmissionAttemptOptions): Promise<SubmissionDispatchResult> {
  const result = await options.dispatch({ ...options.safety,
    beforeDispatch: async (): Promise<void> => {
      await options.persist('dispatch_unknown');
      await options.safety.beforeDispatch?.();
    },
  });
  if (result.kind === 'not_dispatched') await options.persist('not_dispatched', result.reason);
  return result;
}
