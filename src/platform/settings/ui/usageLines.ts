/**
 * The /usage Usage and Session tabs as rows of text: one string per terminal
 * row, styled inline, for the RawAnsi scroll pane (ink-tui.md §4). Pure, so
 * every layout is testable without mounting Ink.
 */
import chalk from 'chalk'

import { formatCost } from 'src/agent/cost-tracker.js'
import type {
  ProviderUsageGroup,
} from 'src/providers/usage/providerAttribution.js'
import type { ProviderLimits } from 'src/providers/usage/providerLimits.js'
import { addModelUsage, emptyModelUsage } from 'src/providers/usage/modelUsage.js'
import type {
  ContributionResult,
  UsageWindow,
} from 'src/platform/usageContribution/usageContribution.js'
import type { CostStateModelUsage } from 'src/shared/types/logs.js'
import {
  formatCountdownDuration,
  formatDuration,
  formatNumber,
  formatResetTime,
  formatTokens,
} from 'src/shared/text/format.js'
import { stringWidth } from 'src/terminal/ink/stringWidth.js'

/** The chip that shows every provider at once. */
export const ALL_PROVIDERS_KEY = '__all__'

export const ESTIMATED_NOTE =
  '~ estimated by model name (recorded before per-provider tracking)'

const CONTRIBUTION_ADVICE =
  'Each subagent runs its own requests. Be deliberate about spawning them — and consider a cheaper model for simpler subagents.'

export type ProviderChip = { key: string; label: string; active: boolean }

/** What the Limits section of a provider tab has to show. */
export type LimitsView =
  | { status: 'unsupported' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; limits: ProviderLimits }

export type ProjectTotalsView = {
  totalCost: number
  totalAPIDuration: number
  totalDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
}

type UsageRow = { marker: string; name: string; cost: string; tokens: string }

const bold = (s: string): string => chalk.bold(s)
const dim = (s: string): string => chalk.dim(s)

function tokenSummary(usage: CostStateModelUsage): string {
  let line = `${formatNumber(usage.inputTokens)} input, ${formatNumber(usage.outputTokens)} output`
  if (usage.cacheReadInputTokens > 0) {
    line += `, ${formatNumber(usage.cacheReadInputTokens)} cache read`
  }
  if (usage.cacheCreationInputTokens > 0) {
    line += `, ${formatNumber(usage.cacheCreationInputTokens)} cache write`
  }
  if (usage.webSearchRequests > 0) {
    line += `, ${formatNumber(usage.webSearchRequests)} web search`
  }
  return line
}

/**
 * Name, cost, then tokens, in aligned columns: a narrow terminal clips the
 * tail, and the tail is the least important part.
 */
function renderRows(rows: readonly UsageRow[], indent: string): string[] {
  const nameWidth = Math.max(0, ...rows.map(r => stringWidth(r.name)))
  const costWidth = Math.max(0, ...rows.map(r => r.cost.length))
  return rows.map(
    r =>
      `${indent}${r.marker}${r.name}${' '.repeat(nameWidth - stringWidth(r.name))}  ${r.cost.padStart(costWidth)}  ${dim(r.tokens)}`,
  )
}

/** One row per canonical model name, the costliest first; `~` if any of it is estimated. */
function modelRows(
  group: ProviderUsageGroup,
  canonicalName: (model: string) => string,
): UsageRow[] {
  const byName = new Map<string, { usage: CostStateModelUsage; estimated: boolean }>()
  const add = (model: string, usage: CostStateModelUsage, estimated: boolean): void => {
    const name = canonicalName(model)
    const entry = byName.get(name) ?? { usage: emptyModelUsage(), estimated: false }
    addModelUsage(entry.usage, usage)
    entry.estimated ||= estimated
    byName.set(name, entry)
  }
  for (const [model, usage] of Object.entries(group.exact)) add(model, usage, false)
  for (const [model, usage] of Object.entries(group.estimated)) add(model, usage, true)
  return [...byName.entries()]
    .sort(([, a], [, b]) => b.usage.costUSD - a.usage.costUSD)
    .map(([name, { usage, estimated }]) => ({
      marker: estimated ? '~ ' : '  ',
      name,
      cost: formatCost(usage.costUSD),
      tokens: tokenSummary(usage),
    }))
}

function groupTotal(group: ProviderUsageGroup): CostStateModelUsage {
  const total = emptyModelUsage()
  for (const usage of Object.values(group.exact)) addModelUsage(total, usage)
  for (const usage of Object.values(group.estimated)) addModelUsage(total, usage)
  return total
}

function hasUsage(group: ProviderUsageGroup): boolean {
  return Object.keys(group.exact).length > 0 || Object.keys(group.estimated).length > 0
}

function hasEstimate(groups: readonly ProviderUsageGroup[]): boolean {
  return groups.some(g => Object.keys(g.estimated).length > 0)
}

