import figures from 'figures'
import type React from 'react'
import { useRef, useState } from 'react'
import { Box, color, Text, useTheme } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { LspServerRow, LspServerStatus } from '../../services/lsp/builtinServers.js'
import { isLspGloballyEnabled } from '../../services/lsp/userSettings.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { plural } from '../../utils/stringUtils.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  rows: LspServerRow[]
  onSelectServer: (server: LspServerRow) => void
  onComplete: (result?: string) => void
}

type SelectableItem =
  | { type: 'master' }
  | { type: 'server'; server: LspServerRow }

type StatusGroupKey = 'detected' | 'missing' | 'installing' | 'disabled'

const GROUP_ORDER: StatusGroupKey[] = ['detected', 'missing', 'installing', 'disabled']

const GROUP_LABEL: Record<StatusGroupKey, string> = {
  detected: 'Detected',
  missing: 'Missing',
  installing: 'Installing',
  disabled: 'Disabled',
}

function statusGroup(status: LspServerStatus): StatusGroupKey {
  switch (status) {
    case '✓ detected': return 'detected'
    case '✗ missing': return 'missing'
    case '⏳ installing': return 'installing'
    case '⊘ disabled': return 'disabled'
  }
}

function renderStatus(
  status: LspServerStatus,
  theme: ReturnType<typeof useTheme>[0],
): { icon: string; label: string } {
  switch (status) {
    case '✓ detected':
      return { icon: color('success', theme)(figures.tick), label: 'detected' }
    case '✗ missing':
      return { icon: color('error', theme)(figures.cross), label: 'missing' }
    case '⏳ installing':
      return { icon: color('warning', theme)(figures.triangleUpOutline), label: 'installing' }
    case '⊘ disabled':
      return { icon: color('inactive', theme)(figures.radioOff), label: 'disabled' }
  }
}

function installerHint(row: LspServerRow): string | null {
  if (row.status !== '✗ missing') return null
  if (row.installer === 'manual (SDK)') {
    return row.name === 'dart' ? 'install via Dart SDK' : 'install manually'
  }
  return `install via ${row.installer}`
}

function groupServers(rows: LspServerRow[]): Record<StatusGroupKey, LspServerRow[]> {
  const groups: Record<StatusGroupKey, LspServerRow[]> = {
    detected: [], missing: [], installing: [], disabled: [],
  }
  for (const row of rows) groups[statusGroup(row.status)].push(row)
  for (const key of GROUP_ORDER) {
    groups[key].sort((a, b) => a.name.localeCompare(b.name))
  }
  return groups
}

