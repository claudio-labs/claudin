import { describe, expect, test } from 'bun:test'
import {
  countTrackedSources,
  dirCountDrifted,
  dominantSourceExtensions,
  extractRuleClaims,
  lineCountDrifted,
  resolveUniqueBasename,
} from 'src/memory/instructions/rulesClaims.js'

/** The Module Map's shape, reduced to the cases that broke the parser. */
const TREE = [
  '```',
  'src/',
  '├── agent/ (489)                 ← the agent loop',
  '│   ├── QueryEngine.ts           ← model drive, tool dispatch',
  '│   ├── context/ (22)            ← token accounting. Three things carry this',
  '│   │                              name: agent/context.ts, terminal/contexts/',
  '│   └── plans/ goal/ autoFix/    ← planning',
  '├── providers/ (254)             ← provider abstraction',
  '│   ├── model/ (42)              ← model.ts (getPrimaryModel), catalogs',
  '│   ├── contexts/ (9) state/ (8) ← two siblings on one line',
  '└── shared/ (175)                ← cross-cutting primitives',
  '```',
].join('\n')

describe('extractRuleClaims — the tree', () => {
  test('joins every entry to the parent its indentation puts it under', () => {
    const paths = extractRuleClaims(TREE).fencedPaths.map(c => c.path)
    expect(paths).toContain('src/agent/')
    expect(paths).toContain('src/agent/QueryEngine.ts')
    expect(paths).toContain('src/agent/context/')
    expect(paths).toContain('src/providers/model/')
    expect(paths).toContain('src/shared/')
  })

  test('a second top-level entry reparents its children', () => {
    // The first version latched the depth-1 prefix to whatever opened it, so
    // every nested entry in the map resolved under `src/agent/`.
    const paths = extractRuleClaims(TREE).fencedPaths.map(c => c.path)
    expect(paths).not.toContain('src/agent/model/')
  })

  test('siblings on one line are siblings, not a nesting', () => {
    const paths = extractRuleClaims(TREE).fencedPaths.map(c => c.path)
    expect(paths).toContain('src/agent/plans/')
    expect(paths).toContain('src/agent/goal/')
    expect(paths).toContain('src/agent/autoFix/')
    expect(paths).not.toContain('src/agent/plans/goal/')
  })

  test('ignores annotations and the wrapped lines that continue them', () => {
    const paths = extractRuleClaims(TREE).fencedPaths.map(c => c.path)
    // An annotation names files by their own name, not relative to the entry:
    // reading `← model.ts (…)` as a child invents `src/providers/model.ts` for
    // every annotated line in the map.
    expect(paths).not.toContain('src/providers/model.ts')
    // `agent/context.ts` and `terminal/contexts/` sit on a marker-less
    // continuation line; joining them to a parent invents paths too.
    expect(paths).not.toContain('src/agent/agent/context.ts')
    expect(paths).not.toContain('src/agent/terminal/contexts/')
  })

  test('reads each `(N)` onto the entry it follows', () => {
    const counts = extractRuleClaims(TREE).dirCounts
    expect(counts).toContainEqual(
      expect.objectContaining({ path: 'src/agent/', claimed: 489 }),
    )
    expect(counts).toContainEqual(
      expect.objectContaining({ path: 'src/providers/model/', claimed: 42 }),
    )
    // Two counts on one line belong to their own directory, not to the first.
    expect(counts).toContainEqual(
      expect.objectContaining({ path: 'src/providers/contexts/', claimed: 9 }),
    )
    expect(counts).toContainEqual(
      expect.objectContaining({ path: 'src/providers/state/', claimed: 8 }),
    )
  })
})

describe('extractRuleClaims — fences that are examples', () => {
  test('skips a labelled code fence', () => {
    const claims = extractRuleClaims(
      ['```typescript', "import { x } from 'src/gone/nowhere.js'", '```'].join(
        '\n',
      ),
    )
    expect(claims.fencedPaths).toEqual([])
  })

  test('reads no claims out of the command examples in a bash fence', () => {
    // search-strategy.md keeps its Grep/Glob recipes in bash fences, right
    // below the map. They carry paths and parentheses and must stay inert.
    const claims = extractRuleClaims(
      [
        '```bash',
        'Grep pattern="from \'src/shared/errors.js\'" type="ts"',
        'Grep pattern="feature\\(\'MY_FLAG\'\\)" type="ts"',
        'Glob pattern="src/**/*.test.ts"',
        '```',
      ].join('\n'),
    )
    expect(claims).toEqual({
      fencedPaths: [],
      dirCounts: [],
      attributions: [],
      lineCounts: [],
    })
  })
})

describe('extractRuleClaims — symbol attribution', () => {
  test('accepts a list of code-shaped identifiers', () => {
    const claims = extractRuleClaims(
      '`model.ts (getPrimaryModel, getContextWindowForModel)`',
    )
    expect(claims.attributions).toEqual([
      expect.objectContaining({
        file: 'model.ts',
        symbols: ['getPrimaryModel', 'getContextWindowForModel'],
      }),
    ])
  })

  test('rejects a parenthetical gloss written in English', () => {
    // `activeProvider.ts (resolver)` is prose; `providers.ts (getAPIProvider)`
    // is a claim, and the interior capital is the only thing separating them.
    expect(
      extractRuleClaims('activeProvider.ts (resolver), x').attributions,
    ).toEqual([])
    expect(
      extractRuleClaims('config.ts (getGlobalConfig/saveGlobalConfig)')
        .attributions,
    ).toEqual([])
    expect(
      extractRuleClaims('providers.ts (getAPIProvider)').attributions,
    ).toHaveLength(1)
  })

  test('only reads the parenthetical the filename itself opens', () => {
    // Loosening the attachment to "any later paren on the line" reports
    // `toolUseResult` as a symbol of the component that merely calls with it.
    const claims = extractRuleClaims(
      '`UserToolSuccessMessage.tsx` runs `tool.outputSchema?.safeParse(toolUseResult)`',
    )
    expect(claims.attributions).toEqual([])
  })
})