/** `Anthropic ●`, `Z.ai (removed)`, `Anthropic (no profile)`. */
export function chipLabel(group: ProviderUsageGroup): string {
  if (group.kind === 'removed') return `${group.name} (removed)`
  if (group.kind === 'env') return `${group.name} (no profile)`
  return group.active ? `${group.name} ●` : group.name
}

/**
 * ` All │ Anthropic ● │ Codex OAuth │ … `, the selected chip inverted. When
 * they do not fit, a window around the selected one, with `‹`/`›` saying
 * there is more on that side.
 */
export function buildProviderChips(
  chips: readonly ProviderChip[],
  selectedKey: string,
  width: number,
): string {
  if (chips.length === 0) return ''
  const cells = chips.map(c => ` ${c.label} `)
  const widths = cells.map(c => stringWidth(c))
  const selected = Math.max(0, chips.findIndex(c => c.key === selectedKey))
  const span = (lo: number, hi: number): number => {
    let w = hi - lo // separators
    for (let i = lo; i <= hi; i++) w += widths[i]!
    if (lo > 0) w += 2
    if (hi < chips.length - 1) w += 2
    return w
  }
  let lo = selected
  let hi = selected
  for (let grew = true; grew; ) {
    grew = false
    if (hi + 1 < chips.length && span(lo, hi + 1) <= width) {
      hi++
      grew = true
    }
    if (lo > 0 && span(lo - 1, hi) <= width) {
      lo--
      grew = true
    }
  }
  const parts: string[] = []
  for (let i = lo; i <= hi; i++) {
    parts.push(i === selected ? chalk.inverse.bold(cells[i]!) : cells[i]!)
  }
  return (
    (lo > 0 ? dim('‹ ') : '') +
    parts.join(dim('│')) +
    (hi < chips.length - 1 ? dim(' ›') : '')
  )
}

function totalsLines(
  totals: ProjectTotalsView,
  unknownCost: boolean,
): string[] {
  return [
    'Total cost:            ' +
      formatCost(totals.totalCost) +
      (unknownCost ? dim(' (costs may be inaccurate due to usage of unknown models)') : ''),
    'Total duration (API):  ' + formatDuration(totals.totalAPIDuration),
    'Total duration (wall): ' + formatDuration(totals.totalDuration),
    `Total code changes:    ${totals.totalLinesAdded} ${totals.totalLinesAdded === 1 ? 'line' : 'lines'} added, ${totals.totalLinesRemoved} ${totals.totalLinesRemoved === 1 ? 'line' : 'lines'} removed`,
  ]
}

function providerRows(groups: readonly ProviderUsageGroup[]): UsageRow[] {
  return groups.filter(hasUsage).map(group => {
    const total = groupTotal(group)
    return {
      // Any estimate marks the row: an exact cent beside thousands estimated
      // must not read as exact.
      marker: Object.keys(group.estimated).length > 0 ? '~ ' : '  ',
      name: chipLabel(group),
      cost: formatCost(total.costUSD),
      tokens: tokenSummary(total),
    }
  })
}

/** The All chip: the project's totals, then one row per provider. */
export function buildAllProvidersLines(input: {
  totals: ProjectTotalsView
  groups: readonly ProviderUsageGroup[]
  unknownCost: boolean
}): string[] {
  const lines = [bold('Project total (all sessions)'), ...totalsLines(input.totals, input.unknownCost)]
  const rows = providerRows(input.groups)
  if (rows.length > 0) {
    lines.push('Usage by provider:', ...renderRows(rows, ''))
    if (hasEstimate(input.groups)) lines.push(dim(ESTIMATED_NOTE))
  }
  lines.push(dim('Aggregated across all sessions in this project — includes the current session live.'))
  return lines
}

/**
 * `Resets in 3h 45m (7:20pm)` — how long first, the way the limit is
 * planned around; just the time once it has passed.
 */
function resetLine(resetsAt: string, nowMs: number): string | undefined {
  const resetsAtMs = Date.parse(resetsAt)
  if (!Number.isFinite(resetsAtMs)) return undefined
  const at = formatResetTime(resetsAtMs / 1000)
  if (!at) return undefined
  const remainingMs = resetsAtMs - nowMs
  return remainingMs > 0
    ? `Resets in ${formatCountdownDuration(remainingMs)} (${at})`
    : `Resets ${at}`
}

