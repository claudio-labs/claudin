import { describe, expect, test } from 'bun:test'
import { join } from 'path'
import { getToolResultsDir, isSavedResultPath, resultDirs } from 'src/agent/tools/toolResultFiles.js'

// The saved results Read hands back whole (readDispatch.ts). Paths only:
// nothing is written, so the session's own directory under the config dir is
// safe to name.
describe('isSavedResultPath', () => {
  test("a file in the session's results directory, or in the fallback one, is a saved result", () => {
    expect(isSavedResultPath(join(getToolResultsDir(), 'toolu_x-0123456789ab.txt'))).toBe(true)
    for (const dir of resultDirs()) {
      expect(isSavedResultPath(join(dir, 'toolu_y-0123456789ab.txt'))).toBe(true)
    }
  })

  test('the directory itself, a sibling that starts like it, and any other path are not', () => {
    const own = getToolResultsDir()
    expect(isSavedResultPath(own)).toBe(false)
    expect(isSavedResultPath(`${own}-x/toolu_x.txt`)).toBe(false)
    expect(isSavedResultPath('/repo/notes.txt')).toBe(false)
  })
})
