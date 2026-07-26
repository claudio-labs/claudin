/**
 * Heuristic for the "serial single-file edit" anti-pattern: the model lands one
 * file per turn (`apply_patch` with a single section, or `Edit`/`Write`) instead
 * of putting every file section into one atomic patch. When triggered,
 * toolExecution appends a <system-reminder> to the successful tool_result.
 *
 * Companion to FileReadTool/serialReadNudge.ts — same injection surface, same
 * shape of detector. Two deliberate differences:
 *
 *  - It spans three tools, so the injection lives at the single shared success
 *    site (toolExecution.ts:addToolResult) rather than inside each tool.
 *  - It is NOT one-shot per query. serialReadNudge fires once because the cost
 *    it targets is narration (cosmetic); here each ignored turn costs a real
 *    round-trip plus a re-authored patch, so the reminder repeats for as long as
 *    the streak stands.
 */

import { APPLY_PATCH_TOOL_NAME } from '../ApplyPatchTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/constants.js'

/** Consecutive single-file edit turns needed before the reminder is appended. */
export const SERIAL_EDIT_THRESHOLD = 3

/**
 * Assistant messages scanned, newest first. Wider than serialReadNudge's 4
 * because read-only turns are transparent here (see TRANSPARENT_TOOL_NAMES), so
 * the pattern this targets — patch → read → patch → read → patch — needs room.
 */
export const SERIAL_EDIT_WINDOW = 10

/**
 * Hard cap on array positions visited, independent of SERIAL_EDIT_WINDOW.
 * Needed because the window counts ASSISTANT turns while the array also holds
 * user/tool-result messages: without this the walk is O(transcript), not
 * O(window), and this runs on the render thread for every successful edit.
 */
export const SERIAL_EDIT_MAX_SCAN = SERIAL_EDIT_WINDOW * 4

export const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  APPLY_PATCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

/**
 * Turns that only discover do NOT break the streak — read-one/patch-one is the
 * exact shape being targeted, so treating an interleaved Read as a break would
 * make the detector blind to it. Anything else (Bash, RunTests, Agent, …) does
 * break it: serializing edits around a build or a test run is legitimate.
 *
 * Matched by wire name, like serialReadNudge's `block.name === 'Read'`.
 */
export const TRANSPARENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'LSP',
  // Bookkeeping, not work: a plan/todo update between two edits is the single
  // most common Claude turn shape, and treating it as a break made the
  // detector blind to the exact sequence it exists to catch.
  'TodoWrite',
])

/** File section headers of the Codex envelope, used to count a patch's targets. */
const PATCH_FILE_HEADER_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm

/**
 * Minimal shape we care about for an assistant message. Mirrors
 * serialReadNudge.ts:AssistantMessageLike, plus the tool_use `input` this
 * detector needs to tell which file a call targets.
 */
export interface EditMessageLike {
  type?: string
  message?: {
    role?: string
    content?: ReadonlyArray<{
      type?: string
      name?: string
      input?: unknown
    }>
  }
}

type Turn =
  /** One or more edit calls; `files` are the distinct targets we could resolve. */
  | { kind: 'edit'; files: Set<string> }
  /** Nothing that bears on the pattern (text-only, or discovery tools only). */
  | { kind: 'transparent' }
  /** Something that makes serialization legitimate — stop counting. */
  | { kind: 'break' }

/**
 * Targets of one edit tool_use. Paths are compared as written, so an
 * `apply_patch` relative path and an `Edit` absolute path for the same file read
 * as different targets. That only ever makes the detector quieter (it counts a
 * repeat as a new file at worst), which is the right way for a nudge to fail.
 */
function targetsOf(name: string, input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  if (name === APPLY_PATCH_TOOL_NAME) {
    const patchText = (input as { patchText?: unknown }).patchText
    if (typeof patchText !== 'string') return []
    // matchAll clones the regex, so the module-level /g lastIndex is untouched.
    return [...patchText.matchAll(PATCH_FILE_HEADER_RE)].map(m => m[1]!.trim())
  }
  const filePath = (input as { file_path?: unknown }).file_path
  return typeof filePath === 'string' ? [filePath] : []
}

