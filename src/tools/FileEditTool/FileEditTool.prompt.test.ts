import { describe, expect, it } from 'bun:test'
import { zodToJsonSchema } from 'src/shared/data/zodToJsonSchema.js'
import {
  buildCompactEditToolDescription,
  buildEditToolDescription,
} from 'src/tools/FileEditTool/prompt.js'
import { inputSchema } from 'src/tools/FileEditTool/types.js'

type EditPrompt = typeof import('src/tools/FileEditTool/prompt.js')

const CREDIT_FLAG = 'CLAUDIN_BASH_READ_CREDIT'

/**
 * The flag is read once at module load, so each arm gets its own instance of
 * the module, loaded with the variable set the way that arm needs it.
 */
async function loadEditPrompt(credit: boolean): Promise<EditPrompt> {
  const prior = process.env[CREDIT_FLAG]
  if (credit) process.env[CREDIT_FLAG] = '1'
  else delete process.env[CREDIT_FLAG]
  try {
    return await import(
      `src/tools/FileEditTool/prompt.js?credit=${credit}-${Date.now()}`
    )
  } finally {
    if (prior === undefined) delete process.env[CREDIT_FLAG]
    else process.env[CREDIT_FLAG] = prior
  }
}

const GATED = [
  'NEVER write new files unless explicitly required',
  'Only use emojis if the user explicitly requests it',
]
const CORE = [
  'Performs exact string replacements in files.',
  'tool at least once in the conversation before editing',
  'preserve the exact indentation',
  'The edit will FAIL if',
  'Use `replace_all` for replacing and renaming',
]

describe('buildEditToolDescription', () => {
  const verbose = buildEditToolDescription(false)
  const lean = buildEditToolDescription(true)

  it('keeps every CORE line in both shapes', () => {
    for (const line of CORE) {
      expect(verbose).toContain(line)
      expect(lean).toContain(line)
    }
  })

  it('includes GATED guardrails only in the verbose shape', () => {
    for (const line of GATED) {
      expect(verbose).toContain(line)
      expect(lean).not.toContain(line)
    }
  })

  it('lean is shorter than verbose', () => {
    expect(lean.length).toBeLessThan(verbose.length)
  })

  it('verbose shape snapshot', () => {
    expect(verbose).toMatchSnapshot()
  })

  it('lean shape snapshot', () => {
    expect(lean).toMatchSnapshot()
  })
})

describe('buildEditToolDescription under CLAUDIN_BASH_READ_CREDIT', () => {
  // The first sentence changes; the one after it stays, in both shapes.
  const READ_ONLY =
    'You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.'
  const READ_OR_CAT =
    'You must read the file first — with `Read`, or a Bash `cat` that printed it whole. This tool will error if you attempt an edit without reading the file.'

  it('flag off: both shapes are byte-identical to the snapshots above', async () => {
    const off = await loadEditPrompt(false)
    for (const lean of [false, true]) {
      expect(off.buildEditToolDescription(lean)).toBe(buildEditToolDescription(lean))
      expect(off.buildEditToolDescription(lean)).toContain(READ_ONLY)
    }
  })

  it('flag on: a cat that printed the file whole counts as reading it, in both shapes', async () => {
    const on = await loadEditPrompt(true)
    for (const lean of [false, true]) {
      expect(on.buildEditToolDescription(lean)).toContain(READ_OR_CAT)
      expect(on.buildEditToolDescription(lean)).toBe(
        buildEditToolDescription(lean).replace(READ_ONLY, READ_OR_CAT),
      )
    }
  })
})

describe('buildCompactEditToolDescription (v2)', () => {
  const compact = buildCompactEditToolDescription()

  it('states every rule of the full text', () => {
    for (const rule of [
      'Read the file in this conversation before editing',
      'match the file exactly, including indentation',
      'be unique',
      'line number + arrow',
      '`replace_all: true`',
    ]) {
      expect(compact).toContain(rule)
    }
  })

  it('drops the gated guardrails and is shorter than the lean shape', () => {
    for (const line of GATED) expect(compact).not.toContain(line)
    expect(compact.length).toBeLessThan(buildEditToolDescription(true).length)
  })

  it('under CLAUDIN_BASH_READ_CREDIT a whole-file cat counts as the read', async () => {
    const on = await loadEditPrompt(true)
    expect(on.buildCompactEditToolDescription()).toContain(
      'You must read the file first — with `Read`, or a Bash `cat` that printed it whole — or the call will fail.',
    )
    const off = await loadEditPrompt(false)
    expect(off.buildCompactEditToolDescription()).toBe(compact)
  })
})

// `then` is described once, by its own schema field: no description shape
// repeats it (see the note in prompt.ts).
describe('the Edit description and `then`', () => {
  const SHAPES: Array<[string, string]> = [
    ['compact', buildCompactEditToolDescription()],
    ['verbose', buildEditToolDescription(false)],
    ['lean', buildEditToolDescription(true)],
  ]
  const schema = JSON.stringify(zodToJsonSchema(inputSchema()))

  it('no shape names `then`, while the schema field still describes itself', () => {
    expect(schema).toContain('"then"')
    expect(schema).toContain('the test, typecheck or build that checks it')
    for (const [shape, text] of SHAPES) {
      expect({ shape, namesThen: text.includes('`then`') }).toEqual({ shape, namesThen: false })
    }
  })

  it('the description and the schema still name every capability', () => {
    for (const [shape, description] of SHAPES) {
      const text = `${description}\n${schema}`
      const missing = ['old_string', 'new_string', 'replace_all'].filter(m => !text.includes(m))
      expect({ shape, missing }).toEqual({ shape, missing: [] })
    }
  })
})
