#!/usr/bin/env node
/**
 * Pre-warm the V8 bytecode cache used by `bin/claudin`.
 *
 * Background: `bin/claudin` enables `module.enableCompileCache(~/.claudin/v8cache)`,
 * which saves ~250 ms on every WARM launch. But the very first launch after
 * `npm install -g @claudiolabs/claudin` has an empty cache, so the user pays
 * the full ~520 ms cold parse cost. This script runs `--version` and `--help`
 * once during the postinstall step, populating the cache transparently. The
 * user's first real invocation lands warm.
 *
 * Safety:
 *  - Only runs if dist/cli.mjs exists (skips dev installs that haven't built).
 *  - All errors are swallowed; postinstall must NEVER block npm install.
 *  - Honors npm's `--ignore-scripts` flag (npm short-circuits before this runs).
 *  - Opt-out: set CLAUDIN_NO_WARMUP=1 before install.
 *  - Bounded by a 15 s timeout per command — won't hang forever on a wedged
 *    spawn.
 *  - Sets CLAUDIN_NO_HEAP_BUMP=1 so the launcher's re-exec doesn't double the
 *    work (the heap bump isn't needed for --version/--help).
 *  - No network, no auth, no config writes outside ~/.claudin/v8cache/.
 *
 * Footprint: ~1–2 s added to `npm install`. v8cache directory grows by ~5 MB.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.CLAUDIN_NO_WARMUP === '1') process.exit(0)

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, 'dist', 'cli.mjs')
const launcher = join(root, 'bin', 'claudin')

if (!existsSync(dist) || !existsSync(launcher)) {
  // Dev install or unbuilt checkout — nothing to warm.
  process.exit(0)
}

const env = {
  ...process.env,
  // Launcher re-execs itself to bump --max-old-space-size. That's pointless
  // for a --version warmup and would double the work. The launcher's compile
  // cache logic runs in EITHER the parent or the re-exec'd child (after the
  // sentinel is set), so the cache is still populated.
  CLAUDIN_NO_HEAP_BUMP: '1',
  // Silence the cache GC pass — it's not relevant during warmup and may print
  // diagnostic noise to install logs.
  CLAUDIN_V8CACHE_GC: '0',
}

const opts = {
  stdio: 'ignore',
  timeout: 15000,
  env,
}

// --version exits in ~80 ms; --help exits in ~520 ms cold. Run both so the
// cache covers BOTH the version fast-path and the commander help graph,
// which the user's first interactive launch will also need.
try {
  spawnSync(process.execPath, [launcher, '--version'], opts)
  spawnSync(process.execPath, [launcher, '--help'], opts)
} catch {
  // Intentionally ignored — postinstall must never block install.
}

process.exit(0)
