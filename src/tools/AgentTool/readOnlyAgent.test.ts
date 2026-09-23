import { afterEach, describe, expect, test } from 'bun:test'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { PLAN_AGENT } from 'src/tools/AgentTool/built-in/planAgent.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import {
  applyReadOnly,
  READ_ONLY_DISALLOWED_TOOLS,
} from 'src/tools/AgentTool/readOnlyAgent.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'

const prior = process.env.CLAUDIN_DISABLE_SLIM_CODE_AGENT

afterEach(() => {
  if (prior === undefined) delete process.env.CLAUDIN_DISABLE_SLIM_CODE_AGENT
  else process.env.CLAUDIN_DISABLE_SLIM_CODE_AGENT = prior
})

describe('applyReadOnly', () => {
  const code = GENERAL_PURPOSE_AGENT as AgentDefinition

  test('a read-only named agent loses the write tools and the CLAUDE.md family', () => {
    delete process.env.CLAUDIN_DISABLE_SLIM_CODE_AGENT
    const out = applyReadOnly(code, true, false)
    expect(out.omitClaudeMd).toBe(true)
    expect(out.omitGitStatus).toBe(true)
    expect(out.disallowedTools).toEqual([...READ_ONLY_DISALLOWED_TOOLS])
    expect(out.disallowedTools).toContain(FILE_EDIT_TOOL_NAME)
    expect(out.disallowedTools).toContain(FILE_WRITE_TOOL_NAME)
    expect(out.disallowedTools).toContain(AGENT_TOOL_NAME)
    // The input is not mutated — the registry's definition stays writable.
    expect(code.omitClaudeMd).toBeUndefined()
    expect(code.disallowedTools).toBeUndefined()
  })

  test('merges with an existing denylist without duplicating', () => {
    const custom = { ...code, disallowedTools: [FILE_EDIT_TOOL_NAME, 'WebFetch'] }
    const out = applyReadOnly(custom, true, false)
    expect(out.disallowedTools?.filter(t => t === FILE_EDIT_TOOL_NAME)).toHaveLength(1)
    expect(out.disallowedTools).toContain('WebFetch')
  })

  test('is a no-op without the flag, on a fork, and under the kill-switch', () => {
    delete process.env.CLAUDIN_DISABLE_SLIM_CODE_AGENT
    expect(applyReadOnly(code, undefined, false)).toBe(code)
    expect(applyReadOnly(code, false, false)).toBe(code)
    // A fork shares the parent's cached tool prefix; its pool must not change.
    expect(applyReadOnly(code, true, true)).toBe(code)
    process.env.CLAUDIN_DISABLE_SLIM_CODE_AGENT = '1'
    expect(applyReadOnly(code, true, false)).toBe(code)
  })
})

describe('omitGitInstructions — no commit/PR protocol for agents that never commit', () => {
  // The protocol is ~3.9k chars in the first request of every agent with Bash.
  // A read-only brief and Plan cannot commit (no write tools), so it is dead
  // weight there. runAgent honors the flag only under
  // CLAUDIN_LEAN_GIT_INSTRUCTIONS; the definitions just declare it.
  const code = GENERAL_PURPOSE_AGENT as AgentDefinition

  test('a read-only brief omits it, like the rest of what Plan omits', () => {
    delete process.env.CLAUDIN_DISABLE_SLIM_CODE_AGENT
    const out = applyReadOnly(code, true, false)
    expect(out.omitGitInstructions).toBe(true)
    for (const key of ['omitClaudeMd', 'omitGitStatus', 'omitGitInstructions'] as const) {
      expect({ key, value: out[key] }).toEqual({ key, value: PLAN_AGENT[key] })
    }
  })

  test('Plan omits it', () => {
    expect(PLAN_AGENT.omitGitInstructions).toBe(true)
  })

  test('the general-purpose Code agent keeps it — it commits when its parent asks', () => {
    expect(code.omitGitInstructions).toBeUndefined()
    expect(applyReadOnly(code, false, false).omitGitInstructions).toBeUndefined()
  })
})
