/**
 * Invariant: the `tools` array a request sends does not depend on the session
 * state that moves while a session runs.
 *
 * `tools` sits in front of every message in the cached prefix: one changed
 * byte there rewrites the whole history. Within a process toolToAPISchema
 * freezes each description on first use (toolSchemaCache.ts), but a --resume
 * starts a new process that computes them again — under whatever permission
 * mode the session had reached — and a /login clears the cache. So a tool's
 * name, order and description must come out the same whichever mode asks.
 *
 * The pool is enumerated, not listed: a new tool is checked the day it lands.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { resetGlobalConfigForTests } from 'src/platform/config/config.js'
import type { PermissionMode } from 'src/permissions/PermissionMode.js'
import { getEmptyToolPermissionContext, type Tool, type ToolPermissionContext } from 'src/tools/Tool.js'
import { assembleToolPool } from 'src/tools/tools.js'

afterAll(() => {
  resetGlobalConfigForTests()
})

/** Every mode a session moves through without restarting. */
const MODES: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'auto']

function contextIn(mode: PermissionMode): ToolPermissionContext {
  return { ...getEmptyToolPermissionContext(), mode }
}

async function description(tool: Tool, mode: PermissionMode, pool: readonly Tool[]): Promise<string> {
  return tool.prompt({
    getToolPermissionContext: async () => contextIn(mode),
    tools: pool as never,
    agents: [],
    allowedAgentTypes: undefined,
  })
}

test('the pool has the same tools, in the same order, in every mode', () => {
  const names = MODES.map(mode => assembleToolPool(contextIn(mode), []).map(t => t.name))
  for (const [i, mode] of MODES.entries()) {
    expect({ mode, names: names[i] }).toEqual({ mode, names: names[0]! })
  }
})

describe('every tool describes itself the same way in every mode', () => {
  const pool = assembleToolPool(contextIn('default'), [])
  for (const tool of pool) {
    test(tool.name, async () => {
      const first = await description(tool, MODES[0]!, pool)
      for (const mode of MODES.slice(1)) {
        expect({ mode, description: await description(tool, mode, pool) }).toEqual({
          mode,
          description: first,
        })
      }
    })
  }
})
