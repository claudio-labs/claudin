import { describe, expect, test } from 'bun:test'

import { zodToJsonSchema } from 'src/shared/data/zodToJsonSchema.js'
import { WorkflowTool } from 'src/tools/AgentWorkflow/WorkflowTool/WorkflowTool.js'

describe('WorkflowTool texts', () => {
  // An omitted run_in_background follows workflowsDefaultBackground, and -p
  // never detaches (WorkflowTool.call).
  test('an omitted run_in_background is the /config default, not always synchronous', async () => {
    const prompt = await WorkflowTool.prompt({} as never)
    expect(prompt).toContain("Omitted, the user's /config default decides")
    expect(prompt).not.toContain('omit to run synchronously')
    const { properties } = zodToJsonSchema(WorkflowTool.inputSchema) as {
      properties: Record<string, { description?: string }>
    }
    expect(properties.run_in_background?.description).toContain('/config default')
  })
})
