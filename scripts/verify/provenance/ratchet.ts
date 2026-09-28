/**
 * The comparison behind provenance-ci.ts, kept free of I/O so it can be tested.
 *
 * Per file, not per tree: a total would let one file's copy hide behind
 * another file's rewrite. A file missing from the baseline is allowed nothing,
 * which is also what makes a move visible: the moved file shows up as new
 * inherited code until the baseline is refreshed in the same change.
 */
import type { Row } from './scan.js'

/** `[claudeCode, openclaude]` inherited lines. */
export type Allowance = [number, number]

export type Baseline = {
  capturedAt: string
  capturedFrom: string
  files: Record<string, Allowance>
}

export type Growth = { file: string; now: Allowance; allowed: Allowance }

export type Comparison = {
  grown: Growth[]
  /** Inherited lines the tree has shed since the baseline, over every file. */
  shed: number
  now: Allowance
  baseline: Allowance
}

export function totals(files: Record<string, Allowance>): Allowance {
  let claudeCode = 0
  let openclaude = 0
  for (const [cc, oc] of Object.values(files)) {
    claudeCode += cc
    openclaude += oc
  }
  return [claudeCode, openclaude]
}

export function toAllowances(rows: Row[]): Record<string, Allowance> {
  const files: Record<string, Allowance> = {}
  for (const row of rows) {
    if (row.claudeCode + row.openclaude > 0) files[row.file] = [row.claudeCode, row.openclaude]
  }
  return files
}

export function compare(rows: Row[], baseline: Baseline): Comparison {
  const grown: Growth[] = []
  let shed = 0
  const seen = new Set<string>()
  for (const row of rows) {
    seen.add(row.file)
    const allowed = baseline.files[row.file] ?? [0, 0]
    const now: Allowance = [row.claudeCode, row.openclaude]
    if (now[0] > allowed[0] || now[1] > allowed[1]) grown.push({ file: row.file, now, allowed })
    shed += Math.max(0, allowed[0] - now[0]) + Math.max(0, allowed[1] - now[1])
  }
  // A deleted file sheds everything it was allowed.
  for (const [file, [cc, oc]] of Object.entries(baseline.files)) {
    if (!seen.has(file)) shed += cc + oc
  }
  return { grown, shed, now: totals(toAllowances(rows)), baseline: totals(baseline.files) }
}

/**
 * Hand-rolled like typecheck-baseline.json: one file per line, sorted, so a
 * refresh diffs as the files that shrank, grew or vanished.
 */
export function serializeBaseline(baseline: Baseline): string {
  const entries = Object.entries(baseline.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const [claudeCode, openclaude] = totals(baseline.files)
  return [
    '{',
    '  "//": "Generated — do not hand-edit. Refresh with `bun run provenance:baseline`. Per file: [Claude Code, openclaude] inherited lines.",',
    `  "capturedAt": ${JSON.stringify(baseline.capturedAt)},`,
    `  "capturedFrom": ${JSON.stringify(baseline.capturedFrom)},`,
    `  "totals": { "claudeCode": ${claudeCode}, "openclaude": ${openclaude} },`,
    '  "files": {',
    ...entries.map(([file, [cc, oc]], i) => `    ${JSON.stringify(file)}: [${cc}, ${oc}]${i === entries.length - 1 ? '' : ','}`),
    '  }',
    '}',
    '',
  ].join('\n')
}
