/**
 * Characterization of the per-file half of the instruction loader, through the
 * barrel `src/memory/instructions/claudemd.ts`:
 *
 * - `processMemoryFile`: one file, its frontmatter, its HTML comments and the
 *   files it pulls in with `@path`;
 * - `processMdRules`: a `.claudin/rules` directory;
 * - the nested-directory loaders the Read tool's attachments use;
 * - the small predicates (`isMemoryFilePath`, `getLargeMemoryFiles`,
 *   `getExternalClaudeMdIncludes`).
 *
 * Every test gets a fresh directory under the system temp directory, and the
 * session's original cwd is pointed at it, so `@path` targets inside it count
 * as internal. Fixtures that stand for real files are in
 * `__fixtures__/rewrite/`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, relative, sep } from 'path'
// One line per import: the provenance measure skips import statements.
import { getConditionalRulesForCwdLevelDirectory, getExternalClaudeMdIncludes, getLargeMemoryFiles, getManagedAndUserConditionalRules, getMemoryFilesForNestedDirectory, hasExternalClaudeMdIncludes, isMemoryFilePath, MAX_MEMORY_CHARACTER_COUNT, type MemoryFileInfo, processConditionedMdRules, processMdRules, processMemoryFile } from 'src/memory/instructions/claudemd.js'
import type { MemoryType } from 'src/memory/memdir/types.js'
import { getAllowedSettingSources, getOriginalCwd, setAllowedSettingSources, setOriginalCwd } from 'src/platform/bootstrap/state.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getManagedFilePath } from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'

const FIXTURES = join(import.meta.dir, '__fixtures__', 'rewrite')
const ALL_SOURCES: SettingSource[] = ['policySettings', 'flagSettings', 'userSettings', 'projectSettings', 'localSettings']
const IS_ROOT = process.getuid?.() === 0

let root: string
const saved = { cwd: '', sources: [] as SettingSource[], configDir: undefined as string | undefined }

function write(rel: string, text: string): string {
  const path = join(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

const at = (rel: string): string => join(root, rel)
const local = (path: string): string => relative(root, path)

async function load(rel: string, opts: { type?: MemoryType; external?: boolean; seen?: Set<string> } = {}): Promise<MemoryFileInfo[]> {
  return processMemoryFile(at(rel), opts.type ?? 'Project', opts.seen ?? new Set(), opts.external ?? true)
}

/** The paths a load returned, in its order, relative to the test directory. */
async function loadedPaths(rel: string, opts?: Parameters<typeof load>[1]): Promise<string[]> {
  return (await load(rel, opts)).map(f => local(f.path))
}

async function rulesIn(rel: string, conditionalRule: boolean, seen = new Set<string>()): Promise<string[]> {
  const files = await processMdRules({ rulesDir: at(rel), type: 'Project', processedPaths: seen, includeExternal: true, conditionalRule })
  return files.map(f => local(f.path)).sort()
}

beforeAll(() => {
  saved.cwd = getOriginalCwd()
  saved.sources = [...getAllowedSettingSources()]
  saved.configDir = process.env.CLAUDIN_CONFIG_DIR
})

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'claudemd-files-')))
  setOriginalCwd(root)
  setAllowedSettingSources(ALL_SOURCES)
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  getManagedFilePath.cache.set(undefined, join(root, 'managed'))
  resetSettingsCache()
})

