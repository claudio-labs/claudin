import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod/v4'
import { buildTool, type ToolCallProgress, type ToolDef } from 'src/tools/Tool.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { findComposeFile } from 'src/containers/project.js'
import {
  containerOpFailed,
  formatContainerResult,
} from 'src/tools/ContainerTool/format.js'
import { checkContainerPermission } from 'src/tools/ContainerTool/permissions.js'
import { CONTAINER_TOOL_NAME, DESCRIPTION } from 'src/tools/ContainerTool/prompt.js'
import { runContainerOp } from 'src/tools/ContainerTool/run.js'
import {
  CONTAINER_OPS,
  isReadOnlyOp,
  type ContainerProgress,
  type ContainerToolInput,
  type ContainerToolOutput,
} from 'src/tools/ContainerTool/types.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  userFacingName,
} from 'src/tools/ContainerTool/UI.js'

/**
 * `Container` — read and drive docker / docker-compose through one summarized
 * call instead of N raw shell-outs.
 *
 * Killswitch: `CLAUDIN_DISABLE_CONTAINER_TOOL=1` drops the tool from the
 * toolset (applied in `src/tools/tools.ts`). The footer panel has its own,
 * `CLAUDIN_DISABLE_CONTAINER_PANEL=1`, in
 * `src/containers/hooks/useContainerStatus.ts`.
 *
 * Four design points, each with a test:
 *
 *  - `shouldDefer` is a CONSTANT `true`. A ~26-op surface is a large schema, so
 *    only the name reaches the prompt until `ToolSearch` pulls it. It must never
 *    become conditional ("only when a compose file exists"): the tool list sits
 *    at the head of the cached prefix, so toggling a tool's presence mid-session
 *    busts the whole prefix. LSPTool is deliberately not flagged `isLsp` for the
 *    same reason.
 *  - Permissions delegate to `bashToolHasPermission` via the command string
 *    `buildContainerCommand` produces, so a user's existing
 *    `Bash(docker compose up:*)` rules keep working and there is no second
 *    permission namespace. `prune`/`rm`/`rmi`/`down --volumes` never auto-allow.
 *  - A FAILURE is never budgeted or elided — it keeps its raw text with a
 *    one-line diagnosis prepended (`format.ts`).
 *  - NOT added to `CACHE_WHITELIST` in `src/agent/tools/toolResultCache.ts`:
 *    container state changes far faster than that cache's 30s TTL, and a
 *    replayed `ps` or `logs` is a wrong answer that would quietly destroy the
 *    real-time property the panel and this tool both exist for.
 *
 * The rest of the subsystem:
 *
 *  - `types.ts`        — the op catalog and the read/destructive partitions.
 *  - `buildCommand.ts` — pure op+args → argv. Both the runner and the
 *                        permission check consume it, so they cannot disagree
 *                        about what will run.
 *  - `run.ts`          — execution, per-op shaping, `wait`, backgrounding.
 *  - `buildProgress.ts`— the streaming path for `build`/`up`: live label and
 *                        the idle watchdog, riding one tick.
 *  - `permissions.ts`  — delegation to `bashToolHasPermission`.
 *  - `format.ts`       — the model-facing framing.
 */

/** Ceiling for an explicit timeout, matching BuildTool's. A cold Dockerfile
 * legitimately runs longer than ten minutes. */
const MAX_TIMEOUT_MS = 1_800_000

/** Each progress message needs its own id; the renderer keeps only the last. */
let progressCounter = 0

