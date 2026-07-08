import { describe, expect, test } from 'bun:test'
import { applyDecision } from './transitionReducer.js'
import {
  MAX_REFINES_PER_STEP,
  MAX_TRANSITIONS,
  type RunState,
  type StepDecision,
  type WorkflowDef,
} from './types.js'

const DEF: WorkflowDef = {
  name: 'dev-flow',
  description: '',
  steps: [
    { name: 'development', agents: ['coder'] },
    { name: 'code-review', agents: ['reviewer'], handbackTo: ['development'] },
    { name: 'test', agents: ['tester'], handbackTo: ['development'] },
    { name: 'done', agents: [] },
  ],
  instructions: '',
}

function stateAt(step: string, overrides: Partial<RunState> = {}): RunState {
  const now = Date.now()
  return {
    runId: 'r1',
    workflow: 'dev-flow',
    description: '',
    task: 't',
    currentStep: step,
    status: 'running',
    artifact: '',
    history: [],
    transitions: 0,
    refineCounts: {},
    totalTokens: 0,
    agentsInPhase: 0,
    agentsDone: 0,
    startedAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const dec = (d: StepDecision['decision'], target?: string): StepDecision => ({
  decision: d,
  target,
  notes: '',
})

describe('applyDecision', () => {
  test('advance moves to the next phase', () => {
    const next = applyDecision(stateAt('development'), dec('advance'), DEF)
    expect(next.currentStep).toBe('code-review')
    expect(next.status).toBe('running')
    expect(next.transitions).toBe(1)
  })

  test('advance into a terminal phase completes the run', () => {
    const next = applyDecision(stateAt('test'), dec('advance'), DEF)
    expect(next.currentStep).toBe('done')
    expect(next.status).toBe('done')
  })

  test('advance past the last phase completes the run without blanking the phase', () => {
    const next = applyDecision(stateAt('done'), dec('advance'), DEF)
    expect(next.status).toBe('done')
    // steps[idx+1] is undefined here — currentStep must be preserved, not cleared.
    expect(next.currentStep).toBe('done')
  })

  test('refine stays on the same phase and counts', () => {
    const next = applyDecision(stateAt('code-review'), dec('refine'), DEF)
    expect(next.currentStep).toBe('code-review')
    expect(next.refineCounts['code-review']).toBe(1)
    expect(next.status).toBe('running')
  })

  test('refine past the per-phase cap stalls', () => {
    const next = applyDecision(
      stateAt('code-review', { refineCounts: { 'code-review': MAX_REFINES_PER_STEP } }),
      dec('refine'),
      DEF,
    )
    expect(next.status).toBe('stalled')
  })

  test('handback to an allowed target returns to that phase', () => {
    const next = applyDecision(stateAt('code-review'), dec('handback', 'development'), DEF)
    expect(next.currentStep).toBe('development')
    expect(next.refineCounts['development']).toBe(1)
    expect(next.status).toBe('running')
  })

  test('handback to a disallowed target stalls', () => {
    const next = applyDecision(stateAt('code-review'), dec('handback', 'test'), DEF)
    expect(next.status).toBe('stalled')
  })

  test('handback with no target stalls', () => {
    const next = applyDecision(stateAt('code-review'), dec('handback'), DEF)
    expect(next.status).toBe('stalled')
  })

  test('handback shares the target phase refine counter and stalls at the cap', () => {
    // The target already sits at the cap from prior refines/handbacks.
    const next = applyDecision(
      stateAt('code-review', { refineCounts: { development: MAX_REFINES_PER_STEP } }),
      dec('handback', 'development'),
      DEF,
    )
    expect(next.status).toBe('stalled')
    // Did not move back into the over-budget phase.
    expect(next.currentStep).toBe('code-review')
  })

  test('advance into a terminal phase wins even at the global transition cap', () => {
    const next = applyDecision(
      stateAt('test', { transitions: MAX_TRANSITIONS - 1 }),
      dec('advance'),
      DEF,
    )
    expect(next.transitions).toBe(MAX_TRANSITIONS)
    expect(next.currentStep).toBe('done')
    expect(next.status).toBe('done')
  })

  test('hitting the global transition cap stalls', () => {
    const next = applyDecision(
      stateAt('development', { transitions: MAX_TRANSITIONS - 1 }),
      dec('advance'),
      DEF,
    )
    expect(next.transitions).toBe(MAX_TRANSITIONS)
    expect(next.status).toBe('stalled')
  })

  test('does not mutate the input state', () => {
    const s = stateAt('development')
    const before = JSON.stringify(s)
    applyDecision(s, dec('advance'), DEF)
    expect(JSON.stringify(s)).toBe(before)
  })
})
