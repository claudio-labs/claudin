/**
 * Tiny implementation of the bash-output-filter pipeline.
 * Mirrors the spec described in `docs/archive/discovery/bash-output-filter/analysis.md`.
 *
 * Pipeline stages (in order, matching rtk):
 *   1. stripAnsi
 *   2. replace (line-by-line, chained)
 *   3. matchOutput (whole blob, short-circuit with `unless`)
 *   4. stripLinesMatching | keepLinesMatching (mutually exclusive)
 *   5. truncateLineAt (per-line char cap)
 *   6. headLines + tailLines (first N + last M with omission marker)
 *   7. maxLines (absolute cap)
 *   8. onEmpty (message if result is empty)
 *
 * Pure, no IO. Returns { body, applied } so caller can introspect what fired.
 */

export interface ReplaceRule {
  pattern: RegExp
  replacement: string
}

export interface MatchOutputRule {
  pattern: RegExp
  message: string
  unless?: RegExp
}

export interface RewriteContext {
  command: string
  verb: string
  args: string[]
}

export interface FilterSpec {
  name: string
  matchCommand: RegExp
  matchCommandReject?: RegExp
  /**
   * NEW: rewrite the command before execution.
   * Returns new command string, or null/undefined to skip rewrite.
   * Receives parsed command for safe arg manipulation.
   */
  rewriteCommand?: (ctx: RewriteContext) => string | null | undefined
  stripAnsi?: boolean
  replace?: ReplaceRule[]
  /**
   * Collapse runs of CONSECUTIVE identical lines into `<line> (×N)`.
   * Cheap, safe, no false positives. Recommended on by default.
   */
  collapseRuns?: boolean
  /**
   * Collapse runs of CONSECUTIVE lines that differ only in digits
   * (`Progress: 12%` + `Progress: 13%` → 1 sample line + count).
   * Min run length to fire (default: 5) — avoids collapsing legitimate
   * numbered output (`line 1`, `line 2`, `line 3`).
   */
  collapseDigitTemplates?: boolean | { minRun?: number }
  /**
   * Global dedup — keeps ONLY first occurrence of each unique line, plus
   * a footer marker `[N duplicate lines deduplicated]`. More aggressive
   * than collapseRuns. Use with care: breaks output where repetition is
   * informative (heartbeat logs, throughput counters).
   */
  dedupGlobal?: boolean
  matchOutput?: MatchOutputRule[]
  stripLinesMatching?: RegExp[]
  keepLinesMatching?: RegExp[]
  truncateLineAt?: number
  headLines?: number
  tailLines?: number
  maxLines?: number
  onEmpty?: string
}

export interface PipelineResult {
  body: string
  applied: string[]
  shortCircuited?: boolean
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/**
 * Collapse runs of consecutive identical lines.
 * `["a", "a", "a", "b"]` → `["a (×3)", "b"]`
 */
function collapseIdenticalRuns(lines: string[]): string[] {
  if (lines.length === 0) return lines
  const out: string[] = []
  let runLine = lines[0] ?? ''
  let runCount = 1
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line === runLine) {
      runCount++
      continue
    }
    out.push(runCount > 1 ? `${runLine} (×${runCount})` : runLine)
    runLine = line
    runCount = 1
  }
  out.push(runCount > 1 ? `${runLine} (×${runCount})` : runLine)
  return out
}

/**
 * Collapse consecutive lines that match the same digit-template.
 * `Progress: 12%`, `Progress: 13%`, ..., `Progress: 99%` → `Progress: 12% (88 updates)`.
 * Only fires when run length ≥ minRun (default 5) — preserves legitimate
 * numbered output (`line 1`, `line 2`).
 */