describe('extractRuleClaims — size claims', () => {
  test('reads a size out of the parenthetical the filename opens', () => {
    expect(extractRuleClaims('`REPL.tsx` (3160 lines)').lineCounts).toEqual([
      expect.objectContaining({ file: 'REPL.tsx', claimed: 3160 }),
    ])
    expect(
      extractRuleClaims('openaiShim.ts (Anthropic → OpenAI, ~2.2k lines),')
        .lineCounts,
    ).toEqual([
      expect.objectContaining({ file: 'openaiShim.ts', claimed: 2200 }),
    ])
  })

  test('does not read a sentence about some other file as a claim', () => {
    // The line that produced the checker's only false positive: the "2,200-line
    // file" is whatever the agent read, not the FileReadTool cited beside it.
    const claims = extractRuleClaims(
      '(`FileReadTool.ts:2268`, `:1886`), so eight lines of a 2,200-line file used',
    )
    expect(claims.lineCounts).toEqual([])
  })

  test('a size claim is not also read as an attribution', () => {
    expect(extractRuleClaims('`REPL.tsx` (3160 lines)').attributions).toEqual([])
  })
})

describe('resolveUniqueBasename', () => {
  const tracked = [
    'src/agent/context.ts',
    'src/agent/context/context.ts',
    'src/agent/repl/REPL.tsx',
  ]

  test('resolves a unique basename and refuses an ambiguous one', () => {
    expect(resolveUniqueBasename(tracked, 'REPL.tsx')).toBe(
      'src/agent/repl/REPL.tsx',
    )
    expect(resolveUniqueBasename(tracked, 'context.ts')).toBeNull()
    expect(resolveUniqueBasename(tracked, 'nothing.ts')).toBeNull()
  })

  test('takes a full path as itself', () => {
    expect(resolveUniqueBasename(tracked, 'src/agent/context.ts')).toBe(
      'src/agent/context.ts',
    )
    expect(resolveUniqueBasename(tracked, 'src/agent/gone.ts')).toBeNull()
  })
})

describe('dominantSourceExtensions', () => {
  /** Builds a tracked-file list with the given per-extension counts. */
  function tree(counts: Record<string, number>): string[] {
    return Object.entries(counts).flatMap(([extension, n]) =>
      Array.from({ length: n }, (_, i) => `src/dir${i}/file${i}${extension}`),
    )
  }

  test('finds the languages of this repo and leaves out its prose', () => {
    // Real proportions from `git ls-files`: docs are 8.7% of the tree and would
    // cross the 90% line on frequency alone.
    expect(
      dominantSourceExtensions(
        tree({ '.ts': 2724, '.tsx': 619, '.md': 346, '.txt': 173, '.js': 17 }),
      ).sort(),
    ).toEqual(['.ts', '.tsx'])
  })

  test('follows the repo rather than assuming TypeScript', () => {
    expect(
      dominantSourceExtensions(tree({ '.py': 200, '.md': 40, '.yml': 12 })),
    ).toEqual(['.py'])
    expect(
      dominantSourceExtensions(tree({ '.go': 300, '.json': 90 })),
    ).toEqual(['.go'])
  })

  test('keeps a genuinely bilingual repo bilingual', () => {
    expect(
      dominantSourceExtensions(tree({ '.py': 120, '.ts': 100, '.md': 30 })).sort(),
    ).toEqual(['.py', '.ts'])
  })

  test('drops a long tail instead of chasing the coverage target', () => {
    const chosen = dominantSourceExtensions(
      tree({ '.ts': 500, '.sh': 4, '.rb': 3, '.pl': 2, '.awk': 1 }),
    )
    expect(chosen).toEqual(['.ts'])
  })

  test('falls back to whatever a repo with no code holds', () => {
    expect(dominantSourceExtensions(tree({ '.md': 40, '.png': 3 }))).toEqual([
      '.md',
    ])
    expect(dominantSourceExtensions([])).toEqual([])
  })
})

describe('counts and tolerances', () => {
  const tracked = [
    'src/agent/a.ts',
    'src/agent/ui/b.tsx',
    'src/agent/README.md',
    'src/agentx/c.ts',
  ]

  test('counts recursively, within the directory, by extension', () => {
    expect(countTrackedSources(tracked, 'src/agent/', ['.ts', '.tsx'])).toBe(2)
    expect(countTrackedSources(tracked, 'src/agent', ['.ts', '.tsx'])).toBe(2)
    expect(countTrackedSources(tracked, 'src/agent/', ['.md'])).toBe(1)
  })

  test('a directory count tolerates churn and reports a structural move', () => {
    expect(dirCountDrifted(489, 491)).toBe(false)
    expect(dirCountDrifted(575, 582)).toBe(false)
    expect(dirCountDrifted(6, 8)).toBe(false)
    expect(dirCountDrifted(489, 0)).toBe(true)
    expect(dirCountDrifted(20, 40)).toBe(true)
  })

  test('a size claim tolerates growth and reports an order of magnitude', () => {
    expect(lineCountDrifted(3160, 3160)).toBe(false)
    expect(lineCountDrifted(2200, 1500)).toBe(false)
    expect(lineCountDrifted(2200, 51)).toBe(true)
    expect(lineCountDrifted(200, 900)).toBe(true)
  })
})
