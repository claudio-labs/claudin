/**
 * A throwaway world for the permission-decision characterization suites
 * (`src/permissions/permissions.*.characterization.test.ts`).
 *
 * Each test gets its own temp tree: a config home, a managed-settings
 * directory, a project the session sits in, and a scratch area for hook
 * scripts. Settings files are written where the settings loader looks for
 * them, and every process-global the decision reads is put back afterwards.
 *
 * Tools are small stand-ins with a real zod schema. The decision treats a
 * tool's own verdict (`checkPermissions`) as an input, so the stand-in lets a
 * test hand it any verdict and watch what the decision makes of it.
 */
import { afterEach, beforeEach } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod/v4'

import { getPlansDirectory } from 'src/agent/plans/plans.js'
import {
  getCwdState,
  getFlagSettingsInline,
  getFlagSettingsPath,
  getIsInteractive,
  getOriginalCwd,
  getProjectRoot,
  setCwdState,
  setFlagSettingsInline,
  setFlagSettingsPath,
  setIsInteractive,
  setOriginalCwd,
  setProjectRoot,
} from 'src/platform/bootstrap/state.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import type { DenialTrackingState } from 'src/permissions/denialTracking.js'
import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import {
  getEmptyToolPermissionContext,
  type Tool,
  type ToolPermissionContext,
  type ToolUseContext,
} from 'src/tools/Tool.js'

/** Environment the decision path reads. Each test starts with all of them unset. */
const OWNED_ENV = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_SIMPLE',
  'CLAUDIN_AUTO_MODE_CLASSIFIER_TIMEOUT_MS',
  'CLAUDE_AGENT_SDK_MCP_NO_PREFIX',
] as const

export type Layer = 'user' | 'project' | 'local' | 'flag' | 'policy'

/** What a stand-in tool answers when the decision asks it. */
export type Verdict =
  | PermissionResult
  | ((input: Record<string, unknown>, seenMode: string) => PermissionResult | Promise<PermissionResult>)

export type StandInSpec = {
  name: string
  readOnly?: boolean | ((input: Record<string, unknown>) => boolean)
  verdict?: Verdict
  needsUser?: boolean
  mcp?: { serverName: string; toolName: string }
  /** Text the classifier gets for this tool; '' means nothing relevant. */
  classifierText?: (input: Record<string, unknown>) => string
}

export type StandIn = Tool & {
  /** The permission mode the tool saw on each of its own checks, in order. */
  readonly seenModes: string[]
}

/** The slice of app state the decision reads and writes. */
export type AppStateLike = {
  sessionHooks?: Map<string, { hooks: Record<string, unknown> }>
  [key: string]: unknown
} & { toolPermissionContext: ToolPermissionContext } & Partial<Record<'denialTracking', DenialTrackingState>>

export type ContextSpec = {
  permissions?: Partial<ToolPermissionContext>
  agentId?: string
  tools?: Tool[]
  /** The streak held in app state, as the main session keeps it. */
  sessionDenials?: { consecutiveDenials: number; totalDenials: number }
  /** The streak a sub-agent keeps for itself. */
  subagentDenials?: { consecutiveDenials: number; totalDenials: number }
  messages?: unknown[]
  abort?: AbortController
  /** PermissionRequest command hooks, each a shell snippet that prints the hook's answer. */
  permissionRequestHooks?: Array<{ matcher?: string; command: string }>
}

export type Ctx = ToolUseContext & {
  /** The app state as the decision left it. */
  state(): AppStateLike
}

export type DecisionWorld = {
  readonly root: string
  readonly configDir: string
  readonly project: string
  settings(layer: Layer, values: Record<string, unknown>): string
  settingsPath(layer: Layer): string
  /** Writes a bash script under the world and returns the command that runs it. */
  script(body: string): string
  refresh(): void
}

/** Builds a stand-in tool. */
export function standIn(spec: StandInSpec): StandIn {
  const seenModes: string[] = []
  const inputSchema = z
    .object({
      command: z.string().optional(),
      file_path: z.string().optional(),
      dangerouslyDisableSandbox: z.boolean().optional(),
      broken: z.literal(undefined).optional(),
    })
    .passthrough()
  const tool = {
    name: spec.name,
    ...(spec.mcp ? { mcpInfo: spec.mcp, isMcp: true } : {}),
    inputSchema,
    seenModes,
    async checkPermissions(input: Record<string, unknown>, ctx: ToolUseContext) {
      const mode = ctx.getAppState().toolPermissionContext.mode
      seenModes.push(mode)
      const verdict = spec.verdict ?? { behavior: 'passthrough', message: 'stand-in passthrough' }
      return typeof verdict === 'function' ? verdict(input, mode) : verdict
    },
    isReadOnly(input: Record<string, unknown>) {
      const ro = spec.readOnly ?? false
      return typeof ro === 'function' ? ro(input) : ro
    },
    ...(spec.needsUser ? { requiresUserInteraction: () => true } : {}),
    toAutoClassifierInput(input: Record<string, unknown>) {
      return spec.classifierText ? spec.classifierText(input) : JSON.stringify(input)
    },
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    userFacingName: () => spec.name,
    async description() {
      return spec.name
    },
    async prompt() {
      return spec.name
    },
    async call() {
      throw new Error('a stand-in tool never runs')
    },
  }
  return tool as unknown as StandIn
}

/** A permission context with rules laid out by source, as callers hold them. */
export function permissionContext(overrides: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return { ...getEmptyToolPermissionContext(), ...overrides } as ToolPermissionContext
}

