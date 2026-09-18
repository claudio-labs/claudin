import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { expect, test } from 'bun:test'
import { loadShippedFeatureFlags } from './parseFeatureFlags'
import { REPO_ROOT } from '../repoRoot'

// Regression guard for #856. Several build feature flags require source files
// that are not mirrored into the open build. When such a flag is set to `true`
// without the source present, the bundler falls back to a missing-module stub
// that only exports `default`, which causes runtime errors like
// `fetchMcpSkillsForClient is not a function` when downstream code reaches
// through the `require()` to a named export.
//
// This test fails fast at test-time if someone re-enables one of these flags
// without first mirroring the corresponding source file.

type FlagGuard = {
  flag: string
  source: string // path relative to repo root
}

const FLAG_REQUIRES_SOURCE: FlagGuard[] = [
  { flag: 'MCP_SKILLS', source: 'src/skills/mcpSkills.ts' },
]

test('build feature flags are not enabled without their source files', () => {
  // Parsed, not regex-matched against the whole file: a `FLAG: true` in a
  // comment or in some other object literal is not a shipped flag.
  const flags = loadShippedFeatureFlags()

  for (const { flag, source } of FLAG_REQUIRES_SOURCE) {
    const isEnabled = flags[flag] === true
    const sourceExists = existsSync(join(REPO_ROOT, source))

    if (isEnabled && !sourceExists) {
      throw new Error(
        `Feature flag ${flag} is enabled in scripts/build/build.ts, but its required source file "${source}" does not exist. ` +
          `Enabling this flag without the source will cause runtime errors (missing named exports from the missing-module stub). ` +
          `Either mirror the source file or set ${flag}: false.`,
      )
    }
  }

  // When the source IS present, the flag can be either true or false; either is
  // fine — we only care about the "enabled but missing" combination. What does
  // need asserting is that the loop above ran at all: an empty table (or a
  // parser that returned {}) would make this suite pass while checking nothing.
  expect(FLAG_REQUIRES_SOURCE.length).toBeGreaterThan(0)
  expect(Object.keys(flags).length).toBeGreaterThan(20)
})

// ───────────────────────────────────────────────────────────────────────────
// The off-map set.
//
// `build.ts` folds `featureFlags[name] ?? false`, so a `feature('X')` naming
// something the map does not list is silently false — its comment says as much:
// "the absence of a flag is NOT a decision". Nothing enforced that, so the set
// grew to 44 unseen, and at the call site an off-map flag is indistinguishable
// from one deliberately shipped off.
//
// This is a ratchet, not a hit list. "Off-map" turned out to be at least three
// different things, which is exactly why a blanket sweep is the wrong tool:
//
//   toolchain    Set per build target or on the command line, never in the map.
//                Removing one BREAKS something — `bun --feature=ALLOW_TEST_VERSIONS`
//                is how `bun run smoke` reaches the 99.99.x install path, and
//                IS_LIBC_MUSL/GLIBC are compile-target pins that `envDynamic.ts`
//                falls back to runtime detection without.
//   absent module  Gates a `require()` of a module this fork never received. The
//                require is already a build stub, so the branch costs a line.
//   dead local   Gates code that IS in this tree and can never run. The removal
//                candidates live here — but each needs its own trace: some have a
//                live side-door (`conversationArc.ts` is reached from /knowledge
//                as well as from behind CONVERSATION_ARC).
//
// A NEW name here fails this test: add it to the map if it is a real switch, or
// list it below with which of the three it is. Removing the last call site of a
// listed flag also fails — drop the entry in the same change.
// ───────────────────────────────────────────────────────────────────────────

const TOOLCHAIN_FLAGS = new Set([
  'ALLOW_TEST_VERSIONS', // bun --feature=…, used by `bun run smoke`
  'IS_LIBC_MUSL', // compile-target pin; falls back to runtime detection
  'IS_LIBC_GLIBC', // idem
  'HARD_FAIL', // debug build: --hard-fail crashes on logError
])

const OFF_MAP_FLAGS = [
  ...TOOLCHAIN_FLAGS,
  'AGENT_MEMORY_SNAPSHOT',
  'AUTO_THEME',
  'BYOC_ENVIRONMENT_RUNNER',
  'CCR_AUTO_CONNECT',
  'CCR_MIRROR',
  'COMPACTION_REMINDERS',
  'CONNECTOR_TEXT',
  'CONVERSATION_ARC',
  'DIRECT_CONNECT',
  'EXPERIMENTAL_SKILL_SEARCH',
  'HISTORY_SNIP',
  'HOOK_CHAINS',
  'LODESTONE',
  'MCP_RICH_OUTPUT',
  'MEMORY_SHAPE_TELEMETRY',
  'NATIVE_CLIENT_ATTESTATION',
  'NATIVE_CLIPBOARD_IMAGE',
  'OVERFLOW_TEST_TOOL',
  'POWERSHELL_AUTO_MODE',
  'REACTIVE_COMPACT',
  'REVIEW_ARTIFACT',
  'RUN_SKILL_GENERATOR',
  'SELF_HOSTED_RUNNER',
  'SLOW_OPERATION_LOGGING',
  'SSH_REMOTE',
  'TEMPLATES',
  'TERMINAL_PANEL',
  'TORCH',
  'TREE_SITTER_BASH',
  'TREE_SITTER_BASH_SHADOW',
  'UNATTENDED_RETRY',
  'WORKFLOW_SCRIPTS',
]

const FEATURE_CALL_RE = /\bfeature\('([A-Z0-9_]+)'\)/g

/** Every flag name a shipped `src/` file passes to `feature()`. */
function scanFeatureNames(): Set<string> {
  const names = new Set<string>()
  function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '__fixtures__') continue
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(full)
        continue
      }
      // Test files are skipped for the same reason the build's import pre-scan
      // skips them: a fixture string is indistinguishable from a real call.
      if (!/\.tsx?$/.test(ent.name) || /\.test\.tsx?$/.test(ent.name)) continue
      const source = readFileSync(full, 'utf8')
      if (!source.includes("feature('")) continue
      FEATURE_CALL_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = FEATURE_CALL_RE.exec(source)) !== null) names.add(m[1]!)
    }
  }
  walk(join(REPO_ROOT, 'src'))
  return names
}

test('no feature() name is off-map without being listed', () => {
  const flags = loadShippedFeatureFlags()
  const used = scanFeatureNames()
  const offMap = [...used].filter(name => !(name in flags)).sort()

  expect(offMap).toEqual([...OFF_MAP_FLAGS].sort())
})

test('the scanner sees the map itself, so an empty result cannot pass', () => {
  // Without this, a walk that silently found nothing would make the test above
  // compare [] against [] the moment OFF_MAP_FLAGS were emptied too — and a
  // broken scanner is exactly how the 44 stayed invisible in the first place.
  const used = scanFeatureNames()
  const flags = loadShippedFeatureFlags()
  const inMapAndUsed = [...used].filter(name => name in flags)
  expect(inMapAndUsed.length).toBeGreaterThan(20)
  expect(used.has('COORDINATOR_MODE')).toBe(true)
})

test('a toolchain flag is off-map on purpose, not pending removal', () => {
  // Pins the distinction the list above draws. These four are set by the build
  // target or the command line; treating them as dead code would break
  // `bun run smoke` and musl detection.
  for (const name of TOOLCHAIN_FLAGS) {
    expect(OFF_MAP_FLAGS).toContain(name)
  }
  expect(TOOLCHAIN_FLAGS.size).toBeLessThan(OFF_MAP_FLAGS.length)
})
