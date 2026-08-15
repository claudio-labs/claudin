import { useCallback, useEffect, useRef, useState } from 'react'
import chalk from 'chalk'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { Box, RawAnsi, Text, useInput, useTheme } from 'src/terminal/ink.js'
import instances from 'src/terminal/ink/instances.js'
import { stringWidth } from 'src/terminal/ink/stringWidth.js'
import { formatTokens } from 'src/shared/text/format.js'
import { logError } from 'src/shared/log.js'
import { getTheme, themeColorToAnsi } from 'src/terminal/theme/theme.js'
import { truncateToWidth } from 'src/shared/text/truncate.js'
import { useTerminalSize } from 'src/terminal/hooks/useTerminalSize.js'
import { Divider } from 'src/terminal/design-system/Divider.js'
import { deleteRun, exportRunSummary, listRuns } from 'src/tools/AgentWorkflow/runStore.js'
import { getWorkflowsDir } from 'src/tools/AgentWorkflow/paths.js'
import type { AgentRun, RunState } from 'src/tools/AgentWorkflow/types.js'

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function statusColor(
  status: RunState['status'],
): 'success' | 'error' | 'warning' | 'permission' {
  if (status === 'done') return 'success'
  if (status === 'stalled' || status === 'failed') return 'error'
  if (status === 'cancelled') return 'warning'
  return 'permission'
}

// ✓ (U+2713), NOT ✔ (U+2714): stringWidth's emoji path counts U+2714 as 2
// cells while most monospace terminals advance 1 — the off-by-one bends the
// pane borders on every row that contains it. U+2713 measures 1 everywhere.
function statusGlyph(status: RunState['status']): string {
  if (status === 'running') return '▸'
  if (status === 'failed' || status === 'stalled') return '✗'
  if (status === 'cancelled') return '⊘'
  return '✓'
}

const workersOf = (agents: AgentRun[]): AgentRun[] => agents.filter(a => a.label !== 'main')

/** Run-level worker counts (main excluded), matching the "X/Y agents" header. */
function agentCounts(run: RunState): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const p of run.history) {
    for (const w of workersOf(p.agents)) {
      total += 1
      if (!w.failed) done += 1
    }
  }
  return { done, total }
}

type PhaseView = {
  step: string
  done: number
  total: number
  agents: AgentRun[] | null // null → in-flight phase (agents land in history on completion)
  decision: RunState['history'][number]['decision']
}

function buildPhases(run: RunState): PhaseView[] {
  const phases: PhaseView[] = run.history.map(p => {
    const workers = workersOf(p.agents)
    return {
      step: p.step,
      done: workers.filter(a => !a.failed).length,
      total: workers.length,
      agents: p.agents,
      decision: p.decision,
    }
  })
  if (run.status === 'running' && !run.history.some(p => p.step === run.currentStep)) {
    phases.push({
      step: run.currentStep,
      done: run.agentsDone ?? 0,
      total: run.agentsInPhase ?? 0,
      agents: null,
      decision: null,
    })
  }
  return phases
}

const PHASES_WIDTH = 26

/** Foreground-color a string with a theme color, resetting to the default fg. */
function fg(themeColor: string, s: string): string {
  return `${themeColorToAnsi(themeColor)}${s}\x1b[39m`
}

/** Pad a colored line with real spaces up to the pane's inner width.
 * RawAnsi writes the full width×height rectangle straight into the screen
 * buffer, so padded blanks actually PAINT (unlike <Text>, whose trailing
 * whitespace is trimmed) — that's what stops stale rows from the previous
 * view ghosting through the empty part of a tall pane. */
function padLine(colored: string, plainWidth: number, width: number): string {
  return colored + ' '.repeat(Math.max(0, width - plainWidth))
}

/** One agent line: colored glyph + bold label + dim meta, duration right-aligned. */
function agentLine(w: AgentRun, width: number, th: ReturnType<typeof getTheme>): string {
  const glyphPlain = w.failed ? '✗ ' : '✓ '
  const glyph = fg(w.failed ? th.error : th.success, glyphPlain.trimEnd()) + ' '
  const dur = duration(w.ms)
  const durW = stringWidth(dur)
  const budget = Math.max(4, width - stringWidth(glyphPlain) - durW - 1)
  const rest = truncateToWidth(
    `${w.label}  ${w.model || 'inherit'} · ${formatTokens(w.tokens)} tok`,
    budget,
  )
  const coloredRest =
    rest.length <= w.label.length
      ? chalk.bold(rest)
      : chalk.bold(rest.slice(0, w.label.length)) + chalk.dim(rest.slice(w.label.length))
  const gap = Math.max(1, width - stringWidth(glyphPlain) - stringWidth(rest) - durW)
  return glyph + coloredRest + ' '.repeat(gap) + chalk.dim(dur)
}