const inputSchema = lazySchema(() =>
  z.strictObject({
    op: z.enum(CONTAINER_OPS).describe('The operation to run.'),
    service: z
      .string()
      .optional()
      .describe('Compose service, or a container name/id for container-scoped ops.'),
    composeFile: z
      .string()
      .optional()
      .describe('Compose file path. Discovered from the project when omitted.'),
    args: z
      .array(z.string())
      .optional()
      .describe('Extra arguments, one per element. Never joined into a shell string.'),
    since: z
      .string()
      .optional()
      .describe('Log window, e.g. "10m". Defaulted rather than left unbounded.'),
    tail: z.number().int().positive().optional().describe('Log line cap.'),
    follow: z
      .boolean()
      .optional()
      .describe('Stream logs as a background task instead of returning once.'),
    until: z
      .enum(['healthy', 'running', 'exited'])
      .optional()
      .describe('State `wait` blocks for.'),
    timeout: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe('Wall ceiling in ms.'),
    idleTimeout: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe('Stop a build after this many ms with no output at all.'),
    background: z
      .boolean()
      .optional()
      .describe('Run a build in the background and report on completion.'),
    volumes: z
      .boolean()
      .optional()
      .describe('`down` also removes volumes. Destructive: always prompts.'),
    directory: z
      .string()
      .optional()
      .describe('Project root override, absolute or relative to the current one.'),
    all: z.boolean().optional().describe('Include stopped containers / all images.'),
    command: z
      .array(z.string())
      .optional()
      .describe('Command for `exec` and `run`, one argument per element.'),
    stdin: z.string().optional().describe('Input piped to `exec`.'),
    source: z.string().optional().describe('`cp` source.'),
    dest: z.string().optional().describe('`cp` destination.'),
    target: z
      .enum(['image', 'volume', 'system', 'container'])
      .optional()
      .describe('What `prune` removes.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * Every field the result renderer reads must be declared here. `z.object`
 * strips what it does not declare and the renderer gets the PARSED value, so an
 * omitted field arrives `undefined` in the TUI only — the model-facing string
 * stays correct and no formatter test can see it. That is how BuildTool shipped
 * a bare `✓ built` with no time.
 */
const outputSchema = lazySchema(() =>
  z.object({
    op: z.string(),
    command: z.string(),
    exitCode: z.number(),
    output: z.string(),
    diagnosis: z
      .object({ kind: z.string(), summary: z.string(), evidence: z.string() })
      .nullable(),
    filtered: z.object({ name: z.string(), reductionPct: z.number() }).optional(),
    rows: z.array(z.looseObject({})).optional(),
    logs: z.looseObject({}).optional(),
    build: z.looseObject({}).optional(),
    contextWarning: z.string().optional(),
    wait: z
      .object({
        satisfied: z.boolean(),
        observedState: z.string(),
        observedHealth: z.string(),
        waitedMs: z.number(),
        impossible: z.string().optional(),
      })
      .optional(),
    backgroundTaskId: z.string().optional(),
    stall: z
      .object({
        reason: z.enum(['ceiling', 'idle']),
        ranMs: z.number(),
        silentMs: z.number(),
        lastLine: z.string(),
      })
      .optional(),
    durationMs: z.number(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = ContainerToolInput
export type Output = ContainerToolOutput

export const ContainerTool = buildTool({
  name: CONTAINER_TOOL_NAME,
  searchHint: 'docker compose container image logs healthcheck build stack',
  maxResultSizeChars: 30_000,
  // Constant. See the header: a conditional presence busts the prompt cache.
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    // Never a per-project answer, for the same cache reason as `shouldDefer`.
    // "Is docker installed here" is answered at call time by docker itself.
    return true
  },
  isReadOnly(input) {
    return isReadOnlyOp(input.op)
  },
  isConcurrencySafe(input) {
    return isReadOnlyOp(input.op)
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  userFacingName,
  toAutoClassifierInput(input) {
    return [input.op, input.service ?? '', (input.command ?? []).join(' ')]
      .filter(Boolean)
      .join(' ')
  },
  async checkPermissions(input, context) {
    return checkContainerPermission(input, context, {
      composeFile: input.composeFile ?? findComposeFile(resolveCwd(input)) ?? undefined,
    })
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  async call(
    input: Input,
    context,
    _canUseTool,
    _parentMessage,
    onProgress?: ToolCallProgress<ContainerProgress>,
  ) {
    const cwd = resolveCwd(input)
    const startedAt = Date.now()
    const result = await runContainerOp(input, {
      cwd,
      composeFile: input.composeFile ?? findComposeFile(cwd) ?? undefined,
      abortSignal: context.abortController.signal,
      toolUseId: context.toolUseId,
      // Purely a TUI signal: progress messages are dropped before the request
      // is serialized, so this cannot add a token to what the model reads.
      onProgress: onProgress
        ? label =>
            onProgress({
              toolUseID: `container-progress-${progressCounter++}`,
              data: {
                type: 'container_progress',
                label,
                elapsedMs: Date.now() - startedAt,
              },
            })
        : undefined,
      spawn: {
        abortController: context.abortController,
        setAppState: context.setAppState as never,
        agentId: context.agentId,
      },
    })
    return { data: result }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formatContainerResult(output),
      is_error: containerOpFailed(output),
    }
  },
} satisfies ToolDef<InputSchema, Output, ContainerProgress>)

/**
 * The project root for this call.
 *
 * Read at call time, never from a module-level cache: a sub-agent running in a
 * worktree has a different cwd, and answering from the parent's would report
 * the wrong project's containers. `RunTestsTool` has a documented bug of
 * exactly this shape.
 */
function resolveCwd(input: ContainerToolInput): string {
  return input.directory ?? getCwd()
}
