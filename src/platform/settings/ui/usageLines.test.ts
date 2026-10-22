import { describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import stripAnsi from 'strip-ansi'

import {
  ALL_PROVIDERS_KEY,
  buildAllProvidersLines,
  buildProviderChips,
  buildProviderLines,
  buildSessionLines,
  chipLabel,
  ESTIMATED_NOTE,
  type LimitsView,
  type ProviderChip,
} from 'src/platform/settings/ui/usageLines.js'
import type { ProviderUsageGroup } from 'src/providers/usage/providerAttribution.js'
import type { CostStateModelUsage } from 'src/shared/types/logs.js'

function usage(partial: Partial<CostStateModelUsage>): CostStateModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    ...partial,
  }
}

function group(partial: Partial<ProviderUsageGroup>): ProviderUsageGroup {
  return {
    key: 'p',
    name: 'Anthropic',
    kind: 'profile',
    active: false,
    exact: {},
    estimated: {},
    totalCostUSD: 0,
    ...partial,
  }
}

const plain = (lines: readonly string[]): string[] => lines.map(l => stripAnsi(l))
const bar = (ratio: number): string => `[${Math.round(ratio * 10)}]`
const identity = (s: string): string => s
const canonical = (model: string): string => model.replace(/-\d{8}$/, '')

const TOTALS = {
  totalCost: 12.5,
  totalAPIDuration: 60_000,
  totalDuration: 120_000,
  totalLinesAdded: 1,
  totalLinesRemoved: 2,
}

describe('buildProviderChips', () => {
  const chips: ProviderChip[] = [
    { key: ALL_PROVIDERS_KEY, label: 'All', active: false },
    { key: 'a', label: 'Anthropic ●', active: true },
    { key: 'c', label: 'Codex OAuth', active: false },
    { key: 'o', label: 'OpenCode GO', active: false },
    { key: 'm', label: 'Moonshot AI', active: false },
    { key: 'r', label: 'OpenRouter', active: false },
  ]

  test('every chip in order when they fit', () => {
    expect(stripAnsi(buildProviderChips(chips, 'a', 200))).toBe(
      ' All │ Anthropic ● │ Codex OAuth │ OpenCode GO │ Moonshot AI │ OpenRouter ',
    )
  })

  test('the selected chip is the inverted one', () => {
    const level = chalk.level
    chalk.level = 3
    try {
      const line = buildProviderChips(chips, 'c', 200)
      expect(line).toContain(chalk.inverse.bold(' Codex OAuth '))
      expect(line).not.toContain(chalk.inverse.bold(' Anthropic ● '))
    } finally {
      chalk.level = level
    }
  })

  test.each([30, 40])('a narrow row windows around the selected chip (%d cols)', width => {
    const line = stripAnsi(buildProviderChips(chips, 'o', width))
    expect(line).toContain(' OpenCode GO ')
    expect(line.length).toBeLessThanOrEqual(width)
    expect(line.startsWith('‹ ')).toBe(true)
    expect(line.endsWith(' ›')).toBe(true)
  })

  test('the window grows to the far end before it gives up the near side', () => {
    expect(stripAnsi(buildProviderChips(chips, 'o', 60))).toBe(
      '‹  Codex OAuth │ OpenCode GO │ Moonshot AI │ OpenRouter ',
    )
  })

  test('no left marker when the window starts at the first chip', () => {
    const line = stripAnsi(buildProviderChips(chips, ALL_PROVIDERS_KEY, 40))
    expect(line.startsWith(' All │')).toBe(true)
    expect(line.endsWith(' ›')).toBe(true)
  })
})

test('chipLabel marks the active and the removed', () => {
  expect(chipLabel(group({ active: true }))).toBe('Anthropic ●')
  expect(chipLabel(group({ kind: 'removed', name: 'Z.ai' }))).toBe('Z.ai (removed)')
  expect(chipLabel(group({}))).toBe('Anthropic')
})

describe('buildAllProvidersLines', () => {
  test('totals, then one aligned row per provider with spend', () => {
    const lines = plain(
      buildAllProvidersLines({
        totals: TOTALS,
        unknownCost: false,
        groups: [
          group({ key: 'a', name: 'Anthropic', active: true, exact: { 'claude-opus-5-5': usage({ inputTokens: 1000, costUSD: 10 }) } }),
          group({ key: 'c', name: 'Codex OAuth' }),
          group({ key: 'o', name: 'OpenCode GO', estimated: { 'glm-5.1': usage({ inputTokens: 5, costUSD: 2.5 }) } }),
        ],
      }),
    )
    expect(lines.slice(0, 5)).toEqual([
      'Project total (all sessions)',
      'Total cost:            $12.50',
      'Total duration (API):  1m 0s',
      'Total duration (wall): 2m 0s',
      'Total code changes:    1 line added, 2 lines removed',
    ])
    expect(lines[5]).toBe('Usage by provider:')
    expect(lines[6]).toBe('  Anthropic ●  $10.00  1.0k input, 0 output')
    // Wholly estimated → marked; a provider with no spend gets no row.
    expect(lines[7]).toBe('~ OpenCode GO   $2.50  5 input, 0 output')
    expect(lines[8]).toBe(ESTIMATED_NOTE)
    expect(lines.some(l => l.includes('Codex OAuth'))).toBe(false)
    expect(lines.at(-1)).toContain('Aggregated across all sessions')
  })

  test('no provider section and no note without spend', () => {
    const lines = plain(buildAllProvidersLines({ totals: TOTALS, unknownCost: true, groups: [group({})] }))
    expect(lines[1]).toContain('(costs may be inaccurate due to usage of unknown models)')
    expect(lines).not.toContain('Usage by provider:')
    expect(lines).not.toContain(ESTIMATED_NOTE)
  })
})

