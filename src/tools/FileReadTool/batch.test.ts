// The batch Read — CLAUDIN_READ_MULTI (readMulti.ts, batchRead.ts).
//
// The flag is read once at module load, so the suite loads its own instance of
// FileReadTool.js with it on (and one with it off, for the identity checks).
// Only that module is re-evaluated: schemas.js, prompt.js and batchRead.js are
// the process-wide instances, which is also how the per-file recursion reaches
// the same cache and pin registries the rest of the suite sees.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'path'
import { AbortError } from 'src/shared/errors.js'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { expandPath } from 'src/shared/fs/path.js'
import {
  _resetAllClippedIdsForTesting,
  buildClipStub,
  isPinRegistered,
} from 'src/agent/compact/stableStubState.js'
import { __resetForTests as resetResultCache, getStats } from 'src/agent/tools/toolResultCache.js'
import type { SessionHooksState } from 'src/platform/lifecycleHooks/sessionHooks.js'
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
  type ToolUseContext,
} from 'src/tools/Tool.js'
import { seenRegionCoversText } from 'src/tools/shared/readBeforeEditMessages.js'
import { userWithToolResult } from 'src/tools/FileReadTool/__test-helpers__/contextManagementFixtures.js'
import {
  fixtureDir,
  makeContext,
  read,
  restoreEnv,
  SAMPLE_TS,
  setContextMessages,
  useFileReadEnv,
  writeFixture,
  type ReadInput,
} from 'src/tools/FileReadTool/__testutils__/fileReadHarness.js'
import { importWithReadMulti } from 'src/tools/FileReadTool/__testutils__/readMultiFlag.js'
import { readBatch } from 'src/tools/FileReadTool/batchRead.js'
import { FileReadTool as HarnessReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import { FILE_UNCHANGED_STUB } from 'src/tools/FileReadTool/prompt.js'
import {
  _resetReadReminderStateForTesting,
  _setMitigationModelResolverForTesting,
  CYBER_RISK_MITIGATION_REMINDER,
} from 'src/tools/FileReadTool/resultContent.js'
import type { Input, Output } from 'src/tools/FileReadTool/schemas.js'

useFileReadEnv()

type ReadModule = typeof import('src/tools/FileReadTool/FileReadTool.js')
type ReadTool = ReadModule['FileReadTool']

const MODULE = 'src/tools/FileReadTool/FileReadTool.js'
let ReadOn: ReadTool
let ReadOff: ReadTool
let priorMacro: unknown

beforeAll(async () => {
  ReadOn = (await importWithReadMulti<ReadModule>(MODULE, true)).FileReadTool
  ReadOff = (await importWithReadMulti<ReadModule>(MODULE, false)).FileReadTool
  // An exempt model: the once-per-agent mitigation reminder would otherwise
  // land on whichever read comes first and make every comparison order-bound.
  // The one test about it sets its own resolver.
  _setMitigationModelResolverForTesting(() => 'claude-opus-5-5')
  // A read permission check outside the working directories reaches the
  // build-time MACRO.VERSION (checkReadableInternalPath → bundled skills).
  priorMacro = (globalThis as Record<string, unknown>).MACRO
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: 'test' }
})

afterAll(() => {
  _setMitigationModelResolverForTesting(undefined)
  _resetReadReminderStateForTesting()
  if (priorMacro === undefined) delete (globalThis as Record<string, unknown>).MACRO
  else (globalThis as Record<string, unknown>).MACRO = priorMacro
})

const AGENT = 'batch-read-test-agent'

type TestAppState = {
  toolPermissionContext: ToolPermissionContext
  sessionHooks: SessionHooksState
}

function appState(overrides: Partial<TestAppState> = {}): TestAppState {
  return {
    toolPermissionContext: overrides.toolPermissionContext ?? getEmptyToolPermissionContext(),
    sessionHooks: overrides.sessionHooks ?? new Map(),
  }
}

let toolUseSeq = 0

function context(
  options: { maxTokens?: number; state?: TestAppState; toolUseId?: string } = {},
): ToolUseContext {
  const ctx = makeContext({
    fileReadingLimits:
      options.maxTokens === undefined ? undefined : { maxTokens: options.maxTokens },
    toolUseId: options.toolUseId ?? `toolu_batch_${++toolUseSeq}`,
  })
  const state = options.state ?? appState()
  Object.assign(ctx, {
    agentId: AGENT,
    nestedMemoryAttachmentTriggers: new Set<string>(),
    getAppState: () => state,
  })
  return ctx
}

