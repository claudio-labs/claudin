/**
 * Characterization of src/vcs/git/gitStatusDelta.ts, pinned before the
 * clean-base rewrite. docs/tech/rewrite/vcs/gitDiff.md is the spec.
 *
 * The git status snapshot goes to the model once per conversation, as a
 * `git_status_delta` attachment; the system context drops its `gitStatus` key
 * so it is not sent twice. Despite the name, nothing is ever computed between
 * two snapshots: a later, different snapshot is simply not announced.
 */
import { describe, expect, test } from 'bun:test'
import { GIT_STATUS_CONTEXT_KEY, getGitStatusDelta } from 'src/vcs/git/gitStatusDelta.js'

type Transcript = Parameters<typeof getGitStatusDelta>[1]

const SNAPSHOT = 'Current branch: main\n\nStatus:\nM src/app.ts\n?? notes.md'
const announced = { type: 'attachment', attachment: { type: 'git_status_delta' } }

test('the system-context key the attachment stands in for is "gitStatus"', () => {
  expect(GIT_STATUS_CONTEXT_KEY).toBe('gitStatus')
})

describe('getGitStatusDelta', () => {
  test('first turn: the snapshot, byte for byte, and nothing else', () => {
    expect(getGitStatusDelta(SNAPSHOT, [])).toStrictEqual({ content: SNAPSHOT })
    expect(getGitStatusDelta('  ', [])).toStrictEqual({ content: '  ' })
  })

  test('no snapshot (null, undefined or empty): nothing, whatever the transcript holds', () => {
    for (const missing of [null, undefined, '']) {
      expect(getGitStatusDelta(missing, [])).toBeNull()
      expect(getGitStatusDelta(missing, [{ type: 'user' }])).toBeNull()
    }
  })

  test('once announced, never again: not for the same snapshot, not for a changed one', () => {
    const later = 'Current branch: feature\n\nStatus:\n(clean)'
    const history: Transcript = [{ type: 'user' }, announced, { type: 'assistant' }]
    expect(getGitStatusDelta(SNAPSHOT, history)).toBeNull()
    expect(getGitStatusDelta(later, history)).toBeNull()
    expect(getGitStatusDelta(later, [announced, announced])).toBeNull()
  })

  test('only an attachment message whose attachment is git_status_delta counts as announced', () => {
    const lookalikes: Transcript = [
      { type: 'user' },
      { type: 'attachment' },
      { type: 'attachment', attachment: { type: 'claude_md_delta' } },
      { type: 'user', attachment: { type: 'git_status_delta' } },
      { type: 'system', attachment: { type: 'git_status_delta' } },
    ]
    expect(getGitStatusDelta(SNAPSHOT, lookalikes)).toStrictEqual({ content: SNAPSHOT })
  })

  test('the transcript is only read', () => {
    const history: Transcript = [{ type: 'user' }]
    const copy = structuredClone(history)
    getGitStatusDelta(SNAPSHOT, history)
    expect(history).toStrictEqual(copy)
  })
})
