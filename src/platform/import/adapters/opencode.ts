/**
 * opencode (SST).
 *
 * Its config is JSON or JSONC, at `~/.config/opencode/` globally and at the
 * project root. Directory names went plural at some point — `agents/` and
 * `commands/` now, `agent/` and `command/` before — so both are read; a
 * half-migrated install would otherwise import as half a set.
 */
import { join } from 'path'

import {
  collectAgents,
  collectMarkdownCommands,
  collectMcpServers,
  collectProviderHint,
  firstExistingPath,
  tableAt,
  type CollectorTarget,
} from 'src/platform/import/collectors.js'
import { OPENCODE_AGENT_DIALECT } from 'src/platform/import/translate/agents.js'
import { OPENCODE_COMMAND_DIALECT } from 'src/platform/import/translate/commands.js'
import { translateOpencodeServer } from 'src/platform/import/translate/mcpServers.js'
import {
  readJsoncFile,
  type ConfigReadResult,
} from 'src/platform/import/translate/readConfig.js'
import { asString, type JsonTable } from 'src/platform/import/translate/values.js'
import {
  emptyPlan,
  mergePlans,
  type CollectContext,
  type ForeignAgentAdapter,
  type ImportPlan,
} from 'src/platform/import/types.js'

const CONFIG_NAMES = ['opencode.jsonc', 'opencode.json'] as const
const COMMAND_DIRS = ['commands', 'command'] as const
const AGENT_DIRS = ['agents', 'agent'] as const

/**
 * opencode model ids are `provider/model`. Only the transport family matters to
 * us, and every provider it supports other than these three speaks OpenAI's
 * wire format.
 */
const TRANSPORT_BY_PREFIX: Record<string, 'anthropic' | 'gemini' | 'mistral'> = {
  anthropic: 'anthropic',
  google: 'gemini',
  'google-vertex': 'gemini',
  gemini: 'gemini',
  mistral: 'mistral',
}

function globalDir(ctx: CollectContext): string {
  return (
    ctx.env.OPENCODE_CONFIG_DIR ??
    join(ctx.env.XDG_CONFIG_HOME ?? join(ctx.homeDir, '.config'), 'opencode')
  )
}

function readConfig(dir: string): {
  path: string
  result: ConfigReadResult
} | null {
  for (const name of CONFIG_NAMES) {
    const path = join(dir, name)
    const result = readJsoncFile(path)
    if (result.ok) return { path, result }
    if (result.reason !== 'missing') return { path, result }
  }
  return null
}

function configPlans(
  target: CollectorTarget,
  found: { path: string; result: ConfigReadResult } | null,
): ImportPlan[] {
  if (!found) return []
  if (!found.result.ok) {
    const plan = emptyPlan()
    plan.warnings.push(found.result.message)
    return [plan]
  }

  const config: JsonTable = found.result.value
  const plans: ImportPlan[] = []

  const servers = tableAt(config, 'mcp')
  if (servers) {
    plans.push(
      collectMcpServers(target, found.path, servers, translateOpencodeServer),
    )
  }

  const model = asString(config.model)
  if (model && target.scope === 'user') {
    const [prefix, ...rest] = model.split('/')
    plans.push(
      collectProviderHint(target, found.path, {
        provider: TRANSPORT_BY_PREFIX[prefix ?? ''] ?? 'openai',
        name: `${prefix ?? 'opencode'} (from opencode)`,
        baseUrl: '',
        model: rest.join('/') || model,
      }),
    )
  }

  if (config.permission !== undefined) {
    const plan = emptyPlan()
    plan.notImportable.push({
      agent: 'opencode',
      label: 'permissions',
      detail: `the "permission" block in ${found.path} uses opencode's own syntax — see /permissions`,
    })
    plans.push(plan)
  }

  return plans
}

function surfacePlans(target: CollectorTarget, root: string): ImportPlan[] {
  const commandDir = firstExistingPath(
    COMMAND_DIRS.map(name => join(root, name)),
  )
  const agentDir = firstExistingPath(AGENT_DIRS.map(name => join(root, name)))
  return [
    commandDir
      ? collectMarkdownCommands(target, commandDir, OPENCODE_COMMAND_DIALECT)
      : emptyPlan(),
    agentDir
      ? collectAgents(target, agentDir, OPENCODE_AGENT_DIALECT)
      : emptyPlan(),
  ]
}

export const opencodeAdapter: ForeignAgentAdapter = {
  id: 'opencode',
  label: 'opencode',
  probePaths: ctx => [
    { path: globalDir(ctx), scope: 'user' },
    { path: join(ctx.cwd, 'opencode.json'), scope: 'project' },
    { path: join(ctx.cwd, 'opencode.jsonc'), scope: 'project' },
    { path: join(ctx.cwd, '.opencode'), scope: 'project' },
  ],
  collect: async ctx => {
    const userTarget: CollectorTarget = { ctx, agent: 'opencode', scope: 'user' }
    const projectTarget: CollectorTarget = {
      ctx,
      agent: 'opencode',
      scope: 'project',
    }
    const userRoot = globalDir(ctx)

    return mergePlans([
      ...configPlans(userTarget, readConfig(userRoot)),
      ...surfacePlans(userTarget, userRoot),
      ...configPlans(projectTarget, readConfig(ctx.cwd)),
      ...surfacePlans(projectTarget, join(ctx.cwd, '.opencode')),
    ])
  },
}