async function call(tool: ReadTool, input: Input, ctx: ToolUseContext) {
  return tool.call(input, ctx, undefined as never, undefined as never)
}

/** The batch's model-facing text, as the tool_result carries it. */
function textOf(data: Output): string {
  if (data.type !== 'batch') throw new Error(`expected a batch result, got ${data.type}`)
  const block = ReadOn.mapToolResultToToolResultBlockParam(data, 'toolu_x')
  expect(block.content).toBe(data.content)
  return data.content
}

/** What a Read of that one file returns — the unit a batch is made of. */
async function singleText(filePath: string, input: ReadInput = {}): Promise<string> {
  const { data } = await read(filePath, input)
  return HarnessReadTool.mapToolResultToToolResultBlockParam(data, 'toolu_single')
    .content as string
}

/** Relative headers need the fixture dir as the working directory. */
function inFixtureDir<T>(fn: () => Promise<T>): Promise<T> {
  return runWithCwdOverride(fixtureDir(), fn)
}

const OTHER_TS = ['export function gamma(): string {', "  return 'g'", '}'].join('\n')

/** small1, a class too large to send whole (281 lines, 3 methods), small2. */
function bigSymbolSource(): string {
  const method = (name: string) => [
    `  ${name}(): number {`,
    ...Array.from({ length: 90 }, (_, i) => `    const v${i} = ${i}`),
    '    return 0',
    '  }',
  ]
  return [
    'export function small1(): number {',
    '  return 11',
    '}',
    '',
    'export class Big {',
    ...method('one'),
    ...method('two'),
    ...method('three'),
    '}',
    '',
    'export function small2(): number {',
    '  return 22',
    '}',
  ].join('\n')
}

function textLines(count: number, width: number, tag: string): string {
  return Array.from({ length: count }, (_, i) =>
    `${tag}-${i}-`.padEnd(width, 'x'),
  ).join('\n')
}

