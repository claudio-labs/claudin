/**
 * Characterization suite for the memory-file loader.
 *
 * `claudemd.ts` had no colocated test: the files that name it either import
 * `MemoryFileInfo` as a type or `mock.module` the whole module away. This suite
 * is the net a later split of the file is checked against, so it is written
 * against real fixtures on disk and drives the real code — nothing here is
 * mocked, because a mock of the thing under characterization proves nothing and
 * `mock.module` overrides are pre-applied for the whole `bun test` run.
 *
 * Two facts about the environment shape what can be asserted:
 *
 * - The fixtures live under `os.tmpdir()`, which is OUTSIDE `getOriginalCwd()`.
 *   `pathInOriginalCwd` therefore reports every fixture as *external*, so the
 *   `@include` tests pass `includeExternal: true` and one test pins what
 *   `false` does instead. That is the observed behaviour, not a workaround.
 * - `feature('TEAMMEM')` reads false under `bun test` (every build flag does),
 *   so the `TeamMem` branches of this module are unreachable here and are
 *   deliberately not asserted on.
 *
 * No env var and no cwd is set by this file, so there is no process-global
 * state to hand back; the only shared thing it touches is the `getMemoryFiles`
 * memoize cache, which it clears again in `afterAll`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, sep } from 'path'
import * as claudemdModule from 'src/memory/instructions/claudemd.js'
import {
  MAX_MEMORY_CHARACTER_COUNT,
  clearMemoryFileCaches,
  getExternalClaudeMdIncludes,
  getLargeMemoryFiles,
  getMemoryFiles,
  hasExternalClaudeMdIncludes,
  isMemoryFilePath,
  processMemoryFile,
  type MemoryFileInfo,
} from 'src/memory/instructions/claudemd.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'

let root: string

function write(relativePath: string, content: string): string {
  const path = join(root, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

/** Drive the real loader over one fixture. */
function load(
  path: string,
  includeExternal = true,
): Promise<MemoryFileInfo[]> {
  return processMemoryFile(path, 'Project', new Set<string>(), includeExternal)
}

beforeAll(() => {
  // realpath both ends so an `@include` resolved against the file's realpath
  // matches the path the test wrote.
  root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'claudemd-char-')))
})

afterAll(() => {
  clearMemoryFileCaches()
  rmSync(root, { recursive: true, force: true })
})

describe('processMemoryFile — frontmatter', () => {
  test('lifts paths frontmatter into globs and keeps the disk bytes beside it', async () => {
    const raw = '---\npaths: src/**/*.ts\n---\n\nUse bun.\n'
    const path = write('frontmatter/scoped.md', raw)

    const [info, ...rest] = await load(path)

    expect(rest).toEqual([])
    expect(info?.path).toBe(path)
    expect(info?.type).toBe('Project')
    expect(info?.globs).toEqual(['src/**/*.ts'])
    // The frontmatter regex eats the blank line after the closing `---`.
    expect(info?.content).toBe('Use bun.\n')
    expect(info?.contentDiffersFromDisk).toBe(true)
    expect(info?.rawContent).toBe(raw)
  })

  test('returns a file without frontmatter byte-identical and marks nothing as differing', async () => {
    const raw = '# Plain\n\nJust text.\n'
    const path = write('frontmatter/plain.md', raw)

    const [info] = await load(path)

    expect(info?.content).toBe(raw)
    expect(info?.globs).toBeUndefined()
    expect(info?.contentDiffersFromDisk).toBe(false)
    expect(info?.rawContent).toBeUndefined()
  })

  test('treats unterminated frontmatter as ordinary content, delimiter included', async () => {
    // No closing `---`, so FRONTMATTER_REGEX never matches and the block is
    // content. The rule loads unconditionally rather than being scoped.
    const raw = '---\npaths: src/**\n\n# Heading\n'
    const path = write('frontmatter/malformed.md', raw)

    const [info] = await load(path)

    expect(info?.content).toBe(raw)
    expect(info?.globs).toBeUndefined()
    expect(info?.contentDiffersFromDisk).toBe(false)
  })
})

