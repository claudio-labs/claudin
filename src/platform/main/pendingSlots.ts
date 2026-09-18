// Pending slots populated by argv pre-parsing in main() before run() begins.
//
// Each slot is `undefined` when the corresponding feature flag is off. The
// slots are mutable: argv pre-parse helpers (src/platform/main/argvPreparse.ts) write
// into them by reference, then they're copied into the BootContext at the
// top of the default action handler.
//
// Extracted from src/platform/main.tsx (ROADMAP 11g Fase 7 margin #1) to keep main.tsx
// focused on orchestration.

import { feature } from 'bun:bundle';

import type { PendingConnect, PendingSSH } from 'src/platform/main/bootContext.js';

/** Set by early argv processing when `claude` is invoked with a cc:// URL. */
export const pendingConnect: PendingConnect | undefined = feature('DIRECT_CONNECT') ? {
  url: undefined,
  authToken: undefined,
  dangerouslySkipPermissions: false,
} : undefined;

/**
 * `claude ssh <host> [dir]` lived behind SSH_REMOTE, which is absent from
 * `featureFlags` in scripts/build/build.ts — so the slot was already always
 * empty and the branch reading it is gone. Kept as the seam
 * `BootContext.pending.ssh` still declares.
 */
export const pendingSSH: PendingSSH | undefined = undefined;
