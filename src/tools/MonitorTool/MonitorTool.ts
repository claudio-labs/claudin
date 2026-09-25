import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from 'src/tools/Tool.js'
import { spawnShellTask } from 'src/agent/tasks/LocalShellTask/LocalShellTask.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { exec } from 'src/shared/proc/Shell.js'
import { getTaskOutputPath } from 'src/agent/tasks/diskOutput.js'
import {
  bashToolHasPermission,
} from 'src/tools/BashTool/bashPermissions.js'
import { MONITOR_TOOL_NAME } from 'src/tools/MonitorTool/toolName.js'

const MONITOR_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

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
    return `Execute a shell command in the background and stream its stdout line-by-line as notifications. Each polling interval (~1s), new output lines are delivered to you. Use this for monitoring logs, watching build output, or observing long-running processes. For one-shot "wait until done" commands, prefer Bash with run_in_background instead.`
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
      content: `Monitor task started with ID: ${output.taskId}. Output is being streamed to: ${outputPath}. You will receive notifications as new output lines appear (~1s polling). Use TaskStop to end monitoring when done.`,
    }
  },

  async call(input, toolUseContext) {
    const { command, description } = input
    const { abortController, setAppState } = toolUseContext

    // Create the shell command — uses the same Shell.exec() as BashTool.
    // This is intentionally a shell execution (not execFile) because
    // MonitorTool needs full shell features (pipes, redirects, etc.)
    // just like BashTool does.
    const shellCommand = await exec(
      command,
      abortController.signal,
      'bash',
      { timeout: MONITOR_TIMEOUT_MS },
    )

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
