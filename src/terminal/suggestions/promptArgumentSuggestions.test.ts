import { describe, expect, mock, test } from 'bun:test'

import type { Command, PromptArgumentValues } from 'src/shared/types/command.js'
import type { SuggestionItem } from 'src/terminal/prompt-input/PromptInputFooterSuggestions.js'
import {
  acceptPromptArgumentSuggestion,
  fetchPromptArgumentSuggestions,
  keepPromptArgumentSuggestions,
  planPromptArgumentCompletion,
} from 'src/terminal/suggestions/promptArgumentSuggestions.js'

const SPECS = [
  { name: 'name', required: true, description: 'Who to greet' },
  { name: 'greeting', required: false },
]

function mcpPrompt(extra: Partial<Command> = {}): Command {
  return {
    type: 'prompt',
    name: 'mcp__srv__greet',
    description: 'Greet',
    progressMessage: 'running',
    contentLength: 0,
    source: 'mcp',
    isMcp: true,
    argNames: SPECS.map(s => s.name),
    argSpecs: SPECS,
    userFacingName: () => 'srv:greet (MCP)',
    getPromptForCommand: async () => [],
    ...extra,
  } as Command
}

const values: PromptArgumentValues = async () => ['Alice']
const GREET = mcpPrompt({ argumentValues: values } as Partial<Command>)
const PLAIN = {
  type: 'prompt',
  name: 'review',
  description: 'Review',
  progressMessage: 'running',
  contentLength: 0,
  source: 'builtin',
  argNames: ['repo'],
  getPromptForCommand: async () => [],
} as Command
const LOCAL = {
  type: 'local',
  name: 'help',
  description: 'Help',
  supportsNonInteractive: false,
  load: async () => ({ call: async () => ({ type: 'skip' as const }) }),
} as Command

function plan(value: string, commands: Command[] = [LOCAL, PLAIN, GREET], cursor = value.length) {
  return planPromptArgumentCompletion(value, cursor, commands)
}

describe('planPromptArgumentCompletion', () => {
  test('the prompt name and a space start the first argument, with the hint', () => {
    expect(plan('/mcp__srv__greet ')).toEqual({
      complete: values,
      position: { index: 0, name: 'name', partial: '', start: 17, filled: {} },
      hint: '<name> [greeting] · Who to greet',
    })
  })

  test('the user-facing name Tab inserts, (MCP) word included, works too', () => {
    expect(plan('/srv:greet (MCP) Al')).toEqual({
      complete: values,
      position: { index: 0, name: 'name', partial: 'Al', start: 17, filled: {} },
      hint: undefined,
    })
    expect(plan('/srv:greet (MCP) "Mary Ann" ')?.position).toMatchObject({
      index: 1,
      start: 28,
      filled: { name: 'Mary Ann' },
    })
    expect(plan('/srv:greet (MCP) "Mary Ann" ')?.hint).toBe('[greeting]')
  })

  test('a prompt without values still gets the hint', () => {
    expect(plan('/mcp__srv__greet ', [mcpPrompt()])).toEqual({
      position: { index: 0, name: 'name', partial: '', start: 17, filled: {} },
      hint: '<name> [greeting] · Who to greet',
    })
  })

  test('anything else is left to the other sources', () => {
    expect(plan('hello there')).toBeNull()
    expect(plan('/mcp__srv__greet')).toBeNull()
    expect(plan('/srv:greet (MCP)')).toBeNull()
    expect(plan('/review ')).toBeNull()
    expect(plan('/help ')).toBeNull()
    expect(plan('/nope ')).toBeNull()
    expect(plan('/mcp__srv__greet Al', undefined, 18)).toBeNull()
    expect(plan('/mcp__srv__greet a b ')).toBeNull()
    expect(plan('/mcp__srv__greet @src/fi')).toBeNull()
  })
})

describe('fetchPromptArgumentSuggestions', () => {
  test('values become rows that remember where their argument starts', async () => {
    const complete = mock<PromptArgumentValues>(async () => ['Alice', 'Mary Ann'])
    const p = plan('/mcp__srv__greet x ', [mcpPrompt({ argumentValues: complete } as Partial<Command>)])!
    expect(await fetchPromptArgumentSuggestions(p)).toEqual([
      { id: 'prompt-argument-Alice', displayText: 'Alice', metadata: { argumentStart: 19 } },
      { id: 'prompt-argument-Mary Ann', displayText: 'Mary Ann', metadata: { argumentStart: 19 } },
    ])
    expect(complete.mock.calls).toEqual([['greeting', '', { name: 'x' }]])
  })

  test('no completer or a rejecting one gives no rows', async () => {
    expect(await fetchPromptArgumentSuggestions(plan('/mcp__srv__greet ', [mcpPrompt()])!)).toEqual([])
    const failing = mcpPrompt({
      argumentValues: async () => {
        throw new Error('boom')
      },
    } as Partial<Command>)
    expect(await fetchPromptArgumentSuggestions(plan('/mcp__srv__greet ', [failing])!)).toEqual([])
  })
})

describe('keepPromptArgumentSuggestions', () => {
  const row = (start: number): SuggestionItem => ({
    id: `prompt-argument-${start}`,
    displayText: 'v',
    metadata: { argumentStart: start },
  })

  test('rows for the same argument stay while the next fetch runs', () => {
    const shown = [row(17)]
    expect(keepPromptArgumentSuggestions(shown, plan('/mcp__srv__greet Al')!)).toBe(shown)
  })

  test('rows for another argument go', () => {
    expect(keepPromptArgumentSuggestions([row(17)], plan('/mcp__srv__greet Al ')!)).toEqual([])
    expect(keepPromptArgumentSuggestions([{ id: 'x', displayText: 'x' }], plan('/mcp__srv__greet ')!)).toEqual([])
  })
})

describe('acceptPromptArgumentSuggestion', () => {
  const item = (start: unknown, displayText = 'Mary Ann'): SuggestionItem => ({
    id: 'prompt-argument-x',
    displayText,
    metadata: { argumentStart: start },
  })

  test('rewrites the argument, quoted when it has spaces', () => {
    expect(acceptPromptArgumentSuggestion(item(17), '/mcp__srv__greet Ma', 19)).toEqual({
      text: '/mcp__srv__greet "Mary Ann" ',
      cursor: 28,
    })
  })

  test('a row that no longer fits the line is not applied', () => {
    expect(acceptPromptArgumentSuggestion(item('17'), '/mcp__srv__greet Ma', 19)).toBeNull()
    expect(acceptPromptArgumentSuggestion({ id: 'x', displayText: 'x' }, '/x a', 4)).toBeNull()
    expect(acceptPromptArgumentSuggestion(item(30), '/mcp__srv__greet Ma', 19)).toBeNull()
    expect(acceptPromptArgumentSuggestion(item(17), '/mcp__srv__greet Ma', 40)).toBeNull()
  })
})