function DetailView({ run, phaseIndex }: { run: RunState; phaseIndex: number }) {
  const { columns, rows } = useTerminalSize()
  const phases = buildPhases(run)
  const idx = Math.min(phaseIndex, Math.max(0, phases.length - 1))
  const phase = phases[idx]
  const { done, total } = agentCounts(run)
  const [themeName] = useTheme()
  const th = getTheme(themeName)

  // Fill the screen like /diff. Pane geometry: the detail sits in paddingX={2}
  // (columns−4 usable); inner width = outer − border(2) − paddingX(2), minus a
  // 4-col slack because fullscreen mode indents the dialog further (2 left, up to 2 right) —
  // over-wide RawAnsi lines get clipped by overflow="hidden", eating the
  // right-aligned duration column (same fudge style as DiffDialog's −10).
  const paneHeight = Math.max(6, rows - 6)
  const interior = paneHeight - 2
  const phasesInner = PHASES_WIDTH - 4
  const agentsInner = Math.max(20, columns - 4 - PHASES_WIDTH - 1 - 4 - 4)

  const agentsTitle = phase
    ? ` ${phase.step} · ${phase.agents ? workersOf(phase.agents).length : phase.total} agents `
    : ' phase '

  const phaseLines = phases.map((p, i) => {
    const sel = i === idx
    const glyph = p.total > 0 && p.done === p.total ? '✓' : p.agents === null ? '▸' : '✓'
    const plain = truncateToWidth(
      `${sel ? ') ' : '  '}${glyph} ${p.step}${p.total > 0 ? ` ${p.done}/${p.total}` : ''}`,
      phasesInner,
    )
    return padLine(sel ? fg(th.permission, plain) : plain, stringWidth(plain), phasesInner)
  })
  while (phaseLines.length < interior) phaseLines.push(' '.repeat(phasesInner))

  const agentLines: string[] = !phase
    ? [padLine(chalk.dim('starting…'), stringWidth('starting…'), agentsInner)]
    : phase.agents === null
      ? [
          padLine(
            chalk.dim(`running… ${phase.done}/${phase.total} done`),
            stringWidth(`running… ${phase.done}/${phase.total} done`),
            agentsInner,
          ),
        ]
      : workersOf(phase.agents).map(w => agentLine(w, agentsInner, th))
  while (agentLines.length < interior) agentLines.push(' '.repeat(agentsInner))

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <Text bold color="permission" wrap="truncate">
            {run.workflow}
          </Text>
          {run.description ? (
            <Text dimColor wrap="truncate">
              {run.description}
            </Text>
          ) : null}
        </Box>
        <Text color={statusColor(run.status)} wrap="truncate">
          {done}/{total} agents · {duration(run.updatedAt - run.startedAt)} · {run.status}
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
          <RawAnsi lines={phaseLines.slice(0, interior)} width={phasesInner} />
        </Box>

        <Box
          flexDirection="column"
          flexGrow={1}
          height={paneHeight}
          overflow="hidden"
          borderStyle="round"
          borderColor="subtle"
          paddingX={1}
          borderText={{ content: agentsTitle, position: 'top', align: 'start' }}
        >
          <RawAnsi lines={agentLines.slice(0, interior)} width={agentsInner} />
        </Box>
      </Box>
    </Box>
  )
}

type ViewState = { mode: 'list' } | { mode: 'detail'; runId: string }

