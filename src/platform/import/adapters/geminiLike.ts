/**
 * Gemini CLI and Qwen Code.
 *
 * Qwen Code is a fork of Gemini CLI and kept its nested `settings.json` schema,
 * so it is this builder with a different directory, a different memory
 * filename, and the two surfaces Gemini does not have (subagents and skills).
 *
 * Two shape details matter. `mcpServers` is a TOP-LEVEL key even though a
 * sibling `mcp` section exists — that section holds allow/exclude policy only.
 * And the nested sections (`model.name`, `context.fileName`) replaced flat keys
 * that older installs still carry, so both spellings are read.
 */
import { join } from 'path'

import {
  collectAgents,
  collectInstructions,
  collectMarkdownCommands,
  collectMcpServers,
  collectProviderHint,
  collectSkillDirs,
  collectTomlCommands,
  tableAt,
  type CollectorTarget,
} from 'src/platform/import/collectors.js'
import { QWEN_AGENT_DIALECT } from 'src/platform/import/translate/agents.js'
import { QWEN_COMMAND_DIALECT } from 'src/platform/import/translate/commands.js'
import { translateGeminiServer } from 'src/platform/import/translate/mcpServers.js'
import { readJsonFile } from 'src/platform/import/translate/readConfig.js'
import {
  asString,
  at,
  type JsonTable,
} from 'src/platform/import/translate/values.js'
import {
  emptyPlan,
  mergePlans,
  type CollectContext,
  type ForeignAgentAdapter,
  type ForeignAgentId,
  type ImportPlan,
} from 'src/platform/import/types.js'

type GeminiLikeSpec = {
  id: ForeignAgentId
  label: string
  /** `.gemini` or `.qwen`. */
  dirName: string
  /** `GEMINI.md` or `QWEN.md`, unless `context.fileName` overrides it. */
  defaultMemoryFile: string
  /** Gemini has no subagents or skills; Qwen has both. */
  hasAgents: boolean
  hasSkills: boolean
  /** The transport family behind this agent's default endpoint. */
  provider: 'gemini' | 'openai'
}

function memoryFileName(settings: JsonTable | null, fallback: string): string {
  if (!settings) return fallback
  return (
    asString(at(settings, 'context', 'fileName')) ??
    asString(settings.contextFileName) ??
    fallback
  )
}

function readSettings(path: string): {
  settings: JsonTable | null
  warning: string | null
} {
  const read = readJsonFile(path)
  if (read.ok) return { settings: read.value, warning: null }
  return {
    settings: null,
    warning: read.reason === 'missing' ? null : read.message,
  }
}

function settingsPlans(
  target: CollectorTarget,
  spec: GeminiLikeSpec,
  settingsPath: string,
  settings: JsonTable | null,
  warning: string | null,
): ImportPlan[] {
  const plans: ImportPlan[] = []
  if (warning) {
    const plan = emptyPlan()
    plan.warnings.push(warning)
    plans.push(plan)
  }
  if (!settings) return plans

  const servers = tableAt(settings, 'mcpServers')
  if (servers) {
    plans.push(
      collectMcpServers(target, settingsPath, servers, translateGeminiServer),
    )
  }

  if (target.scope === 'user') {
    const model =
      asString(at(settings, 'model', 'name')) ?? asString(settings.model)
    const baseUrl =
      asString(at(settings, 'model', 'baseUrl')) ?? asString(settings.baseUrl)
    if (model || baseUrl) {
      plans.push(
        collectProviderHint(target, settingsPath, {
          provider: spec.provider,
          name: `${spec.label} (imported)`,
          baseUrl: baseUrl ?? '',
          model: model ?? '',
        }),
      )
    }

    if (at(settings, 'security', 'auth') !== undefined) {
      const plan = emptyPlan()
      plan.notImportable.push({
        agent: spec.id,
        label: 'auth settings',
        detail: `security.auth in ${settingsPath} selects a sign-in method — use /provider`,
      })
      plans.push(plan)
    }
  }

  return plans
}

export function buildGeminiLikeAdapter(
  spec: GeminiLikeSpec,
): ForeignAgentAdapter {
  return {
    id: spec.id,
    label: spec.label,
    probePaths: (ctx: CollectContext) => [
      { path: join(ctx.homeDir, spec.dirName), scope: 'user' as const },
      { path: join(ctx.cwd, spec.dirName), scope: 'project' as const },
    ],
    collect: async (ctx: CollectContext): Promise<ImportPlan> => {
      const plans: ImportPlan[] = []

      const userDir = join(ctx.homeDir, spec.dirName)
      const userTarget: CollectorTarget = { ctx, agent: spec.id, scope: 'user' }
      const userSettingsPath = join(userDir, 'settings.json')
      const user = readSettings(userSettingsPath)
      plans.push(
        ...settingsPlans(
          userTarget,
          spec,
          userSettingsPath,
          user.settings,
          user.warning,
        ),
      )

      const userMemory = memoryFileName(user.settings, spec.defaultMemoryFile)
      plans.push(collectInstructions(userTarget, join(userDir, userMemory)))
      plans.push(collectTomlCommands(userTarget, join(userDir, 'commands')))
      plans.push(
        collectMarkdownCommands(
          userTarget,
          join(userDir, 'commands'),
          QWEN_COMMAND_DIALECT,
        ),
      )
      if (spec.hasAgents) {
        plans.push(
          collectAgents(userTarget, join(userDir, 'agents'), QWEN_AGENT_DIALECT),
        )
      }
      if (spec.hasSkills) {
        plans.push(collectSkillDirs(userTarget, join(userDir, 'skills')))
      }

      const projectDir = join(ctx.cwd, spec.dirName)
      const projectTarget: CollectorTarget = {
        ctx,
        agent: spec.id,
        scope: 'project',
      }
      const projectSettingsPath = join(projectDir, 'settings.json')
      const project = readSettings(projectSettingsPath)
      plans.push(
        ...settingsPlans(
          projectTarget,
          spec,
          projectSettingsPath,
          project.settings,
          project.warning,
        ),
      )
      plans.push(collectTomlCommands(projectTarget, join(projectDir, 'commands')))
      plans.push(
        collectMarkdownCommands(
          projectTarget,
          join(projectDir, 'commands'),
          QWEN_COMMAND_DIALECT,
        ),
      )
      if (spec.hasAgents) {
        plans.push(
          collectAgents(
            projectTarget,
            join(projectDir, 'agents'),
            QWEN_AGENT_DIALECT,
          ),
        )
      }
      // The project memory file sits at the project ROOT, not inside the
      // agent's directory — GEMINI.md beside AGENTS.md rather than under
      // .gemini/.
      const projectMemory = memoryFileName(
        project.settings ?? user.settings,
        spec.defaultMemoryFile,
      )
      plans.push(collectInstructions(projectTarget, join(ctx.cwd, projectMemory)))

      return mergePlans(plans)
    },
  }
}

export const geminiAdapter = buildGeminiLikeAdapter({
  id: 'gemini',
  label: 'Gemini CLI',
  dirName: '.gemini',
  defaultMemoryFile: 'GEMINI.md',
  hasAgents: false,
  hasSkills: false,
  provider: 'gemini',
})

export const qwenAdapter = buildGeminiLikeAdapter({
  id: 'qwen',
  label: 'Qwen Code',
  dirName: '.qwen',
  defaultMemoryFile: 'QWEN.md',
  hasAgents: true,
  hasSkills: true,
  // Qwen Code talks to DashScope and other OpenAI-compatible endpoints.
  provider: 'openai',
})
