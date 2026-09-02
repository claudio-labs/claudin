/**
 * OpenAI Codex CLI.
 *
 * Everything except the prompts, the skills and `AGENTS.md` lives in one TOML
 * file. Its project-level `.codex/config.toml` deliberately cannot override
 * provider or auth keys, so the provider hint is read from the user-level file
 * only.
 */
import { join } from 'path'

import {
  collectInstructions,
  collectMarkdownCommands,
  collectMcpServers,
  collectProviderHint,
  collectSkillDirs,
  type CollectorTarget,
} from 'src/platform/import/collectors.js'
import { CODEX_PROMPT_DIALECT } from 'src/platform/import/translate/commands.js'
import { translateCodexServer } from 'src/platform/import/translate/mcpServers.js'
import { readTomlFile } from 'src/platform/import/translate/readConfig.js'
import { asString, asTable } from 'src/platform/import/translate/values.js'
import {
  emptyPlan,
  mergePlans,
  type CollectContext,
  type ForeignAgentAdapter,
  type ImportPlan,
} from 'src/platform/import/types.js'

function codexHome(ctx: CollectContext): string {
  return ctx.env.CODEX_HOME ?? join(ctx.homeDir, '.codex')
}

function mcpFrom(
  target: CollectorTarget,
  configPath: string,
): ImportPlan | null {
  const config = readTomlFile(configPath)
  if (!config.ok) {
    if (config.reason === 'missing') return null
    const plan = emptyPlan()
    plan.warnings.push(config.message)
    return plan
  }
  const servers = asTable(config.value.mcp_servers)
  if (!servers) return null
  return collectMcpServers(target, configPath, servers, translateCodexServer)
}

function providerHintFrom(
  target: CollectorTarget,
  configPath: string,
): ImportPlan {
  const config = readTomlFile(configPath)
  if (!config.ok) return emptyPlan()

  const model = asString(config.value.model)
  const providerId = asString(config.value.model_provider) ?? 'openai'
  const providers = asTable(config.value.model_providers)
  const provider = providers ? asTable(providers[providerId]) : null

  const baseUrl =
    (provider ? asString(provider.base_url) : null) ??
    (providerId === 'openai' ? 'https://api.openai.com/v1' : null)
  if (!baseUrl && !model) return emptyPlan()
  const envKey = provider ? asString(provider.env_key) : null

  return collectProviderHint(target, configPath, {
    // Every Codex provider speaks an OpenAI wire format, so the transport
    // family is always `openai` even when the vendor is not.
    provider: 'openai',
    name: (provider ? asString(provider.name) : null) ?? `${providerId} (from Codex)`,
    baseUrl: baseUrl ?? '',
    model: model ?? '',
    ...(envKey ? { envKey } : {}),
  })
}

export const codexAdapter: ForeignAgentAdapter = {
  id: 'codex',
  label: 'OpenAI Codex',
  probePaths: ctx => [
    { path: codexHome(ctx), scope: 'user' },
    { path: join(ctx.cwd, '.codex'), scope: 'project' },
  ],
  collect: async ctx => {
    const home = codexHome(ctx)
    const userTarget: CollectorTarget = { ctx, agent: 'codex', scope: 'user' }
    const userConfig = join(home, 'config.toml')
    const plans: ImportPlan[] = []

    const userMcp = mcpFrom(userTarget, userConfig)
    if (userMcp) plans.push(userMcp)
    plans.push(providerHintFrom(userTarget, userConfig))
    plans.push(collectInstructions(userTarget, join(home, 'AGENTS.md')))
    plans.push(
      collectMarkdownCommands(
        userTarget,
        join(home, 'prompts'),
        CODEX_PROMPT_DIALECT,
      ),
    )
    // Codex takes the same SKILL.md layout, at `~/.codex/skills` and
    // `.codex/skills`. Its own bundled skills live one level down under
    // `skills/.system/`, which has no SKILL.md of its own and so is skipped
    // for free — importing Codex's built-ins would not be a migration.
    plans.push(collectSkillDirs(userTarget, join(home, 'skills')))

    const projectTarget: CollectorTarget = {
      ctx,
      agent: 'codex',
      scope: 'project',
    }
    const projectMcp = mcpFrom(
      projectTarget,
      join(ctx.cwd, '.codex', 'config.toml'),
    )
    if (projectMcp) plans.push(projectMcp)
    plans.push(
      collectSkillDirs(projectTarget, join(ctx.cwd, '.codex', 'skills')),
    )

    const notes = emptyPlan()
    notes.notImportable.push({
      agent: 'codex',
      label: 'credentials',
      detail: `${join(home, 'auth.json')} is never copied by /import — sign in with /provider`,
    })
    notes.notImportable.push({
      agent: 'codex',
      label: 'approval & sandbox policy',
      detail:
        'approval_policy and sandbox_mode have no equivalent — see /permissions',
    })
    plans.push(notes)

    return mergePlans(plans)
  },
}
