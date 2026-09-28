/**
 * `/debug`: switches debug logging on for the rest of the process, then
 * helps diagnose a problem from the session's log.
 *
 * Everything the prompt reports is read when it is invoked: the log path
 * (which `--debug-file` or `CLAUDIN_DEBUG_LOGS_DIR` can move), the tail of
 * the log, and the settings paths. Only the end of the log is read, because
 * the file grows without bound.
 */
import { enableDebugLogging, getDebugLogPath } from 'src/shared/debug.js'
import { formatFileSize } from 'src/shared/text/format.js'
import { CLI_COMMAND } from 'src/skills/bundled/shared/cliCommand.js'
import {
  type LogTail,
  type TailLimits,
  readLogTail,
} from 'src/skills/bundled/shared/logTail.js'
import { listResolvedSettingsFiles } from 'src/skills/bundled/shared/settingsFiles.js'
import { registerBundledSkill } from 'src/skills/bundledSkills.js'
import { CLAUDE_CODE_GUIDE_AGENT_TYPE } from 'src/tools/AgentTool/built-in/claudeCodeGuideAgent.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'

const LOG_TAIL_LIMITS: TailLimits = { maxBytes: 64 * 1024, maxLines: 20 }

// -- Prose

const DESCRIPTION =
  'Turn on debug logging for this session and diagnose a problem from its log.'

type PromptInput = {
  /** The user's description, as given; absent when they gave none. */
  readonly issue: string | undefined
  /** Logging was off until this invocation switched it on. */
  readonly switchedOn: boolean
  readonly logPath: string
  readonly tail: LogTail
  readonly settingsFiles: string
}

const FRAME = `# Debug this session

Help the user track down a problem in the current session. The session's debug log is your main evidence.`

function switchedOnNote(logPath: string): string {
  return `Debug logging was off until now and is on from this point, so nothing earlier in the session was recorded. Tell the user that logging is now on and writing to \`${logPath}\`, ask them to reproduce the problem, then read the log again. To capture a session from its very start, they can restart with \`${CLI_COMMAND} --debug\`.`
}

// A fence longer than any backtick run inside the log keeps its lines intact.
const BACKTICK_RUN_RE = /`{3,}/g

function fenced(lines: readonly string[]): string {
  const body = lines.join('\n')
  const longestRun = Math.max(
    2,
    ...Array.from(body.matchAll(BACKTICK_RUN_RE), match => match[0].length),
  )
  const fence = '`'.repeat(longestRun + 1)
  return `${fence}\n${body}\n${fence}`
}

function logState(tail: LogTail): string {
  switch (tail.kind) {
    case 'missing':
      return 'No log file exists there yet. That is normal when logging has only just been switched on: the file appears with the first logged event.'
    case 'unreadable':
      return `The tail of the log could not be read: ${tail.reason}`
    case 'read': {
      const size = `Size: ${formatFileSize(tail.sizeBytes)}.`
      const count = tail.lines.length
      if (count === 0) return `${size} It holds no lines yet.`
      return `${size} Last ${count} ${count === 1 ? 'line' : 'lines'}:\n\n${fenced(tail.lines)}`
    }
  }
}

function logSection(logPath: string, tail: LogTail): string {
  return `## Debug log

\`${logPath}\`

${logState(tail)}

Beyond the tail, search the whole file with \`${GREP_TOOL_NAME}\` for \`[ERROR]\` and \`[WARN]\` lines, stack traces and repeated failures.`
}

function issueSection(issue: string | undefined): string {
  const body =
    issue ??
    'The user did not describe one. Read the log and summarize its errors, warnings and anything else notable.'
  return `## The issue\n\n${body}`
}

const NEXT_STEPS = `## Then

- For how a feature is meant to work (settings, hooks, MCP, permissions), ask the \`${CLAUDE_CODE_GUIDE_AGENT_TYPE}\` agent through the \`${AGENT_TOOL_NAME}\` tool.
- Explain what you found in plain language, then give concrete fixes or next steps.`

function renderPrompt(input: PromptInput): string {
  const parts = [
    FRAME,
    input.switchedOn ? switchedOnNote(input.logPath) : undefined,
    logSection(input.logPath, input.tail),
    issueSection(input.issue),
    `## Settings files\n\n${input.settingsFiles}`,
    NEXT_STEPS,
  ]
  return parts.filter((part): part is string => part !== undefined).join('\n\n')
}

// -- Registration

type DebugDeps = {
  /** Switches debug logging on for the rest of the process; says whether it already was. */
  readonly enableLogging: () => boolean
  readonly logPath: () => string
  readonly readTail: (path: string, limits: TailLimits) => Promise<LogTail>
}

const DEFAULT_DEPS: DebugDeps = {
  enableLogging: enableDebugLogging,
  logPath: getDebugLogPath,
  readTail: readLogTail,
}

export function registerDebugSkill(deps: DebugDeps = DEFAULT_DEPS): void {
  registerBundledSkill({
    name: 'debug',
    description: DESCRIPTION,
    argumentHint: '[issue description]',
    allowedTools: [FILE_READ_TOOL_NAME, GREP_TOOL_NAME, GLOB_TOOL_NAME],
    userInvocable: true,
    disableModelInvocation: true,
    async getPromptForCommand(args) {
      const wasOn = deps.enableLogging()
      const logPath = deps.logPath()
      const text = renderPrompt({
        issue: args.trim() === '' ? undefined : args,
        switchedOn: !wasOn,
        logPath,
        tail: await deps.readTail(logPath, LOG_TAIL_LIMITS),
        settingsFiles: listResolvedSettingsFiles(),
      })
      return [{ type: 'text', text }]
    },
  })
}
