/**
 * Characterization of the one-line background task row, as the tasks dialog
 * lists it: what each task type shows, how its status reads, and how the
 * activity text is cut to the width it is given.
 *
 * All cases mount together in one Ink root, one row per line, each behind a
 * `name|` marker so a line can be traced to its case.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { Box, Text } from 'src/terminal/ink.js'
import { BackgroundTask } from 'src/agent/ui/tasks/BackgroundTask.js'
import { taskRowLabel } from 'src/agent/ui/tasks/taskRowLabel.js'
import type { BackgroundTaskState } from 'src/agent/tasks/types.js'
import { withInk } from 'src/agent/ui/__testutils__/inkMount.js'
import {
  agentRow,
  containerRow,
  dreamRow,
  mcpRow,
  monitorRow,
  shellRow,
  teammateRow,
  workflowRow,
} from 'src/agent/ui/tasks/__testutils__/backgroundRows.js'

const TIMEOUT = 30_000

type Case = { name: string; task: BackgroundTaskState; width?: number; shows: string }

const LONG = 'run the entire integration suite against every supported database'

const CASES: Case[] = [
  // shells: the command, or the description for a monitor, then the state
  { name: 'shell-running', task: shellRow('b1', { command: 'npm run dev' }), shows: 'npm run dev (running)' },
  { name: 'shell-pending', task: shellRow('b2', { command: 'make', status: 'pending' }), shows: 'make (running)' },
  { name: 'shell-done', task: shellRow('b3', { command: 'make', status: 'completed' }), shows: 'make (done)' },
  { name: 'shell-failed', task: shellRow('b4', { command: 'make', status: 'failed' }), shows: 'make (error)' },
  { name: 'shell-killed', task: shellRow('b5', { command: 'make', status: 'killed' }), shows: 'make (stopped)' },
  { name: 'shell-monitor', task: shellRow('b6', { kind: 'monitor', command: 'tail -f x.log', description: 'Watching x.log' }), shows: 'Watching x.log (running)' },
  { name: 'shell-long', task: shellRow('b7', { command: LONG }), shows: 'run the entire integration suite agains… (running)' },
  { name: 'shell-narrow', task: shellRow('b8', { command: LONG }), width: 12, shows: 'run the ent… (running)' },

  // local agents: the description; a finished one says whether it was read
  { name: 'agent-running', task: agentRow('a1', { description: 'Audit the parser' }), shows: 'Audit the parser (running)' },
  { name: 'agent-unread', task: agentRow('a2', { description: 'Audit', status: 'completed' }), shows: 'Audit (done, unread)' },
  { name: 'agent-read', task: agentRow('a3', { description: 'Audit', status: 'completed', notified: true }), shows: 'Audit (done)' },
  { name: 'agent-failed', task: agentRow('a4', { description: 'Audit', status: 'failed' }), shows: 'Audit (failed)' },
  { name: 'agent-killed', task: agentRow('a5', { description: 'Audit', status: 'killed', notified: true }), shows: 'Audit (killed)' },

  // teammates: @name, then what they are doing
  { name: 'mate-working', task: teammateRow('t1', 'ada'), shows: '@ada: working' },
  { name: 'mate-idle', task: teammateRow('t2', 'bob', { isIdle: true }), shows: '@bob: idle' },
  { name: 'mate-approval', task: teammateRow('t3', 'cy', { awaitingPlanApproval: true, isIdle: true }), shows: '@cy: awaiting approval' },
  { name: 'mate-stopping', task: teammateRow('t4', 'di', { shutdownRequested: true, awaitingPlanApproval: true }), shows: '@di: stopping' },
  {
    name: 'mate-activity',
    task: teammateRow('t5', 'ed', { progress: { lastActivity: { toolName: 'Bash', input: {}, activityDescription: 'Running the tests' } } }),
    shows: '@ed: Running the tests',
  },

  // workflows: the workflow name, else its summary, else the description
  { name: 'flow-named', task: workflowRow('w1', { workflowName: 'nightly', summary: 's', agentCount: 3 }), shows: 'nightly (3 agents)' },
  { name: 'flow-summary', task: workflowRow('w2', { summary: 'Sweep the repo', agentCount: 1 }), shows: 'Sweep the repo (1 agent)' },
  { name: 'flow-plain', task: workflowRow('w3', { description: 'Plain flow', agentCount: 0 }), shows: 'Plain flow (0 agents)' },
  { name: 'flow-done', task: workflowRow('w4', { workflowName: 'nightly', status: 'completed' }), shows: 'nightly (done, unread)' },
  { name: 'flow-failed', task: workflowRow('w5', { workflowName: 'nightly', status: 'failed', notified: true }), shows: 'nightly (failed)' },

  // MCP monitors
  { name: 'monitor-running', task: monitorRow('m1', { description: 'Tailing gateway' }), shows: 'Tailing gateway (running)' },
  { name: 'monitor-done', task: monitorRow('m2', { description: 'Tailing gateway', status: 'completed' }), shows: 'Tailing gateway (done, unread)' },

  // dreams: description · phase · sessions, or files once it is updating
  { name: 'dream-start', task: dreamRow('d1', { description: 'Dreaming' }), shows: 'Dreaming · starting · 4 sessions (running)' },
  { name: 'dream-one', task: dreamRow('d2', { description: 'Dreaming', sessionsReviewing: 1 }), shows: 'Dreaming · starting · 1 session (running)' },
  {
    name: 'dream-files',
    task: dreamRow('d3', { description: 'Dreaming', phase: 'updating', filesTouched: ['a.md', 'b.md'] }),
    shows: 'Dreaming · updating · 2 files (running)',
  },
  {
    name: 'dream-reading',
    task: dreamRow('d6', { description: 'Dreaming', phase: 'reading', filesTouched: ['a.md'], sessionsReviewing: 2 }),
    shows: 'Dreaming · reading · 2 sessions (running)',
  },
  { name: 'dream-nofiles',task: dreamRow('d4', { description: 'Dreaming', phase: 'updating' }), shows: 'Dreaming · updating · 4 sessions (running)' },
  {
    name: 'dream-done',
    task: dreamRow('d5', { description: 'Dreaming', phase: 'updating', filesTouched: ['a.md'], status: 'completed' }),
    shows: 'Dreaming · updating · 1 file (done, unread)',
  },
]

// Container and MCP rows print the shared row label, cut to the width.
const LABELLED: Array<{ name: string; task: BackgroundTaskState; width?: number }> = [
  { name: 'container-up', task: containerRow('cache') },
  { name: 'container-exited', task: containerRow('db', {}, { state: 'exited', exitCode: 2, ports: [] }) },
  { name: 'mcp-connected', task: mcpRow('p1') },
  { name: 'mcp-failed', task: mcpRow('p2', { connectionType: 'failed', error: 'spawn ENOENT' }) },
  { name: 'container-narrow', task: containerRow('verylongservicename'), width: 10 },
]

function rowsOf(frame: string): Map<string, string> {
  const rows = new Map<string, string>()
  for (const line of frame.split('\n')) {
    const bar = line.indexOf('|')
    if (bar > 0) rows.set(line.slice(0, bar).trim(), line.slice(bar + 1).trimEnd())
  }
  return rows
}

function table(cases: Array<{ name: string; task: BackgroundTaskState; width?: number }>) {
  return (
    <Box flexDirection="column">
      {cases.map(c => (
        <Box key={c.name}>
          <Text>{c.name}|</Text>
          <BackgroundTask task={c.task as never} maxActivityWidth={c.width} />
        </Box>
      ))}
    </Box>
  )
}

describe('BackgroundTask row', () => {
  test(
    'each task type renders its label and status',
    async () => {
      await withInk(
        table(CASES),
        async ui => {
          const rows = rowsOf(await ui.waitFor(frame => frame.includes(`${CASES.at(-1)!.name}|`)))
          for (const c of CASES) expect(rows.get(c.name), c.name).toBe(c.shows)
        },
        200,
      )
    },
    TIMEOUT,
  )

  test(
    'container and MCP rows show the shared row label, truncated to the width',
    async () => {
      await withInk(
        table(LABELLED),
        async ui => {
          const rows = rowsOf(await ui.waitFor(frame => frame.includes(`${LABELLED.at(-1)!.name}|`)))
          for (const c of LABELLED.filter(c => c.width === undefined)) {
            expect(rows.get(c.name), c.name).toBe(taskRowLabel(c.task as never))
          }
          const narrow = rows.get('container-narrow')!
          expect(narrow.length).toBe(10)
          expect(narrow.endsWith('…')).toBe(true)
          expect(taskRowLabel(LABELLED.at(-1)!.task as never).startsWith(narrow.slice(0, -1))).toBe(true)
        },
        200,
      )
    },
    TIMEOUT,
  )
})
