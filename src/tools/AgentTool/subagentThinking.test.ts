import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import type { ThinkingConfig } from 'src/agent/context/thinking.js'
import { subagentEffort, subagentThinkingConfig } from 'src/tools/AgentTool/subagentThinking.js'

const ADAPTIVE: ThinkingConfig = { type: 'adaptive' }
const OFF: ThinkingConfig = { type: 'disabled' }
const KILLSWITCH = 'CLAUDIN_DISABLE_SUBAGENT_THINKING'
const CAP = 'CLAUDIN_SUBAGENT_EFFORT_CAP'
const saved = process.env[KILLSWITCH]
const savedCap = process.env[CAP]

afterEach(() => {
  if (saved === undefined) delete process.env[KILLSWITCH]
  else process.env[KILLSWITCH] = saved
  if (savedCap === undefined) delete process.env[CAP]
  else process.env[CAP] = savedCap
})

describe('subagentThinkingConfig', () => {
  // Thinking "off" sent no thinking field, and Opus 5.5 thought anyway at the
  // server's default, with its progress updates omitted.
  test('a sub-agent on a model with effort inherits the parent config', () => {
    expect(subagentThinkingConfig(ADAPTIVE, { useExactTools: false, modelSupportsEffort: true })).toEqual(ADAPTIVE)
  })

  test('a model without effort keeps thinking off', () => {
    expect(subagentThinkingConfig(ADAPTIVE, { useExactTools: false, modelSupportsEffort: false })).toEqual(OFF)
  })

  // The request must match the parent's prefix to read its cache.
  test('a fork takes the parent config as it is, whatever the model', () => {
    const budget: ThinkingConfig = { type: 'enabled', budgetTokens: 8192 }
    expect(subagentThinkingConfig(budget, { useExactTools: true, modelSupportsEffort: false })).toBe(budget)
  })

  test('thinking the session turned off stays off', () => {
    expect(subagentThinkingConfig(OFF, { useExactTools: false, modelSupportsEffort: true })).toEqual(OFF)
  })

  test('CLAUDIN_DISABLE_SUBAGENT_THINKING=1 turns it back off, except for a fork', () => {
    process.env[KILLSWITCH] = '1'
    expect(subagentThinkingConfig(ADAPTIVE, { useExactTools: false, modelSupportsEffort: true })).toEqual(OFF)
    expect(subagentThinkingConfig(ADAPTIVE, { useExactTools: true, modelSupportsEffort: true })).toEqual(ADAPTIVE)
  })
})

describe('subagentEffort (CLAUDIN_SUBAGENT_EFFORT_CAP)', () => {
  const fresh = { useExactTools: false }

  test('unset: the parent effort, whatever it is', () => {
    delete process.env[CAP]
    expect(subagentEffort('xhigh', fresh)).toBe('xhigh')
    expect(subagentEffort(undefined, fresh)).toBeUndefined()
  })

  test('lowers a named level above the cap, leaves one at or below it', () => {
    process.env[CAP] = 'high'
    expect(subagentEffort('xhigh', fresh)).toBe('high')
    expect(subagentEffort('max', fresh)).toBe('high')
    expect(subagentEffort('high', fresh)).toBe('high')
    expect(subagentEffort('medium', fresh)).toBe('medium')
  })

  test('a fork keeps the parent effort; adaptive, numeric and unset pass through', () => {
    process.env[CAP] = 'medium'
    expect(subagentEffort('xhigh', { useExactTools: true })).toBe('xhigh')
    expect(subagentEffort('adaptive', fresh)).toBe('adaptive')
    expect(subagentEffort(80, fresh)).toBe(80)
    expect(subagentEffort(undefined, fresh)).toBeUndefined()
  })

  test('a value that is not a level is ignored', () => {
    process.env[CAP] = 'turbo'
    expect(subagentEffort('xhigh', fresh)).toBe('xhigh')
  })

  // runAgent builds the agent's app state inside a closure no unit test
  // drives; the wiring is pinned on the source.
  test('runAgent applies it when the agent definition sets no effort', () => {
    const source = readFileSync(`${import.meta.dir}/runAgent.ts`, 'utf8')
    expect(source).toContain(
      ': subagentEffort(state.effortValue, { useExactTools: useExactTools === true })',
    )
  })
})
