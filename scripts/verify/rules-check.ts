#!/usr/bin/env bun
/**
 * Fails the build when an auto-loaded rule file lies.
 *
 * Rules under `.claudin/rules/` (and AGENTS.md) are injected into context with
 * no validation, so a rule can be silently inert or silently unconditional and
 * look identical to a working one at runtime. This is the CI gate over
 * src/memory/instructions/rulesLint.ts; `/doctor` and `/refresh-rules` are the surfaces users
 * get, since a `scripts/` file only ever runs in this repo.
 *
 *   bun run scripts/verify/rules-check.ts            # report + exit non-zero on error
 *   bun run scripts/verify/rules-check.ts --quiet    # only print problems
 *   bun run scripts/verify/rules-check.ts --fix      # rewrite the stale numbers
 */
import {
  lintRuleFiles,
  relativeFindingPath,
  type RuleLintFinding,
} from '../../src/memory/instructions/rulesLint.js'
import { syncRuleMap } from '../../src/memory/instructions/rulesMapSync.js'
import { listTrackedFiles } from '../../src/memory/instructions/rulesLint.js'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { REPO_ROOT } from '../repoRoot'

const ROOT = REPO_ROOT
const QUIET = process.argv.includes('--quiet')
const FIX = process.argv.includes('--fix')

/**
 * Rewrites the claims that are mechanically derivable, and only those.
 *
 * The same healer the session-start sync uses, so `--fix` and an automatic
 * refresh can never produce different bytes. A dead directory or a wrong symbol
 * attribution is deliberately NOT fixed here: where a directory belongs in a
 * curated tree is judgment, and this is the surface that must not guess.
 */
async function fixInPlace(): Promise<void> {
  const trackedFiles = await listTrackedFiles(ROOT)
  if (!trackedFiles) {
    console.error('✗ --fix needs a git repo: `git ls-files` failed here.')
    process.exit(1)
  }

  const targets = [
    ...new Set(
      result.findings
        .filter(f => f.kind === 'dir_count_drift' || f.kind === 'stale_line_count')
        .map(f => f.file),
    ),
  ]

  const fileLines = new Map<string, number>()
  for (const relPath of trackedFiles) {
    try {
      const source = readFileSync(join(ROOT, relPath), 'utf8')
      const lines = source.split('\n').length
      fileLines.set(relPath, source.endsWith('\n') ? lines - 1 : lines)
    } catch {
      // Unreadable: the size claim about it simply goes unhealed.
    }
  }

  let healed = 0
  for (const file of targets) {
    const content = readFileSync(file, 'utf8')
    const next = syncRuleMap({ content, trackedFiles, fileLines })
    if (next === null || next === content) continue
    writeFileSync(file, next, 'utf8')
    healed += 1
    console.log(`  healed ${relativeFindingPath(ROOT, file)}`)
  }

  console.log(
    healed === 0
      ? '\n✓ nothing to heal — every derivable claim already matches the tree'
      : `\n✓ healed ${healed} rule ${healed === 1 ? 'file' : 'files'}; review with \`git diff\``,
  )
}

/**
 * Ceiling on what every session pays before it has done anything: AGENTS.md,
 * CLAUDE.md and every rule with no `paths:`.
 *
 * Measured 2026-08-15, right after AGENTS.md was cut from 18,534 to ~10,000
 * chars: 16,500 total. The headroom is deliberately thin (~20%) — a budget with
 * a year of slack does not ratchet, and this file grew to 75% of the always-on
 * cost precisely because nothing ever said no. When this fails, the fix is
 * almost always to move the new prose into a `paths:`-scoped rule, not to raise
 * the number.
 */
const ALWAYS_LOADED_CHAR_BUDGET = 20_000

const KIND_LABEL: Record<RuleLintFinding['kind'], string> = {
  unsupported_key: 'unsupported frontmatter key',
  malformed_paths: 'malformed paths',
  inert_paths: 'inert rule',
  missing_path: 'stale path reference',
  stale_line_count: 'stale size claim',
  wrong_attribution: 'wrong symbol attribution',
  dir_count_drift: 'stale directory count',
}

const result = await lintRuleFiles({ root: ROOT })

const errors = result.findings.filter(f => f.severity === 'error')
const warnings = result.findings.filter(f => f.severity === 'warning')

function print(findings: RuleLintFinding[], marker: string): void {
  const byFile = new Map<string, RuleLintFinding[]>()
  for (const finding of findings) {
    const key = relativeFindingPath(ROOT, finding.file)
    byFile.set(key, [...(byFile.get(key) ?? []), finding])
  }
  for (const [file, fileFindings] of [...byFile].sort()) {
    console.error(`\n${file}`)
    for (const finding of fileFindings) {
      console.error(
        `  ${marker} ${finding.line === undefined ? '' : `line ${finding.line}: `}${KIND_LABEL[finding.kind]}: ${finding.message}`,
      )
      console.error(`      fix: ${finding.fix}`)
    }
  }
}

if (errors.length > 0) print(errors, '✗')
if (warnings.length > 0) print(warnings, '!')

if (FIX) {
  await fixInPlace()
  process.exit(0)
}

if (!QUIET) {
  const budget = result.unconditional
    .map(
      r =>
        `${relativeFindingPath(ROOT, r.file)} (${r.chars.toLocaleString()} chars)`,
    )
    .sort()
  console.log(
    `\nChecked ${result.filesChecked} rule ${result.filesChecked === 1 ? 'file' : 'files'}.`,
  )
  console.log(
    `Always-loaded context: ${result.unconditional.length} — ${result.unconditionalChars.toLocaleString()} chars ` +
      `(~${Math.round(result.unconditionalChars / 4).toLocaleString()} tokens every turn)` +
      (budget.length > 0 ? `\n  ${budget.join('\n  ')}` : ''),
  )
}

const overBudget = result.unconditionalChars > ALWAYS_LOADED_CHAR_BUDGET
if (overBudget) {
  console.error(
    `\n✗ always-loaded context is ${result.unconditionalChars.toLocaleString()} chars, ` +
      `over the ${ALWAYS_LOADED_CHAR_BUDGET.toLocaleString()} budget by ` +
      `${(result.unconditionalChars - ALWAYS_LOADED_CHAR_BUDGET).toLocaleString()}.`,
  )
  console.error(
    `      fix: move the newest prose into a \`paths:\`-scoped rule under .claudin/rules/ ` +
      `so it loads only for the files it is about.`,
  )
}

if (errors.length > 0) {
  console.error(
    `\n✗ ${errors.length} rule ${errors.length === 1 ? 'error' : 'errors'}` +
      (warnings.length > 0 ? `, ${warnings.length} warnings` : ''),
  )
  process.exit(1)
}

if (overBudget) process.exit(1)

console.log(
  warnings.length > 0
    ? `\n✓ no rule errors (${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'})`
    : '\n✓ rules are consistent with the tree',
)