describe('batch Read — several files', () => {
  test('each file sits under its own header with exactly what a Read of it returns', async () => {
    const a = writeFixture('several-a.ts', SAMPLE_TS)
    const b = writeFixture('several-notes.txt', 'first\nsecond\n')
    const result = await inFixtureDir(() => call(ReadOn, { file_paths: [a, b] }, context()))
    expect(textOf(result.data)).toBe(
      `==> several-a.ts <==\n${await singleText(a)}\n\n==> several-notes.txt <==\n${await singleText(b)}`,
    )
    expect(result.noResultCache).toBe(true)
  })

  test('each file is an ordinary Read for readFileState and the nested_memory triggers', async () => {
    const a = writeFixture('state-a.ts', SAMPLE_TS)
    const b = writeFixture('state-b.ts', OTHER_TS)
    const ctx = context()
    await call(ReadOn, { file_paths: [a, b] }, ctx)
    for (const [p, content] of [
      [a, SAMPLE_TS],
      [b, OTHER_TS],
    ] as const) {
      const entry = ctx.readFileState.get(p)
      expect(entry?.content).toBe(content)
      expect(entry?.offset).toBe(1)
      expect(entry?.limit).toBeUndefined()
      expect(entry?.toolUseId).toBe(ctx.toolUseId)
      expect(ctx.nestedMemoryAttachmentTriggers?.has(p)).toBe(true)
    }
  })

  test("view: 'outline' applies to every file", async () => {
    const a = writeFixture('outline-a.ts', SAMPLE_TS)
    const b = writeFixture('outline-b.ts', OTHER_TS)
    const ctx = context()
    const result = await inFixtureDir(() =>
      call(ReadOn, { file_paths: [a, b], view: 'outline' }, ctx),
    )
    expect(textOf(result.data)).toBe(
      `==> outline-a.ts <==\n${await singleText(a, { view: 'outline' })}\n\n==> outline-b.ts <==\n${await singleText(b, { view: 'outline' })}`,
    )
    expect(ctx.readFileState.get(a)?.isPartialView).toBe(true)
  })

  test('a symbol is looked up in every file; the misses share one line', async () => {
    const a = writeFixture('sym-a.ts', SAMPLE_TS)
    const c = writeFixture('sym-c.ts', OTHER_TS)
    const result = await inFixtureDir(() =>
      call(ReadOn, { file_paths: [a, c], symbol: 'alpha' }, context()),
    )
    expect(textOf(result.data)).toBe(
      `==> sym-a.ts <==\n${await singleText(a, { symbol: 'alpha' })}\n\nSymbol not found: alpha in sym-c.ts.`,
    )
  })

  test('the stub stands in for a file already read at the same range', async () => {
    const a = writeFixture('stub-a.ts', SAMPLE_TS)
    const b = writeFixture('stub-b.ts', OTHER_TS)
    const c = writeFixture('stub-c.txt', 'c\n')
    const ctx = context()
    await call(ReadOn, { file_paths: [a, b] }, ctx)
    const again = await inFixtureDir(() => call(ReadOn, { file_paths: [a, c] }, ctx))
    expect(textOf(again.data)).toBe(
      `==> stub-a.ts <==\n${FILE_UNCHANGED_STUB}\n\n==> stub-c.txt <==\n${await singleText(c)}`,
    )
  })

  test('the auto-pivot still decides per file', async () => {
    const prior = process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION
    process.env.CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION = '1'
    try {
      const fn = (n: number) => [
        `export function big${n}(): void {`,
        ...Array.from({ length: 60 }, (_, i) => `  const a${i} = '${'x'.repeat(24)}'`),
        '}',
      ]
      const big = writeFixture('pivot-big.ts', [1, 2, 3, 4, 5].flatMap(fn).join('\n'))
      const small = writeFixture('pivot-small.ts', OTHER_TS)
      const ctx = context()
      const result = await inFixtureDir(() => call(ReadOn, { file_paths: [big, small] }, ctx))
      const text = textOf(result.data)
      expect(text).toBe(
        `==> pivot-big.ts <==\n${await singleText(big)}\n\n==> pivot-small.ts <==\n${await singleText(small)}`,
      )
      expect(text).toContain('returned outline instead of full body')
      expect(ctx.readFileState.get(big)?.isPartialView).toBe(true)
      expect(ctx.readFileState.get(small)?.isPartialView).toBeUndefined()
    } finally {
      restoreEnv('CLAUDIN_FORCE_AUTO_OUTLINE_ON_ELISION', prior)
    }
  })

  test('a file that fails reads its error under its header; the rest still read', async () => {
    const a = writeFixture('fail-a.ts', OTHER_TS)
    const missing = join(fixtureDir(), 'fail-missing.ts')
    const result = await inFixtureDir(() => call(ReadOn, { file_paths: [missing, a] }, context()))
    const text = textOf(result.data)
    expect(text.startsWith('==> fail-missing.ts <==\nFile does not exist.')).toBe(true)
    expect(text.endsWith(`==> fail-a.ts <==\n${await singleText(a)}`)).toBe(true)
  })

  test('images, PDFs and notebooks are sent back to a Read of their own, unread', async () => {
    const a = writeFixture('kinds-a.ts', OTHER_TS)
    const png = writeFixture('kinds-shot.png', 'not really a png')
    const pdf = writeFixture('kinds-doc.pdf', 'not really a pdf')
    const nb = writeFixture('kinds-nb.ipynb', '{"cells": []}')
    const ctx = context()
    const result = await inFixtureDir(() => call(ReadOn, { file_paths: [png, a, pdf, nb] }, ctx))
    expect(textOf(result.data)).toBe(
      `==> kinds-a.ts <==\n${await singleText(a)}\n\nNot read — images, PDFs and notebooks need a Read of their own: kinds-shot.png, kinds-doc.pdf, kinds-nb.ipynb.`,
    )
    expect(ctx.readFileState.get(png)).toBeUndefined()
  })

  // An interrupt ends the call; it is not one file's result to show.
  test('an abort ends the batch instead of becoming a section of it', async () => {
    const a = writeFixture('abort-a.ts', OTHER_TS)
    const b = writeFixture('abort-b.ts', SAMPLE_TS)
    let reads = 0
    const aborted = readBatch({ file_paths: [a, b] }, context(), async () => {
      reads++
      throw new AbortError('interrupted')
    })
    await expect(aborted).rejects.toBeInstanceOf(AbortError)
    expect(reads).toBe(1)
  })

  test('a path named twice is read once', async () => {
    const a = writeFixture('twice-a.ts', OTHER_TS)
    const b = writeFixture('twice-b.ts', SAMPLE_TS)
    const result = await inFixtureDir(() => call(ReadOn, { file_paths: [a, b, a] }, context()))
    expect(textOf(result.data).split('==> twice-a.ts <==')).toHaveLength(2)
  })

  test('the result names the files and line counts the renderer shows', async () => {
    const a = writeFixture('summary-a.ts', SAMPLE_TS)
    const b = writeFixture('summary-b.ts', OTHER_TS)
    const { data } = await call(ReadOn, { file_paths: [a, b] }, context())
    if (data.type !== 'batch') throw new Error('expected a batch')
    expect(data.files).toEqual([
      { filePath: a, lines: 13 },
      { filePath: b, lines: 3 },
    ])
    expect(data.notShown).toEqual([])
  })
})

