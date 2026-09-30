import { describe, expect, test } from 'bun:test'
import { zodToJsonSchema } from 'src/shared/data/zodToJsonSchema.js'
import { ApplyPatchTool } from 'src/tools/ApplyPatchTool/ApplyPatchTool.js'
import { DESCRIPTION } from 'src/tools/ApplyPatchTool/prompt.js'

type PatchPrompt = typeof import('src/tools/ApplyPatchTool/prompt.js')

const CREDIT_FLAG = 'CLAUDIN_BASH_READ_CREDIT'

/**
 * The flag is read once at module load, so each arm gets its own instance of
 * the module, loaded with the variable set the way that arm needs it.
 */
async function loadPatchPrompt(credit: boolean): Promise<PatchPrompt> {
  const prior = process.env[CREDIT_FLAG]
  if (credit) process.env[CREDIT_FLAG] = '1'
  else delete process.env[CREDIT_FLAG]
  try {
    return await import(
      `src/tools/ApplyPatchTool/prompt.js?credit=${credit}-${Date.now()}`
    )
  } finally {
    if (prior === undefined) delete process.env[CREDIT_FLAG]
    else process.env[CREDIT_FLAG] = prior
  }
}

describe('Patch DESCRIPTION', () => {
  // The description heads the cached `tools` block, so any byte it gains or
  // loses is a cache miss for every user (see the note above DESCRIPTION).
  test('matches snapshot', () => {
    expect(DESCRIPTION).toMatchSnapshot()
  })
})

describe('Patch DESCRIPTION under CLAUDIN_BASH_READ_CREDIT', () => {
  const ANY_READ =
    'any Read counts: the whole file, an outline, a symbol, or a range. Nothing has to be re-read'
  const ANY_READ_OR_CAT =
    'any Read counts: the whole file, an outline, a symbol, or a range — a Bash `cat` that printed the whole file counts too. Nothing has to be re-read'

  test('flag off: byte-identical to the snapshot above', async () => {
    const off = await loadPatchPrompt(false)
    expect(off.DESCRIPTION).toBe(DESCRIPTION)
    expect(off.DESCRIPTION).toContain(ANY_READ)
    expect(off.DESCRIPTION).not.toContain('`cat`')
  })

  test('flag on: a cat that printed the whole file counts too, and nothing else moves', async () => {
    const on = await loadPatchPrompt(true)
    expect(on.DESCRIPTION).toContain(ANY_READ_OR_CAT)
    expect(on.DESCRIPTION).toBe(DESCRIPTION.replace(ANY_READ, ANY_READ_OR_CAT))
  })
})

describe('Patch DESCRIPTION — the rules it must keep', () => {
  // Every format rule and contract line promptFeatureCoverage.test.ts pins.
  const MARKERS = [
    '*** Begin Patch',
    '*** Add File',
    '*** Update File',
    '*** Delete File',
    '*** Move to',
    '*** End of File',
    '@@',
    'NOT applied',
    'Each hunk begins with a "@@" line',
    'each "@@" must sit at or after the previous hunk\'s',
    'give each file exactly ONE section',
    'lines you copied from the file (not remembered)',
    'Batch related edits into ONE call',
  ]

  test('keeps every format rule', () => {
    expect(MARKERS.filter(m => !DESCRIPTION.includes(m))).toEqual([])
  })

  // `then` is described once, by its own schema field (see the note in prompt.ts).
  test('does not name `then`, while the schema field still describes itself', () => {
    const schema = JSON.stringify(zodToJsonSchema(ApplyPatchTool.inputSchema))
    expect(schema).toContain('"then"')
    expect(schema).toContain('the test, typecheck or build that checks it')
    expect(DESCRIPTION).not.toContain('`then`')
  })
})
