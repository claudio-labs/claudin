/**
 * The /usage Usage and Session tabs.
 *
 * Usage has a chip per registered provider profile, stepped with `[`/`]`
 * (←/→ belong to the Settings tab row), plus an All chip. A provider's chip
 * shows its limits — read for that profile, whichever one is active — and
 * what it spent in this project; All shows the project's totals split by
 * provider. Session splits the session's spend the same way.
 *
 * Both tabs render as a flat string[] windowed with RawAnsi (ink-tui.md §4):
 * the Settings tab clips with a fixed-height Box, which inline render mode
 * does not honor, so a tall tab would spill past the viewport.
 */
import * as React from 'react'
import { useEffect, useMemo, useReducer, useState } from 'react'

import { getBytesSaved } from 'src/agent/context/tokensSaved.js'
import {
  getModelUsage,
  getProjectTotals,
  getProviderUsage,
  getTotalAPIDuration,
  getTotalCost,
  getTotalDuration,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  hasUnknownModelCost,
} from 'src/agent/cost-tracker.js'
import { getGlobalConfig } from 'src/platform/config/config.js'
import {
  ALL_PROVIDERS_KEY,
  buildAllProvidersLines,
  buildContributionLines,
  buildProviderChips,
  buildProviderLines,
  buildSessionLines,
  chipLabel,
  type LimitsView,
} from 'src/platform/settings/ui/usageLines.js'
import {
  computeUsageContribution,
  type ContributionResult,
  type UsageWindow,
} from 'src/platform/usageContribution/usageContribution.js'
import { getCanonicalName } from 'src/providers/model/model.js'
import { getAPIProviderForProfile } from 'src/providers/model/providers.js'
import {
  resolveProviderProfile,
  tryGetActiveProvider,
  type ResolvedProvider,
} from 'src/providers/presets/activeProvider.js'
import { getProviderProfiles } from 'src/providers/presets/providerProfiles.js'
import {
  groupUsageByProvider,
  type AttributionProfile,
  type ProviderUsageGroup,
} from 'src/providers/usage/providerAttribution.js'
import {
  getLimitsFetcher,
  type LimitsFetcher,
} from 'src/providers/usage/providerLimits.js'
import { logError } from 'src/shared/log.js'
import sliceAnsi from 'src/shared/text/sliceAnsi.js'
import { useModalOrTerminalSize } from 'src/terminal/contexts/modalContext.js'
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js'
import { Box, RawAnsi, Text, useTheme } from 'src/terminal/ink.js'
import { colorize } from 'src/terminal/ink/colorize.js'
import { stringWidth } from 'src/terminal/ink/stringWidth.js'
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js'
import { BYTES_PER_TOKEN } from 'src/tools/constants/toolLimits.js'

type CostView = 'global' | 'session'

const MODEL_LIST_SEPARATOR_RE = /\s*,\s*/

type RegisteredProvider = {
  attribution: AttributionProfile
  resolved: ResolvedProvider
}

/** Every registered profile, resolved, with the models it is known to serve. */
function registeredProviders(): RegisteredProvider[] {
  const config = getGlobalConfig()
  const discovered = config.openaiAdditionalModelOptionsCacheByProfile ?? {}
  return getProviderProfiles(config).map(profile => {
    const resolved = resolveProviderProfile(profile)
    const models = new Set(
      profile.model.split(MODEL_LIST_SEPARATOR_RE).filter(Boolean),
    )
    if (resolved.model) models.add(resolved.model)
    const configuredModels = [...models]
    for (const option of discovered[profile.id] ?? []) {
      if (option.value) models.add(option.value)
    }
    return {
      resolved,
      attribution: {
        id: profile.id,
        name: profile.name,
        kind: getAPIProviderForProfile(resolved),
        baseUrl: profile.baseUrl,
        models: [...models],
        configuredModels,
      },
    }
  })
}

function activeProviderKey(): string | undefined {
  return tryGetActiveProvider()?.profileId
}

