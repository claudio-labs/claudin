import { describe, expect, test } from 'bun:test'
import { parseWorkflow } from 'src/tools/AgentWorkflow/loadWorkflows.js'
import { renameStep, serializeWorkflow } from 'src/tools/AgentWorkflow/serializeWorkflow.js'
import type { WorkflowDef } from 'src/tools/AgentWorkflow/types.js'

const DEF: WorkflowDef = {
  name: 'dev-flow',
  description: 'Build, review, test',
  steps: [
    { name: 'development', agents: ['coder'] },
    { name: 'code-review', agents: ['reviewer-bugs', 'reviewer-perf'], handbackTo: ['development'] },
    { name: 'done', agents: [] },
  ],
  instructions: 'Goal and house rules.\n\nSecond paragraph.',
}

describe('serializeWorkflow', () => {
  test('round-trips through parseWorkflow', () => {
    const md = serializeWorkflow(DEF)
    const { def, errors } = parseWorkflow(md, 'fallback')
    expect(errors).toEqual([])
    expect(def?.name).toBe('dev-flow')
    expect(def?.description).toBe('Build, review, test')
    expect(def?.steps).toEqual(DEF.steps.map(s => ({ ...s })))
    expect(def?.instructions).toBe(DEF.instructions)
  })

  test('preserves unknown frontmatter keys from rawFrontmatter', () => {
    const original = `---\nname: x\ndescription: d\ncustomKey: keep-me\nsteps:\n  - name: only\n    agents: [a]\n---\nbody\n`
    const { def, rawFrontmatter } = parseWorkflow(original, 'x')
    const md = serializeWorkflow(def!, rawFrontmatter)
    expect(md).toContain('customKey: keep-me')
    // and the round-trip still parses
    expect(parseWorkflow(md, 'x').errors).toEqual([])
  })

  test('omits main when unset, keeps it when set', () => {
    expect(serializeWorkflow(DEF)).not.toContain('main:')
    expect(serializeWorkflow({ ...DEF, main: 'orchestrator-x' })).toContain('main: orchestrator-x')
  })

  test('omits empty agents/handbackTo on steps', () => {
    const md = serializeWorkflow(DEF)
    // terminal step emitted as bare name
    expect(md).toContain('- name: done')
    expect(md).not.toContain('handbackTo: []')
    const doneBlock = md.slice(md.indexOf('- name: done'))
    expect(doneBlock.split('---')[0]).not.toContain('agents')
  })

  test('empty instructions produce no trailing body', () => {
    const md = serializeWorkflow({ ...DEF, instructions: '' })
    expect(md.endsWith('---\n')).toBe(true)
    expect(parseWorkflow(md, 'x').def?.instructions).toBe('')
  })
})

describe('renameStep', () => {
  test('renames and updates handbackTo references', () => {
    const steps = renameStep(DEF.steps, 0, 'build')
    expect(steps[0]?.name).toBe('build')
    expect(steps[1]?.handbackTo).toEqual(['build'])
    // input untouched
    expect(DEF.steps[0]?.name).toBe('development')
    expect(DEF.steps[1]?.handbackTo).toEqual(['development'])
  })

  test('leaves unrelated references alone', () => {
    const steps = renameStep(DEF.steps, 1, 'review')
    expect(steps[1]?.name).toBe('review')
    expect(steps[1]?.handbackTo).toEqual(['development'])
  })
})
