import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import {
  extractProsePaths,
  isCheckableProsePath,
  lintRuleFiles,
} from 'src/memory/instructions/rulesLint.js'

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ruleslint-'))
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  return root
}

describe('isCheckableProsePath', () => {
  test('accepts concrete relative paths', () => {
    expect(isCheckableProsePath('src/memory/instructions/claudemd.ts')).toBe(true)
    expect(isCheckableProsePath('.claudin/rules/')).toBe(true)
  })

  test('rejects placeholders, globs and home paths', () => {
    expect(isCheckableProsePath('src/tools/<Name>/')).toBe(false)
    expect(isCheckableProsePath('src/**/*.ts')).toBe(false)
    expect(isCheckableProsePath('~/.claudin/settings.json')).toBe(false)
    expect(isCheckableProsePath('src/components/*.tsx')).toBe(false)
    expect(isCheckableProsePath('https://example.com/x')).toBe(false)
  })

  test('rejects bare filenames and prose that merely contains a slash', () => {
    // A bare name does not resolve from the root, so checking it would report a
    // file that exists elsewhere as missing.
    expect(isCheckableProsePath('tsconfig.json')).toBe(false)
    expect(isCheckableProsePath('and/or')).toBe(true) // shape-valid; existence decides
    expect(isCheckableProsePath('git status')).toBe(false)
  })
})

describe('extractProsePaths', () => {
  test('extracts backticked paths and strips line references', () => {
    const found = extractProsePaths(
      'See `src/memory/instructions/claudemd.ts:259-284` and `scripts/build/build.ts`.',
    )
    expect(found.sort()).toEqual(['scripts/build/build.ts', 'src/memory/instructions/claudemd.ts'])
  })

  test('ignores unbackticked paths and placeholder citations', () => {
    expect(extractProsePaths('src/utils/real.ts is not backticked')).toEqual([])
    expect(extractProsePaths('use `src/tools/<Name>/index.ts`')).toEqual([])
  })
})

