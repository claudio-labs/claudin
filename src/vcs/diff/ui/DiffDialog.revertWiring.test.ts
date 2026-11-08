// The `x` hunk revert in /diff. The decision (planHunkRevert) and the git
// work (revertHunk) are tested in src/vcs/diff/revertHunk.test.ts, the
// row→hunk mapping in rowLines.test.ts. DiffDialog itself has no render
// harness (it drives the workspace, log and stash hooks), so its wiring is
// pinned on the source text, the way contextUsage.test.ts pins its
// React-Compiler components.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_BINDINGS } from 'src/terminal/keybindings/defaultBindings.js'

const source = readFileSync(join(import.meta.dir, 'DiffDialog.tsx'), 'utf8')

describe('DiffDialog hunk revert wiring', () => {
  test('x is bound to diff:revertHunk in the DiffDialog context', () => {
    const block = DEFAULT_BINDINGS.find(b => b.context === 'DiffDialog')
    expect(block?.bindings.x).toBe('diff:revertHunk')
  })

  test('x asks about the hunk under the diff cursor; in the list or with a selection open it says why not', () => {
    expect(source).toContain(
      "      'diff:revertHunk': () => {\n        if (activeTab !== 'local') return false\n        if (focus !== 'content') {\n          setRevertNotice('x reverts a hunk in the diff: ctrl+↓ to move into it')\n          return\n        }\n        if (visualAnchor !== null) {\n          setRevertNotice('close the selection (v) before reverting a hunk')\n          return\n        }\n        void askToRevertHunk()\n      },",
    )
    expect(source).toContain('      hunkAtRow(segments, diffRows, cursorRowClamped),\n')
    expect(source).toContain('    const intent = planHunkRevert(\n      currentSource.type,\n')
  })

  test("a worktree's main checkout is never reverted from its session", () => {
    expect(source).toContain('  const shadowedRoots = useMemo(() => worktreeShadowedRoots(scanBases), [scanBases])\n')
    expect(source).toContain('      { shadowedRoot: !!selected && shadowedRoots.has(selected.root) },\n')
  })

  test('a staged file is refused before the question', () => {
    expect(source).toMatch(
      /if \(await hasStagedChanges\(root, selected\.file\.path\)\) \{\n\s+setRevertNotice\(`Not reverted: \$\{stagedRefusal\(selected\.file\.path\)\}`\)\n\s+return\n\s+\}\n\s+setRevertNotice\(null\)\n\s+setRevertPrompt\(/,
    )
  })

  test("the outcome survives the revert's own refresh moving the selection", () => {
    expect(source).toContain("    setRevertNotice('Hunk reverted')\n    keepRevertNoticeRef.current = true\n")
    expect(source).toContain('    if (keepRevertNoticeRef.current) keepRevertNoticeRef.current = false\n    else setRevertNotice(null)\n  }, [selectedKey])')
    expect(source).toContain('  useEffect(() => {\n    keepRevertNoticeRef.current = false\n  }, [currentGroups])')
  })

  test('y/Enter confirm through the Confirmation context while the question is up', () => {
    expect(source).toContain(
      "  useKeybinding('confirm:yes', () => void confirmRevert(), {\n    context: 'Confirmation',\n    isActive: hasFocus && revertPrompt !== null,\n  })",
    )
  })

  test('the DiffDialog keys and the paging handler stand down while it is up', () => {
    expect(source).toContain("    { context: 'DiffDialog', isActive: hasFocus && revertPrompt === null },")
    expect(source).toContain('  }, { isActive: hasFocus && revertPrompt === null })')
  })

  test('n/Esc peel the question before anything else', () => {
    expect(source).toContain(
      '  const handleCancel = (): void => {\n    // Esc peels one layer at a time; a pending revert is the innermost, then\n    // an active selection.\n    if (revertPrompt !== null) {\n      setRevertPrompt(null)\n      return\n    }',
    )
  })

  test('a revert re-reads the working tree and keeps the selected file', () => {
    expect(source).toContain('    const result = await revertHunk(prompt.root, prompt.file, prompt.hunk)\n')
    expect(source).toMatch(
      /setRevertNotice\('Hunk reverted'\)[\s\S]{0,400}pendingReselectRef\.current = \{[\s\S]{0,200}workspace\.refresh\(\)\n {4}setStatusNonce/,
    )
  })

  test('the footer shows the question, then the outcome, in place of the hints', () => {
    expect(source).toContain("{fitHints([revertPrompt.question], footerWidth, 'y/Enter revert · n/Esc cancel')}")
    expect(source).toContain('<Text wrap="truncate-end">{revertNotice}</Text>')
    expect(source).toContain("...(currentSource.type === 'working' ? ['x revert hunk'] : []),")
  })
})
