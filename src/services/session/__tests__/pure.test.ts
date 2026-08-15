// Characterization tests for purely-functional exports of
// src/services/session/sessionStorage.ts. Wave 0 of the 11c split: locks in observable
// behavior of type guards, path computation, first-prompt extraction, JSONL
// byte-level stripping, and logging filters BEFORE the source is broken into
// submodules. No production code is modified by this file.
//
// Scope is intentionally narrow — Project-backed tests (record*, flush,
// session metadata) live in characterization.test.ts and the upcoming
// project.test.ts. Everything here is callable without bootstrap state
// except #2 (paths), which uses switchSession() to materialize a sessionId.

import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'

import { resetStateForTests, switchSession } from 'src/platform/bootstrap/state.js'
import { asAgentId, asSessionId } from 'src/types/ids.js'
import {
  clearAgentTranscriptSubdir,
  cleanMessagesForLogging,
  getAgentTranscriptPath,
  getFirstMeaningfulUserMessageTextContent,
  getProjectDir,
  getProjectsDir,
  getTranscriptPath,
  getTranscriptPathForSession,
  isChainParticipant,
  isEphemeralToolProgress,
  isLoggableMessage,
  isTranscriptMessage,
  removeExtraFields,
  resetProjectForTesting,
  setAgentTranscriptSubdir,
  stripPersistedToolUseResultsFromJSONLBuffer,
} from 'src/services/session/sessionStorage.js'

const ORIGINAL_CWD = process.cwd()
const ORIGINAL_CONFIG_DIR = process.env.CLAUDIN_CONFIG_DIR
const ORIGINAL_NODE_ENV = process.env.NODE_ENV

let tmpDir: string

beforeEach(async () => {
  process.env.NODE_ENV = 'test'
  tmpDir = await mkdtemp(join(tmpdir(), 'sessstor-pure-'))
  process.env.CLAUDIN_CONFIG_DIR = tmpDir
  resetStateForTests()
  resetProjectForTesting()
  // getProjectDir is a module-level lodash memoize keyed off cwd; without
  // a manual cache.clear() it returns stale paths derived from a prior
  // test's CLAUDIN_CONFIG_DIR, breaking the getProjectsDir() containment
  // check in #2.
  ;(
    getProjectDir as unknown as { cache: { clear: () => void } }
  ).cache.clear()
  // Block #2 needs a deterministic sessionId; cheap to do for every test.
  switchSession(asSessionId(randomUUID()))
})

afterEach(async () => {
  resetProjectForTesting()
  await rm(tmpDir, { recursive: true, force: true })
})

afterAll(() => {
  if (ORIGINAL_CONFIG_DIR === undefined) {
    delete process.env.CLAUDIN_CONFIG_DIR
  } else {
    process.env.CLAUDIN_CONFIG_DIR = ORIGINAL_CONFIG_DIR
  }
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
  }
  process.chdir(ORIGINAL_CWD)
})

// --- redaction helpers (snapshot determinism) ---------------------------

const TS_RE = /"timestamp":\s*"[^"]+"/g
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

function redact(raw: string, dirs: string[] = []): string {
  let s = raw
  for (const d of dirs) {
    if (d) s = s.split(d).join('<TMP>')
  }
  s = s.replace(TS_RE, '"timestamp":"<TS>"')
  const seen = new Map<string, string>()
  s = s.replace(UUID_RE, raw => {
    if (!seen.has(raw)) seen.set(raw, `UUID_${seen.size}`)
    return seen.get(raw)!
  })
  return s
}

// --- fixture builders ---------------------------------------------------

const TS = '2026-04-02T00:00:00.000Z'

function det(seed: number): string {
  return `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`
}

type AnyMsg = Record<string, unknown>

function baseMeta(uuid: string, parentUuid: string | null): AnyMsg {
  return {
    uuid,
    parentUuid,
    timestamp: TS,
    cwd: '/tmp',
    userType: 'external',
    sessionId: det(999),
    version: 'test',
    isSidechain: false,
  }
}

function mkUserStr(
  uuid: string,
  parentUuid: string | null,
  text: string,
  extras: AnyMsg = {},
): AnyMsg {
  return {
    ...baseMeta(uuid, parentUuid),
    type: 'user',
    isMeta: false,
    message: { role: 'user', content: text },
    ...extras,
  }
}

