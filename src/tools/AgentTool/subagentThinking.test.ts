import { afterEach, describe, expect, test } from 'bun:test'
import type { ThinkingConfig } from 'src/agent/context/thinking.js'
import { subagentThinkingConfig } from 'src/tools/AgentTool/subagentThinking.js'

const ADAPTIVE: ThinkingConfig = { type: 'adaptive' }
const OFF: ThinkingConfig = { type: 'disabled' }
const KILLSWITCH = 'CLAUDIN_DISABLE_SUBAGENT_THINKING'
const saved = process.env[KILLSWITCH]

afterEach(() => {
  if (saved === undefined) delete process.env[KILLSWITCH]
  else process.env[KILLSWITCH] = saved
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
