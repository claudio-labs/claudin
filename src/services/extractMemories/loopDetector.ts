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

import { logError } from '../../utils/log.js'
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
} from '../../utils/messages/constants.js'
import { isHumanTurn } from '../../utils/messagePredicates.js'
import type { Message } from '../../types/message.js'

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
const REPEATED_ERROR_THRESHOLD = 3

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

/**
 * Returns a signal when the current human turn contains a repeated-error loop,
 * else null. Scope is the messages after the last human turn (the active task).
 */
export function detectRepeatedErrorLoop(
  messages: ReadonlyArray<Message>,
): LoopSignal | null {
  try {
    // Boundary: everything after the most recent human turn is the active task.
    let boundaryIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m && isHumanTurn(m)) {
        boundaryIdx = i
        break
      }
    }
    const userTurnUuid =
      boundaryIdx >= 0 ? messages[boundaryIdx]?.uuid : undefined

    // Walk the window forward, correlating each tool_use to its tool_result,
    // building an ordered list of (key, errored) for non-interrupted results.
    const useIdToKey = new Map<string, string>()
    const useIdToName = new Map<string, string>()
    type Stat = { count: number; name: string; mostRecentErrored: boolean }
    const stats = new Map<string, Stat>()

    for (let i = boundaryIdx + 1; i < messages.length; i++) {
      const m = messages[i]
      if (!m) continue
      if (m.type === 'assistant' && Array.isArray(m.message.content)) {
        for (const block of m.message.content) {
          if (block.type === 'tool_use') {
            const key = block.name + KEY_SEP + canonicalize(block.input)
            useIdToKey.set(block.id, key)
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
            name,
            mostRecentErrored: false,
          }
          if (errored) stat.count++
          // Forward order → this overwrite ends on the most-recent result.
          stat.mostRecentErrored = errored
          stats.set(key, stat)
        }
      }
    }

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
