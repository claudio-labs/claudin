import { describe, expect, test } from 'bun:test'
import { APPLY_PATCH_TOOL_NAME } from 'src/tools/ApplyPatchTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GENERAL_PURPOSE_AGENT } from 'src/tools/AgentTool/built-in/generalPurposeAgent.js'
import { PLAN_AGENT } from 'src/tools/AgentTool/built-in/planAgent.js'

const PARAMS = { toolUseContext: { options: {} as never } }

// The built-in Plan agent is contractually read-only ("you do NOT have access
// to file editing tools"). apply_patch is a mutating tool and must be excluded
// alongside edit/write — otherwise a read-only agent could write.
describe('read-only built-in agents exclude all write tools', () => {
  for (const agent of [PLAN_AGENT]) {
    test(`${agent.agentType} disallows apply_patch (and edit/write)`, () => {
      const disallowed = agent.disallowedTools ?? []
      expect(disallowed).toContain(FILE_EDIT_TOOL_NAME)
      expect(disallowed).toContain(FILE_WRITE_TOOL_NAME)
      expect(disallowed).toContain(APPLY_PATCH_TOOL_NAME)
    })
  }
})

// Moved here when exploreAgent.test.ts was deleted with its agent: the reading
// order was replicated into Plan and Code, and those two copies were only ever
// covered by that file's loop. Measured motivation: across 99 sessions only
// 22.7% of the Reads these agents issued were targeted (outline/symbol), the
// rest pulled whole files.
describe('reading order in the bulk-reading agents', () => {
  for (const agent of [PLAN_AGENT, GENERAL_PURPOSE_AGENT]) {
    test(`${agent.agentType} prefers outline/symbol over a full read`, () => {
      const prompt = agent.getSystemPrompt(PARAMS)
      expect(prompt).toContain("view='outline'")
      expect(prompt).toContain("symbol='name'")
      expect(prompt).toContain('offset/limit')
      expect(prompt).toContain('Read a file in full only when')
    })

    test(`${agent.agentType} states the order, not just the options`, () => {
      const prompt = agent.getSystemPrompt(PARAMS)
      expect(prompt.indexOf("view='outline'")).toBeLessThan(
        prompt.indexOf("symbol='name'"),
      )
    })
  }
})
