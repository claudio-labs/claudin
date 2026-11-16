/**
 * A sub-agent's worktree is a second checkout under
 * `<root>/.claudin/worktrees/<slug>/`, so a Read inside it walks the worktree
 * root as a nested directory and finds that checkout's own AGENTS.md and
 * `.claudin/rules/*.md`. Where those are byte-identical to the main checkout's
 * and the main checkout's are already in context, attaching them again says
 * nothing new (8 such attachments, ~14K chars, in the 2026-11-16 census).
 *
 * A copy that differs, has no counterpart, or whose counterpart never reached
 * context still attaches: a worktree on another branch can carry a rule the
 * main checkout lacks.
 *
 * The project is a temp dir the original cwd points at for the length of each
 * test; no module is mocked.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import type { ToolPermissionContext, ToolUseContext } from 'src/tools/Tool.js'
import { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { getOriginalCwd, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import {
  clearMemoryFileCaches,
  getMemoryFiles,
} from 'src/memory/instructions/claudemd.js'
import { getNestedMemoryAttachmentsForFile } from 'src/agent/attachments/memory.js'

const AGENTS = '# AGENTS.md\n\nZZ_WORKTREE_COPY_AGENTS_ZZ\n'
const ALWAYS_RULE = '# Always\n\nZZ_WORKTREE_COPY_ALWAYS_ZZ\n'
const SCOPED_RULE =
  '---\npaths:\n  - "src/**/*.ts"\n---\n\n# Scoped\n\nZZ_WORKTREE_COPY_SCOPED_ZZ\n'

let previousOriginalCwd: string
let project: string
let worktree: string

/** One checkout: AGENTS.md, an always-on rule, a path-scoped rule and a source file. */
function writeCheckout(root: string): void {
  mkdirSync(join(root, '.claudin', 'rules'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), AGENTS)
  writeFileSync(join(root, '.claudin', 'rules', 'always.md'), ALWAYS_RULE)
  writeFileSync(join(root, '.claudin', 'rules', 'scoped.md'), SCOPED_RULE)
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
}

beforeEach(() => {
  // realpath: the working-directory check compares resolved paths.
  project = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-copies-')))
  worktree = join(project, '.claudin', 'worktrees', 'feat')
  writeCheckout(project)
  writeCheckout(worktree)

  previousOriginalCwd = getOriginalCwd()
  setOriginalCwd(project)
  // The eager instruction set is memoized for the session: load it from here.
  clearMemoryFileCaches()
})

afterEach(() => {
  setOriginalCwd(previousOriginalCwd)
  clearMemoryFileCaches()
  rmSync(project, { recursive: true, force: true })
})

function makeContext(): ToolUseContext {
  return {
    readFileState: new FileStateCache(100, 10_000_000),
    loadedNestedMemoryPaths: new Set<string>(),
  } as unknown as ToolUseContext
}

const appState = {
  toolPermissionContext: {
    additionalWorkingDirectories: new Map(),
  } as unknown as ToolPermissionContext,
}

/** The `nested_memory` paths a Read of `target` attaches, under `root` only. */
async function attachedUnder(
  root: string,
  context: ToolUseContext,
  target: string,
): Promise<string[]> {
  const attachments = await getNestedMemoryAttachmentsForFile(
    target,
    context,
    appState,
  )
  return attachments
    .filter(a => a.type === 'nested_memory')
    .map(a => (a.type === 'nested_memory' ? a.path : ''))
    .filter(path => path.startsWith(root + sep))
}

describe('worktree copies of instruction files', () => {
  test('the main checkout loads AGENTS.md and the always-on rule eagerly, not the scoped rule', async () => {
    // What "already in context" rests on for the two eager files below.
    const eager = (await getMemoryFiles()).map(f => f.path)

    expect(eager).toContain(join(project, 'AGENTS.md'))
    expect(eager).toContain(join(project, '.claudin', 'rules', 'always.md'))
    expect(eager).not.toContain(join(project, '.claudin', 'rules', 'scoped.md'))
  })

  test('an identical worktree copy of AGENTS.md is not attached', async () => {
    const attached = await attachedUnder(
      worktree,
      makeContext(),
      join(worktree, 'src', 'a.ts'),
    )

    expect(attached).not.toContain(join(worktree, 'AGENTS.md'))
  })

  test('an identical worktree copy of an always-on rule is not attached', async () => {
    const attached = await attachedUnder(
      worktree,
      makeContext(),
      join(worktree, 'src', 'a.ts'),
    )

    expect(attached).not.toContain(
      join(worktree, '.claudin', 'rules', 'always.md'),
    )
  })

  test('an identical worktree copy of a path-scoped rule already loaded from the main checkout is not attached', async () => {
    const context = makeContext()
    const mainScoped = join(project, '.claudin', 'rules', 'scoped.md')

    // A Read in the main checkout brings its scoped rule into context first.
    const fromMain = await getNestedMemoryAttachmentsForFile(
      join(project, 'src', 'a.ts'),
      context,
      appState,
    )
    expect(
      fromMain.map(a => (a.type === 'nested_memory' ? a.path : '')),
    ).toContain(mainScoped)
    expect(context.loadedNestedMemoryPaths?.has(mainScoped)).toBe(true)

    const attached = await attachedUnder(
      worktree,
      context,
      join(worktree, 'src', 'a.ts'),
    )

    expect(attached).not.toContain(
      join(worktree, '.claudin', 'rules', 'scoped.md'),
    )
  })

  test('a worktree rule that differs from the main checkout is still attached', async () => {
    const changed = join(worktree, '.claudin', 'rules', 'always.md')
    writeFileSync(changed, `${ALWAYS_RULE}\nOnly on this branch.\n`)

    const attached = await attachedUnder(
      worktree,
      makeContext(),
      join(worktree, 'src', 'a.ts'),
    )

    expect(attached).toContain(changed)
  })

  test('a worktree instruction file with no main counterpart is still attached', async () => {
    const onlyHere = join(worktree, '.claudin', 'rules', 'only-here.md')
    writeFileSync(onlyHere, '# Only here\n\nA rule the main checkout lacks.\n')

    const attached = await attachedUnder(
      worktree,
      makeContext(),
      join(worktree, 'src', 'a.ts'),
    )

    expect(attached).toContain(onlyHere)
  })

  test('a path-scoped worktree rule whose main counterpart was never loaded is still attached', async () => {
    // No Read in the main checkout: its scoped rule is on disk, not in context.
    const attached = await attachedUnder(
      worktree,
      makeContext(),
      join(worktree, 'src', 'a.ts'),
    )

    expect(attached).toContain(join(worktree, '.claudin', 'rules', 'scoped.md'))
  })

  test('a main rule with an unanchored glob and its identical worktree copy attach once, as the main one', async () => {
    // `**/*.ts` in the main checkout matches a file inside the worktree too,
    // so one Read brings both: the worktree's from the walk down to the file,
    // the main checkout's from the cwd-level rules. Neither was in context.
    const rule = '---\npaths:\n  - "**/*.ts"\n---\n\n# Unanchored\n\nZZ_WORKTREE_COPY_UNANCHORED_ZZ\n'
    const mainRule = join(project, '.claudin', 'rules', 'unanchored.md')
    writeFileSync(mainRule, rule)
    writeFileSync(join(worktree, '.claudin', 'rules', 'unanchored.md'), rule)

    const attached = await attachedUnder(
      project,
      makeContext(),
      join(worktree, 'src', 'a.ts'),
    )

    expect(attached.filter(path => path.endsWith('unanchored.md'))).toEqual([
      mainRule,
    ])
  })
})