describe('batch Read — the token budget', () => {
  // Each file stays under a quarter of the cap in characters, so the per-file
  // guard never needs the counting API; five of them overrun the whole call.
  const MAX_TOKENS = 1500

  function budgetFiles(tag: string): string[] {
    return [0, 1, 2, 3, 4, 5].map(i =>
      writeFixture(`${tag}-${i}.txt`, textLines(30, 44, `${tag}${i}`)),
    )
  }

  test('files past the budget are listed at the end, in order', async () => {
    const files = budgetFiles('budget')
    const result = await inFixtureDir(() =>
      call(ReadOn, { file_paths: files }, context({ maxTokens: MAX_TOKENS })),
    )
    if (result.data.type !== 'batch') throw new Error('expected a batch')
    const shown = result.data.files.length
    expect(shown).toBeGreaterThan(0)
    expect(shown).toBeLessThan(files.length)
    const notShown = files.slice(shown).map(f => f.slice(fixtureDir().length + 1))
    expect(result.data.notShown).toEqual(notShown)
    const text = textOf(result.data)
    expect(
      text.endsWith(
        `Not shown — over the 2k tokens one Read returns: ${notShown.join(', ')}. Read them in another call.`,
      ),
    ).toBe(true)
    // The shown part stays inside the budget it claims.
    const shownPart = text.slice(0, text.lastIndexOf('\n\nNot shown'))
    expect(shownPart.length / 4).toBeLessThanOrEqual(MAX_TOKENS)
  })

  test('a file left out is not a read: no entry, no trigger, the earlier entry kept', async () => {
    const files = budgetFiles('rollback')
    const last = files[files.length - 1]!
    const ctx = context({ maxTokens: MAX_TOKENS })
    // An earlier range Read of the last file: the batch must hand it back.
    await read(last, { offset: 2, limit: 3 }, ctx)
    const earlier = ctx.readFileState.get(last)
    const result = await call(ReadOn, { file_paths: files }, ctx)
    if (result.data.type !== 'batch') throw new Error('expected a batch')
    const shown = result.data.files.length
    for (const f of files.slice(shown, -1)) {
      expect(ctx.readFileState.get(f)).toBeUndefined()
      expect(ctx.nestedMemoryAttachmentTriggers?.has(f)).toBe(false)
    }
    expect(ctx.readFileState.get(last)).toBe(earlier)
    for (const f of files.slice(0, shown)) {
      expect(ctx.readFileState.get(f)?.offset).toBe(1)
      expect(ctx.nestedMemoryAttachmentTriggers?.has(f)).toBe(true)
    }
  })

  test("a file left out does not spend the agent's one mitigation reminder", async () => {
    _setMitigationModelResolverForTesting(() => 'not-an-exempt-model')
    _resetReadReminderStateForTesting()
    try {
      // The first file alone overruns the budget: it is read (and flagged)
      // first, then dropped. The reminder must land on the next one. 400 blank
      // lines keep its bytes at the per-file guard's cheap estimate — past it
      // the guard asks the counting API — while their numbers render well
      // over the 400-token budget.
      const blank = writeFixture('reminder-blank.txt', '\n'.repeat(400))
      const small = writeFixture('reminder-small.txt', 'small\n')
      const result = await call(
        ReadOn,
        { file_paths: [blank, small] },
        context({ maxTokens: 400 }),
      )
      const text = textOf(result.data)
      expect(text).toContain(CYBER_RISK_MITIGATION_REMINDER)
      expect(text).toContain('Not shown')
    } finally {
      _setMitigationModelResolverForTesting(() => 'claude-opus-5-5')
      _resetReadReminderStateForTesting()
    }
  })
})

