import { describe, expect, it } from 'bun:test'
import { buildWriteToolDescription } from 'src/tools/FileWriteTool/prompt.js'

type WritePrompt = typeof import('src/tools/FileWriteTool/prompt.js')

const CREDIT_FLAG = 'CLAUDIN_BASH_READ_CREDIT'

/**
 * The flag is read once at module load, so each arm gets its own instance of
 * the module, loaded with the variable set the way that arm needs it.
 */
async function loadWritePrompt(credit: boolean): Promise<WritePrompt> {
  const prior = process.env[CREDIT_FLAG]
  if (credit) process.env[CREDIT_FLAG] = '1'
  else delete process.env[CREDIT_FLAG]
  try {
    return await import(
      `src/tools/FileWriteTool/prompt.js?credit=${credit}-${Date.now()}`
    )
  } finally {
    if (prior === undefined) delete process.env[CREDIT_FLAG]
    else process.env[CREDIT_FLAG] = prior
  }
}

const GATED = [
  'NEVER create documentation files (*.md) or README files',
  'Only use emojis if the user explicitly requests it',
]
const CORE = [
  'Writes a file to the local filesystem.',
  'This tool will overwrite the existing file',
  'you MUST use the Read tool first',
  'Prefer the Edit tool for modifying existing files',
]

describe('buildWriteToolDescription', () => {
  const verbose = buildWriteToolDescription(false)
  const lean = buildWriteToolDescription(true)

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

describe('buildWriteToolDescription under CLAUDIN_BASH_READ_CREDIT', () => {
  const READ_FIRST =
    "you MUST use the Read tool first to read the file's contents — all of them, since a Write replaces the whole file."
  const READ_OR_CAT_FIRST =
    "you MUST use the Read tool first to read the file's contents (a Bash `cat` that printed it whole counts) — all of them, since a Write replaces the whole file."

  it('flag off: both shapes are byte-identical to the snapshots above', async () => {
    const off = await loadWritePrompt(false)
    for (const lean of [false, true]) {
      expect(off.buildWriteToolDescription(lean)).toBe(buildWriteToolDescription(lean))
      expect(off.buildWriteToolDescription(lean)).toContain(READ_FIRST)
    }
  })

  it('flag on: a cat that printed the file whole counts as the read, in both shapes', async () => {
    const on = await loadWritePrompt(true)
    for (const lean of [false, true]) {
      expect(on.buildWriteToolDescription(lean)).toContain(READ_OR_CAT_FIRST)
      expect(on.buildWriteToolDescription(lean)).toBe(
        buildWriteToolDescription(lean).replace(READ_FIRST, READ_OR_CAT_FIRST),
      )
    }
  })
})
