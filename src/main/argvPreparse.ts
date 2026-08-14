// Argv pre-parsing helpers extracted from src/main.tsx (ROADMAP 11g Fase 7a).
//
// Each helper inspects/mutates process.argv directly (the entrypoint's mutable
// argv slot is the unit of work) and optionally mutates the matching slot in
// `bootContext` (passed by reference). They are called from main() BEFORE
// commander runs so the `program.parseAsync(process.argv)` sees rewritten args.
//
// NOTE: helpers never call `profileCheckpoint(...)`. Checkpoint placement is
// locked by src/main/__tests__/bootSnapshot.test.ts and remains at the
// original callsite in src/main.tsx.

import { feature } from 'bun:bundle';

import { gracefulShutdownSync } from 'src/utils/gracefulShutdown.js';

import type { PendingAssistantChat, PendingConnect, PendingSSH } from './bootContext.js';

/**
 * Check argv for a `cc://` or `cc+unix://` URL and rewrite so the main command
 * (or the internal `open` subcommand under -p/--print) handles it.
 *
 * No-op when DIRECT_CONNECT is gated off or when no cc URL is present.
 */
export async function runDirectConnectArgvRewrite(
  pendingConnect: PendingConnect | undefined,
): Promise<void> {
  if (!feature('DIRECT_CONNECT')) return;
  const rawCliArgs = process.argv.slice(2);
  const ccIdx = rawCliArgs.findIndex(a => a.startsWith('cc://') || a.startsWith('cc+unix://'));
  if (ccIdx === -1 || !pendingConnect) return;

  const ccUrl = rawCliArgs[ccIdx]!;
  const { parseConnectUrl } = await import('../server/parseConnectUrl.js');
  const parsed = parseConnectUrl(ccUrl);
  pendingConnect.dangerouslySkipPermissions = rawCliArgs.includes('--dangerously-skip-permissions');
  if (rawCliArgs.includes('-p') || rawCliArgs.includes('--print')) {
    // Headless: rewrite to internal `open` subcommand
    const stripped = rawCliArgs.filter((_, i) => i !== ccIdx);
    const dspIdx = stripped.indexOf('--dangerously-skip-permissions');
    if (dspIdx !== -1) {
      stripped.splice(dspIdx, 1);
    }
    process.argv = [process.argv[0]!, process.argv[1]!, 'open', ccUrl, ...stripped];
  } else {
    // Interactive: strip cc:// URL and flags, run main command
    pendingConnect.url = parsed.serverUrl;
    pendingConnect.authToken = parsed.authToken;
    const stripped = rawCliArgs.filter((_, i) => i !== ccIdx);
    const dspIdx = stripped.indexOf('--dangerously-skip-permissions');
    if (dspIdx !== -1) {
      stripped.splice(dspIdx, 1);
    }
    process.argv = [process.argv[0]!, process.argv[1]!, ...stripped];
  }
}

/**
 * Handle `--handle-uri <uri>` and macOS LaunchServices URL scheme launches.
 * Calls `process.exit()` and never returns when a deep link is handled.
 *
 * No-op when LODESTONE is gated off or when neither branch matches.
 */
export async function runDeepLinkArgvHandling(): Promise<void> {
  if (!feature('LODESTONE')) return;

  const handleUriIdx = process.argv.indexOf('--handle-uri');
  if (handleUriIdx !== -1 && process.argv[handleUriIdx + 1]) {
    const { enableConfigs } = await import('src/utils/config.js');
    enableConfigs();
    const uri = process.argv[handleUriIdx + 1]!;
    const { handleDeepLinkUri } = await import('src/utils/deepLink/protocolHandler.js');
    const exitCode = await handleDeepLinkUri(uri);
    process.exit(exitCode);
  }

  // macOS URL handler: when LaunchServices launches our .app bundle, the
  // URL arrives via Apple Event (not argv). LaunchServices overwrites
  // __CFBundleIdentifier to the launching bundle's ID, which is a precise
  // positive signal — cheaper than importing and guessing with heuristics.
  if (
    process.platform === 'darwin' &&
    process.env.__CFBundleIdentifier === 'com.anthropic.claude-code-url-handler'
  ) {
    const { enableConfigs } = await import('src/utils/config.js');
    enableConfigs();
    const { handleUrlSchemeLaunch } = await import('src/utils/deepLink/protocolHandler.js');
    const urlSchemeResult = await handleUrlSchemeLaunch();
    process.exit(urlSchemeResult ?? 1);
  }
}

/**
 * `claude assistant [sessionId]` — stash and strip so the main command handles
 * it, giving the full interactive TUI. Position-0 only (matching the ssh
 * pattern) — indexOf would false-positive on `claude -p "explain assistant"`.
 *
 * No-op when KAIROS is gated off.
 */