describe('lintRuleFiles', () => {
  test('flags a rule whose paths match no tracked file (inert)', async () => {
    const root = makeProject({
      '.claudin/rules/a.md': '---\npaths: src/nope/**/*.ts\n---\n# A\n',
    })
    const result = await lintRuleFiles({
      root,
      trackedFiles: ['src/real/thing.ts'],
    })
    const kinds = result.findings.map(f => f.kind)
    expect(kinds).toContain('inert_paths')
  })

  test('does not flag a rule whose paths do match', async () => {
    const root = makeProject({
      '.claudin/rules/a.md': '---\npaths: src/**/*.ts\n---\n# A\n',
    })
    const result = await lintRuleFiles({
      root,
      trackedFiles: ['src/real/thing.ts'],
    })
    expect(result.findings).toEqual([])
    expect(result.unconditional).toEqual([])
  })

  test('flags `globs:` — the key that silently makes a rule unconditional', async () => {
    const root = makeProject({
      '.claudin/rules/a.md': '---\nglobs: src/**/*.ts\n---\n# A\n',
    })
    const result = await lintRuleFiles({ root, trackedFiles: ['src/a.ts'] })
    const finding = result.findings.find(f => f.kind === 'unsupported_key')
    expect(finding).toBeDefined()
    expect(finding!.message).toContain('globs')
    expect(finding!.fix).toContain('paths:')
    // and it is counted against the always-loaded budget
    expect(result.unconditional).toHaveLength(1)
  })

  test('flags a paths value of the wrong shape', async () => {
    const root = makeProject({
      '.claudin/rules/a.md': '---\npaths: 42\n---\n# A\n',
    })
    const result = await lintRuleFiles({ root, trackedFiles: ['src/a.ts'] })
    expect(result.findings.map(f => f.kind)).toContain('malformed_paths')
  })

  test('flags a prose path that no longer exists, and only that one', async () => {
    const root = makeProject({
      '.claudin/rules/a.md':
        '---\npaths: src/**/*.ts\n---\nSee `src/gone.ts` and `src/here.ts`.\n',
      'src/here.ts': 'export {}\n',
    })
    const result = await lintRuleFiles({ root, trackedFiles: ['src/here.ts'] })
    const missing = result.findings.filter(f => f.kind === 'missing_path')
    expect(missing).toHaveLength(1)
    expect(missing[0]!.message).toContain('src/gone.ts')
  })

  test('treats a rule with no frontmatter as intentionally unconditional', async () => {
    const root = makeProject({
      '.claudin/rules/always.md': '# Always on\n',
    })
    const result = await lintRuleFiles({ root, trackedFiles: ['src/a.ts'] })
    expect(result.findings).toEqual([])
    expect(result.unconditional).toHaveLength(1)
    expect(result.unconditionalChars).toBe('# Always on\n'.length)
  })

  test('checks AGENTS.md prose but never its frontmatter', async () => {
    const root = makeProject({
      // `type:` would be an unsupported key on a rule; on a root context file it
      // must not be reported, because AGENTS.md is unconditional by design.
      'AGENTS.md': '---\ntype: project\n---\nSee `src/gone.ts`.\n',
      'src/anchor.ts': 'export {}\n',
    })
    const result = await lintRuleFiles({ root, trackedFiles: ['src/a.ts'] })
    expect(result.findings.map(f => f.kind)).toEqual(['missing_path'])
    expect(result.filesChecked).toBe(1)
  })

  // The budget exists to price what every turn pays for. Counting only the rule
  // files hid the biggest always-on file of all: AGENTS.md takes no `paths:`, so
  // it is unconditional by construction and outweighed every rule combined.
  test('counts the root context files against the always-loaded budget', async () => {
    const agents = '# Agents\n'
    const claude = '# Claude\n'
    const scoped = '---\npaths: src/**/*.ts\n---\n# Scoped\n'
    const root = makeProject({
      'AGENTS.md': agents,
      'CLAUDE.md': claude,
      '.claudin/rules/scoped.md': scoped,
    })
    const result = await lintRuleFiles({ root, trackedFiles: ['src/a.ts'] })
    expect(
      result.unconditional.map(r => r.file.split(sep).pop()).sort(),
    ).toEqual(['AGENTS.md', 'CLAUDE.md'])
    expect(result.unconditionalChars).toBe(agents.length + claude.length)
  })

  test('ignores citations whose first segment is not a project directory', async () => {
    const root = makeProject({
      'AGENTS.md':
        'Package `react/compiler-runtime`, prose `add/rm`, other-repo `Settings/Config.tsx`.\n',
      'src/anchor.ts': 'export {}\n',
    })
    const result = await lintRuleFiles({ root, trackedFiles: [] })
    expect(result.findings).toEqual([])
  })

  test('resolves a `.js` specifier to the TypeScript file on disk', async () => {
    const root = makeProject({
      'AGENTS.md': 'Import from `src/platform/config/config.js`.\n',
      'src/platform/config/config.ts': 'export {}\n',
    })
    const result = await lintRuleFiles({ root, trackedFiles: [] })
    expect(result.findings).toEqual([])
  })

  test('does not flag a path the prose says was removed', async () => {
    const root = makeProject({
      'AGENTS.md':
        'The gRPC service (`src/grpc/`) was removed in #22.\nSee also `src/other.ts`.\n',
      'src/anchor.ts': 'export {}\n',
    })
    const result = await lintRuleFiles({ root, trackedFiles: [] })
    const missing = result.findings.filter(f => f.kind === 'missing_path')
    expect(missing.map(f => f.message)).toEqual([
      'cites `src/other.ts`, which does not exist',
    ])
  })

  test('an empty tracked-file list still runs the inert check', async () => {
    const root = makeProject({
      '.claudin/rules/a.md': '---\npaths: src/nope/**\n---\n# A\n',
    })
    const result = await lintRuleFiles({ root, trackedFiles: [] })
    expect(result.findings.map(f => f.kind)).toContain('inert_paths')
  })

  test('skips the inert check outside a git repo', async () => {
    const root = makeProject({
      '.claudin/rules/a.md': '---\npaths: src/nope/**\n---\n# A\n',
    })
    // No trackedFiles: git ls-files fails in a bare tmpdir, which must mean
    // "cannot tell" rather than "every rule is inert".
    const result = await lintRuleFiles({ root })
    expect(result.findings.map(f => f.kind)).not.toContain('inert_paths')
  })
})

