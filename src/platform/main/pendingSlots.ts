// Pending slots read by the default action handler through the BootContext.
//
// Both are now permanently `undefined`: each was populated by an argv
// pre-parse helper, and both helpers went with the branches that read them.
// They survive as the seam `BootContext.pending` still declares.
//
// Extracted from src/platform/main.tsx (ROADMAP 11g Fase 7 margin #1) to keep main.tsx
// focused on orchestration.

import type { PendingConnect, PendingSSH } from 'src/platform/main/bootContext.js';

/**
 * `claudin open cc://…` and `claudin server` lived behind DIRECT_CONNECT, which
 * is absent from `featureFlags` in scripts/build/build.ts — so the slot was
 * already always empty, and the argv rewrite, the two subcommands and the
 * interactive branch that read it are gone. Kept as the seam
 * `BootContext.pending.connect` still declares.
 */
export const pendingConnect: PendingConnect | undefined = undefined;

/**
 * `claude ssh <host> [dir]` lived behind SSH_REMOTE, which is absent from
 * `featureFlags` in scripts/build/build.ts — so the slot was already always
 * empty and the branch reading it is gone. Kept as the seam
 * `BootContext.pending.ssh` still declares.
 */
export const pendingSSH: PendingSSH | undefined = undefined;
