// The elision guard (src/tools/shared/elisionGuard.ts) through Edit: new
// text carrying a placeholder comment the old text does not hold is refused
// before any permission prompt or write. Write and Patch have their own
// suites beside their tools.
import { describe, expect, test } from 'bun:test'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { ELIDED, ORIGINAL, useElisionGuardEnv } from 'src/tools/shared/__testutils__/elisionGuardHarness.js'

const { ctx, fresh } = useElisionGuardEnv()

describe('Edit', () => {
  test('refuses a new_string that turns code into a placeholder, naming the line, with error code 11', async () => {
    const path = fresh('edit.ts', ORIGINAL)
    const r = await FileEditTool.validateInput!(
      {
        file_path: path,
        old_string: '  return 2\n}',
        new_string: '  return 2\n}\n// ... existing code ...',
      },
      ctx(),
    )
    expect(r).toEqual({
      result: false,
      message: expect.stringContaining('Edit refused: new_string line 3 is an elision placeholder:\n    // ... existing code ...\n'),
      errorCode: 11,
    })
  })

  test('lets through a placeholder already in old_string', async () => {
    const path = fresh('edit-kept.ts', `${ORIGINAL}// ... existing code ...\n`)
    const r = await FileEditTool.validateInput!(
      { file_path: path, old_string: '  return 2\n}\n// ... existing code ...', new_string: '  return 3\n}\n// ... existing code ...' },
      ctx(),
    )
    expect(r.result).toBe(true)
  })

  test('refuses it on file creation too', async () => {
    const path = fresh('edit-new.ts', null)
    const r = await FileEditTool.validateInput!({ file_path: path, old_string: '', new_string: ELIDED }, ctx())
    expect(r.result).toBe(false)
    expect(r.result === false && r.errorCode).toBe(11)
  })

  test('lets an ordinary comment ending in an ellipsis through', async () => {
    const path = fresh('edit-prose.ts', ORIGINAL)
    const r = await FileEditTool.validateInput!(
      { file_path: path, old_string: '  return 2', new_string: '  // Retry against the other replicas...\n  return 2' },
      ctx(),
    )
    expect(r.result).toBe(true)
  })

  test('CLAUDIN_ELISION_GUARD=0 lets it through', async () => {
    process.env.CLAUDIN_ELISION_GUARD = '0'
    const path = fresh('edit-off.ts', ORIGINAL)
    const r = await FileEditTool.validateInput!(
      { file_path: path, old_string: '  return 2\n}', new_string: '  // ...\n}' },
      ctx(),
    )
    expect(r.result).toBe(true)
  })
})
