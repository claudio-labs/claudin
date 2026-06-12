// Bounded wait for MCP connect promises in print/headless mode. Shared by
// the regular-server and claude.ai connector awaits in headless.ts — both
// race the connect against a timer and proceed on timeout; the connect
// promise keeps running and updates headlessStore in the background, so
// turn 2+ still sees late-connecting servers.

export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30_000;

// Resolve the regular-server startup cap. Override with
// CLAUDIN_MCP_STARTUP_TIMEOUT_MS; falls back to the default on
// missing/NaN/non-positive values (never throws, never returns <= 0).
export function getMcpStartupTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CLAUDIN_MCP_STARTUP_TIMEOUT_MS;
  if (!raw) return DEFAULT_MCP_STARTUP_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MCP_STARTUP_TIMEOUT_MS;
  return parsed;
}

// Race a connect promise against a timeout. Resolves true if the timer
// fired first, false if the connect settled in time. The timer is always
// cleared so a fast connect leaves nothing pending on the event loop.
export async function raceConnectTimeout(connect: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([connect.then(() => false), new Promise<boolean>(resolve => {
    timer = setTimeout(r => r(true), timeoutMs, resolve);
  })]);
  if (timer) clearTimeout(timer);
  return timedOut;
}
