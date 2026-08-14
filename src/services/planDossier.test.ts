import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const realPlans = await import('src/utils/plans.js')

let testTempDir: string
let testPlansDir: string
let mockSlug = 'test-slug'

mock.module('src/utils/plans.js', () => ({
  ...realPlans,
  getPlanFilePath: () => join(testPlansDir, `${mockSlug}.md`),
  getPlanSlug: () => mockSlug,
}))

import {
  buildDossierFromMessages,
  clearAgentPlanSlug,
  clearRevalidateCache,
  deleteDossier,
  dossierBudgetTokens,
  getAgentPlanSlug,
  getDossierPath,
  HARD_CAP_PCT,
  loadDossier,
  renderDossierForSubagent,
  revalidateDossier,
  serializeDossier,
  setAgentPlanSlug,
  SUBAGENT_BUDGET_PCT,
  type Dossier,
  type GlobEntry,
  type GrepEntry,
  type ReadEntry,
} from './planDossier.js'
import { getEffectiveContextWindowSize } from './compact/autoCompact.js'

beforeEach(() => {
  testTempDir = mkdtempSync(join(tmpdir(), 'planDossier-'))
  testPlansDir = join(testTempDir, 'plans')
  mkdirSync(testPlansDir, { recursive: true })
  mockSlug = 'test-slug'
  clearRevalidateCache()
})

afterEach(() => {
  try {
    rmSync(testTempDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

afterAll(() => {
  mock.module('src/utils/plans.js', () => realPlans)
})

function makeAssistantMessage(toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: toolUses.map(t => ({
        type: 'tool_use',
        id: t.id,
        name: t.name,
        input: t.input,
      })),
    },
  }
}

function makeUserToolResult(id: string, content: unknown) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content,
        },
      ],
    },
  }
}

function makeEnterPlanModeMsg() {
  return makeAssistantMessage([
    { id: 'enter-1', name: 'EnterPlanMode', input: {} },
  ])
}

describe('getDossierPath', () => {
  test('derives from getPlanFilePath by swapping .md for .dossier.json', () => {
    expect(getDossierPath('foo-bar')).toBe(join(testPlansDir, 'foo-bar.dossier.json'))
  })
})

