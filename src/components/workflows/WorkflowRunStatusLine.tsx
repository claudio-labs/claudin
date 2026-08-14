import { useEffect, useState } from 'react'
import { Box, Text } from 'src/ink.js'
import { formatTokens, truncate } from 'src/utils/format.js'
import { useElapsedTime } from 'src/hooks/useElapsedTime.js'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import { logError } from 'src/utils/log.js'
import { listRuns } from 'src/tools/AgentWorkflow/runStore.js'
import type { RunState } from 'src/tools/AgentWorkflow/types.js'

// Keep the footer compact: show at most a few live runs, then a "+N more" line.
const MAX_ROWS = 3

// Cheap change-detector so we only re-render when a running run actually moves
// (its worker count, tokens, or the running set itself changes).
function signature(runs: RunState[]): string {
  return runs
    .map(r => `${r.runId}:${r.agentsDone}/${r.agentsInPhase}:${r.totalTokens}:${r.currentStep}`)
    .join('|')
}

/**
 * A live, one-line-per-run status of currently-running workflows, rendered at
 * the very bottom of the REPL chrome. Reads `.runs/` on a self-driven 1s timer
 * (not the shared clock, which can be idle while a background run progresses).
 * Clicking a row opens the /workflows dialog on the Running tab (fullscreen
 * only — inline the line is informational).
 */
export function WorkflowRunStatusLine({ onOpen }: { onOpen?: (runId?: string) => void }) {
  const [runs, setRuns] = useState<RunState[]>([])

  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      try {
        const running = (await listRuns()).filter(r => r.status === 'running')
        if (!alive) return
        setRuns(prev => (signature(prev) === signature(running) ? prev : running))
      } catch (error) {
        logError(error)
      }
    }
    void poll()
    const id = setInterval(() => void poll(), 1000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  if (runs.length === 0) return null

  const shown = runs.slice(0, MAX_ROWS)
  const extra = runs.length - shown.length

  return (
    <Box flexDirection="column">
      {shown.map(run => (
        <WorkflowRunRow key={run.runId} run={run} onOpen={onOpen} />
      ))}
      {extra > 0 && (
        <Box onClick={onOpen ? () => onOpen() : undefined}>
          <Text dimColor>{`  +${extra} more running…`}</Text>
        </Box>
      )}
    </Box>
  )
}

function WorkflowRunRow({ run, onOpen }: { run: RunState; onOpen?: (runId?: string) => void }) {
  const { columns } = useTerminalSize()
  const elapsed = useElapsedTime(run.startedAt, true, 1000)
  const stats = `${run.agentsDone ?? 0}/${run.agentsInPhase ?? 0} agents done · ${elapsed} · ↓ ${formatTokens(run.totalTokens)} tokens`

  // Budget the left side so the right-aligned stats stay intact; the description
  // truncates first, then (only under extreme narrowness) the name.
  const leftBudget = Math.max(12, columns - stats.length - 4)
  const nameCost = run.workflow.length + 2 // "○ " glyph + space
  const descBudget = Math.max(0, leftBudget - nameCost - 2)
  const desc = run.description && descBudget > 0 ? truncate(run.description, descBudget, true) : ''

  return (
    <Box justifyContent="space-between" onClick={onOpen ? () => onOpen(run.runId) : undefined}>
      <Box flexShrink={1}>
        <Text>{'○ '}</Text>
        <Text bold>{truncate(run.workflow, leftBudget, true)}</Text>
        {desc ? <Text dimColor>{`  ${desc}`}</Text> : null}
      </Box>
      <Text dimColor>{stats}</Text>
    </Box>
  )
}