describe('processMemoryFile — HTML comments', () => {
  test('strips a comment block spanning several lines', async () => {
    const raw = '# Rules\n\n<!--\nprivate note\nspanning lines\n-->\n\nUse bun.\n'
    const path = write('comments/block.md', raw)

    const [info] = await load(path)

    expect(info?.content).not.toContain('private note')
    expect(info?.content).not.toContain('spanning lines')
    expect(info?.content).not.toContain('<!--')
    expect(info?.content).toContain('# Rules')
    expect(info?.content).toContain('Use bun.')
    expect(info?.contentDiffersFromDisk).toBe(true)
    expect(info?.rawContent).toBe(raw)
  })

  test('keeps the text after `-->` on the closing line', async () => {
    const raw = '<!-- note --> Use bun\n'
    const path = write('comments/residue.md', raw)

    const [info] = await load(path)

    expect(info?.content.trim()).toBe('Use bun')
    expect(info?.contentDiffersFromDisk).toBe(true)
  })

  test('strips a block comment but leaves one inline inside a paragraph', async () => {
    // Observed, not desired: stripping walks TOP-LEVEL tokens and only acts on
    // `html` ones. A comment opened mid-paragraph is part of a `paragraph`
    // token, so it survives into the content the model sees.
    const raw = '<!-- dropped -->\n\nUse bun <!-- kept --> always.\n'
    const path = write('comments/inline.md', raw)

    const [info] = await load(path)

    expect(info?.content).not.toContain('dropped')
    expect(info?.content).toContain('<!-- kept -->')
  })

  test('ignores an @include written inside a comment', async () => {
    write('comments/hidden-child.md', '# Hidden\n')
    const path = write(
      'comments/hides-include.md',
      '# Host\n\n<!--\n@./hidden-child.md\n-->\n\nText\n',
    )

    const result = await load(path)

    expect(result.map(f => f.path)).toEqual([path])
  })
})

describe('processMemoryFile — @include', () => {
  test('loads an included sibling after its includer, with parent set', async () => {
    const child = write('include/child.md', '# Child\n')
    const parent = write('include/parent.md', '# Parent\n\n@./child.md\n')

    const result = await load(parent)

    expect(result.map(f => f.path)).toEqual([parent, child])
    expect(result[0]?.parent).toBeUndefined()
    expect(result[1]?.parent).toBe(parent)
    expect(result[1]?.type).toBe('Project')
  })

  test('drops an include outside the original cwd when includeExternal is false', async () => {
    write('external/child.md', '# Child\n')
    const parent = write('external/parent.md', '@./child.md\n')

    // Precondition: the fixture root is outside getOriginalCwd(), so every
    // include here counts as external.
    expect(root.startsWith(getOriginalCwd())).toBe(false)

    const result = await load(parent, false)

    expect(result.map(f => f.path)).toEqual([parent])
  })

  test('honours the text-extension allowlist for @include targets', async () => {
    write('ext/logo.png', 'this file is text, only its extension is not\n')
    const notes = write('ext/notes.txt', 'notes\n')
    const parent = write('ext/parent.md', '@./logo.png\n\n@./notes.txt\n')

    const result = await load(parent)

    expect(result.map(f => f.path)).toEqual([parent, notes])
  })

  test('extracts the @include after a fenced block and not the one inside it', async () => {
    write('fenced/fenced-child.md', '# Fenced\n')
    const real = write('fenced/real-child.md', '# Real\n')
    const parent = write(
      'fenced/parent.md',
      '# Parent\n\n```\n@./fenced-child.md\n```\n\n@./real-child.md\n',
    )

    const result = await load(parent)

    // The include outside the fence is the load-bearing half. The one inside is
    // invisible for a reason the code does not spell out: a `code` token has no
    // `text`-typed child, and extractPathsFromText only runs on those — so the
    // explicit code/codespan skip in extractIncludePathsFromTokens changes no
    // outcome (break-probe: removing it turns nothing red). The contract is
    // still pinned here; the guard that appears to implement it is not.
    expect(result.map(f => f.path)).toEqual([parent, real])
  })

  test('yields one entry for a file reached through two different includers', async () => {
    const shared = write('dedup/shared.md', '# Shared\n')
    const b = write('dedup/b.md', '@./shared.md\n')
    const c = write('dedup/c.md', '@./shared.md\n')
    const a = write('dedup/a.md', '@./b.md\n\n@./c.md\n')

    const result = await load(a)

    expect(result.map(f => f.path)).toEqual([a, b, shared, c])
  })

  test('stops the include chain at MAX_INCLUDE_DEPTH', async () => {
    const levels = [0, 1, 2, 3, 4, 5, 6].map(i =>
      write(
        `chain/l${i}.md`,
        i === 6 ? `# l6\n` : `# l${i}\n\n@./l${i + 1}.md\n`,
      ),
    )

    const result = await load(levels[0] as string)

    // l0 is depth 0 … l4 is depth 4; l5 would be depth 5 and is refused.
    expect(result.map(f => f.path)).toEqual(levels.slice(0, 5))
  })
})

describe('processMemoryFile — guards', () => {
  test('returns nothing for a file whose content trims to empty', async () => {
    const path = write('guards/blank.md', '   \n\n\t\n')

    expect(await load(path)).toEqual([])
  })

  test('returns nothing the second time the same processedPaths set sees a file', async () => {
    const path = write('guards/once.md', '# Once\n')
    const processedPaths = new Set<string>()

    const first = await processMemoryFile(path, 'Project', processedPaths, true)
    const second = await processMemoryFile(path, 'Project', processedPaths, true)

    expect(first.map(f => f.path)).toEqual([path])
    expect(second).toEqual([])
  })

  test('returns nothing for a missing file instead of throwing', async () => {
    expect(await load(join(root, 'guards', 'absent.md'))).toEqual([])
  })
})

