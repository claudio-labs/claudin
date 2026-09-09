/**
 * WaitFor — poll a shell command until a regex matches, its output settles,
 * or a timeout elapses, and return ONE result.
 *
 * Replaces the `sleep N && check` loop, where every poll is a full API
 * round-trip carrying the whole context (134 of 1,044 calls in the
 * 2026-09-04..08 census). ON by default; `CLAUDIN_DISABLE_WAITFOR_TOOL=1`
 * removes the tool (and with it the Bash sleep redirect, see redirect.ts).
 * Permissions delegate to the Bash rules exactly like Monitor: a saved
 * "don't ask again" lands as a `Bash(prefix:*)` rule.
 */
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ValidationResult } from 'src/tools/Tool.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { exec } from 'src/shared/proc/Shell.js'
import {
  bashToolHasPermission,
  matchWildcardPattern,
  permissionRuleExtractPrefix,
} from 'src/tools/BashTool/bashPermissions.js'
import { parseForSecurity } from 'src/platform/bash/ast.js'
import { WAITFOR_TOOL_NAME } from 'src/tools/WaitForTool/toolName.js'

const DEFAULT_SETTLE_S = 3
const DEFAULT_INTERVAL_S = 1
const MIN_INTERVAL_S = 0.2
const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 600

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .describe('The shell command to run on every poll, e.g. `tmux capture-pane -t s -p` or `cat /tmp/task.out`'),
    until: z
      .string()
      .optional()
      .describe('Regex; return as soon as the output matches it. Preferred over settling.'),
    settle_s: z
      .number()
      .min(0)
      .optional()
      .describe(`Without \`until\`: return once the output has been identical for this many seconds (default ${DEFAULT_SETTLE_S})`),
    interval_s: z
      .number()
      .min(MIN_INTERVAL_S)
      .optional()
      .describe(`Seconds between polls (default ${DEFAULT_INTERVAL_S})`),
    timeout_s: z
      .number()
      .min(1)
      .max(MAX_TIMEOUT_S)
      .optional()
      .describe(`Give up after this many seconds and return the last output (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S})`),
    setup: z
      .string()
      .optional()
      .describe('Command run ONCE before polling starts, e.g. `tmux send-keys -t s Enter`'),
    description: z
      .string()
      .describe('Clear, concise description of what you are waiting for, in active voice.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    output: z.string().describe('The last polled output (stdout, then stderr)'),
    matched: z.boolean().describe('Whether `until` matched'),
    reason: z
      .enum(['match', 'settled', 'timeout', 'aborted'])
      .describe('Why polling stopped'),
    elapsedMs: z.number(),
    polls: z.number(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

async function runOnce(
  command: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  const shell = await exec(command, signal, 'bash', { timeout: timeoutMs })
  const result = await shell.result
  const stderr = result.stderr.trim()
  return stderr ? `${result.stdout}\n${stderr}` : result.stdout
}

function formatStatus(output: Output): string {
  const secs = (output.elapsedMs / 1000).toFixed(1)
  return `[${WAITFOR_TOOL_NAME}: ${output.reason} after ${secs}s, ${output.polls} poll${output.polls === 1 ? '' : 's'}]`
}

export const WaitForTool = buildTool({
  name: WAITFOR_TOOL_NAME,
  searchHint: 'wait until a command output matches or settles',
  clearableResult: true,
  maxResultSizeChars: 10_000,
  strict: true,

  isConcurrencySafe() {
    return true
  },

  toAutoClassifierInput(input) {
    return input.setup ? `${input.setup} && ${input.command}` : input.command
  },

  async preparePermissionMatcher({ command, setup }) {
    // Setup and poll are parsed separately: joined with `&&` they would read
    // as a compound command and lose the per-subcommand prefix matching.
    const subcommands: string[] = []
    for (const part of setup ? [setup, command] : [command]) {
      const parsed = await parseForSecurity(part)
      if (parsed.kind !== 'simple') {
        return () => true
      }
      subcommands.push(...parsed.commands.map(c => c.argv.join(' ')))
    }
    return (pattern: string) => {
      const prefix = permissionRuleExtractPrefix(pattern)
      return subcommands.some(cmd => {
        if (prefix !== null) {
          return cmd === prefix || cmd.startsWith(`${prefix} `)
        }
        return matchWildcardPattern(pattern, cmd)
      })
    }
  },

  async checkPermissions(input, context) {
    // Delegate to the bash permission system — both the setup and the poll
    // are shell commands, so the same rules apply to their conjunction.
    const command = input.setup ? `${input.setup} && ${input.command}` : input.command
    return bashToolHasPermission({ command }, context)
  },

  async validateInput(input): Promise<ValidationResult> {
    if (input.until !== undefined) {
      try {
        new RegExp(input.until)
      } catch (e) {
        return {
          result: false,
          message: `Invalid \`until\` regex: ${e instanceof Error ? e.message : String(e)}`,
          errorCode: 1,
        }
      }
    }
    return { result: true }
  },

  async description(input) {
    return input.description || 'Wait for command output'
  },

  async prompt() {
    return `Run a shell command repeatedly until its output matches a regex (\`until\`), stops changing for \`settle_s\` seconds, or \`timeout_s\` elapses — then return the final output once. Use it instead of \`sleep N && check\` polling loops (a tmux pane, a task output file, a health endpoint, a build log): one call replaces every poll turn. Prefer \`until\` over settling whenever you know what you are waiting for. \`setup\` runs once before the first poll (e.g. sending keys to tmux).`
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  userFacingName() {
    return WAITFOR_TOOL_NAME
  },

  getToolUseSummary(input) {
    if (!input?.description) {
      return input?.command ?? null
    }
    return input.description
  },

  getActivityDescription(input) {
    if (!input?.description) {
      return 'Waiting for output'
    }
    return `Waiting for ${input.description}`
  },

  renderToolUseMessage(
    input: Partial<z.infer<InputSchema>>,
  ): React.ReactNode {
    const cmd = input.command ?? ''
    const desc = input.description ?? ''
    const cond = input.until ? ` until /${input.until}/` : ''
    if (desc && cmd) {
      return `${desc}: ${cmd}${cond}`
    }
    return `${cmd || desc}${cond}`
  },

  renderToolResultMessage(output: Output): React.ReactNode {
    return formatStatus(output)
  },

  mapToolResultToToolResultBlockParam(
    output: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    const body = output.output.trimEnd()
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: body ? `${body}\n${formatStatus(output)}` : formatStatus(output),
    }
  },

  async call(input, toolUseContext) {
    const { command, until, setup } = input
    const settleMs = (input.settle_s ?? DEFAULT_SETTLE_S) * 1000
    const intervalMs = (input.interval_s ?? DEFAULT_INTERVAL_S) * 1000
    const timeoutMs = (input.timeout_s ?? DEFAULT_TIMEOUT_S) * 1000
    const signal = toolUseContext.abortController.signal
    // Validated in validateInput; compiled once here.
    const untilRe = until === undefined ? null : new RegExp(until)

    const startedAt = Date.now()
    const remaining = () => timeoutMs - (Date.now() - startedAt)

    if (setup) {
      await runOnce(setup, signal, Math.max(1000, remaining()))
    }

    let output = ''
    let polls = 0
    let stableSince = startedAt
    let reason: Output['reason'] = 'timeout'
    let matched = false

    while (!signal.aborted) {
      const budget = remaining()
      if (budget <= 0) break
      const next = await runOnce(command, signal, budget)
      polls++
      const now = Date.now()
      if (untilRe) {
        if (untilRe.test(next)) {
          output = next
          matched = true
          reason = 'match'
          break
        }
      } else {
        if (next !== output || polls === 1) stableSince = now
        else if (now - stableSince >= settleMs) {
          reason = 'settled'
          break
        }
      }
      output = next
      if (remaining() <= 0) break
      await delay(Math.min(intervalMs, Math.max(0, remaining())), signal)
    }
    if (signal.aborted && !matched && reason !== 'settled') reason = 'aborted'

    return {
      data: {
        output,
        matched,
        reason,
        elapsedMs: Date.now() - startedAt,
        polls,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
