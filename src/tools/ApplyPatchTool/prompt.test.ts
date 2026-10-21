import { describe, expect, test } from 'bun:test'
import { zodToJsonSchema } from 'src/shared/data/zodToJsonSchema.js'
import { ApplyPatchTool } from 'src/tools/ApplyPatchTool/ApplyPatchTool.js'
import { DESCRIPTION } from 'src/tools/ApplyPatchTool/prompt.js'

type PatchPrompt = typeof import('src/tools/ApplyPatchTool/prompt.js')

/**
 * The flags are read once at module load, so each arm gets its own instance of
 * the module, loaded with the variables set the way that arm needs them.
 */
async function loadPatchPromptWith(flags: string[]): Promise<PatchPrompt> {
  const names = ['CLAUDIN_BASH_READ_CREDIT', 'CLAUDIN_LEAN_PATCH_PROMPT', 'CLAUDIN_SOFT_BATCH']
  const prior = names.map(name => [name, process.env[name]] as const)
  for (const name of names) {
    if (flags.includes(name)) process.env[name] = '1'
    else delete process.env[name]
  }
  try {
    return await import(`src/tools/ApplyPatchTool/prompt.js?flags=${flags.join('+')}-${Date.now()}`)
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

const loadPatchPrompt = (credit: boolean) => loadPatchPromptWith(credit ? ['CLAUDIN_BASH_READ_CREDIT'] : [])

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
    'any Read counts: the whole file, an outline, a symbol, or a range — a Bash `cat` that printed the whole file, or a `sed -n A,Bp` slice of it, counts too. Nothing has to be re-read'

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

// The patch-thinking A/B arms of 2026-10-21 (steeringToggles.ts). Off, the
// description is the snapshot above byte for byte.
describe('Patch DESCRIPTION under CLAUDIN_LEAN_PATCH_PROMPT', () => {
  test('drops only the rules patchFormat.ts rescues, and keeps the ones it does not', async () => {
    const lean = (await loadPatchPromptWith(['CLAUDIN_LEAN_PATCH_PROMPT'])).DESCRIPTION
    expect(lean).toMatchSnapshot()
    for (const rescued of [
      'not a fragment like',
      'do not restate the anchored line',
      'give each file exactly ONE section',
      'do not repeat one function signature',
    ]) {
      expect(DESCRIPTION).toContain(rescued)
      expect(lean).not.toContain(rescued)
    }
    for (const kept of [
      'Each hunk begins with a "@@" line',
      'each "@@" must sit at or after the previous hunk\'s',
      'lines you copied from the file (not remembered)',
      'Include enough context/"@@" anchors that each hunk matches a unique location',
      'NOT applied',
      'Batch related edits into ONE call',
      'Typical flow for a multi-file change',
    ]) {
      expect(lean).toContain(kept)
    }
  })
})

describe('Patch DESCRIPTION under CLAUDIN_SOFT_BATCH', () => {
  test('drops the Typical-flow line and nothing else', async () => {
    const soft = (await loadPatchPromptWith(['CLAUDIN_SOFT_BATCH'])).DESCRIPTION
    const flow = DESCRIPTION.split('\n').find(line => line.startsWith('- Typical flow for a multi-file change'))
    expect(flow).toBeDefined()
    expect(soft).toBe(DESCRIPTION.replace(`\n${flow}`, ''))
    expect(soft).toContain('Batch related edits into ONE call')
  })

  test('both flags off: byte-identical to the snapshot', async () => {
    expect((await loadPatchPromptWith([])).DESCRIPTION).toBe(DESCRIPTION)
  })
})
