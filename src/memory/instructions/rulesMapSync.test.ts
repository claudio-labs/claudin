import { describe, expect, test } from 'bun:test'
import {
  MAP_MARKER,
  existingAnnotations,
  generateRuleMap,
  healRuleMap,
  renderModuleTree,
  scopePatterns,
  syncRuleMap,
} from 'src/memory/instructions/rulesMapSync.js'
import { extractRuleClaims } from 'src/memory/instructions/rulesClaims.js'

/** Tracked-file list with `count` source files under each directory. */
function repo(spec: Record<string, number>, extension = '.ts'): string[] {
  return Object.entries(spec).flatMap(([dir, count]) =>
    Array.from({ length: count }, (_, i) => `${dir}/f${i}${extension}`),
  )
}

describe('healRuleMap', () => {
  const tracked = repo({ 'src/agent': 20, 'src/providers': 40 })

  test('leaves a map alone when nothing drifted past the tolerance', () => {
    const content = ['```', 'src/', '├── agent/ (22)', '```', ''].join('\n')
    expect(healRuleMap({ content, trackedFiles: tracked })).toBe(content)
  })

  test('rewrites a count the tree no longer supports', () => {
    const content = ['```', 'src/', '├── agent/ (140)', '```', ''].join('\n')
    expect(healRuleMap({ content, trackedFiles: tracked })).toContain(
      '├── agent/ (20)',
    )
  })

  test('keeps the annotation column where it was', () => {
    // A number that shrinks by two characters must give two spaces back, or the
    // whole map shears and the diff stops being reviewable.
    const before = '├── agent/ (140)              ← the loop'
    const content = ['```', 'src/', before, '```', ''].join('\n')
    const healed = healRuleMap({ content, trackedFiles: tracked }).split('\n')[2]
    expect(healed).toBe('├── agent/ (20)               ← the loop')
    expect(healed?.indexOf('←')).toBe(before.indexOf('←'))
  })

  test('never touches an annotation, only the numbers', () => {
    const content = [
      '```',
      'src/',
      '├── agent/ (140)              ← the loop, start here',
      '└── providers/ (900)          ← provider abstraction',
      '```',
      '',
    ].join('\n')
    const healed = healRuleMap({ content, trackedFiles: tracked })
    expect(healed).toContain('← the loop, start here')
    expect(healed).toContain('← provider abstraction')
    expect(healed).toContain('agent/ (20)')
    expect(healed).toContain('providers/ (40)')
  })

  test('rewrites a size claim in the form it was written', () => {
    const content = '`shim.ts (the renderer, ~2.2k lines)`\n'
    const healed = healRuleMap({
      content,
      trackedFiles: ['src/shim.ts'],
      fileLines: new Map([['src/shim.ts', 51]]),
    })
    expect(healed).toBe('`shim.ts (the renderer, 51 lines)`\n')
  })

  test('leaves sizes alone when no line counts were supplied', () => {
    const content = '`shim.ts (the renderer, ~2.2k lines)`\n'
    expect(healRuleMap({ content, trackedFiles: ['src/shim.ts'] })).toBe(content)
  })

  test('does not restructure a hand-written map', () => {
    // `rag/` is missing and `gone/` is dead. Both are judgment calls about a
    // curated tree, so the healer reports neither and rewrites neither.
    const content = [
      '```',
      'src/',
      '├── agent/ (20)              ← the loop',
      '└── gone/ (4)                ← retired',
      '```',
      '',
    ].join('\n')
    const healed = healRuleMap({
      content,
      trackedFiles: repo({ 'src/agent': 20, 'src/rag': 9 }),
    })
    expect(healed).toContain('gone/')
    expect(healed).not.toContain('rag/')
  })
})

