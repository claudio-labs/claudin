// BootContext — explicit container for state shared across the default
// action handler in src/platform/main.tsx (and, after Fase 5b, across the per-mode
// modules under src/platform/main/defaultAction/).
//
// Fase 4 (in-place refactor): this module introduces the type seam.
// Wave A: pending slots (DIRECT_CONNECT / KAIROS / SSH_REMOTE).
// Wave B (this commit, partial scope — worktree/tmux + teammate/kairos
// + the two non-controversial flag slots taskListId / disableSlashCommands).
// The wider Wave-B/C/D options-and-state cluster (verbose, print, sdkUrl,
// systemPrompt, dynamicMcpConfig, …) is left for a follow-up commit so
// each in-place migration stays reviewable.
//
// See docs/tech/main-split/bootContext-fields.md for the inventory.

import type { DownloadResult } from 'src/services/api/filesApi.js';
import type { TeammateOptions } from 'src/platform/main/helpers.js';

// The three pending slots are populated by argv pre-parsing inside
// `main()` BEFORE `run()` builds Commander. We do NOT move that parsing
// here — that would change boot order. Instead, the slots remain
// module-level `let`s in src/platform/main.tsx and are copied into ctx.pending
// at the top of the default action handler.

/** Set by early argv processing when `claude` is invoked with a cc:// URL. */
export type PendingConnect = {
  url: string | undefined;
  authToken: string | undefined;
  dangerouslySkipPermissions: boolean;
};

/** Set by early argv processing when `claude assistant [sessionId]` is detected. */
export type PendingAssistantChat = {
  sessionId?: string;
  discover: boolean;
};

/** Set by early argv processing when `claude ssh <host> [dir]` is detected. */
export type PendingSSH = {
  host: string | undefined;
  cwd: string | undefined;
  permissionMode: string | undefined;
  dangerouslySkipPermissions: boolean;
  /** --local: spawn the child CLI directly, skip ssh/probe/deploy. e2e test mode. */
  local: boolean;
  /** Extra CLI args to forward to the remote CLI on initial spawn (--resume, -c). */
  extraCliArgs: string[];
};

/**
 * Opaque type for the assistant-team context produced by
 * `assistantModule.initializeAssistantTeam()`. The `assistant` module is
 * build-time-stubbed in this fork, so we expose it as `unknown` and rely
 * on the caller (main.tsx) to keep the original typed handle locally
 * when needed.
 */
export type AssistantTeamContext = unknown;

/**
 * BootContext — shared state for the default action handler.
 *
 * Fields beyond `prompt` / `pending` are declared with their resting
 * value and assigned at the original site in src/platform/main.tsx so that boot
 * ordering and side-effects (awaits, process.exit branches) are
 * preserved exactly.
 */
export type BootContext = {
  /** Original positional prompt argument, mutated when `prompt === 'code'`. */
  prompt: string | undefined;

  /**
   * Slots populated by argv pre-parsing in main() before run() begins.
   * Each is `undefined` when the corresponding feature flag is off.
   */
  pending: {
    connect: PendingConnect | undefined;
    assistantChat: PendingAssistantChat | undefined;
    ssh: PendingSSH | undefined;
  };

  // --- Wave B (partial): flag slots that are read but not mutated ---

  disableSlashCommands: boolean;
  taskListId: string | undefined;

  // --- Wave B: worktree / tmux ---

  worktreeOption: boolean | string | undefined;
  worktreeName: string | undefined;
  worktreeEnabled: boolean;
  worktreePRNumber: number | undefined;
  tmuxEnabled: boolean;

  // --- Wave B: teammate / kairos ---

  kairosEnabled: boolean;
  assistantTeamContext: AssistantTeamContext | undefined;
  storedTeammateOpts: TeammateOptions | undefined;

  // --- Wave C (partial): SDK / streaming, files ---

  sdkUrl: string | undefined;
  effectiveIncludePartialMessages: boolean;
  fileSpecs: string[] | undefined;
  fileDownloadPromise: Promise<DownloadResult[]> | undefined;
};

/** Inputs the factory needs to populate the BootContext from. */
export type BuildBootContextInput = {
  prompt: string | undefined;
  pendingConnect: PendingConnect | undefined;
  pendingAssistantChat: PendingAssistantChat | undefined;
  pendingSSH: PendingSSH | undefined;
};

/**
 * Build the BootContext at the top of the default action handler.
 *
 * Pure: no I/O, no side-effects, no awaits. Boot ordering is preserved
 * because all argv-driven mutation of the pending slots happens BEFORE
 * this function is called, and all migrated fields are assigned in-place
 * at their original sites in src/platform/main.tsx.
 */
export function buildBootContext(input: BuildBootContextInput): BootContext {
  return {
    prompt: input.prompt,
    pending: {
      connect: input.pendingConnect,
      assistantChat: input.pendingAssistantChat,
      ssh: input.pendingSSH,
    },

    // Wave B (partial): assigned at original sites in main.tsx.
    disableSlashCommands: false,
    taskListId: undefined,

    // Wave B: worktree / tmux.
    worktreeOption: undefined,
    worktreeName: undefined,
    worktreeEnabled: false,
    worktreePRNumber: undefined,
    tmuxEnabled: false,

    // Wave B: teammate / kairos.
    kairosEnabled: false,
    assistantTeamContext: undefined,
    storedTeammateOpts: undefined,

    // Wave C (partial): SDK / streaming, files.
    sdkUrl: undefined,
    effectiveIncludePartialMessages: false,
    fileSpecs: undefined,
    fileDownloadPromise: undefined,
  };
}
