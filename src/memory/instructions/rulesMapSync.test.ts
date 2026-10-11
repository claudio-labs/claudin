import { describe, expect, test } from 'bun:test'
import {
  MAP_MARKER,
  describeRuleMapWrite,
  diffRuleMapCounts,
  existingAnnotations,
  generateRuleMap,
  healRuleMap,
  isHealerOnlyDiff,
  renderModuleTree,
  ruleMapKind,
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

  test('leaves a dead directory for the verifier instead of healing it to zero', () => {
    // `(0)` is a number nobody reads twice, so writing it launders a directory
    // that died or moved into something that looks maintained.
    const content = ['```', 'src/', '└── gone/ (4)', '```', ''].join('\n')
    const healed = healRuleMap({
      content,
      trackedFiles: repo({ 'src/agent': 20 }),
    })
    expect(healed).toBe(content)
    expect(healed).not.toContain('(0)')
  })

  test('rewrites the count that belongs to the entry, not the first on the line', () => {
    // Two siblings on one line carrying the SAME number, where only the second
    // drifted: searching from the start of the line healed the correct claim to
    // the wrong directory's count and left the wrong claim standing.
    const content = [
      '```',
      'src/',
      '├── plans/ (5)  goal/ (5)',
      '```',
      '',
    ].join('\n')
    const healed = healRuleMap({
      content,
      trackedFiles: repo({ 'src/plans': 5, 'src/goal': 40 }),
    }).split('\n')[2]
    expect(healed).toBe('├── plans/ (5)  goal/ (40)')
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
    expect(order).toEqual(['docs', 'guide', 'src', 'agent', 'ui', 'providers'])
  })

  test('descends past the immediate children when the lines are there', () => {
    // `src/agent/ui/` is a grandchild of the root, and the connectors in front
    // of it encode its whole ancestry: `src/` was the last top so its column is
    // blank, `agent/` was not so its bar continues.
    expect(renderModuleTree(tracked).join('\n')).toContain(
      '    │   └── ui/ (8)',
    )
  })

  test('stops descending when the next level would blow the budget', () => {
    // Two levels always render; a third only when the whole tree still fits.
    // 20 grandchildren is fine, 120 is a file nobody reads that every matching
    // edit re-reads anyway.
    const spec: Record<string, number> = {}
    for (let top = 0; top < 10; top++) {
      for (let mid = 0; mid < 6; mid++) {
        for (let leaf = 0; leaf < 4; leaf++) {
          spec[`top${top}/mid${mid}/leaf${leaf}`] = 3
        }
      }
    }
    const tree = renderModuleTree(repo(spec)).join('\n')
    expect(tree).toContain('mid0/ (12)')
    expect(tree).not.toContain('leaf0/')
  })

  test('never draws deeper than four levels, however deep the repo nests', () => {
    const deep = repo({ 'a/b/c/d/e': 9 })
    const tree = renderModuleTree(deep).join('\n')
    expect(tree).toContain('d/ (9)')
    expect(tree).not.toContain('e/')
  })

  test('lines the annotations up on one column when a deep name overruns it', () => {
    // The fixed column is a floor, not a cap: a depth-4 entry with a long name
    // pushes every `←` right rather than leaving its own annotation jammed
    // against the count.
    const long = repo({
      'src/providers/transport/reallyLongDirectoryName': 5,
      'src/agent': 4,
    })
    const columns = renderModuleTree(long).map(line => line.indexOf('←'))
    expect(new Set(columns).size).toBe(1)
    expect(columns[0]).toBeGreaterThan(34)
  })

  test('a deep entry resolves back to its full path for the parser', () => {
    // Annotations and healing are both keyed by the path the claim parser
    // reconstructs from the indentation, so a level the renderer can draw but
    // the parser cannot walk silently loses every gloss under it.
    const map = generateRuleMap(tracked)
    const paths = extractRuleClaims(map).dirCounts.map(claim => claim.path)
    expect(paths).toContain('src/agent/ui/')
  })

  test('carries annotations across a regeneration', () => {
    // Keyed by full path: the bare name is ambiguous across parents.
    const annotations = new Map([['src/agent/', 'the loop']])
    expect(renderModuleTree(tracked, annotations).join('\n')).toContain(
      '← the loop',
    )
    expect(
      renderModuleTree(tracked, new Map([['agent/', 'the loop']])).join('\n'),
    ).not.toContain('← the loop')
  })

  test('carries a count that is still inside tolerance, so nothing rewrites', () => {
    // The whole cost argument for running at session start: a repo that gained
    // one file must re-render byte-identical, not churn the tracked map.
    const retained = new Map([['src/agent/', 27]])
    expect(renderModuleTree(tracked, new Map(), retained).join('\n')).toContain(
      'agent/ (27)',
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
  test('keeps a level it already drew when the repo outgrows the budget', () => {
    // Dropping a level takes every annotation on it along, which is worse than
    // a map that is one level wider than the budget would have chosen today.
    const content = generateRuleMap(repo({ 'src/a': 3, 'src/a/x': 3 }))
      .split('\n')
      .map(line =>
        line.includes('x/ (3)') ? line.replace('TODO', 'the widget') : line,
      )
      .join('\n')

    const grown: Record<string, number> = { 'src/a': 3, 'src/a/x': 3 }
    for (let top = 0; top < 20; top++) {
      for (let mid = 0; mid < 5; mid++) grown[`src/b${top}/m${mid}`] = 3
    }

    const next = syncRuleMap({ content, trackedFiles: repo(grown) })
    expect(next).toContain('x/ (3)')
    expect(next).toContain('← the widget')
  })

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

  test('a generated map absorbs small churn without a write', () => {
    // The cost argument for running at session start. Regeneration used to emit
    // exact counts, so ONE added file rewrote the tracked map and printed a
    // notice — on essentially every session in a repo under development.
    const before = repo({ 'src/agent': 20, 'src/rag': 9 })
    const content = generateRuleMap(before)
    const after = repo({ 'src/agent': 21, 'src/rag': 9 })
    expect(syncRuleMap({ content, trackedFiles: after })).toBeNull()
  })

  test('a generated map still heals a count that really moved', () => {
    const before = repo({ 'src/agent': 20 })
    const content = generateRuleMap(before)
    const after = repo({ 'src/agent': 44 })
    const next = syncRuleMap({ content, trackedFiles: after })
    expect(next).not.toBeNull()
    expect(next).toContain('agent/ (44)')
  })

  test('regenerating targets the tree, not the first fence in the file', () => {
    // The file invites hand-editing, so a prose example above the tree is
    // expected; the tree used to overwrite whatever that example was.
    const tracked = repo({ 'src/agent': 20 })
    const generated = generateRuleMap(tracked).split('\n')
    const markerAt = generated.findIndex(line => line.includes(MAP_MARKER))
    const withExample = [
      ...generated.slice(0, markerAt + 1),
      '```bash',
      'rg --files src/agent',
      '```',
      ...generated.slice(markerAt + 1),
    ].join('\n')

    const next = syncRuleMap({
      content: withExample,
      trackedFiles: repo({ 'src/agent': 44 }),
    })
    expect(next).not.toBeNull()
    expect(next).toContain('rg --files src/agent')
    expect(next).toContain('agent/ (44)')
  })

  test('writes nothing for a repo whose code does not group into directories', () => {
    // A flat repo renders an empty fence, and the file around it is still 347
    // bytes of prose promising a tree plus a `paths:` that pulls it into
    // context on every matching edit. Measured shapes that land here: a Go
    // binary with its sources at the root, and a small Python package whose
    // only subdirectory is a two-file `tests/`.
    expect(
      syncRuleMap({
        content: '',
        trackedFiles: ['main.go', 'server.go', 'db.go', 'go.mod'],
      }),
    ).toBeNull()
    expect(
      syncRuleMap({
        content: '',
        trackedFiles: ['setup.py', 'cli.py', 'tests/a.py', 'tests/b.py'],
      }),
    ).toBeNull()
  })

  test('one directory over the floor is enough to be worth a map', () => {
    // The boundary the previous test sits under, pinned from the other side so
    // the guard cannot quietly grow into "never generate anything".
    const next = syncRuleMap({
      content: '',
      trackedFiles: ['Gemfile', 'lib/a.rb', 'lib/b.rb', 'lib/c.rb'],
    })
    expect(next).not.toBeNull()
    expect(next).toContain('lib/ (3)')
  })

  test('a generated map is left intact when its repo goes flat', () => {
    // Emptying the fence would discard every annotation in it, which is worse
    // than the map being stale — the annotations are the only part a human
    // wrote.
    const content = generateRuleMap(repo({ 'src/agent': 20 })).replace(
      '← TODO',
      '← the loop',
    )
    expect(
      syncRuleMap({ content, trackedFiles: ['main.ts', 'util.ts'] }),
    ).toBeNull()
  })

  test('a hand-written map in a flat repo still gets its counts healed', () => {
    // The guard is about drawing a tree, not about touching numbers. A curated
    // map can describe a layout the renderer would not have produced.
    const content = ['```', '.', '├── lib/ (99)', '```', ''].join('\n')
    const next = syncRuleMap({
      content,
      trackedFiles: ['main.ts', 'lib/a.ts', 'lib/b.ts'],
    })
    expect(next).toContain('lib/ (2)')
  })
})

describe('diffRuleMapCounts', () => {
  test('lists moved, new and dropped counts, in the order the new map draws them', () => {
    const before = ['```', 'src/', '├── a/ (5)', '└── b/ (9)', '```'].join('\n')
    const after = ['```', 'src/', '├── a/ (50)', '└── c/ (7)', '```'].join('\n')
    expect(diffRuleMapCounts(before, after)).toEqual([
      { path: 'src/a/', from: 5, to: 50 },
      { path: 'src/c/', from: null, to: 7 },
      { path: 'src/b/', from: 9, to: null },
    ])
  })

  test('is empty when no count moved', () => {
    const map = ['```', 'src/', '└── a/ (5)   ← x', '```'].join('\n')
    expect(diffRuleMapCounts(map, map.replace('← x', '← y'))).toEqual([])
  })
})

describe('isHealerOnlyDiff', () => {
  const tracked = repo({ 'src/agent': 20, 'src/providers': 40 })
  const handWritten = [
    '# Map',
    '',
    'Prose.',
    '',
    '```',
    'src/',
    '├── agent/ (140)              ← the loop',
    '└── providers/ (4)            ← providers',
    '```',
    '',
  ].join('\n')

  test('accepts a hand-written map healed by this module', () => {
    const healed = healRuleMap({ content: handWritten, trackedFiles: tracked })
    expect(healed).not.toBe(handWritten)
    expect(isHealerOnlyDiff(handWritten, healed)).toBe(true)
  })

  test('rejects a hand-written map whose prose changed', () => {
    expect(
      isHealerOnlyDiff(handWritten, handWritten.replace('Prose.', 'Mine.')),
    ).toBe(false)
  })

  test('rejects a hand-written map whose annotation changed', () => {
    expect(
      isHealerOnlyDiff(handWritten, handWritten.replace('the loop', 'mine')),
    ).toBe(false)
  })

  test('rejects a hand-written map that gained a line', () => {
    expect(
      isHealerOnlyDiff(
        handWritten,
        handWritten.replace('src/\n', 'src/\n├── extra/ (3)\n'),
      ),
    ).toBe(false)
  })

  const generated = generateRuleMap(tracked)
  const grown = repo({ 'src/agent': 20, 'src/providers': 40, 'src/new': 9 })

  test('accepts a generated map regenerated by this module', () => {
    const annotated = generated.replace('← TODO', '← the loop')
    const next = syncRuleMap({ content: annotated, trackedFiles: grown })
    expect(next).not.toBeNull()
    expect(isHealerOnlyDiff(annotated, next ?? '')).toBe(true)
  })

  test('rejects a generated map with a gloss nobody committed', () => {
    const next = syncRuleMap({ content: generated, trackedFiles: grown }) ?? ''
    // On an entry the committed map edits too…
    expect(isHealerOnlyDiff(generated, next.replace('← TODO', '← mine'))).toBe(
      false,
    )
    // …and on one only the regenerate added, which may read nothing but TODO.
    const onNewEntry = next.replace(/(new\/ \(9\)\s+)← TODO/, '$1← mine')
    expect(onNewEntry).not.toBe(next)
    expect(isHealerOnlyDiff(generated, onNewEntry)).toBe(false)
  })

  test('rejects a generated map whose prose changed', () => {
    expect(
      isHealerOnlyDiff(generated, generated.replace('# Module Map', '# Mine')),
    ).toBe(false)
  })

  test('rejects a generated map with a note inside its tree', () => {
    // A regenerate rewrites the whole tree, so free text there would be lost.
    const noted = generated.replace('```\n', '```\n# start in src/agent\n')
    expect(isHealerOnlyDiff(generated, noted)).toBe(false)
  })

  test('accepts a note inside the tree that was already committed', () => {
    const noted = generated.replace('```\n', '```\n# start in src/agent\n')
    const next = noted.replace('agent/ (20)', 'agent/ (90)')
    expect(isHealerOnlyDiff(noted, next)).toBe(true)
  })

  test('rejects a generated map whose frontmatter changed — a regenerate keeps it as written', () => {
    expect(
      isHealerOnlyDiff(generated, generated.replace('paths:', 'paths: # mine\n')),
    ).toBe(false)
  })

  // A wrong "yes" deletes uncommitted text on the next heal; each of these is a
  // user edit a regenerate would drop, found by a review that ran them through
  // syncProjectRuleMap.
  const annotated = generated.replace(
    /(agent\/ \(20\)\s+)← TODO/,
    '$1← the loop ← being split',
  )

  test('rejects text written beside an entry\'s count', () => {
    expect(
      isHealerOnlyDiff(generated, generated.replace('agent/ (20)', 'agent/ (20) DEPRECATED')),
    ).toBe(false)
  })

  test('compares a gloss whole, past an arrow of its own', () => {
    expect(isHealerOnlyDiff(annotated, annotated.replace(' ← being split', ''))).toBe(false)
    expect(
      isHealerOnlyDiff(annotated, annotated.replace('being split', 'being split, ask Bob')),
    ).toBe(false)
  })

  test('rejects a deleted note', () => {
    const bare = annotated.replace(/\s+← the loop ← being split/, '')
    expect(isHealerOnlyDiff(annotated, bare)).toBe(false)
  })

  test('rejects the same directory twice', () => {
    const lines = annotated.split('\n')
    const at = lines.findIndex(line => line.includes('agent/ (20)'))
    lines.splice(at, 0, lines[at]!.replace(/←.*$/, '← mine'))
    expect(isHealerOnlyDiff(annotated, lines.join('\n'), tracked)).toBe(false)
  })

  test('rejects an entry deleted while its directory still holds files', () => {
    const lines = annotated.split('\n').filter(line => !line.includes('agent/ (20)'))
    expect(isHealerOnlyDiff(annotated, lines.join('\n'), tracked)).toBe(false)
  })

  test('accepts an entry dropped because its directory died — given the tracked files', () => {
    const shrunk = repo({ 'src/agent': 1, 'src/providers': 40 })
    const next = syncRuleMap({ content: annotated, trackedFiles: shrunk }) ?? ''
    expect(next).not.toContain('agent/')
    expect(isHealerOnlyDiff(annotated, next, shrunk)).toBe(true)
    // Without them nothing says the directory died, so it answers no.
    expect(isHealerOnlyDiff(annotated, next)).toBe(false)
  })

  test('reads a CRLF checkout against an LF blob as the same map', () => {
    expect(isHealerOnlyDiff(generated, generated.replace(/\n/g, '\r\n'))).toBe(true)
  })

  test('rejects a map that changed kind', () => {
    expect(isHealerOnlyDiff(generated, generated.replace(MAP_MARKER, ''))).toBe(
      false,
    )
  })
})

describe('existingAnnotations', () => {
  test('keys the gloss by the directory it describes', () => {
    const found = existingAnnotations(
      [
        '```',
        '├── agent/ (489)      ← the agent loop',
        '└── shared/ (175)     ← bits',
        '```',
      ].join('\n'),
    )
    expect(found.get('agent/')).toBe('the agent loop')
    expect(found.get('shared/')).toBe('bits')
  })

  test('does not let two same-named directories share one gloss', () => {
    // `src/ui/` and `app/ui/` are both written `ui/` on their line, so a
    // name-keyed map handed whichever came second the other's sentence.
    const found = existingAnnotations(
      [
        '```',
        '├── app/ (12)                  ← the product',
        '│   └── ui/ (8)                ← product screens',
        '└── src/ (20)                  ← the library',
        '    └── ui/ (9)                ← reusable widgets',
        '```',
      ].join('\n'),
    )
    expect(found.get('app/ui/')).toBe('product screens')
    expect(found.get('src/ui/')).toBe('reusable widgets')
  })

  test('keeps a gloss whole when it holds an arrow of its own', () => {
    const found = existingAnnotations(
      ['```', '└── agent/ (489)      ← the loop ← being split', '```'].join('\n'),
    )
    expect(found.get('agent/')).toBe('the loop ← being split')
  })
})

describe('ruleMapKind', () => {
  const tracked = repo({ 'src/agent': 20, 'src/providers': 40 })
  const generated = generateRuleMap(tracked)

  test('a map nobody wrote inside is generated', () => {
    expect(ruleMapKind(generated)).toBe('generated')
    expect(ruleMapKind(generated.replace('← TODO', '← the loop ← being split'))).toBe(
      'generated',
    )
  })

  test('text a redraw would drop makes it edited', () => {
    expect(ruleMapKind(generated.replace('```\n', '```\n# start here\n'))).toBe('edited')
    expect(ruleMapKind(generated.replace('agent/ (20)', 'agent/ (20) DEPRECATED'))).toBe(
      'edited',
    )
    const lines = generated.split('\n')
    const at = lines.findIndex(line => line.includes('agent/ (20)'))
    lines.splice(at, 0, lines[at]!)
    expect(ruleMapKind(lines.join('\n'))).toBe('edited')
  })

  test('no marker is hand-written', () => {
    expect(ruleMapKind(generated.replace(MAP_MARKER, ''))).toBe('hand-written')
  })

  test('an edited map is healed numbers only, so the text stays', () => {
    const noted = generated.replace('agent/ (20)', 'agent/ (20) DEPRECATED')
    const next = syncRuleMap({
      content: noted,
      trackedFiles: repo({ 'src/agent': 90, 'src/providers': 40, 'src/new': 9 }),
    })
    expect(next).toContain('agent/ (90) DEPRECATED')
    // Numbers only: no entry is added to a tree somebody wrote in.
    expect(next).not.toContain('new/')
  })
})

describe('describeRuleMapWrite', () => {
  test('one clause for every surface: the verb, then what moved', () => {
    expect(
      describeRuleMapWrite({
        status: 'healed',
        changes: [{ path: 'src/tools/', from: 682, to: 751 }],
      }),
    ).toBe('updated · src/tools/ 682→751')
    expect(
      describeRuleMapWrite({
        status: 'created',
        changes: [
          { path: 'src/', from: null, to: 8 },
          { path: 'src/a/', from: null, to: 8 },
        ],
      }),
    ).toBe('created · 2 directories')
    expect(describeRuleMapWrite({ status: 'healed', changes: [] })).toBe('updated')
  })
})