describe('renderModuleTree', () => {
  const tracked = repo({
    'src/agent': 20,
    'src/agent/ui': 8,
    'src/providers': 40,
    'src/tiny': 1,
    'docs/guide': 12,
  })

  test('names the source directories with their counts', () => {
    const tree = renderModuleTree(tracked).join('\n')
    // `tiny/` is too small to get its own line but still counts toward `src/`.
    expect(tree).toContain('src/ (69)')
    expect(tree).toContain('agent/ (28)')
    expect(tree).toContain('providers/ (40)')
  })

  test('leaves out a directory too small to be worth naming', () => {
    expect(renderModuleTree(tracked).join('\n')).not.toContain('tiny/')
  })

  test('is alphabetical, so two directories trading size churn no diff', () => {
    // Alphabetical within each level: `docs/` before `src/`, and `agent/`
    // before `providers/` under it, regardless of which holds more files.
    const order = renderModuleTree(tracked)
      .map(line => /(\w+)\/ \(/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined)
    expect(order).toEqual(['docs', 'guide', 'src', 'agent', 'providers'])
  })

  test('carries annotations across a regeneration', () => {
    const annotations = new Map([['agent/', 'the loop']])
    expect(renderModuleTree(tracked, annotations).join('\n')).toContain(
      '← the loop',
    )
  })

  test('emits TODO for a directory nobody has explained', () => {
    expect(renderModuleTree(tracked).join('\n')).toContain('← TODO')
  })
})

describe('generateRuleMap', () => {
  test('scopes itself to the languages the repo is written in', () => {
    expect(scopePatterns(repo({ src: 40 }, '.py'))).toEqual(['**/*.py'])
    const map = generateRuleMap(repo({ src: 40 }, '.py'))
    expect(map).toContain('paths:')
    expect(map).toContain('- "**/*.py"')
  })

  test('never ships an unconditional rule', () => {
    // Unconditional means every project pays for it on every turn.
    expect(generateRuleMap(repo({ src: 40 }))).toMatch(/^---\npaths:\n/)
  })

  test('makes only claims the verifier re-derives', () => {
    const claims = extractRuleClaims(generateRuleMap(repo({ src: 40 })))
    expect(claims.attributions).toEqual([])
    expect(claims.lineCounts).toEqual([])
    expect(claims.dirCounts.length).toBeGreaterThan(0)
  })

  test('marks itself as generated so it can be restructured later', () => {
    expect(generateRuleMap(repo({ src: 40 }))).toContain(MAP_MARKER)
  })
})

describe('syncRuleMap', () => {
  test('writes a map when the project has none', () => {
    const written = syncRuleMap({ content: '', trackedFiles: repo({ src: 40 }) })
    expect(written).toContain(MAP_MARKER)
  })

  test('returns null when there is nothing to do', () => {
    const tracked = repo({ 'src/agent': 20 })
    const content = ['```', 'src/', '├── agent/ (22)', '```', ''].join('\n')
    expect(syncRuleMap({ content, trackedFiles: tracked })).toBeNull()
  })

  test('returns null for a repo git knows nothing about', () => {
    expect(syncRuleMap({ content: '', trackedFiles: [] })).toBeNull()
  })

  test('restructures a generated map, keeping the annotations', () => {
    const first = generateRuleMap(repo({ 'src/agent': 20 }))
    const grown = syncRuleMap({
      content: first.replace('← TODO', '← the loop'),
      trackedFiles: repo({ 'src/agent': 20, 'src/rag': 9 }),
    })
    expect(grown).not.toBeNull()
    // The new slice appears, and the sentence someone wrote survives.
    expect(grown).toContain('rag/ (9)')
    expect(grown).toContain('← the loop')
  })

  test('is idempotent — a second sync of its own output is a no-op', () => {
    const tracked = repo({ 'src/agent': 20, 'src/rag': 9 })
    const first = generateRuleMap(tracked)
    expect(syncRuleMap({ content: first, trackedFiles: tracked })).toBeNull()
  })
})

describe('existingAnnotations', () => {
  test('keys the gloss by the directory it describes', () => {
    const found = existingAnnotations(
      ['├── agent/ (489)      ← the agent loop', '└── shared/ (175)     ← bits'].join(
        '\n',
      ),
    )
    expect(found.get('agent/')).toBe('the agent loop')
    expect(found.get('shared/')).toBe('bits')
  })
})