function mkUserBlocks(
  uuid: string,
  parentUuid: string | null,
  blocks: AnyMsg[],
  extras: AnyMsg = {},
): AnyMsg {
  return {
    ...baseMeta(uuid, parentUuid),
    type: 'user',
    isMeta: false,
    message: { role: 'user', content: blocks },
    ...extras,
  }
}

function mkAssistantText(
  uuid: string,
  parentUuid: string | null,
  text: string,
): AnyMsg {
  return {
    ...baseMeta(uuid, parentUuid),
    type: 'assistant',
    message: {
      id: uuid,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'test-model',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }
}

// =========================================================================
// Block #1 — Type guards
// =========================================================================

test('isTranscriptMessage: returns true for user/assistant/attachment/system', () => {
  // Cast through unknown; isTranscriptMessage operates on the discriminated
  // `type` field only.
  const cases: Array<{ type: string; want: boolean }> = [
    { type: 'user', want: true },
    { type: 'assistant', want: true },
    { type: 'attachment', want: true },
    { type: 'system', want: true },
    { type: 'progress', want: false },
    { type: 'summary', want: false },
    { type: 'tombstone', want: false },
    { type: 'file-history-snapshot', want: false },
    { type: 'attribution-snapshot', want: false },
    { type: 'queue-op', want: false },
    { type: 'tag', want: false },
    { type: 'agent-name', want: false },
  ]
  const observed = cases.map(c => ({
    type: c.type,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    got: isTranscriptMessage({ type: c.type } as any),
    want: c.want,
  }))
  for (const r of observed) expect(r.got).toBe(r.want)
})

test('isChainParticipant: every type except progress participates in chain', () => {
  const types = [
    'user',
    'assistant',
    'attachment',
    'system',
    'summary',
    'tombstone',
    'progress',
  ]
  const map = Object.fromEntries(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    types.map(t => [t, isChainParticipant({ type: t } as any)]),
  )
  expect(map).toEqual({
    user: true,
    assistant: true,
    attachment: true,
    system: true,
    summary: true,
    tombstone: true,
    progress: false,
  })
})

test('isEphemeralToolProgress: true for known progress kinds, false for everything else', () => {
  // Characterizes current EPHEMERAL_PROGRESS_TYPES set. sleep_progress is
  // feature-gated (PROACTIVE/KAIROS), so we don't assert on it here.
  expect(isEphemeralToolProgress('bash_progress')).toBe(true)
  expect(isEphemeralToolProgress('powershell_progress')).toBe(true)
  expect(isEphemeralToolProgress('mcp_progress')).toBe(true)

  // Negative cases — non-string inputs return false, unknown strings return false.
  expect(isEphemeralToolProgress('unknown_progress')).toBe(false)
  expect(isEphemeralToolProgress('')).toBe(false)
  expect(isEphemeralToolProgress(null)).toBe(false)
  expect(isEphemeralToolProgress(undefined)).toBe(false)
  expect(isEphemeralToolProgress(123)).toBe(false)
  expect(isEphemeralToolProgress({})).toBe(false)
  expect(isEphemeralToolProgress([])).toBe(false)
})

// =========================================================================
// Block #2 — Paths
// =========================================================================

test('getProjectsDir: resolves to <CLAUDIN_CONFIG_DIR>/projects', () => {
  expect(getProjectsDir()).toBe(join(tmpDir, 'projects'))
})

test('getProjectDir: returns distinct paths for distinct cwd inputs, both under getProjectsDir()', () => {
  const a = getProjectDir('/home/user/projA')
  const b = getProjectDir('/home/user/projB')
  expect(a).not.toBe(b)
  expect(a.startsWith(getProjectsDir())).toBe(true)
  expect(b.startsWith(getProjectsDir())).toBe(true)
  // Memoization: same input returns same string instance (characterizes lodash
  // memoize behavior — important for the split to preserve).
  expect(getProjectDir('/home/user/projA')).toBe(a)
})

test('getTranscriptPath: ends with <sessionId>.jsonl and lives under getProjectsDir()', () => {
  const sessionId = randomUUID()
  switchSession(asSessionId(sessionId))
  const p = getTranscriptPath()
  expect(p.endsWith(`${sessionId}.jsonl`)).toBe(true)
  expect(p.startsWith(getProjectsDir())).toBe(true)
})

test('getTranscriptPathForSession: same sessionId returns getTranscriptPath()', () => {
  const sessionId = randomUUID() as UUID
  switchSession(asSessionId(sessionId))
  expect(getTranscriptPathForSession(sessionId)).toBe(getTranscriptPath())
})

test('getTranscriptPathForSession: foreign sessionId uses original-cwd projectDir', () => {
  switchSession(asSessionId(randomUUID()))
  const other = randomUUID()
  const p = getTranscriptPathForSession(other)
  expect(p.endsWith(`${other}.jsonl`)).toBe(true)
  expect(p.startsWith(getProjectsDir())).toBe(true)
  expect(p).not.toBe(getTranscriptPath())
})

test('getAgentTranscriptPath: base path is <projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl', () => {
  const sessionId = randomUUID()
  switchSession(asSessionId(sessionId))
  const agentId = asAgentId(randomUUID())
  const base = getAgentTranscriptPath(agentId)
  expect(base.endsWith(`/subagents/agent-${agentId}.jsonl`)).toBe(true)
  expect(base.includes(`/${sessionId}/`)).toBe(true)
})

test('setAgentTranscriptSubdir / clearAgentTranscriptSubdir: subdir is interpolated between subagents/ and agent-<id>.jsonl', () => {
  const sessionId = randomUUID()
  switchSession(asSessionId(sessionId))
  const agentId = asAgentId(randomUUID())
  const before = getAgentTranscriptPath(agentId)

  setAgentTranscriptSubdir(agentId, 'workflows/run-123')
  const scoped = getAgentTranscriptPath(agentId)
  expect(
    scoped.endsWith(
      `/subagents/workflows/run-123/agent-${agentId}.jsonl`,
    ),
  ).toBe(true)
  expect(scoped).not.toBe(before)

  clearAgentTranscriptSubdir(agentId)
  expect(getAgentTranscriptPath(agentId)).toBe(before)
})

// =========================================================================
// Block #6 — getFirstMeaningfulUserMessageTextContent
// =========================================================================

test('getFirstMeaningfulUserMessageTextContent: returns simple string content from first eligible user message', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msgs = [mkUserStr(det(1), null, 'hello world')] as any
  expect(getFirstMeaningfulUserMessageTextContent(msgs)).toBe('hello world')
})

