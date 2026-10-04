/**
 * The session a permission request is routed in, for the toolPermission
 * characterization suites.
 *
 * `useDecisionWorld` (src/permissions/__testutils__/decisionWorld.ts) gives
 * each test its temp config home and project. On top of that this file
 * builds what the router reads from the session it serves:
 * - the tool-use context, with app state the test can read back and real
 *   PermissionRequest hook commands registered for the session or sub-agent;
 * - the dialog queue, held in a plain array the way the REPL holds it in
 *   React state (the UI boundary);
 * - a swarm team on disk, with this process joined to it as a worker;
 * - a host component that mounts `useCanUseTool` in a real Ink tree.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'

import { clearDynamicTeamContext, setDynamicTeamContext } from 'src/agent/coordinator/teammate.js'
import { permissionContext } from 'src/permissions/__testutils__/decisionWorld.js'
import type { ToolUseConfirm } from 'src/permissions/ui/PermissionRequest.js'
import useCanUseTool, { type CanUseToolFn } from 'src/permissions/useCanUseTool.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import { createFakeTerminal } from 'src/terminal/__testutils__/fakeTerminal.js'
import { createRoot, Text } from 'src/terminal/ink.js'
import type { Tool, ToolPermissionContext, ToolUseContext } from 'src/tools/Tool.js'

export type SessionState = {
  toolPermissionContext: ToolPermissionContext
  [key: string]: unknown
}

export type SessionSpec = {
  permissions?: Partial<ToolPermissionContext>
  /** Present when the request comes from a sub-agent. */
  agentId?: string
  /** Shell commands registered as PermissionRequest hooks. */
  hooks?: string[]
  tools?: Tool[]
  abort?: AbortController
  /** Extra app-state fields (the bridge callbacks, say). */
  state?: Record<string, unknown>
  /** Whether a notification sink is wired, as the REPL wires one. */
  notify?: boolean
}

export type Session = ToolUseContext & {
  state(): SessionState
  readonly notices: Array<Record<string, unknown>>
}

/** Prints a PermissionRequest hook answer the way a hook command would. */
export function hookSays(decision: Record<string, unknown>): string {
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } })
  return `printf '%s' '${out}'`
}

export function openSession(spec: SessionSpec = {}): Session {
  const owner = spec.agentId ?? getSessionId()
  const table = spec.hooks?.length
    ? {
        PermissionRequest: spec.hooks.map(command => ({
          matcher: '*',
          hooks: [{ hook: { type: 'command', command, timeout: 20 } }],
        })),
      }
    : {}
  let state: SessionState = {
    toolPermissionContext: permissionContext(spec.permissions),
    sessionHooks: new Map([[owner, { hooks: table }]]),
    ...spec.state,
  }
  const notices: Array<Record<string, unknown>> = []
  const session = {
    ...(spec.agentId ? { agentId: spec.agentId } : {}),
    abortController: spec.abort ?? new AbortController(),
    messages: [],
    options: { tools: spec.tools ?? [], isNonInteractiveSession: false, mainLoopModel: 'claude-sonnet-4-5' },
    ...(spec.notify ? { addNotification: (n: Record<string, unknown>) => notices.push(n) } : {}),
    getAppState: () => state,
    setAppState: (next: (prev: SessionState) => SessionState) => {
      state = next(state)
    },
    state: () => state,
    notices,
  }
  return session as unknown as Session
}

export type DialogQueue = {
  readonly set: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
  items(): ToolUseConfirm[]
  /** The one entry on screen; throws when there is none or several. */
  only(): ToolUseConfirm
}

export function dialogQueue(): DialogQueue {
  let items: ToolUseConfirm[] = []
  const set = (next: React.SetStateAction<ToolUseConfirm[]>) => {
    items = typeof next === 'function' ? next(items) : next
  }
  return {
    set,
    items: () => items,
    only() {
      if (items.length !== 1) throw new Error(`expected one dialog, found ${items.length}`)
      return items[0] as ToolUseConfirm
    },
  }
}

