import React, { useEffect, useMemo, useRef, useState } from 'react'
import { type DesktopImportDeps, runDesktopImport } from 'src/mcp/approval/desktopImport.js'
import { addMcpConfig, getAllMcpConfigs } from 'src/mcp/config.js'
import type { ConfigScope, McpServerConfig } from 'src/mcp/types.js'
import { gracefulShutdown } from 'src/shared/proc/gracefulShutdown.js'
import { writeToStderr, writeToStdout } from 'src/shared/proc/process.js'
import { plural } from 'src/shared/text/stringUtils.js'
import { ConfigurableShortcutHint } from 'src/terminal/ConfigurableShortcutHint.js'
import { SelectMulti } from 'src/terminal/custom-select/SelectMulti.js'
import { Byline } from 'src/terminal/design-system/Byline.js'
import { Dialog } from 'src/terminal/design-system/Dialog.js'
import { KeyboardShortcutHint } from 'src/terminal/design-system/KeyboardShortcutHint.js'
import { Box, color, Text, useTheme } from 'src/terminal/ink.js'

export type MCPServerDesktopImportDialogProps = {
  servers: Record<string, McpServerConfig>
  scope: ConfigScope
  onDone(): void
}

const NO_CLASHES: ReadonlySet<string> = new Set()

/** The names of every configured server, read once after the first paint. */
function useConfiguredNames(): ReadonlySet<string> | null {
  const [names, setNames] = useState<ReadonlySet<string> | null>(null)
  useEffect(() => {
    let live = true
    getAllMcpConfigs().then(
      ({ servers }) => {
        if (live) setNames(new Set(Object.keys(servers)))
      },
      () => {
        if (live) setNames(NO_CLASHES)
      },
    )
    return () => {
      live = false
    }
  }, [])
  return names
}

export function MCPServerDesktopImportDialog({ servers, scope, onDone }: MCPServerDesktopImportDialogProps): React.ReactNode {
  const [theme] = useTheme()
  const names = useMemo(() => Object.keys(servers), [servers])
  const configured = useConfiguredNames()
  const [ticked, setTicked] = useState<string[]>(names)
  const finished = useRef(false)

  // Once the clashes are known, their rows start unticked: the note says they
  // are imported only if selected.
  const [clashesApplied, setClashesApplied] = useState(false)
  if (configured !== null && !clashesApplied) {
    setClashesApplied(true)
    setTicked(ticked.filter(name => !configured.has(name)))
  }

  const existing = configured ?? NO_CLASHES
  const clashing = names.filter(name => existing.has(name))
  const options = useMemo(
    () => names.map(name => ({ label: existing.has(name) ? `${name} (already exists)` : name, value: name })),
    [names, existing],
  )

  // A key pressed while the import runs must not start a second one.
  const finish = async (selected: readonly string[]) => {
    if (finished.current) return
    finished.current = true
    const deps: DesktopImportDeps = {
      add: addMcpConfig,
      writeOut: writeToStdout,
      writeErr: writeToStderr,
      successColour: color('success', theme),
      shutdown: gracefulShutdown,
    }
    await runDesktopImport({ servers, selected, existing, scope }, onDone, deps)
  }
  const cancel = () => void finish([])

  return (
    <>
      <Dialog
        title="Import MCP Servers from Claude Desktop"
        subtitle={`Found ${names.length} MCP ${plural(names.length, 'server')} in Claude Desktop.`}
        color="success"
        onCancel={cancel}
        hideInputGuide
      >
        {clashing.length > 0 && (
          <Text color="warning">
            Note: Some servers already exist with the same name. If selected, they will be imported with a numbered
            suffix.
          </Text>
        )}
        <Text>Please select the servers you want to import:</Text>
        <SelectMulti
          // Remounted when the clashes arrive, so the list takes the new ticks.
          key={clashesApplied ? 'checked' : 'unchecked'}
          options={options}
          defaultValue={ticked}
          onChange={setTicked}
          onSubmit={selected => void finish(selected)}
          onCancel={cancel}
          hideIndexes
        />
      </Dialog>
      <Box paddingX={1}>
        <Text dimColor>
          <Byline>
            <KeyboardShortcutHint shortcut="Space" action="select" />
            <KeyboardShortcutHint shortcut="Enter" action="confirm" />
            <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />
          </Byline>
        </Text>
      </Box>
    </>
  )
}
