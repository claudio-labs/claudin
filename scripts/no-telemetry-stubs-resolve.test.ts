import { existsSync, readdirSync, statSync } from 'fs'
import { basename, join } from 'path'
import { expect, test } from 'bun:test'

// Guard for a silent failure the 2026-08 reorg walked into.
//
// `noTelemetryPlugin` registers each stub as a Bun `onLoad` filter built from
// the module's RESOLVED file path. A filter that matches nothing is not an
// error — it just never fires — and the plugin's own
// `stubbed N modules` line counts REGISTERED stubs, not applied ones. So when
// `src/services/api/dumpPrompts.ts` became `src/providers/transport/
// dumpPrompts.ts`, its stub went dead, the real module started shipping, and
// every signal stayed green: the build passed, and `verify:privacy` passed too
// because that scans the bundle for banned phone-home PATTERNS and the real
// module happens to be a no-op shim. Nothing in the pipeline was watching the
// stub itself.
//
// The distinction this test draws:
//
//   key resolves to a file            → the stub applies. Fine.
//   key does not resolve, and no file
//     of that name exists anywhere    → dead entry for a module the fork
//                                       deleted. Harmless, reported below.
//   key does not resolve, but a file
//     of that name exists ELSEWHERE   → the module MOVED and took the stub out
//                                       of the build with it. This fails.

const REPO_ROOT = join(import.meta.dir, '..')
const SRC = join(REPO_ROOT, 'src')

function stubKeys(source: string): string[] {
  const start = source.indexOf('const stubs')
  const end = source.indexOf('function escapeForResolvedPathRegex')
  if (start < 0 || end < 0 || end < start) {
    throw new Error(
      'could not locate the stubs object in no-telemetry-plugin.ts — ' +
        'if it was renamed, update this guard rather than deleting it',
    )
  }
  // Keys sit at one tab of indentation inside the object literal; the stub
  // bodies are template literals, so anchoring to the line start keeps their
  // contents out of the match.
  return [...source.slice(start, end).matchAll(/^\t'([^']+)':/gm)].map(m => m[1]!)
}

function findByBasename(dir: string, name: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      findByBasename(full, name, out)
    } else if (basename(entry).replace(/\.(ts|tsx|js|d\.ts)$/, '') === name) {
      out.push(full)
    }
  }
}

test('every no-telemetry stub key still resolves, or names nothing at all', async () => {
  const plugin = await Bun.file(
    join(REPO_ROOT, 'scripts', 'no-telemetry-plugin.ts'),
  ).text()
  const keys = stubKeys(plugin)
  expect(keys.length).toBeGreaterThan(10)

  const disarmed: string[] = []
  const dead: string[] = []

  for (const key of keys) {
    const resolves = ['ts', 'tsx', 'js'].some(ext =>
      existsSync(join(REPO_ROOT, `${key}.${ext}`)),
    )
    if (resolves) continue

    const elsewhere: string[] = []
    findByBasename(SRC, basename(key), elsewhere)
    if (elsewhere.length > 0) {
      disarmed.push(
        `${key} → moved to ${elsewhere.map(p => p.slice(REPO_ROOT.length + 1)).join(', ')}`,
      )
    } else {
      dead.push(key)
    }
  }

  if (dead.length > 0) {
    // Not a failure: a stub for a module this fork never received is inert by
    // design. Printed so the list does not grow unnoticed.
    console.log(
      `  no-telemetry: ${dead.length} stub(s) name a module that does not exist:\n` +
        dead.map(k => `    ${k}`).join('\n'),
    )
  }

  expect(disarmed).toEqual([])
})
