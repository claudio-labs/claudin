import { afterEach, describe, expect, test } from 'bun:test'
import type { ModelFamily } from 'src/agent/prompts/familyAddendums/index.js'
import { _setToolPromptFamilyForTesting } from 'src/agent/prompts/toolPromptTier.js'
import { zodToJsonSchema } from 'src/shared/data/zodToJsonSchema.js'
// bashSchemas.ts reaches BashTool.tsx through its imports, and buildTool reads
// the tool's inputSchema getter. Loaded first, bashSchemas would still be
// initializing at that read (a TDZ); loading the tool first orders the cycle.
import 'src/tools/BashTool/BashTool.js'
import { inputSchema, isBackgroundTasksDisabled } from 'src/tools/BashTool/bashSchemas.js'
import { getMaxTimeoutMs, getSimplePrompt } from 'src/tools/BashTool/prompt.js'

type JsonRecord = Record<string, unknown>

const schema = zodToJsonSchema(inputSchema()) as JsonRecord
const properties = schema.properties as Record<string, JsonRecord>

function descriptionOf(field: string): string {
  return String(properties[field]!.description)
}

// The parameter texts say only what the tool description does not (see the
// note above fullInputSchema): the unit, the maximum, the rule for
// `description` with two examples, and that Read opens a background run's output.
describe('Bash input schema — the texts that ship', () => {
  afterEach(() => _setToolPromptFamilyForTesting(null))

  test('every model-facing parameter stays, and no internal one reaches the model', () => {
    const expected = isBackgroundTasksDisabled
      ? ['command', 'timeout', 'description']
      : ['command', 'timeout', 'description', 'run_in_background']
    expect(Object.keys(properties)).toEqual(expected)
  })

  test('`description` keeps its rule and two examples, not six', () => {
    const description = descriptionOf('description')
    expect(description).toStartWith('Clear, concise description of what this command does in active voice.')
    expect(description).toContain('Never use words like "complex" or "risk" in the description')
    expect(description).toContain('git status → "Show working tree status"')
    expect(description).toContain(`curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"`)
    expect(description.split('→').length - 1).toBe(2)
    for (const cut of ['ls →', 'npm install →', 'find . -name', 'git reset --hard']) {
      expect({ cut, present: description.includes(cut) }).toEqual({ cut, present: false })
    }
  })

  test('`timeout` keeps the unit and the maximum; `run_in_background` keeps that Read opens the output', () => {
    expect(descriptionOf('timeout')).toBe(`Timeout in ms (max ${getMaxTimeoutMs()})`)
    if (!isBackgroundTasksDisabled) {
      expect(descriptionOf('run_in_background')).toBe('Run it in the background; Read its output file later.')
    }
  })

  // What each family receives: the compact description (Anthropic) or the
  // full one, with the one schema.
  for (const family of ['anthropic', 'default'] as const satisfies readonly ModelFamily[]) {
    test(`${family}: the description and the schema still name every capability`, () => {
      _setToolPromptFamilyForTesting(family)
      const text = `${getSimplePrompt()}\n${JSON.stringify(schema)}`
      const markers = ['timeout', /absolute path/i, 'RunTests', 'Typecheck', 'Build', 'Git', 'Read', 'Grep', 'Glob']
      const missing = markers.filter(m => (typeof m === 'string' ? !text.includes(m) : !m.test(text)))
      expect(missing.map(String)).toEqual([])
    })
  }
})
