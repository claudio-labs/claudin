// The elision guard (src/tools/shared/elisionGuard.ts) through Patch: only the
// file that carries a new placeholder comment is refused; the rest of the
// patch applies.
import { randomUUID } from 'crypto'
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { runApplyPatch, validateApplyPatchInput } from 'src/tools/ApplyPatchTool/applyPatch.js'
import { ORIGINAL, useElisionGuardEnv } from 'src/tools/shared/__testutils__/elisionGuardHarness.js'

const { ctx, fresh } = useElisionGuardEnv()

describe('Patch', () => {
  test('a patch whose only file carries a placeholder is refused in validation', () => {
    const path = fresh('patch.ts', ORIGINAL)
    const r = validateApplyPatchInput(
      { patchText: ['*** Begin Patch', `*** Update File: ${path}`, '@@', '-  return 2', '+  // ... existing code ...', '*** End Patch'].join('\n') },
      ctx(),
    )
    expect(r.result).toBe(false)
    expect(r.result === false && r.message).toContain('an added line of')
    expect(r.result === false && r.message).toContain('is an elision placeholder:\n    // ... existing code ...')
  })

  test('an Add File carrying a placeholder is refused', () => {
    const path = fresh('patch-add.ts', null)
    const r = validateApplyPatchInput(
      { patchText: ['*** Begin Patch', `*** Add File: ${path}`, '+const a = 1', '+// ... rest of the file', '*** End Patch'].join('\n') },
      ctx(),
    )
    expect(r.result).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  test('the other files of the patch apply; the elided one is left untouched and reported', async () => {
    const elided = fresh('patch-elided.ts', ORIGINAL)
    const clean = fresh('patch-clean.ts', ORIGINAL)
    const patchText = [
      '*** Begin Patch',
      `*** Update File: ${elided}`,
      '@@',
      '-  return 2',
      '+  // ... existing code ...',
      `*** Update File: ${clean}`,
      '@@',
      '-  return 2',
      '+  return 20',
      '*** End Patch',
    ].join('\n')
    expect(validateApplyPatchInput({ patchText }, ctx()).result).toBe(true)
    const { output } = await runApplyPatch({ patchText }, ctx(), randomUUID())
    expect(readFileSync(clean, 'utf8')).toContain('return 20')
    expect(readFileSync(elided, 'utf8')).toBe(ORIGINAL)
    expect(output.notApplied?.join('\n')).toContain('is an elision placeholder')
  })

  test('a placeholder kept as context is not new', () => {
    const path = fresh('patch-context.ts', `${ORIGINAL}// ... existing code ...\n`)
    const r = validateApplyPatchInput(
      {
        patchText: ['*** Begin Patch', `*** Update File: ${path}`, '@@', '-  return 2', '+  return 3', ' }', ' // ... existing code ...', '*** End Patch'].join('\n'),
      },
      ctx(),
    )
    expect(r.result).toBe(true)
  })
})
