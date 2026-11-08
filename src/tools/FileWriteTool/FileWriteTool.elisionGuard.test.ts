// The elision guard (src/tools/shared/elisionGuard.ts) through Write: content
// carrying a placeholder comment the file does not already hold is refused
// before any permission prompt or write.
import { describe, expect, test } from 'bun:test'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { ELIDED, ORIGINAL, useElisionGuardEnv } from 'src/tools/shared/__testutils__/elisionGuardHarness.js'

const { ctx, fresh } = useElisionGuardEnv()

describe('Write', () => {
  test('refuses content that elides part of the file, with error code 5', async () => {
    const path = fresh('write.ts', ORIGINAL)
    const r = await FileWriteTool.validateInput!({ file_path: path, content: ELIDED }, ctx())
    expect(r).toEqual({
      result: false,
      message: expect.stringContaining('Write refused: content line 5 is an elision placeholder:\n    // ... existing code ...\n'),
      errorCode: 5,
    })
  })

  test('refuses it in a new file', async () => {
    const path = fresh('write-new.py', null)
    const r = await FileWriteTool.validateInput!({ file_path: path, content: 'def a():\n    # ... rest of the module\n' }, ctx())
    expect(r.result === false && r.errorCode).toBe(5)
  })

  test('lets through a placeholder the file already has, and a full rewrite', async () => {
    const kept = fresh('write-kept.ts', `${ORIGINAL}// ... existing code ...\n`)
    expect((await FileWriteTool.validateInput!({ file_path: kept, content: `// head\n${ORIGINAL}// ... existing code ...\n` }, ctx())).result).toBe(true)
    const full = fresh('write-full.ts', ORIGINAL)
    expect((await FileWriteTool.validateInput!({ file_path: full, content: ORIGINAL.replace('1', '10') }, ctx())).result).toBe(true)
  })

  test('never checks prose', async () => {
    const path = fresh('notes.md', '# Notes\n')
    expect((await FileWriteTool.validateInput!({ file_path: path, content: '```ts\n// ... existing code ...\n```\n' }, ctx())).result).toBe(true)
  })

  test('CLAUDIN_ELISION_GUARD=0 lets it through', async () => {
    process.env.CLAUDIN_ELISION_GUARD = '0'
    const path = fresh('write-off.ts', ORIGINAL)
    expect((await FileWriteTool.validateInput!({ file_path: path, content: ELIDED }, ctx())).result).toBe(true)
  })
})
