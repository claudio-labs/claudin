/**
 * Repeated-error loop detector for the memory-extraction trigger.
 *
 * Scans the current human turn for a tool call that keeps failing: the same
 * (tool name + canonicalized input) producing an errored tool_result >= N times.
 * When found — and the most recent call of that key is STILL failing (the agent
 * hasn't un-stuck itself) — it returns a signal so runExtraction can fire a
 * forked extraction with a hint to capture the lesson as a `feedback` memory.
 *
 * Pure + side-effect-free (fails open: returns null on any surprise) so it can
 * be unit-tested without importing the ink/agent stack.
 */

import { logError } from 'src/utils/log.js'
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
} from 'src/utils/messages/constants.js'
import { isHumanTurn } from 'src/utils/messagePredicates.js'
import type { Message } from 'src/types/message.js'

/** Minimal tool_result guard (inlined to keep this module dependency-light). */
function isToolResultBlock(
  b: unknown,
): b is { type: 'tool_result'; tool_use_id: string; is_error?: boolean } {
  return (
    typeof b === 'object' &&
    b !== null &&
    (b as { type?: unknown }).type === 'tool_result' &&
    typeof (b as { tool_use_id?: unknown }).tool_use_id === 'string'
  )
}

/** Same failing (tool + input) must error at least this many times to count. */
export const REPEATED_ERROR_THRESHOLD = 3

/** Separator between tool name and canonical input — NUL never appears in JSON. */
const KEY_SEP = '\u0000'

export type LoopSignal = {
  toolName: string
  repeatCount: number
  /** Stable identity of the looping call — used by the caller's cooldown. */
  loopKey: string
  /** uuid of the human turn the loop was found in — used to reset the cooldown. */
  userTurnUuid: string | undefined
}

/**
 * Recursive, key-sorted JSON stringify so two inputs with the same content but
 * different key order compare equal. No shared util exists for this (the only
 * `canonicalize*` in the tree is Bash-command specific).
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map(k => JSON.stringify(k) + ':' + canonicalize(obj[k]))
      .join(',') +
    '}'
  )
}

/**
 * Sentinels for an errored tool_result that is a USER-CONTROL action (interrupt,
 * cancel, deny) rather than the tool itself failing. These must not count toward
 * a repeated-error loop — the agent's approach isn't at fault.
 */
const USER_CONTROL_SENTINELS = [
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
]

/** tool_result content may be a string or an array of text blocks. */
function resultText(block: unknown): string {
  const content = (block as { content?: unknown }).content
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map(c =>
        typeof (c as { text?: unknown })?.text === 'string'
          ? (c as { text: string }).text
          : '',
      )
      .join('\n')
  }
  return ''
}

function isUserControlResult(block: unknown): boolean {
  const text = resultText(block)
  return USER_CONTROL_SENTINELS.some(sentinel => text.includes(sentinel))
}

type FailureStat = {
  /** Total errored results for this key in the active task. */
  count: number
  /** Errored results since the last success — resets on any success. */
  consecutive: number
  name: string
  mostRecentErrored: boolean
}

/** Stable identity of a call: tool name + canonical input. */
function loopKeyFor(toolName: string, input: unknown): string {
  return toolName + KEY_SEP + canonicalize(input)
}

/**
 * True only for a real human turn. `isHumanTurn` alone is not enough here: it
 * keys on `toolUseResult === undefined`, and two live paths blank that field
 * on messages that are really tool turns — sub-agent successes
 * (toolExecution.ts, `agentId && !preserveToolUseResults`) and results swapped
 * for a persisted preview (toolResultStorage.replaceToolResultContents). Those
 * masqueraded as the task boundary and truncated the window, so one success
 * between two failures wiped the streak, leaving the repeated-failure hint
 * dead inside sub-agents and after any oversized result. A user message
 * carrying tool_result blocks is never the human's turn.
 */
function isTaskBoundary(m: Message): boolean {
  if (!isHumanTurn(m)) return false
  const content = m.message?.content
  if (!Array.isArray(content)) return true
  return !content.some(isToolResultBlock)
}

/**
 * Hard bound on how far back a scan may walk when no task boundary is found.
 * `isTaskBoundary` deliberately refuses to treat a user message carrying
 * tool_results as the human's turn, which is what fixed the sub-agent window —
 * but it also means a sub-agent transcript (whose first message is already a
 * tool turn) can yield boundaryIdx === -1 and scan everything. The walk itself
 * is cheap; canonicalize() on every tool_use input is not, since a single
 * Write carries a whole file body. A repeated-failure streak lives in the last
 * handful of turns, so in practice the cap does not change the verdict — but
 * it CAN: detectRepeatedErrorLoop scores on a cumulative count at threshold 3,
 * so a streak straddling the floor (two failures below it, one above) drops to
 * 1 and the hint is lost. 400 messages is roughly 200 tool calls, so that
 * needs a single task running unbroken past that; the trade is deliberate.
 */
const MAX_SCAN_MESSAGES = 400

/**
 * Walk the active task (everything after the most recent human turn),
 * correlating each tool_use to its tool_result, and tally per-key error
 * counts. Shared by the memory-extraction signal and the just-in-time
 * repeated-failure hint.
 */