function collapseDigitTemplates(lines: string[], minRun = 5): string[] {
  if (lines.length === 0) return lines
  const out: string[] = []
  let template: string | null = null
  let runStart = 0
  let runCount = 0

  const emitRun = (endExclusive: number) => {
    if (runCount >= minRun) {
      out.push(`${lines[runStart] ?? ''} (${runCount} updates)`)
    } else {
      for (let i = runStart; i < endExclusive; i++) {
        out.push(lines[i] ?? '')
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const t = line.replace(/\d+/g, '#')
    if (template !== null && t === template) {
      runCount++
      continue
    }
    if (template !== null) emitRun(i)
    template = t
    runStart = i
    runCount = 1
  }
  if (template !== null) emitRun(lines.length)
  return out
}

/**
 * Global dedup — first occurrence of each unique line wins.
 * Returns `[unique lines..., '[N duplicates deduplicated]']` if duplicates found.
 */
function dedupGlobal(lines: string[]): string[] {
  if (lines.length === 0) return lines
  const seen = new Set<string>()
  const out: string[] = []
  let dupCount = 0
  for (const line of lines) {
    if (line === '') {
      out.push(line)
      continue
    }
    if (seen.has(line)) {
      dupCount++
      continue
    }
    seen.add(line)
    out.push(line)
  }
  if (dupCount > 0) {
    out.push(`[${dupCount} duplicate lines deduplicated]`)
  }
  return out
}

export function applyFilter(filter: FilterSpec, raw: string): PipelineResult {
  const applied: string[] = []
  let lines = raw.split('\n')

  // Stage 1: strip ANSI
  if (filter.stripAnsi) {
    lines = lines.map(stripAnsi)
    applied.push('stripAnsi')
  }

  // Stage 2: replace (line-by-line, chained)
  if (filter.replace && filter.replace.length > 0) {
    lines = lines.map(line => {
      let result = line
      for (const rule of filter.replace!) {
        result = result.replace(rule.pattern, rule.replacement)
      }
      return result
    })
    applied.push('replace')
  }

  // Stage 2.5: dedup (collapseRuns → collapseDigitTemplates → dedupGlobal)
  // Order: most conservative first; global dedup last (most aggressive).
  if (filter.collapseRuns) {
    const before = lines.length
    lines = collapseIdenticalRuns(lines)
    if (lines.length < before) applied.push(`collapseRuns(-${before - lines.length})`)
  }
  if (filter.collapseDigitTemplates) {
    const before = lines.length
    const minRun =
      typeof filter.collapseDigitTemplates === 'object' &&
      filter.collapseDigitTemplates.minRun !== undefined
        ? filter.collapseDigitTemplates.minRun
        : 5
    lines = collapseDigitTemplates(lines, minRun)
    if (lines.length < before) applied.push(`collapseDigitTemplates(-${before - lines.length})`)
  }
  if (filter.dedupGlobal) {
    const before = lines.length
    lines = dedupGlobal(lines)
    if (lines.length !== before) applied.push(`dedupGlobal(-${before - lines.length + 1})`)
  }

  // Stage 3: matchOutput (short-circuit)
  if (filter.matchOutput && filter.matchOutput.length > 0) {
    const blob = lines.join('\n')
    for (const rule of filter.matchOutput) {
      if (rule.pattern.test(blob)) {
        if (rule.unless && rule.unless.test(blob)) continue
        applied.push(`matchOutput[${rule.message}]`)
        return { body: rule.message, applied, shortCircuited: true }
      }
    }
  }

  // Stage 4: strip OR keep
  if (filter.stripLinesMatching && filter.stripLinesMatching.length > 0) {
    lines = lines.filter(line =>
      !filter.stripLinesMatching!.some(re => re.test(line))
    )
    applied.push('stripLines')
  } else if (filter.keepLinesMatching && filter.keepLinesMatching.length > 0) {
    lines = lines.filter(line =>
      filter.keepLinesMatching!.some(re => re.test(line))
    )
    applied.push('keepLines')
  }

  // Stage 5: truncateLineAt
  if (filter.truncateLineAt && filter.truncateLineAt > 0) {
    const cap = filter.truncateLineAt
    lines = lines.map(line =>
      line.length > cap ? line.slice(0, cap) + '…' : line
    )
    applied.push('truncateLineAt')
  }

  // Stage 6: head + tail
  if (filter.headLines !== undefined && filter.tailLines !== undefined) {
    const total = lines.length
    if (total > filter.headLines + filter.tailLines) {
      const omitted = total - filter.headLines - filter.tailLines
      lines = [
        ...lines.slice(0, filter.headLines),
        `... (${omitted} lines omitted)`,
        ...lines.slice(-filter.tailLines),
      ]
      applied.push('headTail')
    }
  }

  // Stage 7: maxLines
  if (filter.maxLines && lines.length > filter.maxLines) {
    const omitted = lines.length - filter.maxLines
    lines = [
      ...lines.slice(0, filter.maxLines),
      `... (${omitted} more lines)`,
    ]
    applied.push('maxLines')
  }

  let body = lines.join('\n').trim()

  // Stage 8: onEmpty
  if (body === '' && filter.onEmpty) {
    body = filter.onEmpty
    applied.push('onEmpty')
  }

  return { body, applied }
}

export function matchesCommand(filter: FilterSpec, command: string): boolean {
  if (filter.matchCommandReject?.test(command)) return false
  return filter.matchCommand.test(command)
}

/**
 * Parse a bash command into verb + args. Tiny version — assumes simple commands.
 * For pipes/compounds, caller should detect with hasCompound() and skip rewrite.
 */
export function parseBashCommand(command: string): RewriteContext {
  const trimmed = command.trim()
  // Naive split — production version would use src/services/bash/commands.ts
  const tokens = trimmed.split(/\s+/)
  return {
    command: trimmed,
    verb: tokens[0] ?? '',
    args: tokens.slice(1),
  }
}

/**
 * Detect compound commands that should bypass rewrite.
 * If true, rewrite must NOT activate (would change pipe/compound semantics).
 */
export function hasCompound(command: string): boolean {
  return /[|&;]|&&|\|\|/.test(command)
}

/**
 * Apply rewrite if filter has it AND command is not compound.
 * Returns new command + info, or null if no rewrite happened.
 */
export function maybeRewrite(
  filter: FilterSpec,
  command: string,
): { rewritten: string; original: string } | null {
  if (!filter.rewriteCommand) return null
  if (hasCompound(command)) return null
  if (!matchesCommand(filter, command)) return null

  const ctx = parseBashCommand(command)
  const newCommand = filter.rewriteCommand(ctx)
  if (!newCommand || newCommand === command) return null

  return { rewritten: newCommand, original: command }
}