describe('batch Read — several symbols of one file', () => {
  test('one header, each body as a symbol Read returns it', async () => {
    const a = writeFixture('multi-a.ts', SAMPLE_TS)
    const result = await inFixtureDir(() =>
      call(ReadOn, { file_path: a, symbol: ['alpha', 'beta'] }, context()),
    )
    expect(textOf(result.data)).toBe(
      `==> multi-a.ts <==\n${await singleText(a, { symbol: 'alpha' })}\n\n${await singleText(a, { symbol: 'beta' })}`,
    )
  })

  test('every body the list showed passes the read-before-edit gate', async () => {
    const a = writeFixture('gate-a.ts', SAMPLE_TS)
    const ctx = context()
    await call(ReadOn, { file_path: a, symbol: ['alpha', 'beta'] }, ctx)
    const entry = ctx.readFileState.get(a)!
    expect(entry.isPartialView).toBeUndefined()
    // The FIRST symbol's body — the one a single offset/limit would lose.
    expect(seenRegionCoversText(entry, 'return x + 1')).toBe(true)
    expect(seenRegionCoversText(entry, 'return y * 2')).toBe(true)
    // Never shown: Widget sits between the two.
    expect(seenRegionCoversText(entry, 'return "w"')).toBe(false)
  })

  test('a symbol that comes back as an outline does not erase the bodies around it', async () => {
    const big = writeFixture('gate-big.ts', bigSymbolSource())
    const ctx = context()
    const result = await call(ReadOn, { file_path: big, symbol: ['small1', 'Big', 'small2'] }, ctx)
    expect(textOf(result.data)).toContain("Symbol 'Big'")
    const entry = ctx.readFileState.get(big)!
    expect(entry.isPartialView).toBeUndefined()
    expect(seenRegionCoversText(entry, 'return 11')).toBe(true)
    expect(seenRegionCoversText(entry, 'return 22')).toBe(true)
    // Big's lines were shown as an outline, never as text.
    expect(seenRegionCoversText(entry, 'const v42 = 42')).toBe(false)

    const tail = context()
    await call(ReadOn, { file_path: big, symbol: ['small1', 'Big'] }, tail)
    const tailEntry = tail.readFileState.get(big)!
    expect(tailEntry.isPartialView).toBeUndefined()
    expect(seenRegionCoversText(tailEntry, 'return 11')).toBe(true)
  })

  // With nothing to expand, each symbol falls back to the whole body, and the
  // batch shows that body once.
  test('a file with no symbols to expand is shown once, not once per symbol', async () => {
    const notes = writeFixture('multi-notes.txt', 'first\nsecond\n')
    const result = await inFixtureDir(() =>
      call(ReadOn, { file_path: notes, symbol: ['alpha', 'beta'] }, context()),
    )
    expect(textOf(result.data)).toBe(`==> multi-notes.txt <==\n${await singleText(notes)}`)
  })

  test('a one-name list is an ordinary symbol Read', async () => {
    const a = writeFixture('one-name.ts', SAMPLE_TS)
    const listed = await call(ReadOn, { file_path: a, symbol: ['alpha'] }, context())
    const plain = await call(ReadOff, { file_path: a, symbol: 'alpha' }, context())
    expect(listed).toEqual(plain)
  })
})

