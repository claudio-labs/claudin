import { useCallback, useEffect, useMemo, useState } from 'react'
import chalk from 'chalk'
import { unlinkSync, writeFileSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Box, RawAnsi, Text, useInput, useTheme } from 'src/ink.js'
import instances from 'src/ink/instances.js'
import { stringWidth } from 'src/ink/stringWidth.js'
import TextInput from 'src/components/TextInput.js'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import { getCwd } from 'src/utils/fs/cwd.js'
import { logError } from 'src/utils/log.js'
import { editFileInEditor } from 'src/utils/promptEditor.js'
import { getTheme, themeColorToAnsi } from 'src/utils/theme.js'
import { truncateToWidth } from 'src/utils/text/truncate.js'
import {
  parseWorkflow,
  validateWorkflowAgents,
  validateWorkflowStructure,
} from 'src/tools/AgentWorkflow/loadWorkflows.js'
import { getWorkflowsDir } from 'src/tools/AgentWorkflow/paths.js'
import { renameStep, serializeWorkflow } from 'src/tools/AgentWorkflow/serializeWorkflow.js'
import type { WorkflowDef } from 'src/tools/AgentWorkflow/types.js'

const PHASES_WIDTH = 26
const FIELDS_PANE_HEIGHT = 7

type PickerTarget = 'agents' | 'handbackTo' | 'main'
type InputTarget = 'name' | 'description' | 'addStep'

type Overlay =
  | { kind: 'input'; target: InputTarget; value: string; cursor: number }
  | { kind: 'picker'; target: PickerTarget; options: string[]; checked: Set<string>; cursor: number; multi: boolean }
  | { kind: 'confirmDelete' }
  | { kind: 'confirmDiscard' }

/** Foreground-color a string with a theme color, resetting to the default fg. */
function fg(themeColor: string, s: string): string {
  return `${themeColorToAnsi(themeColor)}${s}\x1b[39m`
}

/** Pad with real spaces to the pane's inner width (RawAnsi paints blanks). */
function padLine(colored: string, plainWidth: number, width: number): string {
  return colored + ' '.repeat(Math.max(0, width - plainWidth))
}

function fillTo(lines: string[], count: number, width: number): string[] {
  const out = lines.slice(0, count)
  while (out.length < count) out.push(' '.repeat(width))
  return out
}

/**
 * Structured editor for one workflow `.md` (Library tab, `e`/`n`).
 *
 * Master/detail in the Running-detail idiom: left pane lists the workflow
 * entry + phases, right side shows the selection's fields and a prompt
 * preview. Edits stay in memory until `s` serializes back to the file
 * (serializeWorkflow preserves hand-added frontmatter keys). The prompt body
 * is edited in the external $EDITOR via a tempfile so `s` remains the only
 * writer of the real file.
 */
