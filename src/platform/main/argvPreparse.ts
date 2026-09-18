// Argv pre-parsing helpers extracted from src/platform/main.tsx (ROADMAP 11g Fase 7a).
//
// Each helper inspects/mutates process.argv directly (the entrypoint's mutable
// argv slot is the unit of work) and optionally mutates the matching slot in
// `bootContext` (passed by reference). They are called from main() BEFORE
// commander runs so the `program.parseAsync(process.argv)` sees rewritten args.
//
// NOTE: helpers never call `profileCheckpoint(...)`. Checkpoint placement is
// locked by src/platform/main/__tests__/bootSnapshot.test.ts and remains at the
// original callsite in src/platform/main.tsx.

import { feature } from 'bun:bundle';

import type { PendingConnect } from 'src/platform/main/bootContext.js';

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
