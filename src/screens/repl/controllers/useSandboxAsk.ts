// Owns the sandbox network-permission ask callback.
//
// Extracted from src/screens/REPL.tsx (controllers, ROADMAP 11e deferred half).
// Before extraction this was a single `useCallback` sitting between the
// cost-threshold effect and the sandbox-unavailable notification effect.
//
// IMPORTANT — hook order: REPL.tsx invokes `useSandboxAsk(...)` at exactly the
// position the original `useCallback` occupied. One hook in, one hook out — the
// component's hook-call sequence is unchanged. The dependency array below is
// verbatim from the original (`[setAppState, store]`); the other three bindings
// it closes over (`setSandboxPermissionRequestQueue`, `sandboxBridgeCleanupRef`)
// are a state setter and a ref, both stable by construction, which is why they
// were — and remain — absent from the deps.
//
// Three resolution paths survive extraction and must stay distinguishable:
//   1. swarm worker  → forward to the leader over the mailbox, fall back to the
//      local dialog when the mailbox send fails.
//   2. local only    → queue the dialog.
//   3. local+bridge  → queue the dialog AND mirror the request to claude.ai as a
//      can_use_tool control_request, first responder wins (`resolveOnce`).
// The per-host cleanup list exists because several concurrent requests can name
// the same host; whoever resolves first tears down every sibling subscription.

import { useCallback } from 'react';
import { feature } from 'bun:bundle';
import { randomUUID } from 'crypto';
import type {
  SandboxAskCallback,
  NetworkHostPattern,
} from '../../../utils/sandbox/sandbox-adapter.js';
import {
  isSwarmWorker,
  generateSandboxRequestId,
  sendSandboxPermissionRequestViaMailbox,
} from '../../../utils/swarm/permissionSync.js';
import { registerSandboxPermissionCallback } from '../../../hooks/useSwarmPermissionPoller.js';
import { isAgentSwarmsEnabled } from '../../../utils/agentSwarmsEnabled.js';
import { SANDBOX_NETWORK_ACCESS_TOOL_NAME } from 'src/cli/structuredIO.js';
import { useAppStateStore } from '../../../state/AppState.js';
import type { SetAppState } from '../../../utils/messageQueueManager.js';

export interface SandboxPermissionRequest {
  hostPattern: NetworkHostPattern;
  resolvePromise: (allowConnection: boolean) => void;
}

export interface UseSandboxAskDeps {
  setAppState: SetAppState;
  store: ReturnType<typeof useAppStateStore>;
  setSandboxPermissionRequestQueue: React.Dispatch<
    React.SetStateAction<SandboxPermissionRequest[]>
  >;
  sandboxBridgeCleanupRef: React.RefObject<Map<string, Array<() => void>>>;
}

export function useSandboxAsk(deps: UseSandboxAskDeps): SandboxAskCallback {
  const {
    setAppState,
    store,
    setSandboxPermissionRequestQueue,
    sandboxBridgeCleanupRef,
  } = deps;

  const sandboxAskCallback: SandboxAskCallback = useCallback(async (hostPattern: NetworkHostPattern) => {
    // If running as a swarm worker, forward the request to the leader via mailbox
    if (isAgentSwarmsEnabled() && isSwarmWorker()) {
      const requestId = generateSandboxRequestId();

      // Send the request to the leader via mailbox
      const sent = await sendSandboxPermissionRequestViaMailbox(hostPattern.host, requestId);
      return new Promise(resolveShouldAllowHost => {
        if (!sent) {
          // If we couldn't send via mailbox, fall back to local handling
          setSandboxPermissionRequestQueue(prev => [...prev, {
            hostPattern,
            resolvePromise: resolveShouldAllowHost
          }]);
          return;
        }

        // Register the callback for when the leader responds
        registerSandboxPermissionCallback({
          requestId,
          host: hostPattern.host,
          resolve: resolveShouldAllowHost
        });

        // Update AppState to show pending indicator
        setAppState(prev => ({
          ...prev,
          pendingSandboxRequest: {
            requestId,
            host: hostPattern.host
          }
        }));
      });
    }

    // Normal flow for non-workers: show local UI and optionally race
    // against the REPL bridge (Remote Control) if connected.
    return new Promise(resolveShouldAllowHost => {
      let resolved = false;
      function resolveOnce(allow: boolean): void {
        if (resolved) return;
        resolved = true;
        resolveShouldAllowHost(allow);
      }

      // Queue the local sandbox permission dialog
      setSandboxPermissionRequestQueue(prev => [...prev, {
        hostPattern,
        resolvePromise: resolveOnce
      }]);

      // When the REPL bridge is connected, also forward the sandbox
      // permission request as a can_use_tool control_request so the
      // remote user (e.g. on claude.ai) can approve it too.
      if (feature('BRIDGE_MODE')) {
        const bridgeCallbacks = store.getState().replBridgePermissionCallbacks;
        if (bridgeCallbacks) {
          const bridgeRequestId = randomUUID();
          bridgeCallbacks.sendRequest(bridgeRequestId, SANDBOX_NETWORK_ACCESS_TOOL_NAME, {
            host: hostPattern.host
          }, randomUUID(), `Allow network connection to ${hostPattern.host}?`);
          const unsubscribe = bridgeCallbacks.onResponse(bridgeRequestId, response => {
            unsubscribe();
            const allow = response.behavior === 'allow';
            // Resolve ALL pending requests for the same host, not just
            // this one — mirrors the local dialog handler pattern.
            setSandboxPermissionRequestQueue(queue => {
              queue.filter(item => item.hostPattern.host === hostPattern.host).forEach(item => item.resolvePromise(allow));
              return queue.filter(item => item.hostPattern.host !== hostPattern.host);
            });
            // Clean up all sibling bridge subscriptions for this host
            // (other concurrent same-host requests) before deleting.
            const siblingCleanups = sandboxBridgeCleanupRef.current.get(hostPattern.host);
            if (siblingCleanups) {
              for (const fn of siblingCleanups) {
                fn();
              }
              sandboxBridgeCleanupRef.current.delete(hostPattern.host);
            }
          });

          // Register cleanup so the local dialog handler can cancel
          // the remote prompt and unsubscribe when the local user
          // responds first.
          const cleanup = () => {
            unsubscribe();
            bridgeCallbacks.cancelRequest(bridgeRequestId);
          };
          const existing = sandboxBridgeCleanupRef.current.get(hostPattern.host) ?? [];
          existing.push(cleanup);
          sandboxBridgeCleanupRef.current.set(hostPattern.host, existing);
        }
      }
    });
  }, [setAppState, store]);

  return sandboxAskCallback;
}