describe('isMemoryFilePath', () => {
  test('recognises the root instruction files and CLAUDE.local.md anywhere', () => {
    expect(isMemoryFilePath(join(root, 'AGENTS.md'))).toBe(true)
    expect(isMemoryFilePath(join(root, 'CLAUDE.md'))).toBe(true)
    expect(isMemoryFilePath(join(root, 'nested', 'CLAUDE.local.md'))).toBe(true)
  })

  test('recognises .md files under a .claudin/rules/ directory', () => {
    expect(
      isMemoryFilePath(join(root, '.claudin', 'rules', 'testing.md')),
    ).toBe(true)
    expect(
      isMemoryFilePath(join(root, '.claudin', 'rules', 'nested', 'deep.md')),
    ).toBe(true)
    // The directory pair is what qualifies it, not the name `rules`.
    expect(isMemoryFilePath(join(root, 'rules', 'testing.md'))).toBe(false)
    // And only .md files qualify.
    expect(
      isMemoryFilePath(join(root, '.claudin', 'rules', 'notes.txt')),
    ).toBe(false)
  })

  test('rejects an ordinary markdown file', () => {
    expect(isMemoryFilePath(join(root, 'README.md'))).toBe(false)
    expect(isMemoryFilePath(`docs${sep}CLAUDE.md.bak`)).toBe(false)
  })
})

describe('getLargeMemoryFiles', () => {
  function file(length: number): MemoryFileInfo {
    return {
      path: `/tmp/f${length}.md`,
      type: 'Project',
      content: 'x'.repeat(length),
    }
  }

  test('the recommended cap is 40000 characters', () => {
    expect(MAX_MEMORY_CHARACTER_COUNT).toBe(40000)
  })

  test('selects only files strictly longer than the cap', () => {
    const short = file(10)
    const exact = file(MAX_MEMORY_CHARACTER_COUNT)
    const over = file(MAX_MEMORY_CHARACTER_COUNT + 1)

    expect(getLargeMemoryFiles([short, exact, over])).toEqual([over])
    expect(getLargeMemoryFiles([])).toEqual([])
  })
})

describe('getExternalClaudeMdIncludes', () => {
  const outside: MemoryFileInfo = {
    path: '/tmp/elsewhere/EXTRA.md',
    type: 'Project',
    content: 'x',
    parent: '/repo/AGENTS.md',
  }

  test('reports an included file living outside the original cwd', () => {
    expect(getExternalClaudeMdIncludes([outside])).toEqual([
      { path: '/tmp/elsewhere/EXTRA.md', parent: '/repo/AGENTS.md' },
    ])
    expect(hasExternalClaudeMdIncludes([outside])).toBe(true)
  })

  test('ignores User memory, files with no parent, and files inside the cwd', () => {
    const userType: MemoryFileInfo = { ...outside, type: 'User' }
    const noParent: MemoryFileInfo = { ...outside, parent: undefined }
    const insideCwd: MemoryFileInfo = {
      ...outside,
      path: join(getOriginalCwd(), 'AGENTS.md'),
    }

    expect(getExternalClaudeMdIncludes([userType, noParent, insideCwd])).toEqual(
      [],
    )
    expect(hasExternalClaudeMdIncludes([userType, noParent, insideCwd])).toBe(
      false,
    )
    expect(hasExternalClaudeMdIncludes([])).toBe(false)
  })
})

describe('clearMemoryFileCaches', () => {
  test('empties the getMemoryFiles memoize cache', () => {
    // Seeded directly so the suite never triggers a real directory walk (which
    // would also fire the InstructionsLoaded hook via the eager-load latch).
    getMemoryFiles.cache.set('sentinel', Promise.resolve([]))
    expect(getMemoryFiles.cache.get('sentinel')).toBeDefined()

    clearMemoryFileCaches()

    expect(getMemoryFiles.cache.get('sentinel')).toBeUndefined()
  })
})

describe('module surface', () => {
  test('exports exactly these runtime names', () => {
    // The only check that sees an over-trimmed barrel after a split — neither
    // the build nor tsc reports a re-export that quietly went missing.
    expect(Object.keys(claudemdModule).sort()).toEqual([
      'MAX_MEMORY_CHARACTER_COUNT',
      'clearMemoryFileCaches',
      'getClaudeMds',
      'getConditionalRulesForCwdLevelDirectory',
      'getExternalClaudeMdIncludes',
      'getLargeMemoryFiles',
      'getManagedAndUserConditionalRules',
      'getMemoryFiles',
      'getMemoryFilesForNestedDirectory',
      'hasExternalClaudeMdIncludes',
      'isMemoryFilePath',
      'processConditionedMdRules',
      'processMdRules',
      'processMemoryFile',
      'resetGetMemoryFilesCache',
      'shouldShowClaudeMdExternalIncludesWarning',
    ])
  })
})
