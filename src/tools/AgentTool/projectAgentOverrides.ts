import { existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import {
  defaultResolveOverrideDeps,
  resolveModelOverride,
  type ResolveOverrideDeps,
} from './agentModelResolver.js'

/**
 * Per-`.md`-agent model overrides live next to the agents directory so
 * users can pin a model without rewriting the `.md` (which is usually
 * checked into the project's git and shared with the team).
 *
 * For a project agent at `<project>/.claudin/agents/<name>.md` the
 * overrides file is `<project>/.claudin/settings.agents.json`. The same
 * scheme works for user agents (`~/.claudin/agents/...`) and local
 * agents — the file always sits in `dirname(baseDir)`.
 *
 * Schema (mirrors the global built-in shape):
 * ```json
 * {
 *   "agentModelOverrides": {
 *     "<agentType>": "<model id | inherit | haiku | sonnet | opus>"
 *   }
 * }
 * ```
 *
 * The `.md` `model:` frontmatter is the team default; this file is the
 * per-user override layered on top.
 */
export const PROJECT_AGENT_OVERRIDES_FILENAME = 'settings.agents.json'

type OverridesFile = {
  agentModelOverrides?: Record<string, string>
  [key: string]: unknown
}

type AgentLike = {
  agentType: string
  source: string
  baseDir?: string
  model?: string
}

export type ProjectAgentOverridesIO = {
  exists: (path: string) => boolean
  read: (path: string) => string
  write: (path: string, contents: string) => void
  logErr: (e: unknown) => void
}

const defaultIO: ProjectAgentOverridesIO = {
  exists: existsSync,
  read: (path: string) => readFileSync(path, 'utf8'),
  write: (path: string, contents: string) => writeFileSync(path, contents, 'utf8'),
  logErr: logError,
}

export function getProjectAgentOverridesPath(baseDir: string): string {
  return join(dirname(baseDir), PROJECT_AGENT_OVERRIDES_FILENAME)
}

function parseOverridesFile(
  raw: string,
  filePath: string,
  io: ProjectAgentOverridesIO,
): OverridesFile {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const obj = parsed as OverridesFile
    if (
      obj.agentModelOverrides !== undefined &&
      (typeof obj.agentModelOverrides !== 'object' ||
        obj.agentModelOverrides === null ||
        Array.isArray(obj.agentModelOverrides))
    ) {
      const { agentModelOverrides: _bad, ...rest } = obj
      return rest
    }
    return obj
  } catch (e) {
    logForDebugging(`Failed to parse project agent overrides at ${filePath}`)
    io.logErr(e)
    return {}
  }
}

export function readProjectAgentOverrides(
  baseDir: string,
  io: ProjectAgentOverridesIO = defaultIO,
): Record<string, string> {
  const path = getProjectAgentOverridesPath(baseDir)
  if (!io.exists(path)) return {}
  let raw: string
  try {
    raw = io.read(path)
  } catch (e) {
    io.logErr(e)
    return {}
  }
  return parseOverridesFile(raw, path, io).agentModelOverrides ?? {}
}

/**
 * Writes `model` into `<dirname(baseDir)>/settings.agents.json` under
 * `agentModelOverrides[agentType]`. Preserves any other entries in the
 * file. Pass `model === undefined` to delete the entry. Throws on I/O
 * failure (caller should `try`/`catch` and surface to the user).
 */
export function writeProjectAgentOverride(
  baseDir: string,
  agentType: string,
  model: string | undefined,
  io: ProjectAgentOverridesIO = defaultIO,
): void {
  const path = getProjectAgentOverridesPath(baseDir)
  let existing: OverridesFile = {}
  if (io.exists(path)) {
    try {
      const raw = io.read(path)
      existing = parseOverridesFile(raw, path, io)
    } catch (e) {
      io.logErr(e)
    }
  }
  const nextOverrides = { ...(existing.agentModelOverrides ?? {}) }
  if (model === undefined) {
    delete nextOverrides[agentType]
  } else {
    nextOverrides[agentType] = model
  }
  const { agentModelOverrides: _, ...rest } = existing
  const next: OverridesFile = {
    ...rest,
    ...(Object.keys(nextOverrides).length > 0
      ? { agentModelOverrides: nextOverrides }
      : {}),
  }
  io.write(path, JSON.stringify(next, null, 2) + '\n')
}

export type ProjectOverridesApplyDeps = {
  readOverrides: (baseDir: string) => Record<string, string>
  resolve: ResolveOverrideDeps
}

const defaultApplyDeps: ProjectOverridesApplyDeps = {
  readOverrides: baseDir => readProjectAgentOverrides(baseDir),
  resolve: defaultResolveOverrideDeps,
}

/**
 * Overlay per-agent model overrides from `settings.agents.json` onto
 * custom (non-built-in) agents. Built-in agents are skipped (they have
 * their own override mechanism in the global config). Agents without a
 * `baseDir` are passed through unchanged.
 *
 * Reads each baseDir at most once per call.
 */
export function applyProjectAgentOverrides<T extends AgentLike>(
  agents: T[],
  deps: ProjectOverridesApplyDeps = defaultApplyDeps,
): T[] {
  const cache = new Map<string, Record<string, string>>()
  return agents.map(agent => {
    if (agent.source === 'built-in' || !agent.baseDir) return agent
    let overrides = cache.get(agent.baseDir)
    if (overrides === undefined) {
      overrides = deps.readOverrides(agent.baseDir)
      cache.set(agent.baseDir, overrides)
    }
    const resolved = resolveModelOverride(
      overrides[agent.agentType],
      `project:${agent.agentType}`,
      deps.resolve,
    )
    if (resolved === undefined) return agent
    return { ...agent, model: resolved }
  })
}
