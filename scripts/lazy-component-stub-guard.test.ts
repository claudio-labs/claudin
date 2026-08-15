import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { describe, expect, test } from 'bun:test'
import { loadShippedFeatureFlags } from './parseFeatureFlags'

// Companion to feature-flags-source-guard.test.ts, for the variant of that bug
// that takes the whole TUI down instead of throwing in one code path.
//
// `scripts/build.ts` stubs every unresolved relative `require()` with a module
// that exports ONLY `default` (build.ts:602-616). Code that destructures a
// NAMED export from such a stub gets `undefined`, and rendering `undefined` as
// a component throws React error #130 ("Element type is invalid") — which the
// Ink error boundary turns into a full-screen ERROR overview, killing the
// session's UI. That is what a missing UserForkBoilerplateMessage.tsx did to
// every fork child's first message.
//
// The safe idiom (used by BackgroundTasksDialog/PermissionRequest) is a
// module-level `const X = feature('F') ? require(...).X : null` plus an
// `if (!X) return null` guard. This test fails on the unguarded shape whenever
// the required module is missing and its feature gate is enabled.

const REPO_ROOT = resolve(import.meta.dir, '..')
const SRC_DIR = join(REPO_ROOT, 'src')

type SourceFile = { path: string; code: string }
type Risk = { path: string; line: number; spec: string; name: string }

const REQUIRE_RE = /require\(\s*['"](\.\.?\/[^'"]+\.js)['"]\s*\)/g

/**
 * Is the `require()` at `index` reachable in the shipped bundle? Undeclared
 * flags fold to `false`, same as `featureFlags[name] ?? false` in build.ts.
 * Gates in this codebase are either on the require's own line (module-level
 * ternary) or a few lines above it (`if (feature('F')) {`), and multiple gates
 * are always OR'd.
 */
function isLiveBranch(
  code: string,
  index: number,
  flags: Record<string, boolean>,
): boolean {
  const before = code.slice(0, index).split('\n')
  const window = before.slice(-25).join('\n') + code.slice(index).split('\n')[0]
  const gates = [...window.matchAll(/feature\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g)]
  if (gates.length === 0) return true
  return gates.some(g => flags[g[1]!] === true)
}

/** Named exports read off the require's result, anchored on the specifier. */
function namedAccesses(code: string, spec: string, requireLine: string): string[] {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const names = new Set<string>()

  // (require('./X.js') as typeof import('./X.js')).Name
  for (const m of requireLine.matchAll(/\)\s*\.\s*(\w+)/g)) names.add(m[1]!)

  // const { Name } = tmp as typeof import('./X.js')   (React Compiler output)
  const destructure = new RegExp(
    `\\{([\\w\\s,]+?)\\}\\s*=\\s*\\w+\\s+as\\s+typeof\\s+import\\(\\s*['"]${escaped}['"]\\s*\\)`,
    'g',
  )
  for (const m of code.matchAll(destructure)) {
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim()
      if (name) names.add(name)
    }
  }

  return [...names].filter(n => n !== 'default')
}

/** `if (!X) return null`, `X ? … : …`, `X && …`, `X ?? …` all render safely. */
function hasFalsyGuard(code: string, name: string): boolean {
  return new RegExp(`(?:!\\s*${name}\\b|\\b${name}\\s*(?:\\?|&&))`).test(code)
}

export function findUnguardedStubComponentRenders(
  files: SourceFile[],
  flags: Record<string, boolean>,
  moduleExists: (absPath: string) => boolean,
): Risk[] {
  const risks: Risk[] = []
  for (const { path, code } of files) {
    for (const m of code.matchAll(REQUIRE_RE)) {
      const spec = m[1]!
      if (moduleExists(join(dirname(path), spec))) continue
      const index = m.index!
      if (!isLiveBranch(code, index, flags)) continue
      const lines = code.slice(0, index).split('\n')
      const requireLine = code.split('\n')[lines.length - 1]!
      for (const name of namedAccesses(code, spec, requireLine)) {
        // Only JSX renders can throw #130; a plain call just returns null.
        if (!new RegExp(`<${name}[\\s/>]`).test(code)) continue
        if (hasFalsyGuard(code, name)) continue
        risks.push({ path, line: lines.length, spec, name })
      }
    }
  }
  return risks
}

function resolvesOnDisk(absPathWithJs: string): boolean {
  const base = absPathWithJs.replace(/\.js$/, '')
  return [
    absPathWithJs,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ].some(existsSync)
}

