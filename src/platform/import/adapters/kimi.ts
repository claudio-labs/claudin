/**
 * Kimi CLI (Moonshot AI).
 *
 * User-scope only: its project surface is an `AGENTS.md` at the project root,
 * which Claudin already reads as its primary instruction file, so there is
 * nothing to import there. MCP lives in its own Claude-compatible JSON file
 * rather than in the TOML config.
 */
import { join } from 'path'

import {
  collectInstructions,
  collectMcpServers,
  collectProviderHint,
  tableAt,
  type CollectorTarget,
} from 'src/platform/import/collectors.js'
import { translateClaudeShapedServer } from 'src/platform/import/translate/mcpServers.js'
import {
  readJsonFile,
  readTomlFile,
} from 'src/platform/import/translate/readConfig.js'
import { asString, asTable } from 'src/platform/import/translate/values.js'
import {
  emptyPlan,
  mergePlans,
  type CollectContext,
  type ForeignAgentAdapter,
  type ImportPlan,
} from 'src/platform/import/types.js'

function kimiHome(ctx: CollectContext): string {
  return ctx.env.KIMI_CODE_HOME ?? join(ctx.homeDir, '.kimi')
}

/**
 * `[providers.<name>]` gives the endpoint and `[models.<name>]` names the model
 * behind it. The first provider that has a base_url is the one described, since
 * the config does not record which is active.
 */
function providerHint(
  target: CollectorTarget,
  configPath: string,
): ImportPlan {
  const config = readTomlFile(configPath)
  if (!config.ok) return emptyPlan()

  const providers = asTable(config.value.providers)
  if (!providers) return emptyPlan()

  for (const [name, raw] of Object.entries(providers)) {
    const provider = asTable(raw)
    const baseUrl = provider ? asString(provider.base_url) : null
    if (!baseUrl) continue

    const models = asTable(config.value.models)
    const model = models
      ? (Object.values(models)
          .map(entry => asTable(entry))
          .find(entry => entry && asString(entry.provider) === name)?.model ??
          null)
      : null

    return collectProviderHint(target, configPath, {
      // Moonshot and everything else Kimi CLI talks to are OpenAI-compatible.
      provider: 'openai',
      name: `${name} (from Kimi CLI)`,
      baseUrl,
      model: asString(model) ?? '',
    })
  }
  return emptyPlan()
}

export const kimiAdapter: ForeignAgentAdapter = {
  id: 'kimi',
  label: 'Kimi CLI',
  probePaths: ctx => [{ path: kimiHome(ctx), scope: 'user' }],
  collect: async ctx => {
    const home = kimiHome(ctx)
    const target: CollectorTarget = { ctx, agent: 'kimi', scope: 'user' }
    const plans: ImportPlan[] = []

    const mcpPath = join(home, 'mcp.json')
    const mcp = readJsonFile(mcpPath)
    if (mcp.ok) {
      const servers = tableAt(mcp.value, 'mcpServers')
      if (servers) {
        plans.push(
          collectMcpServers(
            target,
            mcpPath,
            servers,
            translateClaudeShapedServer,
          ),
        )
      }
    } else if (mcp.reason !== 'missing') {
      const plan = emptyPlan()
      plan.warnings.push(mcp.message)
      plans.push(plan)
    }

    plans.push(collectInstructions(target, join(home, 'AGENTS.md')))
    plans.push(providerHint(target, join(home, 'config.toml')))

    const notes = emptyPlan()
    notes.notImportable.push({
      agent: 'kimi',
      label: 'credentials',
      detail: `${join(home, 'credentials')} is never read by /import — sign in with /provider`,
    })
    notes.notImportable.push({
      agent: 'kimi',
      label: 'agents',
      detail:
        'Kimi agents are YAML files loaded by --agent-file, with no directory to discover them in',
    })
    plans.push(notes)

    return mergePlans(plans)
  },
}
