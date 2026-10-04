/**
 * The explainer's pure parts, without a model: the user turn, the tool
 * definition and the answer parser. Plus the guard that keeps the answer out
 * of every permission decision.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join, relative } from 'path'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/factories.js'
import {
  buildExplainTool,
  EXPLAIN_TOOL_NAME,
  parseExplanationInput,
  parseExplanationReply,
  RISK_LEVELS,
} from 'src/permissions/explainer/answer.js'
import type { PermissionExplanation } from 'src/permissions/permissionExplainer.js'
import { buildExplainerPrompt, CONTEXT_BUDGET, conversationContext, formatToolInput } from 'src/permissions/explainer/prompt.js'

const said = (text: string) => createAssistantMessage({ content: text })

describe('buildExplainerPrompt', () => {
  test('the full turn without description or context', () => {
    expect(buildExplainerPrompt({ toolName: 'Bash', toolInput: 'ls' })).toBe(
      'Tool: Bash\nInput:\nls\n\nExplain this command in context.',
    )
  })

  test('the full turn with a description and context', () => {
    expect(
      buildExplainerPrompt({ toolName: 'Bash', toolInput: 'ls', toolDescription: 'List', messages: [said('Looking around.')] }),
    ).toBe('Tool: Bash\nDescription: List\nInput:\nls\n\nRecent conversation context:\nLooking around.\n\nExplain this command in context.')
  })

  test('an empty description adds no line', () => {
    expect(buildExplainerPrompt({ toolName: 'Bash', toolInput: 'ls', toolDescription: '' })).not.toContain('Description:')
  })
})

describe('formatToolInput', () => {
  const cases: Array<[string, unknown, string]> = [
    ['string', 'echo hi', 'echo hi'],
    ['object', { a: 1 }, '{\n  "a": 1\n}'],
    ['undefined', undefined, 'undefined'],
    ['bigint', 5n, '5'],
  ]
  for (const [label, input, shown] of cases) {
    test(label, () => expect(formatToolInput(input)).toBe(shown))
  }
})

describe('conversationContext', () => {
  test('user turns never travel', () => {
    expect(conversationContext([createUserMessage({ content: 'secret user words' }), said('agent words')])).toBe('agent words')
  })

  test('only the last three assistant turns are considered', () => {
    expect(conversationContext(['one', 'two', 'three', 'four'].map(said))).toBe('two\n\nthree\n\nfour')
  })

  test('the budget is spent newest first and the cut is marked', () => {
    expect(conversationContext([said('aaaa'), said('bbb')], 5)).toBe('aa...\n\nbbb')
  })

  test('a turn with no text adds no empty paragraph', () => {
    const toolOnly = createAssistantMessage({ content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] as never })
    expect(conversationContext([said('before'), toolOnly])).toBe('before')
  })

  test('the default budget is a thousand characters', () => {
    expect(CONTEXT_BUDGET).toBe(1000)
  })
})

describe('the tool definition', () => {
  test('its enum and required fields come from the same table the parser reads', () => {
    const tool = buildExplainTool()
    expect(tool.name).toBe(EXPLAIN_TOOL_NAME)
    expect(tool.input_schema.properties.riskLevel.enum).toEqual([...RISK_LEVELS])
    expect([...tool.input_schema.required].sort() as string[]).toEqual(Object.keys(tool.input_schema.properties).sort())
  })
})

describe('parseExplanationInput', () => {
  const good: PermissionExplanation = { riskLevel: 'LOW', explanation: 'e', reasoning: 'r', risk: 'k' }
  const cases: Array<[string, unknown, boolean]> = [
    ['well formed', good, true],
    ['extra fields', { ...good, extra: 1 }, true],
    ['null', null, false],
    ['a string', 'LOW', false],
    ['missing reasoning', { ...good, reasoning: undefined }, false],
    ['a number for risk', { ...good, risk: 1 }, false],
    ['an unknown level', { ...good, riskLevel: 'NONE' }, false],
  ]
  for (const [label, input, usable] of cases) {
    test(`${label} → ${usable ? 'the four fields' : 'null'}`, () => {
      expect(parseExplanationInput(input)).toEqual(usable ? good : null)
    })
  }

  test('a reply is read from its first tool call', () => {
    const first: PermissionExplanation = { ...good, riskLevel: 'HIGH' }
    const reply = { content: [{ type: 'text' }, { type: 'tool_use', input: first }, { type: 'tool_use', input: good }] }
    expect(parseExplanationReply(reply)).toEqual(first)
  })
})

describe('advice never decides', () => {
  // Only the dialogs' explanation panel may reach the explainer; a decision,
  // rule or option module importing it would let model text steer a verdict.
  const root = join(import.meta.dir, '..', '..', '..')
  const allowed = new Set([
    'src/permissions/permissionExplainer.ts',
    'src/permissions/explainer/answer.ts',
    'src/permissions/ui/PermissionExplanation.tsx',
  ])
  const explainerImport = /from ['"]src\/permissions\/(permissionExplainer|explainer\/[a-zA-Z]+)\.js['"]/

  test('no production module outside the panel imports the explainer', () => {
    const offenders: string[] = []
    for (const file of new Bun.Glob('src/**/*.{ts,tsx}').scanSync({ cwd: root })) {
      if (/\.test\.tsx?$/.test(file) || file.includes('__testutils__')) continue
      const path = relative(root, join(root, file))
      if (allowed.has(path)) continue
      if (explainerImport.test(readFileSync(join(root, file), 'utf8'))) offenders.push(path)
    }
    expect(offenders).toEqual([])
  })
})