function collectTsxFiles(dir: string, out: SourceFile[] = []): SourceFile[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectTsxFiles(full, out)
      continue
    }
    if (!entry.name.endsWith('.tsx') || entry.name.endsWith('.test.tsx')) continue
    out.push({ path: full, code: readFileSync(full, 'utf-8') })
  }
  return out
}

describe('findUnguardedStubComponentRenders', () => {
  const missingEverything = () => false
  // The React Compiler output shape that shipped the #130 crash.
  const compilerOutputShape = `
  if (feature("FORK_SUBAGENT")) {
    if (param.text.includes("<fork-boilerplate>")) {
      let t1;
      if ($[32] === Symbol.for("react.memo_cache_sentinel")) {
        t1 = require("./UserForkBoilerplateMessage.js");
        $[32] = t1;
      }
      const {
        UserForkBoilerplateMessage
      } = t1 as typeof import('./UserForkBoilerplateMessage.js');
      return <UserForkBoilerplateMessage addMargin={addMargin} param={param} />;
    }
  }`

  test('flags an unguarded render of a missing module behind an enabled flag', () => {
    const risks = findUnguardedStubComponentRenders(
      [{ path: 'src/agent/ui/messages/UserTextMessage.tsx', code: compilerOutputShape }],
      { FORK_SUBAGENT: true },
      missingEverything,
    )

    expect(risks).toHaveLength(1)
    expect(risks[0]!.name).toBe('UserForkBoilerplateMessage')
    expect(risks[0]!.spec).toBe('./UserForkBoilerplateMessage.js')
  })

  test('ignores the same shape when the feature flag is off', () => {
    expect(
      findUnguardedStubComponentRenders(
        [{ path: 'src/agent/ui/messages/UserTextMessage.tsx', code: compilerOutputShape }],
        { FORK_SUBAGENT: false },
        missingEverything,
      ),
    ).toEqual([])
  })

  test('treats an undeclared flag as off, like the build does', () => {
    expect(
      findUnguardedStubComponentRenders(
        [{ path: 'src/agent/ui/messages/UserTextMessage.tsx', code: compilerOutputShape }],
        {},
        missingEverything,
      ),
    ).toEqual([])
  })

  test('ignores a module that resolves on disk', () => {
    expect(
      findUnguardedStubComponentRenders(
        [{ path: 'src/agent/ui/messages/UserTextMessage.tsx', code: compilerOutputShape }],
        { FORK_SUBAGENT: true },
        () => true,
      ),
    ).toEqual([])
  })

  test('ignores the null-guarded module-level idiom', () => {
    const guarded = `
  const MonitorMcpDetailDialog = feature('MONITOR_TOOL') ? (require('./MonitorMcpDetailDialog.js') as typeof import('./MonitorMcpDetailDialog.js')).MonitorMcpDetailDialog : null;
  function Dialog() {
    if (!MonitorMcpDetailDialog) return null;
    return <MonitorMcpDetailDialog task={task} />;
  }`

    expect(
      findUnguardedStubComponentRenders(
        [{ path: 'src/agent/ui/tasks/BackgroundTasksDialog.tsx', code: guarded }],
        { MONITOR_TOOL: true },
        missingEverything,
      ),
    ).toEqual([])
  })

  test('flags the module-level idiom when the null guard is missing', () => {
    const unguarded = `
  const MonitorMcpDetailDialog = feature('MONITOR_TOOL') ? (require('./MonitorMcpDetailDialog.js') as typeof import('./MonitorMcpDetailDialog.js')).MonitorMcpDetailDialog : null;
  function Dialog() {
    return <MonitorMcpDetailDialog task={task} />;
  }`

    expect(
      findUnguardedStubComponentRenders(
        [{ path: 'src/agent/ui/tasks/BackgroundTasksDialog.tsx', code: unguarded }],
        { MONITOR_TOOL: true },
        missingEverything,
      ),
    ).toHaveLength(1)
  })
})

test('no live require() renders a component from a missing (stubbed) module', () => {
  const flags = loadShippedFeatureFlags()
  const risks = findUnguardedStubComponentRenders(
    collectTsxFiles(SRC_DIR),
    flags,
    resolvesOnDisk,
  )

  const described = risks.map(
    r =>
      `${r.path.slice(REPO_ROOT.length + 1)}:${r.line} renders <${r.name}> from missing '${r.spec}'`,
  )
  expect(described).toEqual([])
})
