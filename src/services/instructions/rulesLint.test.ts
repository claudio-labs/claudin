import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  extractProsePaths,
  isCheckableProsePath,
  lintRuleFiles,
} from 'src/services/instructions/rulesLint.js'

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
    expect(isCheckableProsePath('src/services/instructions/claudemd.ts')).toBe(true)
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
      'See `src/services/instructions/claudemd.ts:259-284` and `scripts/build.ts`.',
    )
    expect(found.sort()).toEqual(['scripts/build.ts', 'src/services/instructions/claudemd.ts'])
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
      'AGENTS.md': 'Import from `src/services/config/config.js`.\n',
      'src/services/config/config.ts': 'export {}\n',
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
