/**
 * Progress payloads that tools stream to the TUI while they are still running.
 *
 * This module was not carried into the fork — every one of its ~21 importers
 * was left unresolved and stubbed at bundle time, which made `ToolProgressData`
 * (and therefore the `P` parameter of `Tool`/`ToolDef`) silently `any`. The
 * shapes below are reconstructed from the sites that actually build and read
 * these objects, so the union is only as wide as the emitters make it.
 *
 * Two invariants the rest of the codebase leans on:
 *
 * 1. Every member is discriminated by a `type` string, and `hook_progress` is
 *    reserved for `HookProgress` (`src/shared/types/hooks.ts`) — the split between
 *    tool progress and hook progress is done with `data.type !== 'hook_progress'`
 *    (`Tool.ts::filterToolProgressMessages`, `AssistantToolUseMessage.tsx`).
 * 2. `ProgressMessage` defaults to this union, and consumers narrow on `type`
 *    to reach member fields (`CollapsedReadSearchContent.tsx` reads
 *    `elapsedTimeSeconds`/`totalLines` off the two shell arms and `phase`/
 *    `toolInput` off the REPL arm). So it has to stay a real discriminated
 *    union rather than an open `{ type: string }`.
 *
 * Nothing here reaches the model: `normalizeMessagesForAPI` drops every
 * `progress` message before serialization.
 */
import type { TaskType } from 'src/agent/Task.js'
import type { AgentId } from 'src/shared/types/ids.js'
import type {
  AssistantMessage,
  NormalizedMessage,
  ProgressMessage,
} from 'src/shared/types/message.js'
// The newer tools declare their own progress type next to the tool, each with a
// comment explaining that it stayed out of this union only because this module
// did not exist. They are pulled in here instead of duplicated, because
// `ToolDef<Input, Output, P>` constrains `P extends ToolProgressData` and each
// of them passes its own type at that position.
import type { BuildProgress } from 'src/tools/BuildTool/types.js'
import type { GitProgress } from 'src/tools/GitTool/types.js'
import type { TestProgress } from 'src/tools/RunTestsTool/types.js'
import type { CheckProgress } from 'src/tools/TypecheckTool/types.js'

/**
 * What both shell backends report on a tick. Mirrors the object the exec
 * generator yields in `BashTool.tsx` / `PowerShellTool.tsx`; the two differ
 * only by discriminant.
 */
type ShellProgressBase = {
  /** The tail of the output, already trimmed to what the TUI shows. */
  output: string
  /** Everything captured so far. */
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  /** Bytes captured, or 0 once the capture is known to be complete. */
  totalBytes: number
  /** Set once the command is backed by a task that can be backgrounded. */
  taskId?: string
  /** Only present when the caller passed a timeout. */
  timeoutMs?: number
}

export type BashProgress = ShellProgressBase & { type: 'bash_progress' }

export type PowerShellProgress = ShellProgressBase & {
  type: 'powershell_progress'
}

/**
 * Either shell backend. `!command` in the REPL and sub-agents both forward
 * whichever one ran without caring which.
 */
export type ShellProgress = BashProgress | PowerShellProgress

/**
 * One message from a running sub-agent, forwarded so the parent can render the
 * agent's transcript inline.
 *
 * `message` is normalized in `AgentTool`/`SkillTool`, but the forked
 * slash-command path (`processSlashCommand.tsx`) passes a raw
 * `AssistantMessage`, so both are accepted. Readers only ever touch
 * `message.type` and `message.message.content[0]`.
 */
export type AgentToolProgress = {
  type: 'agent_progress'
  message: NormalizedMessage | AssistantMessage
  /** Carried on the first progress message only; later ones send `''`. */
  prompt: string
  agentId: AgentId
}

/** The `SkillTool` equivalent of {@link AgentToolProgress}. */
export type SkillToolProgress = {
  type: 'skill_progress'
  message: Exclude<NormalizedMessage, ProgressMessage>
  prompt: string
  agentId: AgentId
}

/**
 * Lifecycle of one MCP tool call. `started`/`completed`/`failed` come from the
 * caller in `fetchCapabilities.ts`; `progress` is relayed from the MCP SDK's
 * `onprogress` notification, which is the only arm that carries the counters.
 */
export type MCPProgress = {
  type: 'mcp_progress'
  status: 'started' | 'progress' | 'completed' | 'failed'
  serverName: string
  toolName: string
  /** Set on `completed` and `failed`. */
  elapsedTimeMs?: number
  /** Set on `progress`; the UI shows a spinner until it arrives. */
  progress?: number
  /** Set on `progress` when the server declares a total, enabling a bar. */
  total?: number
  /** The server's own description of the step, if it sent one. */
  progressMessage?: string
}

/** Emitted once per query the search provider actually issues. */
export type WebSearchProgress =
  | { type: 'query_update'; query: string }
  | {
      type: 'search_results_received'
      query: string
      resultCount: number
    }

/** Emitted once when `TaskOutput` starts blocking on a task. */
export type TaskOutputProgress = {
  type: 'waiting_for_task'
  taskDescription: string
  taskType: TaskType
}

/**
 * The inner tool a REPL call is currently running. This is the only live signal
 * during a REPL execution — its virtual messages do not arrive until it ends.
 */
export type REPLToolProgress = {
  type: 'repl_tool_call'
  phase: 'start' | 'end'
  toolName: string
  /** Shape depends on `toolName`; readers cast it. */
  toolInput: unknown
}

/**
 * A delta of workflow state pushed on the SDK's `task_progress` event, not on a
 * tool's progress channel — so it is deliberately NOT part of
 * {@link ToolProgressData}. Clients upsert by `${type}:${index}` and group by
 * `phaseIndex` to rebuild the phase tree.
 *
 * The producer (`LocalWorkflowTask`) and the renderer (`PhaseProgress.tsx`)
 * were both left out of the fork, so these three fields are everything the
 * remaining code documents; a real emitter may well carry more.
 */
export type SdkWorkflowProgress = {
  type: string
  index: number
  phaseIndex: number
}

/**
 * Every payload a tool can put on its progress channel. `Tool`, `ToolDef` and
 * `ToolCallProgress` constrain their `P` parameter to this, so a new tool with
 * its own progress shape has to be added here.
 */
export type ToolProgressData =
  | AgentToolProgress
  | SkillToolProgress
  | BashProgress
  | PowerShellProgress
  | MCPProgress
  | WebSearchProgress
  | TaskOutputProgress
  | REPLToolProgress
  | BuildProgress
  | TestProgress
  | CheckProgress
  | GitProgress
