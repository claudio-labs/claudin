import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isReadOnlyGitBatch, parseGitCommand } from './grammar.js'
import { checkGitBatchPermission } from './permissions.js'
import { DESCRIPTION, GIT_TOOL_NAME } from './prompt.js'
import { batchFailed, formatGitBatchResult, runGitBatch } from './run.js'
import type { GitBatchResult } from './types.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

/**
 * `Git` — run git and gh commands with a budgeted result instead of raw shell
 * output.
 *
 * Killswitch: `CLAUDIN_DISABLE_GIT_TOOL=1` drops the tool from the toolset
 * (applied in `src/tools.ts`, where the rest of the registry lives).
 *
 * Three deliberate design points, each of which has a test:
 *
 *  - The input is a LIST. The model runs git in bursts (the commit protocol
 *    alone prescribes status + diff + log), and one call with three commands
 *    costs one `tool_use` block and one result framing instead of three.
 *  - Permissions delegate to `bashToolHasPermission`, so existing
 *    `Bash(git …)` rules apply unchanged. See `permissions.ts`.
 *  - `isReadOnly` is computed per command and fails closed, which is what lets
 *    `git diff` run inside plan mode while `git commit` does not.
 *
 * NOT added to `isCacheableTool`'s whitelist in
 * `src/services/tools/toolResultCache.ts`: git state changes faster than that
 * cache's 30s TTL, and a replayed `git status` is a wrong answer.
 *
 * The rest of the subsystem, and the two killswitches that do not live here:
 *
 *  - `grammar.ts`  — what is accepted, and read vs mutate (fails closed).
 *  - `permissions.ts` — delegation to `bashToolHasPermission`.
 *  - `run.ts`      — sequential execution; its error/success branch is what
 *                    guarantees a failure is never budgeted or elided.
 *  - `budget.ts` + `parsers/` — the summarizers, ≤70% no-win guard.
 *  - `delta.ts`    — re-run elision, on by default; `CLAUDIN_DISABLE_GIT_DELTA=1`.
 *  - `redirect.ts` — the Bash refusal that points here;
 *                    `CLAUDIN_DISABLE_GIT_REDIRECT=1`.
 *  - `errors.ts`   — one-line diagnosis prepended to a failure's raw text.
 */

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

/**
 * Batch cap, mirroring Bash's `MAX_SUBCOMMANDS_FOR_SECURITY_CHECK`. Every
 * element costs a full permission evaluation, so an unbounded list is both a
 * latency and a review-surface problem.
 */
export const MAX_COMMANDS = 10

const inputSchema = lazySchema(() =>
  z.strictObject({
    commands: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_COMMANDS)
      .describe(
        'Verbatim shell commands, each starting with "git" or "gh" — e.g. ["git status", "git diff"]. One command per element: no pipes, &&, ; or redirects.',
      ),
    timeout: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(`Timeout in ms per command (default ${DEFAULT_TIMEOUT_MS}).`),
    full: z
      .boolean()
      .optional()
      .describe(
        'Return the whole body: no summary, no rewrite, and no eliding of what an identical earlier call already delivered. Use it to get every hunk of a large diff.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    outcomes: z.array(
      z.object({
        command: z.string(),
        effectiveCommand: z.string(),
        exitCode: z.number(),
        output: z.string(),
        interrupted: z.boolean(),
      }),
    ),
    notRun: z.array(z.string()),
    runError: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = z.infer<InputSchema>
export type Output = GitBatchResult

export const GitTool = buildTool({
  name: GIT_TOOL_NAME,
  searchHint: 'git gh version control diff status log commit push pull request',
  maxResultSizeChars: 30_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    // Constant, never a per-project answer: the tool list is pinned to a shared
    // system-prompt cache config (see getAllBaseTools in src/tools.ts), so
    // "is this a git repo" answered here would fragment that cache. A
    // non-repository is answered at call time by git itself.
    return true
  },
  isReadOnly(input) {
    return isReadOnlyGitBatch(input.commands)
  },
  isConcurrencySafe() {
    // git serialises on .git/index anyway, and a batch may mutate.
    return false
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return DESCRIPTION
  },
  userFacingName,
  toAutoClassifierInput(input) {
    return input.commands.join('\n')
  },
  async validateInput(input) {
    for (const command of input.commands) {
      const parsed = parseGitCommand(command)
      if (!parsed.ok) {
        return { result: false, message: parsed.reason, errorCode: 1 }
      }
    }
    return { result: true }
  },
  async checkPermissions(input, context) {
    return checkGitBatchPermission(input, context)
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  async call(input: Input, context) {
    const result = await runGitBatch({
      commands: input.commands,
      abortSignal: context.abortController.signal,
      timeoutMs: input.timeout ?? DEFAULT_TIMEOUT_MS,
      full: input.full,
      // Rule 1 of the delta lane: without this id it cannot tell whether the
      // body it would elide is still visible to the model, and it declines.
      toolUseId: context.toolUseId,
    })
    return { data: result }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formatGitBatchResult(output),
      is_error: batchFailed(output),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
