import { describe, expect, test } from 'bun:test'
import { buildDecisionSchema, isTerminalStep, type WorkflowStep } from 'src/tools/AgentWorkflow/types.js'

const step = (over: Partial<WorkflowStep> = {}): WorkflowStep => ({
  name: 'phase',
  agents: ['worker'],
  ...over,
})

describe('buildDecisionSchema', () => {
  test('omits handback + target when the phase declares no handbackTo', () => {
    const schema = buildDecisionSchema(step()) as {
      properties: { decision: { enum: string[] }; target?: unknown }
      required: string[]
      additionalProperties: boolean
    }
    expect(schema.properties.decision.enum).toEqual(['advance', 'refine'])
    // The model must not be able to hand back to an undeclared target.
    expect(schema.properties.target).toBeUndefined()
    expect(schema.required).toEqual(['decision', 'notes'])
    expect(schema.additionalProperties).toBe(false)
  })

  test('offers handback and constrains target to the declared phases', () => {
    const schema = buildDecisionSchema(step({ handbackTo: ['development', 'design'] })) as {
      properties: { decision: { enum: string[] }; target: { enum: string[] } }
    }
    expect(schema.properties.decision.enum).toEqual(['advance', 'refine', 'handback'])
    expect(schema.properties.target.enum).toEqual(['development', 'design'])
  })

  test('treats an empty handbackTo array like no handback', () => {
    const schema = buildDecisionSchema(step({ handbackTo: [] })) as {
      properties: { decision: { enum: string[] }; target?: unknown }
    }
    expect(schema.properties.decision.enum).toEqual(['advance', 'refine'])
    expect(schema.properties.target).toBeUndefined()
  })
})

describe('isTerminalStep', () => {
  test('an undefined step is terminal', () => {
    expect(isTerminalStep(undefined)).toBe(true)
  })

  test('a step with no agents is terminal', () => {
    expect(isTerminalStep(step({ agents: [] }))).toBe(true)
  })

  test('a step with at least one agent is not terminal', () => {
    expect(isTerminalStep(step({ agents: ['coder'] }))).toBe(false)
  })
})