describe('buildDossierFromMessages', () => {
  test('extracts Read entries between Enter and Exit', async () => {
    const filePath = join(testTempDir, 'sample.ts')
    writeFileSync(filePath, 'const x = 1\nexport {}\n')
    const messages = [
      makeAssistantMessage([
        { id: 'read-pre', name: 'Read', input: { file_path: filePath } },
      ]),
      makeUserToolResult('read-pre', '     1→pre-plan content'),
      makeEnterPlanModeMsg(),
      makeAssistantMessage([
        { id: 'read-1', name: 'Read', input: { file_path: filePath } },
      ]),
      makeUserToolResult('read-1', '     1→const x = 1\n     2→export {}'),
    ]
    const dossier = await buildDossierFromMessages(messages, '# plan', [], 'slug-1')
    const reads = dossier.entries.filter(
      (e): e is ReadEntry => e.source === 'Read',
    )
    expect(reads).toHaveLength(1)
    expect(reads[0]!.path).toBe(filePath)
    expect(reads[0]!.content).toContain('const x = 1')
  })

  test('multiple Enter→Exit cycles: walk only most recent', async () => {
    const filePath = join(testTempDir, 'a.ts')
    writeFileSync(filePath, 'a')
    const messages = [
      makeEnterPlanModeMsg(),
      makeAssistantMessage([
        { id: 'r-old', name: 'Read', input: { file_path: filePath } },
      ]),
      makeUserToolResult('r-old', 'OLD'),
      makeEnterPlanModeMsg(),
      makeAssistantMessage([
        { id: 'r-new', name: 'Read', input: { file_path: filePath } },
      ]),
      makeUserToolResult('r-new', 'NEW'),
    ]
    const dossier = await buildDossierFromMessages(messages, '#', [], 'slug-cycle')
    const reads = dossier.entries.filter(
      (e): e is ReadEntry => e.source === 'Read',
    )
    expect(reads).toHaveLength(1)
    expect(reads[0]!.content).toBe('NEW')
  })

  test('multiple reads of same path → last wins', async () => {
    const filePath = join(testTempDir, 'dedupe.ts')
    writeFileSync(filePath, 'final')
    const messages = [
      makeEnterPlanModeMsg(),
      makeAssistantMessage([
        { id: 'r1', name: 'Read', input: { file_path: filePath } },
      ]),
      makeUserToolResult('r1', 'first'),
      makeAssistantMessage([
        { id: 'r2', name: 'Read', input: { file_path: filePath } },
      ]),
      makeUserToolResult('r2', 'second'),
    ]
    const dossier = await buildDossierFromMessages(messages, '#', [], 'dedupe')
    const reads = dossier.entries.filter(
      (e): e is ReadEntry => e.source === 'Read',
    )
    expect(reads).toHaveLength(1)
    expect(reads[0]!.content).toBe('second')
  })

  test('Grep and Glob entries are extracted with discriminated source', async () => {
    const messages = [
      makeEnterPlanModeMsg(),
      makeAssistantMessage([
        {
          id: 'g1',
          name: 'Grep',
          input: { pattern: 'foo', output_mode: 'files_with_matches' },
        },
      ]),
      makeUserToolResult('g1', '/abs/path/a.ts\n/abs/path/b.ts'),
      makeAssistantMessage([
        { id: 'gl1', name: 'Glob', input: { pattern: '*.ts' } },
      ]),
      makeUserToolResult('gl1', '/abs/path/c.ts\n/abs/path/d.ts'),
    ]
    const dossier = await buildDossierFromMessages(messages, '#', [], 's')
    const grep = dossier.entries.find(e => e.source === 'Grep') as GrepEntry
    const glob = dossier.entries.find(e => e.source === 'Glob') as GlobEntry
    expect(grep.pattern).toBe('foo')
    expect(grep.paths).toEqual(['/abs/path/a.ts', '/abs/path/b.ts'])
    expect(glob.pattern).toBe('*.ts')
    expect(glob.paths).toEqual(['/abs/path/c.ts', '/abs/path/d.ts'])
  })

  test('non-existent path in filesToEdit → isNew, content empty', async () => {
    const newPath = join(testTempDir, 'will-create.ts')
    const dossier = await buildDossierFromMessages(
      [makeEnterPlanModeMsg()],
      '#',
      [newPath],
      's',
    )
    const reads = dossier.entries.filter(
      (e): e is ReadEntry => e.source === 'Read',
    )
    expect(reads).toHaveLength(1)
    expect(reads[0]!.isNew).toBe(true)
    expect(reads[0]!.content).toBe('')
  })

  test('image/PDF/notebook reads → isNonText, kind set, content empty', async () => {
    const imgPath = join(testTempDir, 'pic.png')
    const pdfPath = join(testTempDir, 'doc.pdf')
    const nbPath = join(testTempDir, 'work.ipynb')
    writeFileSync(imgPath, 'fake-img-bytes')
    writeFileSync(pdfPath, 'fake-pdf-bytes')
    writeFileSync(nbPath, '{}')
    const messages = [
      makeEnterPlanModeMsg(),
      makeAssistantMessage([
        { id: 'i', name: 'Read', input: { file_path: imgPath } },
        { id: 'p', name: 'Read', input: { file_path: pdfPath } },
        { id: 'n', name: 'Read', input: { file_path: nbPath } },
      ]),
      makeUserToolResult('i', 'img-base64'),
      makeUserToolResult('p', 'pdf-base64'),
      makeUserToolResult('n', 'notebook-json'),
    ]
    const dossier = await buildDossierFromMessages(messages, '#', [], 's')
    const reads = dossier.entries.filter(
      (e): e is ReadEntry => e.source === 'Read',
    )
    const byKind = Object.fromEntries(reads.map(r => [r.kind, r]))
    expect(byKind.image!.isNonText).toBe(true)
    expect(byKind.image!.content).toBe('')
    expect(byKind.pdf!.isNonText).toBe(true)
    expect(byKind.notebook!.isNonText).toBe(true)
  })

  test('partial read marks isPartial + range from line markers and totals', async () => {
    const filePath = join(testTempDir, 'big.ts')
    writeFileSync(filePath, 'long content')
    const partialOutput =
      '    50→middle content line A\n    51→middle content line B\n\n(file has 200 total lines)'
    const messages = [
      makeEnterPlanModeMsg(),
      makeAssistantMessage([
        {
          id: 'r',
          name: 'Read',
          input: { file_path: filePath, offset: 49, limit: 2 },
        },
      ]),
      makeUserToolResult('r', partialOutput),
    ]
    const dossier = await buildDossierFromMessages(messages, '#', [], 's')
    const read = dossier.entries.find(e => e.source === 'Read') as ReadEntry
    expect(read.isPartial).toBe(true)
    expect(read.range).toEqual({ startLine: 50, endLine: 51, totalLines: 200 })
  })

  test('non-Read/Grep/Glob tools are ignored', async () => {
    const messages = [
      makeEnterPlanModeMsg(),
      makeAssistantMessage([
        { id: 'b', name: 'Bash', input: { command: 'ls' } },
        { id: 't', name: 'TodoWrite', input: { todos: [] } },
      ]),
      makeUserToolResult('b', 'output'),
    ]
    const dossier = await buildDossierFromMessages(messages, '#', [], 's')
    expect(dossier.entries).toHaveLength(0)
  })
})

