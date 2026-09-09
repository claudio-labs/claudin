import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import type { Output } from 'src/tools/FileReadTool/schemas.js'
import {
  _resetReadReminderStateForTesting,
  _setMitigationModelResolverForTesting,
  CYBER_RISK_MITIGATION_REMINDER,
  isMitigationExemptModel,
  mapReadResultToToolResultBlock,
  maybeFlagReadReminder,
} from 'src/tools/FileReadTool/resultContent.js'

// The mitigation reminder is gated on the main-loop model and on two env
// flags; the model is pinned through the module's own resolver seam (no
// module mock, and immune to the model/state mocks other files leak) and
// every env key touched here is put back, since both are process-global and
// read per call.
const ENV_KEYS = ['CLAUDIN_DISABLE_TOOL_REMINDERS', 'CLAUDIN_DISABLE_READ_REMINDER_ONCE'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

function pinModel(shortName: string): void {
  _setMitigationModelResolverForTesting(() => shortName)
}

function textResult(content: string): Output {
  return {
    type: 'text',
    file: {
      filePath: '/tmp/x.ts',
      content,
      numLines: content === '' ? 0 : content.split('\n').length,
      startLine: 1,
      totalLines: content === '' ? 0 : content.split('\n').length,
    },
  }
}

function render(data: Output): string {
  const block = mapReadResultToToolResultBlock(data, 'toolu_test')
  if (typeof block.content !== 'string') {
    throw new Error('expected string tool_result content')
  }
  return block.content
}

function reminderCount(text: string): number {
  return text.split(CYBER_RISK_MITIGATION_REMINDER).length - 1
}

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
})

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  _setMitigationModelResolverForTesting(undefined)
})

beforeEach(() => {
  delete process.env.CLAUDIN_DISABLE_TOOL_REMINDERS
  delete process.env.CLAUDIN_DISABLE_READ_REMINDER_ONCE
  _resetReadReminderStateForTesting()
})

afterEach(() => {
  _setMitigationModelResolverForTesting(undefined)
})

describe('isMitigationExemptModel', () => {
  test('the two upstream exemptions plus opus-5 and fable-5-1', () => {
    for (const m of ['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-5', 'claude-fable-5-1']) {
      expect(isMitigationExemptModel(m)).toBe(true)
    }
    expect(isMitigationExemptModel('claude-sonnet-5')).toBe(false)
    expect(isMitigationExemptModel('claude-fable-5')).toBe(false)
  })
})

describe('mitigation reminder — model gate', () => {
  test('an exempt model never carries the reminder', () => {
    pinModel('claude-opus-5')
    expect(reminderCount(render(textResult('a\nb')))).toBe(0)
    pinModel('claude-fable-5-1')
    expect(reminderCount(render(textResult('a\nb')))).toBe(0)
  })

  test('a non-exempt model carries it on every read under CLAUDIN_DISABLE_READ_REMINDER_ONCE', () => {
    pinModel('claude-sonnet-5')
    process.env.CLAUDIN_DISABLE_READ_REMINDER_ONCE = '1'
    const one = textResult('a')
    const two = textResult('b')
    maybeFlagReadReminder(one, { agentId: undefined })
    maybeFlagReadReminder(two, { agentId: undefined })
    expect(reminderCount(render(one))).toBe(1)
    expect(reminderCount(render(two))).toBe(1)
  })

  test('CLAUDIN_DISABLE_TOOL_REMINDERS wins over everything', () => {
    pinModel('claude-sonnet-5')
    process.env.CLAUDIN_DISABLE_TOOL_REMINDERS = '1'
    const one = textResult('a')
    maybeFlagReadReminder(one, { agentId: undefined })
    expect(reminderCount(render(one))).toBe(0)
  })
})

describe('mitigation reminder — once per agent (default)', () => {
  beforeEach(() => {
    pinModel('claude-sonnet-5')
  })

  test('the first text read of an agent carries it, the second does not', () => {
    const one = textResult('a\nb')
    const two = textResult('c')
    maybeFlagReadReminder(one, { agentId: undefined })
    maybeFlagReadReminder(two, { agentId: undefined })
    expect(reminderCount(render(one))).toBe(1)
    expect(reminderCount(render(two))).toBe(0)
  })

  test('a different agent key gets its own first reminder', () => {
    const main = textResult('a')
    const fork = textResult('b')
    const forkAgain = textResult('c')
    maybeFlagReadReminder(main, { agentId: undefined })
    maybeFlagReadReminder(fork, { agentId: 'agent-1' as never })
    maybeFlagReadReminder(forkAgain, { agentId: 'agent-1' as never })
    expect(reminderCount(render(main))).toBe(1)
    expect(reminderCount(render(fork))).toBe(1)
    expect(reminderCount(render(forkAgain))).toBe(0)
  })

  test('an empty file does not consume the slot — it never carries the reminder', () => {
    const empty = textResult('')
    const first = textResult('a')
    maybeFlagReadReminder(empty, { agentId: undefined })
    maybeFlagReadReminder(first, { agentId: undefined })
    expect(reminderCount(render(empty))).toBe(0)
    expect(reminderCount(render(first))).toBe(1)
  })

  test('a result that was never flagged carries nothing (mapper without call())', () => {
    // The flag is what the mapper reads; a result that bypassed call() —
    // e.g. a replayed cache hit built elsewhere — stays clean rather than
    // re-emitting the reminder.
    expect(reminderCount(render(textResult('a')))).toBe(0)
  })

  test('an exempt model stays exempt', () => {
    pinModel('claude-opus-5')
    const one = textResult('a')
    maybeFlagReadReminder(one, { agentId: undefined })
    expect(reminderCount(render(one))).toBe(0)
  })
})