describe('batch Read — validateInput', () => {
  async function validate(input: Input, ctx = context()) {
    return ReadOn.validateInput(input, ctx)
  }

  test('exactly one of file_path and file_paths', async () => {
    const a = writeFixture('xor-a.ts', OTHER_TS)
    const neither = await validate({})
    const both = await validate({ file_path: a, file_paths: [a, a] })
    for (const result of [neither, both]) {
      expect(result.result).toBe(false)
    }
    if (neither.result === false) expect(neither.message).toContain('file_paths')
    if (both.result === false) expect(both.message).toContain('not both')
  })

  test('offset, limit, pages and encoding are single-file only', async () => {
    const a = writeFixture('combo-a.ts', OTHER_TS)
    const b = writeFixture('combo-b.ts', OTHER_TS)
    for (const extra of [{ offset: 2 }, { limit: 5 }, { pages: '1-2' }, { encoding: 'latin1' }]) {
      const result = await validate({ file_paths: [a, b], ...extra })
      expect(result.result).toBe(false)
      if (result.result === false) expect(result.message).toContain(Object.keys(extra)[0]!)
    }
    // A symbol list on one file keeps its encoding.
    expect((await validate({ file_path: a, symbol: ['x', 'y'], encoding: 'latin1' })).result).toBe(
      true,
    )
  })

  test("each path gets a single Read's checks, and a failure names the path", async () => {
    const a = writeFixture('checks-a.ts', OTHER_TS)
    const bin = writeFixture('checks-lib.so', 'x')
    const result = await validate({ file_paths: [a, bin] })
    expect(result.result).toBe(false)
    if (result.result === false) {
      expect(result.message).toContain(bin)
      expect(result.message).toContain('cannot read binary files')
    }
    const denied = await validate(
      { file_paths: [a, writeFixture('checks-b.ts', OTHER_TS)] },
      context({
        state: appState({
          toolPermissionContext: {
            ...getEmptyToolPermissionContext(),
            alwaysDenyRules: { cliArg: [`Read(/${a})`] },
          },
        }),
      }),
    )
    expect(denied.result).toBe(false)
  })

  test('the Codex placeholders parse to an ordinary batch', async () => {
    const schemas = await importWithReadMulti<typeof import('src/tools/FileReadTool/schemas.js')>(
      'src/tools/FileReadTool/schemas.js',
      true,
    )
    const a = writeFixture('codex-a.ts', SAMPLE_TS)
    const b = writeFixture('codex-b.ts', OTHER_TS)
    const input = schemas.inputSchema().parse({ file_path: null, file_paths: [a, b], symbol: '' })
    const ctx = context()
    expect(await validate(input, ctx)).toEqual({ result: true })
    const result = await call(ReadOn, input, ctx)
    expect(result.data.type).toBe('batch')
  })
})

describe('batch Read — permissions', () => {
  function fixtureAsWorkingDir(): ToolPermissionContext['additionalWorkingDirectories'] {
    return new Map([[fixtureDir(), { path: fixtureDir(), source: 'cliArg' as const }]])
  }

  test('a deny on one file denies the call and names it', async () => {
    const a = writeFixture('perm-a.ts', OTHER_TS)
    const b = writeFixture('perm-b.ts', OTHER_TS)
    const decision = await ReadOn.checkPermissions(
      { file_paths: [a, b] },
      context({
        state: appState({
          toolPermissionContext: {
            ...getEmptyToolPermissionContext(),
            additionalWorkingDirectories: fixtureAsWorkingDir(),
            alwaysDenyRules: { cliArg: [`Read(/${b})`] },
          },
        }),
      }),
    )
    expect(decision.behavior).toBe('deny')
    if (decision.behavior === 'deny') {
      expect(decision.message).toContain(b)
      expect(decision.message).not.toContain(a)
    }
  })

  test('files outside the working directories make ONE ask listing them', async () => {
    const a = writeFixture('ask-a.ts', OTHER_TS)
    const b = writeFixture('ask-b.ts', OTHER_TS)
    const decision = await ReadOn.checkPermissions({ file_paths: [a, b] }, context())
    expect(decision.behavior).toBe('ask')
    if (decision.behavior === 'ask') {
      expect(decision.message).toContain(a)
      expect(decision.message).toContain(b)
    }
  })

  test('an allow hands the real input back, never a placeholder', async () => {
    const a = writeFixture('allow-a.ts', OTHER_TS)
    const b = writeFixture('allow-b.ts', OTHER_TS)
    const input: Input = { file_paths: [a, b], view: 'outline' }
    const decision = await ReadOn.checkPermissions(
      input,
      context({
        state: appState({
          toolPermissionContext: {
            ...getEmptyToolPermissionContext(),
            additionalWorkingDirectories: fixtureAsWorkingDir(),
          },
        }),
      }),
    )
    expect(decision.behavior).toBe('allow')
    if (decision.behavior === 'allow') expect(decision.updatedInput).toBe(input)
  })

  // The one ask's dialog titles itself with one path; the ask lists them all.
  test('the permission dialog is titled with the first file of the batch', () => {
    const a = join(fixtureDir(), 'title-a.ts')
    const b = join(fixtureDir(), 'title-b.ts')
    expect(ReadOn.getPath({ file_paths: [a, b] })).toBe(a)
  })
})