export function RunningWorkflowsTab({
  liveRun,
  onStop,
  initialRunId,
  onViewChange,
}: {
  liveRun: RunState | null
  onStop: () => void
  initialRunId?: string
  onViewChange?: (isDetail: boolean) => void
}) {
  const [historical, setHistorical] = useState<RunState[]>([])
  const [selected, setSelected] = useState(0)
  const [phaseIndex, setPhaseIndex] = useState(0)
  const [view, setView] = useState<ViewState>(initialRunId ? { mode: 'detail', runId: initialRunId } : { mode: 'list' })
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // The live run is a prop, so deleting its file wouldn't drop it from `runs`
  // — filter deleted ids locally as well.
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    listRuns()
      .then(setHistorical)
      .catch(error => logError(error))
  }, [liveRun?.runId, liveRun?.updatedAt])

  // Live run first, then historical (deduped by runId).
  const runs: RunState[] = (
    liveRun ? [liveRun, ...historical.filter(r => r.runId !== liveRun.runId)] : historical
  ).filter(r => !deletedIds.has(r.runId))
  const selectedRun = runs[Math.min(selected, Math.max(0, runs.length - 1))]
  const detailRun = view.mode === 'detail' ? runs.find(r => r.runId === view.runId) : undefined

  // Tell the parent so it can hide the tab bar / swap the footer / gate Esc.
  useEffect(() => {
    onViewChange?.(view.mode === 'detail')
  }, [view.mode, onViewChange])

  // Every list↔detail switch and phase/selection move rewrites rows in place;
  // ink's incremental diff emits partial-row writes whose positioning drifts
  // around ambiguous-width glyphs, interleaving old/new cells (reproduced in
  // tmux; a resize — which rewrites every cell from scratch — always cleared
  // it). So BEFORE the state change, reset the frame state so the very next
  // render writes every cell, exactly like the clean resize path.
  // invalidatePrevFrame() alone was not enough (only skips the blit fast
  // path; the cell-diff still emits positioned partial writes), and a bare
  // repaint() stacked stale frames in alt-screen/fullscreen mode —
  // prepareFullRepaint() picks the mode-appropriate reset.
  const repaint = useCallback(() => {
    instances.get(process.stdout)?.prepareFullRepaint()
  }, [])

  // When opened from the footer with a specific run, select it once it appears.
  const appliedInitial = useRef(false)
  useEffect(() => {
    if (appliedInitial.current || !initialRunId) return
    const idx = runs.findIndex(r => r.runId === initialRunId)
    if (idx >= 0) {
      setSelected(idx)
      appliedInitial.current = true
    }
  }, [initialRunId, runs])

  const target = view.mode === 'detail' ? detailRun : selectedRun

  const save = useCallback(async () => {
    if (!target) return
    try {
      const path = join(getWorkflowsDir(), `run-${target.runId}.md`)
      await writeFile(path, exportRunSummary(target))
      setSavedPath(path)
    } catch (error) {
      logError(error)
    }
  }, [target])

  const doDelete = useCallback(async () => {
    if (!selectedRun) return
    try {
      await deleteRun(selectedRun.runId)
      setDeletedIds(prev => new Set(prev).add(selectedRun.runId))
      setSelected(i => Math.max(0, Math.min(i, runs.length - 2)))
      setHistorical(await listRuns())
    } catch (error) {
      logError(error)
    }
  }, [selectedRun, runs.length])

  useInput((input, key) => {
    if (view.mode === 'detail') {
      const phaseCount = detailRun ? buildPhases(detailRun).length : 0
      if (key.escape) {
        repaint()
        setView({ mode: 'list' })
      } else if (key.upArrow) {
        repaint()
        setPhaseIndex(i => Math.max(0, i - 1))
      } else if (key.downArrow) {
        repaint()
        setPhaseIndex(i => Math.min(Math.max(0, phaseCount - 1), i + 1))
      }
      else if (input === 's') void save()
      else if (input === 'x' && detailRun && liveRun && detailRun.runId === liveRun.runId) onStop()
      return
    }
    if (confirmDelete) {
      setConfirmDelete(false)
      if (input === 'y') void doDelete()
      return
    }
    if (key.upArrow) setSelected(i => Math.max(0, i - 1))
    else if (key.downArrow) setSelected(i => Math.min(runs.length - 1, i + 1))
    else if (key.return && selectedRun) {
      repaint()
      setPhaseIndex(0)
      setView({ mode: 'detail', runId: selectedRun.runId })
    } else if (input === 's') void save()
    else if (input === 'x' && selectedRun && liveRun && selectedRun.runId === liveRun.runId) onStop()
    else if (input === 'd' && selectedRun && selectedRun.status !== 'running') setConfirmDelete(true)
  }, { isActive: true })

  // Detail view — takes over the tab (the parent hides its tab bar + swaps footer).
  if (view.mode === 'detail') {
    if (!detailRun) {
      return (
        <Box paddingX={2} paddingTop={1}>
          <Text dimColor>Run not found.</Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column" paddingX={2}>
        <DetailView run={detailRun} phaseIndex={phaseIndex} />
        {savedPath && (
          <Text color="success">Saved → {savedPath}</Text>
        )}
      </Box>
    )
  }

  // List view.
  return (
    <Box flexDirection="column" paddingTop={1}>
      {/* padding=4: fullscreen indents the dialog, a full-width rule wraps. */}
      <Divider color="permission" padding={4} />
      {runs.length === 0 ? (
        <Box paddingX={2} marginTop={1}>
          <Text dimColor>No workflow runs yet. Start one from the Library tab.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingX={2} marginTop={1}>
          {runs.map((r, i) => {
            const { total } = agentCounts(r)
            return (
              <Text key={r.runId} inverse={i === selected} wrap="truncate">
                {i === selected ? '▸ ' : '  '}
                <Text color={statusColor(r.status)}>{statusGlyph(r.status)}</Text> {r.workflow}
                {'  '}
                {total} agents · {formatTokens(r.totalTokens)} tok · {duration(r.updatedAt - r.startedAt)}
              </Text>
            )
          })}
          {savedPath && (
            <Box marginTop={1}>
              <Text color="success">Saved → {savedPath}</Text>
            </Box>
          )}
          {confirmDelete && selectedRun && (
            <Box marginTop={1}>
              <Text color="warning">
                Delete run "{selectedRun.workflow}" ({duration(selectedRun.updatedAt - selectedRun.startedAt)})? (y/n)
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}
