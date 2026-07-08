import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const DIR = mkdtempSync(join(tmpdir(), 'wf-defs-'))
mock.module('./paths.js', () => ({
  getWorkflowsDir: () => DIR,
  getWorkflowRunsDir: () => join(DIR, '.runs'),
}))

const {
  parseWorkflow,
  validateWorkflowStructure,
  validateWorkflowAgents,
  loadWorkflowDefs,
  loadWorkflowDef,
} = await import('./loadWorkflows.js')

afterAll(async () => {
  mock.restore()
  await rm(DIR, { recursive: true, force: true })
})

const GOOD = `---
name: dev-flow
description: demo flow
steps:
  - name: development
    agents: [coder]
  - name: code-review
    agents: [reviewer-bugs, reviewer-perf]
    handbackTo: [development]
  - name: done
---
Follow the house style.
`

describe('parseWorkflow', () => {
  test('parses a valid workflow with body as instructions', () => {
    const { def, errors } = parseWorkflow(GOOD, 'fallback')
    expect(errors).toHaveLength(0)
    expect(def!.name).toBe('dev-flow')
    expect(def!.steps).toHaveLength(3)
    expect(def!.steps[1].agents).toEqual(['reviewer-bugs', 'reviewer-perf'])
    expect(def!.instructions).toContain('house style')
  })

  test('falls back to the filename when name is absent', () => {
    const { def } = parseWorkflow('---\nsteps:\n  - name: a\n    agents: [x]\n---\n', 'my-file')
    expect(def!.name).toBe('my-file')
  })

  test('reports zod errors when steps are missing', () => {
    const { def, errors } = parseWorkflow('---\nname: broken\n---\n', 'broken')
    expect(def).toBeUndefined()
    // Pin that the reported issue is about the missing `steps`, not some other field.
    expect(errors.join()).toContain('steps')
  })
})

describe('validateWorkflowStructure', () => {
  test('accepts a well-formed workflow', () => {
    const { def } = parseWorkflow(GOOD, 'x')
    expect(validateWorkflowStructure(def!)).toHaveLength(0)
  })

  test('flags a non-final phase with no agents', () => {
    const { def } = parseWorkflow(
      '---\nname: w\nsteps:\n  - name: empty\n    agents: []\n  - name: real\n    agents: [a]\n---\n',
      'w',
    )
    expect(validateWorkflowStructure(def!).join()).toContain('no agents')
  })

  test('flags handback to a later or unknown phase', () => {
    const { def } = parseWorkflow(
      '---\nname: w\nsteps:\n  - name: a\n    agents: [x]\n    handbackTo: [b]\n  - name: b\n    agents: [y]\n---\n',
      'w',
    )
    expect(validateWorkflowStructure(def!).join()).toContain('earlier phase')
  })

  test('flags duplicate phase names', () => {
    const { def } = parseWorkflow(
      '---\nname: w\nsteps:\n  - name: a\n    agents: [x]\n  - name: a\n    agents: [y]\n---\n',
      'w',
    )
    expect(validateWorkflowStructure(def!).join()).toContain('Duplicate')
  })
})

describe('validateWorkflowAgents', () => {
  test('flags unknown worker and main agents', () => {
    const { def } = parseWorkflow(
      '---\nname: w\nmain: nope\nsteps:\n  - name: a\n    agents: [ghost]\n---\n',
      'w',
    )
    const errors = validateWorkflowAgents(def!, new Set(['coder']))
    expect(errors.join()).toContain('unknown agent "ghost"')
    expect(errors.join()).toContain('Unknown main agent "nope"')
  })

  test('accepts known agents and the built-in orchestrator', () => {
    const { def } = parseWorkflow(
      '---\nname: w\nsteps:\n  - name: a\n    agents: [coder]\n---\n',
      'w',
    )
    expect(validateWorkflowAgents(def!, new Set(['coder']))).toHaveLength(0)
  })
})

describe('loadWorkflowDefs / loadWorkflowDef', () => {
  test('discovers project .md files and keys structural errors by file', async () => {
    writeFileSync(join(DIR, 'dev-flow.md'), GOOD)
    writeFileSync(
      join(DIR, 'broken.md'),
      '---\nname: broken\nsteps:\n  - name: a\n    agents: []\n  - name: b\n    agents: [y]\n---\n',
    )
    const { defs, errorsByFile } = await loadWorkflowDefs()
    expect(defs.map(d => d.name).sort()).toEqual(['broken', 'dev-flow'])
    expect(errorsByFile['broken.md'].join()).toContain('no agents')
    expect(errorsByFile['dev-flow.md']).toBeUndefined()

    const one = await loadWorkflowDef('dev-flow')
    expect(one!.name).toBe('dev-flow')
    expect(await loadWorkflowDef('missing')).toBeNull()
  })

  test('tags each def with its source filename', async () => {
    writeFileSync(join(DIR, 'dev-flow.md'), GOOD)
    const { defs } = await loadWorkflowDefs()
    expect(defs.find(d => d.name === 'dev-flow')!.sourceFile).toBe('dev-flow.md')
    expect((await loadWorkflowDef('dev-flow'))!.sourceFile).toBe('dev-flow.md')
  })

  test('skips non-.md files and excludes unparseable defs while keying their errors', async () => {
    writeFileSync(join(DIR, 'dev-flow.md'), GOOD)
    writeFileSync(join(DIR, 'notes.txt'), 'not a workflow')
    // Missing `steps` → zod parse failure (distinct from a structural error).
    writeFileSync(join(DIR, 'noparse.md'), '---\nname: noparse\n---\n')

    const { defs, errorsByFile } = await loadWorkflowDefs()
    expect(defs.map(d => d.name)).not.toContain('noparse')
    expect(defs.map(d => d.name)).toContain('dev-flow')
    expect(errorsByFile['noparse.md'].length).toBeGreaterThan(0)
    expect(errorsByFile['notes.txt']).toBeUndefined()

    // An unparseable single load resolves to null rather than throwing.
    expect(await loadWorkflowDef('noparse')).toBeNull()
  })
})