function collectFailureStats(messages: ReadonlyArray<Message>): {
  stats: Map<string, FailureStat>
  userTurnUuid: string | undefined
} {
  // Boundary: everything after the most recent human turn is the active task.
  let boundaryIdx = -1
  const scanFloor = Math.max(0, messages.length - MAX_SCAN_MESSAGES)
  for (let i = messages.length - 1; i >= scanFloor; i--) {
    const m = messages[i]
    if (m && isTaskBoundary(m)) {
      boundaryIdx = i
      break
    }
  }
  const userTurnUuid = boundaryIdx >= 0 ? messages[boundaryIdx]?.uuid : undefined

  const useIdToKey = new Map<string, string>()
  const useIdToName = new Map<string, string>()
  const stats = new Map<string, FailureStat>()

  for (let i = Math.max(boundaryIdx + 1, scanFloor); i < messages.length; i++) {
    const m = messages[i]
    if (!m) continue
    if (m.type === 'assistant' && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (block.type === 'tool_use') {
          useIdToKey.set(block.id, loopKeyFor(block.name, block.input))
          useIdToName.set(block.id, block.name)
        }
      }
    } else if (m.type === 'user' && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (!isToolResultBlock(block)) continue
        const key = useIdToKey.get(block.tool_use_id)
        if (key === undefined) continue
        const errored = block.is_error === true
        // Interrupts/cancels/denials are user-control actions, not approach
        // failures, and neither are they successes — skip them entirely.
        if (errored && isUserControlResult(block)) continue
        const name = useIdToName.get(block.tool_use_id) ?? ''
        const stat = stats.get(key) ?? {
          count: 0,
          consecutive: 0,
          name,
          mostRecentErrored: false,
        }
        if (errored) {
          stat.count++
          stat.consecutive++
        } else {
          // A success proves this exact call is not stuck. The just-in-time
          // hint claims "in a row", so its streak restarts here;
          // detectRepeatedErrorLoop keeps scoring on the cumulative count
          // plus its own mostRecentErrored recovery guard.
          stat.consecutive = 0
        }
        // Forward order → this overwrite ends on the most-recent result.
        stat.mostRecentErrored = errored
        stats.set(key, stat)
      }
    }
  }

  return { stats, userTurnUuid }
}

/**
 * How many times IN A ROW this exact (tool, input) has already produced an
 * errored tool_result in the active task; any success for the same key resets
 * the streak. Used just-in-time, while the current failure's result is still
 * being built — so the ordinal of the call being assembled is the return
 * value + 1.
 *
 * Bound: `messages` is the snapshot taken at the start of the turn (query.ts),
 * so identical calls issued within the SAME assistant turn all observe the
 * same streak. Deliberate — they were emitted before any of them could have
 * been corrected, so nudging on them would be noise.
 *
 * Fails open (returns 0) so a surprise here can never block a tool result.
 */
export function countIdenticalFailures(
  messages: ReadonlyArray<Message>,
  toolName: string,
  input: unknown,
): number {
  try {
    const { stats } = collectFailureStatsMemoized(messages)
    return stats.get(loopKeyFor(toolName, input))?.consecutive ?? 0
  } catch (e) {
    logError(e)
    return 0
  }
}

// One-entry memo, keyed on the transcript's identity AND length.
//
// Every tool that errors in a turn asks this question against the SAME messages
// array, and answering it walks up to MAX_SCAN_MESSAGES canonicalizing every
// tool_use input in the window — file bodies from Write/Edit included. A turn
// with N parallel failing tools therefore did N identical full walks, on the
// render thread. Identity alone is not enough: the transcript is appended to in
// place, so the length pins the version.
let memoMessages: ReadonlyArray<Message> | undefined
let memoLength = -1
let memoStats: ReturnType<typeof collectFailureStats> | undefined

function collectFailureStatsMemoized(
  messages: ReadonlyArray<Message>,
): ReturnType<typeof collectFailureStats> {
  if (memoStats && memoMessages === messages && memoLength === messages.length) {
    return memoStats
  }
  const computed = collectFailureStats(messages)
  memoMessages = messages
  memoLength = messages.length
  memoStats = computed
  return computed
}

/**
 * Returns a signal when the current human turn contains a repeated-error loop,
 * else null. Scope is the messages after the last human turn (the active task).
 */
export function detectRepeatedErrorLoop(
  messages: ReadonlyArray<Message>,
): LoopSignal | null {
  try {
    const { stats, userTurnUuid } = collectFailureStats(messages)

    // Qualify: >= threshold errors AND still failing on the latest call
    // (recovery guard). Pick the loudest qualifying key.
    let best: LoopSignal | null = null
    for (const [loopKey, stat] of stats) {
      if (stat.count < REPEATED_ERROR_THRESHOLD || !stat.mostRecentErrored) {
        continue
      }
      if (best === null || stat.count > best.repeatCount) {
        best = {
          toolName: stat.name,
          repeatCount: stat.count,
          loopKey,
          userTurnUuid,
        }
      }
    }
    return best
  } catch (e) {
    logError(e)
    return null
  }
}
