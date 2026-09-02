/**
 * Claude Code and openclaude.
 *
 * openclaude is a fork of Claude Code with the same on-disk layout, so it is
 * this builder with a different root directory rather than a second
 * implementation. Its config directory is not documented, so both candidates
 * are probed and whichever exists wins.
 *
 * Two surfaces are deliberately absent: a project `CLAUDE.md` and a project
 * `.mcp.json` are read by Claudin natively, so importing them would copy a file
 * onto itself.
 */
import { join } from 'path'

import {
  collectMcpServers,
  collectSettingsKeys,
  collectSkillDirs,
  collectInstructions,
  collectVerbatimMarkdown,
  firstExistingPath,
  tableAt,
  type CollectorTarget,
} from 'src/platform/import/collectors.js'
import { readJsonFile } from 'src/platform/import/translate/readConfig.js'
import { translateClaudeShapedServer } from 'src/platform/import/translate/mcpServers.js'
import {
  emptyPlan,
  mergePlans,
  type CollectContext,
  type ForeignAgentAdapter,
  type ForeignAgentId,
  type ImportPlan,
  type ProbePath,
} from 'src/platform/import/types.js'
import { fileSuffixForOauthConfig } from 'src/shared/constants/oauth.js'

/**
 * Deliberately NARROWER than the startup migration's whitelist
 * (`SETTINGS_WHITELIST`, `src/platform/config/claudinMigration.ts:51`), and the
 * two must not be merged:
 *
 * - `providerProfiles` / `activeProviderProfileId` hold **plaintext API keys**.
 *   The startup migration is a one-time move of the user's own directory into
 *   their own directory; `/import` promised not to move secrets, so it does not.
 * - `mcpServers` is imported as its own artifacts instead, so it shows up in the
 *   tree with a count and per-server conflict detection.
 *
 * `claudeLike.settingsKeys.test.ts` pins both of those.
 */
const SETTINGS_KEYS = [
  'theme',
  'model',
  'editorMode',
  'verbose',
  'permissions',
  'customApiKeyResponses',
] as const

type ClaudeLikeSpec = {
  id: ForeignAgentId
  label: string
  /** Candidate user config directories, in preference order. */
  userDirs: (home: string) => string[]
  /** The legacy single-file global config, e.g. `~/.claude.json`. */
  globalConfigFile: (home: string) => string
  /** The per-project directory name, e.g. `.claude`. */
  projectDirName: string
}

function collectFromRoot(target: CollectorTarget, root: string): ImportPlan {
  const settingsPath = join(root, 'settings.json')
  const settings = readJsonFile(settingsPath)
  const plans: ImportPlan[] = []

  if (settings.ok) {
    const servers = tableAt(settings.value, 'mcpServers')
    if (servers) {
      plans.push(
        collectMcpServers(
          target,
          settingsPath,
          servers,
          translateClaudeShapedServer,
        ),
      )
    }
    plans.push(
      collectSettingsKeys(target, settingsPath, settings.value, SETTINGS_KEYS),
    )
  } else if (settings.reason !== 'missing') {
    const plan = emptyPlan()
    plan.warnings.push(settings.message)
    plans.push(plan)
  }

  plans.push(collectVerbatimMarkdown(target, join(root, 'commands'), 'command'))
  plans.push(collectVerbatimMarkdown(target, join(root, 'agents'), 'agent'))
  plans.push(collectSkillDirs(target, join(root, 'skills')))
  return mergePlans(plans)
}

export function buildClaudeLikeAdapter(
  spec: ClaudeLikeSpec,
): ForeignAgentAdapter {
  return {
    id: spec.id,
    label: spec.label,
    probePaths: (ctx: CollectContext): ProbePath[] => [
      ...spec.userDirs(ctx.homeDir).map(path => ({
        path,
        scope: 'user' as const,
      })),
      { path: spec.globalConfigFile(ctx.homeDir), scope: 'user' as const },
      { path: join(ctx.cwd, spec.projectDirName), scope: 'project' as const },
    ],
    collect: async (ctx: CollectContext): Promise<ImportPlan> => {
      const plans: ImportPlan[] = []
      const userTarget: CollectorTarget = { ctx, agent: spec.id, scope: 'user' }

      const userRoot = firstExistingPath(spec.userDirs(ctx.homeDir))
      if (userRoot) {
        plans.push(collectFromRoot(userTarget, userRoot))
        plans.push(
          collectInstructions(userTarget, join(userRoot, 'CLAUDE.md')),
        )
        const credentials = join(userRoot, '.credentials.json')
        const credentialsPlan = emptyPlan()
        credentialsPlan.notImportable.push({
          agent: spec.id,
          label: 'credentials',
          detail: `${credentials} is never copied by /import — sign in with /provider`,
        })
        plans.push(credentialsPlan)
      }

      const globalConfigPath = spec.globalConfigFile(ctx.homeDir)
      const globalConfig = readJsonFile(globalConfigPath)
      if (globalConfig.ok) {
        const servers = tableAt(globalConfig.value, 'mcpServers')
        if (servers) {
          plans.push(
            collectMcpServers(
              userTarget,
              globalConfigPath,
              servers,
              translateClaudeShapedServer,
            ),
          )
        }
      }

      const projectRoot = join(ctx.cwd, spec.projectDirName)
      plans.push(
        collectFromRoot(
          { ctx, agent: spec.id, scope: 'project' },
          projectRoot,
        ),
      )

      return mergePlans(plans)
    },
  }
}

export const claudeAdapter = buildClaudeLikeAdapter({
  id: 'claude',
  label: 'Claude Code',
  userDirs: home => [join(home, '.claude')],
  globalConfigFile: home => join(home, `.claude${fileSuffixForOauthConfig()}.json`),
  projectDirName: '.claude',
})

export const openclaudeAdapter = buildClaudeLikeAdapter({
  id: 'openclaude',
  label: 'openclaude',
  userDirs: home => [join(home, '.openclaude'), join(home, '.config', 'openclaude')],
  globalConfigFile: home =>
    join(home, `.openclaude${fileSuffixForOauthConfig()}.json`),
  projectDirName: '.openclaude',
})
