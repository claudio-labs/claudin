import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import type { ThinkingConfig } from 'src/agent/context/thinking.js'
import { subagentEffort, subagentThinkingConfig } from 'src/tools/AgentTool/subagentThinking.js'

const ADAPTIVE: ThinkingConfig = { type: 'adaptive' }
const OFF: ThinkingConfig = { type: 'disabled' }
const KILLSWITCH = 'CLAUDIN_DISABLE_SUBAGENT_THINKING'
const STEP_DOWN = 'CLAUDIN_SUBAGENT_EFFORT_STEP_DOWN'
const saved = process.env[KILLSWITCH]
const savedStepDown = process.env[STEP_DOWN]

afterEach(() => {
  if (saved === undefined) delete process.env[KILLSWITCH]
  else process.env[KILLSWITCH] = saved
  if (savedStepDown === undefined) delete process.env[STEP_DOWN]
  else process.env[STEP_DOWN] = savedStepDown
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

describe('subagentEffort — one level below a raised parent', () => {
  // Opus 5.5 defaults to medium, Fable 5.1 to high.
  const opus55 = { useExactTools: false, parentDefault: 'medium' as const }
  const fable = { useExactTools: false, parentDefault: 'high' as const }

  test('above the default: one level down', () => {
    expect(subagentEffort('max', opus55)).toBe('xhigh')
    expect(subagentEffort('xhigh', opus55)).toBe('high')
    expect(subagentEffort('high', opus55)).toBe('medium')
    expect(subagentEffort('max', fable)).toBe('xhigh')
    expect(subagentEffort('xhigh', fable)).toBe('high')
  })

  test('at or below the default: the parent effort', () => {
    expect(subagentEffort('medium', opus55)).toBe('medium')
    expect(subagentEffort('low', opus55)).toBe('low')
    expect(subagentEffort('high', fable)).toBe('high')
    expect(subagentEffort('medium', fable)).toBe('medium')
  })

  test('CLAUDIN_SUBAGENT_EFFORT_STEP_DOWN=0 (or off/false) restores plain inheritance', () => {
    for (const v of ['0', 'off', 'false']) {
      process.env[STEP_DOWN] = v
      expect(subagentEffort('max', opus55)).toBe('max')
    }
  })

  test('a fork keeps the parent effort; adaptive, numeric, unset and a default that is no level pass through', () => {
    expect(subagentEffort('xhigh', { ...opus55, useExactTools: true })).toBe('xhigh')
    expect(subagentEffort('adaptive', opus55)).toBe('adaptive')
    expect(subagentEffort(80, opus55)).toBe(80)
    expect(subagentEffort(undefined, opus55)).toBeUndefined()
    expect(subagentEffort('max', { useExactTools: false, parentDefault: undefined })).toBe('max')
  })

  // runAgent builds the agent's app state inside a closure no unit test
  // drives; the wiring is pinned on the source.
  test("runAgent applies it with the parent model's default when the agent definition sets no effort", () => {
    const source = readFileSync(`${import.meta.dir}/runAgent.ts`, 'utf8')
    expect(source).toContain(
      ': subagentEffort(state.effortValue, {\n            useExactTools: useExactTools === true,\n            parentDefault: getDefaultEffortForModel(toolUseContext.options.mainLoopModel),\n          })',
    )
  })
})
