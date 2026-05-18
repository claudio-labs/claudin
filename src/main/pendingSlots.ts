// Pending slots populated by argv pre-parsing in main() before run() begins.
//
// Each slot is `undefined` when the corresponding feature flag is off. The
// slots are mutable: argv pre-parse helpers (src/main/argvPreparse.ts) write
// into them by reference, then they're copied into the BootContext at the
// top of the default action handler.
//
// Extracted from src/main.tsx (ROADMAP 11g Fase 7 margin #1) to keep main.tsx
// focused on orchestration.

import { feature } from 'bun:bundle';

import type { PendingAssistantChat, PendingConnect, PendingSSH } from './bootContext.js';

/** Set by early argv processing when `claude` is invoked with a cc:// URL. */
export const pendingConnect: PendingConnect | undefined = feature('DIRECT_CONNECT') ? {
  url: undefined,
  authToken: undefined,
  dangerouslySkipPermissions: false,
} : undefined;

/** Set by early argv processing when `claude assistant [sessionId]` is detected. */
export const pendingAssistantChat: PendingAssistantChat | undefined = feature('KAIROS') ? {
  sessionId: undefined,
  discover: false,
} : undefined;

/** Set by early argv processing when `claude ssh <host> [dir]` is detected. */
export const pendingSSH: PendingSSH | undefined = feature('SSH_REMOTE') ? {
  host: undefined,
  cwd: undefined,
  permissionMode: undefined,
  dangerouslySkipPermissions: false,
  local: false,
  extraCliArgs: [],
} : undefined;