/** Every permission context pushed back to the app, with its options. */
export function contextSink() {
  const pushed: Array<{ context: ToolPermissionContext; preserveMode?: boolean }> = []
  const set = (context: ToolPermissionContext, options?: { preserveMode?: boolean }) => {
    pushed.push({ context, preserveMode: options?.preserveMode })
  }
  return { set, pushed }
}

export const TURN = {
  type: 'assistant',
  uuid: 'route-suite-turn',
  message: { id: 'msg_route_suite', role: 'assistant', content: [] },
} as never

/** Waits until `ready()` holds, or fails after `ms`. */
export async function until(ready: () => boolean, ms = 4_000): Promise<void> {
  const stop = Date.now() + ms
  while (!ready()) {
    if (Date.now() > stop) throw new Error('condition never held')
    await Bun.sleep(5)
  }
}

// ---- swarm ---------------------------------------------------------------

export type Crew = {
  /** Messages the leader received, decoded. */
  leaderInbox(): Array<Record<string, unknown>>
  leave(): void
}

/**
 * Writes a team under the config home and joins this process to it as the
 * worker `agentId`. With `teamFile: false` the team has no config file, so
 * no leader can be found.
 */
export function joinCrew(
  configDir: string,
  opts: { team?: string; agentId?: string; agentName?: string; teamFile?: boolean } = {},
): Crew {
  const team = opts.team ?? 'crew'
  const agentId = opts.agentId ?? 'worker-7@crew'
  const agentName = opts.agentName ?? 'worker-7'
  const savedFlag = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
  const dir = join(configDir, 'teams', team)
  if (opts.teamFile !== false) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        name: team,
        createdAt: 1,
        leadAgentId: 'lead@crew',
        members: [
          { agentId: 'lead@crew', name: 'captain', joinedAt: 1, tmuxPaneId: '', cwd: '/', subscriptions: [] },
          { agentId, name: agentName, joinedAt: 2, tmuxPaneId: '', cwd: '/', subscriptions: [] },
        ],
      }),
    )
  }
  setDynamicTeamContext({ agentId, agentName, teamName: team, planModeRequired: false })
  return {
    leaderInbox() {
      const file = join(dir, 'inboxes', 'captain.json')
      if (!existsSync(file)) return []
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Array<{ text: string; from: string }>
      return raw.map(m => ({ from: m.from, ...JSON.parse(m.text) }))
    },
    leave() {
      clearDynamicTeamContext()
      if (savedFlag === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
      else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = savedFlag
    },
  }
}

// ---- the hook, mounted ---------------------------------------------------

export type MountedRouter = {
  /** The function the hook returned on its latest render. */
  canUseTool(): CanUseToolFn
  renders(): number
  /** Renders again with these setters. */
  redraw(queue: DialogQueue['set'], setContext: ReturnType<typeof contextSink>['set']): Promise<void>
  close(): void
}

export async function mountRouter(
  queue: DialogQueue['set'],
  setContext: ReturnType<typeof contextSink>['set'],
): Promise<MountedRouter> {
  const terminal = createFakeTerminal()
  const root = await createRoot({ stdin: terminal.stdin, stdout: terminal.stdout, patchConsole: false, exitOnCtrlC: false })
  const seen: { fn?: CanUseToolFn; renders: number } = { renders: 0 }
  function Host(props: { q: DialogQueue['set']; c: ReturnType<typeof contextSink>['set'] }): React.ReactNode {
    seen.fn = useCanUseTool(props.q, props.c)
    seen.renders += 1
    return React.createElement(Text, null, 'router')
  }
  const draw = async (q: DialogQueue['set'], c: ReturnType<typeof contextSink>['set']) => {
    const before = seen.renders
    root.render(React.createElement(Host, { q, c }))
    await until(() => seen.renders > before)
  }
  await draw(queue, setContext)
  return {
    canUseTool: () => seen.fn as CanUseToolFn,
    renders: () => seen.renders,
    redraw: draw,
    close() {
      root.unmount()
      terminal.close()
    },
  }
}