test('getFirstMeaningfulUserMessageTextContent: skips meta messages', () => {
  const msgs = [
    mkUserStr(det(1), null, 'meta noise', { isMeta: true }),
    mkUserStr(det(2), det(1), 'real prompt'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any
  expect(getFirstMeaningfulUserMessageTextContent(msgs)).toBe('real prompt')
})

test('getFirstMeaningfulUserMessageTextContent: skips user messages whose content is tool_result blocks only', () => {
  // Characterizes current behavior: a user message whose `content` is an
  // array with no `text` block (only tool_result) is skipped — collected
  // `texts` list is empty so the loop falls through.
  const msgs = [
    mkUserBlocks(det(1), null, [
      {
        type: 'tool_result',
        tool_use_id: 'tu-1',
        content: '<persisted-output>x</persisted-output>',
      },
    ]),
    mkUserStr(det(2), det(1), 'actual user text'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any
  expect(getFirstMeaningfulUserMessageTextContent(msgs)).toBe(
    'actual user text',
  )
})

test('getFirstMeaningfulUserMessageTextContent: empty array returns undefined', () => {
  // Characterizes current behavior: signature claims `string | undefined`
  // and the implementation falls through to `return undefined` (not '').
  expect(getFirstMeaningfulUserMessageTextContent([])).toBeUndefined()
})

test('getFirstMeaningfulUserMessageTextContent: array content with text block returns that text', () => {
  const msgs = [
    mkUserBlocks(det(1), null, [{ type: 'text', text: 'block-text' }]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any
  expect(getFirstMeaningfulUserMessageTextContent(msgs)).toBe('block-text')
})

test('getFirstMeaningfulUserMessageTextContent: skips messages that start with an XML tag (SKIP_FIRST_PROMPT_PATTERN)', () => {
  // Characterizes SKIP_FIRST_PROMPT_PATTERN — text that starts with
  // "<some-tag" is treated as command output / IDE metadata and skipped.
  const msgs = [
    mkUserStr(det(1), null, '<command-stdout>compiled ok</command-stdout>'),
    mkUserStr(det(2), det(1), 'first real prompt'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any
  expect(getFirstMeaningfulUserMessageTextContent(msgs)).toBe(
    'first real prompt',
  )
})

test('getFirstMeaningfulUserMessageTextContent: skips "[Request interrupted by user]" preamble', () => {
  const msgs = [
    mkUserStr(det(1), null, '[Request interrupted by user]'),
    mkUserStr(det(2), det(1), 'next prompt'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] as any
  expect(getFirstMeaningfulUserMessageTextContent(msgs)).toBe('next prompt')
})

// =========================================================================
// Block #7 — stripPersistedToolUseResultsFromJSONLBuffer
// =========================================================================

test('stripPersistedToolUseResultsFromJSONLBuffer: buffer without toolUseResult is returned unchanged (same instance)', () => {
  const u = mkUserStr(det(1), null, 'plain hello')
  const buf = Buffer.from(`${JSON.stringify(u)}\n`)
  const out = stripPersistedToolUseResultsFromJSONLBuffer(buf)
  // Fast-path early return — both markers absent.
  expect(out).toBe(buf)
})

test('stripPersistedToolUseResultsFromJSONLBuffer: buffer with toolUseResult but NO <persisted-output> marker is unchanged', () => {
  const u = mkUserBlocks(det(1), null, [
    {
      type: 'tool_result',
      tool_use_id: 'tu-1',
      is_error: false,
      content: 'plain stdout, no persisted marker',
    },
  ])
  ;(u as AnyMsg).toolUseResult = { stdout: 'x'.repeat(1000), stderr: '' }
  const buf = Buffer.from(`${JSON.stringify(u)}\n`)
  const out = stripPersistedToolUseResultsFromJSONLBuffer(buf)
  // Characterizes the AND-guard in the strip: both markers must appear at
  // BUFFER level. The persisted-output tag is absent → fast-path returns
  // the input untouched even though a raw toolUseResult is present.
  expect(out).toBe(buf)
})

test('stripPersistedToolUseResultsFromJSONLBuffer: drops toolUseResult when <persisted-output> marker is present, preserving preview', () => {
  const u = mkUserBlocks(det(1), null, [
    {
      type: 'tool_result',
      tool_use_id: 'tu-1',
      is_error: false,
      content: '<persisted-output>\nPreview text\n</persisted-output>',
    },
  ])
  ;(u as AnyMsg).toolUseResult = { stdout: 'x'.repeat(2000), stderr: '' }
  const buf = Buffer.from(`${JSON.stringify(u)}\n`)
  const out = stripPersistedToolUseResultsFromJSONLBuffer(buf)
  const parsed = JSON.parse(out.toString('utf8').trim()) as AnyMsg & {
    toolUseResult?: unknown
    message: { content: Array<{ content: string }> }
  }
  expect(parsed.toolUseResult).toBeUndefined()
  expect(parsed.message.content[0]!.content).toContain('Preview text')
})

test('stripPersistedToolUseResultsFromJSONLBuffer: mixed lines — only persisted lines are modified', () => {
  // Line 1: pure assistant, no markers → untouched.
  const a = mkAssistantText(det(1), null, 'hi')
  // Line 2: persisted tool_result — toolUseResult should be stripped.
  const persisted = mkUserBlocks(det(2), det(1), [
    {
      type: 'tool_result',
      tool_use_id: 'tu-2',
      is_error: false,
      content: '<persisted-output>\nkept-preview\n</persisted-output>',
    },
  ])
  ;(persisted as AnyMsg).toolUseResult = { stdout: 'y'.repeat(500), stderr: '' }
  // Line 3: plain user — untouched.
  const u = mkUserStr(det(3), det(2), 'thanks')

  const buf = Buffer.from(
    `${JSON.stringify(a)}\n${JSON.stringify(persisted)}\n${JSON.stringify(u)}\n`,
  )
  const out = stripPersistedToolUseResultsFromJSONLBuffer(buf)
  const lines = out
    .toString('utf8')
    .split('\n')
    .filter(l => l.length > 0)
    .map(l => JSON.parse(l) as AnyMsg & { toolUseResult?: unknown })

  expect(lines).toHaveLength(3)
  expect(lines[0]!.type).toBe('assistant')
  expect((lines[0] as AnyMsg).toolUseResult).toBeUndefined()
  expect(lines[1]!.type).toBe('user')
  expect(lines[1]!.toolUseResult).toBeUndefined()
  expect(lines[2]!.type).toBe('user')
  // The third (plain) user message was never carrying toolUseResult.
  expect(lines[2]!.toolUseResult).toBeUndefined()

  // Snapshot the redacted full output for structural lock-in.
  expect(redact(out.toString('utf8'))).toMatchSnapshot()
})

test('stripPersistedToolUseResultsFromJSONLBuffer: empty buffer is returned unchanged', () => {
  const buf = Buffer.alloc(0)
  const out = stripPersistedToolUseResultsFromJSONLBuffer(buf)
  expect(out).toBe(buf)
  expect(out.length).toBe(0)
})

// Byte-perfect invariant: a single deterministic fixture run through
// stripPersistedToolUseResultsFromJSONLBuffer must produce *exactly* this
// byte sequence. /resume re-streams the stripped buffer back into the model
// context, so a 1-byte regression in the writer can poison every subsequent
// turn — snapshots catch structural drift but not byte-level drift after
// JSON.stringify reorders keys. The SHA pins the output literally.
test('stripPersistedToolUseResultsFromJSONLBuffer: byte-level SHA256 invariant on canonical fixture', async () => {
  const { createHash } = await import('crypto')
  const a = mkAssistantText(det(1), null, 'hi')
  const persisted = mkUserBlocks(det(2), det(1), [
    {
      type: 'tool_result',
      tool_use_id: 'tu-2',
      is_error: false,
      content: '<persisted-output>\nkept-preview\n</persisted-output>',
    },
  ])
  ;(persisted as AnyMsg).toolUseResult = { stdout: 'y'.repeat(500), stderr: '' }
  const u = mkUserStr(det(3), det(2), 'thanks')
  const buf = Buffer.from(
    `${JSON.stringify(a)}\n${JSON.stringify(persisted)}\n${JSON.stringify(u)}\n`,
  )
  const out = stripPersistedToolUseResultsFromJSONLBuffer(buf)
  const hash = createHash('sha256').update(out).digest('hex')
  expect(out.length).toBe(1322)
  expect(hash).toBe(
    'a41fa68cd1dabb395d93547d64df53ad53c1220ed35abfcd5baf33217232bb84',
  )
})

// =========================================================================
// Block #8 — cleanMessagesForLogging (+ isLoggableMessage, removeExtraFields)
// =========================================================================

test('isLoggableMessage: drops progress entries, keeps user/assistant', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect(isLoggableMessage({ type: 'progress' } as any)).toBe(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect(isLoggableMessage({ type: 'user' } as any)).toBe(true)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect(isLoggableMessage({ type: 'assistant' } as any)).toBe(true)
})

test('isLoggableMessage: external user drops generic attachments', () => {
  // userType() === 'external' in tests (see getUserType()).
  expect(
    isLoggableMessage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'attachment', attachment: { type: 'selected_lines' } } as any,
    ),
  ).toBe(false)
})

test('isLoggableMessage: deferred_tools_delta attachments persist for external users', () => {
  // Resume-visible marker for the legacy-announcement latch AND the bytes
  // a warm-resumed prefix must reproduce — see historyHasDeferredToolsDelta
  // in src/services/tools/toolSearch.ts. Dropping these re-breaks every warm resume
  // of a delta-format session.
  expect(
    isLoggableMessage({
      type: 'attachment',
      attachment: {
        type: 'deferred_tools_delta',
        addedNames: ['mcp__foo__bar'],
        addedLines: ['- mcp__foo__bar'],
        removedNames: [],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any),
  ).toBe(true)
})

test('removeExtraFields: strips isSidechain and parentUuid', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const input = [mkAssistantText(det(1), det(0), 'hi')] as any
  const stripped = removeExtraFields(input) as Array<Record<string, unknown>>
  expect(stripped).toHaveLength(1)
  expect('isSidechain' in stripped[0]!).toBe(false)
  expect('parentUuid' in stripped[0]!).toBe(false)
  // Other meta fields survive.
  expect(stripped[0]!.uuid).toBe(det(1))
  expect(stripped[0]!.type).toBe('assistant')
})

test('cleanMessagesForLogging: filters progress and returns the rest in original order', () => {
  const u = mkUserStr(det(1), null, 'hi')
  const a = mkAssistantText(det(2), det(1), 'hello')
  // Synthesize a progress entry that survives the cast — only `type` is
  // inspected by isLoggableMessage.
  const progress = { type: 'progress', uuid: det(3), parentUuid: det(2) }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = cleanMessagesForLogging([u, progress, a] as any)
  expect(result.map(m => m.type)).toEqual(['user', 'assistant'])
  // Structural snapshot — redacted for UUIDs/timestamps.
  expect(redact(JSON.stringify(result, null, 2))).toMatchSnapshot()
})

test('cleanMessagesForLogging: empty input yields empty output', () => {
  expect(cleanMessagesForLogging([])).toEqual([])
})
