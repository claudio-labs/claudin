// Characterization of the tool registry, for the dead-code cleanup.
//
// Two halves, because neither is sufficient alone:
//
//   1. The RUNTIME list (`getAllBaseTools()`). Under `bun test` every
//      `feature()` reads false — Bun resolves `bun:bundle` natively before any
//      mock — so this is the flag-OFF registry. It pins the tools that ship
//      unconditionally.
//   2. The STATIC table, scanned out of `src/tools/tools.ts`. Every
//      flag-gated tool is registered as
//      `const Name = feature('FLAG') ? require(…) : null`, so a regex over the
//      source recovers what the runtime list cannot see: the tools behind flags
//      that ship TRUE.
//
// Together they are exhaustive. Delete a tool gated by a true flag and half 2
// notices; delete an ungated one and half 1 notices. Half 1 on its own would
// have let the first case through, which is exactly the failure this cleanup
// can produce.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAllBaseTools } from 'src/tools/tools.js'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const TOOLS_SOURCE = join(REPO_ROOT, 'src', 'tools', 'tools.ts')

/**
 * `const Name = feature('A') || feature('B') ? require(…) : null`
 *
 * Captures the binding name and the whole gate expression; the flags are pulled
 * out of the latter separately so the `||` chains stay visible.
 */
const GATED_BINDING_RE =
  /^const (\w+)\s*=\s*\n?\s*((?:feature\('\w+'\)(?:\s*\|\|\s*)?)+)\s*\n?\s*\?/gm

function scanGatedTools(): Record<string, string[]> {
  const source = readFileSync(TOOLS_SOURCE, 'utf8')
  const out: Record<string, string[]> = {}
  let m: RegExpExecArray | null
  GATED_BINDING_RE.lastIndex = 0
  while ((m = GATED_BINDING_RE.exec(source)) !== null) {
    const flags = [...m[2]!.matchAll(/feature\('(\w+)'\)/g)].map(f => f[1]!)
    out[m[1]!] = flags
  }
  return out
}

describe('tool registry — characterization', () => {
  test('the unconditional tool list matches the snapshot', () => {
    // Flag-off shape by construction: see the header. A name leaving this list
    // during the cleanup is either intended (and the snapshot is edited by
    // hand, naming it) or a regression.
    const names = getAllBaseTools().map(t => t.name)
    expect(names).toMatchSnapshot()
  })

  test('the flag-gated tool table matches the snapshot', () => {
    // This is where the tools behind SHIPPED flags live — MonitorTool
    // (MONITOR_TOOL), the workflow tools (AGENT_WORKFLOWS). The runtime list
    // above cannot see them at all.
    expect(scanGatedTools()).toMatchSnapshot()
  })

  test('the scan actually found the gated bindings', () => {
    // A regex that silently matches nothing turns both snapshots into a record
    // of an empty object, and the suite would stay green through the entire
    // cleanup while guarding nothing.
    //
    // The floor was 10 before the dead-flag cleanup, then 5, then 2: the table
    // lost CtxInspectTool, ListPeersTool, PushNotificationTool, RemoteTrigger,
    // SendUserFileTool, SleepTool, SubscribePRTool and WebBrowserTool in the
    // first round, then OverflowTestTool (OVERFLOW_TEST_TOOL),
    // TerminalCaptureTool (TERMINAL_PANEL) and WorkflowTool
    // (WORKFLOW_SCRIPTS) in the second, and SnipTool (HISTORY_SNIP) in the
    // third — three entries left, all behind flags the map ships true. It
    // exists to catch a regex that matches NOTHING, so any number comfortably
    // above zero does the job — lower it again if a later pass legitimately
    // takes the table below two. The `toHaveProperty` below is the real guard:
    // it pins one known binding to its flag, which a broken regex cannot fake.
    const gated = scanGatedTools()
    expect(Object.keys(gated).length).toBeGreaterThan(2)
    expect(gated).toHaveProperty('MonitorTool', ['MONITOR_TOOL'])
  })

  test('every gated tool names a flag that the build map knows about', () => {
    // `build.ts` folds `featureFlags[name] ?? false`, so a flag absent from the
    // map is silently false — which is how KAIROS_PUSH_NOTIFICATION and six
    // other satellites became invisible dead code. This does not fail on an
    // absent flag (several are absent on purpose); it records WHICH are absent,
    // so the cleanup removes them deliberately rather than by accident.
    const buildSource = readFileSync(
      join(REPO_ROOT, 'scripts', 'build', 'build.ts'),
      'utf8',
    )
    const mapBody = buildSource.slice(
      buildSource.indexOf('const featureFlags'),
      buildSource.indexOf('checkAutoModeClassifierPrompts()'),
    )
    const known = new Set([...mapBody.matchAll(/^\s{2}(\w+):\s*(?:true|false)/gm)].map(f => f[1]!))
    expect(known.size).toBeGreaterThan(20)

    const absent = [
      ...new Set(Object.values(scanGatedTools()).flat().filter(f => !known.has(f))),
    ].sort()
    expect(absent).toMatchSnapshot()
  })
})
