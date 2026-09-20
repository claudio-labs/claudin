// Shared fixtures and helpers for the FileReadTool suites.
//
// All of this used to sit at the top of a single 2177-line
// `FileReadTool.test.ts`, above 10 describes. That file is now eight
// topic-scoped siblings (baseline, outlineView, lineNumbering, dedup, the
// three clipPin* files, encoding) and the helpers moved here unchanged — the
// only thing that changed SHAPE is the environment pair.
//
// `CLAUDIN_SIMPLE` and `CLAUDIN_DISABLE_TOOL_RESULT_CACHE` were set at module
// scope and restored in a module-scope `afterAll`. That is correct in one
// file and wrong in eight: `bun test` runs every file in one process, so
// whichever suite finishes FIRST runs that `afterAll` and hands the
// tool-result cache back to the other seven — which then short-circuit
// `call()` on identical inputs and silently stop exercising the in-call dedup
// paths they exist to test. `.claudin/rules/testing.md` records this exact
// pair as a past incident. So the assignment lives in `useFileReadEnv()`,
// which each suite calls at its own top level and which arms and restores in
// that file's scope.
//
// This is NOT a `*.test.ts` file: it declares no tests and bun does not
// collect it. It is only ever imported.

import { afterAll, beforeAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from 'src/tools/Tool.js'
import {
  READ_FILE_STATE_CACHE_SIZE,
  createFileStateCacheWithSizeLimit,
} from 'src/shared/fs/fileStateCache.js'
import {
  _resetAllClippedIdsForTesting,
  buildClipStub,
} from 'src/agent/compact/stableStubState.js'
import { userWithToolResult } from 'src/tools/FileReadTool/__test-helpers__/contextManagementFixtures.js'
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'

/** The per-file fixture directory. Each suite gets its own — fixtures are
 * written per test, so sharing one across files would only couple them. */
let dir = ''

export function fixtureDir(): string {
  return dir
}

const priorEnv: Record<string, string | undefined> = {}
const MANAGED_ENV = ['CLAUDIN_SIMPLE', 'CLAUDIN_DISABLE_TOOL_RESULT_CACHE'] as const

/**
 * Call once at the top level of each FileReadTool suite.
 *
 * Registers the hooks in THAT file's scope, which is the whole point: the env
 * pair below is process-global and read per call, so setting it at module
 * scope — as the pre-split file did — means the first suite to finish hands
 * the tool-result cache back to the other seven and silently masks the dedup
 * paths they assert on.
 *
 * Skill discovery touches the real filesystem and is irrelevant here, which is
 * what CLAUDIN_SIMPLE suppresses. The cache is disabled because it
 * short-circuits call() on identical inputs.
 */
export function useFileReadEnv(): void {
  beforeAll(() => {
    for (const key of MANAGED_ENV) priorEnv[key] = process.env[key]
    process.env.CLAUDIN_SIMPLE = '1'
    process.env.CLAUDIN_DISABLE_TOOL_RESULT_CACHE = '1'
    dir = mkdtempSync(join(tmpdir(), 'fileread-regression-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of MANAGED_ENV) restoreEnv(key, priorEnv[key])
  })
}

/** The clip-pin suites force the feature on for their whole file and reset the
 * pin registry per case — it is module-global state. */
export function useForcedClipPin(): void {
  beforeAll(() => {
    process.env.CLAUDIN_FORCE_READ_CLIP_PIN = '1'
  })
  afterAll(() => {
    delete process.env.CLAUDIN_FORCE_READ_CLIP_PIN
  })
  beforeEach(() => {
    _resetAllClippedIdsForTesting()
  })
}

export function restoreEnv(name: string, prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = prior
  }
}

export function writeFixture(name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

export type ContextOverrides = {
  fileReadingLimits?: ToolUseContext['fileReadingLimits']
  messages?: unknown[]
  toolUseId?: string
}

export function makeContext(overrides: ContextOverrides = {}): ToolUseContext {
  return {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
    fileReadingLimits: overrides.fileReadingLimits,
    messages: overrides.messages,
    toolUseId: overrides.toolUseId,
    getAppState: () => ({ toolPermissionContext: {} }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

/** Swap the transcript a context exposes to the dedup scanners mid-test —
 *  mirrors toolUseContext.messages being reassigned each query iteration. */
export function setContextMessages(ctx: ToolUseContext, messages: unknown[]): void {
  ;(ctx as unknown as { messages: unknown[] }).messages = messages
}

export type ReadInput = {
  offset?: number
  limit?: number
  view?: 'outline'
  symbol?: string
  encoding?: string
}

export async function read(
  filePath: string,
  input: ReadInput = {},
  context: ToolUseContext = makeContext(),
) {
  return FileReadTool.call(
    { file_path: filePath, ...input },
    context,
    undefined as never,
    undefined as never,
  )
}

// ---------------------------------------------------------------------------
// Smart Code Navigation — view / symbol / auto-outline.
// ---------------------------------------------------------------------------

export const SAMPLE_TS = [
  'export function alpha(x: number): number {',
  '  return x + 1',
  '}',
  '',
  'export class Widget {',
  '  render(): string {',
  '    return "w"',
  '  }',
  '}',
  '',
  'export const beta = (y: number) => {',
  '  return y * 2',
  '}',
].join('\n')

// ---------------------------------------------------------------------------
// Smart Code Navigation — one language per scanner family (C-like, end-block,
// dedicated) exercised end-to-end through the tool: outline, symbol unfold,
// and the symbol-not-found error.
// ---------------------------------------------------------------------------

export const SAMPLE_CPP = [
  'struct Point {',
  '  int x;',
  '};',
  '',
  'int add(int a, int b) {',
  '  return a + b;',
  '}',
].join('\n')

export const SAMPLE_RB = [
  'class Greeter',
  '  def greet(name)',
  '    "hi #{name}"',
  '  end',
  'end',
].join('\n')

export const SAMPLE_SQL = [
  'CREATE TABLE users (',
  '  id INT',
  ');',
  '',
  'CREATE VIEW active AS SELECT 1;',
].join('\n')

export const SAMPLE_CSS = ['.header {', '  color: red;', '}'].join('\n')

export const SAMPLE_HTML = ['<main id="app">', '  <h1>Title</h1>', '</main>'].join('\n')

// ---------------------------------------------------------------------------
// Clip-pin stand-down — when a Read's tool_result is clipped out of context and
// the model re-reads the same (file, range), re-sending the body is only useful
// if the copy survives: the stand-down therefore re-sends ONCE and pins that
// copy, which every clip path skips. If the pinned copy is clipped anyway
// (server-side clear, eviction), re-sending is provably futile and a stable
// form is served instead — the file's structural outline for code, a textual
// redirect stub otherwise.
// ---------------------------------------------------------------------------

let pinIdSeq = 0
/** tool_use id of the most recent read issued through the helpers below. */
let lastReadToolUseId = ''

/** Accessor, not the binding: an importer of a `let` would read a snapshot,
 *  and every assertion below cares about the id of the read it just issued. */
export function lastToolUseId(): string {
  return lastReadToolUseId
}

export function assignFreshToolUseId(ctx: ToolUseContext): void {
  lastReadToolUseId = `toolu_clip_pin_${++pinIdSeq}`
  ;(ctx as unknown as { toolUseId: string }).toolUseId = lastReadToolUseId
}

/** Longest run of consecutive `value`s in `xs` — the shape the bounds are
 *  stated in ("never two futile re-sends in a row"). */
export function longestRun<T>(xs: readonly T[], value: T): number {
  let best = 0
  let cur = 0
  for (const x of xs) {
    cur = x === value ? cur + 1 : 0
    if (cur > best) best = cur
  }
  return best
}

/** Read `p` with the transcript showing the PRIOR Read's result clipped to a
 *  stub — the exact condition the client-clipping stand-down detects. Each call
 *  gets its own tool_use id, like a real turn, so pins never conflate two
 *  reads. Returns the full call result so callers can inspect `noResultCache`. */
export async function readWithPriorClipped(
  p: string,
  ctx: ToolUseContext,
  input: ReadInput = {},
) {
  const priorId = ctx.readFileState.get(p)?.toolUseId
  setContextMessages(
    ctx,
    priorId ? [userWithToolResult(priorId, buildClipStub('Read', 1234))] : [],
  )
  assignFreshToolUseId(ctx)
  return read(p, input, ctx)
}
