/**
 * Characterization of src/vcs/git/commitAttribution.ts, pinned before the
 * clean-base rewrite. docs/tech/rewrite/vcs/gitDiff.md is the spec.
 *
 * Three things live here: the public name a model id maps to, the per-session
 * attribution counters held in AppState, and the `attribution-snapshot` line
 * those counters are stored as in a session transcript. The line format is
 * pinned byte for byte against __fixtures__/rewrite/attribution-snapshots.jsonl,
 * written by the old module from the states rebuilt below.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { AttributionSnapshotMessage } from 'src/shared/types/logs.js'
import { type AttributionState, attributionRestoreStateFromLog, createEmptyAttributionState, getClientSurface, incrementPromptCount, restoreAttributionStateFromSnapshots, sanitizeModelName, stateToSnapshotMessage } from 'src/vcs/git/commitAttribution.js'

const SURFACE_VAR = 'CLAUDE_CODE_ENTRYPOINT'
let savedSurface: string | undefined

beforeEach(() => {
  savedSurface = process.env[SURFACE_VAR]
  delete process.env[SURFACE_VAR]
})

afterEach(() => {
  if (savedSurface === undefined) delete process.env[SURFACE_VAR]
  else process.env[SURFACE_VAR] = savedSurface
})

const SNAPSHOT_LINES = readFileSync(join(import.meta.dir, '__fixtures__', 'rewrite', 'attribution-snapshots.jsonl'), 'utf8').split('\n').filter(Boolean)
const FIRST_ID = '0b9d5c3e-7a41-4f6e-9c1d-2e8f4a6b7c90'
const SECOND_ID = '5f2a8e61-3c7b-4d90-8e2a-1b6c9d0e4f73'

/** The state after the first prompt of a CLI session. */
const afterFirstPrompt = (): AttributionState => ({ ...createEmptyAttributionState(), promptCount: 1 })

/** A later state, with per-file entries as older writers stored them. */
const laterState = (): AttributionState => ({
  ...createEmptyAttributionState(),
  surface: 'claude-vscode',
  fileStates: new Map([
    ['src/app.ts', { contentHash: 'c0ffee', claudeContribution: 120, mtime: 1_790_000_000_000 }],
    ['README.md', { contentHash: 'beef01', claudeContribution: 7, mtime: 1_790_000_001_000 }],
  ]),
  promptCount: 5,
  promptCountAtLastCommit: 2,
  permissionPromptCount: 3,
  permissionPromptCountAtLastCommit: 1,
  escapeCount: 4,
  escapeCountAtLastCommit: 1,
})

describe('sanitizeModelName: the public model name, by the first family that the id contains', () => {
  const table: Array<[id: string, publicName: string]> = [
    ['claude-fable-5-1', 'claude-fable-5-1'],
    ['fable-5-1-preview', 'claude-fable-5-1'],
    ['claude-fable-5', 'claude-fable-5'],
    ['claude-opus-5-5', 'claude-opus-5-5'],
    ['claude-opus-5-5-20260915', 'claude-opus-5-5'],
    ['claude-opus-5', 'claude-opus-5'],
    ['claude-opus-4-8', 'claude-opus-4-8'],
    ['claude-opus-4-7', 'claude-opus-4-7'],
    ['claude-opus-4-6', 'claude-opus-4-6'],
    ['claude-opus-4-5-20251101', 'claude-opus-4-5'],
    ['claude-opus-4-1@20250805', 'claude-opus-4-1'],
    ['claude-opus-4-20250514', 'claude-opus-4'],
    ['claude-sonnet-5', 'claude-sonnet-5'],
    ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5'],
    ['claude-sonnet-4-20250514', 'claude-sonnet-4'],
    ['sonnet-3-7', 'claude-sonnet-3-7'],
    ['claude-haiku-4-5', 'claude-haiku-4-5'],
    ['haiku-3-5-latest', 'claude-haiku-3-5'],
    // Containment, not equality: "opus-4-10" holds "opus-4-1".
    ['claude-opus-4-10', 'claude-opus-4-1'],
    // No known family, the generic name: the older family-last id form,
    // another vendor, a local model, nothing at all.
    ['claude-3-7-sonnet-20250219', 'claude'],
    ['gpt-5.1', 'claude'],
    ['qwen3-coder:30b', 'claude'],
    ['', 'claude'],
  ]

  test('every id in the table gets its public name', () => {
    const named = table.map(([id]) => [id, sanitizeModelName(id)])
    expect(named).toEqual(table)
  })
})

describe('getClientSurface', () => {
  test('CLAUDE_CODE_ENTRYPOINT as it is, and "cli" when it is not set', () => {
    const seen = [getClientSurface()]
    for (const value of ['claude-vscode', '']) {
      process.env[SURFACE_VAR] = value
      seen.push(getClientSurface())
    }
    expect(seen).toEqual(['cli', 'claude-vscode', ''])
  })
})