describe('batch Read — hooks', () => {
  function hooked(event: 'PreToolUse' | 'PostToolUse', matcher: string): TestAppState {
    return appState({
      sessionHooks: new Map([
        [
          AGENT,
          {
            hooks: {
              [event]: [{ matcher, hooks: [{ hook: { type: 'command', command: 'true' } }] }],
            },
          },
        ],
      ]) as SessionHooksState,
    })
  }

  test('a hook that would see a Read refuses the batch', async () => {
    const a = writeFixture('hook-a.ts', OTHER_TS)
    const b = writeFixture('hook-b.ts', OTHER_TS)
    for (const state of [hooked('PreToolUse', 'Read'), hooked('PostToolUse', 'Read'), hooked('PreToolUse', '*')]) {
      const result = await ReadOn.validateInput({ file_paths: [a, b] }, context({ state }))
      expect(result).toEqual({
        result: false,
        message: 'Batch Read is off while a Read hook is configured — read one file per call.',
        errorCode: expect.any(Number),
      })
    }
  })

  test('a hook question that cannot be answered refuses the batch', async () => {
    // Fails closed: an app state with no session-hook store (the shape the
    // harness's own contexts carry) makes the lookup throw, and one file per
    // call is what every hook can see.
    const a = writeFixture('hook-closed-a.ts', OTHER_TS)
    const b = writeFixture('hook-closed-b.ts', OTHER_TS)
    const ctx = context()
    Object.assign(ctx, {
      getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }),
    })
    const result = await ReadOn.validateInput({ file_paths: [a, b] }, ctx)
    expect(result.result).toBe(false)
    if (result.result === false) {
      expect(result.message).toBe(
        'Batch Read is off while a Read hook is configured — read one file per call.',
      )
    }
  })

  test('a hook for another tool leaves it alone, and so does one file with a symbol list', async () => {
    const a = writeFixture('hook-c.ts', OTHER_TS)
    const b = writeFixture('hook-d.ts', OTHER_TS)
    expect(
      await ReadOn.validateInput({ file_paths: [a, b] }, context({ state: hooked('PreToolUse', 'Bash') })),
    ).toEqual({ result: true })
    // The hook still receives file_path for this one.
    expect(
      await ReadOn.validateInput(
        { file_path: a, symbol: ['gamma', 'delta'] },
        context({ state: hooked('PreToolUse', 'Read') }),
      ),
    ).toEqual({ result: true })
  })

  // Only PreToolUse and PostToolUse hooks refuse a batch. A PermissionRequest
  // or PostToolUseFailure hook still runs on one: it gets the backfilled
  // tool_input, and its `if` condition goes through preparePermissionMatcher.
  test('the backfilled input a hook sees holds every path of a batch expanded', () => {
    const input: Record<string, unknown> = { file_paths: ['rel/a.ts', '~/b.ts'] }
    ReadOn.backfillObservableInput?.(input)
    expect(input.file_paths).toEqual([expandPath('rel/a.ts'), expandPath('~/b.ts')])
  })

  test('an if-condition fires on any file of a batch, not only the first', async () => {
    const matches = await ReadOn.preparePermissionMatcher?.({ file_paths: ['/repo/a.ts', '/repo/.env'] })
    expect(matches?.('*.env')).toBe(true)
    expect(matches?.('*.md')).toBe(false)
  })
})

