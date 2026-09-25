/**
 * Response chains — the guard half of CLAUDIN_RESPONSE_CHAINS=1
 * (steeringToggles.ts; team memory `request-count-levers-2026-09-24`).
 *
 * runTools already runs the calls of one response in the order written: each
 * call that is not concurrency-safe runs alone, after every call before it has
 * finished. So an edit and the test that checks it can share a response instead
 * of costing a model request each. What made that unsafe is that nothing
 * stopped the calls after a failure — a test ran against an edit that never
 * landed, a commit ran after a red check. This is that stop, kept narrow:
 *
 * - A failure is a call that is not read-only coming back `is_error`; a
 *   RunTests, Typecheck or Build result with a non-zero `exitCode` (those three
 *   report a red run without `is_error`); or a Bash command whose stripped
 *   trailing `| tail -N` hid a non-zero exit (`reducedExitCode`, BashTool). A
 *   failed read breaks nothing.
 * - After a failure only the calls that run or ship code are skipped: Bash,
 *   PowerShell and Git when not read-only, and RunTests, Typecheck and Build.
 *   Reads, edits (usually independent fixes), Agent and MCP calls still run.
 * - A skipped call gets a synthetic `is_error` result naming the failure, and
 *   never reaches permissions or hooks.
 *
 * Off, runTools builds no chain and a response runs exactly as before. The
 * StreamingToolExecutor (gated off) keeps its own, broader rule: a Bash error
 * cancels every sibling.
 */
import type { Message } from 'src/shared/types/message.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { BUILD_TOOL_NAME } from 'src/tools/BuildTool/prompt.js'
import { GIT_TOOL_NAME } from 'src/tools/GitTool/prompt.js'
import { POWERSHELL_TOOL_NAME } from 'src/tools/PowerShellTool/toolName.js'
import { RUN_TESTS_TOOL_NAME } from 'src/tools/RunTestsTool/prompt.js'
import { TYPECHECK_TOOL_NAME } from 'src/tools/TypecheckTool/prompt.js'

/** One call of the response, as the chain sees it. */
export type ChainCall = {
  id: string
  /** The tool's canonical name. */
  name: string
  /** `tool.isReadOnly(input)`; false when it cannot be told (fail closed). */
  readOnly: boolean
  /** Short label for the skip message, e.g. `Bash(bun test)`. */
  description: string
}

/** Checks that report a failed run through `exitCode`, not `is_error`. */
const EXIT_CODE_CHECKS: ReadonlySet<string> = new Set([
  RUN_TESTS_TOOL_NAME,
  TYPECHECK_TOOL_NAME,
  BUILD_TOOL_NAME,
])

/** Tools that run commands: skipped after a failure unless read-only. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set([
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  GIT_TOOL_NAME,
])

const MAX_DESCRIPTION_CHARS = 40

/** Whether `call` is one the chain skips once an earlier call failed. */
export function isSkippedAfterFailure(call: ChainCall): boolean {
  if (EXIT_CODE_CHECKS.has(call.name)) return true
  return COMMAND_TOOLS.has(call.name) && !call.readOnly
}

function nonZeroNumber(value: unknown): boolean {
  return typeof value === 'number' && value !== 0
}

/** Whether `message` is `call`'s result, reporting a failure. */
export function isFailedResult(call: ChainCall, message: Message | undefined): boolean {
  if (call.readOnly || message?.type !== 'user') return false
  const content = message.message.content
  if (!Array.isArray(content)) return false
  const result = content.find(
    block => block.type === 'tool_result' && block.tool_use_id === call.id,
  )
  if (result === undefined) return false
  if (result.type === 'tool_result' && result.is_error === true) return true
  const data = message.toolUseResult
  if (typeof data !== 'object' || data === null) return false
  if (EXIT_CODE_CHECKS.has(call.name)) {
    return 'exitCode' in data && nonZeroNumber(data.exitCode)
  }
  if (call.name === BASH_TOOL_NAME) {
    return 'reducedExitCode' in data && nonZeroNumber(data.reducedExitCode)
  }
  return false
}

/** The text of a skipped call's result, without the error tags. */
export function skippedCallText(call: ChainCall, failure: string): string {
  return `Skipped: ${failure} failed earlier in this response, so this ${call.name} call did not run. Re-send it if it still applies.`
}

/** `Name(first 40 chars of the command, path or pattern)`, or the bare name. */
export function describeCall(name: string, input: unknown): string {
  let summary = ''
  if (typeof input === 'object' && input !== null) {
    const fields = input as Record<string, unknown>
    const commands = fields.commands
    const first = Array.isArray(commands) ? commands[0] : undefined
    for (const value of [fields.command, first, fields.file_path, fields.pattern]) {
      if (typeof value === 'string' && value.length > 0) {
        summary = value
        break
      }
    }
  }
  if (summary === '') return name
  const short =
    summary.length > MAX_DESCRIPTION_CHARS
      ? `${summary.slice(0, MAX_DESCRIPTION_CHARS)}\u2026`
      : summary
  return `${name}(${short})`
}

/** One response's chain state: the first failure, once there is one. */
export type ResponseChain = {
  readonly failure: string | null
  /** Record what `call` returned; the first failure sticks. */
  observe(call: ChainCall, message: Message | undefined): void
  /** The skip text when `call` must not run, or null to run it. */
  skipText(call: ChainCall): string | null
}

export function createResponseChain(): ResponseChain {
  let failure: string | null = null
  return {
    get failure() {
      return failure
    },
    observe(call, message) {
      if (failure === null && isFailedResult(call, message)) {
        failure = call.description
      }
    },
    skipText(call) {
      if (failure === null || !isSkippedAfterFailure(call)) return null
      return skippedCallText(call, failure)
    },
  }
}