afterAll(() => {
  setOriginalCwd(saved.cwd)
  setAllowedSettingSources(saved.sources)
  if (saved.configDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = saved.configDir
  getManagedFilePath.cache.clear?.()
  resetSettingsCache()
  rmSync(root, { recursive: true, force: true })
})

describe('processMemoryFile: one file', () => {
  test('a plain file comes back as written, flagged as matching the disk', async () => {
    write('AGENTS.md', '# Rules\n\nUse bun.\n')

    const [only, ...rest] = await load('AGENTS.md', { type: 'Local' })

    expect(rest).toEqual([])
    expect(only).toEqual({ path: at('AGENTS.md'), type: 'Local', content: '# Rules\n\nUse bun.\n', globs: undefined, contentDiffersFromDisk: false, rawContent: undefined })
  })

  test('nothing comes back for a file that is missing, blank, a directory, or already seen', async () => {
    write('blank.md', ' \n\t\n')
    mkdirSync(at('folder.md'))
    write('seen.md', 'text\n')
    const seen = new Set<string>()
    await load('seen.md', { seen })

    const outcomes = await Promise.all(['missing.md', 'blank.md', 'folder.md'].map(rel => loadedPaths(rel)))

    expect(outcomes).toEqual([[], [], []])
    expect(await loadedPaths('seen.md', { seen })).toEqual([])
  })

  test.skipIf(IS_ROOT)('an unreadable file gives nothing and does not throw', async () => {
    const path = write('locked.md', 'secret\n')
    chmodSync(path, 0o000)

    expect(await loadedPaths('locked.md')).toEqual([])
    chmodSync(path, 0o644)
  })

  test('every path it visits goes into the set, the file\'s own first', async () => {
    write('a.md', 'a\n\n@./b.md\n')
    write('b.md', 'b\n')
    const seen = new Set<string>()

    await load('a.md', { seen })

    expect([...seen].map(local)).toEqual(['a.md', 'b.md'])
  })

  test('a missing file is still recorded as visited', async () => {
    const seen = new Set<string>()

    await load('missing.md', { seen })

    expect([...seen].map(local)).toEqual(['missing.md'])
  })

  test('the parent argument is put on the returned entry', async () => {
    write('child.md', 'child\n')

    const [entry] = await processMemoryFile(at('child.md'), 'User', new Set(), true, 0, '/somewhere/CLAUDE.md')

    expect(entry?.parent).toBe('/somewhere/CLAUDE.md')
  })
})

describe('processMemoryFile: frontmatter', () => {
  test('the scoped-rule fixture: paths become globs, the body is the content, the disk bytes ride along', async () => {
    const raw = readFileSync(join(FIXTURES, 'path-scoped-rule.md'), 'utf8')
    write('rule.md', raw)

    const [entry] = await load('rule.md')

    expect(entry?.globs).toEqual(['src/memory/**/*.ts', 'src/memory/**/*.tsx', 'docs/tech/memory'])
    expect(entry?.content).toBe(raw.slice(raw.indexOf('# Memory loader')))
    expect(entry?.contentDiffersFromDisk).toBe(true)
    expect(entry?.rawContent).toBe(raw)
  })

  const shapes: Array<[string, string, string[] | undefined]> = [
    ['a single string', '---\npaths: lib/**\n---\nbody\n', ['lib']],
    ['a comma list with braces', '---\npaths: "a/*.{ts,tsx}, b"\n---\nbody\n', ['a/*.ts', 'a/*.tsx', 'b']],
    ['only the match-all pattern', '---\npaths: "**"\n---\nbody\n', undefined],
    ['no paths key', '---\ntitle: x\n---\nbody\n', undefined],
    ['frontmatter that never closes', '---\npaths: lib/**\nbody\n', undefined],
  ]
  test.each(shapes)('paths given as %s', async (_name, text, globs) => {
    write('shape.md', text)

    const [entry] = await load('shape.md')

    expect(entry?.globs).toEqual(globs)
  })

  test('a file that is only frontmatter gives nothing', async () => {
    write('empty-body.md', '---\npaths: lib/**\n---\n\n')

    expect(await loadedPaths('empty-body.md')).toEqual([])
  })
})

describe('processMemoryFile: HTML comments', () => {
  // Each case: the file as written, and the content expected back (UNCHANGED: byte for byte).
  const UNCHANGED = Symbol('unchanged')
  const commentCases: Record<string, readonly [string, string | typeof UNCHANGED]> = {
    'a block comment of its own goes': ['# T\n\n<!--\nhidden\n-->\n\nshown\n', '# T\n\nshown\n'],
    'text after the closing marker on its line stays': ['<!-- note --> kept words\n', ' kept words\n'],
    'two comments on one line both go': ['<!-- one --> mid <!-- two --> end\n', ' mid  end\n'],
    'a comment inside a paragraph stays': ['Use bun <!-- inline --> always.\n', UNCHANGED],
    'a comment that never closes stays': ['a\n\n<!-- open\n\nnever closed\n', UNCHANGED],
    'a comment inside a code fence stays': ['```\n<!-- in code -->\n```\n', UNCHANGED],
  }
  test.each(Object.entries(commentCases))('%s', async (_name, [text, expected]) => {
    write('c.md', text)

    const [entry] = await load('c.md')
    // How many blank lines a removed block leaves behind is not part of the contract.
    const squeezed = entry?.content.replace(/\n{3,}/g, '\n\n')

    if (expected === UNCHANGED) {
      expect(entry?.content).toBe(text)
      expect(entry?.contentDiffersFromDisk).toBe(false)
    } else {
      expect(squeezed).toBe(expected)
      expect(entry?.contentDiffersFromDisk).toBe(true)
    }
  })

  test('a file that is only a comment gives nothing', async () => {
    write('only-comment.md', '<!-- nothing else -->\n')

    expect(await loadedPaths('only-comment.md')).toEqual([])
  })

  test('CRLF: untouched without a comment; once a comment is stripped, the line ends become LF', async () => {
    write('plain-crlf.md', 'one\r\ntwo\r\n')
    write('comment-crlf.md', 'one\r\n\r\n<!-- c -->\r\n\r\ntwo\r\n')

    const [plain] = await load('plain-crlf.md')
    const [stripped] = await load('comment-crlf.md')

    expect(plain).toMatchObject({ content: 'one\r\ntwo\r\n', contentDiffersFromDisk: false })
    expect(stripped?.content).not.toContain('\r')
    expect(stripped?.content).toContain('one\n')
    expect(stripped?.content).toContain('two\n')
  })
})

describe('processMemoryFile: @include', () => {
  test('the fixture: which @ references are followed, in document order, after the includer', async () => {
    const host = readFileSync(join(FIXTURES, 'instructions-with-includes.md'), 'utf8')
    write('docs/AGENTS.md', host)
    const targets = ['docs/plain.md', 'docs/dotted.md', 'docs/sub/deep.md', 'up.md', 'docs/my notes.md', 'docs/anchor.md', 'docs/after-comment.md', 'docs/in-list.md', 'docs/in-quote.md', 'docs/in-heading.md', 'docs/fenced.md', 'docs/in-code.md', 'docs/hidden.md', 'docs/mail.md', 'docs/twice.md']
    for (const target of targets) write(target, `${target}\n`)
    write('docs/absolute.md', 'absolute\n')
    writeFileSync(at('docs/AGENTS.md'), host.replace('@ABSOLUTE', `@${at('docs/absolute.md')}`))

    expect(await loadedPaths('docs/AGENTS.md')).toEqual([
      'docs/AGENTS.md',
      'docs/plain.md',
      'docs/dotted.md',
      'docs/sub/deep.md',
      'up.md',
      'docs/my notes.md',
      'docs/anchor.md',
      'docs/absolute.md',
      'docs/after-comment.md',
      'docs/in-list.md',
      'docs/in-quote.md',
      'docs/in-heading.md',
      'docs/twice.md',
    ])
  })

  test('not followed: a bare @/, a doubled @, a symbol after @, an @ glued to a word, an @ in inline code', async () => {
    write('twice.md', 'target\n')
    write('star.md', 'target\n')
    const forms = ['see @/ here', 'see @@twice.md', 'see @#heading and @*star.md', 'mail team@twice.md', 'run `@./twice.md`']
    write('host.md', `${forms.join('\n\n')}\n`)

    expect(await loadedPaths('host.md')).toEqual(['host.md'])
  })

  test('included files take the includer\'s type and name it as parent', async () => {
    write('a.md', '@./b.md\n')
    write('b.md', 'b\n\n@./c.md\n')
    write('c.md', 'c\n')

    const files = await load('a.md', { type: 'User' })

    expect(files.map(f => [local(f.path), f.type, f.parent ? local(f.parent) : null])).toEqual([
      ['a.md', 'User', null],
      ['b.md', 'User', 'a.md'],
      ['c.md', 'User', 'b.md'],
    ])
  })

  test('depth-first, each file at most once, cycles included', async () => {
    write('a.md', '@./b.md\n\n@./c.md\n\n@./a.md\n')
    write('b.md', '@./shared.md\n\n@./a.md\n')
    write('c.md', '@./shared.md\n')
    write('shared.md', 'shared\n')

    expect(await loadedPaths('a.md')).toEqual(['a.md', 'b.md', 'shared.md', 'c.md'])
  })

  test('the chain stops after four levels below the first file', async () => {
    for (let level = 0; level <= 6; level++) write(`l${level}.md`, level < 6 ? `l${level}\n\n@./l${level + 1}.md\n` : 'l6\n')

    expect(await loadedPaths('l0.md')).toEqual(['l0.md', 'l1.md', 'l2.md', 'l3.md', 'l4.md'])
  })

  test('the depth argument counts toward the same limit', async () => {
    write('x.md', 'x\n\n@./y.md\n')
    write('y.md', 'y\n')
    const fromDepth = (depth: number) => processMemoryFile(at('x.md'), 'Project', new Set(), true, depth).then(files => files.map(f => local(f.path)))

    expect(await Promise.all([3, 4, 5].map(fromDepth))).toEqual([['x.md', 'y.md'], ['x.md'], []])
  })

  const extensions: Array<[string, boolean]> = [
    ['notes.txt', true],
    ['data.json', true],
    ['script.ts', true],
    ['build.gradle', true],
    ['UPPER.TXT', true],
    ['Makefile', true],
    ['logo.png', false],
    ['manual.pdf', false],
    ['tool.exe', false],
    ['archive.zip', false],
  ]
  test('which include targets are read, by extension', async () => {
    for (const [name] of extensions) write(`ext/${name}`, `${name} is text\n`)
    write('ext/host.md', extensions.map(([name]) => `@./${name}`).join('\n\n'))

    const loaded = new Set((await loadedPaths('ext/host.md')).map(p => p.slice('ext/'.length)))

    expect(extensions.map(([name]) => [name, loaded.has(name)])).toEqual(extensions)
  })

  test('without includeExternal, a target outside the original cwd is dropped, while the file itself still loads', async () => {
    write('outside/host.md', 'host\n\n@./sibling.md\n\n@../inside/near.md\n')
    write('outside/sibling.md', 'sibling\n')
    write('inside/near.md', 'near\n')
    setOriginalCwd(at('inside'))

    expect(await loadedPaths('outside/host.md', { external: false })).toEqual(['outside/host.md', 'inside/near.md'])
    expect(await loadedPaths('outside/host.md', { external: true })).toEqual(['outside/host.md', 'outside/sibling.md', 'inside/near.md'])
  })

  test('a linked file reports the link\'s path, resolves its includes next to the target, and marks the target as seen', async () => {
    write('shared/real.md', 'real\n\n@./beside-target.md\n')
    write('shared/beside-target.md', 'beside the target\n')
    write('project/beside-link.md', 'beside the link\n')
    symlinkSync(at('shared/real.md'), at('project/AGENTS.md'))
    const seen = new Set<string>()

    expect(await loadedPaths('project/AGENTS.md', { seen })).toEqual(['project/AGENTS.md', 'shared/beside-target.md'])
    expect(await loadedPaths('shared/real.md', { seen })).toEqual([])
  })

  test('a link is followed wherever it points, and an extensionless target is read', async () => {
    write('private/id_key', 'not meant for the model\n')
    symlinkSync(at('private/id_key'), at('repo-notes'))
    write('AGENTS.md', 'see @./repo-notes\n')
    setOriginalCwd(root)

    const files = await load('AGENTS.md', { external: false })

    expect(files.map(f => [local(f.path), f.content])).toEqual([
      ['AGENTS.md', 'see @./repo-notes\n'],
      ['repo-notes', 'not meant for the model\n'],
    ])
  })
})

describe('processMdRules', () => {
  beforeEach(() => {
    write('rules/always.md', 'always\n')
    write('rules/scoped.md', '---\npaths: src/**\n---\nscoped\n')
    write('rules/team/deep.md', 'deep\n')
    write('rules/team/deep-scoped.md', '---\npaths: lib/**\n---\nscoped deep\n')
    write('rules/.dot.md', 'dot\n')
    write('rules/readme.txt', 'not a rule\n')
  })

  test('the unconditional pass keeps files without paths, the conditional pass those with', async () => {
    expect(await rulesIn('rules', false)).toEqual(['rules/.dot.md', 'rules/always.md', 'rules/team/deep.md'])
    expect(await rulesIn('rules', true)).toEqual(['rules/scoped.md', 'rules/team/deep-scoped.md'])
  })

  test('either pass marks every rule file it read as seen', async () => {
    const seen = new Set<string>()
    await rulesIn('rules', false, seen)

    expect(await rulesIn('rules', true, seen)).toEqual([])
  })

  test('a missing directory, or a file in its place, gives nothing', async () => {
    write('not-a-dir', 'file\n')

    expect([await rulesIn('nowhere', false), await rulesIn('not-a-dir', false)]).toEqual([[], []])
  })

  test('links: a linked file and a linked directory are read, and reported at their targets', async () => {
    write('library/linked-file.md', 'from a link\n')
    write('library/pack/packed.md', 'from a linked directory\n')
    symlinkSync(at('library/linked-file.md'), at('rules/alias.md'))
    symlinkSync(at('library/pack'), at('rules/pack'))

    const found = await rulesIn('rules', false)

    expect(found).toContain('library/linked-file.md')
    expect(found).toContain('library/pack/packed.md')
    expect(found).not.toContain('rules/alias.md')
  })

  test('the link name decides: a .md link to a .txt target counts, a .txt link to a .md target does not', async () => {
    write('library/target.txt', 'text target\n')
    write('library/target.md', 'markdown target\n')
    symlinkSync(at('library/target.txt'), at('rules/named.md'))
    symlinkSync(at('library/target.md'), at('rules/named.txt'))

    const found = await rulesIn('rules', false)

    expect(found).toContain('library/target.txt')
    expect(found).not.toContain('library/target.md')
  })

  test('a dangling link is skipped and the rest still load; a link loop ends', async () => {
    symlinkSync(at('nothing-here.md'), at('rules/dangling.md'))
    symlinkSync(at('rules'), at('rules/team/loop'))

    expect(await rulesIn('rules', false)).toEqual(['rules/.dot.md', 'rules/always.md', 'rules/team/deep.md'])
  })

  test.skipIf(IS_ROOT)('an unreadable subdirectory is skipped and the rest still load', async () => {
    chmodSync(at('rules/team'), 0o000)

    try {
      expect(await rulesIn('rules', false)).toEqual(['rules/.dot.md', 'rules/always.md'])
    } finally {
      chmodSync(at('rules/team'), 0o755)
    }
  })

  test('includes in a rule are followed', async () => {
    write('rules/always.md', 'always\n\n@../extra/more.md\n')
    write('extra/more.md', 'more\n')

    expect(await rulesIn('rules', false)).toContain('extra/more.md')
  })
})

describe('conditional rules for a target file', () => {
  /** A project at <root>/proj with rules scoped to parts of it. */
  function project(): string {
    write('proj/.claudin/rules/api.md', '---\npaths: src/api/**\n---\napi rule\n')
    write('proj/.claudin/rules/tests.md', '---\npaths: "*.test.ts"\n---\ntest rule\n')
    write('proj/.claudin/rules/always.md', 'unscoped\n')
    return at('proj')
  }

  const targets: Array<[string, string, string[]]> = [
    ['a file under the scoped directory', 'proj/src/api/routes.ts', ['proj/.claudin/rules/api.md']],
    ['a test file at any depth', 'proj/src/api/routes.test.ts', ['proj/.claudin/rules/api.md', 'proj/.claudin/rules/tests.md']],
    ['a file nothing scopes', 'proj/README.md', []],
    ['a file outside the project', 'elsewhere/src/api/routes.ts', []],
    ['the project directory itself', 'proj', []],
  ]
  test.each(targets)('getConditionalRulesForCwdLevelDirectory: %s', async (_name, target, expected) => {
    const dir = project()

    const files = await getConditionalRulesForCwdLevelDirectory(dir, at(target), new Set())

    expect(files.map(f => local(f.path)).sort()).toEqual(expected)
    expect(files.every(f => f.type === 'Project' && (f.globs?.length ?? 0) > 0)).toBe(true)
  })

  test('a relative target is matched as written, against the directory holding .claudin', async () => {
    const dir = project()

    const files = await getConditionalRulesForCwdLevelDirectory(dir, 'src/api/x.ts', new Set())

    expect(files.map(f => local(f.path))).toEqual(['proj/.claudin/rules/api.md'])
  })

  test('processConditionedMdRules anchors user and managed globs at the original cwd, not at the rules directory', async () => {
    write('somewhere/rules/web.md', '---\npaths: web/**\n---\nweb rule\n')
    setOriginalCwd(at('workspace'))
    const run = (type: MemoryType, target: string) => processConditionedMdRules(at(target), at('somewhere/rules'), type, new Set(), false).then(f => f.map(x => local(x.path)))

    expect(await run('User', 'workspace/web/page.ts')).toEqual(['somewhere/rules/web.md'])
    expect(await run('Managed', 'workspace/web/page.ts')).toEqual(['somewhere/rules/web.md'])
    expect(await run('User', 'somewhere/web/page.ts')).toEqual([])
  })

  test('getManagedAndUserConditionalRules: managed first, then user; user rules only with user settings on', async () => {
    write('managed/.claudin/rules/policy.md', '---\npaths: "**/*.sql"\n---\npolicy\n')
    write('config/rules/mine.md', '---\npaths: "**/*.sql"\n---\nmine\n')
    write('config/rules/other.md', '---\npaths: "**/*.go"\n---\nother\n')
    write('config/rules/unscoped.md', 'unscoped\n')
    const target = at('db/schema.sql')

    const both = await getManagedAndUserConditionalRules(target, new Set())
    setAllowedSettingSources(['projectSettings', 'localSettings'])
    const managedOnly = await getManagedAndUserConditionalRules(target, new Set())

    expect(both.map(f => `${f.type} ${local(f.path)}`)).toEqual(['Managed managed/.claudin/rules/policy.md', 'User config/rules/mine.md'])
    expect(managedOnly.map(f => `${f.type} ${local(f.path)}`)).toEqual(['Managed managed/.claudin/rules/policy.md'])
  })
})

describe('getMemoryFilesForNestedDirectory', () => {
  function nested(): string {
    write('proj/sub/AGENTS.md', 'sub agents\n\n@./inside.md\n\n@../../beyond.md\n')
    write('proj/sub/CLAUDE.md', 'never read beside AGENTS.md\n')
    write('proj/sub/inside.md', 'inside\n')
    write('beyond.md', 'outside the cwd\n')
    write('proj/sub/.claudin/CLAUDE.md', 'sub dot-dir\n')
    write('proj/sub/CLAUDE.local.md', 'sub local\n')
    write('proj/sub/.claudin/rules/plain.md', 'sub unconditional\n')
    write('proj/sub/.claudin/rules/ts.md', '---\npaths: "**/*.ts"\n---\nts only\n')
    setOriginalCwd(at('proj'))
    return at('proj/sub')
  }

  const rows = (files: MemoryFileInfo[]) => files.map(f => `${f.type} ${local(f.path)}`)

  test('instruction files, local file, unconditional rules, then the rules that match the target', async () => {
    const dir = nested()

    expect(rows(await getMemoryFilesForNestedDirectory(dir, at('proj/sub/x.ts'), new Set()))).toEqual([
      'Project proj/sub/AGENTS.md',
      'Project proj/sub/inside.md',
      'Project proj/sub/.claudin/CLAUDE.md',
      'Local proj/sub/CLAUDE.local.md',
      'Project proj/sub/.claudin/rules/plain.md',
      'Project proj/sub/.claudin/rules/ts.md',
    ])
  })

  test('a target the scoped rule does not match leaves it out', async () => {
    const dir = nested()

    expect(rows(await getMemoryFilesForNestedDirectory(dir, at('proj/sub/x.py'), new Set()))).not.toContain('Project proj/sub/.claudin/rules/ts.md')
  })

  test('setting sources gate the instruction and local files, not the rules', async () => {
    const dir = nested()
    setAllowedSettingSources([])

    expect(rows(await getMemoryFilesForNestedDirectory(dir, at('proj/sub/x.ts'), new Set()))).toEqual([
      'Project proj/sub/.claudin/rules/plain.md',
      'Project proj/sub/.claudin/rules/ts.md',
    ])
  })

  test('afterwards every rule file of the directory counts as seen, matched or not', async () => {
    const dir = nested()
    const seen = new Set<string>()
    await getMemoryFilesForNestedDirectory(dir, at('proj/sub/x.py'), seen)

    expect(await getMemoryFilesForNestedDirectory(dir, at('proj/sub/x.ts'), seen)).toEqual([])
  })
})

describe('the predicates', () => {
  const paths: Array<[string, boolean]> = [
    [['', 'r', 'AGENTS.md'].join(sep), true],
    [['', 'r', 'deep', 'CLAUDE.md'].join(sep), true],
    [['', 'r', 'CLAUDE.local.md'].join(sep), true],
    [['', 'r', '.claudin', 'CLAUDE.md'].join(sep), true],
    [['', 'r', '.claudin', 'rules', 'style.md'].join(sep), true],
    [['', 'r', '.claudin', 'rules', 'a', 'b.md'].join(sep), true],
    [['', 'r', '.claudin', 'rules', 'notes.txt'].join(sep), false],
    [['', 'r', 'rules', 'style.md'].join(sep), false],
    [['', 'r', '.claude', 'rules', 'style.md'].join(sep), false],
    [['', 'r', 'agents.md'].join(sep), false],
    [['', 'r', 'CLAUDE.md.bak'].join(sep), false],
    [['', 'r', 'README.md'].join(sep), false],
    ['AGENTS.md', true],
  ]
  test('isMemoryFilePath', () => {
    expect(paths.map(([path]) => [path, isMemoryFilePath(path)])).toEqual(paths)
  })

  test('getLargeMemoryFiles keeps files strictly over 40,000 characters', () => {
    const sized = (n: number): MemoryFileInfo => ({ path: `/f${n}`, type: 'Project', content: 'y'.repeat(n) })
    const files = [sized(1), sized(40_000), sized(40_001), sized(90_000)]

    expect(MAX_MEMORY_CHARACTER_COUNT).toBe(40_000)
    expect(getLargeMemoryFiles(files).map(f => f.path)).toEqual(['/f40001', '/f90000'])
  })

  test('getExternalClaudeMdIncludes: included, not user, and outside the original cwd', () => {
    setOriginalCwd('/work/project')
    const files: MemoryFileInfo[] = [
      { path: '/work/elsewhere/a.md', type: 'Project', content: 'a', parent: '/work/project/AGENTS.md' },
      { path: '/work/elsewhere/b.md', type: 'Local', content: 'b', parent: '/work/project/CLAUDE.local.md' },
      { path: '/opt/policy/c.md', type: 'Managed', content: 'c', parent: '/etc/x/CLAUDE.md' },
      { path: '/home/me/d.md', type: 'User', content: 'd', parent: '/home/me/.claudin/CLAUDE.md' },
      { path: '/work/project/docs/e.md', type: 'Project', content: 'e', parent: '/work/project/AGENTS.md' },
      { path: '/work/elsewhere/f.md', type: 'Project', content: 'f' },
    ]

    expect(getExternalClaudeMdIncludes(files)).toEqual([
      { path: '/work/elsewhere/a.md', parent: '/work/project/AGENTS.md' },
      { path: '/work/elsewhere/b.md', parent: '/work/project/CLAUDE.local.md' },
      { path: '/opt/policy/c.md', parent: '/etc/x/CLAUDE.md' },
    ])
    expect([hasExternalClaudeMdIncludes(files), hasExternalClaudeMdIncludes(files.slice(3))]).toEqual([true, false])
  })
})
