/**
 * Cursor CLI.
 *
 * Two surfaces: `mcp.json` at both scopes, and `.cursor/rules/**.mdc` in the
 * project. Cursor's *user* rules are edited in its UI and have no file, so
 * there is nothing to read at that scope.
 */
import { join } from 'path'

import {
  collectCursorRules,
  collectMcpServers,
  reportUnimportablePermissions,
  tableAt,
  type CollectorTarget,
} from 'src/platform/import/collectors.js'
import { translateCursorServer } from 'src/platform/import/translate/mcpServers.js'
import { readJsonFile } from 'src/platform/import/translate/readConfig.js'
import { at } from 'src/platform/import/translate/values.js'
import {
  emptyPlan,
  mergePlans,
  type CollectContext,
  type ForeignAgentAdapter,
  type ImportPlan,
} from 'src/platform/import/types.js'

function cursorHome(ctx: CollectContext): string {
  return ctx.env.CURSOR_CONFIG_DIR ?? join(ctx.homeDir, '.cursor')
}

function mcpPlan(target: CollectorTarget, path: string): ImportPlan {
  const read = readJsonFile(path)
  if (!read.ok) {
    if (read.reason === 'missing') return emptyPlan()
    const plan = emptyPlan()
    plan.warnings.push(read.message)
    return plan
  }
  const servers = tableAt(read.value, 'mcpServers')
  if (!servers) return emptyPlan()
  return collectMcpServers(target, path, servers, translateCursorServer)
}

export const cursorAdapter: ForeignAgentAdapter = {
  id: 'cursor',
  label: 'Cursor',
  probePaths: ctx => [
    { path: cursorHome(ctx), scope: 'user' },
    { path: join(ctx.cwd, '.cursor'), scope: 'project' },
  ],
  collect: async ctx => {
    const home = cursorHome(ctx)
    const userTarget: CollectorTarget = { ctx, agent: 'cursor', scope: 'user' }
    const projectTarget: CollectorTarget = {
      ctx,
      agent: 'cursor',
      scope: 'project',
    }
    const projectCursor = join(ctx.cwd, '.cursor')
    const cliConfigPath = join(home, 'cli-config.json')
    const cliConfig = readJsonFile(cliConfigPath)

    return mergePlans([
      mcpPlan(userTarget, join(home, 'mcp.json')),
      mcpPlan(projectTarget, join(projectCursor, 'mcp.json')),
      collectCursorRules(projectTarget, join(projectCursor, 'rules')),
      cliConfig.ok
        ? reportUnimportablePermissions(
            'cursor',
            cliConfigPath,
            at(cliConfig.value, 'permissions', 'allow'),
            at(cliConfig.value, 'permissions', 'deny'),
          )
        : emptyPlan(),
    ])
  },
}
