import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  _resetAllClippedIdsForTesting,
  addClippedIds,
  applyStableStubs,
} from '../services/compact/stableStubState.js'

// Roadmap 5.7: pin the cache-compaction pattern used by the gRPC server in
// src/grpc/server.ts:201. The server stores cross-stream resume snapshots in
// `this.sessions: Map<sessionId, Message[]>`. To avoid pinning the original
// 50-200 KB tool_result content in RAM across resumes, the snapshot is
// passed through applyStableStubs before being cached.
//
// We don't boot the real gRPC server here (would require a port and the
// proto loader); instead we replicate the pattern verbatim and assert the
// behavior the server depends on.

beforeEach(() => {
  _resetAllClippedIdsForTesting()
})

afterEach(() => {
  _resetAllClippedIdsForTesting()
})

type Block = Record<string, unknown>
type Msg = {
  role?: string
  message?: { role?: string; content?: unknown }
  content?: unknown
}

function assistantToolUse(id: string, name: string): Msg {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: {} }],
  }
}

function userToolResult(id: string, content: string): Msg {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content }],
  }
}

test('gRPC cache pattern: previousMessages snapshot is rewritten to stubs before storage', () => {
  // Live engine state (in real code: engine.getMessages())
  const engineMessages: Msg[] = [
    assistantToolUse('toolu_old', 'Read'),
    userToolResult('toolu_old', 'OLD'.repeat(20_000)), // 60 KB original
    assistantToolUse('toolu_recent', 'Bash'),
    userToolResult('toolu_recent', 'recent output'),
  ]
  // Mirrors microcompact's size-based trigger having clipped the older id
  addClippedIds(['toolu_old'])

  // The pattern from server.ts:201:
  //   previousMessages = applyStableStubs([...engine.getMessages()])
  const previousMessages = applyStableStubs([...engineMessages])

  // The cached snapshot must NOT contain the original 60 KB payload —
  // otherwise the per-session Map<sessionId, Message[]> pins it across
  // every cross-stream resume and the roadmap 5.7 RSS win evaporates.
  const cachedOldContent = (
    (previousMessages[1].content as Block[])[0] as { content: string }
  ).content
  expect(cachedOldContent).toMatch(/^\[clipped: ~\d+ tokens from Read\]$/)
  expect(cachedOldContent).not.toContain('OLD')

  // Recent (non-clipped) results pass through untouched
  const cachedRecentContent = (
    (previousMessages[3].content as Block[])[0] as { content: string }
  ).content
  expect(cachedRecentContent).toBe('recent output')
})

test('gRPC cache pattern: snapshot is independent of subsequent engine mutations', () => {
  // After caching, the engine continues to receive new turns. The cached
  // snapshot must be a genuine point-in-time capture, not aliased with the
  // live array. The `[...engine.getMessages()]` spread + applyStableStubs
  // (which returns a new array when any block is rewritten) guarantees this.
  const engineMessages: Msg[] = [
    assistantToolUse('toolu_a', 'Read'),
    userToolResult('toolu_a', 'A'.repeat(5_000)),
  ]
  addClippedIds(['toolu_a'])

  const previousMessages = applyStableStubs([...engineMessages])
  expect(previousMessages).not.toBe(engineMessages)

  // Engine pushes new messages — cached snapshot length is unchanged
  engineMessages.push(assistantToolUse('toolu_b', 'Bash'))
  engineMessages.push(userToolResult('toolu_b', 'B'.repeat(5_000)))
  expect(previousMessages).toHaveLength(2)
  expect(engineMessages).toHaveLength(4)
})

test('gRPC cache pattern: identity-preserving fast path when nothing to clip', () => {
  // Empty clipped set → applyStableStubs returns the input ref. The spread
  // before applyStableStubs creates a new array regardless, so the cached
  // snapshot is still independent of the live engine state — but the
  // applyStableStubs call itself does no extra allocation.
  const engineMessages: Msg[] = [
    assistantToolUse('toolu_a', 'Read'),
    userToolResult('toolu_a', 'small'),
  ]
  const spread = [...engineMessages]
  const previousMessages = applyStableStubs(spread)
  expect(previousMessages).toBe(spread) // identity preserved
  expect(previousMessages).not.toBe(engineMessages) // but independent of engine
})
