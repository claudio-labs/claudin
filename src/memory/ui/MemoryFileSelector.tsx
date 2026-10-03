import { feature } from 'bun:bundle'
import { join } from 'path'
import React, { use, useCallback, useEffect, useMemo, useState } from 'react'

import { isAutoDreamEnabled } from 'src/memory/autoDream/config.js'
import { readLastConsolidatedAt } from 'src/memory/autoDream/consolidationLock.js'
import { getMemoryFiles } from 'src/memory/instructions/claudemd.js'
import { getAutoMemPath, isAutoMemoryEnabled } from 'src/memory/memdir/paths.js'
import { getTeamMemPath, isTeamMemoryEnabled } from 'src/memory/memdir/teamMemPaths.js'
import { projectIsInGitRepo } from 'src/memory/memdir/versions.js'
import { pickerChoice } from 'src/memory/ui/memoryFileSelector/choiceMemory.js'
import { describeDreamStatus } from 'src/memory/ui/memoryFileSelector/dreamStatus.js'
import { type PickerFocus, stepFocus, type SwitchKey } from 'src/memory/ui/memoryFileSelector/focus.js'
import { MemorySwitches, type SwitchView } from 'src/memory/ui/memoryFileSelector/MemorySwitches.js'
import { buildSelectorRows, type SelectorRow, type SelectorRowDeps } from 'src/memory/ui/memoryFileSelector/rows.js'
import { overrideNote } from 'src/memory/ui/memoryFileSelector/switchNote.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { updateSettingsForSource } from 'src/platform/settings/settings.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { getDisplayPath } from 'src/shared/fs/file.js'
import { logError } from 'src/shared/log.js'
import { type OptionWithDescription, Select } from 'src/terminal/custom-select/index.js'
import { useExitOnCtrlCDWithKeybindings } from 'src/terminal/hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Text } from 'src/terminal/ink.js'
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js'
import { useAppState } from 'src/terminal/state/AppState.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { getAgentMemoryDir } from 'src/tools/AgentTool/agentMemory.js'

type Props = {
  onSelect: (path: string) => void
  onCancel: () => void
  /** Memory counts for the two browse rows, scanned before the dialog opens. */
  dirCounts?: {
    private: number
    team: number
  }
}

type SwitchSetting = {
  label: string
  /** The value in effect, after every settings layer and environment override. */
  read: () => boolean
  /** Only the user's own settings: a toggle here must not change a checked-in or managed file. */
  write: (on: boolean) => { error: Error | null }
}

const SWITCH_SETTINGS: Record<SwitchKey, SwitchSetting> = {
  autoMemory: {
    label: 'Auto-memory',
    read: isAutoMemoryEnabled,
    write: on => updateSettingsForSource('userSettings', { autoMemoryEnabled: on }),
  },
  autoDream: {
    label: 'Auto-dream',
    read: isAutoDreamEnabled,
    write: on => updateSettingsForSource('userSettings', { autoDreamEnabled: on }),
  },
}

const ROW_DEPS: SelectorRowDeps = {
  displayPath: getDisplayPath,
  agentMemoryDir: getAgentMemoryDir,
}

const selectActiveAgents = (state: AppState): AppState['agentDefinitions']['activeAgents'] =>
  state.agentDefinitions.activeAgents

const selectDreamRunning = (state: AppState): boolean =>
  Object.values(state.tasks).some(task => task.type === 'dream' && task.status === 'running')

/** The last consolidation stamp, read once: `null` until it arrives, `0` for never. */
function useLastConsolidation(): number | null {
  const [lastRunAt, setLastRunAt] = useState<number | null>(null)
  useEffect(() => {
    let mounted = true
    readLastConsolidatedAt().then(at => {
      if (mounted) setLastRunAt(at)
    }, logError)
    return () => {
      mounted = false
    }
  }, [])
  return lastRunAt
}

function toOption(row: SelectorRow): OptionWithDescription<string> {
  const label =
    row.emphasis === undefined ? (
      row.label
    ) : (
      <Text>
        <Text bold>{row.emphasis}</Text>
        {row.label.slice(row.emphasis.length)}
      </Text>
    )
  return { label, value: row.value, description: row.description }
}

export function MemoryFileSelector({ onSelect, onCancel, dirCounts }: Props): React.ReactNode {
  const loadedFiles = use(getMemoryFiles())
  const agents = useAppState(selectActiveAgents)
  const dreamRunning = useAppState(selectDreamRunning)
  const lastRunAt = useLastConsolidation()

  // Fixed for the life of the picker: where the session started, whether it is
  // a repository, and whether the auto-dream line is shown at all.
  const [startDir] = useState(getOriginalCwd)
  const [inGitRepo] = useState(() => projectIsInGitRepo(startDir))
  const [switchKeys] = useState<readonly SwitchKey[]>(() =>
    isAutoMemoryEnabled() ? ['autoMemory', 'autoDream'] : ['autoMemory'],
  )

  const [focus, setFocus] = useState<PickerFocus>('list')
  // What each switch last asked for, to tell when another layer overrides it.
  const [requested, setRequested] = useState<Partial<Record<SwitchKey, boolean>>>({})

  useExitOnCtrlCDWithKeybindings()
  useKeybinding('confirm:no', onCancel, { context: 'Confirmation' })

  // Read on every render, so a toggle shows its effect on the rows at once.
  const autoMemoryOn = isAutoMemoryEnabled()
  const teamOn = feature('TEAMMEM') ? isTeamMemoryEnabled() : false

  const rows = useMemo(
    () =>
      buildSelectorRows(
        {
          loadedFiles,
          startDir,
          userFilePath: join(getClaudinConfigHomeDir(), 'CLAUDE.md'),
          inGitRepo,
          autoMemoryOn,
          privateDir: getAutoMemPath(),
          teamDir: teamOn ? getTeamMemPath() : null,
          counts: dirCounts,
          agents,
        },
        ROW_DEPS,
      ),
    [loadedFiles, startDir, inGitRepo, autoMemoryOn, teamOn, dirCounts, agents],
  )
  const options = useMemo(() => rows.map(toOption), [rows])
  const [initialFocus] = useState(() => pickerChoice.focusAmong(rows.map(row => row.value)))

  const switches: SwitchView[] = switchKeys.map(key => {
    const on = SWITCH_SETTINGS[key].read()
    const status = key === 'autoDream' ? describeDreamStatus({ enabled: on, running: dreamRunning, lastRunAt }) : ''
    return { key, label: SWITCH_SETTINGS[key].label, on, detail: `${status}${overrideNote(requested[key], on)}` }
  })

  const toggle = useCallback((key: SwitchKey) => {
    const setting = SWITCH_SETTINGS[key]
    const next = !setting.read()
    const { error } = setting.write(next)
    if (error !== null) {
      logError(error)
      return
    }
    setRequested(previous => ({ ...previous, [key]: next }))
  }, [])

  const move = useCallback(
    (direction: 'up' | 'down') => setFocus(current => stepFocus(current, direction, switchKeys)),
    [switchKeys],
  )
  const leaveList = useCallback(() => move('up'), [move])

  const choose = useCallback(
    (value: string) => {
      pickerChoice.remember(value)
      onSelect(value)
    },
    [onSelect],
  )

  return (
    <Box flexDirection="column">
      <MemorySwitches switches={switches} focus={focus} onMove={move} onToggle={toggle} />
      <Box flexDirection="column" marginTop={1}>
        <Select
          options={options}
          defaultFocusValue={initialFocus}
          isDisabled={focus !== 'list'}
          onChange={choose}
          onUpFromFirstItem={leaveList}
        />
      </Box>
    </Box>
  )
}
