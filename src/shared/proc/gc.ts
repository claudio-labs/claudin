/**
 * Force a garbage collection at a known release point, on whichever runtime
 * this process happens to be.
 *
 * There are two, and they disagree about the entry point:
 *
 *   - **Bun** — the shipped native binary, and `bun run dev`. `globalThis.gc`
 *     does NOT exist unless the process was started with `bun --expose-gc`.
 *     The always-available entry point is `Bun.gc(sync)`.
 *   - **Node** — `node dist/cli.mjs` launched by `bin/claudin`, which re-execs
 *     with `--expose-gc`. There `globalThis.gc` exists and is always a
 *     synchronous full GC; V8 offers no asynchronous form.
 *
 * The distinction is load-bearing rather than cosmetic. The released CLI is
 * `bin/claudin.exe`, compiled with `bun --compile`, and it never runs
 * `bin/claudin` — so a bare `globalThis.gc?.()` is a silent no-op for every
 * user on the default install, which is exactly what it was at the two call
 * sites this module replaced. See `.claudin/rules/build-system.md`.
 *
 * Pass `sync: true` only at a one-off pause point such as post-compaction. On
 * a path that can run many times in a row — per-subagent teardown during a
 * fan-out — a queue of full synchronous collections stalls the render loop,
 * so leave it false and let the runtime schedule the sweep.
 */

export type GcStrategy = 'bun' | 'global' | 'none'

/**
 * Pure core: which entry point to use, given what the runtime exposes.
 *
 * Split out because the suite runs under Bun, where the Node branch is
 * unreachable — passing the two flags directly is the only way to pin the
 * fallback order and the "neither exists" case that made the old code a no-op.
 */
export function pickGcStrategy(
  hasBunGc: boolean,
  hasGlobalGc: boolean,
): GcStrategy {
  if (hasBunGc) return 'bun'
  if (hasGlobalGc) return 'global'
  return 'none'
}

export function hintGc(sync = false): void {
  const strategy = pickGcStrategy(
    typeof Bun !== 'undefined' && typeof Bun.gc === 'function',
    typeof globalThis.gc === 'function',
  )
  switch (strategy) {
    case 'bun':
      Bun.gc(sync)
      return
    case 'global':
      globalThis.gc?.()
      return
    case 'none':
      return
  }
}
