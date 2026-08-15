// Owns the REPL's per-render boot/lifecycle effects.
//
// Extracted from src/agent/repl/REPL.tsx (Etapa 4, ROADMAP 11e). Before extraction,
// two sibling useEffect blocks sat between the spinner/status calculations and
// the `useTabStatus` hook call:
//
//   1. Prevent macOS from sleeping while Claude is working (`startPreventSleep`/
//      `stopPreventSleep`), keyed on `(isLoading, isWaitingForApproval,
//      isShowingLocalJSXCommand)`.
//   2. Push session activity to the PID file for `claude ps` (gated on
//      `feature('BG_SESSIONS')`), keyed on the derived `(sessionStatus,
//      waitingFor)` pair.
//
// Both depend on the same upstream state (`isLoading`, `isWaitingForApproval`,
// `isShowingLocalJSXCommand`, plus the permission/sandbox queues that feed
// `waitingFor`). Collapsing them into one hook keeps the derivation of
// `sessionStatus`/`waitingFor` adjacent to its only consumers, and the hook
// returns those two values so REPL.tsx can still pass them to `useTabStatus`
// and the spinner UI.
//
// IMPORTANT — hook order: REPL.tsx invokes `useReplLifecycle(...)` at exactly
// the same point in the component body where the original two effects lived
// (between `titleIsAnimating` and `useTabStatus(...)`). React's Rules of Hooks
// require a stable call order, so this single call replaces TWO effects — the
// net change to the hook-call sequence is one fewer hook (-1). The startup-
// checks gate (REPL.tsx ~line 1207) is intentionally NOT consolidated here:
// it lives much later, after dozens of other hooks (state, refs, callbacks)
// declared between, so moving it would shift those hooks' relative position
// and violate hook order.

import { useEffect } from 'react';
import type { TabStatusKind } from 'src/terminal/ink/hooks/use-tab-status.js';
import { feature } from 'bun:bundle';
import { startPreventSleep, stopPreventSleep } from 'src/platform/preventSleep.js';
import { updateSessionActivity } from 'src/sessions/concurrentSessions.js';
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
  sessionStatus: TabStatusKind;
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

  const sessionStatus: TabStatusKind = isWaitingForApproval || isShowingLocalJSXCommand
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

  // Push status to the PID file for `claude ps`. Fire-and-forget; ps falls
  // back to transcript-tail derivation when this is missing/stale.
  useEffect(() => {
    if (feature('BG_SESSIONS')) {
      void updateSessionActivity({
        status: sessionStatus,
        waitingFor,
      });
    }
  }, [sessionStatus, waitingFor]);

  return { sessionStatus, waitingFor };
}