describe('buildProviderLines', () => {
  const rich = group({
    active: true,
    exact: {
      'claude-haiku-5-5-20260101': usage({ inputTokens: 10, costUSD: 0.5 }),
      'claude-opus-5-5': usage({ inputTokens: 2000, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, webSearchRequests: 1, costUSD: 9 }),
    },
    estimated: { 'claude-haiku-5-5': usage({ inputTokens: 5, costUSD: 0.25 }) },
    totalCostUSD: 9.75,
  })
  const render = (limits: LimitsView, g = rich): string[] =>
    plain(buildProviderLines({ group: g, limits, canonicalName: canonical, bar, error: identity }))

  test('header, limits, then the costliest model first; dated ids collapse', () => {
    const lines = render({
      status: 'ready',
      limits: {
        plan: 'Max',
        rows: [
          { kind: 'window', label: 'Current session', usedPercent: 6.4, resetsAt: '2026-10-22T16:00:00Z' },
          { kind: 'window', label: 'Extra usage', usedPercent: 50, extraSubtext: '$5.00 / $10.00 spent' },
          { kind: 'text', label: 'Credits', value: '12' },
        ],
      },
    })
    expect(lines.slice(0, 6)).toEqual(['Anthropic · active', '', 'Limits', 'Plan: Max', 'Current session', '[1] 6% used'])
    expect(lines[6]).toStartWith('Resets ')
    expect(lines.slice(7, 12)).toEqual(['', 'Extra usage', '[5] 50% used', '$5.00 / $10.00 spent', 'Credits · 12'])
    const usageAt = lines.indexOf('Usage in this project (all sessions)')
    expect(lines[usageAt + 1]).toBe('Total cost: $9.75')
    expect(lines[usageAt + 2]).toBe(
      '  claude-opus-5-5   $9.00  2.0k input, 0 output, 3 cache read, 4 cache write, 1 web search',
    )
    // The dated haiku id and its estimated rest are one row, marked.
    expect(lines[usageAt + 3]).toBe('~ claude-haiku-5-5  $0.75  15 input, 0 output')
    expect(lines.at(-1)).toBe(ESTIMATED_NOTE)
  })

  test.each<[LimitsView, string]>([
    [{ status: 'unsupported' }, 'Limits are not available for Anthropic.'],
    [{ status: 'loading' }, 'Loading limits…'],
    [{ status: 'error', message: 'boom' }, 'Could not load limits: boom'],
    [{ status: 'ready', limits: { rows: [], message: 'Ask your admin.' } }, 'Ask your admin.'],
    [{ status: 'ready', limits: { rows: [] } }, 'No limit data was returned for this account.'],
  ])('limits state %j', (limits, text) => {
    expect(render(limits)[3]).toBe(text)
  })

  test('an error offers the retry key', () => {
    expect(render({ status: 'error', message: 'x' })[4]).toBe('(usage below is unaffected) · r to retry')
  })

  test('no spend yet says so', () => {
    const lines = render({ status: 'unsupported' }, group({ name: 'Codex OAuth' }))
    expect(lines.at(-1)).toBe('No usage recorded in this project yet.')
  })

  test('a removed profile has no limits section', () => {
    const lines = render({ status: 'loading' }, group({ kind: 'removed', name: 'Z.ai' }))
    expect(lines[0]).toBe('Z.ai · removed from /provider')
    expect(lines).not.toContain('Limits')
  })
})

describe('buildSessionLines', () => {
  test('each provider with spend, then its models indented', () => {
    const lines = plain(
      buildSessionLines({
        totals: TOTALS,
        unknownCost: false,
        bytesSaved: 4000,
        bytesPerToken: 4,
        canonicalName: canonical,
        groups: [
          group({ key: 'a', name: 'Anthropic', active: true, exact: { 'claude-haiku-4-5': usage({ inputTokens: 680, outputTokens: 25, costUSD: 0.0008 }) }, totalCostUSD: 0.0008 }),
          group({ key: 'c', name: 'Codex OAuth' }),
        ],
      }),
    )
    expect(lines[0]).toBe('Current session')
    expect(lines[5]).toBe('Context tokens saved:  ~1k tokens')
    expect(lines.slice(6)).toEqual([
      'Usage by provider:',
      '  Anthropic ● · $0.0008',
      '    claude-haiku-4-5  $0.0008  680 input, 25 output',
    ])
  })

  test('nothing after the totals without spend', () => {
    const lines = plain(
      buildSessionLines({ totals: TOTALS, unknownCost: false, bytesPerToken: 4, canonicalName: canonical, groups: [] }),
    )
    expect(lines).toHaveLength(5)
  })
})
