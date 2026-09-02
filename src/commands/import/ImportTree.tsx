import * as React from 'react'

import {
  agentRowKey,
  buildTreeRows,
  cascadeSelection,
  defaultSelection,
  type AgentEntry,
} from 'src/commands/import/tree.js'
import { Box, Text } from 'src/terminal/ink.js'
import { SelectMulti } from 'src/terminal/custom-select/SelectMulti.js'

const MAX_VISIBLE_ROWS = 16

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every(value => set.has(value))
}

export function ImportTree({
  entries,
  notImportable,
  onSubmit,
  onCancel,
}: {
  entries: AgentEntry[]
  notImportable: string[]
  onSubmit: (selected: string[]) => void
  onCancel: () => void
}): React.ReactNode {
  const [selected, setSelected] = React.useState<string[]>(() =>
    defaultSelection(entries),
  )
  // Bumped only when a parent row cascades to its children. SelectMulti owns
  // its selection and re-seeds from `defaultValue` only on mount, so a cascade
  // is the one case that has to remount it; `focusValue` puts the cursor back
  // where it was, which is why this is not visible as a jump.
  const [revision, setRevision] = React.useState(0)
  const focusedRef = React.useRef<string | undefined>(undefined)

  const rows = buildTreeRows(entries, new Set(selected))
  const options = rows.map(row => ({
    value: row.key,
    label: row.label,
    description: row.description,
    dimDescription: true,
  }))

  const handleChange = (next: string[]): void => {
    const cascaded = cascadeSelection(entries, selected, next)
    setSelected(cascaded)
    if (!sameSet(cascaded, next)) {
      setRevision(current => current + 1)
    }
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>Import config from another AI coding agent</Text>
      <Box marginTop={1} flexDirection="column">
        <SelectMulti
          key={revision}
          options={options}
          defaultValue={selected}
          focusValue={revision === 0 ? undefined : focusedRef.current}
          onFocus={value => {
            focusedRef.current = value
          }}
          onChange={handleChange}
          onSubmit={next => onSubmit(cascadeSelection(entries, selected, next))}
          onCancel={onCancel}
          visibleOptionCount={Math.min(options.length, MAX_VISIBLE_ROWS)}
          hideIndexes
        />
      </Box>
      {notImportable.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{`⎿ Not importable: ${notImportable.join(', ')}`}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          Enter confirms · Space toggles · Esc cancels
        </Text>
      </Box>
    </Box>
  )
}

/** Re-exported so the command can name the agent rows without a second import. */
export { agentRowKey }
