// Owns the REPL's per-render boot/lifecycle effects.
//
// Extracted from src/agent/repl/REPL.tsx (Etapa 4, ROADMAP 11e). Before extraction,
// two sibling useEffect blocks sat after the spinner/status calculations:
//
//   1. Prevent macOS from sleeping while Claude is working (`startPreventSleep`/
//      `stopPreventSleep`), keyed on `(isLoading, isWaitingForApproval,
//      isShowingLocalJSXCommand)`.
//   2. Push session activity to the PID file for `claude ps`. Removed together
//      with the background-sessions build flag it was gated on, which never
//      opened in this fork.
//
// What remains is the sleep effect plus the derivation of `waitingFor`,
// which the hook returns so REPL.tsx can still pass it to the spinner UI.
//
// IMPORTANT — hook order: REPL.tsx invokes `useReplLifecycle(...)` at exactly
// the same point in the component body where the original two effects lived
// (right after `titleIsAnimating`). React's Rules of Hooks
// require a stable call order, so this single call replaces TWO effects. The
// startup-checks gate (REPL.tsx ~line 1207) is intentionally NOT consolidated here:
// it lives much later, after dozens of other hooks (state, refs, callbacks)
// declared between, so moving it would shift those hooks' relative position
// and violate hook order.

import { useEffect } from 'react';
import { startPreventSleep, stopPreventSleep } from 'src/platform/preventSleep.js';
import type { ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js';

export interface UseReplLifecycleDeps {
  // Boot signals — whether the agent is mid-turn and what kind of attention
  // (if any) it's waiting for.
  isLoading: boolean;
  isWaitingForApproval: boolean;
  isShowingLocalJSXCommand: boolean;
  // Inputs to the `waitingFor` derivation. We accept the raw queues / flags
  // (rather than the precomputed string) so the hook owns the full mapping
  // from REPL state → activity payload, keeping the derivation colocated
  // with the effect that publishes it.
  toolUseConfirmQueue: ToolUseConfirm[];
  pendingWorkerRequest: boolean;
  pendingSandboxRequest: boolean;
}

export interface UseReplLifecycleResult {
  waitingFor: string | undefined;
}

export function useReplLifecycle(deps: UseReplLifecycleDeps): UseReplLifecycleResult {
  const {
    isLoading,
    isWaitingForApproval,
    isShowingLocalJSXCommand,
    toolUseConfirmQueue,
    pendingWorkerRequest,
    pendingSandboxRequest,
  } = deps;

  // Prevent macOS from sleeping while Claude is working.
  useEffect(() => {
    if (isLoading && !isWaitingForApproval && !isShowingLocalJSXCommand) {
      startPreventSleep();
      return () => stopPreventSleep();
    }
  }, [isLoading, isWaitingForApproval, isShowingLocalJSXCommand]);

  const sessionStatus: 'idle' | 'busy' | 'waiting' = isWaitingForApproval || isShowingLocalJSXCommand
    ? 'waiting'
    : isLoading
      ? 'busy'
      : 'idle';

  const waitingFor: string | undefined = sessionStatus !== 'waiting'
    ? undefined
    : toolUseConfirmQueue.length > 0
      ? `approve ${toolUseConfirmQueue[0]!.tool.name}`
      : pendingWorkerRequest
        ? 'worker request'
        : pendingSandboxRequest
          ? 'sandbox request'
          : isShowingLocalJSXCommand
            ? 'dialog open'
            : 'input needed';

  return { waitingFor };
}
