/**
 * Cross-compile the Claudin native binary for every distribution target.
 *
 * The release pipeline builds each platform NATIVELY on its own runner (so the
 * binary + bytecode are host-native and can be smoke-tested), passing a single
 * `CLAUDIN_COMPILE_TARGET` into `scripts/build.ts`. This driver is the
 * cross-compile-everything-on-one-host path — useful for local testing and as
 * the win-arm64 fallback when no native arm64 Windows runner is available.
 *
 * Usage:
 *   bun run scripts/build-compile-all.ts            # all 8 targets
 *   bun run scripts/build-compile-all.ts bun-linux-x64 bun-darwin-arm64
 *
 * Output: dist/bin/<platform>/claudin[.exe] per target (layout owned by build.ts).
 * Note: cross-compiled (non-host) binaries cannot be smoke-tested here — only
 * their native runner can. Bytecode cross-compile is validated per-target.
 */

const ALL_TARGETS = [
  'bun-darwin-x64',
  'bun-darwin-arm64',
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-linux-x64-musl',
  'bun-linux-arm64-musl',
  'bun-windows-x64',
  'bun-windows-arm64',
] as const

const targets = process.argv.slice(2)
const selected = targets.length > 0 ? targets : [...ALL_TARGETS]

const results: { target: string; ok: boolean; ms: number }[] = []

for (const target of selected) {
  const t0 = Date.now()
  console.log(`\n▶ Compiling ${target} …`)
  const proc = Bun.spawnSync(['bun', 'run', 'scripts/build.ts'], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: {
      ...process.env,
      CLAUDIN_COMPILE: '1',
      CLAUDIN_COMPILE_TARGET: target,
    },
  })
  const ms = Date.now() - t0
  results.push({ target, ok: proc.exitCode === 0, ms })
}

console.log('\n─── compile summary ───')
let failed = 0
for (const r of results) {
  const s = (r.ms / 1000).toFixed(1)
  console.log(`${r.ok ? '✓' : '✗'} ${r.target.padEnd(22)} ${s}s`)
  if (!r.ok) failed++
}

if (failed > 0) {
  console.error(`\n${failed}/${results.length} target(s) failed to compile.`)
  process.exit(1)
}
console.log(`\nAll ${results.length} target(s) compiled → dist/bin/`)