describe('lintRuleFiles — claims inside fenced blocks', () => {
  test('reports a directory the map lists but the tree does not have', async () => {
    const root = makeProject({
      'AGENTS.md': [
        '# Map',
        '',
        '```',
        'src/',
        '├── agent/ (2)                 ← the loop',
        '│   └── gone/                  ← retired slice',
        '```',
        '',
      ].join('\n'),
      'src/agent/model.ts': 'export {}\n',
      'src/agent/other.ts': 'export {}\n',
    })
    const result = await lintRuleFiles({
      root,
      trackedFiles: ['src/agent/model.ts', 'src/agent/other.ts'],
    })
    const missing = result.findings.filter(f => f.kind === 'missing_path')
    expect(missing).toHaveLength(1)
    expect(missing[0]?.message).toContain('src/agent/gone/')
    // The Module Map runs to a hundred lines; a finding without one is a search.
    expect(missing[0]?.line).toBe(6)
  })

  test('accepts a symbol the named file defines, and reports one it imports', async () => {
    const files = {
      'AGENTS.md': '`model.ts (getPrimaryModel, getContextWindowForModel)`\n',
      'src/agent/other.ts': 'export {}\n',
    }
    const trackedFiles = ['src/agent/model.ts', 'src/agent/other.ts']

    const defines = await lintRuleFiles({
      root: makeProject({
        ...files,
        'src/agent/model.ts':
          'export function getPrimaryModel() {}\nexport const getContextWindowForModel = () => 0\n',
      }),
      trackedFiles,
    })
    expect(defines.findings.filter(f => f.kind === 'wrong_attribution')).toEqual(
      [],
    )

    const imports = await lintRuleFiles({
      root: makeProject({
        ...files,
        'src/agent/model.ts':
          "import { getContextWindowForModel } from 'src/x.js'\nexport function getPrimaryModel() {}\n",
      }),
      trackedFiles,
    })
    const wrong = imports.findings.filter(f => f.kind === 'wrong_attribution')
    expect(wrong).toHaveLength(1)
    expect(wrong[0]?.message).toContain('getContextWindowForModel')
    expect(wrong[0]?.message).not.toContain('`getPrimaryModel`,')
  })

  test('counts a re-exported name as defined', async () => {
    const root = makeProject({
      'AGENTS.md': '`barrel.ts (someHelper)`\n',
      'src/barrel.ts': "export { someHelper } from 'src/impl.js'\n",
    })
    const result = await lintRuleFiles({ root, trackedFiles: ['src/barrel.ts'] })
    expect(result.findings.filter(f => f.kind === 'wrong_attribution')).toEqual(
      [],
    )
  })

  test('says nothing about a barrel that re-exports the world', async () => {
    const root = makeProject({
      'AGENTS.md': '`barrel.ts (someHelper)`\n',
      'src/barrel.ts': "export * from 'src/impl.js'\n",
    })
    const result = await lintRuleFiles({ root, trackedFiles: ['src/barrel.ts'] })
    expect(result.findings.filter(f => f.kind === 'wrong_attribution')).toEqual(
      [],
    )
  })

  test('reports a size claim that is off by an order of magnitude', async () => {
    const root = makeProject({
      'AGENTS.md': '`shim.ts (the renderer, ~2.2k lines)`\n',
      'src/shim.ts': 'export {}\n',
    })
    const result = await lintRuleFiles({ root, trackedFiles: ['src/shim.ts'] })
    const stale = result.findings.filter(f => f.kind === 'stale_line_count')
    expect(stale).toHaveLength(1)
    expect(stale[0]?.message).toContain('is ~2,200 lines; it is 1')
  })

  test('reports a directory count only once the slice has really moved', async () => {
    const trackedFiles = Array.from(
      { length: 20 },
      (_, i) => `src/agent/f${i}.ts`,
    )
    const files = Object.fromEntries(
      trackedFiles.map(path => [path, 'export {}\n']),
    )

    const withinTolerance = await lintRuleFiles({
      root: makeProject({
        ...files,
        'AGENTS.md': ['```', 'src/', '├── agent/ (22)', '```', ''].join('\n'),
      }),
      trackedFiles,
    })
    expect(
      withinTolerance.findings.filter(f => f.kind === 'dir_count_drift'),
    ).toEqual([])

    const moved = await lintRuleFiles({
      root: makeProject({
        ...files,
        'AGENTS.md': ['```', 'src/', '├── agent/ (140)', '```', ''].join('\n'),
      }),
      trackedFiles,
    })
    const drift = moved.findings.filter(f => f.kind === 'dir_count_drift')
    expect(drift).toHaveLength(1)
    expect(drift[0]?.message).toContain('holds 140 files; it holds 20')
  })

  test('skips every claim whose file the tracked list cannot identify', async () => {
    const root = makeProject({
      'AGENTS.md': '`shim.ts (the renderer, ~2.2k lines)`\n',
      'src/a/shim.ts': 'export {}\n',
      'src/b/shim.ts': 'export {}\n',
    })
    const result = await lintRuleFiles({
      root,
      trackedFiles: ['src/a/shim.ts', 'src/b/shim.ts'],
    })
    expect(result.findings).toEqual([])
  })

  test('checks nothing in a fenced block outside a git repo', async () => {
    const root = makeProject({
      'AGENTS.md': ['```', 'src/', '├── gone/ (9)', '```', ''].join('\n'),
      'src/anchor.ts': 'export {}\n',
    })
    // No trackedFiles and no git: counts and basenames are unresolvable, so the
    // whole fenced pass must stay silent rather than report the map as wrong.
    const result = await lintRuleFiles({ root })
    expect(result.findings).toEqual([])
  })
})
