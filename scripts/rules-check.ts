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
 *   bun run scripts/rules-check.ts            # report + exit non-zero on error
 *   bun run scripts/rules-check.ts --quiet    # only print problems
 */
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
  lintRuleFiles,
  relativeFindingPath,
  type RuleLintFinding,
} from '../src/memory/instructions/rulesLint.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const QUIET = process.argv.includes('--quiet')

const KIND_LABEL: Record<RuleLintFinding['kind'], string> = {
  unsupported_key: 'unsupported frontmatter key',
  malformed_paths: 'malformed paths',
  inert_paths: 'inert rule',
  missing_path: 'stale path reference',
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
        `  ${marker} ${KIND_LABEL[finding.kind]}: ${finding.message}`,
      )
      console.error(`      fix: ${finding.fix}`)
    }
  }
}

if (errors.length > 0) print(errors, '✗')
if (warnings.length > 0) print(warnings, '!')

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
    `Always-loaded rules: ${result.unconditional.length} — ${result.unconditionalChars.toLocaleString()} chars ` +
      `(~${Math.round(result.unconditionalChars / 4).toLocaleString()} tokens every turn)` +
      (budget.length > 0 ? `\n  ${budget.join('\n  ')}` : ''),
  )
}

if (errors.length > 0) {
  console.error(
    `\n✗ ${errors.length} rule ${errors.length === 1 ? 'error' : 'errors'}` +
      (warnings.length > 0 ? `, ${warnings.length} warnings` : ''),
  )
  process.exit(1)
}

console.log(
  warnings.length > 0
    ? `\n✓ no rule errors (${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'})`
    : '\n✓ rules are consistent with the tree',
)
