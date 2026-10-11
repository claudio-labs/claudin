import { describe, expect, test } from 'bun:test'
// AgentTool first: agentToolUtils <-> AgentTool form an init cycle (see
// agentToolUtils.test.ts).
import 'src/tools/AgentTool/AgentTool.js'
import type { Tool, Tools } from 'src/tools/Tool.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { resolveRunTools } from 'src/tools/AgentTool/toolPool.js'
import { CONTAINER_TOOL_NAME } from 'src/tools/ContainerTool/prompt.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { LSP_TOOL_NAME } from 'src/tools/LSPTool/prompt.js'

// Only `name` is read on this path.
const tool = (name: string): Tool => ({ name }) as unknown as Tool
const pool: Tools = [tool(FILE_READ_TOOL_NAME), tool(LSP_TOOL_NAME), tool(CONTAINER_TOOL_NAME), tool(AGENT_TOOL_NAME)]
// A Code-style agent: every tool the filter lets through.
const code = { tools: undefined, disallowedTools: undefined, source: 'built-in', permissionMode: undefined } as const
const names = (tools: Tools) => tools.map(t => t.name)

describe('resolveRunTools — the tools one run of an agent gets', () => {
  test('a resume of an agent that first ran in the foreground keeps that pool', () => {
    // A resume always runs in the background. Filtered as one, it lost every
    // tool outside the async allowlist its first run had used.
    const resumed = names(resolveRunTools(code, pool, true, 'sync').resolvedTools)
    expect(resumed).toContain(LSP_TOOL_NAME)
    expect(resumed).toContain(CONTAINER_TOOL_NAME)
  })

  test('…but a background run never holds Agent, whatever its pool', () => {
    expect(names(resolveRunTools(code, pool, true, 'sync').resolvedTools)).not.toContain(AGENT_TOOL_NAME)
  })

  test('a background run on the async pool keeps the async allowlist', () => {
    expect(names(resolveRunTools(code, pool, true, 'async').resolvedTools)).toEqual([FILE_READ_TOOL_NAME])
  })

  test('a foreground run is untouched, Agent included', () => {
    expect(names(resolveRunTools(code, pool, false, 'sync').resolvedTools)).toEqual(names(pool))
  })
})