/** A tool-use context whose app state lives in a small store the test can read back. */
export function makeCtx(spec: ContextSpec = {}): Ctx {
  const hooks: Record<string, unknown> = {}
  if (spec.permissionRequestHooks?.length) {
    hooks.PermissionRequest = spec.permissionRequestHooks.map(({ matcher = '*', command }) => ({
      matcher,
      hooks: [{ hook: { type: 'command', command, timeout: 20 } }],
    }))
  }
  const agentId = spec.agentId ?? 'decision-suite-agent'
  let state: AppStateLike = {
    toolPermissionContext: permissionContext(spec.permissions),
    ...(spec.sessionDenials ? { denialTracking: spec.sessionDenials } : {}),
    sessionHooks: new Map([[agentId, { hooks }]]),
  }
  const ctx = {
    agentId,
    abortController: spec.abort ?? new AbortController(),
    messages: spec.messages ?? [],
    options: {
      tools: spec.tools ?? [],
      isNonInteractiveSession: true,
      mainLoopModel: 'claude-sonnet-4-5',
    },
    ...(spec.subagentDenials ? { localDenialTracking: spec.subagentDenials } : {}),
    getAppState: () => state,
    setAppState: (update: (prev: AppStateLike) => AppStateLike) => {
      state = update(state)
    },
    state: () => state,
  }
  return ctx as unknown as Ctx
}

type Snapshot = {
  env: Array<[string, string | undefined]>
  projectRoot: string
  originalCwd: string
  cwd: string
  interactive: boolean
  flagPath: string | undefined
  flagInline: Record<string, unknown> | null
}

function snapshot(): Snapshot {
  return {
    env: OWNED_ENV.map(name => [name, process.env[name]]),
    projectRoot: getProjectRoot(),
    originalCwd: getOriginalCwd(),
    cwd: getCwdState(),
    interactive: getIsInteractive(),
    flagPath: getFlagSettingsPath(),
    flagInline: getFlagSettingsInline(),
  }
}

function restore(saved: Snapshot): void {
  for (const [name, value] of saved.env) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  setProjectRoot(saved.projectRoot)
  setOriginalCwd(saved.originalCwd)
  setCwdState(saved.cwd)
  setIsInteractive(saved.interactive)
  setFlagSettingsPath(saved.flagPath)
  setFlagSettingsInline(saved.flagInline)
}

function open(): { world: DecisionWorld; close: () => void } {
  const saved = snapshot()
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'perm-decision-')))
  const configDir = join(root, 'config')
  const managed = join(root, 'managed')
  const project = join(root, 'project')
  const scripts = join(root, 'scripts')
  for (const dir of [configDir, managed, project, scripts]) mkdirSync(dir, { recursive: true })

  for (const name of OWNED_ENV) delete process.env[name]
  process.env.CLAUDIN_CONFIG_DIR = configDir
  setFlagSettingsPath(undefined)
  setFlagSettingsInline(null)
  getManagedFilePath.cache.set(undefined, managed)
  getManagedSettingsDropInDir.cache.set(undefined, join(managed, 'managed-settings.d'))
  setProjectRoot(project)
  setOriginalCwd(project)
  setCwdState(project)
  // Hooks run without a trust prompt only outside an interactive session.
  setIsInteractive(false)

  const refresh = (): void => {
    resetSettingsCache()
    getPlansDirectory.cache.clear?.()
  }
  refresh()

  const settingsPath = (layer: Layer): string =>
    ({
      user: join(configDir, 'settings.json'),
      project: join(project, '.claudin', 'settings.json'),
      local: join(project, '.claudin', 'settings.local.json'),
      flag: join(root, 'flag-settings.json'),
      policy: join(managed, 'managed-settings.json'),
    })[layer]

  let scriptCount = 0
  const world: DecisionWorld = {
    root,
    configDir,
    project,
    settingsPath,
    settings(layer, values) {
      const file = settingsPath(layer)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(values, null, 2))
      if (layer === 'flag') setFlagSettingsPath(file)
      refresh()
      return file
    },
    script(body) {
      const file = join(scripts, `hook-${++scriptCount}.sh`)
      writeFileSync(file, ['#!/bin/bash', 'input=$(cat)', body, ''].join('\n'))
      return `bash '${file}'`
    },
    refresh,
  }

  const close = (): void => {
    restore(saved)
    getManagedFilePath.cache.delete(undefined)
    getManagedSettingsDropInDir.cache.delete(undefined)
    refresh()
    rmSync(root, { recursive: true, force: true })
  }
  return { world, close }
}

/** Registers a fresh world around every test of the calling file. */
export function useDecisionWorld(): () => DecisionWorld {
  let current: { world: DecisionWorld; close: () => void } | undefined
  beforeEach(() => {
    current = open()
  })
  afterEach(() => {
    current?.close()
    current = undefined
  })
  return () => {
    if (!current) throw new Error('useDecisionWorld: there is no world outside a test')
    return current.world
  }
}

/** The assistant message the decision is handed alongside the call. */
export const ASSISTANT_TURN = {
  type: 'assistant',
  uuid: 'decision-suite-turn',
  message: { id: 'msg_decision_suite', role: 'assistant', content: [] },
} as never

/** The message a decision carries, when its kind has one. */
export function messageOf(decision: { behavior: string } | null | undefined): string | undefined {
  return decision && 'message' in decision ? (decision as { message?: string }).message : undefined
}
