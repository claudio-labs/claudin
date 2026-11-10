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
import type { ShellCommand } from 'src/shared/proc/ShellCommand.js'
import { getTaskOutputPath } from 'src/agent/tasks/diskOutput.js'
import {
  bashToolHasPermission,
} from 'src/tools/BashTool/bashPermissions.js'
import { MONITOR_TOOL_NAME } from 'src/tools/MonitorTool/toolName.js'
import { monitorSource } from 'src/tools/MonitorTool/monitorSource.js'
import {
  createWebSocketCommand,
  WS_MAX_FRAME_BYTES,
  wsInputError,
  wsTargetRefusal,
} from 'src/tools/MonitorTool/webSocketCommand.js'

const minutes = (ms: number): number => ms / 60_000

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .optional()
      .describe('The shell command to run and monitor. Exactly one of `command` and `ws`.'),
    ws: z
      .strictObject({
        url: z.string().describe('A ws:// or wss:// URL'),
        protocols: z.array(z.string()).optional().describe('WebSocket subprotocols to offer'),
      })
      .optional()
      .describe('Open this WebSocket and stream its incoming frames instead of running a command. Exactly one of `command` and `ws`.'),
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
    return monitorSource(input)
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

  async validateInput(input) {
    if ((input.command === undefined) === (input.ws === undefined)) {
      return { result: false, message: 'Pass exactly one of `command` and `ws`.', errorCode: 1 }
    }
    if (!input.ws) return { result: true }
    const wsError = wsInputError(input.ws)
    if (wsError) return { result: false, message: wsError, errorCode: 2 }
    // Before the permission step, which every mode passes through after this,
    // so the user is never asked about a URL that would then be refused.
    const refusal = await wsTargetRefusal(input.ws.url)
    if (refusal) return { result: false, message: `Monitor will not open ${input.ws.url}: ${refusal}`, errorCode: 3 }
    return { result: true }
  },

  async checkPermissions(input, context) {
    // A socket runs no code, so the Bash rules say nothing about it, and no
    // rule is offered either. A plain ask, as for any tool: a mode that
    // allows without asking (bypass, a tool-wide rule, auto) allows this too.
    if (input.ws) {
      return {
        behavior: 'ask',
        message: `Monitor will open a WebSocket to ${input.ws.url}${input.ws.protocols?.length ? ` (subprotocols: ${input.ws.protocols.join(', ')})` : ''}`,
      }
    }
    // Delegate to the bash permission system — Monitor runs shell commands
    // just like Bash does, so the same permission rules apply.
    const bashDecision = await bashToolHasPermission({ command: input.command ?? '' }, context)
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
    return `Run a shell command in the background and get its output while it runs: about once a second, the lines that arrived (stdout and stderr together) reach you as a notification, and you keep working meanwhile. A notification is the command's output, not a reply from the user, even when one lands while you wait for the user to answer.

Pick by how many notifications you need:
- One ("tell me when the server is ready", "when the build finishes"): use Bash with run_in_background and a command that exits when the condition holds, e.g. \`until grep -q Ready app.log; do sleep 1; done\`. One notification, no expiry.
- One per occurrence, until the monitor expires ("tell me every time an ERROR line appears"): Monitor with a command that never ends on its own (\`tail -f\`, \`inotifywait -m\`, a \`while true\` loop).
- One per occurrence, until a known end ("report each CI check as it lands, stop when the run completes"): Monitor with a command that prints and then exits.

- Don't use a never-ending command for a single notification: it stays armed until it expires, long after the event. \`tail -f app.log | grep -m 1 Ready\` does not fix that — if the log goes quiet after the match, \`tail\` never learns the pipe closed and the pipeline hangs.
- Filter to the lines you would act on, and make every pipe stage flush per line, or matches wait in its buffer: \`grep --line-buffered\`, \`awk\` with \`fflush()\`. \`| head -N\` cannot flush: nothing arrives until N lines matched.
- Match the failure signatures too, not only success. A filter that greps only for the success marker stays silent through a crash or a hang, and silence looks the same as "still running": \`tail -f run.log | grep --line-buffered -E "done|Traceback|Error|FAILED|Killed"\`. When polling a job's state, print every terminal state (succeeded, failed, cancelled, timed out).
- In a poll loop, let one failed request pass (\`curl … || true\`) instead of ending the monitor. Poll remote APIs every 30 s or more, local checks every second or so.
- Write a specific \`description\` ("errors in deploy.log", not "watching logs"): every notification is titled with it.
- A notification carries at most ${MONITOR_EVENT_MAX_LINES} lines; the rest stays in the output file. A monitor that sends ${MONITOR_FLOOD_EVENTS} notifications within a minute is stopped; call Monitor again with a tighter filter.
- It expires after \`timeout_ms\` (default ${minutes(MONITOR_DEFAULT_TIMEOUT_MS)} minutes, at most ${minutes(MONITOR_MAX_TIMEOUT_MS)}): the command is killed and you get one notice with its event count. Call Monitor again to keep watching — for a long watch, set the maximum and re-arm on each expiry; TaskStop ends it early.
- \`ws\` instead of \`command\` opens a WebSocket (\`{url: "wss://…", protocols?: […]}\`) and streams each incoming frame as output lines: no shell, no polling. A binary frame shows as \`[binary frame, N bytes]\`, a frame over ${WS_MAX_FRAME_BYTES / (1024 * 1024)} MiB closes the socket, and the close (code and reason) is the last line. Private and link-local addresses are refused, and a \`ws\` monitor asks the user first unless the permission mode already allows it. Prefer it over \`websocat\`; use a command when the frames need shell tools to filter them.`
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
      return input ? monitorSource(input) || null : null
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
    const cmd = monitorSource(input)
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
      content: `Monitor task started with ID: ${output.taskId}. New output lines reach you as notifications about once a second until the source ends or the monitor expires; all output also goes to ${outputPath}. Use TaskStop to end it early.`,
    }
  },

  async call(input, toolUseContext) {
    const { description, timeout_ms } = input
    const { abortController, setAppState } = toolUseContext
    const command = monitorSource(input)

    let shellCommand: ShellCommand
    if (input.ws) {
      shellCommand = createWebSocketCommand(input.ws)
    } else {
      // Create the shell command — uses the same Shell.exec() as BashTool.
      // This is intentionally a shell execution (not execFile) because
      // MonitorTool needs full shell features (pipes, redirects, etc.)
      // just like BashTool does. No exec timeout: backgrounding clears it, so
      // the deadline is the stream's (monitorStream.ts).
      shellCommand = await exec(command, abortController.signal, 'bash')
    }

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