/** The ↑/↓ window over a list of rows, as RawAnsi needs it: one row per entry. */
function useScrollWindow(lines: readonly string[], bodyRows: number, width: number) {
  const [offset, setOffset] = useState(0)
  const scrollUp = () => setOffset(o => Math.max(0, o - 1))
  const scrollDown = () => setOffset(o => o + 1)
  const kb = { context: 'Settings' as const, isActive: true }
  useKeybinding('select:previous', scrollUp, kb)
  useKeybinding('select:next', scrollDown, kb)
  useKeybinding('scroll:lineUp', scrollUp, kb)
  useKeybinding('scroll:lineDown', scrollDown, kb)

  const maxOffset = Math.max(0, lines.length - bodyRows)
  // Adjust-state-during-render (React-blessed pattern): clamp a runaway offset
  // from repeated ↓ so it doesn't grow unbounded. Guarded, so it bails fast.
  if (offset > maxOffset) setOffset(maxOffset)
  const clamped = Math.min(offset, maxOffset)
  const visible = lines
    .slice(clamped, clamped + bodyRows)
    .map(line => (stringWidth(line) > width ? sliceAnsi(line, 0, width - 1) + '…' : line))
  return {
    visible,
    above: clamped,
    below: lines.length - (clamped + visible.length),
    reset: () => setOffset(0),
  }
}

function usePaneSize(reservedRows: number): { width: number; bodyRows: number } {
  const term = useTerminalSize()
  const { rows } = useModalOrTerminalSize(term)
  const width = Math.max(20, term.columns - 2)
  const cap = Math.max(15, Math.min(Math.floor(rows * 0.8), 30))
  return { width, bodyRows: Math.max(5, cap - reservedRows) }
}

/** Re-renders every second, so live counters stay live. */
function useSecondTick(): void {
  const [, tick] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    const id = setInterval(() => tick(), 1000)
    return () => clearInterval(id)
  }, [])
}

export function Usage(props: { view?: CostView } = {}): React.ReactNode {
  return props.view === 'session' ? <SessionUsage /> : <UsageByProvider />
}

function SessionUsage(): React.ReactNode {
  useSecondTick()
  const { width, bodyRows } = usePaneSize(3)
  const providers = useMemo(registeredProviders, [])

  const modelUsage = getModelUsage()
  const totals = {
    totalCost: getTotalCost(),
    totalAPIDuration: getTotalAPIDuration(),
    totalDuration: getTotalDuration(),
    totalLinesAdded: getTotalLinesAdded(),
    totalLinesRemoved: getTotalLinesRemoved(),
  }
  const isEmpty =
    totals.totalCost === 0 &&
    Object.keys(modelUsage).length === 0 &&
    totals.totalLinesAdded === 0 &&
    totals.totalLinesRemoved === 0
  const lines = isEmpty
    ? []
    : buildSessionLines({
        totals,
        groups: groupUsageByProvider({
          modelUsage,
          providerUsage: getProviderUsage(),
          profiles: providers.map(p => p.attribution),
          activeKey: activeProviderKey(),
        }),
        unknownCost: hasUnknownModelCost(),
        bytesSaved: getBytesSaved(),
        bytesPerToken: BYTES_PER_TOKEN,
        canonicalName: getCanonicalName,
      })
  const pane = useScrollWindow(lines, bodyRows, width)
  if (isEmpty) return null
  return (
    <Box flexDirection="column" width="100%">
      <Text dimColor>{pane.above > 0 ? `↑ ${pane.above} more above` : ' '}</Text>
      <RawAnsi lines={pane.visible} width={width} />
      <Text dimColor>{pane.below > 0 ? `↓ ${pane.below} more below` : ' '}</Text>
      <Text dimColor>↑↓ scroll · Esc to close</Text>
    </Box>
  )
}