export function WorkflowEditor({
  sourceFile,
  onClose,
}: {
  sourceFile: string
  onClose: () => void
}) {
  const { columns, rows } = useTerminalSize()
  const [themeName] = useTheme()
  const th = getTheme(themeName)

  const [def, setDef] = useState<WorkflowDef | null>(null)
  const [rawFrontmatter, setRawFrontmatter] = useState<Record<string, unknown>>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [focus, setFocus] = useState<'phases' | 'fields'>('phases')
  // 0 = the workflow entry (description/main), 1..n = steps[row-1].
  const [row, setRow] = useState(0)
  const [fieldIdx, setFieldIdx] = useState(0)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [knownAgents, setKnownAgents] = useState<Set<string> | null>(null)

  // See the Running detail: reset ink's frame state BEFORE every setState that
  // changes this dialog's layout, so the next render is a full clean repaint.
  const repaint = useCallback(() => {
    instances.get(process.stdout)?.prepareFullRepaint()
  }, [])

  useEffect(() => {
    readFile(join(getWorkflowsDir(), sourceFile), 'utf-8')
      .then(raw => {
        const parsed = parseWorkflow(raw, sourceFile.replace(/\.md$/, ''))
        if (parsed.def) {
          setDef(parsed.def)
          setRawFrontmatter(parsed.rawFrontmatter)
        } else {
          setLoadError(parsed.errors.join('; '))
        }
      })
      .catch(error => {
        logError(error)
        setLoadError('Failed to read workflow file.')
      })
  }, [sourceFile])

  // Dynamic import: the agent registry is heavy and this dialog is cold.
  useEffect(() => {
    import('src/tools/AgentWorkflow/agentTypes.js')
      .then(m => m.getKnownAgentTypes(getCwd()))
      .then(setKnownAgents)
      .catch(error => logError(error))
  }, [])

  const validationErrors = useMemo(() => {
    if (!def) return []
    const errors = validateWorkflowStructure(def)
    if (knownAgents) errors.push(...validateWorkflowAgents(def, knownAgents))
    return errors
  }, [def, knownAgents])

  const update = useCallback(
    (fn: (d: WorkflowDef) => WorkflowDef) => {
      repaint()
      setDef(d => (d ? fn(d) : d))
      setDirty(true)
      setMessage(null)
    },
    [repaint],
  )

  const stepIdx = row - 1
  const step = def && stepIdx >= 0 ? def.steps[stepIdx] : undefined
  const fields: string[] = row === 0 ? ['description', 'main'] : ['name', 'agents', 'handbackTo']

  const save = useCallback(async () => {
    if (!def) return
    try {
      const path = join(getWorkflowsDir(), sourceFile)
      await writeFile(path, serializeWorkflow(def, rawFrontmatter))
      setDirty(false)
      setMessage(`Saved → ${path}`)
    } catch (error) {
      logError(error)
      setMessage('Failed to save.')
    }
  }, [def, rawFrontmatter, sourceFile])

  const editPrompt = useCallback(() => {
    if (!def) return
    const tmp = join(tmpdir(), `claudin-wf-prompt-${Date.now()}.md`)
    try {
      writeFileSync(tmp, def.instructions ? `${def.instructions}\n` : '')
      const result = editFileInEditor(tmp)
      if (result.error) {
        setMessage(result.error)
      } else if (result.content === null) {
        setMessage('No external editor available — set $EDITOR or $VISUAL.')
      } else {
        const next = result.content.trim()
        if (next !== def.instructions) {
          update(d => ({ ...d, instructions: next }))
        }
      }
    } catch (error) {
      logError(error)
      setMessage('Failed to open editor.')
    } finally {
      try {
        unlinkSync(tmp)
      } catch {
        /* tempfile already gone */
      }
    }
  }, [def, update])

  const openFieldEditor = useCallback(() => {
    if (!def) return
    const field = fields[fieldIdx]
    repaint()
    if (row === 0) {
      if (field === 'description') {
        setOverlay({ kind: 'input', target: 'description', value: def.description, cursor: def.description.length })
      } else {
        const options = ['(default)', ...[...(knownAgents ?? [])].sort()]
        setOverlay({
          kind: 'picker',
          target: 'main',
          options,
          checked: new Set([def.main ?? '(default)']),
          cursor: Math.max(0, options.indexOf(def.main ?? '(default)')),
          multi: false,
        })
      }
      return
    }
    if (!step) return
    if (field === 'name') {
      setOverlay({ kind: 'input', target: 'name', value: step.name, cursor: step.name.length })
    } else if (field === 'agents') {
      // Known agents plus any currently-referenced ones (so a typo'd agent can
      // still be unchecked even though the registry doesn't know it).
      const options = [...new Set([...[...(knownAgents ?? [])].sort(), ...step.agents])]
      setOverlay({ kind: 'picker', target: 'agents', options, checked: new Set(step.agents), cursor: 0, multi: true })
    } else {
      // handbackTo may only reference EARLIER phases (validateWorkflowStructure).
      const options = def.steps.slice(0, stepIdx).map(s => s.name)
      if (options.length === 0) {
        setMessage('No earlier phases to hand back to.')
        return
      }
      setOverlay({ kind: 'picker', target: 'handbackTo', options, checked: new Set(step.handbackTo ?? []), cursor: 0, multi: true })
    }
  }, [def, fields, fieldIdx, row, step, stepIdx, knownAgents, repaint])

  const commitInput = useCallback(
    (target: InputTarget, value: string) => {
      const trimmed = value.trim()
      repaint()
      setOverlay(null)
      // Library idiom: empty + Enter cancels (description can't be cleared this
      // way — acceptable; edit the file directly for that rare case).
      if (!trimmed) return
      if (target === 'description') update(d => ({ ...d, description: trimmed }))
      else if (target === 'name' && stepIdx >= 0) update(d => ({ ...d, steps: renameStep(d.steps, stepIdx, trimmed) }))
      else if (target === 'addStep') {
        const at = row === 0 ? 0 : row // insert after the selected step
        update(d => ({
          ...d,
          steps: [...d.steps.slice(0, at), { name: trimmed, agents: [] }, ...d.steps.slice(at)],
        }))
        setRow(at + 1)
        setFocus('phases')
      }
    },
    [repaint, row, stepIdx, update],
  )

  const commitPicker = useCallback(
    (o: Extract<Overlay, { kind: 'picker' }>) => {
      repaint()
      setOverlay(null)
      if (o.target === 'main') {
        const choice = o.options[o.cursor]
        update(d => ({ ...d, main: choice === '(default)' ? undefined : choice }))
        return
      }
      const picked = o.options.filter(opt => o.checked.has(opt))
      if (o.target === 'agents' && stepIdx >= 0) {
        update(d => ({ ...d, steps: d.steps.map((s, i) => (i === stepIdx ? { ...s, agents: picked } : s)) }))
      } else if (o.target === 'handbackTo' && stepIdx >= 0) {
        update(d => ({
          ...d,
          steps: d.steps.map((s, i) => (i === stepIdx ? { ...s, handbackTo: picked.length ? picked : undefined } : s)),
        }))
      }
    },
    [repaint, stepIdx, update],
  )

  const deleteStep = useCallback(() => {
    if (stepIdx < 0) return
    update(d => ({ ...d, steps: d.steps.filter((_, i) => i !== stepIdx) }))
    setRow(r => Math.max(0, Math.min(r, (def?.steps.length ?? 1) - 1)))
    setFocus('phases')
  }, [def, stepIdx, update])

  const moveStep = useCallback(
    (delta: -1 | 1) => {
      if (!def || stepIdx < 0) return
      const target = stepIdx + delta
      if (target < 0 || target >= def.steps.length) return
      update(d => {
        const steps = [...d.steps]
        const [s] = steps.splice(stepIdx, 1)
        steps.splice(target, 0, s!)
        return { ...d, steps }
      })
      setRow(target + 1)
    },
    [def, stepIdx, update],
  )

  useInput(
    (input, key) => {
      if (!def) {
        if (key.escape) onClose()
        return
      }
      if (overlay?.kind === 'input') return // TextInput owns the keys
      if (overlay?.kind === 'confirmDelete') {
        repaint()
        setOverlay(null)
        if (input === 'y') deleteStep()
        return
      }
      if (overlay?.kind === 'confirmDiscard') {
        repaint()
        setOverlay(null)
        if (input === 'y') onClose()
        return
      }
      if (overlay?.kind === 'picker') {
        // Functional updates only: rapid key repeat delivers several events
        // against one render's closure — a spread of the closed-over overlay
        // would drop all but the last cursor move / toggle.
        const patch = (fn: (o: Extract<Overlay, { kind: 'picker' }>) => Overlay | null) => {
          repaint()
          setOverlay(prev => (prev?.kind === 'picker' ? fn(prev) : prev))
        }
        if (key.upArrow) {
          patch(o => ({ ...o, cursor: Math.max(0, o.cursor - 1) }))
        } else if (key.downArrow) {
          patch(o => ({ ...o, cursor: Math.min(o.options.length - 1, o.cursor + 1) }))
        } else if (input === ' ' && overlay.multi) {
          patch(o => {
            const opt = o.options[o.cursor]
            if (opt === undefined) return o
            const checked = new Set(o.checked)
            if (checked.has(opt)) checked.delete(opt)
            else checked.add(opt)
            return { ...o, checked }
          })
        } else if (key.return) {
          commitPicker(overlay)
        } else if (key.escape) {
          repaint()
          setOverlay(null)
        }
        return
      }

      // Global keys (both focuses).
      if (input === 's') {
        void save()
        return
      }
      if (input === 'p') {
        editPrompt()
        return
      }

      if (focus === 'fields') {
        if (key.escape) {
          repaint()
          setFocus('phases')
        } else if (key.upArrow) {
          repaint()
          setFieldIdx(i => Math.max(0, i - 1))
        } else if (key.downArrow) {
          repaint()
          setFieldIdx(i => Math.min(fields.length - 1, i + 1))
        } else if (key.return) {
          openFieldEditor()
        }
        return
      }

      // focus === 'phases'
      if (key.escape) {
        if (dirty) {
          repaint()
          setOverlay({ kind: 'confirmDiscard' })
        } else {
          onClose()
        }
      } else if (key.upArrow) {
        repaint()
        setRow(r => Math.max(0, r - 1))
      } else if (key.downArrow) {
        repaint()
        setRow(r => Math.min(def.steps.length, r + 1))
      } else if (key.return) {
        repaint()
        setFocus('fields')
        setFieldIdx(0)
      } else if (input === 'a') {
        repaint()
        setOverlay({ kind: 'input', target: 'addStep', value: '', cursor: 0 })
      } else if (input === 'd' && row > 0) {
        repaint()
        setOverlay({ kind: 'confirmDelete' })
      } else if (input === 'K') {
        moveStep(-1)
      } else if (input === 'J') {
        moveStep(1)
      }
    },
    { isActive: true },
  )

  if (loadError) {
    return (
      <Box flexDirection="column" paddingX={2} paddingTop={1}>
        <Text color="error">⚠ {loadError}</Text>
        <Text dimColor>Esc to go back — fix the file by hand at .claudin/workflows/{sourceFile}.</Text>
      </Box>
    )
  }
  if (!def) {
    return (
      <Box paddingX={2} paddingTop={1}>
        <Text dimColor>Loading…</Text>
      </Box>
    )
  }

  // Same geometry as the Running detail (incl. the 4-col fullscreen slack).
  const paneHeight = Math.max(6, rows - 6)
  const phasesInner = PHASES_WIDTH - 4
  const rightInner = Math.max(20, columns - 4 - PHASES_WIDTH - 1 - 4 - 4)
  const phasesInterior = paneHeight - 2

  // ── Left pane: workflow entry + separator + steps ──
  const marker = (sel: boolean): string => (sel ? ') ' : '  ')
  const phaseLines: string[] = []
  {
    const plain = truncateToWidth(`${marker(row === 0)}${def.name}`, phasesInner)
    phaseLines.push(padLine(row === 0 ? fg(th.permission, plain) : chalk.bold(plain), stringWidth(plain), phasesInner))
    const rule = `  ${'─'.repeat(Math.max(1, phasesInner - 2))}`
    phaseLines.push(padLine(chalk.dim(rule), stringWidth(rule), phasesInner))
    def.steps.forEach((s, i) => {
      const sel = row === i + 1
      const plain = truncateToWidth(`${marker(sel)}${s.name} ${s.agents.length}`, phasesInner)
      phaseLines.push(padLine(sel ? fg(th.permission, plain) : plain, stringWidth(plain), phasesInner))
    })
  }

  // ── Right side ──
  const isPicker = overlay?.kind === 'picker'
  let rightTitle: string
  let rightLines: string[]
  let promptTitle = ' Prompt (p to edit) '
  let promptLines: string[] = []
  const fieldsInterior = FIELDS_PANE_HEIGHT - 2
  const promptHeight = Math.max(3, paneHeight - FIELDS_PANE_HEIGHT)
  const promptInterior = promptHeight - 2

  if (isPicker) {
    const o = overlay as Extract<Overlay, { kind: 'picker' }>
    rightTitle =
      o.target === 'main'
        ? ' main orchestrator '
        : ` ${o.target === 'agents' ? 'agents' : 'hand back to'} · ${step?.name ?? def.name} `
    const interior = paneHeight - 2
    // Window the options around the cursor when they overflow the pane.
    const start = Math.max(0, Math.min(o.cursor - Math.floor(interior / 2), o.options.length - interior))
    rightLines = o.options.slice(start, start + interior).map((opt, i) => {
      const realIdx = start + i
      const sel = realIdx === o.cursor
      const box = o.multi ? (o.checked.has(opt) ? '[x] ' : '[ ] ') : ''
      // ASCII '(unknown)', not ⚠ — U+26A0 takes the emoji width path in
      // stringWidth (model 2, terminal 1) and bends the pane border.
      const unknown = o.target === 'agents' && knownAgents && !knownAgents.has(opt)
      const plain = truncateToWidth(`${marker(sel)}${box}${opt}${unknown ? ' (unknown)' : ''}`, rightInner)
      const colored = sel ? fg(th.permission, plain) : unknown ? fg(th.error, plain) : plain
      return padLine(colored, stringWidth(plain), rightInner)
    })
  } else {
    rightTitle = row === 0 ? ` ${def.name} ` : ` phase: ${step?.name ?? ''} `
    const fieldValue = (field: string): string => {
      if (field === 'description') return def.description || '(empty)'
      if (field === 'main') return def.main ?? '(default)'
      if (field === 'name') return step?.name ?? ''
      if (field === 'agents') return step?.agents.join(', ') || '(none)'
      return step?.handbackTo?.join(', ') ?? '—'
    }
    rightLines = fields.map((f, i) => {
      const sel = focus === 'fields' && i === fieldIdx
      const label = f === 'handbackTo' ? 'handback' : f
      const plain = truncateToWidth(`${marker(sel)}${label}: ${fieldValue(f)}`, rightInner)
      const colored = sel
        ? fg(th.permission, plain)
        : chalk.dim(plain.slice(0, 2 + label.length + 1)) + plain.slice(2 + label.length + 1)
      return padLine(colored, stringWidth(plain), rightInner)
    })
    const promptSrc = def.instructions ? def.instructions.split('\n') : []
    promptLines = promptSrc.slice(0, promptInterior).map(l => {
      const plain = truncateToWidth(l, rightInner)
      return padLine(chalk.dim(plain), stringWidth(plain), rightInner)
    })
    if (promptLines.length === 0) {
      const hint = '(empty — press p to write the prompt)'
      promptLines = [padLine(chalk.dim(hint), stringWidth(hint), rightInner)]
    }
  }

  const inputOverlay = overlay?.kind === 'input' ? overlay : null
  const inputLabel =
    inputOverlay?.target === 'addStep'
      ? 'New phase name:'
      : inputOverlay?.target === 'name'
        ? 'Rename phase:'
        : 'Description:'

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="permission" wrap="truncate">
          {def.name}
        </Text>
        <Text color={dirty ? 'warning' : 'success'} wrap="truncate">
          {dirty ? '● unsaved' : 'saved'}
        </Text>
      </Box>

      <Box flexDirection="row" marginTop={1} gap={1}>
        <Box
          flexDirection="column"
          flexShrink={0}
          width={PHASES_WIDTH}
          height={paneHeight}
          overflow="hidden"
          borderStyle="round"
          borderColor="subtle"
          paddingX={1}
          borderText={{ content: ' Phases ', position: 'top', align: 'start' }}
        >
          <RawAnsi lines={fillTo(phaseLines, phasesInterior, phasesInner)} width={phasesInner} />
        </Box>

        {isPicker ? (
          <Box
            flexDirection="column"
            flexGrow={1}
            height={paneHeight}
            overflow="hidden"
            borderStyle="round"
            borderColor="subtle"
            paddingX={1}
            borderText={{ content: rightTitle, position: 'top', align: 'start' }}
          >
            <RawAnsi lines={fillTo(rightLines, paneHeight - 2, rightInner)} width={rightInner} />
          </Box>
        ) : (
          <Box flexDirection="column" flexGrow={1}>
            <Box
              flexDirection="column"
              height={FIELDS_PANE_HEIGHT}
              overflow="hidden"
              borderStyle="round"
              borderColor="subtle"
              paddingX={1}
              borderText={{ content: rightTitle, position: 'top', align: 'start' }}
            >
              <RawAnsi lines={fillTo(rightLines, fieldsInterior, rightInner)} width={rightInner} />
            </Box>
            <Box
              flexDirection="column"
              height={promptHeight}
              overflow="hidden"
              borderStyle="round"
              borderColor="subtle"
              paddingX={1}
              borderText={{ content: promptTitle, position: 'top', align: 'start' }}
            >
              <RawAnsi lines={fillTo(promptLines, promptInterior, rightInner)} width={rightInner} />
            </Box>
          </Box>
        )}
      </Box>

      {inputOverlay && (
        <Box flexDirection="column">
          <Text>{inputLabel}</Text>
          <Box borderStyle="round" borderDimColor paddingLeft={1}>
            <TextInput
              value={inputOverlay.value}
              onChange={v => setOverlay(o => (o?.kind === 'input' ? { ...o, value: v } : o))}
              onSubmit={() => commitInput(inputOverlay.target, inputOverlay.value)}
              columns={80}
              cursorOffset={inputOverlay.cursor}
              onChangeCursorOffset={c => setOverlay(o => (o?.kind === 'input' ? { ...o, cursor: c } : o))}
              showCursor
            />
          </Box>
          <Text dimColor>Enter to confirm · empty + Enter to cancel</Text>
        </Box>
      )}
      {overlay?.kind === 'confirmDelete' && step && (
        <Text color="warning">Delete phase "{step.name}"? (y/n)</Text>
      )}
      {overlay?.kind === 'confirmDiscard' && (
        <Text color="warning">Discard unsaved changes? (y/n)</Text>
      )}
      {validationErrors.length > 0 && (
        <Text color="error" wrap="truncate">
          ⚠ {validationErrors.join(' · ')}
        </Text>
      )}
      {message && (
        <Text dimColor wrap="truncate">
          {message}
        </Text>
      )}
    </Box>
  )
}