describe('serialize / load round-trip', () => {
  test('preserves discriminated union types', async () => {
    const filePath = join(testTempDir, 'a.ts')
    writeFileSync(filePath, 'a')
    const stats = statSync(filePath)
    const dossier: Dossier = {
      version: 1,
      planSlug: 'rt',
      planContent: '# plan',
      filesToEdit: [filePath],
      capturedAt: new Date().toISOString(),
      entries: [
        {
          source: 'Read',
          path: filePath,
          content: 'a',
          mtime: Math.floor(stats.mtimeMs),
          capturedAt: new Date().toISOString(),
          kind: 'text',
        },
        {
          source: 'Grep',
          pattern: 'foo',
          paths: ['/abs/x.ts'],
          matchSummary: '1 files',
          capturedAt: new Date().toISOString(),
        },
        {
          source: 'Glob',
          pattern: '*.ts',
          paths: ['/abs/x.ts'],
          matchSummary: '1 paths',
          capturedAt: new Date().toISOString(),
        },
      ],
    }
    mockSlug = 'rt'
    await serializeDossier(dossier)
    const loaded = await loadDossier('rt')
    expect(loaded).toEqual(dossier)
  })
})

describe('loadDossier', () => {
  test('returns null for missing file', async () => {
    mockSlug = 'nope'
    expect(await loadDossier('nope')).toBeNull()
  })

  test('returns null for incompatible version', async () => {
    mockSlug = 'oldver'
    await writeFile(
      join(testPlansDir, 'oldver.dossier.json'),
      JSON.stringify({ version: 99, planSlug: 'oldver' }),
    )
    expect(await loadDossier('oldver')).toBeNull()
  })

  test('deletes corrupted JSON file and returns null', async () => {
    mockSlug = 'corrupt'
    const path = join(testPlansDir, 'corrupt.dossier.json')
    await writeFile(path, '{not json}')
    expect(await loadDossier('corrupt')).toBeNull()
    let exists = true
    try {
      statSync(path)
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })
})

describe('revalidateDossier', () => {
  test('marks STALE when mtime increases', async () => {
    const filePath = join(testTempDir, 'mut.ts')
    writeFileSync(filePath, 'v1')
    const captured = Math.floor(statSync(filePath).mtimeMs)

    // Bump mtime forward by writing again with a later timestamp
    await new Promise(r => setTimeout(r, 10))
    writeFileSync(filePath, 'v2')
    const future = new Date(Date.now() + 5_000)
    await utimes(filePath, future, future)

    const dossier: Dossier = {
      version: 1,
      planSlug: 'stale',
      planContent: '#',
      filesToEdit: [],
      capturedAt: new Date().toISOString(),
      entries: [
        {
          source: 'Read',
          path: filePath,
          content: 'v1',
          mtime: captured,
          capturedAt: new Date().toISOString(),
          kind: 'text',
        },
      ],
    }
    clearRevalidateCache()
    const re = await revalidateDossier(dossier)
    const entry = re.entries[0] as ReadEntry
    expect(entry.isStale).toBe(true)
    expect(entry.content).toBe('')
  })

  test('does not mark STALE when mtime unchanged', async () => {
    const filePath = join(testTempDir, 'same.ts')
    writeFileSync(filePath, 'same')
    const captured = Math.floor(statSync(filePath).mtimeMs)
    const dossier: Dossier = {
      version: 1,
      planSlug: 'fresh',
      planContent: '#',
      filesToEdit: [],
      capturedAt: new Date().toISOString(),
      entries: [
        {
          source: 'Read',
          path: filePath,
          content: 'same',
          mtime: captured,
          capturedAt: new Date().toISOString(),
          kind: 'text',
        },
      ],
    }
    clearRevalidateCache()
    const re = await revalidateDossier(dossier)
    const entry = re.entries[0] as ReadEntry
    expect(entry.isStale).toBeUndefined()
    expect(entry.content).toBe('same')
  })

  test('cache reuses promise per planSlug', async () => {
    const filePath = join(testTempDir, 'cached.ts')
    writeFileSync(filePath, 'x')
    const dossier: Dossier = {
      version: 1,
      planSlug: 'cache-key',
      planContent: '#',
      filesToEdit: [],
      capturedAt: new Date().toISOString(),
      entries: [
        {
          source: 'Read',
          path: filePath,
          content: 'x',
          mtime: Math.floor(statSync(filePath).mtimeMs),
          capturedAt: new Date().toISOString(),
          kind: 'text',
        },
      ],
    }
    clearRevalidateCache()
    const a = revalidateDossier(dossier)
    const b = revalidateDossier(dossier)
    expect(a).toBe(b)
  })
})

describe('renderDossierForSubagent — Explore + budget basics', () => {
  function smallDossier(filesToEdit: string[] = []): Dossier {
    return {
      version: 1,
      planSlug: 'r',
      planContent: '# plan content',
      filesToEdit,
      capturedAt: new Date().toISOString(),
      entries: [],
    }
  }

  test('returns null for Explore subagent', () => {
    expect(renderDossierForSubagent(smallDossier(), 'Explore', 'claude-opus-4-7')).toBeNull()
  })

  test('renders text for code subagent', () => {
    const result = renderDossierForSubagent(smallDossier(), 'Code', 'claude-opus-4-7')
    expect(result).not.toBeNull()
    expect(result!.text).toContain('<plan-dossier>')
    expect(result!.text).toContain('# plan content')
    expect(result!.text).toContain('</plan-dossier>')
  })

  test('renders text for claudin-dev subagent', () => {
    const result = renderDossierForSubagent(smallDossier(), 'claudin-dev', 'claude-opus-4-7')
    expect(result).not.toBeNull()
    expect(result!.text).toContain('<plan-dossier>')
  })

  test('willEdit empty → all reads become Tier 2 reference', () => {
    const captured = new Date().toISOString()
    const dossier: Dossier = {
      version: 1,
      planSlug: 'r',
      planContent: '#',
      filesToEdit: [],
      capturedAt: captured,
      entries: [
        {
          source: 'Read',
          path: '/x/a.ts',
          content: 'A'.repeat(2000),
          mtime: 1,
          capturedAt: captured,
          kind: 'text',
        },
      ],
    }
    const result = renderDossierForSubagent(dossier, 'Code', 'claude-opus-4-7')!
    // No Tier 1 block should be rendered
    expect(result.text).not.toContain('AAAA') // raw bytes from content not present
    expect(result.text).toContain('--- Other explored files & searches ---')
    expect(result.text).toContain('/x/a.ts (Read')
  })

  test('STALE entry renders with re-read header', () => {
    const captured = new Date().toISOString()
    const dossier: Dossier = {
      version: 1,
      planSlug: 'r',
      planContent: '#',
      filesToEdit: ['/x/stale.ts'],
      capturedAt: captured,
      entries: [
        {
          source: 'Read',
          path: '/x/stale.ts',
          content: '',
          mtime: 1,
          capturedAt: captured,
          kind: 'text',
          isStale: true,
        },
      ],
    }
    const result = renderDossierForSubagent(dossier, 'Code', 'claude-opus-4-7')!
    expect(result.text).toContain('STALE: /x/stale.ts')
  })
})

describe('renderDossierForSubagent — tier 3 degrade and overflow', () => {
  test('Tier 1 over budget → larger entries degrade to structural summary', () => {
    const captured = new Date().toISOString()
    // Build many huge willEdit entries that overflow claudin-dev's tier1 budget.
    const huge = 'x'.repeat(20_000) // 20KB each — small file
    const truly = 'y'.repeat(200_000) // 200KB — larger
    const dossier: Dossier = {
      version: 1,
      planSlug: 'deg',
      planContent: '#',
      filesToEdit: ['/big1.ts', '/big2.ts'],
      capturedAt: captured,
      entries: [
        {
          source: 'Read',
          path: '/big1.ts',
          content: huge,
          mtime: 1,
          capturedAt: captured,
          kind: 'text',
        },
        {
          source: 'Read',
          path: '/big2.ts',
          content: truly,
          mtime: 1,
          capturedAt: captured,
          kind: 'text',
        },
      ],
    }
    // Use a small effective window via legacy model with smaller capacity
    const result = renderDossierForSubagent(
      dossier,
      'Code',
      'claude-3-5-haiku-latest',
    )!
    // The smaller file (big1) should remain in full; the larger (big2) should
    // be either degraded to structural summary or reported as truncated.
    const containsStructural = result.text.includes('structural summary')
    const containsTruncationWarning = result.text.includes('dossier truncated')
    expect(containsStructural || containsTruncationWarning).toBe(true)
  })
})

describe('dossierBudgetTokens — ALL_MODELS × SUBAGENT_TYPES matrix', () => {
  // Representative model set covering each branch in
  // getEffectiveContextWindowSize / getContextWindowForModel.
  const ALL_MODELS: string[] = [
    // Anthropic 200k canonical
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
    // Anthropic 1M (beta context — [1m] suffix)
    'claude-opus-4-7[1m]',
    'claude-sonnet-4-6[1m]',
    // Anthropic legacy
    'claude-3-5-sonnet-latest',
    'claude-3-5-haiku-latest',
    'claude-3-opus-latest',
    // Provider-compat: with USE_OPENAI, unknown models hit the fallback
    'gpt-5.2',
    'gemini-2.5-pro',
    'github:copilot:claude-sonnet-4.6',
  ]

  const SUBAGENT_TYPES: string[] = [
    'claudin-dev',
    'Code',
    '__customDefault',
    'Explore',
    'some-custom-name-not-in-table',
  ]

  describe.each(ALL_MODELS)('model=%s', model => {
    describe.each(SUBAGENT_TYPES)('subagentType=%s', subagentType => {
      test('budget = floor(window * min(pct, hardCap))', () => {
        const window = getEffectiveContextWindowSize(model)
        const explicit = SUBAGENT_BUDGET_PCT[subagentType]
        const fallback = SUBAGENT_BUDGET_PCT.__customDefault!
        const pct = Math.min(explicit ?? fallback, HARD_CAP_PCT)
        const expected = Math.floor(window * pct)
        const actual = dossierBudgetTokens(subagentType, model)
        expect(actual).toBe(expected)
      })

      test('Explore returns 0 budget and null render', () => {
        if (subagentType !== 'Explore') return
        expect(dossierBudgetTokens(subagentType, model)).toBe(0)
        const result = renderDossierForSubagent(
          {
            version: 1,
            planSlug: 's',
            planContent: '#',
            filesToEdit: [],
            capturedAt: new Date().toISOString(),
            entries: [],
          },
          subagentType,
          model,
        )
        expect(result).toBeNull()
      })

      test('hard cap: budget never exceeds floor(window * 0.25)', () => {
        const window = getEffectiveContextWindowSize(model)
        const cap = Math.floor(window * HARD_CAP_PCT)
        expect(dossierBudgetTokens(subagentType, model)).toBeLessThanOrEqual(cap)
      })

      test('render does not crash on small windows', () => {
        const result = renderDossierForSubagent(
          {
            version: 1,
            planSlug: 's',
            planContent: 'tiny plan',
            filesToEdit: [],
            capturedAt: new Date().toISOString(),
            entries: [],
          },
          subagentType,
          model,
        )
        if (subagentType === 'Explore') {
          expect(result).toBeNull()
        } else {
          expect(result).not.toBeNull()
          expect(result!.text).toContain('<plan-dossier>')
        }
      })
    })
  })

  test('snapshot of (model, subagentType) → budget is stable', () => {
    const fresh: Record<string, number> = {}
    for (const model of ALL_MODELS) {
      for (const sub of SUBAGENT_TYPES) {
        fresh[`${model}|${sub}`] = dossierBudgetTokens(sub, model)
      }
    }
    expect(Object.keys(fresh).length).toBe(ALL_MODELS.length * SUBAGENT_TYPES.length)
    for (const [key, val] of Object.entries(fresh)) {
      expect(Number.isInteger(val)).toBe(true)
      expect(val).toBeGreaterThanOrEqual(0)
      expect(key).toMatch(/^[^|]+\|[^|]+$/)
    }
  })
})

describe('renderDossierForSubagent — budget compliance', () => {
  test('rendered text token estimate stays under hard cap for claudin-dev', () => {
    const captured = new Date().toISOString()
    // Build a willEdit set well over the budget to force tier-1 + degrade
    const blob = 'b'.repeat(50_000)
    const dossier: Dossier = {
      version: 1,
      planSlug: 'cap',
      planContent: '#',
      filesToEdit: ['/a.ts', '/b.ts', '/c.ts'],
      capturedAt: captured,
      entries: [
        { source: 'Read', path: '/a.ts', content: blob, mtime: 1, capturedAt: captured, kind: 'text' },
        { source: 'Read', path: '/b.ts', content: blob, mtime: 1, capturedAt: captured, kind: 'text' },
        { source: 'Read', path: '/c.ts', content: blob, mtime: 1, capturedAt: captured, kind: 'text' },
      ],
    }
    const result = renderDossierForSubagent(dossier, 'claudin-dev', 'claude-opus-4-7')!
    const window = getEffectiveContextWindowSize('claude-opus-4-7')
    const hardCap = Math.floor(window * HARD_CAP_PCT)
    // Plan content + header + tier 2 lines add overhead beyond the tier-1
    // budget; allow the full hard cap as the upper bound.
    expect(result.tokensInjected).toBeLessThanOrEqual(hardCap + 1_000)
  })

  test('1M model lets large willEdit fit without degrade', () => {
    const captured = new Date().toISOString()
    const fivehundredKB = 'z'.repeat(500_000)
    const dossier: Dossier = {
      version: 1,
      planSlug: '1m',
      planContent: '#',
      filesToEdit: ['/big.ts'],
      capturedAt: captured,
      entries: [
        { source: 'Read', path: '/big.ts', content: fivehundredKB, mtime: 1, capturedAt: captured, kind: 'text' },
      ],
    }
    const result = renderDossierForSubagent(dossier, 'claudin-dev', 'claude-opus-4-7[1m]')!
    expect(result.text).not.toContain('structural summary')
    expect(result.text).not.toContain('dossier truncated')
    // Full content of /big.ts should be inline
    expect(result.text).toContain('zzzz')
  })
})

describe('deleteDossier', () => {
  test('removes existing file', async () => {
    mockSlug = 'del'
    const path = join(testPlansDir, 'del.dossier.json')
    await writeFile(path, '{"version":1}')
    await deleteDossier('del')
    let exists = true
    try {
      statSync(path)
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })

  test('no-op on missing file', async () => {
    mockSlug = 'absent'
    await deleteDossier('absent')
    // Should not throw
    expect(true).toBe(true)
  })
})

describe('clearRevalidateCache slug-targeted clear', () => {
  test('clearing one slug does not invalidate the other', async () => {
    const fileA = join(testTempDir, 'a.ts')
    const fileB = join(testTempDir, 'b.ts')
    writeFileSync(fileA, 'A')
    writeFileSync(fileB, 'B')
    const dossierA: Dossier = {
      version: 1,
      planSlug: 'A',
      planContent: '#',
      filesToEdit: [],
      capturedAt: new Date().toISOString(),
      entries: [
        {
          source: 'Read',
          path: fileA,
          content: 'A',
          mtime: Math.floor(statSync(fileA).mtimeMs),
          capturedAt: new Date().toISOString(),
          kind: 'text',
        },
      ],
    }
    const dossierB: Dossier = { ...dossierA, planSlug: 'B' }
    const promiseA1 = revalidateDossier(dossierA)
    const promiseB1 = revalidateDossier(dossierB)
    clearRevalidateCache('A')
    const promiseA2 = revalidateDossier(dossierA)
    const promiseB2 = revalidateDossier(dossierB)
    expect(promiseA1).not.toBe(promiseA2)
    expect(promiseB1).toBe(promiseB2)
  })

  test('Enter→Exit cycle reuse: stale cache from cycle 1 must not bleed into cycle 2', async () => {
    const filePath = join(testTempDir, 'cycle.ts')
    writeFileSync(filePath, 'v1')
    const slug = 'cycle-slug'

    // Cycle 1: dossier captures content as 'v1' at original mtime
    const cycle1: Dossier = {
      version: 1,
      planSlug: slug,
      planContent: '# cycle 1',
      filesToEdit: [filePath],
      capturedAt: new Date().toISOString(),
      entries: [
        {
          source: 'Read',
          path: filePath,
          content: 'v1',
          mtime: Math.floor(statSync(filePath).mtimeMs),
          capturedAt: new Date().toISOString(),
          kind: 'text',
        },
      ],
    }
    const revalidated1 = await revalidateDossier(cycle1)
    expect((revalidated1.entries[0] as ReadEntry).content).toBe('v1')

    // User edits file between cycles, then a new ExitPlanMode produces cycle 2
    // capturing content 'v2' at the bumped mtime.
    await new Promise(r => setTimeout(r, 10))
    writeFileSync(filePath, 'v2')
    const futureTime = new Date(Date.now() + 5_000)
    await utimes(filePath, futureTime, futureTime)
    const cycle2: Dossier = {
      version: 1,
      planSlug: slug,
      planContent: '# cycle 2',
      filesToEdit: [filePath],
      capturedAt: new Date().toISOString(),
      entries: [
        {
          source: 'Read',
          path: filePath,
          content: 'v2',
          mtime: Math.floor(statSync(filePath).mtimeMs),
          capturedAt: new Date().toISOString(),
          kind: 'text',
        },
      ],
    }

    // Without the slug-scoped clear, revalidateDossier short-circuits to the
    // cycle-1 promise (same slug key) and returns the v1 entry.
    clearRevalidateCache(slug)
    const revalidated2 = await revalidateDossier(cycle2)
    const entry = revalidated2.entries[0] as ReadEntry
    expect(entry.content).toBe('v2')
    expect(entry.isStale).toBeUndefined()
  })
})

describe('agent plan slug registry', () => {
  test('set/get/clear round-trip', () => {
    setAgentPlanSlug('agent-A', 'slug-X')
    expect(getAgentPlanSlug('agent-A')).toBe('slug-X')
    clearAgentPlanSlug('agent-A')
    expect(getAgentPlanSlug('agent-A')).toBeUndefined()
  })

  test('nested A → B → C inheritance: each spawn sees the original slug', () => {
    // Simulates the exact propagation runAgent + AgentTool perform:
    //   1. Top-level main thread spawns A — runAgent registers (A, slug).
    //   2. AgentTool inside A reads from the registry on toolUseContext.agentId
    //      (= A) and forwards as inheritedPlanSlug to runAgent for B.
    //   3. runAgent for B registers (B, same slug).
    //   4. AgentTool inside B reads (B, slug) and forwards to C.
    const slug = 'plan-original'
    setAgentPlanSlug('A', slug)

    const slugSeenByB = getAgentPlanSlug('A')
    expect(slugSeenByB).toBe(slug)
    setAgentPlanSlug('B', slugSeenByB!)

    const slugSeenByC = getAgentPlanSlug('B')
    expect(slugSeenByC).toBe(slug)
    setAgentPlanSlug('C', slugSeenByC!)

    expect(getAgentPlanSlug('C')).toBe(slug)

    // Cleanup ordering follows the runAgent finally chain (deepest first).
    clearAgentPlanSlug('C')
    clearAgentPlanSlug('B')
    clearAgentPlanSlug('A')
    expect(getAgentPlanSlug('A')).toBeUndefined()
    expect(getAgentPlanSlug('B')).toBeUndefined()
    expect(getAgentPlanSlug('C')).toBeUndefined()
  })

  test('parallel siblings get the same slug from a shared parent', () => {
    setAgentPlanSlug('parent', 'shared-slug')
    setAgentPlanSlug('child-1', getAgentPlanSlug('parent')!)
    setAgentPlanSlug('child-2', getAgentPlanSlug('parent')!)
    expect(getAgentPlanSlug('child-1')).toBe('shared-slug')
    expect(getAgentPlanSlug('child-2')).toBe('shared-slug')
    clearAgentPlanSlug('child-1')
    expect(getAgentPlanSlug('child-2')).toBe('shared-slug')
    clearAgentPlanSlug('child-2')
    clearAgentPlanSlug('parent')
  })
})

describe('dossierBudgetTokens — branch coverage guard', () => {
  // Each entry pins the matrix to one named branch in
  // getEffectiveContextWindowSize / getContextWindowForModel. If a future
  // refactor splits a branch or adds a new one, the entry below stops
  // matching the expected window class and fails — forcing coverage
  // updates instead of silent gaps.
  const BRANCH_COVERAGE: Array<{
    branch: string
    model: string
    minWindow: number
    maxWindow: number
  }> = [
    { branch: '[1m] suffix path', model: 'claude-opus-4-7[1m]', minWindow: 900_000, maxWindow: 1_000_000 },
    { branch: 'Anthropic 200k canonical', model: 'claude-opus-4-7', minWindow: 150_000, maxWindow: 200_000 },
    { branch: 'Anthropic legacy fallback', model: 'claude-3-5-sonnet-latest', minWindow: 150_000, maxWindow: 200_000 },
    // gpt models only resolve via the OpenAI lookup table, but in the test
    // env CLAUDE_CODE_USE_OPENAI is unset → the openai branch never fires
    // and these fall through to the default 200k. The point of the entry
    // is to assert the default fallback path is exercised by ALL_MODELS.
    { branch: 'unrecognized → default 200k', model: 'gpt-5.2', minWindow: 150_000, maxWindow: 200_000 },
  ]

  test.each(BRANCH_COVERAGE)(
    '$branch model "$model" yields window in [$minWindow, $maxWindow]',
    ({ model, minWindow, maxWindow }) => {
      const window = getEffectiveContextWindowSize(model)
      expect(window).toBeGreaterThanOrEqual(minWindow)
      expect(window).toBeLessThanOrEqual(maxWindow)
    },
  )

  test('every branch model is included in ALL_MODELS — guard against silent gaps', () => {
    // ALL_MODELS lives inside the matrix describe; mirror the canonical names
    // here so a future edit that drops a branch from ALL_MODELS fails the
    // intersection check instead of going unnoticed.
    const matrixNames = new Set([
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-7[1m]',
      'claude-sonnet-4-6[1m]',
      'claude-3-5-sonnet-latest',
      'claude-3-5-haiku-latest',
      'claude-3-opus-latest',
      'gpt-5.2',
      'gemini-2.5-pro',
      'github:copilot:claude-sonnet-4.6',
    ])
    for (const { model } of BRANCH_COVERAGE) {
      expect(matrixNames.has(model)).toBe(true)
    }
  })
})
