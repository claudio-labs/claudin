import { describe, expect, test } from 'bun:test'
import { APPLY_PATCH_TOOL_NAME } from 'src/tools/ApplyPatchTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { EXPLORE_AGENT } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { PLAN_AGENT } from 'src/tools/AgentTool/built-in/planAgent.js'

// The built-in Explore/Plan agents are contractually read-only ("you do NOT
// have access to file editing tools"). apply_patch is a mutating tool and must
// be excluded alongside edit/write — otherwise a read-only agent could write.
describe('read-only built-in agents exclude all write tools', () => {
  for (const agent of [EXPLORE_AGENT, PLAN_AGENT]) {
    test(`${agent.agentType} disallows apply_patch (and edit/write)`, () => {
      const disallowed = agent.disallowedTools ?? []
      expect(disallowed).toContain(FILE_EDIT_TOOL_NAME)
      expect(disallowed).toContain(FILE_WRITE_TOOL_NAME)
      expect(disallowed).toContain(APPLY_PATCH_TOOL_NAME)
    })
  }
})
