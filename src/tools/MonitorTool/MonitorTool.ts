import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from 'src/tools/Tool.js'
import { spawnShellTask } from 'src/agent/tasks/LocalShellTask/LocalShellTask.js'
import {
  clampMonitorTimeout,
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_EVENT_MAX_LINES,
  MONITOR_FLOOD_EVENTS,
  MONITOR_MAX_TIMEOUT_MS,
} from 'src/agent/tasks/LocalShellTask/monitorStream.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { semanticNumber } from 'src/shared/data/semanticNumber.js'
import { exec } from 'src/shared/proc/Shell.js'
import { getTaskOutputPath } from 'src/agent/tasks/diskOutput.js'
import {
  bashToolHasPermission,
} from 'src/tools/BashTool/bashPermissions.js'
import { MONITOR_TOOL_NAME } from 'src/tools/MonitorTool/toolName.js'

const minutes = (ms: number): number => ms / 60_000

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .describe('The shell command to run and monitor'),
    description: z
      .string()
      .describe(
        'Clear, concise description of what this command does in active voice.',
      ),
    timeout_ms: semanticNumber(z.number().min(1000).optional()).describe(
      `Kill the monitor after this many ms. Default ${MONITOR_DEFAULT_TIMEOUT_MS} (${minutes(MONITOR_DEFAULT_TIMEOUT_MS)} min); values above ${MONITOR_MAX_TIMEOUT_MS} (${minutes(MONITOR_MAX_TIMEOUT_MS)} min) are capped. You are notified when it expires.`,
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    taskId: z
      .string()
      .describe('The ID of the background monitor task'),
    outputFile: z
      .string()
      .describe('Path to the file where output is being written'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

export const MonitorTool = buildTool({
  name: MONITOR_TOOL_NAME,
  searchHint: 'stream shell output as notifications',
  clearableResult: true,
  maxResultSizeChars: 10_000,

  isConcurrencySafe() {
    return true
  },

  toAutoClassifierInput(input) {
    return input.command
  },

  // Every `if` condition on a Monitor hook matches. The per-subcommand matcher
  // this used to build needed argv from parseForSecurity, which has answered
  // parse-unavailable in every shipped bundle, so the permissive arm is the only
  // one that has ever run. It is also the fail-safe direction — matching.ts
  // treats a MISSING matcher as "no match", so the method has to stay and return
  // true rather than be removed. Restoring real filtering would silently stop
  // hooks that fire today, which is a separate decision from removing dead code.
  async preparePermissionMatcher(_input) {
    return (_pattern: string) => true
  },

  async checkPermissions(input, context) {
    // Delegate to the bash permission system — Monitor runs shell commands
    // just like Bash does, so the same permission rules apply.
    const bashDecision = await bashToolHasPermission({ command: input.command }, context)
    // Bash's verdict, never its `updatedInput`: the harness applies it
    // verbatim, and its Bash-shaped `{ command }` would drop `description`.
    if (bashDecision.behavior === 'allow') {
      return { behavior: 'allow', updatedInput: input }
    }
    return bashDecision
  },

  async description(input) {
    return input.description || 'Monitor shell command'
  },

  async prompt() {
    return `Run a shell command in the background and get its output while it runs: about once a second, the lines that arrived (stdout and stderr together) reach you as a notification. Use it for "tell me each time X happens" — a log tail, a build or test watch, a poll loop. For "tell me when X is done", use Bash with run_in_background and a command that exits when the condition holds (e.g. \`until grep -q Ready app.log; do sleep 1; done\`): one notification, no expiry.

- Filter to the lines you would act on, and make every pipe stage flush per line, or matches wait in its buffer: \`tail -f app.log | grep --line-buffered -E "ERROR|FAILED|Traceback"\`. Match the failure signatures too, not only success: silence looks the same as "still running".
- A notification carries at most ${MONITOR_EVENT_MAX_LINES} lines; the rest stays in the output file. A monitor that sends ${MONITOR_FLOOD_EVENTS} notifications within a minute is stopped; call Monitor again with a tighter filter.
- It expires after \`timeout_ms\` (default ${minutes(MONITOR_DEFAULT_TIMEOUT_MS)} minutes, at most ${minutes(MONITOR_MAX_TIMEOUT_MS)}): the command is killed and you get one notice with its event count. Call Monitor again to keep watching; TaskStop ends it early.`
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  userFacingName() {
    return 'Monitor'
  },

  getToolUseSummary(input) {
    if (!input?.description) {
      return input?.command ?? null
    }
    return input.description
  },

  getActivityDescription(input) {
    if (!input?.description) {
      return 'Starting monitor'
    }
    return `Monitoring ${input.description}`
  },

  renderToolUseMessage(
    input: Partial<z.infer<InputSchema>>,
  ): React.ReactNode {
    const cmd = input.command ?? ''
    const desc = input.description ?? ''
    if (desc && cmd) {
      return `${desc}: ${cmd}`
    }
    return cmd || desc || ''
  },

  renderToolResultMessage(
    output: Output,
  ): React.ReactNode {
    return `Monitor started (task ${output.taskId})`
  },

  mapToolResultToToolResultBlockParam(
    output: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    const outputPath = output.outputFile
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Monitor task started with ID: ${output.taskId}. New output lines reach you as notifications about once a second until the command exits or the monitor expires; all output also goes to ${outputPath}. Use TaskStop to end it early.`,
    }
  },

  async call(input, toolUseContext) {
    const { command, description, timeout_ms } = input
    const { abortController, setAppState } = toolUseContext

    // Create the shell command — uses the same Shell.exec() as BashTool.
    // This is intentionally a shell execution (not execFile) because
    // MonitorTool needs full shell features (pipes, redirects, etc.)
    // just like BashTool does. No exec timeout: backgrounding clears it, so
    // the deadline is the stream's (monitorStream.ts).
    const shellCommand = await exec(command, abortController.signal, 'bash')

    // Spawn as a background task with kind='monitor' — identical to
    // BashTool's run_in_background path but always monitor-flavored.
    const handle = await spawnShellTask(
      {
        command,
        description: description || command,
        shellCommand,
        toolUseId: toolUseContext.toolUseId,
        agentId: toolUseContext.agentId,
        kind: 'monitor',
        monitorStream: { timeoutMs: clampMonitorTimeout(timeout_ms) },
      },
      {
        abortController,
        getAppState: () => {
          throw new Error(
            'getAppState not available in MonitorTool spawn context',
          )
        },
        setAppState: toolUseContext.setAppStateForTasks ?? setAppState,
      },
    )

    const taskId = handle.taskId
    const outputFile = getTaskOutputPath(taskId)

    return {
      data: {
        taskId,
        outputFile,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)