/** The six counters of a state, in the order the spec lists them. */
const COUNTER_NAMES = ['escapeCount', 'escapeCountAtLastCommit', 'permissionPromptCount', 'permissionPromptCountAtLastCommit', 'promptCount', 'promptCountAtLastCommit'] as const

describe('createEmptyAttributionState', () => {
  test('zero counts, no HEAD, empty maps, and the surface read when it is called', () => {
    process.env[SURFACE_VAR] = 'sdk-ts'
    const zeros = Object.fromEntries(COUNTER_NAMES.map(name => [name, 0])) as Record<(typeof COUNTER_NAMES)[number], number>
    const expected = { surface: 'sdk-ts', startingHeadSha: null, fileStates: new Map(), sessionBaselines: new Map(), ...zeros }
    expect(createEmptyAttributionState()).toStrictEqual(expected)
  })

  test('every call has maps of its own', () => {
    const one = createEmptyAttributionState()
    const two = createEmptyAttributionState()
    one.fileStates.set('a.ts', { contentHash: 'x', claudeContribution: 1, mtime: 1 })
    one.sessionBaselines.set('a.ts', { contentHash: 'x', mtime: 1 })
    expect(two.fileStates.size + two.sessionBaselines.size).toBe(0)
  })
})

describe('the attribution-snapshot line in a transcript', () => {
  test('stateToSnapshotMessage, serialized, is the stored line byte for byte, starting with its type', () => {
    expect(SNAPSHOT_LINES).toHaveLength(2)
    expect(JSON.stringify(stateToSnapshotMessage(afterFirstPrompt(), FIRST_ID))).toBe(SNAPSHOT_LINES[0]!)
    expect(JSON.stringify(stateToSnapshotMessage(laterState(), SECOND_ID))).toBe(SNAPSHOT_LINES[1]!)
    for (const line of SNAPSHOT_LINES) expect(line.startsWith('{"type":"attribution-snapshot",')).toBe(true)
  })

  test('the per-file map becomes a plain object; the baselines and the starting HEAD are not stored', () => {
    const message = stateToSnapshotMessage(laterState(), SECOND_ID)
    expect(message.fileStates).not.toBeInstanceOf(Map)
    expect(Object.keys(message.fileStates)).toEqual(['src/app.ts', 'README.md'])
    expect(Object.keys(message)).not.toContain('sessionBaselines')
    expect(Object.keys(message)).not.toContain('startingHeadSha')
  })
})

describe('restoring from stored snapshots', () => {
  const stored = (): AttributionSnapshotMessage[] => SNAPSHOT_LINES.map(line => JSON.parse(line) as AttributionSnapshotMessage)

  test('the last snapshot is the state: its surface, files and counts, nothing added up', () => {
    process.env[SURFACE_VAR] = 'sdk-py'
    const state = restoreAttributionStateFromSnapshots(stored())
    expect(state).toStrictEqual({ ...laterState(), startingHeadSha: null, sessionBaselines: new Map() })
    expect([...state.fileStates.keys()]).toEqual(['src/app.ts', 'README.md'])
  })

  test('no snapshots: an empty state with the current surface', () => {
    process.env[SURFACE_VAR] = 'sdk-py'
    expect(restoreAttributionStateFromSnapshots([])).toStrictEqual(createEmptyAttributionState())
  })

  test('counts a snapshot does not carry come back as 0', () => {
    const bare = { type: 'attribution-snapshot', messageId: FIRST_ID, surface: 'cli', fileStates: {} } as AttributionSnapshotMessage
    const state = restoreAttributionStateFromSnapshots([JSON.parse(SNAPSHOT_LINES[1]!), bare])
    expect(state).toStrictEqual({ ...createEmptyAttributionState(), surface: 'cli' })
  })

  test('attributionRestoreStateFromLog hands the restored state to the callback once, and returns nothing', () => {
    const received: AttributionState[] = []
    const returned = attributionRestoreStateFromLog(stored(), state => received.push(state))
    expect(returned).toBeUndefined()
    expect(received).toStrictEqual([restoreAttributionStateFromSnapshots(stored())])
  })
})

describe('incrementPromptCount', () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  test('a new state with one more prompt; the snapshot of that new state is saved before it returns', () => {
    const before = laterState()
    const saves: AttributionSnapshotMessage[] = []
    const after = incrementPromptCount(before, snapshot => saves.push(snapshot))
    expect(after).not.toBe(before)
    expect(after).toStrictEqual({ ...laterState(), promptCount: 6 })
    expect(before.promptCount).toBe(5)
    expect(saves).toHaveLength(1)
    const [saved] = saves
    expect(saved!.messageId).toMatch(UUID_V4)
    expect(saved).toStrictEqual(stateToSnapshotMessage(after, saved!.messageId))
  })

  test('each save gets a fresh message id', () => {
    const ids: string[] = []
    const once = incrementPromptCount(createEmptyAttributionState(), s => ids.push(s.messageId))
    incrementPromptCount(once, s => ids.push(s.messageId))
    expect(new Set(ids).size).toBe(2)
  })
})
