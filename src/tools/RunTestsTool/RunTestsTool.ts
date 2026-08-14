import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { z } from 'zod/v4'
import { bashToolHasPermission } from 'src/tools/BashTool/bashPermissions.js'
import { buildTool, type ToolCallProgress, type ToolDef } from 'src/Tool.js'
import { getCwd } from 'src/utils/fs/cwd.js'
import { lazySchema } from 'src/utils/data/lazySchema.js'
import { formatTestResult } from './budget.js'
import { detectFrameworkFromCommand, detectTestRunner } from './detect.js'
import { DESCRIPTION, RUN_TESTS_TOOL_NAME } from './prompt.js'
import { noteRunTestsExecution } from './redirect.js'
import { runTests } from './run.js'
import type { Framework, TestProgress, TestResult } from './types.js'
import {
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  userFacingName,
} from './UI.js'

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 900_000

/** Each progress message needs its own id; the renderer keeps only the last. */
let progressCounter = 0

const FRAMEWORKS = [
  'vitest',
  'jest',
  'bun',
  'mocha',
  'node-test',
  'pytest',
  'go',
  'cargo',
  'nextest',
  'rspec',
  'phpunit',
  'dotnet',
  'maven',
  'gradle',
  'deno',
  'dart',
  'ctest',
  'catch2',
  'doctest',
  'playwright',
  'pest',
  'elixir',
  'minitest',
] as const

const inputSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .optional()
      .describe('Exact test command to run. When omitted, the suite is auto-detected.'),
    path: z
      .string()
      .optional()
      .describe('Scope the run to a file or directory (appended to the command).'),
    pattern: z
      .string()
      .optional()
      .describe('Filter by test name (framework-appropriate flag is added).'),
    framework: z
      .enum(FRAMEWORKS)
      .optional()
      .describe('Override framework detection. Rarely needed.'),
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
    framework: z.string(),
    command: z.string(),
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
    degraded: z.boolean(),
    exitCode: z.number(),
    runError: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = z.infer<InputSchema>
export type Output = TestResult

// Runners whose CLI takes NO filesystem-path positional — the `path` filter is a
// class/module concept there, so appending it verbatim would break the command.
const NO_PATH_POSITIONAL: ReadonlySet<Framework> = new Set([
  'maven',
  'gradle',
  'dotnet',
  'ctest',
  'catch2',
  'doctest',
])

/**
 * POSIX single-quote escaping. The assembled command is handed to `bash`
 * (see run.ts), so a name filter must be quoted such that `$`, backticks and
 * `\` are NOT interpreted — `JSON.stringify` uses double quotes, inside which
 * bash still expands those. Single-quote everything and escape embedded quotes
 * as `'\''`.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Framework-appropriate application of the `pattern` name filter. `path` is
 * appended verbatim as a positional for runners that accept one (skipped for
 * the JVM/.NET runners in NO_PATH_POSITIONAL).
 */
export function applyFilters(
  command: string,
  framework: Framework,
  path?: string,
  pattern?: string,
): string {
  let cmd = command
  if (pattern) {
    const q = shellQuote(pattern)
    switch (framework) {
      case 'pytest':
        cmd += ` -k ${q}`
        break
      case 'vitest':
      case 'jest':
        cmd += ` -t ${q}`
        break
      case 'mocha':
        cmd += ` --grep ${q}`
        break
      case 'go':
        cmd += ` -run ${q}`
        break
      case 'cargo':
      case 'nextest':
        cmd += ` ${q}`
        break
      case 'maven':
        // surefire: -Dtest=Class#method or a glob like *Foo*.
        cmd += ` -Dtest=${q}`
        break
      case 'gradle':
        cmd += ` --tests ${q}`
        break
      case 'dotnet':
        cmd += ` --filter ${q}`
        break
      case 'rspec':
        cmd += ` -e ${q}`
        break
      case 'deno':
      case 'pest':
        cmd += ` --filter ${q}`
        break
      case 'dart':
        cmd += ` --name ${q}`
        break
      case 'ctest':
        cmd += ` -R ${q}`
        break
      case 'catch2':
        cmd += ` ${q}`
        break
      case 'doctest':
        cmd += ` --test-case=${q}`
        break
      case 'playwright':
        cmd += ` -g ${q}`
        break
      default:
        cmd += ` -t ${q}`
    }
  }
  if (path && !NO_PATH_POSITIONAL.has(framework)) cmd += ` ${path}`
  return cmd
}

/**
 * Resolve the concrete command that will run for a given input: explicit
 * `command` verbatim, otherwise the auto-detected runner — then apply the
 * `path`/`pattern` filters. Returns null when no suite can be detected. Shared
 * by `call()` (execution) and the UI (so the user sees the command before it
 * runs, mirroring how Bash shows its command). Declared as a hoisted function
 * so `UI.tsx` can import it despite the module cycle.
 */
export function resolveRunCommand(
  input: Pick<Input, 'command' | 'framework' | 'path' | 'pattern'>,
): { command: string; framework: Framework } | null {
  const cwd = getCwd()
  const detected = input.command ? null : detectTestRunner(cwd)
  const baseCommand = input.command ?? detected?.command
  if (!baseCommand) return null
  const framework: Framework =
    input.framework ?? detected?.framework ?? detectFrameworkFromCommand(baseCommand)
  return { command: applyFilters(baseCommand, framework, input.path, input.pattern), framework }
}

export const RunTestsTool = buildTool({
  name: RUN_TESTS_TOOL_NAME,
  aliases: ['Test'],
  searchHint: 'run project unit tests structured failures',
  maxResultSizeChars: 30_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return true
  },
  isReadOnly() {
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
    return input.command ?? '<detect test suite>'
  },
  async checkPermissions(input, context) {
    // Running tests executes project code — gate it exactly like a Bash command
    // so the user's allowlist / permission mode applies to the resolved command.
    const cwd = getCwd()
    const command = input.command ?? detectTestRunner(cwd)?.command ?? 'test'
    const bashDecision = await bashToolHasPermission({ command }, context)
    // Use Bash's allow/deny verdict, but NEVER return its `updatedInput` — that
    // is Bash-shaped (`{ command }`) and the harness applies it verbatim, which
    // would drop our `path`/`pattern`/`framework` fields. Echo our own input.
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
    onProgress?: ToolCallProgress<TestProgress>,
  ) {
    const cwd = getCwd()

    const resolved = resolveRunCommand(input)
    if (!resolved) {
      const output: TestResult = {
        framework: 'unknown',
        command: '',
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        failures: [],
        degraded: true,
        exitCode: 0,
        runError:
          'Could not detect a test suite in this project. Pass an explicit `command` (e.g. "pytest" or "npx vitest run").',
      }
      return { data: output }
    }

    const { command, framework } = resolved

    // Arms one Bash escalation on this suite — see noteRunTestsExecution.
    noteRunTestsExecution(command)

    const result = await runTests({
      command,
      framework,
      cwd,
      abortSignal: context.abortController.signal,
      timeoutMs: input.timeout ?? DEFAULT_TIMEOUT_MS,
      // Purely a TUI signal: every `progress` message is dropped before the
      // request is serialized, so this cannot add a token to what the model
      // reads.
      onProgress: onProgress
        ? data => onProgress({ toolUseID: `test-progress-${progressCounter++}`, data })
        : undefined,
    })

    return { data: result }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: formatTestResult(output),
    }
  },
} satisfies ToolDef<InputSchema, Output, TestProgress>)