export function runAssistantArgvStash(
  pendingAssistantChat: PendingAssistantChat | undefined,
): void {
  if (!feature('KAIROS') || !pendingAssistantChat) return;
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] !== 'assistant') return;

  const nextArg = rawArgs[1];
  if (nextArg && !nextArg.startsWith('-')) {
    pendingAssistantChat.sessionId = nextArg;
    rawArgs.splice(0, 2); // drop 'assistant' and sessionId
    process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs];
  } else if (!nextArg) {
    pendingAssistantChat.discover = true;
    rawArgs.splice(0, 1); // drop 'assistant'
    process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs];
  }
  // else: `claude assistant --help` → fall through to stub
}

/**
 * `claude ssh <host> [dir]` — strip from argv so the main command handler
 * runs (full interactive TUI), stash host/dir/flags for the REPL branch to
 * pick up. Headless (-p) mode is rejected here.
 *
 * No-op when SSH_REMOTE is gated off.
 */
export function runSshArgvStash(pendingSSH: PendingSSH | undefined): void {
  if (!feature('SSH_REMOTE') || !pendingSSH) return;
  const rawCliArgs = process.argv.slice(2);
  // SSH-specific flags can appear before the host positional (e.g.
  // `ssh --permission-mode auto host /tmp` — standard POSIX flags-before-
  // positionals). Pull them all out BEFORE checking whether a host was
  // given, so `claude ssh --permission-mode auto host` and `claude ssh host
  // --permission-mode auto` are equivalent. The host check below only needs
  // to guard against `-h`/`--help` (which commander should handle).
  if (rawCliArgs[0] === 'ssh') {
    const localIdx = rawCliArgs.indexOf('--local');
    if (localIdx !== -1) {
      pendingSSH.local = true;
      rawCliArgs.splice(localIdx, 1);
    }
    const dspIdx = rawCliArgs.indexOf('--dangerously-skip-permissions');
    if (dspIdx !== -1) {
      pendingSSH.dangerouslySkipPermissions = true;
      rawCliArgs.splice(dspIdx, 1);
    }
    const pmIdx = rawCliArgs.indexOf('--permission-mode');
    if (pmIdx !== -1 && rawCliArgs[pmIdx + 1] && !rawCliArgs[pmIdx + 1]!.startsWith('-')) {
      pendingSSH.permissionMode = rawCliArgs[pmIdx + 1];
      rawCliArgs.splice(pmIdx, 2);
    }
    const pmEqIdx = rawCliArgs.findIndex(a => a.startsWith('--permission-mode='));
    if (pmEqIdx !== -1) {
      pendingSSH.permissionMode = rawCliArgs[pmEqIdx]!.split('=')[1];
      rawCliArgs.splice(pmEqIdx, 1);
    }
    // Forward session-resume + model flags to the remote CLI's initial spawn.
    // --continue/-c and --resume <uuid> operate on the REMOTE session history
    // (which persists under the remote's ~/.claudin/projects/<cwd>/).
    // --model controls which model the remote uses.
    const extractFlag = (
      flag: string,
      opts: { hasValue?: boolean; as?: string } = {},
    ) => {
      const i = rawCliArgs.indexOf(flag);
      if (i !== -1) {
        pendingSSH.extraCliArgs.push(opts.as ?? flag);
        const val = rawCliArgs[i + 1];
        if (opts.hasValue && val && !val.startsWith('-')) {
          pendingSSH.extraCliArgs.push(val);
          rawCliArgs.splice(i, 2);
        } else {
          rawCliArgs.splice(i, 1);
        }
      }
      const eqI = rawCliArgs.findIndex(a => a.startsWith(`${flag}=`));
      if (eqI !== -1) {
        pendingSSH.extraCliArgs.push(opts.as ?? flag, rawCliArgs[eqI]!.slice(flag.length + 1));
        rawCliArgs.splice(eqI, 1);
      }
    };
    extractFlag('-c', { as: '--continue' });
    extractFlag('--continue');
    extractFlag('--resume', { hasValue: true });
    extractFlag('--model', { hasValue: true });
  }
  // After pre-extraction, any remaining dash-arg at [1] is either -h/--help
  // (commander handles) or an unknown-to-ssh flag (fall through to commander
  // so it surfaces a proper error). Only a non-dash arg is the host.
  if (rawCliArgs[0] === 'ssh' && rawCliArgs[1] && !rawCliArgs[1].startsWith('-')) {
    pendingSSH.host = rawCliArgs[1];
    // Optional positional cwd.
    let consumed = 2;
    if (rawCliArgs[2] && !rawCliArgs[2].startsWith('-')) {
      pendingSSH.cwd = rawCliArgs[2];
      consumed = 3;
    }
    const rest = rawCliArgs.slice(consumed);

    // Headless (-p) mode is not supported with SSH in v1 — reject early
    // so the flag doesn't silently cause local execution.
    if (rest.includes('-p') || rest.includes('--print')) {
      process.stderr.write('Error: headless (-p/--print) mode is not supported with claude ssh\n');
      gracefulShutdownSync(1);
      return;
    }

    // Rewrite argv so the main command sees remaining flags but not `ssh`.
    process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
  }
}
