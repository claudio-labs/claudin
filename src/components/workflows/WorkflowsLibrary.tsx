import { useCallback, useEffect, useState } from 'react'
import { unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { Box, Text, useInput } from 'src/terminal/ink.js'
import TextInput from 'src/terminal/text-input/TextInput.js'
import { logError } from 'src/shared/log.js'
import { Divider } from 'src/terminal/design-system/Divider.js'
import { loadWorkflowDefs } from 'src/tools/AgentWorkflow/loadWorkflows.js'
import { getWorkflowsDir } from 'src/tools/AgentWorkflow/paths.js'
import type { WorkflowDef } from 'src/tools/AgentWorkflow/types.js'
import { WorkflowEditor } from 'src/components/workflows/WorkflowEditor.js'

type Mode = 'list' | 'task' | 'new' | 'confirmDelete'

const TEMPLATE = (name: string): string =>
  `---
name: ${name}
description: What this workflow does
steps:
  - name: explore
    agents: [explorer]
  - name: synthesize
    agents: [synthesizer]
    handbackTo: [explore]
  - name: done
---
Describe the goal and any house rules for this workflow.
`

export function WorkflowsLibrary({
  onRun,
  onInputActiveChange,
  onViewChange,
}: {
  onRun: (def: WorkflowDef, task: string) => void
  onInputActiveChange: (active: boolean) => void
  /** True while the structured editor covers the tab (shell hides tab bar etc.). */
  onViewChange?: (editing: boolean) => void
}) {
  const [defs, setDefs] = useState<WorkflowDef[]>([])
  const [errorsByFile, setErrorsByFile] = useState<Record<string, string[]>>({})
  const [selected, setSelected] = useState(0)
  const [mode, setMode] = useState<Mode>('list')
  const [text, setText] = useState('')
  const [cursor, setCursor] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [editFile, setEditFile] = useState<string | null>(null)

  const reload = useCallback(() => {
    loadWorkflowDefs()
      .then(({ defs: d, errorsByFile: e }) => {
        setDefs(d)
        setErrorsByFile(e)
      })
      .catch(error => logError(error))
  }, [])

  useEffect(reload, [reload])

  // Let the shell suppress tab-switching while we capture free text.
  useEffect(() => {
    // Any non-list mode captures keys locally; suppress the shell's tab-switch
    // so an arrow at the delete prompt doesn't both cancel AND flip the tab.
    onInputActiveChange(mode !== 'list')
  }, [mode, onInputActiveChange])

  useEffect(() => {
    onViewChange?.(editFile !== null)
  }, [editFile, onViewChange])

  const current = defs[Math.min(selected, Math.max(0, defs.length - 1))]
  const fileOf = (d: WorkflowDef): string => d.sourceFile ?? `${d.name}.md`
  const currentErrors = current ? errorsByFile[fileOf(current)] : undefined

  const beginInput = (m: Mode) => {
    setText('')
    setCursor(0)
    setMessage(null)
    setMode(m)
  }

  const submitTask = () => {
    if (current && text.trim()) onRun(current, text.trim())
    setMode('list')
  }

  const submitNew = async () => {
    const name = text.trim()
    if (!name) {
      setMode('list')
      return
    }
    try {
      const path = join(getWorkflowsDir(), `${name}.md`)
      await writeFile(path, TEMPLATE(name))
      reload()
      // Drop straight into the structured editor on the fresh file.
      setEditFile(`${name}.md`)
    } catch (error) {
      logError(error)
      setMessage('Failed to create workflow.')
    }
    setMode('list')
  }

  const doDelete = async () => {
    if (current) {
      try {
        await unlink(join(getWorkflowsDir(), fileOf(current)))
        setMessage(`Deleted ${current.name}.`)
        reload()
      } catch (error) {
        logError(error)
        setMessage('Failed to delete workflow.')
      }
    }
    setMode('list')
  }

  useInput(
    (input, key) => {
      if (editFile !== null) return // WorkflowEditor owns the keys
      if (mode === 'confirmDelete') {
        if (input === 'y') void doDelete()
        else setMode('list')
        return
      }
      if (mode !== 'list') return
      if (key.upArrow) setSelected(i => Math.max(0, i - 1))
      else if (key.downArrow) setSelected(i => Math.min(defs.length - 1, i + 1))
      else if (key.return && current) beginInput('task')
      else if (input === 'n') beginInput('new')
      else if (input === 'd' && current) setMode('confirmDelete')
      else if (input === 'e' && current) {
        setMessage(null)
        setEditFile(fileOf(current))
      } else if (input === 'r') reload()
    },
    { isActive: true },
  )

  if (editFile !== null) {
    return (
      <Box paddingX={2}>
        <WorkflowEditor
          sourceFile={editFile}
          onClose={() => {
            setEditFile(null)
            reload()
          }}
        />
      </Box>
    )
  }

  if (mode === 'task' || mode === 'new') {
    const label = mode === 'task' ? `Task for "${current?.name}":` : 'New workflow name:'
    return (
      <Box flexDirection="column" paddingTop={1} paddingX={2}>
        <Divider color="permission" />
        <Box marginTop={1}>
          <Text>{label}</Text>
        </Box>
        <Box borderStyle="round" borderDimColor marginY={1} paddingLeft={1}>
          <TextInput
            value={text}
            onChange={setText}
            onSubmit={mode === 'task' ? submitTask : () => void submitNew()}
            columns={80}
            cursorOffset={cursor}
            onChangeCursorOffset={setCursor}
            showCursor
          />
        </Box>
        <Text dimColor>Enter to confirm · empty + Enter to cancel</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingTop={1}>
      <Divider color="permission" />
      <Box flexDirection="column" paddingX={2} marginTop={1}>
        {defs.length === 0 ? (
          <Text dimColor>No workflows. Press "n" to create one at .claudin/workflows/.</Text>
        ) : (
          defs.map((d, i) => {
            const hasErr = Boolean(errorsByFile[fileOf(d)]?.length)
            return (
              <Text key={d.name} inverse={i === selected}>
                {i === selected ? '▸ ' : '  '}
                {d.name}
                {hasErr ? ' ⚠' : ''} <Text dimColor>· {d.steps.length} phases</Text>
              </Text>
            )
          })
        )}

        {current && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{current.description}</Text>
            {current.steps.map(s => (
              <Text key={s.name} dimColor>
                {' '}
                {s.name}: {s.agents.join(', ') || '(terminal)'}
                {s.handbackTo?.length ? ` ↩ ${s.handbackTo.join(',')}` : ''}
              </Text>
            ))}
            {currentErrors?.length ? (
              <Text color="error">⚠ {currentErrors.join('; ')}</Text>
            ) : null}
          </Box>
        )}

        {mode === 'confirmDelete' && current && (
          <Box marginTop={1}>
            <Text color="warning">Delete "{current.name}"? (y/n)</Text>
          </Box>
        )}
        {message && (
          <Box marginTop={1}>
            <Text dimColor>{message}</Text>
          </Box>
        )}
      </Box>
    </Box>
  )
}