function classifyTurn(m: EditMessageLike): Turn {
  const content = m.message?.content
  if (!Array.isArray(content)) return { kind: 'transparent' }

  const files = new Set<string>()
  let sawEdit = false
  let sawOther = false
  for (const block of content) {
    if (block?.type !== 'tool_use') continue
    const name = block.name
    if (typeof name !== 'string') {
      sawOther = true
      continue
    }
    if (EDIT_TOOL_NAMES.has(name)) {
      sawEdit = true
      for (const target of targetsOf(name, block.input)) files.add(target)
    } else if (!TRANSPARENT_TOOL_NAMES.has(name)) {
      sawOther = true
    }
  }

  if (sawOther) return { kind: 'break' }
  return sawEdit ? { kind: 'edit', files } : { kind: 'transparent' }
}

/** One tool_use, in the shape `classifyTurn` consumes. */
export type EditCallLike = { name: string; input: unknown }

function turnForCurrentCall(call: EditCallLike): Turn {
  return classifyTurn({
    message: { content: [{ type: 'tool_use', ...call }] },
  })
}

/**
 * How many consecutive single-file edit turns end the transcript, walking
 * backwards from the newest assistant message.
 *
 * `currentCall` MUST be supplied in production. `toolUseContext.messages` is
 * frozen before the current turn streams (query.ts sets it, then collects
 * `assistantMessages` separately), so the call being answered right now is NOT
 * in `messages`. Without it the walk sees only prior turns, and a successful
 * MULTI-file patch preceded by three single-file turns would be nudged — the
 * instrument would scold exactly the behavior it is asking for.
 *
 * Returns 0 (rather than counting) as soon as the newest edit turn already
 * batched — a multi-file patch is the behavior being asked for, so it must
 * never be what triggers the reminder.
 *
 * Known blind spot: only the ONE call being answered is visible, not its
 * siblings, so a turn issuing two separate single-file patches in parallel
 * (already batched, at the message level) still reads as single-file. Prior
 * turns are unaffected — they come from `messages`, which has whole turns.
 */
export function detectSerialEditStreak(
  messages: ReadonlyArray<unknown>,
  options: {
    currentCall?: EditCallLike
    window?: number
    maxScan?: number
  } = {},
): number {
  const window = options.window ?? SERIAL_EDIT_WINDOW
  const maxScan = options.maxScan ?? SERIAL_EDIT_MAX_SCAN
  let streak = 0
  let lastFile: string | undefined
  let scanned = 0
  let visited = 0

  if (options.currentCall) {
    const turn = turnForCurrentCall(options.currentCall)
    if (turn.kind !== 'edit') return 0
    if (turn.files.size !== 1) return 0
    const [file] = turn.files
    lastFile = file
    streak = 1
    scanned = 1
  }

  for (
    let i = messages.length - 1;
    i >= 0 && scanned < window && visited < maxScan;
    i--
  ) {
    visited++
    const m = messages[i] as EditMessageLike
    if (!m || m.type !== 'assistant') continue
    scanned++

    const turn = classifyTurn(m)
    if (turn.kind === 'break') break
    if (turn.kind === 'transparent') continue
    // Either the model batched (≥2) or we could not resolve the target (0).
    // Neither is the pattern; stop rather than guess.
    if (turn.files.size !== 1) break

    const [file] = turn.files
    // Repeated edits to the SAME file are legitimate iteration, not the
    // one-file-per-patch waste — they neither count nor break the streak.
    if (file === lastFile) continue
    lastFile = file
    streak++
  }

  return streak
}

export function renderSerialEditNudge(streak: number): string {
  return `\n\n<system-reminder>\nThat's ${streak} single-file edits in a row, each in its own turn. If the remaining edits are already known and independent, Read every remaining file in ONE message (parallel Read calls) and land them all in ONE ${APPLY_PATCH_TOOL_NAME} call with one section per file — it is atomic and costs a single round-trip instead of one per file.\n</system-reminder>\n`
}
