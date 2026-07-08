import { describe, expect, test } from 'bun:test'
import {
  buildMainContext,
  buildWorkerPrompt,
  MAX_WORKER_OUTPUT_CHARS,
} from './promptKit.js'
import type { RunState, WorkflowDef } from './types.js'

const DEF: WorkflowDef = {
  name: 'dev-flow',
  description: 'demo',
  steps: [
    { name: 'development', agents: ['coder'] },
    { name: 'code-review', agents: ['reviewer'], handbackTo: ['development'] },
    { name: 'done', agents: [] },
  ],
  instructions: 'Follow the house style.',
}

describe('buildWorkerPrompt', () => {
  test('includes workflow name, task, phase and artifact', () => {
    const p = buildWorkerPrompt(DEF, 'Add a button', 'prior work', DEF.steps[1])
    expect(p).toContain('dev-flow')
    expect(p).toContain('code-review')
    expect(p).toContain('Add a button')
    expect(p).toContain('prior work')
    expect(p).toContain('Follow the house style.')
  })

  test('omits the artifact section when empty', () => {
    const p = buildWorkerPrompt(DEF, 'task', '', DEF.steps[0])
    expect(p).not.toContain('accumulated artifact')
  })
})

describe('buildMainContext', () => {
  function stateWithHistory(): RunState {
    const now = Date.now()
    return {
      runId: 'r1',
      workflow: 'dev-flow',
      description: '',
      task: 'Add a button',
      currentStep: 'code-review',
      status: 'running',
      artifact: 'synthesized so far',
      history: [
        {
          step: 'development',
          stepIndex: 0,
          agents: [
            { label: 'coder', model: 'Opus 4.8', tokens: 100, tools: 2, ms: 500, output: 'wrote code', failed: false },
          ],
          synthesis: 'code written',
          decision: { decision: 'advance', notes: 'looks good' },
          at: now,
        },
        {
          step: 'code-review',
          stepIndex: 1,
          agents: [
            { label: 'reviewer', model: 'Opus 4.8', tokens: 80, tools: 1, ms: 300, output: 'found a bug', failed: false },
          ],
          synthesis: '',
          decision: null,
          at: now,
        },
      ],
      transitions: 1,
      refineCounts: {},
      totalTokens: 180,
      agentsInPhase: 0,
      agentsDone: 0,
      startedAt: now,
      updatedAt: now,
    }
  }

  test('renders phases with status, history and handback targets', () => {
    const ctx = buildMainContext(stateWithHistory(), DEF)
    expect(ctx).toContain('development [done]')
    expect(ctx).toContain('code-review [current]')
    expect(ctx).toContain('done [pending]')
    expect(ctx).toContain('found a bug')
    expect(ctx).toContain('hand back to: development')
    expect(ctx).toContain('StructuredOutput')
  })

  test('caps large worker outputs', () => {
    const s = stateWithHistory()
    s.history[1].agents[0].output = 'x'.repeat(MAX_WORKER_OUTPUT_CHARS + 500)
    const ctx = buildMainContext(s, DEF)
    expect(ctx).toContain('truncated')
    expect(ctx).not.toContain('x'.repeat(MAX_WORKER_OUTPUT_CHARS + 500))
  })

  test('states when there are no handback targets', () => {
    const s = stateWithHistory()
    s.currentStep = 'development'
    const ctx = buildMainContext(s, DEF)
    expect(ctx).toContain('no handback targets')
  })
})
