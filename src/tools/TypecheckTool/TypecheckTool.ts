import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod/v4'
import { buildTool, type ToolCallProgress, type ToolDef } from 'src/Tool.js'
import { getCwd } from 'src/utils/cwd.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { bashToolHasPermission } from 'src/tools/BashTool/bashPermissions.js'
import { formatCheckResult } from './budget.js'
import {
  applyCompactFlags,
  detectAllCheckers,
  detectChecker,
  detectCheckerFor,
  detectCheckerFromCommand,
} from './detect.js'
import { DESCRIPTION, TYPECHECK_TOOL_NAME } from './prompt.js'
import { runTypecheck } from './run.js'
import type { Checker, CheckProgress, CheckResult } from './types.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  userFacingName,
} from './UI.js'

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 900_000

/** Each progress message needs its own id; the renderer keeps only the last. */
let progressCounter = 0

const CHECKERS = [
  'tsc',
  'deno',
  'cargo',
  'pyright',
  'mypy',
  'go',
  'dart',
  'dotnet',
  'maven',
  'gradle',
  'phpstan',
  'psalm',
] as const

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .optional()
      .describe('Exact check command to run. When omitted, the checker is auto-detected.'),
    checker: z
      .enum(CHECKERS)
      .optional()
      .describe('Override checker detection. Rarely needed.'),
    path: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        'Filter the reported diagnostics to one file or directory, or to several at once. Does not narrow what is checked.',
      ),
    severity: z
      .enum(['errors', 'all'])
      .optional()
      .describe('Which diagnostics to report. Default "errors"; "all" adds warnings.'),
    baseline: z
      .enum(['auto', 'capture', 'ignore'])
      .optional()
      .describe(
        'Baseline handling. "auto" (default) records one when the tree is clean; "capture" forces a re-record; "ignore" reports every diagnostic.',
      ),
    timeout: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(`Timeout in ms (default ${DEFAULT_TIMEOUT_MS}).`),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    checker: z.string(),
    command: z.string(),
    errors: z.number(),
    warnings: z.number(),
    newCount: z.number(),
    preExistingCount: z.number(),
    fixedCount: z.number(),
    degraded: z.boolean(),
    exitCode: z.number(),
    runError: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = z.infer<InputSchema>
export type Output = CheckResult

export type ResolvedCheck = {
  command: string
  checker: Checker
  /** See `DetectedChecker.toolchainDir` — absent for a caller-supplied command. */
  toolchainDir?: string
}

/**
 * Resolve the concrete command for a given input: an explicit `command`
 * verbatim, otherwise the auto-detected checker — then inject the flag that
 * makes its output machine-readable.
 *
 * The one case where the flag is NOT injected is a composed package script
 * (`tsc --noEmit && eslint .`): appending there would land the flag on the last
 * command in the chain, not on the checker. Such a run stays human-formatted
 * and the parse chain falls back to the pretty-layout regex.
 *
 * Shared by `call()` and the UI so the user sees the command before it runs,
 * mirroring how Bash shows its command. Declared as a hoisted function so
 * UI.tsx can import it despite the module cycle.
 */
export function resolveCheckCommand(
  input: Pick<Input, 'command' | 'checker'>,
): ResolvedCheck | null {
  const cwd = getCwd()
  if (input.command) {
    const checker = input.checker ?? detectCheckerFromCommand(input.command)
    return { command: applyCompactFlags(checker, input.command, cwd), checker }
  }

  // An override must resolve the command for THAT checker. Pairing it with the
  // first-detected command would run, say, `bun run typecheck` and then parse
  // its output as cargo JSON.
  const detected = input.checker ? detectCheckerFor(cwd, input.checker) : detectChecker(cwd)
  if (!detected) return null
  return {
    command: detected.composedScript
      ? detected.command
      : applyCompactFlags(detected.checker, detected.command, cwd),
    checker: detected.checker,
    toolchainDir: detected.toolchainDir,
  }
}

export const TypecheckTool = buildTool({
  name: TYPECHECK_TOOL_NAME,
  aliases: ['Check'],
  searchHint: 'typecheck compile diagnostics new errors baseline',
  maxResultSizeChars: 30_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    // Constant, never a detection result. The tool list is pinned to a shared
    // system-prompt cache config (see getAllBaseTools in src/tools.ts), so a
    // per-project answer here would fragment that cache for every user. "No
    // checker here" is answered at call time instead.
    return true
  },
  isReadOnly() {
    // tsc/cargo check only analyze, but dotnet/maven/gradle genuinely build and
    // cargo runs build scripts. One tool-level answer must cover the worst case.
    return false
  },
  isConcurrencySafe() {
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
    return input.command ?? '<detect type checker>'
  },
  async checkPermissions(input, context) {
    // Running a checker executes project tooling (build scripts, plugins), so
    // gate it exactly like a Bash command and let the user's allowlist apply.
    const command = resolveCheckCommand(input)?.command ?? 'typecheck'
    const bashDecision = await bashToolHasPermission({ command }, context)
    // Use Bash's verdict but NEVER its `updatedInput`: that is Bash-shaped
    // (`{ command }`) and the harness applies it verbatim, which would drop our
    // checker/path/baseline fields. Echo our own input instead.
    if (bashDecision.behavior === 'allow') {
      return { behavior: 'allow', updatedInput: input }
    }
    return bashDecision
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
    onProgress?: ToolCallProgress<CheckProgress>,
  ) {
    const cwd = getCwd()
    const resolved = resolveCheckCommand(input)
    if (!resolved) {
      const output: CheckResult = {
        checker: 'unknown',
        command: '',
        errors: 0,
        warnings: 0,
        newCount: 0,
        preExistingCount: 0,
        fixedCount: 0,
        diagnostics: [],
        baseline: { kind: 'absent', reason: 'not-a-git-repo' },
        alsoDetected: [],
        degraded: false,
        exitCode: 0,
        runError: input.checker
          ? `This project has no ${input.checker} setup, or ${input.checker} is not installed here. Pass an explicit \`command\` to run it anyway.`
          : 'Could not detect a type checker in this project, or the one it configures is not installed. Pass an explicit `command` (e.g. "tsc --noEmit" or "cargo check").',
      }
      return { data: output }
    }

    const result = await runTypecheck({
      command: resolved.command,
      checker: resolved.checker,
      toolchainDir: resolved.toolchainDir,
      cwd,
      abortSignal: context.abortController.signal,
      timeoutMs: input.timeout ?? DEFAULT_TIMEOUT_MS,
      baselineMode: input.baseline ?? 'auto',
      severity: input.severity ?? 'errors',
      pathFilter: input.path,
      alsoDetected: detectAllCheckers(cwd),
      // Purely a TUI signal: every `progress` message is dropped before the
      // request is serialized, so this cannot add a token to what the model
      // reads.
      onProgress: onProgress
        ? data => onProgress({ toolUseID: `check-progress-${progressCounter++}`, data })
        : undefined,
    })

    return { data: result }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formatCheckResult(output),
    }
  },
} satisfies ToolDef<InputSchema, Output, CheckProgress>)
