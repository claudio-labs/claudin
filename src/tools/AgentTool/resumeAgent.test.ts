import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
// AgentTool first: agentToolUtils <-> AgentTool form an init cycle (see
// agentToolUtils.test.ts).
import 'src/tools/AgentTool/AgentTool.js'
import { EXPLORE_AGENT } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { FORK_AGENT } from 'src/tools/AgentTool/forkSubagent.js'
import { READ_ONLY_DISALLOWED_TOOLS } from 'src/tools/AgentTool/readOnlyAgent.js'
import { resumedAgentDefinition } from 'src/tools/AgentTool/resumeAgent.js'

const active = [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT]

describe('resumedAgentDefinition — a resume runs as the agent that was launched', () => {
  test('by the agentType its metadata recorded', () => {
    const { selectedAgent, isResumedFork } = resumedAgentDefinition({ agentType: 'Explore' }, active)
    expect(selectedAgent).toBe(EXPLORE_AGENT)
    expect(isResumedFork).toBe(false)
  })

  test('a readOnly launch stays read-only: no write tools come back', () => {
    const { selectedAgent } = resumedAgentDefinition({ agentType: 'Code', readOnly: true }, active)
    for (const tool of READ_ONLY_DISALLOWED_TOOLS) {
      expect(selectedAgent.disallowedTools).toContain(tool)
    }
  })

  test('without readOnly the definition is the one registered, untouched', () => {
    expect(resumedAgentDefinition({ agentType: 'Code' }, active).selectedAgent).toBe(
      GENERAL_PURPOSE_AGENT,
    )
  })

  test('a fork resumes as a fork; no metadata, or an unknown type, as Code', () => {
    expect(resumedAgentDefinition({ agentType: FORK_AGENT.agentType }, active)).toEqual({
      selectedAgent: FORK_AGENT,
      isResumedFork: true,
    })
    expect(resumedAgentDefinition(null, active).selectedAgent).toBe(GENERAL_PURPOSE_AGENT)
    expect(resumedAgentDefinition({ agentType: 'gone' }, active).selectedAgent).toBe(
      GENERAL_PURPOSE_AGENT,
    )
  })
})

describe('readOnly reaches the metadata a resume reads', () => {
  // runAgent needs a live model to reach its metadata write; pin the wiring.
  test('the spawn passes it, runAgent writes it, and a resume passes it on', () => {
    const agentTool = readFileSync(new URL('./AgentTool.tsx', import.meta.url), 'utf8')
    const runAgent = readFileSync(new URL('./runAgent.ts', import.meta.url), 'utf8')
    const resume = readFileSync(new URL('./resumeAgent.ts', import.meta.url), 'utf8')
    expect(agentTool).toContain('readOnly: readOnly === true && !isForkPath,')
    expect(runAgent).toContain('...(readOnly && { readOnly }),')
    expect(resume).toContain('readOnly: meta?.readOnly,')
  })
})

describe('a resume gives the agent back what it had read', () => {
  // runAgent needs a live model to reach a tool call; pin the wiring. What
  // the rebuild restores is tested in queryHelpers.extractReadFiles.test.ts.
  test('the state is rebuilt from the transcript, and runAgent takes it over a fresh cache', () => {
    // Before: a resumed agent started with an empty cache, so every file it
    // had read before the stop was refused as "has not been read yet" — 2 of
    // the 2026-10-05..12 census's refusals, after a 529 stopped the agent.
    const runAgent = readFileSync(new URL('./runAgent.ts', import.meta.url), 'utf8')
    const resume = readFileSync(new URL('./resumeAgent.ts', import.meta.url), 'utf8')
    expect(resume).toMatch(
      /readFileState: extractReadFilesFromMessages\(\s*resumedMessages,\s*resumedWorktreePath \?\? getCwd\(\),\s*READ_FILE_STATE_CACHE_SIZE,?\s*\)/,
    )
    expect(runAgent).toMatch(/const agentReadFileState =\s*readFileState \?\?/)
  })
})

describe('the tool filter reaches the metadata a resume reads', () => {
  test('runAgent picks tools by it and writes it, and a resume passes it on', () => {
    const runAgent = readFileSync(new URL('./runAgent.ts', import.meta.url), 'utf8')
    const resume = readFileSync(new URL('./resumeAgent.ts', import.meta.url), 'utf8')
    expect(runAgent).toContain("toolFilter = isAsync ? 'async' : 'sync',")
    expect(runAgent).toContain('resolveRunTools(agentDefinition, availableTools, isAsync, toolFilter)')
    // Anywhere inside that one call's object, in any position.
    expect(runAgent).toMatch(/writeAgentMetadata\(agentId, \{(?:(?!\}\)\.catch)[\s\S])*\btoolFilter,/)
    // Metadata written before the filter was recorded resumes as it always did.
    expect(resume).toContain("toolFilter: meta?.toolFilter ?? 'async',")
  })

  test('a foreground run sent to the background mid-task keeps its filter too', () => {
    // The continuation re-enters runAgent with isAsync: true; without this it
    // lost LSP or Container mid-task, and recorded the background filter.
    const agentTool = readFileSync(new URL('./AgentTool.tsx', import.meta.url), 'utf8')
    expect(agentTool).toMatch(/isAsync: true,\n\s*\/\/ Agent is now running in background\n\s*toolFilter: 'sync',/)
  })
})