describe('batch Read — no result cache, no clip pin', () => {
  test('neither the batch nor a file inside it enters the result cache', async () => {
    const prior = process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE
    delete process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE
    resetResultCache()
    try {
      const a = writeFixture('cache-a.ts', SAMPLE_TS)
      const b = writeFixture('cache-b.ts', OTHER_TS)
      const input: Input = { file_paths: [a, b] }
      const ctx = context()
      expect(ReadOn.bypassResultCache?.(input, ctx)).toBe(true)
      await call(ReadOn, input, ctx)
      await call(ReadOn, { file_path: a, symbol: ['alpha', 'beta'] }, context())
      // No store and not even a lookup.
      expect(getStats()).toEqual({ hits: 0, misses: 0, evictions: 0, bytesStored: 0 })
    } finally {
      restoreEnv('CLAUDIN_DISABLE_TOOL_RESULT_CACHE', prior)
      resetResultCache()
    }
  })

  test('a stand-down re-send inside a batch is never pinned — a single Read of it is', async () => {
    const prior = process.env.CLAUDIN_FORCE_READ_CLIP_PIN
    process.env.CLAUDIN_FORCE_READ_CLIP_PIN = '1'
    _resetAllClippedIdsForTesting()
    try {
      // Prior Read of `a`, whose tool_result the transcript then shows clipped:
      // the next Read of the same range is the stand-down re-send.
      const setUp = async (name: string) => {
        const a = writeFixture(name, SAMPLE_TS)
        const ctx = context({ toolUseId: `toolu_prior_${name}` })
        await read(a, {}, ctx)
        setContextMessages(ctx, [userWithToolResult(`toolu_prior_${name}`, buildClipStub('Read', 1234))])
        return { a, ctx }
      }

      const single = await setUp('pin-single.ts')
      Object.assign(single.ctx, { toolUseId: 'toolu_single_resend' })
      await read(single.a, {}, single.ctx)
      // The scenario reaches the pin: without this the batch half proves nothing.
      expect(isPinRegistered('toolu_single_resend')).toBe(true)

      const batched = await setUp('pin-batch.ts')
      const b = writeFixture('pin-batch-b.ts', OTHER_TS)
      Object.assign(batched.ctx, { toolUseId: 'toolu_batch_resend' })
      const result = await call(ReadOn, { file_paths: [batched.a, b] }, batched.ctx)
      expect(textOf(result.data)).toContain('export function alpha')
      expect(isPinRegistered('toolu_batch_resend')).toBe(false)
    } finally {
      restoreEnv('CLAUDIN_FORCE_READ_CLIP_PIN', prior)
      _resetAllClippedIdsForTesting()
    }
  })
})

describe('batch Read — flag off', () => {
  test('a single Read is the same with the flag on or off', async () => {
    const a = writeFixture('same-a.ts', SAMPLE_TS)
    for (const input of [{}, { view: 'outline' as const }, { symbol: 'beta' }, { offset: 2, limit: 3 }]) {
      const on = await call(ReadOn, { file_path: a, ...input }, context())
      const off = await call(ReadOff, { file_path: a, ...input }, context())
      expect(on).toEqual(off)
    }
  })

  test('the flag-off tool neither validates nor dispatches a batch', async () => {
    const a = writeFixture('off-a.ts', OTHER_TS)
    const b = writeFixture('off-b.ts', OTHER_TS)
    // No batch branch: the single-file path runs, and has no file_path.
    await expect(ReadOff.validateInput({ file_paths: [a, b] }, context())).rejects.toThrow()
    await expect(call(ReadOff, { file_paths: [a, b] }, context())).rejects.toThrow()
  })
})

describe('batch Read — the auto-mode classifier', () => {
  test('sees every path of a batch, one per line', () => {
    expect(ReadOn.toAutoClassifierInput({ file_paths: ['/r/a.ts', '/r/b.ts'] })).toBe(
      '/r/a.ts\n/r/b.ts',
    )
  })

  test('sees a single path as it always has, as stored with Codex placeholders too', () => {
    // The transcript keeps the model's own arguments: under the batch-capable
    // schema a Codex single Read carries `file_paths: null`.
    const codexSingle = { file_path: '/r/a.ts', file_paths: null } as unknown as Input
    for (const tool of [ReadOn, ReadOff]) {
      expect(tool.toAutoClassifierInput({ file_path: '/r/a.ts' })).toBe('/r/a.ts')
      expect(tool.toAutoClassifierInput(codexSingle)).toBe('/r/a.ts')
      expect(tool.toAutoClassifierInput({ file_path: '/r/a.ts', symbol: ['x', 'y'] })).toBe(
        '/r/a.ts',
      )
    }
  })
})
