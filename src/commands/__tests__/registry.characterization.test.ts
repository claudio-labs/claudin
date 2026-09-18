// Characterization of the slash-command registry, for the dead-code cleanup.
//
// Static, not runtime: `commands.ts` pulls in a large part of the Ink tree, and
// any module whose import chain reaches `src/terminal/ink.js` fails to load
// under `bun test` (the `@growthbook/growthbook` stub is a bundler-only alias).
// So the registry is recovered by scanning the source — which has the useful
// side effect of seeing the flag-gated entries that a flag-off runtime import
// would have resolved to null anyway.
//
// The scan is not just a snapshot. A command registered as
// `const x = feature('FLAG') ? require('./x/index.js').default : null` and
// spread into COMMANDS() is only real if the module behind the require exists:
// `scripts/build/build.ts` stubs a missing relative import to
// `const noop = () => null; export default noop`, and that noop is TRUTHY, so
// the conditional spread injects a function where a Command object belongs.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const COMMANDS_SOURCE = join(REPO_ROOT, 'src', 'commands', 'commands.ts')
const BUILD_SOURCE = join(REPO_ROOT, 'scripts', 'build', 'build.ts')

type GatedCommand = { binding: string; flags: string[]; specifier: string }

/**
 * `const name = feature('A') || feature('B') ? require('spec').default : null`
 *
 * The `[\s\S]*?` between the gate and the require covers the `as typeof import`
 * casts and the IIFE form that a few entries use.
 */
const GATED_COMMAND_RE =
  /const (\w+)\s*=\s*\n?\s*((?:feature\('\w+'\)(?:\s*(?:\|\||&&)\s*)?)+)\s*\n?\s*\?[\s\S]{0,200}?require\(\s*'([^']+)'/g

function scanGatedCommands(): GatedCommand[] {
  const source = readFileSync(COMMANDS_SOURCE, 'utf8')
  const out: GatedCommand[] = []
  GATED_COMMAND_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = GATED_COMMAND_RE.exec(source)) !== null) {
    out.push({
      binding: m[1]!,
      flags: [...m[2]!.matchAll(/feature\('(\w+)'\)/g)].map(f => f[1]!),
      specifier: m[3]!,
    })
  }
  return out.sort((a, b) => a.binding.localeCompare(b.binding))
}

/** Entries of the COMMANDS() array: bare names and conditional spreads alike. */
function scanRegisteredBindings(): string[] {
  const source = readFileSync(COMMANDS_SOURCE, 'utf8')
  const start = source.indexOf('const COMMANDS = memoize')
  expect(start).toBeGreaterThan(-1)
  // The array literal ends at the first `])` that closes memoize's arrow.
  const end = source.indexOf('\n])', start)
  expect(end).toBeGreaterThan(start)
  const body = source.slice(start, end)

  const names = new Set<string>()
  for (const line of body.split('\n')) {
    const spread = line.match(/^\s*\.\.\.\((\w+)\s*\?/)
    if (spread) {
      names.add(spread[1]!)
      continue
    }
    const bare = line.match(/^\s{2}(\w+),\s*$/)
    if (bare) names.add(bare[1]!)
  }
  return [...names].sort()
}

/** Flags the build map declares, with the value it folds them to. */
function shippedFlags(): Record<string, boolean> {
  const source = readFileSync(BUILD_SOURCE, 'utf8')
  const body = source.slice(
    source.indexOf('const featureFlags'),
    source.indexOf('checkAutoModeClassifierPrompts()'),
  )
  const out: Record<string, boolean> = {}
  for (const m of body.matchAll(/^\s{2}(\w+):\s*(true|false)/gm)) {
    out[m[1]!] = m[2] === 'true'
  }
  return out
}

/** Does a `require()` specifier from commands.ts reach a real implementation? */
function resolvesToImplementation(specifier: string): boolean {
  const base = specifier.startsWith('src/')
    ? join(REPO_ROOT, specifier)
    : resolve(dirname(COMMANDS_SOURCE), specifier)
  const withoutExt = base.replace(/\.js$/, '')
  // A `.d.ts` deliberately does NOT count: it declares a module this fork never
  // received, resolves for tsc and for nothing else, and the bundler replaces
  // the import with a noop stub.
  return ['.ts', '.tsx', '.js'].some(ext => existsSync(withoutExt + ext))
}

describe('slash-command registry — characterization', () => {
  test('the registered bindings match the snapshot', () => {
    expect(scanRegisteredBindings()).toMatchSnapshot()
  })

  test('the flag-gated command table matches the snapshot', () => {
    expect(scanGatedCommands()).toMatchSnapshot()
  })

  test('the scans actually found something', () => {
    // A regex that matches nothing would snapshot an empty array and stay green
    // through the whole cleanup while guarding exactly nothing.
    //
    // The gated floor was 5, then 2, and is 1 now: the dead-flag cleanup took
    // `torch` (TORCH) and both WORKFLOW_SCRIPTS bindings (`workflowsCmd`,
    // `getWorkflowCommands`) out, then `clearSkillIndexCache`
    // (EXPERIMENTAL_SKILL_SEARCH) and `forceSnip` (HISTORY_SNIP) — two
    // entries left, `agentWorkflowsCmd` and `bridge`, both behind flags the
    // map ships true. `agentWorkflowsCmd` still requires the same
    // `src/commands/workflows/index.js` that `workflowsCmd` did, behind the
    // live AGENT_WORKFLOWS flag — the module is NOT dead.
    expect(scanRegisteredBindings().length).toBeGreaterThan(50)
    expect(scanGatedCommands().length).toBeGreaterThan(1)
  })

  test('no command is registered behind a true flag with no implementation', () => {
    // The `noop` phantom: FORK_SUBAGENT ships true, but src/commands/fork/ holds
    // only an index.d.ts, so the build substitutes `default = () => null`. That
    // value is truthy, so `...(forkCmd ? [forkCmd] : [])` spreads a bare arrow
    // function into COMMANDS() — and its inferred `.name` is "noop", which is
    // what the user sees in the command list.
    const flags = shippedFlags()
    const registered = new Set(scanRegisteredBindings())

    const phantoms = scanGatedCommands()
      .filter(c => registered.has(c.binding))
      .filter(c => c.flags.every(f => flags[f] === true))
      .filter(c => !resolvesToImplementation(c.specifier))
      .map(c => `${c.binding} → ${c.specifier} (flags: ${c.flags.join(', ')})`)

    expect(phantoms).toEqual([])
  })
})
