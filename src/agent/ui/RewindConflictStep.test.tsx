// The rewind's conflict step (RewindConflictStep.tsx) and the MessageSelector
// wiring that routes a code restore through it. The step is rendered; the
// wiring lives in MessageSelector, a React-Compiler file with no interaction
// harness, and REPL.tsx, so it is pinned on their source text.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import React from 'react'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { conflictLabel, conflictLines, RewindConflictStep } from 'src/agent/ui/RewindConflictStep.js'

describe('conflictLabel', () => {
  test('a path inside the cwd is shown relative to it, one outside as it is', () => {
    expect(conflictLabel('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    expect(conflictLabel('/elsewhere/b.ts', '/repo')).toBe('/elsewhere/b.ts')
    expect(conflictLabel('/repo-other/c.ts', '/repo')).toBe('/repo-other/c.ts')
  })
})

describe('conflictLines', () => {
  test('a heading that counts the files, then one line per file', () => {
    expect(conflictLines(['/repo/src/parser.ts', '/repo/README.md'], '/repo')).toEqual([
      '2 files changed outside Claudin since its last edit:',
      '  src/parser.ts',
      '  README.md',
    ])
  })

  test('one file reads in the singular', () => {
    expect(conflictLines(['/repo/a.ts'], '/repo')[0]).toBe('1 file changed outside Claudin since its last edit:')
  })

  test('past eight files the rest are counted', () => {
    const files = Array.from({ length: 11 }, (_, i) => `/repo/f${i}.ts`)
    const lines = conflictLines(files, '/repo')
    expect(lines).toHaveLength(10)
    expect(lines.at(-1)).toBe('  … and 3 more')
  })
})

describe('RewindConflictStep', () => {
  test('lists the files and offers keep (focused), overwrite and back', async () => {
    const out = await renderToString(
      <RewindConflictStep files={[join(process.cwd(), 'src', 'parser.ts')]} onChoose={() => {}} />,
      100,
    )
    const flat = out.replace(/\s+/g, ' ')
    expect(flat).toContain('1 file changed outside Claudin since its last edit: src/parser.ts')
    expect(flat).toMatch(/❯ 1\. Keep my changes in these files \(restore the rest\)/)
    expect(flat).toContain('2. Overwrite them too')
    expect(flat).toContain('3. Back')
  })
})

const selector = readFileSync(join(import.meta.dir, 'MessageSelector.tsx'), 'utf8')
const repl = readFileSync(join(import.meta.dir, '..', 'repl', 'REPL.tsx'), 'utf8')

describe('MessageSelector wiring', () => {
  test('both confirmation entry points load the conflicts beside the diff stats', () => {
    expect(selector).toContain(
      'Promise.all([fileHistoryGetDiffStats(fileHistory, preselectedMessage.uuid), fileHistoryFindConflicts(fileHistory, preselectedMessage.uuid)])',
    )
    expect(selector).toContain(
      'Promise.all([fileHistoryGetDiffStats(fileHistory, message_0.uuid), fileHistoryFindConflicts(fileHistory, message_0.uuid)])',
    )
  })

  test('a code restore with conflicts stops at the conflict step', () => {
    expect(selector).toContain(
      "    if ((option === 'code' || option === 'both') && conflictsForRestore.length > 0) {\n      setPendingCodeOption(option);\n      return;\n    }",
    )
    expect(selector).toContain('{pendingCodeOption !== null ? <RewindConflictStep files={conflictsForRestore}')
  })

  test('keep restores with the conflicts kept, overwrite without, back returns', () => {
    expect(selector).toContain(
      "    await runRestore(option, choice === 'keep' ? new Set(conflictsForRestore) : undefined);",
    )
    expect(selector).toContain("    if (choice === 'back') {\n      setPendingCodeOption(null);\n      return;\n    }")
    expect(selector).toContain('        await onRestoreCode(messageToRestore, keep);')
  })

  test('the REPL hands the kept set to the rewind', () => {
    expect(repl).toContain('onRestoreCode={async (message: UserMessage, keep?: ReadonlySet<string>) => {')
    expect(repl).toContain('}, message.uuid, { keep });')
  })

  test('the copy no longer claims a manual edit is never touched', () => {
    expect(selector).not.toContain('Rewinding does not affect files edited')
    expect(selector).toContain("Rewinding restores only files Claudin's edit")
  })
})