function limitsLines(
  limits: LimitsView,
  providerName: string,
  bar: (ratio: number) => string,
  error: (s: string) => string,
  nowMs: number,
): string[] {
  const lines = [bold('Limits')]
  switch (limits.status) {
    case 'unsupported':
      lines.push(dim(`Limits are not available for ${providerName}.`))
      return lines
    case 'loading':
      lines.push(dim('Loading limits…'))
      return lines
    case 'error':
      lines.push(error(`Could not load limits: ${limits.message}`))
      lines.push(dim('(usage below is unaffected) · r to retry'))
      return lines
    case 'ready':
      break
  }
  const { plan, rows, message } = limits.limits
  if (plan) lines.push(dim(`Plan: ${plan}`))
  if (rows.length === 0) {
    lines.push(dim(message ?? 'No limit data was returned for this account.'))
    return lines
  }
  rows.forEach((row, i) => {
    if (row.kind === 'text') {
      lines.push(row.value ? `${bold(row.label)}${dim(` · ${row.value}`)}` : bold(row.label))
      return
    }
    if (i > 0) lines.push('')
    lines.push(bold(row.label))
    lines.push(`${bar(row.usedPercent / 100)} ${Math.floor(row.usedPercent)}% used`)
    const reset = row.resetsAt ? resetLine(row.resetsAt, nowMs) : undefined
    if (reset) lines.push(dim(reset))
    if (row.extraSubtext) lines.push(dim(row.extraSubtext))
  })
  return lines
}

/** A provider chip: who it is, its limits, then what it spent in this project. */
export function buildProviderLines(input: {
  group: ProviderUsageGroup
  limits: LimitsView
  canonicalName: (model: string) => string
  bar: (ratio: number) => string
  error: (s: string) => string
  nowMs?: number
}): string[] {
  const { group } = input
  let header = bold(group.name)
  if (group.kind === 'removed') header += dim(' · removed from /provider')
  if (group.kind === 'env') header += dim(' · spent with no provider profile')
  if (group.active) header += dim(' · active')
  const lines = [header]
  if (group.kind === 'profile') {
    lines.push(
      '',
      ...limitsLines(input.limits, group.name, input.bar, input.error, input.nowMs ?? Date.now()),
    )
  }
  lines.push('', bold('Usage in this project (all sessions)'))
  if (!hasUsage(group)) {
    lines.push(dim('No usage recorded in this project yet.'))
    return lines
  }
  lines.push(`Total cost: ${formatCost(group.totalCostUSD)}`)
  lines.push(...renderRows(modelRows(group, input.canonicalName), ''))
  if (Object.keys(group.estimated).length > 0) lines.push(dim(ESTIMATED_NOTE))
  return lines
}

/** The Session tab: the session's totals, then each provider with its models. */
export function buildSessionLines(input: {
  totals: ProjectTotalsView
  groups: readonly ProviderUsageGroup[]
  unknownCost: boolean
  bytesSaved?: number
  bytesPerToken: number
  canonicalName: (model: string) => string
}): string[] {
  const lines = [bold('Current session'), ...totalsLines(input.totals, input.unknownCost)]
  if (input.bytesSaved !== undefined && input.bytesSaved > 0) {
    lines.push(`Context tokens saved:  ~${formatTokens(input.bytesSaved / input.bytesPerToken)} tokens`)
  }
  const used = input.groups.filter(hasUsage)
  if (used.length === 0) return lines
  lines.push('Usage by provider:')
  for (const group of used) {
    lines.push(`  ${bold(chipLabel(group))} ${dim('·')} ${formatCost(group.totalCostUSD)}`)
    lines.push(...renderRows(modelRows(group, input.canonicalName), '  '))
  }
  if (hasEstimate(used)) lines.push(dim(ESTIMATED_NOTE))
  return lines
}

/**
 * "What's driving your token usage?" — provider-agnostic, local-only analysis
 * of which sessions/subagents drove recent token usage, from
 * computeUsageContribution() (scans local transcripts; nothing is sent out).
 */
export function buildContributionLines(input: {
  window: UsageWindow
  result: ContributionResult | null
  loading: boolean
}): string[] {
  const { result } = input
  const windowLabel = input.window === 'day' ? 'last 24h' : 'last week'
  const lines = [
    bold("What's driving your token usage?"),
    dim('Approximate, based on local sessions on this machine — does not include other devices.'),
    dim(`${windowLabel[0]!.toUpperCase()}${windowLabel.slice(1)} · a characteristic of your usage, not a full breakdown`),
  ]
  if (input.loading && !result) {
    lines.push(dim('Analyzing local sessions…'))
    return lines
  }
  if (!result || result.totalTokens === 0) {
    lines.push(dim(`No local session activity in the ${windowLabel}.`))
    return lines
  }
  if (result.subagentHeavyPct >= 5) {
    lines.push('')
    lines.push(`${Math.round(result.subagentHeavyPct)}% of your token usage came from subagent-heavy sessions.`)
    lines.push(dim(CONTRIBUTION_ADVICE))
  }
  const topAgent = result.agentBreakdown[0]
  if (topAgent) {
    lines.push('')
    lines.push(`${Math.round(topAgent.pct)}% of your token usage came from subagents under '${topAgent.agentType}'.`)
  }
  if (result.agentBreakdown.length > 0) {
    lines.push('')
    lines.push('Subagents'.padEnd(24) + '% of usage')
    for (const a of result.agentBreakdown) {
      lines.push(a.agentType.padEnd(24) + `${Math.round(a.pct)}%`)
    }
  }
  return lines
}