function UsageByProvider(): React.ReactNode {
  useSecondTick()
  const theme = useTheme()
  const { width, bodyRows } = usePaneSize(5)
  const barWidth = Math.min(50, Math.max(20, Math.min(width, 80) - 14))

  const providers = useMemo(registeredProviders, [])
  const activeKey = activeProviderKey()
  const totals = getProjectTotals()
  const groups = groupUsageByProvider({
    modelUsage: totals.modelUsage,
    providerUsage: totals.providerUsage,
    profiles: providers.map(p => p.attribution),
    activeKey,
  })
  const keys = [ALL_PROVIDERS_KEY, ...groups.map(g => g.key)]

  const [selectedKey, setSelectedKey] = useState(() =>
    activeKey !== undefined && groups.some(g => g.key === activeKey)
      ? activeKey
      : ALL_PROVIDERS_KEY,
  )
  const [limits, setLimits] = useState<Record<string, LimitsView>>({})
  const [contribWindow, setContribWindow] = useState<UsageWindow>('day')
  const [contrib, setContrib] = useState<ContributionResult | null>(null)
  const [contribLoading, setContribLoading] = useState(true)

  const selected: ProviderUsageGroup | undefined = groups.find(
    g => g.key === selectedKey,
  )
  const provider = providers.find(p => p.attribution.id === selectedKey)
  const fetchLimits = provider
    ? getLimitsFetcher(provider.attribution.kind)
    : undefined

  const loadLimits = React.useCallback(
    async (key: string, read: LimitsFetcher, resolved: ResolvedProvider) => {
      setLimits(prev => ({ ...prev, [key]: { status: 'loading' } }))
      try {
        const result = await read(resolved)
        setLimits(prev => ({ ...prev, [key]: { status: 'ready', limits: result } }))
      } catch (err) {
        logError(err as Error)
        setLimits(prev => ({
          ...prev,
          [key]: { status: 'error', message: (err as Error)?.message || 'Failed to load usage data' },
        }))
      }
    },
    [],
  )

  // Limits are read only for the chip on screen: nobody is asked about a
  // provider whose chip the user never opened.
  const selectedState = limits[selectedKey]
  useEffect(() => {
    if (!provider || !fetchLimits || selectedState !== undefined) return
    void loadLimits(selectedKey, fetchLimits, provider.resolved)
  }, [selectedKey, provider, fetchLimits, selectedState, loadLimits])

  const loadContrib = React.useCallback(async (w: UsageWindow) => {
    setContribLoading(true)
    try {
      setContrib(await computeUsageContribution(w))
    } catch (err) {
      logError(err as Error)
      setContrib(null)
    } finally {
      setContribLoading(false)
    }
  }, [])
  useEffect(() => {
    void loadContrib(contribWindow)
  }, [loadContrib, contribWindow])

  const step = (delta: number) => {
    const at = Math.max(0, keys.indexOf(selectedKey))
    setSelectedKey(keys[(at + delta + keys.length) % keys.length]!)
    pane.reset()
  }
  const kb = { context: 'Settings' as const, isActive: true }
  useKeybinding('settings:usagePrevProvider', () => step(-1), kb)
  useKeybinding('settings:usageNextProvider', () => step(1), kb)
  useKeybinding('settings:usageDay', () => setContribWindow('day'), kb)
  useKeybinding('settings:usageWeek', () => setContribWindow('week'), kb)
  useKeybinding(
    'settings:retry',
    () => {
      if (provider && fetchLimits) void loadLimits(selectedKey, fetchLimits, provider.resolved)
    },
    { context: 'Settings', isActive: Boolean(provider && fetchLimits) },
  )

  const makeBar = (ratio: number): string => {
    const r = Math.min(1, Math.max(0, ratio))
    const whole = Math.floor(r * barWidth)
    return (
      colorize('█'.repeat(whole), theme.rate_limit_fill, 'foreground') +
      colorize(' '.repeat(Math.max(0, barWidth - whole)), theme.rate_limit_empty, 'background')
    )
  }

  const lines = selected
    ? buildProviderLines({
        group: selected,
        limits: fetchLimits ? (selectedState ?? { status: 'loading' }) : { status: 'unsupported' },
        canonicalName: getCanonicalName,
        bar: makeBar,
        error: s => colorize(s, theme.error, 'foreground'),
        nowMs: Date.now(),
      })
    : [
        ...buildAllProvidersLines({ totals, groups, unknownCost: hasUnknownModelCost() }),
        '',
        ...buildContributionLines({ window: contribWindow, result: contrib, loading: contribLoading }),
      ]
  const pane = useScrollWindow(lines, bodyRows, width)

  const chips = buildProviderChips(
    [
      { key: ALL_PROVIDERS_KEY, label: 'All', active: false },
      ...groups.map(g => ({ key: g.key, label: chipLabel(g), active: g.active })),
    ],
    selectedKey,
    width,
  )

  return (
    <Box flexDirection="column" width="100%">
      <RawAnsi lines={[chips]} width={width} />
      <Text dimColor>{pane.above > 0 ? `↑ ${pane.above} more above` : ' '}</Text>
      <RawAnsi lines={pane.visible} width={width} />
      <Text dimColor>{pane.below > 0 ? `↓ ${pane.below} more below` : ' '}</Text>
      <Text dimColor>
        {`↑↓ scroll · [ ] provider${fetchLimits ? ' · r refresh' : ''}${selected ? '' : ' · d/w day/week'} · Esc to close`}
      </Text>
    </Box>
  )
}