export function LspListPanel({ rows, onSelectServer, onComplete }: Props): React.ReactNode {
  const [theme] = useTheme()
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [globalEnabled, setGlobalEnabled] = useState(() => isLspGloballyEnabled())

  const groups = groupServers(rows)

  const items: SelectableItem[] = [{ type: 'master' }]
  for (const key of GROUP_ORDER) {
    for (const server of groups[key]) items.push({ type: 'server', server })
  }

  const itemsRef = useRef(items)
  itemsRef.current = items
  const selectedIndexRef = useRef(selectedIndex)
  selectedIndexRef.current = selectedIndex
  const globalEnabledRef = useRef(globalEnabled)
  globalEnabledRef.current = globalEnabled

  const toggleGlobal = () => {
    const next = !globalEnabledRef.current
    setGlobalEnabled(next)
    updateSettingsForSource('userSettings', {
      // Schema's catchall narrows extra keys to per-server objects; this
      // partial only writes the master `enabled` field, so cast through.
      lsp: { enabled: next ? undefined : false } as never,
    })
  }

  useKeybindings(
    {
      'confirm:previous': () => {
        const total = itemsRef.current.length
        setSelectedIndex((i) => (i === 0 ? total - 1 : i - 1))
      },
      'confirm:next': () => {
        const total = itemsRef.current.length
        setSelectedIndex((i) => (i === total - 1 ? 0 : i + 1))
      },
      'confirm:toggle': () => {
        const item = itemsRef.current[selectedIndexRef.current]
        if (item?.type === 'master') toggleGlobal()
      },
      'confirm:yes': () => {
        const item = itemsRef.current[selectedIndexRef.current]
        if (!item) return
        if (item.type === 'master') {
          toggleGlobal()
          return
        }
        onSelectServer(item.server)
      },
    },
    { context: 'Confirmation' },
  )

  const totalServers = rows.length
  const detectedCount = groups.detected.length
  const missingCount = groups.missing.length
  const installingCount = groups.installing.length
  const disabledCount = groups.disabled.length

  const subtitleParts = [
    `${totalServers} ${plural(totalServers, 'server')}`,
    `${detectedCount} detected`,
    `${missingCount} missing`,
  ]
  if (installingCount > 0) subtitleParts.push(`${installingCount} installing`)
  if (disabledCount > 0) subtitleParts.push(`${disabledCount} disabled`)
  const subtitle = subtitleParts.join(' · ')

  const renderMaster = () => {
    const masterIndex = 0
    const isSelected = selectedIndex === masterIndex
    const icon = globalEnabled
      ? color('success', theme)(figures.tick)
      : color('inactive', theme)(figures.radioOff)
    const stateLabel = globalEnabled ? 'enabled' : 'disabled'
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingLeft={2}>
          <Text bold>Global</Text>
        </Box>
        <Box>
          <Text color={isSelected ? 'suggestion' : undefined}>
            {isSelected ? `${figures.pointer} ` : '  '}
          </Text>
          <Text color={isSelected ? 'suggestion' : undefined}>LSP</Text>
          <Text dimColor={!isSelected}> · {icon} </Text>
          <Text dimColor={!isSelected}>{stateLabel}</Text>
        </Box>
        {!globalEnabled && (
          <Box paddingLeft={2} marginTop={1}>
            <Text color="warning">
              LSP is disabled. No servers connect, the LSP tool is hidden, and diagnostics are not injected.
            </Text>
          </Box>
        )}
      </Box>
    )
  }

  const renderServerRow = (server: LspServerRow) => {
    const itemIndex = items.findIndex(
      (it) => it.type === 'server' && it.server === server,
    )
    const isSelected = itemIndex === selectedIndex
    const { icon, label } = renderStatus(server.status, theme)
    const hint = installerHint(server)
    return (
      <Box key={server.name}>
        <Text color={isSelected ? 'suggestion' : undefined}>
          {isSelected ? `${figures.pointer} ` : '  '}
        </Text>
        <Text color={isSelected ? 'suggestion' : undefined}>{server.name}</Text>
        <Text dimColor={!isSelected}> · {icon} </Text>
        <Text dimColor={!isSelected}>{label}</Text>
        {hint && (
          <Text dimColor> · {hint}</Text>
        )}
      </Box>
    )
  }

  const renderGroup = (key: StatusGroupKey) => {
    const list = groups[key]
    if (list.length === 0) return null
    return (
      <Box key={key} flexDirection="column" marginBottom={1}>
        <Box paddingLeft={2}>
          <Text bold>{GROUP_LABEL[key]}</Text>
          <Text dimColor> ({list.length})</Text>
        </Box>
        {list.map(renderServerRow)}
      </Box>
    )
  }

  const body = rows.length === 0 ? (
    <Box flexDirection="column">
      {renderMaster()}
      <Text dimColor>Loading...</Text>
    </Box>
  ) : (
    <Box flexDirection="column">
      {renderMaster()}
      {GROUP_ORDER.map(renderGroup)}
    </Box>
  )

  return (
    <Box flexDirection="column">
      <Dialog
        title="LSP servers"
        subtitle={subtitle}
        onCancel={() => onComplete()}
        hideInputGuide
      >
        {body}
      </Dialog>
      <Box paddingX={1}>
        <Text dimColor italic>
          <Byline>
            <KeyboardShortcutHint shortcut="↑↓" action="navigate" />
            <KeyboardShortcutHint shortcut="Space" action="toggle LSP" />
            <KeyboardShortcutHint shortcut="Enter" action="select" />
            <KeyboardShortcutHint shortcut="Esc" action="close" />
          </Byline>
        </Text>
      </Box>
    </Box>
  )
}
